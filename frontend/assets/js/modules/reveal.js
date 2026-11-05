/**
 * Появление секций при скролле. Без ожидания данных — можно запускать сразу
 * после разбора страницы и независимо от /api/site.
 *
 * Контент никогда не прячется навсегда: если IntersectionObserver недоступен,
 * наблюдение падает или сработало prefers-reduced-motion — классы не ставятся
 * и всё остаётся видимым (CSS .match-media в motion.css это дублирует).
 */

export function initReveal(targets) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!targets.length || typeof IntersectionObserver !== 'function') return;

  targets.forEach((el, i) => {
    el.classList.add('reveal');
    el.style.setProperty('--reveal-i', String(Math.min(i, 5)));
  });

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-in');
      io.unobserve(entry.target);
    }
  }, { threshold: 0.08, rootMargin: '0px 0px -8% 0px' });

  targets.forEach((el) => io.observe(el));
}
