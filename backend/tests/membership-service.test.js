/**
 * Применение оплаченного тарифа: новое оформление или продление.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyPlan } from '../src/membership-service.js';

const DAY = 86_400_000;
const iso = (n) => new Date(Date.parse('2026-01-10T00:00:00Z') + n * DAY).toISOString().slice(0, 10);

const FITNESS = { id: 'fitness:day:12', category: 'fitness', title: 'Фитнес · Дневной · 12 посещений', visitsTotal: 12, durationMonths: null, price: 7500 };
const POOL = { id: 'pool:adult:12', category: 'pool', title: 'Бассейн · Взрослый · 12 посещений, 2 месяца', visitsTotal: 12, durationMonths: 2, price: 8500 };
const GOLD = { id: 'gold:6', category: 'fitness', title: 'Фитнес · «Золотая» карта · 6 месяцев, безлимит', visitsTotal: null, durationMonths: 6, price: 70000 };

describe('applyPlan: без абонемента и другой тариф — новое оформление', () => {
  test('нет абонемента → новый с текущей даты', () => {
    const { extended, membership } = applyPlan({ membership: null, plan: POOL, today: iso(0), nowISO: `${iso(0)}T06:00:00.000Z`, orderId: 'o1' });
    assert.equal(extended, false);
    assert.equal(membership.startsAt, iso(0));
    assert.equal(membership.visitsTotal, 12);
    assert.equal(membership.visitsUsed, 0);
    assert.equal(membership.issuedBy, 'o1');
    assert.ok(membership.endsAt > membership.startsAt);
  });

  test('другой тариф при активном → новый (замена), посещения обнуляются', () => {
    const old = { planId: 'fitness:day:12', category: 'fitness', title: '…', price: 7500, visitsTotal: 12, visitsUsed: 4, startsAt: iso(-10), endsAt: iso(50), issuedAt: iso(-10), visits: [{}, {}] };
    const { extended, membership } = applyPlan({ membership: old, plan: POOL, today: iso(0), nowISO: `${iso(0)}T06:00:00.000Z` });
    assert.equal(extended, false);
    assert.equal(membership.visitsUsed, 0);
    assert.equal(membership.visitsTotal, 12);
    assert.notEqual(membership.planId, 'fitness:day:12');
  });

  test('срок истёк → новое оформление со сегодня', () => {
    const expired = { planId: POOL.id, category: 'pool', title: POOL.title, price: POOL.price, visitsTotal: 12, visitsUsed: 3, startsAt: iso(-90), endsAt: iso(-5), issuedAt: iso(-90), visits: [] };
    const { extended, membership } = applyPlan({ membership: expired, plan: POOL, today: iso(0), nowISO: `${iso(0)}T06:00:00.000Z` });
    assert.equal(extended, false);
    assert.equal(membership.startsAt, iso(0));
    assert.equal(membership.visitsUsed, 0);
  });

  test('посещения закончились → новое оформление при том же тарифе', () => {
    const usedUp = { planId: POOL.id, category: 'pool', title: POOL.title, price: POOL.price, visitsTotal: 12, visitsUsed: 12, startsAt: iso(-20), endsAt: iso(40), issuedAt: iso(-20), visits: [] };
    const { extended, membership } = applyPlan({ membership: usedUp, plan: POOL, today: iso(0), nowISO: `${iso(0)}T06:00:00.000Z` });
    assert.equal(extended, false);
    assert.equal(membership.visitsUsed, 0);
    assert.equal(membership.visitsTotal, 12);
  });
});

describe('applyPlan: продление того же тарифа', () => {
  test('визитный тариф без срока: посещения суммируются, конец не сбрасывается', () => {
    const active = { planId: FITNESS.id, category: 'fitness', title: FITNESS.title, price: FITNESS.price, visitsTotal: 12, visitsUsed: 5, startsAt: iso(-10), endsAt: null, issuedAt: iso(-10), visits: [] };
    const { extended, membership } = applyPlan({ membership: active, plan: FITNESS, today: iso(0), nowISO: `${iso(0)}T06:00:00.000Z` });
    assert.equal(extended, true);
    assert.equal(membership.visitsTotal, 24);
    assert.equal(membership.visitsUsed, 5);
    assert.equal(membership.endsAt, null);
    assert.equal(membership.startsAt, iso(-10));
  });

  test('пул: +12 посещений и срок растягивается от даты окончания', () => {
    const active = { planId: POOL.id, category: 'pool', title: POOL.title, price: POOL.price, visitsTotal: 12, visitsUsed: 4, startsAt: iso(-10), endsAt: iso(50), issuedAt: iso(-10), visits: [] };
    const { extended, membership } = applyPlan({ membership: active, plan: POOL, today: iso(0), nowISO: `${iso(0)}T06:00:00.000Z` });
    assert.equal(extended, true);
    assert.equal(membership.visitsTotal, 24);
    assert.ok(membership.endsAt > iso(50));
    assert.equal(membership.visitsUsed, 4);
  });

  test('безлимитная карта: срок растягивается от конца действия', () => {
    const active = { planId: GOLD.id, category: 'fitness', title: GOLD.title, price: GOLD.price, visitsTotal: null, visitsUsed: 900, startsAt: iso(-100), endsAt: iso(80), issuedAt: iso(-100), visits: [] };
    const { extended, membership } = applyPlan({ membership: active, plan: GOLD, today: iso(0), nowISO: `${iso(0)}T06:00:00.000Z` });
    assert.equal(extended, true);
    assert.equal(membership.visitsTotal, null);
    assert.ok(membership.endsAt > iso(80));
    assert.equal(membership.visitsUsed, 900);
  });

  test('безлимитная карта, срок истёк при том же тарифе → новый срок с сегодня', () => {
    const expired = { planId: GOLD.id, category: 'fitness', title: GOLD.title, price: GOLD.price, visitsTotal: null, visitsUsed: 900, startsAt: iso(-200), endsAt: iso(-10), issuedAt: iso(-200), visits: [] };
    const { extended, membership } = applyPlan({ membership: expired, plan: GOLD, today: iso(0), nowISO: `${iso(0)}T06:00:00.000Z` });
    assert.equal(extended, false);
    assert.equal(membership.startsAt, iso(0));
    assert.ok(membership.endsAt > iso(0));
  });
});
