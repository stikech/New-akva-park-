/**
 * Превью расписания занятий на главной (секция «Занятия»).
 *
 * Данные — шаблон недели из site-data.js: тот же источник, из которого
 * backend/src/schedule.js компилирует живое расписание кабинета. Превью
 * статично: какие занятия бывают и когда. Точные дни, время и свободные
 * места — только в кабинете (за этим и отправляет кнопка на /account).
 */

import { escapeHtml } from '../utils/format.js';

/** Короткие подписи дней недели (ISO 1–7). */
const DAY = { 1: 'пн', 2: 'вт', 3: 'ср', 4: 'чт', 5: 'пт', 6: 'сб', 7: 'вс' };

const CATEGORY = {
  pool: 'Бассейн',
  aqua: 'Аквааэробика',
  fitness: 'Фитнес',
  combat: 'Единоборства',
  group: 'Групповые',
  kids: 'Детские',
};

const minutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

const hhmm = (total) => `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

/** Группирует время занятий: одинаковые слоты в разные дни → одна строка. */
function timeGroups(times) {
  const buckets = new Map();
  for (const { day, start } of times) {
    if (!buckets.has(start)) buckets.set(start, []);
    buckets.get(start).push(day);
  }
  return [...buckets.entries()]
    .map(([start, days]) => ({ start, days: [...days].sort((a, b) => a - b) }))
    .sort((a, b) => a.days[0] - b.days[0] || minutes(a.start) - minutes(b.start));
}

/** Заполняет контейнер карточками занятий. */
export function renderSchedulePreview(root, schedule = []) {
  if (!root) return;
  root.innerHTML = schedule.map((lesson) => {
    const times = timeGroups(lesson.times || []).map(({ start, days }) => {
      const end = minutes(start) + (lesson.durationMin ?? 60);
      return `<b>${hhmm(minutes(start))}–${hhmm(end)}</b> ${days.map((d) => DAY[d] ?? d).join(' · ')}`;
    });
    return `
      <article class="class-item class-item--${escapeHtml(lesson.category)}">
        <span class="class-item__chip">${escapeHtml(CATEGORY[lesson.category] ?? lesson.category)}</span>
        <h3>${escapeHtml(lesson.title)}</h3>
        <p class="class-item__room">${escapeHtml(lesson.room)}${lesson.capacity ? ` · до ${Number(lesson.capacity)} человек` : ''}</p>
        <p class="class-item__times">${times.join('</p><p class="class-item__times">')}</p>
      </article>`;
  }).join('');
}
