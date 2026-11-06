/**
 * Личный кабинет (/account/<раздел>): вход и регистрация, страницы дашборда
 * «Обзор», «Мой профиль», «Абонемент», «Магазин», «Расписание», «Настройки».
 *
 * У каждой кнопки меню — свой URL (/account/overview, /account/profile…):
 * переходы работают и как обычные ссылки, и как pushState-переходы без
 * перезагрузки. Неизвестный раздел, `/account` без раздела и легаси-хеши
 * (#schedule и т. п.) сводятся на /account/overview.
 *
 * Сессия — HttpOnly-cookie, JS её не видит; состояние «вошёл ли» узнаём у API.
 * Данные из API выводятся через textContent или escapeHtml — без сырого HTML.
 */

import { accountApi, shopApi } from './services/api.js?v=4';
import { initTabs } from './modules/tabs.js';
import { initTheme } from './modules/theme.js';
import { initShop } from './modules/shop.js?v=3';
import { initBooking } from './modules/booking.js';
import { escapeHtml, formatPrice, initials, plural } from './utils/format.js';
import {
  ageOn, cityDateString, formatPhone, passwordError, profileCompleteness, validateProfile, validateRegistration,
} from './utils/account.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const LANG_KEY = 'neptun-lang'; // тот же ключ, что у переключателя языка на главной
const TZ_OFFSET = 5; // Петропавловск, UTC+5
const SECTIONS = ['overview', 'profile', 'membership', 'shop', 'schedule', 'settings'];
const ACCOUNT_BASE = '/account'; // разделы: /account/<section>
const LANG_NAMES = { ru: 'Русский', kz: 'Қазақша' };

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const visitFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Almaty' });

/** «2026-11-04» → «4 ноября 2026» */
const formatDate = (iso) => (iso ? dateFmt.format(new Date(`${iso}T00:00:00Z`)).replace(/\s?г\.$/, '') : '—');
const today = () => cityDateString(TZ_OFFSET);
const icon = (name) => `<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const words = {
  visits: ['посещение', 'посещения', 'посещений'],
  visitsGen: ['посещения', 'посещений', 'посещений'], // «из 12 посещений»
  days: ['день', 'дня', 'дней'],
  years: ['год', 'года', 'лет'],
};

let user = null;
let currentSection = 'overview';
let shopCtl = null; // модуль магазина (initShop) — подключается в bootstrap()
let bookingCtl = null; // модуль расписания (initBooking)
let scheduleStale = true; // расписание надо перечитать (после входа или смены абонемента)

// ---------- общие помощники форм ----------

function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.dataset.kind = kind;
}

function showErrors(form, errors = {}) {
  $$('[data-error]', form).forEach((el) => {
    const field = el.dataset.error;
    el.textContent = errors[field] ?? '';
    form.elements[field]?.setAttribute('aria-invalid', String(Boolean(errors[field])));
  });
  const first = Object.keys(errors).find((f) => form.elements[f]);
  if (first) form.elements[first].focus();
}

/** Отправка формы: блокирует кнопку, показывает ошибки полей (422) или общую ошибку. */
async function submitWith(form, action, { pending = 'Сохраняем…' } = {}) {
  const button = $('button[type="submit"]', form);
  const status = $('[data-status]', form);
  button.disabled = true;
  setStatus(status, pending, 'pending');
  try {
    const result = await action();
    setStatus(status, '', '');
    return result;
  } catch (error) {
    if (error.status === 401 && user) return onSignedOut('Сеанс завершён — войдите снова.');
    if (error.body?.errors) {
      showErrors(form, error.body.errors);
      setStatus(status, error.body.errors.form ?? 'Проверьте поля формы', 'error');
    } else {
      setStatus(status, error.message, 'error');
    }
    return undefined;
  } finally {
    button.disabled = Boolean(user?.demo && button.hasAttribute('data-demo-off'));
  }
}

function persistLang(lang) {
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* приватный режим */ }
}

// ---------- иерархия экранов и навигация ----------

function show(view) {
  $('#loadingView').hidden = view !== 'loading';
  $('#authView').hidden = view !== 'auth';
  $('#accountView').hidden = view !== 'account';
  $('#logoutTop').hidden = view !== 'account';
}

/** Раздел из URL. null — /account без раздела; '?' — неизвестный раздел. */
function sectionFromPath(pathname = location.pathname) {
  const name = pathname.slice(`${ACCOUNT_BASE}/`.length).split('/')[0];
  if (!name) return null;
  return SECTIONS.includes(name) ? name : '?';
}

/** Показ страницы дашборда (панель уже в DOM, это выборка и ленивые загрузки). */
function showSection(section) {
  currentSection = section;
  SECTIONS.forEach((t) => {
    $(`#panel-${t}`).hidden = t !== section;
  });
  $$('#dashNav .dash-nav__item').forEach((link) => {
    if (link.dataset.section === section) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (section !== 'profile') setEditing(false);
  if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'instant' });
  // Магазин и расписание грузим при входе на страницу, а не при входе в кабинет:
  // пользователь видит кабинет сразу, запросы идут ровно те, что нужны.
  if (section === 'shop' && user) shopCtl?.ensure();
  if (section === 'schedule' && user) {
    bookingCtl?.load({ force: scheduleStale });
    scheduleStale = false;
  }
}

