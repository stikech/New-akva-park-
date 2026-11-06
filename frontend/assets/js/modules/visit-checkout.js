/**
 * Покупка билетов аквапарка из калькулятора (главная страница) — модальное окно.
 *
 * Калькулятор выбирает состав гостей и отправляет событие `neptun:visit-buy`
 * (detail: { adult, child, day, duration }); этот модуль показывает чекаут:
 * контакт → перевод Kaspi → «Я оплатил» → ожидание → чек. Цена отображается
 * по каталогу (utils/pricing.js), а финальную сумму считает сервер.
 *
 * Покупка без входа в кабинет (visitApi): если пользователь уже вошёл —
 * тихо подставляем его почту и имя. Каждый билет доступен по ссылке
 * /ticket?id=… — подтверждение оплаты приходит не мгновенно.
 */

import { visitApi, accountApi } from '../services/api.js?v=4';
import { escapeHtml, formatPrice, plural } from '../utils/format.js';
import { calcParkTotal } from '../utils/pricing.js';
import { CONSENT_HTML } from '../utils/plans.js';
import { bindCopyButtons, kaspiDisabledHtml, kaspiPayHtml, kaspiWaitingHtml, pollUntilSettled } from './kaspi-pay.js';
import { rememberTicket, ticketUrl } from './ticket-page.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const DAY_LABEL = { weekday: 'Будни', weekend: 'Выходные' };
const DURATION_LABEL = { h2: '2 часа', unl: 'Без лимита' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function initVisitCheckout({ modal, park, preload = true }) {
  if (!modal || !park) return null;
  const card = $('.visit-modal__card', modal);
  let state = 'form'; // form | kaspi | waiting | receipt | closed
  let visit = null; // визит с сервера: цена, код оплаты и статус приходят отсюда
  let payment = null; // реквизиты Kaspi с сервера
  let stopPolling = () => {};
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
        <span>${CONSENT_HTML}</span>
      </label>
      <span class="field__error" data-error="consent"></span>`;
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
        <p class="acc-status" data-status role="alert"></p>
        <div class="vc-amount"><span>К оплате</span><b data-amount>${formatPrice(preview)}</b></div>
        <button class="btn primary btn--block" type="submit">Перейти к оплате</button>
        <p class="note vc-note">Оплата — переводом Kaspi. Окончательную сумму считает сервер по каталогу цен.</p>
      </form>`;
  }

  function headHtml(title) {
    return `
      <div class="vc-head">
        <h2 class="vc-title" id="visitModalTitle">${escapeHtml(title)}</h2>
        <button class="vc-close" type="button" data-visit-close aria-label="Закрыть">×</button>
      </div>`;
  }

  function kaspiHtml(guests) {
    return `
      ${headHtml('Оплата билетов')}
      <p class="vc-summary"><b>${escapeHtml(summaryText(guests))}</b></p>
      ${kaspiPayHtml({ payment, amount: visit.price, code: visit.payCode })}`;
  }

  function waitingHtml(guests) {
    return `
      ${headHtml('Ждём подтверждения')}
      <p class="vc-summary"><b>${escapeHtml(summaryText(guests))}</b> · ${formatPrice(visit.price)}</p>
      ${kaspiWaitingHtml({ code: visit.payCode, statusUrl: ticketUrl(visit.id) })}`;
  }

  function closedHtml(guests) {
    const reason = visit.kaspi?.rejectReason;
    return `
      ${headHtml('Оплата не подтверждена')}
      <p class="vc-summary"><b>${escapeHtml(summaryText(guests))}</b></p>
      <p class="note">${reason ? `${escapeHtml(reason)}. ` : ''}Если вы перевели деньги, позвоните на ресепшен
        <a href="tel:+77152336141">+7 7152 33-61-41</a> и назовите код <b>${escapeHtml(visit.payCode ?? '')}</b>.</p>
      <div class="vc-actions"><button class="btn primary btn--block" type="button" data-visit-done>Закрыть</button></div>`;
  }

  function offHtml(guests) {
    return `
      ${headHtml('Билеты в аквапарк')}
      <p class="vc-summary"><b>${escapeHtml(summaryText(guests))}</b></p>
      ${kaspiDisabledHtml()}
      <div class="vc-actions"><button class="btn primary btn--block" type="button" data-visit-done>Понятно</button></div>`;
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
        <div><dt>Код на входе</dt><dd><b>${escapeHtml(visit.payCode ?? visit.id.slice(0, 8))}</b></dd></div>
        <div><dt>Чек</dt><dd>${escapeHtml(receipt.receiptId)}</dd></div>
        <div><dt>Оплачено</dt><dd>${new Date(receipt.paidAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</dd></div>
        <div><dt>Способ</dt><dd>${receipt.last4 ? `•••• ${escapeHtml(receipt.last4)} · ` : ''}${escapeHtml(receipt.brand ?? 'Kaspi')}</dd></div>
        <div><dt>Сумма</dt><dd>${formatPrice(visit.price)}</dd></div>
      </dl>
      <p class="note">Назовите код на входе — администратор выдаст браслеты. Билет всегда открывается по <a href="${escapeHtml(ticketUrl(visit.id))}">ссылке</a>.</p>
      <div class="vc-actions">
        <button class="btn primary btn--block" type="button" data-visit-done>Готово</button>
      </div>`;
  }

  // ---------- рендер и события ----------

  const VIEWS = { form: formHtml, kaspi: kaspiHtml, waiting: waitingHtml, receipt: receiptHtml, closed: closedHtml, off: offHtml };

  function render(guests) {
    const view = state === 'receipt' && !visit?.receipt ? 'waiting' : state;
    card.innerHTML = VIEWS[view](guests);
    bindForm(guests);
  }

  /** Визит сменил статус (подтверждён или отклонён админом). */
  function settle(fresh, guests) {
    visit = fresh;
    state = fresh.status === 'paid' ? 'receipt' : 'closed';
    if (!modal.hidden) render(guests);
  }

  function startPolling(guests) {
    stopPolling();
    stopPolling = pollUntilSettled(async () => (await visitApi.visit(visit.id)).visit, (fresh) => settle(fresh, guests));
  }

  function bindForm(guests) {
    $$('[data-visit-close]', modal).forEach((el) => el.addEventListener('click', close));
    $('[data-visit-done]', modal)?.addEventListener('click', close);
    bindCopyButtons(card);

    $('[data-kaspi-claim]', card)?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const status = $('[data-kaspi-status]', card);
      button.disabled = true;
      status.textContent = 'Отправляем…';
      try {
        const { visit: claimed } = await visitApi.claimKaspi(visit.id);
        visit = claimed;
        if (claimed.status !== 'pending') { settle(claimed, guests); return; }
        state = 'waiting';
        render(guests);
        startPolling(guests);
      } catch (error) {
        status.textContent = error.message;
        button.disabled = false;
      }
    });

    const form = $('#visitForm', card);
    if (!form) return;

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

    // Сначала локальная проверка — мгновенная подсказка без запросов
    const errors = {};
    if (!EMAIL_RE.test(contact.email)) errors.email = 'Укажите почту в формате name@mail.kz';
    if (!payload.consent) errors.consent = 'Без согласия с условиями оплатить нельзя';
    if (setErrors(form, errors)) {
      form.elements[Object.keys(errors)[0]].focus();
      return;
    }

    const button = $('button[type="submit"]', form);
    const status = $('[data-status]', form);
    button.disabled = true;
    status.textContent = 'Оформляем билеты…';
    try {
      const { visit: created, payment: info } = await visitApi.create(payload);
      if (created.status !== 'pending') throw new Error('Визит уже закрыт — откройте калькулятор заново');
      visit = created;
      payment = info;
      if (!payment?.enabled) { state = 'off'; render(guests); return; }
      rememberTicket(visit.id);
      state = 'kaspi';
      render(guests);
      $('[data-kaspi-claim]', card)?.scrollIntoView({ block: 'nearest' });
    } catch (error) {
      button.disabled = false;
      status.textContent = '';
      if (error.status === 422 && error.body?.errors) {
        const fieldErrors = Object.fromEntries(Object.entries(error.body.errors).map(([k, v]) => [k.replace('contact.', ''), v]));
        const first = setErrors(form, fieldErrors);
        status.textContent = 'Проверьте поля формы';
        if (first) form.elements[first]?.focus();
      } else {
        status.textContent = error.message;
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
    stopPolling();
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
