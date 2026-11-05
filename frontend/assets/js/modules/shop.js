/**
 * Магазин кабинета: каталог тарифов, покупка и продление абонементов, чеки.
 *
 * Состояния: каталог → чекаут (карта) → чек/ошибка. Каталог приходит от
 * сервера вместе со списком заказов (GET /api/orders) — цены только из
 * каталога, с фронта их никто не подменит. Оплата уходит с Idempotency-Key
 * (api.js), повтор сети не списывает дважды.
 *
 * Данные карты не сохраняются — сервер возвращает только последние четыре
 * цифры. Форма предупреждает об этом честно, без мелкого шрифта.
 */

import { shopApi, accountApi } from '../services/api.js?v=2';
import { formatCardNumber, normalizeCardNumber, validateCard } from '../utils/card.js';
import { escapeHtml, formatPrice, plural } from '../utils/format.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const CATEGORY_LABEL = { pool: 'Бассейн', fitness: 'Фитнес-клуб' };
const STATUS_LABEL = { pending: 'Ожидает оплаты', paid: 'Оплачен', cancelled: 'Отменён', expired: 'Истёк' };

/**
 * Подключает магазин. Родительский account.js даёт:
 *  - root — контейнер панели;
 *  - getUser()/refreshUser() — доступ к текущему пользователю и обновлению;
 *  - goto(tab, planId?) — переключение вкладок, planId выбирает тариф.
 */
