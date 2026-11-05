/**
 * Хранилище аккаунтов и сессий: один JSON-файл DATA_DIR/accounts.json.
 *
 * - Данные держатся в памяти, файл перезаписывается целиком при каждом изменении:
 *   запись во временный файл + rename (атомарно — при сбое остаётся старая версия).
 * - Записи идут строго по очереди (promise-цепочка), поэтому параллельные запросы
 *   не затирают друг друга. Рассчитано на один инстанс сервера.
 * - Сессии хранятся по SHA-256 токена: утечка файла не даёт войти чужой cookie.
 *
 * Объёма в тысячи клиентов хватает. Интерфейс ниже позволяет позже перейти на
 * SQLite/Postgres, не трогая маршруты.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function createAccountStore(dataDir, { now = () => Date.now() } = {}) {
  const file = path.join(dataDir, 'accounts.json');
  let state = null; // { version, users: [], sessions: [] }
  let loading = null;
  let queue = Promise.resolve();

  async function load() {
    if (state) return state;
    loading ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        state = { version: 1, users: parsed.users ?? [], sessions: parsed.sessions ?? [] };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error; // битый файл не затираем молча
        state = { version: 1, users: [], sessions: [] };
      }
      return state;
    })();
    return loading;
  }

  /** Применяет изменение и сохраняет файл. Изменения выполняются строго по очереди. */
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

  const byId = (s, id) => s.users.find((u) => u.id === id) ?? null;

  return {
    file,

    async findUserByEmail(email) {
      const s = await load();
      return s.users.find((u) => u.email === email) ?? null;
    },

    async findUserById(id) {
      return byId(await load(), id);
    },

    async listUsers() {
      return [...(await load()).users];
    },

    /** Создаёт пользователя; null, если почта уже занята (проверка внутри очереди — без гонок). */
    createUser({ email, passwordHash, firstName, consentAt }) {
      return mutate((s) => {
        if (s.users.some((u) => u.email === email)) return null;
        const t = new Date(now()).toISOString();
        const user = {
          id: randomUUID(),
          email,
          passwordHash,
          firstName,
          lastName: null,
          phone: null,
          birthDate: null,
          lang: 'ru',
          consentAt,
          createdAt: t,
          updatedAt: t,
          membership: null,
        };
        s.users.push(user);
        return user;
      });
    },

    /** Создаёт пользователя или перезаписывает поля существующего (по почте). Для демо-аккаунтов. */
    upsertUser(email, fields) {
      return mutate((s) => {
        const t = new Date(now()).toISOString();
        let user = s.users.find((u) => u.email === email);
        if (!user) {
          user = { id: randomUUID(), email, createdAt: t };
          s.users.push(user);
        }
        Object.assign(user, fields, { email, updatedAt: t });
        return user;
      });
    },

    /** patch — объект полей; fn-вариант позволяет менять вложенные данные атомарно. */
    updateUser(id, patch) {
      return mutate((s) => {
        const user = byId(s, id);
        if (!user) return null;
        if (typeof patch === 'function') {
          if (patch(user) === false) return null;
        } else {
          Object.assign(user, patch);
        }
        user.updatedAt = new Date(now()).toISOString();
        return user;
      });
    },

    deleteUser(id) {
      return mutate((s) => {
        const before = s.users.length;
        s.users = s.users.filter((u) => u.id !== id);
        s.sessions = s.sessions.filter((x) => x.userId !== id);
        return s.users.length < before;
      });
    },

    /** Создаёт сессию, возвращает сырой токен (в файле — только хеш). */
    async createSession(userId, ttlMs) {
      const token = randomBytes(32).toString('base64url');
      const t = now();
      await mutate((s) => {
        s.sessions = s.sessions.filter((x) => x.expiresAt > t); // попутно чистим просроченные
        s.sessions.push({ id: hashToken(token), userId, createdAt: t, expiresAt: t + ttlMs });
      });
      return token;
    },

    /** Пользователь по токену сессии или null (просрочена / удалена). */
    async userBySession(token) {
      if (!token) return null;
      const s = await load();
      const id = hashToken(token);
      const session = s.sessions.find((x) => x.id === id);
      if (!session || session.expiresAt <= now()) return null;
      return byId(s, session.userId);
    },

    deleteSession(token) {
      const id = hashToken(token);
      return mutate((s) => {
        s.sessions = s.sessions.filter((x) => x.id !== id);
      });
    },

    /** Завершает все сессии пользователя, кроме keepToken (если передан). */
    deleteUserSessions(userId, keepToken = null) {
      const keep = keepToken ? hashToken(keepToken) : null;
      return mutate((s) => {
        const before = s.sessions.length;
        s.sessions = s.sessions.filter((x) => x.userId !== userId || x.id === keep);
        return before - s.sessions.length;
      });
    },
  };
}
