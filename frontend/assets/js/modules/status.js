/** Индикатор «Открыто / Закрыто» в hero. Обновляется раз в минуту и при смене языка. */

import { cityNow, getOpenStatus } from '../utils/time.js';
import { formatHour } from '../utils/format.js';

const REFRESH_MS = 60_000;

export function initOpenStatus({ dot, text }, { schedule, tzOffsetHours }, i18n) {
  function render() {
    const { isOpen, closesAt, opensAt } = getOpenStatus(schedule, cityNow(tzOffsetHours));
    dot.classList.toggle('off', !isOpen);
    text.textContent = isOpen ? i18n.t('open', formatHour(closesAt)) : i18n.t('closed', formatHour(opensAt));
  }

  i18n.onChange(render);
  setInterval(render, REFRESH_MS);
}
