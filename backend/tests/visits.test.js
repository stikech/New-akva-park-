/**
 * Онлайн-билеты аквапарка (/api/visits): создание, цена из каталога сервера,
 * оплата, отклонения, идемпотентность, публичный статус, админ-список.
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
const SECRET = 'visits-secret-for-tests-0123456789';

const CARD_OK = { number: '4242 4242 4242 4242', exp: '12/31', cvc: '123', holder: 'IVAN PETROV' };
const CARD_DECLINED = { ...CARD_OK, number: '4000 0000 0000 0002' };
const CARD_INSUFFICIENT = { ...CARD_OK, number: '5105 1051 0510 9995' };

const json = (body, headers = {}, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

async function startServer(env = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'neptun-visit-'));
  const config = readConfig({ ADMIN_TOKEN: 'test-token', DATA_DIR: dataDir, PAYMENT_SECRET: SECRET, ...env });
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

const createVisit = (base, body, headers = {}) => fetch(
  `${base}/api/visits`,
  json(body, { 'Idempotency-Key': `visit-key-${Math.random().toString(36).slice(2, 10)}-${Date.now() % 100000}`, Origin: base, ...headers }),
);

const visitPayload = { adults: 2, children: 1, day: 'weekday', duration: 'unl', contact: { email: 'guest@neptun.kz', firstName: 'Ольга' }, consent: true };
const pay = (base, id, card = CARD_OK) => fetch(`${base}/api/visits/${id}/pay`, json(card, { Origin: base }));

describe('Визиты: создание', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.close(); });

  test('без Idempotency-Key — 400', async () => {
    const res = await fetch(`${srv.base}/api/visits`, json(visitPayload, { Origin: srv.base }));
    assert.equal(res.status, 400);
  });

  test('создание визита: 201, pending, цена и гостей из каталога (2×6300 + 1×5800 = 18400)', async () => {
    const res = await createVisit(srv.base, visitPayload, { 'Idempotency-Key': 'visit-create-anna-00000001' });
    assert.equal(res.status, 201);
    const { visit } = await res.json();
    assert.equal(visit.kind, 'visit');
    assert.equal(visit.status, 'pending');
    assert.equal(visit.adults, 2);
    assert.equal(visit.children, 1);
    assert.equal(visit.day, 'weekday');
    assert.equal(visit.duration, 'unl');
    assert.equal(visit.price, 18400);
    assert.equal(visit.receipt, null);
    assert.ok(!JSON.stringify(visit).includes('guest@neptun.kz'), 'контакты не возвращаются наружу');
  });

  test('идемпотентность: тот же ключ → тот же визит, 200', async () => {
    const res = await fetch(`${srv.base}/api/visits`, json(
      visitPayload,
      { 'Idempotency-Key': 'visit-create-anna-00000001', 'Content-Type': 'application/json', Origin: srv.base },
    ));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).visit.status, 'pending');
  });

  test('свою цену прислать нельзя: сервер считает сам', async () => {
    const res = await createVisit(srv.base, { ...visitPayload, price: 1 });
    assert.equal((await res.json()).visit.price, 18400);
  });

  test('пришедшая сумма гостей за пределами 0–20 и «ноль гостей» — 422 по полям', async () => {
    const bad = await createVisit(srv.base, { ...visitPayload, adults: -3, children: 99 });
    assert.equal(bad.status, 422);
    const errors = (await bad.json()).errors;
    assert.ok(errors.adults);
    assert.ok(errors.children);

    const empty = await createVisit(srv.base, { ...visitPayload, adults: 0, children: 0 });
    assert.equal(empty.status, 422);
    assert.ok((await empty.json()).errors.adults);
  });

  test('день и тариф — только допустимые значения, контакт обязательно с почтой', async () => {
    const wrong = await createVisit(srv.base, { ...visitPayload, day: 'ночь', duration: '5h' });
    assert.equal(wrong.status, 422);
    const errors = (await wrong.json()).errors;
    assert.ok(errors.day);
    assert.ok(errors.duration);

    const noMail = await createVisit(srv.base, { ...visitPayload, contact: { email: 'нет' } });
    assert.equal(noMail.status, 422);
    assert.ok((await noMail.json()).errors['contact.email']);

    const noConsent = await createVisit(srv.base, { ...visitPayload, consent: false });
    assert.equal(noConsent.status, 422);
    assert.ok((await noConsent.json()).errors.consent);
  });

  test('создание ограничено по IP (429) — лимит создания 40 в час', async () => {
    let last = null;
    for (let i = 0; i < 41; i += 1) {
      last = await createVisit(srv.base, { ...visitPayload, adults: 1, children: 0 });
      if (last.status === 429) break;
    }
    assert.equal(last.status, 429);
  });
});

describe('Визиты: оплата', () => {
  let srv;
  let visit;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.close(); });

  before(async () => {
    const res = await createVisit(srv.base, visitPayload, { 'Idempotency-Key': 'visit-pay-suite-00000001' });
    visit = (await res.json()).visit;
  });

  test('бракованная карта — 422 с ошибками по полям', async () => {
    const res = await pay(srv.base, visit.id, { number: '9999', exp: '13/20', cvc: '1', holder: '' });
    assert.equal(res.status, 422);
    const errors = (await res.json()).errors;
    assert.deepEqual(Object.keys(errors).sort(), ['cvc', 'exp', 'holder', 'number']);
  });

  test('0002 — банк отклоняет платёж (402), визит остаётся pending', async () => {
    const res = await pay(srv.base, visit.id, CARD_DECLINED);
    assert.equal(res.status, 402);
    assert.equal((await res.json()).code, 'declined');
    const fresh = await (await fetch(`${srv.base}/api/visits/${visit.id}`)).json();
    assert.equal(fresh.visit.status, 'pending');
  });

  test('9995 — недостаточно средств (402)', async () => {
    const res = await pay(srv.base, visit.id, CARD_INSUFFICIENT);
    assert.equal(res.status, 402);
    assert.equal((await res.json()).code, 'insufficient');
  });

  test('успешная оплата — 200, чек с валидной подписью, planId visit, без полного номера', async () => {
    const res = await pay(srv.base, visit.id);
    assert.equal(res.status, 200);
    const { visit: paid } = await res.json();
    assert.equal(paid.status, 'paid');
    assert.equal(paid.receipt.valid, true);
    assert.equal(paid.receipt.amount, visit.price);
    assert.equal(paid.receipt.last4, '4242');
    assert.ok(!JSON.stringify(paid).includes('424242424242'), 'полный номер карты нигде не возвращается');
    assert.ok(!JSON.stringify(paid).includes('guest@neptun.kz'), 'контакты не возвращаются наружу');
  });

  test('подпись чека пересчитывается ключом сервера и совпадает (HMAC: orderId|userId|receiptId|visit|amount|paidAt)', async () => {
    const res = await fetch(`${srv.base}/api/admin/visits`, { headers: { Authorization: 'Bearer test-token' } });
    assert.equal(res.status, 200);
    const { items } = await res.json();
    const adminVisitItem = items.find((i) => i.id === visit.id);
    assert.ok(adminVisitItem, 'админ видит визит и контакты');
    assert.equal(adminVisitItem.email, 'guest@neptun.kz');

    const expected = createHmac('sha256', SECRET)
      .update([
        adminVisitItem.id, adminVisitItem.userId ?? '', adminVisitItem.receipt.receiptId,
        'visit', String(adminVisitItem.price), adminVisitItem.receipt.paidAt,
      ].join('|'))
      .digest('base64url');
    assert.equal(expected, adminVisitItem.receipt.signature);
  });

  test('без админ-токена список визитов закрыт (401)', async () => {
    const res = await fetch(`${srv.base}/api/admin/visits`);
    assert.equal(res.status, 401);
  });

  test('повторная оплата оплаченного — 200 alreadyPaid', async () => {
    const res = await pay(srv.base, visit.id, CARD_DECLINED);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).alreadyPaid, true);
  });

  test('чужой/несуществующий визит неотличим от отсутствующего (404)', async () => {
    const noSuch = await fetch(`${srv.base}/api/visits/ffffffff-ffff-ffff-ffff-ffffffffffff`);
    assert.equal(noSuch.status, 404);
    const badPay = await pay(srv.base, 'ffffffff-ffff-ffff-ffff-ffffffffffff');
    assert.equal(badPay.status, 404);
    const wrongId = await fetch(`${srv.base}/api/visits/<script>`);
    assert.equal(wrongId.status, 404);
  });
});

describe('Визиты: страницы', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.close(); });

  test('/account и разделы дашборда отдают страницу кабинета', async () => {
    for (const p of ['/account', '/account/overview', '/account/profile', '/account/membership', '/account/shop', '/account/schedule', '/account/settings']) {
      const res = await fetch(`${srv.base}${p}`);
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get('content-type') ?? '', /html/u, p);
      const body = await res.text();
      assert.ok(body.includes('dash-nav'), p);
    }
  });
});
