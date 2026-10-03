'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {parseHTML} = require('linkedom');
const core = require('../h2s-monitor.user.js');
const fixture = fs.readFileSync(__dirname + '/fixtures/residences.html', 'utf8');
const source = fs.readFileSync(__dirname + '/../h2s-monitor.user.js', 'utf8');
const documentOf = () => parseHTML(fixture).document;
const sample = (overrides = {}) => ({url: 'https://www.holland2stay.com/residences/example.html', title: 'Example 1, The Hague', city: 'The Hague', rent: 900, status: 'Book directly', ...overrides});
const update = (state, rows, time = 100) => core.reconcile(state, rows, 'scope', 'Den Haag', 1000, time).state;

test('actual uploaded page: 10 main rents, 109 total, 11 pages; service costs are excluded', () => {
  const page = core.parsePage(documentOf());
  assert.equal(page.total, 109);
  assert.equal(page.page.current, 1);
  assert.equal(page.page.last, 11);
  assert.ok(page.page.next);
  assert.deepEqual(page.listings.map(item => item.rent), [2200,1845,1580,1488,2400,1995,1778,1556,1650,1560]);
  assert.equal(page.listings[6].city, 'The Hague');
  assert.equal(page.listings.filter(item => core.cityKey(item.city) === 'den haag' && item.rent <= 1000).length, 0);
});
test('money handles both display conventions and refuses ambiguous or invalid data', () => {
  for (const [input, expected] of [['1,778.00',1778],['1.778,00',1778],['999,50',999.5],['1 000.00',1000],['1.000',1000]]) assert.equal(core.money(input),expected);
  assert.equal(core.money('unknown'), null);
  assert.equal(core.money('9,12,00'), null);
  assert.throws(() => core.rentFromText('servicekosten amount to €67.50 per month.'));
  assert.throws(() => core.rentFromText('€900 per month excl.* €950 per month excl.*'));
});
test('URL normalization removes tracking, rejects unrelated or booking URLs', () => {
  assert.equal(core.normalizeUrl('/residences/example.html?utm_source=x#details'), sample().url);
  assert.equal(core.normalizeUrl('https://elsewhere.example/residences/example.html'),null);
  assert.equal(core.normalizeUrl('/residences'),null);
  assert.equal(core.normalizeUrl('javascript:alert(1)'),null);
});
test('unselected, unknown and multi-city filters cannot silently monitor the wrong city', () => {
  const doc = documentOf();
  assert.equal(core.citySelection(doc, 'Den Haag').ok,false);
  const section = doc.querySelector('[aria-label="Filter products by City"]');
  section.insertAdjacentHTML('beforeend','<label>The Hague<input type="checkbox" title="The Hague"></label><label>Rijswijk<input type="checkbox" title="Rijswijk"></label>');
  const [hague, other] = section.querySelectorAll('input');
  hague.checked = true;
  assert.equal(core.citySelection(doc,'Den Haag').ok,true);
  other.checked = true;
  assert.equal(core.citySelection(doc,'Den Haag').ok,false);
});
test('partial, duplicate, wrong-city, loading and malformed pages cannot form a baseline', () => {
  const page = core.parsePage(documentOf());
  assert.throws(() => core.validateSweep(page.listings,109,'Den Haag'));
  assert.throws(() => core.validateSweep([sample(), sample()],2,'Den Haag'));
  assert.throws(() => core.validateSweep([sample({city:'Rijswijk'})],1,'Den Haag'));
  const doc = documentOf();
  doc.querySelector('.residence_MainSection').innerHTML = '';
  assert.throws(() => core.parsePage(doc));
  doc.querySelector('.total_residence .count').textContent = '0';
  assert.equal(core.parsePage(doc).listings.length,0);
  const malformed = documentOf();
  malformed.querySelector('.price_text').remove();
  assert.throws(() => core.parsePage(malformed));
});
test('normal Cloudflare widgets are ignored; real challenge headings are detected', () => {
  const doc = documentOf();
  doc.body.insertAdjacentHTML('beforeend','<div class="cf-turnstile">Cloudflare</div>');
  assert.equal(core.challenge(doc),false);
  doc.title = 'Just a moment...';
  assert.equal(core.challenge(doc),true);
});
test('first scan suppresses existing listings; later newly eligible listings create notifications', () => {
  const item = sample();
  let state = update(null,[item]);
  assert.equal(state.items[item.url].pending,null);
  state = update(state,[item,sample({url:item.url.replace('example','new')})]);
  assert.equal(Object.values(state.items).filter(x => x.pending).length,1);
  state = update(null,[sample({rent:1100})]);
  state = update(state,[item]);
  assert.equal(state.items[item.url].pending.reason,'降价进入预算');
  state = update(null,[sample({status:'Available in lottery'})]);
  state = update(state,[item]);
  assert.equal(state.items[item.url].pending.reason,'变为可直接预订');
});
test('two complete missing sweeps trigger reappearance, one transient disappearance does not', () => {
  const item = sample();
  let state = update(null,[item]);
  state = update(state,[]);
  state = update(state,[item]);
  assert.equal(state.items[item.url].pending,null);
  state = update(update(state,[]),[]);
  state = update(state,[item]);
  assert.equal(state.items[item.url].pending.reason,'重新出现，可直接预订');
});
test('notification failures stay pending across scans and storage round trips', async () => {
  const item = sample();
  let state = update(update(null,[]),[item]);
  await assert.rejects(core.deliverPending(state,async () => {throw Error('network failure');},() => {}));
  assert.ok(state.items[item.url].pending);
  state = update(JSON.parse(JSON.stringify(state)),[item]);
  let sends = 0;
  await core.deliverPending(state,async () => {sends++;},() => {},() => true,() => 200);
  assert.equal(sends,1);
  assert.equal(state.items[item.url].lastNotified,200);
  assert.equal(state.items[item.url].pending,null);
  await core.deliverPending(state,async () => {sends++;},() => {});
  assert.equal(sends,1);
});
test('scope change resets baseline; pause guard prevents sending', async () => {
  const item = sample();
  let state = update(update(null,[]),[item]);
  let sends = 0;
  await core.deliverPending(state,async () => {sends++;},() => {},() => false);
  assert.equal(sends,0);
  assert.ok(state.items[item.url].pending);
  state = core.reconcile(state,[item],'changed filters','Den Haag',1000,200).state;
  assert.equal(state.items[item.url].pending,null);
});
test('Amsterdam time windows respect winter/summer time and 23:00 cutoff', () => {
  assert.equal(core.withinHours(new Date('2026-07-01T05:00:00Z')),true);
  assert.equal(core.withinHours(new Date('2026-01-01T05:00:00Z')),false);
  assert.equal(core.withinHours(new Date('2026-01-01T06:00:00Z')),true);
  assert.equal(core.withinHours(new Date('2026-10-03T21:00:00Z')),false);
});

