/**
 * Запись на занятия: расписание и личные бронирования.
 *
 * Правила:
 *  - записаться можно на до 14 дней вперёд; старт слота — минимум за 60 минут;
 *  - с активным абонементом подходящей категории занятие входит в абонемент (fitness открывает
 *    все занятия, pool — 'pool' и 'aqua', см. schedule.js → CATEGORY_ACCESS);
 *  - без абонемента — разовое занятие (payment: 'single'): оплата онлайн через корзину или на ресепшене;
 *  - без регистрации тоже можно: имя + телефон + согласие с офертой (guest);
 *  - вместимость слота ограничена (capacity из site-data.js); на один слот
 *    у пользователя может быть не больше одной записи;
 *  - лимиты: 20 новых записей в час на пользователя, не больше 15 активных
 *    записей вперед — от фермы ботов;
 *  - отмена: до начала слота, статус 'cancelled' остаётся в истории.
 *
 *   GET    /api/schedule            — афиша на 7 дней (?days=1..14), для вошедшего — доп. поля
 *   POST   /api/bookings            — записаться { key, guest?: { name, phone }, consent? }
 *   GET    /api/bookings            — мои записи
 *   DELETE /api/bookings/:key       — отменить свою запись
 *   POST   /api/bookings/:id/cancel — гость отменяет запись по её id { phone }
 *   GET    /api/admin/bookings      — день целиком: все занятия, места и кто записан (?date=YYYY-MM-DD)
 *   POST   /api/admin/bookings      — сотрудник записывает клиента { key, name, phone }
 *   POST   /api/admin/bookings/:id/attend — отметить приход { attended: true|false }
 *   POST   /api/admin/bookings/:id/cancel — отменить запись
 */

import { HttpError, assertSameOrigin, clientIp, readJsonBody, sendJson } from './http.js';
import { createRateLimiter } from './rate-limit.js';
import { sessionToken } from './session.js';
import { SITE_DATA } from '../../frontend/assets/js/config/site-data.js';
import { cityDateString, membershipStatus } from '../../frontend/assets/js/utils/account.js';
import { CATEGORY_ACCESS, CATEGORY_PLAN, DAYS_AHEAD_MAX, createScheduleModule, slotInstant } from './schedule.js';
import { classPrice } from '../../frontend/assets/js/utils/catalog.js';
import { normalizePhone } from '../../frontend/assets/js/utils/account.js';

const BOOKING_CUTOFF_MS = 60 * 60_000; // за час до старта запись уже не поменяешь
const KEY_RE = /^(\d{4}-\d{2}-\d{2}):([a-z0-9-]{3,40})$/;
const MAX_ACTIVE_BOOKINGS = 15;
const ID_RE = /^[0-9a-f-]{36}$/;

