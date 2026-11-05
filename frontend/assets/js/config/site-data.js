/**
 * Статические данные сайта (временный источник до появления бэкенда).
 *
 * Форма объекта = контракт GET /api/site (см. docs/api-contract.md).
 * Когда появится API, этот файл останется как fallback / фикстура для тестов.
 *
 * Источник цен и команды — страницы akvapark.kz «Виды клубных карт», «Команда»,
 * «Массаж. Солярий. Прессотерапия» (сохранены 04.11.2026).
 *
 * @typedef {[number, number]} HoursRange  [открытие, закрытие] в целых часах местного времени
 * @typedef {{ h2: number, unl: number }} DurationPrices  тенге
 * @typedef {{ visits: number, price: number }} Package  абонемент на N посещений
 * @typedef {{ name: string, role: string|null, highlights: string[] }} Trainer
 */

export const SITE_DATA = {
  /** Смещение часового пояса Петропавловска от UTC, ч. Казахстан — единый UTC+5. */
  tzOffsetHours: 5,

  coords: { lat: 54.8667, lon: 69.15 },

  hours: {
    /** @type {{ weekday: HoursRange, weekend: HoursRange }} */
    park: { weekday: [12, 22], weekend: [10, 22] },
    /** @type {HoursRange} */
    pool: [8, 23],
  },

  prices: {
    /** Аквапарк: «2 часа» = максимальное время пребывания 2 часа, «без лимита» = время не ограничено. */
    park: {
      adult: { weekday: { h2: 5700, unl: 6300 }, weekend: { h2: 6200, unl: 6800 } },
      child: { weekday: { h2: 5200, unl: 5800 }, weekend: { h2: 5400, unl: 6000 } },
      note: 'Тариф выходного дня действует также в праздники и в весенние, осенние и зимние каникулы.',
    },
    /** Плавательный бассейн. Порядок: 1 ч, 2 ч, 3 ч, 12 посещений (срок 2 месяца). */
    pool: [
      { id: 'adult', label: 'Взрослый', prices: [2000, 2700, 3000, 8500] },
      { id: 'child', label: 'Детский (5–14 лет)', prices: [1200, 1450, 1650, 6500] },
    ],
  },

  fitness: {
    floor: 4,
    /** @type {HoursRange} */
    hours: [8, 23],
    directions: [
      'Тренажёрный зал', 'Кроссфит', 'Муай тай', 'Грэпплинг', 'Аквааэробика', 'Пилатес', 'Хатха-йога',
      'Джампинг', 'Степ и танцевальная аэробика', 'Хип-хоп', 'Восточный танец', 'Pole dance',
      'Воздушный эквилибр', 'Детский фитнес',
    ],
    /** Абонементы на посещения. Первый пакет (1 посещение) — разовый визит. */
    cards: [
      { id: 'day', name: 'Дневной', packages: [{ visits: 1, price: 2000 }, { visits: 4, price: 4100 }, { visits: 8, price: 5700 }, { visits: 12, price: 7500 }] },
      { id: 'evening', name: 'Вечерний', packages: [{ visits: 1, price: 2000 }, { visits: 4, price: 4500 }, { visits: 8, price: 6500 }, { visits: 12, price: 8500 }] },
      { id: 'aqua', name: 'Аквааэробика', packages: [{ visits: 1, price: 2000 }, { visits: 6, price: 6100 }, { visits: 12, price: 9500 }] },
      { id: 'neptunchiki', name: '«Нептунчики»', packages: [{ visits: 1, price: 1700 }, { visits: 12, price: 9000 }] },
      { id: 'junior', name: '«Юниор»', packages: [{ visits: 1, price: 1200 }, { visits: 12, price: 6500 }] },
    ],
    /** Безлимитная клубная карта по сроку действия. */
    gold: {
      name: '«Золотая» карта',
      periods: [{ months: 1, price: 20000 }, { months: 6, price: 70000 }, { months: 12, price: 110000 }],
    },
    socials: [
      { id: 'instagram', label: 'Instagram', url: 'https://www.instagram.com/neptunfitnes_/' },
      { id: 'vk', label: 'ВКонтакте', url: 'https://vk.com/fitclubneptun' },
    ],
  },

  /** Тренеры по направлениям — в порядке вкладок. */
  team: [
    {
      id: 'gym', title: 'Тренажёрный зал', trainers: [
        { name: 'Руслан Касманов', role: 'Инструктор тренажёрного зала', highlights: ['Бронзовый призёр Центральной Азии 2019', 'Многократный призёр чемпионатов РК по бодибилдингу', 'Тренерский стаж с 2012 г.'] },
        { name: 'Олег Ляуконис', role: 'Инструктор тренажёрного зала', highlights: ['КМС по греко-римской борьбе, гиревому спорту и армрестлингу', 'Чемпион СКО по тяжёлой атлетике 2016 и 2019', 'Тренерский стаж с 2008 г.'] },
        { name: 'Денис Шестопалов', role: 'Инструктор тренажёрного зала', highlights: ['Чемпион мира по жиму лёжа среди юниоров 2015–2016', 'МС по жиму лёжа', 'Тренерский стаж с 2015 г.'] },
        { name: 'Марина Шатверян', role: 'Инструктор тренажёрного зала', highlights: ['МС РК по пауэрлифтингу и жиму лёжа', 'Тренерский стаж с 2013 г.'] },
      ],
    },
    {
      id: 'crossfit', title: 'Кроссфит', trainers: [
        { name: 'Амир Загрутдинов', role: 'Инструктор по CrossFit', highlights: ['Финишёр IronMan Astana 70.3 (2019)', 'Призёр универсиад и чемпионатов РК по многоборью', 'Тренерский стаж с 2012 г.'] },
        { name: 'Роман Ковач', role: 'Инструктор по функциональному многоборью', highlights: ['Чемпион турнира по кроссфиту, Петропавловск 2017', 'Бронзовый призёр турниров по тяжёлой атлетике 2019', 'Тренерский стаж с 2019 г.'] },
        { name: 'Алексей Горобченко', role: 'Инструктор по функциональному многоборью', highlights: ['МС РК по гиревому спорту, серебро чемпионатов Европы 2012–2013', 'Чемпион РК по кроссфиту в командах 2018', 'Тренерский стаж с 2017 г.'] },
      ],
    },
    {
      id: 'combat', title: 'Единоборства', trainers: [
        { name: 'Виктор Вегеле', role: 'Тренер по муай тай', highlights: ['Чемпион «Кубка Севера», многократный чемпион СКО', 'Призёр чемпионата РК по муай тай', 'Тренерский стаж с 2014 г.'] },
        { name: 'Тигран Степанян', role: 'Инструктор по муай тай', highlights: [] },
        { name: 'Дмитрий Фролков', role: 'Инструктор по грэпплингу', highlights: ['КМС по грэпплингу и боевому джиу-джитсу', 'Призёр чемпионата РК по грэпплингу 2019', 'Тренерский стаж с 2017 г.'] },
      ],
    },
    {
      id: 'group', title: 'Групповые программы', trainers: [
        { name: 'Андрей Качмар', role: 'Фитнес-менеджер', highlights: ['Методист Kazfitness Academy', 'Финалист International Fitness Open 2016–2017', 'Опыт работы с 2006 г.'] },
        { name: 'Галия Харисова', role: 'Групповые и водные программы', highlights: ['КМС СССР по плаванию', 'Пилатес, функциональный тренинг, аквааэробика'] },
        { name: 'Светлана Селютина', role: 'Групповые и водные программы', highlights: ['Сертификаты Pilates и «Аква-аэробика»', 'Стаж инструктора с 2009 г.'] },
        { name: 'Сергей Жамалиев', role: 'Хип-хоп, house, popping, breakdance', highlights: ['Победитель уличных фестивалей Hip-Hop 2012–2015', 'Тренерский стаж с 2008 г.'] },
        { name: 'Марина Рыбалкина', role: 'Хатха-йога', highlights: ['Семинары по йоге Айенгара и йога-терапии', 'Тренерский стаж с 2006 г.'] },
        { name: 'Дарья Качмар', role: 'Инструктор групповых программ', highlights: ['Бронзовый призёр «Битвы хореографов» 2015', 'Опыт работы с 2013 г.'] },
        { name: 'Юлия Шубина', role: 'Инструктор групповых программ', highlights: ['Сертифицированный специалист Jumping', 'В «Нептуне» с 2018 г.'] },
        { name: 'Карина Лавринова', role: 'Воздушный эквилибр', highlights: ['Бронзовый призёр всероссийских турниров по воздушной акробатике', 'В «Нептуне» с 2019 г.'] },
        { name: 'Владислава Головина', role: 'Восточный танец', highlights: ['7-кратный победитель регионального конкурса Helwa', 'Серебро фестиваля Oriental Astana 2014', 'Преподаёт с 2006 г.'] },
        { name: 'Наталья Попова', role: 'Pole dance', highlights: ['Победитель Exotic Pole Dance Championship (дуэт)', 'В «Нептуне» с 2018 г.'] },
      ],
    },
    {
      id: 'kids', title: 'Детский фитнес', trainers: [
        { name: 'Инна Батрак', role: 'Инструктор по детскому фитнесу', highlights: ['Серебряный призёр Республиканской универсиады по плаванию', 'Опыт работы с 2007 г.'] },
        { name: 'Кристина Хрупина', role: 'Инструктор по детскому фитнесу', highlights: ['Хореография и плавание', 'Тренерский стаж с 2016 г.'] },
        { name: 'Александр Кондрат', role: 'Инструктор по детскому фитнесу', highlights: ['МС по летнему президентскому многоборью', 'Чемпион универсиад РК', 'В «Нептуне» с 2017 г.'] },
        { name: 'Татьяна Рыбалко', role: 'Инструктор по детскому фитнесу', highlights: ['Призёр первенства РК по лёгкой атлетике', 'Опыт работы с 2016 г.'] },
        { name: 'Аида Орлова', role: 'Инструктор по детскому фитнесу', highlights: ['КМС по конькобежному спорту', 'Чемпионка РК по многоборью 2012', 'В «Нептуне» с 2018 г.'] },
      ],
    },
    {
      id: 'swim', title: 'Плавательный клуб', trainers: [
        { name: 'Павел Ихтендрис', role: 'Тренер плавательного клуба «Нептун-Shark»', highlights: ['МС РК, чемпион Казахстана по конькобежному спорту 2016', 'Тренер клуба с 2016 г.'] },
      ],
    },
  ],

  spa: {
    /** @type {HoursRange} */
    massageHours: [9, 22],
    booking: [
      { display: '33-64-41', tel: '+77152336441' },
      { display: '46-39-79', tel: '+77152463979' },
    ],
    massage: [
      { name: 'Общий', duration: '70 мин', price: 7000 },
      { name: 'Антицеллюлитный', duration: '40 мин', price: 5000 },
      { name: 'Спина', duration: '30–40 мин', price: 4000 },
      { name: 'Ноги', duration: '30 мин', price: 3700 },
      { name: 'Воротниковая зона', duration: '15–20 мин', price: 3000 },
      { name: 'Руки', duration: '15 мин', price: 2700 },
      { name: 'Живот', duration: '15 мин', price: 2700 },
      { name: 'Грудь', duration: '10 мин', price: 2500 },
      { name: 'Голова', duration: '10–15 мин', price: 2500 },
      { name: 'Лицо', duration: '20 мин', price: 2500 },
    ],
    solarium: {
      units: 4,
      cosmetics: 'SolBianca',
      /** Два прайса: стандартные солярии и горизонтальный солярий № 4. */
      groups: [
        {
          title: 'Солярии 1–3',
          perMinute: [{ name: 'Горизонтальный', price: 150 }, { name: 'Вертикальный', price: 120 }],
          certificates: [{ minutes: 50, price: 5000 }, { minutes: 100, price: 11000 }],
        },
        {
          title: 'Горизонтальный № 4',
          perMinute: [{ name: 'Горизонтальный', price: 150 }],
          certificates: [{ minutes: 50, price: 7000 }, { minutes: 100, price: 13000 }],
        },
      ],
    },
    pressotherapy: { single: 1100, course: { sessions: 10, price: 10000 }, minutes: 30 },
  },

  /**
   * Расписание занятий. Шаблон недели: 1 — понедельник … 7 — воскресенье (ISO-день).
   * Расписание примерное и уточняется на ресепшене; ёмкость слота — сколько человек
   * может записаться одновременно. Категория определяет, какой абонемент даёт доступ
   * (см. backend/src/schedule.js): fitness — все занятия фитнес-клуба, pool — 'pool' и 'aqua'.
   */
  schedule: [
    { id: 'swim-shark', title: 'Плавательный клуб «Нептун-Shark»', category: 'pool', room: 'Бассейн 25 м', capacity: 10, durationMin: 90,
      times: [{ day: 2, start: '07:00' }, { day: 4, start: '07:00' }, { day: 6, start: '10:00' }] },
    { id: 'swim-kids', title: 'Детская школа плавания', category: 'kids', room: 'Бассейн 25 м', capacity: 10, durationMin: 60,
      times: [{ day: 6, start: '11:00' }, { day: 7, start: '11:00' }] },
    { id: 'aqua-morning', title: 'Аквааэробика', category: 'aqua', room: 'Бассейн 25 м', capacity: 14, durationMin: 60,
      times: [{ day: 1, start: '08:30' }, { day: 3, start: '08:30' }, { day: 5, start: '08:30' }, { day: 2, start: '19:00' }, { day: 4, start: '19:00' }] },
    { id: 'gym-anytime', title: 'Тренажёрный зал (внедорожный час)', category: 'fitness', room: 'Фитнес, 4 этаж', capacity: 20, durationMin: 90,
      times: [{ day: 1, start: '09:00' }, { day: 2, start: '09:00' }, { day: 3, start: '09:00' }, { day: 4, start: '09:00' }, { day: 5, start: '09:00' }, { day: 6, start: '09:00' }, { day: 7, start: '09:00' }] },
    { id: 'crossfit', title: 'Кроссфит', category: 'fitness', room: 'Зал кроссфита', capacity: 10, durationMin: 60,
      times: [{ day: 1, start: '19:30' }, { day: 3, start: '19:30' }, { day: 5, start: '19:30' }, { day: 6, start: '10:00' }] },
    { id: 'combat-thai', title: 'Муай тай', category: 'combat', room: 'Зал единоборств', capacity: 12, durationMin: 90,
      times: [{ day: 1, start: '20:00' }, { day: 3, start: '20:00' }, { day: 5, start: '20:00' }] },
    { id: 'combat-grappling', title: 'Грэпплинг', category: 'combat', room: 'Зал единоборств', capacity: 10, durationMin: 90,
      times: [{ day: 2, start: '20:00' }, { day: 4, start: '20:00' }] },
    { id: 'group-jumping', title: 'Джампинг', category: 'group', room: 'Студия групповых программ', capacity: 10, durationMin: 45,
      times: [{ day: 2, start: '18:00' }, { day: 4, start: '18:00' }] },
    { id: 'group-yoga', title: 'Хатха-йога', category: 'group', room: 'Студия групповых программ', capacity: 12, durationMin: 60,
      times: [{ day: 1, start: '10:30' }, { day: 3, start: '10:30' }, { day: 6, start: '12:00' }] },
    { id: 'group-pilates', title: 'Пилатес', category: 'group', room: 'Студия групповых программ', capacity: 12, durationMin: 60,
      times: [{ day: 6, start: '13:00' }] },
    { id: 'group-hiphop', title: 'Хип-хоп', category: 'kids', room: 'Студия групповых программ', capacity: 12, durationMin: 60,
      times: [{ day: 6, start: '14:00' }, { day: 7, start: '12:00' }] },
    { id: 'kids-fitness', title: '«Нептунчики», детский фитнес', category: 'kids', room: 'Детский зал', capacity: 12, durationMin: 45,
      times: [{ day: 2, start: '17:00' }, { day: 4, start: '17:00' }, { day: 7, start: '13:00' }] },
  ],

  /** Горки. null — данных нет, в UI выводится «уточняется». */
  slides: [
    { id: 'boomerang', name: 'Бумеранг', color: 'orange', level: 'Средней сложности', startHeightM: 22, lengthM: 130, minHeightCm: 120, slopePct: 17,
      path: 'M10 10 C 60 10, 40 70, 100 70 S 180 10, 230 60' },
    { id: 'anaconda', name: 'Анаконда', color: 'green', level: 'Средней сложности', startHeightM: 22, lengthM: 155, minHeightCm: 120, slopePct: 14,
      path: 'M10 10 C 40 60, 80 10, 110 50 S 170 20, 190 60 S 220 70, 230 74' },
    { id: 'niagara', name: 'Ниагара', color: 'yellow', level: 'Повышенной сложности', startHeightM: 22, lengthM: 165, minHeightCm: 140, slopePct: 13,
      path: 'M10 8 L 70 74 C 90 80, 110 30, 150 40 S 200 74, 230 74' },
    { id: 'tornado', name: 'Торнадо', color: 'blue', level: 'Средней сложности', startHeightM: 22, lengthM: null, minHeightCm: null, slopePct: null,
      path: 'M10 10 C 30 70, 90 70, 90 40 S 50 10, 120 20 S 200 74, 230 70' },
  ],
};
