/**
 * Админка: отзывы и клиенты личного кабинета (абонементы, посещения). Токен хранится только на время вкладки (sessionStorage).
 * Данные из API выводятся через textContent — без innerHTML.
 */

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'neptun-admin-token';

const storage = {
  get() { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set(v) { try { sessionStorage.setItem(TOKEN_KEY, v); } catch { /* приватный режим */ } },
  clear() { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};

let token = storage.get();
let items = [];
let users = [];
let visitItems = [];
let catalog = [];
let today = '';
let paymentItems = []; // ожидают подтверждения: заказы абонементов и билеты
let current = 'payments'; // открытый раздел: payments | list (отзывы) | users (клиенты) | visits (билеты)

const dateFmt = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  timeZone: 'Asia/Almaty', // Петропавловск: UTC+5, как во всём Казахстане
});
const visitFmt = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Almaty',
});

function plural(n, [one, few, many]) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function show(view) {
  if (view !== 'login') current = view;
  $('loginView').hidden = view !== 'login';
  $('listView').hidden = view !== 'list';
  $('usersView').hidden = view !== 'users';
  $('visitsView').hidden = view !== 'visits';
  $('paymentsView').hidden = view !== 'payments';
  $('switch').hidden = view === 'login';
  $('logout').hidden = view === 'login';
  $('switch').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? Object.values(data.errors ?? {})[0] ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const visible = q
    ? items.filter((it) => [it.name, it.email ?? '', it.message].some((s) => s.toLowerCase().includes(q)))
    : items;

  const feed = $('feed');
  feed.replaceChildren(...visible.map(renderItem));
  $('empty').hidden = visible.length > 0;
  $('empty').querySelector('strong').textContent = q ? 'Ничего не найдено.' : 'Пока пусто.';
}

function renderItem(it) {
  const node = $('itemTpl').content.firstElementChild.cloneNode(true);
  node.querySelector('.avatar').textContent = (it.name.trim()[0] ?? '?').toUpperCase();
  node.querySelector('.item__name').textContent = it.name;
  const email = node.querySelector('.item__email');
  if (it.email) {
    email.textContent = it.email;
    email.href = `mailto:${encodeURIComponent(it.email).replace('%40', '@')}`;
  } else {
    email.textContent = 'почта не указана';
  }
  const time = node.querySelector('.item__date');
  time.dateTime = it.createdAt;
  time.textContent = dateFmt.format(new Date(it.createdAt));
  node.querySelector('.item__text').textContent = it.message;
  return node;
}

async function load() {
  $('listError').textContent = '';
  $('summary').textContent = 'Загружаем…';
  try {
    const data = await api('/api/admin/feedback?limit=1000');
    items = data.items;
    const notif = data.notifications === 'telegram' ? 'уведомления в Telegram включены' : 'уведомления выключены';
    $('summary').textContent = `${data.total} ${plural(data.total, ['отзыв', 'отзыва', 'отзывов'])} · ${notif}`;
    show(current);
    render();
    if (current === 'payments' && !paymentItems.length) loadPayments();
  } catch (error) {
    if (error.status === 401) {
      storage.clear();
      token = null;
      show('login');
      $('loginError').textContent = 'Неверный токен';
      return;
    }
    if (error.status === 503 || error.status === 429) {
      show('login');
      $('loginError').textContent = error.message;
      return;
    }
    $('summary').textContent = '';
    $('listError').textContent = `Не удалось загрузить отзывы: ${error.message}`;
  }
}

// ---------- клиенты ----------

const dateOnly = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtDate = (iso) => (iso ? dateOnly.format(new Date(`${iso}T00:00:00Z`)) : 'без срока');
const fmtPhone = (p) => (p ? p.replace(/^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/, '+7 $1 $2-$3-$4') : null);

function addMonths(iso, months) { // как в frontend/assets/js/utils/account.js
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  t.setUTCDate(Math.min(d, new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate()) - 1);
  return t.toISOString().slice(0, 10);
}

