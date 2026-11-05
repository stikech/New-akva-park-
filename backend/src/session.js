/**
 * Общий страж сессий для всех «личных» API (кабинет, заказы, записи).
 * Раньше requireUser жил внутри accounts.js — теперь им пользуются
 * и платёжные, и бронировочные маршруты.
 */

import { HttpError, parseCookies } from './http.js';

/** Имя cookie сессии. При HTTPS используется флаг Secure (см. accounts.js). */
export const SESSION_COOKIE = 'neptun_sid';

/** Токен сессии из cookie. Ничего не бросает — отсутствие cookie это норма. */
export function sessionToken(req) {
  const cookies = parseCookies(req);
  return cookies[SESSION_COOKIE] ?? cookies[`__Host-${SESSION_COOKIE}`] ?? null;
}

/**
 * Текущий пользователь или HttpError 401.
 * Все личные маршруты считают отсутствие сессии одной и той же ошибкой —
 * так проще на фронте и нет лишних утечек информации.
 */
export function createUserGuard({ accounts }) {
  return async function requireUser(req) {
    const token = sessionToken(req);
    const user = await accounts.userBySession(token);
    if (!user) throw new HttpError(401, 'Войдите в аккаунт');
    return { user, token };
  };
}
