/**
 * Страница билета /ticket?id=… — статус онлайн-покупки в любой момент:
 * реквизиты Kaspi (если ещё не оплачено), ожидание подтверждения, чек с кодом
 * для входа. Ссылку можно сохранить или переслать; последние билеты этого
 * браузера помнит localStorage.
 */

import { visitApi } from '../services/api.js?v=4';
import { escapeHtml, formatPrice, plural } from '../utils/format.js';
import { bindCopyButtons, kaspiDisabledHtml, kaspiPayHtml, kaspiWaitingHtml, pollUntilSettled } from './kaspi-pay.js';

const STORAGE_KEY = 'neptun:tickets';
const DAY_LABEL = { weekday: 'будни', weekend: 'выходные' };
const DURATION_LABEL = { h2: '2 часа', unl: 'без лимита' };

export const ticketUrl = (id) => `/ticket?id=${encodeURIComponent(id)}`;

function storedTickets() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Запоминает билет в этом браузере (последние 10). */
export function rememberTicket(id) {
  try {
    const list = [id, ...storedTickets().filter((x) => x !== id)].slice(0, 10);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch { /* приватный режим — ссылка на билет всё равно работает */ }
}

const guestsText = (v) => [
  v.adults ? `${v.adults} ${plural(v.adults, ['взрослый', 'взрослых', 'взрослых'])}` : null,
  v.children ? `${v.children} ${plural(v.children, ['ребёнок', 'ребёнка', 'детей'])}` : null,
].filter(Boolean).join(' + ');

const summary = (v) => `${guestsText(v)} · ${DAY_LABEL[v.day] ?? v.day} · ${DURATION_LABEL[v.duration] ?? v.duration}`;

function bodyHtml(visit, payment) {
  if (visit.status === 'paid') {
    const r = visit.receipt;
    return `
      <div class="ticket__pass">
        <span class="ticket__stamp">${visit.usedAt ? 'Билет использован' : 'Оплачено'}</span>
        <span class="ticket__label">Код для входа</span>
        <b class="ticket__code">${escapeHtml(visit.payCode ?? visit.id.slice(0, 8))}</b>
        <p>Назовите код на кассе — администратор выдаст браслеты.</p>
      </div>
      <dl class="vc-list">
        <div><dt>Гости</dt><dd>${escapeHtml(summary(visit))}</dd></div>
        <div><dt>Сумма</dt><dd>${formatPrice(visit.price)}</dd></div>
        ${r ? `<div><dt>Чек</dt><dd>${escapeHtml(r.receiptId)}</dd></div>
        <div><dt>Оплачено</dt><dd>${new Date(r.paidAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</dd></div>` : ''}
        ${visit.usedAt ? `<div><dt>Вход</dt><dd>${new Date(visit.usedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</dd></div>` : ''}
      </dl>`;
  }
  if (visit.status === 'pending') {
    if (!payment?.enabled) return kaspiDisabledHtml();
    if (visit.kaspi?.claimedAt) return kaspiWaitingHtml({ code: visit.payCode });
    return kaspiPayHtml({ payment, amount: visit.price, code: visit.payCode });
  }
  const reason = visit.kaspi?.rejectReason;
  return `
    <div class="kaspi kaspi--off">
      <b>${visit.status === 'expired' ? 'Срок оплаты истёк' : 'Заказ отменён'}</b>
      <p>${reason ? `${escapeHtml(reason)}. ` : ''}Если вы уже перевели деньги — позвоните на ресепшен
      <a href="tel:+77152336141">+7 7152 33-61-41</a> и назовите код <b>${escapeHtml(visit.payCode ?? '')}</b>.</p>
      <a class="btn primary" href="/prices">Оформить заново</a>
    </div>`;
}

export function initTicketPage(root) {
  if (!root) return;
  const id = new URLSearchParams(location.search).get('id');
  let stop = () => {};

  async function listRecent() {
    const ids = storedTickets();
    if (!ids.length) {
      root.innerHTML = `
        <div class="panel ticket__empty">
          <p><b>Здесь появятся ваши билеты.</b></p>
          <p class="note">Купите билеты онлайн в разделе «Цены» — после оплаты код для входа будет на этой странице.</p>
          <a class="btn primary" href="/prices">Купить билеты</a>
        </div>`;
      return;
    }
    const results = await Promise.allSettled(ids.map((x) => visitApi.visit(x)));
    const items = results.filter((r) => r.status === 'fulfilled').map((r) => r.value.visit);
    const label = { paid: 'Оплачен', pending: 'Ждёт оплаты', cancelled: 'Отменён', expired: 'Истёк' };
    root.innerHTML = `
      <ul class="ticket__list">
        ${items.map((v) => `
          <li><a class="panel ticket__row" href="${escapeHtml(ticketUrl(v.id))}">
            <span><b>${escapeHtml(v.payCode ?? v.id.slice(0, 8))}</b> · ${escapeHtml(summary(v))}</span>
            <span class="ticket__row-right">${formatPrice(v.price)} <span class="badge" data-code="${v.status === 'paid' ? 'active' : 'none'}">${label[v.status] ?? v.status}</span></span>
          </a></li>`).join('') || '<li class="note">Билеты не найдены.</li>'}
      </ul>`;
  }

  async function show() {
    stop();
    let data;
    try {
      data = await visitApi.visit(id);
    } catch (error) {
      root.innerHTML = `<div class="panel"><p>${error.status === 404 ? 'Билет не найден — проверьте ссылку.' : escapeHtml(error.message)}</p></div>`;
      return;
    }
    const { visit, payment } = data;
    root.innerHTML = `
      <article class="panel ticket">
        <h2 class="ticket__title">Билеты в аквапарк</h2>
        <p class="ticket__summary">${escapeHtml(summary(visit))} · <b>${formatPrice(visit.price)}</b></p>
        ${bodyHtml(visit, payment)}
      </article>`;
    bindCopyButtons(root);
    root.querySelector('[data-kaspi-claim]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await visitApi.claimKaspi(visit.id);
        show();
      } catch (error) {
        root.querySelector('[data-kaspi-status]').textContent = error.message;
        button.disabled = false;
      }
    });
    if (visit.status === 'pending' && visit.kaspi?.claimedAt) {
      stop = pollUntilSettled(async () => (await visitApi.visit(id)).visit, () => show());
    }
  }

  if (id) {
    rememberTicket(id);
    show();
  } else {
    listRecent();
  }
}
