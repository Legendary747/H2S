// ==UserScript==
// @name         H2S — Den Haag housing monitor
// @namespace    https://github.com/Legendary747/H2S
// @homepageURL  https://github.com/Legendary747/H2S
// @license      MIT
// @version      1.4.0
// @description  Scan H2S with combined city filters by ascending Price, stop above the rent budget, and preserve resumable alerts.
// @match        https://www.holland2stay.com/residences*
// @match        https://holland2stay.com/residences*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.telegram.org
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// ==/UserScript==

(async () => {
  'use strict';

  // Keep the original @name and prefix so in-place updates preserve local data.
  const STORAGE_PREFIX = 'h2s_single_city_den_haag';
  const DEFAULT_CONFIG = {
    schemaVersion: 1,
    cities: [
      {name: 'The Hague', id: '90'}, {name: 'Rijswijk', id: '6224'},
      {name: 'Zoetermeer', id: '6088'}, {name: 'Rotterdam', id: '25'},
      {name: 'Leiden', id: '6293'}
    ],
    maxRent: 1000,
    activeHours: {start: '07:00', end: '23:00', timeZone: 'Europe/Amsterdam'},
    refreshMinutes: [5, 10]
  };
  // Speed up local scanning only; network timeouts and server cooldowns are separate.
  const SCAN_SPEED = 3;
  const scanDelay = ms => Math.ceil(ms / SCAN_SPEED);
  const MIN_SETTLE_MS = scanDelay(10000);
  const MAX_SETTLE_MS = scanDelay(30000);
  const MANUAL_SETTLE_MS = scanDelay(30000);
  const SORT_RETRY_MS = scanDelay(3000);
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
  const sameCities = (left, right) => JSON.stringify(cityKeys(left)) === JSON.stringify(cityKeys(right));
  // Retain existing global/single-city scope IDs and normalize multi-city order.
  const selectionScope = filters => filters.allCities ? '*' : filters.cities.length === 1 ? cityKey(filters.city) : cityKeys(filters.cities);
  function requireFields(value, fields, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== fields.length ||
        fields.some(field => !Object.prototype.hasOwnProperty.call(value, field))) {
      throw Error(label + ' must contain exactly: ' + fields.join(', '));
    }
  }
  function validateConfig(value) {
    requireFields(value, ['schemaVersion', 'cities', 'maxRent', 'activeHours', 'refreshMinutes'], 'Config');
    if (value.schemaVersion !== 1) throw Error('Unsupported config schemaVersion; expected 1');
    if (!Array.isArray(value.cities) || !value.cities.length || value.cities.length > 100) {
      throw Error('cities must contain 1–100 city objects');
    }
    const cities = value.cities.map(city => {
      requireFields(city, ['name', 'id'], 'City');
      if (typeof city.name !== 'string' || city.name !== city.name.trim() ||
          !/^[\p{L}\p{M}\p{N} .()'’–-]{1,80}$/u.test(city.name) || !/\p{L}/u.test(city.name)) {
        throw Error('City name must be the official city label without commas or surrounding whitespace');
      }
      if (typeof city.id !== 'string' || !/^[1-9]\d{0,9}$/.test(city.id)) {
        throw Error('City id must be the positive numeric ID from the H2S city filter URL, as a string');
      }
      return {name: city.name, id: city.id};
    });
    if (cityKeys(cities.map(city => city.name)).length !== cities.length ||
        new Set(cities.map(city => city.id)).size !== cities.length) throw Error('Duplicate city name or ID');
    if (typeof value.maxRent !== 'number' || parseBudget(value.maxRent) !== value.maxRent) {
      throw Error('maxRent must be a number greater than 0 and at most 100000, with at most two decimal places');
    }
    requireFields(value.activeHours, ['start', 'end', 'timeZone'], 'activeHours');
    const {start, end, timeZone} = value.activeHours;
    if (![start, end].every(time => typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) || start === end) {
      throw Error('activeHours start/end must be different HH:MM times (00:00–23:59)');
    }
    if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 100) throw Error('Invalid timeZone');
    try { new Intl.DateTimeFormat('en-GB', {timeZone}).format(new Date(0)); }
    catch { throw Error('Unknown IANA timeZone'); }
    if (!Array.isArray(value.refreshMinutes) || value.refreshMinutes.length !== 2 ||
        value.refreshMinutes.some(minutes => typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 1 || minutes > 1440) ||
        value.refreshMinutes[0] > value.refreshMinutes[1]) {
      throw Error('refreshMinutes must be [minimum, maximum], 1–1440 minutes, in ascending order');
    }
    return {schemaVersion: 1, cities, maxRent: value.maxRent,
      activeHours: {start, end, timeZone}, refreshMinutes: [...value.refreshMinutes]};
  }
  function parseConfig(json) {
    if (typeof json !== 'string' || json.length > 50000) throw Error('Config JSON must be text of at most 50000 characters');
    let value;
    try { value = JSON.parse(json); } catch { throw Error('Invalid JSON; paste the complete contents of your config file'); }
    return validateConfig(value);
  }
  function loadConfig(saved, legacyBudget) {
    // New configurations are authoritative; the old budget is migrated only once.
    if (saved !== null && saved !== undefined) return validateConfig(saved);
    return validateConfig({...DEFAULT_CONFIG, maxRent: parseBudget(legacyBudget) ?? DEFAULT_CONFIG.maxRent});
  }
  let configStartupError = '';
  let settings;
  try {
    settings = loadConfig(typeof GM_getValue === 'function' ? GM_getValue(STORAGE_PREFIX + ':config', null) : null,
      typeof GM_getValue === 'function' ? GM_getValue(STORAGE_PREFIX + ':maxRent', null) : null);
  } catch (error) {
    // Fail closed instead of silently monitoring a different set of cities.
    configStartupError = error.message;
    settings = validateConfig(DEFAULT_CONFIG);
  }
  const TARGET_CITIES = settings.cities.map(city => city.name);
  const CITY_FILTER_VALUES = settings.cities.map(city => city.name + ',' + city.id);
  const CITY_LABEL = TARGET_CITIES.join(', ');
  const TIME_ZONE = settings.activeHours.timeZone;
  const REFRESH_MINUTES = settings.refreshMinutes;
  function configuredCityUrl() {
    const url = new URL('https://www.holland2stay.com/residences');
    url.searchParams.set('page', '1');
    url.searchParams.set('available_to_book[filter]', 'Available to book,179');
    for (const value of CITY_FILTER_VALUES) url.searchParams.append('city[filter]', value);
    return url.href;
  }
  // Backwards-compatible helper name for existing integrations and tests.
  const fiveCityUrl = configuredCityUrl;
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
  function parseBudget(value) {
    const input = String(value ?? '').trim();
    if (!/^\d+(?:[.,]\d{1,2})?$/.test(input)) return null;
    const amount = Number(input.replace(',', '.'));
    return Number.isFinite(amount) && amount > 0 && amount <= 100000 ? Math.round(amount * 100) / 100 : null;
  }
  function nextScanFailure(previous, reason, now, retryBaseMs = scanDelay(60000)) {
    const count = Math.min(3, Math.max(0, Number(previous?.count) || 0) + 1);
    return {count, retryAt: count < 3 ? now + count * retryBaseMs : 0, paused: count >= 3,
      reason, noticeSent: false, noticeRetryAt: 0};
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
  function occupiedStatus(value) {
    return /^occupied$/i.test(clean(value));
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
  function filterState(doc, href = doc.location?.href || doc.URL || (typeof location !== 'undefined' ? location.href : '')) {
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
    const chipCities = chips.filter(chip => chip.kind === 'city').map(chip => chip.name);
    const names = [...new Map([...checkedNames, ...chipCities]
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
    let urlReason = '';
    if (href) {
      try {
        const params = new URL(href).searchParams;
        const requested = params.getAll('city[filter]');
        if (requested.length) {
          const valid = requested.every(value => CITY_FILTER_VALUES.some(expected => {
            const [name, id] = expected.split(',');
            const parts = value.split(',');
            return parts.length === 2 && cityKey(parts[0]) === cityKey(name) && parts[1] === id;
          }));
          if (!valid) urlReason = 'URL 中包含无法识别的城市筛选；请使用配置的城市入口';
          else if (!sameCities(requested.map(value => value.split(',')[0]), names)) urlReason = 'URL 与页面选中的城市不一致；等待全部城市筛选生效';
        }
        const availabilityParams = params.getAll('available_to_book[filter]');
        if (!urlReason && availabilityParams.length &&
            (availabilityParams.some(value => value !== 'Available to book,179') || availability !== 'Available to book')) {
          urlReason = 'URL 与页面可订状态不一致；请只保留 Available to book';
        }
      } catch { urlReason = '无法读取当前筛选 URL'; }
    }
    let reason = '';
    if (checked.length !== checkedNames.length) reason = '无法识别选中的城市名称；请展开 City 筛选';
    else if (inputs.length && chipCities.length && !sameCities(checkedNames, chipCities)) reason = '城市勾选项与筛选标签不一致；等待页面完成切换';
    else if (!wanted) reason = '当前城市不在配置的目标城市中，不开始扫描';
    else if (checkedAvailability.length !== checkedAvailabilityNames.length) reason = '无法识别可订状态；请展开 Availability 筛选';
    else if (availabilityNames.length > 1 || (availability && availability !== 'Available to book')) reason = 'Availability 请只选择 Available to book，或清除可订状态筛选';
    else if (otherInputs || otherChips.length || (text(filterList) && !chips.length)) reason = '请清除其他网页筛选；可保留多个目标 City 和 Available to book'
      + (otherChips.length ? '；未支持的筛选：' + otherChips.map(chip => chip.name).join(', ') : '');
    else if (urlReason) reason = urlReason;
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
    return filters.ok ? JSON.stringify([selectionScope(filters), filters.availability || '']) : null;
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
  function withinHours(date = new Date(), hours = settings.activeHours) {
    const parts = new Intl.DateTimeFormat('en-GB', {timeZone: hours.timeZone,
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(date);
    const minute = Number(parts.find(part => part.type === 'hour').value) * 60 + Number(parts.find(part => part.type === 'minute').value);
    const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const start = minutes(hours.start), end = minutes(hours.end);
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
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

  // Observe only existing first-party data traffic. Never read bodies or issue a request.
  function h2sDataUrl(value, baseUrl = 'https://www.holland2stay.com/residences') {
    try {
      if (typeof value !== 'string' || !value.trim()) return null;
      const url = new URL(value, baseUrl);
      if (url.protocol !== 'https:' || !['holland2stay.com', 'www.holland2stay.com'].includes(url.hostname)) return null;
      if (url.port && url.port !== '443') return null;
      if (!/^\/(?:graphql|rest|api|residences)(?:\/|$)/i.test(url.pathname)) return null;
      return url;
    } catch { return null; }
  }
  function h2sRetryAt(value, now) {
    const header = typeof value === 'string' ? value.trim() : '';
    const deadline = /^\d+$/.test(header) ? now + Number(header) * 1000
      : /^[A-Za-z]{3,9}(?:,|\s)/.test(header) ? Date.parse(header) : NaN;
    return Number.isFinite(deadline) ? Math.max(now, deadline) : now + 60000;
  }
  function classifyH2SResponse(response, now = Date.now(), baseUrl) {
    const url = h2sDataUrl(response.url, baseUrl);
    if (!url) return null;
    const header = name => { try { return String(response.getHeader?.(name) || ''); } catch { return ''; } };
    const status = Number(response.status) || 0;
    const info = {url: url.origin + url.pathname, status};
    if (header('cf-mitigated').trim().toLowerCase() === 'challenge') return {...info, kind: 'challenge', retryAt: 0};
    if (status === 429) return {...info, kind: 'rate-limit', retryAt: h2sRetryAt(header('Retry-After'), now)};
    if (status === 403) return {...info, kind: 'blocked', retryAt: 0};
    if (status >= 500 && status <= 599 || response.networkError) return {...info, kind: 'temporary', retryAt: now + 60000};
    return null;
  }
  function installH2SNetworkObserver(page, onSignal, options = {}) {
    const capabilities = {fetch: false, xhr: false, cleanup: () => {}};
    const undo = [];
    let active = true;
    const baseUrl = options.baseUrl || 'https://www.holland2stay.com/residences';
    const now = options.now || Date.now;
    const inputUrl = input => {
      try {
        if (typeof input === 'string') return input;
        if (input && typeof input.url === 'string') return input.url; // Request
        if (input && typeof input.href === 'string') return input.href; // URL
      } catch {}
      return '';
    };
    const report = response => {
      if (!active) return;
      try { const signal = classifyH2SResponse(response, now(), baseUrl); if (signal) onSignal(signal); } catch {}
    };
    try {
      const original = page.fetch;
      if (typeof original === 'function') {
        const wrapped = function (...args) {
          const result = Reflect.apply(original, this, args);
          const requestUrl = inputUrl(args[0]);
          if (h2sDataUrl(requestUrl, baseUrl)) {
            // Attach a side observer and return the original promise, preserving its
            // identity, response, rejection, and body ownership for the application.
            try {
              result.then(response => {
                try {
                  report({url: response.url || requestUrl, status: response.status, getHeader: name => response.headers.get(name)});
                } catch {}
              }, error => {
                try { if (error?.name !== 'AbortError') report({url: requestUrl, status: 0, networkError: true}); } catch {}
              });
            } catch {}
          }
          return result;
        };
        page.fetch = wrapped;
        capabilities.fetch = page.fetch === wrapped;
        if (capabilities.fetch) undo.push(() => { if (page.fetch === wrapped) page.fetch = original; });
      }
    } catch {}
    try {
      const prototype = page.XMLHttpRequest?.prototype;
      if (prototype && typeof prototype.open === 'function' && typeof prototype.send === 'function') {
        const open = prototype.open;
        const send = prototype.send;
        const requests = new WeakMap();
        const wrappedOpen = function (...args) {
          const result = Reflect.apply(open, this, args);
          requests.set(this, inputUrl(args[1]));
          return result;
        };
        const wrappedSend = function (...args) {
          const requestUrl = requests.get(this);
          let detach = () => {};
          if (h2sDataUrl(requestUrl, baseUrl)) {
            try {
              const xhr = this;
              let aborted = false;
              let failed = false;
              const abort = () => { aborted = true; };
              const fail = () => { failed = true; };
              const done = () => {
                detach();
                if (aborted) return;
                try {
                  report({url: xhr.responseURL || requestUrl, status: xhr.status,
                    getHeader: name => xhr.getResponseHeader(name), networkError: failed});
                } catch {}
              };
              detach = () => {
                for (const [event, listener] of [['abort', abort], ['error', fail], ['timeout', fail], ['loadend', done]]) {
                  try { xhr.removeEventListener(event, listener); } catch {}
                }
              };
              try {
                xhr.addEventListener('abort', abort);
                xhr.addEventListener('error', fail);
                xhr.addEventListener('timeout', fail);
                xhr.addEventListener('loadend', done);
              } catch { detach(); }
            } catch {}
          }
          try { return Reflect.apply(send, this, args); }
          catch (error) { detach(); throw error; }
        };
        // Install atomically where possible; never leave a half-installed hook.
        try {
          prototype.open = wrappedOpen;
          prototype.send = wrappedSend;
          capabilities.xhr = prototype.open === wrappedOpen && prototype.send === wrappedSend;
        } catch {}
        if (!capabilities.xhr) {
          try { if (prototype.open === wrappedOpen) prototype.open = open; } catch {}
          try { if (prototype.send === wrappedSend) prototype.send = send; } catch {}
        } else undo.push(() => {
          if (prototype.open === wrappedOpen) prototype.open = open;
          if (prototype.send === wrappedSend) prototype.send = send;
        });
      }
    } catch {}
    capabilities.cleanup = () => {
      active = false;
      for (const restore of undo) { try { restore(); } catch {} }
    };
    return capabilities;
  }

  // The userscript is also directly importable by the offline regression tests.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {cityKey, cityKeys, matchesCity, money, rentFromText, normalizeUrl, directStatus, parseCard, parsePage, pagination,
      filterState, sortChoice, isAscendingPrice, isPriceChoice, priceSortState, forgetPriceSort, sortOptions, challenge, withinHours, validateSweep, validateBudgetSweep,
      cityScope, historyFrom, freshState, reconcile, deliverPending, parseBudget, nextScanFailure, fiveCityUrl, configuredCityUrl, selectionScope, validateConfig, parseConfig, loadConfig,
      h2sDataUrl, h2sRetryAt, classifyH2SResponse, installH2SNetworkObserver};
    return;
  }
  if (!/^\/residences\/?$/.test(location.pathname)) return; // Never run on a booking/detail page.

  // Start observing before DOM setup, using the page realm rather than the userscript realm.
  // Buffer startup signals until this tab obtains the monitor lock.
  const earlyNetworkSignals = [];
  const bufferNetworkSignal = signal => {
    earlyNetworkSignals.push({...signal, observedAt: Date.now()});
    if (earlyNetworkSignals.length > 20) earlyNetworkSignals.shift();
  };
  let networkReceiver = bufferNetworkSignal;
  let pageWindow;
  try { pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window; } catch { pageWindow = window; }
  const networkObserver = installH2SNetworkObserver(pageWindow, signal => networkReceiver(signal),
    {now: () => Date.now(), baseUrl: location.origin + location.pathname});
  if (document.readyState === 'loading') {
    await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, {once: true}));
  }

  const key = name => STORAGE_PREFIX + ':' + name;
  const get = (name, fallback) => GM_getValue(key(name), fallback);
  const set = (name, value) => GM_setValue(key(name), value);
  const maxRent = () => settings.maxRent;
  function currentConfigProblem() {
    if (configStartupError) return configStartupError;
    try {
      const current = loadConfig(get('config', null), get('maxRent', null));
      return JSON.stringify(current) === JSON.stringify(settings) ? '' : '配置已在其他标签页更改，请刷新当前页面';
    } catch (error) { return error.message; }
  }
  const readScanFailure = () => get('scanFailure', null) || {count: 0, retryAt: 0, paused: false};
  const telegramCooldownUntil = () => Math.max(0, Number(get('telegramCooldownUntil', 0)) || 0);
  function postponeTelegram(seconds = 60) {
    const until = Math.max(telegramCooldownUntil(), Date.now() + Math.max(1, seconds) * 1000);
    set('telegramCooldownUntil', until);
    return until;
  }
  function cancelledError(message) { const error = Error(message); error.cancelled = true; return error; }
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
  let telegramQueue = Promise.resolve();
  let daytime = withinHours();
  let maintenanceUntil = 0;
  let networkRefreshPending = false;
  let settingsReloadPending = false;
  const stats = {message: '正在启动', phase: '未开始', sortStep: '', mode: '', scope: '', scanned: 0, matched: 0, occupied: 0, pages: 0, telegram: '未配置', sent: 0};
  const panelColors = {normal: '#e6edf5', muted: '#a6b8cb', info: '#7dd3fc', success: '#86efac', warning: '#fcd34d', error: '#fda4af'};
  const panelBackgrounds = {normal: '#162638', muted: '#162638', info: '#142d41', success: '#16332f', warning: '#352d20', error: '#38232e'};
  function panelNode(tag, value, style = {}) {
    const node = document.createElement(tag);
    if (value != null) node.textContent = value;
    Object.assign(node.style, style);
    return node;
  }
  function panelRow(label, value, tone = 'normal') {
    const row = panelNode('div', null, {display: 'flex', gap: '8px', alignItems: 'baseline', margin: '5px 0'});
    row.append(panelNode('span', label + '：', {color: panelColors.muted, flex: '0 0 68px'}),
      panelNode('span', value, {color: panelColors[tone], flex: '1', minWidth: '0', overflowWrap: 'anywhere'}));
    return row;
  }
  function panelNumbers(value) {
    const row = panelNode('div', null, {color: panelColors.muted, lineHeight: '1.9', fontSize: '12px'});
    for (const part of value.split(/(\d+)/)) row.append(panelNode(/^\d+$/.test(part) ? 'strong' : 'span', part,
      /^\d+$/.test(part) ? {color: panelColors.info, fontSize: '15px', fontWeight: '700'} : {}));
    return row;
  }
  const panel = document.createElement('aside');
  panel.id = 'h2s-monitor-panel';
  panel.setAttribute('aria-label', 'H2S 房源监控');
  Object.assign(panel.style, {position: 'fixed', right: '16px', bottom: '84px', zIndex: 2147483646, padding: '16px',
    boxSizing: 'border-box', width: '354px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 108px)', overflowY: 'auto',
    background: 'linear-gradient(145deg, #14283a, #0c1827)', color: panelColors.normal, font: '12px/1.55 system-ui,sans-serif',
    fontVariantNumeric: 'tabular-nums', textAlign: 'left', letterSpacing: 'normal',
    border: '1px solid #35516b', borderRadius: '16px', boxShadow: '0 12px 40px #0006', whiteSpace: 'normal'});
  document.body.append(panel);
  const panelText = document.createElement('div');
  const checkButton = document.createElement('button');
  checkButton.id = 'h2s-monitor-check';
  checkButton.type = 'button';
  checkButton.textContent = '立即检查（夜间也可运行）';
  Object.assign(checkButton.style, {display: 'block', width: '100%', boxSizing: 'border-box', marginTop: '12px', padding: '10px 12px',
    border: '1px solid #4bbbbb', borderRadius: '9px', background: 'linear-gradient(120deg, #116b70, #155b76)',
    color: '#f0fdfa', font: '600 13px/1.5 system-ui,sans-serif', cursor: 'pointer'});
  checkButton.addEventListener('click', safe(async () => { requireIdle(); await runScan(true); }));
  const entryLink = panelNode('a', '打开配置城市可订房源 / Open configured cities', {display: 'block', color: panelColors.info,
    textAlign: 'center', marginTop: '8px', fontSize: '12px'});
  entryLink.href = fiveCityUrl();
  panel.append(panelText, checkButton, entryLink);
  function configured() { return Boolean(get('token', '') && get('chatId', '')); }
  const readHistory = () => historyFrom(get('state', null));
  const targetsFor = filters => filters.allCities ? TARGET_CITIES : filters.cities;
  const scopeFor = filters => JSON.stringify(['price-asc-v1', selectionScope(filters), maxRent(),
    ...(filters.allCities ? ['targets:' + JSON.stringify(cityKeys(TARGET_CITIES))] : []),
    ...(filters.availability ? ['availability:' + filters.availability] : [])]);
  function scopeRequested(name, filters) {
    const request = get(name, false);
    if (request === true || request === scopeFor(filters)) return true;
    // v1.3.14 global one-off requests did not include target cities in their scope.
    // Honor them only for an untouched default installation, never imported settings.
    if (!filters.allCities || get('config', null) != null ||
        !sameCities(TARGET_CITIES, DEFAULT_CONFIG.cities.map(city => city.name))) return false;
    const legacyScope = JSON.stringify(['price-asc-v1', '*', maxRent(),
      ...(filters.availability ? ['availability:' + filters.availability] : [])]);
    return request === legacyScope;
  }
  const queuedItems = (history, filters) => Object.values(history.cities).flatMap(state => Object.values(state.items))
    .filter(item => item.pending && item.eligible && !item.missing && item.rent <= maxRent() && matchesCity(item.city, targetsFor(filters)));
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
    if (['扫描未完成', '扫描失败，等待重试', '故障暂停'].includes(stats.phase)) return '尚未操作：本轮在排序前停止，见下方原因';
    return '尚未开始；扫描启动后自动选择 Price';
  }
  function notificationSummary(history, filters, previous, pending, sameScope) {
    if (!filters.ok) return '筛选条件通过并完成扫描后，才会生成房源通知。';
    const requested = name => scopeRequested(name, filters);
    if (requested('notifyExisting')) return '已设置强制重发；下次完整扫描后发送符合房源。夜间请点立即检查。';
    if (requested('silentBaseline')) return '已设置静默基线；下次扫描记录现有房源，不发送这些房源。';
    if (!configured()) return 'Telegram 尚未配置；需要通知的房源会保留在待发队列。';
    if (pending) return '当前有 ' + pending + ' 条待发；发送或重试进度见扫描状态。';
    if (scanRunning) return '完成扫描后核对通知；已成功通知且无变化的房源不重发。';
    if (sameScope && ['扫描未完成', '扫描失败，等待重试', '故障暂停'].includes(stats.phase)) return '本轮扫描未完成验证，没有生成新的房源通知。';
    if (!previous) return '尚无当前范围的完整扫描；立即检查会扫描，测试 Telegram 仅检查消息通道。';
    if (sameScope && stats.sent) return '本轮已成功发送 ' + stats.sent + ' 条；重复检查不会重复发送未变化的房源。';
    if (!previous.matched) return '上次完整扫描没有符合城市、预算和可订条件的房源。';
    const eligible = Object.values(history.cities).flatMap(state => Object.values(state.items))
      .filter(item => item.eligible && !item.missing && item.rent <= maxRent() && matchesCity(item.city, targetsFor(filters)));
    const silent = eligible.some(item => item.initialNoticeSkipped && item.lastNotified == null);
    if (silent) return '当前无待发通知；静默基线中的房源不首发，已通知且无变化的房源不重发。';
    if (eligible.length && eligible.every(item => item.lastNotified != null)) return '符合房源已通知过；本轮没有需要新发的通知。';
    return '当前无待发通知；仅通知新房源、降价或重新可订等变化。';
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
    const phase = isLeader ? stats.phase : '待机，另一个标签页正在监控';
    const tone = !isLeader ? 'muted' : phase === '扫描未完成' || phase === '验证暂停' ? 'error'
      : /暂停|重试/.test(phase) ? 'warning' : scanRunning || deliveryRunning ? 'info' : /完成/.test(phase) ? 'success' : 'muted';
    const header = panelNode('div', null, {display: 'flex', alignItems: 'center', justifyContent: 'space-between'});
    header.append(panelNode('strong', 'H2S', {fontSize: '21px', color: '#f0f9ff', letterSpacing: '0.5px'}),
      panelNode('span', 'v1.4.0', {color: panelColors.info, background: '#1d354b', padding: '3px 9px', borderRadius: '20px', fontSize: '11px'}));
    const budget = panelNode('div', '预算内扫描 · 主租金 ≤ €' + maxRent(), {color: panelColors.info, margin: '3px 0 12px', fontSize: '12px'});
    const statusCard = panelNode('div', null, {background: panelBackgrounds[tone], borderLeft: '3px solid ' + panelColors[tone],
      borderRadius: '8px', padding: '9px 11px', marginBottom: '10px'});
    statusCard.append(panelNode('div', '扫描状态：' + phase, {color: panelColors[tone], fontWeight: '700', fontSize: '13px'}),
      panelNode('div', stats.message, {color: panelColors.normal, marginTop: '4px', overflowWrap: 'anywhere'}));
    const counts = panelNode('div', null, {padding: '5px 0 10px', borderBottom: '1px solid #2b4055', marginBottom: '10px'});
    counts.append(panelNumbers('已读 ' + (sameScope ? stats.scanned : previous?.inspected || 0) + ' 套 · 符合 ' +
      (sameScope ? stats.matched : previous?.matched || 0) + ' 套 · 第 ' + (sameScope ? stats.pages : previous?.pages || 0) + ' 页'),
      panelNumbers('本轮已发 ' + (sameScope ? stats.sent : 0) + ' · 当前范围待发 ' + pending + ' · 累计 ' + history.sent));
    const occupied = sameScope ? stats.occupied : previous?.occupied || 0;
    if (occupied) counts.append(panelNode('div', '已跳过 ' + occupied + ' 套已租出房源（仍计入已读）', {color: panelColors.muted}));
    const details = panelNode('div');
    details.append(panelRow('当前城市', filters.allCities ? '全部城市（按配置筛选）' : filters.cities.join(', ') || '尚未识别'),
      panelRow('可订状态', filters.availability || '未筛选（仅通知可直接预订）'),
      panelRow('目标城市', filters.allCities ? '仅通知 ' + CITY_LABEL : filters.wanted ? '是，属于配置的目标城市' : '否 / 尚未确认', 'muted'),
      panelRow('筛选条件', filters.ok ? '通过' : '未通过；' + filters.reason, filters.ok ? 'success' : 'warning'),
      panelRow('价格排序', sortingStatus(sorting, mode, filters), sorting.ok || mode === 'single' ? 'success' : 'warning'));
    if (readScanFailure().count) details.append(panelRow('故障状态', readScanFailure().paused ? '已暂停；请手动恢复' : '连续失败 ' + readScanFailure().count + '/3', 'warning'));
    if (telegramCooldownUntil() > Date.now()) details.append(panelRow('通知等待', '最早重试 ' + formatTime(telegramCooldownUntil()), 'warning'));
    details.append(panelRow('接口观察', networkObserver.fetch && networkObserver.xhr ? '已接入 fetch / XHR'
      : networkObserver.fetch || networkObserver.xhr ? '部分可用；其余依赖页面检查' : '不可用；仅使用页面检查',
      networkObserver.fetch && networkObserver.xhr ? 'muted' : 'warning'));
    if (mode === 'city') details.append(panelRow('扫描方式', '读完当前城市全部页，再按预算筛选', 'info'));
    else if (filters.ok && filters.cities.length > 1) details.append(panelRow('扫描方式', '所选 ' + filters.cities.length + ' 城联合列表；多页按 Price 升序扫描', 'info'));
    if (others > 0) details.append(panelNode('div', '其他城市 / 范围待复查 ' + others + ' 条', {color: panelColors.warning}));
    const telegramLabel = configured() ? stats.telegram === '未配置' ? '已配置' : stats.telegram : '未配置（菜单设置）';
    details.append(panelRow('Telegram', telegramLabel, !configured() ? 'warning' : /失败|错误|异常|超时|HTTP|限流/.test(telegramLabel)
      ? 'error' : /成功/.test(telegramLabel) ? 'success' : 'info'));
    const notification = panelNode('div', null, {background: '#142536', border: '1px solid #294359', borderRadius: '8px',
      padding: '8px 10px', margin: '10px 0', color: pending || !configured() ? panelColors.warning : panelColors.muted});
    notification.append(panelNode('strong', '通知说明：', {color: panelColors.info}),
      panelNode('span', notificationSummary(history, filters, previous, pending, sameScope)));
    const footer = panelNode('div', null, {color: panelColors.muted, fontSize: '11px', lineHeight: '1.7'});
    footer.append(panelNode('div', '上次扫描终点：' + (previous ? previous.cutoff ? '超出预算，已停止翻页' : '已到最后一页' : '尚未完成')),
      panelNode('div', '上次完成预算内扫描 ' + formatTime(previous?.completedAt)));
    const refresh = panelNode('div', null, {display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '8px 0 4px', marginTop: '6px', borderTop: '1px solid #2b4055'});
    refresh.append(panelNode('span', '下次刷新 ', {color: panelColors.muted}), panelNode('strong',
      formatTime(filters.ok && lastScope === scopeFor(filters) ? nextRefresh : 0), {fontSize: '17px', color: panelColors.info}));
    const hours = panelNode('div', '自动运行 ' + settings.activeHours.start + '–' + settings.activeHours.end + ' · ' + TIME_ZONE, {color: panelColors.muted, fontSize: '11px'});
    panelText.replaceChildren(header, budget, statusCard, counts, details, notification, footer, refresh, hours);
    checkButton.textContent = readScanFailure().paused ? '恢复并立即检查' : '立即检查（夜间也可运行）';
    const hold = readNetworkHold();
    const canRecoverTemporary = hold?.kind === 'temporary' && readScanFailure().paused && Date.now() >= hold.retryAt;
    checkButton.disabled = !isLeader || scanRunning || deliveryRunning || get('paused', false) || !filters.ok || challenge(document)
      || (Boolean(hold) && !canRecoverTemporary) || networkRefreshPending;
    checkButton.style.opacity = checkButton.disabled ? '0.55' : '1';
    checkButton.style.cursor = checkButton.disabled ? 'not-allowed' : 'pointer';
  }
  function setMessage(message) { stats.message = message; render(); }
  function setStatus(phase, message) { stats.phase = phase; setMessage(message); }
  function scheduleRefresh() { nextRefresh = readScanFailure().paused ? 0 : Date.now() + (REFRESH_MINUTES[0] + Math.random() * (REFRESH_MINUTES[1] - REFRESH_MINUTES[0])) * 60000; }
  function filtersFingerprint() {
    return scopeFor(filterState(document));
  }
  function assertRunning(manual, sending = false) {
    const configProblem = currentConfigProblem();
    if (configProblem) throw cancelledError('配置已更改或无效，请刷新或重新导入 JSON：' + configProblem);
    if (settingsReloadPending) throw cancelledError('配置已保存，请等待页面刷新');
    if (readNetworkHold() || networkRefreshPending) throw cancelledError('房源接口受阻，等待处理后重新加载');
    if (!isLeader || get('paused', false)) throw cancelledError('监控已暂停');
    if (readScanFailure().paused) throw cancelledError('连续扫描失败，监控已故障暂停');
    if (challenge(document)) throw cancelledError('检测到验证页面，已停止操作');
    if (!manual && !withinHours()) throw cancelledError('已进入夜间暂停时段');
    if (!sending && Date.now() < maintenanceUntil) throw cancelledError('检测到手动操作，等待 ' + MANUAL_SETTLE_MS / 1000 + ' 秒后继续扫描');
  }
  function assertScope(scope, manual, sending = false) {
    assertRunning(manual, sending);
    const filters = filterState(document);
    if (!filters.ok) throw cancelledError(filters.reason);
    if (filtersFingerprint() !== scope) throw cancelledError('筛选条件已改变；本轮已取消');
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
          if (sorting.button && !sorting.button.disabled && sorting.button.getAttribute('aria-disabled') !== 'true' && Date.now() - lastOpenAt >= scanDelay(1500)) {
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
      await sleep(scanDelay(500));
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
        if (!currentFilters.allCities && result.listings.some(item => !matchesCity(item.city, currentFilters.cities))) throw Error('等待列表切换到所选城市');
        // A just-rented residence can linger under Available to book. Keep it in
        // count/order validation; reconcile excludes it from notifications.
        if (currentFilters.availability === 'Available to book' && result.listings.some(item => !directStatus(item.status) && !occupiedStatus(item.status))) throw Error('等待列表切换到 Available to book');
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
      await sleep(scanDelay(1000));
    }
    throw Error(lastError + '；本轮未完成，将按退避间隔重试');
  }
  function telegram(method, payload, allowed = () => {}) {
    // Serialize this tab's requests so a just-received rate limit also covers
    // a queued test, pairing request, or incident notification.
    const task = telegramQueue.then(() => { allowed(); return requestTelegram(method, payload); });
    telegramQueue = task.catch(() => {});
    return task;
  }
  async function requestTelegram(method, payload) {
    const configProblem = currentConfigProblem();
    if (configProblem || settingsReloadPending) throw Error('配置已更改或无效，请刷新页面后重试 Telegram：' + configProblem);
    const remaining = telegramCooldownUntil() - Date.now();
    if (remaining > 0) {
      const error = Error('Telegram 等待重试，最早 ' + formatTime(telegramCooldownUntil()));
      error.retryAfter = Math.ceil(remaining / 1000);
      throw error;
    }
    const token = get('token', '');
    if (!/^\d+:[\w-]{20,}$/.test(token)) throw Error('请先在菜单配置 Telegram Token');
    return new Promise((resolve, reject) => {
      const fail = (message, retryAfter = 60) => {
        const error = Error(message);
        error.retryAfter = retryAfter;
        postponeTelegram(retryAfter);
        reject(error);
      };
      GM_xmlhttpRequest({method: 'POST', url: 'https://api.telegram.org/bot' + token + '/' + method,
        headers: {'Content-Type': 'application/json'}, data: JSON.stringify(payload), anonymous: true, timeout: 15000,
        onload(response) {
          let body;
          try { body = JSON.parse(response.responseText); }
          catch { fail('Telegram 返回无法解析的响应'); return; }
          if (response.status === 200 && body?.ok === true) resolve(body.result);
          else {
            const seconds = Number(body?.parameters?.retry_after);
            const retryAfter = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60;
            fail('Telegram HTTP ' + response.status + '；请核对配置或稍后重试', retryAfter);
          }
        },
        onerror: () => fail('Telegram 网络错误，通知保留待重试'),
        ontimeout: () => fail('Telegram 超时，通知保留待重试'),
        onabort: () => fail('Telegram 请求中止，通知保留待重试')});
    });
  }
  async function sendText(message, allowed) {
    const chatId = get('chatId', '');
    if (!/^-?\d+$/.test(String(chatId))) throw Error('请先配置 Telegram Chat ID');
    await telegram('sendMessage', {chat_id: chatId, text: message, link_preview_options: {is_disabled: true}}, allowed);
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
    if (incident.sent || !configured() || Date.now() < Math.max(incident.retryAt || 0, telegramCooldownUntil())) return;
    incident.retryAt = Date.now() + 60000;
    set('incident', incident);
    try {
      await sendText('H2S · ' + CITY_LABEL + '\n监控遇到验证或访问受阻，已暂停自动刷新。请在运行脚本的浏览器中手动处理。\n' + location.origin + location.pathname);
      incident.sent = true;
      set('incident', incident);
    } catch (error) {
      incident.retryAt = Math.max(incident.retryAt, telegramCooldownUntil());
      set('incident', incident);
      stats.telegram = '验证提醒发送失败；最早重试 ' + formatTime(incident.retryAt); render();
    }
  }
  async function notifyScanFailure() {
    const failure = readScanFailure();
    if (!failure.paused) return;
    nextRefresh = 0;
    deliveryContext = null;
    const hold = readNetworkHold();
    const recovery = hold && hold.kind !== 'temporary' ? '处理后使用“恢复接口暂停（验证完成后）”菜单'
      : hold ? '接口等待到 ' + formatTime(hold.retryAt) + ' 后，点“恢复并立即检查”' : '处理后点“恢复并立即检查”或菜单恢复';
    setStatus('故障暂停', '连续 ' + failure.count + ' 次扫描失败：' + failure.reason + '；' + recovery);
    if (failure.noticeSent || !configured() || Date.now() < Math.max(failure.noticeRetryAt || 0, telegramCooldownUntil())) return;
    failure.noticeRetryAt = Date.now() + 60000;
    set('scanFailure', failure);
    try {
      await sendText('H2S · 监控故障暂停\n连续 ' + failure.count + ' 次扫描失败，已停止自动扫描和刷新。\n原因：' + failure.reason +
        '\n请在原浏览器检查页面，处理后选择“恢复故障暂停并立即检查”。\n' + location.origin + location.pathname);
      // A manual recovery during the request must not revive an old incident.
      if (readScanFailure().paused) { failure.noticeSent = true; set('scanFailure', failure); }
      stats.telegram = '故障提醒发送成功';
    } catch (error) {
      failure.noticeRetryAt = Math.max(failure.noticeRetryAt, telegramCooldownUntil());
      if (readScanFailure().paused) set('scanFailure', failure);
      stats.telegram = '故障提醒发送失败；最早重试 ' + formatTime(failure.noticeRetryAt); render();
    }
  }
  async function flushPending(context) {
    if (deliveryRunning || !configured() || Date.now() < telegramCooldownUntil()) return;
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
        try { await sendText(listingMessage(item), () => assertScope(context.scope, context.manual, true)); }
        catch (error) { if (!error.cancelled) error.telegramFailure = true; throw error; }
        stats.telegram = '发送成功';
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
        postponeTelegram(error.retryAfter || 60);
        stats.telegram = error.message;
        setStatus('通知等待重试（扫描已完成）', '待发记录已保留；最早重试 ' + formatTime(telegramCooldownUntil()));
      } else {
        deliveryContext = null;
        setStatus('通知已暂停（扫描已完成）', error.message + '；待发记录已保留');
      }
    } finally { deliveryRunning = false; render(); }
  }
  const readNetworkHold = () => get('networkHold', null);
  function networkDescription(hold) {
    if (hold.kind === 'challenge') return '房源接口返回验证页面；请手动完成验证后使用“恢复接口暂停（验证完成后）”';
    if (hold.kind === 'blocked') return '房源接口返回 HTTP 403；请检查官网拒绝访问原因，处理后使用恢复接口菜单';
    if (hold.kind === 'rate-limit') return '房源接口返回 HTTP 429；最早 ' + formatTime(hold.retryAt) + ' 后重新加载';
    return '房源接口' + (hold.status ? '返回 HTTP ' + hold.status : '网络请求失败') + '；等待后重新加载';
  }
  async function applyNetworkSignal(signal) {
    const previous = readNetworkHold();
    const priority = kind => ({temporary: 1, 'rate-limit': 2, blocked: 3, challenge: 4})[kind] || 0;
    if (previous && priority(previous.kind) >= priority(signal.kind)) {
      if (previous.kind === signal.kind && signal.retryAt > previous.retryAt) {
        previous.retryAt = signal.retryAt;
        set('networkHold', previous);
      }
      return;
    }
    const hold = {...signal, started: Date.now(), noticeSent: false, noticeRetryAt: 0,
      retryAt: ['temporary', 'rate-limit'].includes(signal.kind) ? Math.max(Date.now() + 60000, signal.retryAt) : 0};
    set('networkHold', hold);
    nextRefresh = 0;
    deliveryContext = null;
    dirty = true;
    if (hold.kind === 'temporary') {
      await recordScanFailure(Error(networkDescription(hold)), 60000);
      // Network failures retain 60/120-second backoff, independent of local scan speed.
      const latest = readNetworkHold();
      if (latest?.started === hold.started && latest.kind === hold.kind) {
        latest.retryAt = Math.max(latest.retryAt, readScanFailure().retryAt || 0);
        set('networkHold', latest);
      }
    } else setStatus(hold.kind === 'rate-limit' ? '接口限流等待' : '接口验证暂停', networkDescription(hold));
  }
  async function notifyNetworkHold(hold) {
    if (hold.kind === 'temporary' || hold.noticeSent || !configured()
      || Date.now() < Math.max(hold.noticeRetryAt || 0, telegramCooldownUntil())) return;
    hold.noticeRetryAt = Date.now() + 60000;
    set('networkHold', hold);
    try {
      await sendText('H2S · 接口暂停\n' + networkDescription(hold) + '\n' + hold.url);
      const latest = readNetworkHold();
      if (latest?.started === hold.started && latest.kind === hold.kind) {
        latest.noticeSent = true;
        set('networkHold', latest);
      }
      stats.telegram = '接口提醒发送成功';
    } catch {
      const latest = readNetworkHold();
      if (latest?.started === hold.started && latest.kind === hold.kind) {
        latest.noticeRetryAt = Math.max(latest.noticeRetryAt, telegramCooldownUntil());
        set('networkHold', latest);
      }
      stats.telegram = '接口提醒等待重试';
    }
  }
  async function serviceNetworkHold(manual = false) {
    if (networkRefreshPending) { setStatus('等待重新加载', '接口等待已结束，正在重新加载以确认最新房源'); return true; }
    const hold = readNetworkHold();
    if (!hold) return false;
    nextRefresh = 0;
    deliveryContext = null;
    if (readScanFailure().paused) { await notifyScanFailure(); return true; }
    if (hold.retryAt && Date.now() >= hold.retryAt) {
      if (!manual && !withinHours()) { setStatus('夜间暂停', '接口等待已结束；白天重新加载，或使用恢复接口菜单'); return true; }
      // Do not accept the old, still-visible cards as fresh data after an API failure.
      set('networkHold', null);
      networkRefreshPending = true;
      setStatus('等待重新加载', '接口等待已结束，正在重新加载以确认最新房源');
      location.reload();
      return true;
    }
    setStatus(hold.retryAt ? '接口等待重试' : '接口验证暂停', networkDescription(hold));
    await notifyNetworkHold(hold);
    return true;
  }
  async function recordScanFailure(error, retryBaseMs) {
    nextRefresh = 0;
    deliveryContext = null;
    dirty = true;
    const previous = readScanFailure();
    if (previous.paused) return previous;
    const failure = nextScanFailure(previous, error.message || String(error), Date.now(), retryBaseMs);
    set('scanFailure', failure);
    retryAt = Math.max(failure.retryAt, maintenanceUntil);
    if (failure.paused) await notifyScanFailure();
    else setStatus('扫描失败，等待重试', '连续失败 ' + failure.count + '/3：' + failure.reason + '；最早重试 ' + formatTime(retryAt));
    return failure;
  }
  async function runScan(manual = false) {
    if (scanRunning || deliveryRunning || !isLeader || get('paused', false)) return;
    if (challenge(document)) { await notifyBlock(); return; }
    const hold = readNetworkHold();
    if (manual && hold?.kind === 'temporary' && readScanFailure().paused && Date.now() >= hold.retryAt) {
      set('networkHold', null);
      set('scanFailure', null);
      networkRefreshPending = true;
      location.reload();
      return;
    }
    if ((readNetworkHold() || networkRefreshPending) && await serviceNetworkHold(manual)) return;
    const filters = filterState(document);
    if (!filters.ok) { nextRefresh = 0; setStatus('未开始', filters.reason); return; }
    if (!manual && !withinHours()) { nextRefresh = 0; setStatus('夜间暂停', '菜单可手动立即检查'); return; }
    if (manual) { set('scanFailure', null); retryAt = 0; }
    else {
      if (readScanFailure().paused) { await notifyScanFailure(); return; }
      if (Date.now() < Math.max(retryAt, readScanFailure().retryAt || 0)) return;
    }
    scanRunning = true;
    dirty = false;
    deliveryContext = null;
    const scope = scopeFor(filters);
    const targets = targetsFor(filters);
    Object.assign(stats, {scope, mode: '', sortStep: '', sent: 0, scanned: 0, matched: 0, occupied: 0, pages: 0});
    lastScope = scope;
    try {
      while (manual && Date.now() < maintenanceUntil) {
        assertScope(scope, manual, true);
        setStatus('已开始，等待手动操作稳定', '还有约 ' + Math.ceil((maintenanceUntil - Date.now()) / 1000) + ' 秒，然后自动扫描');
        await sleep(Math.min(scanDelay(1000), maintenanceUntil - Date.now()));
      }
      assertScope(scope, manual);
      setStatus('已开始，等待列表稳定', '正在确认当前城市、房源数量和分页');
      let result = await stablePage(scope, manual);
      const singlePage = page => page.page.current === 1 && page.page.last === 1 && !page.page.next;
      let mode = 'single';
      if (!singlePage(result)) {
        const sorting = await ensurePriceSort(scope, manual);
        if (!sorting.ok && (filters.allCities || filters.cities.length > 1)) {
          throw Error('未能选中 Price：' + sorting.reason + '；请手动展开 Sort 选择 Price 后点击“立即检查”');
        }
        mode = sorting.ok ? 'budget' : 'city';
        setStatus('已开始，等待列表稳定', mode === 'budget' ? '已选择 Price 升序，遇到主租金 > €' + maxRent() + ' 后停止翻页'
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
        stats.matched = listings.filter(item => matchesCity(item.city, targets) && item.rent <= maxRent() && directStatus(item.status)).length;
        stats.occupied = listings.filter(item => occupiedStatus(item.status)).length;
        stats.pages = n;
        setStatus('扫描中', '正在读取第 ' + n + ' 页；当前列表共 ' + total + ' 套');
        if ((useCutoff && result.listings.some(item => item.rent > maxRent())) || !result.page.next) break;
        if (n === MAX_PAGES) throw Error('超过分页上限；本轮不更新历史');
        const old = fingerprint(result);
        result.page.next.click();
        result = await stablePage(scope, manual, n + 1, old, useCutoff);
      }
      let cutoff = false;
      const selectedCities = filters.allCities ? null : filters.cities;
      if (useCutoff) ({cutoff} = validateBudgetSweep(listings, total, maxRent(), selectedCities, !result.page.next));
      else validateSweep(listings, total, selectedCities);
      assertAllowed(scope, manual, useCutoff);
      const history = readHistory();
      const requested = name => scopeRequested(name, filters);
      const notifyExisting = requested('notifyExisting');
      const silentBaseline = requested('silentBaseline') && !notifyExisting;
      for (const city of targets) {
        const key = cityKey(city);
        const previous = history.cities[key];
        const rows = listings.filter(item => matchesCity(item.city, city));
        const {state} = reconcile(previous, rows, cityScope(city), city, maxRent(), Date.now(), {silentBaseline});
        if (notifyExisting) {
          for (const item of Object.values(state.items)) if (item.eligible && !item.missing) item.pending = {reason: '手动重新通知', detectedAt: Date.now()};
        }
        history.cities[key] = state;
      }
      history.scans ||= {};
      history.scans[scope] = {completedAt: Date.now(), inspected: listings.length, matched: stats.matched, occupied: stats.occupied, pages: stats.pages, total, cutoff, mode};
      set('state', history);
      set('scanFailure', null);
      retryAt = 0;
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
      nextRefresh = 0;
      dirty = true;
      if (challenge(document)) {
        await notifyBlock();
      } else if (error.cancelled) {
        retryAt = Math.max(Date.now() + scanDelay(2000), maintenanceUntil);
        setStatus('扫描已取消', error.message);
      } else {
        await recordScanFailure(error);
      }
    } finally { scanRunning = false; render(); }
  }
  async function tick() {
    if (!isLeader || scanRunning || deliveryRunning) return;
    const configProblem = currentConfigProblem();
    if (configProblem) { nextRefresh = 0; deliveryContext = null; setStatus('配置已更改或无效，监控已暂停', '请刷新页面或通过菜单重新导入配置 JSON：' + configProblem); return; }
    if (settingsReloadPending) { nextRefresh = 0; setStatus('配置已保存', '请等待页面刷新后使用新配置'); return; }
    if (get('paused', false)) { nextRefresh = 0; setStatus('手动暂停', '菜单可恢复'); return; }
    if (challenge(document)) { await notifyBlock(); return; }
    if (get('incident', null)) { set('incident', null); dirty = true; }
    if ((readNetworkHold() || networkRefreshPending) && await serviceNetworkHold()) return;
    if (readScanFailure().paused) { await notifyScanFailure(); return; }
    const filters = filterState(document);
    if (!filters.ok) { deliveryContext = null; dirty = true; nextRefresh = 0; setStatus('未开始', filters.reason); return; }
    const scope = scopeFor(filters);
    if (lastScope && scope !== lastScope) { deliveryContext = null; dirty = true; retryAt = 0; nextRefresh = 0; }
    if (deliveryContext && Date.now() >= deliveryContext.expiresAt) {
      deliveryContext = null;
      dirty = true; // Recheck availability before retrying an old snapshot.
    }
    if (deliveryContext && configured() && (withinHours() || deliveryContext.manual)) {
      if (Date.now() >= telegramCooldownUntil()) await flushPending(deliveryContext);
      if (deliveryContext) {
        setStatus('通知等待重试（扫描已完成）', '当前范围待发记录已保留；最早重试 ' + formatTime(telegramCooldownUntil()));
        return;
      }
    }
    if (!withinHours()) { daytime = false; nextRefresh = 0; setStatus('夜间暂停', '菜单可手动立即检查；待发数量保留显示'); return; }
    const scanRetryAt = Math.max(retryAt, readScanFailure().retryAt || 0);
    if (Date.now() < scanRetryAt) {
      if (readScanFailure().count) setStatus('扫描失败，等待重试', '连续失败 ' + readScanFailure().count + '/3；最早重试 ' + formatTime(scanRetryAt));
      else render();
      return;
    }
    if (!daytime) { daytime = true; location.reload(); return; }
    if (Date.now() < maintenanceUntil) { setStatus('等待手动操作结束', MANUAL_SETTLE_MS / 1000 + ' 秒观察期结束后继续扫描'); return; }
    if (nextRefresh && Date.now() >= nextRefresh) { location.reload(); return; }
    if (dirty && Date.now() >= scanRetryAt) { await runScan(); return; }
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
  register('打开配置城市可订房源 / Open configured cities', () => { requireIdle(); location.assign(fiveCityUrl()); });
  register('导入配置 JSON / Import settings JSON', () => {
    requireIdle();
    const json = prompt('粘贴配置文件的完整 JSON 内容 / Paste the complete JSON from your config file.\n仅包含城市、预算、时间和刷新设置；不要粘贴 Telegram Token。');
    if (json === null) return;
    const incoming = parseConfig(json); // Validate everything before writing any value.
    const history = readHistory();
    history.scans = {}; // Old completed-scan summaries may describe another target set.
    set('state', history);
    set('config', incoming);
    set('maxRent', incoming.maxRent); // Retain the legacy key for in-place downgrade compatibility.
    set('notifyExisting', false);
    set('silentBaseline', false);
    deliveryContext = null;
    lastScope = '';
    nextRefresh = 0;
    settingsReloadPending = true;
    location.reload();
  });
  register('导出配置 JSON / Export settings JSON', () => {
    const current = loadConfig(get('config', null), get('maxRent', null));
    // Only validated public settings are exported; token/chatId/history never enter this object.
    const json = JSON.stringify(current, null, 2) + '\n';
    const download = document.createElement('a');
    download.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
    download.download = 'h2s-config.json';
    document.body.append(download);
    download.click();
    download.remove();
  });
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
    await sendText('H2S 测试成功 · ' + CITY_LABEL + ' · 主租金 ≤ €' + maxRent() + '\n此消息只验证 Telegram 配置，不代表已发现新房源。');
    stats.telegram = '测试成功'; render();
  });
  register('恢复接口暂停（验证完成后）', () => {
    requireIdle();
    if (challenge(document)) throw Error('请先在官网完成验证或解决拒绝访问');
    const hold = readNetworkHold();
    if (!hold) throw Error('当前没有接口暂停；需要重扫时使用“立即检查”');
    if (hold.retryAt && Date.now() < hold.retryAt) throw Error('接口仍在等待期；最早 ' + formatTime(hold.retryAt) + ' 后恢复');
    if (!confirm('已在官网处理验证/访问问题？确认后重新加载并重新检查房源。')) return;
    set('networkHold', null);
    set('scanFailure', null);
    deliveryContext = null;
    nextRefresh = 0;
    networkRefreshPending = true;
    location.reload();
  });
  register('设置预算（主租金上限）', () => {
    requireIdle();
    const configProblem = currentConfigProblem();
    if (configProblem || settingsReloadPending) throw Error('请先刷新页面或重新导入配置，再修改预算：' + configProblem);
    const value = prompt('输入每月主租金上限（欧元，不含额外费用；0 < 金额 ≤ 100000，最多两位小数）：', String(maxRent()));
    if (value === null) return;
    const budget = parseBudget(value);
    if (budget === null) throw Error('预算须大于 0、最高 100000 欧元，最多两位小数');
    const updated = validateConfig({...settings, maxRent: budget});
    set('config', updated);
    set('maxRent', budget);
    settings = updated;
    deliveryContext = null;
    lastScope = '';
    nextRefresh = 0;
    dirty = true;
    retryAt = 0;
    set('notifyExisting', false);
    set('silentBaseline', false);
    setStatus('预算已保存', '新预算 €' + budget + '；下次完整扫描后按新预算核对通知');
  });
  register('恢复故障暂停并立即检查', async () => {
    requireIdle();
    if (get('paused', false)) throw Error('监控同时处于手动暂停，请先通过“暂停 / 恢复”恢复');
    await runScan(true);
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
    render();
  });
  register('重新通知当前符合条件的房源（强制重发）', () => {
    requireIdle();
    const filters = requireFilters();
    if (!configured()) throw Error('请先配置 Telegram');
    if (!confirm('下一次预算内扫描后，重新发送当前扫描范围内所有符合条件的房源？')) return;
    set('notifyExisting', scopeFor(filters)); set('silentBaseline', false); dirty = true; retryAt = 0;
    render();
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
      debounce = setTimeout(() => { dirty = true; retryAt = Math.max(retryAt, readScanFailure().retryAt || 0, Date.now() + scanDelay(2000)); }, scanDelay(1200));
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
      dirty = true; nextRefresh = 0; retryAt = Math.max(readScanFailure().retryAt || 0, Date.now() + scanDelay(2000));
      if (event.isTrusted) maintenanceUntil = Date.now() + MANUAL_SETTLE_MS;
      render();
    }
  });
  document.addEventListener('click', event => {
    if (event.isTrusted && event.target.closest?.('.residence_pagination,#filter_accordion,.selected_filter,[data-cy="ProductSort-root"]')) {
      maintenanceUntil = Date.now() + MANUAL_SETTLE_MS;
      if (!deliveryRunning) dirty = true;
    }
  });
  networkReceiver = signal => {
    if (!isLeader) { bufferNetworkSignal(signal); return; }
    applyNetworkSignal(signal).catch(error => setMessage('接口状态处理失败：' + error.message));
  };
  render();
  if (!navigator.locks) { setMessage('此浏览器不支持 Web Locks；请使用更新的 Chrome、Edge 或 Firefox'); return; }
  setMessage('等待监控锁；同一配置只允许一个标签页运行');
  navigator.locks.request('h2s-monitor:' + STORAGE_PREFIX, async () => {
    isLeader = true;
    for (const signal of earlyNetworkSignals.splice(0)) await applyNetworkSignal(signal);
    const interval = setInterval(safe(tick), scanDelay(5000));
    await tick();
    await new Promise(resolve => window.addEventListener('pagehide', resolve, {once: true}));
    clearInterval(interval);
    observer.disconnect();
    networkObserver.cleanup();
    isLeader = false;
  }).catch(error => setMessage('监控锁异常：' + error.message));
})();
