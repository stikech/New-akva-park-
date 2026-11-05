/**
 * Точка входа. Только связывает данные, DOM и модули — логики здесь нет.
 */

import { getSiteData } from './services/api.js?v=2';
import { cityNow, dayType, weekdayIndex } from './utils/time.js';
import { createI18n } from './modules/i18n.js?v=2';
import { initOpenStatus } from './modules/status.js';
import { initWeather } from './modules/weather.js?v=2';
import { initSlides } from './modules/slides.js';
import { renderParkPrices, renderPoolPrices } from './modules/prices.js';
import { initCalculator } from './modules/calculator.js';
import { initVisitCheckout } from './modules/visit-checkout.js';
import { initTabs } from './modules/tabs.js';
import { renderFitness } from './modules/fitness.js';
import { renderSchedulePreview } from './modules/schedule-preview.js';
import { initTeam } from './modules/team.js?v=2';
import { renderSpa } from './modules/spa.js';
import { renderHours } from './modules/hours.js';
import { initFeedback } from './modules/feedback.js?v=2';
import { initMobileNav } from './modules/nav.js';
import { initAccountLink } from './modules/account-link.js';
import { initTheme } from './modules/theme.js';
import { initReveal } from './modules/reveal.js';

const $ = (selector) => document.querySelector(selector);

const MAIN_PHONE = '+7 7152 33-61-41';

async function bootstrap() {
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
  initCalculator($('#calculator'), data.prices.park, dayType(today));
  initVisitCheckout({ modal: $('#visitModal'), park: data.prices.park });
  initTabs($('#priceTabs'), { sync: true });

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
}

bootstrap().catch((error) => {
  // Не роняем страницу: статическая разметка остаётся видимой.
  console.error('[neptun] init failed:', error);
});
