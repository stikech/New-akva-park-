/**
 * Приложение: маршруты API, админка и фронтенд. createApp() не слушает порт —
 * так его удобно поднимать в тестах на случайном порту.
 *
 *   GET  /api/health            — проверка живости (для хостинга)
 *   GET  /api/site              — данные страницы (docs/api-contract.md)
 *   GET  /api/payment           — реквизиты оплаты Kaspi (backend/payment.config.js)
 *   GET  /api/admin/status      — состояние сервера для админки
 *   POST /api/feedback          — отзыв с сайта
 *   GET  /api/admin/feedback    — список отзывов, Authorization: Bearer <ADMIN_TOKEN>
 *   /api/auth/*, /api/account*, /api/admin/users|membership|visit — личный кабинет (accounts.js)
 *   /api/orders/*               — покупка и продление абонементов (payments.js)
 *   /api/bookings/*             — запись на занятия (bookings.js)
 *   /api/visits/*               — онлайн-билеты аквапарка (прежний поток, visits.js)
 *   /api/checkout/*             — корзина: заказ и оплата картой / переводом (checkout.js)
 *   GET  /api/admin/me          — кто вошёл в админку (владелец или сотрудник)
 *   /api/admin/login, staff, activity, finance, settings — роли и владелец (staff.js)
 *   GET  /admin                 — страница администратора
 *   GET  /account[/раздел]      — личный кабинет: /account/overview, /account/shop…
 *   GET  /                      — главная: hero и плитки разделов
 *   GET  /prices, /rules, …     — разделы сайта, у каждого своя страница (frontend/<раздел>.html)
 *   GET  /ticket?id=…           — статус онлайн-билета и код для входа
 *   GET  /checkout              — корзина, оформление и оплата заказа
 *   GET  /assets/*              — фронтенд
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError, clientIp, readJsonBody, sendJson } from './http.js';
import { parseFeedback } from './feedback.js';
import { createRateLimiter } from './rate-limit.js';
import { createStaticServer } from './static.js';
import { buildSitePayload } from './site-data.js';
import { createAccountRoutes } from './accounts.js';
import { createUserGuard } from './session.js';
import { createAccountStore } from './account-store.js';
import { createOrderStore } from './order-store.js';
import { createBookingStore } from './booking-store.js';
import { createAudit } from './audit.js';
import { createPaymentRoutes } from './payments.js';
import { createBookingRoutes } from './bookings.js';
import { createVisitRoutes } from './visits.js';
import { createVisitStore } from './visit-store.js';
import { kaspiInfo } from './kaspi.js';
import { createCheckoutRoutes, paymentMethods } from './checkout.js';
import { createCheckoutStore } from './checkout-store.js';
import { actionLabel, actionTarget, createActivityLog, createPaymentSettings, createStaffRoutes, createStaffStore } from './staff.js';
import { deriveKey } from './sealed-token.js';

/** Разделы сайта — отдельные страницы frontend/<раздел>.html, на них ведут кнопки шапки. */
const SITE_SECTION_SLUGS = ['slides', 'prices', 'rules', 'fitness', 'classes', 'spa', 'pool', 'contacts', 'shop', 'ticket', 'offer', 'checkout'];
const SITE_PAGES = new Map(SITE_SECTION_SLUGS.flatMap((s) => [[`/${s}`, `${s}.html`], [`/${s}/`, `${s}.html`]]));

const sha256 = (s) => createHash('sha256').update(s).digest();

