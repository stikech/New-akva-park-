/**
 * Тема: светлая/тёмная. Выбор хранится в localStorage («neptun.theme»);
 * пока пользователь не выбирал — идём за системной настройкой.
 * До загрузки JS это делает inline-скрипт в <head> (иначе вспышка тёмного на белом).
 */

const KEY = 'neptun.theme';
const THEMES = new Set(['dark', 'light']);

const read = () => {
  try { return localStorage.getItem(KEY); } catch { return null; }
};

function apply(root, value) {
  root.dataset.theme = value;
  root.style.colorScheme = value;
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', value === 'dark' ? '#04141F' : '#FFFFFF');
}

export function initTheme(buttons) {
  if (!buttons.length) return;
  const root = document.documentElement;

  const buttonsFor = (dark) => {
    buttons.forEach((btn) => {
      btn.setAttribute('aria-pressed', String(dark));
    });
  };

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      apply(root, next);
      buttonsFor(next === 'dark');
      // плавная смена поверхностей, но без постоянных глобальных transition
      root.classList.add('theme-swap');
      setTimeout(() => root.classList.remove('theme-swap'), 350);
      try { localStorage.setItem(KEY, next); } catch { /* приватный режим */ }
    });
  });

  buttonsFor(read() === 'dark' || (!THEMES.has(read() ?? '') && matchMedia('(prefers-color-scheme: dark)').matches));

  // meta theme-color для уже открытой темы (boot-скрипт тему ставит, meta не трогает)
  const syncMeta = () => {
    const dark = root.dataset.theme === 'dark';
    document.querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', dark ? '#04141F' : '#FFFFFF');
  };
  syncMeta();

  // пользователь не выбирал тему — следуем за переключением системы
  const media = matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener?.('change', ({ matches }) => {
    const stored = read();
    if (THEMES.has(stored ?? '')) return;
    apply(root, matches ? 'dark' : 'light');
    buttonsFor(matches);
  });
}
