/**
 * Корзина (/api/cart-orders): несколько услуг одним платежом, цена только из
 * каталога сервера, оплата, отклонения, идемпотентность, админ-список.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createFileStore } from '../src/store.js';
import { SITE_DATA } from '../../frontend/assets/js/config/site-data.js';

const silentLog = { info() {}, error() {}, warn() {} };
const SECRET = 'cart-secret-for-tests-0123456789';
const CARD_OK = { number: '4242 4242 4242 4242', exp: '12/31', cvc: '123', holder: 'IVAN PETROV' };
const CARD_DECLINED = { ...CARD_OK, number: '4000 0000 0000 0002' };

const json = (body, headers = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

async function startServer() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'neptun-cart-'));
  const config = readConfig({ ADMIN_TOKEN: 'test-token', DATA_DIR: dataDir, PAYMENT_SECRET: SECRET });
  const server = http.createServer(createApp({ config, store: createFileStore(dataDir), log: silentLog }));
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

let seq = 0;
const key = () => `cart-key-${Date.now()}-${(seq += 1)}-abcdef`;
const create = (base, body, headers = {}) => fetch(`${base}/api/cart-orders`, json(body, { 'Idempotency-Key': key(), Origin: base, ...headers }));
const pay = (base, id, card = CARD_OK) => fetch(`${base}/api/cart-orders/${id}/pay`, json(card, { Origin: base }));

const contact = { email: 'guest@neptun.kz', firstName: 'Арман' };
const items = [
  { id: 'park:adult:weekday:unl', qty: 2 },
  { id: 'park:child:weekday:unl', qty: 1 },
  { id: 'massage:0', qty: 1 },
  { id: 'pool:adult:0', qty: 3 },
  { id: 'gold:1', qty: 1 },
];
const expectedTotal = 2 * SITE_DATA.prices.park.adult.weekday.unl
  + SITE_DATA.prices.park.child.weekday.unl
  + SITE_DATA.spa.massage[0].price
  + 3 * SITE_DATA.prices.pool[0].prices[0]
  + SITE_DATA.fitness.gold.periods[0].price;

describe('Корзина', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.close(); });

  test('без Idempotency-Key — 400', async () => {
    const res = await fetch(`${srv.base}/api/cart-orders`, json({ items, contact, consent: true }, { Origin: srv.base }));
    assert.equal(res.status, 400);
  });

  test('пустая корзина, неизвестная услуга, нет согласия — 422', async () => {
    const empty = await create(srv.base, { items: [], contact, consent: true });
    assert.equal(empty.status, 422);
    assert.ok((await empty.json()).errors.items);

    const unknown = await create(srv.base, { items: [{ id: 'park:vip:any:unl', qty: 1 }], contact, consent: true });
    assert.equal(unknown.status, 422);

    const noConsent = await create(srv.base, { items, contact });
    assert.equal(noConsent.status, 422);
    assert.ok((await noConsent.json()).errors.consent);
  });

  test('несколько услуг из разных сфер — одна сумма по каталогу сервера; цена с фронта игнорируется', async () => {
    const res = await create(srv.base, {
      items: items.map((l) => ({ ...l, price: 1, unitPrice: 1 })),
      contact,
      consent: true,
      total: 1,
    });
    assert.equal(res.status, 201);
    const { order } = await res.json();
    assert.equal(order.kind, 'cart');
    assert.equal(order.status, 'pending');
    assert.equal(order.items.length, items.length);
    assert.equal(order.total, expectedTotal);
    assert.equal(order.items.reduce((s, l) => s + l.sum, 0), expectedTotal);
    assert.ok(!JSON.stringify(order).includes('guest@neptun.kz'), 'контакты наружу не отдаются');
  });

  test('повтор с тем же Idempotency-Key — тот же заказ (200)', async () => {
    const headers = { 'Idempotency-Key': 'cart-same-key-000000001' };
    const a = await (await create(srv.base, { items, contact, consent: true }, headers)).json();
    const res = await create(srv.base, { items, contact, consent: true }, headers);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).order.id, a.order.id);
  });

  test('отклонение банком — 402, заказ остаётся pending; затем оплата — чек с верной подписью; повтор не списывает', async () => {
    const { order } = await (await create(srv.base, { items, contact, consent: true })).json();

    const declined = await pay(srv.base, order.id, CARD_DECLINED);
    assert.equal(declined.status, 402);
    const still = await (await fetch(`${srv.base}/api/cart-orders/${order.id}`)).json();
    assert.equal(still.order.status, 'pending');

    const paid = await pay(srv.base, order.id);
    assert.equal(paid.status, 200);
    const body = await paid.json();
    assert.equal(body.order.status, 'paid');
    assert.equal(body.order.receipt.amount, expectedTotal);
    assert.equal(body.order.receipt.valid, true);
    assert.equal(body.order.receipt.last4, '4242');
    assert.equal(body.alreadyPaid, false);

    const again = await (await pay(srv.base, order.id)).json();
    assert.equal(again.alreadyPaid, true);
    assert.equal(again.order.receipt.receiptId, body.order.receipt.receiptId);
  });

  test('чужой Origin — запрещено', async () => {
    const res = await create(srv.base, { items, contact, consent: true }, { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
  });

  test('админ видит заказы с контактами; без токена — 401', async () => {
    const anon = await fetch(`${srv.base}/api/admin/cart-orders`);
    assert.equal(anon.status, 401);
    const res = await fetch(`${srv.base}/api/admin/cart-orders`, { headers: { Authorization: 'Bearer test-token' } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.items.length >= 1);
    assert.equal(data.items[0].email, 'guest@neptun.kz');
  });
});
