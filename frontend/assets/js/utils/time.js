/**
 * Время работы. Чистые функции без DOM — покрыты тестами.
 *
 * Все вычисления ведутся в местном времени Петропавловска независимо от
 * часового пояса посетителя: создаётся Date, чьи getHours()/getDay()
 * возвращают значения города.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Текущий момент «по часам города». */
export function cityNow(tzOffsetHours, date = new Date()) {
  return new Date(date.getTime() + date.getTimezoneOffset() * MINUTE_MS + tzOffsetHours * HOUR_MS);
}

export function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

/** Тип дня для тарифов и расписания. */
export function dayType(date) {
  return isWeekend(date) ? 'weekend' : 'weekday';
}

/** Индекс дня недели с понедельника: Пн = 0 … Вс = 6. */
export function weekdayIndex(date) {
  return (date.getDay() + 6) % 7;
}

/**
 * Статус работы на момент `now`.
 * @param {{ weekday: [number, number], weekend: [number, number] }} schedule
 * @param {Date} now  результат cityNow()
 * @returns {{ isOpen: boolean, closesAt: number, opensAt: number }}
 */
export function getOpenStatus(schedule, now) {
  const hour = now.getHours() + now.getMinutes() / 60;
  const [opensToday, closesToday] = schedule[dayType(now)];

  if (hour >= opensToday && hour < closesToday) {
    return { isOpen: true, closesAt: closesToday, opensAt: opensToday };
  }
  if (hour < opensToday) {
    return { isOpen: false, closesAt: closesToday, opensAt: opensToday };
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return { isOpen: false, closesAt: closesToday, opensAt: schedule[dayType(tomorrow)][0] };
}
