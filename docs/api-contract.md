# Контракт API для фронтенда

Фронтенд получает и отправляет данные только через `frontend/assets/js/services/api.js`.
Сейчас `getSiteData()` возвращает статический объект из `assets/js/config/site-data.js` —
**он и есть полный эталон формы** (с реальными данными). Бэкенд должен отдавать ту же форму,
тогда UI менять не придётся. Тесты `frontend/tests/site-data.test.js` проверяют её целостность.

Статус: **реализовано** в `backend/` (`GET /api/site`, `POST /api/feedback`, `GET /api/admin/feedback`,
`GET /api/health`, магазин в кабинете `payments.js`, расписание `bookings.js`).

## `GET /api/site`

Все данные для страницы одним запросом (они небольшие и меняются редко — удобно кешировать).
Ниже — структура с сокращёнными примерами; полные значения см. в `site-data.js`.

```jsonc
{
  "tzOffsetHours": 5,
  "coords": { "lat": 54.8667, "lon": 69.15 },

  "hours": {
    "park": { "weekday": [12, 22], "weekend": [10, 22] },   // [открытие, закрытие], целые часы, местное время
    "pool": [8, 23]
  },

  "prices": {
    "park": {
      "adult": { "weekday": { "h2": 5700, "unl": 6300 }, "weekend": { "h2": 6200, "unl": 6800 } },
      "child": { "weekday": { "h2": 5200, "unl": 5800 }, "weekend": { "h2": 5400, "unl": 6000 } },
      "note": "строка-пояснение под таблицей"
    },
    "pool": [
      { "id": "adult", "label": "Взрослый", "prices": [2000, 2700, 3000, 8500] }   // 1ч, 2ч, 3ч, 12 посещений
    ]
  },

  "fitness": {
    "floor": 4,
    "hours": [8, 23],
    "directions": ["Тренажёрный зал", "Кроссфит"],
    "cards": [
      { "id": "day", "name": "Дневной", "packages": [{ "visits": 1, "price": 2000 }, { "visits": 12, "price": 7500 }] }
    ],                                                      // packages по возрастанию visits, первый — разовый (visits: 1)
    "gold": { "name": "«Золотая» карта", "periods": [{ "months": 1, "price": 20000 }] },
    "socials": [{ "id": "vk", "label": "ВКонтакте", "url": "https://vk.com/fitclubneptun" }]
  },

  "team": [
    { "id": "gym", "title": "Тренажёрный зал", "trainers": [
      { "name": "Руслан Касманов", "role": "Инструктор тренажёрного зала", "highlights": ["…"] }
    ]}
  ],

  "spa": {
    "massageHours": [9, 22],
    "booking": [{ "display": "33-64-41", "tel": "+77152336441" }],
    "massage": [{ "name": "Общий", "duration": "70 мин", "price": 7000 }],
    "solarium": {
      "units": 4, "cosmetics": "SolBianca",
      "groups": [{ "title": "Солярии 1–3",
                   "perMinute": [{ "name": "Горизонтальный", "price": 150 }],
                   "certificates": [{ "minutes": 50, "price": 5000 }] }]
    },
    "pressotherapy": { "single": 1100, "course": { "sessions": 10, "price": 10000 }, "minutes": 30 }
  },

  "slides": [
    {
      "id": "boomerang", "name": "Бумеранг", "color": "orange",   // orange | green | yellow | blue
      "level": "Средней сложности",
      "startHeightM": 22, "lengthM": 130, "minHeightCm": 120, "slopePct": 17,   // null = нет данных
      "path": "M10 10 C ..."   // SVG-путь иконки трассы
    }
  ]
}
```

## `POST /api/feedback`

Форма «Оставить отзыв» (раздел «Обратная связь» старого сайта).

```jsonc
// запрос, Content-Type: application/json
{ "name": "Аня", "email": "anya@example.com" /* или null */, "message": "Текст отзыва", "website": "" }
```

- `website` — honeypot: люди его не видят. Непустое значение = бот → ответить `200`, но не сохранять.
- Ответ: `201 { "ok": true }`. Ошибка валидации: `422 { "errors": { "name": "…" } }`.
- Серверная валидация: те же правила, что `validateFeedback` (функция импортируется из фронтенда),
  плюс строки обязательны по типу и длины: имя ≤ 80, почта ≤ 254, отзыв ≤ 3000 символов.
