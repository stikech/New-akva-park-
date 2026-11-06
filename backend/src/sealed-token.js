/**
 * Зашифрованные токены (AES-256-GCM): сессия клиента и вход сотрудника в админку.
 *
 * Зачем: на бесплатном Render диск стирается при каждом «засыпании» сервера, и
 * сессии из файла пропадали — клиента выкидывало из кабинета. Токен в cookie несёт
 * всё нужное сам: кто вошёл, до когда, и (для клиента) снимок аккаунта, чтобы сервер
 * мог восстановить его после перезапуска. Прочитать или подделать токен без ключа
 * сервера нельзя: GCM проверяет целостность, содержимое зашифровано.
 *
 * Ключ — SESSION_SECRET, иначе выводится из ADMIN_TOKEN (он постоянный в Render).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const PREFIX = 'v2.';

/** 32-байтный ключ из строки-секрета (или случайный — для разработки и тестов). */
export function deriveKey(secret) {
  return secret ? createHash('sha256').update(`neptun-session|${secret}`).digest() : randomBytes(32);
}

export function seal(payload, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(deflateRawSync(Buffer.from(JSON.stringify(payload)))), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** Расшифровка; null — не наш токен, испорчен или ключ сменился. */
export function unseal(token, key) {
  if (typeof token !== 'string' || !token.startsWith(PREFIX) || token.length > 6000) return null;
  try {
    const raw = Buffer.from(token.slice(PREFIX.length), 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    return JSON.parse(inflateRawSync(plain).toString('utf8'));
  } catch {
    return null;
  }
}

export const isSealed = (token) => typeof token === 'string' && token.startsWith(PREFIX);
