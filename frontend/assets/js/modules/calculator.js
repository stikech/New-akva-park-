/**
 * Единый калькулятор: аквапарк, бассейн, фитнес и SPA.
 *
 * Сфера выбирается переключателем в самом калькуляторе:
 *  - «Аквапарк» — привычный расчёт визита: взрослые, дети, будни/выходные, 2 часа/без лимита;
 *  - остальные сферы — выбор услуги из прайса этой сферы и количество.
 * «Добавить в корзину» кладёт позиции в общую корзину (modules/cart.js); итог
 * считается по тому же каталогу, что и на сервере (utils/cart.js).
 */

import { escapeHtml, formatPrice } from '../utils/format.js';
import { CART_CATEGORIES, CART_MAX_QTY, parkLines, priceCart } from '../utils/cart.js';
import { clampGuests } from '../utils/pricing.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const CATEGORY_LABEL = Object.fromEntries(CART_CATEGORIES.map((c) => [c.id, c.label]));

export function initCalculator({ root }, cart, initialDay) {
  const products = [...cart.index.values()];
  const state = {
    category: 'park',
    park: { adult: 2, child: 1, day: initialDay, duration: 'unl' },
    service: {}, // выбранная услуга по сфере: { pool: 'pool:adult:0', … }
    qty: 1,
  };

  const parkBox = $('[data-calc-mode="park"]', root);
  const serviceBox = $('[data-calc-mode="service"]', root);
  const select = $('#calcService', root);
  const groups = $$('.seg[data-group]', parkBox);
  const out = {
    cats: $$('[data-calc-cats] button', root),
    adult: $('[data-count="adult"]', root),
    child: $('[data-count="child"]', root),
    qty: $('[data-count="qty"]', root),
    unitPrice: $('[data-unit-price]', root),
    unitLabel: $('[data-calc-unit-label]', root),
    total: $('[data-total]', root),
    added: $('[data-calc-added]', root),
    add: $('[data-calc-add]', root),
  };

  const byCategory = (category) => products.filter((p) => p.category === category);
  const currentProduct = () => cart.index.get(state.service[state.category]);

  /** Позиции, которые сейчас уйдут в корзину. */
  function pendingLines() {
    if (state.category === 'park') return parkLines(state.park);
    const p = currentProduct();
    return p ? [{ id: p.id, qty: state.qty }] : [];
  }

  function fillSelect() {
    const list = byCategory(state.category);
    if (!state.service[state.category] && list.length) state.service[state.category] = list[0].id;
    const grouped = new Map();
    for (const p of list) {
      if (!grouped.has(p.group)) grouped.set(p.group, []);
      grouped.get(p.group).push(p);
    }
    select.innerHTML = [...grouped].map(([group, items]) => `
      <optgroup label="${escapeHtml(group)}">
        ${items.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === state.service[state.category] ? 'selected' : ''}>${escapeHtml(p.option)} — ${formatPrice(p.price)}${p.unit === 'min' ? '/мин' : ''}</option>`).join('')}
      </optgroup>`).join('');
  }

  function render() {
    const isPark = state.category === 'park';
    parkBox.hidden = !isPark;
    serviceBox.hidden = isPark;
    out.cats.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.category === state.category)));

    if (isPark) {
      out.adult.textContent = state.park.adult;
      out.child.textContent = state.park.child;
      groups.forEach((group) => {
        $$('button', group).forEach((btn) =>
          btn.setAttribute('aria-pressed', String(btn.dataset.value === state.park[group.dataset.group])));
      });
    } else {
      const p = currentProduct();
      out.qty.textContent = state.qty;
      out.unitLabel.textContent = p?.unit === 'min' ? 'Минуты' : 'Количество';
      out.unitPrice.textContent = p ? `${formatPrice(p.price)}${p.unit === 'min' ? ' / мин' : ''}` : '—';
    }

    const lines = pendingLines();
    out.total.textContent = formatPrice(priceCart(lines, cart.index).total);
    out.add.disabled = lines.length === 0;
  }

  function setCategory(category) {
    if (!CATEGORY_LABEL[category] || category === state.category) return;
    state.category = category;
    state.qty = 1;
    out.added.textContent = '';
    if (category !== 'park') fillSelect();
    render();
  }

  // ---------- события ----------

  $$('.stepper button[data-guest]', parkBox).forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.guest;
      state.park[key] = clampGuests(state.park[key] + Number(btn.dataset.step));
      render();
    });
  });

  groups.forEach((group) => {
    group.addEventListener('click', (event) => {
      const btn = event.target.closest('button');
      if (!btn) return;
      state.park[group.dataset.group] = btn.dataset.value;
      render();
    });
  });

  $$('[data-qty-step]', serviceBox).forEach((btn) => {
    btn.addEventListener('click', () => {
      state.qty = Math.min(CART_MAX_QTY, Math.max(1, state.qty + Number(btn.dataset.qtyStep)));
      render();
    });
  });

  select.addEventListener('change', () => {
    state.service[state.category] = select.value;
    state.qty = 1;
    render();
  });

  out.add.addEventListener('click', () => {
    const lines = pendingLines();
    if (!lines.length) return;
    cart.addMany(lines);
    const { total } = priceCart(lines, cart.index);
    out.added.textContent = `Добавлено в корзину на ${formatPrice(total)}.`;
  });

  out.cats.forEach((b) => b.addEventListener('click', () => setCategory(b.dataset.category)));

  render();

  return {
    /** Показать подтверждение после добавления из таблицы прайса. */
    notifyAdded(id) {
      const p = cart.index.get(id);
      if (p) out.added.textContent = `«${p.title}» — в корзине.`;
    },
  };
}
