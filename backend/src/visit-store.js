/**
 * Хранилище визитов (онлайн-билеты аквапарка): один JSON-файл DATA_DIR/visits.json.
 * По образцу order-store.js, но отдельно: визит покупается без входа в кабинет
 * (анонимная покупка на калькуляторе главной), поэтому не годится под orders.json,
 * где заказ жёстко привязан к пользователю (userId, planId) и всегда выдаёт абонемент.
 *
 * - Данные в памяти, файл перезаписывается целиком: временный файл + rename (атомарно).
 * - Мутации идут строго по очереди (promise-цепочка): параллельные запросы не гоняются.
 * - Идемпотентность: ключ приходит с фронта (Idempotency-Key) и хранится в записи —
 *   повторный запрос с тем же ключом возвращает ту же покупку.
 *
 * Объём и интерфейс { create, byId, listAll, patch, sweepExpired } позволяют позже
 * перейти на SQLite/Postgres без правки маршрутов.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const PENDING_TTL_MS = 24 * 3_600_000; // неоплаченный визит живёт 24 часа, потом «истёк»

export const VISIT_STATUS = { pending: 'pending', paid: 'paid', cancelled: 'cancelled', expired: 'expired' };

export function createVisitStore(dataDir, { now = () => Date.now() } = {}) {
  const file = path.join(dataDir, 'visits.json');
  let state = null; // { version, visits: [] }
  let loading = null;
  let queue = Promise.resolve();

  async function load() {
    if (state) return state;
    loading ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        state = { version: 1, visits: Array.isArray(parsed.visits) ? parsed.visits : [] };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error; // битый файл не затираем молча
        state = { version: 1, visits: [] };
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

  const byId = (s, id) => s.visits.find((v) => v.id === id) ?? null;

  return {
    file,

    /** Создаёт запись визита. Повтор с тем же ключом идемпотентности вернёт существующий. */
    create({ email, firstName, userId, phone, adults, children, day, duration, price, payCode = null, consentAt = null, idempotencyKey, now: isoNow }) {
      return mutate((s) => {
        const existing = s.visits.find((v) => v.idempotencyKey === idempotencyKey);
        if (existing) return { visit: existing, created: false };
        const visit = {
          id: randomUUID(),
          email,
          firstName,
          phone: phone ?? null,
          userId: userId ?? null,
          adults,
          children,
          day,
          duration,
          price,
          payCode,
          consentAt,
          status: VISIT_STATUS.pending,
          createdAt: isoNow,
          updatedAt: isoNow,
          idempotencyKey,
          attempts: [],
          paidAt: null,
          cancelledAt: null,
          receipt: null,
          kaspi: null,
          usedAt: null,
        };
        s.visits.push(visit);
        return { visit, created: true };
      });
    },

    byId(id) {
      return load().then((s) => byId(s, id));
    },

    listAll({ limit = 500 } = {}) {
      return load().then((s) => [...s.visits]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit));
    },

    patch(id, fn) {
      return mutate((s) => {
        const visit = byId(s, id);
        if (!visit) return null;
        const result = fn(visit);
        visit.updatedAt = new Date(now()).toISOString();
        return result ?? visit;
      });
    },

    /** Просроченные pending-визиты → expired. Вызывается периодически. */
    sweepExpired() {
      const t = now();
      return mutate((s) => {
        let n = 0;
        for (const v of s.visits) {
          // клиент сообщил об оплате Kaspi — ждёт сверки администратором, не истекает
          if (v.status === 'pending' && !v.kaspi?.claimedAt && Date.parse(v.createdAt) + PENDING_TTL_MS < t) {
            v.status = 'expired';
            v.updatedAt = new Date(t).toISOString();
            n += 1;
          }
        }
        return n;
      });
    },
  };
}
