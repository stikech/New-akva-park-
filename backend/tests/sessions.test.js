/**
 * Сессии переживают перезапуск сервера с чистым диском (бесплатный Render):
 * клиента не выкидывает, аккаунт восстанавливается из зашифрованной cookie,
 * а выход «на всех устройствах» не отменяется перезапуском.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createFileStore } from '../src/store.js';
import { seal, unseal, deriveKey } from '../src/sealed-token.js';

const silentLog = { info() {}, error() {}, warn() {} };
const json = (body, headers = {}, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const cookieOf = (res) => res.headers.get('set-cookie')?.split(';')[0];

/** Новый сервер на пустом диске — как Render после «засыпания». */
async function freshServer(env = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'neptun-sess-'));
  const config = readConfig({ ADMIN_TOKEN: 'stable-admin-token', DATA_DIR: dataDir, ...env });
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

test('токен: шифруется, подделка и чужой ключ не проходят', () => {
  const key = deriveKey('k1');
  const token = seal({ uid: 'u1', exp: 1 }, key);
  assert.deepEqual(unseal(token, key), { uid: 'u1', exp: 1 });
  assert.equal(unseal(token, deriveKey('k2')), null);
  assert.equal(unseal(`${token.slice(0, -3)}AAA`, key), null);
  assert.ok(!token.includes('u1'), 'содержимое не читается');
});

test('перезапуск с пустым диском: клиент остаётся в кабинете и может войти паролем заново', async () => {
  const a = await freshServer();
  const reg = await fetch(`${a.base}/api/auth/register`, json({ email: 'olga@mail.kz', password: 'supersafepw1', firstName: 'Ольга', consent: true }, { Origin: a.base }));
  let cookie = cookieOf(reg);
  await fetch(`${a.base}/api/account`, json({ phone: '+7 705 111 22 33' }, { Cookie: cookie, Origin: a.base }, 'PATCH'));
  // страница при каждом открытии обновляет cookie (снимок с телефоном)
  cookie = cookieOf(await fetch(`${a.base}/api/account`, { headers: { Cookie: cookie } })) ?? cookie;
  await a.close();

  const b = await freshServer();
  const me = await fetch(`${b.base}/api/account`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  const { user } = await me.json();
  assert.equal(user.email, 'olga@mail.kz');
  assert.equal(user.phone, '+77051112233');

  const session = await fetch(`${b.base}/api/auth/session`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.equal(session.authenticated, true);

  // вышел — и заново вошёл тем же паролем на «новом» сервере
  await fetch(`${b.base}/api/auth/logout`, json({}, { Cookie: cookie, Origin: b.base }));
  assert.equal((await fetch(`${b.base}/api/account`, { headers: { Cookie: cookie } })).status, 401, 'после выхода cookie не работает');
  const login = await fetch(`${b.base}/api/auth/login`, json({ email: 'olga@mail.kz', password: 'supersafepw1' }, { Origin: b.base }));
  assert.equal(login.status, 200);
  await b.close();
});

test('выход на всех устройствах не отменяется перезапуском', async () => {
  const a = await freshServer();
  const reg = await fetch(`${a.base}/api/auth/register`, json({ email: 'phone2@mail.kz', password: 'supersafepw1', firstName: 'Тест', consent: true }, { Origin: a.base }));
  const laptop = cookieOf(reg);
  const phone = cookieOf(await fetch(`${a.base}/api/auth/login`, json({ email: 'phone2@mail.kz', password: 'supersafepw1' }, { Origin: a.base })));
  const res = await fetch(`${a.base}/api/account/logout-all`, json({}, { Cookie: laptop, Origin: a.base }));
  const laptopNew = cookieOf(res);
  assert.equal(res.status, 200);
  assert.equal((await fetch(`${a.base}/api/account`, { headers: { Cookie: phone } })).status, 401);
  const snap = cookieOf(await fetch(`${a.base}/api/account`, { headers: { Cookie: laptopNew } })) ?? laptopNew;
  await a.close();

  const b = await freshServer();
  // ноутбук (новый токен) восстанавливается первым — аккаунт с новым счётчиком сессий
  assert.equal((await fetch(`${b.base}/api/account`, { headers: { Cookie: snap } })).status, 200);
  assert.equal((await fetch(`${b.base}/api/account`, { headers: { Cookie: phone } })).status, 401, 'старый токен телефона не оживает');
  await b.close();
});
