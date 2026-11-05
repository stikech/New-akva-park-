/** Фитнес-клуб: направления, абонементы на посещения и «Золотая» карта. */

import { escapeHtml, formatHour, formatPrice, plural } from '../utils/format.js';
import { bestPackage, pricePerMonth, pricePerVisit } from '../utils/pricing.js';

const VISITS = ['посещение', 'посещения', 'посещений'];
const MONTHS = ['месяц', 'месяца', 'месяцев'];

function packageRow({ visits, price }, isBest) {
  const label = visits === 1 ? 'Разовое посещение' : `${visits} ${plural(visits, VISITS)}`;
  const perVisit = visits === 1 ? '' : `<small>${formatPrice(pricePerVisit(price, visits))} за занятие</small>`;
  return `
    <li class="pkg${isBest ? ' pkg--best' : ''}">
      <span class="pkg__label">${label}${perVisit}</span>
      <b class="pkg__price">${formatPrice(price)}</b>
    </li>`;
}

function cardTemplate(card) {
  const best = bestPackage(card.packages);
  const badge = best && best.savingPct > 0
    ? `<p class="club-card__badge">Экономия до ${best.savingPct}% по сравнению с разовым посещением</p>`
    : '';
  return `
    <article class="club-card">
      <h3>${escapeHtml(card.name)}</h3>
      <ul class="pkg-list">${card.packages.map((p) => packageRow(p, best && p.visits === best.visits)).join('')}</ul>
      ${badge}
    </article>`;
}

function goldTemplate(gold) {
  const periods = gold.periods.map(({ months, price }) => `
    <li>
      <span>${months === 12 ? '1 год' : `${months} ${plural(months, MONTHS)}`}</span>
      <b>${formatPrice(price)}</b>
      <small>${months > 1 ? `${formatPrice(pricePerMonth(price, months))} в месяц` : 'без ограничения посещений'}</small>
    </li>`).join('');
  return `
    <article class="club-card club-card--gold">
      <h3>${escapeHtml(gold.name)}</h3>
      <p>Безлимитная клубная карта. Чем дольше срок, тем дешевле месяц.</p>
      <ul class="gold-periods">${periods}</ul>
    </article>`;
}

export function renderFitness({ cards, directions, hours, socials }, fitness) {
  cards.innerHTML = fitness.cards.map(cardTemplate).join('') + goldTemplate(fitness.gold);
  directions.innerHTML = fitness.directions.map((d) => `<li class="chip">${escapeHtml(d)}</li>`).join('');
  hours.textContent = `Ежедневно ${formatHour(fitness.hours[0])}–${formatHour(fitness.hours[1])}, ${fitness.floor} этаж`;
  socials.innerHTML = fitness.socials
    .map((s) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.label)}</a>`)
    .join('');
}
