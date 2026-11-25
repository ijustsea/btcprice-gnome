import GLib from 'gi://GLib';
import {PriceController} from '../../build/controller.js';
import {nextDelaySeconds} from '../../build/price.js';

const assert = (value, message) => { if (!value) throw new Error(message); };
const tick = () => new Promise(resolve => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { resolve(); return GLib.SOURCE_REMOVE; }));
const sources = [{id: 'coinbase', url: 'cb'}, {id: 'binance', url: 'bn'}];
// Seconds until the controller's scheduled read (timeout_add_seconds may add up to 1 s of coalescing).
const delay = controller => {
    const source = GLib.MainContext.default().find_source_by_id(controller.timer);
    assert(source, 'a read is scheduled');
    return (source.get_ready_time() - GLib.get_monotonic_time()) / 1e6;
};
// Failure logs are part of the behavior under test (once per failure streak), so they are captured.
const warnings = [];
GLib.log_set_writer_func((level, fields) => {
    if (level !== GLib.LogLevelFlags.LEVEL_WARNING) return GLib.LogWriterOutput.UNHANDLED;
    warnings.push(new TextDecoder().decode(fields.MESSAGE));
    return GLib.LogWriterOutput.HANDLED;
});
const near = (actual, want, label) => assert(actual > want - 1.5 && actual <= want + 1, `${label}: ${actual.toFixed(1)}s, expected ${want}s`);

function harness(answers, initialQuote = null) {
    const h = {calls: [], views: [], cancellables: [], answers};
    h.controller = new PriceController({
        sources, now: () => 1000, initialQuote,
        fetchPrice: (url, cancellable) => {
            h.calls.push(url);
            h.cancellables.push(cancellable);
            const answer = h.answers[url];
            if (answer === 'hang') return new Promise((_resolve, reject) => cancellable.connect(() => reject(new Error('cancelled'))));
            return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
        },
        publish: view => h.views.push(view),
    });
    return h;
}

