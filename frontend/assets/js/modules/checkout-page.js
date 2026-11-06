/**
 * Страница /checkout: корзина → контакты и дата визита → оплата → чек.
 *
 * Оплата (что включено — решает сервер, backend/payment.config.js):
 *   card     — форма карты (номер, срок, CVC, имя) с живой проверкой и превью карты.
 *              Карта шифруется скриптом TipTop Pay прямо в браузере — на наш сервер уходит
 *              только криптограмма. Если банк просит 3-D Secure — уходим на его страницу
 *              и возвращаемся сюда же (/checkout?order=…);
 *   transfer — перевод на карту по номеру: реквизиты, код заказа, «Я оплатил», ожидание;
 *   kaspi    — то же по номеру Kaspi;
 *   desk     — онлайн-способов нет: заказ с кодом, оплата на кассе.
 *
 * Заказ создаётся один раз на корзину (Idempotency-Key в sessionStorage), повторная
 * попытка оплаты использует тот же заказ. Последние заказы помнятся в localStorage.
 */

import { accountApi, checkoutApi } from '../services/api.js?v=4';
import { escapeHtml, formatPrice } from '../utils/format.js';
import { cartNeeds } from '../utils/catalog.js?v=1';
import { CONSENT_HTML } from '../utils/plans.js';
import { formatCardNumber, luhnValid, normalizeCardNumber } from '../utils/card.js';
import { cart } from './cart.js?v=1';
import { cartLinesHtml, cartTotal, describe, openCart } from './cart-ui.js?v=1';
import { bindCopyButtons, pollUntilSettled } from './kaspi-pay.js';

const $ = (selector, root = document) => root.querySelector(selector);
const ORDERS_KEY = 'neptun-orders';
/** Плашка «принимаем карты» — у способов оплаты и в корзине. */
export const CARDS_BADGE = `<p class="cards-badge"><span class="cards-badge__logos" aria-hidden="true"><i>VISA</i><i>MC</i><i>Kaspi</i></span>
  Принимаем оплату банковской картой — Visa, Mastercard, Kaspi Gold и карты любых банков Казахстана.</p>`;
const DATE_FMT = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const STATUS = { pending: 'Ожидает оплаты', paid: 'Оплачен', cancelled: 'Отменён', expired: 'Истёк' };
const METHOD = { card: 'картой на сайте', transfer: 'переводом на карту', kaspi: 'переводом Kaspi', desk: 'на кассе' };

const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* приватный режим */ } },
};
function rememberOrder(order) {
  const list = store.get(ORDERS_KEY, []).filter((o) => o.id !== order.id);
  store.set(ORDERS_KEY, [{ id: order.id, code: order.code, total: order.total, at: order.createdAt }, ...list].slice(0, 10));
}

/** Один ключ идемпотентности на одну и ту же корзину. */
function idempotencyKey(lines) {
  const sig = JSON.stringify(lines.map((l) => [l.id, l.qty, l.ref ?? '']));
  try {
    const saved = JSON.parse(sessionStorage.getItem('neptun-checkout-key') ?? 'null');
    if (saved?.sig === sig) return saved.key;
    const key = crypto.randomUUID();
    sessionStorage.setItem('neptun-checkout-key', JSON.stringify({ sig, key }));
    return key;
  } catch {
    return crypto.randomUUID();
  }
}

function isoWeekday(date) {
  return (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7 + 1;
}
function shiftDate(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
function phoneMask(value) {
  const d = value.replace(/\D/g, '').replace(/^8/, '7').slice(0, 11);
  if (!d) return '';
  const p = d.startsWith('7') ? d : `7${d}`;
  const parts = [p.slice(1, 4), p.slice(4, 7), p.slice(7, 9), p.slice(9, 11)];
  return `+7${parts[0] ? ` ${parts[0]}` : ''}${parts[1] ? ` ${parts[1]}` : ''}${parts[2] ? `-${parts[2]}` : ''}${parts[3] ? `-${parts[3]}` : ''}`;
}
function cardBrandOf(digits) {
  if (/^4/.test(digits)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(digits)) return 'mastercard';
  if (/^(220[0-4])/.test(digits)) return 'mir';
  if (/^(62)/.test(digits)) return 'unionpay';
  return '';
}

// ---------- TipTop Pay: шифрование карты в браузере ----------

let scriptPromise = null;
function loadCheckoutScript(url) {
  if (window.tiptop?.Checkout) return Promise.resolve();
  scriptPromise ??= new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement('script'), { src: url, async: true });
    s.onload = () => (window.tiptop?.Checkout ? resolve() : reject(new Error('script')));
    s.onerror = () => { scriptPromise = null; reject(new Error('script')); };
    document.head.append(s);
  });
  return scriptPromise;
}