/**
 * Переход на страницу раздела. history API — только для внутренних ссылок:
 * браузер сам управляет URL, JS подменяет контент без перезагрузки.
 */
function navigate(section, { replace = false } = {}) {
  if (!SECTIONS.includes(section)) section = 'overview';
  const url = `${ACCOUNT_BASE}/${section}`;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  showSection(section);
}

/** Переключение разделов из модулей (кнопки «В магазин», «Записаться»). */
function goto(section) {
  navigate(section);
}

/** Куда вернуться после входа: только свой сайт (/shop…), не чужой домен и не //host. */
function returnPath() {
  const next = new URLSearchParams(location.search).get('next') ?? '';
  return /^\/(?!\/)[\w\-/?=&.:%]*$/.test(next) && !next.startsWith('/account') ? next : null;
}

// Запоминаем при загрузке: экран входа убирает query-параметры из адреса.
const RETURN_TO = returnPath();

function onSignedIn(nextUser) {
  if (RETURN_TO) { location.replace(RETURN_TO); return; }
  user = nextUser;
  persistLang(user.lang);
  scheduleStale = true; // у нового сеанса свои посещения и записи
  renderAll();
  show('account');
  // Открываем тот раздел, что в URL (или обзор, если раздела нет/чужой)
  const requested = sectionFromPath();
  navigate(requested === null || requested === '?' ? 'overview' : requested, { replace: true });
}

function onSignedOut(message = '') {
  user = null;
  scheduleStale = true;
  shopCtl?.reset();
  bookingCtl?.reset();
  show('auth');
  $('#panel-login').reset();
  $('#tab-login').click();
  setStatus($('#panel-login [data-status]'), message, message ? 'error' : '');
  history.replaceState(null, '', location.pathname);
  loadDemoAccounts();
}

// ---------- обновление данных (использует modules/shop.js после оплаты) ----------

/**
 * Перечитать пользователя. Ошибку не бросаем: платёж к этому моменту уже
 * прошёл на сервере, данные дообновятся при следующем открытии кабинета.
 */
async function refreshUser() {
  try {
    const { user: me } = await accountApi.me();
    const membershipBefore = JSON.stringify(user?.membership ?? null);
    user = me;
    persistLang(user.lang);
    if (JSON.stringify(user?.membership ?? null) !== membershipBefore) scheduleStale = true;
    renderAll();
    return me;
  } catch (error) {
    if (error.status === 401) onSignedOut('Сеанс завершён — войдите снова.');
    return undefined;
  }
}

// ---------- рендер ----------

const fullName = (u) => [u.firstName, u.lastName].filter(Boolean).join(' ');

function renderAll() {
  renderShell();
  renderOverview();
  renderProfileView();
  renderMembership();
  renderSettings();
}

function renderShell() {
  const name = fullName(user);
  $$('[data-avatar]').forEach((el) => { el.textContent = initials(name) || '?'; });
  $$('[data-fullname]').forEach((el) => { el.textContent = name; });
  $$('[data-email]').forEach((el) => { el.textContent = user.email; });
  const pill = $('[data-status-pill]');
  const code = user.membership?.status.code ?? 'none';
  pill.dataset.code = code;
  pill.textContent = user.membership ? user.membership.status.label : 'Без абонемента';
  $('#demoNote').hidden = !user.demo;
}

