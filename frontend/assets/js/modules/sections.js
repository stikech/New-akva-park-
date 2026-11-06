/**
 * Навигация по сайту настоящими адресами: /prices, /rules, /pool…
 * Кнопки шапки и меню ведут на секции главной, страница при этом не
 * перезагружается: роутер сам скроллит к секции и обновляет адрес.
 *
 * Прямое открытие адреса (/prices, по ссылке или F5) тоже работает:
 * сервер отдаёт главную, а роутер после загрузки доезжает до секции.
 */

/** Секции с собственным адресом (ср. SITE_SECTION_SLUGS в backend/src/app.js). */
const SECTION_IDS = ['slides', 'prices', 'rules', 'fitness', 'classes', 'spa', 'pool', 'contacts'];

/** '/prices/' -> 'prices', '/' -> null (главная без секции). */
export function sectionFromPath(pathname) {
  const slug = pathname.replace(/\/+$/, '').slice(1);
  return SECTION_IDS.includes(slug) ? slug : null;
}

export function initSectionRouting() {
  // Ссылки на секции (шапка, мобильное меню, футер); /account в выборку не входит.
  const links = [...document.querySelectorAll('a[href]')]
    .filter((a) => a.origin === location.origin
      && (sectionFromPath(a.pathname) !== null || a.pathname === '/'));

  const linksBySection = new Map();
  for (const link of links) {
    const section = sectionFromPath(link.pathname) ?? '';
    if (!linksBySection.has(section)) linksBySection.set(section, []);
    linksBySection.get(section).push(link);
  }

  const mark = (section) => markSection(linksBySection, section);
  const spy = trackSectionInView(mark);
  const goTo = (section, behavior) => {
    (section ? document.getElementById(section) : document.documentElement)
      ?.scrollIntoView({ behavior, block: 'start' });
  };

  // Первый показ страницы — мгновенный прыжок, дальше прокрутка плавная.
  let landed = false;
  const applyLocation = () => {
    const section = sectionFromPath(location.pathname);
    goTo(section, landed ? 'smooth' : 'auto');
    landed = true;
    mark(section);
  };

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0
      || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href]');
    if (!link || !links.includes(link)) return;

    event.preventDefault();
    spy.freeze();
    const section = sectionFromPath(link.pathname);
    goTo(section, 'smooth');
    history.pushState({}, '', link.pathname + link.search);
    mark(section);
  });

  window.addEventListener('popstate', () => {
    spy.freeze();
    applyLocation();
  });

  // Прыжок сразу после загрузки и повторно — когда данные отрисованы и
  // размеры секций устоялись, иначе прямой адрес может «не доехать».
  requestAnimationFrame(applyLocation);
  window.addEventListener('load', applyLocation);

  return { reapply: applyLocation };
}

/** Подсветка активного пункта меню: aria-current + подчёркивание (см. layout.css). */
function markSection(map, section) {
  for (const [key, items] of map) {
    for (const item of items) {
      if (key === (section ?? '')) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    }
  }
}

/** Scrollspy: подсвечиваем секцию, находящуюся в верхней части экрана. */
function trackSectionInView(mark) {
  const sections = [...document.querySelectorAll('main [id]')].filter((el) => SECTION_IDS.includes(el.id));
  if (!sections.length) return { freeze() {} };

  // Во время плавной прокрутки после клика подсветку ведёт сам клик,
  // иначе по пути проскакивают «чужие» секции.
  let frozen = false;

  // «Линия», по которой определяем активную секцию, — чуть ниже шапки.
  const LINE = 130;
  const currentSection = () => {
    let current = null;
    for (const section of sections) {
      if (section.getBoundingClientRect().top > LINE) break;
      current = section;
    }
    // Прокрутили до конца страницы — активна последняя секция (контакты),
    // даже если её верх не дошёл до линии (секция низкая).
    const atEnd = window.innerHeight + window.scrollY
      >= document.documentElement.scrollHeight - 2;
    if (atEnd) current = sections.at(-1);
    return current?.id ?? null;
  };

  let scheduled = false;
  const update = () => {
    scheduled = false;
    if (frozen) return;
    mark(currentSection());
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(update);
  };

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  update();

  return {
    freeze() {
      frozen = true;
      setTimeout(() => {
        frozen = false;
        update();
      }, 1000);
    },
  };
}