function planSummary(m) {
  if (!m) return 'Абонемента нет';
  const visits = m.visitsTotal == null ? 'безлимит' : `осталось ${m.status.visitsLeft} из ${m.visitsTotal}`;
  return `${m.title} — ${visits}; ${fmtDate(m.startsAt)} → ${fmtDate(m.endsAt)}`;
}

function renderUsers() {
  const q = $('userSearch').value.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const visible = q
    ? users.filter((u) => [u.firstName, u.lastName ?? '', u.email].some((s) => s.toLowerCase().includes(q))
      || (digits.length >= 3 && (u.phone ?? '').includes(digits)))
    : users;
  $('users').replaceChildren(...visible.map(renderUser));
  $('usersEmpty').hidden = visible.length > 0;
  $('usersEmpty').querySelector('strong').textContent = q ? 'Никого не нашли.' : 'Клиентов пока нет.';
}

function renderUser(u) {
  const node = $('userTpl').content.firstElementChild.cloneNode(true);
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ');
  node.querySelector('.avatar').textContent = (name[0] ?? '?').toUpperCase();
  node.querySelector('.item__name').textContent = name;
  node.querySelector('.user__contacts').textContent = [u.email, fmtPhone(u.phone) ?? 'телефон не указан',
    u.birthDate ? `д. р. ${fmtDate(u.birthDate)}` : null].filter(Boolean).join(' · ');
  const pill = node.querySelector('.pill');
  pill.textContent = u.membership ? u.membership.status.label : 'Без абонемента';
  pill.dataset.code = u.membership?.status.code ?? 'none';
  node.querySelector('.user__plan').textContent = planSummary(u.membership);

  node.querySelector('[data-act="visit"]').hidden = u.membership?.status.code !== 'active';
  node.querySelector('[data-act="remove"]').hidden = !u.membership;

  const form = node.querySelector('.issue');
  const select = form.elements.planId;
  select.replaceChildren(...catalog.map((p) => new Option(`${p.title} — ${p.price.toLocaleString('ru-RU')} ₸`, p.id)));
  const syncEnd = () => {
    const plan = catalog.find((p) => p.id === select.value);
    form.elements.endsAt.value = plan?.durationMonths && form.elements.startsAt.value
      ? addMonths(form.elements.startsAt.value, plan.durationMonths) : '';
  };
  select.addEventListener('change', syncEnd);
  form.elements.startsAt.addEventListener('change', syncEnd);

  const error = node.querySelector('.user__error');
  const run = async (fn) => {
    error.textContent = '';
    node.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      const { user } = await fn();
      users = users.map((x) => (x.id === user.id ? user : x));
      node.replaceWith(renderUser(user));
      renderUsersSummary();
    } catch (e) {
      if (e.status === 401) return load();
      error.textContent = e.message;
      node.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  };

  node.querySelector('[data-act="visit"]').addEventListener('click', () =>
    run(() => api('/api/admin/visit', { method: 'POST', body: { userId: u.id } })));
  node.querySelector('[data-act="remove"]').addEventListener('click', () => {
    if (!window.confirm(`Снять абонемент у клиента ${name}?`)) return;
    run(() => api('/api/admin/membership', { method: 'DELETE', body: { userId: u.id } }));
  });
  node.querySelector('[data-act="issue"]').addEventListener('click', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) {
      form.elements.startsAt.value = today;
      syncEnd();
      select.focus();
    }
  });
  form.querySelector('[data-act="cancel"]').addEventListener('click', () => { form.hidden = true; });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (u.membership && !window.confirm('У клиента уже есть абонемент. Заменить его новым?')) return;
    run(() => api('/api/admin/membership', {
      method: 'PUT',
      body: { userId: u.id, planId: select.value, startsAt: form.elements.startsAt.value, endsAt: form.elements.endsAt.value || null },
    }));
  });
  return node;
}

function renderUsersSummary() {
  const active = users.filter((u) => u.membership?.status.code === 'active').length;
  $('usersSummary').textContent = `${users.length} ${plural(users.length, ['клиент', 'клиента', 'клиентов'])} · с действующим абонементом: ${active}`;
}

