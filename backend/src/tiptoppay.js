/**
 * Оплата картой через TipTop Pay (бывший CloudPayments Kazakhstan) — интернет-эквайринг.
 *
 * Как это устроено:
 *   1. На странице /checkout покупатель вводит карту в НАШИ поля (номер, срок, CVC, имя).
 *   2. Скрипт TipTop Pay (checkout.js) прямо в браузере шифрует карту в «криптограмму» —
 *      номер карты и CVC на наш сервер не попадают никогда (требование PCI DSS).
 *   3. Сервер отправляет криптограмму и сумму в API TipTop Pay (payments/cards/charge).
 *   4. Банк просит 3-D Secure → покупатель подтверждает платёж кодом из SMS / в приложении банка,
 *      банк возвращает его на /api/checkout/3ds → сервер завершает платёж (payments/cards/post3ds).
 *   5. Деньги зачисляются на расчётный счёт, указанный в договоре с TipTop Pay.
 *
 * Ключи: Public ID — в backend/payment.config.js или TIPTOPPAY_PUBLIC_ID;
 * API Secret — ТОЛЬКО переменной окружения TIPTOPPAY_API_SECRET (репозиторий публичный).
 *
 * Документация: https://developers.tiptoppay.kz/
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const CURRENCY = 'KZT';

/** Что видит браузер. API Secret наружу не отдаётся никогда. */
export function cardInfo(config) {
  const t = config.tiptoppay ?? {};
  if (config.paymentMode === 'demo') return { enabled: true, provider: 'demo', publicId: null, scriptUrl: null };
  if (!t.publicId || !t.apiSecret) return { enabled: false };
  return { enabled: true, provider: 'tiptoppay', publicId: t.publicId, scriptUrl: t.scriptUrl };
}

/**
 * Клиент API. fetchImpl подменяется в тестах.
 * Ответ API: { Success, Message, Model: { TransactionId, Status, CardLastFour, CardType, AcsUrl, PaReq, CardHolderMessage, ReasonCode } }.
 */
export function createTipTopPay({ publicId, apiSecret, apiUrl = 'https://api.tiptoppay.kz' }, { fetchImpl = fetch, log = console } = {}) {
  const auth = `Basic ${Buffer.from(`${publicId}:${apiSecret}`).toString('base64')}`;

  async function call(path, body) {
    let response;
    try {
      response = await fetchImpl(`${apiUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      log.error?.(`[tiptoppay] ${path}: сеть недоступна —`, error.message);
      return { kind: 'error', message: 'Платёжный сервис временно недоступен. Попробуйте через минуту.' };
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      log.error?.(`[tiptoppay] ${path}: HTTP ${response.status}`);
      return { kind: 'error', message: 'Платёжный сервис временно недоступен. Попробуйте через минуту.' };
    }
    return interpret(data);
  }

  return {
    /** Одностадийная оплата по криптограмме. */
    charge({ cryptogram, amount, invoiceId, description, ip, email, name, accountId }) {
      return call('/payments/cards/charge', {
        Amount: amount,
        Currency: CURRENCY,
        IpAddress: ip,
        CardCryptogramPacket: cryptogram,
        Name: name || undefined,
        InvoiceId: invoiceId,
        Description: description,
        AccountId: accountId || undefined,
        Email: email || undefined,
        CultureName: 'ru-RU',
      });
    },

    /** Завершение после 3-D Secure: MD (= TransactionId) и PaRes пришли от банка. */
    post3ds({ transactionId, paRes }) {
      return call('/payments/cards/post3ds', { TransactionId: Number(transactionId), PaRes: paRes });
    },
  };
}

/**
 * Ответ API → { kind: 'paid' | '3ds' | 'declined' | 'error', ... }.
 * Успех — Success=true и статус Completed/Authorized.
 */
export function interpret(data) {
  const m = data?.Model ?? {};
  if (data?.Success === true && ['Completed', 'Authorized'].includes(m.Status)) {
    return { kind: 'paid', transactionId: m.TransactionId, last4: m.CardLastFour ?? null, brand: m.CardType ?? null };
  }
  if (data?.Success === false && m.AcsUrl && m.PaReq) {
    return { kind: '3ds', transactionId: m.TransactionId, acsUrl: m.AcsUrl, paReq: m.PaReq };
  }
  if (data?.Success === false && m.TransactionId) {
    return {
      kind: 'declined',
      transactionId: m.TransactionId,
      message: m.CardHolderMessage || 'Банк отклонил платёж. Попробуйте другую карту.',
      reasonCode: m.ReasonCode ?? null,
    };
  }
  return { kind: 'error', message: data?.Message || 'Не удалось провести платёж. Попробуйте ещё раз.' };
}

/** Подпись уведомлений TipTop Pay (как у CloudPayments): Base64(HMAC-SHA256(тело, API Secret)). */
export function verifyNotification(rawBody, headers, apiSecret) {
  if (!apiSecret) return false;
  const expected = Buffer.from(createHmac('sha256', apiSecret).update(rawBody).digest('base64'));
  for (const name of ['content-hmac', 'x-content-hmac']) {
    const given = Buffer.from(String(headers[name] ?? ''));
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

/**
 * Эмулятор для PAYMENT_MODE=demo (тесты и локальная разработка): «карта» — это строка
 * demo:<16 цифр>. Номер на 0002 — отказ банка, на 3333 — 3-D Secure, остальные — успех.
 * На боевом сайте не включается: cardInfo() отдаёт demo только при PAYMENT_MODE=demo.
 */
export function createDemoGateway() {
  return {
    async charge({ cryptogram }) {
      const digits = String(cryptogram ?? '').replace(/^demo:/, '');
      if (!/^\d{16}$/.test(digits)) return { kind: 'error', message: 'Некорректные данные карты' };
      const last4 = digits.slice(-4);
      if (last4 === '0002') return { kind: 'declined', transactionId: 1, message: 'Банк отклонил платёж. Попробуйте другую карту.' };
      if (last4 === '3333') return { kind: '3ds', transactionId: 3333, acsUrl: '/api/checkout/demo-acs', paReq: 'demo' };
      return { kind: 'paid', transactionId: Date.now(), last4, brand: digits.startsWith('4') ? 'Visa' : 'Mastercard' };
    },
    async post3ds({ transactionId, paRes }) {
      if (paRes !== 'ok') return { kind: 'declined', transactionId, message: '3-D Secure не пройден' };
      return { kind: 'paid', transactionId, last4: '3333', brand: 'Visa' };
    },
  };
}
