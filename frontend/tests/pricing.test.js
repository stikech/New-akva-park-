import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestPackage, calcParkTotal, clampGuests, pricePerMonth, pricePerVisit } from '../assets/js/utils/pricing.js';

// Фикстура, а не реальный прайс: тесты логики не должны ломаться при смене цен.
const PARK = {
  adult: { weekday: { h2: 100, unl: 150 }, weekend: { h2: 120, unl: 170 } },
  child: { weekday: { h2: 60, unl: 90 }, weekend: { h2: 70, unl: 100 } },
};

test('calcParkTotal: 2 взрослых + 1 ребёнок, будни, без лимита', () => {
  assert.equal(calcParkTotal(PARK, { adult: 2, child: 1, day: 'weekday', duration: 'unl' }), 2 * 150 + 90);
});

test('calcParkTotal: выходные, 2 часа', () => {
  assert.equal(calcParkTotal(PARK, { adult: 1, child: 2, day: 'weekend', duration: 'h2' }), 120 + 2 * 70);
});

test('calcParkTotal: нет гостей — ноль', () => {
  assert.equal(calcParkTotal(PARK, { adult: 0, child: 0, day: 'weekday', duration: 'h2' }), 0);
});

test('clampGuests держит диапазон 0..20', () => {
  assert.equal(clampGuests(-1), 0);
  assert.equal(clampGuests(21), 20);
  assert.equal(clampGuests(5), 5);
});

test('pricePerVisit и pricePerMonth округляют до тенге', () => {
  assert.equal(pricePerVisit(8500, 12), 708);
  assert.equal(pricePerMonth(70000, 6), 11667);
});

test('bestPackage выбирает минимальную цену за посещение и считает экономию', () => {
  const best = bestPackage([
    { visits: 1, price: 2000 },
    { visits: 4, price: 4100 },
    { visits: 8, price: 5700 },
    { visits: 12, price: 7500 },
  ]);
  assert.equal(best.visits, 12);
  assert.equal(best.perVisit, 625);
  assert.equal(best.savingPct, 68); // 1 − 625/2000 = 68,75% → 68
});

test('bestPackage: только разовое посещение — null', () => {
  assert.equal(bestPackage([{ visits: 1, price: 1000 }]), null);
});

test('bestPackage: без разового посещения экономия 0', () => {
  assert.equal(bestPackage([{ visits: 6, price: 600 }, { visits: 12, price: 1100 }]).savingPct, 0);
});
