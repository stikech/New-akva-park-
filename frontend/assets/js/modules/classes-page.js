/**
 * Страница /classes: живое расписание на 14 дней и запись на занятия.
 *
 * Кто может записаться (сервер решает сам, backend/src/bookings.js):
 *  - с абонементом нужной категории — бесплатно, занятие входит в абонемент;
 *  - без абонемента — разовое занятие: оплатить сразу онлайн (позиция уходит в корзину
 *    вместе с id записи) или на ресепшене перед занятием;
 *  - без личного кабинета — по имени и телефону; запись можно отменить отсюда же,
 *    она запоминается в этом браузере.
 * Для разового занятия и для гостя нужно согласие с офертой и правилами.
 */

import { accountApi, scheduleApi } from '../services/api.js?v=4';
import { escapeHtml, formatPrice } from '../utils/format.js';
import { CONSENT_HTML } from '../utils/plans.js';
import { addToCart } from './cart-ui.js?v=1';

const $ = (selector, root = document) => root.querySelector(selector);
const GUEST_KEY = 'neptun-guest-bookings';
const CATEGORY = { pool: 'Бассейн', aqua: 'Аквааэробика', fitness: 'Фитнес', combat: 'Единоборства', group: 'Групповые', kids: 'Детские' };
const DAY_SHORT = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' });
const DAY_NUM = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const DAY_FULL = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const asDate = (iso) => new Date(`${iso}T00:00:00Z`);

const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* приватный режим */ } },
};

function phoneMask(value) {
  const d = value.replace(/\D/g, '').replace(/^8/, '7').slice(0, 11);
  if (!d) return '';
  const p = d.startsWith('7') ? d : `7${d}`;
  const parts = [p.slice(1, 4), p.slice(4, 7), p.slice(7, 9), p.slice(9, 11)];
  return `+7${parts[0] ? ` ${parts[0]}` : ''}${parts[1] ? ` ${parts[1]}` : ''}${parts[2] ? `-${parts[2]}` : ''}${parts[3] ? `-${parts[3]}` : ''}`;
}

