/**
 * Кнопка личного кабинета в шапке: «Войти» или «Кабинет», если посетитель уже вошёл.
 * Запрос к API не блокирует страницу; при ошибке остаётся «Войти» — ссылка ведёт туда же.
 */

import { accountApi } from '../services/api.js?v=2';

export function initAccountLink(links, i18n) {
  let signedIn = false;

  function render() {
    links.forEach((link) => {
      link.toggleAttribute('data-signed-in', signedIn);
      link.querySelectorAll('[data-account-label]').forEach((label) => {
        label.textContent = label.dataset.accountLabel === 'long'
          ? i18n.t('accountLong')
          : i18n.t(signedIn ? 'account' : 'signIn');
      });
    });
  }

  i18n.onChange(render);

  accountApi.session()
    .then((s) => { signedIn = Boolean(s.authenticated); })
    .catch(() => { /* бэкенд недоступен (статический хостинг) — остаётся «Войти» */ })
    .finally(render);
}
