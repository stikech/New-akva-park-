/**
 * Конфигурация из переменных окружения. Все значения — с безопасными дефолтами,
 * чтобы `npm start` работал без настройки.
 */

import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PAYMENT } from '../payment.config.js';

const BACKEND_DIR = fileURLToPath(new URL('..', import.meta.url));

/** Подхватывает backend/.env, если он есть (Node ≥ 21.7, без dotenv). */
export function loadDotEnv(file = path.join(BACKEND_DIR, '.env')) {
  if (existsSync(file)) process.loadEnvFile(file);
}

function int(value, fallback, { min = 0 } = {}) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function str(value) {
  const s = (value ?? '').trim();
  return s || null;
}

function httpsUrl(value, fallback) {
  const s = str(value);
  return s && s.startsWith('https://') ? s : fallback;
}

/** «Имя:пароль;Имя2:пароль2» → [{ name, password }]. Пароли короче 8 символов отбрасываем. */
export function parseStaff(value) {
  return String(value ?? '').split(/[;\n]/).map((pair) => {
    const i = pair.indexOf(':');
    if (i < 1) return null;
    const name = pair.slice(0, i).trim().slice(0, 40);
    const password = pair.slice(i + 1).trim();
    return name && password.length >= 8 ? { name, password } : null;
  }).filter(Boolean);
}

export function readConfig(env = process.env) {
  return {
    port: int(env.PORT, 3000),
    host: str(env.HOST) ?? '0.0.0.0',
    frontendDir: path.resolve(BACKEND_DIR, str(env.FRONTEND_DIR) ?? '../frontend'),
    publicDir: path.join(BACKEND_DIR, 'public'),
    dataDir: path.resolve(BACKEND_DIR, str(env.DATA_DIR) ?? 'data'),

    /** Токен для /admin. Без него админка отключена (503). */
    adminToken: str(env.ADMIN_TOKEN),

    /**
     * Ключ шифрования сессий (sealed-token.js). Должен быть постоянным, иначе после
     * перезапуска все выйдут из кабинета: SESSION_SECRET, а без него — из ADMIN_TOKEN.
     */
    sessionSecret: str(env.SESSION_SECRET) ?? str(env.ADMIN_TOKEN),

    /**
     * Секрет подписи платёжных чеков (HMAC-SHA256). Без него нельзя принимать
     * платежи — маршруты заказов просто не заведутся. Если переменной нет,
     * генерируем случайный на процесс: годится для разработки и демо, но
     * после перезапуска старые чеки перестанут «считаться» валидными
     * (данные не пропадут — применённые абонементы уже в accounts.json).
     */
    paymentSecret: str(env.PAYMENT_SECRET) ?? randomBytes(32).toString('hex'),

    /**
     * Способ оплаты: 'kaspi' (по умолчанию) — перевод на Kaspi с подтверждением в админке;
     * 'demo' — эмулятор карточного шлюза для тестов (любая карта по Луну «проходит»,
     * поэтому на боевом сайте его включать нельзя).
     */
    paymentMode: str(env.PAYMENT_MODE)?.toLowerCase() === 'demo' ? 'demo' : 'kaspi',

    /** Реквизиты Kaspi: backend/payment.config.js, переменные окружения важнее. */
    kaspi: {
      phone: str(env.KASPI_PHONE) ?? str(PAYMENT.kaspiPhone),
      receiver: str(env.KASPI_RECEIVER) ?? str(PAYMENT.receiverName) ?? 'Аквапарк «Нептун»',
      payLink: str(env.KASPI_PAY_LINK) ?? str(PAYMENT.kaspiPayLink),
      qr: str(env.KASPI_QR) ?? str(PAYMENT.kaspiQr),
    },

    /** Перевод на банковскую карту: номер из backend/payment.config.js, переменные окружения важнее. */
    cardTransfer: {
      number: str(env.PAY_CARD_NUMBER) ?? str(PAYMENT.cardNumber),
      bank: str(env.PAY_CARD_BANK) ?? str(PAYMENT.cardBank),
      holder: str(env.PAY_CARD_HOLDER) ?? str(PAYMENT.cardHolder),
    },

    /**
     * Оплата картой на сайте через TipTop Pay (tiptoppay.js). Секрет — только из окружения:
     * репозиторий публичный.
     */
    tiptoppay: {
      publicId: str(env.TIPTOPPAY_PUBLIC_ID) ?? str(PAYMENT.tiptoppayPublicId),
      apiSecret: str(env.TIPTOPPAY_API_SECRET),
      apiUrl: httpsUrl(env.TIPTOPPAY_API_URL, 'https://api.tiptoppay.kz'),
      scriptUrl: httpsUrl(env.TIPTOPPAY_SCRIPT_URL, 'https://checkout.tiptoppay.kz/checkout.js'),
    },

    /**
     * Входы сотрудников в /admin: STAFF_LOGINS="Арман:пароль-армана;Ержан:пароль-ержана".
     * Каждый входит своим паролем, в журнале видно, кто подтвердил оплату или отметил приход.
     * ADMIN_TOKEN остаётся паролем администратора.
     */
    staff: parseStaff(env.STAFF_LOGINS),

    /** Продавец в публичной оферте (/offer). */
    seller: {
      name: str(env.SELLER_NAME) ?? str(PAYMENT.sellerName),
      bin: str(env.SELLER_BIN) ?? str(PAYMENT.sellerBin),
    },

    /**
     * Постоянное хранение данных на бесплатном хостинге: копия DATA_DIR в Upstash Redis
     * (REST API, бесплатно). Без переменных — только локальные файлы.
     */
    backup: {
      url: str(env.UPSTASH_REDIS_REST_URL),
      token: str(env.UPSTASH_REDIS_REST_TOKEN),
    },

    /** Публичный адрес сайта — для ссылок в уведомлениях Telegram. */
    publicUrl: str(env.PUBLIC_URL) ?? str(env.RENDER_EXTERNAL_URL),

    /** Заготовленные демо-аккаунты кабинета (demo-accounts.js), пересоздаются при запуске. */
    demoAccounts: ['1', 'true', 'yes'].includes(String(env.DEMO_ACCOUNTS ?? '').trim().toLowerCase()),

    /** Уведомления о новых отзывах в Telegram — опционально. */
    telegram: {
      botToken: str(env.TELEGRAM_BOT_TOKEN),
      chatId: str(env.TELEGRAM_CHAT_ID),
    },

    /**
     * Сколько доверенных прокси стоит перед сервером (Render, nginx…).
     * 0 — X-Forwarded-For игнорируется, IP берётся из сокета.
     */
    trustProxyHops: int(env.TRUST_PROXY, 0),

    rateLimit: {
      max: int(env.FEEDBACK_RATE_MAX, 5, { min: 1 }),
      windowMs: int(env.FEEDBACK_RATE_WINDOW_MIN, 10, { min: 1 }) * 60_000,
    },
  };
}
