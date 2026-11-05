/**
 * Правила карты: Луна, сроки, CVC, имя. Один модуль на фронт и бэк.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { luhnValid, cardBrand, formatCardNumber, normalizeCardNumber, validateCard } from '../assets/js/utils/card.js';

const NOW = '2026-05-15T10:00:00.000Z';

describe('luhnValid', () => {
  const cases = [
    ['4242424242424242', true],
    ['4111111111111111', true],
    ['4000000000000002', true],
    ['5105105105109995', true],
    ['4242424242424241', false],
    ['0000000000000000', false],
    ['1234567890123456', false],
  ];
  for (const [number, expected] of cases) {
    test(`${number} → ${expected}`, () => assert.equal(luhnValid(number), expected));
  }
  test('не-16-значные отметаются', () => {
    assert.equal(luhnValid('42424242424242'), false);
    assert.equal(luhnValid(''), false);
  });
});

describe('cardBrand и форматирование', () => {
  test('brands', () => {
    assert.equal(cardBrand('4242424242424242'), 'Visa');
    assert.equal(cardBrand('5105105105105100'.slice(0, 16)), 'Mastercard');
    assert.equal(cardBrand('4242424242424241'), null);
  });
  test('formatCardNumber группирует по 4', () => {
    assert.equal(formatCardNumber('4242424242424242'), '4242 4242 4242 4242');
    assert.equal(formatCardNumber('42424242'), '4242 4242');
    assert.equal(formatCardNumber('4242-4242-4242'), '4242 4242 4242');
    assert.equal(formatCardNumber(null), '');
  });
  test('normalizeCardNumber чистит мусор', () => {
    assert.equal(normalizeCardNumber('  4242 4242 4242 4242 '), '4242424242424242');
    assert.equal(normalizeCardNumber('abc'), '');
  });
});

describe('validateCard', () => {
  test('валидная карта', () => {
    const result = validateCard({ number: '4242 4242 4242 4242', exp: '12/30', cvc: '123', holder: 'IVAN PETROV' }, { nowISO: NOW });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { last4: '4242', brand: 'Visa' });
  });

  test('ошибки по всем полям сразу', () => {
    const result = validateCard({ number: '9999', exp: '13/20', cvc: '1', holder: 'Иван' }, { nowISO: NOW });
    assert.equal(result.ok, false);
    assert.deepEqual(Object.keys(result.errors).sort(), ['cvc', 'exp', 'holder', 'number']);
  });

  test('срок в прошлом — ошибка', () => {
    const result = validateCard({ number: '4242424242424242', exp: '04/26', cvc: '123', holder: 'IVAN' }, { nowISO: NOW });
    assert.match(result.errors.exp, /истёк/);
  });

  test('срок слишком далеко — ошибка', () => {
    const result = validateCard({ number: '4242424242424242', exp: '01/50', cvc: '123', holder: 'IVAN' }, { nowISO: NOW });
    assert.match(result.errors.exp, /проверьте/i);
  });

  test('текущий месяц валиден: 05/26 на 2026-05-15 — срок до следующего мес', () => {
    const result = validateCard({ number: '4242424242424242', exp: '05/26', cvc: '123', holder: 'IVAN' }, { nowISO: NOW });
    assert.equal(result.ok, true);
  });

  test('holder — латиницей', () => {
    const result = validateCard({ number: '4242424242424242', exp: '12/30', cvc: '123', holder: 'Иванов Иван' }, { nowISO: NOW });
    assert.match(result.errors.holder, /латиницей/i);
  });

  test('cvc 4 цифры отклоняется (не amex)', () => {
    const result = validateCard({ number: '4242424242424242', exp: '12/30', cvc: '1234', holder: 'IVAN' }, { nowISO: NOW });
    assert.ok(result.errors.cvc);
  });
});
