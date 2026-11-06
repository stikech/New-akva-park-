/**
 * Единый каталог услуг и логика корзины. Чистые функции без DOM — их используют
 * и фронтенд (калькулятор, корзина), и бэкенд (backend/src/cart.js считает
 * окончательную сумму заказа по этому же каталогу). Покрыто тестами tests/cart.test.js.
 *
 * Товар (product) — одна позиция прайса с постоянным id:
 *   park:<adult|child>:<weekday|weekend>:<h2|unl>   билет в аквапарк
 *   pool:<adult|child>:<0..3>                        бассейн: 1 ч, 2 ч, 3 ч, 12 посещений
 *   fitness:<card>:<visits>                          фитнес-клуб: разовое посещение или пакет
 *   gold:<months>                                    «Золотая» карта
 *   massage:<index>                                  массаж
 *   solarium:<group>:min:<index>                     солярий поминутно (количество = минуты)
 *   solarium:<group>:cert:<minutes>                  сертификат солярия
 *   press:single | press:course                      прессотерапия
 *
 * Строка корзины — { id, qty }. Цена в строке не хранится: её всегда берут из
 * каталога, поэтому подменить сумму через localStorage или запрос нельзя.
 */

import { plural } from './format.js';

export const CART_STORAGE_KEY = 'neptun:cart:v1';
export const CART_MAX_QTY = 50;
export const CART_MAX_LINES = 30;

export const CART_CATEGORIES = [
  { id: 'park', label: 'Аквапарк' },
  { id: 'pool', label: 'Бассейн' },
  { id: 'fitness', label: 'Фитнес' },
  { id: 'spa', label: 'SPA' },
];

const DAY_LABEL = { weekday: 'будни', weekend: 'выходные' };
const DURATION_LABEL = { h2: '2 часа', unl: 'без лимита' };
const GUEST_LABEL = { adult: 'Взрослый', child: 'Детский' };
/** Порядок цен бассейна в site-data.js: 1 ч, 2 ч, 3 ч, 12 посещений (2 месяца). */
const POOL_OPTIONS = ['1 час', '2 часа', '3 часа', '12 посещений, 2 месяца'];

const visitsWord = (n) => plural(n, ['посещение', 'посещения', 'посещений']);
const monthsWord = (n) => plural(n, ['месяц', 'месяца', 'месяцев']);

/**
 * Каталог всех услуг из данных сайта (SITE_DATA / GET /api/site).
 * @returns {{ id: string, category: string, group: string, title: string, option: string, price: number, unit?: string }[]}
 *   group — подзаголовок в выпадающем списке калькулятора;
 *   option — короткая подпись в списке; title — полная строка для корзины и чека;
 *   unit — 'min' для поминутных услуг (количество = минуты).
 */
export function buildProducts(data) {
  const products = [];
  const add = (p) => { if (Number.isFinite(p.price) && p.price > 0) products.push(p); };

  const park = data?.prices?.park;
  if (park) {
    for (const guest of ['adult', 'child']) {
      for (const day of ['weekday', 'weekend']) {
        for (const duration of ['h2', 'unl']) {
          add({
            id: `park:${guest}:${day}:${duration}`,
            category: 'park',
            group: `Аквапарк · ${GUEST_LABEL[guest]}`,
            option: `${DAY_LABEL[day]}, ${DURATION_LABEL[duration]}`,
            title: `Аквапарк · ${GUEST_LABEL[guest]} билет · ${DAY_LABEL[day]}, ${DURATION_LABEL[duration]}`,
            price: park[guest]?.[day]?.[duration],
          });
        }
      }
    }
  }

  for (const row of data?.prices?.pool ?? []) {
    row.prices.forEach((price, i) => {
      if (!POOL_OPTIONS[i]) return;
      add({
        id: `pool:${row.id}:${i}`,
        category: 'pool',
        group: `Бассейн · ${row.label}`,
        option: POOL_OPTIONS[i],
        title: `Бассейн · ${row.label} · ${POOL_OPTIONS[i]}`,
        price,
      });
    });
  }

  for (const card of data?.fitness?.cards ?? []) {
    for (const pkg of card.packages) {
      const option = pkg.visits === 1 ? 'разовое посещение' : `${pkg.visits} ${visitsWord(pkg.visits)}`;
      add({
        id: `fitness:${card.id}:${pkg.visits}`,
        category: 'fitness',
        group: `Фитнес · ${card.name}`,
        option,
        title: `Фитнес · ${card.name} · ${option}`,
        price: pkg.price,
      });
    }
  }

  const gold = data?.fitness?.gold;
  for (const period of gold?.periods ?? []) {
    const option = `${period.months} ${monthsWord(period.months)}, безлимит`;
    add({
      id: `gold:${period.months}`,
      category: 'fitness',
      group: `Фитнес · ${gold.name}`,
      option,
      title: `Фитнес · ${gold.name} · ${option}`,
      price: period.price,
    });
  }

  const spa = data?.spa;
  (spa?.massage ?? []).forEach((m, i) => {
    add({
      id: `massage:${i}`,
      category: 'spa',
      group: 'Массаж',
      option: `${m.name} (${m.duration})`,
      title: `Массаж · ${m.name} (${m.duration})`,
      price: m.price,
    });
  });

  (spa?.solarium?.groups ?? []).forEach((g, gi) => {
    g.perMinute.forEach((m, i) => {
      add({
        id: `solarium:${gi}:min:${i}`,
        category: 'spa',
        group: `Солярий · ${g.title}`,
        option: `${m.name}, поминутно`,
        title: `Солярий · ${g.title} · ${m.name}, минута`,
        price: m.price,
        unit: 'min',
      });
    });
    g.certificates.forEach((c) => {
      add({
        id: `solarium:${gi}:cert:${c.minutes}`,
        category: 'spa',
        group: `Солярий · ${g.title}`,
        option: `сертификат на ${c.minutes} минут`,
        title: `Солярий · ${g.title} · сертификат на ${c.minutes} минут`,
        price: c.price,
      });
    });
  });

  const press = spa?.pressotherapy;
  if (press) {
    add({
      id: 'press:single',
      category: 'spa',
      group: 'Прессотерапия',
      option: `сеанс ${press.minutes} минут`,
      title: `Прессотерапия · сеанс ${press.minutes} минут`,
      price: press.single,
    });
    if (press.course) {
      add({
        id: 'press:course',
        category: 'spa',
        group: 'Прессотерапия',
        option: `курс ${press.course.sessions} сеансов`,
        title: `Прессотерапия · курс ${press.course.sessions} сеансов`,
        price: press.course.price,
      });
    }
  }

  return products;
}

