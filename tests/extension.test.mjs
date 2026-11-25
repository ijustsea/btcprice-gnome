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
        retryIfFailing() {this.calls.push('retryIfFailing');}
        stop() {this.calls.push('stop');}
    }
    class Indicator {
        button = {};
        constructor(actions) {h.actions = actions; h.indicator = this; h.updates = 0;}
        update(view) {h.view = view; h.updates++;}
        destroy() {this.destroyed = true;}
    }
    // Recorded so a test can show that keyboard or pointer idleness never pauses polling.
    const monitor = {
        add_idle_watch(ms, callback) {const id = nextWatch++; h.watches.set(id, {kind: 'idle', ms, callback}); return id;},
        add_user_active_watch(callback) {const id = nextWatch++; h.watches.set(id, {kind: 'active', callback}); return id;},
        remove_watch(id) {h.watches.delete(id);},
    };
    class Cancellable {cancel() {this.cancelled = true;} is_cancelled() {return !!this.cancelled;}}
    const NetworkConnectivity = {LOCAL: 1, LIMITED: 2, PORTAL: 3, FULL: 4};
    h.network = {handlers: new Map(), next: 1, connectivity: NetworkConnectivity.FULL,
        connect(signal, callback) {const id = this.next++; this.handlers.set(id, {signal, callback}); return id;},
        disconnect(id) {this.handlers.delete(id);},
        set(connectivity) {
            this.connectivity = NetworkConnectivity[connectivity];
            for (const {signal, callback} of this.handlers.values()) if (signal === 'notify::connectivity') callback(this);
        }};
    const Gio = {Cancellable, NetworkConnectivity, NetworkMonitor: {get_default: () => h.network},
        AppInfo: {launch_default_for_uri_async(uri, context) {h.launches.push({uri, context});}, launch_default_for_uri_finish() {}}};
    const Main = {panel: {addToStatusArea(uuid) {h.added = uuid;}}};
    const Extension = new Function('Gio', 'Extension', 'Main', 'PriceClient', 'PriceController', 'PriceIndicator', 'global', 'logError', emitted)(
        Gio, Base, Main, Client, Controller, Indicator,
        {backend: {get_core_idle_monitor: () => monitor}, create_app_launch_context: (time, workspace) => ({launchContext: [time, workspace]})}, () => {});
    h.extension = new Extension();
    h.extension.enable();
    return h;
}

test('enable adds the indicator and starts polling', () => {
    const h = harness();
    assert.equal(h.added, 'btcprice@test');
    assert.deepEqual(h.controller.calls, ['start']);
    assert.equal(h.launches.length, 0, 'no browser is opened by enabling');
    h.controller.options.publish({quote: null, failing: false});
    assert.deepEqual(h.view, {quote: null, failing: false});
    h.extension.disable();
});

test('enable registers no input-idle watch (the removed 5-minute pause)', () => {
    const h = harness();
    assert.equal(h.watches.size, 0, 'the screen blanking or locking disables the extension instead');
    h.extension.disable();
});

test('menu actions refresh at once and open the Coinbase chart only on request', () => {
    const h = harness();
    h.actions.refresh();
    assert.deepEqual(h.controller.calls, ['start', 'refresh']);
    h.actions.openChart();
    assert.deepEqual(h.launches, [{uri: 'https://www.tradingview.com/chart/?symbol=COINBASE%3ABTCUSD', context: {launchContext: [0, -1]}}],
        'opened with a Shell launch context, like GNOME Shell itself');
    h.extension.disable();
});

test('full internet connectivity again retries at once; losing it or partial connectivity does nothing', () => {
    const h = harness();
    h.network.set('LOCAL');
    h.network.set('PORTAL');
    assert.deepEqual(h.controller.calls, ['start']);
    h.network.set('FULL');
    assert.deepEqual(h.controller.calls, ['start', 'retryIfFailing']);
    h.extension.disable();
});

test('disable stops polling, closes the connection and removes the UI and the network handler', () => {
    const h = harness();
    const controller = h.controller, indicator = h.indicator;
    h.extension.disable();
    assert.equal(h.network.handlers.size, 0);
    assert.equal(controller.calls.at(-1), 'stop');
    assert.equal(h.client.closed, true);
    assert.equal(indicator.destroyed, true);
    const updates = h.updates;
    controller.options.publish({quote: null, failing: true});
    assert.equal(h.updates, updates, 'a late result after disable does not reach the destroyed UI');
});

test('after a lock-screen disable/enable the new controller starts from the last price', () => {
    const h = harness();
    assert.equal(h.controller.options.initialQuote, null, 'nothing to show on the first enable');
    const quote = {source: 'coinbase', price: 61763.77, receivedAt: 1};
    h.controller.options.publish({quote, failing: false});
    h.extension.disable();
    h.extension.enable();
    assert.deepEqual(h.controller.options.initialQuote, quote);
    h.extension.disable();
});
