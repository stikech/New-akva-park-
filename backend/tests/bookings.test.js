/**
 * Расписание и запись на занятия: доступ по абонементу, вместимость, отмена.
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
import { createBookingStore } from '../src/booking-store.js';
import { createScheduleModule, shiftDate } from '../src/schedule.js';

const silentLog = { info() {}, error() {}, warn() {} };
const json = (body, headers = {}, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

async function startServer() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'neptun-book-'));
  const config = readConfig({ ADMIN_TOKEN: 'test-token', DATA_DIR: dataDir });
  const store = createFileStore(dataDir);
  const bookings = createBookingStore(dataDir); // тот же инстанс, что внутри createApp (в сервисах нет магии)
  const server = http.createServer(createApp({ config, store, bookings, log: silentLog }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, bookings, dataDir,
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
  return { email, cookie: res.headers.get('set-cookie').split(';')[0], id: body.user.id };
}

const giveMembership = (base, userId, planId, startsAt) => fetch(`${base}/api/admin/membership`, json({
  userId, planId, startsAt,
}, { Authorization: 'Bearer test-token' }, 'PUT'));

const todayCity = () => new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);

/** Ближайший (на offset-й день) слот категории, ещё не начавшийся. */
async function nextKey(base, category, offset = 1) {
  const data = await fetch(`${base}/api/schedule?days=14`).then((r) => r.json());
  for (const day of data.days.slice(offset)) {
    const slot = day.slots.find((s) => s.category === category);
    if (slot) return slot.key;
  }
  throw new Error(`нет слота категории ${category} в окне 14 дней`);
}

const book = (base, cookie, key) =>
  fetch(`${base}/api/bookings`, json({ key }, { Cookie: cookie, Origin: base }));

