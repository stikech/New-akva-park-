/**
 * Покупка и продление абонементов через сайт — заказы и оплата.
 *
 * Оплата: эмулятор платёжного шлюза (без внешних зависимостей). Сценарии как у
 * реального PSP: успех по любой карте, валидной по Луна; два тестовых каскада
 * отклонения (номер кончается на 0002 — отклонено банком, на 9995 — нет средств).
 * При подключении реального шлюза (Kaspi Pay, bePaid, Halyk) эти сценарии
 * заменяются на колбэк шлюза — маршруты ниже остаются.
 *
 * Безопасность:
 *  - стоимость берётся ТОЛЬКО из каталога на сервере: цену с фронта не принимаем;
 *  - идемпотентность: `Idempotency-Key` обязателен, повтор вернёт тот же заказ;
 *  - переход pending → paid выполняется ровно один раз (атомарная мутация стора),
 *    повторная попытка не списывает деньги и не выдаёт абонемент повторно;
 *  - данные карты валидируются, но не хранятся: в файлах и журнале только
 *    последние 4 цифры;
 *  - чек подписывается HMAC-SHA256 ключом из PAYMENT_SECRET — подпись содержит
 *    все данные чека, её нельзя перевыпустить на стороне браузера;
 *  - лимиты попыток оплаты и создания заказов (IP + пользователь);
 *  - чужой заказ неотличим от отсутствующего (404 в обоих случаях);
 *  - append-only аудит (audit.js) без персональных данных карты.
 *
 *   POST   /api/orders            — создать заказ { planId }, Idempotency-Key обязателен
 *   GET    /api/orders            — мои заказы
 *   GET    /api/orders/:id        — статус заказа (владелец)
 *   POST   /api/orders/:id/pay    — оплатить { number, exp, cvc, holder }
 *   POST   /api/orders/:id/cancel — отменить (только pending)
 *   GET    /api/admin/orders      — все заказы (администратор)
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError, assertSameOrigin, clientIp, readJsonBody, sendJson } from './http.js';
import { createRateLimiter } from './rate-limit.js';
import { buildCatalog } from './memberships.js';
import { SITE_DATA } from '../../frontend/assets/js/config/site-data.js';
import { cityDateString } from '../../frontend/assets/js/utils/account.js';
import { validateCard } from '../../frontend/assets/js/utils/card.js';
import { applyPlan } from './membership-service.js';

const IDEMPOTENCY_RE = /^[A-Za-z0-9._-]{16,80}$/;
const ID_RE = /^[0-9a-fA-F-]{8,64}$/;
/** Коды отклонения по последним четырём цифрам номера (тестовые сценарии шлюза). */
const DECLINE_BY_LAST4 = { '0002': 'declined', '9995': 'insufficient' };
const DECLINE_ERRORS = {
  declined: 'Платёж отклонён банком. Попробуйте другую карту.',
  insufficient: 'Недостаточно средств на карте.',
};

