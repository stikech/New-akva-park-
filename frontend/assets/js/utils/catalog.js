/**
 * Каталог корзины: всё, что можно купить на сайте, в плоском виде.
 * Чистые функции без DOM — их используют корзина и страница оформления, и сервер
 * (backend/src/checkout.js пересчитывает сумму сам, цене из браузера не доверяет).
 *
 * id позиции стабилен, пока не меняется структура site-data.js:
 *   park:adult:weekday:h2 · pool:child:1 · fit:day:1 · plan:gold:6 · massage:0 · sol:1:100 · press:course
 *   class:2026-11-10:crossfit — разовое занятие по расписанию (строится отдельно, см. classItem)
 *
 * kind:
 *   ticket     — билет в аквапарк (нужна дата визита);
 *   service    — разовая услуга: бассейн по часам, разовое посещение фитнеса, SPA;
 *   membership — абонемент, привязывается к личному кабинету (planId = id тарифа из memberships.js);
 *   class      — оплата разового занятия, на которое клиент уже записан.
 */

import { plural } from './format.js';

export const GROUPS = [
  { id: 'park', title: 'Аквапарк' },
  { id: 'pool', title: 'Бассейн' },
  { id: 'fitness', title: 'Фитнес' },
  { id: 'spa', title: 'SPA' },
  { id: 'classes', title: 'Занятия' },
];

const WHO = { adult: 'Взрослый', child: 'Детский' };
const DAY = { weekday: 'будни', weekend: 'выходные' };
const DURATION = { h2: '2 часа', unl: 'без лимита' };
const POOL_HOURS = ['1 час', '2 часа', '3 часа'];

const visitsText = (n) => (n === 1 ? 'разовое посещение' : `${n} ${plural(n, ['посещение', 'посещения', 'посещений'])}`);
const monthsText = (n) => (n === 12 ? '1 год' : `${n} ${plural(n, ['месяц', 'месяца', 'месяцев'])}`);

/**
 * @param {typeof import('../config/site-data.js').SITE_DATA} data
 * @returns {{ id: string, group: string, kind: string, title: string, option: string, price: number, planId?: string }[]}
 */
export function buildCatalog(data) {
  const items = [];
  const add = (item) => items.push(item);

  const { park, pool } = data.prices;
  for (const who of ['adult', 'child']) {
    for (const day of ['weekday', 'weekend']) {
      for (const duration of ['h2', 'unl']) {
        add({
          id: `park:${who}:${day}:${duration}`, group: 'park', kind: 'ticket',
          title: `Аквапарк · ${WHO[who]}`, option: `${DAY[day]}, ${DURATION[duration]}`, price: park[who][day][duration],
        });
      }
    }
  }

  // Бассейн: первые три цены — по часам, последняя — абонемент «12 посещений, 2 месяца».
  for (const row of pool) {
    row.prices.slice(0, 3).forEach((price, i) => add({
      id: `pool:${row.id}:${i + 1}`, group: 'pool', kind: 'service',
      title: `Бассейн · ${row.label}`, option: POOL_HOURS[i], price,
    }));
    add({
      id: `plan:pool:${row.id}:12`, planId: `pool:${row.id}:12`, group: 'pool', kind: 'membership',
      title: `Абонемент в бассейн · ${row.label}`, option: '12 посещений, 2 месяца', price: row.prices.at(-1),
    });
  }

  for (const card of data.fitness.cards) {
    for (const { visits, price } of card.packages) {
      if (visits === 1) {
        add({ id: `fit:${card.id}:1`, group: 'fitness', kind: 'service', title: `Фитнес · ${card.name}`, option: visitsText(1), price });
      } else {
        add({
          id: `plan:fitness:${card.id}:${visits}`, planId: `fitness:${card.id}:${visits}`, group: 'fitness', kind: 'membership',
          title: `Фитнес · ${card.name}`, option: `абонемент, ${visitsText(visits)}`, price,
        });
      }
    }
  }
  for (const { months, price } of data.fitness.gold.periods) {
    add({
      id: `plan:gold:${months}`, planId: `gold:${months}`, group: 'fitness', kind: 'membership',
      title: `Фитнес · ${data.fitness.gold.name}`, option: `${monthsText(months)}, безлимит`, price,
    });
  }

  data.spa.massage.forEach((m, i) => add({
    id: `massage:${i}`, group: 'spa', kind: 'service', title: `Массаж · ${m.name}`, option: m.duration, price: m.price,
  }));
  data.spa.solarium.groups.forEach((g, gi) => g.certificates.forEach((c) => add({
    id: `sol:${gi}:${c.minutes}`, group: 'spa', kind: 'service', title: `Солярий · ${g.title}`, option: `сертификат на ${c.minutes} минут`, price: c.price,
  })));
  const press = data.spa.pressotherapy;
  add({ id: 'press:single', group: 'spa', kind: 'service', title: 'Прессотерапия', option: `1 сеанс, ${press.minutes} минут`, price: press.single });
  add({ id: 'press:course', group: 'spa', kind: 'service', title: 'Прессотерапия', option: `курс ${press.course.sessions} сеансов`, price: press.course.price });

  return items;
}

