/** Таблицы тарифов аквапарка и бассейна, выгода абонемента бассейна. */

import { escapeHtml, formatPrice } from '../utils/format.js';
import { pricePerVisit } from '../utils/pricing.js';

const POOL_PACKAGE_VISITS = 12;

const cells = (values) => values.map((v) => `<td>${formatPrice(v)}</td>`).join('');

export function renderParkPrices({ rows, note }, park) {
  const tariffs = [['Взрослый', park.adult], ['Детский', park.child]];
  rows.innerHTML = tariffs
    .map(([label, t]) => `<tr><td>${label}</td>${cells([t.weekday.h2, t.weekday.unl, t.weekend.h2, t.weekend.unl])}</tr>`)
    .join('');
  note.textContent = park.note;
}

export function renderPoolPrices({ rows, saving }, pool) {
  rows.innerHTML = pool
    .map((tariff) => `<tr><td>${escapeHtml(tariff.label)}</td>${cells(tariff.prices)}</tr>`)
    .join('');

  const adult = pool.find((t) => t.id === 'adult');
  if (!adult) return;
  const [singleHour, , , pack] = adult.prices;
  saving.textContent =
    `${POOL_PACKAGE_VISITS} посещений за ${formatPrice(pack)} — это около ` +
    `${formatPrice(pricePerVisit(pack, POOL_PACKAGE_VISITS))} за визит вместо ${formatPrice(singleHour)} ` +
    'за разовый час. Абонемент действует 2 месяца.';
}
