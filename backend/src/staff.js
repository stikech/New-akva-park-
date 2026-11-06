/**
 * Админка: владелец и сотрудники.
 *
 * Роли:
 *   owner (владелец) — вход паролем ADMIN_TOKEN. Всё: подтверждение и отклонение оплат,
 *          настройки оплаты (номер карты, Kaspi), финансы с онлайн-продаж, сотрудники и
 *          журнал их действий, плюс всё, что умеют сотрудники.
 *   staff (сотрудник) — свой логин и пароль. Помогает клиентам: клиенты и абонементы,
 *          записи на занятия, выдача заказов на входе, отзывы. Денежных действий нет.
 *
 * Сотрудники хранятся в DATA_DIR/staff.json (пароли — scrypt), заводит их владелец в /admin.
 * Ещё можно задать постоянных сотрудников переменной STAFF_LOGINS (config.js) и
 * пробных — DEMO_ACCOUNTS=1 (DEMO_STAFF ниже, пересоздаются при запуске).
 *
 * Вход: POST /api/admin/login → зашифрованный токен на 12 часов (sealed-token.js);
 * сотрудник, которого отключили или удалили, теряет доступ сразу.
 *
 *   POST   /api/admin/login           { login, password } → { token, who }
 *   GET    /api/admin/demo            — пробные входы сотрудников (DEMO_ACCOUNTS=1)
 *   GET    /api/admin/staff           — сотрудники (владелец)
 *   POST   /api/admin/staff           — завести { name, login, password } (владелец)
 *   PATCH  /api/admin/staff/:id       — { active?, password?, name? } (владелец)
 *   DELETE /api/admin/staff/:id       — удалить (владелец)
 *   GET    /api/admin/activity        — журнал действий (?staff=id&limit=) (владелец)
 *   GET    /api/admin/finance         — выручка по способам оплаты и дням (владелец)
 *   GET    /api/admin/settings        — реквизиты оплаты (владелец)
 *   PUT    /api/admin/settings        — изменить реквизиты (владелец)
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { HttpError, clientIp, readJsonBody, sendJson } from './http.js';
import { createRateLimiter } from './rate-limit.js';
import { dummyVerify, hashPassword, verifyPassword } from './passwords.js';
import { seal, unseal } from './sealed-token.js';
import { luhnValid } from '../../frontend/assets/js/utils/card.js';
import { normalizePhone } from '../../frontend/assets/js/utils/account.js';

const TOKEN_TTL_MS = 12 * 3_600_000; // смена сотрудника
const LOGIN_RE = /^[a-z0-9._-]{3,32}$/;
const OWNER_LOGINS = new Set(['', 'owner', 'admin', 'владелец']);
const sha256 = (s) => createHash('sha256').update(String(s)).digest();
const same = (a, b) => timingSafeEqual(sha256(a), sha256(b));

/** Пробные сотрудники (DEMO_ACCOUNTS=1): видят клиентов со скрытыми телефонами и почтами. */
export const DEMO_STAFF_PASSWORD = 'staff2026';
export const DEMO_STAFF = [
  { id: 'demo-staff-reception', login: 'reception', name: 'Айгуль (ресепшен, демо)' },
  { id: 'demo-staff-fitness', login: 'fitness', name: 'Данияр (фитнес, демо)' },
];

// ---------- хранилище сотрудников ----------

