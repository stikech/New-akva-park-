/**
 * Корзина: оплата нескольких услуг одним платежом (аквапарк, бассейн, фитнес, SPA).
 * Покупка без входа в кабинет, как у онлайн-билетов (visits.js); если пользователь
 * вошёл — заказ привязывается к нему.
 *
 * Безопасность — те же правила, что у заказов и визитов:
 *  - сумма ТОЛЬКО из каталога сервера (utils/cart.js → buildProducts(SITE_DATA)):
 *    фронт присылает лишь { id, qty } позиций, цены с фронта игнорируются;
 *  - идемпотентность: `Idempotency-Key` обязателен, повтор вернёт тот же заказ;
 *  - переход pending → paid ровно один раз (атомарная мутация стора);
 *  - данные карты валидируются, но не хранятся: только последние 4 цифры;
 *  - чек подписывается HMAC-SHA256 ключом PAYMENT_SECRET (planId = 'cart');
 *  - лимиты создания и оплаты по IP, append-only аудит.
 *
 *   POST /api/cart-orders          — создать заказ { items: [{ id, qty }], contact, consent }
 *   GET  /api/cart-orders/:id      — статус заказа (по UUID)
 *   POST /api/cart-orders/:id/pay  — оплатить { number, exp, cvc, holder }
 *   GET  /api/admin/cart-orders    — все заказы корзины (администратор)
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError, assertSameOrigin, clientIp, readJsonBody, sendJson } from './http.js';
import { createRateLimiter } from './rate-limit.js';
import { sessionToken } from './session.js';
import { SITE_DATA } from '../../frontend/assets/js/config/site-data.js';
import { cityDateString } from '../../frontend/assets/js/utils/account.js';
import { CART_MAX_LINES, buildProducts, normalizeCart, priceCart, productIndex } from '../../frontend/assets/js/utils/cart.js';
import { validateCard } from '../../frontend/assets/js/utils/card.js';

const IDEMPOTENCY_RE = /^[A-Za-z0-9._-]{16,80}$/;
const ID_RE = /^[0-9a-fA-F-]{8,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DECLINE_BY_LAST4 = { '0002': 'declined', '9995': 'insufficient' };
const DECLINE_ERRORS = {
  declined: 'Платёж отклонён банком. Попробуйте другую карту.',
  insufficient: 'Недостаточно средств на карте.',
};

export function createCartRoutes({
  config, carts, journal, accounts, requireUser = null, requireAdmin, log = console, clock = () => new Date(),
}) {
  if (!config.paymentSecret) {
    throw new Error('cart.js: не задан PAYMENT_SECRET — чеки без подписи недопустимы');
  }
  const index = productIndex(buildProducts(SITE_DATA));
  if (!index.size) throw new Error('cart.js: каталог услуг пуст');

  const createLimiterIp = createRateLimiter({ max: 40, windowMs: 60 * 60_000 });
  const payTotalLimiterIp = createRateLimiter({ max: 60, windowMs: 15 * 60_000 });
  const payFailLimiterIp = createRateLimiter({ max: 20, windowMs: 15 * 60_000 });
  setInterval(() => [createLimiterIp, payTotalLimiterIp, payFailLimiterIp].forEach((l) => l.sweep()), 60_000).unref();
  setInterval(() => { carts.sweepExpired(); }, 10 * 60_000).unref();

  const tooMany = (limit) => new HttpError(429, 'Слишком много попыток. Попробуйте позже.', {
    error: 'Слишком много попыток. Попробуйте позже.',
    retryAfterSec: limit.retryAfterSec,
  });

  // ---------- чек ----------

  const receiptSignature = (r) => createHmac('sha256', config.paymentSecret)
    .update([r.orderId, r.userId ?? '', r.receiptId, r.planId, String(r.amount), r.paidAt].join('|'))
    .digest('base64url');

  function receiptValid(receipt) {
    if (!receipt || typeof receipt !== 'object') return false;
    const expected = Buffer.from(receiptSignature(receipt));
    const given = typeof receipt.signature === 'string' && expected.length === receipt.signature.length
      ? Buffer.from(receipt.signature)
      : null;
    return given !== null && timingSafeEqual(expected, given);
  }

  function buildReceipt(order, { last4, brand }) {
    const receipt = {
      receiptId: `r_${randomBytes(6).toString('base64url')}`,
      paidAt: clock().toISOString(),
      last4,
      brand,
      amount: order.total,
      orderId: order.id,
      userId: order.userId,
      planId: 'cart',
    };
    return { ...receipt, signature: receiptSignature(receipt) };
  }

  // ---------- валидация ----------

  function parseOrder(body) {
    const errors = {};

    const raw = body?.items;
    if (!Array.isArray(raw) || raw.length === 0) errors.items = 'Корзина пуста';
    else if (raw.length > CART_MAX_LINES) errors.items = `Не больше ${CART_MAX_LINES} позиций в одном заказе`;

    let lines = [];
    if (!errors.items) {
      lines = normalizeCart(raw, index);
      // Неизвестная позиция = прайс на сайте устарел. Не оплачиваем «молча меньше», а просим обновить.
      const known = raw.every((l) => index.has(l?.id));
      if (!known) errors.items = 'Часть услуг больше не продаётся — обновите страницу и проверьте корзину';
      else if (!lines.length) errors.items = 'Укажите количество от 1';
    }

    const contact = { email: '', firstName: '', phone: null };
    if (typeof body?.contact === 'object' && body.contact !== null) {
      const email = String(body.contact.email ?? '').trim().toLowerCase();
      if (!EMAIL_RE.test(email) || email.length > 120) errors['contact.email'] = 'Укажите почту в формате name@mail.kz';
      else contact.email = email;
      const firstName = String(body.contact.firstName ?? '').trim();
      if (firstName.length > 60) errors['contact.firstName'] = 'Имя — не длиннее 60 символов';
      else contact.firstName = firstName;
      if (body.contact.phone != null) {
        const phone = String(body.contact.phone).replace(/[^\d+]/g, '');
        if (phone && !/^\+?\d{10,15}$/.test(phone)) errors['contact.phone'] = 'Телефон в формате +7…';
        else contact.phone = phone || null;
      }
    } else errors['contact.email'] = 'Укажите почту для чека';

    if (body?.consent !== true) errors.consent = 'Нужно согласие с правилами комплекса';

    if (Object.keys(errors).length) return { ok: false, errors };

    // Цены — только из каталога сервера.
    const { lines: priced, total } = priceCart(lines, index);
    if (!Number.isFinite(total) || total <= 0) return { ok: false, errors: { items: 'Не удалось рассчитать стоимость' } };
    const items = priced.map(({ id, qty, title, unitPrice, sum, unit }) => ({ id, qty, title, unitPrice, sum, ...(unit ? { unit } : {}) }));
    return { ok: true, value: { ...contact, items, total } };
  }

  function publicOrder(o) {
    return {
      id: o.id,
      kind: 'cart',
      items: o.items,
      total: o.total,
      status: o.status,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      paidAt: o.paidAt,
      attempts: Array.isArray(o.attempts) ? o.attempts.length : 0,
      receipt: o.receipt
        ? {
          receiptId: o.receipt.receiptId,
          paidAt: o.receipt.paidAt,
          last4: o.receipt.last4,
          brand: o.receipt.brand,
          amount: o.receipt.amount,
          signature: o.receipt.signature,
          valid: receiptValid(o.receipt),
        }
        : null,
    };
  }

  const today = () => cityDateString(SITE_DATA.tzOffsetHours, clock());

  // ---------- маршруты ----------

  const routes = {
    'POST /api/cart-orders': async (req, res) => {
      assertSameOrigin(req);
      const ip = clientIp(req, config.trustProxyHops);
      const limitIp = createLimiterIp.hit(ip);
      if (!limitIp.ok) throw tooMany(limitIp);

      const key = req.headers['idempotency-key'];
      if (!IDEMPOTENCY_RE.test(String(key ?? ''))) {
        throw new HttpError(400, 'Заголовок Idempotency-Key обязателен (16–80 символов)');
      }

      const body = await readJsonBody(req);
      const parsed = parseOrder(body);
      if (!parsed.ok) return sendJson(res, 422, { errors: parsed.errors });
      const order = parsed.value;

      if (requireUser && sessionToken(req)) {
        try {
          const { user } = await requireUser(req);
          order.userId = user.id;
          if (!order.firstName) order.firstName = user.firstName ?? '';
          if (!order.phone) order.phone = user.phone ?? null;
        } catch { /* нет сессии — покупка как гость */ }
      }

      const { order: saved, created } = await carts.create({
        ...order, idempotencyKey: String(key), now: clock().toISOString(),
      });
      if (created) {
        await journal.record('cart_created', {
          orderId: saved.id, userId: saved.userId ?? null, lines: saved.items.length, total: saved.total,
        });
        log.info?.(`[cart] создан ${saved.id} (${saved.items.length} поз., ${saved.total} ₸)`);
      }
      sendJson(res, created ? 201 : 200, { order: publicOrder(saved) });
    },

    'GET /api/admin/cart-orders': async (req, res) => {
      requireAdmin(req);
      const users = new Map((await accounts.listUsers()).map((u) => [u.id, u]));
      const items = (await carts.listAll()).map((o) => ({
        ...publicOrder(o),
        email: o.email,
        firstName: o.firstName,
        phone: o.phone,
        userId: o.userId,
        user: o.userId && users.get(o.userId) ? { email: users.get(o.userId).email } : null,
      }));
      sendJson(res, 200, { items, total: items.length, today: today() });
    },
  };

  const dynamic = {
    'GET /api/cart-orders/:id': async (req, res, { params }) => {
      const id = String(params.id ?? '');
      if (!ID_RE.test(id)) throw new HttpError(404, 'Заказ не найден');
      const order = await carts.byId(id);
      if (!order) throw new HttpError(404, 'Заказ не найден');
      sendJson(res, 200, { order: publicOrder(order) });
    },

    'POST /api/cart-orders/:id/pay': async (req, res, { params }) => {
      assertSameOrigin(req);
      const id = String(params.id ?? '');
      if (!ID_RE.test(id)) throw new HttpError(404, 'Заказ не найден');
      const order = await carts.byId(id);
      if (!order) throw new HttpError(404, 'Заказ не найден');

      if (order.status === 'paid') {
        return sendJson(res, 200, { order: publicOrder(order), alreadyPaid: true });
      }
      if (order.status !== 'pending') throw new HttpError(409, 'Заказ уже закрыт — оформите корзину заново');

      const ip = clientIp(req, config.trustProxyHops);
      const total = payTotalLimiterIp.hit(ip);
      if (!total.ok) throw tooMany(total);

      const body = await readJsonBody(req);
      const check = validateCard(
        { number: body?.number, exp: body?.exp, cvc: body?.cvc, holder: body?.holder },
        { nowISO: clock().toISOString() },
      );
      if (!check.ok) return sendJson(res, 422, { errors: check.errors });

      const nowISO = clock().toISOString();
      const last4 = check.value.last4;

      const decline = DECLINE_BY_LAST4[last4];
      if (decline) {
        await carts.patch(order.id, (o) => { o.attempts.push({ at: nowISO, ok: false, code: decline }); });
        payFailLimiterIp.hit(ip);
        await journal.record('cart_pay_declined', { orderId: order.id, code: decline, last4 });
        return sendJson(res, 402, { error: DECLINE_ERRORS[decline], code: decline });
      }

      let outcome = null;
      const receipt = buildReceipt(order, check.value);
      await carts.patch(order.id, (o) => {
        if (o.status === 'paid') { outcome = 'duplicate'; o.attempts.push({ at: nowISO, ok: true, duplicate: true }); return; }
        if (o.status !== 'pending') { outcome = 'conflict'; return; }
        o.status = 'paid';
        o.paidAt = receipt.paidAt;
        o.receipt = receipt;
        o.attempts.push({ at: nowISO, ok: true });
        outcome = 'paid';
      });

      if (outcome === 'conflict') throw new HttpError(409, 'Заказ уже закрыт — оформите корзину заново');
      if (outcome === 'paid') {
        await journal.record('cart_paid', { orderId: order.id, userId: order.userId ?? null, total: order.total, last4 });
        log.info?.(`[cart] оплачен ${order.id}`);
      }

      const fresh = await carts.byId(id);
      sendJson(res, 200, { order: publicOrder(fresh), alreadyPaid: outcome === 'duplicate' });
    },
  };

  return { routes, dynamic };
}
