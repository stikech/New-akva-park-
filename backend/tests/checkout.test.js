/**
 * Корзина и оплата: цены с сервера, согласие с офертой, оплата картой (эмулятор и
 * запросы к TipTop Pay), 3-D Secure, перевод на карту с подтверждением сотрудником.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readConfig, parseStaff } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createFileStore } from '../src/store.js';
import { createTipTopPay, interpret, verifyNotification } from '../src/tiptoppay.js';
import { shiftDate, isoWeekday } from '../src/schedule.js';

const silentLog = { info() {}, error() {}, warn() {} };
const json = (body, headers = {}, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const todayCity = () => new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);
let keySeq = 0;
const idem = () => ({ 'Idempotency-Key': `test-key-${Date.now()}-${keySeq += 1}` });

async function startServer(env = {}, extra = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'neptun-checkout-'));
  const config = readConfig({ ADMIN_TOKEN: 'test-token', DATA_DIR: dataDir, ...env });
  const server = http.createServer(createApp({ config, store: createFileStore(dataDir), log: silentLog, ...extra }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** Ближайший будний день (пн–пт) от сегодня. */
function nextWeekday() {
  for (let i = 1; i < 8; i += 1) {
    const d = shiftDate(todayCity(), i);
    if (isoWeekday(d) <= 5) return d;
  }
  throw new Error('unreachable');
}
function nextSaturday() {
  for (let i = 1; i < 8; i += 1) {
    const d = shiftDate(todayCity(), i);
    if (isoWeekday(d) === 6) return d;
  }
  throw new Error('unreachable');
}

const contact = { name: 'Айгерим', phone: '+7 705 123 45 67', email: 'aigerim@mail.kz' };