const run = async () => {
    const h = harness({cb: 61763.77, bn: 61725.04});
    h.controller.start(); await h.controller.pending;
    assert(h.calls.join() === 'cb', 'Coinbase alone answers a healthy poll');
    assert(h.views.at(-1).quote.source === 'coinbase' && h.views.at(-1).quote.price === 61763.77 && !h.views.at(-1).failing, 'Coinbase quote published');
    const [healthy, firstBackoff, secondBackoff] = [0, 1, 2].map(nextDelaySeconds);
    near(delay(h.controller), healthy, 'healthy interval');

    h.answers.cb = new Error('HTTP 503'); h.calls.length = 0;
    await h.controller.refresh();
    assert(h.calls.join() === 'cb,bn' && h.views.at(-1).quote.source === 'binance' && !h.views.at(-1).failing, 'Binance answers only after Coinbase fails');
    near(delay(h.controller), healthy, 'a successful fallback keeps the healthy interval');

    h.answers.bn = new Error('offline'); h.calls.length = 0;
    await h.controller.refresh();
    assert(h.views.at(-1).failing && h.views.at(-1).quote.price === 61725.04, 'all sources failing keeps the last price and reports it');
    near(delay(h.controller), firstBackoff, 'first total failure backs off');
    await h.controller.refresh();
    near(delay(h.controller), secondBackoff, 'second total failure backs off further');
    // The network returning (still failing here) retries at once instead of after the backoff.
    h.calls.length = 0; h.controller.retryIfFailing();
    assert(h.calls.join() === 'cb' && h.controller.pending !== null, 'a returning network retries at once while failing'); await h.controller.pending;

    h.answers.cb = 61800; h.calls.length = 0;
    await h.controller.refresh();
    assert(h.calls.join() === 'cb' && h.views.at(-1).quote.source === 'coinbase' && !h.views.at(-1).failing, 'Coinbase is retried first and recovery clears the failure');
    near(delay(h.controller), healthy, 'recovery returns to the healthy interval');

    const before = h.calls.length;
    const first = h.controller.refresh(), second = h.controller.refresh();
    assert(first === second, 'overlapping refreshes share one read'); await first;
    assert(h.calls.length === before + 1, 'only one request for overlapping refreshes');

    const healthyCalls = h.calls.length; h.controller.retryIfFailing();
    assert(h.calls.length === healthyCalls && h.controller.pending === null, 'network notifications while healthy cause no request');
    h.controller.stop();
    assert(h.controller.timer === 0, 'stop removes the timer');

    const stopped = harness({cb: 'hang'});
    stopped.controller.start(); const views = stopped.views.length;
    await tick(); stopped.controller.stop(); await tick();
    assert(stopped.cancellables[0].is_cancelled(), 'stop cancels the request in flight');
    assert(stopped.views.length === views && stopped.controller.timer === 0, 'a read cancelled by stop publishes nothing and schedules nothing');
    // A stopped read that settles after a restart must not publish over the new one.
    const gates = [];
    const restart = harness({});
    restart.controller.options.fetchPrice = () => new Promise(resolve => gates.push(resolve));
    restart.controller.start(); await tick();
    restart.controller.stop(); restart.controller.start(); await tick();
    gates[0](1); await tick(); await tick();
    assert(restart.views.length === 0, 'a read from before stop does not publish after restart');
    gates[1](2); await restart.controller.pending;
    assert(restart.views.length === 1 && restart.views[0].quote.price === 2, 'the read after restart publishes');
    restart.controller.stop();

    // A UI error after a successful Coinbase read is not a Coinbase failure.
    const ui = harness({cb: 61763.77, bn: 61725.04});
    ui.controller.options.publish = () => { throw new Error('UI failure'); };
    ui.controller.start();
    await ui.controller.pending.catch(() => {});
    assert(ui.calls.join() === 'cb' && ui.controller.failures === 0, 'Binance is not asked and no backoff starts after a UI error');
    ui.controller.stop();

    // After an unlock the new controller starts from the last price and keeps it if the network is not back yet.
    const last = {source: 'coinbase', price: 61763.77, receivedAt: 1};
    const unlock = harness({cb: new Error('offline'), bn: new Error('offline')}, last);
    unlock.controller.start();
    assert(unlock.views.length === 1 && unlock.views[0].quote === last && !unlock.views[0].failing,
        'the last price is shown at once, before the first read');
    await unlock.controller.pending;
    assert(unlock.views.at(-1).quote === last && unlock.views.at(-1).failing, 'a failed first read keeps the last price, marked not live');
    unlock.controller.stop();
    const fresh = harness({cb: new Error('offline'), bn: new Error('offline')});
    fresh.controller.start(); await fresh.controller.pending;
    assert(fresh.views.length === 1 && fresh.views[0].quote === null && fresh.views[0].failing, 'without a last price only the failure is shown');
    fresh.controller.stop();

    // Each source's failure is logged once per streak, and a streak ends once that source is no longer needed.
    warnings.length = 0;
    const fallback = harness({cb: new Error('HTTP 503'), bn: 61725.04});
    fallback.controller.start(); await fallback.controller.pending;
    await fallback.controller.refresh(); await fallback.controller.refresh();
    assert(warnings.length === 1 && /coinbase/.test(warnings[0]), 'Coinbase down for three polls while Binance answers logs once: ' + warnings);
    fallback.controller.stop();
    warnings.length = 0;
    const logs = harness({cb: new Error('HTTP 503'), bn: new Error('offline')});
    logs.controller.start(); await logs.controller.pending;
    await logs.controller.refresh();
    assert(warnings.length === 2 && /coinbase/.test(warnings[0]) && /binance/.test(warnings[1]), 'two sources failing twice log twice: ' + warnings);
    logs.answers.cb = 61763.77;
    await logs.controller.refresh();
    logs.answers.cb = new Error('HTTP 503');
    await logs.controller.refresh();
    assert(warnings.length === 4 && /binance/.test(warnings[3]), 'a Binance failure after Coinbase recovered is a new streak: ' + warnings);
    logs.controller.stop();
    print('Controller GJS checks passed: Coinbase first, Binance fallback, backoff, recovery, coalescing, network retry, stop, restart guard, UI errors, unlock keeps the last price, failure logs');
};
const loop = new GLib.MainLoop(null, false);
let failed = null;
run().catch(error => { failed = error; }).finally(() => loop.quit());
loop.run();
if (failed) throw failed;
