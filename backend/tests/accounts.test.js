import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createFileStore } from '../src/store.js';
import { createAccountStore } from '../src/account-store.js';
import { buildCatalog, buildMembership } from '../src/memberships.js';
import { hashPassword, verifyPassword } from '../src/passwords.js';

const silentLog = { info() {}, error() {}, warn() {} };
const ADMIN = { Authorization: 'Bearer test-token' };

async function startServer({ env = {}, clock } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'neptun-acc-'));
  const config = readConfig({ ADMIN_TOKEN: 'test-token', DATA_DIR: dataDir, ...env });
  const notifier = { enabled: false, async notify() {} };
  const accounts = createAccountStore(dataDir);
  const app = createApp({ config, store: createFileStore(dataDir), notifier, accounts, log: silentLog, clock });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    dataDir,
    accounts,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** Мини-клиент с cookie, как браузер. */
function client(base) {
  let cookie = '';
  async function call(method, url, body, headers = {}) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) {
      const [pair] = set.split(';');
      cookie = pair.endsWith('=') ? '' : pair;
    }
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json, setCookie: set };
  }
  return { call, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}

const reg = { email: 'Anya@Example.com ', password: 'aqua-park-2026', firstName: 'Аня', consent: true };

describe('личный кабинет', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.close(); });

  test('регистрация: 201, HttpOnly-cookie, почта нормализована, хеша нет в ответе', async () => {
    const c = client(srv.base);
    const r = await c.call('POST', '/api/auth/register', reg);
    assert.equal(r.status, 201);
    assert.match(r.setCookie, /neptun_sid=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000/);
    assert.doesNotMatch(r.setCookie, /Secure/); // HTTP без прокси
    assert.equal(r.body.user.email, 'anya@example.com');
    assert.equal(r.body.user.passwordHash, undefined);
    assert.equal(r.body.user.membership, null);

    const s = await c.call('GET', '/api/auth/session');
    assert.deepEqual(s.body, { authenticated: true, user: { firstName: 'Аня', lang: 'ru' } });

    // Файл: пароль только в виде scrypt-хеша, токен сессии — только хеш
    const file = await readFile(path.join(srv.dataDir, 'accounts.json'), 'utf8');
    assert.doesNotMatch(file, /aqua-park-2026/);
    assert.ok(!file.includes(c.cookie.split('=')[1]));
  });

  test('регистрация: 422 по полям, 409 на занятую почту', async () => {
    const c = client(srv.base);
    const bad = await c.call('POST', '/api/auth/register', { email: 'x', password: '123', firstName: '<b>', consent: false });
    assert.equal(bad.status, 422);
    assert.deepEqual(Object.keys(bad.body.errors).sort(), ['consent', 'email', 'firstName', 'password']);
    const dup = await c.call('POST', '/api/auth/register', { ...reg, email: 'ANYA@example.com' });
    assert.equal(dup.status, 409);
  });

  test('вход: неверный пароль и чужая почта — одинаковый 401; верный — 200', async () => {
    const c = client(srv.base);
    const wrong = await c.call('POST', '/api/auth/login', { email: 'anya@example.com', password: 'nope-nope' });
    const ghost = await c.call('POST', '/api/auth/login', { email: 'ghost@example.com', password: 'nope-nope' });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body, ghost.body);
    const ok = await c.call('POST', '/api/auth/login', { email: ' ANYA@example.com', password: reg.password });
    assert.equal(ok.status, 200);
    assert.ok(c.cookie);
  });

  test('профиль: без сессии 401; PATCH нормализует телефон, валидирует дату', async () => {
    assert.equal((await client(srv.base).call('GET', '/api/account')).status, 401);

    const c = client(srv.base);
    await c.call('POST', '/api/auth/login', { email: reg.email, password: reg.password });
    const upd = await c.call('PATCH', '/api/account', { lastName: 'Петрова', phone: '8 (705) 123-45-67', birthDate: '1995-03-08', lang: 'kz' });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.user.phone, '+77051234567');
    assert.equal(upd.body.user.lang, 'kz');

    const bad = await c.call('PATCH', '/api/account', { phone: '123', birthDate: '2999-01-01', firstName: '' });
    assert.equal(bad.status, 422);
    assert.deepEqual(Object.keys(bad.body.errors).sort(), ['birthDate', 'firstName', 'phone']);

    const cleared = await c.call('PATCH', '/api/account', { phone: '' });
    assert.equal(cleared.body.user.phone, null);
    assert.equal(cleared.body.user.lastName, 'Петрова'); // не переданные поля не трогаются
  });

  test('CSRF: запрос с чужим Origin → 403', async () => {
    const c = client(srv.base);
    await c.call('POST', '/api/auth/login', { email: reg.email, password: reg.password });
    const r = await c.call('PATCH', '/api/account', { lastName: 'Взлом' }, { Origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    const same = await c.call('PATCH', '/api/account', { lastName: 'Петрова' }, { Origin: srv.base });
    assert.equal(same.status, 200);
  });

  test('смена пароля завершает другие сессии, текущая остаётся', async () => {
    const phone = client(srv.base);
    const laptop = client(srv.base);
    await phone.call('POST', '/api/auth/login', { email: reg.email, password: reg.password });
    await laptop.call('POST', '/api/auth/login', { email: reg.email, password: reg.password });

    const wrong = await laptop.call('POST', '/api/account/password', { currentPassword: 'xxx', newPassword: 'new-password-1' });
    assert.equal(wrong.status, 422);
    const ok = await laptop.call('POST', '/api/account/password', { currentPassword: reg.password, newPassword: 'new-password-1' });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.endedSessions >= 1);

    assert.equal((await phone.call('GET', '/api/account')).status, 401);
    assert.equal((await laptop.call('GET', '/api/account')).status, 200);
    reg.password = 'new-password-1';
  });

  test('выход: cookie очищается, сессия на сервере удалена', async () => {
    const c = client(srv.base);
    await c.call('POST', '/api/auth/login', { email: reg.email, password: reg.password });
    const token = c.cookie;
    const out = await c.call('POST', '/api/auth/logout');
    assert.equal(out.status, 200);
    assert.match(out.setCookie, /Max-Age=0/);
    c.cookie = token; // старый токен больше не работает
    assert.equal((await c.call('GET', '/api/account')).status, 401);
    assert.equal((await c.call('GET', '/api/auth/session')).body.authenticated, false);
  });

  test('админ: выдаёт абонемент, отмечает посещения; клиент видит статус', async () => {
    assert.equal((await client(srv.base).call('GET', '/api/admin/users')).status, 401);

    const admin = client(srv.base);
    const list = await admin.call('GET', '/api/admin/users', undefined, ADMIN);
    assert.equal(list.status, 200);
    const user = list.body.items.find((u) => u.email === 'anya@example.com');
    assert.ok(list.body.catalog.some((p) => p.id === 'pool:adult:12'));

    const bad = await admin.call('PUT', '/api/admin/membership', { userId: user.id, planId: 'nope', startsAt: '2026-11-01' }, ADMIN);
    assert.equal(bad.status, 422);

    const set = await admin.call('PUT', '/api/admin/membership', { userId: user.id, planId: 'pool:adult:12', startsAt: list.body.today }, ADMIN);
    assert.equal(set.status, 200);
    assert.equal(set.body.user.membership.visitsTotal, 12);
    assert.equal(set.body.user.membership.status.code, 'active');

    const visit = await admin.call('POST', '/api/admin/visit', { userId: user.id }, ADMIN);
    assert.equal(visit.status, 200);
    assert.equal(visit.body.user.membership.status.visitsLeft, 11);

    const me = client(srv.base);
    await me.call('POST', '/api/auth/login', { email: reg.email, password: reg.password });
    const acc = await me.call('GET', '/api/account');
    assert.equal(acc.body.user.membership.title, 'Бассейн · Взрослый · 12 посещений, 2 месяца');
    assert.equal(acc.body.user.membership.visits.length, 1);

    assert.equal((await admin.call('PUT', '/api/admin/membership', { userId: 'missing', planId: 'gold:1', startsAt: '2026-11-01' }, ADMIN)).status, 404);
    const removed = await admin.call('DELETE', '/api/admin/membership', { userId: user.id }, ADMIN);
    assert.equal(removed.body.user.membership, null);
    assert.equal((await admin.call('POST', '/api/admin/visit', { userId: user.id }, ADMIN)).status, 409);
  });

  test('удаление аккаунта: нужен пароль, после — вход невозможен', async () => {
    const c = client(srv.base);
    await c.call('POST', '/api/auth/login', { email: reg.email, password: reg.password });
    assert.equal((await c.call('DELETE', '/api/account', { password: 'wrong' })).status, 422);
    assert.equal((await c.call('DELETE', '/api/account', { password: reg.password })).status, 200);
    assert.equal((await c.call('POST', '/api/auth/login', { email: reg.email, password: reg.password })).status, 401);
  });

  test('страница /account отдаётся', async () => {
    const res = await fetch(`${srv.base}/account`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  });
});

