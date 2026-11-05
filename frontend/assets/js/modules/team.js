/** Команда тренеров: вкладка на каждое направление, карточка на тренера. */

import { escapeHtml, initials } from '../utils/format.js';
import { initTabs } from './tabs.js';

function trainerTemplate({ name, role, highlights }) {
  const list = highlights.length
    ? `<ul>${highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul>`
    : '';
  return `
    <article class="trainer">
      <span class="trainer__avatar" aria-hidden="true">${escapeHtml(initials(name))}</span>
      <div>
        <h4>${escapeHtml(name)}</h4>
        ${role ? `<p class="trainer__role">${escapeHtml(role)}</p>` : ''}
        ${list}
      </div>
    </article>`;
}

export function initTeam({ tablist, panels }, groups) {
  tablist.innerHTML = groups.map((g, i) => `
    <button role="tab" type="button" id="team-tab-${g.id}" aria-controls="team-panel-${g.id}"
            aria-selected="${i === 0}">${escapeHtml(g.title)}<span class="tab-count">${g.trainers.length}</span></button>`).join('');

  panels.innerHTML = groups.map((g, i) => `
    <div class="team-grid rail-mobile" role="tabpanel" id="team-panel-${g.id}" aria-labelledby="team-tab-${g.id}" ${i === 0 ? '' : 'hidden'}>
      ${g.trainers.map(trainerTemplate).join('')}
    </div>`).join('');

  initTabs(tablist, { sync: true });
}
