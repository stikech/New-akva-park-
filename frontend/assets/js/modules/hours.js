/** Таблица часов работы с подсветкой текущего дня. */

import { formatHour } from '../utils/format.js';

const DAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const WEEKEND_FROM_INDEX = 5;

export function renderHours(tbody, schedule, todayIndex) {
  tbody.innerHTML = DAYS.map((day, i) => {
    const [opens, closes] = schedule[i >= WEEKEND_FROM_INDEX ? 'weekend' : 'weekday'];
    const isToday = i === todayIndex;
    return `<tr class="${isToday ? 'today' : ''}">` +
      `<td>${day}${isToday ? ' (сегодня)' : ''}</td><td>${formatHour(opens)}–${formatHour(closes)}</td></tr>`;
  }).join('');
}
