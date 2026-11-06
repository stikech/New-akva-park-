/**
 * Расписание и запись на занятия (модуль кабинета).
 *
 * Лента дней (14 вперёд) → слот-лист дня: вместимость, «мой» флаг, какая
 * категория абонемента понадобится. Запись и отмена работают оптимистично:
 * UI сначала перерисовывается, затем подтверждение от сервера уточняет
 * цифры занятости.
 *
 * Поведение без абонемента — не блок, а приглашение: карточка слота
 * показывает, какой тип абонемента нужен, кнопка ведёт в магазин.
 */

import { scheduleApi } from '../services/api.js?v=3';
import { escapeHtml } from '../utils/format.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const DAY_FMT = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const DAY_FULL = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

const CATEGORY_LABEL = {
  pool: 'Бассейн', aqua: 'Аквааэробика', fitness: 'Фитнес',
  combat: 'Единоборства', group: 'Групповые', kids: 'Детские',
};
const PLAN_LABEL = { pool: 'абонемент «Бассейн»', fitness: 'любой абонемент фитнес-клуба' };

export function initBooking({ root, goto }) {
  let data = null; // ответ /api/schedule
  let selectedDate = null;

  // ---------- разметка ----------

  function slotHtml(slot) {
    const state = slot.past ? 'past' : slot.mine ? 'mine' : slot.fullyBooked ? 'full' : slot.bookable ? 'open' : 'locked';
    const busy = slot.capacity - slot.free;
    const pct = Math.round((busy / slot.capacity) * 100);
    const action = state === 'mine'
      ? '<button class="btn outline slot__btn" type="button" data-cancel-key="' + escapeHtml(slot.key) + '">Отменить</button>'
      : state === 'open'
        ? '<button class="btn primary slot__btn" type="button" data-book-key="' + escapeHtml(slot.key) + '">Записаться</button>'
        : state === 'full'
          ? '<span class="slot__state">Мест нет</span>'
          : state === 'locked'
            ? `<span class="slot__state slot__state--hint">Нужен ${escapeHtml(PLAN_LABEL[slot.needPlan ?? 'fitness'])}</span><button class="btn outline slot__btn" type="button" data-goto-shop>Купить</button>`
            : '<span class="slot__state">Время прошло</span>';

    return `
      <li class="slot slot--${escapeHtml(state)}${slot.free <= 2 && !slot.fullyBooked ? ' slot--few' : ''}">
        <div class="slot__time"><b>${escapeHtml(slot.start)}</b><small>до ${escapeHtml(slot.end)}</small></div>
        <div class="slot__info">
          <b>${escapeHtml(slot.title)}</b>
          <span>${escapeHtml(CATEGORY_LABEL[slot.category] ?? slot.category)} · ${escapeHtml(slot.room)}</span>
          <span class="slot__meter ${slot.fullyBooked ? 'slot__meter--full' : ''}">
            <span class="slot__meter__track"><i style="width:${pct}%"></i></span>
            <small>${slot.fullyBooked ? 'заполнено' : `свободно ${slot.free} из ${slot.capacity}`}</small>
          </span>
        </div>
        <div class="slot__action">${action}</div>
      </li>`;
  }

  function render() {
    if (!data) {
      root.innerHTML = '<div class="schedule-root__load" role="status"><span class="spinner" aria-hidden="true"></span> Загружаем расписание…</div>';
      return;
    }

    const m = data.membership;
    const dayList = data.days.map((d) => ({
      ...d,
      selectable: Boolean(d.slots.length),
    }));

    const current = dayList.find((d) => d.date === selectedDate) ?? dayList.find((d) => d.slots.some((s) => !s.past)) ?? dayList[0];
    selectedDate = current?.date ?? null;

    const dayFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' });
    const numFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', timeZone: 'UTC' });

    root.innerHTML = `
      ${m ? `
      <div class="schedule-status" data-code="${escapeHtml(m.status)}">
        <span class="badge badge--light" data-code="${escapeHtml(m.status)}">${escapeHtml(m.label)}</span>
        <span>${m.status === 'active'
          ? `Открыты занятия: ${escapeHtml(m.allowed.map((c) => CATEGORY_LABEL[c] ?? c).join(' · '))}`
          : escapeHtml(m.status === 'none' ? 'Запись доступна с действующим абонементом — выберите тариф в магазине.' : 'Абонемент не действует — продолжить можно в магазине.')}</span>
        ${m.status !== 'active' ? '<button class="btn outline" type="button" data-goto-shop>В магазин</button>' : ''}
      </div>` : ''}
      <div class="schedule-days" role="group" aria-label="Дни расписания">
        ${dayList.map((d) => `
          <button class="schedule-day${d.date === selectedDate ? ' schedule-day--active' : ''}${d.selectable ? '' : ' schedule-day--empty'}"
                  type="button" data-date="${escapeHtml(d.date)}"
                  aria-pressed="${d.date === selectedDate}"
                  ${d.selectable ? '' : 'disabled'}>
            <span class="schedule-day__wd">${dayFmt.format(new Date(`${d.date}T00:00:00Z`))}</span>
            <span class="schedule-day__num">${numFmt.format(new Date(`${d.date}T00:00:00Z`))}</span>
            ${d.slots.some((s) => s.mine) ? '<i class="schedule-day__dot" title="Есть ваша запись"></i>' : ''}
          </button>`).join('')}
      </div>

      ${current ? `
      <p class="schedule-dayname" aria-live="polite">${DAY_FULL.format(new Date(`${current.date}T00:00:00Z`))}</p>
      ${current.slots.length
        ? `<ul class="slots">${current.slots.map(slotHtml).join('')}</ul>`
        : '<p class="empty">В этот день занятий нет — выберите другой день.</p>'}` : ''}

      ${data.myBookings?.length ? `
      <section class="panel schedule-mine">
        <h3 class="acc-h3">Мои записи</h3>
        <ul class="schedule-mine__list">
          ${data.myBookings.map((b) => `
            <li>
              <div>
                <b>${escapeHtml(b.title)}</b>
                <span>${new Date(`${b.date}T00:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'long', timeZone: 'UTC' })}, ${escapeHtml(b.start)}–${escapeHtml(b.end)} · ${escapeHtml(b.room)}</span>
              </div>
              <button class="btn outline" type="button" data-cancel-key="${escapeHtml(b.key)}">Отменить</button>
            </li>`).join('')}
        </ul>
        <p class="note">Отмена — не позднее, чем за ${data.cutoffMin} минут до начала. Опоздание не возвращает место в зале.</p>
      </section>` : ''}
    `;

    $$('.schedule-day:not([disabled])', root).forEach((btn) => btn.addEventListener('click', () => {
      selectedDate = btn.dataset.date;
      render();
    }));
    $$('[data-book-key]', root).forEach((btn) => btn.addEventListener('click', () => book(btn.dataset.bookKey)));
    $$('[data-cancel-key]', root).forEach((btn) => btn.addEventListener('click', () => cancel(btn.dataset.cancelKey)));
    $$('[data-goto-shop]', root).forEach((btn) => btn.addEventListener('click', () => goto('shop')));
  }

  // ---------- действия ----------

  async function book(key) {
    const btn = $(`[data-book-key="${CSS.escape(key)}"]`, root);
    if (btn) { btn.disabled = true; btn.textContent = 'Записываем…'; }
    try {
      await scheduleApi.book(key);
      await fetchSchedule();
      render();
    } catch (error) {
      if (error.status === 403 || error.status === 409 || error.status === 422) {
        await fetchSchedule(); // собой обновим и fill/места/статус
        render();
        showToast(`Запись не прошла: ${error.message}`);
      } else if (error.status === 401) {
        showToast('Сеанс завершён — войдите снова.');
        render();
      } else {
        showToast(error.message);
        if (btn) { btn.disabled = false; btn.textContent = 'Записаться'; }
      }
    }
  }

  async function cancel(key) {
    const btn = $(`[data-cancel-key="${CSS.escape(key)}"]`, root);
    if (btn) { btn.disabled = true; btn.textContent = 'Отменяем…'; }
    try {
      await scheduleApi.cancel(key);
      await fetchSchedule();
      render();
    } catch (error) {
      showToast(error.message);
      await fetchSchedule();
      render();
    }
  }

  async function fetchSchedule() {
    data = await scheduleApi.schedule(14);
    if (selectedDate && !data.days.some((d) => d.date === selectedDate)) selectedDate = null;
  }

  let toastTimer = null;
  function showToast(message) {
    $$('.schedule-toast', root).forEach((t) => t.remove());
    const el = document.createElement('p');
    el.className = 'schedule-toast';
    el.setAttribute('role', 'status');
    el.textContent = message;
    root.prepend(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 6000);
  }

  return {
    async load({ force = false } = {}) {
      if (data && !force) return;
      render(); // индикация загрузки
      try {
        await fetchSchedule();
      } catch {
        root.innerHTML = '<p class="note" role="status">Расписание недоступно — обновите страницу или позвоните на ресепшен: +7 7152 33-61-41.</p>';
        return;
      }
      render();
    },
    /** Сброс при выходе из аккаунта: следующему пользователю — свои записи. */
    reset() { data = null; },
  };
}