describe('защита входа', () => {
  test('перебор пароля для одной почты → 429', async () => {
    const srv = await startServer();
    try {
      const c = client(srv.base);
      await c.call('POST', '/api/auth/register', { ...reg, email: 'brute@example.com', password: 'correct-horse' });
      let last;
      for (let i = 0; i < 9; i += 1) last = await c.call('POST', '/api/auth/login', { email: 'brute@example.com', password: `bad-${i}` });
      assert.equal(last.status, 429);
      // даже верный пароль в окне блокировки не проходит
      assert.equal((await c.call('POST', '/api/auth/login', { email: 'brute@example.com', password: 'correct-horse' })).status, 429);
    } finally {
      await srv.close();
    }
  });

  test('cookie получает Secure за HTTPS-прокси', async () => {
    const srv = await startServer({ env: { TRUST_PROXY: '1' } });
    try {
      const r = await client(srv.base).call('POST', '/api/auth/register', { ...reg, email: 'secure@example.com' }, { 'X-Forwarded-Proto': 'https' });
      assert.match(r.setCookie, /; Secure/);
    } finally {
      await srv.close();
    }
  });

  test('данные переживают перезапуск сервера (чтение accounts.json)', async () => {
    const srv = await startServer();
    try {
      await client(srv.base).call('POST', '/api/auth/register', { ...reg, email: 'persist@example.com' });
      const fresh = createAccountStore(srv.dataDir);
      const user = await fresh.findUserByEmail('persist@example.com');
      assert.equal(user.firstName, 'Аня');
    } finally {
      await srv.close();
    }
  });

  test('параллельные регистрации не теряют записи', async () => {
    const srv = await startServer();
    try {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        client(srv.base).call('POST', '/api/auth/register', { ...reg, email: `p${i}@example.com` })));
      assert.ok(results.every((r) => r.status === 201));
      const fresh = createAccountStore(srv.dataDir);
      assert.equal((await fresh.listUsers()).length, 8);
    } finally {
      await srv.close();
    }
  });
});

