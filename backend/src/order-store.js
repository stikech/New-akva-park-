/**
 * Хранилище заказов: один JSON-файл DATA_DIR/orders.json, как у аккаунтов.
 *
 * - Данные в памяти, файл перезаписывается целиком: временный файл + rename (атомарно).
 * - Записи идут строго по очереди (promise-цепочка): параллельные запросы не гоняются.
 * - Идемпотентность: ключ придёт с фронта (Idempotency-Key) и хранится в записи
 *   заказа — повторный запрос с тем же ключом возвращает тот же заказ.
 *
 * Объём: тысячи заказов хватает; интерфейс { create, find, all, patch } позволяет
 * позже перейти на SQLite/Postgres без правки маршрутов.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const PENDING_TTL_MS = 24 * 3_600_000; // неоплаченный заказ живёт 24 часа, потом «истёк»

export const ORDER_STATUS = { pending: 'pending', paid: 'paid', cancelled: 'cancelled', expired: 'expired' };

export function createOrderStore(dataDir, { now = () => Date.now() } = {}) {
  const file = path.join(dataDir, 'orders.json');
  let state = null; // { version, orders: [] }
  let loading = null;
  let queue = Promise.resolve();

  async function load() {
    if (state) return state;
    loading ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        state = { version: 1, orders: Array.isArray(parsed.orders) ? parsed.orders : [] };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error; // битый файл не затираем молча
        state = { version: 1, orders: [] };
      }
      return state;
    })();
    return loading;
  }

  /** Применяет изменение и сохраняет файл строго по очереди. */
  function mutate(fn) {
    const run = queue.then(async () => {
      const s = await load();
      const result = fn(s);
      await mkdir(dataDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(s), { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, file);
      return result;
    });
    queue = run.catch(() => {}); // ошибка одной записи не блокирует следующие
    return run;
  }

  const byId = (s, id) => s.orders.find((o) => o.id === id) ?? null;
  const byKey = (s, userId, key) => s.orders.find((o) => o.userId === userId && o.idempotencyKey === key) ?? null;

  return {
    file,

    /** Создаёт pending-заказ. Если ключ уже использован этим пользователем — вернёт существующий. */
    create({ userId, planId, category, title, price, payCode = null, idempotencyKey, now: isoNow }) {
      return mutate((s) => {
        const existing = byKey(s, userId, idempotencyKey);
        if (existing) return { order: existing, created: false };
        const order = {
          id: randomUUID(),
          userId,
          planId,
          category,
          title,
          price,
          payCode,
          status: ORDER_STATUS.pending,
          createdAt: isoNow,
          updatedAt: isoNow,
          idempotencyKey,
          attempts: [],
          paidAt: null,
          cancelledAt: null,
          receipt: null,
          kaspi: null,
          applied: false,
        };
        s.orders.push(order);
        return { order, created: true };
      });
    },

    byIdOrder(id) {
      return load().then((s) => byId(s, id));
    },

    listByUser(userId, { limit = 30 } = {}) {
      return load().then((s) => s.orders
        .filter((o) => o.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit));
    },

    listAll({ limit = 500 } = {}) {
      return load().then((s) => [...s.orders]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit));
    },

    patch(id, fn) {
      return mutate((s) => {
        const order = byId(s, id);
        if (!order) return null;
        const result = fn(order);
        order.updatedAt = new Date(now()).toISOString();
        return result ?? order;
      });
    },

    /** Пользователь — по заказу. Для проверки права на заказ перед мутацией. */
    ownerOf(id) {
      return load().then((s) => byId(s, id)?.userId ?? null);
    },

    /** Просроченные pending-заказы → expired. Вызывается периодически. */
    sweepExpired() {
      const t = now();
      return mutate((s) => {
        let n = 0;
        for (const o of s.orders) {
          // клиент сообщил об оплате Kaspi — ждёт сверки администратором, не истекает
          if (o.status === 'pending' && !o.kaspi?.claimedAt && Date.parse(o.createdAt) + PENDING_TTL_MS < t) {
            o.status = 'expired';
            o.updatedAt = new Date(t).toISOString();
            n += 1;
          }
        }
        return n;
      });
    },
  };
}
