/** Мобильное меню: открытие по бургеру, закрытие по ссылке и Escape. */

export function initMobileNav(burger, drawer) {
  const setOpen = (open) => {
    drawer.classList.toggle('open', open);
    burger.setAttribute('aria-expanded', String(open));
  };

  burger.addEventListener('click', () => setOpen(!drawer.classList.contains('open')));
  drawer.addEventListener('click', (event) => {
    if (event.target.closest('a')) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drawer.classList.contains('open')) {
      setOpen(false);
      burger.focus();
    }
  });
}
