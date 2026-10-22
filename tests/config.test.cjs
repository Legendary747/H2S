'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const core = require('../h2s-monitor.user.js');
const example = JSON.parse(fs.readFileSync(__dirname + '/../config.example.json', 'utf8'));

test('the example is importable, defaults preserve behavior, and legacy budgets migrate without credentials', () => {
  assert.deepEqual(core.parseConfig(JSON.stringify(example)), example);
  assert.deepEqual(core.loadConfig(null, null), example);
  assert.equal(core.loadConfig(null, '1250,50').maxRent, 1250.5);
  assert.equal(core.loadConfig(null, 'invalid').maxRent, 1000);
  assert.equal(core.loadConfig({...example, maxRent: 850}, 1250).maxRent, 850);
  assert.equal(example.cities.length, 5);
  assert.equal(example.activeHours.start, '07:00');
  assert.equal(example.activeHours.end, '23:00');
  assert.deepEqual(example.refreshMinutes, [5, 10]);
  assert.deepEqual(Object.keys(example).sort(), ['activeHours','cities','maxRent','refreshMinutes','schemaVersion']);
});

test('configuration rejects malformed, ambiguous, misspelled and secret-bearing inputs', () => {
  for (const makeInvalid of [
    value => { value.schemaVersion = 2; },
    value => { value.token = 'not-a-real-token'; },
    value => { value.chatId = '123'; },
    value => { delete value.maxRent; },
    value => { value.maxRent = '1000'; },
    value => { value.maxRent = NaN; },
    value => { value.maxRent = 0; },
    value => { value.maxRent = 1000.001; },
    value => { value.cities = []; },
    value => { value.cities = ['The Hague']; },
    value => { value.cities[0].id = 90; },
    value => { value.cities[0].id = '0'; },
    value => { value.cities[0].name = '<script>alert(1)</script>'; },
    value => { value.cities[0].name = 'The Hague,90'; },
    value => { value.cities[0].name = ' The Hague'; },
    value => { value.cities[0].unexpected = true; },
    value => { value.cities.push({name: 'Den Haag', id: '999'}); },
    value => { value.cities.push({name: 'Exampleville', id: '90'}); },
    value => { value.activeHours.start = '24:00'; },
    value => { value.activeHours.start = '7:00'; },
    value => { value.activeHours.end = value.activeHours.start; },
    value => { value.activeHours.timeZone = 'Not/A_Timezone'; },
    value => { value.activeHours.extra = true; },
    value => { value.refreshMinutes = [0, 10]; },
    value => { value.refreshMinutes = [10, 5]; },
    value => { value.refreshMinutes = [5, 1441]; },
    value => { value.refreshMinutes = [5, Infinity]; },
    value => { value.refreshMinutes = ['5', 10]; },
    value => { value.refreshMinutes = [5]; }
  ]) {
    const value = structuredClone(example);
    makeInvalid(value);
    assert.throws(() => core.validateConfig(value));
  }
  for (const raw of ['not JSON', '{}', 'null', '[]', ' '.repeat(50001)]) assert.throws(() => core.parseConfig(raw));
});

test('minute-precision overnight hours use the configured timezone with inclusive start and exclusive end', () => {
  const hours = {start: '22:30', end: '07:15', timeZone: 'Europe/Amsterdam'};
  for (const [date, expected] of [
    ['2026-07-01T20:29:59Z', false], ['2026-07-01T20:30:00Z', true],
    ['2026-07-02T05:14:59Z', true], ['2026-07-02T05:15:00Z', false],
    ['2026-01-01T20:30:00Z', false], ['2026-01-01T21:30:00Z', true],
    ['2026-01-02T06:14:59Z', true], ['2026-01-02T06:15:00Z', false]
  ]) assert.equal(core.withinHours(new Date(date), hours), expected, date);
  const utc = {start: '09:15', end: '10:45', timeZone: 'UTC'};
  assert.equal(core.withinHours(new Date('2026-07-01T09:14:59Z'), utc), false);
  assert.equal(core.withinHours(new Date('2026-07-01T09:15:00Z'), utc), true);
  assert.equal(core.withinHours(new Date('2026-07-01T10:45:00Z'), utc), false);
});
