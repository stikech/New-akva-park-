import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SITE_DATA } from '../assets/js/config/site-data.js';
import { calcParkTotal } from '../assets/js/utils/pricing.js';
import {
  CART_MAX_LINES, CART_MAX_QTY, addToCart, buildProducts, clampQty, normalizeCart, parkLines,
  priceCart, productIndex, removeLine, setQty,
} from '../assets/js/utils/cart.js';

const products = buildProducts(SITE_DATA);
const index = productIndex(products);

test('buildProducts: каталог охватывает все сферы, id уникальны, цены положительные', () => {
  const categories = new Set(products.map((p) => p.category));
  assert.deepEqual([...categories].sort(), ['fitness', 'park', 'pool', 'spa']);
  assert.equal(index.size, products.length, 'id не повторяются');
  for (const p of products) assert.ok(Number.isInteger(p.price) && p.price > 0, p.id);
});

test('buildProducts: цены берутся из прайса сайта', () => {
  assert.equal(index.get('park:adult:weekend:unl').price, SITE_DATA.prices.park.adult.weekend.unl);
  assert.equal(index.get('pool:child:3').price, SITE_DATA.prices.pool[1].prices[3]);
  assert.equal(index.get('gold:12').price, 110000);
  assert.equal(index.get('massage:0').price, SITE_DATA.spa.massage[0].price);
  assert.equal(index.get('solarium:1:cert:100').price, 13000);
  assert.equal(index.get('press:course').price, SITE_DATA.spa.pressotherapy.course.price);
  assert.equal(index.get('solarium:0:min:0').unit, 'min');
});

test('addToCart: повторное добавление увеличивает количество, а не дублирует строку', () => {
  let cart = addToCart([], 'massage:0', 1);
  cart = addToCart(cart, 'massage:0', 2);
  cart = addToCart(cart, 'press:single');
  assert.deepEqual(cart, [{ id: 'massage:0', qty: 3 }, { id: 'press:single', qty: 1 }]);
});

test('setQty: плюс/минус и удаление при нуле', () => {
  const cart = [{ id: 'massage:0', qty: 1 }];
  assert.deepEqual(setQty(cart, 'massage:0', 2), [{ id: 'massage:0', qty: 2 }]);
  assert.deepEqual(setQty(cart, 'massage:0', 0), []);
  assert.deepEqual(setQty(cart, 'massage:0', 999), [{ id: 'massage:0', qty: CART_MAX_QTY }]);
  assert.deepEqual(removeLine(cart, 'massage:0'), []);
});

test('normalizeCart: мусор из localStorage отбрасывается, дубликаты склеиваются', () => {
  const raw = [
    { id: 'massage:0', qty: 2 },
    { id: 'massage:0', qty: '3' },
    { id: 'nope', qty: 1 },
    { id: 'press:single', qty: -1 },
    { id: 'gold:1', qty: 1.9 },
    null,
    { qty: 4 },
  ];
  assert.deepEqual(normalizeCart(raw, index), [{ id: 'massage:0', qty: 5 }, { id: 'gold:1', qty: 1 }]);
  assert.deepEqual(normalizeCart('[]', index), []);
  assert.deepEqual(normalizeCart(undefined, index), []);
});

test('normalizeCart: не больше CART_MAX_LINES строк', () => {
  const raw = products.map((p) => ({ id: p.id, qty: 1 }));
  assert.ok(raw.length > CART_MAX_LINES);
  assert.equal(normalizeCart(raw, index).length, CART_MAX_LINES);
});

test('priceCart: сумма по каталогу, цена из строки не учитывается', () => {
  const { lines, total, count } = priceCart(
    [{ id: 'massage:0', qty: 2, price: 1 }, { id: 'solarium:0:min:0', qty: 10 }],
    index,
  );
  assert.equal(total, 2 * SITE_DATA.spa.massage[0].price + 10 * 150);
  assert.equal(lines[0].sum, 2 * SITE_DATA.spa.massage[0].price);
  assert.equal(count, 3, 'минуты солярия считаются одной услугой');
});

test('parkLines: калькулятор аквапарка даёт ту же сумму, что и calcParkTotal', () => {
  const visit = { adult: 2, child: 1, day: 'weekend', duration: 'h2' };
  const { total } = priceCart(parkLines(visit), index);
  assert.equal(total, calcParkTotal(SITE_DATA.prices.park, visit));
  assert.deepEqual(parkLines({ adult: 0, child: 2, day: 'weekday', duration: 'unl' }), [{ id: 'park:child:weekday:unl', qty: 2 }]);
});

test('clampQty', () => {
  assert.equal(clampQty('7'), 7);
  assert.equal(clampQty(0), 0);
  assert.equal(clampQty(Number.NaN), 0);
  assert.equal(clampQty(1e9), CART_MAX_QTY);
});