describe('модули кабинета', () => {
  test('пароли: scrypt, соль уникальна, проверка', async () => {
    const a = await hashPassword('секрет-123');
    const b = await hashPassword('секрет-123');
    assert.notEqual(a, b);
    assert.ok(await verifyPassword('секрет-123', a));
    assert.equal(await verifyPassword('секрет-124', a), false);
    assert.equal(await verifyPassword('x', 'garbage'), false);
  });

  test('каталог и выдача абонемента: срок считается по тарифу', () => {
    const catalog = buildCatalog();
    assert.ok(catalog.every((p) => p.price > 0 && p.title));
    assert.ok(!catalog.some((p) => p.visitsTotal === 1));

    const pool = buildMembership({ planId: 'pool:child:12', startsAt: '2026-11-04' }, catalog);
    assert.equal(pool.value.endsAt, '2027-01-03');
    const gold = buildMembership({ planId: 'gold:12', startsAt: '2026-01-31' }, catalog);
    assert.equal(gold.value.endsAt, '2027-01-30');
    assert.equal(gold.value.visitsTotal, null);

    const fitness = buildMembership({ planId: 'fitness:day:8', startsAt: '2026-11-04' }, catalog);
    assert.equal(fitness.value.endsAt, null); // срок на сайте не указан — задаёт администратор
    assert.ok(buildMembership({ planId: 'fitness:day:8', startsAt: '2026-11-04', endsAt: '2026-10-01' }, catalog).errors.endsAt);
  });
});

describe('демо-аккаунты', () => {
  test('создаются при старте, видны на экране входа, защищены от смены пароля и удаления', async () => {
    const srv = await startServer({ env: { DEMO_ACCOUNTS: '1' } });
    try {
      const c = client(srv.base);
      const s = await c.call('GET', '/api/auth/session');
      assert.deepEqual(s.body.demoAccounts.map((a) => a.email), ['demo@neptun.kz', 'gold@neptun.kz', 'new@neptun.kz']);

      const login = await c.call('POST', '/api/auth/login', { email: 'demo@neptun.kz', password: s.body.demoAccounts[0].password });
      assert.equal(login.status, 200);
      assert.equal(login.body.user.demo, true);
      const m = login.body.user.membership;
      assert.equal(m.status.code, 'active');
      assert.equal(m.visitsUsed, 5);
      assert.equal(m.visits.length, 5);

      assert.equal((await c.call('POST', '/api/account/password', { currentPassword: 'neptun2026', newPassword: 'hacked-123' })).status, 403);
      assert.equal((await c.call('DELETE', '/api/account', { password: 'neptun2026' })).status, 403);
      assert.equal((await c.call('POST', '/api/account/logout-all')).status, 403);
      assert.equal((await c.call('PATCH', '/api/account', { lastName: 'Иванова' })).status, 200); // профиль править можно

      const gold = await client(srv.base).call('POST', '/api/auth/login', { email: 'gold@neptun.kz', password: 'neptun2026' });
      assert.equal(gold.body.user.membership.visitsTotal, null);
      assert.equal(gold.body.user.membership.status.code, 'active');
    } finally {
      await srv.close();
    }
  });

  test('при перезапуске демо-аккаунт сбрасывается к исходному виду', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'neptun-demo-'));
    try {
      const { seedDemoAccounts } = await import('../src/demo-accounts.js');
      const store = createAccountStore(dataDir);
      await seedDemoAccounts(store, { log: silentLog });
      const before = await store.findUserByEmail('demo@neptun.kz');
      await store.updateUser(before.id, { lastName: 'Испорчено' });
      const fresh = createAccountStore(dataDir);
      await seedDemoAccounts(fresh, { log: silentLog });
      const after = await fresh.findUserByEmail('demo@neptun.kz');
      assert.equal(after.lastName, 'Петрова');
      assert.equal(after.id, before.id);
      assert.equal((await fresh.listUsers()).length, 3);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test('без DEMO_ACCOUNTS демо-аккаунтов нет', async () => {
    const srv = await startServer();
    try {
      const s = await client(srv.base).call('GET', '/api/auth/session');
      assert.deepEqual(s.body.demoAccounts, []);
    } finally {
      await srv.close();
    }
  });
});
