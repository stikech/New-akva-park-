/**
 * Rate limit в памяти: скользящее окно по ключу (IP).
 * Для одного инстанса этого достаточно; при нескольких — вынести в Redis.
 */
export function createRateLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map(); // key → массив таймстемпов

  function prune(key, t) {
    const list = (hits.get(key) ?? []).filter((ts) => t - ts < windowMs);
    if (list.length) hits.set(key, list);
    else hits.delete(key);
    return list;
  }

  return {
    /** @returns {{ ok: true } | { ok: false, retryAfterSec: number }} */
    hit(key) {
      const t = now();
      const list = prune(key, t);
      if (list.length >= max) {
        return { ok: false, retryAfterSec: Math.ceil((list[0] + windowMs - t) / 1000) };
      }
      list.push(t);
      hits.set(key, list);
      return { ok: true };
    },

    /** Проверка без записи попытки — для лимита только на неудачи (неверный пароль). */
    check(key) {
      const t = now();
      const list = prune(key, t);
      if (list.length >= max) return { ok: false, retryAfterSec: Math.ceil((list[0] + windowMs - t) / 1000) };
      return { ok: true };
    },

    /** Сбросить счётчик ключа (например, после успешного входа). */
    reset(key) {
      hits.delete(key);
    },

    /** Периодическая очистка, чтобы Map не рос бесконечно. */
    sweep() {
      const t = now();
      for (const key of hits.keys()) prune(key, t);
    },

    get size() {
      return hits.size;
    },
  };
}
