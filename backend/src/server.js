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

loadDotEnv();
const config = readConfig();
const store = createFileStore(config.dataDir);
const notifier = createTelegramNotifier(config.telegram);
const accounts = createAccountStore(config.dataDir);
const orders = createOrderStore(config.dataDir);
const bookings = createBookingStore(config.dataDir);
const journal = createAudit(config.dataDir);

if (!process.env.PAYMENT_SECRET) {
  console.warn('[neptun] PAYMENT_SECRET не задан — подписи чеков живут только до перезапуска. Задайте переменную для продакшена.');
}

const server = http.createServer(createApp({ config, store, notifier, accounts, orders, bookings, journal }));
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
});

function shutdown(signal) {
  console.log(`[neptun] ${signal}: останавливаюсь…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
