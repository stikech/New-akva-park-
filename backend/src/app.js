/**
 * Приложение: маршруты API, админка и фронтенд. createApp() не слушает порт —
 * так его удобно поднимать в тестах на случайном порту.
 *
 *   GET  /api/health            — проверка живости (для хостинга)
 *   GET  /api/site              — данные страницы (docs/api-contract.md)
 *   POST /api/feedback          — отзыв с сайта
 *   GET  /api/admin/feedback    — список отзывов, Authorization: Bearer <ADMIN_TOKEN>
 *   /api/auth/*, /api/account*, /api/admin/users|membership|visit — личный кабинет (accounts.js)
 *   /api/orders/*               — покупка и продление абонементов (payments.js)
 *   /api/bookings/*             — запись на занятия (bookings.js)
 *   /api/visits/*               — онлайн-билеты аквапарка (visits.js)
 *   /api/cart-orders/*          — корзина: оплата нескольких услуг одним платежом (cart.js)
 *   GET  /admin                 — страница администратора
 *   GET  /account[/раздел]      — личный кабинет: /account/overview, /account/shop…
 *   GET  /, /prices, /rules, …  — главная: чистые адреса секций (роутер на клиенте скроллит)
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
import { createCartRoutes } from './cart.js';
import { createCartStore } from './cart-store.js';

/** Секции главной с собственными адресами вроде /prices — на них ведут кнопки шапки и меню. */
const SITE_SECTION_SLUGS = ['slides', 'prices', 'rules', 'fitness', 'classes', 'spa', 'pool', 'contacts'];
const SITE_SECTIONS = new Set(SITE_SECTION_SLUGS.flatMap((s) => [`/${s}`, `/${s}/`]));

const sha256 = (s) => createHash('sha256').update(s).digest();

export function createApp({
  config, store, notifier, log = console, sitePayload = buildSitePayload(),
  accounts = createAccountStore(config.dataDir),
  orders = createOrderStore(config.dataDir),
  bookings = createBookingStore(config.dataDir),
  visits = createVisitStore(config.dataDir),
  carts = createCartStore(config.dataDir),
  journal = createAudit(config.dataDir),
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
    config, accounts, orders, journal, requireUser, requireAdmin, log, ...extraClock,
  });
  const bookingRoutes = createBookingRoutes({
    config, accounts, bookings, journal, requireUser, requireAdmin, log, ...extraClock,
  });
  const visitRoutes = createVisitRoutes({
    config, visits, journal, accounts, requireUser, requireAdmin, log, ...extraClock,
  });
  const cartRoutes = createCartRoutes({
    config, carts, journal, accounts, requireUser, requireAdmin, log, ...extraClock,
  });

  function isAdmin(req) {
    if (!config.adminToken) return false;
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    // Сравниваем хеши фиксированной длины — постоянное время независимо от длины ввода.
    return token !== '' && timingSafeEqual(sha256(token), sha256(config.adminToken));
  }

  /** Бросает 503/401/429, если запрос не от администратора. */
  function requireAdmin(req) {
    if (!config.adminToken) {
      throw new HttpError(503, 'Админка не настроена: задайте переменную ADMIN_TOKEN');
    }
    if (!isAdmin(req)) {
      const limit = adminFailLimiter.hit(clientIp(req, config.trustProxyHops));
      if (!limit.ok) throw new HttpError(429, 'Слишком много попыток. Попробуйте позже.');
      throw new HttpError(401, 'Неверный токен');
    }
  }

  const routes = {
    'GET /api/health': (req, res) => {
      sendJson(res, 200, { ok: true, uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
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
    ...cartRoutes.routes,
  };

  // Динамические маршруты с параметрами: /api/orders/:id, /api/bookings/:key.
  // Сегменты `:имя` передаются обработчику в params; расширять — по образцу payments.js.
  const dynamicRoutes = [];
  for (const definition of [paymentRoutes.dynamic, bookingRoutes.dynamic, visitRoutes.dynamic, cartRoutes.dynamic]) {
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
    } else if (SITE_SECTIONS.has(pathname)) {
      // Навигация по сайту — настоящими адресами: /prices, /rules, /pool…
      // Отдаём главную целиком, а скролл к секции делает клиентский роутер.
      if (await serveFile(req, res, config.frontendDir, 'index.html')) return;
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

  return async function requestListener(req, res) {
    const started = performance.now();
    try {
      await handle(req, res);
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
