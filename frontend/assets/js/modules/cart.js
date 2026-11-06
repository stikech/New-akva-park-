/**
 * Корзина: состояние, сохранение и отображение.
 *
 * - Состояние — массив строк { id, qty }; цены всегда из каталога (utils/cart.js).
 * - Каждое изменение (плюс, минус, добавление, удаление) сразу сохраняется в
 *   localStorage и перерисовывает всё, что подписано: список корзины, итог,
 *   счётчик в шапке. После F5 корзина восстанавливается из localStorage.
 * - Изменения в другой вкладке браузера подхватываются через событие `storage`.
 * - Неизвестные позиции (прайс обновился) при загрузке тихо отбрасываются.
 */

import { escapeHtml, formatPrice } from '../utils/format.js';
import {
  CART_MAX_QTY, CART_STORAGE_KEY, addToCart, itemsLabel, normalizeCart, priceCart, productIndex, removeLine, setQty,
} from '../utils/cart.js';

const $ = (selector, root = document) => root.querySelector(selector);

/** Хранилище корзины без DOM. storage можно подменить в тестах. */
export function createCartStore(products, { storage = safeStorage() } = {}) {
  const index = productIndex(products);
  const listeners = new Set();
  let lines = read();

  function read() {
    try {
      return normalizeCart(JSON.parse(storage?.getItem(CART_STORAGE_KEY) ?? '[]'), index);
    } catch {
      return [];
    }
  }

  function write() {
    try {
      if (lines.length) storage?.setItem(CART_STORAGE_KEY, JSON.stringify(lines));
      else storage?.removeItem(CART_STORAGE_KEY);
    } catch { /* приватный режим / переполнение — корзина живёт до закрытия вкладки */ }
  }

  function commit(next) {
    lines = next;
    write();
    emit();
  }

  function emit() {
    const snapshot = priceCart(lines, index);
    listeners.forEach((fn) => fn(snapshot));
  }

  return {
    index,
    lines: () => lines,
    priced: () => priceCart(lines, index),
    add(id, qty = 1) { if (index.has(id)) commit(addToCart(lines, id, qty)); },
    addMany(list) { commit(list.reduce((acc, l) => (index.has(l.id) ? addToCart(acc, l.id, l.qty) : acc), lines)); },
    set(id, qty) { commit(setQty(lines, id, qty)); },
    remove(id) { commit(removeLine(lines, id)); },
    clear() { commit([]); },
    /** Перечитать из localStorage (изменения из другой вкладки браузера). */
    reload() { lines = read(); emit(); },
    subscribe(fn) {
      listeners.add(fn);
      fn(priceCart(lines, index));
      return () => listeners.delete(fn);
    },
  };
}

function safeStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/**
 * Отрисовка корзины и счётчиков.
 * @param {{ root: HTMLElement, badges: HTMLElement[], links: HTMLElement[] }} dom
 * @param {ReturnType<typeof createCartStore>} cart
 * @param {{ onCheckout: () => void }} opts
 */
