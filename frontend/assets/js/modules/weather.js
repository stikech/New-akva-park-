/** Температура «снаружи» в hero. При ошибке остаётся текст из разметки («Зима»). */

import { getOutsideTemperature } from '../services/api.js?v=4';
import { formatTemperature } from '../utils/format.js';

export async function initWeather(target, coords) {
  const celsius = await getOutsideTemperature(coords);
  if (celsius !== null) {
    target.textContent = formatTemperature(celsius);
  }
}
