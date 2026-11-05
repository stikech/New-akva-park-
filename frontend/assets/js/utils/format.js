/** Форматирование и экранирование. Чистые функции без DOM — покрыты тестами. */

/** Неразрывный пробел: цена «13 000 ₸» не должна разрываться переносом строки. */
export const NBSP = '\u00A0';

/** Пробелы, которые toLocaleString ставит между разрядами (обычный, NBSP, узкий NBSP). */
const GROUP_SPACES = /[ \u00A0\u202F]/g;

/** 13000 → "13 000 ₸" (пробелы неразрывные) */
export function formatPrice(amount) {
  return `${amount.toLocaleString('ru-RU').replace(GROUP_SPACES, NBSP)}${NBSP}₸`;
}

/** 9 → "09:00" */
export function formatHour(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

/** -14.4 → "−14°", 3 → "+3°", 0 → "0°" (типографский минус) */
export function formatTemperature(celsius) {
  const t = Math.round(celsius);
  const sign = t > 0 ? '+' : t < 0 ? '−' : '';
  return `${sign}${Math.abs(t)}°`;
}

/**
 * Русское склонение по числу: plural(4, ['посещение', 'посещения', 'посещений']) → "посещения".
 */
export function plural(n, [one, few, many]) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** "Руслан Касманов" → "РК" */
export function initials(fullName) {
  return fullName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Экранирование значений, подставляемых в innerHTML. Обязательно для данных из API. */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}