function greeting() {
  const h = new Date(Date.now() + TZ_OFFSET * 3_600_000).getUTCHours();
  if (h < 5) return 'Доброй ночи';
  if (h < 12) return 'Доброе утро';
  if (h < 18) return 'Добрый день';
  return 'Добрый вечер';
}

function membershipSentence(m) {
  if (!m) return 'Абонемента пока нет — выберите тариф на странице «Магазин» и оформите без визита на кассу.';
  const s = m.status;
  if (s.code === 'active') {
    const visits = m.visitsTotal == null ? 'безлимитные посещения' : `осталось ${s.visitsLeft} ${plural(s.visitsLeft, words.visits)}`;
    const until = m.endsAt ? ` до ${formatDate(m.endsAt)}` : '';
    return `Абонемент действует${until}: ${visits}. Запишитесь на занятие на странице «Расписание».`;
  }
  if (s.code === 'scheduled') return `Абонемент начнёт действовать ${formatDate(m.startsAt)}.`;
  if (s.code === 'expired') return 'Срок абонемента истёк — продлить можно онлайн на странице «Магазин».';
  return 'Посещения по абонементу закончились — продлить можно онлайн на странице «Магазин».';
}

function kpi(iconName, label, value, hint = '') {
  return `<div class="kpi">
    <span class="kpi__label">${icon(iconName)}${escapeHtml(label)}</span>
    <b class="kpi__value">${escapeHtml(value)}</b>
    ${hint ? `<span class="kpi__hint">${escapeHtml(hint)}</span>` : ''}
  </div>`;
}

function renderOverview() {
  const m = user.membership;
  const s = m?.status;
  const t = today();
  $('#todayLabel').textContent = dayFmt.format(new Date(`${t}T00:00:00Z`));
  $('#hello').textContent = `${greeting()}, ${user.firstName}!`;
  $('#helloSub').textContent = membershipSentence(m);

  const left = !m ? '—' : m.visitsTotal == null ? '∞' : String(s.visitsLeft);
  const leftHint = !m ? 'нет абонемента' : m.visitsTotal == null ? 'безлимит' : `из ${m.visitsTotal}`;
  const days = !m ? '—' : s.daysLeft == null ? '∞' : String(Math.max(0, s.daysLeft));
  const daysHint = !m ? 'нет абонемента' : !m.endsAt ? 'без срока' : `до ${formatDate(m.endsAt)}`;
  const { percent, missing } = profileCompleteness(user);

  $('#kpis').innerHTML = [
    kpi('wave', 'Осталось посещений', left, leftHint),
    kpi('cal', 'Дней до окончания', days, daysHint),
    kpi('check', 'Уже посетили', m ? String(m.visitsUsed) : '0', m ? 'по этому абонементу' : ''),
    kpi('user', 'Профиль заполнен', `${percent}%`, missing.length ? `не хватает: ${missing.length}` : 'всё заполнено'),
  ].join('');

  $('#overviewPass').innerHTML = passHtml(m, { compact: true });

  $('#overviewVisits').innerHTML = visitsHtml(m?.visits.slice(0, 4) ?? [], m);

  $('#overviewProfile').innerHTML = `
    <div class="progress-row">
      <div class="progress-row__text"><span>Заполнено</span><b>${percent}%</b></div>
      <div class="meter meter--light" role="meter" aria-label="Профиль заполнен" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><i style="width:${percent}%"></i></div>
    </div>
    <ul class="checklist">
      ${['Имя', 'Фамилия', 'Телефон', 'Дата рождения'].map((label) => `
        <li class="${missing.includes(label) ? '' : 'done'}">${icon('check')}${label}</li>`).join('')}
    </ul>
    ${missing.length ? `<a class="btn outline ov-fill" href="/account/profile" data-goto="tab-profile" data-edit="1">${icon('edit')}Дополнить профиль</a>` : ''}`;
}

function visitsHtml(visits, m) {
  if (!m) return '<li class="empty">Посещения появятся после оформления абонемента.</li>';
  if (!visits.length) return '<li class="empty">По этому абонементу ещё не было посещений.</li>';
  return visits.map((v, i) => `
    <li><b>№${m.visitsUsed - i}</b><time datetime="${escapeHtml(v.at)}">${escapeHtml(visitFmt.format(new Date(v.at)))}</time></li>`).join('');
}

