/**
 * Доступные вкладки (WAI-ARIA Tabs): клик, стрелки, Home/End, roving tabindex.
 * opts.sync — отражать выбор в location.hash (#tab-…): вкладка открывается
 * по прямой ссылке, но якоря секций (#prices) подход не ломает.
 */
export function initTabs(tablist, { sync = false } = {}) {
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  if (!tabs.length) return;

  function select(tab, { focus = true, silent = false } = {}) {
    tabs.forEach((t) => {
      const selected = t === tab;
      t.setAttribute('aria-selected', String(selected));
      t.tabIndex = selected ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !selected;
    });
    if (silent !== true && sync) {
      try { history.replaceState(null, '', `#${tab.id}`); } catch { /* file:// — не критично */ }
    }
    if (focus) tab.focus();
  }

  const KEY_TO_INDEX = {
    ArrowRight: (i) => (i + 1) % tabs.length,
    ArrowLeft: (i) => (i - 1 + tabs.length) % tabs.length,
    Home: () => 0,
    End: () => tabs.length - 1,
  };

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (event) => {
      const next = KEY_TO_INDEX[event.key];
      if (!next) return;
      event.preventDefault();
      select(tabs[next(i)]);
    });
  });

  // выбор по прямой ссылке — начальный select молчаливый, якорь не переписывает
  const linked = sync && tabs.find((t) => `#${t.id}` === location.hash);
  select(linked ?? tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabs[0], { focus: false, silent: true });
}
