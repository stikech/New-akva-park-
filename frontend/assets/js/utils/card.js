/**
 * Правила платёжной карты: чистые функции, без DOM.
 * Используются и формой оплаты на фронте, и сервером (backend/src/payments.js),
 * чтобы правила не разъезжались: сервер никогда не доверяет фронту и
 * проверяет всё повторно. Покрыты тестами (frontend/tests, backend/tests).
 *
 * Данные карты НИКУДА не сохраняются: наружу отдаём только последние 4 цифры
 * и тип карты. Полный номер, CVC и дата живёт ровно до ответа сервера.
 */

export const CARD_LIMITS = { numberMin: 16, numberMax: 16, cvcMin: 3, cvcMax: 3, holderMax: 60, yearsAhead: 10 };

// Буквы любых алфавитов, пробел, дефис, точка, апостроф (латиница обязательна — на карте)
const CARDHOLDER_RE = /^[A-Za-z][A-Za-z .'’-]{1,59}$/;
const EXP_RE = /^(\d{2})\/(\d{2})$/;

/** Луна-проверка номера карты (алгоритм Luhn, длина 16). */
export function luhnValid(digits) {
  if (!/^\d{16}$/.test(digits)) return false;
  if (/^0+$/.test(digits)) return false; // нулевой «номер» Луну проходит — запрещаем явно
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = digits.charCodeAt(i) - 48;
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Что за карта: только определитель для отображения (<span class="card-brand">). */
export function cardBrand(digits) {
  if (!luhnValid(digits)) return null;
  if (/^4/.test(digits)) return 'Visa';
  if (/^5[1-5]/.test(digits) || /^2[2-7]/.test(digits)) return 'Mastercard';
  return 'Карта';
}

/** «4242 4242 4242 4242» → «4242424242424242»: только цифры. */
export function normalizeCardNumber(raw) {
  return String(raw ?? '').replace(/[^\d]/g, '');
}

/** Разбивает номер по 4: 4242424242424242 → 4242 4242 4242 4242 (для поля ввода). */
export function formatCardNumber(raw) {
  return normalizeCardNumber(raw).slice(0, 16).replace(/(\d{4})(?=\d)/g, '$1 ');
}

const isStr = (v) => typeof v === 'string';

/**
 * Проверяем карту целиком. Не храним картy — возвращаем только { last4, brand }.
 * @param {{ number: string, exp: string, cvc: string, holder: string }} input
 * @param {{ nowISO?: string }} ctx — момент «сейчас» (для сервера — clock())
 */
export function validateCard(input, { nowISO } = {}) {
  const errors = {};
  const number = normalizeCardNumber(input?.number);
  const exp = isStr(input?.exp) ? input.exp.replace(/\s/g, '') : '';
  const cvc = isStr(input?.cvc) ? input.cvc.replace(/[^\d]/g, '') : '';
  const holder = isStr(input?.holder) ? input.holder.trim() : '';

  if (!luhnValid(number)) errors.number = 'Такого номера карты не существует';
  if (holder && !CARDHOLDER_RE.test(holder)) errors.holder = 'Имя латиницей, как на карте';
  if (!holder) errors.holder = 'Введите имя владельца карты';
  if (!cvc || cvc.length < CARD_LIMITS.cvcMin || cvc.length > CARD_LIMITS.cvcMax) errors.cvc = 'CVC — 3 цифры на обороте';

  // Срок действия «MM/YY»: месяц 01–12, между прошлым месяцем и +N годами
  const m = EXP_RE.exec(exp);
  if (m) {
    const month = Number(m[1]);
    const year = 2000 + Number(m[2]);
    if (month < 1 || month > 12) errors.exp = 'Проверьте срок действия';
    else {
      const at = nowISO ? new Date(nowISO) : new Date();
      const lastValidDay = new Date(Date.UTC(year, month, 1));               // 1-е число следующего месяца
      const maxValidDay = new Date(Date.UTC(at.getUTCFullYear() + CARD_LIMITS.yearsAhead, 1, 1));
      if (lastValidDay <= at) errors.exp = 'Срок действия карты истёк';
      else if (lastValidDay > maxValidDay) errors.exp = 'Проверьте срок действия';
    }
  } else errors.exp = 'Срок в формате ММ/ГГ';

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { last4: number.slice(-4), brand: cardBrand(number) } };
}
