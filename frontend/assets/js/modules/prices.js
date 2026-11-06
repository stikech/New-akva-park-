/** Таблицы тарифов аквапарка и бассейна, выгода абонемента бассейна. */

import { escapeHtml, formatPrice } from '../utils/format.js';
import { pricePerVisit } from '../utils/pricing.js';

const POOL_PACKAGE_VISITS = 12;

const cells = (values) => values.map((v) => `<td>${formatPrice(v)}</td>`).join('');

export function renderParkPrices({ rows, note }, park) {
  const tariffs = [['Взрослый', park.adult], ['Детский', park.child]];
  rows.innerHTML = tariffs
    .map(([label, t]) => `<tr><td>${label}</td>${cells([t.weekday.h2, t.weekday.unl, t.weekend.h2, t.weekend.unl])}</tr>`)
    .join('');
  note.textContent = park.note;
}

export function renderPoolPrices({ rows, saving }, pool) {
  rows.innerHTML = pool
    .map((tariff) => `<tr><td>${escapeHtml(tariff.label)}</td>${cells(tariff.prices)}</tr>`)
    .join('');

  const adult = pool.find((t) => t.id === 'adult');
  if (!adult) return;
  const [singleHour, , , pack] = adult.prices;
  saving.textContent =
    `${POOL_PACKAGE_VISITS} посещений за ${formatPrice(pack)} — это около ` +
    `${formatPrice(pricePerVisit(pack, POOL_PACKAGE_VISITS))} за визит вместо ${formatPrice(singleHour)} ` +
    'за разовый час. Абонемент действует 2 месяца.';
}

/**
 * Прайс сферы из единого каталога (фитнес, SPA): строки по группам и кнопка «+»
 * у каждой позиции — она кладёт услугу в корзину (modules/cart.js → bindAddButtons).
 * @param {HTMLElement} rows  <tbody>
 * @param {{ id: string, group: string, option: string, price: number, unit?: string }[]} products
 */
export function renderCatalogRows(rows, products) {
  let lastGroup = null;
  rows.innerHTML = products.map((p) => {
    const head = p.group === lastGroup ? '' : `<tr class="catalog-table__group"><th colspan="3" scope="colgroup">${escapeHtml(p.group)}</th></tr>`;
    lastGroup = p.group;
    return `${head}
      <tr>
        <td>${escapeHtml(p.option)}</td>
        <td class="catalog-table__price">${formatPrice(p.price)}${p.unit === 'min' ? '<small> / мин</small>' : ''}</td>
        <td class="catalog-table__add"><button class="add-btn" type="button" data-add-product="${escapeHtml(p.id)}" aria-label="В корзину: ${escapeHtml(p.title)}">+</button></td>
      </tr>`;
  }).join('');
}
