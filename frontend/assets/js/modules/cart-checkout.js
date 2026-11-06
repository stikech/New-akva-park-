/**
 * Оплата корзины одним платежом — модальное окно: контакт → карта → чек.
 *
 * Фронт отправляет только состав корзины ({ id, qty }); сумму и чек формирует
 * сервер (POST /api/cart-orders, затем /pay). После успешной оплаты корзина
 * очищается. Покупка без входа в кабинет; вошедшему подставляем почту и имя.
 * Сценарии карт демо-шлюза: № …0002 отклоняется банком, № …9995 — «недостаточно средств».
 */

import { cartApi, accountApi } from '../services/api.js?v=3';
import { formatCardNumber, normalizeCardNumber, validateCard } from '../utils/card.js';
import { escapeHtml, formatPrice } from '../utils/format.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const qtyText = (l) => `${l.qty} ${l.unit === 'min' ? 'мин' : 'шт.'}`;

export function initCartCheckout({ modal, cart }) {
  if (!modal || !cart) return null;
  const card = $('.visit-modal__card', modal);
  let order = null; // pending-заказ с сервера: сумма и номер — отсюда
  let snapshot = null; // состав корзины на момент открытия окна
  let opener = null;
  let prefill; // undefined — кабинет ещё не спрашивали

  // ---------- разметка ----------

  function linesHtml(lines) {
    return `
      <ul class="vc-lines">
        ${lines.map((l) => `
          <li><span>${escapeHtml(l.title)} <small>× ${escapeHtml(qtyText(l))}</small></span><b>${formatPrice(l.sum)}</b></li>`).join('')}
      </ul>`;
  }

  function formHtml() {
    const pref = prefill ?? {};
    return `
      <div class="vc-head">
        <h2 class="vc-title" id="cartModalTitle">Оплата корзины</h2>
        <button class="vc-close" type="button" data-modal-close aria-label="Закрыть">×</button>
      </div>
      ${linesHtml(snapshot.lines)}
      <form id="cartForm" class="acc-form" novalidate>
        <div class="field">
          <label for="cc-email">Почта для чека</label>
          <input id="cc-email" name="email" type="email" inputmode="email" autocomplete="email"
            value="${escapeHtml(pref.email ?? '')}" placeholder="name@mail.kz" maxlength="120" required>
          <span class="field__error" data-error="email"></span>
        </div>
        <div class="vc-cols">
          <div class="field">
            <label for="cc-name">Имя <small>— для ресепшена</small></label>
            <input id="cc-name" name="firstName" type="text" autocomplete="given-name" value="${escapeHtml(pref.firstName ?? '')}" maxlength="60">
            <span class="field__error" data-error="firstName"></span>
          </div>
          <div class="field">
            <label for="cc-phone">Телефон <small>— по желанию</small></label>
            <input id="cc-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 7__ ___-__-__" maxlength="24">
            <span class="field__error" data-error="phone"></span>
          </div>
        </div>
        <label class="vc-consent">
          <input name="consent" type="checkbox" required>
          <span>Согласен(на) с <a href="/rules" target="_blank" rel="noopener">правилами комплекса</a> и оплатой заказа</span>
        </label>
        <span class="field__error" data-error="consent"></span>

        <div class="field">
          <label for="cc-number">Номер карты</label>
          <input id="cc-number" name="number" type="text" inputmode="numeric" autocomplete="cc-number" spellcheck="false" placeholder="0000 0000 0000 0000" maxlength="19" required>
          <span class="field__error" data-error="number"></span>
        </div>
        <div class="vc-cols">
          <div class="field">
            <label for="cc-exp">Срок действия</label>
            <input id="cc-exp" name="exp" type="text" inputmode="numeric" autocomplete="cc-exp" spellcheck="false" placeholder="ММ/ГГ" maxlength="5" required>
            <span class="field__error" data-error="exp"></span>
          </div>
          <div class="field">
            <label for="cc-cvc">CVC</label>
            <input id="cc-cvc" name="cvc" type="password" inputmode="numeric" autocomplete="cc-csc" placeholder="•••" maxlength="3" required>
            <span class="field__error" data-error="cvc"></span>
          </div>
        </div>
        <div class="field">
          <label for="cc-holder">Имя на карте (латиницей)</label>
          <input id="cc-holder" name="holder" type="text" autocomplete="cc-name" spellcheck="false" maxlength="60" required>
          <span class="field__error" data-error="holder"></span>
        </div>

        <p class="acc-status" data-status role="alert"></p>
        <div class="vc-amount"><span>К оплате</span><b data-amount>${formatPrice(snapshot.total)}</b></div>
        <button class="btn primary btn--block" type="submit">Оплатить ${formatPrice(snapshot.total)}</button>
        <p class="note vc-note">Окончательную сумму считает сервер по прайсу. Демо-платёж: деньги не списываются;
        № …0002 отклоняется «банком», № …9995 — «недостаточно средств». Данные карты остаются только у банка.</p>
      </form>`;
  }

  function receiptHtml() {
    const { receipt } = order;
    return `
      <div class="vc-head">
        <h2 class="vc-title" id="cartModalTitle">Заказ оплачен</h2>
        <button class="vc-close" type="button" data-modal-close aria-label="Закрыть">×</button>
      </div>
      ${linesHtml(order.items)}
      <dl class="vc-list">
        <div><dt>Заказ</dt><dd>№ ${escapeHtml(order.id.slice(0, 8))}</dd></div>
        <div><dt>Сумма</dt><dd>${formatPrice(order.total)}</dd></div>
        <div><dt>Чек</dt><dd>${escapeHtml(receipt.receiptId)}</dd></div>
        <div><dt>Оплачено</dt><dd>${new Date(receipt.paidAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</dd></div>
        <div><dt>Карта</dt><dd>•••• ${escapeHtml(receipt.last4)} · ${escapeHtml(receipt.brand ?? 'карта')}</dd></div>
        <div><dt>Подпись</dt><dd>${receipt.valid ? 'верна' : 'не подтверждена'}</dd></div>
      </dl>
      <p class="note">Назовите номер заказа на ресепшене — вам выдадут браслеты, абонементы и запишут на SPA-процедуры.</p>
      <div class="vc-actions">
        <button class="btn primary btn--block" type="button" data-modal-done>Готово</button>
      </div>`;
  }

  // ---------- события ----------

  function bind() {
    $$('[data-modal-close]', modal).forEach((el) => el.addEventListener('click', close));
    $('[data-modal-done]', card)?.addEventListener('click', close);

    const form = $('#cartForm', card);
    if (!form) return;
    $('#cc-number', form).addEventListener('input', (e) => { e.target.value = formatCardNumber(e.target.value); });
    $('#cc-exp', form).addEventListener('input', (e) => {
      const digits = e.target.value.replace(/[^\d]/g, '').slice(0, 4);
      e.target.value = digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
    });
    $('#cc-cvc', form).addEventListener('input', (e) => { e.target.value = e.target.value.replace(/[^\d]/g, '').slice(0, 3); });
    form.addEventListener('submit', (event) => { event.preventDefault(); submit(form); });
  }

  function setErrors(form, errors = {}) {
    $$('.field__error', form).forEach((el) => {
      el.textContent = errors[el.dataset.error] ?? '';
      form.elements[el.dataset.error]?.setAttribute('aria-invalid', String(Boolean(errors[el.dataset.error])));
    });
    return Object.keys(errors).find((f) => form.elements[f]);
  }

  /** Ошибки сервера вида { 'contact.email': … } → поля формы. */
  const serverErrors = (errors) => Object.fromEntries(Object.entries(errors).map(([k, v]) => [k.replace(/^contact\./, ''), v]));

  async function submit(form) {
    const contact = {
      email: form.elements.email.value.trim(),
      firstName: form.elements.firstName.value.trim(),
      phone: form.elements.phone.value.trim() || undefined,
    };
    const cardData = {
      number: normalizeCardNumber(form.elements.number.value),
      exp: form.elements.exp.value.trim(),
      cvc: form.elements.cvc.value.trim(),
      holder: form.elements.holder.value.trim(),
    };

    const errors = {};
    if (!EMAIL_RE.test(contact.email)) errors.email = 'Укажите почту в формате name@mail.kz';
    if (!form.elements.consent.checked) errors.consent = 'Без согласия оплатить заказ нельзя';
    Object.assign(errors, validateCard(cardData).errors ?? {});
    const first = setErrors(form, errors);
    if (first) { form.elements[first].focus(); return; }

    const button = $('button[type="submit"]', form);
    const status = $('[data-status]', form);
    button.disabled = true;
    status.textContent = order ? 'Проводим платёж…' : 'Оформляем заказ…';
    try {
      if (!order) {
        const { order: created } = await cartApi.create({
          items: snapshot.lines.map(({ id, qty }) => ({ id, qty })),
          contact,
          consent: true,
        });
        if (created.status !== 'pending') throw new Error('Заказ уже закрыт — откройте корзину заново');
        order = created;
        $('[data-amount]', form).textContent = formatPrice(order.total);
        button.textContent = `Оплатить ${formatPrice(order.total)}`;
        status.textContent = 'Проводим платёж…';
      }
      const { order: paid } = await cartApi.pay(order.id, cardData);
      order = paid;
      cart.clear(); // оплачено — корзина пуста, и после F5 тоже
      card.innerHTML = receiptHtml();
      bind();
      $('[data-modal-done]', card)?.focus();
    } catch (error) {
      status.textContent = error.message;
      if (error.status === 422 && error.body?.errors) {
        const firstField = setErrors(form, serverErrors(error.body.errors));
        status.textContent = error.body.errors.items ?? 'Проверьте поля формы';
        if (firstField) form.elements[firstField]?.focus();
        button.disabled = Boolean(error.body.errors.items); // прайс изменился — сначала обновить страницу
      } else if (error.status === 402) {
        button.disabled = false; // другая карта может пройти; заказ остаётся тем же
        form.elements.number.value = '';
        form.elements.cvc.value = '';
        form.elements.number.focus();
      } else if (error.status === 409) {
        order = null; // заказ закрыт — следующая попытка создаст новый
        button.disabled = false;
      } else {
        button.disabled = false;
      }
    }
  }

  // ---------- открытие и закрытие ----------

  async function open(source) {
    const priced = cart.priced();
    if (!priced.lines.length) return;
    opener = source ?? document.activeElement;
    order = null;
    snapshot = priced;
    modal.hidden = false;
    document.body.classList.add('visit-modal-open');
    card.innerHTML = formHtml();
    bind();
    requestAnimationFrame(() => $('#cc-email', card)?.focus());

    if (prefill === undefined) {
      prefill = null; // кабинет не обязателен — покупка работает и без входа
      try {
        const { authenticated } = await accountApi.session();
        if (authenticated) {
          const { user } = await accountApi.me();
          prefill = { email: user.email, firstName: user.firstName ?? '' };
          const form = $('#cartForm', card);
          if (form && !form.elements.email.value) {
            form.elements.email.value = prefill.email;
            form.elements.firstName.value = prefill.firstName;
          }
        }
      } catch { /* гость — ок */ }
    }
  }

  function close() {
    if (modal.hidden) return;
    modal.hidden = true;
    card.innerHTML = '';
    document.body.classList.remove('visit-modal-open');
    order = null;
    snapshot = null;
    opener?.focus?.();
    opener = null;
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) close();
  });

  return { open, close };
}