describe('корзина: заказ и оплата картой (PAYMENT_MODE=demo)', () => {
  let srv;
  before(async () => { srv = await startServer({ PAYMENT_MODE: 'demo', STAFF_LOGINS: 'Ержан:erzhan-pass-123' }); });
  after(() => srv.close());

  const create = (body, headers = {}) => fetch(`${srv.base}/api/checkout`, json(body, { Origin: srv.base, ...idem(), ...headers }));

  test('options: каталог и способы оплаты; секрет TipTop Pay не отдаётся', async () => {
    const data = await fetch(`${srv.base}/api/checkout/options`).then((r) => r.json());
    assert.ok(data.catalog.find((i) => i.id === 'park:adult:weekday:h2'));
    assert.ok(data.catalog.find((i) => i.id === 'plan:gold:6' && i.kind === 'membership'));
    assert.equal(data.methods.card.enabled, true);
    assert.equal(data.methods.card.provider, 'demo');
    assert.ok(!JSON.stringify(data).includes('apiSecret'));
  });

  test('сумму считает сервер; цена из браузера игнорируется', async () => {
    const res = await create({
      cart: [{ id: 'park:adult:weekday:h2', qty: 2, price: 1 }, { id: 'massage:0', qty: 1 }],
      contact, visitDate: nextWeekday(), consent: true, total: 5,
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.order.total, 5700 * 2 + 7000);
    assert.match(body.order.code, /^NP-[A-Z2-9]{5}$/);
    assert.equal(body.order.status, 'pending');
    assert.equal(body.order.contact.phone, undefined, 'контакты наружу не отдаются');
  });

  test('без согласия с офертой, без даты, с неизвестной позицией — 422', async () => {
    const noConsent = await create({ cart: [{ id: 'massage:0', qty: 1 }], contact });
    assert.equal(noConsent.status, 422);
    assert.ok((await noConsent.json()).errors.consent);

    const noDate = await create({ cart: [{ id: 'park:child:weekday:unl', qty: 1 }], contact, consent: true });
    assert.ok((await noDate.json()).errors.visitDate);

    const unknown = await create({ cart: [{ id: 'park:vip:gold', qty: 1 }], contact, consent: true });
    assert.ok((await unknown.json()).errors.cart);

    const badPhone = await create({ cart: [{ id: 'massage:0', qty: 1 }], contact: { ...contact, phone: '123' }, consent: true });
    assert.ok((await badPhone.json()).errors['contact.phone']);
  });

  test('билет «будни» на субботу — 422 с подсказкой', async () => {
    const res = await create({ cart: [{ id: 'park:adult:weekday:unl', qty: 1 }], contact, visitDate: nextSaturday(), consent: true });
    assert.equal(res.status, 422);
    assert.match((await res.json()).errors.visitDate, /выходного/);
  });

  test('абонемент без входа в кабинет — 422 account', async () => {
    const res = await create({ cart: [{ id: 'plan:gold:1', qty: 1 }], contact, consent: true });
    assert.ok((await res.json()).errors.account);
  });

  test('тот же Idempotency-Key — тот же заказ', async () => {
    const headers = idem();
    const body = { cart: [{ id: 'press:single', qty: 1 }], contact, consent: true };
    const a = await (await create(body, headers)).json();
    const b = await create(body, headers);
    assert.equal(b.status, 200);
    assert.equal((await b.json()).order.id, a.order.id);
  });

  test('оплата картой: успех → paid, подписанный чек, последние 4 цифры', async () => {
    const { order } = await (await create({ cart: [{ id: 'fit:day:1', qty: 2 }], contact, consent: true })).json();
    const res = await fetch(`${srv.base}/api/checkout/${order.id}/card`, json({ cryptogram: 'demo:4242424242424242' }, { Origin: srv.base }));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.order.status, 'paid');
    assert.equal(body.order.method, 'card');
    assert.equal(body.order.card.last4, '4242');
    assert.equal(body.order.receipt.valid, true);

    const again = await fetch(`${srv.base}/api/checkout/${order.id}/card`, json({ cryptogram: 'demo:4242424242424242' }, { Origin: srv.base }));
    assert.equal((await again.json()).alreadyPaid, true, 'повторная оплата не списывает второй раз');
  });

  test('оплата картой: отказ банка — 402, заказ остаётся неоплаченным', async () => {
    const { order } = await (await create({ cart: [{ id: 'fit:day:1', qty: 1 }], contact, consent: true })).json();
    const res = await fetch(`${srv.base}/api/checkout/${order.id}/card`, json({ cryptogram: 'demo:4000000000000002' }, { Origin: srv.base }));
    assert.equal(res.status, 402);
    const status = await fetch(`${srv.base}/api/checkout/${order.id}`).then((r) => r.json());
    assert.equal(status.order.status, 'pending');
  });

  test('3-D Secure: ответ с формой банка → возврат на /api/checkout/3ds → paid', async () => {
    const { order } = await (await create({ cart: [{ id: 'sol:0:50', qty: 1 }], contact, consent: true })).json();
    const res = await fetch(`${srv.base}/api/checkout/${order.id}/card`, json({ cryptogram: 'demo:4111111111113333' }, { Origin: srv.base }));
    const { threeDs } = await res.json();
    assert.ok(threeDs.acsUrl.startsWith('/api/checkout/demo-acs'));
    assert.ok(threeDs.termUrl.endsWith('/api/checkout/3ds'));

    const back = await fetch(`${srv.base}/api/checkout/3ds`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://bank.example' },
      body: new URLSearchParams({ MD: threeDs.md, PaRes: 'ok' }),
    });
    assert.equal(back.status, 303);
    assert.equal(back.headers.get('location'), `/checkout?order=${order.id}`);
    const status = await fetch(`${srv.base}/api/checkout/${order.id}`).then((r) => r.json());
    assert.equal(status.order.status, 'paid');
  });

  test('абонемент в корзине: после оплаты выдаётся в кабинет', async () => {
    const reg = await fetch(`${srv.base}/api/auth/register`, json({ email: 'buyer@mail.kz', password: 'supersafepw1', firstName: 'Покупатель', consent: true }, { Origin: srv.base }));
    const cookie = reg.headers.get('set-cookie').split(';')[0];
    const res = await create({ cart: [{ id: 'plan:gold:1', qty: 3 }, { id: 'press:course', qty: 1 }], contact, consent: true }, { Cookie: cookie });
    const { order } = await res.json();
    assert.equal(res.status, 201);
    assert.equal(order.lines.find((l) => l.kind === 'membership').qty, 1, 'абонемент — всегда одна штука');

    await fetch(`${srv.base}/api/checkout/${order.id}/card`, json({ cryptogram: 'demo:5555555555554444' }, { Origin: srv.base }));
    const me = await fetch(`${srv.base}/api/account`, { headers: { Cookie: cookie } }).then((r) => r.json());
    assert.match(me.user.membership.title, /Золотая/);

    const mine = await fetch(`${srv.base}/api/checkout/mine`, { headers: { Cookie: cookie } }).then((r) => r.json());
    assert.equal(mine.items[0].id, order.id);
  });

  test('разовое занятие: запись гостя → оплата в корзине → запись оплачена', async () => {
    const schedule = await fetch(`${srv.base}/api/schedule?days=7`).then((r) => r.json());
    const slot = schedule.days.slice(1).flatMap((d) => d.slots).find((s) => s.bookable);
    const booked = await fetch(`${srv.base}/api/bookings`, json({ key: slot.key, guest: contact, consent: true }, { Origin: srv.base }));
    const { booking } = await booked.json();
    assert.equal(booked.status, 201);

    const forged = await create({ cart: [{ id: `class:${slot.key}`, qty: 1 }], contact, consent: true });
    assert.equal(forged.status, 422, 'без записи занятие в корзину не положить');

    const res = await create({ cart: [{ id: `class:${slot.key}`, qty: 1, ref: booking.id }], contact, consent: true });
    const { order } = await res.json();
    assert.equal(res.status, 201);
    assert.equal(order.total, slot.singlePrice);
    await fetch(`${srv.base}/api/checkout/${order.id}/card`, json({ cryptogram: 'demo:4242424242424242' }, { Origin: srv.base }));

    const day = await fetch(`${srv.base}/api/admin/bookings?date=${slot.date}`, { headers: { Authorization: 'Bearer test-token' } }).then((r) => r.json());
    assert.equal(day.items.find((b) => b.id === booking.id).paid, true);
  });

  test('админка: сотрудник входит своим паролем, видит заказы и отмечает выдачу', async () => {
    const staff = { Authorization: 'Bearer erzhan-pass-123' };
    assert.deepEqual(await fetch(`${srv.base}/api/admin/me`, { headers: staff }).then((r) => r.json()), { id: 'env:Ержан', name: 'Ержан', role: 'staff' });
    assert.equal((await fetch(`${srv.base}/api/admin/me`, { headers: { Authorization: 'Bearer wrong-password' } })).status, 401);

    const list = await fetch(`${srv.base}/api/admin/checkout`, { headers: staff }).then((r) => r.json());
    const paid = list.items.find((o) => o.status === 'paid');
    assert.equal(paid.contact.phone, '+77051234567', 'сотрудник видит контакты');
    const redeem = await fetch(`${srv.base}/api/admin/checkout/${paid.id}/redeem`, json({}, staff));
    assert.equal(redeem.status, 200);
    const twice = await fetch(`${srv.base}/api/admin/checkout/${paid.id}/redeem`, json({}, staff));
    assert.equal(twice.status, 409);
  });
});

