/**
 * Роли админки: владелец и сотрудники, вход по логину, журнал действий,
 * финансы и реквизиты оплаты, пробные сотрудники со скрытыми данными клиентов.
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
import { maskPersonal } from '../src/mask.js';

const silentLog = { info() {}, error() {}, warn() {} };
const json = (body, headers = {}, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const OWNER = { Authorization: 'Bearer owner-token-123' };

describe('владелец и сотрудники', () => {
  let base;
  let close;
  let staffAuth;
  let clientId;

  before(async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'neptun-staff-'));
    const config = readConfig({ ADMIN_TOKEN: 'owner-token-123', DATA_DIR: dataDir, DEMO_ACCOUNTS: '1' });
    const server = http.createServer(createApp({ config, store: createFileStore(dataDir), log: silentLog }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    close = async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    };
    const reg = await fetch(`${base}/api/auth/register`, json({ email: 'client@mail.kz', password: 'supersafepw1', firstName: 'Клиент', consent: true }, { Origin: base }));
    clientId = (await reg.json()).user.id;
  });
  after(() => close());

  test('владелец входит логином owner и паролем ADMIN_TOKEN', async () => {
    const res = await fetch(`${base}/api/admin/login`, json({ login: 'owner', password: 'owner-token-123' }));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.who.role, 'owner');
    const me = await fetch(`${base}/api/admin/me`, { headers: { Authorization: `Bearer ${body.token}` } }).then((r) => r.json());
    assert.equal(me.role, 'owner');
    assert.equal((await fetch(`${base}/api/admin/login`, json({ login: 'owner', password: 'nope' }))).status, 401);
  });

  test('владелец заводит сотрудника; сотрудник входит своим логином', async () => {
    const created = await fetch(`${base}/api/admin/staff`, json({ name: 'Мадина', login: 'madina', password: 'madina-pass-1' }, OWNER));
    assert.equal(created.status, 201);
    const dup = await fetch(`${base}/api/admin/staff`, json({ name: 'Ещё', login: 'madina', password: 'madina-pass-1' }, OWNER));
    assert.equal(dup.status, 422);

    const login = await fetch(`${base}/api/admin/login`, json({ login: 'Madina', password: 'madina-pass-1' }));
    const { token, who } = await login.json();
    assert.equal(who.role, 'staff');
    assert.equal(who.name, 'Мадина');
    staffAuth = { Authorization: `Bearer ${token}` };
  });

  test('сотрудник: клиенты и абонементы — можно; деньги, сотрудники, журнал, настройки — нет', async () => {
    assert.equal((await fetch(`${base}/api/admin/users`, { headers: staffAuth })).status, 200);
    const issue = await fetch(`${base}/api/admin/membership`, json({ userId: clientId, planId: 'gold:1', startsAt: '2026-11-06' }, staffAuth, 'PUT'));
    assert.equal(issue.status, 200);
    for (const p of ['/api/admin/finance', '/api/admin/staff', '/api/admin/activity', '/api/admin/settings']) {
      assert.equal((await fetch(`${base}${p}`, { headers: staffAuth })).status, 403, p);
    }
    const status = await fetch(`${base}/api/admin/status`, { headers: staffAuth }).then((r) => r.json());
    assert.equal(status.methods, undefined, 'реквизиты оплаты сотруднику не показываются');
  });

  test('журнал: владелец видит, кто и что сделал', async () => {
    const { items } = await fetch(`${base}/api/admin/activity`, { headers: OWNER }).then((r) => r.json());
    const issued = items.find((x) => x.action === 'Оформил абонемент клиенту');
    assert.ok(issued, JSON.stringify(items.slice(0, 3)));
    assert.equal(issued.name, 'Мадина');
    assert.match(issued.target, /client@mail\.kz/);
    assert.ok(items.find((x) => x.action === 'Вошёл в админку' && x.name === 'Мадина'));
    assert.ok(items.find((x) => x.action === 'Завёл сотрудника' && x.name === 'Владелец'));
  });

  test('отключённый сотрудник сразу теряет доступ', async () => {
    const { items } = await fetch(`${base}/api/admin/staff`, { headers: OWNER }).then((r) => r.json());
    const madina = items.find((s) => s.login === 'madina');
    await fetch(`${base}/api/admin/staff/${madina.id}`, json({ active: false }, OWNER, 'PATCH'));
    assert.equal((await fetch(`${base}/api/admin/me`, { headers: staffAuth })).status, 401);
    assert.equal((await fetch(`${base}/api/admin/login`, json({ login: 'madina', password: 'madina-pass-1' }))).status, 401);
  });

  test('реквизиты: владелец вписывает номер карты — способ «перевод на карту» включается сразу', async () => {
    const bad = await fetch(`${base}/api/admin/settings`, json({ cardNumber: '1234 5678 9012 3456' }, OWNER, 'PUT'));
    assert.equal(bad.status, 422);
    const ok = await fetch(`${base}/api/admin/settings`, json({ cardNumber: '4242 4242 4242 4242', cardBank: 'Kaspi Gold' }, OWNER, 'PUT'));
    assert.equal(ok.status, 200);
    const { methods } = await fetch(`${base}/api/checkout/options`).then((r) => r.json());
    assert.equal(methods.transfer.enabled, true);
    assert.equal(methods.transfer.number, '4242 4242 4242 4242');
  });

  test('финансы: онлайн-выручка по способам оплаты', async () => {
    const order = await fetch(`${base}/api/checkout`, json({ cart: [{ id: 'massage:0', qty: 2 }], contact: { name: 'Гость', phone: '+77051112233', email: 'g@mail.kz' }, consent: true }, { Origin: base, 'Idempotency-Key': 'finance-test-key-0001' })).then((r) => r.json());
    await fetch(`${base}/api/checkout/${order.order.id}/claim`, json({ method: 'transfer' }, { Origin: base }));
    await fetch(`${base}/api/admin/checkout/${order.order.id}/confirm`, json({}, OWNER));
    const f = await fetch(`${base}/api/admin/finance`, { headers: OWNER }).then((r) => r.json());
    assert.equal(f.periods.today.methods.transfer, 14000);
    assert.equal(f.periods.today.online, 14000);
    assert.equal(f.days.length, 30);
    assert.equal(f.days.at(-1).total, 14000);
  });

  test('пробный сотрудник (DEMO_ACCOUNTS): входит, но телефоны и почты клиентов скрыты', async () => {
    const login = await fetch(`${base}/api/admin/login`, json({ login: 'reception', password: 'staff2026' })).then((r) => r.json());
    assert.equal(login.who.demo, true);
    const users = await fetch(`${base}/api/admin/users`, { headers: { Authorization: `Bearer ${login.token}` } }).then((r) => r.json());
    const client = users.items.find((u) => u.id === clientId);
    assert.equal(client.email, 'c•••@mail.kz');
    assert.ok(users.items.find((u) => u.email === 'demo@neptun.kz'), 'демо-клиенты видны полностью');
  });

  test('maskPersonal: телефоны и почты во вложенных объектах', () => {
    assert.deepEqual(maskPersonal({ items: [{ contact: { phone: '+77051234567', email: 'ivan@mail.kz' } }] }),
      { items: [{ contact: { phone: '+7705•••••67', email: 'i•••@mail.kz' } }] });
  });
});
