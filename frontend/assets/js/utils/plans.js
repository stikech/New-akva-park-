/**
 * Подписи тарифов абонементов — общие для витрины /shop и магазина кабинета.
 * Тариф приходит с сервера (backend/src/memberships.js → buildCatalog).
 */

import { formatPrice, plural } from './format.js';

const monthsText = (n) => `${n} ${plural(n, ['месяц', 'месяца', 'месяцев'])}`;

/** Название тарифа без категории и срока: «Фитнес · Дневной · 12 посещений» → «Дневной». Срок — в planMeta. */
export const planTitle = (p) => p.title.split(' · ')[1] ?? p.title;

/** «12 посещений, 2 месяца» или «6 месяцев · безлимит». */
export function planMeta(p) {
  if (p.visitsTotal == null) return p.durationMonths ? `${monthsText(p.durationMonths)} · безлимит` : 'безлимит';
  const visits = `${p.visitsTotal} ${plural(p.visitsTotal, ['посещение', 'посещения', 'посещений'])}`;
  return p.durationMonths ? `${visits}, ${monthsText(p.durationMonths)}` : visits;
}

/** «625 ₸ за посещение» — только для абонементов с посещениями. */
export const perVisit = (p) => (p.visitsTotal ? `${formatPrice(Math.ceil(p.price / p.visitsTotal))} за посещение` : null);

/** Текст согласия с офертой — один на все формы оплаты. */
export const CONSENT_HTML = 'Я принимаю условия <a href="/offer" target="_blank" rel="noopener">публичной оферты</a>, '
  + '<a href="/rules" target="_blank" rel="noopener">правила посещения</a> и даю согласие на обработку персональных данных';
