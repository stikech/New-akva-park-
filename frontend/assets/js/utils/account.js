/**
 * Правила полей личного кабинета и расчёт статуса абонемента.
 * Чистые функции без DOM: их использует и страница /account, и сервер
 * (backend/src/accounts.js), чтобы правила не разъезжались. Покрыты тестами.
 */

export const ACCOUNT_LIMITS = { email: 254, passwordMin: 8, passwordMax: 128, name: 60 };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Буквы любых алфавитов, пробел, дефис, апостроф, точка: «Жан-Поль», «O'Neil», «Ә. Нұрлан»
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const LANGS = ['ru', 'kz'];

export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

/** «8 (705) 123-45-67», «+7 705 1234567» → «+77051234567»; иначе null. */
export function normalizePhone(phone) {
  const digits = String(phone ?? '').replace(/[\s()\-]/g, '');
  const m = /^(?:\+7|8|7)(\d{10})$/.exec(digits);
  return m ? `+7${m[1]}` : null;
}

/** «+77051234567» → «+7 705 123-45-67» */
export function formatPhone(phone) {
  const m = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(phone ?? '');
  return m ? `+7 ${m[1]} ${m[2]}-${m[3]}-${m[4]}` : (phone ?? '');
}

/** Проверяет «YYYY-MM-DD» на существующую дату. */
export function isValidDate(value) {
  const m = DATE_RE.exec(value ?? '');
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Дата «YYYY-MM-DD» по часам города (UTC+tzOffsetHours). */
export function cityDateString(tzOffsetHours, date = new Date()) {
  return new Date(date.getTime() + tzOffsetHours * 3_600_000).toISOString().slice(0, 10);
}

/** «2026-11-04» + 2 месяца → «2027-01-03» (последний день действия включительно). */
export function addMonths(isoDate, months) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  target.setUTCDate(target.getUTCDate() - 1);
  return target.toISOString().slice(0, 10);
}

/** Разница в днях между датами «YYYY-MM-DD» (b − a). */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Полных лет на дату today: ageOn('1995-03-08', '2026-03-07') → 30. */
export function ageOn(birthDate, today) {
  if (!isValidDate(birthDate) || !isValidDate(today)) return null;
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/** Поля профиля, которые клиент заполняет сам (для подсказки «профиль заполнен на N%»). */
export const PROFILE_FIELDS = [
  { key: 'firstName', label: 'Имя' },
  { key: 'lastName', label: 'Фамилия' },
  { key: 'phone', label: 'Телефон' },
  { key: 'birthDate', label: 'Дата рождения' },
];

/** @returns {{ percent: number, missing: string[] }} */
export function profileCompleteness(user) {
  const missing = PROFILE_FIELDS.filter((f) => !user?.[f.key]).map((f) => f.label);
  return { percent: Math.round(((PROFILE_FIELDS.length - missing.length) / PROFILE_FIELDS.length) * 100), missing };
}

const isString = (v) => typeof v === 'string';

/** Регистрация: { email, password, firstName, consent }. */
export function validateRegistration(input) {
  const errors = {};
  const email = normalizeEmail(input?.email);
  const password = isString(input?.password) ? input.password : '';
  const firstName = isString(input?.firstName) ? input.firstName.trim() : '';

  if (!EMAIL_RE.test(email) || email.length > ACCOUNT_LIMITS.email) errors.email = 'Проверьте адрес почты';
  const pwError = passwordError(password);
  if (pwError) errors.password = pwError;
  const nameError = personNameError(firstName, { required: true });
  if (nameError) errors.firstName = nameError;
  if (input?.consent !== true) errors.consent = 'Нужно согласие на обработку персональных данных';

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { email, password, firstName } };
}

export function passwordError(password) {
  if (!isString(password) || password.length < ACCOUNT_LIMITS.passwordMin) {
    return `Пароль — не короче ${ACCOUNT_LIMITS.passwordMin} символов`;
  }
  if (password.length > ACCOUNT_LIMITS.passwordMax) return `Пароль — не длиннее ${ACCOUNT_LIMITS.passwordMax} символов`;
  return null;
}

function personNameError(name, { required }) {
  if (!name) return required ? 'Укажите имя' : null;
  if (name.length > ACCOUNT_LIMITS.name) return `Не больше ${ACCOUNT_LIMITS.name} символов`;
  if (!NAME_RE.test(name)) return 'Только буквы, пробел и дефис';
  return null;
}

/**
 * Личные данные из профиля. Пустая строка = очистить необязательное поле.
 * Неизвестные ключи игнорируются; передавать можно только изменившиеся поля.
 * @param {object} input
 * @param {{ today: string }} ctx  сегодняшняя дата «YYYY-MM-DD» (для даты рождения)
 */
export function validateProfile(input, { today }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: { form: 'Некорректные данные формы' } };
  }
  const errors = {};
  const value = {};

  for (const field of ['firstName', 'lastName', 'phone', 'birthDate']) {
    if (!(field in input)) continue;
    if (input[field] !== null && !isString(input[field])) {
      errors[field] = 'Ожидается строка';
      continue;
    }
    const raw = (input[field] ?? '').trim();

    if (field === 'firstName' || field === 'lastName') {
      const err = personNameError(raw, { required: field === 'firstName' });
      if (err) errors[field] = err;
      else value[field] = raw || null;
    } else if (field === 'phone') {
      if (!raw) value.phone = null;
      else {
        const phone = normalizePhone(raw);
        if (phone) value.phone = phone;
        else errors.phone = 'Номер в формате +7 7XX XXX-XX-XX';
      }
    } else if (field === 'birthDate') {
      if (!raw) value.birthDate = null;
      else if (!isValidDate(raw) || raw < '1900-01-01' || raw > today) errors.birthDate = 'Проверьте дату рождения';
      else value.birthDate = raw;
    }
  }

  if ('lang' in input) {
    if (LANGS.includes(input.lang)) value.lang = input.lang;
    else errors.lang = 'Неизвестный язык';
  }

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

/**
 * Статус абонемента на дату `today`.
 * @param {null | { startsAt: string, endsAt: string|null, visitsTotal: number|null, visitsUsed: number }} m
 * @returns {{ code: 'none'|'scheduled'|'active'|'expired'|'used_up', label: string,
 *             visitsLeft: number|null, daysLeft: number|null }}
 */
export function membershipStatus(m, today) {
  if (!m) return { code: 'none', label: 'Нет абонемента', visitsLeft: null, daysLeft: null };
  const visitsLeft = m.visitsTotal == null ? null : Math.max(0, m.visitsTotal - m.visitsUsed);
  const daysLeft = m.endsAt ? daysBetween(today, m.endsAt) + 1 : null; // день окончания включительно

  if (today < m.startsAt) return { code: 'scheduled', label: 'Ещё не начал действовать', visitsLeft, daysLeft };
  if (m.endsAt && today > m.endsAt) return { code: 'expired', label: 'Срок действия истёк', visitsLeft, daysLeft: 0 };
  if (visitsLeft === 0) return { code: 'used_up', label: 'Посещения закончились', visitsLeft, daysLeft };
  return { code: 'active', label: 'Действует', visitsLeft, daysLeft };
}
