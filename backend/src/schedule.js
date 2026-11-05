/**
 * Расписание занятий: шаблон недели из site-data.js → афиша слотов на N дней.
 *
 * Каждая запись шаблона — занятие с расписанием недельных времён (ISO-день 1–7).
 * Слот = (дата, занятие). Ключ слота: `YYYY-MM-DD:session-id` — он же адрес
 * в API записи (POST /api/bookings, DELETE /api/bookings/:key).
 *
 * Шаблон проверяется один раз при старте: битое расписание должно падать
 * loudly при деплое, а не тихо ломать страницу.
 */

import { SITE_DATA } from '../../frontend/assets/js/config/site-data.js';

export const SCHEDULE_CATEGORIES = ['pool', 'aqua', 'fitness', 'combat', 'group', 'kids'];
export const DAYS_AHEAD_MAX = 14;
const DAY = 86_400_000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID_RE = /^[a-z0-9-]{3,40}$/;

/** Какой абонемент открывает какие категории занятий. */
export const CATEGORY_ACCESS = {
  fitness: [...SCHEDULE_CATEGORIES],
  pool: ['pool', 'aqua'],
};

/** Какой тип абонемента нужен на категорию занятия (для подсказки «купить»). */
export const CATEGORY_PLAN = { pool: 'pool', aqua: 'pool', fitness: 'fitness', combat: 'fitness', group: 'fitness', kids: 'fitness' };

function compile(data) {
  if (!Array.isArray(data) || data.length === 0) throw new Error('schedule.js: расписание в site-data.js пустое');
  const seen = new Set();
  return data.map((s) => {
    const what = `занятие ${s?.id ?? '(без id)'}`;
    if (!ID_RE.test(s?.id ?? '')) throw new Error(`${what}: id — 3–40 строчных латинских букв и дефисов`);
    if (seen.has(s.id)) throw new Error(`${what}: id не уникален`);
    seen.add(s.id);
    if (typeof s.title !== 'string' || !s.title.trim() || s.title.length > 80) throw new Error(`${what}: заголовок 1–80 символов`);
    if (!SCHEDULE_CATEGORIES.includes(s.category)) throw new Error(`${what}: категории нет в списке (${s.category})`);
    if (typeof s.room !== 'string' || !s.room.trim() || s.room.length > 60) throw new Error(`${what}: зал 1–60 символов`);
    if (!Number.isInteger(s.capacity) || s.capacity < 1 || s.capacity > 100) throw new Error(`${what}: вместимость 1–100`);
    if (!Number.isInteger(s.durationMin) || s.durationMin < 15 || s.durationMin > 300) throw new Error(`${what}: длительность 15–300 минут`);
    if (!Array.isArray(s.times) || s.times.length === 0) throw new Error(`${what}: должен быть хотя бы один слот недели`);
    s.times.forEach((t) => {
      if (!Number.isInteger(t?.day) || t.day < 1 || t.day > 7) throw new Error(`${what}: день недели 1–7 (ISO)`);
      if (!TIME_RE.test(t?.start ?? '')) throw new Error(`${what}: время в формате ЧЧ:ММ (${t?.start})`);
    });
    return {
      id: s.id, title: s.title, category: s.category, room: s.room,
      capacity: s.capacity, durationMin: s.durationMin,
      times: s.times.map((t) => ({ day: t.day, start: t.start })),
    };
  });
}

/** Какой ISO-день недели у даты «YYYY-MM-DD»: 1 — понедельник … 7 — воскресенье. */
export function isoWeekday(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return null;
  const d = Date.parse(`${date}T12:00:00Z`);
  return Number.isFinite(d) ? (new Date(d).getUTCDay() + 6) % 7 + 1 : null;
}

/** Момент начала/конца слота в UTC: «HH:MM» по времени города (UTC+5). */
export function slotInstant(date, time, tzOffsetHours = SITE_DATA.tzOffsetHours) {
  if (!TIME_RE.test(time ?? '')) return null;
  const naive = Date.parse(`${date}T${time}:00Z`);
  return Number.isFinite(naive) ? naive - tzOffsetHours * 3_600_000 : null;
}

function addMinutes(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Смещает «YYYY-MM-DD» на n дней (в обе стороны). */
export function shiftDate(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

export function createScheduleModule({ template = SITE_DATA.schedule } = {}) {
  const compiled = compile(template);
  const byWeekday = new Map(); // день недели → занятия в нём
  for (const session of compiled) {
    for (const t of session.times) {
      if (!byWeekday.has(t.day)) byWeekday.set(t.day, []);
      byWeekday.get(t.day).push({ session, start: t.start });
    }
  }

  const list = (date) => {
    const day = isoWeekday(date);
    const items = (byWeekday.get(day) ?? []).map(({ session, start }) => ({
      key: `${date}:${session.id}`,
      date,
      sessionId: session.id,
      title: session.title,
      category: session.category,
      room: session.room,
      capacity: session.capacity,
      durationMin: session.durationMin,
      start,
      end: addMinutes(start, session.durationMin),
    }));
    return items.sort((a, b) => (a.start === b.start ? a.title.localeCompare(b.title) : a.start.localeCompare(b.start)));
  };

  /** Слот по ключу «дата:занятие» или null. */
  const find = (key) => {
    if (typeof key !== 'string') return null;
    const i = key.indexOf(':');
    if (i < 8) return null;
    for (const slot of list(key.slice(0, i))) if (slot.key === key) return slot;
    return null;
  };

  return {
    compiled,
    list,
    find,
    /** Список дат вперед: today+0 … today+days-1. */
    window: (today, days) => Array.from({ length: days }, (_, i) => shiftDate(today, i)),
  };
}
