/**
 * Заготовленные демо-аккаунты: чтобы кабинет можно было показать без регистрации.
 *
 * Включаются переменной DEMO_ACCOUNTS=1. При каждом запуске сервера аккаунты
 * создаются заново (или сбрасываются к исходному виду) — поэтому они не пропадают
 * на хостинге с временным диском (бесплатный Render) и не «портятся» посетителями.
 *
 * Пароль у демо-аккаунтов общий и публичный, поэтому для них запрещены смена пароля,
 * удаление и «выйти на других устройствах» (см. accounts.js).
 */

import { buildCatalog, buildMembership } from './memberships.js';
import { hashPassword } from './passwords.js';
import { cityDateString } from '../../frontend/assets/js/utils/account.js';
import { SITE_DATA } from '../../frontend/assets/js/config/site-data.js';

export const DEMO_PASSWORD = 'neptun2026';

const DAY = 86_400_000;

/** Дата «YYYY-MM-DD», сдвинутая на days дней от today. */
function shiftDate(today, days) {
  return new Date(Date.parse(`${today}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/** Посещения: daysAgo — сколько дней назад, в 18:30 по Петропавловску (13:30 UTC). */
function visitsAt(today, daysAgoList) {
  return daysAgoList.map((d) => ({ at: `${shiftDate(today, -d)}T13:30:00.000Z` }));
}

function membership(planId, startsAt, catalog, visitDaysAgo, today, now) {
  const built = buildMembership({ planId, startsAt }, catalog, { now });
  if (!built.ok) throw new Error(`demo: тариф ${planId} не найден в каталоге`);
  const visits = visitsAt(today, visitDaysAgo);
  return { ...built.value, visitsUsed: visits.length, visits, issuedAt: `${startsAt}T06:00:00.000Z` };
}

/** Описание демо-аккаунтов на дату today. */
export function demoAccounts({ now = new Date(), catalog = buildCatalog() } = {}) {
  const today = cityDateString(SITE_DATA.tzOffsetHours, now);
  return [
    {
      label: 'Абонемент в бассейн',
      email: 'demo@neptun.kz',
      fields: {
        firstName: 'Никуша',
        lastName: null,
        phone: '+77051234567',
        birthDate: '1995-03-08',
        membership: membership('pool:adult:12', shiftDate(today, -18), catalog, [16, 13, 9, 6, 2], today, now),
      },
    },
    {
      label: '«Золотая» карта, безлимит',
      email: 'gold@neptun.kz',
      fields: {
        firstName: 'Ерлан',
        lastName: 'Сейткали',
        phone: '+77019876543',
        birthDate: '1988-11-21',
        membership: membership('gold:6', shiftDate(today, -40), catalog, [38, 36, 33, 31, 29, 26, 24, 22, 19, 17, 15, 12, 10, 8, 5, 3, 1], today, now),
      },
    },
    {
      label: 'Новый клиент без абонемента',
      email: 'new@neptun.kz',
      fields: { firstName: 'Арман', lastName: null, phone: null, birthDate: null, membership: null },
    },
  ].map((a) => ({ ...a, fields: { ...a.fields, createdAt: `${shiftDate(today, -60)}T09:00:00.000Z` } }));
}

/** Создаёт или сбрасывает демо-аккаунты. Возвращает список { email, label } для экрана входа. */
export async function seedDemoAccounts(accounts, { now = new Date(), log = console } = {}) {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const list = demoAccounts({ now });
  for (const a of list) {
    await accounts.upsertUser(a.email, {
      ...a.fields,
      passwordHash,
      lang: 'ru',
      consentAt: a.fields.createdAt,
      demo: true,
    });
  }
  log.info?.(`[demo] демо-аккаунты готовы: ${list.map((a) => a.email).join(', ')} (пароль ${DEMO_PASSWORD})`);
  return list.map(({ email, label }) => ({ email, label, password: DEMO_PASSWORD }));
}