const CRYPTO_ERRORS = {
  CardNumber_Empty: 'Введите номер карты', CardNumber_Invalid: 'Проверьте номер карты',
  Cvv_Empty: 'Введите CVC', Cvv_Invalid: 'Проверьте CVC',
  ExpDateMonthYear_Empty: 'Введите срок действия', ExpDateMonthYear_Invalid: 'Проверьте срок действия',
  ExpDateMonth_Invalid: 'Проверьте месяц', ExpDateYear_Invalid: 'Проверьте год', Name_Invalid: 'Имя латиницей, как на карте',
};

async function makeCryptogram(card, method) {
  if (method.provider === 'demo') return `demo:${card.number}`;
  await loadCheckoutScript(method.scriptUrl);
  const checkout = new window.tiptop.Checkout({ publicId: method.publicId });
  try {
    return await checkout.createPaymentCryptogram({
      cardNumber: card.number, expDateMonth: card.month, expDateYear: card.year, cvv: card.cvc, name: card.holder,
    });
  } catch (errors) {
    const first = errors && typeof errors === 'object' ? Object.values(errors)[0] : null;
    throw new Error(CRYPTO_ERRORS[first] ?? 'Проверьте данные карты');
  }
}

/** Шаг 3-D Secure: POST-форма на страницу банка (так требует протокол). */
function goTo3ds({ acsUrl, paReq, md, termUrl }) {
  const form = Object.assign(document.createElement('form'), { method: 'POST', action: acsUrl });
  for (const [name, value] of Object.entries({ PaReq: paReq, MD: md, TermUrl: termUrl })) {
    form.append(Object.assign(document.createElement('input'), { type: 'hidden', name, value }));
  }
  document.body.append(form);
  form.submit();
}

// ---------- страница ----------

