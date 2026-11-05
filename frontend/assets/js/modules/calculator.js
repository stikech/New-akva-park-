/** Калькулятор визита в аквапарк. Состояние локальное, расчёт — в utils/pricing.js. */

import { formatPrice } from '../utils/format.js';
import { calcParkTotal, clampGuests } from '../utils/pricing.js';

export function initCalculator(root, park, initialDay) {
  const state = { adult: 2, child: 1, day: initialDay, duration: 'unl' };

  const outputs = {
    adult: root.querySelector('[data-count="adult"]'),
    child: root.querySelector('[data-count="child"]'),
    total: root.querySelector('[data-total]'),
  };
  const groups = [...root.querySelectorAll('.seg[data-group]')];

  function render() {
    outputs.adult.textContent = state.adult;
    outputs.child.textContent = state.child;
    groups.forEach((group) => {
      group.querySelectorAll('button').forEach((btn) =>
        btn.setAttribute('aria-pressed', String(btn.dataset.value === state[group.dataset.group])));
    });
    outputs.total.textContent = formatPrice(calcParkTotal(park, state));
  }

  // Покупка билетов: модуль visit-checkout.js ловит событие и открывает чекаут
  const buyBtn = root.querySelector('[data-visit-buy]');
  buyBtn?.addEventListener('click', (event) => {
    root.dispatchEvent(new CustomEvent('neptun:visit-buy', {
      bubbles: true,
      detail: { ...state, source: event.currentTarget },
    }));
  });

  root.querySelectorAll('.stepper button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.guest;
      state[key] = clampGuests(state[key] + Number(btn.dataset.step));
      render();
    });
  });

  groups.forEach((group) => {
    group.addEventListener('click', (event) => {
      const btn = event.target.closest('button');
      if (!btn) return;
      state[group.dataset.group] = btn.dataset.value;
      render();
    });
  });

  render();
}
