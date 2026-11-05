/**
 * Онлайн-покупка билетов аквапарка (разовый визит) из калькулятора на главной.
 * Отличие от абонементов (payments.js): покупка без входа в кабинет, абонемент
 * не выдаётся — только оплата визита; чек с тем же механизмом HMAC.
 *
 * Безопасность — те же правила, что у заказов:
 *  - стоимость ТОЛЬКО из каталога цен на сервере (SITE_DATA.prices.park):
 *    сумму с фронта не принимаем вовсе, фронт передаёт только состав гостей;
 *  - идемпотентность: `Idempotency-Key` обязателен, повтор вернёт тот же визит;
 *  - переход pending → paid ровно один раз (атомарная мутация стора);
 *  - данные карты валидируются, но не хранятся: только последние 4 цифры;
 *  - чек подписывается HMAC-SHA256 ключом PAYMENT_SECRET (planId = 'visit');
 *  - лимиты создания и попыток оплаты по IP (+ по пользователю, если вошёл);
 *  - append-only аудит (audit.js) — visit_created, visit_pay_declined, visit_paid.
 *
 *   POST /api/visits          — создать визит { adults, children, day, duration, contact, consent }
 *   GET  /api/visits/:id      — статус визита (по UUID — публично, как /api/bookings/:key)
 *   POST /api/visits/:id/pay  — оплатить { number, exp, cvc, holder }
 *   GET  /api/admin/visits    — все визиты (администратор)
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError, assertSameOrigin, clientIp, readJsonBody, sendJson } from './http.js';
import { createRateLimiter } from './rate-limit.js';
import { sessionToken } from './session.js';
import { SITE_DATA } from '../../frontend/assets/js/config/site-data.js';
import { cityDateString } from '../../frontend/assets/js/utils/account.js';
import { clampGuests, calcParkTotal } from '../../frontend/assets/js/utils/pricing.js';
import { validateCard } from '../../frontend/assets/js/utils/card.js';

const IDEMPOTENCY_RE = /^[A-Za-z0-9._-]{16,80}$/;
const ID_RE = /^[0-9a-fA-F-]{8,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DAY_VALUES = ['weekday', 'weekend'];
const DURATION_VALUES = ['h2', 'unl'];
/** Коды отклонения по последним четырём цифрам номера (тестовые сценарии шлюза). */
const DECLINE_BY_LAST4 = { '0002': 'declined', '9995': 'insufficient' };
const DECLINE_ERRORS = {
  declined: 'Платёж отклонён банком. Попробуйте другую карту.',
  insufficient: 'Недостаточно средств на карте.',
};

