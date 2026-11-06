/**
 * Админка для сотрудников: оплаты, заказы корзины, записи на занятия, клиенты и абонементы, отзывы.
 * Вход — пароль сотрудника (STAFF_LOGINS) или администратора (ADMIN_TOKEN); хранится только на время вкладки (sessionStorage).
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
let current = null; // открытый раздел (VIEWS); по умолчанию — первый доступный роли
let me = null; // кто вошёл: { id, name, role: 'owner' | 'staff', demo? }
let orderItems = []; // заказы корзины (/api/admin/checkout)
let classesDate = '';
const VIEWS = ['list', 'users', 'visits', 'payments', 'orders', 'classes', 'finance', 'staff', 'activity', 'settings'];
const OWNER_VIEWS = new Set(['finance', 'payments', 'staff', 'activity', 'settings']);
const isOwner = () => me?.role === 'owner';

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
  if (view !== 'login' && OWNER_VIEWS.has(view) && !isOwner()) view = 'orders'; // сотруднику — без денег и настроек
  if (view !== 'login') current = view;
  $('switch').querySelectorAll('[data-owner]').forEach((b) => { b.hidden = !isOwner(); });
  $('loginView').hidden = view !== 'login';
  VIEWS.forEach((v) => { $(`${v}View`).hidden = view !== v; });
  $('switch').hidden = view === 'login';
  $('logout').hidden = view === 'login';
  $('who').hidden = view === 'login';
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
  try {
    me = await api('/api/admin/me');
    $('who').textContent = me.role === 'owner' ? `${me.name} · полный доступ` : `${me.name} · сотрудник${me.demo ? ' (пробный)' : ''}`;
    show(current ?? (isOwner() ? 'finance' : 'orders'));
    openView(current);
  } catch (error) {
    storage.clear();
    token = null;
    me = null;
    show('login');
    loadDemoLogins();
    if (error.status !== 401) $('loginError').textContent = error.message;
  }
}

async function loadFeedback() {
  $('listError').textContent = '';
  $('summary').textContent = 'Загружаем…';
  try {
    const data = await api('/api/admin/feedback?limit=1000');
    items = data.items;
    const notif = data.notifications === 'telegram' ? 'уведомления в Telegram включены' : 'уведомления выключены';
    $('summary').textContent = `${data.total} ${plural(data.total, ['отзыв', 'отзыва', 'отзывов'])} · ${notif}`;
    render();
  } catch (error) {
    if (error.status === 401) return load();
    $('summary').textContent = '';
    $('listError').textContent = `Не удалось загрузить отзывы: ${error.message}`;
  }
}

/** Пробные сотрудники на экране входа (если на сервере DEMO_ACCOUNTS=1). */
async function loadDemoLogins() {
  try {
    const demo = await fetch('/api/admin/demo').then((r) => r.json());
    $('demoLogins').hidden = !demo.enabled;
    if (!demo.enabled) return;
    $('demoPassword').textContent = demo.password;
    $('demoList').replaceChildren(...demo.accounts.map((a) => {
      const b = el('button', { type: 'button', className: 'ghost', textContent: `${a.name} — ${a.login}` });
      b.addEventListener('click', () => { $('login').value = a.login; $('token').value = demo.password; $('loginForm').requestSubmit(); });
      return b;
    }));
  } catch { /* без демо — просто форма */ }
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
  } else if (v.status === 'pending' && isOwner()) {
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
    const m = s.methods ?? {};
    box.replaceChildren(
      item('Карта на сайте', m.card?.enabled ? (m.card.provider === 'demo' ? 'ДЕМО-режим' : 'TipTop Pay подключён') : 'не подключена (нужны ключи TipTop Pay)', m.card?.enabled),
      item('Перевод на карту', m.transfer?.enabled ? m.transfer.number : 'номер карты не задан', m.transfer?.enabled),
      item('Kaspi', s.payment.enabled ? `${s.payment.phone} (${s.payment.receiver})` : 'номер не задан', s.payment.enabled),
      item('Сотрудники', s.staff?.length ? s.staff.join(', ') : 'только администратор', true),
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
    const [orders, visits, checkout] = await Promise.all([api('/api/admin/orders'), api('/api/admin/visits'), api('/api/admin/checkout')]);
    visitItems = visits.items;
    orderItems = checkout.items;
    paymentItems = [
      // Заказы корзины: в «Оплаты» попадают только те, где клиент сообщил о переводе.
      ...checkout.items.filter((o) => o.status === 'pending' && o.claim).map((o) => ({
        ...o, kind: 'checkout', payCode: o.code, price: o.total, firstName: o.contact.name, email: o.contact.email,
        phone: fmtPhone(o.contact.phone), kaspi: { claimedAt: o.claim.at },
      })),
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
  const base = { order: '/api/admin/orders', visit: '/api/admin/visits', checkout: '/api/admin/checkout' }[p.kind];
  node.querySelector('.payment__codevalue').textContent = p.payCode ?? p.id.slice(0, 8);
  node.querySelector('.payment__kind').textContent = p.kind === 'checkout'
    ? `${p.claim.method === 'kaspi' ? 'Kaspi' : 'Перевод на карту'}: ${linesSummary(p.lines)}`
    : p.kind === 'order'
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

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('loginError').textContent = '';
  const button = $('loginForm').querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: $('login').value.trim() || 'owner', password: $('token').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    token = data.token;
    storage.set(token);
    $('token').value = '';
    current = null;
    await load();
  } catch (error) {
    $('loginError').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

function openView(view) {
  if (view === 'list') loadFeedback();
  if (view === 'finance') loadFinance();
  if (view === 'staff') loadStaff();
  if (view === 'activity') loadActivity();
  if (view === 'settings') loadSettings();
  if (view === 'users') loadUsers();
  if (view === 'visits') loadVisits();
  if (view === 'payments') loadPayments();
  if (view === 'orders') loadOrders();
  if (view === 'classes') loadClasses();
}

// ---------- заказы корзины ----------

const ORDER_STATUS_LABEL = { pending: 'Ждёт оплаты', paid: 'Оплачен', cancelled: 'Отменён', expired: 'Истёк' };
const METHOD_LABEL = { card: 'картой на сайте', transfer: 'переводом на карту', kaspi: 'Kaspi', desk: 'на кассе' };

function linesSummary(lines) {
  return lines.map((l) => `${l.title.replace(/^.*? · /, '')}${l.qty > 1 ? ` ×${l.qty}` : ''}`).join(', ');
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

async function loadOrders() {
  $('ordersError').textContent = '';
  $('ordersSummary').textContent = 'Загружаем…';
  try {
    const data = await api('/api/admin/checkout');
    orderItems = data.items;
    today = data.today;
    const paid = orderItems.filter((o) => o.status === 'paid');
    const paidToday = paid.filter((o) => o.paidAt?.slice(0, 10) === today);
    $('ordersSummary').textContent = `${orderItems.length} ${plural(orderItems.length, ['заказ', 'заказа', 'заказов'])} · оплачено сегодня: ${paidToday.length} на ${paidToday.reduce((s, o) => s + o.total, 0).toLocaleString('ru-RU')} ₸ · всего оплачено: ${paid.reduce((s, o) => s + o.total, 0).toLocaleString('ru-RU')} ₸`;
    renderOrders();
  } catch (error) {
    if (error.status === 401) return load();
    $('ordersSummary').textContent = '';
    $('ordersError').textContent = `Не удалось загрузить заказы: ${error.message}`;
  }
}

function renderOrders() {
  const q = $('orderSearch').value.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const filter = $('orderFilter').value;
  const visible = orderItems.filter((o) => {
    if (filter === 'pending' && o.status !== 'pending') return false;
    if (filter === 'paid' && !(o.status === 'paid' && !o.usedAt)) return false;
    if (filter === 'used' && !o.usedAt) return false;
    if (filter === 'closed' && !['cancelled', 'expired'].includes(o.status)) return false;
    if (!q) return true;
    return [o.code, o.contact.name, o.contact.email].some((s) => String(s ?? '').toLowerCase().includes(q))
      || (digits.length >= 3 && (o.contact.phone ?? '').includes(digits));
  });
  $('orderFeed').replaceChildren(...visible.map(renderOrder));
  $('ordersEmpty').hidden = visible.length > 0;
}

function renderOrder(o) {
  const error = el('p', { className: 'error user__error', role: 'alert' });
  const pill = el('span', { className: 'pill', textContent: o.usedAt ? 'Выдан' : o.status === 'pending' && o.claim ? 'Проверить перевод' : ORDER_STATUS_LABEL[o.status] ?? o.status });
  pill.dataset.code = o.usedAt ? 'used' : o.status === 'pending' && o.claim ? 'claimed' : o.status;
  const actions = el('div', { className: 'user__actions' });
  const reload = () => loadOrders();
  if (o.status === 'paid' && !o.usedAt) {
    actions.append(actionButton('Выдать / отметить вход', 'btn', () => api(`/api/admin/checkout/${o.id}/redeem`, { method: 'POST', body: {} }), error, reload));
  }
  if ((o.status === 'pending' || o.status === 'expired') && isOwner()) { // деньги подтверждает только владелец
    actions.append(actionButton(o.claim ? 'Подтвердить перевод' : 'Оплачено на кассе', 'btn', () => api(`/api/admin/checkout/${o.id}/confirm`, { method: 'POST', body: {} }), error, reload));
    const reject = el('button', { type: 'button', className: 'ghost danger-text', textContent: 'Отклонить' });
    reject.addEventListener('click', () => {
      const reason = prompt('Причина отказа (её увидит клиент):', 'Перевод с этим кодом не найден');
      if (reason === null) return;
      runAction(reject, () => api(`/api/admin/checkout/${o.id}/reject`, { method: 'POST', body: { reason } }), error, reload);
    });
    actions.append(reject);
  }
  const details = [
    o.visitDate ? `визит ${fmtDate(o.visitDate)}` : null,
    o.paidAt ? `оплачен ${visitFmt.format(new Date(o.paidAt))} ${METHOD_LABEL[o.method] ?? ''}${o.card?.last4 ? ` •••• ${o.card.last4}` : ''}${o.paidBy && !['tiptoppay', 'demo'].includes(o.paidBy) ? ` (${o.paidBy})` : ''}` : null,
    o.claim && o.status === 'pending' ? `«Я оплатил» ${visitFmt.format(new Date(o.claim.at))}, ${METHOD_LABEL[o.claim.method]}` : null,
    o.usedAt ? `выдан ${visitFmt.format(new Date(o.usedAt))}${o.usedBy ? ` (${o.usedBy})` : ''}` : null,
    o.rejectReason ? `отклонён: ${o.rejectReason}` : null,
    o.user ? `кабинет: ${o.user.email}` : null,
  ].filter(Boolean).join(' · ');
  return el('li', { className: 'card item payment' },
    el('div', { className: 'item__meta' },
      el('div', { className: 'payment__code' }, el('b', { className: 'payment__codevalue', textContent: o.code }), el('span', { className: 'payment__kind muted', textContent: `${o.lines.reduce((s, l) => s + l.qty, 0)} поз.` })),
      el('div', {}, el('strong', { className: 'item__name', textContent: o.contact.name }), el('span', { className: 'visit__contact muted', textContent: [fmtPhone(o.contact.phone), o.contact.email].filter(Boolean).join(' · ') })),
      el('div', { className: 'visit__right' }, el('span', { className: 'visit__price', textContent: `${o.total.toLocaleString('ru-RU')} ₸` }), pill,
        el('time', { className: 'item__date', dateTime: o.createdAt, textContent: visitFmt.format(new Date(o.createdAt)) }))),
    el('ul', { className: 'order__lines' }, ...o.lines.map((l) => el('li', { textContent: `${l.title} — ${l.option} × ${l.qty} = ${l.sum.toLocaleString('ru-RU')} ₸` }))),
    details ? el('p', { className: 'visit__receipt muted', textContent: details }) : null,
    actions, error);
}

// ---------- записи на занятия ----------

function shiftDay(iso, n) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

async function loadClasses(date = classesDate) {
  $('classesError').textContent = '';
  $('classesSummary').textContent = 'Загружаем…';
  try {
    const data = await api(`/api/admin/bookings${date ? `?date=${date}` : ''}`);
    classesDate = data.date;
    today = data.today;
    $('classesDate').value = data.date;
    const attended = data.slots.reduce((s, x) => s + x.attended, 0);
    const label = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${data.date}T00:00:00Z`));
    $('classesSummary').textContent = `${label}${data.date === data.today ? ' (сегодня)' : ''} · ${data.slots.length} ${plural(data.slots.length, ['занятие', 'занятия', 'занятий'])} · записано: ${data.total} · пришли: ${attended}`;
    $('classesDay').replaceChildren(...(data.slots.length ? data.slots.map(renderSlot) : [el('div', { className: 'empty card' }, el('p', {}, el('strong', { textContent: 'В этот день занятий нет.' })))]));
  } catch (error) {
    if (error.status === 401) return load();
    $('classesSummary').textContent = '';
    $('classesError').textContent = `Не удалось загрузить записи: ${error.message}`;
  }
}

function renderSlot(slot) {
  const error = el('p', { className: 'error user__error', role: 'alert' });
  const reload = () => loadClasses();
  const fill = el('span', { className: 'slot__fill' });
  fill.style.width = `${Math.min(100, Math.round((slot.booked / slot.capacity) * 100))}%`;
  const people = slot.items.map((b) => {
    const cancelled = b.status === 'cancelled';
    const tags = el('span', { className: 'slot__tags' },
      el('span', { className: 'pill', textContent: b.payment === 'membership' ? 'абонемент' : b.paid ? 'разово, оплачено' : `разово, ${b.price ? `${b.price.toLocaleString('ru-RU')} ₸ ` : ''}на ресепшене` }),
      b.account ? null : el('span', { className: 'pill', textContent: 'без кабинета' }));
    tags.firstChild.dataset.code = b.payment === 'membership' || b.paid ? 'paid' : 'pending';
    const row = el('li', { className: `person${cancelled ? ' person--cancelled' : ''}${b.attendedAt ? ' person--here' : ''}` },
      el('label', { className: 'person__check' },
        Object.assign(el('input', { type: 'checkbox', checked: Boolean(b.attendedAt), disabled: cancelled }), { title: 'Пришёл' }),
        el('span', {}, el('b', { textContent: b.name }), el('small', { className: 'muted', textContent: [fmtPhone(b.phone), b.email].filter(Boolean).join(' · ') }))),
      tags);
    const box = row.querySelector('input');
    box.addEventListener('change', () => runAction(box, () => api(`/api/admin/bookings/${b.id}/attend`, { method: 'POST', body: { attended: box.checked } }), error, reload));
    if (cancelled) row.append(el('span', { className: 'muted person__note', textContent: `отменена${b.cancelledBy ? ` (${b.cancelledBy === 'client' || b.cancelledBy === 'guest' ? 'клиентом' : b.cancelledBy})` : ''}` }));
    else {
      const cancel = el('button', { type: 'button', className: 'ghost danger-text person__cancel', textContent: 'Отменить' });
      cancel.addEventListener('click', () => {
        if (!confirm(`Отменить запись: ${b.name}?`)) return;
        runAction(cancel, () => api(`/api/admin/bookings/${b.id}/cancel`, { method: 'POST', body: {} }), error, reload);
      });
      row.append(cancel);
    }
    return row;
  });

  const form = el('form', { className: 'slot__add', hidden: true },
    el('input', { name: 'name', placeholder: 'Имя клиента', required: true, maxLength: 80 }),
    el('input', { name: 'phone', placeholder: '+7 7__ ___-__-__', type: 'tel', required: true }),
    el('button', { className: 'btn', type: 'submit', textContent: 'Записать' }));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    runAction(form.querySelector('button'), () => api('/api/admin/bookings', { method: 'POST', body: { key: slot.key, name: form.elements.name.value, phone: form.elements.phone.value } }), error, reload);
  });
  const addBtn = el('button', { type: 'button', className: 'ghost', textContent: '+ Записать' });
  addBtn.addEventListener('click', () => { form.hidden = !form.hidden; if (!form.hidden) form.elements.name.focus(); });

  return el('article', { className: 'card slot' },
    el('div', { className: 'slot__head' },
      el('div', { className: 'slot__time' }, el('b', { textContent: slot.start }), el('small', { className: 'muted', textContent: `до ${slot.end}` })),
      el('div', {}, el('strong', { textContent: slot.title }), el('span', { className: 'muted slot__room', textContent: slot.room })),
      el('div', { className: 'slot__count' }, el('b', { textContent: `${slot.booked}/${slot.capacity}` }), el('small', { className: 'muted', textContent: `пришли ${slot.attended}` }))),
    el('div', { className: 'slot__bar' }, fill),
    people.length ? el('ul', { className: 'people' }, ...people) : el('p', { className: 'muted', textContent: 'Пока никто не записан.' }),
    el('div', { className: 'user__actions' }, addBtn), form, error);
}

$('ordersRefresh').addEventListener('click', loadOrders);
$('orderSearch').addEventListener('input', renderOrders);
$('orderFilter').addEventListener('change', renderOrders);
$('classesDate').addEventListener('change', (e) => loadClasses(e.target.value));
$('classesToday').addEventListener('click', () => loadClasses(today));
document.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => loadClasses(shiftDay(classesDate || today, Number(b.dataset.day)))));

$('logout').addEventListener('click', () => {
  storage.clear();
  token = null;
  me = null;
  items = [];
  $('token').value = '';
  show('login');
  loadDemoLogins();
});

$('refresh').addEventListener('click', loadFeedback);
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
  openView(btn.dataset.view);
});
$('search').addEventListener('input', render);
$('exportCsv').addEventListener('click', exportCsv);

// ---------- владелец: финансы ----------

const money = (n) => `${Math.round(n).toLocaleString('ru-RU')} ₸`;
const METHOD_NAMES = { card: 'Картой на сайте', transfer: 'Перевод на карту', kaspi: 'Kaspi', desk: 'На кассе по коду' };

async function loadFinance() {
  $('financeError').textContent = '';
  try {
    const f = await api('/api/admin/finance');
    const kpi = (label, p, note) => el('div', { className: 'card kpi' },
      el('span', { className: 'muted', textContent: label }),
      el('b', { textContent: money(p.online) }),
      el('small', { className: 'muted', textContent: `онлайн · всего с кассой ${money(p.total)} · ${p.count} ${plural(p.count, ['оплата', 'оплаты', 'оплат'])}` }),
      note ? el('small', { className: 'muted', textContent: note }) : null);
    const m = f.periods.month.methods;
    $('financeKpis').replaceChildren(
      kpi('Сегодня', f.periods.today), kpi('7 дней', f.periods.week), kpi('30 дней', f.periods.month), kpi('За всё время', f.periods.all),
      el('div', { className: 'card kpi kpi--wide' },
        el('span', { className: 'muted', textContent: 'За 30 дней по способам оплаты' }),
        el('ul', { className: 'methods' }, ...Object.entries(METHOD_NAMES).map(([k, label]) => el('li', {}, el('span', { textContent: label }), el('b', { textContent: money(m[k] ?? 0) })))),
        f.pending.count ? el('small', { className: 'warn-text', textContent: `Ждут проверки перевода: ${f.pending.count} на ${money(f.pending.total)} — раздел «Оплаты»` }) : null),
    );
    const max = Math.max(1, ...f.days.map((d) => d.total));
    $('financeChart').replaceChildren(...f.days.map((d) => {
      const col = el('div', { className: 'chart__col', title: `${d.date}: ${money(d.total)} (онлайн ${money(d.online)})` });
      const desk = el('span', { className: 'chart__desk' });
      const online = el('span', { className: 'chart__online' });
      desk.style.height = `${((d.total - d.online) / max) * 100}%`;
      online.style.height = `${(d.online / max) * 100}%`;
      col.append(desk, online, el('small', { textContent: d.date.slice(8) }));
      return col;
    }));
    $('financeRecent').replaceChildren(...(f.recent.length ? f.recent.map((x) => el('li', {},
      el('span', { textContent: `${visitFmt.format(new Date(x.at))} · ${x.kind} ${x.code ?? ''}` }),
      el('span', { className: 'muted', textContent: METHOD_NAMES[x.method] ?? x.method }),
      el('b', { textContent: money(x.amount) }))) : [el('li', { className: 'muted', textContent: 'Оплат пока нет.' })]));
  } catch (error) {
    if (error.status === 401) return load();
    $('financeError').textContent = `Не удалось загрузить финансы: ${error.message}`;
  }
}

// ---------- владелец: сотрудники ----------

let staffList = [];

async function loadStaff() {
  $('staffError').textContent = '';
  try {
    const data = await api('/api/admin/staff');
    staffList = data.items;
    $('staffFeed').replaceChildren(...staffList.map(renderStaff));
    $('staffNote').textContent = [
      data.env.length ? `Постоянные входы из Render (STAFF_LOGINS): ${data.env.join(', ')} — логин = имя.` : '',
      data.demoPassword ? `Пробные сотрудники включены (DEMO_ACCOUNTS=1), пароль ${data.demoPassword}. Перед запуском для клиентов поставьте DEMO_ACCOUNTS=0.` : '',
    ].filter(Boolean).join(' ');
  } catch (error) {
    if (error.status === 401) return load();
    $('staffError').textContent = error.message;
  }
}

function renderStaff(s) {
  const error = el('p', { className: 'error user__error', role: 'alert' });
  const pill = el('span', { className: 'pill', textContent: s.active ? (s.demo ? 'пробный' : 'работает') : 'отключён' });
  pill.dataset.code = s.active ? 'active' : 'cancelled';
  const actions = el('div', { className: 'user__actions' });
  if (!s.demo) {
    const toggle = el('button', { type: 'button', className: 'ghost', textContent: s.active ? 'Отключить' : 'Включить' });
    toggle.addEventListener('click', () => runAction(toggle, () => api(`/api/admin/staff/${s.id}`, { method: 'PATCH', body: { active: !s.active } }), error, loadStaff));
    const pass = el('button', { type: 'button', className: 'ghost', textContent: 'Новый пароль' });
    pass.addEventListener('click', () => {
      const password = prompt(`Новый пароль для ${s.name} (от 8 символов):`);
      if (password) runAction(pass, () => api(`/api/admin/staff/${s.id}`, { method: 'PATCH', body: { password } }), error, loadStaff);
    });
    const del = el('button', { type: 'button', className: 'ghost danger-text', textContent: 'Удалить' });
    del.addEventListener('click', () => {
      if (confirm(`Удалить сотрудника ${s.name}? Войти он больше не сможет.`)) runAction(del, () => api(`/api/admin/staff/${s.id}`, { method: 'DELETE' }), error, loadStaff);
    });
    actions.append(toggle, pass, del);
  }
  const log = el('button', { type: 'button', className: 'ghost', textContent: 'Журнал' });
  log.addEventListener('click', () => { $('activityStaff').value = s.id; show('activity'); loadActivity(); });
  actions.append(log);
  return el('li', { className: 'card item' },
    el('div', { className: 'item__meta' },
      el('span', { className: 'avatar', textContent: (s.name[0] ?? '?').toUpperCase() }),
      el('div', {}, el('strong', { className: 'item__name', textContent: s.name }),
        el('span', { className: 'muted', textContent: `логин ${s.login} · ${s.lastLoginAt ? `последний вход ${visitFmt.format(new Date(s.lastLoginAt))}` : 'ещё не входил'}` })),
      pill),
    actions, error);
}

$('staffForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  $('staffFormError').textContent = '';
  try {
    await api('/api/admin/staff', { method: 'POST', body: { name: form.elements.name.value, login: form.elements.login.value, password: form.elements.password.value } });
    form.reset();
    loadStaff();
  } catch (error) {
    $('staffFormError').textContent = error.message;
  }
});

// ---------- владелец: журнал ----------

async function loadActivity() {
  $('activityError').textContent = '';
  try {
    if (!staffList.length) staffList = (await api('/api/admin/staff')).items;
    const select = $('activityStaff');
    const chosen = select.value;
    select.replaceChildren(new Option('Все', ''), new Option('Владелец', 'owner'), ...staffList.map((s) => new Option(s.name, s.id)));
    select.value = chosen;
    const { items: log } = await api(`/api/admin/activity?limit=500${chosen ? `&staff=${encodeURIComponent(chosen)}` : ''}`);
    $('activityFeed').replaceChildren(...log.map((x) => el('li', { className: `log__item${x.role === 'owner' ? ' log__item--owner' : ''}` },
      el('time', { className: 'muted', dateTime: x.at, textContent: visitFmt.format(new Date(x.at)) }),
      el('b', { textContent: x.name }),
      el('span', { textContent: x.action }),
      x.target ? el('span', { className: 'muted', textContent: x.target }) : null)));
    $('activityEmpty').hidden = log.length > 0;
  } catch (error) {
    if (error.status === 401) return load();
    $('activityError').textContent = error.message;
  }
}
$('activityStaff').addEventListener('change', loadActivity);
$('activityRefresh').addEventListener('click', loadActivity);
$('financeRefresh').addEventListener('click', loadFinance);

// ---------- владелец: реквизиты оплаты ----------

async function loadSettings() {
  $('settingsError').textContent = '';
  $('settingsOk').textContent = '';
  try {
    const data = await api('/api/admin/settings');
    const form = $('settingsForm');
    for (const [k, v] of Object.entries(data.payment)) {
      if (form.elements[k]) form.elements[k].value = k === 'cardNumber' && v ? v.replace(/(\d{4})(?=\d)/g, '$1 ') : (v ?? '');
    }
    $('settingsCard').textContent = data.card.enabled
      ? `Подключено (Public ID ${data.card.publicId}). Клиенты платят картой прямо на сайте, оплата подтверждается сама.`
      : 'Не подключено. Нужен договор интернет-эквайринга с TipTop Pay (tiptoppay.kz): впишите Public ID в backend/payment.config.js, а API Secret — в Render → Environment (TIPTOPPAY_API_SECRET). Пока этого нет, «Банковской картой» на сайте — это перевод с карты клиента на вашу карту выше.';
    $('settingsPersist').hidden = data.persistent;
    $('settingsPersist').textContent = 'Облачное хранилище (Upstash) не подключено: бесплатный Render стирает данные при перезапуске, и эти настройки вернутся к значениям из backend/payment.config.js. Чтобы номер карты не сбрасывался — подключите Upstash или впишите его в Render → Environment → PAY_CARD_NUMBER.';
  } catch (error) {
    if (error.status === 401) return load();
    $('settingsError').textContent = error.message;
  }
}

$('settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  $('settingsError').textContent = '';
  $('settingsOk').textContent = '';
  try {
    const body = Object.fromEntries(['cardNumber', 'cardBank', 'cardHolder', 'kaspiPhone', 'kaspiReceiver', 'kaspiPayLink'].map((k) => [k, form.elements[k].value]));
    await api('/api/admin/settings', { method: 'PUT', body });
    $('settingsOk').textContent = 'Сохранено — на сайте уже действует.';
    loadSettings().then(() => { $('settingsOk').textContent = 'Сохранено — на сайте уже действует.'; });
  } catch (error) {
    $('settingsError').textContent = error.message;
  }
});

if (token) load();
else { show('login'); loadDemoLogins(); }