async function loadUsers() {
  $('usersError').textContent = '';
  $('usersSummary').textContent = 'Загружаем…';
  try {
    const data = await api('/api/admin/users');
    ({ catalog, today } = data);
    users = data.items;
    renderUsersSummary();
    renderUsers();
  } catch (error) {
    if (error.status === 401) return load();
    $('usersSummary').textContent = '';
    $('usersError').textContent = `Не удалось загрузить клиентов: ${error.message}`;
  }
}

// ---------- визиты (онлайн-билеты аквапарка) ----------

const DAY_LABEL = { weekday: 'Будни', weekend: 'Выходные' };
const DURATION_LABEL = { h2: '2 часа', unl: 'Без лимита' };
const VISIT_STATUS_LABEL = { pending: 'Ожидает оплаты', paid: 'Оплачен', cancelled: 'Отменён', expired: 'Истёк' };

function visitorsLabel(v) {
  const n = v.adults + v.children;
  return `${n} ${plural(n, ['билет', 'билета', 'билетов'])} · ${v.adults} взр.${v.children ? `, ${v.children} дет.` : ''}`;
}

function renderVisits() {
  const q = $('visitSearch').value.trim().toLowerCase();
  const visible = q
    ? visitItems.filter((v) => [v.email ?? '', v.firstName ?? '', v.id, v.payCode ?? '', v.phone ?? '', v.user?.email ?? '']
      .some((s) => String(s).toLowerCase().includes(q)))
    : visitItems;
  $('visitFeed').replaceChildren(...visible.map(renderVisit));
  $('visitsEmpty').hidden = visible.length > 0;
  $('visitsEmpty').querySelector('strong').textContent = q ? 'Ничего не нашли.' : 'Визитов пока нет.';
}

function renderVisit(v) {
  const node = $('visitTpl').content.firstElementChild.cloneNode(true);
  node.querySelector('.item__name').textContent = v.firstName || 'Гость';
  node.querySelector('.visit__contact').textContent = v.email ?? '—';
  node.querySelector('.visit__count').textContent = visitorsLabel(v);
  node.querySelector('.visit__tariff').textContent = `${DAY_LABEL[v.day] ?? v.day} · ${DURATION_LABEL[v.duration] ?? v.duration}`;
  node.querySelector('.item__date').dateTime = v.createdAt;
  node.querySelector('.item__date').textContent = visitFmt.format(new Date(v.createdAt));
  node.querySelector('.visit__price').textContent = `${v.price.toLocaleString('ru-RU')} ₸`;
  const pill = node.querySelector('.pill');
  const claimed = v.status === 'pending' && v.kaspi?.claimedAt;
  pill.textContent = v.usedAt ? 'Вход отмечен' : claimed ? 'Проверить перевод' : VISIT_STATUS_LABEL[v.status] ?? v.status;
  pill.dataset.code = v.usedAt ? 'used' : claimed ? 'claimed' : v.status;
  const receipt = node.querySelector('.visit__receipt');
  const parts = [`код ${v.payCode ?? v.id.slice(0, 8)}`];
  if (v.phone) parts.push(v.phone);
  if (v.receipt) parts.push(`чек ${v.receipt.receiptId}`);
  if (v.usedAt) parts.push(`вход ${visitFmt.format(new Date(v.usedAt))}`);
  if (v.kaspi?.rejectReason) parts.push(`отклонено: ${v.kaspi.rejectReason}`);
  receipt.textContent = parts.join(' · ');

  const actions = node.querySelector('.visit__actions');
  const error = node.querySelector('.user__error');
  if (v.status === 'paid' && !v.usedAt) {
    actions.append(actionButton('Отметить вход', 'btn', () => api(`/api/admin/visits/${v.id}/redeem`, { method: 'POST', body: {} }), error, loadVisits));
  } else if (v.status === 'pending') {
    actions.append(actionButton('Подтвердить оплату', 'btn', () => api(`/api/admin/visits/${v.id}/confirm`, { method: 'POST', body: {} }), error, loadVisits));
  }
  return node;
}

