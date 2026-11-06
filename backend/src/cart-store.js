/**
 * Хранилище заказов корзины: один JSON-файл DATA_DIR/cart-orders.json.
 * Тот же подход, что у visit-store.js (покупка без входа, идемпотентность по ключу),
 * но заказ содержит несколько позиций из разных сфер: аквапарк, бассейн, фитнес, SPA.
 *
 * - Данные в памяти, файл перезаписывается целиком: временный файл + rename (атомарно).
 * - Мутации идут строго по очереди (promise-цепочка): параллельные запросы не гоняются.
 * - Повторный create с тем же Idempotency-Key возвращает уже созданный заказ.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const PENDING_TTL_MS = 24 * 3_600_000; // неоплаченный заказ живёт 24 часа, потом «истёк»

export function createCartStore(dataDir, { now = () => Date.now() } = {}) {
  const file = path.join(dataDir, 'cart-orders.json');
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
    queue = run.catch(() => {});
    return run;
  }

  const find = (s, id) => s.orders.find((o) => o.id === id) ?? null;

  return {
    file,

    create({ email, firstName, phone, userId, items, total, idempotencyKey, now: isoNow }) {
      return mutate((s) => {
        const existing = s.orders.find((o) => o.idempotencyKey === idempotencyKey);
        if (existing) return { order: existing, created: false };
        const order = {
          id: randomUUID(),
          email,
          firstName,
          phone: phone ?? null,
          userId: userId ?? null,
          items,
          total,
          status: 'pending',
          createdAt: isoNow,
          updatedAt: isoNow,
          idempotencyKey,
          attempts: [],
          paidAt: null,
          receipt: null,
        };
        s.orders.push(order);
        return { order, created: true };
      });
    },

    byId(id) {
      return load().then((s) => find(s, id));
    },

    listAll({ limit = 500 } = {}) {
      return load().then((s) => [...s.orders]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit));
    },

    patch(id, fn) {
      return mutate((s) => {
        const order = find(s, id);
        if (!order) return null;
        const result = fn(order);
        order.updatedAt = new Date(now()).toISOString();
        return result ?? order;
      });
    },

    sweepExpired() {
      const t = now();
      return mutate((s) => {
        let n = 0;
        for (const o of s.orders) {
          if (o.status === 'pending' && Date.parse(o.createdAt) + PENDING_TTL_MS < t) {
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
