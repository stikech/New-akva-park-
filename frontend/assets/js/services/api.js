/**
 * Слой доступа к данным — единственная точка связи с бэкендом (backend/).
 * UI-модули не знают, откуда пришли данные.
 *
 * getSiteData() берёт данные из GET /api/site; если API недоступен
 * (статический сервер без бэкенда, сбой сети), используется встроенная копия
 * из config/site-data.js — страница не ломается (docs/api-contract.md).
 */

import { SITE_DATA } from '../config/site-data.js';

/** Базовый URL API. Относительный путь = тот же origin (бэкенд раздаёт и фронтенд). */
export const API_BASE = '/api';

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

/** Данные сайта: цены, расписание, горки. API → fallback на статическую копию. */
export async function getSiteData({ timeoutMs = 4000 } = {}) {
  try {
    const data = await fetchJson(`${API_BASE}/site`, { timeoutMs });
    if (data && typeof data === 'object' && data.prices && data.hours) return data;
    throw new Error('unexpected /api/site shape');
  } catch (error) {
    console.warn('[neptun] API недоступен, использую встроенные данные:', error.message);
    return structuredClone(SITE_DATA);
  }
}

/**
 * Текущая температура воздуха (Open-Meteo, без ключа).
 * @returns {Promise<number|null>} °C или null при любой ошибке — UI не должен падать.
 */
export async function getOutsideTemperature({ lat, lon }, { timeoutMs = 5000 } = {}) {
  const url = `${OPEN_METEO_URL}?latitude=${lat}&longitude=${lon}&current=temperature_2m`;
  try {
    const data = await fetchJson(url, { timeoutMs });
    const temperature = data?.current?.temperature_2m;
    return typeof temperature === 'number' ? temperature : null;
  } catch {
    return null;
  }
}

/**
 * Отправка отзыва: POST /api/feedback (docs/api-contract.md).
 * Если бэкенд недоступен, запрос падает — UI показывает телефон для связи.
 */
export async function sendFeedback({ name, email, message, website }) {
  return fetchJson(`${API_BASE}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim(), email: email.trim() || null, message: message.trim(), website }),
  });
}

/** Ошибка API с HTTP-статусом и телом ответа ({ error } или { errors: { поле: текст } }). */
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ?? `HTTP ${status}`);
    this.status = status;
    this.body = body ?? {};
  }
}

/** Запрос к API личного кабинета. Cookie сессии браузер отправляет сам (same-origin). */
async function accountRequest(method, path, body, { timeoutMs = 10_000, idempotencyKey } = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ApiError(0, { error: 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.' });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data);
  return data;
}

/** Личный кабинет: вход, профиль, настройки (docs/api-contract.md). */
export const accountApi = {
  // Бесплатный Render «просыпается» до минуты — короткий таймаут показывал «Войти» вошедшему.
  session: () => accountRequest('GET', '/auth/session', undefined, { timeoutMs: 20_000 }),
  register: (data) => accountRequest('POST', '/auth/register', data),
  login: (data) => accountRequest('POST', '/auth/login', data),
  logout: () => accountRequest('POST', '/auth/logout'),
  me: () => accountRequest('GET', '/account'),
  updateProfile: (patch) => accountRequest('PATCH', '/account', patch),
  changePassword: (data) => accountRequest('POST', '/account/password', data),
  logoutOthers: () => accountRequest('POST', '/account/logout-all'),
  deleteAccount: (password) => accountRequest('DELETE', '/account', { password }),
};

/**
 * Магазин и расписание: покупки, продление, запись на занятия.
 * Оплата требует заголовка Idempotency-Key — без него сервер отвечает 400,
 * это защита от двойных списков при повторах сети.
 */
export const shopApi = {
  orders: () => accountRequest('GET', '/orders'),
  order: (id) => accountRequest('GET', `/orders/${id}`),
  catalog: () => accountRequest('GET', '/catalog', undefined, { timeoutMs: 20_000 }),
  createOrder: (planId, { consent = false } = {}) => accountRequest('POST', '/orders', { planId, consent }, { idempotencyKey: crypto.randomUUID() }),
  payOrder: (id, card) => accountRequest('POST', `/orders/${id}/pay`, card),
  claimKaspi: (id) => accountRequest('POST', `/orders/${id}/kaspi-claim`, {}),
  cancelOrder: (id) => accountRequest('POST', `/orders/${id}/cancel`, {}),
};

export const scheduleApi = {
  schedule: (days = 7) => accountRequest('GET', `/schedule?days=${days}`, undefined, { timeoutMs: 6000 }),
  bookings: () => accountRequest('GET', '/bookings'),
  book: (key) => accountRequest('POST', '/bookings', { key }),
  cancel: (key) => accountRequest('DELETE', `/bookings/${key}`, {}),
};

/**
 * Онлайн-билеты аквапарка (калькулятор на главной): покупка без входа в кабинет.
 * Идемпотентность обязательна, как у абонементов: повтор сети не списывает дважды.
 */
export const visitApi = {
  create: (payload) => accountRequest('POST', '/visits', payload, { idempotencyKey: crypto.randomUUID() }),
  visit: (id) => accountRequest('GET', `/visits/${id}`),
  pay: (id, card) => accountRequest('POST', `/visits/${id}/pay`, card),
  claimKaspi: (id) => accountRequest('POST', `/visits/${id}/kaspi-claim`, {}),
};

/** Реквизиты оплаты Kaspi (backend/payment.config.js): { enabled, phone, receiver, payLink, qr }. */
export const paymentApi = {
  info: () => accountRequest('GET', '/payment', undefined, { timeoutMs: 5000 }),
};

/** fetch с таймаутом и проверкой статуса. */
async function fetchJson(url, { timeoutMs = 8000, ...init } = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}
