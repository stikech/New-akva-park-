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
let catalog = [];
let today = '';
let current = 'list'; // открытый раздел: list (отзывы) | users (клиенты)

const dateFmt = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  timeZone: 'Asia/Almaty', // Петропавловск: UTC+5, как во всём Казахстане
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
$('userSearch').addEventListener('input', renderUsers);
$('switch').addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-view]');
  if (!btn) return;
  show(btn.dataset.view);
  if (btn.dataset.view === 'users') loadUsers();
});
$('search').addEventListener('input', render);
$('exportCsv').addEventListener('click', exportCsv);

if (token) load();
else show('login');
