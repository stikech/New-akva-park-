/**
 * Корзина в интерфейсе: кнопка со счётчиком в шапке каждой страницы, выезжающая панель
 * с позициями (±, удалить, итог), кнопки «в корзину» и короткое подтверждение.
 *
 * Кнопки размечаются атрибутом data-add="<id из utils/catalog.js>" (+ data-qty) — клики ловятся
 * делегированием на всей странице. Добавленная позиция «летит» в корзину из точки клика.
 */

import { SITE_DATA } from '../config/site-data.js';
import { CART_LIMITS, GROUPS, buildCatalog } from '../utils/catalog.js?v=1';
import { escapeHtml, formatPrice } from '../utils/format.js';
import { cart } from './cart.js?v=1';

const CART_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h2.2l2.4 11.2a1.6 1.6 0 0 0 1.6 1.3h8.6a1.6 1.6 0 0 0 1.6-1.2L21 8H6.2"/><circle cx="9.5" cy="20" r="1.3"/><circle cx="17.5" cy="20" r="1.3"/></svg>';
export const PLUS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const GROUP_EMOJI = { park: '🌊', pool: '🏊', fitness: '💪', spa: '🌿', classes: '🗓' };

const byId = new Map(buildCatalog(SITE_DATA).map((item) => [item.id, item]));
const groupTitle = new Map(GROUPS.map((g) => [g.id, g.title]));

/** Позиция корзины для показа: из каталога или из meta (занятия). */
export function describe(line) {
  const item = byId.get(line.id);
  if (item) return item;
  if (line.id.startsWith('class:') && line.meta) {
    return { id: line.id, group: 'classes', kind: 'class', title: String(line.meta.title), option: String(line.meta.option), price: Number(line.meta.price) || 0 };
  }
  return null;
}

/** Кнопка «добавить в корзину» для прайса. label — что именно добавляется (для скринридера). */
export function addButton(id, label) {
  return `<button class="add-btn" type="button" data-add="${escapeHtml(id)}" aria-label="В корзину: ${escapeHtml(label)}" title="В корзину">${PLUS_ICON}</button>`;
}

// ---------- подтверждение ----------

let toastEl = null;
let toastTimer = 0;

export function showToast(text, action) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
    document.body.append(toastEl);
  }
  toastEl.replaceChildren(document.createTextNode(text));
  if (action) {
    const btn = Object.assign(document.createElement('button'), { type: 'button', textContent: action.label, className: 'toast__action' });
    btn.addEventListener('click', action.run);
    toastEl.append(btn);
  }
  requestAnimationFrame(() => toastEl.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3600);
}

// ---------- шапка и панель ----------

let panel = null;
let opener = null;
const buttons = [];

function injectHeaderButton() {
  const bar = document.querySelector('header .bar');
  if (!bar || bar.querySelector('.cart-btn')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cart-btn';
  btn.setAttribute('aria-label', 'Корзина');
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.innerHTML = `${CART_ICON}<span class="cart-btn__count" aria-hidden="true"></span>`;
  btn.addEventListener('click', () => openCart(btn));
  bar.insertBefore(btn, bar.querySelector('.lang') ?? bar.querySelector('.theme-btn'));
  buttons.push(btn);
}

function renderBadges() {
  const n = cart.count();
  buttons.forEach((btn) => {
    btn.querySelector('.cart-btn__count').textContent = n ? String(n) : '';
    btn.setAttribute('aria-label', n ? `Корзина: ${n}` : 'Корзина пуста');
  });
}

function bump() {
  buttons.forEach((b) => { b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); });
}

