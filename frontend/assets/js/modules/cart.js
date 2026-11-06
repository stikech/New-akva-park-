/**
 * Корзина: список { id, qty, ref? } в localStorage (на этом устройстве и в этом браузере).
 * Цены здесь не хранятся — их берут из каталога (utils/catalog.js), окончательную сумму считает сервер.
 * ref — id записи на занятие для позиций class:… (место уже занято, в корзине — только оплата);
 * meta — подпись занятия { title, option, price } для показа: занятий нет в статическом каталоге.
 * Если localStorage недоступен (приватный режим), корзина живёт до перезагрузки страницы.
 */

import { CART_LIMITS } from '../utils/catalog.js?v=1';

const KEY = 'neptun-cart';
const listeners = new Set();
let memory = [];

function read() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((l) => typeof l?.id === 'string' && Number.isInteger(l.qty) && l.qty > 0)
      : [];
  } catch {
    return memory;
  }
}

function write(lines) {
  memory = lines;
  try { localStorage.setItem(KEY, JSON.stringify(lines)); } catch { /* приватный режим */ }
  listeners.forEach((fn) => fn(lines));
}

const single = (id) => id.startsWith('class:') || id.startsWith('plan:');
const clampQty = (id, q) => Math.max(0, Math.min(single(id) ? 1 : CART_LIMITS.qty, q));

export const cart = {
  lines: read,

  count: () => read().reduce((s, l) => s + l.qty, 0),

  qty: (id) => read().find((l) => l.id === id)?.qty ?? 0,

  /** Добавляет qty к позиции (или создаёт её). Возвращает false, если корзина полна. */
  add(id, qty = 1, { ref, meta } = {}) {
    let lines = read();
    // Абонемент в заказе один: новый заменяет прежний.
    if (id.startsWith('plan:')) lines = lines.filter((l) => !l.id.startsWith('plan:') || l.id === id);
    const line = lines.find((l) => l.id === id);
    if (line) line.qty = clampQty(id, line.qty + qty);
    else if (lines.length >= CART_LIMITS.lines) return false;
    else lines.push({ id, qty: clampQty(id, qty), ...(ref ? { ref } : {}), ...(meta ? { meta } : {}) });
    write(lines.filter((l) => l.qty > 0));
    return true;
  },

  set(id, qty) {
    const lines = read();
    const line = lines.find((l) => l.id === id);
    if (line) line.qty = clampQty(id, qty);
    write(lines.filter((l) => l.qty > 0));
  },

  remove(id) {
    write(read().filter((l) => l.id !== id));
  },

  /** Оставить только позиции, которые есть в каталоге (после обновления цен). */
  retain(isKnown) {
    const lines = read();
    const kept = lines.filter((l) => isKnown(l.id));
    if (kept.length !== lines.length) write(kept);
    return lines.length - kept.length;
  },

  clear: () => write([]),

  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

// Корзина изменилась в другой вкладке — обновляем счётчики и здесь.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === KEY) listeners.forEach((fn) => fn(read()));
  });
}
