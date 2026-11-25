import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseMarketPrice, formatPrice, isLive, panelText, menuPrice, sourceName, statusText, nextDelaySeconds, SOURCES, STALE_MS} from '../build/price.js';

const now = 1_800_000_000_000;
const view = (source, changes = {}) => ({quote: {source, price: 61763.77, receivedAt: now, tradedAt: now, tradeAgeMs: 0}, failing: false, ...changes});
const parsePrice = (body, source = 'coinbase') => parseMarketPrice(body, source, null, null).price;

test('Coinbase is asked first and Binance only as the fallback', () => {
    assert.deepEqual(SOURCES.map(source => source.id), ['coinbase', 'binance']);
    assert.match(SOURCES[0].url, /^https:\/\/api\.exchange\.coinbase\.com\/products\/BTC-USD\/ticker$/);
    assert.match(SOURCES[1].url, /^https:\/\/api\.binance\.com\/api\/v3\/ticker\/price\?symbol=BTCUSDT$/);
});

test('both real response shapes parse to the price', () => {
    assert.equal(parsePrice('{"ask":"61764.10","bid":"61763.76","volume":"8231.2","trade_id":1,"price":"61763.77","size":"0.01","time":"2026-11-23T17:27:15.491339698Z"}'), 61763.77);
    assert.equal(parsePrice('{"symbol":"BTCUSDT","price":"61725.04000000"}', 'binance'), 61725.04);
});

test('Coinbase freshness uses server Date and cache Age, independent of the PC clock at receipt', () => {
    const trade = '2026-11-23T17:27:15.491339698Z';
    const parsed = parseMarketPrice(JSON.stringify({price: '61763.77', time: trade}), 'coinbase',
        Date.parse('2026-11-23T17:27:16Z'), '60');
    assert.equal(parsed.tradedAt, Date.parse(trade));
    assert.equal(parsed.tradeAgeMs, 60509);
    const stale = {quote: {...parsed, source: 'coinbase', receivedAt: now}, failing: false};
    assert.equal(panelText(stale, now), 'BTC ~$61,764');
    assert.match(statusText(stale, now), /오래된 체결/);
    const unknown = {...stale, quote: {...stale.quote, tradeAgeMs: null}};
    assert.match(statusText(unknown, now), /신선도 미확인/);
    assert.equal(isLive(unknown, now), false);
});

test('Coinbase tolerates HTTP Date precision, leaves invalid dates unknown, and ages a known trade after receipt', () => {
    const parse = (time, date) => parseMarketPrice(JSON.stringify({price: '61763.77', time}), 'coinbase', date, null);
    const trade = '2026-11-23T17:27:15.491339698Z';
    const date = Date.parse('2026-11-23T17:27:15Z');
    assert.equal(parse(trade, date).tradeAgeMs, 0);
    assert.equal(parse(trade, date - 10000).tradeAgeMs, null);
    assert.equal(parse(trade, null).tradeAgeMs, null);
    assert.equal(parse('2026-02-30T17:27:15Z', date).tradedAt, null);
    const nearlyOld = {quote: {...parse(trade, date + 59000), source: 'coinbase', receivedAt: now}, failing: false};
    assert.equal(isLive(nearlyOld, now), true);
    assert.equal(isLive(nearlyOld, now + 2000), false);
});

test('Binance accepts only BTCUSDT and displays receive time', () => {
    for (const body of ['{"symbol":"ETHUSDT","price":"2345.67"}', '{"price":"2345.67"}'])
        assert.throws(() => parseMarketPrice(body, 'binance', null, null), /symbol/i);
    const parsed = parseMarketPrice('{"symbol":"BTCUSDT","price":"61725.04"}', 'binance', null, null);
    assert.equal(parsed.price, 61725.04);
    assert.match(statusText({quote: {...parsed, source: 'binance', receivedAt: now}, failing: false}, now), /수신/);
});

test('Coinbase accepts up to three seconds of clock skew without subtracting cache age', () => {
    const trade = '2026-11-23T17:27:15Z';
    const date = Date.parse(trade) - 3000;
    const body = JSON.stringify({price: '61763.77', time: trade});
    const price = parseMarketPrice(body, 'coinbase', date, '61');
    assert.equal(price.tradeAgeMs, 61_000);
    assert.equal(isLive({quote: {...price, source: 'coinbase', receivedAt: now}, failing: false}, now), false);
    assert.equal(parseMarketPrice(body, 'coinbase', date, null).tradeAgeMs, 0);
    assert.equal(parseMarketPrice(body, 'coinbase', date - 1, '61').tradeAgeMs, null);
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
    assert.equal(statusText({quote: null, failing: false}, now), '가격 확인 중…');
    assert.equal(statusText({quote: null, failing: true}, now), '가격을 받지 못했습니다 · 재시도 중');
    assert.match(statusText(view('coinbase'), now), /^\d{2}:\d{2}:\d{2} 체결$/);
    assert.match(statusText(view('coinbase', {failing: true}), now), /^\d{2}:\d{2}:\d{2} 체결 · 재시도 중$/);
    assert.match(statusText(view('binance'), now), /^대체 시세 · \d{2}:\d{2}:\d{2} 수신$/);
    assert.match(statusText(view('binance', {failing: true}), now), /^대체 시세 · .* 수신 · 재시도 중$/);
});

test('local polling and failure delays range from 5 seconds to one minute', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 50, 5000].map(nextDelaySeconds), [5, 10, 20, 40, 60, 60, 60]);
});
