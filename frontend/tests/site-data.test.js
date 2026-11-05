// Целостность реальных данных: ловит опечатки в site-data.js (и в ответе API в будущем).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SITE_DATA } from '../assets/js/config/site-data.js';

const isPrice = (v) => Number.isInteger(v) && v > 0;

test('аквапарк: все цены — положительные целые, без лимита дороже 2 часов', () => {
  for (const who of ['adult', 'child']) {
    for (const day of ['weekday', 'weekend']) {
      const { h2, unl } = SITE_DATA.prices.park[who][day];
      assert.ok(isPrice(h2) && isPrice(unl), `${who}.${day}`);
      assert.ok(unl > h2, `${who}.${day}: без лимита должен быть дороже`);
    }
  }
});

test('бассейн: у каждого тарифа 4 цены', () => {
  SITE_DATA.prices.pool.forEach((t) => {
    assert.equal(t.prices.length, 4, t.id);
    assert.ok(t.prices.every(isPrice), t.id);
  });
});

test('фитнес: пакеты отсортированы по числу посещений, у каждой карты есть разовое', () => {
  SITE_DATA.fitness.cards.forEach((card) => {
    const visits = card.packages.map((p) => p.visits);
    assert.deepEqual(visits, [...visits].sort((a, b) => a - b), card.id);
    assert.equal(visits[0], 1, `${card.id}: нет разового посещения`);
    assert.ok(card.packages.every((p) => isPrice(p.price)), card.id);
  });
});

test('команда: у групп уникальные id, у тренеров есть имя', () => {
  const ids = SITE_DATA.team.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length);
  SITE_DATA.team.forEach((g) => {
    assert.ok(g.trainers.length > 0, g.id);
    g.trainers.forEach((t) => assert.ok(t.name.trim(), g.id));
  });
});

test('SPA: цены массажа положительные', () => {
  SITE_DATA.spa.massage.forEach((m) => assert.ok(isPrice(m.price), m.name));
});
