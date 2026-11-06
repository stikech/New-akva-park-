/**
 * Каталог абонементов, которые администратор может выдать клиенту.
 * Строится из frontend/assets/js/config/site-data.js — тех же цен, что на сайте,
 * поэтому новый тариф в site-data.js автоматически появляется в админке.
 *
 * durationMonths: null — срок у тарифа на сайте не указан, дату окончания задаёт администратор.
 */

import { SITE_DATA } from '../../frontend/assets/js/config/site-data.js';
import { addMonths, isValidDate } from '../../frontend/assets/js/utils/account.js';
import { plural } from '../../frontend/assets/js/utils/format.js';

const visitsWord = (n) => plural(n, ['посещение', 'посещения', 'посещений']);

/** Карты тренажёрного зала (остальные карты фитнеса — групповые программы). */
const GYM_CARDS = new Set(['day', 'evening']);

/** Группы витрины магазина — в этом порядке. */
export const CATALOG_GROUPS = [
  { id: 'gym', title: 'Тренажёрный зал' },
  { id: 'pool', title: 'Бассейн' },
  { id: 'classes', title: 'Групповые программы' },
];
const monthsWord = (n) => plural(n, ['месяц', 'месяца', 'месяцев']);

export function buildCatalog(data = SITE_DATA) {
  const plans = [];

  for (const card of data.fitness.cards) {
    for (const pkg of card.packages) {
      if (pkg.visits < 2) continue; // 1 посещение — разовый визит, не абонемент
      plans.push({
        id: `fitness:${card.id}:${pkg.visits}`,
        category: 'fitness',
        group: GYM_CARDS.has(card.id) ? 'gym' : 'classes',
        title: `Фитнес · ${card.name} · ${pkg.visits} ${visitsWord(pkg.visits)}`,
        visitsTotal: pkg.visits,
        durationMonths: null,
        price: pkg.price,
      });
    }
  }

  for (const period of data.fitness.gold.periods) {
    plans.push({
      id: `gold:${period.months}`,
      category: 'fitness',
      group: 'gym',
      title: `Фитнес · ${data.fitness.gold.name} · ${period.months} ${monthsWord(period.months)}, безлимит`,
      visitsTotal: null,
      durationMonths: period.months,
      price: period.price,
    });
  }

  // Бассейн: последняя цена в строке — «12 посещений, 2 месяца» (см. комментарий в site-data.js).
  for (const row of data.prices.pool) {
    plans.push({
      id: `pool:${row.id}:12`,
      category: 'pool',
      group: 'pool',
      title: `Бассейн · ${row.label} · 12 посещений, 2 месяца`,
      visitsTotal: 12,
      durationMonths: 2,
      price: row.prices.at(-1),
    });
  }

  return plans;
}

/**
 * Проверяет запрос администратора на выдачу абонемента и собирает запись.
 * @param {{ planId: string, startsAt: string, endsAt?: string|null }} input
 */
export function buildMembership(input, catalog, { now = new Date() } = {}) {
  const plan = catalog.find((p) => p.id === input?.planId);
  if (!plan) return { ok: false, errors: { planId: 'Выберите тариф из списка' } };

  const errors = {};
  const startsAt = input.startsAt;
  if (!isValidDate(startsAt)) errors.startsAt = 'Укажите дату начала';

  let endsAt = input.endsAt || null;
  if (endsAt === null && plan.durationMonths && !errors.startsAt) endsAt = addMonths(startsAt, plan.durationMonths);
  if (endsAt !== null && (!isValidDate(endsAt) || (!errors.startsAt && endsAt < startsAt))) {
    errors.endsAt = 'Дата окончания не раньше даты начала';
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      planId: plan.id,
      category: plan.category,
      title: plan.title,
      price: plan.price,
      visitsTotal: plan.visitsTotal,
      visitsUsed: 0,
      startsAt,
      endsAt,
      issuedAt: now.toISOString(),
      visits: [],
    },
  };
}
