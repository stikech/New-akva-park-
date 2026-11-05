/**
 * Применение оплаченного абонемента к аккаунту: новое оформление или продление.
 *
 * Клиент покупает тариф из каталога (site-data.js → buildCatalog), сервер решает:
 *  - тот же тариф И срок ещё не прошёл → продление: посещения и срок суммируются;
 *  - нет абонемента / другой тариф / срок прошёл → новое оформление, история
 *    посещений начинается заново (как при выдаче на кассе).
 *
 * Вся проверка живёт здесь — маршруты лишь передают данные. Чистая функция
 * `applyPlan` покрыта тестами backend/tests/membership-service.test.js.
 */

import { addMonths, membershipStatus } from '../../frontend/assets/js/utils/account.js';

/**
 * @param {{ membership: object|null, plan: object, today: string, nowISO: string }} input
 *   plan — тариф каталога { id, category, title, visitsTotal, durationMonths, price }
 *   today — «YYYY-MM-DD» по времени города
 */
export function applyPlan({ membership, plan, today, nowISO, orderId }) {
  const status = membership ? membershipStatus(membership, today) : null;
  const extendable = status && (status.code === 'active' || status.code === 'scheduled') && membership.planId === plan.id;

  if (!extendable) {
    return {
      extended: false,
      membership: {
        planId: plan.id,
        category: plan.category,
        title: plan.title,
        price: plan.price,
        visitsTotal: plan.visitsTotal,
        visitsUsed: 0,
        startsAt: today,
        endsAt: plan.durationMonths ? addMonths(today, plan.durationMonths) : null,
        issuedAt: nowISO,
        issuedBy: orderId ?? 'checkout',
        visits: [],
      },
    };
  }

  // Тот же тариф и срок не прошёл — продлеваем существующую запись.
  const m = membership;
  if (plan.visitsTotal != null) m.visitsTotal += plan.visitsTotal;

  if (plan.durationMonths != null && m.endsAt) {
    const base = m.endsAt > today ? m.endsAt : today; // активный срок дотягиваем от даты конца
    m.endsAt = addMonths(base, plan.durationMonths);
  }
  if (plan.durationMonths != null && !m.endsAt) m.endsAt = addMonths(today, plan.durationMonths);

  m.issuedAt = nowISO;
  m.issuedBy = orderId ?? 'checkout';
  return { extended: true, membership: m };
}