export function createStaffStore(dataDir) {
  const file = path.join(dataDir, 'staff.json');
  let state = { staff: [] };
  let queue = Promise.resolve();
  const ready = readFile(file, 'utf8')
    .then((raw) => { state = { staff: JSON.parse(raw).staff ?? [] }; })
    .catch((error) => { if (error.code !== 'ENOENT') throw error; });

  function mutate(fn) {
    const run = queue.then(async () => {
      await ready;
      const result = fn(state);
      await mkdir(dataDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, file);
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  return {
    file,
    ready,
    /** Синхронно — страж админки вызывается без await. */
    byId: (id) => state.staff.find((s) => s.id === id) ?? null,
    byLogin: (login) => state.staff.find((s) => s.login === login) ?? null,
    list: () => [...state.staff],
    create: (record) => mutate((s) => { s.staff.push(record); return record; }),
    update: (id, fn) => mutate((s) => {
      const rec = s.staff.find((x) => x.id === id);
      if (!rec) return null;
      fn(rec);
      return rec;
    }),
    remove: (id) => mutate((s) => {
      const before = s.staff.length;
      s.staff = s.staff.filter((x) => x.id !== id);
      return before !== s.staff.length;
    }),
  };
}

// ---------- журнал действий ----------

export function createActivityLog(dataDir) {
  const file = path.join(dataDir, 'activity.jsonl');
  let dir = null;
  return {
    file,
    async record(entry) {
      try {
        dir ??= mkdir(dataDir, { recursive: true });
        await dir;
        await appendFile(file, `${JSON.stringify({ id: randomUUID(), at: new Date().toISOString(), ...entry })}\n`, 'utf8');
      } catch { /* журнал не ломает основной запрос */ }
    },
    async list({ limit = 300, staffId = null } = {}) {
      const raw = await readFile(file, 'utf8').catch(() => '');
      const items = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      return items.filter((x) => !staffId || x.staffId === staffId).reverse().slice(0, limit);
    },
  };
}

/** Понятная подпись действия по методу и пути. */
const ACTION_LABELS = [
  [/^POST \/api\/admin\/login$/, 'Вошёл в админку'],
  [/^POST \/api\/admin\/checkout\/[^/]+\/confirm$/, 'Подтвердил оплату заказа'],
  [/^POST \/api\/admin\/checkout\/[^/]+\/reject$/, 'Отклонил заказ'],
  [/^POST \/api\/admin\/checkout\/[^/]+\/redeem$/, 'Выдал заказ / отметил вход'],
  [/^POST \/api\/admin\/orders\/[^/]+\/confirm$/, 'Подтвердил оплату абонемента'],
  [/^POST \/api\/admin\/orders\/[^/]+\/reject$/, 'Отклонил заказ абонемента'],
  [/^POST \/api\/admin\/visits\/[^/]+\/confirm$/, 'Подтвердил оплату билетов'],
  [/^POST \/api\/admin\/visits\/[^/]+\/reject$/, 'Отклонил билеты'],
  [/^POST \/api\/admin\/visits\/[^/]+\/redeem$/, 'Отметил вход по билету'],
  [/^PUT \/api\/admin\/membership$/, 'Оформил абонемент клиенту'],
  [/^DELETE \/api\/admin\/membership$/, 'Снял абонемент'],
  [/^POST \/api\/admin\/visit$/, 'Отметил посещение по абонементу'],
  [/^POST \/api\/admin\/bookings$/, 'Записал клиента на занятие'],
  [/^POST \/api\/admin\/bookings\/[^/]+\/attend$/, 'Отметил приход на занятие'],
  [/^POST \/api\/admin\/bookings\/[^/]+\/cancel$/, 'Отменил запись на занятие'],
  [/^POST \/api\/admin\/staff$/, 'Завёл сотрудника'],
  [/^PATCH \/api\/admin\/staff\/[^/]+$/, 'Изменил сотрудника'],
  [/^DELETE \/api\/admin\/staff\/[^/]+$/, 'Удалил сотрудника'],
  [/^PUT \/api\/admin\/settings$/, 'Изменил реквизиты оплаты'],
];
export function actionLabel(method, pathname) {
  const key = `${method} ${pathname}`;
  return ACTION_LABELS.find(([re]) => re.test(key))?.[1] ?? `${method} ${pathname}`;
}

/** Кого/что затронуло действие — по ответу сервера (код заказа, клиент, занятие). */
export function actionTarget(responseBody, requestBody) {
  const b = responseBody ?? {};
  if (b.order?.code) return `заказ ${b.order.code}${b.order.total ? ` на ${b.order.total.toLocaleString('ru-RU')} ₸` : ''}`;
  if (b.order?.payCode) return `заказ ${b.order.payCode}`;
  if (b.visit?.payCode) return `билеты ${b.visit.payCode}`;
  if (b.booking) return `${b.booking.title}, ${b.booking.date} ${b.booking.start}${requestBody?.name ? ` — ${requestBody.name}` : ''}`;
  if (b.user?.email) return `${[b.user.firstName, b.user.lastName].filter(Boolean).join(' ')} (${b.user.email})${b.user.membership?.title ? ` — ${b.user.membership.title}` : ''}`;
  if (b.staff?.name) return b.staff.name;
  if (requestBody?.reason) return `причина: ${requestBody.reason}`;
  return '';
}

// ---------- маршруты ----------

export function createStaffRoutes({
  config, staff, activity, key, requireAdmin, checkout, orders, visits, settings, log = console, clock = () => new Date(),
}) {
  const loginFail = createRateLimiter({ max: 10, windowMs: 15 * 60_000 });
  setInterval(() => loginFail.sweep(), 60_000).unref();

  const owner = { id: 'owner', name: 'Владелец', role: 'owner' };
  const publicStaff = (s) => ({
    id: s.id, name: s.name, login: s.login, active: s.active !== false, demo: Boolean(s.demo),
    createdAt: s.createdAt, lastLoginAt: s.lastLoginAt ?? null,
  });

  /** Токен → кто вошёл (синхронно). Сотрудник проверяется по хранилищу: отключён — доступа нет. */
  function fromToken(token) {
    const p = unseal(token, key);
    if (!p || p.kind !== 'admin' || p.exp <= Date.now()) return null;
    if (p.role === 'owner') return config.adminToken && p.ah === sha256(config.adminToken).toString('base64url').slice(0, 16) ? owner : null;
    const s = staff.byId(p.sid);
    if (!s || s.active === false || (s.epoch ?? 0) !== (p.ep ?? 0)) return null;
    return { id: s.id, name: s.name, role: 'staff', demo: Boolean(s.demo) };
  }

  function issue(who) {
    const s = who.role === 'staff' ? staff.byId(who.id) : null;
    return seal({
      kind: 'admin', role: who.role, sid: who.id, ep: s?.epoch ?? 0, exp: Date.now() + TOKEN_TTL_MS,
      ...(who.role === 'owner' ? { ah: sha256(config.adminToken).toString('base64url').slice(0, 16) } : {}),
    }, key);
  }

  async function ensureDemoStaff() {
    await staff.ready;
    if (!config.demoAccounts) {
      for (const d of DEMO_STAFF) if (staff.byId(d.id)) await staff.remove(d.id);
      return;
    }
    const passwordHash = await hashPassword(DEMO_STAFF_PASSWORD);
    for (const d of DEMO_STAFF) {
      if (staff.byId(d.id)) await staff.update(d.id, (r) => { Object.assign(r, d, { passwordHash, demo: true, active: true }); });
      else await staff.create({ ...d, passwordHash, demo: true, active: true, createdAt: clock().toISOString() });
    }
  }
  const demoReady = ensureDemoStaff().catch((error) => log.error?.('[staff] демо-сотрудники:', error.message));

  function parseStaffInput(body, { partial = false } = {}) {
    const errors = {};
    const out = {};
    if (!partial || body?.name !== undefined) {
      const name = String(body?.name ?? '').trim();
      if (!name || name.length > 60) errors.name = 'Имя сотрудника, до 60 символов';
      else out.name = name;
    }
    if (!partial || body?.login !== undefined) {
      const login = String(body?.login ?? '').trim().toLowerCase();
      if (!LOGIN_RE.test(login) || OWNER_LOGINS.has(login)) errors.login = 'Логин: 3–32 латинские буквы, цифры, точка, дефис';
      else if (staff.byLogin(login)) errors.login = 'Такой логин уже есть';
      else out.login = login;
    }
    if (!partial || body?.password !== undefined) {
      const password = String(body?.password ?? '');
      if (password.length < 8 || password.length > 100) errors.password = 'Пароль — от 8 символов';
      else out.password = password;
    }
    if (body?.active !== undefined) out.active = body.active !== false;
    return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: out };
  }

  // ---------- финансы ----------

  async function finance() {
    const DAY = 86_400_000;
    const tz = 5 * 3_600_000;
    const dayOf = (iso) => new Date(Date.parse(iso) + tz).toISOString().slice(0, 10);
    const today = dayOf(clock().toISOString());
    const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

    const paid = [];
    for (const o of await checkout.listAll({ limit: 100_000 })) {
      if (o.status === 'paid') paid.push({ at: o.paidAt, amount: o.total, method: o.method ?? 'desk', kind: 'Заказ', code: o.code, by: o.paidBy });
    }
    for (const o of await orders.listAll({ limit: 100_000 })) {
      if (o.status === 'paid') paid.push({ at: o.paidAt, amount: o.price, method: o.receipt?.brand === 'Kaspi' ? 'kaspi' : 'card', kind: 'Абонемент', code: o.payCode });
    }
    for (const v of await visits.listAll()) {
      if (v.status === 'paid') paid.push({ at: v.paidAt, amount: v.price, method: v.receipt?.brand === 'Kaspi' ? 'kaspi' : 'card', kind: 'Билеты', code: v.payCode });
    }
    const pendingClaims = (await checkout.listAll({ limit: 100_000 })).filter((o) => o.status === 'pending' && o.claim);

    const sum = (list) => list.reduce((s, x) => s + x.amount, 0);
    const byMethod = (list) => Object.fromEntries(['card', 'transfer', 'kaspi', 'desk']
      .map((m) => [m, sum(list.filter((x) => x.method === m))]));
    const period = (days) => {
      const from = days ? shift(today, -(days - 1)) : '0000-00-00';
      const list = paid.filter((x) => x.at && dayOf(x.at) >= from);
      const methods = byMethod(list);
      return { total: sum(list), online: methods.card + methods.transfer + methods.kaspi, count: list.length, methods };
    };
    const days = Array.from({ length: 30 }, (_, i) => shift(today, i - 29)).map((date) => {
      const list = paid.filter((x) => x.at && dayOf(x.at) === date);
      return { date, total: sum(list), online: sum(list.filter((x) => x.method !== 'desk')), count: list.length };
    });
    return {
      today,
      periods: { today: period(1), week: period(7), month: period(30), all: period(0) },
      days,
      pending: { count: pendingClaims.length, total: pendingClaims.reduce((s, o) => s + o.total, 0) },
      recent: paid.filter((x) => x.at).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 15),
    };
  }

  const routes = {
    'POST /api/admin/login': async (req, res) => {
      const ip = clientIp(req, config.trustProxyHops);
      if (!loginFail.check(ip).ok) throw new HttpError(429, 'Слишком много попыток. Попробуйте через 15 минут.');
      const body = await readJsonBody(req);
      const login = String(body?.login ?? '').trim().toLowerCase();
      const password = String(body?.password ?? '');
      await demoReady;

      let who = null;
      if (OWNER_LOGINS.has(login) && config.adminToken && same(password, config.adminToken)) who = owner;
      if (!who && !OWNER_LOGINS.has(login)) {
        const s = staff.byLogin(login);
        if (s && s.active !== false && await verifyPassword(password, s.passwordHash)) {
          who = { id: s.id, name: s.name, role: 'staff', demo: Boolean(s.demo) };
          await staff.update(s.id, (r) => { r.lastLoginAt = clock().toISOString(); });
        } else if (!s) await dummyVerify(password);
        // постоянные сотрудники из переменной STAFF_LOGINS: логин — имя
        const env = (config.staff ?? []).find((x) => x.name.toLowerCase() === login && same(password, x.password));
        if (!who && env) who = { id: `env:${env.name}`, name: env.name, role: 'staff' };
      }
      if (!who) {
        loginFail.hit(ip);
        throw new HttpError(401, 'Неверный логин или пароль');
      }
      loginFail.reset(ip);
      // Сотрудник из STAFF_LOGINS не хранится в staff.json — его токен проверяется по паролю, как раньше.
      const token = who.id.startsWith('env:') ? password : issue(who);
      req.adminWho = who;
      sendJson(res, 200, { token, who });
    },

    /** Пробные входы сотрудников для экрана входа (только при DEMO_ACCOUNTS=1). */
    'GET /api/admin/demo': async (req, res) => {
      await demoReady;
      sendJson(res, 200, config.demoAccounts
        ? { enabled: true, password: DEMO_STAFF_PASSWORD, accounts: DEMO_STAFF.map(({ login, name }) => ({ login, name })) }
        : { enabled: false });
    },

    'GET /api/admin/staff': async (req, res) => {
      requireAdmin(req, { owner: true });
      await demoReady;
      sendJson(res, 200, {
        items: staff.list().map(publicStaff),
        env: (config.staff ?? []).map((s) => s.name),
        demoPassword: config.demoAccounts ? DEMO_STAFF_PASSWORD : null,
      });
    },

    'POST /api/admin/staff': async (req, res) => {
      requireAdmin(req, { owner: true });
      const parsed = parseStaffInput(await readJsonBody(req));
      if (!parsed.ok) return sendJson(res, 422, { errors: parsed.errors });
      const { password, ...rest } = parsed.value;
      const record = await staff.create({
        id: randomUUID(), ...rest, passwordHash: await hashPassword(password), active: true, epoch: 0, createdAt: clock().toISOString(),
      });
      sendJson(res, 201, { staff: publicStaff(record) });
    },

    'GET /api/admin/activity': async (req, res) => {
      requireAdmin(req, { owner: true });
      const q = new URL(req.url, 'http://x').searchParams;
      const items = await activity.list({ limit: Math.min(Number(q.get('limit')) || 300, 2000), staffId: q.get('staff') || null });
      sendJson(res, 200, { items });
    },

    'GET /api/admin/finance': async (req, res) => {
      requireAdmin(req, { owner: true });
      sendJson(res, 200, await finance());
    },

    'GET /api/admin/settings': (req, res) => {
      requireAdmin(req, { owner: true });
      sendJson(res, 200, settings.view());
    },

    'PUT /api/admin/settings': async (req, res) => {
      requireAdmin(req, { owner: true });
      const body = await readJsonBody(req);
      const errors = {};
      const next = {};
      if (body?.cardNumber !== undefined) {
        const digits = String(body.cardNumber ?? '').replace(/\D/g, '');
        if (digits && (digits.length < 16 || digits.length > 19 || (digits.length === 16 && !luhnValid(digits)))) errors.cardNumber = 'Проверьте номер карты — 16 цифр';
        else next.cardNumber = digits || null;
      }
      for (const f of ['cardBank', 'cardHolder', 'kaspiReceiver']) {
        if (body?.[f] !== undefined) next[f] = String(body[f] ?? '').trim().slice(0, 60) || null;
      }
      if (body?.kaspiPhone !== undefined) {
        const raw = String(body.kaspiPhone ?? '').trim();
        const phone = raw ? normalizePhone(raw) : null;
        if (raw && !phone) errors.kaspiPhone = 'Номер Kaspi в формате +7 7XX XXX-XX-XX';
        else next.kaspiPhone = phone;
      }
      if (body?.kaspiPayLink !== undefined) {
        const link = String(body.kaspiPayLink ?? '').trim();
        if (link && !/^https:\/\/[\w.-]+\//.test(link)) errors.kaspiPayLink = 'Ссылка должна начинаться с https://';
        else next.kaspiPayLink = link || null;
      }
      if (Object.keys(errors).length) return sendJson(res, 422, { errors });
      await settings.save(next);
      sendJson(res, 200, settings.view());
    },
  };

  const dynamic = {
    'PATCH /api/admin/staff/:id': async (req, res, { params }) => {
      requireAdmin(req, { owner: true });
      const current = staff.byId(String(params.id));
      if (!current) throw new HttpError(404, 'Сотрудник не найден');
      const parsed = parseStaffInput(await readJsonBody(req), { partial: true });
      if (!parsed.ok) return sendJson(res, 422, { errors: parsed.errors });
      const { password, ...rest } = parsed.value;
      const passwordHash = password ? await hashPassword(password) : null;
      const updated = await staff.update(current.id, (r) => {
        Object.assign(r, rest);
        if (passwordHash) r.passwordHash = passwordHash;
        // смена пароля или отключение — старые входы этого сотрудника сразу перестают работать
        if (passwordHash || rest.active === false) r.epoch = (r.epoch ?? 0) + 1;
      });
      sendJson(res, 200, { staff: publicStaff(updated) });
    },

    'DELETE /api/admin/staff/:id': async (req, res, { params }) => {
      requireAdmin(req, { owner: true });
      const current = staff.byId(String(params.id));
      if (!current) throw new HttpError(404, 'Сотрудник не найден');
      await staff.remove(current.id);
      sendJson(res, 200, { ok: true, staff: publicStaff(current) });
    },
  };

  return { routes, dynamic, fromToken, demoReady };
}

// ---------- реквизиты оплаты из админки ----------

/**
 * Настройки оплаты, которые владелец меняет в /admin → «Настройки оплаты»:
 * DATA_DIR/settings.json поверх backend/payment.config.js и переменных окружения.
 * Применяются к config сразу — перезапуск не нужен.
 */
export function createPaymentSettings(config, dataDir) {
  const file = path.join(dataDir, 'settings.json');
  const base = {
    cardNumber: config.cardTransfer?.number ?? null, cardBank: config.cardTransfer?.bank ?? null, cardHolder: config.cardTransfer?.holder ?? null,
    kaspiPhone: config.kaspi?.phone ?? null, kaspiReceiver: config.kaspi?.receiver ?? null, kaspiPayLink: config.kaspi?.payLink ?? null,
  };
  let saved = {};

  function apply() {
    const v = { ...base, ...saved };
    config.cardTransfer = { number: v.cardNumber, bank: v.cardBank, holder: v.cardHolder };
    config.kaspi = { ...config.kaspi, phone: v.kaspiPhone, receiver: v.kaspiReceiver ?? 'Аквапарк «Нептун»', payLink: v.kaspiPayLink };
  }

  const ready = readFile(file, 'utf8')
    .then((raw) => { saved = JSON.parse(raw).payment ?? {}; apply(); })
    .catch(() => {});

  return {
    ready,
    view() {
      return {
        payment: { ...base, ...saved },
        fromAdmin: Object.keys(saved),
        card: { enabled: Boolean(config.tiptoppay?.publicId && config.tiptoppay?.apiSecret), publicId: config.tiptoppay?.publicId ?? null },
        persistent: Boolean(config.backup?.url && config.backup?.token),
      };
    },
    async save(patch) {
      saved = { ...saved, ...patch };
      for (const [k, v] of Object.entries(saved)) if (v === null && base[k] === null) delete saved[k];
      await mkdir(dataDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ payment: saved }), { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, file);
      apply();
    },
  };
}
