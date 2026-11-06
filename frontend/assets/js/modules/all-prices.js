/**
 * Единый прайс на странице /prices: все услуги аквапарка, бассейна, фитнеса и SPA в одной таблице.
 *
 * У каждой строки «+» (общая кнопка data-add из cart-ui.js: анимация и подтверждение);
 * когда услуга уже в корзине, рядом появляются «−» и количество. Разные услуги копятся
 * в корзине отдельными строками, повторный «+» увеличивает количество.
 * Цены — из того же каталога, что у корзины и сервера (utils/catalog.js).
 */

import { GROUPS, buildCatalog } from '../utils/catalog.js?v=1';
import { escapeHtml, formatPrice } from '../utils/format.js';
import { addButton } from './cart-ui.js?v=1';
import { cart } from './cart.js?v=1';

const GROUP_HEAD = {
  park: 'Аквапарк',
  pool: 'Плавательный бассейн',
  fitness: 'Фитнес-клуб',
  spa: 'SPA: массаж, солярий, прессотерапия',
};

export function renderAllPrices(root, data) {
  const items = buildCatalog(data).filter((i) => GROUP_HEAD[i.group]);
  const order = GROUPS.map((g) => g.id);
  items.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));

  let lastGroup = null;
  let lastTitle = null;
  const rows = items.map((item) => {
    let head = '';
    if (item.group !== lastGroup) {
      head += `<tr class="all-prices__group" id="price-${escapeHtml(item.group)}"><th colspan="3" scope="colgroup">${escapeHtml(GROUP_HEAD[item.group])}</th></tr>`;
      lastGroup = item.group;
      lastTitle = null;
    }
    if (item.title !== lastTitle) {
      head += `<tr class="all-prices__sub"><th colspan="3" scope="colgroup">${escapeHtml(item.title)}</th></tr>`;
      lastTitle = item.title;
    }
    const label = `${item.title}, ${item.option}`;
    return `${head}
      <tr data-price-row="${escapeHtml(item.id)}">
        <td>${escapeHtml(item.option)}${item.kind === 'membership' ? ' <span class="all-prices__tag">абонемент</span>' : ''}</td>
        <td class="all-prices__price">${formatPrice(item.price)}</td>
        <td class="all-prices__ctrl">
          <span class="all-prices__qty">
            <button class="add-btn add-btn--minus" type="button" data-minus="${escapeHtml(item.id)}" aria-label="Убрать одну: ${escapeHtml(label)}" title="Убрать одну" hidden>−</button>
            <output data-price-qty hidden>0</output>
            ${addButton(item.id, label)}
          </span>
        </td>
      </tr>`;
  }).join('');

  root.innerHTML = `
    <div class="scroll-x">
      <table class="all-prices__table">
        <thead><tr><th>Услуга</th><th>Цена</th><th><span class="visually-hidden">В корзине</span></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  // «−» в строке прайса: минус одна штука, при нуле позиция уходит из корзины
  root.addEventListener('click', (event) => {
    const minus = event.target.closest('[data-minus]');
    if (!minus) return;
    const id = minus.dataset.minus;
    const left = cart.qty(id) - 1;
    cart.set(id, left);
    if (left <= 0) minus.closest('tr')?.querySelector('[data-add]')?.focus();
  });

  const sync = () => {
    root.querySelectorAll('[data-price-row]').forEach((tr) => {
      const n = cart.qty(tr.dataset.priceRow);
      tr.classList.toggle('is-in-cart', n > 0);
      const out = tr.querySelector('[data-price-qty]');
      out.textContent = String(n);
      out.hidden = n === 0;
      tr.querySelector('[data-minus]').hidden = n === 0;
    });
  };
  cart.onChange(sync);
  sync();
}