export function createApp({
  config, store, notifier, log = console, sitePayload = buildSitePayload(),
  accounts = createAccountStore(config.dataDir, { sessionKey: config.sessionSecret }),
  orders = createOrderStore(config.dataDir),
  bookings = createBookingStore(config.dataDir),
  visits = createVisitStore(config.dataDir),
  checkout = createCheckoutStore(config.dataDir),
  staffStore = createStaffStore(config.dataDir),
  activity = createActivityLog(config.dataDir),
  paymentGateway = null,
  journal = createAudit(config.dataDir),
  backup = { enabled: false },
  clock,
}) {
  const serveFile = createStaticServer({ trustProxyHops: config.trustProxyHops });
  const feedbackLimiter = createRateLimiter(config.rateLimit);
  // Отдельный лимит на неверный токен админки — от перебора.
  const adminFailLimiter = createRateLimiter({ max: 10, windowMs: 15 * 60_000 });
  const startedAt = Date.now();
  setInterval(() => {
    feedbackLimiter.sweep();
    adminFailLimiter.sweep();
  }, 60_000).unref();

  // Один страж сессии для кабинета, заказов и записей (session.js).
  const requireUser = createUserGuard({ accounts });
  const extraClock = clock ? { clock } : {};
  const paymentRoutes = createPaymentRoutes({
    config, accounts, orders, journal, requireUser, requireAdmin, notifier, log, ...extraClock,
  });
  const bookingRoutes = createBookingRoutes({
    config, accounts, bookings, journal, requireUser, requireAdmin, log, ...extraClock,
  });
  const visitRoutes = createVisitRoutes({
    config, visits, journal, accounts, requireUser, requireAdmin, notifier, log, ...extraClock,
  });
  const checkoutRoutes = createCheckoutRoutes({
    config, checkout, accounts, bookings, journal, requireAdmin, notifier, log, gateway: paymentGateway, ...extraClock,
  });

  // Сравниваем хеши фиксированной длины — постоянное время независимо от длины ввода.
  const sameSecret = (a, b) => timingSafeEqual(sha256(a), sha256(b));
  const staffLogins = config.staff ?? [];
  const settings = createPaymentSettings(config, config.dataDir);
  const staffRoutes = createStaffRoutes({
    config, staff: staffStore, activity, key: deriveKey(config.sessionSecret), requireAdmin,
    checkout, orders, visits, settings, log, ...extraClock,
  });

  /**
   * Кто вошёл: { id, name, role: 'owner' | 'staff', demo? } или null.
   * Токен: ADMIN_TOKEN (владелец), токен входа из /api/admin/login или пароль из STAFF_LOGINS.
   */
  function whoIs(req) {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return null;
    if (config.adminToken && sameSecret(token, config.adminToken)) return { id: 'owner', name: 'Никуша', role: 'owner' };
    const sealed = staffRoutes.fromToken(token);
    if (sealed) return sealed;
    // Проверяем все пароли без раннего выхода — время ответа не выдаёт, чей пароль ближе.
    let found = null;
    for (const s of staffLogins) if (sameSecret(token, s.password) && !found) found = { id: `env:${s.name}`, name: s.name, role: 'staff' };
    return found;
  }

  /**
   * Бросает 503/401/403/429, если запрос не от владельца или сотрудника. Возвращает, кто вошёл.
   * { owner: true } — только владелец (деньги, настройки оплаты, сотрудники, журнал).
   */
  function requireAdmin(req, { owner = false } = {}) {
    if (!config.adminToken && !staffLogins.length) {
      throw new HttpError(503, 'Админка не настроена: задайте переменную ADMIN_TOKEN');
    }
    const who = whoIs(req);
    if (!who) {
      const limit = adminFailLimiter.hit(clientIp(req, config.trustProxyHops));
      if (!limit.ok) throw new HttpError(429, 'Слишком много попыток. Попробуйте позже.');
      throw new HttpError(401, 'Неверный пароль');
    }
    req.adminWho = who;
    if (owner && who.role !== 'owner') throw new HttpError(403, 'Это может только владелец');
    return who;
  }

  const routes = {
    'GET /api/health': (req, res) => {
      sendJson(res, 200, { ok: true, uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
    },

    'GET /api/payment': (req, res) => {
      sendJson(res, 200, kaspiInfo(config));
    },

    'GET /api/admin/me': (req, res) => {
      sendJson(res, 200, requireAdmin(req));
    },

    'GET /api/admin/status': (req, res) => {
      const who = requireAdmin(req);
      if (who.role !== 'owner') {
        // сотруднику — только то, что нужно для работы с клиентами
        return sendJson(res, 200, { uptimeSec: Math.round((Date.now() - startedAt) / 1000), who, backup: backup.enabled ? 'upstash' : 'off' });
      }
      sendJson(res, 200, {
        who,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        payment: kaspiInfo(config),
        methods: paymentMethods(config),
        staff: staffLogins.map((s) => s.name),
        telegram: notifier?.enabled ? 'on' : 'off',
        backup: backup.enabled ? 'upstash' : 'off',
        demoAccounts: config.demoAccounts,
      });
    },

    'GET /api/site': (req, res) => {
      const headers = {
        ETag: sitePayload.etag,
        'Cache-Control': 'public, max-age=300',
        'Content-Type': 'application/json; charset=utf-8',
      };
      if (req.headers['if-none-match'] === sitePayload.etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      headers['Content-Length'] = Buffer.byteLength(sitePayload.json);
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : sitePayload.json);
    },

    'POST /api/feedback': async (req, res) => {
      const ip = clientIp(req, config.trustProxyHops);
      const limit = feedbackLimiter.hit(ip);
      if (!limit.ok) {
        throw new HttpError(429, 'Слишком много отзывов подряд. Попробуйте позже.', {
          error: 'Слишком много отзывов подряд. Попробуйте позже.',
          retryAfterSec: limit.retryAfterSec,
        });
      }

      const body = await readJsonBody(req);
      const parsed = parseFeedback(body);
      if (!parsed.ok) {
        sendJson(res, 422, { errors: parsed.errors });
        return;
      }

      // Honeypot: бот получает «успех», но ничего не сохраняется (контракт API).
      if (parsed.isBot) {
        log.info?.(`[feedback] honeypot сработал, ip=${ip}`);
        sendJson(res, 200, { ok: true });
        return;
      }

      const record = await store.add(parsed.value);
      notifier.notify(record); // не ждём: медленный Telegram не должен тормозить ответ
      sendJson(res, 201, { ok: true });
    },

    'GET /api/admin/feedback': async (req, res) => {
      requireAdmin(req);
      const limit = Math.min(Number.parseInt(new URL(req.url, 'http://x').searchParams.get('limit'), 10) || 200, 1000);
      const result = await store.list({ limit });
      sendJson(res, 200, { ...result, notifications: notifier.enabled ? 'telegram' : 'off' });
    },

    ...createAccountRoutes({
      config, accounts, requireAdmin, requireUser, log, ...(clock ? { clock } : {}),
    }),

    ...paymentRoutes.routes,
    ...bookingRoutes.routes,
    ...visitRoutes.routes,
    ...checkoutRoutes.routes,
    ...staffRoutes.routes,
  };

  // Динамические маршруты с параметрами: /api/orders/:id, /api/bookings/:key.
  // Сегменты `:имя` передаются обработчику в params; расширять — по образцу payments.js.
  const dynamicRoutes = [];
  for (const definition of [paymentRoutes.dynamic, bookingRoutes.dynamic, visitRoutes.dynamic, checkoutRoutes.dynamic, staffRoutes.dynamic]) {
    for (const [key, handler] of Object.entries(definition)) {
      const [method, pattern] = key.split(' ');
      dynamicRoutes.push({ method, segments: pattern.split('/').filter(Boolean), handler });
    }
  }

  /** Совпадает ли форма пути с шаблоном (без учёта метода). */
  function shapeMatches(route, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    if (route.segments.length !== parts.length) return false;
    return route.segments.every((seg, i) => seg.startsWith(':') ? true : seg === parts[i]);
  }

  function matchDynamic(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of dynamicRoutes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length && ok; i += 1) {
        const seg = route.segments[i];
        if (seg.startsWith(':')) {
          try { params[seg.slice(1)] = decodeURIComponent(parts[i]); } catch { ok = false; }
        } else if (seg !== parts[i]) ok = false;
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }

  async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const route = routes[`${method} ${pathname}`];

    if (route) return route(req, res);

    if (pathname.startsWith('/api/')) {
      const matched = matchDynamic(method, pathname);
      if (matched) return matched.handler(req, res, { params: matched.params });
      // Путь динамический есть, но метод не тот (или точный маршрут с другим методом):
      const known = Object.keys(routes).some((key) => key.endsWith(` ${pathname}`))
        || dynamicRoutes.some((r) => shapeMatches(r, pathname));
      if (known) throw new HttpError(405, 'Метод не поддерживается');
      throw new HttpError(404, 'Не найдено');
    }

    if (method !== 'GET') throw new HttpError(405, 'Метод не поддерживается');

    if (pathname === '/admin' || pathname === '/admin/') {
      if (await serveFile(req, res, config.publicDir, 'admin.html')) return;
    } else if (pathname.startsWith('/admin/')) {
      if (await serveFile(req, res, config.publicDir, pathname.slice('/admin/'.length))) return;
    } else if (pathname === '/' || pathname === '/index.html') {
      if (await serveFile(req, res, config.frontendDir, 'index.html')) return;
    } else if (SITE_PAGES.has(pathname)) {
      // Каждый раздел — своя страница по чистому адресу: /prices → prices.html.
      if (await serveFile(req, res, config.frontendDir, SITE_PAGES.get(pathname))) return;
    } else if (pathname === '/account' || pathname === '/account/' || pathname.startsWith('/account/')) {
      // Каждая кнопка дашборда — отдельный URL: /account/overview, /account/profile…
      // Неизвестные разделы разгребает JS на странице (redirect на /account/overview).
      if (await serveFile(req, res, config.frontendDir, 'account.html')) return;
    } else if (pathname.startsWith('/assets/')) {
      // Отдаём только assets/ — tests/ и package.json фронтенда наружу не нужны.
      if (await serveFile(req, res, config.frontendDir, pathname.slice(1))) return;
    } else if (pathname === '/favicon.ico') {
      // Иконки пока нет — отвечаем «пусто», чтобы не было 404 в консоли браузера.
      res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
      res.end();
      return;
    }

    throw new HttpError(404, 'Страница не найдена');
  }

  /** Журнал: каждое изменяющее действие в админке — кто, что, с чем (видит владелец). */
  function logStaffAction(req, res) {
    const who = req.adminWho;
    if (!who || req.method === 'GET' || res.statusCode >= 400 || !req.url.startsWith('/api/admin/')) return;
    const { pathname } = new URL(req.url, 'http://x');
    activity.record({
      staffId: who.id, name: who.name, role: who.role, demo: Boolean(who.demo),
      action: actionLabel(req.method, pathname), target: actionTarget(res.sentBody, req.parsedBody),
      method: req.method, path: pathname,
    });
  }

  return async function requestListener(req, res) {
    const started = performance.now();
    try {
      await handle(req, res);
      logStaffAction(req, res);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) log.error('[http] ошибка обработки запроса:', error);
      const headers = status === 429 && error.body?.retryAfterSec ? { 'Retry-After': String(error.body.retryAfterSec) } : {};
      if (!res.headersSent) {
        const body = status === 500 ? { error: 'Внутренняя ошибка сервера' } : error.body;
        sendJson(res, status, body, headers);
      } else {
        res.destroy();
      }
    } finally {
      if (req.url !== '/api/health') {
        log.info?.(`${req.method} ${req.url} ${res.statusCode} ${Math.round(performance.now() - started)}ms`);
      }
    }
  };
}
