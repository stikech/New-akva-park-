/**
 * Уведомления администрации: новые отзывы и заявки об оплате Kaspi. Сейчас — Telegram (бесплатно, без SMTP).
 * Ошибка уведомления никогда не ломает ответ пользователю — только пишется в лог.
 */

const MAX_MESSAGE = 3500; // лимит Telegram — 4096 символов

export function createTelegramNotifier({ botToken, chatId }, { fetchImpl = fetch, log = console } = {}) {
  if (!botToken || !chatId) {
    return { enabled: false, async notify() {}, async send() {} };
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  /** Отправка текста; ошибки только в лог. */
  async function send(text) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) log.error(`[notify] Telegram ответил HTTP ${response.status}`);
    } catch (error) {
      log.error('[notify] Telegram недоступен:', error.message);
    }
  }

  return {
    enabled: true,
    send,
    async notify(record) {
      const text = [
        '🌊 Новый отзыв с сайта «Нептун»',
        `Имя: ${record.name}`,
        `Почта: ${record.email ?? '—'}`,
        '',
        record.message.slice(0, MAX_MESSAGE),
      ].join('\n');
      await send(text);
    },
  };
}