describe('корзина: перевод на карту и подтверждение сотрудником', () => {
  let srv;
  before(async () => {
    srv = await startServer({ PAY_CARD_NUMBER: '4400 4301 2345 6789', PAY_CARD_BANK: 'Kaspi Gold', STAFF_LOGINS: 'Анна:anna-pass-1234' });
  });
  after(() => srv.close());

  test('реквизиты карты в options, картой на сайте — выключено без ключей TipTop Pay', async () => {
    const { methods } = await fetch(`${srv.base}/api/checkout/options`).then((r) => r.json());
    assert.deepEqual(methods.transfer, { enabled: true, number: '4400 4301 2345 6789', bank: 'Kaspi Gold', holder: null });
    assert.equal(methods.card.enabled, false);
  });

  test('«Я оплатил» → сотруднику нельзя, владелец подтверждает → paid, кто подтвердил — в заказе', async () => {
    const res = await fetch(`${srv.base}/api/checkout`, json({ cart: [{ id: 'pool:adult:2', qty: 2 }], contact, consent: true }, { Origin: srv.base, ...idem() }));
    const { order } = await res.json();

    const card = await fetch(`${srv.base}/api/checkout/${order.id}/card`, json({ cryptogram: 'demo:4242424242424242' }, { Origin: srv.base }));
    assert.equal(card.status, 409, 'эмулятор карт на боевом режиме выключен');

    const claim = await fetch(`${srv.base}/api/checkout/${order.id}/claim`, json({ method: 'transfer' }, { Origin: srv.base }));
    assert.equal((await claim.json()).order.claim.method, 'transfer');

    const staff = { Authorization: 'Bearer anna-pass-1234' };
    const denied = await fetch(`${srv.base}/api/admin/checkout/${order.id}/confirm`, json({}, staff));
    assert.equal(denied.status, 403, 'деньги подтверждает только владелец');

    const confirm = await fetch(`${srv.base}/api/admin/checkout/${order.id}/confirm`, json({}, { Authorization: 'Bearer test-token' }));
    const body = await confirm.json();
    assert.equal(confirm.status, 200);
    assert.equal(body.order.status, 'paid');
    assert.equal(body.order.method, 'transfer');
    const list = await fetch(`${srv.base}/api/admin/checkout`, { headers: staff }).then((r) => r.json());
    assert.equal(list.items.find((o) => o.id === order.id).paidBy, 'Владелец');
  });

  test('отклонение перевода — cancelled с причиной', async () => {
    const { order } = await (await fetch(`${srv.base}/api/checkout`, json({ cart: [{ id: 'massage:1', qty: 1 }], contact, consent: true }, { Origin: srv.base, ...idem() }))).json();
    const res = await fetch(`${srv.base}/api/admin/checkout/${order.id}/reject`, json({ reason: 'Нет поступления' }, { Authorization: 'Bearer test-token' }));
    const body = await res.json();
    assert.equal(body.order.status, 'cancelled');
    assert.equal(body.order.rejectReason, 'Нет поступления');
  });
});

