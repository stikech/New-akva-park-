import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionFromPath } from '../assets/js/modules/sections.js';

test('sectionFromPath: слаг секции — имя секции, оба варианта слэша', () => {
  for (const slug of ['slides', 'prices', 'rules', 'fitness', 'classes', 'spa', 'pool', 'contacts']) {
    assert.equal(sectionFromPath(`/${slug}`), slug, slug);
    assert.equal(sectionFromPath(`/${slug}/`), slug, slug);
  }
});

test('sectionFromPath: главная и чужие пути — null', () => {
  assert.equal(sectionFromPath('/'), null);
  assert.equal(sectionFromPath('/account'), null);
  assert.equal(sectionFromPath('/account/shop'), null);
  assert.equal(sectionFromPath('/nosuchsection'), null);
  assert.equal(sectionFromPath('/prices/nope'), null);
  assert.equal(sectionFromPath('/images/bg.svg'), null);
});
