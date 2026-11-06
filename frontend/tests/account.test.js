import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ageOn, profileCompleteness, addMonths, cityDateString, formatPhone, isValidDate, membershipStatus, normalizePhone,
  validateProfile, validateRegistration,
} from '../assets/js/utils/account.js';

test('normalizePhone / formatPhone — казахстанские номера', () => {
  assert.equal(normalizePhone('8 (705) 123-45-67'), '+77051234567');
  assert.equal(normalizePhone('+7 705 1234567'), '+77051234567');
  assert.equal(normalizePhone('77051234567'), '+77051234567');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('+1 705 123 4567'), null);
  assert.equal(formatPhone('+77051234567'), '+7 705 123-45-67');
});

test('isValidDate — несуществующие даты отклоняются', () => {
  assert.ok(isValidDate('2024-02-29'));
  assert.equal(isValidDate('2026-02-29'), false);
  assert.equal(isValidDate('2026-13-01'), false);
  assert.equal(isValidDate('04.11.2026'), false);
});

test('addMonths — последний день действия включительно, конец месяца', () => {
  assert.equal(addMonths('2026-11-04', 2), '2027-01-03');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-27'); // до 28 фев не включительно → 27
  assert.equal(addMonths('2026-03-01', 12), '2027-02-28');
});

test('cityDateString — дата по UTC+5', () => {
  assert.equal(cityDateString(5, new Date('2026-11-04T20:30:00Z')), '2026-11-05');
  assert.equal(cityDateString(5, new Date('2026-11-04T18:59:00Z')), '2026-11-04');
});

test('validateRegistration', () => {
  const ok = validateRegistration({ email: ' A@B.kz ', password: '12345678', firstName: ' Әсел ', consent: true });
  assert.deepEqual(ok, { ok: true, value: { email: 'a@b.kz', password: '12345678', firstName: 'Әсел' } });
  const bad = validateRegistration({ email: 'a@b', password: 'short', firstName: '', consent: 'yes' });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['consent', 'email', 'firstName', 'password']);
  assert.ok(validateRegistration(null).errors);
});

test('validateProfile — частичное обновление, очистка, ошибки', () => {
  const today = '2026-11-04';
  assert.deepEqual(validateProfile({ phone: '' }, { today }).value, { phone: null });
  assert.deepEqual(validateProfile({ lastName: "O'Neil-Смит" }, { today }).value, { lastName: "O'Neil-Смит" });
  const bad = validateProfile({ firstName: ' ', birthDate: '2026-11-05', lang: 'en', phone: 42 }, { today });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['birthDate', 'firstName', 'lang', 'phone']);
  assert.ok(validateProfile({ lastName: '<script>' }, { today }).errors.lastName);
  assert.equal(validateProfile([], { today }).ok, false);
});

test('membershipStatus — все состояния', () => {
  const base = { startsAt: '2026-11-01', endsAt: '2026-12-31', visitsTotal: 12, visitsUsed: 3 };
  assert.equal(membershipStatus(null, '2026-11-04').code, 'none');
  assert.deepEqual(membershipStatus(base, '2026-11-04'), { code: 'active', label: 'Действует', visitsLeft: 9, daysLeft: 58 });
  assert.equal(membershipStatus(base, '2026-10-31').code, 'scheduled');
  assert.equal(membershipStatus(base, '2026-12-31').daysLeft, 1);
  assert.equal(membershipStatus(base, '2027-01-01').code, 'expired');
  assert.equal(membershipStatus({ ...base, visitsUsed: 12 }, '2026-11-04').code, 'used_up');
  const gold = membershipStatus({ ...base, visitsTotal: null, endsAt: null }, '2030-01-01');
  assert.deepEqual([gold.code, gold.visitsLeft, gold.daysLeft], ['active', null, null]);
});

test('ageOn — полных лет с учётом дня рождения', () => {
  assert.equal(ageOn('1995-03-08', '2026-03-07'), 30);
  assert.equal(ageOn('1995-03-08', '2026-03-08'), 31);
  assert.equal(ageOn(null, '2026-03-08'), null);
});

test('profileCompleteness — процент и недостающие поля', () => {
  assert.deepEqual(profileCompleteness({ firstName: 'Арман' }), { percent: 25, missing: ['Фамилия', 'Телефон', 'Дата рождения'] });
  assert.equal(profileCompleteness({ firstName: 'А', lastName: 'Б', phone: '+77000000000', birthDate: '2000-01-01' }).percent, 100);
});
