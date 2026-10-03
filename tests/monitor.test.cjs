'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {parseHTML} = require('linkedom');
const core = require('../h2s-monitor.user.js');
const fixture = fs.readFileSync(__dirname + '/fixtures/residences.html', 'utf8');
const source = fs.readFileSync(__dirname + '/../h2s-monitor.user.js', 'utf8');
const targets = ['The Hague','Rijswijk','Rotterdam','Leiden','Zoetermeer'];
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
test('all-city monitoring does not depend on City options, and detects any applied filters', () => {
  const doc = documentOf();
  assert.equal(core.filterState(doc).ok,true);
  const section = doc.querySelector('[aria-label="Filter products by City"]');
  section.innerHTML = '<label>Rijswijk (4)<input type="checkbox" title="Rijswijk"></label>';
  assert.equal(core.filterState(doc).ok,true); // The Hague does not even exist as an option.
  section.querySelector('input').checked = true;
  assert.equal(core.filterState(doc).ok,false);
  section.remove();
  assert.equal(core.filterState(doc).ok,true);
  const selected = doc.querySelector('[aria-label="Current Filters"]');
  selected.innerHTML = '<li>Rent p/month: €0–€900</li>';
  assert.equal(core.filterState(doc).ok,false);
  selected.remove();
  assert.equal(core.filterState(doc).unknown,true);
});
test('partial, duplicate, loading and malformed pages cannot form a baseline; mixed cities are valid', () => {
  const page = core.parsePage(documentOf());
  assert.throws(() => core.validateSweep(page.listings,109,'Den Haag'));
  assert.throws(() => core.validateSweep([sample(), sample()],2,'Den Haag'));
  assert.doesNotThrow(() => core.validateSweep([sample({city:'Amsterdam'})],1));
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
test('first scan queues matches; successful notifications stay deduplicated across scans, reloads and days', async () => {
  const item = sample();
  let state = update(null,[item]);
  assert.equal(state.items[item.url].pending.reason,'首次发现符合条件');
  let sends = 0;
  await core.deliverPending(state,async () => {sends++;},() => {},() => true,() => 200);
  state = update(JSON.parse(JSON.stringify(state)),[item],86400100);
  assert.equal(state.items[item.url].pending,null);
  await core.deliverPending(state,async () => {sends++;},() => {});
  assert.equal(sends,1);
  state = update(state,[item,sample({url:item.url.replace('example','new')})]);
  assert.equal(Object.values(state.items).filter(x => x.pending).length,1);
  state = update(null,[sample({rent:1100})]);
  state = update(state,[item]);
  assert.equal(state.items[item.url].pending.reason,'降价进入预算');
  state = update(null,[sample({status:'Available in lottery'})]);
  state = update(state,[item]);
  assert.equal(state.items[item.url].pending.reason,'变为可直接预订');
});
test('upgrade sends never-notified old baseline matches without repeating prior successful deliveries', async () => {
  const neverSent = sample();
  const delivered = sample({url:sample().url.replace('example','delivered')});
  const previous = {version:1,scope:'scope',initialized:true,sent:1,items:{
    [neverSent.url]:{...neverSent,eligible:true,missing:0,lastSeen:10,pending:null},
    [delivered.url]:{...delivered,eligible:true,missing:0,lastSeen:10,pending:null,lastNotified:20}
  }};
  let state = update(previous,[neverSent,delivered]);
  assert.equal(state.items[neverSent.url].pending.reason,'首次通知');
  assert.equal(state.items[delivered.url].pending,null);
  const sent = [];
  await core.deliverPending(state,async item => {sent.push(item.url);},() => {});
  assert.deepEqual(sent,[neverSent.url]);
  state = update(JSON.parse(JSON.stringify(state)),[neverSent,delivered]);
  assert.ok(Object.values(state.items).every(item => !item.pending));
});
test('explicit silent baseline remains silent later but still notifies new listings and price drops', () => {
  const item = sample();
  let state = core.reconcile(null,[item],'scope','Den Haag',1000,100,{silentBaseline:true}).state;
  assert.equal(state.items[item.url].pending,null);
  assert.equal(state.items[item.url].lastNotified,undefined);
  state = update(JSON.parse(JSON.stringify(state)),[item]);
  assert.equal(state.items[item.url].pending,null);
  state = update(state,[sample({rent:850}),sample({url:item.url.replace('example','new')})]);
  assert.equal(state.items[item.url].pending.reason,'主租金下降');
  assert.equal(Object.values(state.items).filter(item => item.pending).length,2);
});
test('notifications include exactly the five cities, recognize Den Haag, and preserve budget/status filters', () => {
  const rows = [...targets,'Den Haag','Amsterdam'].map((city,i) => sample({city,title:'Example, '+city,url:sample().url.replace('example','city-'+i)}));
  rows.push(sample({city:'Leiden',rent:1001,url:sample().url.replace('example','over-budget')}));
  rows.push(sample({city:'Rotterdam',status:'Available in lottery',url:sample().url.replace('example','lottery')}));
  const baseline = core.reconcile(null,[],'multi','The Hague',1000,10).state;
  const state = core.reconcile(baseline,rows,'multi',targets,1000,20).state;
  assert.equal(Object.values(state.items).filter(x => x.pending).length,6);
  assert.equal(Object.values(state.items).find(x => x.city==='Amsterdam').eligible,false);
  assert.equal(Object.values(state.items).find(x => x.rent===1001).pending,null);
  assert.equal(Object.values(state.items).find(x => x.status==='Available in lottery').pending,null);
});
test('two complete missing sweeps trigger reappearance, one transient disappearance does not', async () => {
  const item = sample();
  let state = update(null,[item]);
  await core.deliverPending(state,async () => {},() => {});
  state = update(state,[]);
  state = update(state,[item]);
  assert.equal(state.items[item.url].pending,null);
  state = update(update(state,[]),[]);
  state = update(state,[item]);
  assert.equal(state.items[item.url].pending.reason,'重新出现，可直接预订');
});
test('notification failures stay pending across scans and storage round trips', async () => {
  const item = sample();
  let state = update(null,[item]);
  const detectedAt = state.items[item.url].pending.detectedAt;
  await assert.rejects(core.deliverPending(state,async () => {throw Error('network failure');},() => {}));
  assert.ok(state.items[item.url].pending);
  assert.equal(state.items[item.url].lastNotified,undefined);
  state = update(JSON.parse(JSON.stringify(state)),[item]);
  assert.equal(state.items[item.url].pending.detectedAt,detectedAt);
  let sends = 0;
  await core.deliverPending(state,async () => {sends++;},() => {},() => true,() => 200);
  assert.equal(sends,1);
  assert.equal(state.items[item.url].lastNotified,200);
  assert.equal(state.items[item.url].pending,null);
  await core.deliverPending(state,async () => {sends++;},() => {});
  assert.equal(sends,1);
});
test('scope change queues current matches with fresh tracking; pause guard prevents sending', async () => {
  const item = sample();
  let state = update(update(null,[]),[item]);
  let sends = 0;
  await core.deliverPending(state,async () => {sends++;},() => {},() => false);
  assert.equal(sends,0);
  assert.ok(state.items[item.url].pending);
  state = core.reconcile(state,[item],'changed filters','Den Haag',1000,200).state;
  assert.equal(state.items[item.url].pending.reason,'首次发现符合条件');
});
test('Amsterdam time windows respect winter/summer time and 23:00 cutoff', () => {
  assert.equal(core.withinHours(new Date('2026-07-01T05:00:00Z')),true);
  assert.equal(core.withinHours(new Date('2026-01-01T05:00:00Z')),false);
  assert.equal(core.withinHours(new Date('2026-01-01T06:00:00Z')),true);
  assert.equal(core.withinHours(new Date('2026-10-03T21:00:00Z')),false);
});

// Offline runtime harness: real DOM events/selectors, virtual clock and mocked GM APIs.
// No network requests or page scripts from the uploaded HTML are executed.
function harness({brokenSecondPage = false, blocked = false, selectedFilter = false, resetFails = false, initialCity = 'The Hague', outsideFirst = false, configured = false, startTime = '2026-10-03T10:00:00Z'} = {}) {
  const {document,window} = parseHTML(fixture);
  const card = document.querySelectorAll('.residence_block')[6].cloneNode(true);
  card.querySelector('.price_text').innerHTML = '€900.00<span class="excl">per month excl.*</span>';
  card.querySelector('.residence_name').textContent = 'Example 1, ' + (outsideFirst ? 'Amsterdam' : initialCity);
  const second = card.cloneNode(true);
  second.querySelector('.residence_name').textContent = 'Example 2, ' + initialCity;
  second.querySelector('a[href]').href = 'https://www.holland2stay.com/residences/example-2.html';
  const list = document.querySelector('.residence_MainSection');
  const pager = document.querySelector('.residence_pagination');
  document.querySelector('.total_residence .count').textContent = '2';
  const city = document.querySelector('[aria-label="Filter products by City"]');
  city.innerHTML = '<label>Rijswijk<input title="Rijswijk" type="checkbox"></label>';
  city.querySelector('input').checked = selectedFilter;
  const currentFilters = document.querySelector('[aria-label="Current Filters"]');
  if (selectedFilter) currentFilters.innerHTML = '<li>Rijswijk</li>';
  document.body.insertAdjacentHTML('beforeend','<div class="residenceFilter"><h2 class="filter_TabHeading"><span class="reset_text">Reset</span></h2></div>');
  let resets = 0;
  document.querySelector('.reset_text').addEventListener('click',() => {
    resets++;
    if (!resetFails) {currentFilters.innerHTML='';city.querySelector('input').checked=false;}
  });
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
  let clock = Date.parse(startTime);
  let networkCalls = 0;
  const messages = [];
  const prefix = 'h2s_single_city_den_haag:';
  if (configured) {
    storage.set(prefix+'token','123456:offline_test_token_not_real');
    storage.set(prefix+'chatId','12345');
  }
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
    GM_xmlhttpRequest(request) {
      networkCalls++;
      if (!configured) throw Error('Unexpected notification');
      messages.push(JSON.parse(request.data));
      queueMicrotask(() => request.onload({status:200,responseText:JSON.stringify({ok:true,result:{message_id:messages.length}})}));
    }};
  vm.runInNewContext(source,sandbox,{filename:'h2s-monitor.user.js'});
  return {document,storage,menus,intervals,visited,prefix,second,messages,get resets(){return resets;},get networkCalls(){return networkCalls;}};
}
async function drain() {for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve));}
test('full runtime scans all pages and queues initial matches while Telegram is unconfigured', async () => {
  const app = harness();
  await drain();
  const state = app.storage.get(app.prefix + 'state');
  assert.ok(state?.initialized, app.document.querySelector('#h2s-monitor-panel').textContent + '\nVisited: ' + app.visited + '\nPage: ' + core.pagination(app.document).current);
  assert.equal(Object.keys(state.items).length,2);
  assert.deepEqual(app.visited,[1,2]);
  assert.equal(app.networkCalls,0);
  assert.match(app.document.querySelector('#h2s-monitor-panel').textContent,/首次完整扫描完成.*待发通知 2 条/);
  const check = [...app.menus.entries()].find(([name]) => name.startsWith('立即检查'))[1];
  check();await drain();
  assert.deepEqual(app.visited,[1,2,1,2]);
});
test('configured runtime sends first-scan matches automatically and repeated scans do not resend', async () => {
  const app = harness({configured:true});
  await drain();
  assert.equal(app.messages.length,2);
  assert.ok(app.messages.every(message => message.chat_id==='12345' && message.text.includes('首次发现符合条件')));
  assert.match(app.document.querySelector('#h2s-monitor-panel').textContent,/本轮已通知 2 条/);
  const check = [...app.menus.entries()].find(([name]) => name.startsWith('立即检查'))[1];
  check();await drain();
  assert.equal(app.messages.length,2);
  assert.match(app.document.querySelector('#h2s-monitor-panel').textContent,/本轮已通知 0 条/);
});
test('nighttime automatic scans pause; manual first scan sends matches without clearing history', async () => {
  const app = harness({configured:true,startTime:'2026-10-03T22:00:00Z'});
  await drain();
  assert.equal(app.storage.has(app.prefix+'state'),false);
  assert.equal(app.messages.length,0);
  const check = [...app.menus.entries()].find(([name]) => name.startsWith('立即检查'))[1];
  check();await drain();
  assert.equal(app.messages.length,2);
  check();await drain();
  assert.equal(app.messages.length,2);
});
test('silent-reset and force-resend menus each apply once and preserve later deduplication', async () => {
  const app = harness({configured:true});
  await drain();
  assert.equal(app.messages.length,2);
  const check = [...app.menus.entries()].find(([name]) => name.startsWith('立即检查'))[1];
  app.menus.get('清除历史并重建基线（不通知现有房源）')();await drain();
  check();await drain();
  assert.equal(app.messages.length,2);
  assert.match(app.document.querySelector('#h2s-monitor-panel').textContent,/已按选择建立静默基线/);
  check();await drain();
  assert.equal(app.messages.length,2);
  app.menus.get('重新通知当前符合条件的房源（强制重发）')();await drain();
  check();await drain();
  assert.equal(app.messages.length,4);
  assert.ok(app.messages.slice(2).every(message => message.text.includes('手动重新通知')));
  check();await drain();
  assert.equal(app.messages.length,4);
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
test('runtime clears website filters once and scans all cities without selecting any city option', async () => {
  const app = harness({selectedFilter:true});
  await drain();
  assert.equal(app.resets,1);
  assert.ok(app.storage.get(app.prefix+'state')?.initialized);
  assert.equal(core.filterState(app.document).ok,true);
});
test('failed Reset cannot create a partial baseline or cause repeated reset clicks', async () => {
  const app = harness({selectedFilter:true,resetFails:true});
  await drain();
  assert.equal(app.resets,1);
  assert.equal(app.storage.has(app.prefix+'state'),false);
  assert.deepEqual(app.visited,[1]);
});
test('a city absent from the dynamic City options can appear later and generates a new listing alert', async () => {
  const app = harness({initialCity:'Rijswijk'});
  await drain();
  const before = app.storage.get(app.prefix+'state');
  assert.ok(before?.initialized);
  assert.ok(Object.values(before.items).every(x => x.city==='Rijswijk'));
  const url = 'https://www.holland2stay.com/residences/new-hague.html';
  app.second.querySelector('.residence_name').textContent='New 1, The Hague';
  app.second.querySelector('a[href]').href=url;
  // The website still exposes only Rijswijk in its City filter; monitoring must work anyway.
  const check = [...app.menus.entries()].find(([name]) => name.startsWith('立即检查'))[1];
  check();await drain();
  const after = app.storage.get(app.prefix+'state');
  assert.equal(after.scope,before.scope);
  assert.equal(after.items[url]?.pending?.reason,'新房源');
  assert.equal(app.resets,0);
});
test('runtime scans unrelated cities but only tracks the requested five for notifications', async () => {
  const app = harness({outsideFirst:true});
  await drain();
  const state = app.storage.get(app.prefix+'state');
  assert.ok(state?.initialized);
  assert.equal(Object.keys(state.items).length,1);
  assert.equal(Object.values(state.items)[0].city,'The Hague');
  assert.match(app.document.querySelector('#h2s-monitor-panel').textContent,/全站扫描 2 套/);
});
