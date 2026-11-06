/** Таблицы тарифов аквапарка и бассейна, выгода абонемента бассейна. */

import { escapeHtml, formatPrice } from '../utils/format.js';
import { pricePerVisit } from '../utils/pricing.js';
import { addButton } from './cart-ui.js?v=1';

const POOL_PACKAGE_VISITS = 12;

/** Ячейка цены с кнопкой «в корзину» (id — из utils/catalog.js). */
const cell = (price, id, label) => `<td><span class="price-cell">${formatPrice(price)}${addButton(id, label)}</span></td>`;

const PARK_COLUMNS = [['weekday', 'h2', 'будни, 2 часа'], ['weekday', 'unl', 'будни, без лимита'], ['weekend', 'h2', 'выходные, 2 часа'], ['weekend', 'unl', 'выходные, без лимита']];
const POOL_COLUMNS = ['1 час', '2 часа', '3 часа'];

export function renderParkPrices({ rows, note }, park) {
  const tariffs = [['adult', 'Взрослый', park.adult], ['child', 'Детский', park.child]];
  rows.innerHTML = tariffs
    .map(([who, label, t]) => `<tr><td>${label}</td>${PARK_COLUMNS
      .map(([day, dur, text]) => cell(t[day][dur], `park:${who}:${day}:${dur}`, `${label} билет, ${text}`)).join('')}</tr>`)
    .join('');
  note.textContent = park.note;
}

export function renderPoolPrices({ rows, saving }, pool) {
  rows.innerHTML = pool
    .map((tariff) => `<tr><td>${escapeHtml(tariff.label)}</td>${tariff.prices.map((price, i) => (i < 3
      ? cell(price, `pool:${tariff.id}:${i + 1}`, `Бассейн, ${tariff.label}, ${POOL_COLUMNS[i]}`)
      : cell(price, `plan:pool:${tariff.id}:12`, `Абонемент в бассейн, ${tariff.label}`))).join('')}</tr>`)
    .join('');

  const adult = pool.find((t) => t.id === 'adult');
  if (!adult) return;
  const [singleHour, , , pack] = adult.prices;
  saving.textContent =
    `${POOL_PACKAGE_VISITS} посещений за ${formatPrice(pack)} — это около ` +
    `${formatPrice(pricePerVisit(pack, POOL_PACKAGE_VISITS))} за визит вместо ${formatPrice(singleHour)} ` +
    'за разовый час. Абонемент действует 2 месяца.';
}