/** Кнопка действия: блокируется на время запроса, ошибку пишет рядом, после успеха — перезагрузка. */
function actionButton(label, cls, run, errorNode, reload) {
  const button = Object.assign(document.createElement('button'), { type: 'button', className: cls, textContent: label });
  button.addEventListener('click', () => runAction(button, run, errorNode, reload));
  return button;
}

async function runAction(button, run, errorNode, reload) {
  button.disabled = true;
  errorNode.textContent = '';
  try {
    await run();
    await reload();
  } catch (error) {
    errorNode.textContent = error.message;
    button.disabled = false;
  }
}

// ---------- оплаты Kaspi: подтверждение переводов ----------

async function loadStatus() {
  const box = $('serverStatus');
  try {
    const s = await api('/api/admin/status');
    const item = (label, value, ok) => {
      const span = document.createElement('span');
      const b = Object.assign(document.createElement('b'), { textContent: value, className: ok ? 'on' : 'off' });
      span.append(`${label}: `, b);
      return span;
    };
    box.replaceChildren(
      item('Kaspi', s.payment.enabled ? `${s.payment.phone} (${s.payment.receiver})` : 'номер не задан — онлайн-оплата выключена', s.payment.enabled),
      item('Telegram', s.telegram === 'on' ? 'уведомления включены' : 'выключен', s.telegram === 'on'),
      item('Хранение данных', s.backup === 'upstash' ? 'облачная копия Upstash' : 'только диск сервера', s.backup === 'upstash'),
    );
  } catch {
    box.replaceChildren();
  }
}

async function loadPayments() {
  $('paymentsError').textContent = '';
  $('paymentsSummary').textContent = 'Загружаем…';
  loadStatus();
  try {
    const [orders, visits] = await Promise.all([api('/api/admin/orders'), api('/api/admin/visits')]);
    visitItems = visits.items;
    paymentItems = [
      ...orders.items.filter((o) => o.status === 'pending').map((o) => ({ ...o, kind: 'order' })),
      ...visits.items.filter((v) => v.status === 'pending').map((v) => ({ ...v, kind: 'visit' })),
    ].sort((a, b) => Number(Boolean(b.kaspi?.claimedAt)) - Number(Boolean(a.kaspi?.claimedAt))
      || b.createdAt.localeCompare(a.createdAt));
    const claimed = paymentItems.filter((p) => p.kaspi?.claimedAt).length;
    $('paymentsSummary').textContent = `Ждут проверки: ${claimed} · не оплачены клиентом: ${paymentItems.length - claimed}`;
    $('paymentsCount').textContent = String(claimed);
    $('paymentsCount').hidden = claimed === 0;
    renderPayments();
  } catch (error) {
    if (error.status === 401) return load();
    $('paymentsSummary').textContent = '';
    $('paymentsError').textContent = `Не удалось загрузить оплаты: ${error.message}`;
  }
}

function renderPayments() {
  const q = $('paymentSearch').value.trim().toLowerCase();
  const visible = q
    ? paymentItems.filter((p) => [p.payCode ?? '', p.email ?? '', p.firstName ?? '', p.phone ?? '']
      .some((s) => String(s).toLowerCase().includes(q)))
    : paymentItems;
  $('paymentFeed').replaceChildren(...visible.map(renderPayment));
  $('paymentsEmpty').hidden = visible.length > 0;
}

