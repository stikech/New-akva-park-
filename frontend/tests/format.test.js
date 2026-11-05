import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, formatHour, formatPrice, formatTemperature, initials, plural } from '../assets/js/utils/format.js';
import { heightVerdict } from '../assets/js/modules/slides.js';
import { validateFeedback } from '../assets/js/modules/feedback.js';

const VISITS = ['посещение', 'посещения', 'посещений'];

test('plural — русские формы, включая 11–14', () => {
  assert.equal(plural(1, VISITS), 'посещение');
  assert.equal(plural(4, VISITS), 'посещения');
  assert.equal(plural(12, VISITS), 'посещений');
  assert.equal(plural(21, VISITS), 'посещение');
  assert.equal(plural(112, VISITS), 'посещений');
});

test('initials', () => {
  assert.equal(initials('Руслан Касманов'), 'РК');
  assert.equal(initials('  Галия  Харисова Шариповна '), 'ГХ');
});

test('validateFeedback', () => {
  assert.deepEqual(validateFeedback({ name: 'Аня', email: '', message: 'Всё отлично' }), {});
  const errors = validateFeedback({ name: ' ', email: 'not-an-email', message: 'ок' });
  assert.deepEqual(Object.keys(errors).sort(), ['email', 'message', 'name']);
});

test('formatPrice — неразрывные пробелы между разрядами и перед знаком тенге', () => {
  assert.equal(formatPrice(13000), '13\u00A0000\u00A0₸');
  assert.equal(formatPrice(900), '900\u00A0₸');
  assert.equal(formatPrice(110000), '110\u00A0000\u00A0₸');
});

test('formatHour', () => {
  assert.equal(formatHour(8), '08:00');
  assert.equal(formatHour(22), '22:00');
});

test('formatTemperature — знак и типографский минус', () => {
  assert.equal(formatTemperature(-14.4), '−14°');
  assert.equal(formatTemperature(3.6), '+4°');
  assert.equal(formatTemperature(0.2), '0°');
});

test('escapeHtml экранирует опасные символы', () => {
  assert.equal(escapeHtml('<img src=x onerror="a">'), '&lt;img src=x onerror=&quot;a&quot;&gt;');
});

test('heightVerdict', () => {
  assert.deepEqual(heightVerdict(140, 125), { allowed: false, text: 'Нужно ещё 15 см' });
  assert.equal(heightVerdict(120, 120).allowed, true);
  assert.equal(heightVerdict(null, 90).allowed, true);
});