/** Кнопка «Продлить/Купить» на карте абонемента — ведёт в магазин к нужному тарифу. */
function shopCTA(label, planId = null) {
  return `<a class="btn primary" href="/account/shop" data-goto="tab-shop" ${planId ? `data-shop-plan="${escapeHtml(planId)}"` : ''}>${label}${icon('arrow')}</a>`;
}

/** Карта абонемента. compact — для «Обзора» (без подробностей, с кнопкой). */
function passHtml(m, { compact = false } = {}) {
  if (!m) {
    return `
      <div class="pass pass--muted">
        <div class="pass__top">
          <div><p class="pass__kind">Абонемент</p><p class="pass__title">Пока нет абонемента</p></div>
          <span class="badge" data-code="none">Не оформлен</span>
        </div>
        <p>Выберите тариф в магазине — оформим онлайн за минуту, касса не нужна. Абонемент появится здесь сразу после оплаты.</p>
        ${compact ? shopCTA('Выбрать абонемент') : ''}
      </div>`;
  }

  const { status } = m;
  const unlimited = m.visitsTotal == null;
  const pct = unlimited ? 100 : Math.round((status.visitsLeft / m.visitsTotal) * 100);
  const muted = status.code === 'expired' || status.code === 'used_up';
  const variant = muted ? ' pass--muted' : m.planId.startsWith('gold') ? ' pass--gold' : '';
  const big = unlimited
    ? '<b>∞</b><span>безлимитные посещения</span>'
    : `<b>${status.visitsLeft}</b><span>из ${m.visitsTotal} ${plural(m.visitsTotal, words.visitsGen)} осталось</span>`;
  const daysLeft = status.daysLeft == null ? 'без срока'
    : status.code === 'expired' ? 'истёк' : `${status.daysLeft} ${plural(status.daysLeft, words.days)}`;
  const renewLabel = status.code === 'expired' || status.code === 'used_up' ? 'Продлить абонемент' : 'Продлить';

  const facts = compact
    ? `<dl class="pass__facts">
        <div><dt>Действует до</dt><dd>${m.endsAt ? formatDate(m.endsAt) : 'без срока'}</dd></div>
        <div><dt>До окончания</dt><dd>${daysLeft}</dd></div>
      </dl>
      <a class="btn primary" href="/account/membership" data-goto="tab-membership">Подробнее${icon('arrow')}</a>
      ${status.code === 'active' || status.code === 'scheduled' ? `<a class="btn outline" href="/account/schedule" data-goto="tab-schedule">${icon('clock')}Записаться</a>` : ''}`
    : `<dl class="pass__facts">
        <div><dt>Действует с</dt><dd>${formatDate(m.startsAt)}</dd></div>
        <div><dt>Действует до</dt><dd>${m.endsAt ? formatDate(m.endsAt) : 'без срока'}</dd></div>
        <div><dt>До окончания</dt><dd>${daysLeft}</dd></div>
        <div><dt>Использовано</dt><dd>${m.visitsUsed} ${plural(m.visitsUsed, words.visits)}</dd></div>
        <div><dt>Стоимость</dt><dd>${formatPrice(m.price)}</dd></div>
        <div><dt>Оформлен</dt><dd>${formatDate(m.issuedAt.slice(0, 10))}</dd></div>
      </dl>
      <a class="btn primary" href="/account/shop" data-goto="tab-shop" data-shop-plan="${escapeHtml(m.planId)}">${renewLabel}${icon('arrow')}</a>
      ${status.code === 'active' ? `<a class="btn outline" href="/account/schedule" data-goto="tab-schedule">${icon('clock')}Записаться на занятие</a>` : ''}`;

  return `
    <article class="pass${variant}" aria-label="Абонемент">
      <div class="pass__top">
        <div>
          <p class="pass__kind">${m.category === 'pool' ? 'Бассейн' : 'Фитнес-клуб'}</p>
          <h3 class="pass__title">${escapeHtml(m.title.split(' · ').slice(1).join(' · ') || m.title)}</h3>
        </div>
        <span class="badge" data-code="${escapeHtml(status.code)}">${escapeHtml(status.label)}</span>
      </div>
      <div>
        <p class="pass__big">${big}</p>
        <div class="meter" role="meter" aria-label="Остаток посещений" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
      </div>
      ${facts}
    </article>`;
}

