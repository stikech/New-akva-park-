/**
 * Заказы и оплата: жизненный цикл, идемпотентность, безопасность.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';

import { readConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createFileStore } from '../src/store.js';

const silentLog = { info() {}, error() {}, warn() {} };
const SECRET = 'payments-secret-for-tests-0123456789';

const CARD_OK = { number: '4242 4242 4242 4242', exp: '12/31', cvc: '123', holder: 'IVAN PETROV' };
const CARD_DECLINED = { ...CARD_OK, number: '4000 0000 0000 0002' };
const CARD_INSUFFICIENT = { ...CARD_OK, number: '5105 1051 0510 9995' };

const json = (body, headers = {}, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

async function startServer(env = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'neptun-pay-'));
  const config = readConfig({ ADMIN_TOKEN: 'test-token', DATA_DIR: dataDir, PAYMENT_SECRET: SECRET, PAYMENT_MODE: 'demo', ...env });
  const store = createFileStore(dataDir);
  const server = http.createServer(createApp({ config, store, log: silentLog }));
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

async function registerUser(base, email, password = 'supersafepw1') {
  const res = await fetch(`${base}/api/auth/register`, json({ email, password, firstName: 'Тест', consent: true }, { Origin: base }));
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { email, cookie, user: body.user };
}

const createOrder = (base, cookie, planId, idempotencyKey = crypto.randomUUID()) =>
  fetch(`${base}/api/orders`, json({ planId, consent: true }, { Cookie: cookie, 'Idempotency-Key': idempotencyKey, Origin: base }));

const pay = (base, cookie, orderId, card = CARD_OK) =>
  fetch(`${base}/api/orders/${orderId}/pay`, json(card, { Cookie: cookie, Origin: base }));

const accountOf = async (base, cookie) => {
  const res = await fetch(`${base}/api/account`, { headers: { Cookie: cookie } });
  return res.status === 200 ? (await res.json()).user : null;
};

describe('Заказы и оплата', () => {
  let srv;
  let anna;
  let boris;
  let order;

  before(async () => { srv = await startServer(); });
  after(async () => { await srv.close(); });

  before(async () => {
    anna = await registerUser(srv.base, 'anna-pay@neptun.kz');
    boris = await registerUser(srv.base, 'boris-pay@neptun.kz');
  });

  test('без входа нельзя создать заказ (401)', async () => {
    const res = await createOrder(srv.base, '', 'pool:adult:12');
    assert.equal(res.status, 401);
  });

  test('без Idempotency-Key — 400', async () => {
    const res = await fetch(`${srv.base}/api/orders`, json({ planId: 'pool:adult:12' }, { Cookie: anna.cookie, Origin: srv.base }));
    assert.equal(res.status, 400);
  });

  test('неизвестный тариф — 422 с ошибкой по полю', async () => {
    const res = await createOrder(srv.base, anna.cookie, 'pool:hack:999999');
    assert.equal(res.status, 422);
    assert.ok((await res.json()).errors.planId);
  });

  test('цена заказа всегда из каталога сервера, пришедшую цену игнорируем', async () => {
    const res = await fetch(`${srv.base}/api/orders`, json(
      { planId: 'pool:adult:12', price: 1, consent: true },
      { Cookie: anna.cookie, 'Idempotency-Key': 'price-ignore-key-00001234', Origin: srv.base },
    ));
    assert.ok([200, 201].includes(res.status));
    assert.equal((await res.json()).order.price, 8500);
  });

  test('создание заказа: 201, pending, цена из каталога', async () => {
    const res = await createOrder(srv.base, anna.cookie, 'pool:adult:12', 'order-key-anna-00000001');
    assert.equal(res.status, 201);
    order = (await res.json()).order;
    assert.equal(order.status, 'pending');
    assert.equal(order.planId, 'pool:adult:12');
    assert.equal(order.price, 8500);
    assert.equal(order.receipt, null);
  });

  test('приемпотентность: тот же ключ → тот же заказ, другой ключ → новый заказ', async () => {
    const retry = await createOrder(srv.base, anna.cookie, 'pool:adult:12', 'order-key-anna-00000001');
    assert.equal(retry.status, 200);
    const again = (await retry.json()).order;
    assert.equal(again.id, order.id);
    assert.equal(again.status, 'pending'); // и состояние то же: деньги не списались на retry

    const other = await createOrder(srv.base, anna.cookie, 'pool:child:12', 'order-key-anna-00000002');
    assert.notEqual((await other.json()).order.id, order.id);
  });

  test('чужой заказ неотличим от отсутствующего (404) — и в статусе, и в оплате', async () => {
    const res = await fetch(`${srv.base}/api/orders/${order.id}`, { headers: { Cookie: boris.cookie } });
    assert.equal(res.status, 404);
    const resPay = await pay(srv.base, boris.cookie, order.id);
    assert.equal(resPay.status, 404);
    const resCancel = await fetch(`${srv.base}/api/orders/${order.id}/cancel`, json({}, { Cookie: boris.cookie, Origin: srv.base }));
    assert.equal(resCancel.status, 404);

    const noSuch = await fetch(`${srv.base}/api/orders/ffffffff-ffff-ffff-ffff-ffffffffffff`, { headers: { Cookie: boris.cookie } });
    assert.equal(noSuch.status, 404);
  });

  test('бракованная карта — 422 с ошибками по полям', async () => {
    const res = await pay(srv.base, anna.cookie, order.id, { number: '9999 9999', exp: '13/20', cvc: '1', holder: '' });
    assert.equal(res.status, 422);
    const errors = (await res.json()).errors;
    assert.deepEqual(Object.keys(errors).sort(), ['cvc', 'exp', 'holder', 'number']);
  });

  test('0002 — банк отклоняет платёж (402), абонемент не появляется', async () => {
    const res = await pay(srv.base, anna.cookie, order.id, CARD_DECLINED);
    assert.equal(res.status, 402);
    assert.equal((await res.json()).code, 'declined');
    assert.equal((await accountOf(srv.base, anna.cookie)).membership, null);
  });

  test('9995 — недостаточно средств (402)', async () => {
    const res = await pay(srv.base, anna.cookie, order.id, CARD_INSUFFICIENT);
    assert.equal(res.status, 402);
    assert.equal((await res.json()).code, 'insufficient');
  });

  test('успешная оплата — 200, чек с валидной HMAC-подписью, последних 4 цифры, без полного номера', async () => {
    const res = await pay(srv.base, anna.cookie, order.id);
    assert.equal(res.status, 200);
    const { order: paid } = await res.json();
    assert.equal(paid.status, 'paid');
    assert.equal(paid.receipt.valid, true);
    assert.equal(paid.receipt.amount, 8500);
    assert.equal(paid.receipt.last4, '4242');
    assert.ok(!JSON.stringify(paid).includes('424242424242'), 'полный номер карты нигде не возвращается');
    order = paid;
  });

  test('абонемент применяется с сегодняшней даты по времени города (UTC+5)', async () => {
    const acc = await accountOf(srv.base, anna.cookie);
    assert.equal(acc.membership.planId, 'pool:adult:12');
    assert.equal(acc.membership.visitsTotal, 12);
    assert.equal(acc.membership.visitsUsed, 0);
    const todayCity = new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);
    assert.equal(acc.membership.startsAt, todayCity);
    assert.ok(acc.membership.endsAt > acc.membership.startsAt);
  });

  test('подпись чека пересчитывается ключом сервера и совпадает', async () => {
    const res = await fetch(`${srv.base}/api/admin/orders`, { headers: { Authorization: 'Bearer test-token' } });
    assert.equal(res.status, 200);
    const { items } = await res.json();
    const adminOrder = items.find((i) => i.id === order.id);
    assert.ok(adminOrder, 'админ видит заказ и его владельца');
    assert.equal(adminOrder.email, 'anna-pay@neptun.kz');

    const expected = createHmac('sha256', SECRET)
      .update([adminOrder.id, adminOrder.userId, order.receipt.receiptId, adminOrder.planId, String(adminOrder.price), order.receipt.paidAt].join('|'))
      .digest('base64url');
    assert.equal(expected, order.receipt.signature);
  });

  test('без админ-токена список заказов закрыт (401)', async () => {
    const res = await fetch(`${srv.base}/api/admin/orders`);
    assert.equal(res.status, 401);
  });

  test('повторная оплата оплаченного — 200 alreadyPaid, абонемент не дублируется', async () => {
    const res = await pay(srv.base, anna.cookie, order.id);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).alreadyPaid, true);
    assert.equal((await accountOf(srv.base, anna.cookie)).membership.visitsTotal, 12);
  });

  test('продление: тот же тариф при активном абонементе — посещения суммируются', async () => {
    const res = await createOrder(srv.base, anna.cookie, 'pool:adult:12', 'order-key-anna-00000003');
    const second = (await res.json()).order;
    const payRes = await pay(srv.base, anna.cookie, second.id);
    assert.equal(payRes.status, 200);
    assert.equal((await payRes.json()).membership.extended, true);
    assert.equal((await accountOf(srv.base, anna.cookie)).membership.visitsTotal, 24);
  });

  test('после оплаты отклонение невозможно — уже оплачен', async () => {
    const res = await pay(srv.base, anna.cookie, order.id, CARD_DECLINED);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.alreadyPaid, true);
    assert.equal((await accountOf(srv.base, anna.cookie)).membership.visitsTotal, 24);
  });

  test('отмена pending-заказа, «закрытый» не отменяется и не оплачивается', async () => {
    const created = await createOrder(srv.base, boris.cookie, 'fitness:day:12', 'order-key-boris-0000001');
    const { order: b2 } = await created.json();
    const cancelRes = await fetch(`${srv.base}/api/orders/${b2.id}/cancel`, json({}, { Cookie: boris.cookie, Origin: srv.base }));
    assert.equal(cancelRes.status, 200);
    assert.equal((await cancelRes.json()).order.status, 'cancelled');

    assert.equal((await pay(srv.base, boris.cookie, b2.id)).status, 409);
    const repeated = await fetch(`${srv.base}/api/orders/${b2.id}/cancel`, json({}, { Cookie: boris.cookie, Origin: srv.base }));
    assert.equal(repeated.status, 409);

    const cancelPaid = await fetch(`${srv.base}/api/orders/${order.id}/cancel`, json({}, { Cookie: anna.cookie, Origin: srv.base }));
    assert.equal(cancelPaid.status, 409); // оплаченный не отменяется
  });
});
