import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parsePrice, formatPrice, panelText, statusText, nextDelaySeconds, SOURCES, STALE_MS} from '../build/price.js';

const now = 1_800_000_000_000;
const view = (source, changes = {}) => ({quote: {source, price: 61763.77, receivedAt: now}, failing: false, paused: false, ...changes});

test('Coinbase is asked first and Binance only as the fallback', () => {
    assert.deepEqual(SOURCES.map(source => source.id), ['coinbase', 'binance']);
    assert.match(SOURCES[0].url, /^https:\/\/api\.exchange\.coinbase\.com\/products\/BTC-USD\/ticker$/);
    assert.match(SOURCES[1].url, /^https:\/\/api\.binance\.com\/api\/v3\/ticker\/price\?symbol=BTCUSDT$/);
});

test('both real response shapes parse to the price', () => {
    assert.equal(parsePrice('{"ask":"61764.10","bid":"61763.76","volume":"8231.2","trade_id":1,"price":"61763.77","size":"0.01","time":"2026-11-23T17:27:15.491339698Z"}'), 61763.77);
    assert.equal(parsePrice('{"symbol":"BTCUSDT","price":"61725.04000000"}'), 61725.04);
});

test('anything but a positive decimal price string is rejected rather than shown', () => {
    for (const body of ['[]', 'null', '"61763"', '{}', '{"price":61763.77}', '{"price":"-1"}', '{"price":"0"}', '{"price":"0.0"}',
        '{"price":"1e5"}', '{"price":" 61763"}', '{"price":"61,763"}', '{"price":"1234567890"}', '{"price":""}', 'not json'])
        assert.throws(() => parsePrice(body), body);
});

test('prices round to whole dollars with thousands separators', () => {
    assert.equal(formatPrice(61763.77), '61,764');
    assert.equal(formatPrice(61763.49), '61,763');
    assert.equal(formatPrice(999.5), '1,000');
    assert.equal(formatPrice(1234567.4), '1,234,567');
    assert.equal(formatPrice(42), '42');
});

test('panel shows Coinbase in dollars and a Binance fallback in USDT', () => {
    assert.equal(panelText({quote: null, failing: false, paused: false}, now), 'BTC —');
    assert.equal(panelText(view('coinbase'), now), 'BTC $61,764');
    assert.equal(panelText(view('binance'), now), 'BTC 61,764 USDT');
});

test('a price is marked not live only after a failed poll, while paused or when over a minute old', () => {
    assert.equal(panelText(view('coinbase'), now + STALE_MS), 'BTC $61,764');
    assert.equal(panelText(view('coinbase'), now + STALE_MS + 1), 'BTC ~$61,764');
    assert.equal(panelText(view('coinbase', {failing: true}), now), 'BTC ~$61,764', 'shown from the first failed poll');
    assert.equal(panelText(view('binance', {failing: true}), now), 'BTC ~61,764 USDT');
    assert.equal(panelText(view('coinbase', {paused: true}), now), 'BTC ~$61,764');
});

test('menu status names the source, the time of the price and any retry or pause', () => {
    assert.equal(statusText({quote: null, failing: false, paused: false}), '가격 확인 중…');
    assert.equal(statusText({quote: null, failing: true, paused: false}), '가격을 받지 못했습니다 · 재시도 중');
    assert.match(statusText(view('coinbase')), /^Coinbase · \d{2}:\d{2}:\d{2} 기준$/);
    assert.match(statusText(view('binance', {failing: true})), /^Binance \(Coinbase 응답 없음\) · .* · 재시도 중$/);
    assert.match(statusText(view('coinbase', {paused: true, failing: true})), / · 자리 비움으로 일시정지$/);
});

test('polling is every 15 s and backs off only after every source failed', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map(nextDelaySeconds), [15, 30, 60, 120, 240, 300, 300, 300]);
});
