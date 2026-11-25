import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parsePrice, formatPrice, isLive, panelText, menuPrice, sourceName, statusText, nextDelaySeconds, SOURCES, STALE_MS} from '../build/price.js';

const now = 1_800_000_000_000;
const view = (source, changes = {}) => ({quote: {source, price: 61763.77, receivedAt: now}, failing: false, ...changes});

test('Coinbase is asked first and Binance only as the fallback', () => {
    assert.deepEqual(SOURCES.map(source => source.id), ['coinbase', 'binance']);
    assert.match(SOURCES[0].url, /^https:\/\/api\.exchange\.coinbase\.com\/products\/BTC-USD\/ticker$/);
    assert.match(SOURCES[1].url, /^https:\/\/api\.binance\.com\/api\/v3\/ticker\/price\?symbol=BTCUSDT$/);
});

test('both real response shapes parse to the price', () => {
    assert.equal(parsePrice('{"ask":"61764.10","bid":"61763.76","volume":"8231.2","trade_id":1,"price":"61763.77","size":"0.01","time":"2026-11-23T17:27:15.491339698Z"}'), 61763.77);
    assert.equal(parsePrice('{"symbol":"BTCUSDT","price":"61725.04000000"}'), 61725.04);
});

test('anything but a decimal price string of at least 1 is rejected rather than shown', () => {
    for (const body of ['[]', 'null', '"61763"', '{}', '{"price":61763.77}', '{"price":"-1"}', '{"price":"0"}', '{"price":"0.0"}',
        '{"price":"0.4"}', '{"price":"0.999999999999"}', '{"price":"1e5"}', '{"price":" 61763"}', '{"price":"61,763"}',
        '{"price":"1234567890"}', '{"price":""}', 'not json'])
        assert.throws(() => parsePrice(body), body);
    assert.equal(parsePrice('{"price":"1"}'), 1, 'the smallest accepted price');
});

test('server text in a rejected price stays on one log line', () => {
    assert.throws(() => parsePrice('{"price":"61763\\nBTC Price: forged line"}'),
        error => !error.message.includes('\n') && error.message.includes('\\n'));
});

test('prices round to whole dollars with thousands separators', () => {
    assert.equal(formatPrice(61763.77), '61,764');
    assert.equal(formatPrice(61763.49), '61,763');
    assert.equal(formatPrice(999.5), '1,000');
    assert.equal(formatPrice(1234567.4), '1,234,567');
    assert.equal(formatPrice(42), '42');
});

test('the menu shows the exact price to the cent', () => {
    assert.equal(formatPrice(61763.77, 2), '61,763.77');
    assert.equal(formatPrice(61770.3, 2), '61,770.30');
    assert.equal(formatPrice(1, 2), '1.00');
    assert.equal(formatPrice(61763.776, 2), '61,763.78');
    assert.equal(formatPrice(999999999.99, 2), '999,999,999.99', 'nine integer digits, the most parsePrice accepts');
    assert.equal(menuPrice({quote: null, failing: false}), '—');
    assert.equal(menuPrice(view('coinbase')), '$61,763.77');
    assert.equal(menuPrice(view('binance')), '61,763.77 USDT');
    assert.deepEqual(['coinbase', 'binance'].map(sourceName), ['Coinbase', 'Binance']);
});

test('panel shows Coinbase in dollars and a Binance fallback in USDT', () => {
    assert.equal(panelText({quote: null, failing: false}, now), 'BTC —');
    assert.equal(panelText(view('coinbase'), now), 'BTC $61,764');
    assert.equal(panelText(view('binance'), now), 'BTC 61,764 USDT');
});

test('a price is marked not live only after a failed poll or when over a minute old', () => {
    assert.equal(panelText(view('coinbase'), now + STALE_MS), 'BTC $61,764');
    assert.equal(panelText(view('coinbase'), now + STALE_MS + 1), 'BTC ~$61,764');
    assert.equal(panelText(view('coinbase', {failing: true}), now), 'BTC ~$61,764', 'shown from the first failed poll');
    assert.equal(panelText(view('binance', {failing: true}), now), 'BTC ~61,764 USDT');
    assert.deepEqual([isLive(view('coinbase'), now + STALE_MS), isLive(view('coinbase'), now + STALE_MS + 1),
        isLive(view('coinbase', {failing: true}), now), isLive({quote: null, failing: false}, now)], [true, false, false, false]);
});

test('menu status gives the time of the price, why Binance is shown and any retry', () => {
    assert.equal(statusText({quote: null, failing: false}), '가격 확인 중…');
    assert.equal(statusText({quote: null, failing: true}), '가격을 받지 못했습니다 · 재시도 중');
    assert.match(statusText(view('coinbase')), /^\d{2}:\d{2}:\d{2} 기준$/);
    assert.match(statusText(view('coinbase', {failing: true})), /^\d{2}:\d{2}:\d{2} 기준 · 재시도 중$/);
    assert.match(statusText(view('binance')), /^Coinbase 응답 없음 · \d{2}:\d{2}:\d{2} 기준$/);
    assert.match(statusText(view('binance', {failing: true})), /^Coinbase 응답 없음 · .* 기준 · 재시도 중$/);
});

test('polling is every 5 s and backs off to at most a minute only after every source failed', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 50, 5000].map(nextDelaySeconds), [5, 10, 20, 40, 60, 60, 60]);
});