/**
 * Цена разового занятия по категории расписания — как разовое посещение
 * соответствующей карты фитнеса (site-data.js → fitness.cards).
 */
const CLASS_CARD = { pool: 'aqua', aqua: 'aqua', kids: 'neptunchiki', fitness: 'day', combat: 'day', group: 'day' };

export function classPrice(category, data) {
  const card = data.fitness.cards.find((c) => c.id === CLASS_CARD[category]);
  return card?.packages.find((p) => p.visits === 1)?.price ?? null;
}

export const CLASS_ID_RE = /^class:(\d{4}-\d{2}-\d{2}):([a-z0-9-]{3,40})$/;

/** Позиция «разовое занятие» для слота расписания { key, title, date, start, category }. */
export function classItem(slot, data) {
  const price = classPrice(slot.category, data);
  if (!price) return null;
  const [, m, d] = slot.date.split('-');
  return {
    id: `class:${slot.key}`, group: 'classes', kind: 'class',
    title: `Занятие · ${slot.title}`, option: `${d}.${m}, ${slot.start}`, price,
  };
}

export const CART_LIMITS = { lines: 20, qty: 20 };

/**
 * Корзина → строки с ценами из каталога. Неизвестные id и неверные количества
 * отбрасываются (их возвращает в rejected), одинаковые id складываются.
 * Занятие всегда в количестве 1 — это одно место в группе.
 * @param {{ id: string, qty: number }[]} cart
 * @param {object[]} catalog — buildCatalog() + classItem() для занятий в корзине
 */
export function priceCart(cart, catalog) {
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const merged = new Map();
  const rejected = [];

  for (const line of Array.isArray(cart) ? cart : []) {
    const item = byId.get(line?.id);
    const qty = line?.qty;
    if (!item || !Number.isInteger(qty) || qty < 1) {
      rejected.push(line);
      continue;
    }
    const max = item.kind === 'class' || item.kind === 'membership' ? 1 : CART_LIMITS.qty;
    merged.set(item.id, Math.min(max, (merged.get(item.id) ?? 0) + qty));
  }

  const lines = [...merged].slice(0, CART_LIMITS.lines).map(([id, qty]) => {
    const item = byId.get(id);
    return {
      id, kind: item.kind, group: item.group, title: item.title, option: item.option,
      price: item.price, qty, sum: item.price * qty, ...(item.planId ? { planId: item.planId } : {}),
    };
  });
  return { lines, total: lines.reduce((s, l) => s + l.sum, 0), rejected, overflow: merged.size > CART_LIMITS.lines };
}

/** Что нужно для оформления корзины: вход (абонемент), дата визита (билеты). */
export function cartNeeds(lines) {
  return {
    account: lines.some((l) => l.kind === 'membership'),
    visitDate: lines.some((l) => l.kind === 'ticket'),
    memberships: lines.filter((l) => l.kind === 'membership').length,
  };
}
