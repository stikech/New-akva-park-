/** Расчёт стоимости. Чистые функции без DOM — покрыты тестами. */

/**
 * Стоимость визита в аквапарк.
 * @param {object} parkPrices  SITE_DATA.prices.park
 * @param {{ adult: number, child: number, day: 'weekday'|'weekend', duration: 'h2'|'unl' }} visit
 */
export function calcParkTotal(parkPrices, { adult, child, day, duration }) {
  return adult * parkPrices.adult[day][duration] + child * parkPrices.child[day][duration];
}

/** Цена одного посещения в абонементе, округлённая до тенге. */
export function pricePerVisit(packagePrice, visits) {
  return Math.round(packagePrice / visits);
}

/**
 * Самый выгодный пакет по цене за посещение (разовый визит не считается пакетом).
 * @param {{ visits: number, price: number }[]} packages
 * @returns {{ visits: number, price: number, perVisit: number, savingPct: number } | null}
 *   savingPct — экономия относительно разового посещения, %, округлено вниз.
 */
export function bestPackage(packages) {
  const single = packages.find((p) => p.visits === 1);
  const multi = packages.filter((p) => p.visits > 1);
  if (!multi.length) return null;

  const best = multi.reduce((a, b) => (b.price / b.visits < a.price / a.visits ? b : a));
  const perVisit = pricePerVisit(best.price, best.visits);
  const savingPct = single ? Math.floor((1 - best.price / best.visits / single.price) * 100) : 0;
  return { ...best, perVisit, savingPct };
}

/** Цена за месяц для клубной карты на N месяцев. */
export function pricePerMonth(price, months) {
  return Math.round(price / months);
}

/** Ограничение счётчика гостей. */
export function clampGuests(value, min = 0, max = 20) {
  return Math.min(max, Math.max(min, value));
}
