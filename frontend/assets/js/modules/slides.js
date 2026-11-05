/** Карточки горок и фильтр по росту катающегося. */

import { escapeHtml } from '../utils/format.js';

const COLOR_VARS = { orange: '--s-orange', green: '--s-green', yellow: '--s-yellow', blue: '--s-blue' };
const UNKNOWN = 'уточняется';

const withUnit = (value, unit) => (value == null ? UNKNOWN : `${value} ${unit}`);
const withPct = (value) => (value == null ? UNKNOWN : `${value}%`);

function slideTemplate(slide, index) {
  const colorVar = COLOR_VARS[slide.color] ?? '--water';
  return `
    <article class="slide" data-index="${index}" style="--c: var(${colorVar})">
      <h3>${escapeHtml(slide.name)}</h3>
      <span class="lvl">${escapeHtml(slide.level)}</span>
      <svg class="tube" viewBox="0 0 240 84" fill="none" aria-hidden="true">
        <path d="${escapeHtml(slide.path)}" stroke-width="10" stroke-linecap="round"/>
      </svg>
      <dl>
        <dt>Старт</dt><dd>${withUnit(slide.startHeightM, 'м')}</dd>
        <dt>Длина трассы</dt><dd>${withUnit(slide.lengthM, 'м')}</dd>
        <dt>Средний уклон</dt><dd>${withPct(slide.slopePct)}</dd>
        <dt>Рост от</dt><dd>${withUnit(slide.minHeightCm, 'см')}</dd>
      </dl>
      <div class="verdict"></div>
    </article>`;
}

/** Вердикт для карточки: можно ли кататься при данном росте. */
export function heightVerdict(minHeightCm, heightCm) {
  if (minHeightCm == null) return { allowed: true, text: 'Ограничение по росту уточняйте у инструктора' };
  if (heightCm >= minHeightCm) return { allowed: true, text: 'Можно кататься' };
  return { allowed: false, text: `Нужно ещё ${minHeightCm - heightCm} см` };
}

export function initSlides({ list, heightInput, heightOutput }, slides) {
  list.innerHTML = slides.map(slideTemplate).join('');
  const cards = [...list.querySelectorAll('.slide')];

  function applyHeight() {
    const height = Number(heightInput.value);
    heightOutput.textContent = `${height} см`;

    cards.forEach((card) => {
      const { allowed, text } = heightVerdict(slides[card.dataset.index].minHeightCm, height);
      card.classList.toggle('no', !allowed);
      card.querySelector('.verdict').textContent = text;
    });
  }

  heightInput.addEventListener('input', applyHeight);
  applyHeight();
}
