/**
 * Корзина и оформление заказа: билеты аквапарка, бассейн, фитнес, абонементы, SPA
 * и разовые занятия — одним заказом, тремя способами оплаты.
 *
 * Способы оплаты (включаются в backend/payment.config.js):
 *   card     — картой на сайте через TipTop Pay: криптограмма из браузера → charge → 3-D Secure →
 *              заказ оплачен автоматически, деньги на расчётном счёте;
 *   transfer — перевод на банковскую карту: клиент переводит сумму с кодом заказа и жмёт «Я оплатил»,
 *              сотрудник сверяет поступление и подтверждает в /admin → «Оплаты»;
 *   kaspi    — то же по номеру телефона Kaspi.
 *
 * Безопасность — как у остальных платёжных модулей:
 *  - цены ТОЛЬКО из каталога на сервере (utils/catalog.js + site-data.js), сумму с фронта не принимаем;
 *  - Idempotency-Key обязателен: повтор вернёт тот же заказ, двойного заказа не будет;
 *  - pending → paid ровно один раз (атомарная мутация стора), выдача абонемента — однажды;
 *  - данные карты на сервер не приходят: только криптограмма TipTop Pay, в заказе — последние 4 цифры;
 *  - согласие с офертой, правилами и обработкой персональных данных обязательно (consentAt);
 *  - чек подписан HMAC-SHA256 ключом PAYMENT_SECRET;
 *  - лимиты на создание заказов и попытки оплаты по IP; журнал audit.js.
 *
 *   GET  /api/checkout/options             — каталог корзины и доступные способы оплаты
 *   POST /api/checkout                     — создать заказ { cart, contact, visitDate?, consent }
 *   GET  /api/checkout/mine                — мои заказы (вошедший пользователь)
 *   GET  /api/checkout/:id                 — статус заказа (id — UUID, знает только покупатель)
 *   POST /api/checkout/:id/card            — оплатить картой { cryptogram }
 *   POST /api/checkout/:id/claim           — «Я оплатил» переводом { method: 'transfer'|'kaspi' }
 *   POST /api/checkout/3ds                 — банк вернул покупателя после 3-D Secure (MD, PaRes)
 *   GET  /api/checkout/demo-acs            — страница «банка» для PAYMENT_MODE=demo
 *   POST /api/payments/tiptoppay/pay       — уведомление TipTop Pay об оплате (HMAC)
 *   GET  /api/admin/checkout               — все заказы (сотрудники)
 *   POST /api/admin/checkout/:id/confirm   — перевод найден: заказ оплачен
 *   POST /api/admin/checkout/:id/reject    — перевод не найден { reason? }
 *   POST /api/admin/checkout/:id/redeem    — заказ выдан / гости прошли
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError, assertSameOrigin, clientIp, readJsonBody, sendJson } from './http.js';
import { createRateLimiter } from './rate-limit.js';
import { sessionToken } from './session.js';
import { SITE_DATA } from '../../frontend/assets/js/config/site-data.js';
import { CLASS_ID_RE, GROUPS, buildCatalog, cartNeeds, classItem, priceCart } from '../../frontend/assets/js/utils/catalog.js';
import { cityDateString, daysBetween, isValidDate, normalizePhone } from '../../frontend/assets/js/utils/account.js';
import { buildCatalog as buildPlans } from './memberships.js';
import { applyPlan } from './membership-service.js';
import { createScheduleModule, isoWeekday } from './schedule.js';
import { formatPhone, kaspiInfo, newPayCode } from './kaspi.js';
import { cardInfo, createDemoGateway, createTipTopPay, verifyNotification } from './tiptoppay.js';

const IDEMPOTENCY_RE = /^[A-Za-z0-9._-]{16,80}$/;
const ID_RE = /^[0-9a-f-]{36}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const VISIT_DAYS_AHEAD = 60;
const METHOD_LABEL = { card: 'картой на сайте', transfer: 'переводом на карту', kaspi: 'переводом Kaspi', desk: 'на кассе' };

/** Реквизиты перевода на карту для клиента. */
export function transferInfo(config) {
  const { number, bank, holder } = config.cardTransfer ?? {};
  const digits = String(number ?? '').replace(/\D/g, '');
  if (digits.length < 16 || digits.length > 19) return { enabled: false };
  return {
    enabled: true,
    number: digits.replace(/(\d{4})(?=\d)/g, '$1 '),
    bank: bank ?? null,
    holder: holder ?? null,
  };
}