export function initClassesPage(root, modal) {
  let data = null;
  let user = null;
  let date = null;
  let category = 'all';
  let opener = null;
  const card = $('.visit-modal__card', modal);

  async function load() {
    try {
      [data, user] = await Promise.all([
        scheduleApi.schedule(14),
        accountApi.session().then((d) => (d.authenticated ? accountApi.me().then((m) => m.user) : null)).catch(() => null),
      ]);
    } catch (error) {
      root.innerHTML = `<div class="panel co-error"><b>Расписание не загрузилось</b><p>${escapeHtml(error.message)}</p><button class="btn primary" type="button" data-retry>Повторить</button></div>`;
      $('[data-retry]', root).addEventListener('click', load);
      return;
    }
    date ??= data.days.find((d) => d.slots.some((s) => s.bookable))?.date ?? data.days[0].date;
    render();
  }

  function guestBookings() {
    const today = data?.today ?? '';
    const list = store.get(GUEST_KEY, []).filter((b) => b.date >= today);
    store.set(GUEST_KEY, list);
    return list;
  }

  // ---------- расписание ----------

  function render() {
    const categories = ['all', ...new Set(data.days.flatMap((d) => d.slots.map((s) => s.category)))];
    const day = data.days.find((d) => d.date === date) ?? data.days[0];
    const slots = day.slots.filter((s) => category === 'all' || s.category === category);
    const mine = user ? (data.myBookings ?? []) : guestBookings();
    const m = data.membership;

    root.innerHTML = `
      ${user ? `<p class="cl-member">${m && m.status === 'active'
        ? `Ваш абонемент: <b>${escapeHtml(m.title)}</b> — занятия с отметкой «по абонементу» бесплатны.`
        : 'Абонемента нет — занятия можно оплатить разово онлайн или на ресепшене. <a href="/shop">Купить абонемент</a>'}</p>`
        : '<p class="cl-member">Записаться можно без регистрации — по имени и телефону. <a href="/account?next=/classes">Войти</a>, чтобы занятия списывались с абонемента.</p>'}

      ${mine.length ? `
        <div class="cl-mine panel">
          <h3>Мои записи</h3>
          <ul>${mine.map((b) => `
            <li><span><b>${escapeHtml(b.title)}</b> · ${escapeHtml(DAY_FULL.format(asDate(b.date)))}, ${escapeHtml(b.start)}
              ${b.payment === 'single' ? (b.paid ? '<span class="cl-tag cl-tag--ok">оплачено</span>' : `<span class="cl-tag">${b.price ? formatPrice(b.price) : ''} на ресепшене</span>`) : '<span class="cl-tag cl-tag--ok">по абонементу</span>'}</span>
              <button class="btn ghost cl-cancel" type="button" data-cancel="${escapeHtml(user ? b.key : b.id)}">Отменить</button></li>`).join('')}
          </ul>
          <p class="acc-status" data-kind="error" data-mine-status role="alert"></p>
        </div>` : ''}

      <div class="cl-days" role="tablist" aria-label="Дни">
        ${data.days.map((d) => {
          const free = d.slots.filter((s) => s.bookable).length;
          return `<button type="button" role="tab" class="cl-day" aria-selected="${d.date === day.date}" data-date="${d.date}">
            <small>${d.date === data.today ? 'сегодня' : escapeHtml(DAY_SHORT.format(asDate(d.date)))}</small>
            <b>${escapeHtml(DAY_NUM.format(asDate(d.date)))}</b>
            <span class="cl-day__dot" data-free="${free > 0}"></span>
          </button>`;
        }).join('')}
      </div>

      <div class="tabs tabs--scroll cl-filter" role="group" aria-label="Направление">
        ${categories.map((c) => `<button type="button" aria-selected="${c === category}" data-cat="${c}">${c === 'all' ? 'Все' : escapeHtml(CATEGORY[c] ?? c)}</button>`).join('')}
      </div>

      <h2 class="cl-dayhead">${escapeHtml(DAY_FULL.format(asDate(day.date)))}</h2>
      ${slots.length ? `<ul class="cl-slots">${slots.map(slotHtml).join('')}</ul>`
        : '<p class="muted cl-none">В этот день по выбранному направлению занятий нет — выберите другой день.</p>'}`;

    root.querySelectorAll('[data-date]').forEach((b) => b.addEventListener('click', () => { date = b.dataset.date; render(); }));
    root.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => { category = b.dataset.cat; render(); }));
    root.querySelectorAll('[data-book]').forEach((b) => b.addEventListener('click', () => open(b.dataset.book, b)));
    root.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => cancel(b)));
  }

  function slotHtml(s) {
    const pct = Math.min(100, Math.round((s.booked / s.capacity) * 100));
    const isMine = s.mine || (!user && guestBookings().some((b) => b.key === s.key));
    const action = isMine ? '<span class="cl-tag cl-tag--ok">Вы записаны</span>'
      : s.past ? '<span class="cl-tag">Запись закрыта</span>'
        : s.fullyBooked ? '<span class="cl-tag">Мест нет</span>'
          : `<button class="btn primary" type="button" data-book="${escapeHtml(s.key)}">Записаться</button>`;
    return `
      <li class="cl-slot class-item--${escapeHtml(s.category)}${s.past ? ' cl-slot--past' : ''}">
        <div class="cl-slot__time"><b>${escapeHtml(s.start)}</b><small>${escapeHtml(s.end)}</small></div>
        <div class="cl-slot__info">
          <span class="class-item__chip">${escapeHtml(CATEGORY[s.category] ?? s.category)}</span>
          <h3>${escapeHtml(s.title)}</h3>
          <p class="class-item__room">${escapeHtml(s.room)} · ${s.durationMin} мин</p>
          <div class="cl-seats" style="--fill:${pct}%"><span></span></div>
          <small class="cl-seats__text">${s.fullyBooked ? 'все места заняты' : `свободно ${s.free} из ${s.capacity}`}</small>
        </div>
        <div class="cl-slot__act">
          <span class="cl-price">${s.access === 'membership' ? 'по абонементу' : s.singlePrice ? formatPrice(s.singlePrice) : ''}</span>
          ${action}
        </div>
      </li>`;
  }

  // ---------- запись ----------

  const slotByKey = (key) => data.days.flatMap((d) => d.slots).find((s) => s.key === key);

  function open(key, from) {
    const slot = slotByKey(key);
    if (!slot) return;
    opener = from;
    const single = slot.access !== 'membership';
    const saved = store.get('neptun-contact', {});
    card.innerHTML = `
      <div class="vc-head">
        <h2 class="vc-title" id="classModalTitle">Запись на занятие</h2>
        <button class="vc-close" type="button" data-modal-close aria-label="Закрыть">×</button>
      </div>
      <p class="vc-summary"><b>${escapeHtml(slot.title)}</b><br>${escapeHtml(DAY_FULL.format(asDate(slot.date)))}, ${escapeHtml(slot.start)}–${escapeHtml(slot.end)} · ${escapeHtml(slot.room)}</p>
      <form class="acc-form cl-form" novalidate>
        ${user ? '' : `
          <div class="vc-cols">
            <div class="field"><label for="clName">Имя</label><input id="clName" name="name" autocomplete="name" required maxlength="80" value="${escapeHtml(saved.name ?? '')}">
              <span class="field__error" data-error="guest.name"></span></div>
            <div class="field"><label for="clPhone">Телефон</label><input id="clPhone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required placeholder="+7 7__ ___-__-__" value="${escapeHtml(phoneMask(saved.phone ?? ''))}">
              <span class="field__error" data-error="guest.phone"></span></div>
          </div>`}
        ${single ? `
          <div class="cl-pay" role="radiogroup" aria-label="Оплата занятия">
            <label class="co-method"><input type="radio" name="pay" value="online" checked>
              <span><b>Оплатить онлайн · ${formatPrice(slot.singlePrice ?? 0)}</b><small>картой или переводом, сразу после записи</small></span></label>
            <label class="co-method"><input type="radio" name="pay" value="desk">
              <span><b>Оплачу на ресепшене</b><small>перед занятием, место уже за вами</small></span></label>
          </div>` : '<p class="cl-member">Занятие входит в ваш абонемент — оплачивать ничего не нужно.</p>'}
        ${single || !user ? `
          <label class="acc-check"><input name="consent" type="checkbox" required><span>${CONSENT_HTML}</span></label>
          <span class="field__error" data-error="consent"></span>` : ''}
        <p class="acc-status" data-status role="alert"></p>
        <button class="btn primary btn--block" type="submit">Записаться</button>
        <p class="note">Отменить запись можно не позднее, чем за час до начала — на этой странице или по телефону ресепшена.</p>
      </form>`;
    const form = $('form', card);
    form.elements.phone?.addEventListener('input', (e) => { e.target.value = phoneMask(e.target.value); });
    form.addEventListener('submit', (event) => { event.preventDefault(); book(slot, form); });
    modal.hidden = false;
    document.body.classList.add('visit-modal-open');
    (form.elements.name ?? $('button[type="submit"]', form)).focus();
  }

  function close() {
    modal.hidden = true;
    document.body.classList.remove('visit-modal-open');
    opener?.focus?.();
  }
  modal.addEventListener('click', (event) => { if (event.target.closest('[data-modal-close], [data-visit-close]')) close(); });
  modal.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });

  async function book(slot, form) {
    const status = $('[data-status]', form);
    const button = $('button[type="submit"]', form);
    form.querySelectorAll('[data-error]').forEach((el) => { el.textContent = ''; });
    status.textContent = '';
    if (form.elements.consent && !form.elements.consent.checked) {
      $('[data-error="consent"]', form).textContent = 'Отметьте согласие с условиями оферты';
      return;
    }
    const extra = { consent: Boolean(form.elements.consent?.checked) };
    if (!user) {
      extra.guest = { name: form.elements.name.value.trim(), phone: form.elements.phone.value.trim() };
      store.set('neptun-contact', { ...store.get('neptun-contact', {}), ...extra.guest });
    }
    button.disabled = true;
    try {
      const { booking } = await scheduleApi.book(slot.key, extra);
      if (!user) {
        store.set(GUEST_KEY, [...store.get(GUEST_KEY, []).filter((b) => b.id !== booking.id),
          { ...booking, phone: extra.guest.phone }]);
      }
      const payOnline = booking.payment === 'single' && form.elements.pay?.value === 'online' && !booking.paid;
      if (payOnline) {
        addToCart(`class:${booking.key}`, 1, {
          ref: booking.id, quiet: true,
          meta: { title: `Занятие · ${booking.title}`, option: `${booking.date.slice(8, 10)}.${booking.date.slice(5, 7)}, ${booking.start}`, price: booking.price },
        });
        location.href = '/checkout';
        return;
      }
      card.innerHTML = `
        <div class="vc-head"><h2 class="vc-title">Вы записаны!</h2><button class="vc-close" type="button" data-modal-close aria-label="Закрыть">×</button></div>
        <p class="vc-summary"><b>${escapeHtml(booking.title)}</b><br>${escapeHtml(DAY_FULL.format(asDate(booking.date)))}, ${escapeHtml(booking.start)}</p>
        <p>${booking.payment === 'single' ? `Оплата ${formatPrice(booking.price ?? 0)} — на ресепшене перед занятием. Назовите имя и телефон.` : 'Занятие спишется с абонемента после отметки на ресепшене.'}</p>
        <button class="btn primary btn--block" type="button" data-modal-close>Готово</button>`;
      await load();
    } catch (error) {
      const errors = error.body?.errors ?? {};
      Object.entries(errors).forEach(([k, v]) => { const el = $(`[data-error="${k}"]`, form); if (el) el.textContent = v; });
      status.dataset.kind = 'error';
      status.textContent = Object.keys(errors).length ? 'Проверьте отмеченные поля' : error.message;
      button.disabled = false;
    }
  }

  async function cancel(button) {
    const status = $('[data-mine-status]', root);
    button.disabled = true;
    try {
      if (user) await scheduleApi.cancel(encodeURIComponent(button.dataset.cancel));
      else {
        const b = store.get(GUEST_KEY, []).find((x) => x.id === button.dataset.cancel);
        await scheduleApi.cancelGuest(button.dataset.cancel, b?.phone ?? '');
        store.set(GUEST_KEY, store.get(GUEST_KEY, []).filter((x) => x.id !== button.dataset.cancel));
      }
      await load();
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  }

  root.innerHTML = '<div class="co-loading"><span class="spinner" aria-hidden="true"></span> Загружаем расписание…</div>';
  load();
}
