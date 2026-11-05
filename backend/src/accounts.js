/**
 * Личный кабинет: регистрация, вход по почте и паролю, профиль, настройки, абонемент.
 *
 * Сессия — случайный токен в cookie `neptun_sid` (HttpOnly, SameSite=Lax, Secure на HTTPS).
 * Пароли — scrypt. Лимиты на неудачные входы по IP и по почте. CSRF — проверка Origin
 * + обязательный Content-Type: application/json.
 *
 *   GET    /api/auth/session        — вошёл ли посетитель (для кнопки в шапке), всегда 200
 *   POST   /api/auth/register       — { email, password, firstName, consent: true }
 *   POST   /api/auth/login          — { email, password }
 *   POST   /api/auth/logout
 *   GET    /api/account             — профиль + абонемент
 *   PATCH  /api/account             — { firstName?, lastName?, phone?, birthDate?, lang? }
 *   POST   /api/account/password    — { currentPassword, newPassword }, завершает другие сессии
 *   POST   /api/account/logout-all  — завершить сессии на других устройствах
 *   DELETE /api/account             — { password }, удаление аккаунта
 *
 * Демо-аккаунты (DEMO_ACCOUNTS=1): список приходит в GET /api/auth/session; для них
 * смена пароля, удаление и logout-all отвечают 403.
 *
 * Администратор (Authorization: Bearer <ADMIN_TOKEN>):
 *   GET    /api/admin/users         — клиенты + каталог тарифов
 *   PUT    /api/admin/membership    — { userId, planId, startsAt, endsAt? } выдать/заменить абонемент
 *   DELETE /api/admin/membership    — { userId } снять абонемент
 *   POST   /api/admin/visit         — { userId } отметить посещение по абонементу
 */

import { HttpError, assertSameOrigin, clientIp, isHttps, readJsonBody, sendJson } from './http.js';
import { createRateLimiter } from './rate-limit.js';
import { SESSION_COOKIE, sessionToken } from './session.js';
import { dummyVerify, hashPassword, verifyPassword } from './passwords.js';
import { buildCatalog, buildMembership } from './memberships.js';
import {
  cityDateString, membershipStatus, normalizeEmail, passwordError, validateProfile, validateRegistration,
} from '../../frontend/assets/js/utils/account.js';
import { SITE_DATA } from '../../frontend/assets/js/config/site-data.js';
import { seedDemoAccounts } from './demo-accounts.js';

const SESSION_TTL_MS = 30 * 24 * 3_600_000; // 30 дней
const VISITS_SHOWN = 30;

/**
 * requireUser приходит снаружи (session.js), чтобы его же использовали
 * платёжные и бронировочные маршруты: один страж — одна политика.
 */