describe('Расписание и записи', () => {
  let srv;
  let anna;
  let boris;

  before(async () => { srv = await startServer(); });
  after(async () => { await srv.close(); });

  before(async () => {
    anna = await registerUser(srv.base, 'anna-book@neptun.kz');
    boris = await registerUser(srv.base, 'boris-book@neptun.kz');
  });

  test('расписание публично: категории, вместимость, счётчик занятых', async () => {
    const res = await fetch(`${srv.base}/api/schedule?days=3`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.days.length, 3);
    const slots = data.days.flatMap((d) => d.slots);
    assert.ok(slots.length > 0);
    assert.ok(slots.every((s) => Number.isInteger(s.capacity) && s.booked >= 0 && s.capacity >= s.booked));
    assert.ok(slots.every((s) => typeof s.key === 'string' && s.key.includes(':')));
    assert.equal(data.membership, undefined, 'без входа личных данных нет');
    assert.equal(data.myBookings, undefined);
  });

  test('расписание для вошедшего — статус абонемента и пустые myBookings', async () => {
    const res = await fetch(`${srv.base}/api/schedule?days=1`, { headers: { Cookie: anna.cookie } });
    const data = await res.json();
    assert.equal(data.membership.status, 'none');
    assert.deepEqual(data.myBookings, []);
  });

  test('без абонемента — разовое занятие: нужно согласие с офертой, затем 201 (payment single)', async () => {
    const key = await nextKey(srv.base, 'group');
    const refused = await book(srv.base, anna.cookie, key);
    assert.equal(refused.status, 422);
    assert.match((await refused.json()).errors.consent, /оферт/);

    const res = await fetch(`${srv.base}/api/bookings`, json({ key, consent: true }, { Cookie: anna.cookie, Origin: srv.base }));
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.booking.payment, 'single');
    assert.equal(body.booking.paid, false);
    assert.ok(body.booking.price > 0);
  });

  test('битый ключ — 422, unrecognized занимается — 404', async () => {
    assert.equal((await book(srv.base, anna.cookie, '../../etc/passwd')).status, 422);
    assert.equal((await book(srv.base, anna.cookie, '2026-11-01:nonexistent-class')).status, 404);
  });

  let annaKey;
  test('с активным абонементом запись создаётся (201), лимит вместимости на сервере', async () => {
    assert.equal((await giveMembership(srv.base, anna.id, 'pool:adult:12', todayCity())).status, 200);

    annaKey = await nextKey(srv.base, 'aqua');
    const res = await book(srv.base, anna.cookie, annaKey);
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.booking.status, 'booked');
    assert.equal(body.booking.key, annaKey);
  });

  test('в myBookings запись видна, повторная — 200 already', async () => {
    const data = await fetch(`${srv.base}/api/schedule?days=7`, { headers: { Cookie: anna.cookie } }).then((r) => r.json());
    assert.equal(data.membership.status, 'active');
    // ещё одна — разовое занятие из теста выше
    assert.equal(data.myBookings.length, 2);
    assert.equal(data.myBookings.find((b) => b.key === annaKey).payment, 'membership');
    assert.ok(data.days.flatMap((d) => d.slots).find((s) => s.mine && s.key === annaKey), 'флаг mine расписан');

    const res = await book(srv.base, anna.cookie, annaKey);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).already, true);
  });

  test('занятие не из своего абонемента — разовое (payment single), а не по абонементу', async () => {
    const res = await fetch(`${srv.base}/api/bookings`, json({ key: await nextKey(srv.base, 'combat'), consent: true }, { Cookie: anna.cookie, Origin: srv.base }));
    assert.equal(res.status, 201);
    assert.equal((await res.json()).booking.payment, 'single');
  });

  test('запись без входа — нужны имя и телефон гостя, потом 201; гость отменяет по телефону', async () => {
    const noGuest = await fetch(`${srv.base}/api/bookings`, json({ key: annaKey, consent: true }, { Origin: srv.base }));
    assert.equal(noGuest.status, 422);

    const guest = { name: 'Гость Тестов', phone: '8 705 111 22 33' };
    const res = await fetch(`${srv.base}/api/bookings`, json({ key: annaKey, guest, consent: true }, { Origin: srv.base }));
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.booking.payment, 'single');

    const wrongPhone = await fetch(`${srv.base}/api/bookings/${body.booking.id}/cancel`, json({ phone: '+77050000000' }, { Origin: srv.base }));
    assert.equal(wrongPhone.status, 404);
    const cancelled = await fetch(`${srv.base}/api/bookings/${body.booking.id}/cancel`, json({ phone: guest.phone }, { Origin: srv.base }));
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).booking.status, 'cancelled');
  });

  test('вместимость: места кончились — 409 следующему', async () => {
    const schedule = createScheduleModule();
    let slot = null;
    for (let i = 2; i <= 8 && !slot; i += 1) {
      slot = schedule.list(shiftDate(todayCity(), i)).find((s) => s.category === 'aqua');
    }
    assert.ok(slot, 'в окне +2..+8 дней есть аквааэробика');
    // следующий испытуемый должен иметь действующий абонемент — иначе раньше вместимости отработает проверка доступа
    assert.equal((await giveMembership(srv.base, boris.id, 'pool:adult:12', todayCity())).status, 200);

    const counts = await srv.bookings.counts([slot.key]);
    const taken = counts[slot.key]; // запись Анны могла попасть на этот слот
    for (let i = 0; i < slot.capacity - taken; i += 1) {
      const { created } = await srv.bookings.create({ userId: `ghost-${i}`, slot, now: new Date().toISOString() });
      assert.equal(created, true, `заняли место ${i} фантомом`);
    }

    // третьему пользователю (не вмещающемуся) — отказ
    const res = await book(srv.base, boris.cookie, slot.key);
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /Мест не осталось/i);
  });

  test('на прошедший слот записаться нельзя (422)', async () => {
    const yesterday = shiftDate(todayCity(), -1);
    const slotId = 'aqua-morning'; // по шаблону в пн/ср/пт в 08:30
    const res = await book(srv.base, anna.cookie, `${yesterday}:${slotId}`);
    const body = await res.json();
    assert.ok([404, 422].includes(res.status) || body.error, JSON.stringify(body));
  });

  test('запись в далёкое будущее beyond окна 14 дней — 422', async () => {
    const far = shiftDate(todayCity(), 40);
    const res = await book(srv.base, anna.cookie, `${far}:aqua-morning`);
    assert.equal(res.status, 422);
  });

  test('отмена своей записи — 200, статус cancelled; чужая — 404', async () => {
    const res = await fetch(`${srv.base}/api/bookings/${encodeURIComponent(annaKey)}`, json({}, { Cookie: anna.cookie, Origin: srv.base }, 'DELETE'));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.booking.status, 'cancelled');

    // повторная отмена того же — уже не booked → 404
    const repeat = await fetch(`${srv.base}/api/bookings/${encodeURIComponent(annaKey)}`, json({}, { Cookie: anna.cookie, Origin: srv.base }, 'DELETE'));
    assert.equal(repeat.status, 404);

    // чужая запись удаляется без следа: попытка от boris даёт 404 (у него нет записей)
    const stranger = await fetch(`${srv.base}/api/bookings/${encodeURIComponent(annaKey)}`, json({}, { Cookie: boris.cookie, Origin: srv.base }, 'DELETE'));
    assert.equal(stranger.status, 404);
  });

  test('отмена начавшегося занятия запрещена (409)', async () => {
    assert.equal((await giveMembership(srv.base, boris.id, 'pool:adult:12', todayCity())).status, 200);
    const yesterday = shiftDate(todayCity(), -1);
    const schedule = createScheduleModule();
    const slot = schedule.list(yesterday).find((s) => s.category === 'aqua');
    const { booking, created } = await srv.bookings.create({ userId: boris.id, slot, now: new Date().toISOString() });
    assert.equal(created, true, 'складываем отменённую запись');

    const res = await fetch(`${srv.base}/api/bookings/${encodeURIComponent(slot.key)}`, json({}, { Cookie: boris.cookie, Origin: srv.base }, 'DELETE'));
    assert.equal(res.status, 409);
    const stillBooked = await srv.bookings.find(booking.id);
    assert.equal(stillBooked.status, 'booked');
  });

  test('администратор видит записи на день, без токена — 401', async () => {
    assert.equal((await fetch(`${srv.base}/api/admin/bookings`)).status, 401);
    const res = await fetch(`${srv.base}/api/admin/bookings?date=${shiftDate(todayCity(), 1)}`, { headers: { Authorization: 'Bearer test-token' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.items));
  });

  test('сотрудник: день по занятиям, ручная запись клиента, отметка прихода и отмена', async () => {
    const admin = { Authorization: 'Bearer test-token' };
    const key = await nextKey(srv.base, 'kids', 2);
    const date = key.slice(0, 10);

    const added = await fetch(`${srv.base}/api/admin/bookings`, json({ key, name: 'Мама Тимура', phone: '+7 701 555 44 33' }, admin));
    const { booking } = await added.json();
    assert.equal(added.status, 201);
    assert.equal(booking.payment, 'single');

    const day = await fetch(`${srv.base}/api/admin/bookings?date=${date}`, { headers: admin }).then((r) => r.json());
    const slot = day.slots.find((s) => s.key === key);
    assert.ok(slot, 'в ответе есть все занятия дня');
    const mine = slot.items.find((b) => b.id === booking.id);
    assert.equal(mine.name, 'Мама Тимура');
    assert.equal(mine.phone, '+77015554433');
    assert.equal(mine.createdBy, 'Администратор');

    const attend = await fetch(`${srv.base}/api/admin/bookings/${booking.id}/attend`, json({ attended: true }, admin));
    assert.equal(attend.status, 200);
    const after = await fetch(`${srv.base}/api/admin/bookings?date=${date}`, { headers: admin }).then((r) => r.json());
    assert.ok(after.slots.find((s) => s.key === key).items.find((b) => b.id === booking.id).attendedAt);

    const cancel = await fetch(`${srv.base}/api/admin/bookings/${booking.id}/cancel`, json({}, admin));
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).booking.status, 'cancelled');
  });
});
