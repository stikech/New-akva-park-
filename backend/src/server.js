/** Точка входа: читает конфиг, собирает зависимости, слушает порт. */

import http from 'node:http';
import { loadDotEnv, readConfig } from './config.js';
import { createApp } from './app.js';
import { createFileStore } from './store.js';
import { createTelegramNotifier } from './notify.js';
import { createAccountStore } from './account-store.js';
import { createOrderStore } from './order-store.js';
import { createBookingStore } from './booking-store.js';
import { createAudit } from './audit.js';
import { createCloudBackup } from './cloud-backup.js';

loadDotEnv();
const config = readConfig();

// Сначала возвращаем данные из облачной копии — до того, как их прочитают сторы.
const backup = createCloudBackup(config.backup, config.dataDir);
if (backup.enabled) {
  let restored = null;
  for (let attempt = 1; attempt <= 3 && restored === null; attempt += 1) {
    try {
      restored = await backup.restore();
    } catch (error) {
      console.error(`[backup] попытка ${attempt}: облачная копия недоступна —`, error.message);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  if (restored === null) {
    // Пустые локальные файлы нельзя заливать поверх облака — работаем без копии.
    console.error('[backup] ВНИМАНИЕ: копия не загружена, изменения этого запуска не сохранятся в облаке');
  } else {
    console.log(`[backup] восстановлено файлов из облака: ${restored}`);
    backup.watch();
  }
}
const store = createFileStore(config.dataDir);
const notifier = createTelegramNotifier(config.telegram);
const accounts = createAccountStore(config.dataDir, { sessionKey: config.sessionSecret });
const orders = createOrderStore(config.dataDir);
const bookings = createBookingStore(config.dataDir);
const journal = createAudit(config.dataDir);

if (!process.env.PAYMENT_SECRET) {
  console.warn('[neptun] PAYMENT_SECRET не задан — подписи чеков живут только до перезапуска. Задайте переменную для продакшена.');
}

const server = http.createServer(createApp({ config, store, notifier, accounts, orders, bookings, journal, backup }));
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;

server.listen(config.port, config.host, () => {
  console.log(`[neptun] http://localhost:${config.port}  (host ${config.host})`);
  console.log(`[neptun] отзывы: ${store.file}`);
  console.log(`[neptun] аккаунты: ${accounts.file}`);
  console.log(`[neptun] заказы: ${orders.file}`);
  console.log(`[neptun] записи: ${bookings.file}`);
  console.log(`[neptun] аудит: ${journal.file}`);
  console.log(`[neptun] админка: ${config.adminToken ? '/admin' : 'выключена (нет ADMIN_TOKEN)'}`);
  console.log(`[neptun] Telegram-уведомления: ${notifier.enabled ? 'вкл' : 'выкл'}`);
  console.log(`[neptun] облачная копия данных: ${backup.enabled ? 'Upstash' : 'выкл (данные только на диске)'}`);
  console.log(`[neptun] оплата: ${config.paymentMode === 'demo' ? 'ДЕМО-эмулятор карт' : config.kaspi.phone ? `Kaspi ${config.kaspi.phone}` : 'Kaspi — номер не задан (backend/payment.config.js), онлайн-оплата выключена'}`);
});

function shutdown(signal) {
  console.log(`[neptun] ${signal}: останавливаюсь…`);
  // Дожидаемся отправки последних изменений в облако, потом выходим.
  server.close(() => backup.flush().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
