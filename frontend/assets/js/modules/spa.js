/** SPA: прайс массажа, солярия и прессотерапии. */

import { escapeHtml, formatHour, formatPrice } from '../utils/format.js';
import { pricePerVisit } from '../utils/pricing.js';

const priceRow = (name, meta, price) => `
  <li><span>${escapeHtml(name)}${meta ? `<small>${escapeHtml(meta)}</small>` : ''}</span><b>${formatPrice(price)}</b></li>`;

function solariumGroup({ title, perMinute, certificates }) {
  return `
    <div class="price-group">
      <h4>${escapeHtml(title)}</h4>
      <ul class="price-list">
        ${perMinute.map((p) => priceRow(p.name, 'за минуту', p.price)).join('')}
        ${certificates.map((c) => priceRow(`${c.minutes} минут`, 'сертификат', c.price)).join('')}
      </ul>
    </div>`;
}

export function renderSpa({ massage, massageHours, booking, solarium, solariumNote, press, pressCard }, spa) {
  massage.innerHTML = spa.massage.map((m) => priceRow(m.name, m.duration, m.price)).join('');
  massageHours.textContent = `Ежедневно ${formatHour(spa.massageHours[0])}–${formatHour(spa.massageHours[1])}`;
  booking.innerHTML = spa.booking
    .map((b) => `<a href="tel:${escapeHtml(b.tel)}">${escapeHtml(b.display)}</a>`)
    .join(', ');

  solarium.innerHTML = spa.solarium.groups.map(solariumGroup).join('');
  solariumNote.textContent = `${spa.solarium.units} турбо-солярия, косметика для загара ${spa.solarium.cosmetics}.`;

  const { single, course, minutes } = spa.pressotherapy;
  press.innerHTML =
    priceRow('1 сеанс', `${minutes} минут`, single) +
    priceRow(`${course.sessions} сеансов`, `${formatPrice(pricePerVisit(course.price, course.sessions))} за сеанс`, course.price);
  pressCard.textContent = `${formatPrice(single)}, курс из ${course.sessions} сеансов — ${formatPrice(course.price)}`;
}
