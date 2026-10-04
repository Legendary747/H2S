'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../h2s-monitor.user.js');
const base = 'https://www.holland2stay.com/residences';
const now = Date.parse('2026-10-04T18:00:00Z');
const response = (status, headers = {}, url = base + '?page=2') => ({
  status, url, getHeader: name => headers[name.toLowerCase()] || null
});

test('network classification excludes third-party hosts, assets, and challenge telemetry', () => {
  for (const url of ['https://api.telegram.org/api/foo', 'https://holland2stay.com.evil.example/graphql',
    'http://www.holland2stay.com/graphql', 'https://www.holland2stay.com:8080/graphql',
    '/cdn-cgi/challenge-platform/check', '/assets/api.js', '/graphql.js', '', undefined]) {
    assert.equal(core.classifyH2SResponse({...response(429), url}, now, base), null, String(url));
  }
  for (const url of ['/graphql', '/graphql?operationName=Products', '/rest/V1/products', '/api/products',
    '/residences?page=2', 'https://holland2stay.com/graphql']) {
    assert.equal(core.classifyH2SResponse(response(429, {}, url), now, base).kind, 'rate-limit', url);
  }
});

test('network classification distinguishes challenge, explicit 403, and server/network failure', () => {
  assert.deepEqual(core.classifyH2SResponse(response(200, {'cf-mitigated': 'challenge'}), now), {
    url: base, status: 200, kind: 'challenge', retryAt: 0
  });
  assert.equal(core.classifyH2SResponse(response(429, {'cf-mitigated': ' Challenge '}), now).kind, 'challenge');
  assert.equal(core.classifyH2SResponse(response(403), now).kind, 'blocked');
  for (const status of [500, 502, 503, 599]) {
    assert.equal(core.classifyH2SResponse(response(status), now).kind, 'temporary');
    assert.equal(core.classifyH2SResponse(response(status), now).retryAt, now + 60000);
  }
  assert.equal(core.classifyH2SResponse({...response(0), networkError: true}, now).kind, 'temporary');
  for (const status of [0, 200, 204, 302, 400, 401, 404, 600]) assert.equal(core.classifyH2SResponse(response(status), now), null);
});

test('H2S Retry-After honors seconds and HTTP dates and safely defaults when unavailable', () => {
  const classify = value => core.classifyH2SResponse(response(429, {'retry-after': value}), now).retryAt;
  assert.equal(classify('600'), now + 600000);
  assert.equal(classify('0'), now);
  assert.equal(classify(' Sun, 04 Oct 2026 18:20:00 GMT '), now + 1200000);
  assert.equal(classify('Sun, 04 Oct 2026 17:00:00 GMT'), now);
  for (const value of ['', 'wait', '-1', '1.5', '9'.repeat(400)]) {
    assert.equal(classify(value), now + 60000);
  }
  assert.equal(core.classifyH2SResponse({url: base, status: 429, getHeader() { throw Error('unavailable'); }}, now).retryAt, now + 60000);
});

test('fetch observer preserves original promise, this/arguments, response, and untouched body', async () => {
  const signals = [];
  let reads = 0;
  const res = {status: 429, url: base + '?token=private', headers: {get: name => name === 'Retry-After' ? '600' : null},
    text() { reads++; return Promise.resolve('caller body'); }, clone() { throw Error('observer must not clone'); }};
  const result = Promise.resolve(res);
  const receiver = {};
  const request = {url: base + '?page=2'};
  const init = {credentials: 'include'};
  const page = {fetch(...args) { assert.equal(this, receiver); assert.deepEqual(args, [request, init]); return result; }};
  const original = page.fetch;
  const observer = core.installH2SNetworkObserver(page, signal => signals.push(signal), {now: () => now, baseUrl: base});
  assert.equal(observer.fetch, true);
  assert.equal(observer.xhr, false);
  assert.equal(page.fetch.call(receiver, request, init), result);
  assert.equal(await result, res);
  assert.equal(reads, 0);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].retryAt, now + 600000);
  assert.equal(signals[0].url, base, 'query secrets are excluded from reported URLs');
  assert.equal(await res.text(), 'caller body');
  observer.cleanup();
  assert.equal(page.fetch, original);
});

test('fetch rejection is unchanged; aborts and third-party failures produce no signal', async () => {
  for (const [url, name, expected] of [['/graphql', 'TypeError', 1], ['/graphql', 'AbortError', 0],
    ['https://api.telegram.org/api/x', 'TypeError', 0], ['/cdn-cgi/challenge-platform/h/b', 'TypeError', 0]]) {
    const signals = [];
    const error = Object.assign(Error('request failed'), {name});
    const result = Promise.reject(error);
    const page = {fetch() { return result; }};
    const observer = core.installH2SNetworkObserver(page, signal => signals.push(signal), {now: () => now});
    const actual = page.fetch(url);
    assert.equal(actual, result);
    await assert.rejects(actual, actualError => actualError === error);
    assert.equal(signals.length, expected);
    observer.cleanup();
  }
});

test('observer callback/getter exceptions cannot break fetch and cleanup suppresses in-flight reports', async () => {
  const res = {status: 403, url: base, headers: {get() { return null; }}};
  const page = {fetch() { return Promise.resolve(res); }};
  const observer = core.installH2SNetworkObserver(page, () => { throw Error('UI failed'); });
  assert.equal(await page.fetch('/graphql'), res);
  assert.equal(await page.fetch({get url() { throw Error('getter failed'); }}), res);
  observer.cleanup();
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  const signals = [];
  page.fetch = () => pending;
  const second = core.installH2SNetworkObserver(page, signal => signals.push(signal));
  const originalResult = page.fetch('/graphql');
  second.cleanup();
  complete(res);
  assert.equal(await originalResult, res);
  assert.equal(signals.length, 0);
});

