import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cityNow, getOpenStatus, isWeekend, weekdayIndex } from '../assets/js/utils/time.js';

const SCHEDULE = { weekday: [12, 22], weekend: [10, 22] };

// Конструктор Date(y, m, d, h, min) — локальное время; модули работают с getHours()/getDay(),
// поэтому тесты не зависят от часового пояса машины.
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min);

test('cityNow переводит UTC-момент во время UTC+5', () => {
  const utcNoon = new Date(Date.UTC(2026, 10, 4, 12, 0));
  const local = cityNow(5, utcNoon);
  assert.equal(local.getHours(), 17);
  assert.equal(local.getMinutes(), 0);
});

test('isWeekend и weekdayIndex', () => {
  assert.equal(isWeekend(at(2026, 11, 4, 12)), false); // среда
  assert.equal(isWeekend(at(2026, 11, 7, 12)), true);  // суббота
  assert.equal(weekdayIndex(at(2026, 11, 2, 12)), 0);  // понедельник
  assert.equal(weekdayIndex(at(2026, 11, 8, 12)), 6);  // воскресенье
});

test('будни днём — открыто до 22:00', () => {
  assert.deepEqual(getOpenStatus(SCHEDULE, at(2026, 11, 4, 14, 30)), { isOpen: true, closesAt: 22, opensAt: 12 });
});

test('будни утром до открытия — откроется сегодня в 12:00', () => {
  const s = getOpenStatus(SCHEDULE, at(2026, 11, 4, 9));
  assert.equal(s.isOpen, false);
  assert.equal(s.opensAt, 12);
});

test('пятница после закрытия — откроется в субботу в 10:00', () => {
  const s = getOpenStatus(SCHEDULE, at(2026, 11, 6, 22, 5));
  assert.equal(s.isOpen, false);
  assert.equal(s.opensAt, 10);
});

test('воскресенье после закрытия — откроется в понедельник в 12:00', () => {
  assert.equal(getOpenStatus(SCHEDULE, at(2026, 11, 8, 23)).opensAt, 12);
});

test('граница закрытия: ровно 22:00 — уже закрыто', () => {
  assert.equal(getOpenStatus(SCHEDULE, at(2026, 11, 4, 22, 0)).isOpen, false);
});
