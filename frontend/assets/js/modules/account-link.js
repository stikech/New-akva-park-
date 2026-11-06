/**
 * Кнопка личного кабинета в шапке: «Войти» или имя посетителя, если он уже вошёл.
 * Запрос к API не блокирует страницу; при ошибке остаётся «Войти» — ссылка ведёт туда же.
 * При возврате кнопкой «назад» браузер показывает страницу из кеша (bfcache) —
 * тогда состояние входа проверяется заново.
 */

import { accountApi } from '../services/api.js?v=4';

export function initAccountLink(links, i18n) {
  let signedIn = false;
  let firstName = '';

  function render() {
    links.forEach((link) => {
      link.toggleAttribute('data-signed-in', signedIn);
      link.querySelectorAll('[data-account-label]').forEach((label) => {
        label.textContent = label.dataset.accountLabel === 'long'
          ? i18n.t('accountLong')
          : signedIn ? firstName || i18n.t('account') : i18n.t('signIn');
      });
    });
  }

  i18n.onChange(render);

  const check = () => accountApi.session()
    .then((s) => {
      signedIn = Boolean(s.authenticated);
      firstName = s.user?.firstName?.trim() ?? '';
    })
    .catch(() => { /* бэкенд недоступен (статический хостинг) — остаётся «Войти» */ })
    .finally(render);

  check();
  window.addEventListener('pageshow', (event) => { if (event.persisted) check(); });
}