function fakeXHR() {
  return class XHR extends EventTarget {
    open(...args) {
      if (args[1] === 'bad') throw this.openError;
      this.openArgs = args;
      this.status = 0;
      this.responseURL = '';
      this.responseHeaders = {};
      return 'original open result';
    }
    send(...args) {
      if (this.sendError) throw this.sendError;
      this.sendArgs = args;
      return 'original send result';
    }
    getResponseHeader(name) { return this.responseHeaders[name.toLowerCase()] || null; }
    complete({status = 200, url = '', headers = {}, event} = {}) {
      this.status = status;
      this.responseURL = url;
      this.responseHeaders = headers;
      if (event) this.dispatchEvent(new Event(event));
      this.dispatchEvent(new Event('loadend'));
    }
  };
}

test('XHR observer preserves open/send binding, arguments/results and request URL across reuse', () => {
  const signals = [];
  const XHR = fakeXHR();
  const originalOpen = XHR.prototype.open;
  const originalSend = XHR.prototype.send;
  const observer = core.installH2SNetworkObserver({XMLHttpRequest: XHR}, signal => signals.push(signal), {now: () => now});
  assert.equal(observer.xhr, true);
  const first = new XHR();
  const second = new XHR();
  assert.equal(first.open('POST', '/graphql', true, 'user', 'password'), 'original open result');
  assert.deepEqual(first.openArgs, ['POST', '/graphql', true, 'user', 'password']);
  const payload = {data: 'body'};
  assert.equal(first.send(payload), 'original send result');
  assert.deepEqual(first.sendArgs, [payload]);
  second.open('GET', '/rest/V1/products');
  second.send();
  second.complete({status: 403});
  first.complete({status: 429, headers: {'retry-after': '120'}});
  assert.deepEqual(signals.map(signal => signal.url), ['https://www.holland2stay.com/rest/V1/products', 'https://www.holland2stay.com/graphql']);
  assert.equal(signals[1].retryAt, now + 120000);
  first.open('GET', 'https://api.telegram.org/api/x');
  first.send();
  first.complete({status: 403});
  assert.equal(signals.length, 2, 'old listeners are removed on completion');
  first.open('GET', '/api/products');
  first.send();
  first.complete({status: 200, headers: {'cf-mitigated': 'challenge'}});
  assert.equal(signals[2].kind, 'challenge');
  observer.cleanup();
  assert.equal(XHR.prototype.open, originalOpen);
  assert.equal(XHR.prototype.send, originalSend);
});

test('XHR abort is ignored but network errors and timeouts are temporary failures', () => {
  const signals = [];
  const XHR = fakeXHR();
  const observer = core.installH2SNetworkObserver({XMLHttpRequest: XHR}, signal => signals.push(signal), {now: () => now});
  for (const event of ['abort', 'error', 'timeout']) {
    const xhr = new XHR();
    xhr.open('GET', '/graphql');
    xhr.send();
    xhr.complete({status: 0, event});
  }
  assert.deepEqual(signals.map(signal => signal.kind), ['temporary', 'temporary']);
  observer.cleanup();
});

test('XHR synchronous errors are preserved and do not leave a spurious completion listener', () => {
  const signals = [];
  const XHR = fakeXHR();
  const observer = core.installH2SNetworkObserver({XMLHttpRequest: XHR}, signal => signals.push(signal));
  const xhr = new XHR();
  xhr.openError = Error('open failure');
  assert.throws(() => xhr.open('GET', 'bad'), error => error === xhr.openError);
  xhr.open('GET', '/graphql');
  xhr.sendError = Error('send failure');
  assert.throws(() => xhr.send(), error => error === xhr.sendError);
  xhr.complete({status: 403});
  assert.equal(signals.length, 0);
  observer.cleanup();
});

test('non-writable hooks report unavailable gracefully and revert partial XHR installation', () => {
  const XHR = fakeXHR();
  const originalOpen = XHR.prototype.open;
  const originalSend = XHR.prototype.send;
  Object.defineProperty(XHR.prototype, 'send', {writable: false});
  const page = {XMLHttpRequest: XHR};
  const fetch = () => Promise.resolve({});
  Object.defineProperty(page, 'fetch', {value: fetch, writable: false});
  const observer = core.installH2SNetworkObserver(page, () => {});
  assert.equal(observer.fetch, false);
  assert.equal(observer.xhr, false);
  assert.equal(page.fetch, fetch);
  assert.equal(XHR.prototype.open, originalOpen);
  assert.equal(XHR.prototype.send, originalSend);
  observer.cleanup();
});

test('cleanup does not overwrite hooks subsequently installed by the page', () => {
  const XHR = fakeXHR();
  const page = {XMLHttpRequest: XHR, fetch() { return Promise.resolve({}); }};
  const observer = core.installH2SNetworkObserver(page, () => {});
  const laterFetch = () => {};
  const laterOpen = () => {};
  const laterSend = () => {};
  page.fetch = laterFetch;
  XHR.prototype.open = laterOpen;
  XHR.prototype.send = laterSend;
  observer.cleanup();
  assert.equal(page.fetch, laterFetch);
  assert.equal(XHR.prototype.open, laterOpen);
  assert.equal(XHR.prototype.send, laterSend);
});
