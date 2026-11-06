/**
 * Блок оплаты переводом Kaspi — общий для билетов (visit-checkout.js),
 * абонементов (shop.js) и страницы билета (ticket-page.js).
 *
 * Сервер присылает реквизиты (`payment`: номер, получатель, ссылка Kaspi Pay, QR)
 * и код заказа NP-XXXXX. Клиент переводит сумму, пишет код в комментарии и
 * жмёт «Я оплатил» — дальше администратор сверяет перевод и подтверждает.
 */

import { escapeHtml, formatPrice } from '../utils/format.js';

const copyButton = (value, label) => `
  <button class="kaspi__copy" type="button" data-copy="${escapeHtml(value)}" aria-label="Скопировать ${escapeHtml(label)}">Копировать</button>`;

/** Инструкция перевода + кнопка «Я оплатил». */
export function kaspiPayHtml({ payment, amount, code }) {
  const digits = String(payment.phone ?? '').replace(/[^\d+]/g, '');
  return `
    <div class="kaspi">
      <div class="kaspi__head">
        <span class="kaspi__logo" aria-hidden="true">K</span>
        <div>
          <b>Оплата через Kaspi</b>
          <span>перевод по номеру телефона</span>
        </div>
      </div>
      <ol class="kaspi__steps">
        <li>Откройте приложение <b>Kaspi.kz</b> → «Переводы» → «По номеру телефона».</li>
        <li>
          <span>Номер: <b class="kaspi__value">${escapeHtml(payment.phone)}</b></span>
          ${copyButton(digits, 'номер')}
          <small>Получатель: ${escapeHtml(payment.receiver ?? '')}</small>
        </li>
        <li>
          <span>Сумма: <b class="kaspi__value">${formatPrice(amount)}</b></span>
          ${copyButton(String(amount), 'сумму')}
        </li>
        <li>
          <span>В комментарии к переводу: <b class="kaspi__value kaspi__code">${escapeHtml(code)}</b></span>
          ${copyButton(code, 'код заказа')}
          <small>По этому коду мы найдём ваш перевод.</small>
        </li>
      </ol>
      ${payment.qr || payment.payLink ? `
        <div class="kaspi__alt">
          ${payment.qr ? `<img class="kaspi__qr" src="${escapeHtml(payment.qr)}" alt="Kaspi QR для оплаты" width="160" height="160">` : ''}
          ${payment.payLink ? `<a class="btn outline" href="${escapeHtml(payment.payLink)}" target="_blank" rel="noopener">Оплатить по ссылке Kaspi</a>` : ''}
        </div>` : ''}
      <p class="acc-status" data-kaspi-status role="alert"></p>
      <button class="btn primary btn--block" type="button" data-kaspi-claim>Я оплатил</button>
      <p class="note">Нажмите после перевода. Подтверждение обычно занимает несколько минут в часы работы аквапарка.</p>
    </div>`;
}

/** Ожидание подтверждения после «Я оплатил». */
export function kaspiWaitingHtml({ code, statusUrl }) {
  return `
    <div class="kaspi kaspi--wait" aria-live="polite">
      <span class="spinner" aria-hidden="true"></span>
      <div>
        <b>Проверяем перевод</b>
        <p>Как только администратор увидит перевод с кодом <b class="kaspi__code">${escapeHtml(code)}</b>, здесь появится чек.
        Страницу можно закрыть${statusUrl ? ` — статус всегда доступен по <a href="${escapeHtml(statusUrl)}">ссылке на билет</a>` : ''}.</p>
      </div>
    </div>`;
}

/** Онлайн-оплата не подключена (номер Kaspi не задан). */
export function kaspiDisabledHtml() {
  return `
    <div class="kaspi kaspi--off">
      <b>Онлайн-оплата скоро появится</b>
      <p>Сейчас оплатить можно на кассе аквапарка картой или Kaspi QR. Вопросы — <a href="tel:+77152336141">+7 7152 33-61-41</a>.</p>
    </div>`;
}

/** Кнопки «Копировать» внутри root. */
export function bindCopyButtons(root) {
  root.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        button.textContent = 'Скопировано';
      } catch {
        button.textContent = button.dataset.copy; // без доступа к буферу — показываем значение
      }
      setTimeout(() => { button.textContent = 'Копировать'; }, 2000);
    });
  });
}

/**
 * Опрос статуса, пока ждём подтверждения. fetchStatus() → запись с полем status;
 * onDone(record) вызывается, когда статус перестал быть pending.
 */
export function pollUntilSettled(fetchStatus, onDone, { intervalMs = 8000 } = {}) {
  let timer = null;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const record = await fetchStatus();
      if (record && record.status !== 'pending') { stopped = true; onDone(record); return; }
    } catch { /* сеть моргнула — попробуем на следующем шаге */ }
    if (!stopped) timer = setTimeout(tick, document.hidden ? intervalMs * 3 : intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return () => { stopped = true; clearTimeout(timer); };
}