export function createVisitRoutes({
  config, visits, journal, accounts, requireUser = null, requireAdmin, log = console, clock = () => new Date(),
}) {
  if (!config.paymentSecret) {
    throw new Error('visits.js: не задан PAYMENT_SECRET — чеки без подписи недопустимы');
  }
  if (!SITE_DATA.prices?.park) {
    throw new Error('visits.js: в SITE_DATA нет каталога цен аквапарка');
  }
  const parkPrices = SITE_DATA.prices.park;

  const createLimiterIp = createRateLimiter({ max: 40, windowMs: 60 * 60_000 });
  const createLimiterUser = createRateLimiter({ max: 20, windowMs: 60 * 60_000 });
  const payTotalLimiterIp = createRateLimiter({ max: 60, windowMs: 15 * 60_000 });
  const payFailLimiterIp = createRateLimiter({ max: 20, windowMs: 15 * 60_000 });
  setInterval(() => [createLimiterIp, createLimiterUser, payTotalLimiterIp, payFailLimiterIp]
    .forEach((l) => l.sweep()), 60_000).unref();
  setInterval(() => { visits.sweepExpired(); }, 10 * 60_000).unref();

  const tooMany = (limit) => new HttpError(429, 'Слишком много попыток. Попробуйте позже.', {
    error: 'Слишком много попыток. Попробуйте позже.',
    retryAfterSec: limit.retryAfterSec,
  });

  // ---------- чек ----------

  /** HMAC-подпись по всем данным чека. Секрет — PAYMENT_SECRET на сервере. */
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

  function buildReceipt(visit, { last4, brand }) {
    const receipt = {
      receiptId: `r_${randomBytes(6).toString('base64url')}`,
      paidAt: clock().toISOString(),
      last4,
      brand,
      amount: visit.price,
      orderId: visit.id,
      userId: visit.userId,
      planId: 'visit', // чек того же формата, что у абонементов, но план — разовый визит
    };
    return { ...receipt, signature: receiptSignature(receipt) };
  }

  // ---------- валидация и представление ----------

  function parseVisit(body) {
    const errors = {};

    const guests = {};
    for (const [field, label] of [['adults', 'Взрослые'], ['children', 'Дети']]) {
      const n = Number.parseInt(body?.[field], 10);
      if (!Number.isInteger(n) || n < 0 || n > 20) {
        errors[field] = `${label}: целое число от 0 до 20`;
        guests[field] = 0;
      } else guests[field] = n;
    }
    if (guests.adults + guests.children < 1 && !errors.adults && !errors.children) {
      errors.adults = 'Нужен хотя бы один гость';
    }

    if (!DAY_VALUES.includes(body?.day)) errors.day = 'Выберите день: будни или выходные';
    if (!DURATION_VALUES.includes(body?.duration)) errors.duration = 'Выберите тариф: 2 часа или без лимита';

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
    } else errors['contact.email'] = 'Укажите почту для подтверждения визита';

    if (body?.consent !== true) errors.consent = 'Нужно согласие с правилами аквапарка';

    if (Object.keys(errors).length) return { ok: false, errors };

    // Цена считает сервером из каталога: ни сумма, ни тариф с фронта не засчитываются.
    // calcParkTotal ждёт { adult, child, day, duration } — форматы каталога.
    const price = calcParkTotal(parkPrices, { adult: guests.adults, child: guests.children, day: body.day, duration: body.duration });
    if (!Number.isFinite(price) || price <= 0) return { ok: false, errors: { form: 'Не удалось рассчитать стоимость' } };
    return { ok: true, value: { ...contact, adults: guests.adults, children: guests.children, day: body.day, duration: body.duration, price } };
  }

  /** Наружу не отдаём контактные данные: GET публичный, адрес знает только владелец заказа. */
  function publicVisit(v) {
    return {
      id: v.id,
      kind: 'visit',
      adults: v.adults,
      children: v.children,
      day: v.day,
      duration: v.duration,
      price: v.price,
      status: v.status,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
      paidAt: v.paidAt,
      attempts: Array.isArray(v.attempts) ? v.attempts.length : 0,
      receipt: v.receipt
        ? {
          receiptId: v.receipt.receiptId,
          paidAt: v.receipt.paidAt,
          last4: v.receipt.last4,
          brand: v.receipt.brand,
          amount: v.receipt.amount,
          signature: v.receipt.signature,
          valid: receiptValid(v.receipt),
        }
        : null,
    };
  }

  /** Админская версия: контакты и владелец-авторизованный нужны на ресепшене. */
  function adminVisit(v, usersById) {
    return {
      ...publicVisit(v),
      email: v.email,
      firstName: v.firstName,
      phone: v.phone,
      userId: v.userId,
      user: v.userId ? (usersById.get(v.userId) ? { email: usersById.get(v.userId).email } : null) : null,
    };
  }

  const today = () => cityDateString(SITE_DATA.tzOffsetHours, clock());

  // ---------- маршруты ----------

  const routes = {
    'POST /api/visits': async (req, res) => {
      assertSameOrigin(req);
      const ip = clientIp(req, config.trustProxyHops);
      const limitIp = createLimiterIp.hit(ip);
      if (!limitIp.ok) throw tooMany(limitIp);

      const key = req.headers['idempotency-key'];
      if (!IDEMPOTENCY_RE.test(String(key ?? ''))) {
        throw new HttpError(400, 'Заголовок Idempotency-Key обязателен (16–80 символов)');
      }

      const body = await readJsonBody(req);
      const parsed = parseVisit(body);
      if (!parsed.ok) return sendJson(res, 422, { errors: parsed.errors });
      const order = parsed.value;

      // Общедоступный эндпоинт: перебор чужих ключей идемпотентности деньги не
      // тратит, но частые попытки создания режем и на пользователя, если он вошёл.
      if (requireUser && sessionToken(req)) {
        try {
          const { user } = await requireUser(req);
          order.userId = user.id;
          if (!order.firstName) order.firstName = user.firstName ?? '';
          if (!body.contact.phone) order.phone = user.phone ?? null;
          const limitUser = createLimiterUser.hit(user.id);
          if (!limitUser.ok) throw tooMany(limitUser);
        } catch (error) {
          if (error.status === 429) throw error;
          // нет/просрочена сессия — покупаем как гость, это норма
        }
      }

      const nowISO = clock().toISOString();
      const { visit, created } = await visits.create({ ...order, idempotencyKey: String(key), now: nowISO });
      if (created) {
        await journal.record('visit_created', {
          visitId: visit.id, userId: visit.userId ?? null, guests: visit.adults + visit.children, price: visit.price,
        });
        log.info?.(`[visits] создан ${visit.id} (${visit.adults}+${visit.children}, ${visit.day}/${visit.duration})`);
      }
      sendJson(res, created ? 201 : 200, { visit: publicVisit(visit) });
    },

    'GET /api/admin/visits': async (req, res) => {
      requireAdmin(req);
      const users = new Map((await accounts.listUsers()).map((u) => [u.id, u]));
      const items = (await visits.listAll()).map((v) => adminVisit(v, users));
      sendJson(res, 200, { items, total: items.length, today: today() });
    },
  };

  const dynamic = {
    'GET /api/visits/:id': async (req, res, { params }) => {
      const id = String(params.id ?? '');
      if (!ID_RE.test(id)) throw new HttpError(404, 'Визит не найден');
      const visit = await visits.byId(id);
      // UUID достаёт только владелец заказа — статус публичный, контакты не раскрываем
      if (!visit) throw new HttpError(404, 'Визит не найден');
      sendJson(res, 200, { visit: publicVisit(visit) });
    },

    'POST /api/visits/:id/pay': async (req, res, { params }) => {
      assertSameOrigin(req);
      const id = String(params.id ?? '');
      if (!ID_RE.test(id)) throw new HttpError(404, 'Визит не найден');
      const visit = await visits.byId(id);
      if (!visit) throw new HttpError(404, 'Визит не найден');

      if (visit.status === 'paid') {
        // идемпотентный успех: повторная отправка не списывает повторно
        return sendJson(res, 200, { visit: publicVisit(visit), alreadyPaid: true });
      }
      if (visit.status !== 'pending') throw new HttpError(409, 'Визит уже закрыт — создайте новый');

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

      // Эмулятор шлюза: выбор отклонения по последним четырём цифрам.
      const decline = DECLINE_BY_LAST4[last4];
      if (decline) {
        await visits.patch(visit.id, (v) => { v.attempts.push({ at: nowISO, ok: false, code: decline }); });
        payFailLimiterIp.hit(ip);
        await journal.record('visit_pay_declined', { visitId: visit.id, code: decline, last4 });
        return sendJson(res, 402, { error: DECLINE_ERRORS[decline], code: decline });
      }

      // Атомарный переход pending → paid: победит ровно одна попытка.
      let outcome = null;
      const receipt = buildReceipt(visit, check.value);
      await visits.patch(visit.id, (v) => {
        if (v.status === 'paid') { outcome = 'duplicate'; v.attempts.push({ at: nowISO, ok: true, duplicate: true }); return; }
        if (v.status !== 'pending') { outcome = 'conflict'; return; }
        v.status = 'paid';
        v.paidAt = receipt.paidAt;
        v.receipt = receipt;
        v.attempts.push({ at: nowISO, ok: true });
        outcome = 'paid';
      });

      if (outcome === 'conflict') throw new HttpError(409, 'Визит уже закрыт — создайте новый');

      if (outcome === 'paid') {
        await journal.record('visit_paid', {
          visitId: visit.id, userId: visit.userId ?? null, guests: visit.adults + visit.children, price: visit.price, last4,
        });
        log.info?.(`[visits] оплачен ${visit.id}`);
      }

      const fresh = await visits.byId(id);
      sendJson(res, 200, {
        visit: publicVisit(fresh),
        alreadyPaid: outcome === 'duplicate',
      });
    },
  };

  return { routes, dynamic };
}
