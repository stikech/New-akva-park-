/**
 * Переключение языка RU/KZ.
 * Русские строки снимаются из DOM при старте, чтобы не дублировать их в JS.
 */

import { DEFAULT_LANG, HTML_LANG, STATIC_TRANSLATIONS, DYNAMIC_STRINGS } from '../config/i18n.js?v=4';

const STORAGE_KEY = 'neptun-lang';

export function createI18n(root = document) {
  const elements = [...root.querySelectorAll('[data-i18n]')];
  const ariaElements = [...root.querySelectorAll('[data-i18n-aria]')];
  const buttons = [...root.querySelectorAll('[data-lang]')];
  const sourceText = new Map(elements.map((el) => [el, el.textContent]));
  const sourceAria = new Map(ariaElements.map((el) => [el, el.getAttribute('aria-label')]));
  const listeners = new Set();
  let lang = DEFAULT_LANG;

  function apply(nextLang) {
    lang = nextLang in DYNAMIC_STRINGS ? nextLang : DEFAULT_LANG;
    document.documentElement.lang = HTML_LANG[lang];

    buttons.forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.lang === lang)));

    const dict = STATIC_TRANSLATIONS[lang] ?? {};
    elements.forEach((el) => {
      el.textContent = dict[el.dataset.i18n] ?? sourceText.get(el);
    });
    ariaElements.forEach((el) => {
      const next = dict[el.dataset.i18nAria];
      el.setAttribute('aria-label', next ?? sourceAria.get(el));
    });

    listeners.forEach((fn) => fn(lang));
    persist(lang);
  }

  buttons.forEach((btn) => btn.addEventListener('click', () => apply(btn.dataset.lang)));

  return {
    /** Динамическая строка на текущем языке. */
    t: (key, ...args) => DYNAMIC_STRINGS[lang][key](...args),
    /** Подписка на смену языка. */
    onChange: (fn) => listeners.add(fn),
    /** Применить сохранённый язык. Вызывать после подписки всех модулей. */
    init: () => apply(restore()),
  };
}

function persist(lang) {
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* приватный режим — не критично */ }
}

function restore() {
  try { return localStorage.getItem(STORAGE_KEY) || DEFAULT_LANG; } catch { return DEFAULT_LANG; }
}
