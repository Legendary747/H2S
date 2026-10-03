'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {parseHTML} = require('linkedom');
const core = require('../h2s-monitor.user.js');
const fixture = fs.readFileSync(__dirname + '/fixtures/residences.html', 'utf8');
const selectedCityFixture = fs.readFileSync(__dirname + '/fixtures/the-hague-filters.html', 'utf8');
const selectedCityPage = fs.readFileSync(__dirname + '/fixtures/the-hague-listings.html', 'utf8');
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
test('recognizes global or one allowed city; rejects other cities, multiple cities and extra filters', () => {
  const doc = documentOf();
  assert.equal(core.filterState(doc).ok,true);
  assert.equal(core.filterState(doc).allCities,true);
  const section = doc.querySelector('[aria-label="Filter products by City"]');
  section.innerHTML = '<label>Rijswijk (4)<input type="checkbox" title="Rijswijk"></label>';
  assert.equal(core.filterState(doc).allCities,true);
  section.querySelector('input').checked = true;
  assert.equal(core.filterState(doc).city,'Rijswijk');
  assert.equal(core.filterState(doc).ok,true);
  section.remove();
  const selected = doc.querySelector('[aria-label="Current Filters"]');
  selected.innerHTML = '<li>City: The Hague <button aria-label="Remove City">×</button></li>';
  assert.equal(core.filterState(doc).city,'The Hague');
  assert.equal(core.filterState(doc).ok,true);
  selected.innerHTML += '<li>Leiden</li>';
  assert.equal(core.filterState(doc).ok,false);
  selected.innerHTML = '<li>Amsterdam</li>';
  assert.equal(core.filterState(doc).city,'Amsterdam');
  assert.equal(core.filterState(doc).wanted,false);
  selected.innerHTML = '<li>Rent p/month: €0–€900</li>';
  assert.equal(core.filterState(doc).ok,false);
  selected.remove();
  assert.equal(core.filterState(doc).ok,false);
});
test('actual The Hague filter markup accepts the city and ignores the Clear all filters action', () => {
  const {document} = parseHTML(selectedCityFixture);
  assert.equal(document.querySelector('[data-cy="FilterSidebar-clearButton"]').textContent,'Clear all filters');
  const filters = core.filterState(document);
  assert.equal(filters.city,'The Hague');
  assert.equal(filters.wanted,true);
  assert.equal(filters.ok,true,filters.reason);
  assert.equal(filters.reason,'');
  document.querySelector('[aria-label="Filter products by City"]').remove();
  assert.equal(core.filterState(document).ok,true,'Selected-city chip also works with collapsed/absent options');
});
test('ignoring Clear all filters still rejects genuine extra filters and multiple selected cities', () => {
  for(const added of ['<li><span>Rent: €0–€900</span></li>','<li><span>Leiden</span></li>']){
    const {document}=parseHTML(selectedCityFixture);
    document.querySelector('[aria-label="Current Filters"]').insertAdjacentHTML('beforeend',added);
    assert.equal(core.filterState(document).ok,false);
  }
});
test('budget cutoff requires sorted prices, unique URLs, and a complete prefix or complete result', () => {
  const rows = [900,1500,1501].map((rent,i) => sample({rent,url:sample().url.replace('example','p'+i)}));
  assert.equal(core.validateBudgetSweep(rows,100,1500,null,false).cutoff,true);
  assert.throws(() => core.validateBudgetSweep(rows.slice(0,2),100,1500,null,false));
  assert.equal(core.validateBudgetSweep(rows.slice(0,2),2,1500,null,true).cutoff,false);
  assert.throws(() => core.validateBudgetSweep([rows[1],rows[0],rows[2]],3,1500,null,true));
  assert.throws(() => core.validateBudgetSweep([rows[0],rows[0],rows[2]],3,1500,null,true));
  assert.throws(() => core.validateBudgetSweep(rows,100,1500,'Leiden',false));
  for (const label of ['Price: Low to High','Price (Ascending)','Prijs: laag naar hoog']) assert.equal(core.isAscendingPrice(label),true);
  for (const label of ['Price: High to Low','Sort ...','Price']) assert.equal(core.isAscendingPrice(label),false);
});
test('plain Price selection is recognized without certifying ascending main-rent order', () => {
  const {document} = parseHTML(selectedCityFixture);
  const root = document.querySelector('[data-cy="ProductSort-root"]');
  root.querySelector('button').textContent = 'Price';
  assert.equal(core.priceSortState(document).selected,true);
  assert.equal(core.priceSortState(document).ok,false);
  root.querySelector('button').textContent = 'Price ✓';
  assert.equal(core.priceSortState(document).selected,true);
  root.setAttribute('aria-busy','true');
  assert.equal(core.priceSortState(document).selected,false);
  for(const label of ['Available start date','Price: High to Low','Sort ...']) assert.equal(core.isPriceChoice(label),false);
});
test('uploaded The Hague page has nine unsorted listings, with only three direct-booking matches within €1500', () => {
  const page=core.parsePage(parseHTML(selectedCityPage).document);
  assert.equal(page.total,9);assert.equal(page.page.last,1);assert.equal(page.page.next,null);
  assert.deepEqual(page.listings.map(item=>item.rent),[1720,1778,1278,1278,1628,1286,1224,829,802]);
  core.validateSweep(page.listings,page.total,'The Hague');
  assert.deepEqual(page.listings.filter(item=>item.rent<=1500&&core.directStatus(item.status)).map(item=>item.rent),[1278,1278,1286]);
});
test('migration separates city history and preserves sent markers, pending records and total successes', () => {
  const a = {...sample(),eligible:true,missing:0,lastNotified:20,pending:null};
  const b = {...sample({city:'Leiden',url:sample().url.replace('example','leiden')}),eligible:true,missing:0,pending:{reason:'新房源',detectedAt:10}};
  const history = core.historyFrom({version:1,scope:'old-all-cities',initialized:true,sent:6,items:{[a.url]:a,[b.url]:b}});
  assert.equal(history.sent,6);
  assert.equal(history.cities['den haag'].items[a.url].lastNotified,20);
  assert.ok(history.cities.leiden.items[b.url].pending);
  const hague = core.reconcile(history.cities['den haag'],[a],core.cityScope('The Hague'),'The Hague',1500,100).state;
  assert.equal(hague.items[a.url].pending,null);
  assert.equal(history.cities.leiden.items[b.url].missing,0);
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

// Offline runtime harness: uploaded card markup, simulated site controls, virtual
// clock, and mocked Telegram responses. No real network requests are made.
function harness({pages, cityFilter = null, collapsedCity = false, extraFilter = false, actualCityControls = false,
  sortMode = 'asc', sortOptionLabel = 'Price: Low to High', sortOptionTag = 'button', canSort = true, configured = false, blocked = false, brokenPage = 0,
  startTime = '2026-10-03T10:00:00Z', initialState, onRequest, onPage} = {}) {
  pages ||= [[sample()], [sample({rent:1000,url:sample().url.replace('example','second')})]];
  const {document,window} = parseHTML(fixture);
  const template = document.querySelectorAll('.residence_block')[6].cloneNode(true);
  const list = document.querySelector('.residence_MainSection');
  const pager = document.querySelector('.residence_pagination');
  const cityRoot = document.querySelector('[aria-label="Filter products by City"]');
  const filtersRoot = document.querySelector('[aria-label="Current Filters"]');
  const handlers = new Map();
  const originalListen = document.addEventListener.bind(document);
  document.addEventListener = (type, fn, ...args) => {
    const fns = handlers.get(type) || [];fns.push(fn);handlers.set(type,fns);
    originalListen(type,fn,...args);
  };
  function selectCity(value) {
    const cities = value === null ? [] : Array.isArray(value) ? value : [value];
    cityRoot.innerHTML = collapsedCity ? '' : cities.map(city => '<label>'+city+'<input type="checkbox" title="'+city+'"></label>').join('');
    cityRoot.querySelectorAll('input').forEach(input => {input.checked=true;});
    filtersRoot.innerHTML = cities.map(city => '<li>City: '+city+' <button>×</button></li>').join('') + (extraFilter ? '<li>Rent: €0–€900</li>' : '');
    if (actualCityControls && cities.length === 1 && cities[0] === 'The Hague') {
      const uploaded = parseHTML(selectedCityFixture).document;
      cityRoot.innerHTML = uploaded.querySelector('[aria-label="Filter products by City"]').innerHTML;
      filtersRoot.innerHTML = uploaded.querySelector('[aria-label="Current Filters"]').innerHTML;
    }
  }
  selectCity(cityFilter);
  document.querySelector('.total_residence .count').textContent = String(pages.flat().length);
  let resets = 0;
  document.body.insertAdjacentHTML('beforeend','<div class="residenceFilter"><span class="reset_text">Reset</span></div>');
  document.querySelector('.reset_text').addEventListener('click',() => {resets++;});
  let sorting = document.querySelector('[data-cy="ProductSort-root"]');
  if (!sorting) {sorting = document.createElement('div');sorting.setAttribute('data-cy','ProductSort-root');document.body.append(sorting);}
  sorting.innerHTML = '<button data-cy="ProductSort-sortButton">'+(sortMode==='asc' ? 'Price: Low to High' : sortMode==='desc' ? 'Price: High to Low' : sortMode==='price' ? 'Price' : 'Sort ...')+'</button>';
  let sortClicks = 0;
  sorting.querySelector('button').addEventListener('click',() => {
    sortClicks++;
    if (!canSort || sorting.querySelector('.price-option')) return;
    const option = document.createElement(sortOptionTag);option.className='price-option';option.textContent=sortOptionLabel;
    option.addEventListener('click',() => {sorting.querySelector('[data-cy="ProductSort-sortButton"]').textContent=sortOptionLabel;option.remove();showPage(1);});
    sorting.append(option);
  });
  if(sortMode==='missing') sorting.remove();
  const visited = [];
  function showPage(number) {
    visited.push(number);
    list.querySelectorAll('.residence_block').forEach(node => node.remove());
    if (number !== brokenPage) for (const row of pages[number-1]) {
      const card = template.cloneNode(true);
      card.querySelector('.price_text').innerHTML = '€'+row.rent.toFixed(2)+'<span class="excl">per month excl.*</span>';
      card.querySelector('.residence_name').textContent = row.title?.endsWith(row.city) ? row.title : 'Example, '+row.city;
      card.querySelector('a[href]').href = row.url;
      card.querySelector('.booking_btn').textContent = row.status;
      list.append(card);
    }
    pager.innerHTML = pages.map((_,i) => '<li><a '+(i+1===number ? 'aria-current="page"' : 'aria-label="Page '+(i+1)+'"')+'>'+(i+1)+'</a></li>').join('')+
      '<li><a aria-label="Next page" aria-disabled="'+(number===pages.length)+'">Next</a></li>';
    pager.querySelectorAll('[aria-label^="Page "]').forEach(link => link.addEventListener('click',() => showPage(Number(link.textContent))));
    pager.querySelector('[aria-label="Next page"]').addEventListener('click',() => {if(number<pages.length) showPage(number+1);});
    if (visited.length>1) onPage?.({number,document,selectCity});
  }
  showPage(1);
  if (blocked) document.title='Just a moment...';
  const storage = new Map(), menus = new Map(), intervals = [], messages = [];
  let clock = Date.parse(startTime), networkCalls = 0, reloads = 0;
  const prefix = 'h2s_single_city_den_haag:';
  if (initialState) storage.set(prefix+'state',structuredClone(initialState));
  if (configured) {storage.set(prefix+'token','123456:offline_test_token_not_real');storage.set(prefix+'chatId','12345');}
  const manualClick = (target = pager) => {for(const fn of handlers.get('click')||[]) fn({isTrusted:true,target});};
  class Clock extends Date {constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
  const sandbox = {document,window,Date:Clock,Intl,URL,console,crypto:require('node:crypto').webcrypto,
    location:{pathname:'/residences',origin:'https://www.holland2stay.com',reload(){reloads++;}},
    navigator:{locks:{request:async(name,fn)=>fn()}},
    setTimeout(fn,ms){queueMicrotask(()=>{clock+=ms;fn();});return 1;},clearTimeout(){},
    setInterval(fn){intervals.push(fn);return 1;},clearInterval(){},MutationObserver:class{observe(){}disconnect(){}},
    prompt:()=>null,confirm:()=>true,alert(){},
    GM_getValue:(key,fallback)=>storage.has(key)?structuredClone(storage.get(key)):fallback,
    GM_setValue:(key,value)=>storage.set(key,structuredClone(value)),GM_registerMenuCommand:(label,fn)=>menus.set(label,fn),
    GM_xmlhttpRequest(request){
      networkCalls++;
      if(!configured) throw Error('Unexpected notification');
      const attempt=networkCalls, body=JSON.parse(request.data);
      queueMicrotask(()=>{
        const response=onRequest?.({attempt,body,document,selectCity,manualClick});
        if(response==='error'){request.onerror();return;}
        if(response==='429'){request.onload({status:429,responseText:JSON.stringify({ok:false,parameters:{retry_after:60}})});return;}
        messages.push(body);
        request.onload({status:200,responseText:JSON.stringify({ok:true,result:{message_id:messages.length}})});
      });
    }};
  vm.runInNewContext(source,sandbox,{filename:'h2s-monitor.user.js'});
  return {document,storage,menus,intervals,visited,prefix,messages,selectCity,manualClick,
    advance:ms=>{clock+=ms;},tick:()=>intervals[0](),
    get history(){return storage.get(prefix+'state');},get panel(){return document.querySelector('#h2s-monitor-panel').textContent;},
    get resets(){return resets;},get sortClicks(){return sortClicks;},get networkCalls(){return networkCalls;},get reloads(){return reloads;}};
}
async function drain(){for(let i=0;i<50;i++)await new Promise(resolve=>setImmediate(resolve));}
const check = async app => {app.menus.get('立即检查（允许在夜间手动执行）')();await drain();};
const rowsOf = history => Object.values(history.cities).flatMap(state=>Object.values(state.items));
const priced = (rents,city='The Hague')=>rents.map((rent,i)=>sample({rent,city,title:'Example '+i+', '+city,url:sample().url.replace('example','r'+rent+'-'+i)}));

test('global runtime scans sorted pages and retains initial notifications until Telegram is configured',async()=>{
  const app=harness();await drain();
  assert.equal(app.history.version,2);
  assert.equal(rowsOf(app.history).filter(x=>x.pending).length,2);
  assert.deepEqual(app.visited,[1,2]);
  assert.equal(app.networkCalls,0);
  assert.match(app.panel,/当前城市：全部城市/);
  assert.match(app.panel,/当前范围待发 2/);
  await check(app);assert.deepEqual(app.visited,[1,2,1,2]);
});
test('sort selection uses the observed ProductSort control and verifies the ascending label',async()=>{
  const app=harness({sortMode:'unset',configured:true});await drain();
  assert.equal(app.sortClicks,1);
  assert.equal(app.messages.length,2);
  assert.match(app.panel,/价格排序：从低到高/);
});
test('single-page The Hague scans without Sort or ascending prices and remains deduplicated at night',async()=>{
  const rows=core.parsePage(parseHTML(selectedCityPage).document).listings;
  for(const sortMode of ['unset','price','desc','missing']){
    const app=harness({pages:[rows],cityFilter:'The Hague',actualCityControls:true,sortMode,configured:true,startTime:'2026-10-03T22:00:00Z'});
    await drain();assert.equal(app.history,undefined);
    app.document.querySelector('.residence_pagination').remove();
    app.manualClick(app.document.querySelector('[aria-label="Current Filters"]'));
    await check(app);
    assert.equal(app.messages.length,3,app.panel);assert.equal(app.sortClicks,0);
    assert.deepEqual(app.visited,[1]);assert.equal(rowsOf(app.history).length,9);
    assert.match(app.panel,/当前仅一页，无需排序/);assert.match(app.panel,/已读 9 套 · 符合 3 套/);
    assert.equal(Object.values(app.history.scans)[0].cutoff,false);
    await check(app);assert.equal(app.messages.length,3);
  }
});
test('Price-only menu can be selected automatically; full city pagination includes cheaper later listings',async()=>{
  const rows=priced([1700,900,800]);
  const app=harness({pages:rows.map(row=>[row]),cityFilter:'The Hague',sortMode:'unset',sortOptionLabel:'Price',sortOptionTag:'li',configured:true});
  await drain();
  assert.equal(app.sortClicks,1);assert.deepEqual(app.visited,[1,1,2,3]);
  assert.equal(app.messages.length,2);assert.equal(rowsOf(app.history).length,3);
  assert.match(app.panel,/已选择 Price，升序方向未确认/);assert.match(app.panel,/读完当前城市全部页/);
  assert.equal(Object.values(app.history.scans)[0].cutoff,false);
});
test('already selected Price avoids reopening the menu; absent Sort still permits complete city scanning',async()=>{
  for(const sortMode of ['price','missing']){
    const app=harness({pages:priced([1700,900]).map(row=>[row]),cityFilter:'The Hague',sortMode,configured:true});
    await drain();assert.equal(app.messages.length,1,app.panel);
    assert.deepEqual(app.visited,[1,2]);assert.equal(app.sortClicks,0);
  }
});
test('global Price-only multi-page mode asks for one target city without sweeping the site',async()=>{
  const app=harness({sortMode:'price',configured:true});await drain();
  assert.equal(app.history,undefined);assert.equal(app.messages.length,0);assert.equal(app.sortClicks,0);
  assert.deepEqual(app.visited,[1]);assert.match(app.panel,/请手动选择一个目标城市/);
});
test('complete unsorted global single page still filters for exactly the allowed cities and budget',async()=>{
  const rows=priced([1700,900,800]);rows[1].city='Amsterdam';rows[1].title='Example, Amsterdam';
  const app=harness({pages:[rows],sortMode:'missing',configured:true});await drain();
  assert.equal(app.messages.length,1);assert.ok(app.messages[0].text.includes('€800.00'));
  assert.equal(app.sortClicks,0);assert.deepEqual(app.visited,[1]);
});
test('complete-scan fallback refuses missing or duplicate cards and preserves prior history',async()=>{
  const baseline=harness({pages:[[sample()]],cityFilter:'The Hague',configured:true});await drain();
  for(const settings of [
    {pages:[[sample()],[sample()]],sortMode:'price'},
    {sortMode:'price',brokenPage:2},
    {pages:[[sample()]],sortMode:'missing',onPage:null}
  ]){
    const app=harness({...settings,cityFilter:'The Hague',initialState:baseline.history,startTime:'2026-10-03T22:00:00Z',configured:true});await drain();
    if(settings.sortMode==='missing') app.document.querySelector('.total_residence .count').textContent='2';
    await check(app);
    assert.deepEqual(app.history,baseline.history,app.panel);assert.equal(app.messages.length,0);
    assert.match(app.panel,/扫描未完成/);
  }
});
test('unknown sort and descending actual prices never initialize history or continue pagination',async()=>{
  const unknown=harness({sortMode:'unset',canSort:false});await drain();
  assert.equal(unknown.history,undefined);
  assert.deepEqual(unknown.visited,[1]);
  assert.match(unknown.panel,/未能确认升序/);
  const unsorted=harness({pages:[priced([1200,900]),priced([1600])]});await drain();
  assert.equal(unsorted.history,undefined);
  assert.deepEqual(unsorted.visited,[1]);
  assert.match(unsorted.panel,/等待价格升序生效/);
});
test('price cutoff stops requests after the first over-budget page, includes exactly €1500, and excludes lottery/other cities',async()=>{
  const rows=priced([900,1000,1200,1500,1501,1800]);
  rows[0].city='Amsterdam';rows[0].title='Example, Amsterdam';
  rows[1].status='Available in lottery';
  const app=harness({pages:[rows.slice(0,2),rows.slice(2,4),rows.slice(4)],configured:true});await drain();
  assert.deepEqual(app.visited,[1,2,3]);
  assert.equal(app.messages.length,2);
  assert.ok(app.messages.some(x=>x.text.includes('€1500.00')));
  assert.ok(Object.values(app.history.scans)[0].cutoff);
  const early=harness({pages:[rows.slice(0,3),[rows[4]],[rows[5]]],configured:true});await drain();
  assert.deepEqual(early.visited,[1,2]);
  assert.equal(early.messages.length,1);
});
test('an all-over-budget first page performs no next-page request and produces no listing notifications',async()=>{
  const app=harness({pages:priced([1501,2000]).map(x=>[x]),configured:true});await drain();
  assert.deepEqual(app.visited,[1]);assert.equal(app.messages.length,0);
  assert.match(app.panel,/超预算位置，停止翻页/);
});
test('cross-page price inversions, duplicate cards, and incomplete rendering preserve previous history',async()=>{
  for(const settings of [
    {pages:priced([1000,900]).map(x=>[x])},
    {pages:[[sample()],[sample()]]},
    {brokenPage:2}
  ]){
    const app=harness(settings);await drain();assert.equal(app.history,undefined,app.panel);
  }
});
test('one allowed city is scanned without Reset, including when City options are collapsed',async()=>{
  const app=harness({cityFilter:'The Hague',collapsedCity:true,configured:true});await drain();
  assert.equal(app.messages.length,2);assert.equal(app.resets,0);
  assert.match(app.panel,/当前城市：The Hague/);
  assert.match(app.panel,/目标城市：是，属于目标五城/);
  assert.match(app.panel,/扫描状态：本轮已完成/);
  await check(app);assert.equal(app.messages.length,2);
});
test('non-target cities, multiple cities and extra filters do not trigger sorting, pagination or messages',async()=>{
  for(const settings of [{cityFilter:'Amsterdam'},{cityFilter:['The Hague','Leiden']},{cityFilter:'The Hague',extraFilter:true}]){
    const app=harness({...settings,sortMode:'unset',configured:true});await drain();
    assert.equal(app.history,undefined);assert.equal(app.messages.length,0);assert.equal(app.sortClicks,0);
    assert.equal(app.resets,0);assert.deepEqual(app.visited,[1]);assert.match(app.panel,/允许扫描：否/);
  }
});
test('stale listings and a city change during scanning cannot be accepted as a completed selected-city scan',async()=>{
  const stale=harness({cityFilter:'Leiden'});await drain();assert.equal(stale.history,undefined);
  const changed=harness({cityFilter:'The Hague',onPage:({number,selectCity})=>{if(number===2)selectCity('Leiden');}});
  await drain();assert.equal(changed.history,undefined);assert.match(changed.panel,/筛选条件已改变/);
});
test('switching global to a single city and back keeps sent history and leaves unscanned cities untouched',async()=>{
  const a=sample(), b=sample({city:'Leiden',title:'Example, Leiden',url:sample().url.replace('example','leiden')});
  const global=harness({pages:[[a,b]],configured:true});await drain();assert.equal(global.messages.length,2);
  const single=harness({pages:[[a]],cityFilter:'The Hague',configured:true,initialState:global.history});await drain();
  assert.equal(single.messages.length,0);assert.equal(single.history.cities.leiden.items[b.url].missing,0);
  const again=harness({pages:[[a,b]],configured:true,initialState:single.history});await drain();
  assert.equal(again.messages.length,0);assert.equal(again.history.sent,2);
});
test('nighttime manual scanning sends matches and repeated checks stay deduplicated',async()=>{
  const app=harness({configured:true,startTime:'2026-10-03T22:00:00Z'});await drain();
  assert.equal(app.history,undefined);assert.equal(app.sortClicks,0);
  await check(app);assert.equal(app.messages.length,2);
  await check(app);assert.equal(app.messages.length,2);
});
test('nighttime check with real city controls waits for recent interaction then sorts and scans automatically',async()=>{
  const app=harness({cityFilter:'The Hague',actualCityControls:true,sortMode:'unset',configured:true,startTime:'2026-10-03T22:00:00Z'});
  await drain();
  assert.equal(core.filterState(app.document).ok,true);
  assert.equal(app.sortClicks,0);assert.equal(app.history,undefined);
  app.manualClick(app.document.querySelector('[aria-label="Current Filters"]'));
  await check(app);
  assert.equal(app.sortClicks,1);assert.equal(app.messages.length,2);
  assert.match(app.panel,/允许扫描：是/);
  assert.match(app.panel,/价格排序：从低到高/);
  assert.match(app.panel,/扫描状态：本轮已完成/);
  assert.equal(app.resets,0);
  assert.ok(app.document.querySelector('[data-cy="FilterSidebar-clearButton"]'));
});
test('same-scope user pagination during delivery does not interrupt a 31-message batch after six successes',async()=>{
  const app=harness({pages:[priced(Array(31).fill(900))],configured:true,
    onRequest:({attempt,manualClick})=>{if(attempt===6)manualClick();}});
  await drain();assert.equal(app.messages.length,31);assert.equal(app.history.sent,31);
  assert.match(app.panel,/当前范围待发 0/);
  assert.doesNotMatch(app.panel,/Telegram：检测到手动操作/);
});
test('six successes followed by rate limiting show 25 pending and resume at night without another H2S sweep',async()=>{
  const app=harness({pages:[priced(Array(31).fill(900))],configured:true,startTime:'2026-10-03T22:00:00Z',
    onRequest:({attempt})=>attempt===7?'429':undefined});
  await drain();await check(app);
  assert.equal(app.messages.length,6);assert.match(app.panel,/当前范围待发 25/);
  app.advance(61000);app.tick();await drain();
  assert.equal(app.messages.length,31);assert.equal(app.history.sent,31);
  assert.deepEqual(app.visited,[1]);assert.match(app.panel,/当前范围待发 0/);
});
test('changing city during sending preserves pending records and reports a control pause separately from Telegram',async()=>{
  const app=harness({pages:[priced(Array(10).fill(900))],configured:true,
    onRequest:({attempt,selectCity})=>{if(attempt===6)selectCity('Leiden');}});
  await drain();assert.equal(app.messages.length,6);
  assert.equal(rowsOf(app.history).filter(x=>x.pending).length,4);
  assert.match(app.panel,/通知已暂停/);assert.match(app.panel,/Telegram：发送成功/);
});
test('old all-city records migrate on upgrade, send pending only, and preserve prior cumulative counts',async()=>{
  const a=sample(),b=sample({url:sample().url.replace('example','new')});
  const old={version:1,scope:'old-all-cities',initialized:true,sent:6,items:{
    [a.url]:{...a,eligible:true,missing:0,lastSeen:10,lastNotified:20,pending:null},
    [b.url]:{...b,eligible:true,missing:0,lastSeen:10,pending:{reason:'新房源',detectedAt:10}}
  }};
  const app=harness({pages:[[a,b]],configured:true,initialState:old});await drain();
  assert.equal(app.messages.length,1);assert.ok(app.messages[0].text.includes(b.url));assert.equal(app.history.sent,7);
});
test('silent reset and forced resend apply only to the current scope and later scans still deduplicate',async()=>{
  const app=harness({cityFilter:'The Hague',configured:true});await drain();assert.equal(app.messages.length,2);
  app.menus.get('清除历史并重建基线（不通知现有房源）')();await drain();await check(app);
  assert.equal(app.messages.length,2);assert.match(app.panel,/静默记录/);
  await check(app);assert.equal(app.messages.length,2);
  app.menus.get('重新通知当前符合条件的房源（强制重发）')();await drain();await check(app);
  assert.equal(app.messages.length,4);await check(app);assert.equal(app.messages.length,4);
});
test('challenge pages pause without sorting, pagination, or altering listing history',async()=>{
  const app=harness({blocked:true});await drain();assert.equal(app.history,undefined);
  assert.deepEqual(app.visited,[1]);assert.equal(app.sortClicks,0);assert.match(app.panel,/验证暂停/);
});