describe('TipTop Pay: запросы к API и ответы', () => {
  test('charge отправляет криптограмму, сумму и номер заказа с Basic-авторизацией', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ Success: true, Model: { TransactionId: 77, Status: 'Completed', CardLastFour: '1234', CardType: 'Visa' } }), { status: 200 });
    };
    const api = createTipTopPay({ publicId: 'pk_test', apiSecret: 'secret', apiUrl: 'https://api.tiptoppay.kz' }, { fetchImpl, log: silentLog });
    const result = await api.charge({ cryptogram: 'CRYPTO', amount: 5700, invoiceId: 'NP-ABCDE', ip: '1.2.3.4', email: 'a@b.kz' });
    assert.deepEqual(result, { kind: 'paid', transactionId: 77, last4: '1234', brand: 'Visa' });
    assert.equal(calls[0].url, 'https://api.tiptoppay.kz/payments/cards/charge');
    assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from('pk_test:secret').toString('base64')}`);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.CardCryptogramPacket, 'CRYPTO');
    assert.equal(sent.Amount, 5700);
    assert.equal(sent.InvoiceId, 'NP-ABCDE');
    assert.equal(sent.Currency, 'KZT');
  });

  test('ответы: 3-D Secure, отказ, ошибка', () => {
    assert.equal(interpret({ Success: false, Model: { TransactionId: 5, AcsUrl: 'https://acs.bank', PaReq: 'xx' } }).kind, '3ds');
    const declined = interpret({ Success: false, Model: { TransactionId: 5, CardHolderMessage: 'Недостаточно средств' } });
    assert.equal(declined.kind, 'declined');
    assert.equal(declined.message, 'Недостаточно средств');
    assert.equal(interpret({ Success: false, Message: 'Invalid' }).kind, 'error');
  });

  test('подпись уведомления проверяется HMAC', () => {
    const raw = 'InvoiceId=NP-ABCDE&Amount=100.00';
    const sig = createHmac('sha256', 'secret').update(raw).digest('base64');
    assert.equal(verifyNotification(raw, { 'content-hmac': sig }, 'secret'), true);
    assert.equal(verifyNotification(raw, { 'content-hmac': 'forged' }, 'secret'), false);
    assert.equal(verifyNotification(raw, { 'content-hmac': sig }, null), false);
  });

  test('STAFF_LOGINS: короткие пароли и мусор отбрасываются', () => {
    assert.deepEqual(parseStaff('Анна:anna-pass-1234; Иван:123 ;:nobody12345;Ержан:erzhan-pass'), [
      { name: 'Анна', password: 'anna-pass-1234' },
      { name: 'Ержан', password: 'erzhan-pass' },
    ]);
  });
});
