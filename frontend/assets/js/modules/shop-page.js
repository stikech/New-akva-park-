/**
 * Витрина абонементов /shop: тренажёрный зал, бассейн, групповые программы.
 *
 * Каталог публичный (GET /api/catalog). Абонемент кладётся в корзину (modules/cart-ui.js) —
 * оплачивается вместе с билетами и SPA на /checkout. Абонемент привязан к аккаунту, поэтому
 * вход страница оформления попросит сама. Ссылка /shop?plan=<id> сразу кладёт тариф в корзину.
 */

import { shopApi } from '../services/api.js?v=4';
import { escapeHtml, formatPrice } from '../utils/format.js';
import { perVisit, planMeta, planTitle } from '../utils/plans.js';
import { addToCart } from './cart-ui.js?v=1';

export function initShopPage({ root, tabs }) {
  if (!root) return;
  let catalog = [];
  let groups = [];
  let activeGroup = null;

  function renderTabs() {
    tabs.innerHTML = groups.map((g) => `
      <button role="tab" type="button" id="shop-tab-${g.id}" aria-selected="${g.id === activeGroup}"
        data-group="${g.id}">${escapeHtml(g.title)}</button>`).join('');
    tabs.querySelectorAll('[data-group]').forEach((b) => b.addEventListener('click', () => {
      activeGroup = b.dataset.group;
      renderTabs();
      renderPlans();
    }));
  }

  function renderPlans() {
    const plans = catalog.filter((p) => p.group === activeGroup);
    root.innerHTML = `
      <div class="plan-grid" role="tabpanel" aria-labelledby="shop-tab-${activeGroup}">
        ${plans.map((p) => `
          <article class="plan${p.visitsTotal == null ? ' plan--gold' : ''}">
            <h3 class="plan__title">${escapeHtml(planTitle(p))}</h3>
            <p class="plan__meta">${escapeHtml(planMeta(p))}</p>
            <p class="plan__price">${formatPrice(p.price)}</p>
            ${perVisit(p) ? `<p class="plan__per">${escapeHtml(perVisit(p))}</p>` : '<p class="plan__per">без ограничения посещений</p>'}
            <div class="plan__actions">
              <button class="btn primary" type="button" data-add="plan:${escapeHtml(p.id)}">В корзину</button>
              <button class="btn ghost" type="button" data-buy-now="plan:${escapeHtml(p.id)}">Купить сейчас</button>
            </div>
          </article>`).join('')}
      </div>`;
    root.querySelectorAll('[data-buy-now]').forEach((b) => b.addEventListener('click', () => {
      if (addToCart(b.dataset.buyNow, 1, { from: b, quiet: true })) location.href = '/checkout';
    }));
  }

  shopApi.catalog()
    .then((data) => {
      ({ catalog, groups } = data);
      const wanted = catalog.find((p) => p.id === new URLSearchParams(location.search).get('plan'));
      activeGroup = wanted?.group ?? groups[0]?.id;
      renderTabs();
      renderPlans();
      if (wanted) {
        addToCart(`plan:${wanted.id}`);
        history.replaceState(null, '', location.pathname);
      }
    })
    .catch(() => {
      root.innerHTML = `<div class="panel"><p>Не удалось загрузить тарифы. Обновите страницу или позвоните:
        <a href="tel:+77152336141">+7 7152 33-61-41</a>.</p></div>`;
    });
}