// Offline runtime harness: real DOM events/selectors, virtual clock and mocked GM APIs.
// No network requests or page scripts from the uploaded HTML are executed.
function harness({brokenSecondPage = false, blocked = false} = {}) {
  const {document,window} = parseHTML(fixture);
  const card = document.querySelectorAll('.residence_block')[6].cloneNode(true);
  card.querySelector('.price_text').innerHTML = '€900.00<span class="excl">per month excl.*</span>';
  const second = card.cloneNode(true);
  second.querySelector('.residence_name').textContent = 'Example 2, The Hague';
  second.querySelector('a[href]').href = 'https://www.holland2stay.com/residences/example-2.html';
  const list = document.querySelector('.residence_MainSection');
  const pager = document.querySelector('.residence_pagination');
  document.querySelector('.total_residence .count').textContent = '2';
  const city = document.querySelector('[aria-label="Filter products by City"]');
  city.insertAdjacentHTML('beforeend','<input title="The Hague" type="checkbox">');
  city.querySelector('input').checked = true;
  const visited = [];
  function showPage(number) {
    visited.push(number);
    list.querySelectorAll('.residence_block').forEach(node => node.remove());
    list.insertAdjacentHTML('afterbegin', number === 1 ? card.outerHTML : brokenSecondPage ? '' : second.outerHTML);
    pager.innerHTML = number === 1
      ? '<li><a aria-current="page">1</a></li><li><a aria-label="Page 2">2</a></li><li><a aria-label="Next page" aria-disabled="false">Next</a></li>'
      : '<li><a aria-label="Page 1">1</a></li><li><a aria-current="page">2</a></li><li><a aria-label="Next page" aria-disabled="true">Next</a></li>';
    pager.querySelector('[aria-label="Next page"]').addEventListener('click',() => showPage(2));
    pager.querySelector('[aria-label="Page 1"]')?.addEventListener('click',() => showPage(1));
  }
  showPage(1);
  if (blocked) document.title = 'Just a moment...';
  const storage = new Map();
  const menus = new Map();
  const intervals = [];
  let clock = Date.parse('2026-10-03T10:00:00Z');
  let networkCalls = 0;
  const prefix = 'h2s_single_city_den_haag:';
  class Clock extends Date { constructor(...args) {super(...(args.length ? args : [clock]));} static now() {return clock;} }
  const sandbox = {document,window,Date:Clock,Intl,URL,console,crypto:require('node:crypto').webcrypto,
    location:{pathname:'/residences',origin:'https://www.holland2stay.com',reload() {}},
    navigator:{locks:{request:async (name,fn) => fn()}},
    setTimeout(fn,ms) {queueMicrotask(() => {clock += ms;fn();});return 1;},clearTimeout() {},
    setInterval(fn) {intervals.push(fn);return 1;},clearInterval() {},
    MutationObserver:class {observe() {} disconnect() {}},
    prompt:() => null,confirm:() => true,alert() {},
    GM_getValue:(key,fallback) => storage.has(key) ? structuredClone(storage.get(key)) : fallback,
    GM_setValue:(key,value) => storage.set(key,structuredClone(value)),
    GM_registerMenuCommand:(label,fn) => menus.set(label,fn),
    GM_xmlhttpRequest() {networkCalls++;throw Error('Unexpected real notification');}};
  vm.runInNewContext(source,sandbox,{filename:'h2s-monitor.user.js'});
  return {document,storage,menus,intervals,visited,prefix,get networkCalls(){return networkCalls;}};
}
async function drain() {for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve));}
test('full userscript runtime traverses the actual pagination controls and stores a complete baseline', async () => {
  const app = harness();
  await drain();
  const state = app.storage.get(app.prefix + 'state');
  assert.ok(state?.initialized, app.document.querySelector('#h2s-monitor-panel').textContent + '\nVisited: ' + app.visited + '\nPage: ' + core.pagination(app.document).current);
  assert.equal(Object.keys(state.items).length,2);
  assert.deepEqual(app.visited,[1,2]);
  assert.equal(app.networkCalls,0);
  assert.match(app.document.querySelector('#h2s-monitor-panel').textContent,/已建立完整基线/);
  const check = [...app.menus.entries()].find(([name]) => name.startsWith('立即检查'))[1];
  check();await drain();
  assert.deepEqual(app.visited,[1,2,1,2]);
});
test('full runtime rejects a page that never finishes rendering without creating an empty baseline', async () => {
  const app = harness({brokenSecondPage:true});
  await drain();
  assert.equal(app.storage.has(app.prefix + 'state'),false);
  assert.equal(app.networkCalls,0);
  assert.match(app.document.querySelector('#h2s-monitor-panel').textContent,/未完成/);
});
test('full runtime pauses on a challenge and does not navigate or touch listing history', async () => {
  const app = harness({blocked:true});
  await drain();
  assert.deepEqual(app.visited,[1]);
  assert.equal(app.storage.has(app.prefix + 'state'),false);
  assert.ok(app.storage.get(app.prefix + 'incident'));
  assert.equal(app.networkCalls,0);
});