export function initCheckoutPage(root) {
  const params = new URLSearchParams(location.search);
  let options = null;
  let user = null;
  let stopPolling = () => {};
  let mode = 'form'; // form — корзина и данные; order — оплата и статус заказа

  const lines = () => cart.lines().filter((l) => describe(l));

  async function boot() {
    root.innerHTML = '<div class="co-loading"><span class="spinner" aria-hidden="true"></span> Загружаем…</div>';
    try {
      [options, user] = await Promise.all([
        checkoutApi.options(),
        // session не даёт 401 гостю; полные данные (почта, телефон) — только вошедшему
        accountApi.session().then((d) => (d.authenticated ? accountApi.me().then((m) => m.user) : null)).catch(() => null),
      ]);
    } catch (error) {
      root.innerHTML = `<div class="panel co-error"><b>Сервер не отвечает</b><p>${escapeHtml(error.message)}</p><button class="btn primary" type="button" data-retry>Повторить</button></div>`;
      $('[data-retry]', root).addEventListener('click', boot);
      return;
    }
    if (params.get('order')) return showOrder(params.get('order'));
    renderForm();
    cart.onChange(() => { if (mode === 'form') renderForm(true); });
  }

  // ---------- форма заказа ----------

  /**
   * Способы оплаты. «Банковской картой» есть всегда, когда аквапарк принимает карты:
   * картой на сайте (TipTop Pay) или переводом с карты клиента на карту аквапарка.
   */
  function enabledMethods({ withDisabled = false } = {}) {
    const m = options.methods;
    const list = [];
    if (m.card.enabled) list.push({ id: 'card', title: 'Банковской картой', text: 'Visa, Mastercard, Kaspi Gold — прямо на сайте, 3-D Secure' });
    if (m.transfer.enabled) {
      list.push(m.card.enabled
        ? { id: 'transfer', title: 'Переводом на карту', text: `${m.transfer.bank ? `${m.transfer.bank} · ` : ''}из приложения любого банка` }
        : { id: 'transfer', title: 'Банковской картой', text: `Visa, Mastercard, Kaspi Gold — перевод с вашей карты на карту аквапарка${m.transfer.bank ? ` (${m.transfer.bank})` : ''}` });
    }
    if (m.kaspi.enabled) list.push({ id: 'kaspi', title: 'Переводом Kaspi', text: 'по номеру телефона' });
    if (!list.length) {
      if (withDisabled) list.push({ id: 'card-off', title: 'Банковской картой', text: 'скоро — аквапарк подключает оплату картой', disabled: true });
      list.push({ id: 'desk', title: 'На кассе', text: 'назовите код заказа на кассе аквапарка' });
    }
    return list;
  }

  function renderForm(keepValues = false) {
    mode = 'form';
    const prev = keepValues ? collect() : null;
    const items = lines();
    if (!items.length) {
      root.innerHTML = `
        <div class="panel cart-empty co-empty">
          <p><b>Корзина пуста</b></p>
          <p class="muted">Соберите визит в калькуляторе или добавьте абонементы, SPA и занятия.</p>
          <div class="cart-empty__links">
            <a class="btn primary" href="/prices">Билеты и калькулятор</a>
            <a class="btn ghost" href="/shop">Абонементы</a>
            <a class="btn ghost" href="/classes">Занятия</a>
          </div>
          ${recentOrdersHtml()}
        </div>`;
      return;
    }
    const needs = cartNeeds(items.map((l) => describe(l)));
    const methods = enabledMethods({ withDisabled: true });
    const firstOn = methods.find((m) => !m.disabled)?.id;
    const takesCards = options.methods.card.enabled || options.methods.transfer.enabled;
    const total = cartTotal(items);
    const maxDate = shiftDate(options.today, options.visitDaysAhead);

    root.innerHTML = `
      <div class="co-grid">
        <form class="co-form" novalidate>
          ${needs.account && !user ? `
            <div class="co-alert" data-login-box>
              <b>Абонемент привязывается к личному кабинету — войдите</b>
              <div class="co-cols">
                <div class="field"><label for="coLoginEmail">Почта</label>
                  <input id="coLoginEmail" type="email" autocomplete="username" inputmode="email"></div>
                <div class="field"><label for="coLoginPass">Пароль</label>
                  <input id="coLoginPass" type="password" autocomplete="current-password"></div>
              </div>
              <p class="acc-status" data-kind="error" data-login-status role="alert"></p>
              <div class="co-alert__actions">
                <button class="btn primary" type="button" data-login>Войти</button>
                <a class="btn ghost" href="/account?next=${encodeURIComponent('/checkout')}">Зарегистрироваться</a>
              </div>
            </div>` : user ? `<p class="co-signed">Вы вошли как <b>${escapeHtml(user.firstName ?? user.email)}</b> — абонемент появится в вашем кабинете.</p>` : ''}

          <fieldset class="co-step">
            <legend><span class="co-step__n">1</span> Контакты</legend>
            <div class="co-cols">
              <div class="field"><label for="coName">Имя</label>
                <input id="coName" name="name" autocomplete="name" required maxlength="80">
                <span class="field__error" data-error="contact.name"></span></div>
              <div class="field"><label for="coPhone">Телефон</label>
                <input id="coPhone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 7__ ___-__-__" required>
                <span class="field__error" data-error="contact.phone"></span></div>
            </div>
            <div class="field"><label for="coEmail">Почта <small>— для связи по заказу</small></label>
              <input id="coEmail" name="email" type="email" inputmode="email" autocomplete="email" required maxlength="120">
              <span class="field__error" data-error="contact.email"></span></div>
          </fieldset>

          ${needs.visitDate ? `
            <fieldset class="co-step">
              <legend><span class="co-step__n">2</span> Дата визита в аквапарк</legend>
              <div class="field"><label for="coDate">Когда придёте</label>
                <input id="coDate" name="visitDate" type="date" min="${options.today}" max="${maxDate}" required>
                <span class="co-date-hint" data-date-hint></span>
                <span class="field__error" data-error="visitDate"></span></div>
            </fieldset>` : ''}

          <fieldset class="co-step">
            <legend><span class="co-step__n">${needs.visitDate ? 3 : 2}</span> Оплата</legend>
            <div class="co-methods" role="radiogroup" aria-label="Способ оплаты">
              ${methods.map((m) => `
                <label class="co-method${m.disabled ? ' co-method--off' : ''}">
                  <input type="radio" name="method" value="${m.id}" ${m.id === firstOn ? 'checked' : ''} ${m.disabled ? 'disabled' : ''}>
                  <span class="co-method__icon co-method__icon--${m.id === 'transfer' && !options.methods.card.enabled ? 'card' : m.id}" aria-hidden="true"></span>
                  <span><b>${m.title}</b><small>${escapeHtml(m.text)}</small></span>
                </label>`).join('')}
            </div>
            ${takesCards ? CARDS_BADGE : ''}
            <div data-method-panel></div>
          </fieldset>

          <label class="acc-check co-consent">
            <input name="consent" type="checkbox" required>
            <span>${CONSENT_HTML}</span>
          </label>
          <span class="field__error" data-error="consent"></span>
          <p class="acc-status" data-status role="alert"></p>
          <button class="btn primary btn--block co-pay" type="submit" ${needs.account && !user ? 'disabled' : ''}>
            <span data-pay-label>Оплатить ${formatPrice(total)}</span>
          </button>
          <p class="note co-secure">🔒 Данные карты шифруются в браузере и не хранятся на сайте. Код заказа и чек появятся на этой странице — ссылка на неё сохранится.</p>
        </form>

        <aside class="co-summary panel">
          <div class="co-summary__head"><h2>Ваш заказ</h2><button class="btn ghost co-edit" type="button" data-edit>Изменить</button></div>
          <ul class="cart-lines cart-lines--static">${cartLinesHtml(items, { editable: false })}</ul>
          <div class="cart-total"><span>Итого</span><b>${formatPrice(total)}</b></div>
          <p class="note">Цены по прейскуранту аквапарка. Билеты действуют в выбранную дату, абонемент появится в личном кабинете сразу после оплаты${items.filter((i) => describe(i)?.kind === 'membership').reduce((s, i) => s + i.qty, 0) > 1 ? ' (первый; остальные абонементы выдаются на ресепшене по коду заказа)' : ''}.</p>
        </aside>
      </div>`;

    const form = $('.co-form', root);
    $('[data-login]', form)?.addEventListener('click', () => loginInline(form));
    $('#coLoginPass', form)?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loginInline(form); } });
    // Контакты: из прошлого ввода, из кабинета или из прошлого заказа.
    // пустое поле не перекрывает данные кабинета (после входа на этой странице)
    const stored = store.get('neptun-contact', null) ?? {};
    const pick = (k, fromUser) => prev?.[k] || stored[k] || fromUser || '';
    form.elements.name.value = pick('name', user?.firstName);
    form.elements.phone.value = phoneMask(pick('phone', user?.phone));
    form.elements.email.value = pick('email', user?.email);
    if (form.elements.visitDate) {
      form.elements.visitDate.value = prev?.visitDate ?? '';
      form.elements.visitDate.addEventListener('input', () => dateHint(form));
      dateHint(form);
    }
    form.elements.phone.addEventListener('input', (e) => { e.target.value = phoneMask(e.target.value); });
    $('[data-edit]', root).addEventListener('click', (e) => openCart(e.currentTarget));
    form.querySelectorAll('input[name="method"]').forEach((r) => r.addEventListener('change', () => renderMethod(form)));
    if (prev?.method) form.querySelector(`input[name="method"][value="${prev.method}"]`)?.click();
    renderMethod(form);
    form.addEventListener('submit', (event) => { event.preventDefault(); submit(form); });
  }

  /** Вход прямо на странице оплаты: корзина и введённые данные остаются на месте. */
  async function loginInline(form) {
    const status = $('[data-login-status]', form);
    const btn = $('[data-login]', form);
    btn.disabled = true;
    status.textContent = '';
    try {
      await accountApi.login({ email: $('#coLoginEmail', form).value.trim(), password: $('#coLoginPass', form).value });
      user = (await accountApi.me()).user;
      document.dispatchEvent(new CustomEvent('neptun:signed-in'));
      renderForm(true);
    } catch (error) {
      status.textContent = error.status === 401 ? 'Неверная почта или пароль' : error.message;
      btn.disabled = false;
    }
  }

  /** Вход мог случиться в другой вкладке или на /account (кнопка «назад») — перепроверяем. */
  async function recheckUser() {
    if (mode !== 'form') return;
    const fresh = await accountApi.session()
      .then((d) => (d.authenticated ? accountApi.me().then((m) => m.user) : null)).catch(() => user);
    if (Boolean(fresh) !== Boolean(user) || fresh?.id !== user?.id) {
      user = fresh;
      renderForm(true);
    }
  }
  window.addEventListener('pageshow', (event) => { if (event.persisted) recheckUser(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) recheckUser(); });

  function dateHint(form) {
    const hint = $('[data-date-hint]', form);
    const value = form.elements.visitDate.value;
    if (!value) { hint.textContent = ''; return; }
    const weekend = isoWeekday(value) >= 6;
    const hasWeekday = lines().some((l) => l.id.includes(':weekday:'));
    hint.innerHTML = `${escapeHtml(DATE_FMT.format(new Date(`${value}T00:00:00Z`)))} · ${weekend ? 'тариф выходного дня' : 'будний день'}`;
    if (weekend && hasWeekday) {
      hint.innerHTML += ' <button class="co-link" type="button" data-to-weekend>Перевести билеты на тариф выходного дня</button>';
      $('[data-to-weekend]', hint).addEventListener('click', () => {
        for (const l of lines().filter((x) => x.id.includes(':weekday:'))) {
          cart.remove(l.id);
          cart.add(l.id.replace(':weekday:', ':weekend:'), l.qty);
        }
      });
    }
  }

  function renderMethod(form) {
    const method = form.elements.method.value;
    const panel = $('[data-method-panel]', form);
    const label = $('[data-pay-label]', form);
    const total = cartTotal(lines());
    label.textContent = method === 'card' ? `Оплатить ${formatPrice(total)}`
      : method === 'desk' ? 'Оформить заказ' : `Перейти к оплате · ${formatPrice(total)}`;
    if (method !== 'card') {
      panel.innerHTML = method === 'desk'
        ? '<p class="note">Онлайн-оплата сейчас не подключена: оформите заказ, назовите код на кассе и оплатите картой или Kaspi QR.</p>'
        : `<p class="note">${method === 'kaspi' ? 'На следующем шаге покажем номер Kaspi' : 'Оплата с вашей карты в приложении вашего банка: на следующем шаге покажем карту аквапарка'}, сумму и код заказа для комментария к переводу.</p>`;
      return;
    }
    cardFieldsInto(panel);
  }

  function collect() {
    const form = $('.co-form', root);
    if (!form) return null;
    const v = (name) => form.elements[name]?.value?.trim() ?? '';
    return { name: v('name'), phone: v('phone'), email: v('email'), visitDate: v('visitDate') || null, method: form.elements.method?.value };
  }

  function readCard(form) {
    const val = (k) => form.querySelector(`[data-cc="${k}"]`).value.trim();
    const number = normalizeCardNumber(val('number'));
    const [month, year] = val('exp').split('/');
    const cvc = val('cvc');
    const holder = val('holder');
    const errors = {};
    if (!(number.length >= 16 && number.length <= 19 && (number.length !== 16 || luhnValid(number)))) errors['card.number'] = 'Проверьте номер карты';
    const m = Number(month);
    const y = 2000 + Number(year);
    const now = new Date();
    if (!/^\d{2}$/.test(month ?? '') || !/^\d{2}$/.test(year ?? '') || m < 1 || m > 12) errors['card.exp'] = 'Срок в формате ММ/ГГ';
    else if (new Date(Date.UTC(y, m, 1)) <= now) errors['card.exp'] = 'Срок действия карты истёк';
    if (!/^\d{3,4}$/.test(cvc)) errors['card.cvc'] = '3 цифры на обороте карты';
    if (!/^[A-Z][A-Z .'-]{1,59}$/.test(holder)) errors['card.holder'] = 'Имя латиницей, как на карте';
    return { errors, card: { number, month, year, cvc, holder } };
  }

  function showErrors(form, errors) {
    form.querySelectorAll('[data-error]').forEach((el) => { el.textContent = errors[el.dataset.error] ?? ''; });
    const first = Object.keys(errors).find((k) => form.querySelector(`[data-error="${k}"]`));
    form.querySelector(`[data-error="${first}"]`)?.closest('.field, .co-step, form')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function submit(form) {
    const status = $('[data-status]', form);
    const button = $('.co-pay', form);
    const data = collect();
    const method = data.method;
    const errors = {};
    if (!form.elements.consent.checked) errors.consent = 'Отметьте согласие с условиями оферты';
    let card = null;
    if (method === 'card') {
      const read = readCard(form);
      Object.assign(errors, read.errors);
      card = read.card;
    }
    if (Object.keys(errors).length) { showErrors(form, errors); return; }
    showErrors(form, {});
    status.textContent = '';
    status.dataset.kind = '';
    button.disabled = true;
    button.classList.add('loading');

    try {
      store.set('neptun-contact', { name: data.name, phone: data.phone, email: data.email });
      const items = lines();
      const { order } = await checkoutApi.create({
        cart: items.map((l) => ({ id: l.id, qty: l.qty, ...(l.ref ? { ref: l.ref } : {}) })),
        contact: { name: data.name, phone: data.phone, email: data.email },
        visitDate: data.visitDate,
        consent: true,
      }, idempotencyKey(items));
      rememberOrder(order);
      history.replaceState(null, '', `/checkout?order=${order.id}`);

      if (method === 'card') {
        status.textContent = 'Связываемся с банком…';
        const cryptogram = await makeCryptogram(card, options.methods.card);
        const res = await checkoutApi.payCard(order.id, { cryptogram, holder: card.holder });
        if (res.threeDs) {
          status.textContent = 'Переходим на страницу вашего банка для подтверждения…';
          goTo3ds(res.threeDs);
          return;
        }
        finish(res.order);
        return;
      }
      mode = 'order';
      cart.clear();
      showOrder(order.id, order, method);
    } catch (error) {
      if (error.body?.errors) showErrors(form, error.body.errors);
      status.dataset.kind = 'error';
      status.textContent = error.body?.errors ? 'Проверьте отмеченные поля' : error.message;
      button.disabled = false;
      button.classList.remove('loading');
    }
  }

  function finish(order) {
    mode = 'order';
    cart.clear();
    try { sessionStorage.removeItem('neptun-checkout-key'); } catch { /* ignore */ }
    showOrder(order.id, order);
  }

  // ---------- заказ: оплата переводом, ожидание, чек ----------

  async function showOrder(id, known = null, preferred = null) {
    mode = 'order';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    stopPolling();
    let order = known;
    if (!order) {
      try {
        ({ order } = await checkoutApi.order(id));
      } catch {
        root.innerHTML = `<div class="panel co-error"><b>Заказ не найден</b><p>Проверьте ссылку или оформите заказ заново.</p><a class="btn primary" href="/checkout">К корзине</a></div>`;
        return;
      }
    }
    rememberOrder(order);
    if (order.status === 'paid') { cart.clear(); return renderPaid(order); }
    if (order.status !== 'pending') return renderClosed(order);
    if (order.claim) return renderWaiting(order);
    renderPayment(order, preferred);
  }

  function orderLinesHtml(order) {
    return order.lines.map((l) => `
      <li class="cart-line"><div class="cart-line__text"><b>${escapeHtml(l.title)}</b><small>${escapeHtml(l.option)}</small></div>
      <span class="cart-line__x">× ${l.qty}</span><b class="cart-line__sum">${formatPrice(l.sum)}</b></li>`).join('');
  }

  function renderPayment(order, preferred) {
    const m = options.methods;
    const methods = enabledMethods().filter((x) => x.id !== 'card' || m.card.enabled);
    const current = preferred ?? (params.get('declined') && m.card.enabled ? 'card' : methods[0].id);
    const declined = params.get('declined');
    root.innerHTML = `
      <div class="co-grid">
        <div class="co-pay-step panel">
          <p class="co-code">Заказ <b>${escapeHtml(order.code)}</b> · ${formatPrice(order.total)}</p>
          ${declined ? `<p class="acc-status" data-kind="error">${escapeHtml(declined)}</p>` : ''}
          <div class="tabs co-tabs" role="tablist">${methods.map((x) => `<button type="button" role="tab" aria-selected="${x.id === current}" data-tab="${x.id}">${x.title}</button>`).join('')}</div>
          <div data-pay-body></div>
        </div>
        <aside class="co-summary panel"><h2>Ваш заказ</h2><ul class="cart-lines cart-lines--static">${orderLinesHtml(order)}</ul>
          <div class="cart-total"><span>Итого</span><b>${formatPrice(order.total)}</b></div></aside>
      </div>`;
    const body = $('[data-pay-body]', root);
    const show = (method) => {
      root.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === method)));
      if (method === 'card') return renderCardRetry(body, order);
      if (method === 'desk') {
        body.innerHTML = `<div class="co-desk"><p>Назовите код <b class="kaspi__code">${escapeHtml(order.code)}</b> на кассе аквапарка и оплатите картой или Kaspi QR — сотрудник найдёт заказ по коду.</p></div>`;
        return null;
      }
      body.innerHTML = transferHtml(order, method);
      bindCopyButtons(body);
      $('[data-claim]', body).addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          const res = await checkoutApi.claim(order.id, method);
          renderWaiting(res.order);
        } catch (error) {
          $('[data-claim-status]', body).textContent = error.message;
          btn.disabled = false;
        }
      });
      return null;
    };
    root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    show(current);
  }

  function transferHtml(order, method) {
    const m = options.methods;
    const isKaspi = method === 'kaspi';
    const target = isKaspi ? m.kaspi.phone : m.transfer.number;
    const copyValue = String(target).replace(/[^\d+]/g, '');
    const copy = (value, label) => `<button class="kaspi__copy" type="button" data-copy="${escapeHtml(value)}" aria-label="Скопировать ${label}">Копировать</button>`;
    return `
      <div class="transfer">
        ${isKaspi ? '' : `
          <div class="transfer__card" aria-label="Карта получателя">
            <span class="transfer__bank">${escapeHtml(m.transfer.bank ?? 'Банковская карта')}</span>
            <span class="transfer__number">${escapeHtml(target)}</span>
            <span class="transfer__holder">${escapeHtml(m.transfer.holder ?? 'Аквапарк «Нептун»')}</span>
          </div>`}
        <ol class="kaspi__steps">
          <li>Откройте приложение своего банка → «Переводы» → ${isKaspi ? '«По номеру телефона» (Kaspi)' : '«По номеру карты»'}.</li>
          <li><span>${isKaspi ? 'Номер' : 'Карта'}: <b class="kaspi__value">${escapeHtml(target)}</b></span> ${copy(copyValue, isKaspi ? 'номер' : 'номер карты')}
            ${isKaspi && m.kaspi.receiver ? `<small>Получатель: ${escapeHtml(m.kaspi.receiver)}</small>` : ''}</li>
          <li><span>Сумма: <b class="kaspi__value">${formatPrice(order.total)}</b></span> ${copy(String(order.total), 'сумму')}</li>
          <li><span>Комментарий к переводу: <b class="kaspi__value kaspi__code">${escapeHtml(order.code)}</b></span> ${copy(order.code, 'код заказа')}
            <small>По этому коду мы найдём ваш перевод.</small></li>
        </ol>
        ${isKaspi && m.kaspi.payLink ? `<a class="btn ghost" href="${escapeHtml(m.kaspi.payLink)}" target="_blank" rel="noopener">Оплатить по ссылке Kaspi</a>` : ''}
        <p class="acc-status" data-kind="error" data-claim-status role="alert"></p>
        <button class="btn primary btn--block" type="button" data-claim>Я перевёл(а) деньги</button>
        <p class="note">Подтверждение занимает несколько минут в часы работы аквапарка. Страницу можно закрыть — заказ сохранится по ссылке.</p>
      </div>`;
  }

  function renderCardRetry(body, order) {
    body.innerHTML = `<form class="co-form co-form--inline" novalidate><div data-method-panel></div>
      <p class="acc-status" data-status role="alert"></p>
      <button class="btn primary btn--block co-pay" type="submit">Оплатить ${formatPrice(order.total)}</button></form>`;
    const form = $('form', body);
    cardFieldsInto($('[data-method-panel]', form));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = $('[data-status]', form);
      const { errors, card } = readCard(form);
      if (Object.keys(errors).length) { showErrors(form, errors); return; }
      showErrors(form, {});
      const btn = $('.co-pay', form);
      btn.disabled = true;
      status.dataset.kind = '';
      status.textContent = 'Связываемся с банком…';
      try {
        const cryptogram = await makeCryptogram(card, options.methods.card);
        const res = await checkoutApi.payCard(order.id, { cryptogram, holder: card.holder });
        if (res.threeDs) { goTo3ds(res.threeDs); return; }
        finish(res.order);
      } catch (error) {
        status.dataset.kind = 'error';
        status.textContent = error.message;
        btn.disabled = false;
      }
    });
  }

  function renderWaiting(order) {
    root.innerHTML = `
      <div class="panel co-result co-result--wait" aria-live="polite">
        <span class="spinner" aria-hidden="true"></span>
        <h2>Проверяем перевод</h2>
        <p>Заказ <b class="kaspi__code">${escapeHtml(order.code)}</b> на ${formatPrice(order.total)}. Как только сотрудник увидит перевод, здесь появится чек с кодом для входа.</p>
        <p class="note">Страницу можно закрыть: ссылка на заказ сохранена, она также есть в разделе «Мои заказы» этой страницы.</p>
      </div>`;
    stopPolling = pollUntilSettled(() => checkoutApi.order(order.id).then((r) => r.order), (fresh) => showOrder(fresh.id, fresh));
  }

  function renderClosed(order) {
    root.innerHTML = `
      <div class="panel co-result co-result--closed">
        <h2>Заказ ${escapeHtml(order.code)}: ${STATUS[order.status] ?? order.status}</h2>
        <p>${order.rejectReason ? `Причина: ${escapeHtml(order.rejectReason)}. ` : ''}Если вы уже перевели деньги — позвоните на ресепшен <a href="tel:+77152336141">+7 7152 33-61-41</a>, назовите код заказа.</p>
        <a class="btn primary" href="/checkout">Оформить заново</a>
      </div>`;
  }

  function renderPaid(order) {
    const date = order.visitDate ? DATE_FMT.format(new Date(`${order.visitDate}T00:00:00Z`)) : null;
    root.innerHTML = `
      <div class="panel co-result co-result--paid">
        <svg class="co-check" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24"/><path d="M15 27l7 7 15-16"/></svg>
        <h2>Оплачено!</h2>
        <p class="co-code co-code--big">${escapeHtml(order.code)}</p>
        <p>Назовите этот код ${order.lines.some((l) => l.kind === 'ticket') ? 'на кассе при входе' : 'на ресепшене'} — сотрудник найдёт заказ.${date ? ` Дата визита: <b>${escapeHtml(date)}</b>.` : ''}</p>
        ${order.needsAccount ? `<p>Абонемент уже в вашем <a href="/account/overview">личном кабинете</a>.${order.lines.filter((l) => l.kind === 'membership').reduce((s, l) => s + l.qty, 0) > 1 ? ' Остальные абонементы из заказа выдадут на ресепшене по этому коду.' : ''}</p>` : ''}
        ${order.usedAt ? '<p class="pill-used">Заказ выдан / вход отмечен</p>' : ''}
        <ul class="cart-lines cart-lines--static">${orderLinesHtml(order)}</ul>
        <div class="cart-total"><span>Итого</span><b>${formatPrice(order.total)}</b></div>
        <p class="note">Оплачено ${METHOD[order.method] ?? ''}${order.card?.last4 ? ` · карта •••• ${escapeHtml(order.card.last4)}` : ''} · чек ${escapeHtml(order.receipt?.receiptId ?? '')} ·
          ${new Date(order.paidAt).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })}</p>
        <div class="co-result__actions">
          <button class="btn ghost" type="button" data-print>Распечатать</button>
          <a class="btn primary" href="/">На главную</a>
        </div>
      </div>`;
    $('[data-print]', root).addEventListener('click', () => window.print());
  }

  function recentOrdersHtml() {
    const list = store.get(ORDERS_KEY, []);
    if (!list.length) return '';
    return `
      <div class="co-recent">
        <h3>Мои заказы на этом устройстве</h3>
        <ul>${list.map((o) => `<li><a href="/checkout?order=${encodeURIComponent(o.id)}">${escapeHtml(o.code)}</a> · ${formatPrice(o.total)}</li>`).join('')}</ul>
      </div>`;
  }

  boot();
}

