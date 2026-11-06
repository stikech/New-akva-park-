/**
 * Серверная валидация отзыва. Правила — те же, что у формы на сайте
 * (импортируем validateFeedback из фронтенда, чтобы не разъезжались),
 * плюс то, что клиент не проверяет: типы и максимальная длина.
 */

import { validateFeedback } from '../../frontend/assets/js/modules/feedback.js';

export const LIMITS = { name: 80, email: 254, message: 3000 };

/**
 * @returns {{ ok: true, value: { name: string, email: string|null, message: string }, isBot: boolean }
 *          | { ok: false, errors: Record<string, string> }}
 */
export function parseFeedback(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: { form: 'Некорректные данные формы' } };
  }

  const raw = {
    name: body.name,
    email: body.email ?? '',
    message: body.message,
    website: body.website ?? '',
    consent: body.consent,
  };

  const typeErrors = {};
  for (const field of ['name', 'email', 'message', 'website']) {
    if (typeof raw[field] !== 'string') typeErrors[field] = 'Ожидается строка';
  }
  if (Object.keys(typeErrors).length) return { ok: false, errors: typeErrors };

  const errors = validateFeedback(raw);
  for (const [field, max] of Object.entries(LIMITS)) {
    if (!errors[field] && raw[field].trim().length > max) {
      errors[field] = `Не больше ${max} символов`;
    }
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  return {
    ok: true,
    isBot: raw.website.trim() !== '',
    value: {
      name: raw.name.trim(),
      email: raw.email.trim() || null,
      message: raw.message.trim(),
    },
  };
}