function renderPayment(p) {
  const node = $('paymentTpl').content.firstElementChild.cloneNode(true);
  const base = p.kind === 'order' ? '/api/admin/orders' : '/api/admin/visits';
  node.querySelector('.payment__codevalue').textContent = p.payCode ?? p.id.slice(0, 8);
  node.querySelector('.payment__kind').textContent = p.kind === 'order'
    ? `Абонемент: ${p.title.split(' · ').slice(1).join(' · ') || p.title}`
    : `Билеты: ${visitorsLabel(p)}`;
  node.querySelector('.item__name').textContent = p.firstName || 'Гость';
  node.querySelector('.visit__contact').textContent = [p.email, p.phone].filter(Boolean).join(' · ') || '—';
  node.querySelector('.visit__price').textContent = `${p.price.toLocaleString('ru-RU')} ₸`;
  const pill = node.querySelector('.pill');
  pill.textContent = p.kaspi?.claimedAt ? `«Я оплатил» ${visitFmt.format(new Date(p.kaspi.claimedAt))}` : 'Клиент ещё не оплатил';
  pill.dataset.code = p.kaspi?.claimedAt ? 'claimed' : 'pending';
  node.querySelector('.item__date').dateTime = p.createdAt;
  node.querySelector('.item__date').textContent = `создан ${visitFmt.format(new Date(p.createdAt))}`;
  const error = node.querySelector('.user__error');
  node.querySelector('[data-act="confirm"]').addEventListener('click', (event) => runAction(event.currentTarget,
    () => api(`${base}/${p.id}/confirm`, { method: 'POST', body: {} }), error, loadPayments));
  node.querySelector('[data-act="reject"]').addEventListener('click', (event) => {
    const reason = prompt('Причина отказа (её увидит клиент):', 'Перевод с этим кодом не найден');
    if (reason === null) return;
    runAction(event.currentTarget, () => api(`${base}/${p.id}/reject`, { method: 'POST', body: { reason } }), error, loadPayments);
  });
  return node;
}

function renderVisitsSummary() {
  const paid = visitItems.filter((v) => v.status === 'paid');
  const sum = paid.reduce((acc, v) => acc + v.price, 0);
  const paidToday = paid.filter((v) => v.paidAt && v.paidAt.slice(0, 10) === today).length;
  $('visitsSummary').textContent = `${visitItems.length} ${plural(visitItems.length, ['визит', 'визита', 'визитов'])} · оплачено сегодня: ${paidToday} · всего онлайн-билетов: ${sum.toLocaleString('ru-RU')} ₸`;
}

async function loadVisits() {
  $('visitsError').textContent = '';
  $('visitsSummary').textContent = 'Загружаем…';
  try {
    const data = await api('/api/admin/visits');
    ({ today } = data);
    visitItems = data.items;
    renderVisitsSummary();
    renderVisits();
  } catch (error) {
    if (error.status === 401 || error.status === 503 || error.status === 429) return load();
    $('visitsSummary').textContent = '';
    $('visitsError').textContent = `Не удалось загрузить визиты: ${error.message}`;
  }
}

function exportCsv() {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // защита от формул в Excel
    return `"${s.replaceAll('"', '""')}"`;
  };
  const rows = [['Дата', 'Имя', 'Почта', 'Отзыв'], ...items.map((it) => [it.createdAt, it.name, it.email, it.message])];
  const csv = `﻿${rows.map((r) => r.map(cell).join(';')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `neptun-otzyvy-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click();
  URL.revokeObjectURL(url);
}

$('loginForm').addEventListener('submit', (event) => {
  event.preventDefault();
  token = $('token').value.trim();
  if (!token) return;
  storage.set(token);
  $('loginError').textContent = '';
  load();
});

$('logout').addEventListener('click', () => {
  storage.clear();
  token = null;
  items = [];
  $('token').value = '';
  show('login');
});

$('refresh').addEventListener('click', load);
$('usersRefresh').addEventListener('click', loadUsers);
$('visitsRefresh').addEventListener('click', loadVisits);
$('userSearch').addEventListener('input', renderUsers);
$('visitSearch').addEventListener('input', renderVisits);
$('paymentSearch').addEventListener('input', renderPayments);
$('paymentsRefresh').addEventListener('click', loadPayments);
// Новые «Я оплатил» подтягиваются сами, пока раздел открыт.
setInterval(() => { if (token && current === 'payments' && !document.hidden) loadPayments(); }, 30_000);
$('switch').addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-view]');
  if (!btn) return;
  show(btn.dataset.view);
  if (btn.dataset.view === 'users') loadUsers();
  if (btn.dataset.view === 'visits') loadVisits();
  if (btn.dataset.view === 'payments') loadPayments();
});
$('search').addEventListener('input', render);
$('exportCsv').addEventListener('click', exportCsv);

if (token) load();
else show('login');