export function createBookingRoutes({
  config, accounts, bookings, journal, requireUser, requireAdmin, log = console, clock = () => new Date(),
}) {
  const schedule = createScheduleModule();
  const today = () => cityDateString(SITE_DATA.tzOffsetHours, clock());

  const createLimiterUser = createRateLimiter({ max: 20, windowMs: 60 * 60_000 });
  const createLimiterIp = createRateLimiter({ max: 60, windowMs: 60 * 60_000 });
  setInterval(() => [createLimiterUser, createLimiterIp].forEach((l) => l.sweep()), 60_000).unref();

  const tooMany = (limit) => new HttpError(429, 'Слишком много попыток. Попробуйте позже.', {
    error: 'Слишком много попыток. Попробуйте позже.',
    retryAfterSec: limit.retryAfterSec,
  });

  function publicBooking(b) {
    return {
      id: b.id, key: b.key, date: b.date, sessionId: b.sessionId, title: b.title,
      category: b.category, room: b.room, start: b.start, end: b.end,
      status: b.status, createdAt: b.createdAt, cancelledAt: b.cancelledAt,
      payment: b.payment ?? 'membership', price: b.price ?? null, paid: Boolean(b.paidOrderId),
    };
  }

  /** Есть ли у пользователя абонемент, в который входит занятие этой категории. */
  function coveredByMembership(user, category) {
    const m = user?.membership;
    if (!m || membershipStatus(m, today()).code !== 'active') return false;
    return (CATEGORY_ACCESS[m.category] ?? []).includes(category);
  }

  function parseGuest(body) {
    const g = typeof body?.guest === 'object' && body.guest !== null ? body.guest : {};
    const name = String(g.name ?? '').trim();
    const phone = normalizePhone(g.phone);
    const errors = {};
    if (!name || name.length > 80) errors['guest.name'] = 'Укажите имя';
    if (!phone) errors['guest.phone'] = 'Телефон в формате +7 7XX XXX-XX-XX';
    return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { name, phone } };
  }

  /** Проверки слота: существует, в окне записи, не позже чем за час. */
  function bookableSlot(key, { ignoreCutoff = false } = {}) {
    if (!KEY_RE.test(key)) throw new HttpError(422, 'Некорректный ключ занятия');
    const slot = schedule.find(key);
    if (!slot) throw new HttpError(404, 'Такого занятия в расписании нет');
    const startMs = slotInstant(slot.date, slot.start);
    const lastDate = schedule.window(today(), DAYS_AHEAD_MAX).at(-1);
    if (startMs === null || slot.date > lastDate || (ignoreCutoff ? slot.date < today() : false)) {
      throw new HttpError(422, 'Дата недоступна для записи');
    }
    if (!ignoreCutoff && startMs - clock().getTime() < BOOKING_CUTOFF_MS) {
      throw new HttpError(422, `Запись возможна не позднее, чем за ${BOOKING_CUTOFF_MS / 60_000} минут до начала`);
    }
    return slot;
  }

  return {
    routes: {
      'GET /api/schedule': async (req, res) => {
        const params = new URL(req.url, 'http://x').searchParams;
        const days = Math.min(Math.max(Number.parseInt(params.get('days'), 10) || 7, 1), DAYS_AHEAD_MAX);
        const nowMs = clock().getTime();
        const dates = schedule.window(today(), days);

        const counts = await bookings.counts(dates.flatMap((d) => schedule.list(d).map((s) => s.key)));

        // Пользователь необязателен: расписание видно всем, доступ и «мои записи»
        // появляются только вошедшим.
        const user = await accounts.userBySession(sessionToken(req));
        const m = user?.membership ?? null;
        const status = m ? membershipStatus(m, today()) : null;
        const allowed = m ? (CATEGORY_ACCESS[m.category] ?? []) : null;
        const myKeys = user
          ? new Set((await bookings.byUser(user.id))
            .filter((b) => b.status === 'booked' && b.date >= dates[0])
            .map((b) => b.key))
          : new Set();

        const daysOut = [];
        for (const date of dates) {
          const slots = schedule.list(date).map((slot) => {
            const booked = counts[slot.key] ?? 0;
            const free = Math.max(0, slot.capacity - booked);
            const startMs = slotInstant(slot.date, slot.start);
            const accessOk = Boolean(user && status?.code === 'active' && allowed?.includes(slot.category));
            const open = startMs !== null && startMs >= nowMs + BOOKING_CUTOFF_MS;
            return {
              ...slot,
              booked,
              free,
              past: !open,
              fullyBooked: free === 0,
              bookable: open && free > 0,
              mine: myKeys.has(slot.key),
              access: accessOk ? 'membership' : 'single',
              singlePrice: classPrice(slot.category, SITE_DATA),
              needPlan: accessOk ? null : CATEGORY_PLAN[slot.category],
            };
          });
          daysOut.push({ date, slots });
        }

        const payload = {
          days: daysOut,
          today: today(),
          tzOffsetHours: SITE_DATA.tzOffsetHours,
          cutoffMin: BOOKING_CUTOFF_MS / 60_000,
          maxActive: MAX_ACTIVE_BOOKINGS,
        };
        if (user) {
          payload.membership = {
            title: m ? m.title : null,
            category: m ? m.category : null,
            status: !m ? 'none' : status.code,
            label: !m ? 'Нет абонемента' : status.label,
            allowed,
          };
          payload.myBookings = (await bookings.byUser(user.id))
            .filter((b) => b.status === 'booked' && b.date >= dates[0])
            .map(publicBooking);
        }
        sendJson(res, 200, payload);
      },

      'POST /api/bookings': async (req, res) => {
        assertSameOrigin(req);
        const limitIp = createLimiterIp.hit(clientIp(req, config.trustProxyHops));
        if (!limitIp.ok) throw tooMany(limitIp);

        const body = await readJsonBody(req);
        const user = await accounts.userBySession(sessionToken(req));
        let guest = null;
        if (user) {
          const limitUser = createLimiterUser.hit(user.id);
          if (!limitUser.ok) throw tooMany(limitUser);
        } else {
          const parsed = parseGuest(body);
          if (!parsed.ok) return sendJson(res, 422, { errors: parsed.errors });
          guest = parsed.value;
        }

        const slot = bookableSlot(String(body?.key ?? ''));
        const payment = coveredByMembership(user, slot.category) ? 'membership' : 'single';
        if ((payment === 'single' || guest) && body?.consent !== true) {
          return sendJson(res, 422, { errors: { consent: 'Нужно принять условия публичной оферты и правила посещения' } });
        }

        if (user) {
          const mine = await bookings.byUser(user.id);
          if (mine.filter((b) => b.status === 'booked' && b.date >= today()).length >= MAX_ACTIVE_BOOKINGS) {
            throw new HttpError(429, 'Слишком много будущих записей — отмените ненужные');
          }
        }

        const { booking, created, full } = await bookings.create({
          userId: user?.id ?? null, guest, slot, payment,
          price: payment === 'single' ? classPrice(slot.category, SITE_DATA) : null,
          now: clock().toISOString(),
        });
        if (full) throw new HttpError(409, 'Мест не осталось — выберите другое время');
        if (!created) return sendJson(res, 200, { booking: publicBooking(booking), already: true });

        await journal.record('booking_created', { bookingId: booking.id, userId: user?.id ?? null, guest: Boolean(guest), key: slot.key, payment });
        log.info?.(`[bookings] ${user?.id ?? 'гость'} → ${slot.key} (${payment})`);
        sendJson(res, 201, { booking: publicBooking(booking) });
      },

      'GET /api/bookings': async (req, res) => {
        const { user } = await requireUser(req);
        const items = await bookings.byUser(user.id);
        sendJson(res, 200, { items: items.map(publicBooking), today: today() });
      },

      'GET /api/admin/bookings': async (req, res) => {
        requireAdmin(req);
        const requested = new URL(req.url, 'http://x').searchParams.get('date');
        const date = validDate(requested) ? requested : today();
        const users = new Map((await accounts.listUsers()).map((u) => [u.id, u]));
        const all = await bookings.byDate(date, { includeCancelled: true });
        const person = (b) => {
          const u = b.userId ? users.get(b.userId) : null;
          return u
            ? { name: [u.firstName, u.lastName].filter(Boolean).join(' '), phone: u.phone ?? null, email: u.email, account: true }
            : { name: b.guest?.name ?? 'Гость', phone: b.guest?.phone ?? null, email: null, account: false };
        };
        const adminBooking = (b) => ({
          ...publicBooking(b), ...person(b),
          attendedAt: b.attendedAt ?? null, attendedBy: b.attendedBy ?? null,
          createdBy: b.createdBy ?? null, cancelledBy: b.cancelledBy ?? null,
        });
        const slots = schedule.list(date).map((slot) => {
          const list = all.filter((b) => b.key === slot.key);
          const booked = list.filter((b) => b.status === 'booked');
          return {
            ...slot,
            booked: booked.length,
            free: Math.max(0, slot.capacity - booked.length),
            attended: booked.filter((b) => b.attendedAt).length,
            items: list.map(adminBooking),
          };
        });
        const total = all.filter((b) => b.status === 'booked').length;
        sendJson(res, 200, { date, today: today(), slots, total, items: all.filter((b) => b.status === 'booked').map(adminBooking) });
      },

      'POST /api/admin/bookings': async (req, res) => {
        const staff = requireAdmin(req);
        const body = await readJsonBody(req);
        const parsed = parseGuest({ guest: { name: body?.name, phone: body?.phone } });
        if (!parsed.ok) return sendJson(res, 422, { errors: parsed.errors });
        const slot = bookableSlot(String(body?.key ?? ''), { ignoreCutoff: true });
        const { booking, created, full } = await bookings.create({
          guest: parsed.value, slot, payment: 'single', price: classPrice(slot.category, SITE_DATA),
          by: staff.name, now: clock().toISOString(),
        });
        if (full) throw new HttpError(409, 'Мест не осталось');
        if (created) await journal.record('booking_created', { bookingId: booking.id, key: slot.key, by: staff.name });
        sendJson(res, created ? 201 : 200, { booking: publicBooking(booking), already: !created });
      },
    },

    dynamic: {
      'POST /api/bookings/:id/cancel': async (req, res, { params }) => {
        assertSameOrigin(req);
        const id = String(params.id ?? '');
        const body = await readJsonBody(req);
        const booking = ID_RE.test(id) ? await bookings.find(id) : null;
        // Гость подтверждает запись своим телефоном — id из чужой ссылки без телефона бесполезен.
        if (!booking || booking.userId || booking.status !== 'booked' || booking.guest?.phone !== normalizePhone(body?.phone)) {
          throw new HttpError(404, 'Запись не найдена');
        }
        const startMs = slotInstant(booking.date, booking.start);
        if (startMs === null || startMs - clock().getTime() < BOOKING_CUTOFF_MS) {
          throw new HttpError(409, 'Отменить можно не позднее, чем за час до начала — позвоните на ресепшен');
        }
        const updated = await bookings.cancel(booking.id, 'guest');
        await journal.record('booking_cancelled', { bookingId: booking.id, guest: true });
        sendJson(res, 200, { booking: publicBooking(updated) });
      },

      'POST /api/admin/bookings/:id/attend': async (req, res, { params }) => {
        const staff = requireAdmin(req);
        const body = await readJsonBody(req);
        const id = String(params.id ?? '');
        const updated = ID_RE.test(id) ? await bookings.setAttended(id, body?.attended !== false, staff.name) : null;
        if (!updated) throw new HttpError(404, 'Запись не найдена или отменена');
        await journal.record('booking_attended', { bookingId: id, attended: Boolean(updated.attendedAt), by: staff.name });
        sendJson(res, 200, { booking: publicBooking(updated) });
      },

      'POST /api/admin/bookings/:id/cancel': async (req, res, { params }) => {
        const staff = requireAdmin(req);
        const id = String(params.id ?? '');
        const booking = ID_RE.test(id) ? await bookings.find(id) : null;
        if (!booking || booking.status !== 'booked') throw new HttpError(404, 'Запись не найдена или уже отменена');
        const updated = await bookings.cancel(id, staff.name);
        await journal.record('booking_cancelled', { bookingId: id, by: staff.name });
        sendJson(res, 200, { booking: publicBooking(updated) });
      },

      'DELETE /api/bookings/:key': async (req, res, { params }) => {
        assertSameOrigin(req);
        const token = String(params.key ?? '');
        if (!KEY_RE.test(token)) throw new HttpError(404, 'Запись не найдена');
        const { user } = await requireUser(req);
        const booking = (await bookings.byUser(user.id))
          .filter((b) => b.key === token && b.status === 'booked')
          .at(-1);
        if (!booking) throw new HttpError(404, 'Запись не найдена');
        const startMs = slotInstant(booking.date, booking.start);
        if (startMs === null || startMs - clock().getTime() < BOOKING_CUTOFF_MS) {
          throw new HttpError(409, 'Отменить можно не позднее, чем за час до начала');
        }
        const updated = await bookings.cancel(booking.id, 'client');
        await journal.record('booking_cancelled', { bookingId: booking.id, userId: user.id });
        sendJson(res, 200, { booking: publicBooking(updated) });
      },
    },
  };
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
