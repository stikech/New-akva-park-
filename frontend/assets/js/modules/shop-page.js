/**
 * Витрина абонементов /shop: тренажёрный зал, бассейн, групповые программы.
 *
 * Каталог публичный (GET /api/catalog), покупка — только для вошедших:
 * абонемент привязан к аккаунту. Гость получает кнопку входа с возвратом
 * обратно (/account?next=/shop?plan=…), после входа окно покупки откроется само.
 * Оплата — перевод Kaspi (kaspi-pay.js), как у билетов.
 */

import { accountApi, shopApi } from '../services/api.js?v=4';
import { escapeHtml, formatPrice } from '../utils/format.js';
import { CONSENT_HTML, perVisit, planMeta, planTitle } from '../utils/plans.js';
import { bindCopyButtons, kaspiDisabledHtml, kaspiPayHtml, kaspiWaitingHtml, pollUntilSettled } from './kaspi-pay.js';

const $ = (selector, root = document) => root.querySelector(selector);

export function initShopPage({ root, tabs, modal }) {
  if (!root || !modal) return;
  const card = $('.visit-modal__card', modal);
  let catalog = [];
  let groups = [];
  let payment = null;
  let signedIn = false;
  let activeGroup = null;
  let order = null;
  let stopPolling = () => {};
  let opener = null;

  // ---------- витрина ----------

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
            <button class="btn primary" type="button" data-buy="${escapeHtml(p.id)}">Купить</button>
          </article>`).join('')}
      </div>`;
    root.querySelectorAll('[data-buy]').forEach((b) => b.addEventListener('click', () => open(b.dataset.buy, b)));
  }

  // ---------- окно покупки ----------

  const head = (title) => `
    <div class="vc-head">
      <h2 class="vc-title" id="shopModalTitle">${escapeHtml(title)}</h2>
      <button class="vc-close" type="button" data-modal-close aria-label="Закрыть">×</button>
    </div>`;

  const summary = (plan) => `<p class="vc-summary"><b>${escapeHtml(planTitle(plan))}</b> · ${escapeHtml(planMeta(plan))}</p>`;

  function signInHtml(plan) {
    const next = encodeURIComponent(`/shop?plan=${plan.id}`);
    return `${head('Покупка абонемента')}${summary(plan)}
      <p class="note">Абонемент привязывается к личному кабинету — там видно остаток посещений и срок. Войдите или зарегистрируйтесь, и окно покупки откроется снова.</p>
      <div class="vc-actions">
        <a class="btn primary btn--block" href="/account?next=${next}">Войти или зарегистрироваться</a>
      </div>`;
  }

  function confirmHtml(plan) {
    return `${head('Покупка абонемента')}${summary(plan)}
      <form id="shopConfirm" class="acc-form" novalidate>
        <div class="vc-amount"><span>К оплате</span><b>${formatPrice(plan.price)}</b></div>
        <label class="vc-consent">
          <input name="consent" type="checkbox" required>
          <span>${CONSENT_HTML}</span>
        </label>
        <span class="field__error" data-error="consent"></span>
        <p class="acc-status" data-status role="alert"></p>
        <button class="btn primary btn--block" type="submit">Перейти к оплате</button>
      </form>`;
  }

  function receiptHtml(plan) {
    return `${head('Абонемент оформлен')}${summary(plan)}
      <dl class="vc-list">
        <div><dt>Код заказа</dt><dd><b>${escapeHtml(order.payCode ?? '')}</b></dd></div>
        <div><dt>Сумма</dt><dd>${formatPrice(order.price)}</dd></div>
        ${order.receipt ? `<div><dt>Чек</dt><dd>${escapeHtml(order.receipt.receiptId)}</dd></div>` : ''}
      </dl>
      <div class="vc-actions">
        <a class="btn primary btn--block" href="/account/membership">Открыть абонемент в кабинете</a>
      </div>`;
  }

  function closedHtml(plan) {
    return `${head('Оплата не подтверждена')}${summary(plan)}
      <p class="note">${escapeHtml(order.kaspi?.rejectReason ?? 'Заказ закрыт')}. Если вы перевели деньги — позвоните
      <a href="tel:+77152336141">+7 7152 33-61-41</a> и назовите код <b>${escapeHtml(order.payCode ?? '')}</b>.</p>`;
  }

  function show(html) {
    card.innerHTML = html;
    card.querySelectorAll('[data-modal-close]').forEach((b) => b.addEventListener('click', close));
    bindCopyButtons(card);
  }

  function showOrder(plan) {
    stopPolling();
    if (order.status === 'paid') { show(receiptHtml(plan)); return; }
    if (order.status !== 'pending') { show(closedHtml(plan)); return; }
    if (order.kaspi?.claimedAt) {
      show(`${head('Ждём подтверждения')}${summary(plan)}${kaspiWaitingHtml({ code: order.payCode })}`);
      stopPolling = pollUntilSettled(async () => (await shopApi.order(order.id)).order, (fresh) => {
        order = fresh;
        if (!modal.hidden) showOrder(plan);
      });
      return;
    }
    show(`${head('Оплата абонемента')}${summary(plan)}${kaspiPayHtml({ payment, amount: order.price, code: order.payCode })}`);
    $('[data-kaspi-claim]', card).addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        order = (await shopApi.claimKaspi(order.id)).order;
        showOrder(plan);
      } catch (error) {
        $('[data-kaspi-status]', card).textContent = error.message;
        button.disabled = false;
      }
    });
  }

  function open(planId, source) {
    const plan = catalog.find((p) => p.id === planId);
    if (!plan) return;
    opener = source ?? null;
    order = null;
    modal.hidden = false;
    document.body.classList.add('modal-open');

    if (!payment?.enabled) { show(`${head('Покупка абонемента')}${summary(plan)}${kaspiDisabledHtml()}`); return; }
    if (!signedIn) { show(signInHtml(plan)); return; }

    show(confirmHtml(plan));
    const form = $('#shopConfirm', card);
    form.elements.consent.focus();
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const error = $('[data-error="consent"]', form);
      error.textContent = form.elements.consent.checked ? '' : 'Без согласия с условиями оплатить нельзя';
      if (!form.elements.consent.checked) return;
      const button = $('button[type="submit"]', form);
      button.disabled = true;
      $('[data-status]', form).textContent = 'Оформляем заказ…';
      try {
        order = (await shopApi.createOrder(plan.id, { consent: true })).order;
        showOrder(plan);
      } catch (err) {
        if (err.status === 401) { signedIn = false; show(signInHtml(plan)); return; }
        $('[data-status]', form).textContent = err.message;
        button.disabled = false;
      }
    });
  }

  function close() {
    if (modal.hidden) return;
    stopPolling();
    modal.hidden = true;
    card.innerHTML = '';
    document.body.classList.remove('modal-open');
    // ?plan= больше не нужен: F5 не должен снова открывать окно
    if (location.search) history.replaceState(null, '', location.pathname);
    opener?.focus?.();
  }

  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });

  // ---------- загрузка ----------

  Promise.all([shopApi.catalog(), accountApi.session().catch(() => ({ authenticated: false }))])
    .then(([data, session]) => {
      ({ catalog, groups, payment } = data);
      signedIn = Boolean(session.authenticated);
      const wanted = new URLSearchParams(location.search).get('plan');
      const wantedPlan = catalog.find((p) => p.id === wanted);
      activeGroup = wantedPlan?.group ?? groups[0]?.id;
      renderTabs();
      renderPlans();
      if (wantedPlan) open(wantedPlan.id);
    })
    .catch(() => {
      root.innerHTML = `<div class="panel"><p>Не удалось загрузить тарифы. Обновите страницу или позвоните:
        <a href="tel:+77152336141">+7 7152 33-61-41</a>.</p></div>`;
    });
}