/** Поля карты с масками и живым превью. Поля без name: значения уходят только в шифрование. */
function cardFieldsInto(panel) {
  panel.innerHTML = `
    <div class="card-form">
      <div class="card-preview" data-card-preview aria-hidden="true">
        <div class="card-preview__face card-preview__front">
          <span class="card-preview__chip"></span>
          <span class="card-preview__brand" data-card-brand></span>
          <span class="card-preview__number" data-card-number>•••• •••• •••• ••••</span>
          <span class="card-preview__row"><span data-card-holder>ИМЯ ВЛАДЕЛЬЦА</span><span data-card-exp>ММ/ГГ</span></span>
        </div>
        <div class="card-preview__face card-preview__back">
          <span class="card-preview__stripe"></span>
          <span class="card-preview__cvc"><span data-card-cvc>•••</span></span>
        </div>
      </div>
      <div class="card-fields">
        <div class="field card-fields__number"><label for="ccNumber">Номер карты</label>
          <input id="ccNumber" inputmode="numeric" autocomplete="cc-number" placeholder="0000 0000 0000 0000" maxlength="23" data-cc="number">
          <span class="field__error" data-error="card.number"></span></div>
        <div class="field"><label for="ccExp">Срок действия</label>
          <input id="ccExp" inputmode="numeric" autocomplete="cc-exp" placeholder="ММ/ГГ" maxlength="5" data-cc="exp">
          <span class="field__error" data-error="card.exp"></span></div>
        <div class="field"><label for="ccCvc">CVC/CVV</label>
          <input id="ccCvc" type="password" inputmode="numeric" autocomplete="cc-csc" placeholder="•••" maxlength="4" data-cc="cvc">
          <span class="field__error" data-error="card.cvc"></span></div>
        <div class="field card-fields__holder"><label for="ccHolder">Имя на карте <small>— латиницей</small></label>
          <input id="ccHolder" autocomplete="cc-name" placeholder="IVAN PETROV" maxlength="60" data-cc="holder">
          <span class="field__error" data-error="card.holder"></span></div>
      </div>
    </div>`;
  const preview = $('[data-card-preview]', panel);
  const input = (k) => $(`[data-cc="${k}"]`, panel);
  input('number').addEventListener('input', (e) => {
    const digits = normalizeCardNumber(e.target.value).slice(0, 19);
    e.target.value = digits.replace(/(\d{4})(?=\d)/g, '$1 ');
    $('[data-card-number]', preview).textContent = (digits.padEnd(16, '•').replace(/(.{4})(?=.)/g, '$1 '));
    $('[data-card-brand]', preview).dataset.brand = cardBrandOf(digits);
    if (digits.length >= 16) input('exp').focus();
  });
  input('exp').addEventListener('input', (e) => {
    let d = e.target.value.replace(/\D/g, '').slice(0, 4);
    if (d.length === 1 && Number(d) > 1) d = `0${d}`;
    e.target.value = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
    $('[data-card-exp]', preview).textContent = e.target.value || 'ММ/ГГ';
    if (d.length === 4) input('cvc').focus();
  });
  input('cvc').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
    $('[data-card-cvc]', preview).textContent = '•'.repeat(e.target.value.length) || '•••';
  });
  input('cvc').addEventListener('focus', () => preview.classList.add('flipped'));
  input('cvc').addEventListener('blur', () => preview.classList.remove('flipped'));
  input('holder').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z .'-]/g, '');
    $('[data-card-holder]', preview).textContent = e.target.value || 'ИМЯ ВЛАДЕЛЬЦА';
  });
}
