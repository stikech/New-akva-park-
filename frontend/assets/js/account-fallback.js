/**
 * Обычный (не module) скрипт: срабатывает, даже если модули кабинета не загрузились
 * (сбой сети, старый файл в кеше браузера, ошибка в коде). Если через 15 секунд
 * экран «Загружаем…» всё ещё виден — показываем понятное сообщение и кнопку «Обновить».
 * Дольше 15 секунд загрузка не идёт: запросы к API ограничены таймаутом 10 секунд.
 */
(function () {
  setTimeout(function () {
    var box = document.getElementById('loadingView');
    if (!box || box.hidden) return;
    box.textContent = '';
    var text = document.createElement('p');
    text.textContent = 'Не удалось загрузить кабинет. Обновите страницу — если не поможет, нажмите Ctrl+Shift+R (на телефоне — закройте и откройте вкладку).';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn primary';
    btn.textContent = 'Обновить';
    btn.addEventListener('click', function () { location.reload(); });
    box.classList.add('acc-loading--failed');
    box.append(text, btn);
  }, 15000);
}());
