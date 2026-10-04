"""Offline Chromium regression suite. No H2S or Telegram requests are sent.
Run: python tests/browser_regression.py [--source path/to/userscript] [--chromium /usr/bin/chromium]
Requires Python playwright, plus an installed Chromium browser.
Fixtures are sanitized DOM extracts from the user's two uploaded snapshots.
"""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, default=ROOT / 'h2s-monitor.user.js')
parser.add_argument('--chromium', default='/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None)
args = parser.parse_args()
SOURCE = args.source.read_text()
PREFIX = 'h2s_single_city_den_haag:'
RESULTS = []
BASE = '''<!doctype html><html><head><title>Residences | Holland2Stay</title></head><body>
<div class="selected_filter"><ul aria-label="Current Filters"><li>Available to book</li><li class="clear_filter" data-cy="FilterSidebar-clearButton">Clear all filters</li></ul></div>
<div id="filter_accordion"><div aria-label="Filter products by City"></div><div aria-label="Filter products by Availability"><label>Available to book<input type="checkbox" checked title="Available to book"></label></div></div>
<p class="total_residence"><span class="count">0</span> residences</p>
<div data-cy="ProductSort-root" aria-busy="false"><button data-cy="ProductSort-sortButton">Sort ...</button></div>
<div class="residence_MainSection"></div><ul class="residence_pagination"></ul>
</body></html>'''
DEFAULT_PAGES = [
    [('amsterdam', 'Amsterdam', 850), ('hague', 'The Hague', 900), ('rijswijk', 'Rijswijk', 1100)],
    [('rotterdam', 'Rotterdam', 1200), ('leiden', 'Leiden', 1500), ('zoetermeer', 'Zoetermeer', 1500.01)],
    [('over1', 'Zoetermeer', 1700), ('over2', 'Leiden', 1800), ('over3', 'The Hague', 2000)],
]
SETUP = r'''cfg => {
  window.store = structuredClone(cfg.store || {});
  window.testLocation = {pathname:'/residences',origin:'https://www.holland2stay.com',reload(){window.reloads=(window.reloads||0)+1;}};
  Object.defineProperty(navigator,'locks',{configurable:true,value:{request:(_name,callback)=>Promise.resolve().then(callback)}});
  window.calls = {open:0, price:0, date:0, pages:[], messages:[], attempts:[], forbidden:0};
  window.commands = {};
  window.GM_getValue = (key, fallback) => key in store ? structuredClone(store[key]) : fallback;
  window.GM_setValue = (key, value) => {store[key] = structuredClone(value);};
  window.GM_registerMenuCommand = (label, callback) => {commands[label] = callback;};
  let failed = false;
  window.GM_xmlhttpRequest = options => {
    const payload = JSON.parse(options.data);
    calls.attempts.push(payload);
    const fail = cfg.failTelegram && !failed && calls.messages.length === 1;
    if (fail) failed = true;
    setTimeout(() => {
      if (fail) options.onload({status:429, responseText:JSON.stringify({ok:false,parameters:{retry_after:60}})});
      else {calls.messages.push(payload); options.onload({status:200, responseText:'{"ok":true,"result":{"message_id":1}}'});}
    },10);
  };
  window.alert=()=>{}; window.confirm=()=>false; window.prompt=()=>null;
  const root = document.querySelector('[data-cy="ProductSort-root"]');
  let selected = cfg.selected || 'date';
  let current = cfg.initialPage || 1;
  const pages = cfg.pages;
  const total = pages.flat().length;
  const list=document.querySelector('.residence_MainSection');
  const pager=document.querySelector('.residence_pagination');
  const count=document.querySelector('.total_residence .count');
  function rowHTML(row) {
    const [id,city,rent,status='Book directly']=row;
    return `<div class="residence_block"><div class="residence_info"><a href="https://www.holland2stay.com/residences/${id}.html"><h5 class="residence_name">${id} 1, ${city}</h5><button class="booking_btn">${status}</button><p class="serviceList_text">*servicekosten amount to €999.00 per month.</p></a><div class="rightSide"><h4 class="price_text">€${rent.toFixed(2)} <span>per month excl.*</span></h4></div></div></div>`;
  }
  function display(n) {
    current=n;
    let rows=pages[n-1];
    if(selected==='date' && cfg.initialUnsorted!==false) rows=[...rows].reverse();
    list.innerHTML=rows.map(rowHTML).join('');
    count.textContent=String(cfg.changeTotal && n>1 ? total+1 : total);
    pager.innerHTML=pages.map((_,i)=>`<li><a role="button" data-page="${i+1}" ${i+1===n?'aria-current="page"':''}>${i+1}</a></li>`).join('')+
      `<li ${n===pages.length?'class="disabled"':''}><a role="button" aria-label="Next page" aria-disabled="${n===pages.length}" data-page="${n+1}">Next</a></li>`;
    root?.setAttribute('aria-busy','false');
  }
  function load(n,fromPager=false) {
    if(fromPager) calls.pages.push(n);
    root?.setAttribute('aria-busy','true');
    if(cfg.stuckPage && n===2) return;
    setTimeout(()=>{
      display(n);
      if(cfg.changeFilters && n===2) document.querySelector('[aria-label="Current Filters"]').insertAdjacentHTML('beforeend','<li>Leiden</li>');
      if(cfg.challengePage && n===2) {let d=document.createElement('div'); d.id='challenge-running';document.body.append(d);}
    },cfg.delay || 1800);
  }
  function menu() {
    root.querySelector('ul')?.remove();
    root.insertAdjacentHTML('beforeend',`<ul><li><button data-kind="date" data-cy="${selected==='date'?'SortItem-activeButton':'SortItem-button'}"><span>Available start date</span></button></li><li><button data-kind="price" data-cy="${selected==='price'?'SortItem-activeButton':'SortItem-button'}"><span>Price</span></button></li></ul>`);
  }
  root?.addEventListener('click',e=>{
    const t=e.target.closest('button'); if(!t)return;
    if(t.dataset.cy==='ProductSort-sortButton'){
      calls.open++;
      if(root.querySelector('ul')) root.querySelector('ul').remove(); else menu();
    }else if(t.dataset.kind){
      calls[t.dataset.kind]++;
      if(!cfg.failedSort)selected=t.dataset.kind;
      if(cfg.closeMenu!==false)root.querySelector('ul')?.remove();else menu();
      load(cfg.sortResetsPage ? 1 : current);
    }
  });
  pager.addEventListener('click',e=>{const a=e.target.closest('[data-page]');if(a&&a.getAttribute('aria-disabled')!=='true')load(Number(a.dataset.page),true);});
  for(const el of document.querySelectorAll('[data-cy="FilterSidebar-clearButton"],#filter_accordion input'))el.addEventListener('click',()=>calls.forbidden++);
  display(current);
  if(cfg.menuOpen&&root) menu();
  if(cfg.city){
    document.querySelector('[aria-label="Current Filters"]').insertAdjacentHTML('afterbegin',`<li>${cfg.city}</li>`);
  }
  if(cfg.noAvailability){
    document.querySelector('[aria-label="Current Filters"]').innerHTML=cfg.city?`<li>${cfg.city}</li>`:'';
    document.querySelector('[aria-label="Filter products by Availability"]').innerHTML='';
  }
  if(cfg.noSort)root?.remove();
}'''

def check(name, fn):
    try:
        fn()
        RESULTS.append({'name':name,'status':'PASS'})
        print('PASS',name,flush=True)
    except Exception as exc:
        RESULTS.append({'name':name,'status':'FAIL','error':str(exc)})
        print('FAIL',name,str(exc)[:1000],flush=True)

def assert_that(test, message='assertion failed'):
    if not test: raise AssertionError(message)

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=args.chromium,headless=True,args=['--no-sandbox'])
    def page_at(html, hour=12):
        context=browser.new_context()
        context.route('**/*',lambda route:route.fulfill(status=200,content_type='text/html',body=html) if route.request.resource_type=='document' else route.abort())
        page=context.new_page()
        page.set_content(html)
        page.clock.install(time=datetime(2026,10,4,hour,0,tzinfo=timezone.utc))
        return page
    corepage=page_at(BASE)
    corepage.evaluate('window.module={exports:{}}')
    corepage.evaluate(SOURCE)
    corepage.evaluate('window.core=module.exports;delete window.module')
    def js_test(name, js):
        check(name,lambda:assert_that(corepage.evaluate('() => {'+js+'}'),name))
    js_test('bare Price means ascending; date is not a price sort',"return core.isAscendingPrice('Price') && !core.isAscendingPrice('Available start date') && core.sortChoice('Available start date').ascending;")
    js_test('explicit descending is never a budget sort',"return ['Price: High to Low','Price descending','Price ↓','Sort ...'].every(x=>!core.isAscendingPrice(x));")
    js_test('localized ascending and price checkmarks remain supported',"return ['Price ✓','Price: Low to High','Price (Ascending)','Prijs: laag naar hoog'].every(core.isAscendingPrice);")
    js_test('active Price survives menu unmount',r'''const d=new DOMParser().parseFromString('<div class="selected_filter"><ul aria-label="Current Filters"></ul></div><div data-cy="ProductSort-root"><button data-cy="ProductSort-sortButton">Sort ...</button><ul><button data-cy="SortItem-activeButton">Price</button></ul></div>','text/html');
      if(!core.priceSortState(d).ok)return false;d.querySelector('ul:has(button)').remove();const s=core.priceSortState(d);return s.ok&&s.source==='verified-menu-cache';''')
    js_test('active Date overrides stale Price trigger and cache',r'''const d=new DOMParser().parseFromString('<div class="selected_filter"><ul aria-label="Current Filters"></ul></div><div data-cy="ProductSort-root"><button data-cy="ProductSort-sortButton">Price</button><button data-cy="SortItem-activeButton">Available start date</button></div>','text/html');return !core.priceSortState(d).ok&&core.priceSortState(d).choice==='date';''')
    js_test('cache invalidates on filter or root replacement',r'''const d=new DOMParser().parseFromString('<div class="selected_filter"><ul aria-label="Current Filters"></ul></div><div data-cy="ProductSort-root"><button data-cy="ProductSort-sortButton">Sort ...</button><button data-cy="SortItem-activeButton">Price</button></div>','text/html');core.priceSortState(d);d.querySelector('[data-cy="SortItem-activeButton"]').remove();d.querySelector('[aria-label="Current Filters"]').innerHTML='<li>Leiden</li>';if(core.priceSortState(d).ok)return false;const r=d.querySelector('[data-cy="ProductSort-root"]');r.insertAdjacentHTML('beforeend','<button data-cy="SortItem-activeButton">Price</button>');if(!core.priceSortState(d).ok)return false;r.querySelector('[data-cy="SortItem-activeButton"]').remove();r.replaceWith(r.cloneNode(true));return !core.priceSortState(d).ok;''')
    js_test('busy Price is selected but not yet ready',r'''const r=document.querySelector('[data-cy="ProductSort-root"]');r.innerHTML='<button data-cy="ProductSort-sortButton">Price</button>';r.setAttribute('aria-busy','true');const s=core.priceSortState(document);r.setAttribute('aria-busy','false');return s.busy&&s.selected&&!s.ok;''')
    js_test('availability is independent from city',"const f=core.filterState(document);return f.ok&&f.allCities&&f.availability==='Available to book'&&f.city==='';")
    js_test('euro conventions and service-cost rejection',r'''return core.money('1,500.00')===1500&&core.money('1.500,00')===1500&&(()=>{try{core.rentFromText('servicekosten €99 per month.');return false}catch{return true}})();''')
    js_test('Amsterdam clock boundaries and winter time',r'''return !core.withinHours(new Date('2026-10-04T04:59:00Z'))&&core.withinHours(new Date('2026-10-04T05:00:00Z'))&&!core.withinHours(new Date('2026-10-04T21:00:00Z'))&&core.withinHours(new Date('2026-11-01T06:00:00Z'));''')
    js_test('legacy history import retains success and pending',r'''const h=core.historyFrom({version:1,sent:9,initialized:true,items:{a:{url:'a',city:'The Hague',lastNotified:20},b:{url:'b',city:'Leiden',pending:{reason:'test'}}}});return h.sent===9&&h.cities['den haag'].items.a.lastNotified===20&&!!h.cities.leiden.items.b.pending;''')
    for file,total,expected in [('snapshot-global.html',109,10),('snapshot-the-hague.html',9,9)]:
        html=(ROOT/'tests'/'fixtures'/file).read_text()
        def snapshot_test(html=html,total=total,expected=expected):
            out=corepage.evaluate('html=>{const d=new DOMParser().parseFromString(html,"text/html");const p=core.parsePage(d);return {total:p.total,n:p.listings.length,f:core.filterState(d),rents:p.listings.map(x=>x.rent)};}',html)
            assert_that(out['total']==total and out['n']==expected and out['f']['ok'],str(out))
        check('parse actual sanitized snapshot '+file,snapshot_test)

    def start(cfg=None,html=BASE,hour=12,manual=True):
        cfg=dict(cfg or {})
        cfg.setdefault('pages',DEFAULT_PAGES)
        cfg.setdefault('store',{})
        cfg['store']={PREFIX+'token':'123456:offline_test_token_not_real_00000',PREFIX+'chatId':'123456',PREFIX+'paused':True,**cfg['store']}
        page=page_at(html,hour)
        page.evaluate(SETUP,cfg)
        page.evaluate("source => {new Function('location',source)(window.testLocation);}",SOURCE)
        page.wait_for_function("document.querySelector('#h2s-monitor-panel')?.textContent.includes('手动暂停')")
        page.evaluate("store['"+PREFIX+"paused']=false")
        if manual: page.evaluate("commands['立即检查（允许在夜间手动执行）']()")
        return page
    def outcome(page, stop='done', limit=170):
        for _ in range(limit):
            page.clock.fast_forward(1000)
            out=page.evaluate('''() => ({panel:document.querySelector('#h2s-monitor-panel').textContent,calls,store})''')
            txt=out['panel']
            if '扫描状态：扫描未完成' in txt or '扫描状态：验证暂停' in txt: return out
            if stop=='retry' and '通知等待重试（扫描已完成）' in txt:return out
            if '扫描状态：本轮已完成' in txt or '扫描状态：扫描已完成' in txt:return out
        raise AssertionError('timeout: '+out['panel'])
    def getscan(out):
        scans=out['store'].get(PREFIX+'state',{}).get('scans',{})
        return list(scans.values())[-1] if scans else None
    def base_check(cfg=None,expected=4):
        p=start(cfg);out=outcome(p)
        assert_that(getscan(out) is not None,out['panel'])
        assert_that(getscan(out)['cutoff'] and getscan(out)['pages']==2,out['panel'])
        assert_that(len(out['calls']['messages'])==expected,out['panel'])
        assert_that(out['calls']['price']==(0 if (cfg or {}).get('selected')=='price' else 1),str(out['calls']))
        assert_that(3 not in out['calls']['pages'] and out['calls']['forbidden']==0,str(out['calls']))
        assert_that('升序方向未确认' not in out['panel'] and 'Price · 从低到高' in out['panel'],out['panel'])
        p.context.close()
    check('full scan: Price closes menu, asynchronous load, five-city cutoff',lambda:base_check())
    check('preselected Price in closed menu: no redundant Price click',lambda:base_check({'selected':'price'}))
    check('already-open Date menu: inner Price button works',lambda:base_check({'menuOpen':True}))
    check('menu stays open after selecting Price',lambda:base_check({'closeMenu':False}))
    check('starts on page 3: returns to page 1 and stops at page 2',lambda:base_check({'initialPage':3}))
    check('sort resets to page 1 during asynchronous update',lambda:base_check({'initialPage':3,'sortResetsPage':True}))
    def dedup():
        p=start();first=outcome(p)
        assert_that(len(first['calls']['messages'])==4,first['panel'])
        p.evaluate("commands['立即检查（允许在夜间手动执行）']()")
        second=outcome(p)
        assert_that(len(second['calls']['messages'])==4 and '本轮已发 0' in second['panel'],second['panel'])
        assert_that(second['calls']['price']==1,str(second['calls']))
        assert_that(second['store'][PREFIX+'token']==first['store'][PREFIX+'token'],'token changed')
        p.context.close()
    check('second scan preserves credentials and never repeats successes',dedup)
    def manual_date():
        p=start();outcome(p)
        p.evaluate('''() => {const r=document.querySelector('[data-cy="ProductSort-root"]');if(!r.querySelector('ul'))r.querySelector('[data-cy="ProductSort-sortButton"]').click();r.querySelector('[data-kind="date"]').click();}''')
        p.clock.fast_forward(3000)
        p.evaluate("commands['立即检查（允许在夜间手动执行）']()")
        out=outcome(p)
        assert_that(getscan(out) and out['calls']['price']==2 and len(out['calls']['messages'])==4,out['panel'])
        p.context.close()
    check('manual Date selection invalidates cached Price even if menu closes',manual_date)
    def no_cutoff():
        pages=[[('a','The Hague',900),('b','Rijswijk',1200)],[('c','Leiden',1500),('d','Zoetermeer',1500)]]
        p=start({'pages':pages});o=outcome(p)
        assert_that(getscan(o) and not getscan(o)['cutoff'] and len(o['calls']['messages'])==4,o['panel']);p.context.close()
    check('exactly €1500 included; all-affordable results reach final page',no_cutoff)
    def single():
        pages=[[('high','The Hague',1700),('low','The Hague',900),('lottery','The Hague',800,'Lottery')]]
        p=start({'pages':pages,'city':'The Hague','noSort':True,'noAvailability':True});o=outcome(p)
        assert_that(getscan(o) and getscan(o)['mode']=='single' and len(o['calls']['messages'])==1,o['panel']);p.context.close()
    check('single-city, single-page, no Sort, excludes Lottery',single)
    def actual_snapshot():
        html=(ROOT/'tests/fixtures/snapshot-the-hague.html').read_text()
        p=page_at(html)
        cfg={'store':{PREFIX+'paused':True,PREFIX+'token':'123456:offline_test_token_not_real_00000',PREFIX+'chatId':'123456'}}
        p.evaluate(SETUP[:SETUP.index('  const root =')]+"}",cfg)
        p.evaluate("source => {new Function('location',source)(window.testLocation);}",SOURCE)
        p.wait_for_function("document.querySelector('#h2s-monitor-panel')?.textContent.includes('手动暂停')")
        p.evaluate("store['"+PREFIX+"paused']=false;commands['立即检查（允许在夜间手动执行）']()")
        out=outcome(p)
        assert_that(getscan(out) and getscan(out)['inspected']==9 and len(out['calls']['messages'])==3,out['panel'])
        p.context.close()
    check('actual The Hague snapshot: entire userscript reads 9 and queues 3 direct rentals',actual_snapshot)
    def legacy_seed():
        item={'url':'https://www.holland2stay.com/residences/hague.html','title':'hague 1, The Hague','city':'The Hague','rent':900,'status':'Book directly','lastNotified':1,'eligible':True,'missing':0}
        history={'version':1,'sent':9,'initialized':True,'items':{item['url']:item}}
        p=start({'store':{PREFIX+'state':history}});out=outcome(p)
        assert_that(getscan(out) and len(out['calls']['messages'])==3 and out['store'][PREFIX+'state']['sent']==12,out['panel'])
        assert_that(out['store'][PREFIX+'state']['cities']['den haag']['items'][item['url']]['lastNotified']==1,'prior success changed')
        p.context.close()
    check('upgrade with cumulative 9: preserves old success, sends only 3 new matches',legacy_seed)

    def invalid(cfg,reason=None):
        cfg={'selected':'price',**cfg}
        p=start(cfg);o=outcome(p)
        assert_that('扫描未完成' in o['panel'] or '验证暂停' in o['panel'],o['panel'])
        assert_that(getscan(o) is None and PREFIX+'state' not in o['store'],o['panel'])
        if reason:assert_that(reason in o['panel'],o['panel'])
        p.context.close()
    check('within-page descending prices: no complete history',lambda:invalid({'pages':[[('a','The Hague',1200),('b','Leiden',900)],[('c','Leiden',1700)]]},'等待价格升序生效'))
    check('cross-page inversion: no complete history',lambda:invalid({'pages':[[('a','The Hague',1400)],[('b','Leiden',1300),('c','Leiden',1700)]]},'跨页价格'))
    check('total changes during pagination: no complete history',lambda:invalid({'changeTotal':True},'总数或页码变化'))
    check('duplicate listing URL across pages: rejected',lambda:invalid({'pages':[[('a','The Hague',900)],[('a','The Hague',900),('c','Leiden',1700)]]},'重复'))
    check('pagination stays busy: timeout without losing history',lambda:invalid({'stuckPage':True},'等待排序加载'))
    check('filter changes mid-scan: cancels old scope',lambda:invalid({'changeFilters':True},'筛选条件已改变'))
    check('Price click did not apply: never assumes click succeeded',lambda:invalid({'selected':'date','failedSort':True},'未能选中 Price'))
    check('challenge during pagination pauses without completing',lambda:invalid({'challengePage':True},'验证'))
    def retry():
        p=start({'failTelegram':True});o=outcome(p,'retry')
        assert_that(getscan(o) and len(o['calls']['messages'])==1,o['panel'])
        hist=o['store'][PREFIX+'state']
        pending=sum(bool(x.get('pending')) for c in hist['cities'].values() for x in c['items'].values())
        assert_that(pending==3,str(hist))
        o=outcome(p)
        assert_that(len(o['calls']['messages'])==4 and o['store'][PREFIX+'state']['sent']==4,o['panel']);p.context.close()
    check('Telegram failure keeps queue; retry does not resend successful item',retry)
    def night():
        p=start(hour=23,manual=False);p.clock.fast_forward(10000)
        assert_that(p.evaluate('calls.price')==0,'automatic night scan')
        p.evaluate("commands['立即检查（允许在夜间手动执行）']()")
        o=outcome(p)
        assert_that(getscan(o) and len(o['calls']['messages'])==4 and '下次刷新 —' in o['panel'],o['panel']);p.context.close()
    check('night automatic pause but menu scan can send notifications',night)
    browser.close()

report={'source':str(args.source),'tests':len(RESULTS),'passed':sum(x['status']=='PASS' for x in RESULTS),'failed':sum(x['status']=='FAIL' for x in RESULTS),'results':RESULTS,'environment':'Chromium local fixture; real DOM; accelerated clock; mocked H2S interactions, navigation, Web Locks and Telegram; no live website E2E'}
(ROOT/'browser-test-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({k:v for k,v in report.items() if k!='results'},ensure_ascii=False),flush=True)
raise SystemExit(bool(report['failed']))
