import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createFileStore } from '../src/store.js';
import { createRateLimiter } from '../src/rate-limit.js';
import { parseFeedback } from '../src/feedback.js';
import { clientIp } from '../src/http.js';
import { SITE_DATA } from '../../frontend/assets/js/config/site-data.js';

const silentLog = { info() {}, error() {}, warn() {} };

async function startServer(env = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'neptun-test-'));
  const config = readConfig({ ADMIN_TOKEN: 'test-token', DATA_DIR: dataDir, ...env });
  const notified = [];
  const notifier = { enabled: true, async notify(record) { notified.push(record); } };
  const store = createFileStore(dataDir);
  const server = http.createServer(createApp({ config, store, notifier, log: silentLog }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    notified,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

const postFeedback = (base, body, headers = {}) =>
  fetch(`${base}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const valid = { name: 'Аня', email: 'anya@example.com', message: 'Очень понравились горки!', website: '', consent: true };

describe('API', () => {
  let srv;
  before(async () => { srv = await startServer({ FEEDBACK_RATE_MAX: '100' }); });
  after(async () => { await srv.close(); });

  test('GET /api/health', async () => {
    const res = await fetch(`${srv.base}/api/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  test('магазин объединён с ценами: /shop → /prices#shop, параметры сохраняются', async () => {
    const plain = await fetch(`${srv.base}/shop`, { redirect: 'manual' });
    assert.equal(plain.status, 302);
    assert.equal(plain.headers.get('location'), '/prices#shop');
    const plan = await fetch(`${srv.base}/shop/?plan=gold:1`, { redirect: 'manual' });
    assert.equal(plan.headers.get('location'), '/prices?plan=gold:1#shop');
    const page = await fetch(`${srv.base}/prices`).then((r) => r.text());
    assert.ok(page.includes('id="shopRoot"') && page.includes('id="allPrices"') && page.includes('id="calculator"'), 'на /prices — калькулятор, все цены и магазин');
  });

  test('GET /api/site отдаёт ту же форму, что site-data.js, и поддерживает ETag', async () => {
    const res = await fetch(`${srv.base}/api/site`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), JSON.parse(JSON.stringify(SITE_DATA)));
    const etag = res.headers.get('etag');
    assert.ok(etag);

    const cached = await fetch(`${srv.base}/api/site`, { headers: { 'If-None-Match': etag } });
    assert.equal(cached.status, 304);
  });

  test('POST /api/feedback: 201, запись сохраняется и уходит в уведомление', async () => {
    const res = await postFeedback(srv.base, { ...valid, name: '  Аня  ' });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(srv.notified.at(-1).name, 'Аня');
  });

  test('POST /api/feedback: 422 с ошибками по полям', async () => {
    const res = await postFeedback(srv.base, { name: ' ', email: 'нет', message: 'ок', website: '' });
    assert.equal(res.status, 422);
    const { errors } = await res.json();
    assert.deepEqual(Object.keys(errors).sort(), ['consent', 'email', 'message', 'name']);
  });

  test('POST /api/feedback: honeypot → 200 и ничего не сохраняется', async () => {
    const before = srv.notified.length;
    const res = await postFeedback(srv.base, { ...valid, website: 'http://spam' });
    assert.equal(res.status, 200);
    assert.equal(srv.notified.length, before);
  });

  test('POST /api/feedback: неверный JSON → 400, не JSON → 415, большой → 413', async () => {
    assert.equal((await postFeedback(srv.base, '{oops')).status, 400);
    const text = await fetch(`${srv.base}/api/feedback`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(text.status, 415);
    assert.equal((await postFeedback(srv.base, { ...valid, message: 'x'.repeat(20_000) })).status, 413);
  });

  test('админка: без токена 401, с токеном — список новых первыми', async () => {
    assert.equal((await fetch(`${srv.base}/api/admin/feedback`)).status, 401);
    const bad = await fetch(`${srv.base}/api/admin/feedback`, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(bad.status, 401);

    const res = await fetch(`${srv.base}/api/admin/feedback`, { headers: { Authorization: 'Bearer test-token' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.total >= 1);
    assert.equal(body.items[0].name, 'Аня');
    assert.ok(body.items[0].id && body.items[0].createdAt);
  });

  test('статика: главная, ассеты, админка; служебные файлы и traversal → 404', async () => {
    const index = await fetch(`${srv.base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.ok(index.headers.get('content-security-policy'));
    assert.match(await index.text(), /Нептун/);

    assert.equal((await fetch(`${srv.base}/assets/js/main.js`)).status, 200);
    assert.equal((await fetch(`${srv.base}/admin`)).status, 200);
    assert.equal((await fetch(`${srv.base}/admin/admin.js`)).status, 200);

    for (const p of ['/package.json', '/tests/pricing.test.js', '/assets/..%2fpackage.json', '/admin/..%2f..%2fsrc%2fconfig.js', '/assets/%00x']) {
      assert.equal((await fetch(`${srv.base}${p}`)).status, 404, p);
    }
  });

  test('у каждого раздела своя страница: /prices → prices.html, /pool → pool.html…', async () => {
    for (const p of ['/slides', '/prices/', '/rules', '/fitness/', '/classes', '/spa/', '/pool', '/contacts/', '/ticket']) {
      const res = await fetch(`${srv.base}${p}`);
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/u, p);
      const html = await res.text();
      assert.match(html, /Нептун/u, p);
      assert.ok(html.includes(`data-page="${p.replaceAll('/', '')}"`), `${p}: отдана своя страница`);
    }
    // Не секция и не файл — обычный 404, а не страница сайта.
    assert.equal((await fetch(`${srv.base}/nosuchsection`)).status, 404);
    assert.equal((await fetch(`${srv.base}/prices/nope`)).status, 404);
  });

  test('неизвестный API → 404 JSON, неверный метод → 405', async () => {
    const res = await fetch(`${srv.base}/api/nope`);
    assert.equal(res.status, 404);
    assert.ok((await res.json()).error);
    assert.equal((await fetch(`${srv.base}/api/site`, { method: 'DELETE' })).status, 405);
  });
});

describe('rate limit отзывов', () => {
  test('после лимита — 429 с Retry-After', async () => {
    const srv = await startServer({ FEEDBACK_RATE_MAX: '2' });
    try {
      assert.equal((await postFeedback(srv.base, valid)).status, 201);
      assert.equal((await postFeedback(srv.base, valid)).status, 201);
      const limited = await postFeedback(srv.base, valid);
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get('retry-after')) > 0);
    } finally {
      await srv.close();
    }
  });

  test('без ADMIN_TOKEN админка отвечает 503', async () => {
    const srv = await startServer({ ADMIN_TOKEN: '' });
    try {
      assert.equal((await fetch(`${srv.base}/api/admin/feedback`)).status, 503);
    } finally {
      await srv.close();
    }
  });
});

describe('модули', () => {
  test('createRateLimiter: скользящее окно', () => {
    let t = 0;
    const rl = createRateLimiter({ max: 2, windowMs: 1000, now: () => t });
    assert.ok(rl.hit('a').ok);
    assert.ok(rl.hit('a').ok);
    assert.equal(rl.hit('a').ok, false);
    assert.ok(rl.hit('b').ok);
    t = 1001;
    assert.ok(rl.hit('a').ok);
    rl.sweep();
    assert.equal(rl.size, 1);
  });

  test('parseFeedback: типы, длины, email=null', () => {
    assert.equal(parseFeedback(null).ok, false);
    assert.equal(parseFeedback([]).ok, false);
    assert.deepEqual(parseFeedback({ ...valid, name: 42 }).errors, { name: 'Ожидается строка' });
    assert.ok(parseFeedback({ ...valid, name: 'a'.repeat(81) }).errors.name);
    const ok = parseFeedback({ name: 'Ли', email: null, message: 'Хорошо было', website: '', consent: true });
    assert.equal(ok.ok, true);
    assert.equal(ok.value.email, null);
    assert.equal(ok.isBot, false);
  });

  test('clientIp: X-Forwarded-For учитывается только за доверенным прокси', () => {
    const req = { socket: { remoteAddress: '10.0.0.1' }, headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' } };
    assert.equal(clientIp(req, 0), '10.0.0.1');
    assert.equal(clientIp(req, 1), '1.2.3.4');
  });
});