export function createAccountRoutes({ config, accounts, requireUser, requireAdmin, log = console, clock = () => new Date() }) {
  const loginFailByIp = createRateLimiter({ max: 20, windowMs: 15 * 60_000 });
  const loginFailByEmail = createRateLimiter({ max: 8, windowMs: 15 * 60_000 });
  const registerByIp = createRateLimiter({ max: 10, windowMs: 60 * 60_000 });
  const passwordFail = createRateLimiter({ max: 8, windowMs: 15 * 60_000 });
  setInterval(() => [loginFailByIp, loginFailByEmail, registerByIp, passwordFail].forEach((l) => l.sweep()), 60_000).unref();

  const catalog = buildCatalog();
  const today = () => cityDateString(SITE_DATA.tzOffsetHours, clock());

  // Демо-аккаунты создаются в фоне при старте; маршруты входа дожидаются их готовности.
  const demoReady = config.demoAccounts
    ? seedDemoAccounts(accounts, { now: clock(), log }).catch((error) => {
      log.error('[demo] не удалось создать демо-аккаунты:', error);
      return [];
    })
    : Promise.resolve([]);

  function forbidDemo(user) {
    if (user.demo) throw new HttpError(403, 'В демо-аккаунте это недоступно — зарегистрируйте свой аккаунт');
  }

  // ---------- сессии и cookie ----------

  function sessionCookie(req, token, maxAgeSec) {
    // При HTTPS добавляем префикс __Host-: браузер требует Secure, всего домена (без
    // Domain=) и Path=/ — сильнее защита от подделки cookie через поддомены.
    const name = isHttps(req, config.trustProxyHops) ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;
    const parts = [`${name}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
    if (isHttps(req, config.trustProxyHops)) parts.push('Secure');
    return parts.join('; ');
  }

  async function startSession(req, userId) {
    const token = await accounts.createSession(userId, SESSION_TTL_MS);
    return sessionCookie(req, token, SESSION_TTL_MS / 1000);
  }

  const clearCookie = (req) => sessionCookie(req, '', 0);

  function tooMany(limit) {
    return new HttpError(429, 'Слишком много попыток. Попробуйте позже.', {
      error: 'Слишком много попыток. Попробуйте позже.',
      retryAfterSec: limit.retryAfterSec,
    });
  }

  // ---------- представление данных ----------

  function publicMembership(m) {
    if (!m) return null;
    const { visits = [], ...rest } = m;
    return { ...rest, status: membershipStatus(m, today()), visits: visits.slice(-VISITS_SHOWN).reverse() };
  }

  /** Пользователь без служебных полей (хеш пароля наружу не уходит никогда). */
  function publicUser(u) {
    return {
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      phone: u.phone,
      birthDate: u.birthDate,
      lang: u.lang,
      createdAt: u.createdAt,
      demo: Boolean(u.demo),
      membership: publicMembership(u.membership),
    };
  }

  // ---------- маршруты ----------

  return {
    'GET /api/auth/session': async (req, res) => {
      const demoAccounts = await demoReady;
      const user = await accounts.userBySession(sessionToken(req));
      sendJson(res, 200, user
        ? { authenticated: true, user: { firstName: user.firstName, lang: user.lang } }
        : { authenticated: false, demoAccounts });
    },

    'POST /api/auth/register': async (req, res) => {
      assertSameOrigin(req);
      const ip = clientIp(req, config.trustProxyHops);
      const limit = registerByIp.hit(ip);
      if (!limit.ok) throw tooMany(limit);

      const parsed = validateRegistration(await readJsonBody(req));
      if (!parsed.ok) return sendJson(res, 422, { errors: parsed.errors });

      const { email, password, firstName } = parsed.value;
      const passwordHash = await hashPassword(password);
      const user = await accounts.createUser({ email, passwordHash, firstName, consentAt: clock().toISOString() });
      if (!user) {
        return sendJson(res, 409, { errors: { email: 'Аккаунт с этой почтой уже есть — войдите' } });
      }
      log.info?.(`[auth] регистрация ${user.id}`);
      sendJson(res, 201, { user: publicUser(user) }, { 'Set-Cookie': await startSession(req, user.id) });
    },

    'POST /api/auth/login': async (req, res) => {
      assertSameOrigin(req);
      const ip = clientIp(req, config.trustProxyHops);
      const body = await readJsonBody(req);
      await demoReady;
      const email = normalizeEmail(body?.email);
      const password = typeof body?.password === 'string' ? body.password : '';

      const byIp = loginFailByIp.check(ip);
      if (!byIp.ok) throw tooMany(byIp);
      const byEmail = loginFailByEmail.check(email);
      if (!byEmail.ok) throw tooMany(byEmail);

      if (!email || !password) {
        return sendJson(res, 422, { errors: { form: 'Введите почту и пароль' } });
      }

      const user = await accounts.findUserByEmail(email);
      const ok = user ? await verifyPassword(password, user.passwordHash) : await dummyVerify(password);
      if (!ok) {
        loginFailByIp.hit(ip);
        loginFailByEmail.hit(email);
        // Одно сообщение для «нет такой почты» и «неверный пароль».
        throw new HttpError(401, 'Неверная почта или пароль');
      }

      loginFailByEmail.reset(email);
      sendJson(res, 200, { user: publicUser(user) }, { 'Set-Cookie': await startSession(req, user.id) });
    },

    'POST /api/auth/logout': async (req, res) => {
      assertSameOrigin(req);
      const token = sessionToken(req);
      if (token) await accounts.deleteSession(token);
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(req) });
    },

    'GET /api/account': async (req, res) => {
      const { user } = await requireUser(req);
      sendJson(res, 200, { user: publicUser(user) });
    },

    'PATCH /api/account': async (req, res) => {
      assertSameOrigin(req);
      const { user } = await requireUser(req);
      const parsed = validateProfile(await readJsonBody(req), { today: today() });
      if (!parsed.ok) return sendJson(res, 422, { errors: parsed.errors });
      const updated = await accounts.updateUser(user.id, parsed.value);
      if (!updated) throw new HttpError(401, 'Войдите в аккаунт');
      sendJson(res, 200, { user: publicUser(updated) });
    },

    'POST /api/account/password': async (req, res) => {
      assertSameOrigin(req);
      const { user, token } = await requireUser(req);
      forbidDemo(user);
      const limit = passwordFail.check(user.id);
      if (!limit.ok) throw tooMany(limit);

      const body = await readJsonBody(req);
      const current = typeof body?.currentPassword === 'string' ? body.currentPassword : '';
      const next = typeof body?.newPassword === 'string' ? body.newPassword : '';

      if (!(await verifyPassword(current, user.passwordHash))) {
        passwordFail.hit(user.id);
        return sendJson(res, 422, { errors: { currentPassword: 'Текущий пароль неверный' } });
      }
      const err = passwordError(next);
      if (err) return sendJson(res, 422, { errors: { newPassword: err } });
      if (next === current) return sendJson(res, 422, { errors: { newPassword: 'Новый пароль совпадает с текущим' } });

      await accounts.updateUser(user.id, { passwordHash: await hashPassword(next) });
      const ended = await accounts.deleteUserSessions(user.id, token);
      sendJson(res, 200, { ok: true, endedSessions: ended });
    },

    'POST /api/account/logout-all': async (req, res) => {
      assertSameOrigin(req);
      const { user, token } = await requireUser(req);
      forbidDemo(user);
      const ended = await accounts.deleteUserSessions(user.id, token);
      sendJson(res, 200, { ok: true, endedSessions: ended });
    },

    'DELETE /api/account': async (req, res) => {
      assertSameOrigin(req);
      const { user } = await requireUser(req);
      forbidDemo(user);
      const limit = passwordFail.check(user.id);
      if (!limit.ok) throw tooMany(limit);
      const body = await readJsonBody(req);
      const password = typeof body?.password === 'string' ? body.password : '';
      if (!(await verifyPassword(password, user.passwordHash))) {
        passwordFail.hit(user.id);
        return sendJson(res, 422, { errors: { password: 'Пароль неверный' } });
      }
      await accounts.deleteUser(user.id);
      log.info?.(`[auth] аккаунт удалён ${user.id}`);
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(req) });
    },

    // ---------- администратор ----------

    'GET /api/admin/users': async (req, res) => {
      requireAdmin(req);
      const users = (await accounts.listUsers())
        .map(publicUser)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      sendJson(res, 200, { items: users, total: users.length, catalog, today: today() });
    },

    'PUT /api/admin/membership': async (req, res) => {
      requireAdmin(req);
      const body = await readJsonBody(req);
      const built = buildMembership(body, catalog, { now: clock() });
      if (!built.ok) return sendJson(res, 422, { errors: built.errors });
      const updated = await accounts.updateUser(String(body.userId ?? ''), { membership: built.value });
      if (!updated) throw new HttpError(404, 'Клиент не найден');
      log.info?.(`[admin] абонемент ${built.value.planId} → ${updated.id}`);
      sendJson(res, 200, { user: publicUser(updated) });
    },

    'DELETE /api/admin/membership': async (req, res) => {
      requireAdmin(req);
      const body = await readJsonBody(req);
      const updated = await accounts.updateUser(String(body?.userId ?? ''), { membership: null });
      if (!updated) throw new HttpError(404, 'Клиент не найден');
      sendJson(res, 200, { user: publicUser(updated) });
    },

    'POST /api/admin/visit': async (req, res) => {
      requireAdmin(req);
      const body = await readJsonBody(req);
      const day = today();
      let reason = null;
      const updated = await accounts.updateUser(String(body?.userId ?? ''), (u) => {
        const status = membershipStatus(u.membership, day);
        if (status.code !== 'active') {
          reason = status.label;
          return false;
        }
        u.membership.visitsUsed += 1;
        u.membership.visits = [...(u.membership.visits ?? []), { at: clock().toISOString() }].slice(-200);
        return true;
      });
      if (reason) throw new HttpError(409, `Нельзя отметить посещение: ${reason.toLowerCase()}`);
      if (!updated) throw new HttpError(404, 'Клиент не найден');
      sendJson(res, 200, { user: publicUser(updated) });
    },
  };
}