function ensurePanel() {
  if (panel) return panel;
  panel = document.createElement('div');
  panel.className = 'cart-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="cart-panel__overlay" data-cart-close></div>
    <aside class="cart-panel__box" role="dialog" aria-modal="true" aria-labelledby="cartPanelTitle">
      <div class="cart-panel__head">
        <h2 id="cartPanelTitle">Корзина</h2>
        <button class="vc-close" type="button" data-cart-close aria-label="Закрыть">×</button>
      </div>
      <div class="cart-panel__body"></div>
      <div class="cart-panel__foot"></div>
    </aside>`;
  document.body.append(panel);
  panel.addEventListener('click', (event) => {
    if (event.target.closest('[data-cart-close]')) closeCart();
    const step = event.target.closest('[data-step]');
    if (step) cart.set(step.dataset.id, cart.qty(step.dataset.id) + Number(step.dataset.step));
    const del = event.target.closest('[data-remove]');
    if (del) cart.remove(del.dataset.remove);
  });
  panel.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeCart(); });
  return panel;
}

export function cartLinesHtml(lines, { editable = true } = {}) {
  return lines.map((line) => {
    const item = describe(line);
    if (!item) return '';
    const max = item.kind === 'class' ? line.qty >= 1 : line.qty >= CART_LIMITS.qty; // занятие — одно место; остальное до лимита
    return `
      <li class="cart-line" data-group="${item.group}">
        <span class="cart-line__icon" aria-hidden="true">${GROUP_EMOJI[item.group] ?? '•'}</span>
        <div class="cart-line__text">
          <b>${escapeHtml(item.title)}</b>
          <small>${escapeHtml(item.option)} · ${formatPrice(item.price)}</small>
        </div>
        ${editable ? `
          <div class="stepper cart-line__qty">
            <button type="button" data-step="-1" data-id="${escapeHtml(line.id)}" aria-label="Меньше">−</button>
            <output>${line.qty}</output>
            <button type="button" data-step="1" data-id="${escapeHtml(line.id)}" aria-label="Больше" ${max ? 'disabled' : ''}>+</button>
          </div>` : `<span class="cart-line__x">× ${line.qty}</span>`}
        <b class="cart-line__sum">${formatPrice(item.price * line.qty)}</b>
        ${editable ? `<button class="cart-line__del" type="button" data-remove="${escapeHtml(line.id)}" aria-label="Убрать ${escapeHtml(item.title)}">×</button>` : ''}
      </li>`;
  }).join('');
}

export function cartTotal(lines) {
  return lines.reduce((sum, line) => sum + (describe(line)?.price ?? 0) * line.qty, 0);
}

function renderPanel() {
  if (!panel || panel.hidden) return;
  const lines = cart.lines().filter((l) => describe(l));
  const body = panel.querySelector('.cart-panel__body');
  const foot = panel.querySelector('.cart-panel__foot');
  if (!lines.length) {
    body.innerHTML = `
      <div class="cart-empty">
        <div class="cart-empty__icon" aria-hidden="true">${CART_ICON}</div>
        <p><b>Корзина пока пуста</b></p>
        <p class="muted">Соберите визит в калькуляторе или добавьте абонемент, SPA и занятия кнопкой «+».</p>
        <div class="cart-empty__links">
          <a class="btn ghost" href="/prices">Билеты и калькулятор</a>
          <a class="btn ghost" href="/prices#shop">Абонементы</a>
          <a class="btn ghost" href="/classes">Занятия</a>
        </div>
      </div>`;
    foot.innerHTML = '';
    return;
  }
  const groups = [...new Set(lines.map((l) => describe(l).group))];
  body.innerHTML = `
    <p class="cart-panel__groups">${groups.map((g) => `<span class="chip">${GROUP_EMOJI[g]} ${escapeHtml(groupTitle.get(g) ?? g)}</span>`).join('')}</p>
    <ul class="cart-lines">${cartLinesHtml(lines)}</ul>`;
  foot.innerHTML = `
    <div class="cart-total"><span>Итого</span><b>${formatPrice(cartTotal(lines))}</b></div>
    <a class="btn primary btn--block" href="/checkout">Оформить заказ</a>
    <p class="note" data-pay-note>Окончательную сумму сайт сверит с прейскурантом.</p>`;
  payNote(foot.querySelector('[data-pay-note]'));
}

/** Способы оплаты — один запрос на страницу: «Принимаем карты», если аквапарк принимает. */
let methodsPromise = null;
function payNote(el) {
  methodsPromise ??= fetch('/api/checkout/options').then((r) => r.json()).then((d) => d.methods).catch(() => null);
  methodsPromise.then((m) => {
    if (!el.isConnected) return;
    el.textContent = m && (m.card?.enabled || m.transfer?.enabled)
      ? '💳 Можно оплатить банковской картой: Visa, Mastercard, Kaspi Gold.'
      : 'Оплата на кассе по коду заказа. Окончательную сумму сайт сверит с прейскурантом.';
  });
}

export function openCart(from = null) {
  ensurePanel();
  opener = from ?? document.activeElement;
  panel.hidden = false;
  document.body.classList.add('cart-open');
  renderPanel();
  requestAnimationFrame(() => panel.classList.add('open'));
  panel.querySelector('.vc-close').focus();
}

export function closeCart() {
  if (!panel || panel.hidden) return;
  panel.classList.remove('open');
  document.body.classList.remove('cart-open');
  setTimeout(() => { panel.hidden = true; }, 220);
  opener?.focus?.();
}

/** Позиция «летит» из точки клика в кнопку корзины. */
function fly(from) {
  const target = buttons.find((b) => b.offsetParent !== null);
  if (!from || !target || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const a = from.getBoundingClientRect();
  const b = target.getBoundingClientRect();
  const dot = document.createElement('span');
  dot.className = 'cart-fly';
  dot.style.left = `${a.left + a.width / 2}px`;
  dot.style.top = `${a.top + a.height / 2}px`;
  document.body.append(dot);
  dot.animate([
    { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
    { transform: `translate(calc(-50% + ${(b.left + b.width / 2) - (a.left + a.width / 2)}px), calc(-50% + ${(b.top + b.height / 2) - (a.top + a.height / 2)}px)) scale(.4)`, opacity: .6 },
  ], { duration: 650, easing: 'cubic-bezier(.5,-0.3,.6,1)' }).finished.then(() => dot.remove(), () => dot.remove());
}

/** Добавить позицию в корзину с анимацией и подтверждением. */
export function addToCart(id, qty = 1, { from = null, ref, meta, quiet = false } = {}) {
  const item = describe({ id, meta });
  if (!cart.add(id, qty, { ref, meta })) {
    showToast('В корзине уже 20 разных позиций', { label: 'Открыть', run: () => openCart() });
    return false;
  }
  fly(from);
  if (!quiet) showToast(item ? `${item.title} — в корзине` : 'Добавлено в корзину', { label: 'Открыть корзину', run: () => openCart() });
  return true;
}

/** Запуск на каждой странице: кнопка в шапке, делегирование data-add. */
export function initCartUi() {
  injectHeaderButton();
  cart.retain((id) => byId.has(id) || id.startsWith('class:'));
  renderBadges();
  cart.onChange(() => { renderBadges(); bump(); renderPanel(); });

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-add]');
    if (!btn) return;
    const qty = Number(btn.dataset.qty) || 1;
    if (addToCart(btn.dataset.add, qty, { from: btn })) {
      btn.classList.add('done');
      setTimeout(() => btn.classList.remove('done'), 900);
    }
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-open-cart]')) { event.preventDefault(); openCart(event.target.closest('[data-open-cart]')); }
  });
  if (new URLSearchParams(location.search).has('cart')) openCart();
}
