/* Решает тему до первой отрисовки: сохранённый выбор → системная → светлая.
   Отдельный (не inline) файл, потому что CSP разрешает только script-src 'self'.
   Загружается синхронно в <head> до стилей — вспышки тёмного на белом нет. */
(function () {
  var t = null;
  try { t = localStorage.getItem('neptun.theme'); } catch (e) {}
  var v = t === 'dark' ? 'dark'
    : t === 'light' ? 'light'
    : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = v;
  document.documentElement.style.colorScheme = v;
})();