function renderMembership() {
  const m = user.membership;
  const side = m
    ? `<div class="panel">
        <h3 class="acc-h3">История посещений</h3>
        <ul class="visits">${visitsHtml(m.visits, m)}</ul>
        <p class="note">Нашли ошибку в посещениях — сообщите на ресепшене.</p>
      </div>`
    : `<div class="panel">
        <h3 class="acc-h3">Как оформить абонемент</h3>
        <ol class="steps">
          <li><span>Заполните <a href="/account/profile" data-goto="tab-profile" data-edit="1">профиль</a> — хотя бы телефон.</span></li>
          <li><span>Выберите абонемент: <a href="/#fitness">фитнес-клуб</a> или <a href="/#prices">бассейн</a>.</span></li>
          <li><span>Оплатите в магазине кабинета по карте — или на кассе, назвав почту <b>${escapeHtml(user.email)}</b> — абонемент привяжут к кабинету.</span></li>
        </ol>
      </div>`;
  $('#membershipBox').innerHTML = `<div class="acc-columns">${passHtml(m)}${side}</div>`;
}

function infoItem(label, value, { hint = '', fillable = false } = {}) {
  if (!value) {
    return `<div class="info-item info-item--empty"><dt>${label}</dt><dd>${fillable
      ? '<button type="button" data-fill>Указать</button>' : 'не указано'}</dd></div>`;
  }
  return `<div class="info-item"><dt>${label}</dt><dd>${escapeHtml(value)}${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</dd></div>`;
}

function renderProfileView() {
  const age = ageOn(user.birthDate, today());
  const { percent, missing } = profileCompleteness(user);
  const m = user.membership;
  $('#memberSince').textContent = `${user.email} · в кабинете с ${formatDate(user.createdAt.slice(0, 10))}`;
  $('#completeness').innerHTML = `
    <div class="progress-row__text"><span>${missing.length ? `Профиль заполнен на ${percent}% — не хватает: ${missing.join(', ').toLowerCase()}` : 'Профиль заполнен полностью'}</span><b>${percent}%</b></div>
    <div class="meter meter--light" role="meter" aria-label="Профиль заполнен" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><i style="width:${percent}%"></i></div>`;

  $('#profileInfo').innerHTML = [
    infoItem('Имя', user.firstName),
    infoItem('Фамилия', user.lastName, { fillable: true }),
    infoItem('Телефон', user.phone ? formatPhone(user.phone) : null, { fillable: true }),
    infoItem('Дата рождения', user.birthDate ? formatDate(user.birthDate) : null,
      { fillable: true, hint: age != null ? `${age} ${plural(age, words.years)}` : '' }),
    infoItem('Почта', user.email, { hint: 'логин для входа' }),
    infoItem('Язык сайта', LANG_NAMES[user.lang] ?? user.lang),
    infoItem('Абонемент', m ? m.title.split(' · ').slice(1).join(' · ') : 'нет', { hint: m ? m.status.label : '' }),
    infoItem('В кабинете с', formatDate(user.createdAt.slice(0, 10))),
  ].join('');
}

function fillProfileForm() {
  const f = $('#profileForm').elements;
  f.firstName.value = user.firstName ?? '';
  f.lastName.value = user.lastName ?? '';
  f.phone.value = user.phone ? formatPhone(user.phone) : '';
  f.birthDate.value = user.birthDate ?? '';
  f.birthDate.max = today();
  $('#pf-email').value = user.email;
  showErrors($('#profileForm'));
  setStatus($('#profileForm [data-status]'), '');
}

function setEditing(on) {
  const form = $('#profileForm');
  if (!form || form.hidden === !on) return;
  $('#profileView').hidden = on;
  form.hidden = !on;
  if (on) {
    fillProfileForm();
    setStatus($('#profileSaved'), '');
    // ждём отрисовки, чтобы фокус и прокрутка сработали
    requestAnimationFrame(() => {
      const empty = ['lastName', 'phone', 'birthDate'].find((k) => !form.elements[k].value);
      form.elements[empty ?? 'firstName'].focus();
    });
  }
}

