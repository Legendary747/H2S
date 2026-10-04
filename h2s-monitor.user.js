// ==UserScript==
// @name         H2S — Den Haag housing monitor
// @namespace    https://github.com/Legendary747/H2S
// @version      1.3.8
// @description  Scan H2S by Price (ascending), stop above the main-rent budget, and preserve resumable alerts for five cities.
// @match        https://www.holland2stay.com/residences*
// @match        https://holland2stay.com/residences*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.telegram.org
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  // Without a City filter, scan all cities by ascending price and locally match this list.
  // With one City selected, scan only that city if it belongs to this list.
  const TARGET_CITIES = ['The Hague', 'Rijswijk', 'Rotterdam', 'Leiden', 'Zoetermeer'];
  const MAX_RENT = 1500;
  // Keep the original @name and prefix so an in-place update preserves Telegram configuration.
  const STORAGE_PREFIX = 'h2s_single_city_den_haag';
  const TIME_ZONE = 'Europe/Amsterdam';
  const START_HOUR = 7;
  const END_HOUR = 23;
  const REFRESH_MINUTES = [5, 15];
  const MIN_SETTLE_MS = 10000;
  const MAX_SETTLE_MS = 30000;
  const SORT_RETRY_MS = 3000;
  const SORT_MAX_ATTEMPTS = 3;
  const MAX_PAGES = 50;
  const VERSION = 1;
  const HISTORY_VERSION = 2;

  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const text = element => clean(element?.textContent);
  function cityKey(value) {
    const key = clean(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    return ['den haag', 'the hague', "'s-gravenhage", 's-gravenhage'].includes(key) ? 'den haag' : key;
  }
  const cityKeys = targets => [...new Set((Array.isArray(targets) ? targets : [targets]).map(cityKey))].sort();
  const matchesCity = (city, targets) => cityKeys(targets).includes(cityKey(city));
  const CITY_LABEL = TARGET_CITIES.join(', ');
  function money(value) {
    let number = clean(value).replace(/[€\s\u00a0]/g, '');
    if (!/^\d+(?:[.,]\d+)*$/.test(number)) return null;
    const comma = number.lastIndexOf(',');
    const dot = number.lastIndexOf('.');
    const last = Math.max(comma, dot);
    if (last >= 0 && number.length - last - 1 === 2) {
      const integer = number.slice(0, last);
      if (!/^\d{1,3}(?:[.,]\d{3})*$/.test(integer) && !/^\d+$/.test(integer)) return null;
      number = integer.replace(/[.,]/g, '') + '.' + number.slice(last + 1);
    } else if (last >= 0) {
      if (!/^\d{1,3}(?:[.,]\d{3})+$/.test(number)) return null;
      number = number.replace(/[.,]/g, '');
    }
    const result = Number(number);
    return Number.isFinite(result) && result >= 0 ? result : null;
  }
  function rentFromText(value) {
    const matches = [...clean(value).matchAll(/€\s*([\d.,\s]+?)\s*per month excl\.?\s*\*?/gi)];
    if (matches.length !== 1) throw Error('主租金标签缺失或不唯一，停止本轮扫描');
    const rent = money(matches[0][1]);
    if (rent === null || rent <= 0) throw Error('无法确认主租金');
    return rent;
  }
  function normalizeUrl(href, base = 'https://www.holland2stay.com/residences') {
    try {
      const url = new URL(href, base);
      if (!['holland2stay.com', 'www.holland2stay.com'].includes(url.hostname)) return null;
      if (url.protocol !== 'https:' || !/^\/residences\/[^/]+\.html$/.test(url.pathname)) return null;
      return 'https://www.holland2stay.com' + url.pathname;
    } catch { return null; }
  }
  function directStatus(value) {
    return /^(book directly|available to book)$/i.test(clean(value));
  }
  function cardsFromDocument(doc) {
    const known = [...doc.querySelectorAll('.residence_MainSection .residence_block')];
    if (known.length) return known;
    // Conservative fallback: the smallest ancestor with one heading and one rent label.
    const cards = new Set();
    for (const link of doc.querySelectorAll('a[href]')) {
      if (!normalizeUrl(link.getAttribute('href'))) continue;
      for (let el = link; el && el !== doc.body; el = el.parentElement) {
        const headings = el.querySelectorAll('h1,h2,h3,h4,h5,h6');
        const rentLabels = text(el).match(/per month excl/gi) || [];
        const titles = [...headings].filter(h => !/per month excl/i.test(text(h)));
        if (rentLabels.length > 1 || titles.length > 1) break;
        if (rentLabels.length === 1 && titles.length === 1) { cards.add(el); break; }
      }
    }
    return [...cards];
  }
  function parseCard(card) {
    const titleEl = card.querySelector('.residence_name') || [...card.querySelectorAll('h1,h2,h3,h4,h5,h6')].find(el => !/per month excl/i.test(text(el)));
    const title = text(titleEl);
    const split = title.lastIndexOf(',');
    if (split < 1) throw Error('房源标题中缺少城市，停止本轮扫描');
    const urls = [...new Set([...card.querySelectorAll('a[href]')].map(a => normalizeUrl(a.getAttribute('href'))).filter(Boolean))];
    if (urls.length !== 1) throw Error('房源卡片没有唯一的详情链接');
    const priceNodes = card.querySelectorAll('.price_text');
    if (priceNodes.length > 1) throw Error('同一卡片出现多个主租金');
    const rent = rentFromText(priceNodes.length ? text(priceNodes[0]) : text(card));
    const statusEl = card.querySelector('.booking_btn') || [...card.querySelectorAll('button')].find(el => /book|lottery|occupied/i.test(text(el)));
    const status = text(statusEl);
    if (!status) throw Error('房源状态未加载完整');
    return {url: urls[0], title, city: title.slice(split + 1).trim(), rent, status};
  }
  function pagination(doc) {
    const root = doc.querySelector('.residence_pagination');
    if (!root) return {current: 1, last: 1, next: null, first: null};
    const current = Number(text(root.querySelector('[aria-current="page"]')));
    const pageLinks = [...root.querySelectorAll('a')].filter(a => /^\d+$/.test(text(a)));
    const last = Math.max(1, ...pageLinks.map(a => Number(text(a))));
    const next = root.querySelector('[aria-label="Next page"]');
    const disabled = next?.getAttribute('aria-disabled') === 'true' || next?.parentElement?.classList.contains('disabled');
    if (!Number.isInteger(current) || current < 1) throw Error('无法识别当前页码');
    return {current, last, next: disabled ? null : next, first: pageLinks.find(a => text(a) === '1') || null};
  }
  function parsePage(doc) {
    const count = text(doc.querySelector('.total_residence .count'));
    if (!/^\d+$/.test(count)) throw Error('房源总数尚未加载');
    const listings = cardsFromDocument(doc).map(parseCard);
    const total = Number(count);
    if (total > 0 && !listings.length) throw Error('列表尚未加载，不能当成零房源');
    if (total === 0 && listings.length) throw Error('总数与卡片不一致，等待页面更新');
    if (!doc.querySelector('.residence_MainSection')) throw Error('无法确认房源列表区域');
    return {listings, total, page: pagination(doc)};
  }
  function filterState(doc) {
    const root = doc.querySelector('.selected_filter [aria-label="Current Filters"]');
    if (!root) return {ok: false, city: '', cities: [], wanted: false, reason: '等待官网城市筛选加载'};
    // H2S renders its Clear all filters action as a sibling <li> of the selected
    // filters. It is a control, not an additional filter or a selected city.
    const filterList = root.cloneNode(true);
    filterList.querySelectorAll('.clear_filter,[data-cy="FilterSidebar-clearButton"]').forEach(node => node.remove());
    const nameOf = value => clean(value).replace(/^(?:apply|remove) filter\s+(.+)\.$/i, '$1')
      .replace(/\s*[×✕]\s*$/, '').replace(/\s+(?:remove|clear)(?:\s+filter)?$/i, '')
      .replace(/^(?:city|availability)(?:\s*[:：-]\s*|\s+)/i, '').replace(/\s*\(\s*\d+\s*\)\s*$/, '').trim();
    const selected = input => input.checked === true || (typeof input.checked !== 'boolean' && input.hasAttribute('checked'));
    const cityRoot = doc.querySelector('[aria-label="Filter products by City"]');
    const availabilityRoot = doc.querySelector('[aria-label="Filter products by Availability"]');
    const inputs = [...(cityRoot?.querySelectorAll('input[type="checkbox"],input[type="radio"]') || [])];
    const availabilityInputs = [...(availabilityRoot?.querySelectorAll('input[type="checkbox"],input[type="radio"]') || [])];
    const optionName = input => nameOf(input.getAttribute('title') || input.getAttribute('aria-label') ||
      text(input.closest('label')) || (input.id && text([...doc.querySelectorAll('label')].find(label => label.htmlFor === input.id))) ||
      (/^[a-z]/i.test(input.value || '') && input.value !== 'on' ? input.value : ''));
    const checked = inputs.filter(selected);
    const checkedNames = checked.map(optionName).filter(Boolean);
    const options = new Set(inputs.map(optionName).filter(Boolean).map(cityKey));
    const availabilityName = name => directStatus(name) ? 'Available to book'
      : /^available in lottery$/i.test(name) ? 'Available in lottery' : /^occupied$/i.test(name) ? 'Occupied' : '';
    const chips = [...filterList.children].map(node => {
      const copy = node.cloneNode(true);
      copy.querySelectorAll('svg,[aria-hidden="true"]').forEach(el => el.remove());
      copy.querySelectorAll('button,a,[role="button"]').forEach(el => {
        if (/^(?:[×✕x]|remove|clear)?$/i.test(text(el))) el.remove();
      });
      const label = text(copy);
      const name = nameOf(label);
      // Chips share one list, but their meanings do not. Only positive City
      // evidence makes a city; never reinterpret unknown filters as city names.
      const kind = availabilityName(name) || /^availability(?:\s*[:：-]|\s+)/i.test(label) ? 'availability'
        : /^city(?:\s*[:：-]|\s+)/i.test(label) || matchesCity(name, TARGET_CITIES) || options.has(cityKey(name)) ? 'city' : 'other';
      return {name, kind};
    }).filter(chip => chip.name);
    const names = [...new Map([...checkedNames, ...chips.filter(chip => chip.kind === 'city').map(chip => chip.name)]
      .map(name => [cityKey(name), name])).values()];
    const checkedAvailability = availabilityInputs.filter(selected);
    const checkedAvailabilityNames = checkedAvailability.map(optionName).filter(Boolean);
    const availabilityNames = [...new Set([...checkedAvailabilityNames, ...chips.filter(chip => chip.kind === 'availability').map(chip => chip.name)]
      .map(name => availabilityName(name) || name))];
    const availability = availabilityNames.join(', ');
    const city = names.length === 1 ? names[0] : '';
    const allCities = names.length === 0;
    const wanted = allCities || names.every(name => matchesCity(name, TARGET_CITIES));
    const otherInputs = [...doc.querySelectorAll('[aria-label^="Filter products by "] input[type="checkbox"], [aria-label^="Filter products by "] input[type="radio"]')]
      .some(input => selected(input) && !cityRoot?.contains(input) && !availabilityRoot?.contains(input));
    const otherChips = chips.filter(chip => chip.kind === 'other');
    let reason = '';
    if (checked.length !== checkedNames.length) reason = '无法识别选中的城市名称；请展开 City 筛选';
    else if (names.length > 1) reason = '一次只扫描一个城市；请只保留一个 City 选项';
    else if (!wanted) reason = '当前城市不在目标五城中，不开始扫描';
    else if (checkedAvailability.length !== checkedAvailabilityNames.length) reason = '无法识别可订状态；请展开 Availability 筛选';
    else if (availabilityNames.length > 1 || (availability && availability !== 'Available to book')) reason = 'Availability 请只选择 Available to book，或清除可订状态筛选';
    else if (otherInputs || otherChips.length || (text(filterList) && !chips.length)) reason = '请清除其他网页筛选；可保留一个目标 City 和 Available to book'
      + (otherChips.length ? '；未支持的筛选：' + otherChips.map(chip => chip.name).join(', ') : '');
    return {ok: !reason, city, cities: names, wanted, allCities, availability, reason};
  }
  // Site convention explicitly chosen by the user: both bare sort labels are
  // ascending. Only Price can justify a rent-budget cutoff; date order cannot.
  const sortSelections = new WeakMap();
  function sortChoice(value) {
    const label = clean(String(value || '').replace(/[✓✔]/g, ''));
    const descending = /\bhigh(?:est)?\s*(?:to|[-–→])\s*low(?:est)?\b|\bdesc(?:ending)?\b|hoog.*laag|aflopend|↓/i.test(label);
    const price = /^(?:price|rent|prijs)$/i.test(label) ||
      (/\b(?:price|rent|prijs)\b/i.test(label) &&
       /\blow(?:est)?\s*(?:to|[-–→])\s*high(?:est)?\b|\basc(?:ending)?\b|laag.*hoog|oplopend|↑/i.test(label));
    if (descending) return {key: /\b(?:price|rent|prijs)\b/i.test(label) ? 'price' : 'other', ascending: false, label};
    if (price) return {key: 'price', ascending: true, label};
    if (/^available start date$/i.test(label)) return {key: 'date', ascending: true, label};
    return {key: 'other', ascending: false, label};
  }
  function isAscendingPrice(value) {
    const choice = sortChoice(value);
    return choice.key === 'price' && choice.ascending;
  }
  const isPriceChoice = isAscendingPrice;
  function sortContext(doc) {
    const filters = filterState(doc);
    return filters.ok ? JSON.stringify([filters.allCities ? '*' : cityKey(filters.city), filters.availability || '']) : null;
  }
  function forgetPriceSort(doc) { sortSelections.delete(doc); }
  function visibleSortNode(doc, node) {
    if (!node) return false;
    const getStyle = doc.defaultView?.getComputedStyle;
    for (let el = node; el; el = el.parentElement) {
      if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true' ||
          el.style?.display === 'none' || ['hidden', 'collapse'].includes(el.style?.visibility)) return false;
      if (getStyle) {
        const css = getStyle.call(doc.defaultView, el);
        if (css.display === 'none' || ['hidden', 'collapse'].includes(css.visibility)) return false;
      }
    }
    return true;
  }
  function priceSortState(doc) {
    const root = [...doc.querySelectorAll('[data-cy="ProductSort-root"]')].find(node => visibleSortNode(doc, node));
    const button = [...(root?.querySelectorAll('[data-cy="ProductSort-sortButton"]') || [])].find(node => visibleSortNode(doc, node));
    const chosen = [...(root?.querySelectorAll('[data-cy="SortItem-activeButton"]') || []),
      ...(root?.querySelectorAll('[aria-selected="true"],[aria-checked="true"],input:checked') || [])].find(node => visibleSortNode(doc, node));
    const context = sortContext(doc);
    const cached = sortSelections.get(doc);
    if (!root || context === null || (cached && (cached.root !== root || cached.context !== context))) forgetPriceSort(doc);
    const busy = root?.getAttribute('aria-busy') === 'true';
    const activeLabel = chosen ? text(chosen.closest('label')) || text(chosen) || chosen.getAttribute('aria-label') : '';
    const triggerLabel = text(button);
    const label = activeLabel || triggerLabel;
    const choice = sortChoice(label);
    let selection = null;
    // Actual active options always override a stale trigger or cached selection.
    // A click alone is never proof: the menu is reopened to read its active item.
    if (chosen || choice.key !== 'other' || (label && !/^sort\s*(?:\.{3}|…)?$/i.test(label))) {
      selection = {...choice, root, context, source: chosen ? 'active-option' : 'trigger'};
      if (!busy && root && context !== null) sortSelections.set(doc, selection);
    } else if (root && context !== null) {
      const remembered = sortSelections.get(doc);
      if (remembered) selection = {...remembered, source: 'verified-menu-cache'};
    }
    const selected = selection?.key === 'price' && selection.ascending;
    return {ok: Boolean(root && !busy && selected), selected: Boolean(selected), busy,
      choice: selection?.key || '', ascending: Boolean(selection?.ascending),
      source: selection?.source || '', activeLabel, triggerLabel, button, root};
  }
  function sortOptions(doc, sorting = priceSortState(doc)) {
    const candidates = [...(sorting.root?.querySelectorAll('button[data-cy="SortItem-button"],button[data-cy="SortItem-activeButton"]') || []),
      ...(sorting.root?.querySelectorAll('button,a,[role="option"],[role="menuitem"],label') || []),
      ...doc.querySelectorAll('[role="listbox"] [role="option"],[role="menu"] [role="menuitem"]'),
      ...[...(sorting.root?.querySelectorAll('li') || [])].filter(node => !node.querySelector('button,a,[role="option"],[role="menuitem"],label'))];
    return [...new Set(candidates)].filter(node => {
      if (node === sorting.button || sorting.button?.contains(node) || !visibleSortNode(doc, node) ||
          node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true') return false;
      return isPriceChoice(text(node)) || /^available start date$/i.test(text(node));
    });
  }
  function pressSortOption(button) {
    // This exact combination worked on the user's live page when button.click()
    // did not: focus, the inner label as target, coordinates, and press/release
    // events. We have not isolated which difference the site requires.
    const target = button.querySelector('span') || button;
    const rect = target.getBoundingClientRect();
    const view = button.ownerDocument.defaultView;
    const init = {
      bubbles: true, cancelable: true, composed: true,
      view, button: 0, detail: 1,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      pointerId: 1, pointerType: 'mouse', isPrimary: true
    };
    button.focus({preventScroll: true});
    for (const [type, EventClass, buttons] of [
      ['pointerdown', view.PointerEvent, 1],
      ['mousedown', view.MouseEvent, 1],
      ['pointerup', view.PointerEvent, 0],
      ['mouseup', view.MouseEvent, 0],
      ['click', view.PointerEvent, 0]
    ]) {
      target.dispatchEvent(new EventClass(type, {...init, buttons}));
    }
    // Dispatching events is not confirmation; ensurePriceSort reads the site's
    // selected option or title on the next iteration before allowing a scan.
  }
  function challenge(doc) {
    // A normal embedded Turnstile widget or the word "Cloudflare" is NOT a challenge page.
    if (doc.querySelector('#challenge-running,#challenge-stage,#challenge-form,#cf-error-details')) return true;
    const prominent = [doc.title, ...[...doc.querySelectorAll('h1,h2')].map(text)].join(' ');
    if (/just a moment|checking your browser|verify you are human|403 forbidden|access denied|attention required/i.test(prominent)) return true;
    if (doc.querySelector('.residence_MainSection')) return false;
    const body = text(doc.body).slice(0, 5000);
    return /verify you are human|checking your browser|sorry, you have been blocked|403 forbidden/i.test(body);
  }
  function withinHours(date = new Date()) {
    const hour = Number(new Intl.DateTimeFormat('en-GB', {timeZone: TIME_ZONE, hour: '2-digit', hourCycle: 'h23'}).format(date));
    return hour >= START_HOUR && hour < END_HOUR;
  }
  function validateSweep(listings, total, city) {
    if (new Set(listings.map(item => item.url)).size !== total || listings.length !== total) throw Error('分页结果不完整或重复；本轮不更新历史');
    if (city && listings.some(item => !matchesCity(item.city, city))) throw Error('房源城市与所选城市不一致；本轮不更新历史');
  }
  function validateBudgetSweep(listings, total, maxRent, city, ended) {
    if (new Set(listings.map(item => item.url)).size !== listings.length || listings.length > total) throw Error('分页重复或数量不一致；本轮不更新历史');
    if (city && listings.some(item => !matchesCity(item.city, city))) throw Error('房源城市与所选城市不一致；本轮不更新历史');
    if (listings.some((item, index) => index && item.rent < listings[index - 1].rent)) throw Error('Price 列表实际不是价格升序；本轮不更新历史');
    const cutoff = listings.some(item => item.rent > maxRent);
    if (!cutoff && (!ended || listings.length !== total)) throw Error('预算内分页尚未完成；本轮不更新历史');
    return {cutoff};
  }
  const cityScope = city => 'selected-city-v1:' + cityKey(city);
  function freshState(scope) { return {version: VERSION, scope, initialized: false, items: {}, sent: 0}; }
  function historyFrom(previous) {
    if (previous?.version === HISTORY_VERSION && previous.cities) return JSON.parse(JSON.stringify(previous));
    const history = {version: HISTORY_VERSION, cities: {}, sent: previous?.sent || 0};
    // Import v1.0–v1.2 records without resending successes or dropping unsent listings.
    if (previous?.version === VERSION && previous.items) {
      for (const old of Object.values(previous.items)) {
        if (!old.city) continue;
        const key = cityKey(old.city);
        const state = history.cities[key] ||= freshState(cityScope(key));
        state.initialized = Boolean(previous.initialized);
        state.lastCompleteScan = previous.lastCompleteScan;
        state.items[old.url] = JSON.parse(JSON.stringify(old));
        if (old.lastNotified != null) state.sent++;
      }
    }
    return history;
  }
  function reconcile(previous, listings, scope, target, maxRent, now, {silentBaseline = false} = {}) {
    const state = previous?.version === VERSION && previous.scope === scope ? JSON.parse(JSON.stringify(previous)) : freshState(scope);
    const baseline = !state.initialized;
    const skipInitial = baseline && silentBaseline;
    const observed = new Set(listings.map(item => item.url));
    for (const item of listings) {
      const old = state.items[item.url];
      const eligible = matchesCity(item.city, target) && item.rent <= maxRent && directStatus(item.status);
      let reason = null;
      if (eligible && !skipInitial) {
        if (!old) reason = baseline ? '首次发现符合条件' : '新房源';
        else if (old.missing >= 2) reason = '重新出现，可直接预订';
        else if (!old.eligible) reason = old.rent > maxRent ? '降价进入预算' : '变为可直接预订';
        else if (item.rent < old.rent) reason = '主租金下降';
        // Older versions silently recorded the first scan. Notify those never sent,
        // while preserving successful deliveries and explicit silent-reset choices.
        else if (old.lastNotified == null && !old.initialNoticeSkipped && !old.pending) reason = '首次通知';
      }
      state.items[item.url] = {...old, ...item, eligible, missing: 0, lastSeen: now,
        ...(skipInitial && eligible ? {initialNoticeSkipped: true} : {}),
        pending: skipInitial || !eligible ? null : reason ? {reason, detectedAt: now} : old?.pending || null};
    }
    for (const [url, item] of Object.entries(state.items)) {
      if (!observed.has(url)) { item.missing = (item.missing || 0) + 1; item.pending = null; }
    }
    state.initialized = true;
    state.lastCompleteScan = now;
    return {state, baseline};
  }
  async function deliverPending(state, send, save, allowed = () => true, now = Date.now) {
    let sent = 0;
    for (const item of Object.values(state.items)) {
      if (!allowed()) break;
      if (!item.pending || !item.eligible || item.missing) continue;
      // Only a confirmed Telegram success clears pending. Failure leaves it retryable.
      await send(item);
      item.lastNotified = now();
      item.pending = null;
      state.sent = (state.sent || 0) + 1;
      save(state, item);
      sent++;
    }
    return sent;
  }

  // The userscript is also directly importable by the offline regression tests.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {cityKey, cityKeys, matchesCity, money, rentFromText, normalizeUrl, directStatus, parseCard, parsePage, pagination,
      filterState, sortChoice, isAscendingPrice, isPriceChoice, priceSortState, forgetPriceSort, sortOptions, challenge, withinHours, validateSweep, validateBudgetSweep,
      cityScope, historyFrom, freshState, reconcile, deliverPending};
    return;
  }
  if (!/^\/residences\/?$/.test(location.pathname)) return; // Never run on a booking/detail page.

  const key = name => STORAGE_PREFIX + ':' + name;
  const get = (name, fallback) => GM_getValue(key(name), fallback);
  const set = (name, value) => GM_setValue(key(name), value);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const formatTime = value => value ? new Intl.DateTimeFormat('zh-CN', {timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'}).format(new Date(value)) : '—';
  let scanRunning = false;
  let deliveryRunning = false;
  let deliveryContext = null;
  let isLeader = false;
  let nextRefresh = 0;
  let retryAt = 0;
  let dirty = true;
  let lastScope = '';
  let nextTelegramAttempt = 0;
  let retryNoticeAt = 0;
  let daytime = withinHours();
  let maintenanceUntil = 0;
  const stats = {message: '正在启动', phase: '未开始', sortStep: '', mode: '', scope: '', scanned: 0, matched: 0, pages: 0, telegram: '未配置', sent: 0};
  const panel = document.createElement('aside');
  panel.id = 'h2s-monitor-panel';
  Object.assign(panel.style, {position: 'fixed', right: '16px', bottom: '84px', zIndex: 2147483646, padding: '14px 16px',
    width: '300px', maxWidth: '80vw', background: '#102c32', color: '#efffff', font: '13px/1.6 system-ui,sans-serif',
    border: '1px solid #75c8d2', borderRadius: '12px', boxShadow: '0 6px 28px #0005', whiteSpace: 'pre-wrap'});
  document.body.append(panel);
  const panelText = document.createElement('div');
  const checkButton = document.createElement('button');
  checkButton.id = 'h2s-monitor-check';
  checkButton.type = 'button';
  checkButton.textContent = '立即检查（夜间也可运行）';
  Object.assign(checkButton.style, {display: 'block', marginTop: '10px', padding: '6px 10px',
    border: '1px solid #75c8d2', borderRadius: '6px', background: '#17434b', color: '#efffff', cursor: 'pointer'});
  checkButton.addEventListener('click', safe(async () => { requireIdle(); await runScan(true); }));
  panel.append(panelText, checkButton);
  function configured() { return Boolean(get('token', '') && get('chatId', '')); }
  const readHistory = () => historyFrom(get('state', null));
  const targetsFor = filters => filters.allCities ? TARGET_CITIES : filters.city ? [filters.city] : [];
  const scopeFor = filters => JSON.stringify(['price-asc-v1', filters.allCities ? '*' : cityKey(filters.city), MAX_RENT,
    ...(filters.availability ? ['availability:' + filters.availability] : [])]);
  const queuedItems = (history, filters) => Object.values(history.cities).flatMap(state => Object.values(state.items))
    .filter(item => item.pending && item.eligible && !item.missing && item.rent <= MAX_RENT && matchesCity(item.city, targetsFor(filters)));
  function sortingStatus(sorting, mode, filters) {
    if (mode === 'single') return '当前仅一页，无需排序';
    if (sorting.ok) return 'Price · 从低到高';
    if (!isLeader) return '尚未操作：等待此标签页取得监控锁';
    if (get('paused', false)) return '尚未操作：监控已手动暂停';
    if (challenge(document)) return '尚未操作：等待手动完成网页验证';
    if (!filters.ok) return '尚未操作：筛选条件未通过';
    if (!scanRunning && !withinHours()) return '夜间不自动选择；可点下方“立即检查”';
    if (Date.now() < maintenanceUntil) return '尚未操作：等待手动操作稳定';
    if (sorting.busy) return '正在加载：等待官网完成排序或翻页';
    if (stats.sortStep && stats.scope === scopeFor(filters)) {
      return stats.sortStep === 'Price · 从低到高' ? 'Price 状态已变化，等待重新确认' : stats.sortStep;
    }
    if (scanRunning) return '尚未操作：先等待房源列表稳定';
    if (stats.phase === '扫描未完成') return '尚未操作：本轮在排序前停止，见下方原因';
    return '尚未开始；扫描启动后自动选择 Price';
  }
  function render() {
    const filters = filterState(document);
    const history = readHistory();
    const sameScope = filters.ok && stats.scope === scopeFor(filters);
    const previous = filters.ok ? history.scans?.[scopeFor(filters)] : null;
    const pending = filters.ok ? queuedItems(history, filters).length : 0;
    const others = Object.values(history.cities).flatMap(state => Object.values(state.items)).filter(item => item.pending && item.eligible && !item.missing).length - pending;
    const sorting = priceSortState(document);
    const mode = sameScope ? stats.mode : previous?.mode;
    panelText.textContent = ['H2S v1.3.8 · 预算内扫描 · 主租金 ≤ €' + MAX_RENT,
      '当前城市：' + (filters.allCities ? '全部城市（本地筛选五城）' : filters.cities.join(', ') || '尚未识别'),
      '可订状态：' + (filters.availability || '未筛选（仅通知可直接预订）'),
      '目标城市：' + (filters.allCities ? '仅通知 ' + CITY_LABEL : filters.wanted ? '是，属于目标五城' : '否 / 尚未确认'),
      '筛选条件：' + (filters.ok ? '通过' : '未通过；' + filters.reason),
      '价格排序：' + sortingStatus(sorting, mode, filters),
      ...(mode === 'city' ? ['扫描方式：读完当前城市全部页，再按预算筛选'] : []),
      '扫描状态：' + (isLeader ? stats.phase : '待机，另一个标签页正在监控'), stats.message,
      '已读 ' + (sameScope ? stats.scanned : previous?.inspected || 0) + ' 套 · 符合 ' + (sameScope ? stats.matched : previous?.matched || 0) + ' 套 · 第 ' + (sameScope ? stats.pages : previous?.pages || 0) + ' 页',
      '本轮已发 ' + (sameScope ? stats.sent : 0) + ' · 当前范围待发 ' + pending + ' · 累计 ' + history.sent,
      ...(others > 0 ? ['其他城市 / 范围待复查 ' + others + ' 条'] : []),
      'Telegram：' + (configured() ? stats.telegram === '未配置' ? '已配置' : stats.telegram : '未配置（菜单设置）'),
      '上次扫描终点：' + (previous ? previous.cutoff ? '超出预算，已停止翻页' : '已到最后一页' : '尚未完成'),
      '上次完成预算内扫描 ' + formatTime(previous?.completedAt),
      '下次刷新 ' + formatTime(filters.ok && lastScope === scopeFor(filters) ? nextRefresh : 0),
      '自动运行 ' + String(START_HOUR).padStart(2, '0') + ':00–' + String(END_HOUR).padStart(2, '0') + ':00 荷兰时间'].join('\n');
    checkButton.disabled = !isLeader || scanRunning || deliveryRunning || get('paused', false) || !filters.ok || challenge(document);
    checkButton.style.opacity = checkButton.disabled ? '0.55' : '1';
  }
  function setMessage(message) { stats.message = message; render(); }
  function setStatus(phase, message) { stats.phase = phase; setMessage(message); }
  function scheduleRefresh() { nextRefresh = Date.now() + (REFRESH_MINUTES[0] + Math.random() * (REFRESH_MINUTES[1] - REFRESH_MINUTES[0])) * 60000; }
  function filtersFingerprint() {
    return scopeFor(filterState(document));
  }
  function assertRunning(manual, sending = false) {
    if (!isLeader || get('paused', false)) throw Error('监控已暂停');
    if (challenge(document)) throw Error('检测到验证页面，已停止操作');
    if (!manual && !withinHours()) throw Error('已进入夜间暂停时段');
    if (!sending && Date.now() < maintenanceUntil) throw Error('检测到手动操作，等待 30 秒后继续扫描');
  }
  function assertScope(scope, manual, sending = false) {
    assertRunning(manual, sending);
    const filters = filterState(document);
    if (!filters.ok) throw Error(filters.reason);
    if (filtersFingerprint() !== scope) throw Error('筛选条件已改变；本轮已取消');
  }
  function assertAllowed(scope, manual, requireAscending = false) {
    assertScope(scope, manual);
    const sorting = priceSortState(document);
    // Busy is transient during React pagination; stablePage waits for it to clear.
    if (requireAscending && !sorting.ok && !sorting.busy) throw Error('Price 排序发生变化；本轮预算截断扫描已取消');
  }
  async function ensurePriceSort(scope, manual) {
    const initial = priceSortState(document);
    if (initial.ok) return initial;
    stats.sortStep = '正在准备 Price 排序';
    setStatus('准备排序', '正在选择 Price（从低到高）');
    const start = Date.now();
    let attempts = 0;
    let lastClickAt = -Infinity;
    let lastOpenAt = -Infinity;
    let reason = '排序控件尚未加载';
    while (Date.now() - start < MAX_SETTLE_MS) {
      assertScope(scope, manual);
      const sorting = priceSortState(document);
      if (sorting.ok) { stats.sortStep = 'Price · 从低到高'; return sorting; }
      if (sorting.busy) {
        reason = '等待官网排序加载结束';
      } else {
        const options = sortOptions(document, sorting);
        const option = options.find(node => isPriceChoice(text(node)));
        const observed = (sorting.activeLabel || sorting.triggerLabel || '未识别').slice(0, 80);
        if (option && attempts < SORT_MAX_ATTEMPTS && Date.now() - lastClickAt >= SORT_RETRY_MS) {
          // Invalidate a previous Date selection before React handles the click.
          forgetPriceSort(document);
          pressSortOption(option);
          attempts++;
          lastClickAt = lastOpenAt = Date.now();
          reason = '已点击 Price（第 ' + attempts + '/' + SORT_MAX_ATTEMPTS + ' 次），等待官网确认选中';
        } else if (!options.length) {
          reason = !sorting.button ? '未找到 Sort 按钮，等待控件加载'
            : attempts ? '已点击 Price，重新展开菜单核对选中项' : '已尝试展开 Sort，等待 Price 选项出现';
          if (sorting.button && !sorting.button.disabled && sorting.button.getAttribute('aria-disabled') !== 'true' && Date.now() - lastOpenAt >= 1500) {
            // Selecting Price may immediately unmount the menu while the trigger
            // still says Sort ... . Reopen it and read SortItem-activeButton.
            sorting.button.click();
            lastOpenAt = Date.now();
          }
        } else {
          reason = attempts ? '已点击 Price ' + attempts + '/' + SORT_MAX_ATTEMPTS + ' 次；网页当前选中：' + observed +
            (attempts < SORT_MAX_ATTEMPTS ? '；等待确认，未生效将重试' : '；仍未确认 Price，已停止重试')
            : 'Sort 菜单中未找到可用的 Price 选项';
        }
      }
      stats.sortStep = reason;
      setMessage(reason + '（已等待 ' + Math.floor((Date.now() - start) / 1000) + ' 秒 / 最多 ' + MAX_SETTLE_MS / 1000 + ' 秒）');
      await sleep(500);
    }
    const final = priceSortState(document);
    stats.sortStep = final.ok ? 'Price · 从低到高' : '未能选中 Price：' + reason;
    return {...final, reason};
  }
  function fingerprint(result) {
    return JSON.stringify([result.total, result.page.current, result.page.last, result.listings.map(item => [item.url, item.rent, item.status])]);
  }
  async function stablePage(scope, manual, expectedPage, oldSignature = null, requireAscending = false) {
    const start = Date.now();
    let previous = null, stable = 0, lastError = '等待房源加载';
    while (Date.now() - start <= MAX_SETTLE_MS) {
      assertAllowed(scope, manual, requireAscending);
      try {
        if (priceSortState(document).root?.getAttribute('aria-busy') === 'true') throw Error('等待排序加载');
        const result = parsePage(document);
        const currentFilters = filterState(document);
        const selectedCity = currentFilters.city;
        if (selectedCity && result.listings.some(item => !matchesCity(item.city, selectedCity))) throw Error('等待列表切换到所选城市');
        if (currentFilters.availability === 'Available to book' && result.listings.some(item => !directStatus(item.status))) throw Error('等待列表切换到 Available to book');
        if (requireAscending && result.listings.some((item, index) => index && item.rent < result.listings[index - 1].rent)) throw Error('等待价格升序生效');
        const signature = fingerprint(result);
        const correctPage = !expectedPage || result.page.current === expectedPage;
        const changed = oldSignature === null || signature !== oldSignature;
        if (correctPage && changed) {
          stable = signature === previous ? stable + 1 : 1;
          previous = signature;
          if (Date.now() - start >= MIN_SETTLE_MS && stable >= 3) return result;
          lastError = '等待房源列表稳定';
        } else { stable = 0; lastError = '正在等待分页内容更新'; }
      } catch (error) { stable = 0; lastError = error.message; }
      setMessage(lastError + '（已等待 ' + Math.floor((Date.now() - start) / 1000) + ' 秒 / 最多 ' + MAX_SETTLE_MS / 1000 + ' 秒）');
      await sleep(1000);
    }
    throw Error(lastError + '；本轮未完成，后续页面变化会重试');
  }
  async function telegram(method, payload) {
    const token = get('token', '');
    if (!/^\d+:[\w-]{20,}$/.test(token)) throw Error('请先在菜单配置 Telegram Token');
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({method: 'POST', url: 'https://api.telegram.org/bot' + token + '/' + method,
        headers: {'Content-Type': 'application/json'}, data: JSON.stringify(payload), anonymous: true, timeout: 15000,
        onload(response) {
          let body;
          try { body = JSON.parse(response.responseText); } catch { reject(Error('Telegram 返回无法解析的响应')); return; }
          if (response.status === 200 && body.ok === true) resolve(body.result);
          else {
            const error = Error('Telegram HTTP ' + response.status + '；请核对配置或稍后重试');
            error.retryAfter = Number(body.parameters?.retry_after) || 60;
            reject(error);
          }
        },
        onerror: () => reject(Error('Telegram 网络错误，通知保留待重试')),
        ontimeout: () => reject(Error('Telegram 超时，通知保留待重试')),
        onabort: () => reject(Error('Telegram 请求中止，通知保留待重试'))});
    });
  }
  async function sendText(message) {
    const chatId = get('chatId', '');
    if (!/^-?\d+$/.test(String(chatId))) throw Error('请先配置 Telegram Chat ID');
    await telegram('sendMessage', {chat_id: chatId, text: message, link_preview_options: {is_disabled: true}});
  }
  function listingMessage(item) {
    return ['H2S · ' + item.pending.reason, item.title, '城市：' + item.city,
      '主租金：€' + item.rent.toFixed(2) + '/月（不含 servicekosten 等额外费用）',
      '状态：' + item.status, '检测：' + new Intl.DateTimeFormat('zh-CN', {timeZone: TIME_ZONE, dateStyle: 'short', timeStyle: 'medium'}).format(new Date(item.pending.detectedAt)),
      item.url].join('\n');
  }
  async function notifyBlock() {
    nextRefresh = 0;
    setStatus('验证暂停', '遇到验证/访问受阻，请在当前页手动处理；自动刷新已停');
    const incident = get('incident', null) || {started: Date.now(), sent: false};
    set('incident', incident);
    if (incident.sent || !configured() || Date.now() < retryNoticeAt) return;
    retryNoticeAt = Date.now() + 60000;
    try {
      await sendText('H2S · ' + CITY_LABEL + '\n监控遇到验证或访问受阻，已暂停自动刷新。请在运行脚本的浏览器中手动处理。\n' + location.origin + location.pathname);
      incident.sent = true;
      set('incident', incident);
    } catch { stats.telegram = '验证提醒发送失败，稍后重试'; render(); }
  }
  async function flushPending(context) {
    if (deliveryRunning || !configured() || Date.now() < nextTelegramAttempt) return;
    const filters = filterState(document);
    const history = readHistory();
    const queue = queuedItems(history, filters);
    if (!queue.length) { deliveryContext = null; return; }
    const state = {items: Object.fromEntries(queue.map(item => [item.url, item])), sent: history.sent};
    deliveryRunning = true;
    setStatus('通知发送中（扫描已完成）', '逐条发送已确认房源；当前范围待发 ' + queue.length + ' 条');
    try {
      await deliverPending(state, async item => {
        await sleep(1100);
        // Pagination clicks do not invalidate an already verified snapshot. Changing
        // the selected city, pausing, or encountering a challenge still stops delivery.
        assertScope(context.scope, context.manual, true);
        try { await sendText(listingMessage(item)); }
        catch (error) { error.telegramFailure = true; throw error; }
        stats.telegram = '发送成功';
        nextTelegramAttempt = 0;
      }, (value, item) => {
        const latest = readHistory();
        const city = latest.cities[cityKey(item.city)];
        city.items[item.url] = item;
        city.sent = (city.sent || 0) + 1;
        latest.sent++;
        set('state', latest);
        stats.sent++;
        render();
      }, () => { assertScope(context.scope, context.manual, true); return true; });
      deliveryContext = null;
      setStatus('本轮已完成', '预算内扫描完成；本轮已发 ' + stats.sent + ' 条');
    } catch (error) {
      if (error.telegramFailure) {
        nextTelegramAttempt = Date.now() + Math.max(60, error.retryAfter || 60) * 1000;
        stats.telegram = error.message;
        setStatus('通知等待重试（扫描已完成）', '待发记录已保留；最早重试 ' + formatTime(nextTelegramAttempt));
      } else {
        deliveryContext = null;
        setStatus('通知已暂停（扫描已完成）', error.message + '；待发记录已保留');
      }
    } finally { deliveryRunning = false; render(); }
  }
  async function runScan(manual = false) {
    if (scanRunning || deliveryRunning || !isLeader || get('paused', false)) return;
    if (challenge(document)) { await notifyBlock(); return; }
    const filters = filterState(document);
    if (!filters.ok) { nextRefresh = 0; setStatus('未开始', filters.reason); return; }
    if (!manual && !withinHours()) { nextRefresh = 0; setStatus('夜间暂停', '菜单可手动立即检查'); return; }
    scanRunning = true;
    dirty = false;
    deliveryContext = null;
    const scope = scopeFor(filters);
    const targets = targetsFor(filters);
    Object.assign(stats, {scope, mode: '', sortStep: '', sent: 0, scanned: 0, matched: 0, pages: 0});
    lastScope = scope;
    try {
      while (manual && Date.now() < maintenanceUntil) {
        assertScope(scope, manual, true);
        setStatus('已开始，等待手动操作稳定', '还有约 ' + Math.ceil((maintenanceUntil - Date.now()) / 1000) + ' 秒，然后自动扫描');
        await sleep(Math.min(1000, maintenanceUntil - Date.now()));
      }
      assertScope(scope, manual);
      setStatus('已开始，等待列表稳定', '正在确认当前城市、房源数量和分页');
      let result = await stablePage(scope, manual);
      const singlePage = page => page.page.current === 1 && page.page.last === 1 && !page.page.next;
      let mode = 'single';
      if (!singlePage(result)) {
        const sorting = await ensurePriceSort(scope, manual);
        if (!sorting.ok && filters.allCities) {
          throw Error('未能选中 Price：' + sorting.reason + '；请手动展开 Sort 选择 Price 后点击“立即检查”');
        }
        mode = sorting.ok ? 'budget' : 'city';
        setStatus('已开始，等待列表稳定', mode === 'budget' ? '已选择 Price 升序，遇到主租金 > €' + MAX_RENT + ' 后停止翻页'
          : '未确认升序，将读取 ' + filters.city + ' 的全部页，再按预算筛选');
        result = await stablePage(scope, manual, undefined, null, mode === 'budget');
        if (singlePage(result)) mode = 'single';
      }
      stats.mode = mode;
      const useCutoff = mode === 'budget';
      if (result.page.current !== 1) {
        if (!result.page.first) throw Error('找不到第 1 页，无法确认预算内房源完整');
        const old = fingerprint(result);
        result.page.first.click();
        result = await stablePage(scope, manual, 1, old, useCutoff);
      }
      const total = result.total;
      const listings = [];
      for (let n = 1; n <= MAX_PAGES; n++) {
        assertAllowed(scope, manual, useCutoff);
        if (result.total !== total || result.page.current !== n) throw Error('分页期间结果总数或页码变化；本轮不更新历史');
        if (useCutoff && listings.length && result.listings.length && result.listings[0].rent < listings[listings.length - 1].rent) throw Error('跨页价格未按升序排列；本轮不更新历史');
        listings.push(...result.listings);
        stats.scanned = listings.length;
        stats.matched = listings.filter(item => matchesCity(item.city, targets) && item.rent <= MAX_RENT && directStatus(item.status)).length;
        stats.pages = n;
        setStatus('扫描中', '正在读取第 ' + n + ' 页；当前列表共 ' + total + ' 套');
        if ((useCutoff && result.listings.some(item => item.rent > MAX_RENT)) || !result.page.next) break;
        if (n === MAX_PAGES) throw Error('超过分页上限；本轮不更新历史');
        const old = fingerprint(result);
        result.page.next.click();
        result = await stablePage(scope, manual, n + 1, old, useCutoff);
      }
      let cutoff = false;
      if (useCutoff) ({cutoff} = validateBudgetSweep(listings, total, MAX_RENT, filters.city, !result.page.next));
      else validateSweep(listings, total, filters.city);
      assertAllowed(scope, manual, useCutoff);
      const history = readHistory();
      const requested = name => get(name, false) === true || get(name, false) === scope;
      const notifyExisting = requested('notifyExisting');
      const silentBaseline = requested('silentBaseline') && !notifyExisting;
      for (const city of targets) {
        const key = cityKey(city);
        const previous = history.cities[key];
        const rows = listings.filter(item => matchesCity(item.city, city));
        const {state} = reconcile(previous, rows, cityScope(city), city, MAX_RENT, Date.now(), {silentBaseline});
        if (notifyExisting) {
          for (const item of Object.values(state.items)) if (item.eligible && !item.missing) item.pending = {reason: '手动重新通知', detectedAt: Date.now()};
        }
        history.cities[key] = state;
      }
      history.scans ||= {};
      history.scans[scope] = {completedAt: Date.now(), inspected: listings.length, matched: stats.matched, pages: stats.pages, total, cutoff, mode};
      set('state', history);
      if (notifyExisting) set('notifyExisting', false);
      if (silentBaseline) set('silentBaseline', false);
      const completion = silentBaseline ? '已按选择建立静默记录；现有房源不通知'
        : cutoff ? '已到超预算位置，停止翻页；预算内扫描完成'
          : mode === 'single' ? '单页房源已完整读取；预算内扫描完成' : '已读到末页；预算内扫描完成';
      setStatus('扫描已完成', completion);
      if (queuedItems(history, filters).length) {
        deliveryContext = {scope, manual, expiresAt: Date.now() + 15 * 60000};
        await flushPending(deliveryContext);
      }
      if (withinHours()) scheduleRefresh();
      else nextRefresh = 0;
    } catch (error) {
      setStatus('扫描未完成', error.message);
      if (challenge(document)) await notifyBlock();
      retryAt = Math.max(Date.now() + 60000, maintenanceUntil);
      dirty = true;
    } finally { scanRunning = false; render(); }
  }
  async function tick() {
    if (!isLeader || scanRunning || deliveryRunning) return;
    if (get('paused', false)) { nextRefresh = 0; setStatus('手动暂停', '菜单可恢复'); return; }
    if (challenge(document)) { await notifyBlock(); return; }
    if (get('incident', null)) { set('incident', null); dirty = true; retryAt = 0; }
    const filters = filterState(document);
    if (!filters.ok) { deliveryContext = null; dirty = true; nextRefresh = 0; setStatus('未开始', filters.reason); return; }
    const scope = scopeFor(filters);
    if (lastScope && scope !== lastScope) { deliveryContext = null; dirty = true; retryAt = 0; nextRefresh = 0; }
    if (deliveryContext && Date.now() >= deliveryContext.expiresAt) {
      deliveryContext = null;
      dirty = true; // Recheck availability before retrying an old snapshot.
    }
    if (deliveryContext && configured() && (withinHours() || deliveryContext.manual)) {
      if (Date.now() >= nextTelegramAttempt) await flushPending(deliveryContext);
      if (deliveryContext) {
        setStatus('通知等待重试（扫描已完成）', '当前范围待发记录已保留；最早重试 ' + formatTime(nextTelegramAttempt));
        return;
      }
    }
    if (!withinHours()) { daytime = false; nextRefresh = 0; setStatus('夜间暂停', '菜单可手动立即检查；待发数量保留显示'); return; }
    if (!daytime) { daytime = true; location.reload(); return; }
    if (Date.now() < maintenanceUntil) { setStatus('等待手动操作结束', '30 秒观察期结束后继续扫描'); return; }
    if (nextRefresh && Date.now() >= nextRefresh) { location.reload(); return; }
    if (dirty && Date.now() >= retryAt) { await runScan(); return; }
    render();
  }
  function safe(callback) { return (...args) => { Promise.resolve().then(() => callback(...args)).catch(error => { setMessage(error.message); }); }; }
  function requireIdle() {
    if (!isLeader) throw Error('请使用正在监控的那个 H2S 标签页');
    if (scanRunning || deliveryRunning) throw Error('当前正在扫描或发送通知，请结束后再操作');
  }
  function requireFilters() {
    const filters = filterState(document);
    if (!filters.ok) throw Error(filters.reason);
    return filters;
  }
  function register(label, callback) { GM_registerMenuCommand(label, safe(callback)); }
  register('配置 Telegram Token', () => {
    const value = prompt('粘贴 BotFather 提供的 Token（仅保存到 Tampermonkey，不写入代码）。留空取消。');
    if (!value) return;
    if (!/^\d+:[\w-]{20,}$/.test(value.trim())) throw Error('Token 格式不正确');
    set('token', value.trim()); stats.telegram = 'Token 已保存'; render();
  });
  register('自动获取 Chat ID（配对）', async () => {
    const nonce = 'h2s-' + crypto.randomUUID().slice(0, 8);
    if (prompt('请在 Telegram 私聊你的机器人，发送下面这段配对文字。发送后点确定：', nonce) === null) return;
    const updates = await telegram('getUpdates', {limit: 100, timeout: 0});
    const matches = updates.map(update => update.message).filter(message => message?.chat?.type === 'private' && message.text?.trim() === nonce);
    const ids = [...new Set(matches.map(message => String(message.chat.id)))];
    if (ids.length !== 1) throw Error('未找到唯一配对消息，请重试；也可手动填写 Chat ID');
    set('chatId', ids[0]); stats.telegram = '配对成功'; dirty = true; render();
  });
  register('手动配置 Chat ID', () => {
    const value = prompt('输入接收通知的 Chat ID：', get('chatId', ''));
    if (!value) return;
    if (!/^-?\d+$/.test(value.trim())) throw Error('Chat ID 应为数字（群组可以是负数）');
    set('chatId', value.trim()); dirty = true; render();
  });
  register('测试 Telegram', async () => {
    await sendText('H2S 测试成功 · ' + CITY_LABEL + ' · 主租金 ≤ €' + MAX_RENT + '\n此消息只验证 Telegram 配置，不代表已发现新房源。');
    stats.telegram = '测试成功'; render();
  });
  register('立即检查（允许在夜间手动执行）', async () => { requireIdle(); await runScan(true); });
  register('暂停 / 恢复', () => { set('paused', !get('paused', false)); dirty = true; retryAt = 0; nextRefresh = 0; render(); });
  register('清除历史并重建基线（不通知现有房源）', () => {
    requireIdle();
    const filters = requireFilters();
    if (!confirm('清除当前扫描范围的房源历史，并跳过下次预算内扫描中现有房源的通知？')) return;
    const history = readHistory();
    for (const city of targetsFor(filters)) history.cities[cityKey(city)] = freshState(cityScope(city));
    history.scans = {};
    set('state', history); set('notifyExisting', false); set('silentBaseline', scopeFor(filters));
    deliveryContext = null; dirty = true; retryAt = 0;
  });
  register('重新通知当前符合条件的房源（强制重发）', () => {
    requireIdle();
    const filters = requireFilters();
    if (!configured()) throw Error('请先配置 Telegram');
    if (!confirm('下一次预算内扫描后，重新发送当前扫描范围内所有符合条件的房源？')) return;
    set('notifyExisting', scopeFor(filters)); set('silentBaseline', false); dirty = true; retryAt = 0;
  });
  register('查看历史', () => {
    const history = readHistory();
    const items = Object.values(history.cities).flatMap(state => Object.values(state.items)).sort((a, b) => b.lastSeen - a.lastSeen);
    alert(items.length ? items.slice(0, 100).map(item => item.title + '\n€' + item.rent + ' · ' + item.status + (item.pending ? ' · 待通知' : '') + '\n' + item.url).join('\n\n') : '暂无完整扫描历史');
  });
  register('测试 Cloudflare 提醒（仅发送测试消息）', async () => {
    await sendText('H2S 验证提醒测试 · ' + CITY_LABEL + '\n这是测试消息。真实遇到验证时，会停止自动刷新并等待你手动处理。');
    stats.telegram = '验证提醒测试成功'; render();
  });

  // Observe late cards and filter changes; ignore our own panel and pagination scan mutations.
  let debounce;
  const observer = new MutationObserver(records => {
    if (scanRunning || deliveryRunning || !isLeader) return;
    const meaningful = records.some(record => {
      const el = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      return el && !panel.contains(el) && !el.closest?.('#h2s-monitor-panel') &&
        (el.closest?.('.residence_MainSection,.selected_filter,.total_residence,#filter_accordion,[data-cy="ProductSort-root"]') || [...record.addedNodes].some(node => node.nodeType === 1 && node.matches?.('.residence_MainSection,.residence_block')));
    });
    if (meaningful) {
      clearTimeout(debounce);
      debounce = setTimeout(() => { dirty = true; retryAt = Math.min(retryAt, Date.now() + 2000); }, 1200);
    }
  });
  observer.observe(document.body, {childList: true, subtree: true, characterData: true});
  document.addEventListener('click', event => {
    const option = event.target.closest?.('button[data-cy="SortItem-button"],button[data-cy="SortItem-activeButton"],[role="option"],[role="menuitem"]');
    if (option && (option.closest('[data-cy="ProductSort-root"]') || option.closest('[role="listbox"],[role="menu"]'))) {
      forgetPriceSort(document);
    }
  }, true);
  document.addEventListener('change', event => {
    if (event.target.closest?.('#filter_accordion,[aria-label^="Filter products by "]')) {
      dirty = true; nextRefresh = 0; retryAt = Date.now() + 2000;
      if (event.isTrusted) maintenanceUntil = Date.now() + 30000;
      render();
    }
  });
  document.addEventListener('click', event => {
    if (event.isTrusted && event.target.closest?.('.residence_pagination,#filter_accordion,.selected_filter,[data-cy="ProductSort-root"]')) {
      maintenanceUntil = Date.now() + 30000;
      if (!deliveryRunning) dirty = true;
    }
  });
  render();
  if (!navigator.locks) { setMessage('此浏览器不支持 Web Locks；请使用更新的 Chrome、Edge 或 Firefox'); return; }
  setMessage('等待监控锁；同一配置只允许一个标签页运行');
  navigator.locks.request('h2s-monitor:' + STORAGE_PREFIX, async () => {
    isLeader = true;
    const interval = setInterval(safe(tick), 5000);
    await tick();
    await new Promise(resolve => window.addEventListener('pagehide', resolve, {once: true}));
    clearInterval(interval);
    observer.disconnect();
    isLeader = false;
  }).catch(error => setMessage('监控锁异常：' + error.message));
})();
