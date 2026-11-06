/**
 * Оплата переводом на Kaspi — общая часть для абонементов (payments.js)
 * и онлайн-билетов (visits.js).
 *
 * У Kaspi нет открытого API для небольших бизнесов (автоматическое подтверждение —
 * только по договору Kaspi Pay для e-commerce), поэтому схема ручная, но надёжная:
 *
 *   pending  ──клиент «Я оплатил»──▶ pending + kaspi.claimedAt (ждёт сверки)
 *            ──админ «Подтвердить»──▶ paid (чек HMAC, абонемент выдаётся)
 *            ──админ «Отклонить»───▶ cancelled (перевод не найден)
 *
 * Код оплаты (NP-XXXXX) клиент пишет в комментарии к переводу — по нему
 * администратор находит перевод в истории Kaspi. Цена — только с сервера.
 */

import { randomInt } from 'node:crypto';

// Без похожих символов (0/O, 1/I/L), чтобы код легко продиктовать и набрать.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function newPayCode() {
  let code = '';
  for (let i = 0; i < 5; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `NP-${code}`;
}

/** Номер для показа: +7 777 123 45 67. Остальные форматы отдаём как есть. */
export function formatPhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  const d = digits.length === 11 && digits.startsWith('8') ? `7${digits.slice(1)}` : digits;
  if (d.length !== 11 || !d.startsWith('7')) return String(phone ?? '');
  return `+7 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7, 9)} ${d.slice(9)}`;
}

/**
 * Реквизиты для клиента. enabled=false — номер не задан: сайт предлагает
 * оплату на кассе, заявка «Я оплатил» не принимается.
 */
export function kaspiInfo(config) {
  const { phone, receiver, payLink, qr } = config.kaspi ?? {};
  const enabled = config.paymentMode === 'kaspi' && Boolean(phone);
  return {
    method: config.paymentMode,
    enabled,
    phone: enabled ? formatPhone(phone) : null,
    receiver: enabled ? receiver : null,
    payLink: enabled ? payLink ?? null : null,
    qr: enabled ? qr ?? null : null,
  };
}

/** Что из Kaspi-статуса видно клиенту и админке. */
export function publicKaspi(record) {
  const k = record.kaspi ?? {};
  return {
    claimedAt: k.claimedAt ?? null,
    confirmedAt: k.confirmedAt ?? null,
    rejectedAt: k.rejectedAt ?? null,
    rejectReason: k.rejectReason ?? null,
  };
}

/** Короткий текст для Telegram. */
export function claimMessage({ kind, code, amount, who, publicUrl }) {
  const sum = `${new Intl.NumberFormat('ru-RU').format(amount)} ₸`;
  return [
    `💳 Клиент сообщил об оплате Kaspi`,
    `${kind}: ${sum}`,
    `Код в комментарии: ${code}`,
    who ? `Клиент: ${who}` : null,
    '',
    'Проверьте поступление в Kaspi и подтвердите в админке → «Оплаты».',
    publicUrl ? `${publicUrl.replace(/\/$/, '')}/admin` : null,
  ].filter((line) => line !== null).join('\n');
}
