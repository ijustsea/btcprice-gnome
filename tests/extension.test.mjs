import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {stripTypeScriptTypes} from 'node:module';

// Exercise the extension's actual orchestration with Shell, Soup and timers replaced;
// the isolated Shell smoke covers real actors and HTTP.
const emitted = stripTypeScriptTypes(readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;$/gm, '').replace('export default class', 'return class');

function harness() {
    const h = {launches: [], watches: new Map()};
    let nextWatch = 1;
    class Base {uuid = 'btcprice@test';}
    class Client {constructor() {h.client = this;} close() {this.closed = true;}}
    class Controller {
        constructor(options) {this.options = options; this.calls = []; h.controller = this;}
        start() {this.calls.push('start');}
        refresh() {this.calls.push('refresh'); return Promise.resolve();}
        pause() {this.calls.push('pause');}
        resume() {this.calls.push('resume');}
        stop() {this.calls.push('stop');}
    }
    class Indicator {
        button = {};
        constructor(actions) {h.actions = actions; h.indicator = this;}
        update(view) {h.view = view;}
        destroy() {this.destroyed = true;}
    }
    const monitor = {
        add_idle_watch(ms, callback) {const id = nextWatch++; h.watches.set(id, {kind: 'idle', ms, callback}); return id;},
        add_user_active_watch(callback) {const id = nextWatch++; h.watches.set(id, {kind: 'active', callback}); return id;},
        remove_watch(id) {h.watches.delete(id);},
    };
    h.fire = kind => {
        for (const [id, watch] of [...h.watches]) if (watch.kind === kind) {
            if (kind === 'active') h.watches.delete(id); // Mutter active watches are one-shot.
            watch.callback();
        }
    };
    class Cancellable {cancel() {this.cancelled = true;} is_cancelled() {return !!this.cancelled;}}
    const Gio = {Cancellable, AppInfo: {launch_default_for_uri_async(uri) {h.launches.push(uri);}, launch_default_for_uri_finish() {}}};
    const Main = {panel: {addToStatusArea(uuid) {h.added = uuid;}}};
    const Extension = new Function('Gio', 'Extension', 'Main', 'PriceClient', 'PriceController', 'PriceIndicator', 'global', 'logError', emitted)(
        Gio, Base, Main, Client, Controller, Indicator, {backend: {get_core_idle_monitor: () => monitor}}, () => {});
    h.extension = new Extension();
    h.extension.enable();
    return h;
}

test('enable adds the indicator, starts polling and registers a 5-minute idle watch', () => {
    const h = harness();
    assert.equal(h.added, 'btcprice@test');
    assert.deepEqual(h.controller.calls, ['start']);
    const idle = [...h.watches.values()].filter(watch => watch.kind === 'idle');
    assert.equal(idle.length, 1);
    assert.equal(idle[0].ms, 300000);
    assert.equal(h.launches.length, 0, 'no browser is opened by enabling');
    h.controller.options.publish({quote: null, failing: false, paused: false});
    assert.deepEqual(h.view, {quote: null, failing: false, paused: false});
    h.extension.disable();
});

test('menu actions refresh at once and open the Coinbase chart only on request', () => {
    const h = harness();
    h.actions.refresh();
    assert.deepEqual(h.controller.calls, ['start', 'refresh']);
    h.actions.openChart();
    assert.deepEqual(h.launches, ['https://www.tradingview.com/chart/?symbol=COINBASE%3ABTCUSD']);
    h.extension.disable();
});

test('idle pauses polling, any input resumes it, and repeated idle signals add no second watch', () => {
    const h = harness();
    h.fire('idle');
    h.fire('idle');
    assert.deepEqual(h.controller.calls, ['start', 'pause']);
    assert.equal([...h.watches.values()].filter(watch => watch.kind === 'active').length, 1);
    h.fire('active');
    assert.deepEqual(h.controller.calls, ['start', 'pause', 'resume']);
    h.extension.disable();
});

test('disable stops polling, closes the connection and removes the UI and every watch', () => {
    const h = harness();
    h.fire('idle');
    const controller = h.controller, indicator = h.indicator;
    const pending = [...h.watches.values()].map(watch => watch.callback);
    h.extension.disable();
    assert.equal(controller.calls.at(-1), 'stop');
    assert.equal(h.client.closed, true);
    assert.equal(indicator.destroyed, true);
    assert.equal(h.watches.size, 0, 'idle and pending active watches are removed');
    for (const callback of pending) callback(); // A watch already dispatched by Mutter.
    controller.options.publish({quote: null, failing: true, paused: false});
    assert.equal(controller.calls.at(-1), 'stop', 'late callbacks after disable do nothing');
});

test('after a lock-screen disable/enable the last price shows at once, marked not live', () => {
    const h = harness();
    const quote = {source: 'coinbase', price: 61763.77, receivedAt: 1};
    h.controller.options.publish({quote, failing: false, paused: false});
    h.extension.disable();
    h.view = null;
    h.extension.enable();
    assert.deepEqual(h.view, {quote, failing: false, paused: true});
    h.extension.disable();
});
