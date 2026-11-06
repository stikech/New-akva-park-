/** Единый прайс всех сфер с кнопками «+»/«−», примечания к тарифам. */

import { escapeHtml, formatPrice } from '../utils/format.js';
import { pricePerVisit } from '../utils/pricing.js';

const POOL_PACKAGE_VISITS = 12;

/** Подписи сфер в едином прайсе; id — якоря для быстрого перехода (#price-park…). */
const CATEGORY_HEAD = { park: 'Аквапарк', pool: 'Плавательный бассейн', fitness: 'Фитнес-клуб', spa: 'SPA: массаж, солярий, прессотерапия' };

/**
 * Единый прайс: все услуги всех сфер в одной таблице. У каждой строки «+» —
 * добавить в корзину; когда услуга уже в корзине, рядом появляются «−» и количество
 * (их обновляет syncCatalogQty при каждом изменении корзины).
 * @param {HTMLElement} rows  <tbody>
 * @param {{ id: string, category: string, group: string, option: string, title: string, price: number, unit?: string }[]} products
 */
export function renderCatalogRows(rows, products) {
  let lastCategory = null;
  let lastGroup = null;
  rows.innerHTML = products.map((p) => {
    let head = '';
    if (p.category !== lastCategory) {
      head += `<tr class="catalog-table__cat" id="price-${escapeHtml(p.category)}"><th colspan="3" scope="colgroup">${escapeHtml(CATEGORY_HEAD[p.category] ?? p.category)}</th></tr>`;
      lastCategory = p.category;
    }
    if (p.group !== lastGroup) {
      head += `<tr class="catalog-table__group"><th colspan="3" scope="colgroup">${escapeHtml(p.group)}</th></tr>`;
      lastGroup = p.group;
    }
    const unit = p.unit === 'min' ? '<small> / мин</small>' : '';
    return `${head}
      <tr data-product-row="${escapeHtml(p.id)}">
        <td>${escapeHtml(p.option)}</td>
        <td class="catalog-table__price">${formatPrice(p.price)}${unit}</td>
        <td class="catalog-table__add">
          <div class="row-qty">
            <button class="add-btn add-btn--minus" type="button" data-remove-product="${escapeHtml(p.id)}" aria-label="Убрать одну: ${escapeHtml(p.title)}" hidden>−</button>
            <output class="row-qty__n" data-row-qty hidden>0</output>
            <button class="add-btn" type="button" data-add-product="${escapeHtml(p.id)}" aria-label="В корзину: ${escapeHtml(p.title)}">+</button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

/** Показывает в строках прайса, сколько каждой услуги уже в корзине. */
export function syncCatalogQty(rows, lines) {
  const qty = new Map(lines.map((l) => [l.id, l.qty]));
  rows.querySelectorAll('[data-product-row]').forEach((tr) => {
    const n = qty.get(tr.dataset.productRow) ?? 0;
    tr.classList.toggle('is-in-cart', n > 0);
    tr.querySelector('[data-row-qty]').textContent = String(n);
    tr.querySelector('[data-row-qty]').hidden = n === 0;
    tr.querySelector('[data-remove-product]').hidden = n === 0;
  });
}

/** Примечание о тарифе выходного дня. */
export function renderParkNote(note, park) {
  note.textContent = park?.note ?? '';
}

/** Выгода абонемента бассейна. */
export function renderPoolSaving(saving, pool) {
  const adult = pool?.find((t) => t.id === 'adult');
  if (!adult) return;
  const [singleHour, , , pack] = adult.prices;
  saving.textContent = `Бассейн: ${POOL_PACKAGE_VISITS} посещений за ${formatPrice(pack)} — около `
    + `${formatPrice(pricePerVisit(pack, POOL_PACKAGE_VISITS))} за визит вместо ${formatPrice(singleHour)} за разовый час. Абонемент действует 2 месяца.`;
}
