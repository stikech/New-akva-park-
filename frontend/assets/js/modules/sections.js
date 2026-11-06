/**
 * Разделы сайта — отдельные страницы: /slides, /prices, /rules, /fitness,
 * /classes, /spa, /pool, /contacts (frontend/<раздел>.html, сервер отдаёт
 * их по чистым адресам). Модуль подсвечивает текущий раздел в шапке и меню.
 */

/** Разделы с собственной страницей (ср. SITE_SECTION_SLUGS в backend/src/app.js). */
export const SECTION_IDS = ['slides', 'prices', 'rules', 'fitness', 'classes', 'spa', 'pool', 'contacts'];

/** '/prices/' -> 'prices', '/' -> null (главная без раздела). */
export function sectionFromPath(pathname) {
  const slug = pathname.replace(/\/+$/, '').slice(1);
  return SECTION_IDS.includes(slug) ? slug : null;
}

/** aria-current="page" у ссылок на текущую страницу (подчёркивание — layout.css). */
export function markCurrentSection(root = document) {
  const current = sectionFromPath(location.pathname);
  for (const link of root.querySelectorAll('nav a[href]')) {
    if (link.origin !== location.origin || link.closest('.crumbs')) continue;
    if (current && sectionFromPath(link.pathname) === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}