export function createPaymentRoutes({
  config, accounts, orders, journal, requireUser, requireAdmin, log = console, clock = () => new Date(),
}) {
  if (!config.paymentSecret) {
    throw new Error('payments.js: не задан PAYMENT_SECRET — чеки без подписи недопустимы');
  }

  const catalog = buildCatalog();
  const today = () => cityDateString(SITE_DATA.tzOffsetHours, clock());

  const createLimiterUser = createRateLimiter({ max: 20, windowMs: 60 * 60_000 });
  const createLimiterIp = createRateLimiter({ max: 40, windowMs: 60 * 60_000 });
  const payTotalLimiter = createRateLimiter({ max: 30, windowMs: 15 * 60_000 });
  const payFailLimiter = createRateLimiter({ max: 10, windowMs: 15 * 60_000 });
  setInterval(() => [createLimiterUser, createLimiterIp, payTotalLimiter, payFailLimiter]
    .forEach((l) => l.sweep()), 60_000).unref();
  setInterval(() => { orders.sweepExpired(); }, 10 * 60_000).unref();

  const tooMany = (limit) => new HttpError(429, 'Слишком много попыток. Попробуйте позже.', {
    error: 'Слишком много попыток. Попробуйте позже.',
    retryAfterSec: limit.retryAfterSec,
  });

  // ---------- чек ----------

  /** HMAC-подпись по всем данным чека. Секрет — PAYMENT_SECRET на сервере. */
  const receiptSignature = (r) => createHmac('sha256', config.paymentSecret)
    .update([r.orderId, r.userId, r.receiptId, r.planId, String(r.amount), r.paidAt].join('|'))
    .digest('base64url');

  /**
   * Подпись сходится → чек выдан нашим сервером, данные не перевыпущены.
   * Сравнение в постоянное время (timingSafeEqual), как у токенов.
   */
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
      amount: order.price,
      orderId: order.id,
      userId: order.userId,
      planId: order.planId,
    };
    return { ...receipt, signature: receiptSignature(receipt) };
  }

  // ---------- представление ----------

  function publicOrder(o) {
    return {
      id: o.id,
      planId: o.planId,
      category: o.category,
      title: o.title,
      price: o.price,
      status: o.status,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      paidAt: o.paidAt,
      attempts: Array.isArray(o.attempts) ? o.attempts.length : 0,
      receipt: o.receipt
        ? { receiptId: o.receipt.receiptId, paidAt: o.receipt.paidAt, last4: o.receipt.last4, brand: o.receipt.brand, amount: o.receipt.amount, signature: o.receipt.signature, valid: receiptValid(o.receipt) }
        : null,
    };
  }

  // ---------- выдача абонемента ----------

  /**
   * Выдаёт абонемент по уже оплаченному заказу (однажды: `order.applied`).
   * Сам payment-эндпоинт и «ремонт» в GET-маршруте делают это идемпотентно.
   */
  async function issueMembership(order) {
    const plan = catalog.find((p) => p.id === order.planId);
    if (!plan) {
      throw new HttpError(409, 'Этот тариф больше не продаётся. Позвоните на ресепшен: +7 7152 33-61-41');
    }
    const nowISO = clock().toISOString();
    let result = null;
    await accounts.updateUser(order.userId, (u) => {
      if (!u) return false;
      result = applyPlan({ membership: u.membership, plan, today: today(), nowISO, orderId: order.id });
      u.membership = result.membership;
      return true;
    });
    if (!result) {
      await journal.record('membership_apply_failed', { orderId: order.id, userId: order.userId, reason: 'account_missing' });
      throw new HttpError(409, 'Аккаунт не найден — свяжитесь с ресепшеном, оформим абонемент вручную');
    }
    await orders.patch(order.id, (o) => { o.applied = true; });
    await journal.record('membership_applied', {
      orderId: order.id, userId: order.userId, planId: order.planId, extended: result.extended,
    });
    log.info?.(`[orders] заказ ${order.id}: абонемент ${result.extended ? 'продлён' : 'выдан'} (${order.planId})`);
    return result;
  }

  // ---------- маршруты ----------

  const routes = {
    'GET /api/orders': async (req, res) => {
      const { user } = await requireUser(req);
      const items = (await orders.listByUser(user.id)).map(publicOrder);
      // catalog идёт вместе с заказами: вкладка «Магазин» берёт цены только отсюда
      sendJson(res, 200, { items, total: items.length, catalog });
    },

    'POST /api/orders': async (req, res) => {
      assertSameOrigin(req);
      const { user } = await requireUser(req);
      const ip = clientIp(req, config.trustProxyHops);
      const limitUser = createLimiterUser.hit(user.id);
      if (!limitUser.ok) throw tooMany(limitUser);
      const limitIp = createLimiterIp.hit(ip);
      if (!limitIp.ok) throw tooMany(limitIp);

      const body = await readJsonBody(req);
      const key = req.headers['idempotency-key'];
      if (!IDEMPOTENCY_RE.test(String(key ?? ''))) {
        throw new HttpError(400, 'Заголовок Idempotency-Key обязателен (16–80 символов)');
      }
      const plan = catalog.find((p) => p.id === body?.planId);
      if (!plan) return sendJson(res, 422, { errors: { planId: 'Тариф не найден — обновите страницу и выберите заново' } });

      const mine = await orders.listByUser(user.id, { limit: 100 });
      if (mine.filter((o) => o.status === 'pending').length >= 10) {
        throw new HttpError(429, 'Слишком много неоплаченных заказов — откажитесь от лишних или оплатите их');
      }

      const nowISO = clock().toISOString();
      const { order, created } = await orders.create({
        userId: user.id, planId: plan.id, category: plan.category, title: plan.title, price: plan.price,
        idempotencyKey: String(key), now: nowISO,
      });
      if (created) {
        await journal.record('order_created', { orderId: order.id, userId: user.id, planId: order.planId, price: order.price });
        log.info?.(`[orders] создан ${order.id} (${order.planId})`);
      }
      sendJson(res, created ? 201 : 200, { order: publicOrder(order), catalog });
    },

    'GET /api/admin/orders': async (req, res) => {
      requireAdmin(req);
      const users = new Map((await accounts.listUsers()).map((u) => [u.id, u]));
      const items = (await orders.listAll()).map((o) => ({
        ...publicOrder(o),
        userId: o.userId,
        email: users.get(o.userId)?.email ?? null,
        firstName: users.get(o.userId)?.firstName ?? null,
      }));
      sendJson(res, 200, { items, total: items.length, today: today() });
    },
  };

  /** Динамические маршруты: `/api/orders/:id` — app.js подставляет `params`. */
  const dynamic = {
    'GET /api/orders/:id': async (req, res, { params }) => {
      const id = String(params.id ?? '');
      if (!ID_RE.test(id)) throw new HttpError(404, 'Заказ не найден');
      const { user } = await requireUser(req);
      let order = await orders.byIdOrder(id);
      // владелец смотрит свой заказ; чужой неотличим от отсутствующего
      if (!order || order.userId !== user.id) throw new HttpError(404, 'Заказ не найден');
      // «Ремонт»: если сервер упал между оплатой и выдачей абонемента — доделываем.
      if (order.status === 'paid' && !order.applied) {
        try { await issueMembership(order); } catch (error) { log.error('[orders] ремонт не удался:', error.message); }
        order = await orders.byIdOrder(id);
      }
      sendJson(res, 200, { order: publicOrder(order) });
    },

    'POST /api/orders/:id/pay': async (req, res, { params }) => {
      assertSameOrigin(req);
      const id = String(params.id ?? '');
      if (!ID_RE.test(id)) throw new HttpError(404, 'Заказ не найден');
      const { user } = await requireUser(req);
      const order = await orders.byIdOrder(id);
      if (!order || order.userId !== user.id) throw new HttpError(404, 'Заказ не найден');

      if (order.status === 'paid') {
        // идемпотентный успех: повторная отправка не списывает и не выдаёт повторно
        return sendJson(res, 200, { order: publicOrder(order), alreadyPaid: true });
      }
      if (order.status !== 'pending') throw new HttpError(409, 'Заказ уже закрыт — создайте новый');

      const total = payTotalLimiter.hit(user.id);
      if (!total.ok) throw tooMany(total);

      const body = await readJsonBody(req);
      const check = validateCard(
        { number: body?.number, exp: body?.exp, cvc: body?.cvc, holder: body?.holder },
        { nowISO: clock().toISOString() },
      );
      if (!check.ok) return sendJson(res, 422, { errors: check.errors });

      const nowISO = clock().toISOString();
      const last4 = check.value.last4;

      // Эмулятор шлюза: выбор отклонения по последним четырём цифрам.
      const decline = DECLINE_BY_LAST4[last4];
      if (decline) {
        await orders.patch(order.id, (o) => { o.attempts.push({ at: nowISO, ok: false, code: decline }); });
        payFailLimiter.hit(user.id);
        await journal.record('order_pay_declined', { orderId: order.id, userId: user.id, code: decline, last4 });
        return sendJson(res, 402, { error: DECLINE_ERRORS[decline], code: decline });
      }

      // Атомарный переход pending → paid: победит ровно одна попытка.
      let outcome = null;
      const receipt = buildReceipt(order, check.value);
      await orders.patch(order.id, (o) => {
        if (o.status === 'paid') { outcome = 'duplicate'; o.attempts.push({ at: nowISO, ok: true, duplicate: true }); return; }
        if (o.status !== 'pending') { outcome = 'conflict'; return; }
        o.status = 'paid';
        o.paidAt = receipt.paidAt;
        o.receipt = receipt;
        o.attempts.push({ at: nowISO, ok: true });
        outcome = 'paid';
      });

      if (outcome === 'conflict') throw new HttpError(409, 'Заказ уже закрыт — создайте новый');

      let result = null;
      if (outcome === 'paid') {
        await journal.record('order_paid', { orderId: order.id, userId: user.id, planId: order.planId, price: order.price, last4 });
        result = await issueMembership(order);
      }

      const fresh = await orders.byIdOrder(id);
      sendJson(res, 200, {
        order: publicOrder(fresh),
        alreadyPaid: outcome === 'duplicate',
        membership: result ? { extended: result.extended } : null,
      });
    },

    'POST /api/orders/:id/cancel': async (req, res, { params }) => {
      assertSameOrigin(req);
      const id = String(params.id ?? '');
      if (!ID_RE.test(id)) throw new HttpError(404, 'Заказ не найден');
      const { user } = await requireUser(req);
      const order = await orders.byIdOrder(id);
      if (!order || order.userId !== user.id) throw new HttpError(404, 'Заказ не найден');
      if (order.status !== 'pending') throw new HttpError(409, 'Заказ уже закрыт и не отменяется');
      const updated = await orders.patch(order.id, (o) => {
        o.status = 'cancelled';
        o.cancelledAt = clock().toISOString();
      });
      await journal.record('order_cancelled', { orderId: order.id, userId: user.id });
      sendJson(res, 200, { order: publicOrder(updated) });
    },
  };

  return { routes, dynamic };
}