export function initShop({ root, getUser, refreshUser, goto }) {
  let state = 'loading'; // catalog | checkout | receipt
  let plans = [];
  let orders = [];
  let activeOrder = null;
  let lastResult = null; // { extended } после оплаты

  const user = getUser;
  const currentPlanId = () => getUser()?.membership?.planId ?? null;
  const currentActive = () => {
    const m = getUser()?.membership;
    return Boolean(m && (m.status.code === 'active' || m.status.code === 'scheduled'));
  };

  // ---------- helpers ----------

  const planTitle = (p) => p.title.split(' · ').slice(1).join(' · ');
  const planMeta = (p) => {
    if (p.visitsTotal == null) return p.durationMonths ? `${p.durationMonths} ${plural(p.durationMonths, ['месяц', 'месяца', 'месяцев'])} · безлимит` : 'безлимит';
    const visits = `${p.visitsTotal} ${plural(p.visitsTotal, ['посещение', 'посещения', 'посещений'])}`;
    return p.durationMonths ? `${visits}, ${p.durationMonths} ${plural(p.durationMonths, ['месяц', 'месяца', 'месяцев'])}` : visits;
  };
  const perVisit = (p) => (p.visitsTotal ? `${formatPrice(Math.ceil(p.price / p.visitsTotal))} за посещение` : null);

  /** Список планов своей категории (для продления) и всех остальных. */  function grouped() {
    const mine = user()?.membership?.category ?? null;
    const groups = { pool: [], fitness: [] };
    for (const p of plans) groups[p.category]?.push(p);
    // сначала та категория, где абонемент пользователя (или бассейн)
    const first = mine && groups[mine] ? mine : 'pool';
    const order = Object.keys(groups).sort((a, b) => (a === first ? -1 : b === first ? 1 : 0));
    return order.map((k) => ({ key: k, label: CATEGORY_LABEL[k] ?? k, plans: groups[k] }));
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
            <span class="shop-plan__cat">${escapeHtml(CATEGORY_LABEL[p.category] ?? p.category)}</span>
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
            <li>Оплата помечена ключом идемпотентности: при сбое сети списание не задвоится.</li>
            <li>Номер карты, срок и CVC остаются между вами и банком — у нас их нет.</li>
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
                ${o.status === 'pending' ? `<button class="btn outline" type="button" data-pay-order="${escapeHtml(o.id)}">Оплатить</button>` : ''}
                ${o.receipt ? `<small class="note">чек <b>${escapeHtml(o.receipt.receiptId)}</b> · подпись ${o.receipt.valid ? 'верна' : 'не подтверждена'}</small>` : ''}
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
          ${phoneMissing ? `<p class="note">Телефон в профиле не указан — администрация не сможет связаться с вами по вопросу заказа. <a href="#profile" data-goto="tab-profile" data-edit="1">Заполнить телефон</a>.</p>` : ''}
          <form id="payForm" class="acc-form" novalidate>
            <div class="field">
              <label for="pay-number">Номер карты</label>
              <input id="pay-number" name="number" type="text" inputmode="numeric" autocomplete="cc-number" spellcheck="false" placeholder="0000 0000 0000 0000" maxlength="19" required>
              <span class="field__error" data-error="number"></span>
            </div>
            <div class="field">
              <label for="pay-exp">Срок действия</label>
              <input id="pay-exp" name="exp" type="text" inputmode="numeric" autocomplete="cc-exp" spellcheck="false" placeholder="ММ/ГГ" maxlength="5" required>
              <span class="field__error" data-error="exp"></span>
            </div>
            <div class="field">
              <label for="pay-cvc">CVC</label>
              <input id="pay-cvc" name="cvc" type="password" inputmode="numeric" autocomplete="cc-csc" placeholder="•••" maxlength="3" required>
              <span class="field__error" data-error="cvc"></span>
            </div>
            <div class="field">
              <label for="pay-holder">Имя на карте (латиницей)</label>
              <input id="pay-holder" name="holder" type="text" autocomplete="cc-name" spellcheck="false" maxlength="60" required>
              <span class="field__error" data-error="holder"></span>
            </div>
            <p class="acc-status" data-status role="alert"></p>
            <div class="acc-actions">
              <button class="btn primary" type="submit">Оплатить ${formatPrice(order.price)}</button>
              <button class="btn outline" type="button" data-shop-back>Отмена</button>
            </div>
          </form>
          <p class="shop-checkout__note">
            Демо-платёж: деньги не списываются. Любая настоящая карта проходит; № …0002 отклоняется банком, № …9995 — «недостаточно средств».
            На платёжном контуре шлюз (Kaspi Pay / bePaid) встраивается одним колбэком: маршруты уже готовы. Данные карты остаются только у банка.
          </p>
        </div>
      </div>`;
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
            <div><dt>Карта</dt><dd>•••• ${escapeHtml(receipt.last4)} · ${escapeHtml(receipt.brand ?? 'карта')}</dd></div>
            <div><dt>Подпись</dt><dd>${receipt.valid ? 'верна' : 'не подтверждена'}</dd></div>
          </dl>
          ${m ? `<p class="note">${escapeHtml(m.title.split(' · ').slice(1).join(' · ') || m.title)} · осталось ${m.visitsTotal == null ? 'безлимит' : `${m.status.visitsLeft} ${plural(m.status.visitsLeft, ['посещение', 'посещения', 'посещений'])}`}${m.endsAt ? `, действует до ${new Date(`${m.endsAt}T00:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}` : ''}</p>` : ''}
          <div class="acc-actions">
            <a class="btn primary" href="#schedule" data-goto-init="tab-schedule">Записаться на занятие</a>
            <button class="btn outline" type="button" data-shop-back>В каталог</button>
          </div>
        </div>
      </div>`;
  }

  // ---------- рендер и события ----------

  function render() {
    if (state === 'loading') {
      root.innerHTML = `
        <div class="shop-root__load" role="status">
          <span class="spinner" aria-hidden="true"></span> Загружаем каталог…
        </div>`;
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
    $$('[data-buy]', root).forEach((btn) => btn.addEventListener('click', () => openPlanCheckout(btn)));
    $$('[data-pay-order]', root).forEach((btn) => btn.addEventListener('click', () => openOrderCheckout(btn.dataset.payOrder)));
  }

  function bindCheckout() {
    const form = $('#payForm', root);
    if (!form) return;
    $('#pay-number', form).addEventListener('input', (e) => {
      e.target.value = formatCardNumber(e.target.value);
    });
    $('#pay-exp', form).addEventListener('input', (e) => {
      const digits = e.target.value.replace(/[^\d]/g, '').slice(0, 4);
      e.target.value = digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
    });
    $('#pay-cvc', form).addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/[^\d]/g, '').slice(0, 3);
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const card = {
        number: normalizeCardNumber(form.elements.number.value),
        exp: form.elements.exp.value.trim(),
        cvc: form.elements.cvc.value.trim(),
        holder: form.elements.holder.value.trim(),
      };
      // Сначала локальная проверка — мгновенная подсказка, без запросов к серверу
      const local = validateCard(card);
      if (!local.ok) {
        $$('.field__error', form).forEach((el) => { el.textContent = local.errors[el.dataset.error] ?? ''; });
        form.querySelector('.field__error:not(:empty)')?.closest('.field')?.querySelector('input')?.focus();
        return;
      }
      const button = $('button[type="submit"]', form);
      const status = $('[data-status]', form);
      button.disabled = true;
      status.textContent = 'Проводим платёж…';
      try {
        const result = await shopApi.payOrder(activeOrder.id, card);
        lastResult = result.membership ? { extended: result.membership.extended } : null;
        activeOrder = { ...activeOrder, ...result.order };
        await refreshUser();
        const ordersData = await shopApi.orders();
        orders = ordersData.items;
        state = 'receipt';
        render();
      } catch (error) {
        status.textContent = '';
        if (error.status === 422 && error.body?.errors) {
          $$('.field__error', form).forEach((el) => { el.textContent = error.body.errors[el.dataset.error] ?? ''; });
        } else if (error.status === 402) {
          status.textContent = error.message;
          button.disabled = false; // другая карта может пройти
          const numberInput = $('#pay-number', form);
          numberInput.value = '';
          numberInput.focus();
          form.elements.cvc.value = '';
        } else if (error.status === 401 && user()) {
          status.textContent = 'Сеанс завершён — войдите снова.';
        } else {
          status.textContent = error.message;
          button.disabled = false; // повторная попытка возможна
        }
      }
    });

    $$('[data-shop-back]', form).forEach((b) => b.addEventListener('click', backToCatalog));
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
    requestAnimationFrame(() => $('#pay-number', root)?.focus());
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

  /**
   * Клик по тарифу каталога: создаём заказ на сервере (цена только из
   * каталога) и открываем оплату. Повторный клик заблокирован — один клик
   * = один заказ.
   */
  async function openPlanCheckout(btn) {
    const planId = btn.dataset.buy;
    if (!planId || btn.disabled) return;
    btn.disabled = true;
    try {
      const { order } = await shopApi.createOrder(planId);
      if (order.status !== 'pending') { await load(); return; }
      showCheckout(order);
    } catch (error) {
      if (error.status === 422) { await load(); return; } // тариф обновился — перечитаем каталог
      await load();
      showNote(error.message);
    }
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
      .then(({ items, catalog }) => {
        if (catalog) plans = catalog;
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