/** Каталог в виде Map id → товар (быстрый поиск при пересчёте корзины). */
export function productIndex(products) {
  return new Map(products.map((p) => [p.id, p]));
}

/** Целое количество в пределах 1…CART_MAX_QTY; мусор → 0 (строка будет удалена). */
export function clampQty(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.min(CART_MAX_QTY, n);
}

/**
 * Приводит произвольные данные (localStorage, тело запроса) к корректной корзине:
 * только известные товары, количество 1…50, одинаковые id склеены, не больше 30 строк.
 * @param {unknown} raw
 * @param {Map<string, object>} index  productIndex(...)
 * @returns {{ id: string, qty: number }[]}
 */
export function normalizeCart(raw, index) {
  if (!Array.isArray(raw)) return [];
  const merged = new Map();
  for (const line of raw) {
    const id = typeof line?.id === 'string' ? line.id : '';
    if (!index.has(id)) continue;
    const qty = clampQty(line.qty);
    if (!qty) continue;
    merged.set(id, clampQty((merged.get(id) ?? 0) + qty));
  }
  return [...merged].slice(0, CART_MAX_LINES).map(([id, qty]) => ({ id, qty }));
}

/** Добавляет товар (или увеличивает количество существующей строки). Возвращает новую корзину. */
export function addToCart(lines, id, qty = 1) {
  const add = clampQty(qty);
  if (!add) return lines;
  const found = lines.find((l) => l.id === id);
  if (found) return lines.map((l) => (l.id === id ? { id, qty: clampQty(l.qty + add) } : l));
  if (lines.length >= CART_MAX_LINES) return lines;
  return [...lines, { id, qty: add }];
}

/** Устанавливает количество строки; 0 и меньше удаляют строку. */
export function setQty(lines, id, qty) {
  const n = clampQty(qty);
  return n ? lines.map((l) => (l.id === id ? { id, qty: n } : l)) : lines.filter((l) => l.id !== id);
}

export function removeLine(lines, id) {
  return lines.filter((l) => l.id !== id);
}

/**
 * Строки корзины с ценами из каталога.
 * @returns {{ lines: { id, qty, title, unitPrice, sum, unit?, category }[], total: number, count: number }}
 */
export function priceCart(lines, index) {
  const priced = [];
  let total = 0;
  let count = 0;
  for (const { id, qty } of lines) {
    const p = index.get(id);
    if (!p) continue;
    const sum = p.price * qty;
    priced.push({ id, qty, title: p.title, unitPrice: p.price, sum, unit: p.unit, category: p.category });
    total += sum;
    count += p.unit === 'min' ? 1 : qty; // минуты солярия — одна услуга, а не 10 штук
  }
  return { lines: priced, total, count };
}

/** Состав визита калькулятора аквапарка → строки корзины (взрослые и детские билеты). */
export function parkLines({ adult, child, day, duration }) {
  return [
    { id: `park:adult:${day}:${duration}`, qty: adult },
    { id: `park:child:${day}:${duration}`, qty: child },
  ].filter((l) => l.qty > 0);
}

/** «3 услуги» — подпись счётчика корзины. */
export function itemsLabel(n) {
  return `${n} ${plural(n, ['услуга', 'услуги', 'услуг'])}`;
}
