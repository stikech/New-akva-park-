/**
 * Точка входа всех страниц сайта (главная и разделы /slides, /prices…).
 * Только связывает данные, DOM и модули — логики здесь нет. На каждой странице
 * своя часть разметки, поэтому модуль запускается, только если его блок есть.
 */

import { getSiteData } from './services/api.js?v=4';
import { cityNow, dayType, weekdayIndex } from './utils/time.js';
import { createI18n } from './modules/i18n.js?v=4';
import { initOpenStatus } from './modules/status.js';
import { initWeather } from './modules/weather.js?v=2';
import { initSlides } from './modules/slides.js';
import { renderParkPrices, renderPoolPrices } from './modules/prices.js?v=2';
import { initCalculator } from './modules/calculator.js?v=2';
import { renderAllPrices } from './modules/all-prices.js?v=1';
import { initTabs } from './modules/tabs.js';
import { renderFitness } from './modules/fitness.js?v=2';
import { renderSchedulePreview } from './modules/schedule-preview.js';
import { initTeam } from './modules/team.js?v=2';
import { renderSpa } from './modules/spa.js?v=2';
import { renderHours } from './modules/hours.js';
import { initFeedback } from './modules/feedback.js?v=3';
import { initMobileNav } from './modules/nav.js';
import { markCurrentSection } from './modules/sections.js?v=2';
import { initAccountLink } from './modules/account-link.js?v=2';
import { initTheme } from './modules/theme.js';
import { initReveal } from './modules/reveal.js';
import { initTicketPage } from './modules/ticket-page.js';
import { initShopPage } from './modules/shop-page.js?v=2';
import { initOfferPage } from './modules/offer-page.js';
import { initCartUi } from './modules/cart-ui.js?v=1';
import { initCheckoutPage } from './modules/checkout-page.js?v=1';
import { initClassesPage } from './modules/classes-page.js?v=1';

const $ = (selector) => document.querySelector(selector);

const MAIN_PHONE = '+7 7152 33-61-41';

/** Запускает init, если на странице есть его корневой элемент. */
const on = (selector, init) => {
  const el = $(selector);
  if (el) init(el);
};

async function bootstrap() {
  markCurrentSection();
  initMobileNav($('.burger'), $('#drawer'));
  initTheme([...document.querySelectorAll('[data-theme-toggle]')]);
  initCartUi();
  on('#checkoutRoot', initCheckoutPage);
  on('#classesBooking', (root) => initClassesPage(root, $('#classModal')));
  on('#ticketRoot', initTicketPage);
  on('#shopRoot', (root) => initShopPage({ root, tabs: $('#shopTabs') }));
  on('#offerLegal', initOfferPage);

  const data = await getSiteData();
  const today = cityNow(data.tzOffsetHours);

  initReveal([...document.querySelectorAll('main > section, main > .wrap')]);

  const i18n = createI18n();
  on('#statusDot', (dot) => initOpenStatus(
    { dot, text: $('#statusText') },
    { schedule: data.hours.park, tzOffsetHours: data.tzOffsetHours },
    i18n,
  ));
  on('#outsideTemp', (el) => initWeather(el, data.coords));

  on('#slideList', (list) => initSlides({ list, heightInput: $('#h'), heightOutput: $('#hOut') }, data.slides));

  on('#parkRows', (rows) => renderParkPrices({ rows, note: $('#parkNote') }, data.prices.park));
  // /prices: единый прайс всех сфер с «+»; примечания к тарифам — те же, что у таблиц аквапарка и бассейна
  on('#allPrices', (el) => {
    renderAllPrices(el, data);
    $('#parkNote').textContent = data.prices.park.note;
    renderPoolPrices({ rows: document.createElement('tbody'), saving: $('#poolSaving') }, data.prices.pool);
  });
  on('#poolRows', (rows) => renderPoolPrices({ rows, saving: $('#poolSaving') }, data.prices.pool));
  on('#calculator', (el) => initCalculator(el, data.prices.park, dayType(today)));
  on('#priceTabs', (el) => initTabs(el, { sync: true }));

  on('#clubCards', (cards) => renderFitness(
    { cards, directions: $('#fitnessDirections'), hours: $('#fitnessHours'), socials: $('#fitnessSocials') },
    data.fitness,
  ));
  on('#classesPreview', (el) => renderSchedulePreview(el, data.schedule));
  on('#teamTabs', (tablist) => initTeam({ tablist, panels: $('#teamPanels') }, data.team));

  on('#massageList', (massage) => renderSpa({
    massage,
    massageHours: $('#massageHours'),
    booking: $('#spaBooking'),
    solarium: $('#solariumGroups'),
    solariumNote: $('#solariumNote'),
    press: $('#pressList'),
    pressCard: $('#pressPrice'),
  }, data.spa));

  on('#hoursRows', (el) => renderHours(el, data.hours.park, weekdayIndex(today)));
  on('#feedbackForm', (form) => initFeedback(form, { fallbackPhone: MAIN_PHONE }));
  initAccountLink([...document.querySelectorAll('[data-account-link]')], i18n);

  i18n.init();
}

bootstrap().catch((error) => {
  // Не роняем страницу: статическая разметка остаётся видимой.
  console.error('[neptun] init failed:', error);
});
