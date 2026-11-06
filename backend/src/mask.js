/** Маскировка персональных данных в ответах админки для пробных (демо) сотрудников. */

/** Скрывает телефоны и почты для пробных сотрудников (кроме демо-клиентов @neptun.kz). */
export function maskPersonal(value) {
  if (Array.isArray(value)) return value.map(maskPersonal);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'email' && typeof v === 'string' && !v.endsWith('@neptun.kz')) out[k] = v.replace(/^(.).*(@.*)$/, '$1•••$2');
    else if (k === 'phone' && typeof v === 'string') out[k] = v.replace(/^(\+?\d{2,4})\d+(\d{2})$/, '$1•••••$2');
    else out[k] = maskPersonal(v);
  }
  return out;
}
