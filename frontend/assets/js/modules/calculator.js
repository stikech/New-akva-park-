/**
 * Калькулятор визита в аквапарк. Состояние локальное, расчёт — в utils/pricing.js.
 *
 * Итог «доезжает» до новой суммы, полоса под ним показывает, сколько приходится на взрослых
 * и на детей, подсказка сравнивает «2 часа» и «без лимита». Кнопка кладёт билеты в корзину
 * (modules/cart-ui.js) — оплата всего сразу на /checkout.
 */

import { formatPrice } from '../utils/format.js';
import { calcParkTotal, clampGuests } from '../utils/pricing.js';
import { addToCart, openCart } from './cart-ui.js?v=1';

export function initCalculator(root, park, initialDay) {
  const state = { adult: 2, child: 1, day: initialDay, duration: 'unl' };

  const outputs = {
    adult: root.querySelector('[data-count="adult"]'),
    child: root.querySelector('[data-count="child"]'),
    total: root.querySelector('[data-total]'),
    bar: root.querySelector('[data-calc-bar]'),
    hint: root.querySelector('[data-calc-hint]'),
  };
  const groups = [...root.querySelectorAll('.seg[data-group]')];
  const addBtn = root.querySelector('[data-calc-add]');
  let shown = 0;
  let frame = 0;

  /** Плавно «докручивает» сумму — видно, на сколько изменилось. */
  function animateTotal(to) {
    cancelAnimationFrame(frame);
    const from = shown;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || from === to) {
      shown = to;
      outputs.total.textContent = to ? formatPrice(to) : '—';
      return;
    }
    const started = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - started) / 380);
      shown = Math.round(from + (to - from) * (1 - (1 - k) ** 3));
      outputs.total.textContent = formatPrice(shown);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }

  function render() {
    outputs.adult.textContent = state.adult;
    outputs.child.textContent = state.child;
    groups.forEach((group) => {
      group.querySelectorAll('button').forEach((btn) =>
        btn.setAttribute('aria-pressed', String(btn.dataset.value === state[group.dataset.group])));
    });
    const total = calcParkTotal(park, state);
    animateTotal(total);

    const adults = state.adult * park.adult[state.day][state.duration];
    if (outputs.bar) {
      outputs.bar.style.setProperty('--adult', total ? `${(adults / total) * 100}%` : '0%');
      outputs.bar.dataset.empty = String(!total);
      outputs.bar.querySelector('[data-part="adult"]').textContent = state.adult ? `Взрослые ${formatPrice(adults)}` : '';
      outputs.bar.querySelector('[data-part="child"]').textContent = state.child ? `Дети ${formatPrice(total - adults)}` : '';
    }

    if (outputs.hint) {
      const other = state.duration === 'unl' ? 'h2' : 'unl';
      const diff = Math.abs(calcParkTotal(park, { ...state, duration: other }) - total);
      const guests = state.adult + state.child;
      outputs.hint.textContent = !guests ? 'Добавьте хотя бы одного гостя.'
        : state.duration === 'h2'
          ? `Без ограничения времени — всего на ${formatPrice(diff)} больше за всю компанию.`
          : `Время не ограничено. Тариф «2 часа» был бы дешевле на ${formatPrice(diff)}.`;
    }
    if (addBtn) addBtn.disabled = state.adult + state.child === 0;
  }

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

  addBtn?.addEventListener('click', () => {
    let ok = true;
    if (state.adult) ok = addToCart(`park:adult:${state.day}:${state.duration}`, state.adult, { from: addBtn, quiet: true }) && ok;
    if (state.child) ok = addToCart(`park:child:${state.day}:${state.duration}`, state.child, { from: addBtn, quiet: true }) && ok;
    if (ok) setTimeout(() => openCart(addBtn), 600); // сначала билеты «долетают» до корзины
  });

  render();
  return { render };
}