function renderSettings() {
  $$('#langSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === user.lang)));
  $$('[data-demo-off]').forEach((el) => { el.disabled = Boolean(user.demo); });
}

// ---------- обработчики ----------

function initAuthForms() {
  const login = $('#panel-login');
  login.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = login.elements.email.value.trim();
    const password = login.elements.password.value;
    if (!email || !password) {
      setStatus($('[data-status]', login), 'Введите почту и пароль', 'error');
      return;
    }
    const result = await submitWith(login, () => accountApi.login({ email, password }), { pending: 'Входим…' });
    if (result) onSignedIn(result.user);
  });

  const reg = $('#panel-register');
  reg.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = {
      firstName: reg.elements.firstName.value,
      email: reg.elements.email.value,
      password: reg.elements.password.value,
      consent: reg.elements.consent.checked,
    };
    const check = validateRegistration(values);
    showErrors(reg, check.errors);
    if (!check.ok) return;
    const result = await submitWith(reg, () => accountApi.register(values), { pending: 'Создаём аккаунт…' });
    if (result) {
      reg.reset();
      onSignedIn(result.user);
      navigate('profile');
      setEditing(true); // сразу предлагаем заполнить данные
    }
  });

  $('#demoList').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-demo-email]');
    if (!btn) return;
    login.elements.email.value = btn.dataset.demoEmail;
    login.elements.password.value = btn.dataset.demoPassword;
    $('#tab-login').click();
    login.requestSubmit();
  });
}

async function loadDemoAccounts() {
  try {
    const { demoAccounts = [] } = await accountApi.session();
    $('#demoBox').hidden = demoAccounts.length === 0;
    $('#demoList').innerHTML = demoAccounts.map((a) => `
      <button class="demo-btn" type="button" data-demo-email="${escapeHtml(a.email)}" data-demo-password="${escapeHtml(a.password)}">
        <span><b>${escapeHtml(a.label)}</b><small>${escapeHtml(a.email)}</small></span>${icon('arrow')}
      </button>`).join('');
  } catch {
    $('#demoBox').hidden = true;
  }
}

function initProfile() {
  const form = $('#profileForm');
  $('#editProfileBtn').addEventListener('click', () => setEditing(true));
  $('#cancelEditBtn').addEventListener('click', () => {
    setEditing(false);
    $('#editProfileBtn').focus();
  });
  $('#profileInfo').addEventListener('click', (event) => {
    if (event.target.closest('[data-fill]')) setEditing(true);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const patch = {
      firstName: form.elements.firstName.value,
      lastName: form.elements.lastName.value,
      phone: form.elements.phone.value,
      birthDate: form.elements.birthDate.value,
    };
    const check = validateProfile(patch, { today: today() });
    showErrors(form, check.errors);
    if (!check.ok) return;
    const result = await submitWith(form, () => accountApi.updateProfile(patch));
    if (result) {
      user = result.user;
      renderAll();
      setEditing(false);
      setStatus($('#profileSaved'), 'Изменения сохранены', 'ok');
    }
  });
}

function initSettings() {
  $('#langSeg').addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-value]');
    if (!btn || btn.dataset.value === user.lang) return;
    const status = $('#langStatus');
    setStatus(status, 'Сохраняем…', 'pending');
    try {
      const result = await accountApi.updateProfile({ lang: btn.dataset.value });
      user = result.user;
      persistLang(user.lang);
      renderAll();
      setStatus(status, 'Сохранено. Сайт откроется на выбранном языке.', 'ok');
    } catch (error) {
      if (error.status === 401) return onSignedOut('Сеанс завершён — войдите снова.');
      setStatus(status, error.message, 'error');
    }
  });

  const pw = $('#passwordForm');
  pw.addEventListener('submit', async (event) => {
    event.preventDefault();
    const currentPassword = pw.elements.currentPassword.value;
    const newPassword = pw.elements.newPassword.value;
    const errors = {};
    if (!currentPassword) errors.currentPassword = 'Введите текущий пароль';
    const err = passwordError(newPassword);
    if (err) errors.newPassword = err;
    showErrors(pw, errors);
    if (Object.keys(errors).length) return;
    const result = await submitWith(pw, () => accountApi.changePassword({ currentPassword, newPassword }));
    if (result) {
      pw.reset();
      const n = result.endedSessions;
      setStatus($('[data-status]', pw), n ? `Пароль изменён. Завершено сеансов на других устройствах: ${n}.` : 'Пароль изменён.', 'ok');
    }
  });

  $('#logoutAllBtn').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const status = $('#sessionsStatus');
    btn.disabled = true;
    try {
      const { endedSessions: n } = await accountApi.logoutOthers();
      setStatus(status, n ? `Готово: завершено ${n} ${plural(n, ['сеанс', 'сеанса', 'сеансов'])}.` : 'Других активных сеансов нет.', 'ok');
    } catch (error) {
      if (error.status === 401) return onSignedOut('Сеанс завершён — войдите снова.');
      setStatus(status, error.message, 'error');
    } finally {
      btn.disabled = Boolean(user?.demo);
    }
  });

  const del = $('#deleteForm');
  del.addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = del.elements.password.value;
    if (!password) return showErrors(del, { password: 'Введите пароль' });
    // eslint-disable-next-line no-alert -- осознанное подтверждение необратимого действия
    if (!window.confirm('Удалить аккаунт без возможности восстановления?')) return;
    const result = await submitWith(del, () => accountApi.deleteAccount(password), { pending: 'Удаляем…' });
    if (result) {
      del.reset();
      onSignedOut();
      setStatus($('#panel-login [data-status]'), 'Аккаунт удалён.', 'ok');
    }
  });
}

