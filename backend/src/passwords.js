/**
 * Хеширование паролей: scrypt (встроен в Node, memory-hard) с уникальной солью.
 * Формат строки: scrypt$N$r$p$salt$hash (base64url) — параметры хранятся рядом с хешем,
 * поэтому их можно усилить позже, не ломая старые пароли.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const KEYLEN = 64;
const DEFAULTS = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password, params = DEFAULTS) {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { ...params, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64url'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(actual, expected);
}

/**
 * Хеш-пустышка: проверяем пароль и для несуществующей почты,
 * чтобы по времени ответа нельзя было понять, есть ли такой аккаунт.
 */
let dummyHash = null;
export async function dummyVerify(password) {
  dummyHash ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummyHash);
  return false;
}
