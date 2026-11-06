/**
 * Хранилище заказов корзины: DATA_DIR/checkout-orders.json.
 * Тот же принцип, что у остальных сторов: данные в памяти, файл перезаписывается
 * целиком (временный файл + rename), записи строго по очереди.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const PENDING_TTL_MS = 24 * 3_600_000; // неоплаченный заказ живёт сутки, потом «истёк»

export function createCheckoutStore(dataDir, { now = () => Date.now() } = {}) {
  const file = path.join(dataDir, 'checkout-orders.json');
  let state = null;
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

  const find = (s, pred) => s.orders.find(pred) ?? null;

  return {
    file,

    /** Создаёт заказ. Повтор с тем же Idempotency-Key (и тем же владельцем) вернёт существующий. */
    create(fields, { idempotencyKey, now: isoNow }) {
      return mutate((s) => {
        const existing = find(s, (o) => o.idempotencyKey === idempotencyKey && o.userId === (fields.userId ?? null));
        if (existing) return { order: existing, created: false };
        const order = {
          id: randomUUID(),
          ...fields,
          userId: fields.userId ?? null,
          status: 'pending',
          method: null,
          claim: null,
          card: null,
          attempts: [],
          receipt: null,
          fulfilled: null,
          paidAt: null,
          paidBy: null,
          usedAt: null,
          usedBy: null,
          cancelledAt: null,
          rejectReason: null,
          idempotencyKey,
          createdAt: isoNow,
          updatedAt: isoNow,
        };
        s.orders.push(order);
        return { order, created: true };
      });
    },

    byId: (id) => load().then((s) => find(s, (o) => o.id === id)),
    byCode: (code) => load().then((s) => find(s, (o) => o.code === code)),
    byTransaction: (txId) => load().then((s) => find(s, (o) => o.card?.threeDs && String(o.card.threeDs.transactionId) === String(txId))),

    listByUser: (userId, { limit = 30 } = {}) => load().then((s) => s.orders
      .filter((o) => o.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)),

    listAll: ({ limit = 500 } = {}) => load().then((s) => [...s.orders]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)),

    /** Изменение одного заказа. fn получает запись, возвращённое значение — результат patch. */
    patch(id, fn) {
      return mutate((s) => {
        const order = find(s, (o) => o.id === id);
        if (!order) return null;
        const result = fn(order);
        order.updatedAt = new Date(now()).toISOString();
        return result ?? order;
      });
    },

    /** Просроченные неоплаченные заказы → expired (кроме тех, где клиент сообщил о переводе). */
    sweepExpired() {
      const t = now();
      return mutate((s) => {
        let n = 0;
        for (const o of s.orders) {
          if (o.status === 'pending' && !o.claim && Date.parse(o.createdAt) + PENDING_TTL_MS < t) {
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
