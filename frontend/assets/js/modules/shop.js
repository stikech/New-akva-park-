/**
 * Магазин кабинета: каталог тарифов, покупка и продление абонементов, чеки.
 *
 * Состояния: каталог → чекаут (перевод Kaspi → «Я оплатил» → ожидание) → чек.
 * Каталог и реквизиты Kaspi приходят от сервера вместе со списком заказов
 * (GET /api/orders) — цены только из каталога, с фронта их никто не подменит.
 * Заказ создаётся с Idempotency-Key (api.js): повтор сети не создаст второй.
 * Абонемент выдаётся сразу после того, как администратор подтвердит перевод.
 *
 * Новые покупки идут через общую корзину (/checkout: карта, перевод на карту, Kaspi) —
 * кнопка «Купить» кладёт тариф в корзину. Здесь остаются старые заказы и их оплата.
 */

import { shopApi } from '../services/api.js?v=4';
import { escapeHtml, formatPrice, plural } from '../utils/format.js';
import { CONSENT_HTML, perVisit, planMeta, planTitle } from '../utils/plans.js';
import { bindCopyButtons, kaspiDisabledHtml, kaspiPayHtml, kaspiWaitingHtml, pollUntilSettled } from './kaspi-pay.js';
import { cart } from './cart.js?v=1';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const GROUP_LABEL = { gym: 'Тренажёрный зал', pool: 'Бассейн', classes: 'Групповые программы' };
const STATUS_LABEL = { pending: 'Ожидает оплаты', paid: 'Оплачен', cancelled: 'Отменён', expired: 'Истёк' };

/**
 * Подключает магазин. Родительский account.js даёт:
 *  - root — контейнер панели;
 *  - getUser()/refreshUser() — доступ к текущему пользователю и обновлению;
 *  - goto(tab, planId?) — переключение вкладок, planId выбирает тариф.
 */
