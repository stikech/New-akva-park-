/**
 * Точка входа. Только связывает данные, DOM и модули — логики здесь нет.
 */

import { getSiteData } from './services/api.js?v=3';
import { cityNow, dayType, weekdayIndex } from './utils/time.js';
import { createI18n } from './modules/i18n.js?v=3';
import { initOpenStatus } from './modules/status.js';
import { initWeather } from './modules/weather.js?v=2';
import { initSlides } from './modules/slides.js';
import { renderCatalogRows, renderParkPrices, renderPoolPrices } from './modules/prices.js?v=2';
import { initCalculator } from './modules/calculator.js?v=2';
import { bindAddButtons, createCartStore, initCartView } from './modules/cart.js';
import { initCartCheckout } from './modules/cart-checkout.js';
import { buildProducts } from './utils/cart.js';
import { initTabs } from './modules/tabs.js';
import { renderFitness } from './modules/fitness.js';
import { renderSchedulePreview } from './modules/schedule-preview.js';
import { initTeam } from './modules/team.js?v=2';
import { renderSpa } from './modules/spa.js';
import { renderHours } from './modules/hours.js';
import { initFeedback } from './modules/feedback.js?v=2';
import { initMobileNav } from './modules/nav.js';
import { initSectionRouting } from './modules/sections.js';
import { initAccountLink } from './modules/account-link.js';
import { initTheme } from './modules/theme.js';
import { initReveal } from './modules/reveal.js';

const $ = (selector) => document.querySelector(selector);

const MAIN_PHONE = '+7 7152 33-61-41';

async function bootstrap() {
  // Роутер секций — до запроса данных: по прямому адресу (/prices и т.п.)
  // прокрутка к секции не должна ждать ответа сервера.
  const router = initSectionRouting();

  const data = await getSiteData();
  const today = cityNow(data.tzOffsetHours);

  initMobileNav($('.burger'), $('#drawer'));
  initTheme([...document.querySelectorAll('[data-theme-toggle]')]);
  initReveal([...document.querySelectorAll('main > section, main > .wrap')]);

  const i18n = createI18n();
  initOpenStatus(
    { dot: $('#statusDot'), text: $('#statusText') },
    { schedule: data.hours.park, tzOffsetHours: data.tzOffsetHours },
    i18n,
  );

  initWeather($('#outsideTemp'), data.coords);

  initSlides({ list: $('#slideList'), heightInput: $('#h'), heightOutput: $('#hOut') }, data.slides);

  renderParkPrices({ rows: $('#parkRows'), note: $('#parkNote') }, data.prices.park);
  renderPoolPrices({ rows: $('#poolRows'), saving: $('#poolSaving') }, data.prices.pool);
  // Единая вкладка «Цены и покупка»: прайс всех сфер, калькулятор и корзина.
  const products = buildProducts(data);
  const cart = createCartStore(products);
  renderCatalogRows($('#fitnessRows'), products.filter((p) => p.category === 'fitness'));
  renderCatalogRows($('#spaRows'), products.filter((p) => p.category === 'spa'));
  initTabs($('#priceTabs'), { sync: true });
  const calculator = initCalculator({ root: $('#calculator'), tablist: $('#priceTabs') }, cart, dayType(today));
  bindAddButtons($('#prices'), cart, (id) => calculator.notifyAdded(id));
  const checkout = initCartCheckout({ modal: $('#cartModal'), cart });
  initCartView(
    { root: $('#cart'), badges: [...document.querySelectorAll('[data-cart-badge]')], links: [...document.querySelectorAll('[data-cart-link]')] },
    cart,
    { onCheckout: (source) => checkout.open(source) },
  );

  renderFitness(
    { cards: $('#clubCards'), directions: $('#fitnessDirections'), hours: $('#fitnessHours'), socials: $('#fitnessSocials') },
    data.fitness,
  );
  renderSchedulePreview($('#classesPreview'), data.schedule);
  initTeam({ tablist: $('#teamTabs'), panels: $('#teamPanels') }, data.team);

  renderSpa({
    massage: $('#massageList'),
    massageHours: $('#massageHours'),
    booking: $('#spaBooking'),
    solarium: $('#solariumGroups'),
    solariumNote: $('#solariumNote'),
    press: $('#pressList'),
    pressCard: $('#pressPrice'),
  }, data.spa);

  renderHours($('#hoursRows'), data.hours.park, weekdayIndex(today));
  initFeedback($('#feedbackForm'), { fallbackPhone: MAIN_PHONE });
  initAccountLink([...document.querySelectorAll('[data-account-link]')], i18n);

  i18n.init();

  // Данные отрисованы, размеры секций устоялись — доскролл до адреса страницы.
  router.reapply();
}

bootstrap().catch((error) => {
  // Не роняем страницу: статическая разметка остаётся видимой.
  console.error('[neptun] init failed:', error);
});
