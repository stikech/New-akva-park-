/**
 * Форма отзыва. Валидация на клиенте, отправка через services/api.js.
 * Если бэкенд недоступен, отправка завершается ошибкой — форма показывает телефон.
 * Те же правила валидации использует сервер (backend/src/feedback.js).
 */

import { sendFeedback } from '../services/api.js?v=4';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Проверка полей. Возвращает { field: сообщение } для невалидных полей. */
export function validateFeedback({ name, email, message, consent }) {
  const errors = {};
  // Имя и почта — персональные данные: без согласия на обработку отзыв не принимаем.
  if (consent !== true) errors.consent = 'Нужно согласие на обработку персональных данных';
  if (!name.trim()) errors.name = 'Укажите имя';
  if (email.trim() && !EMAIL_RE.test(email.trim())) errors.email = 'Проверьте адрес почты';
  if (message.trim().length < 5) errors.message = 'Напишите отзыв — хотя бы пару слов';
  return errors;
}

export function initFeedback(form, { fallbackPhone }) {
  const status = form.querySelector('[data-status]');
  const submit = form.querySelector('button[type="submit"]');

  function showErrors(errors) {
    form.querySelectorAll('[data-error]').forEach((el) => {
      const field = el.dataset.error;
      el.textContent = errors[field] ?? '';
      form.elements[field]?.setAttribute('aria-invalid', String(Boolean(errors[field])));
    });
  }

  function setStatus(text, kind) {
    status.textContent = text;
    status.dataset.kind = kind;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = {
      name: form.elements.name.value,
      email: form.elements.email.value,
      message: form.elements.message.value,
      website: form.elements.website.value, // honeypot: заполняют только боты
      consent: form.elements.consent.checked,
    };

    const errors = validateFeedback(values);
    showErrors(errors);
    if (Object.keys(errors).length) {
      form.elements[Object.keys(errors)[0]].focus();
      return;
    }

    submit.disabled = true;
    setStatus('Отправляем…', 'pending');
    try {
      await sendFeedback(values);
      form.reset();
      setStatus('Спасибо! Отзыв отправлен.', 'ok');
    } catch {
      setStatus(`Не удалось отправить отзыв. Позвоните нам: ${fallbackPhone}`, 'error');
    } finally {
      submit.disabled = false;
    }
  });
}
