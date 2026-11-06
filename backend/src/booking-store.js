/**
 * Хранилище записей на занятия: DATA_DIR/bookings.json.
 * Тот же принцип, что у аккаунтов и заказов: память + атомарная запись файла
 * по очереди. Вместимость слота считается по числу записей со статусом 'booked'.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const HISTORY_TTL_MS = 60 * 24 * 3_600_000; // запись живёт в истории 60 дней

export function createBookingStore(dataDir, { now = () => Date.now() } = {}) {
  const file = path.join(dataDir, 'bookings.json');
  let state = null;
  let loading = null;
  let queue = Promise.resolve();

  async function load() {
    if (state) return state;
    loading ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        state = { version: 1, bookings: Array.isArray(parsed.bookings) ? parsed.bookings : [] };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        state = { version: 1, bookings: [] };
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

  const bookedCount = (s, key) => s.bookings.filter((b) => b.key === key && b.status === 'booked').length;

  return {
    file,

    /** Число занятых мест для каждого ключа из списка («дата:занятие»). */
    async counts(keys) {
      const s = await load();
      const out = {};
      for (const key of keys) out[key] = bookedCount(s, key);
      return out;
    },

    /**
     * Создаёт запись. Возвращает { booking, created } — created=false, если уже записан.
     * userId — клиент с кабинетом; guest { name, phone } — запись без регистрации.
     * payment: 'membership' — по абонементу; 'single' — разовое занятие (оплата онлайн или на ресепшене).
     */
    create({ userId = null, guest = null, slot, payment = 'membership', price = null, by = null, now: isoNow }) {
      return mutate((s) => {
        const existing = s.bookings.find(
          (b) => b.key === slot.key && b.status === 'booked'
            && (userId ? b.userId === userId : !b.userId && b.guest?.phone === guest?.phone),
        );
        if (existing) return { booking: existing, created: false };
        if (bookedCount(s, slot.key) >= slot.capacity) return { booking: null, created: false, full: true };

        const booking = {
          id: randomUUID(),
          key: slot.key,
          userId,
          guest: userId ? null : guest,
          payment,
          price,
          paidOrderId: null,
          createdBy: by,
          attendedAt: null,
          attendedBy: null,
          date: slot.date,
          sessionId: slot.sessionId,
          title: slot.title,
          category: slot.category,
          room: slot.room,
          start: slot.start,
          end: slot.end,
          createdAt: isoNow,
          status: 'booked',
          cancelledAt: null,
        };
        s.bookings.push(booking);
        // попутная чистка: записи старше 60 дней не нужны никому
        const cutoff = Date.now() - HISTORY_TTL_MS;
        if (s.bookings.length > 200 && s.bookings.some((b) => Date.parse(b.createdAt) < cutoff)) {
          s.bookings = s.bookings.filter((b) => Date.parse(b.createdAt) >= cutoff);
        }
        return { booking, created: true };
      });
    },

    /** Записи пользователя: сначала будущие, затем недавние отменённые. */
    async byUser(userId, { limit = 100 } = {}) {
      const s = await load();
      const mine = s.bookings.filter((b) => b.userId === userId);
      mine.sort((a, b) => (a.date === b.date ? a.start.localeCompare(b.start) : a.date.localeCompare(b.date)));
      return mine.slice(-limit);
    },

    async find(id) {
      const s = await load();
      return s.bookings.find((b) => b.id === id) ?? null;
    },

    cancel(id, by = null) {
      const t = now();
      return mutate((s) => {
        const b = s.bookings.find((x) => x.id === id);
        if (!b) return null;
        b.status = 'cancelled';
        b.cancelledAt = new Date(t).toISOString();
        b.cancelledBy = by;
        return b;
      });
    },

    /** Разовое занятие оплачено заказом корзины. */
    markPaid(id, orderId) {
      return mutate((s) => {
        const b = s.bookings.find((x) => x.id === id);
        if (!b) return null;
        b.paidOrderId = orderId;
        return b;
      });
    },

    /** Сотрудник отметил, пришёл ли клиент (attended=false снимает отметку). */
    setAttended(id, attended, by) {
      const t = now();
      return mutate((s) => {
        const b = s.bookings.find((x) => x.id === id);
        if (!b || b.status !== 'booked') return null;
        b.attendedAt = attended ? new Date(t).toISOString() : null;
        b.attendedBy = attended ? by : null;
        return b;
      });
    },

    /** Администратор: записи на дату (с отменёнными — includeCancelled). */
    async byDate(date, { includeCancelled = false } = {}) {
      const s = await load();
      return s.bookings.filter((b) => b.date === date && (includeCancelled || b.status === 'booked'))
        .sort((a, b) => a.start.localeCompare(b.start));
    },
  };
}