export function initShop({ root, getUser, refreshUser, goto }) {
  let state = 'loading'; // catalog | confirm (оферта) | checkout | receipt
  let confirmPlan = null; // тариф на шаге согласия с офертой
  let plans = [];
  let orders = [];
  let activeOrder = null;
  let lastResult = null; // { extended } после оплаты
  let payment = null; // реквизиты Kaspi с сервера
  let stopPolling = () => {};

  const user = getUser;
  const currentPlanId = () => getUser()?.membership?.planId ?? null;
  const currentActive = () => {
    const m = getUser()?.membership;
    return Boolean(m && (m.status.code === 'active' || m.status.code === 'scheduled'));
  };

  // ---------- helpers ----------

  /** Тарифы по группам витрины; первой — группа текущего абонемента. */
  function grouped() {
    const mine = plans.find((p) => p.id === currentPlanId())?.group ?? null;
    const keys = Object.keys(GROUP_LABEL).sort((a, b) => (a === mine ? -1 : b === mine ? 1 : 0));
    return keys
      .map((k) => ({ key: k, label: GROUP_LABEL[k], plans: plans.filter((p) => (p.group ?? p.category) === k) }))
      .filter((g) => g.plans.length);
  }

  const isCurrent = (p) => p.id === currentPlanId();

  // ---------- render: каталог ----------

  function catalogHtml() {
    const m = user()?.membership;
    const status = m?.status;
    const headline = !m
      ? 'Выберите абонемент — оформим за минуту'
      : status.code === 'active' || status.code === 'scheduled'
        ? 'Тариф действует: покупка этого же тарифа продлит его'
        : 'Срок или посещения закончились — продлить можно тут же';

    const planCard = (p) => {
      const current = isCurrent(p) && currentActive();
      const action = current ? 'Продлить' : !m ? 'Купить' : m.planId === p.id ? 'Продлить' : 'Оформить';
      return `
        <article class="shop-plan${p.category === 'fitness' && p.visitsTotal == null ? ' shop-plan--gold' : ''}" data-plan-id="${escapeHtml(p.id)}">
          <div class="shop-plan__head">
            <span class="shop-plan__cat">${escapeHtml(GROUP_LABEL[p.group] ?? p.category)}</span>
            ${current ? '<span class="badge" data-code="active">Ваш тариф</span>' : ''}
          </div>
          <h3 class="shop-plan__title">${escapeHtml(planTitle(p))}</h3>
          <p class="shop-plan__meta">${escapeHtml(planMeta(p))}</p>
          <p class="shop-plan__price">${formatPrice(p.price)}</p>
          <button class="${current ? 'btn outline' : 'btn primary'} btn--block shop-plan__buy" type="button" data-buy="${escapeHtml(p.id)}">
            ${action}
          </button>
          ${perVisit(p) ? `<p class="note">${escapeHtml(perVisit(p))}</p>` : ''}
        </article>`;
    };

    return `
      <p class="shop-note">${escapeHtml(headline)}</p>
      ${grouped().map((g) => `
        <section class="shop-group">
          <h3 class="acc-h3">${escapeHtml(g.label)}</h3>
          <div class="shop-grid">${g.plans.map(planCard).join('')}</div>
        </section>`).join('')}
      ${ordersHtml()}
      <div class="panel shop-guarantee">
        <svg class="ic" aria-hidden="true"><use href="#i-lock"/></svg>
        <div>
          <h3 class="acc-h3">Как защищены платежи</h3>
          <ul class="shop-guarantee__list">
            <li>Цены фиксирует сервер — в заказе нельзя прислать свою сумму.</li>
            <li>Оплата — переводом Kaspi напрямую на счёт аквапарка, с кодом заказа в комментарии.</li>
            <li>Абонемент включается, как только администратор увидит перевод. Данные карты нам не нужны.</li>
          </ul>
        </div>
      </div>`;
  }

  function ordersHtml() {
    if (!orders.length) return '';
    return `
      <section class="panel">
        <h3 class="acc-h3">История заказов</h3>
        <ul class="orders">
          ${orders.slice(0, 10).map((o) => `
            <li class="orders__item" data-order="${escapeHtml(o.id)}">
              <div>
                <b>${escapeHtml(o.title.split(' · ').slice(1).join(' · ') || o.title)}</b>
                <time datetime="${escapeHtml(o.createdAt)}">${new Date(o.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</time>
              </div>
              <div class="orders__right">
                <span class="orders__price">${formatPrice(o.price)}</span>
                <span class="badge ${o.status === 'paid' ? '' : 'badge--light'}" data-code="${o.status === 'paid' ? 'active' : 'none'}">${escapeHtml(STATUS_LABEL[o.status] ?? o.status)}</span>
                ${o.status === 'pending' ? `<button class="btn outline" type="button" data-pay-order="${escapeHtml(o.id)}">${o.kaspi?.claimedAt ? 'Проверяем перевод' : 'Оплатить'}</button>` : ''}
                ${o.receipt ? `<small class="note">чек <b>${escapeHtml(o.receipt.receiptId)}</b></small>` : ''}
                ${o.kaspi?.rejectReason ? `<small class="note">${escapeHtml(o.kaspi.rejectReason)}</small>` : ''}
              </div>
            </li>`).join('')}
        </ul>
      </section>`;
  }

  // ---------- render: чекаут ----------

  function checkoutHtml(order) {
    const m = user();
    const phoneMissing = !m.phone;
    return `
      <div class="shop-checkout">
        <button class="shop-back" type="button" data-shop-back>← К каталогу</button>
        <div class="panel">
          <h3 class="acc-h3">Оплата</h3>
          <p class="shop-checkout__summary">
            <b>${escapeHtml(order.title.split(' · ').slice(1).join(' · ') || order.title)}</b>
            <span>${currentActive() && isCurrent({ id: order.planId }) ? 'продление текущего абонемента' : order.category === 'pool' ? 'абонемент на бассейн' : 'абонемент фитнес-клуба'}</span>
          </p>
          <p class="shop-checkout__amount"><span>К оплате</span><b>${formatPrice(order.price)}</b></p>
          ${phoneMissing ? `<p class="note">Телефон в профиле не указан — администрация не сможет связаться с вами по вопросу заказа. <a href="/account/profile" data-goto="tab-profile" data-edit="1">Заполнить телефон</a>.</p>` : ''}
          ${!payment?.enabled
            ? kaspiDisabledHtml()
            : order.kaspi?.claimedAt
              ? kaspiWaitingHtml({ code: order.payCode })
              : kaspiPayHtml({ payment, amount: order.price, code: order.payCode })}
          <div class="acc-actions">
            <button class="btn outline" type="button" data-shop-back>← К каталогу</button>
            ${order.kaspi?.claimedAt ? '' : '<button class="btn ghost" type="button" data-shop-cancel>Отменить заказ</button>'}
          </div>
        </div>
      </div>`;
  }

  // ---------- render: согласие с офертой ----------

  function confirmHtml(plan) {
    return `
      <div class="shop-checkout">
        <button class="shop-back" type="button" data-shop-back>← К каталогу</button>
        <div class="panel">
          <h3 class="acc-h3">Оформление</h3>
          <p class="shop-checkout__summary"><b>${escapeHtml(planTitle(plan))}</b><span>${escapeHtml(planMeta(plan))}</span></p>
          <p class="shop-checkout__amount"><span>К оплате</span><b>${formatPrice(plan.price)}</b></p>
          <form id="confirmForm" class="acc-form" novalidate>
            <label class="consent">
              <input name="consent" type="checkbox" required>
              <span>${CONSENT_HTML}</span>
            </label>
            <span class="field__error" data-error="consent"></span>
            <p class="acc-status" data-status role="alert"></p>
            <div class="acc-actions">
              <button class="btn primary" type="submit">Перейти к оплате</button>
              <button class="btn outline" type="button" data-shop-back>Отмена</button>
            </div>
          </form>
        </div>
      </div>`;
  }

  function bindConfirm() {
    $$('[data-shop-back]', root).forEach((b) => b.addEventListener('click', backToCatalog));
    const form = $('#confirmForm', root);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const error = $('[data-error="consent"]', form);
      error.textContent = form.elements.consent.checked ? '' : 'Без согласия с условиями оплатить нельзя';
      if (!form.elements.consent.checked) return;
      const button = $('button[type="submit"]', form);
      button.disabled = true;
      $('[data-status]', form).textContent = 'Оформляем заказ…';
      try {
        const { order } = await shopApi.createOrder(confirmPlan.id, { consent: true });
        if (order.status !== 'pending') { await load(); return; }
        showCheckout(order);
      } catch (err) {
        if (err.status === 422 && err.body?.errors?.planId) { await load(); return; }
        $('[data-status]', form).textContent = err.status === 401 ? 'Сеанс завершён — войдите снова.' : err.message;
        button.disabled = false;
      }
    });
  }

  // ---------- render: чек ----------

  function receiptHtml(order) {
    const { receipt } = order;
    const headline = lastResult?.extended ? 'Абонемент продлён' : 'Абонемент оформлен';
    const m = user()?.membership;
    return `
      <div class="shop-receipt" aria-live="polite">
        <div class="panel shop-receipt__card">
          <span class="shop-receipt__stamp">${headline}</span>
          <h3 class="acc-h3">Заказ № ${escapeHtml(order.id.slice(0, 8))}…</h3>
          <p class="shop-checkout__amount"><span>Сумма</span><b>${formatPrice(order.price)}</b></p>
          <dl class="receipt-list">
            <div><dt>Чек</dt><dd>${escapeHtml(receipt.receiptId)}</dd></div>
            <div><dt>Оплачено</dt><dd>${new Date(receipt.paidAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</dd></div>
            <div><dt>Способ</dt><dd>${receipt.last4 ? `•••• ${escapeHtml(receipt.last4)} · ` : ''}${escapeHtml(receipt.brand ?? 'Kaspi')}</dd></div>
            <div><dt>Код заказа</dt><dd>${escapeHtml(order.payCode ?? '—')}</dd></div>
          </dl>
          ${m ? `<p class="note">${escapeHtml(m.title.split(' · ').slice(1).join(' · ') || m.title)} · осталось ${m.visitsTotal == null ? 'безлимит' : `${m.status.visitsLeft} ${plural(m.status.visitsLeft, ['посещение', 'посещения', 'посещений'])}`}${m.endsAt ? `, действует до ${new Date(`${m.endsAt}T00:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}` : ''}</p>` : ''}
          <div class="acc-actions">
            <a class="btn primary" href="/account/schedule" data-goto-init="tab-schedule">Записаться на занятие</a>
            <button class="btn outline" type="button" data-shop-back>В каталог</button>
          </div>
        </div>
      </div>`;
  }

  // ---------- рендер и события ----------

  function render() {
    stopPolling();
    if (state === 'loading') {
      root.innerHTML = `
        <div class="shop-root__load" role="status">
          <span class="spinner" aria-hidden="true"></span> Загружаем каталог…
        </div>`;
      return;
    }

    if (state === 'confirm' && confirmPlan) {
      root.innerHTML = confirmHtml(confirmPlan);
      bindConfirm();
      return;
    }

    if (state === 'checkout' && activeOrder) {
      root.innerHTML = checkoutHtml(activeOrder);
      bindCheckout();
      return;
    }

    if (state === 'receipt' && activeOrder?.receipt) {
      root.innerHTML = receiptHtml(activeOrder);
      $$('[data-shop-back]', root).forEach((b) => b.addEventListener('click', backToCatalog));
      $$('[data-goto-init]', root).forEach((a) => a.addEventListener('click', (event) => {
        event.preventDefault();
        goto('schedule');
      }));
      return;
    }

    root.innerHTML = catalogHtml();
    $$('[data-buy]', root).forEach((btn) => btn.addEventListener('click', () => {
      cart.add(`plan:${btn.dataset.buy}`);
      location.href = '/checkout';
    }));
    $$('[data-pay-order]', root).forEach((btn) => btn.addEventListener('click', () => openOrderCheckout(btn.dataset.payOrder)));
  }

  function bindCheckout() {
    $$('[data-shop-back]', root).forEach((b) => b.addEventListener('click', backToCatalog));
    bindCopyButtons(root);

    $('[data-shop-cancel]', root)?.addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      try { await shopApi.cancelOrder(activeOrder.id); } catch { /* закрыт — перечитаем */ }
      activeOrder = null;
      await load();
    });

    $('[data-kaspi-claim]', root)?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const status = $('[data-kaspi-status]', root);
      button.disabled = true;
      status.textContent = 'Отправляем…';
      try {
        const { order } = await shopApi.claimKaspi(activeOrder.id);
        activeOrder = { ...activeOrder, ...order };
        if (order.status === 'paid') { await settle(order); return; }
        render();
      } catch (error) {
        status.textContent = error.status === 401 ? 'Сеанс завершён — войдите снова.' : error.message;
        button.disabled = false;
      }
    });

    // Ждём, пока администратор подтвердит перевод — чек откроется сам.
    if (activeOrder?.status === 'pending' && activeOrder.kaspi?.claimedAt) {
      stopPolling = pollUntilSettled(async () => (await shopApi.order(activeOrder.id)).order, settle);
    }
  }

  /** Заказ закрыт администратором: оплачен — чек, отклонён — история заказов. */
  async function settle(order) {
    activeOrder = { ...activeOrder, ...order };
    if (order.status !== 'paid') { await load(); showNote(order.kaspi?.rejectReason ?? 'Заказ закрыт'); return; }
    const previous = getUser()?.membership?.planId ?? null;
    await refreshUser();
    lastResult = { extended: previous === order.planId && currentActive() };
    orders = (await shopApi.orders()).items;
    state = 'receipt';
    render();
  }

  function backToCatalog() {
    state = 'catalog';
    activeOrder = null;
    render();
  }

  function showCheckout(order) {
    activeOrder = order;
    state = 'checkout';
    render();
    requestAnimationFrame(() => $('[data-kaspi-claim]', root)?.focus({ preventScroll: true }));
  }

  /** Вывод ошибки поверх каталога (карточки остаются на месте). */
  function showNote(message) {
    const note = document.createElement('p');
    note.className = 'shop-err';
    note.setAttribute('role', 'alert');
    note.textContent = message;
    root.prepend(note);
    setTimeout(() => note.remove(), 8000);
  }

  /** Клик по тарифу каталога: сначала согласие с офертой, заказ создаётся после него. */
  function openPlanCheckout(btn) {
    const plan = plans.find((p) => p.id === btn.dataset.buy);
    if (!plan) return;
    confirmPlan = plan;
    state = 'confirm';
    render();
    requestAnimationFrame(() => $('#confirmForm input[name="consent"]', root)?.focus({ preventScroll: true }));
  }

  /** Клик «Оплатить» у pending-заказа в истории заказов. */
  async function openOrderCheckout(orderId) {
    try {
      const { order } = await shopApi.order(orderId);
      if (order.status !== 'pending') { await load(); return; }
      showCheckout(order);
    } catch {
      await load();
      showNote('Заказ недоступен — вероятно, уже закрыт. Откройте историю заново.');
    }
  }

  let inflight = null; // идущая загрузка каталога — дублирующие вызовы ждут её
  let loaded = false;

  /** Каталог + история заказов. Пока один запрос в пути, повторные получают его же промис. */
  function load() {
    if (inflight) return inflight;
    state = 'loading';
    render();
    inflight = shopApi.orders()
      .then(({ items, catalog, payment: info }) => {
        if (catalog) plans = catalog;
        payment = info ?? null;
        orders = items;
        if (!plans.length) throw new Error('catalog empty');
        loaded = true;
        state = 'catalog';
        render();
        return plans;
      })
      .catch((error) => {
        loaded = false;
        const text = error.status === 401
          ? '<p>Сеанс завершён — войдите снова, каталог откроется после входа.</p>'
          : '<p>Каталог недоступен — попробуйте ещё раз. Если не помогло, позвоните на ресепшен: <a href="tel:+77152336141">+7 7152 33-61-41</a>.</p>';
        root.innerHTML = `
          <div class="panel shop-fail" role="status">
            ${text}
            <button class="btn outline" type="button" data-shop-retry>Повторить</button>
          </div>`;
        $('[data-shop-retry]', root).addEventListener('click', load);
      })
      .finally(() => { inflight = null; });
    return inflight;
  }

  /** Загружает каталог при первом открытии вкладки, дальше он уже на месте. */
  function ensure() { return loaded ? undefined : load(); }

  /** Сброс при выходе из аккаунта: следующему пользователю — новые данные. */
  function reset() {
    stopPolling();
    state = 'catalog';
    plans = [];
    orders = [];
    activeOrder = null;
    lastResult = null;
    loaded = false;
    inflight = null;
    root.innerHTML = '';
  }

  // Переключатель тарифа из других вкладок (кнопка «Продлить» на карте абонемента).
  document.addEventListener('neptun:shop-open', (event) => {
    load().then(() => {
      const planId = event.detail?.planId;
      if (!planId || state !== 'catalog') return;
      const card = $(`[data-buy="${CSS.escape(planId)}"]`, root);
      if (card) {
        card.scrollIntoView({ block: 'nearest' });
        card.focus({ preventScroll: true });
      }
    });
  });

  return { load, ensure, reset, reload: load };
}
