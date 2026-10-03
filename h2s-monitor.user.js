// ==UserScript==
// @name         H2S — Den Haag housing monitor
// @namespace    https://github.com/Legendary747/H2S
// @version      1.2.0
// @description  Scan all H2S cities and locally notify for The Hague, Rijswijk, Rotterdam, Leiden and Zoetermeer.
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

  // City options change with availability. Never depend on them to find future listings.
  const TARGET_CITIES = ['The Hague', 'Rijswijk', 'Rotterdam', 'Leiden', 'Zoetermeer'];
  const MAX_RENT = 1000;
  const AUTO_RESET_FILTERS = true;
  // Keep the original @name and prefix so an in-place update preserves Telegram configuration.
  const STORAGE_PREFIX = 'h2s_single_city_den_haag';
  const TIME_ZONE = 'Europe/Amsterdam';
  const START_HOUR = 7;
  const END_HOUR = 23;
  const REFRESH_MINUTES = [5, 15];
  const MIN_SETTLE_MS = 10000;
  const MAX_SETTLE_MS = 30000;
  const MAX_PAGES = 50;
  const VERSION = 1;

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
    if (!root) return {ok: false, unknown: true, reason: '尚未加载已应用筛选区域'};
    const inputs = [...doc.querySelectorAll('[aria-label^="Filter products by "] input[type="checkbox"], [aria-label^="Filter products by "] input[type="radio"]')];
    const selected = inputs.some(input => input.checked);
    const ok = root.children.length === 0 && !text(root) && !selected;
    return {ok, unknown: false, reason: ok ? '' : '页面存在筛选条件；需要恢复全部城市列表'};
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
  function validateSweep(listings, total) {
    if (new Set(listings.map(item => item.url)).size !== total || listings.length !== total) throw Error('分页结果不完整或重复；本轮不更新历史');
  }
  function freshState(scope) { return {version: VERSION, scope, initialized: false, items: {}, sent: 0}; }
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
      save(state);
      sent++;
    }
    return sent;
  }

  // The userscript is also directly importable by the offline regression tests.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {cityKey, cityKeys, matchesCity, money, rentFromText, normalizeUrl, directStatus, parseCard, parsePage, pagination,
      filterState, challenge, withinHours, validateSweep, freshState, reconcile, deliverPending};
    return;
  }
  if (!/^\/residences\/?$/.test(location.pathname)) return; // Never run on a booking/detail page.

  const key = name => STORAGE_PREFIX + ':' + name;
  const get = (name, fallback) => GM_getValue(key(name), fallback);
  const set = (name, value) => GM_setValue(key(name), value);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const formatTime = value => value ? new Intl.DateTimeFormat('zh-CN', {timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'}).format(new Date(value)) : '—';
  let scanRunning = false;
  let isLeader = false;
  let nextRefresh = 0;
  let retryAt = 0;
  let dirty = true;
  let lastScope = '';
  let nextTelegramAttempt = 0;
  let retryNoticeAt = 0;
  let daytime = withinHours();
  let maintenanceUntil = 0;
  const stats = {message: '正在启动', scanned: 0, matched: 0, pages: 0, telegram: '未配置', sent: 0};
  const panel = document.createElement('aside');
  panel.id = 'h2s-monitor-panel';
  Object.assign(panel.style, {position: 'fixed', right: '16px', bottom: '84px', zIndex: '2147483646', padding: '14px 16px',
    width: '300px', maxWidth: '80vw', background: '#102c32', color: '#efffff', font: '13px/1.6 system-ui,sans-serif',
    border: '1px solid #75c8d2', borderRadius: '12px', boxShadow: '0 6px 28px #0005', whiteSpace: 'pre-wrap'});
  document.body.append(panel);
  function configured() { return Boolean(get('token', '') && get('chatId', '')); }
  function render() {
    const state = get('state', null);
    panel.textContent = ['H2S · 五城市监控 · 主租金 ≤ €' + MAX_RENT, CITY_LABEL,
      (isLeader ? '' : '待机：') + stats.message,
      '全站扫描 ' + stats.scanned + ' 套 · 五城符合 ' + stats.matched + ' 套 · 第 ' + stats.pages + ' 页',
      '本轮通知 ' + stats.sent + ' · 累计 ' + (state?.sent || 0),
      'Telegram：' + (configured() ? stats.telegram === '未配置' ? '已配置' : stats.telegram : '未配置（菜单设置）'),
      '上次完整扫描 ' + formatTime(state?.lastCompleteScan),
      '下次刷新 ' + formatTime(nextRefresh), '自动运行 07:00–23:00 荷兰时间'].join('\n');
  }
  function setMessage(message) { stats.message = message; render(); }
  function scheduleRefresh() { nextRefresh = Date.now() + (REFRESH_MINUTES[0] + Math.random() * (REFRESH_MINUTES[1] - REFRESH_MINUTES[0])) * 60000; }
  function filtersFingerprint() {
    // Availability-derived city options must not change the baseline scope.
    return JSON.stringify(['all-cities-v1', cityKeys(TARGET_CITIES), MAX_RENT]);
  }
  function assertRunning(manual) {
    if (!isLeader || get('paused', false)) throw Error('监控已暂停');
    if (challenge(document)) throw Error('检测到验证页面，已停止操作');
    if (!manual && !withinHours()) throw Error('已进入夜间暂停时段');
    if (Date.now() < maintenanceUntil) throw Error('检测到手动操作，等待 30 秒后继续');
  }
  function assertAllowed(scope, manual) {
    assertRunning(manual);
    const filters = filterState(document);
    if (!filters.ok) throw Error(filters.reason);
    if (filtersFingerprint() !== scope) throw Error('筛选条件已改变；本轮已取消');
  }
  async function ensureUnfiltered(manual) {
    const start = Date.now();
    let resetClicked = false;
    while (Date.now() - start < MAX_SETTLE_MS) {
      assertRunning(manual);
      const filters = filterState(document);
      if (filters.ok) return;
      if (!filters.unknown && !resetClicked) {
        if (!AUTO_RESET_FILTERS) throw Error('请点击官网 Reset 清除筛选，保持全部城市');
        const reset = document.querySelector('.residenceFilter .reset_text');
        if (!reset || !/^reset$/i.test(text(reset))) throw Error('检测到筛选，但未找到 Reset；请手动清除网页筛选');
        if (Date.now() - get('lastFilterReset', 0) < 30000) throw Error('刚重置后仍有筛选，请手动点击 Reset；暂不重复刷新');
        setMessage('正在清除网页筛选，恢复全部城市列表');
        set('lastFilterReset', Date.now());
        reset.click();
        resetClicked = true;
      }
      await sleep(500);
    }
    throw Error('未能确认全部城市列表；请手动点击 Reset 后重试');
  }
  function fingerprint(result) {
    return JSON.stringify([result.total, result.page.current, result.page.last, result.listings.map(item => [item.url, item.rent, item.status])]);
  }
  async function stablePage(scope, manual, expectedPage, oldSignature = null) {
    const start = Date.now();
    let previous = null, stable = 0, lastError = '等待房源加载';
    while (Date.now() - start <= MAX_SETTLE_MS) {
      assertAllowed(scope, manual);
      try {
        const result = parsePage(document);
        const signature = fingerprint(result);
        const correctPage = !expectedPage || result.page.current === expectedPage;
        const changed = oldSignature === null || signature !== oldSignature;
        if (correctPage && changed) {
          stable = signature === previous ? stable + 1 : 1;
          previous = signature;
          if (Date.now() - start >= MIN_SETTLE_MS && stable >= 3) return result;
        } else { stable = 0; lastError = '正在等待分页内容更新'; }
      } catch (error) { stable = 0; lastError = error.message; }
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
    setMessage('遇到验证/访问受阻，请在当前页手动处理；自动刷新已停');
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
  async function runScan(manual = false) {
    if (scanRunning || !isLeader || get('paused', false)) return;
    if (!manual && !withinHours()) { nextRefresh = 0; setMessage('夜间暂停；菜单可手动立即检查'); return; }
    scanRunning = true;
    dirty = false;
    stats.sent = 0;
    let scope;
    try {
      if (challenge(document)) { await notifyBlock(); return; }
      await ensureUnfiltered(manual);
      scope = filtersFingerprint();
      lastScope = scope;
      assertAllowed(scope, manual);
      setMessage('等待全部城市列表稳定，准备扫描全部分页');
      let result = await stablePage(scope, manual);
      if (result.page.current !== 1) {
        if (!result.page.first) throw Error('找不到第 1 页，无法进行完整扫描');
        const old = fingerprint(result);
        result.page.first.click();
        result = await stablePage(scope, manual, 1, old);
      }
      const total = result.total;
      const listings = [];
      for (let n = 1; n <= MAX_PAGES; n++) {
        assertAllowed(scope, manual);
        if (result.total !== total || result.page.current !== n) throw Error('分页期间结果总数或页码变化；本轮不更新历史');
        listings.push(...result.listings);
        stats.scanned = listings.length;
        stats.matched = listings.filter(item => matchesCity(item.city, TARGET_CITIES) && item.rent <= MAX_RENT && directStatus(item.status)).length;
        stats.pages = n;
        setMessage('扫描第 ' + n + ' 页，共 ' + total + ' 套');
        if (!result.page.next) break;
        if (n === MAX_PAGES) throw Error('超过分页上限；本轮不更新历史');
        const old = fingerprint(result);
        result.page.next.click();
        result = await stablePage(scope, manual, n + 1, old);
      }
      validateSweep(listings, total);
      assertAllowed(scope, manual);
      const oldState = get('state', null);
      const targetListings = listings.filter(item => matchesCity(item.city, TARGET_CITIES));
      const notifyExisting = get('notifyExisting', false);
      const silentBaseline = get('silentBaseline', false) && !notifyExisting;
      const {state, baseline} = reconcile(oldState, targetListings, scope, TARGET_CITIES, MAX_RENT, Date.now(), {silentBaseline});
      if (notifyExisting) {
        for (const item of Object.values(state.items)) if (item.eligible && !item.missing) item.pending = {reason: '手动重新通知', detectedAt: Date.now()};
      }
      set('state', state);
      set('notifyExisting', false);
      set('silentBaseline', false);
      if (configured() && Date.now() >= nextTelegramAttempt) {
        const sentBefore = state.sent || 0;
        try {
          await deliverPending(state, async item => {
            await sleep(1100);
            assertAllowed(scope, manual);
            await sendText(listingMessage(item));
            stats.telegram = '发送成功';
          }, value => set('state', value), () => {
            try { assertAllowed(scope, manual); return true; } catch { return false; }
          });
        } catch (error) {
          nextTelegramAttempt = Date.now() + Math.max(60, error.retryAfter || 60) * 1000;
          stats.telegram = error.message;
        } finally {
          stats.sent = (state.sent || 0) - sentBefore;
        }
      }
      const pending = Object.values(state.items).filter(item => item.pending).length;
      const completion = baseline && silentBaseline ? '已按选择建立静默基线；现有房源不通知'
        : (baseline ? '首次完整扫描完成' : '完整扫描完成') + '；本轮已通知 ' + stats.sent + ' 条';
      setMessage(completion + (pending ? '；待发通知 ' + pending + ' 条' : ''));
      if (withinHours()) scheduleRefresh();
      else nextRefresh = 0;
    } catch (error) {
      setMessage(error.message);
      if (challenge(document)) await notifyBlock();
      retryAt = Date.now() + 60000;
      dirty = true;
      // Failed scans cannot suppress existing notifications or initialize the baseline.
      if (!nextRefresh && scope && withinHours() && !challenge(document)) scheduleRefresh();
    } finally {
      scanRunning = false;
      render();
    }
  }
  async function tick() {
    if (!isLeader || scanRunning) return;
    if (get('paused', false)) { nextRefresh = 0; setMessage('手动暂停；菜单可恢复'); return; }
    if (challenge(document)) { await notifyBlock(); return; }
    if (get('incident', null)) { set('incident', null); dirty = true; retryAt = 0; }
    if (!withinHours()) { daytime = false; nextRefresh = 0; setMessage('夜间暂停；菜单可手动立即检查'); return; }
    if (!filterState(document).ok) { dirty = true; nextRefresh = 0; }
    if (!daytime) { daytime = true; location.reload(); return; }
    if (lastScope && filtersFingerprint() !== lastScope) { dirty = true; retryAt = 0; nextRefresh = 0; }
    // Refresh fresh server-rendered data before starting the next scheduled cycle.
    if (nextRefresh && Date.now() >= nextRefresh && Date.now() >= maintenanceUntil) { location.reload(); return; }
    if (dirty && Date.now() >= retryAt && Date.now() >= maintenanceUntil) { await runScan(); return; }
    if (!nextRefresh) {
      if (get('state', null)?.lastCompleteScan) { scheduleRefresh(); dirty = true; }
      else dirty = true;
    }
    render();
  }
  function safe(callback) { return (...args) => { Promise.resolve().then(() => callback(...args)).catch(error => { setMessage(error.message); }); }; }
  function requireIdle() {
    if (!isLeader) throw Error('请使用正在监控的那个 H2S 标签页');
    if (scanRunning) throw Error('当前正在扫描，请扫描结束后再操作');
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
    if (!confirm('清除监控历史，并把下次完整扫描作为新基线？现有房源不会通知。')) return;
    set('state', null); set('notifyExisting', false); set('silentBaseline', true); dirty = true; retryAt = 0;
  });
  register('重新通知当前符合条件的房源（强制重发）', () => {
    requireIdle();
    if (!configured()) throw Error('请先配置 Telegram');
    if (!confirm('下一次完整扫描后，向已配置的 Telegram 重新发送当前所有符合条件的房源？')) return;
    set('notifyExisting', true); set('silentBaseline', false); dirty = true; retryAt = 0;
  });
  register('查看历史', () => {
    const state = get('state', null);
    const items = Object.values(state?.items || {}).sort((a, b) => b.lastSeen - a.lastSeen);
    alert(items.length ? items.slice(0, 100).map(item => item.title + '\n€' + item.rent + ' · ' + item.status + (item.pending ? ' · 待通知' : '') + '\n' + item.url).join('\n\n') : '暂无完整扫描历史');
  });
  register('测试 Cloudflare 提醒（仅发送测试消息）', async () => {
    await sendText('H2S 验证提醒测试 · ' + CITY_LABEL + '\n这是测试消息。真实遇到验证时，会停止自动刷新并等待你手动处理。');
    stats.telegram = '验证提醒测试成功'; render();
  });

  // Observe late cards and filter changes; ignore our own panel and pagination scan mutations.
  let debounce;
  const observer = new MutationObserver(records => {
    if (scanRunning || !isLeader) return;
    const meaningful = records.some(record => {
      const el = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      return el && !panel.contains(el) && !el.closest?.('#h2s-monitor-panel') &&
        (el.closest?.('.residence_MainSection,.selected_filter,.total_residence,#filter_accordion') || [...record.addedNodes].some(node => node.nodeType === 1 && node.matches?.('.residence_MainSection,.residence_block')));
    });
    if (meaningful) {
      clearTimeout(debounce);
      debounce = setTimeout(() => { dirty = true; retryAt = Math.min(retryAt, Date.now() + 2000); }, 1200);
    }
  });
  observer.observe(document.body, {childList: true, subtree: true, characterData: true});
  document.addEventListener('change', event => {
    if (!scanRunning && event.target.closest?.('#filter_accordion')) { dirty = true; nextRefresh = 0; retryAt = Date.now() + 2000; }
  });
  document.addEventListener('click', event => {
    if (event.isTrusted && event.target.closest?.('.residence_pagination,#filter_accordion,.selected_filter')) {
      maintenanceUntil = Date.now() + 30000;
      dirty = true;
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
