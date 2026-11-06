/**
 * Хранилище аккаунтов и сессий: один JSON-файл DATA_DIR/accounts.json.
 *
 * - Данные держатся в памяти, файл перезаписывается целиком при каждом изменении:
 *   запись во временный файл + rename (атомарно — при сбое остаётся старая версия).
 * - Записи идут строго по очереди (promise-цепочка), поэтому параллельные запросы
 *   не затирают друг друга. Рассчитано на один инстанс сервера.
 * - Сессии хранятся по SHA-256 токена: утечка файла не даёт войти чужой cookie.
 * - Токен сессии зашифрован (sealed-token.js) и несёт снимок аккаунта: если сервер
 *   перезапустился и файл пропал (бесплатный Render стирает диск), сессия и аккаунт
 *   восстанавливаются из cookie — клиента не выкидывает и войти заново он может.
 *
 * Объёма в тысячи клиентов хватает. Интерфейс ниже позволяет позже перейти на
 * SQLite/Postgres, не трогая маршруты.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { deriveKey, isSealed, seal, unseal } from './sealed-token.js';

const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const SNAPSHOT_VISITS = 40; // в cookie — последние посещения, чтобы токен оставался небольшим

/** Что из аккаунта кладём в токен, чтобы восстановить его после потери файла. */
function snapshot(user) {
  const { visits, ...membership } = user.membership ?? {};
  return {
    ...user,
    membership: user.membership ? { ...membership, visits: (visits ?? []).slice(-SNAPSHOT_VISITS) } : null,
  };
}

export function createAccountStore(dataDir, { now = () => Date.now(), sessionKey = null } = {}) {
  const key = Buffer.isBuffer(sessionKey) ? sessionKey : deriveKey(sessionKey);
  const file = path.join(dataDir, 'accounts.json');
  let state = null; // { version, users: [], sessions: [] }
  let loading = null;
  let queue = Promise.resolve();

  async function load() {
    if (state) return state;
    loading ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        state = { version: 1, users: parsed.users ?? [], sessions: parsed.sessions ?? [], revoked: parsed.revoked ?? [], deleted: parsed.deleted ?? [] };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error; // битый файл не затираем молча
        state = { version: 1, users: [], sessions: [], revoked: [] };
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
        // токены удалённого аккаунта не должны «воскресить» его из снимка
        s.revoked = [...(s.revoked ?? []), ...s.sessions.filter((x) => x.userId === id).map((x) => ({ id: x.id, expiresAt: x.expiresAt }))];
        s.deleted = [...(s.deleted ?? []), id];
        s.sessions = s.sessions.filter((x) => x.userId !== id);
        return s.users.length < before;
      });
    },

    /** Создаёт сессию, возвращает сырой токен (в файле — только хеш). */
    /** Новая сессия: id хранится на сервере, а сам токен — зашифрованный, со снимком аккаунта. */
    async createSession(userId, ttlMs) {
      const sid = randomBytes(24).toString('base64url');
      const t = now();
      let user = null;
      await mutate((s) => {
        s.sessions = s.sessions.filter((x) => x.expiresAt > t); // попутно чистим просроченные
        s.revoked = (s.revoked ?? []).filter((x) => x.expiresAt > t);
        s.sessions.push({ id: hashToken(sid), userId, createdAt: t, expiresAt: t + ttlMs });
        user = byId(s, userId);
      });
      return seal({ sid, uid: userId, email: user?.email, ep: user?.sessionEpoch ?? 0, exp: t + ttlMs, snap: user ? snapshot(user) : null }, key);
    },

    /**
     * Тот же токен со свежим снимком аккаунта (после покупки абонемента, правки профиля).
     * null — токен не наш. Возвращает { token, maxAgeSec }.
     */
    async refreshSession(token) {
      const p = unseal(token, key);
      if (!p) return null;
      const s = await load();
      const user = byId(s, p.uid);
      if (!user) return null;
      return { token: seal({ ...p, snap: snapshot(user) }, key), maxAgeSec: Math.max(0, Math.floor((p.exp - now()) / 1000)) };
    },

    /** Пользователь по токену сессии или null (просрочена / удалена). */
    async userBySession(token) {
      if (!token) return null;
      if (!isSealed(token)) {
        // старые токены (до шифрования) — как раньше, только по файлу
        const s = await load();
        const session = s.sessions.find((x) => x.id === hashToken(token));
        if (!session || session.expiresAt <= now()) return null;
        return byId(s, session.userId);
      }
      const p = unseal(token, key);
      if (!p || p.exp <= now()) return null;
      const id = hashToken(p.sid);
      const s = await load();
      const session = s.sessions.find((x) => x.id === id);
      if (session) return session.expiresAt > now() ? byId(s, session.userId) : null;
      if ((s.revoked ?? []).some((x) => x.id === id)) return null; // вышел или завершён «везде»

      // Сессии нет в файле — сервер перезапускался. Восстанавливаем из токена.
      return mutate((st) => {
        let user = byId(st, p.uid) ?? st.users.find((u) => u.email === p.email) ?? null;
        if (!user && p.snap?.id === p.uid && p.snap.email && !(st.deleted ?? []).includes(p.uid)) {
          if (st.users.some((u) => u.email === p.snap.email)) return null;
          user = { ...p.snap };
          st.users.push(user);
        }
        if (!user || (user.sessionEpoch ?? 0) !== (p.ep ?? 0)) return null;
        st.sessions.push({ id, userId: user.id, createdAt: now(), expiresAt: p.exp });
        return user;
      });
    },

    deleteSession(token) {
      const p = isSealed(token) ? unseal(token, key) : null;
      const id = hashToken(p ? p.sid : token);
      return mutate((s) => {
        s.sessions = s.sessions.filter((x) => x.id !== id);
        if (p) s.revoked = [...(s.revoked ?? []), { id, expiresAt: p.exp }];
      });
    },

    /**
     * Завершает все сессии пользователя, кроме keepToken. Счётчик sessionEpoch растёт —
     * так старые токены не оживут и после перезапуска сервера; вызывающий выдаёт
     * текущему устройству новый токен (createSession).
     */
    deleteUserSessions(userId, keepToken = null) {
      const kp = keepToken && isSealed(keepToken) ? unseal(keepToken, key) : null;
      const keep = keepToken ? hashToken(kp ? kp.sid : keepToken) : null;
      return mutate((s) => {
        const ended = s.sessions.filter((x) => x.userId === userId && x.id !== keep);
        s.sessions = s.sessions.filter((x) => x.userId !== userId || x.id === keep);
        s.revoked = [...(s.revoked ?? []), ...ended.map((x) => ({ id: x.id, expiresAt: x.expiresAt }))];
        const user = byId(s, userId);
        if (user) user.sessionEpoch = (user.sessionEpoch ?? 0) + 1;
        s.sessions = s.sessions.filter((x) => x.id !== keep); // текущему устройству выдадут новый токен
        return ended.length;
      });
    },
  };
}