- Rate limit по IP: по умолчанию 5 запросов за 10 минут → `429 { "error", "retryAfterSec" }` + заголовок `Retry-After`.
- Прочие ошибки: `400` некорректный JSON, `413` тело > 16 КБ, `415` не `application/json`.
- Уведомление администрации — Telegram (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`). Капча старого сайта заменена honeypot + rate limit.
- Если бэкенд недоступен, фронтенд показывает ошибку и номер телефона.

## `GET /api/admin/feedback?limit=200`

Заголовок `Authorization: Bearer <ADMIN_TOKEN>`. Ответ:

```jsonc
{ "items": [{ "id": "uuid", "createdAt": "2026-11-04T10:15:28.680Z", "name": "Аня", "email": null, "message": "…" }],
  "total": 1, "notifications": "telegram" /* или "off" */ }
```

`401` — неверный токен (после 10 попыток за 15 минут — `429`), `503` — `ADMIN_TOKEN` не задан. `limit` ≤ 1000, новые первыми.

## Личный кабинет

Сессия — cookie `neptun_sid` (HttpOnly), браузер шлёт её сам. Изменяющие запросы — только
`Content-Type: application/json` и с `Origin` этого же сайта (иначе `403`). Ошибки полей — `422 { "errors": { поле: текст } }`,
нет сессии — `401`, лимит попыток — `429 { error, retryAfterSec }`.

| Метод и путь | Тело | Ответ |
| --- | --- | --- |
| `GET /api/auth/session` | — | `200 { authenticated: false }` или `{ authenticated: true, user: { firstName, lang } }` |
| `POST /api/auth/register` | `{ email, password, firstName, consent: true }` | `201 { user }` + cookie; `409` — почта занята |
| `POST /api/auth/login` | `{ email, password }` | `200 { user }` + cookie; `401` — неверная почта или пароль |
| `POST /api/auth/logout` | — | `200 { ok }`, cookie очищается |
| `GET /api/account` | — | `200 { user }` |
| `PATCH /api/account` | любые из `{ firstName, lastName, phone, birthDate, lang }`; `""` очищает поле | `200 { user }` |
| `POST /api/account/password` | `{ currentPassword, newPassword }` | `200 { ok, endedSessions }` |
| `POST /api/account/logout-all` | — | `200 { ok, endedSessions }` |
| `DELETE /api/account` | `{ password }` | `200 { ok }`, cookie очищается |

```jsonc
// user
{ "id": "uuid", "email": "anya@example.com", "firstName": "Аня", "lastName": null,
  "phone": "+77051234567", "birthDate": "1995-03-08", "lang": "ru", "createdAt": "…",
  "membership": { // null — абонемента нет
    "planId": "pool:adult:12", "category": "pool", "title": "Бассейн · Взрослый · 12 посещений, 2 месяца",
    "price": 8500, "visitsTotal": 12 /* null = безлимит */, "visitsUsed": 2,
    "startsAt": "2026-11-04", "endsAt": "2027-01-03" /* null = без срока, день включительно */, "issuedAt": "…",
    "status": { "code": "active" /* none|scheduled|active|expired|used_up */, "label": "Действует", "visitsLeft": 10, "daysLeft": 61 },
    "visits": [{ "at": "2026-11-04T10:51:00.000Z" }] /* последние 30, новые первыми */
  } }
```

Администратор (`Authorization: Bearer <ADMIN_TOKEN>`):

| Метод и путь | Тело | Ответ |
| --- | --- | --- |
| `GET /api/admin/users` | — | `{ items: user[], total, catalog: plan[], today }` |
| `PUT /api/admin/membership` | `{ userId, planId, startsAt, endsAt? }` — срок считается по тарифу, если не задан | `{ user }`; `404`, `422` |
| `DELETE /api/admin/membership` | `{ userId }` | `{ user }` |
| `POST /api/admin/visit` | `{ userId }` | `{ user }`; `409` — абонемент не действует |

Даты — `YYYY-MM-DD` по времени Петропавловска (UTC+5).

## Магазин абонементов: заказы и оплата

Клиент покупает или продлевает абонемент картой прямо из кабинета (вкладка «Магазин»).
Маршруты — `backend/src/payments.js`, хранилище заказов — `DATA_DIR/orders.json`,
журнал событий (append-only) — `DATA_DIR/audit.jsonl`. Все маршруты требуют сессию
(cookie `neptun_sid`); изменяющие — те же правила `Origin`/`Content-Type`, что и выше.

| Метод и путь | Тело | Ответ |
| --- | --- | --- |
| `GET /api/orders` | — | `200 { items: order[], total, catalog: plan[] }` — каталог идёт вместе с заказами: вкладка берёт цены только отсюда |
| `POST /api/orders` | `{ planId }` + заголовок `Idempotency-Key` (16–80 символов `[A-Za-z0-9._-]`) | `201 { order, catalog }` (или `200` при повторе — тот же заказ); `422 { errors: { planId } }` — тариф не найден; `429` — >10 pending-заказов / лимит создания |
| `GET /api/orders/:id` | — | `200 { order }` — владелец; чужой заказ неотличим от отсутствующего (`404`) |
| `POST /api/orders/:id/pay` | `{ number, exp, cvc, holder }` | `200 { order, alreadyPaid?, membership?: { extended } }`; `402 { error, code }` — отклонение; `422 { errors }` — карта не прошла валидацию |
| `POST /api/orders/:id/cancel` | — | `200 { order }` — только `pending`; иначе `409` |
| `GET /api/admin/orders` | — | `200 { items, total, today }` — все заказы с email клиента (Bearer `ADMIN_TOKEN`) |

```jsonc
// plan (каталог строится из site-data.js на сервере — цена существует только здесь)
{ "id": "pool:adult:12", "category": "pool", "title": "Бассейн · Взрослый · 12 посещений, 2 месяца", "price": 8500 }

// order
{ "id": "uuid", "planId": "pool:adult:12", "category": "pool",
  "title": "…", "price": 8500, "status": "pending" /* pending|paid|cancelled|expired */,
  "createdAt": "…", "updatedAt": "…", "paidAt": null, "attempts": 0,
  "receipt": null }   // после оплаты — объект ниже

// receipt — подписывается сервером, браузер перевыпустить не может
{ "receiptId": "r_42U6Qv18", "paidAt": "2026-11-05T09:08:00.000Z", "last4": "4242",
  "brand": "Visa", "amount": 8500, "signature": "…base64url…", "valid": true }
```

После успешной оплаты заказ атомарно переводится `pending → paid` (ровно один раз —
повторная отправка формы не списывает повторно и отвечает `alreadyPaid: true`),
и абонемент выдаётся в тот же запрос: новая запись или продление старой
(`membership.extended` — `true`, если срок отрос, а не создан заново).
Если сервер упал между оплатой и выдачей, `GET /api/orders/:id` доделывает выдачу («ремонт»).

### Оплата: эмулятор шлюза

Вместо внешнего PSP — встроенный эмулятор, сценарии как у реального:
любая карта, валидная по **алгоритму Луна**, проходит; два заведомо отклоняемых номера:

| Номер | Результат |
| --- | --- |
| `4242 4242 4242 4242` (и любая другая Луна-валидная) | успех |
| `4000 0000 0000 0002` | `402 { code: "declined" }` — отклонено банком |
| `5105 1051 0510 9995` | `402 { code: "insufficient" }` — недостаточно средств |

Невалидные по Луне номера не доходят до «банка» — отклоняются с `422` на клиенте и сервере.
При подключении Kaspi Pay / bePaid / Halyk эмулятор заменяется колбэком шлюза, маршруты остаются.

### Безопасность платежей

- **Цена — только из каталога на сервере.** Тело платежа не содержит суммы: UI не может «назначить» свою цену,
  подмены `price` в запросе невозможны в принципе.
- **Идемпотентность создания.** `Idempotency-Key` обязателен: двойной клик или повторная отправка
  не создают второй заказ — вернётся тот же.
- **Одиночный переход статуса.** `pending → paid` — атомарная мутация хранилища: параллельные
  попытки выигрывает одна, деньги не спишутся дважды, абонемент не выдаётся повторно.
- **Данные карты не хранятся.** Валидация по месту (Луна, срок, CVC, держатель), в файлах и журнале —
  только последние 4 цифры и бренд.
- **Подписанные чеки.** HMAC-SHA256 ключом `PAYMENT_SECRET` по всем полям чека; проверка подписи —
  `timingSafeEqual`. Без `PAYMENT_SECRET` сервер не стартует (по умолчанию генерируется при запуске,
  но тогда подписи живут до перезапуска — для продакшена задайте переменную).
- **Лимиты.** Создание заказов: 20/час на пользователя, 40/час на IP; оплата: 30 попыток за 15 минут,
  из них неудачных — 10; неоплаченный заказ живёт 24 часа, потом становится `expired` и подметается.
- **SQL-инъекции не страшны по архитектуре:** хранилище — JSON-файлы без SQL-движка, значения
  попадают в поля объектов фиксированной формы (план — только по совпадению `id` из каталога,
  номера заказа проверяются regex'ом), всё, что попадает в HTML, экранируется на фронте.
- Чужой заказ и несуществующий — один и тот же `404` (не раскрываем существование чужих заказов).

## Расписание и записи на занятия

Маршруты — `backend/src/bookings.js`, расписание строится из `site-data.js → schedule`,
хранилище — `DATA_DIR/bookings.json`.

| Метод и путь | Тело | Ответ |
| --- | --- | --- |
| `GET /api/schedule?days=7` (1–14) | — | `200 { days: [{ date, slots }], today, tzOffsetHours, cutoffMin, maxActive }`; вошедшим — доп. поля `membership` и `myBookings` |
| `POST /api/bookings` | `{ key: "YYYY-MM-DD:session-id" }` | `201 { booking }`; повтор на тот же слот — `200 { booking, already: true }`; `409` — мест нет |
| `GET /api/bookings` | — | `200 { items, today }` — все мои записи |
| `DELETE /api/bookings/:key` | — | `200 { booking }` — отмена не позднее чем за `cutoffMin` минут до начала, иначе `409` |
| `GET /api/admin/bookings?date=YYYY-MM-DD` | — | `200 { date, items, total }` — записи на день (Bearer `ADMIN_TOKEN`) |

```jsonc
// slot из days[].slots[]
{ "key": "2026-11-05:aqua-19", "date": "2026-11-05", "sessionId": "aqua-19",
  "title": "Аквааэробика", "category": "aqua" /* pool|aqua|fitness|group|combat|kids */,
  "room": "Бассейн 25 м", "start": "19:00", "end": "20:00", "capacity": 14,
  "booked": 1, "free": 13,
  "past": false,        // началось / меньше cutoff до старта
  "fullyBooked": false,
  "bookable": true,     // можно записаться: действующий абонемент выбранной категории
  "mine": true,         // уже записан
  "needPlan": null }    // если нельзя — какую категорию абонемента нужно ("pool" | "fitness")

// booking
{ "id": "uuid", "key": "2026-11-05:aqua-19", "date": "2026-11-05", "sessionId": "aqua-19",
  "title": "Аквааэробика", "category": "aqua", "room": "Бассейн 25 м",
  "start": "19:00", "end": "20:00", "status": "booked" /* booked|cancelled */,
  "createdAt": "…", "cancelledAt": null }
```

Правила доступа: абонемент «Бассейн» (`pool`) открывает категории `pool` и `aqua`,
фитнес-абонемент (`fitness`) — все категории, включая бассейн; запись возможна только с
**действующим** абонементом (`403` с подсказкой оформить в магазине), не позднее
`cutoffMin` (60) минут до начала, не дальше 14 дней вперёд и не больше `maxActive` (15) будущих записей.


## `GET /api/health`

`200 { "ok": true, "uptimeSec": 42 }` — для health check хостинга.

## Правила

- Цены — целые числа в тенге (KZT), без копеек.
- `null` в характеристиках горок допустим: UI покажет «уточняется».
- Строки выводятся с экранированием (`escapeHtml`), но бэкенд всё равно не должен отдавать HTML.
- Ошибка API не должна ломать страницу: `main.js` логирует ошибку, статическая разметка остаётся.

## Что логично добавить на бэкенде

| Endpoint | Назначение |
| --- | --- |
| `GET /api/site` | ✅ данные выше |
| `POST /api/feedback` | ✅ отзывы |
| `GET /api/admin/feedback` | ✅ список отзывов |
| `/api/auth/*`, `/api/account*`, `/api/admin/users…` | ✅ личный кабинет и абонементы |
| `/api/orders*`, `/api/admin/orders` | ✅ покупка и продление абонементов картой |
| `/api/schedule`, `/api/bookings*`, `/api/admin/bookings` | ✅ расписание и запись на занятия |
| `POST /api/auth/reset` | восстановление пароля по почте (нужен SMTP) |
| `PUT /api/admin/…` | редактирование цен, расписания, команды администратором (с авторизацией) |
| `GET /api/events` | новости и события |
| `GET /api/gallery` | фото и видео, фото тренеров |
| `GET /api/site?lang=kz` | локализованные строки из БД вместо `config/i18n.js` |

Реальный платёжный шлюз: сейчас оплата — встроенный эмулятор (см. «Магазин абонементов»).
Подключение Kaspi Pay / bePaid / Halyk сводится к замене проверки номера на колбэк шлюза —
маршруты, заказы, идемпотентность и выдача абонемента уже готовы.
