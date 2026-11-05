/**
 * Покупка билетов аквапарка из калькулятора (главная страница) — модальное окно.
 *
 * Калькулятор выбирает состав гостей и отправляет событие `neptun:visit-buy`
 * (detail: { adult, child, day, duration }); этот модуль показывает чекаут:
 * контакт → карта → чек. Цена отображается по каталогу (utils/pricing.js),
 * а финальную сумму считает сервер: фронт передаёт только состав гостей.
 *
 * Покупка без входа в кабинет (visitApi): если пользователь уже вошёл —
 * тихо подставляем его почту и имя. Сценарии карт как у абонементов:
 * № …0002 отклоняется банком, № …9995 — «недостаточно средств».
 */

import { visitApi, accountApi } from '../services/api.js?v=2';
import { formatCardNumber, normalizeCardNumber, validateCard } from '../utils/card.js';
import { escapeHtml, formatPrice, plural } from '../utils/format.js';
import { calcParkTotal } from '../utils/pricing.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const DAY_LABEL = { weekday: 'Будни', weekend: 'Выходные' };
const DURATION_LABEL = { h2: '2 часа', unl: 'Без лимита' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function initVisitCheckout({ modal, park, preload = true }) {
  if (!modal || !park) return null;
  const card = $('.visit-modal__card', modal);
  let state = 'form'; // form | receipt
  let visit = null; // pending-визит с сервера: цена и номер приходят отсюда
  let opener = null; // кнопка «Купить»: вернём ей фокус при закрытии
  let prefill = preload ? undefined : null; // undefined = ещё не спрашивали кабинет

  const guestsText = ({ adult, child }) => [
    `${adult} ${plural(adult, ['взрослый', 'взрослых', 'взрослых'])}`,
    `${child} ${plural(child, ['ребёнок', 'ребёнка', 'детей'])}`,
  ].join(' · ');

  const summaryText = (g) => `${guestsText(g)} · ${DAY_LABEL[g.day]} · ${DURATION_LABEL[g.duration]}`;

  // ---------- разметка ----------

  function contactFields(pref = {}) {
    return `
      <div class="field">
        <label for="vc-email">Почта для чека</label>
        <input id="vc-email" name="email" type="email" inputmode="email" autocomplete="email"
          value="${escapeHtml(pref.email ?? '')}" placeholder="name@mail.kz" maxlength="120" required>
        <span class="field__error" data-error="email"></span>
      </div>
      <div class="vc-cols">
        <div class="field">
          <label for="vc-name">Имя <small>— для ресепшена</small></label>
          <input id="vc-name" name="firstName" type="text" autocomplete="given-name"
            value="${escapeHtml(pref.firstName ?? '')}" maxlength="60">
          <span class="field__error" data-error="firstName"></span>
        </div>
        <div class="field">
          <label for="vc-phone">Телефон <small>— по желанию</small></label>
          <input id="vc-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel"
            value="${escapeHtml(pref.phone ?? '')}" placeholder="+7 7__ ___-__-__" maxlength="24">
          <span class="field__error" data-error="phone"></span>
        </div>
      </div>
      <label class="vc-consent">
        <input name="consent" type="checkbox" required>
        <span>Согласен(на) с <a href="/#rules" target="_blank" rel="noopener">правилами аквапарка</a> и оплатой визита</span>
      </label>
      <span class="field__error" data-error="consent"></span>`;
  }

  function cardFields() {
    return `
      <div class="field">
        <label for="vc-number">Номер карты</label>
        <input id="vc-number" name="number" type="text" inputmode="numeric" autocomplete="cc-number"
          spellcheck="false" placeholder="0000 0000 0000 0000" maxlength="19" required>
        <span class="field__error" data-error="number"></span>
      </div>
      <div class="vc-cols">
        <div class="field">
          <label for="vc-exp">Срок действия</label>
          <input id="vc-exp" name="exp" type="text" inputmode="numeric" autocomplete="cc-exp"
            spellcheck="false" placeholder="ММ/ГГ" maxlength="5" required>
          <span class="field__error" data-error="exp"></span>
        </div>
        <div class="field">
          <label for="vc-cvc">CVC</label>
          <input id="vc-cvc" name="cvc" type="password" inputmode="numeric" autocomplete="cc-csc"
            placeholder="•••" maxlength="3" required>
          <span class="field__error" data-error="cvc"></span>
        </div>
      </div>
      <div class="field">
        <label for="vc-holder">Имя на карте (латиницей)</label>
        <input id="vc-holder" name="holder" type="text" autocomplete="cc-name" spellcheck="false" maxlength="60" required>
        <span class="field__error" data-error="holder"></span>
      </div>`;
  }

  function formHtml(guests) {
    const preview = calcParkTotal(park, guests);
    return `
      <div class="vc-head">
        <h2 class="vc-title" id="visitModalTitle">Билеты в аквапарк</h2>
        <button class="vc-close" type="button" data-visit-close aria-label="Закрыть">×</button>
      </div>
      <p class="vc-summary"><b>${escapeHtml(summaryText(guests))}</b></p>
      <form id="visitForm" class="acc-form" novalidate>
        ${contactFields(prefill ?? {})}
        ${cardFields()}
        <p class="acc-status" data-status role="alert"></p>
        <div class="vc-amount"><span>К оплате</span><b data-amount>${formatPrice(preview)}</b></div>
        <button class="btn primary btn--block" type="submit">Оплатить ${formatPrice(preview)}</button>
        <p class="note vc-note">Окончательную сумму считает сервер по каталогу цен. Демо-платёж: деньги не списываются;
        № …0002 отклоняется «банком», № …9995 — «недостаточно средств». Данные карты остаются только у банка.</p>
      </form>`;
  }

  function receiptHtml(guests) {
    const { receipt } = visit;
    return `
      <div class="vc-head">
        <h2 class="vc-title" id="visitModalTitle" data-i18n-skip>Билеты оплачены</h2>
        <button class="vc-close" type="button" data-visit-close aria-label="Закрыть">×</button>
      </div>
      <p class="vc-summary"><b>${escapeHtml(summaryText(guests))}</b></p>
      <dl class="vc-list">
        <div><dt>К оплате на входе</dt><dd>заказ № ${escapeHtml(visit.id.slice(0, 8))}…</dd></div>
        <div><dt>Чек</dt><dd>${escapeHtml(receipt.receiptId)}</dd></div>
        <div><dt>Оплачено</dt><dd>${new Date(receipt.paidAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</dd></div>
        <div><dt>Карта</dt><dd>•••• ${escapeHtml(receipt.last4)} · ${escapeHtml(receipt.brand ?? 'карта')}</dd></div>
        <div><dt>Подпись</dt><dd>${receipt.valid ? 'верна' : 'не подтверждена'}</dd></div>
      </dl>
      <p class="note">Покажите номер заказа на входе — администратор выдаст браслеты. Сумма визита: ${formatPrice(visit.price)}.</p>
      <div class="vc-actions">
        <button class="btn primary btn--block" type="button" data-visit-done>Готово</button>
      </div>`;
  }

  // ---------- рендер и события ----------

  function render(guests) {
    card.innerHTML = state === 'receipt' && visit?.receipt ? receiptHtml(guests) : formHtml(guests);
    bindForm(guests);
  }

  function bindForm(guests) {
    $$('[data-visit-close]', modal).forEach((el) => el.addEventListener('click', close));
    $('[data-visit-done]', modal)?.addEventListener('click', close);

    const form = $('#visitForm', card);
    if (!form) return;
    $('#vc-number', form).addEventListener('input', (e) => { e.target.value = formatCardNumber(e.target.value); });
    $('#vc-exp', form).addEventListener('input', (e) => {
      const digits = e.target.value.replace(/[^\d]/g, '').slice(0, 4);
      e.target.value = digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
    });
    $('#vc-cvc', form).addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/[^\d]/g, '').slice(0, 3);
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      await submit(form, guests);
    });
  }

  function setErrors(form, errors = {}) {
    $$('.field__error', form).forEach((el) => {
      el.textContent = errors[el.dataset.error] ?? '';
      form.elements[el.dataset.error]?.setAttribute('aria-invalid', String(Boolean(errors[el.dataset.error])));
    });
    return Object.keys(errors).find((f) => form.elements[f]);
  }

  async function submit(form, guests) {
    const contact = {
      email: form.elements.email.value.trim(),
      firstName: form.elements.firstName.value.trim(),
      phone: form.elements.phone.value.trim() || undefined,
    };
    const payload = {
      adults: guests.adult,
      children: guests.child,
      day: guests.day,
      duration: guests.duration,
      contact,
      consent: form.elements.consent.checked,
    };
    const cardData = {
      number: normalizeCardNumber(form.elements.number.value),
      exp: form.elements.exp.value.trim(),
      cvc: form.elements.cvc.value.trim(),
      holder: form.elements.holder.value.trim(),
    };

    // Сначала локальная проверка — мгновенная подсказка без запросов
    const errors = {};
    if (!EMAIL_RE.test(contact.email)) errors.email = 'Укажите почту в формате name@mail.kz';
    if (!payload.consent) errors.consent = 'Без согласия купить билеты нельзя';
    const localCard = validateCard(cardData);
    Object.assign(errors, localCard.errors ?? {});
    if (setErrors(form, errors)) {
      form.elements[Object.keys(errors)[0]].focus();
      return;
    }

    const button = $('button[type="submit"]', form);
    const status = $('[data-status]', form);
    button.disabled = true;
    status.textContent = visit ? 'Проводим платёж…' : 'Оформляем визит…';
    try {
      if (!visit) {
        const { visit: created } = await visitApi.create(payload);
        if (created.status !== 'pending') throw new Error('Визит уже закрыт — откройте калькулятор заново');
        visit = created;
        $('[data-amount]', form).textContent = formatPrice(visit.price);
        button.textContent = `Оплатить ${formatPrice(visit.price)}`;
        status.textContent = 'Проводим платёж…';
      }
      const { visit: paid, alreadyPaid } = await visitApi.pay(visit.id, cardData);
      visit = paid;
      state = 'receipt';
      render(guests);
      if (alreadyPaid) return;
      $('[data-visit-done]', card)?.focus();
    } catch (error) {
      status.textContent = '';
      if (!visit) { button.disabled = false; status.textContent = error.message; return; }
      if (error.status === 422 && error.body?.errors) {
        const first = setErrors(form, error.body.errors);
        status.textContent = 'Проверьте поля формы';
        if (first) form.elements[first]?.focus();
      } else if (error.status === 402) {
        status.textContent = error.message;
        button.disabled = false; // другая карта может пройти
        const numberInput = $('#vc-number', form);
        numberInput.value = '';
        numberInput.focus();
        form.elements.cvc.value = '';
        // визит остаётся pending — оплата повторяется тем же заказом, без второго списка
      } else if (error.status === 409) {
        status.textContent = error.message;
        visit = null;
      } else {
        status.textContent = error.message;
        button.disabled = false; // повторная попытка возможна
      }
    }
  }

  // ---------- открытие и закрытие ----------

  async function open(guests, source) {
    opener = source ?? document.activeElement;
    visit = null;
    state = 'form';
    modal.hidden = false;
    document.body.classList.add('modal-open');
    if (prefill === undefined) {
      prefill = null; // кабинет не обязан отвечать — покупка работает и без входа
      try {
        // Сначала тихая проверка сессии (всегда 200): только для вошедших дергаем /api/account
        const { authenticated } = await accountApi.session();
        if (authenticated) {
          const { user } = await accountApi.me();
          prefill = { email: user.email, firstName: user.firstName ?? '' };
          // Если пользователь ещё на форме — подставим данные сразу
          if (state === 'form' && !modal.hidden) {
            const form = $('#visitForm', card);
            if (form && !form.elements.email.value) {
              form.elements.email.value = prefill.email;
              form.elements.firstName.value = prefill.firstName;
            }
          }
        }
      } catch { /* гость — ок */ }
    }
    render(guests);
    requestAnimationFrame(() => $('#vc-email', card)?.focus());
  }

  function close() {
    if (modal.hidden) return;
    modal.hidden = true;
    card.innerHTML = '';
    document.body.classList.remove('modal-open');
    visit = null;
    state = 'form';
    opener?.focus?.();
    opener = null;
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || modal.hidden) return;
    close();
  });

  document.addEventListener('neptun:visit-buy', (event) => {
    const guests = {
      adult: event.detail?.adult ?? 2,
      child: event.detail?.child ?? 1,
      day: event.detail?.day ?? 'weekday',
      duration: event.detail?.duration ?? 'unl',
    };
    open(guests, event.detail?.source);
  });

  return { open, close };
}
