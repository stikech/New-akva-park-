/**
 * Постоянное хранение данных на бесплатном хостинге.
 *
 * На бесплатном Render диск временный: при каждом деплое и «засыпании» файлы
 * DATA_DIR (аккаунты, заказы, билеты, отзывы) стираются. Этот модуль держит
 * копию каждого файла в Upstash Redis (бесплатно, без карты, REST API —
 * никаких npm-зависимостей):
 *
 *   - при запуске restore() скачивает файлы до того, как их прочитают сторы;
 *   - watch() следит за DATA_DIR и через секунду после изменения отправляет файл;
 *   - flush() дожидается отправки при остановке (SIGTERM от хостинга).
 *
 * Сторы ничего не знают о копии — работают с файлами как раньше.
 * Без UPSTASH_REDIS_REST_URL / _TOKEN модуль выключен.
 */

import { watch as watchDir } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const HASH_KEY = 'neptun:data';
const FILE_RE = /^[a-z-]+\.(json|jsonl)$/; // временные *.tmp и посторонние файлы пропускаем
const DEBOUNCE_MS = 1000;

export function createCloudBackup({ url, token }, dataDir, { fetchImpl = fetch, log = console } = {}) {
  if (!url || !token) {
    return { enabled: false, async restore() { return 0; }, watch() {}, async flush() {} };
  }

  async function command(args) {
    const response = await fetchImpl(url.replace(/\/$/, ''), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(data.error ?? `Upstash HTTP ${response.status}`);
    return data.result;
  }

  const timers = new Map();
  const inflight = new Set();

  async function upload(name) {
    let body;
    try {
      body = await readFile(path.join(dataDir, name), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    await command(['HSET', HASH_KEY, name, body]);
  }

  function schedule(name) {
    clearTimeout(timers.get(name));
    timers.set(name, setTimeout(() => {
      timers.delete(name);
      const job = upload(name)
        .catch((error) => log.error(`[backup] не удалось сохранить ${name}:`, error.message))
        .finally(() => inflight.delete(job));
      inflight.add(job);
    }, DEBOUNCE_MS));
  }

  return {
    enabled: true,

    /** Скачивает сохранённые файлы в DATA_DIR. Возвращает число файлов. */
    async restore() {
      await mkdir(dataDir, { recursive: true });
      const flat = await command(['HGETALL', HASH_KEY]) ?? [];
      let n = 0;
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const name = flat[i];
        if (!FILE_RE.test(name)) continue;
        await writeFile(path.join(dataDir, name), flat[i + 1], { encoding: 'utf8', mode: 0o600 });
        n += 1;
      }
      // Файлы, которых ещё нет в облаке (первый запуск с копией), — отправляем сразу.
      const local = (await readdir(dataDir)).filter((f) => FILE_RE.test(f));
      const remote = new Set(flat.filter((_, i) => i % 2 === 0));
      for (const name of local) if (!remote.has(name)) schedule(name);
      return n;
    },

    watch() {
      const watcher = watchDir(dataDir, (event, name) => {
        if (name && FILE_RE.test(name)) schedule(name);
      });
      watcher.unref();
    },

    /** Немедленно отправляет всё, что ждёт отправки (перед остановкой). */
    async flush() {
      const pending = [...timers.keys()];
      for (const name of pending) clearTimeout(timers.get(name));
      timers.clear();
      await Promise.allSettled([...inflight, ...pending.map((name) => upload(name))]);
    },
  };
}