export function initCartView({ root, badges, links }, cart, { onCheckout }) {
  const list = $('[data-cart-lines]', root);
  const empty = $('[data-cart-empty]', root);
  const footer = $('[data-cart-footer]', root);
  const total = $('[data-cart-total]', root);
  const count = $('[data-cart-count]', root);
  const clear = $('[data-cart-clear]', root);

  function lineHtml(l) {
    const unit = l.unit === 'min' ? 'мин' : 'шт.';
    return `
      <li class="cart-line" data-id="${escapeHtml(l.id)}">
        <div class="cart-line__info">
          <b class="cart-line__title">${escapeHtml(l.title)}</b>
          <span class="cart-line__unit">${formatPrice(l.unitPrice)} × ${l.qty} ${unit}</span>
        </div>
        <div class="stepper cart-line__qty">
          <button type="button" data-cart-step="-1" aria-label="Уменьшить: ${escapeHtml(l.title)}">−</button>
          <output aria-label="Количество">${l.qty}</output>
          <button type="button" data-cart-step="1" aria-label="Увеличить: ${escapeHtml(l.title)}" ${l.qty >= CART_MAX_QTY ? 'disabled' : ''}>+</button>
        </div>
        <b class="cart-line__sum">${formatPrice(l.sum)}</b>
        <button class="cart-line__remove" type="button" data-cart-remove aria-label="Удалить: ${escapeHtml(l.title)}">×</button>
      </li>`;
  }

  function render(snapshot) {
    const has = snapshot.lines.length > 0;
    // Фокус переживает перерисовку: после «+» он остаётся на той же кнопке той же строки
    const active = document.activeElement;
    const focusLine = active && list.contains(active) ? active.closest('[data-id]')?.dataset.id : null;
    const focusAction = active?.dataset?.cartStep ?? (active?.hasAttribute?.('data-cart-remove') ? 'remove' : null);

    list.innerHTML = snapshot.lines.map(lineHtml).join('');
    empty.hidden = has;
    footer.hidden = !has;
    clear.hidden = !has;
    total.textContent = formatPrice(snapshot.total);
    count.textContent = has ? `· ${itemsLabel(snapshot.count)}` : '';

    badges.forEach((b) => {
      b.textContent = String(snapshot.count);
      b.hidden = !has;
    });
    links.forEach((a) => a.setAttribute('aria-label', has ? `Корзина: ${itemsLabel(snapshot.count)}, ${formatPrice(snapshot.total)}` : 'Корзина пуста'));

    if (focusLine) {
      const row = list.querySelector(`[data-id="${CSS.escape(focusLine)}"]`);
      const target = focusAction === 'remove' || !row
        ? (row?.querySelector('[data-cart-remove]') ?? list.querySelector('button') ?? $('[data-cart-checkout]', root))
        : row.querySelector(`[data-cart-step="${focusAction}"]`);
      (target && !target.disabled ? target : row?.querySelector('[data-cart-step="-1"]'))?.focus({ preventScroll: true });
    }
  }

  // Делегирование: строки перерисовываются, обработчик один
  list.addEventListener('click', (event) => {
    const row = event.target.closest('[data-id]');
    if (!row) return;
    const id = row.dataset.id;
    const step = event.target.closest('[data-cart-step]');
    if (step) {
      const line = cart.lines().find((l) => l.id === id);
      if (line) cart.set(id, line.qty + Number(step.dataset.cartStep));
      return;
    }
    if (event.target.closest('[data-cart-remove]')) cart.remove(id);
  });

  clear.addEventListener('click', () => {
    if (window.confirm('Очистить корзину?')) cart.clear();
  });
  $('[data-cart-checkout]', root).addEventListener('click', (event) => onCheckout(event.currentTarget));

  // Ссылка «Корзина» в шапке: прокрутка к корзине без перезагрузки
  links.forEach((a) => a.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); // роутер секций видит defaultPrevented и не вмешивается (мобильное меню закроется само)
    root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    root.focus({ preventScroll: true });
    try { history.pushState({}, '', '/prices#cart'); } catch { /* file:// */ }
  }));

  // Прямой заход на /prices#cart: доскролл к корзине
  if (location.hash === '#cart') requestAnimationFrame(() => root.scrollIntoView({ block: 'start' }));

  // Другая вкладка изменила корзину — синхронизируемся
  window.addEventListener('storage', (event) => {
    if (event.key === CART_STORAGE_KEY || event.key === null) cart.reload();
  });

  cart.subscribe(render);
}

/** Кнопки «+» в таблицах прайса (фитнес, SPA): добавляют позицию в корзину. */
export function bindAddButtons(container, cart, onAdded) {
  container.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-add-product]');
    if (!btn) return;
    cart.add(btn.dataset.addProduct, 1);
    onAdded?.(btn.dataset.addProduct, btn);
  });
}