/**
 * Навигация кабинета: ссылки меню и ссылки вида data-goto="tab-profile".
 * Ссылки — настоящие URL: клик перехватываем для перехода без перезагрузки,
 * но с отключённым JS они ведут на ту же страницу (браузерный роутинг).
 */
function initDashNav() {
  const nav = $('#dashNav');
  nav.addEventListener('click', (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    const link = event.target.closest('.dash-nav__item');
    if (!link) return;
    event.preventDefault();
    navigate(link.dataset.section ?? 'overview', { replace: location.pathname === `${ACCOUNT_BASE}/${link.dataset.section}` ? true : false });
  });
  window.addEventListener('popstate', () => {
    if (!user || $('#accountView').hidden) return;
    const section = sectionFromPath();
    if (section === '?') history.replaceState(null, '', `${ACCOUNT_BASE}/overview`);
    showSection(SECTIONS.includes(section) ? section : 'overview');
  });
  // Ссылки внутри кабинета вида data-goto="tab-profile" (+href нового пути)
  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-goto]');
    if (!link) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigate(link.dataset.goto.replace('tab-', ''));
    if (link.dataset.edit) setEditing(true);
    // Кнопка «Продлить/Купить» на карте абонемента ведёт в магазин к своему тарифу
    if (link.dataset.shopPlan) {
      document.dispatchEvent(new CustomEvent('neptun:shop-open', { detail: { planId: link.dataset.shopPlan } }));
    }
  });
  // Легаси-хеши (#schedule у старых ссылок): сводим на новый URL
  window.addEventListener('hashchange', () => {
    if (!user || $('#accountView').hidden) return;
    const name = location.hash.slice(1);
    if (SECTIONS.includes(name)) navigate(name);
  });
}

async function logout() {
  try { await accountApi.logout(); } catch { /* cookie всё равно перестанет действовать по сроку */ }
  onSignedOut();
}

async function bootstrap() {
  initTheme([...document.querySelectorAll('[data-theme-toggle]')]);
  initTabs($('#authTabs'));
  initDashNav();
  initAuthForms();
  initProfile();
  initSettings();
  // Покупка/продление абонемента и запись на занятия
  shopCtl = initShop({ root: $('#shopRoot'), getUser: () => user, refreshUser, goto });
  bookingCtl = initBooking({ root: $('#scheduleRoot'), goto });

  $('#logoutBtn').addEventListener('click', logout);
  $('#logoutTop').addEventListener('click', logout);

  try {
    // Сначала тихая проверка сессии (всегда 200): 401 «нет сессии» не должен шуметь в консоли
    const { authenticated } = await accountApi.session();
    if (!authenticated) throw Object.assign(new Error('Гость'), { status: 401 });
    const { user: me } = await accountApi.me();
    onSignedIn(me);
  } catch (error) {
    show('auth');
    if (error.status !== 401) setStatus($('#panel-login [data-status]'), error.message, 'error');
    if (location.hash === '#register') $('#tab-register').click();
    loadDemoAccounts();
  }
}

bootstrap();