export function paymentMethods(config) {
  const kaspi = kaspiInfo(config);
  return {
    card: cardInfo(config),
    transfer: transferInfo(config),
    kaspi: { enabled: kaspi.enabled, phone: kaspi.phone, receiver: kaspi.receiver, payLink: kaspi.payLink, qr: kaspi.qr },
    seller: kaspi.seller,
  };
}

export function createCheckoutRoutes({
  config, checkout, accounts, bookings, journal, requireAdmin, notifier = null, log = console,
  clock = () => new Date(), gateway = null,
}) {
  if (!config.paymentSecret) throw new Error('checkout.js: не задан PAYMENT_SECRET — чеки без подписи недопустимы');

  const catalog = buildCatalog(SITE_DATA);
  const plans = new Map(buildPlans().map((p) => [p.id, p]));
  for (const item of catalog) {
    if (item.planId && !plans.has(item.planId)) throw new Error(`checkout.js: тариф ${item.planId} есть в корзине, но нет в memberships.js`);
  }
  const schedule = createScheduleModule();
  const today = () => cityDateString(SITE_DATA.tzOffsetHours, clock());

  const t = config.tiptoppay ?? {};
  const pay = gateway
    ?? (config.paymentMode === 'demo' ? createDemoGateway()
      : t.publicId && t.apiSecret ? createTipTopPay(t, { log }) : null);

  const createLimiter = createRateLimiter({ max: 30, windowMs: 60 * 60_000 });
  const payLimiter = createRateLimiter({ max: 20, windowMs: 15 * 60_000 });
  const claimLimiter = createRateLimiter({ max: 20, windowMs: 60 * 60_000 });
  setInterval(() => [createLimiter, payLimiter, claimLimiter].forEach((l) => l.sweep()), 60_000).unref();
  setInterval(() => { checkout.sweepExpired(); }, 10 * 60_000).unref();

  const tooMany = (limit) => new HttpError(429, 'Слишком много попыток. Попробуйте позже.', {
    error: 'Слишком много попыток. Попробуйте позже.', retryAfterSec: limit.retryAfterSec,
  });

  // ---------- чек ----------

  const signature = (r) => createHmac('sha256', config.paymentSecret)
    .update([r.orderId, r.code, r.receiptId, String(r.amount), r.method, r.paidAt].join('|'))
    .digest('base64url');

  function receiptValid(r) {
    if (!r) return false;
    const expected = Buffer.from(signature(r));
    const given = Buffer.from(String(r.signature ?? ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  function buildReceipt(order, method, { last4 = null, brand = null } = {}) {
    const r = {
      receiptId: `r_${randomBytes(6).toString('base64url')}`,
      orderId: order.id, code: order.code, amount: order.total, method, last4, brand,
      paidAt: clock().toISOString(),
    };
    return { ...r, signature: signature(r) };
  }

  // ---------- представление ----------

  function publicOrder(o) {
    return {
      id: o.id,
      code: o.code,
      status: o.status,
      lines: o.lines,
      total: o.total,
      visitDate: o.visitDate,
      contact: { name: o.contact.name },
      method: o.method,
      claim: o.claim,
      needsAccount: o.lines.some((l) => l.kind === 'membership'),
      card: o.card ? { last4: o.card.last4 ?? null, brand: o.card.brand ?? null } : null,
      paidAt: o.paidAt,
      usedAt: o.usedAt,
      rejectReason: o.rejectReason,
      createdAt: o.createdAt,
      receipt: o.receipt ? { ...o.receipt, valid: receiptValid(o.receipt) } : null,
    };
  }

  function adminOrder(o, usersById) {
    const u = o.userId ? usersById.get(o.userId) : null;
    return {
      ...publicOrder(o),
      contact: o.contact,
      userId: o.userId,
      user: u ? { email: u.email, name: [u.firstName, u.lastName].filter(Boolean).join(' ') } : null,
      paidBy: o.paidBy,
      usedBy: o.usedBy,
      fulfilled: o.fulfilled,
      attempts: o.attempts.length,
    };
  }

  // ---------- выдача: абонемент и оплаченные занятия ----------

  async function fulfill(order) {
    if (order.fulfilled) return;
    const result = { membership: null, bookings: [] };
    for (const line of order.lines) {
      if (line.kind === 'membership' && order.userId) {
        const plan = plans.get(line.planId);
        let applied = null;
        await accounts.updateUser(order.userId, (u) => {
          if (!u) return false;
          applied = applyPlan({ membership: u.membership, plan, today: today(), nowISO: clock().toISOString(), orderId: order.id });
          u.membership = applied.membership;
          return true;
        });
        result.membership = applied ? (applied.extended ? 'extended' : 'issued') : 'account_missing';
        await journal.record('membership_applied', { orderId: order.id, userId: order.userId, planId: line.planId, ok: Boolean(applied) });
      }
      if (line.kind === 'class' && line.bookingId) {
        await bookings.markPaid(line.bookingId, order.id);
        result.bookings.push(line.bookingId);
      }
    }
    await checkout.patch(order.id, (o) => { o.fulfilled = result; });
  }

  /** pending → paid ровно один раз. Возвращает 'paid' | 'already' | 'closed'. */
  async function markPaid(id, { method, by, last4 = null, brand = null, transactionId = null }) {
    let outcome = 'closed';
    let snapshot = null;
    await checkout.patch(id, (o) => {
      if (o.status === 'paid') { outcome = 'already'; return; }
      if (o.status !== 'pending' && !(o.status === 'expired' && method === 'card')) return;
      o.status = 'paid';
      o.method = method;
      o.paidAt = clock().toISOString();
      o.paidBy = by;
      if (method === 'card') o.card = { ...o.card, last4, brand, transactionId, threeDs: o.card?.threeDs ?? null };
      o.receipt = buildReceipt(o, method, { last4, brand });
      outcome = 'paid';
      snapshot = { ...o };
    });
    if (outcome === 'paid') {
      await journal.record('checkout_paid', { orderId: id, code: snapshot.code, total: snapshot.total, method, by });
      log.info?.(`[checkout] ${snapshot.code} оплачен (${METHOD_LABEL[method]}, ${by})`);
      await fulfill(snapshot);
      if (method === 'card') {
        notifier?.send?.(`✅ Оплата картой на сайте\nЗаказ ${snapshot.code}: ${money(snapshot.total)}\n${linesText(snapshot)}\nКлиент: ${contactText(snapshot)}`);
      }
    }
    return outcome;
  }

  // ---------- проверка заказа ----------

  async function parseOrder(body, user) {
    const errors = {};
    const cart = Array.isArray(body?.cart) ? body.cart.slice(0, 40) : [];
    if (!cart.length) errors.cart = 'Корзина пуста';

    // Разовые занятия: место уже занято записью — проверяем запись и строим позицию.
    const extra = [];
    const bookingByLine = new Map();
    for (const line of cart) {
      const m = CLASS_ID_RE.exec(String(line?.id ?? ''));
      if (!m) continue;
      const slot = schedule.find(`${m[1]}:${m[2]}`);
      const booking = typeof line.ref === 'string' && ID_RE.test(line.ref) ? await bookings.find(line.ref) : null;
      if (!slot || !booking || booking.key !== slot.key || booking.status !== 'booked') {
        errors.cart = 'Запись на занятие не найдена — запишитесь заново на странице «Занятия»';
        continue;
      }
      if (booking.paidOrderId) { errors.cart = `Занятие «${slot.title}» уже оплачено`; continue; }
      const item = classItem(slot, SITE_DATA);
      if (item) { extra.push(item); bookingByLine.set(item.id, booking.id); }
    }

    const priced = priceCart(cart.map((l) => ({ id: l?.id, qty: l?.qty })), [...catalog, ...extra]);
    if (priced.rejected.length && !errors.cart) errors.cart = 'В корзине есть позиции, которых больше нет в продаже — обновите страницу';
    if (priced.overflow) errors.cart = 'Слишком много разных позиций в одном заказе';
    if (!priced.lines.length && !errors.cart) errors.cart = 'Корзина пуста';

    const needs = cartNeeds(priced.lines);
    if (needs.memberships > 1) errors.cart = 'Абонемент в заказе может быть только один — он привязывается к кабинету';
    if (needs.account && !user) errors.account = 'Абонемент привязывается к личному кабинету — войдите или зарегистрируйтесь';

    let visitDate = null;
    if (needs.visitDate) {
      const raw = String(body?.visitDate ?? '');
      if (!isValidDate(raw)) errors.visitDate = 'Выберите дату визита';
      else {
        const ahead = daysBetween(today(), raw);
        if (ahead < 0) errors.visitDate = 'Дата уже прошла';
        else if (ahead > VISIT_DAYS_AHEAD) errors.visitDate = `Не дальше чем на ${VISIT_DAYS_AHEAD} дней вперёд`;
        else if (isoWeekday(raw) >= 6 && priced.lines.some((l) => l.id.includes(':weekday:'))) {
          errors.visitDate = 'В выходные действует тариф выходного дня — поменяйте билеты в корзине';
        } else visitDate = raw;
      }
    }

    const c = typeof body?.contact === 'object' && body.contact !== null ? body.contact : {};
    const name = String(c.name ?? '').trim();
    if (!name) errors['contact.name'] = 'Укажите имя';
    else if (name.length > 80) errors['contact.name'] = 'Не длиннее 80 символов';
    const phone = normalizePhone(c.phone);
    if (!phone) errors['contact.phone'] = 'Телефон в формате +7 7XX XXX-XX-XX';
    const email = String(c.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 120) errors['contact.email'] = 'Почта для чека, например name@mail.kz';

    if (body?.consent !== true) errors.consent = 'Нужно принять условия публичной оферты';

    if (Object.keys(errors).length) return { ok: false, errors };
    const lines = priced.lines.map((l) => (bookingByLine.has(l.id) ? { ...l, bookingId: bookingByLine.get(l.id) } : l));
    return { ok: true, value: { lines, total: priced.total, visitDate, contact: { name, phone, email } } };
  }

  async function optionalUser(req) {
    if (!sessionToken(req)) return null;
    return accounts.userBySession(sessionToken(req)).catch(() => null);
  }

  async function orderById(id) {
    const order = ID_RE.test(String(id ?? '')) ? await checkout.byId(String(id)) : null;
    if (!order) throw new HttpError(404, 'Заказ не найден');
    return order;
  }

  /** Куда банк вернёт покупателя после 3-D Secure. */
  function termUrl(req) {
    const base = config.publicUrl
      ?? `${req.headers['x-forwarded-proto']?.split(',')[0] === 'https' ? 'https' : 'http'}://${req.headers.host}`;
    return `${base.replace(/\/$/, '')}/api/checkout/3ds`;
  }

  // ---------- маршруты ----------

  const routes = {
    'GET /api/checkout/options': (req, res) => {
      sendJson(res, 200, { groups: GROUPS, catalog, methods: paymentMethods(config), today: today(), visitDaysAhead: VISIT_DAYS_AHEAD });
    },

    'POST /api/checkout': async (req, res) => {
      assertSameOrigin(req);
      const limit = createLimiter.hit(clientIp(req, config.trustProxyHops));
      if (!limit.ok) throw tooMany(limit);
      const key = String(req.headers['idempotency-key'] ?? '');
      if (!IDEMPOTENCY_RE.test(key)) throw new HttpError(400, 'Заголовок Idempotency-Key обязателен (16–80 символов)');

      const body = await readJsonBody(req, { limitBytes: 32 * 1024 });
      const user = await optionalUser(req);
      const parsed = await parseOrder(body, user);
      if (!parsed.ok) return sendJson(res, 422, { errors: parsed.errors });

      const nowISO = clock().toISOString();
      const { order, created } = await checkout.create(
        { ...parsed.value, code: newPayCode(), userId: user?.id ?? null, consentAt: nowISO },
        { idempotencyKey: key, now: nowISO },
      );
      if (created) {
        await journal.record('checkout_created', { orderId: order.id, code: order.code, total: order.total, lines: order.lines.length });
        log.info?.(`[checkout] создан ${order.code} на ${order.total} ₸`);
      }
      sendJson(res, created ? 201 : 200, { order: publicOrder(order), methods: paymentMethods(config) });
    },

    'GET /api/checkout/mine': async (req, res) => {
      const user = await optionalUser(req);
      if (!user) throw new HttpError(401, 'Войдите в личный кабинет');
      const items = (await checkout.listByUser(user.id)).map(publicOrder);
      sendJson(res, 200, { items });
    },

    'POST /api/checkout/3ds': async (req, res) => {
      // Сюда POST-ом приходит браузер покупателя со страницы банка — Origin чужой, это нормально:
      // подделать результат нельзя, итог проверяет TipTop Pay (post3ds).
      const form = await readForm(req);
      const order = form.MD ? await checkout.byTransaction(form.MD) : null;
      if (!order) return redirect(res, '/checkout?error=3ds');
      const back = `/checkout?order=${order.id}`;
      if (order.status === 'paid' || !pay) return redirect(res, back);

      const result = await pay.post3ds({ transactionId: form.MD, paRes: String(form.PaRes ?? '') });
      if (result.kind === 'paid') {
        await markPaid(order.id, { method: 'card', by: config.paymentMode === 'demo' ? 'demo' : 'tiptoppay', ...result });
        return redirect(res, back);
      }
      await checkout.patch(order.id, (o) => { o.attempts.push({ at: clock().toISOString(), ok: false, step: '3ds', message: result.message }); });
      await journal.record('checkout_card_declined', { orderId: order.id, step: '3ds' });
      return redirect(res, `${back}&declined=${encodeURIComponent(result.message ?? 'Платёж не прошёл')}`);
    },

    'GET /api/checkout/demo-acs': (req, res) => {
      if (config.paymentMode !== 'demo') throw new HttpError(404, 'Не найдено');
      const q = new URL(req.url, 'http://x').searchParams;
      const md = String(q.get('md') ?? '').replace(/\D/g, '');
      const html = `<!doctype html><meta charset="utf-8"><title>3-D Secure (демо)</title>
        <body style="font-family:sans-serif;max-width:420px;margin:40px auto">
        <h1>Подтверждение платежа</h1><p>Демо-страница банка: так выглядит шаг 3-D Secure.</p>
        <form method="post" action="/api/checkout/3ds"><input type="hidden" name="MD" value="${md}">
        <button name="PaRes" value="ok">Подтвердить</button> <button name="PaRes" value="no">Отклонить</button></form>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    },

    'POST /api/payments/tiptoppay/pay': async (req, res) => {
      const raw = await readRaw(req);
      if (!verifyNotification(raw, req.headers, t.apiSecret)) {
        log.warn?.(`[checkout] уведомление TipTop Pay с неверной подписью, ip=${clientIp(req, config.trustProxyHops)}`);
        throw new HttpError(401, 'Неверная подпись');
      }
      const tx = parseBody(raw, req.headers['content-type']);
      const order = tx.InvoiceId ? await checkout.byCode(String(tx.InvoiceId)) : null;
      if (order && Math.round(Number(tx.Amount) * 100) === order.total * 100) {
        await markPaid(order.id, { method: 'card', by: 'tiptoppay', last4: tx.CardLastFour ?? null, brand: tx.CardType ?? null, transactionId: tx.TransactionId ?? null });
      } else {
        log.warn?.(`[checkout] уведомление TipTop Pay: заказ ${tx.InvoiceId} не найден или сумма не совпала`);
      }
      sendJson(res, 200, { code: 0 });
    },

    'GET /api/admin/checkout': async (req, res) => {
      requireAdmin(req);
      const users = new Map((await accounts.listUsers()).map((u) => [u.id, u]));
      const items = (await checkout.listAll()).map((o) => adminOrder(o, users));
      sendJson(res, 200, { items, total: items.length, today: today() });
    },
  };

  const dynamic = {
    'GET /api/checkout/:id': async (req, res, { params }) => {
      const order = await orderById(params.id);
      sendJson(res, 200, { order: publicOrder(order), methods: paymentMethods(config) });
    },

    'POST /api/checkout/:id/card': async (req, res, { params }) => {
      assertSameOrigin(req);
      const order = await orderById(params.id);
      if (!pay || !cardInfo(config).enabled) throw new HttpError(409, 'Оплата картой на сайте не подключена — выберите перевод');
      if (order.status === 'paid') return sendJson(res, 200, { order: publicOrder(order), alreadyPaid: true });
      if (order.status !== 'pending') throw new HttpError(409, 'Заказ закрыт — оформите корзину заново');

      const ip = clientIp(req, config.trustProxyHops);
      const limit = payLimiter.hit(ip);
      if (!limit.ok) throw tooMany(limit);
      const body = await readJsonBody(req, { limitBytes: 8 * 1024 });
      const cryptogram = String(body?.cryptogram ?? '');
      if (cryptogram.length < 10 || cryptogram.length > 4096) throw new HttpError(422, 'Проверьте данные карты');

      const result = await pay.charge({
        cryptogram, amount: order.total, invoiceId: order.code, ip,
        description: `Аквапарк «Нептун», заказ ${order.code}`,
        email: order.contact.email, name: String(body?.holder ?? '').slice(0, 60), accountId: order.userId ?? order.contact.email,
      });

      if (result.kind === 'paid') {
        await markPaid(order.id, { method: 'card', by: config.paymentMode === 'demo' ? 'demo' : 'tiptoppay', ...result });
        return sendJson(res, 200, { order: publicOrder(await checkout.byId(order.id)) });
      }
      if (result.kind === '3ds') {
        await checkout.patch(order.id, (o) => {
          o.card = { ...o.card, threeDs: { transactionId: result.transactionId, startedAt: clock().toISOString() } };
        });
        const acsUrl = result.acsUrl.startsWith('/') ? `${result.acsUrl}?md=${result.transactionId}` : result.acsUrl;
        return sendJson(res, 200, {
          order: publicOrder(order),
          threeDs: { acsUrl, paReq: result.paReq, md: String(result.transactionId), termUrl: termUrl(req) },
        });
      }
      await checkout.patch(order.id, (o) => { o.attempts.push({ at: clock().toISOString(), ok: false, message: result.message }); });
      await journal.record('checkout_card_declined', { orderId: order.id, kind: result.kind });
      throw new HttpError(result.kind === 'declined' ? 402 : 502, result.message);
    },

    'POST /api/checkout/:id/claim': async (req, res, { params }) => {
      assertSameOrigin(req);
      const order = await orderById(params.id);
      const body = await readJsonBody(req);
      const method = body?.method;
      const methods = paymentMethods(config);
      if (!['transfer', 'kaspi'].includes(method) || !methods[method].enabled) throw new HttpError(422, 'Этот способ оплаты не подключён');
      const limit = claimLimiter.hit(clientIp(req, config.trustProxyHops));
      if (!limit.ok) throw tooMany(limit);
      if (order.status !== 'pending') {
        if (order.status === 'paid') return sendJson(res, 200, { order: publicOrder(order) });
        throw new HttpError(409, 'Заказ закрыт — оформите корзину заново');
      }

      let first = false;
      const updated = await checkout.patch(order.id, (o) => {
        if (o.claim) return;
        o.claim = { method, at: clock().toISOString() };
        first = true;
      });
      if (first) {
        await journal.record('checkout_claimed', { orderId: order.id, code: order.code, method });
        const where = method === 'kaspi' ? `Kaspi ${methods.kaspi.phone}` : `карту ${methods.transfer.number}`;
        notifier?.send?.([
          `💳 Клиент сообщил о переводе (${METHOD_LABEL[method]})`,
          `Заказ ${order.code}: ${money(order.total)}`,
          linesText(order),
          `Клиент: ${contactText(order)}`,
          '',
          `Проверьте поступление на ${where} и подтвердите в админке → «Оплаты».`,
          config.publicUrl ? `${config.publicUrl.replace(/\/$/, '')}/admin` : null,
        ].filter((x) => x !== null).join('\n'));
      }
      sendJson(res, 200, { order: publicOrder(updated) });
    },

    'POST /api/admin/checkout/:id/confirm': async (req, res, { params }) => {
      const staff = requireAdmin(req);
      const order = await orderById(params.id);
      // Клиент не нажимал «Я оплатил» — значит, сотрудник принял оплату на кассе.
      const method = order.claim?.method ?? 'desk';
      const outcome = await markPaid(order.id, { method, by: staff?.name ?? 'admin' });
      if (outcome === 'closed') throw new HttpError(409, 'Заказ закрыт — подтвердить нельзя');
      sendJson(res, 200, { order: publicOrder(await checkout.byId(order.id)), alreadyPaid: outcome === 'already' });
    },

    'POST /api/admin/checkout/:id/reject': async (req, res, { params }) => {
      const staff = requireAdmin(req);
      const order = await orderById(params.id);
      const body = await readJsonBody(req).catch(() => ({}));
      const reason = String(body?.reason ?? '').trim().slice(0, 200) || 'Перевод не найден';
      let ok = false;
      const updated = await checkout.patch(order.id, (o) => {
        if (o.status !== 'pending' && o.status !== 'expired') return;
        o.status = 'cancelled';
        o.cancelledAt = clock().toISOString();
        o.rejectReason = reason;
        ok = true;
      });
      if (!ok) throw new HttpError(409, 'Отклонить можно только неоплаченный заказ');
      await journal.record('checkout_rejected', { orderId: order.id, reason, by: staff?.name ?? 'admin' });
      sendJson(res, 200, { order: publicOrder(updated) });
    },

    'POST /api/admin/checkout/:id/redeem': async (req, res, { params }) => {
      const staff = requireAdmin(req);
      const order = await orderById(params.id);
      let outcome = null;
      const updated = await checkout.patch(order.id, (o) => {
        if (o.status !== 'paid') { outcome = 'unpaid'; return; }
        if (o.usedAt) { outcome = 'used'; return; }
        o.usedAt = clock().toISOString();
        o.usedBy = staff?.name ?? 'admin';
        outcome = 'ok';
      });
      if (outcome === 'unpaid') throw new HttpError(409, 'Заказ не оплачен — выдавать нельзя');
      if (outcome === 'used') throw new HttpError(409, `Заказ уже выдан ${new Date(order.usedAt).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })}`);
      await journal.record('checkout_redeemed', { orderId: order.id, by: staff?.name ?? 'admin' });
      sendJson(res, 200, { order: publicOrder(updated) });
    },
  };

  return { routes, dynamic, catalog };
}

// ---------- помощники ----------

const money = (n) => `${new Intl.NumberFormat('ru-RU').format(n)} ₸`;
const linesText = (o) => o.lines.map((l) => `• ${l.title} (${l.option}) × ${l.qty}`).join('\n');
const contactText = (o) => [o.contact.name, formatPhone(o.contact.phone), o.contact.email].filter(Boolean).join(', ');

function redirect(res, location) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

async function readRaw(req, limitBytes = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, 'Слишком большой запрос');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseBody(raw, contentType = '') {
  if (String(contentType).includes('application/json')) {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

async function readForm(req) {
  return parseBody(await readRaw(req, 64 * 1024), req.headers['content-type']);
}

