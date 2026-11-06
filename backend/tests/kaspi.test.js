/**
 * Оплата переводом Kaspi: реквизиты, «Я оплатил», подтверждение и отклонение
 * администратором, погашение билета на входе, отключённая оплата картой.
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
import { formatPhone, newPayCode } from '../src/kaspi.js';

const silentLog = { info() {}, error() {}, warn() {} };
const ADMIN = { Authorization: 'Bearer test-token' };

const json = (body, headers = {}, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

async function startServer(env = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'neptun-kaspi-'));
  const config = readConfig({ ADMIN_TOKEN: 'test-token', DATA_DIR: dataDir, PAYMENT_SECRET: 'kaspi-secret-0123456789', KASPI_PHONE: '87771234567', ...env });
  const sent = [];
  const notifier = { enabled: true, notify() {}, async send(text) { sent.push(text); } };
  const server = http.createServer(createApp({ config, store: createFileStore(dataDir), notifier, log: silentLog }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    sent,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

const visitPayload = { adults: 1, children: 0, day: 'weekday', duration: 'h2', contact: { email: 'guest@neptun.kz', firstName: 'Ольга' }, consent: true };
const createVisit = async (base) => {
  const res = await fetch(`${base}/api/visits`, json(visitPayload, { 'Idempotency-Key': crypto.randomUUID(), Origin: base }));
  return res.json();
};

describe('Kaspi: хелперы', () => {
  test('код оплаты NP-XXXXX без похожих символов', () => {
    for (let i = 0; i < 50; i += 1) assert.match(newPayCode(), /^NP-[2-9A-HJKMNP-Z]{5}$/);
  });
  test('номер форматируется в +7 777 123 45 67', () => {
    assert.equal(formatPhone('87771234567'), '+7 777 123 45 67');
    assert.equal(formatPhone('+7 (777) 123-45-67'), '+7 777 123 45 67');
  });
});

describe('Kaspi: билеты', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.close(); });

  test('реквизиты отдаются публично и вместе с визитом', async () => {
    const info = await (await fetch(`${srv.base}/api/payment`)).json();
    assert.deepEqual(info, { method: 'kaspi', enabled: true, phone: '+7 777 123 45 67', receiver: 'Аквапарк «Нептун»', payLink: null, qr: null, seller: { name: null, bin: null } });
    const { visit, payment } = await createVisit(srv.base);
    assert.equal(payment.phone, '+7 777 123 45 67');
    assert.match(visit.payCode, /^NP-/);
    assert.equal(visit.status, 'pending');
  });

  test('оплата картой выключена (403)', async () => {
    const { visit } = await createVisit(srv.base);
    const res = await fetch(`${srv.base}/api/visits/${visit.id}/pay`, json({ number: '4242424242424242', exp: '12/31', cvc: '123', holder: 'A B' }, { Origin: srv.base }));
    assert.equal(res.status, 403);
  });

  test('«Я оплатил» → уведомление один раз → подтверждение → чек → вход по билету один раз', async () => {
    const { visit } = await createVisit(srv.base);
    const before = srv.sent.length;
    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`${srv.base}/api/visits/${visit.id}/kaspi-claim`, json({}, { Origin: srv.base }));
      assert.equal(res.status, 200);
      assert.ok((await res.json()).visit.kaspi.claimedAt);
    }
    assert.equal(srv.sent.length, before + 1, 'повторное «Я оплатил» не спамит Telegram');
    assert.ok(srv.sent.at(-1).includes(visit.payCode));

    assert.equal((await fetch(`${srv.base}/api/admin/visits/${visit.id}/confirm`, json({}))).status, 401);
    const redeemEarly = await fetch(`${srv.base}/api/admin/visits/${visit.id}/redeem`, json({}, ADMIN));
    assert.equal(redeemEarly.status, 409, 'неоплаченный билет не погашается');

    const confirm = await fetch(`${srv.base}/api/admin/visits/${visit.id}/confirm`, json({}, ADMIN));
    assert.equal(confirm.status, 200);
    const paid = (await confirm.json()).visit;
    assert.equal(paid.status, 'paid');
    assert.equal(paid.receipt.brand, 'Kaspi');
    assert.equal(paid.receipt.valid, true);

    const status = await (await fetch(`${srv.base}/api/visits/${visit.id}`)).json();
    assert.equal(status.visit.status, 'paid');

    assert.equal((await fetch(`${srv.base}/api/admin/visits/${visit.id}/redeem`, json({}, ADMIN))).status, 200);
    assert.equal((await fetch(`${srv.base}/api/admin/visits/${visit.id}/redeem`, json({}, ADMIN))).status, 409);
  });

  test('отклонение: визит отменён, повторно подтвердить нельзя', async () => {
    const { visit } = await createVisit(srv.base);
    const res = await fetch(`${srv.base}/api/admin/visits/${visit.id}/reject`, json({ reason: 'Нет перевода' }, ADMIN));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.visit.status, 'cancelled');
    assert.equal(body.visit.kaspi.rejectReason, 'Нет перевода');
    assert.equal((await fetch(`${srv.base}/api/admin/visits/${visit.id}/confirm`, json({}, ADMIN))).status, 409);
  });
});

describe('Kaspi: без номера', () => {
  let srv;
  before(async () => { srv = await startServer({ KASPI_PHONE: '' }); });
  after(async () => { await srv.close(); });

  test('онлайн-оплата выключена: «Я оплатил» не принимается', async () => {
    const info = await (await fetch(`${srv.base}/api/payment`)).json();
    assert.equal(info.enabled, false);
    assert.equal(info.phone, null);
    const { visit } = await createVisit(srv.base);
    const res = await fetch(`${srv.base}/api/visits/${visit.id}/kaspi-claim`, json({}, { Origin: srv.base }));
    assert.equal(res.status, 409);
  });
});

describe('Kaspi: абонементы', () => {
  let srv;
  let cookie;
  before(async () => {
    srv = await startServer();
    const res = await fetch(`${srv.base}/api/auth/register`, json({ email: 'kaspi@neptun.kz', password: 'supersafepw1', firstName: 'Тест', consent: true }, { Origin: srv.base }));
    cookie = res.headers.get('set-cookie').split(';')[0];
  });
  after(async () => { await srv.close(); });

  test('заказ → «Я оплатил» → подтверждение админом выдаёт абонемент', async () => {
    const created = await fetch(`${srv.base}/api/orders`, json({ planId: 'pool:adult:12', consent: true }, { Cookie: cookie, 'Idempotency-Key': crypto.randomUUID(), Origin: srv.base }));
    const { order, payment } = await created.json();
    assert.equal(payment.enabled, true);
    assert.match(order.payCode, /^NP-/);

    const claim = await fetch(`${srv.base}/api/orders/${order.id}/kaspi-claim`, json({}, { Cookie: cookie, Origin: srv.base }));
    assert.equal(claim.status, 200);
    assert.ok(srv.sent.at(-1).includes(order.payCode));

    const confirm = await fetch(`${srv.base}/api/admin/orders/${order.id}/confirm`, json({}, ADMIN));
    assert.equal(confirm.status, 200);
    const body = await confirm.json();
    assert.equal(body.order.status, 'paid');
    assert.deepEqual(body.membership, { extended: false });

    const again = await (await fetch(`${srv.base}/api/admin/orders/${order.id}/confirm`, json({}, ADMIN))).json();
    assert.equal(again.alreadyPaid, true);
    assert.equal(again.membership, null, 'повторное подтверждение не выдаёт второй абонемент');

    const me = await (await fetch(`${srv.base}/api/account`, { headers: { Cookie: cookie } })).json();
    assert.equal(me.user.membership.planId, 'pool:adult:12');
  });

  test('без входа «Я оплатил» по заказу — 401', async () => {
    const created = await fetch(`${srv.base}/api/orders`, json({ planId: 'pool:adult:12', consent: true }, { Cookie: cookie, 'Idempotency-Key': crypto.randomUUID(), Origin: srv.base }));
    const { order } = await created.json();
    const res = await fetch(`${srv.base}/api/orders/${order.id}/kaspi-claim`, json({}, { Origin: srv.base }));
    assert.equal(res.status, 401);
  });
});

describe('Магазин: витрина и оферта', () => {
  let srv;
  let cookie;
  before(async () => {
    srv = await startServer();
    const res = await fetch(`${srv.base}/api/auth/register`, json({ email: 'shop@neptun.kz', password: 'supersafepw1', firstName: 'Тест', consent: true }, { Origin: srv.base }));
    cookie = res.headers.get('set-cookie').split(';')[0];
  });
  after(async () => { await srv.close(); });

  test('витрина публичная: абонементы в тренажёрный зал, бассейн и группы', async () => {
    const res = await fetch(`${srv.base}/api/catalog`);
    assert.equal(res.status, 200);
    const { groups, catalog, payment } = await res.json();
    assert.deepEqual(groups.map((g) => g.id), ['gym', 'pool', 'classes']);
    assert.ok(catalog.some((p) => p.group === 'gym' && p.id.startsWith('fitness:day:')));
    assert.ok(catalog.some((p) => p.group === 'gym' && p.id.startsWith('gold:')));
    assert.ok(catalog.every((p) => groups.some((g) => g.id === p.group)));
    assert.equal(payment.enabled, true);
  });

  test('без согласия с офертой заказ не создаётся (422)', async () => {
    const res = await fetch(`${srv.base}/api/orders`, json({ planId: 'fitness:day:12' }, { Cookie: cookie, 'Idempotency-Key': crypto.randomUUID(), Origin: srv.base }));
    assert.equal(res.status, 422);
    assert.ok((await res.json()).errors.consent);
  });

  test('страницы /shop и /offer отдаются', async () => {
    for (const p of ['/shop', '/offer']) assert.equal((await fetch(`${srv.base}${p}`)).status, 200, p);
  });
});
