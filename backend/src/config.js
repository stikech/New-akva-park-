/**
 * Конфигурация из переменных окружения. Все значения — с безопасными дефолтами,
 * чтобы `npm start` работал без настройки.
 */

import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
     * Секрет подписи платёжных чеков (HMAC-SHA256). Без него нельзя принимать
     * платежи — маршруты заказов просто не заведутся. Если переменной нет,
     * генерируем случайный на процесс: годится для разработки и демо, но
     * после перезапуска старые чеки перестанут «считаться» валидными
     * (данные не пропадут — применённые абонементы уже в accounts.json).
     */
    paymentSecret: str(env.PAYMENT_SECRET) ?? randomBytes(32).toString('hex'),

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
