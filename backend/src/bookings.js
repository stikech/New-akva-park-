/**
 * Запись на занятия: расписание и личные бронирования.
 *
 * Правила:
 *  - записаться можно на до 14 дней вперёд; старт слота — минимум за 60 минут;
 *  - нужен активный абонемент подходящей категории: fitness открывает все
 *    занятия, pool — 'pool' и 'aqua' (см. schedule.js → CATEGORY_ACCESS);
 *  - вместимость слота ограничена (capacity из site-data.js); на один слот
 *    у пользователя может быть не больше одной записи;
 *  - лимиты: 20 новых записей в час на пользователя, не больше 15 активных
 *    записей вперед — от фермы ботов;
 *  - отмена: до начала слота, статус 'cancelled' остаётся в истории.
 *
 *   GET    /api/schedule            — афиша на 7 дней (?days=1..14), для вошедшего — доп. поля
 *   POST   /api/bookings            — записаться { key: 'YYYY-MM-DD:session-id' }
 *   GET    /api/bookings            — мои записи
 *   DELETE /api/bookings/:key       — отменить свою запись
 *   GET    /api/admin/bookings      — записи на день (?date=YYYY-MM-DD)
 */

import { HttpError, assertSameOrigin, clientIp, readJsonBody, sendJson } from './http.js';
import { createRateLimiter } from './rate-limit.js';
import { sessionToken } from './session.js';
import { SITE_DATA } from '../../frontend/assets/js/config/site-data.js';
import { cityDateString, membershipStatus } from '../../frontend/assets/js/utils/account.js';
import { CATEGORY_ACCESS, CATEGORY_PLAN, DAYS_AHEAD_MAX, createScheduleModule, slotInstant } from './schedule.js';

const BOOKING_CUTOFF_MS = 60 * 60_000; // за час до старта запись уже не поменяешь
const KEY_RE = /^(\d{4}-\d{2}-\d{2}):([a-z0-9-]{3,40})$/;
const MAX_ACTIVE_BOOKINGS = 15;

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
    };
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
            return {
              ...slot,
              booked,
              free,
              past: startMs !== null && startMs < nowMs + BOOKING_CUTOFF_MS,
              fullyBooked: free === 0,
              bookable: accessOk && startMs >= nowMs + BOOKING_CUTOFF_MS,
              mine: myKeys.has(slot.key),
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
        const { user } = await requireUser(req);
        const limitUser = createLimiterUser.hit(user.id);
        if (!limitUser.ok) throw tooMany(limitUser);
        const limitIp = createLimiterIp.hit(clientIp(req, config.trustProxyHops));
        if (!limitIp.ok) throw tooMany(limitIp);

        const body = await readJsonBody(req);
        const key = String(body?.key ?? '');
        if (!KEY_RE.test(key)) throw new HttpError(422, 'Некорректный ключ занятия');
        const slot = schedule.find(key);
        if (!slot) throw new HttpError(404, 'Такого занятия в расписании нет');

        const nowMs = clock().getTime();
        const startMs = slotInstant(slot.date, slot.start);
        const lastDate = schedule.window(today(), DAYS_AHEAD_MAX).at(-1);
        if (startMs === null || slot.date > lastDate) throw new HttpError(422, 'Дата недоступна для записи');
        if (startMs - nowMs < BOOKING_CUTOFF_MS) {
          throw new HttpError(422, `Запись возможна не позднее, чем за ${BOOKING_CUTOFF_MS / 60_000} минут до начала`);
        }

        const status = membershipStatus(user.membership, today());
        if (!user.membership || status.code !== 'active') {
          throw new HttpError(403, 'Нужен действующий абонемент — оформить можно во вкладке «Магазин»');
        }
        const allowed = CATEGORY_ACCESS[user.membership.category] ?? [];
        if (!allowed.includes(slot.category)) {
          throw new HttpError(403, `Это занятие входит только в абонемент категории «${CATEGORY_PLAN[slot.category] === 'pool' ? 'Бассейн' : 'Фитнес'}»`);
        }

        const mine = await bookings.byUser(user.id);
        if (mine.filter((b) => b.status === 'booked' && b.date >= today()).length >= MAX_ACTIVE_BOOKINGS) {
          throw new HttpError(429, 'Слишком много будущих записей — отмените ненужные');
        }

        const { booking, created, full } = await bookings.create({
          userId: user.id, slot, now: clock().toISOString(),
        });
        if (full) throw new HttpError(409, 'Мест не осталось — выберите другое время');
        if (!created) return sendJson(res, 200, { booking: publicBooking(booking), already: true });

        await journal.record('booking_created', { bookingId: booking.id, userId: user.id, key: slot.key });
        log.info?.(`[bookings] ${user.id} → ${slot.key}`);
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
        const items = (await bookings.byDate(date)).map((b) => ({
          ...publicBooking(b),
          email: users.get(b.userId)?.email ?? null,
          firstName: users.get(b.userId)?.firstName ?? null,
          phone: users.get(b.userId)?.phone ?? null,
        }));
        sendJson(res, 200, { date, items, total: items.length });
      },
    },

    dynamic: {
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
        const updated = await bookings.cancel(booking.id);
        await journal.record('booking_cancelled', { bookingId: booking.id, userId: user.id });
        sendJson(res, 200, { booking: publicBooking(updated) });
      },
    },
  };
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
