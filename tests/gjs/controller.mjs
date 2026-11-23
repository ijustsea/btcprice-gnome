import GLib from 'gi://GLib';
import {PriceController} from '../../build/controller.js';

const assert = (value, message) => { if (!value) throw new Error(message); };
const tick = () => new Promise(resolve => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { resolve(); return GLib.SOURCE_REMOVE; }));
const sources = [{id: 'coinbase', url: 'cb'}, {id: 'binance', url: 'bn'}];
// Seconds until the controller's scheduled read (timeout_add_seconds may add up to 1 s of coalescing).
const delay = controller => {
    const source = GLib.MainContext.default().find_source_by_id(controller.timer);
    assert(source, 'a read is scheduled');
    return (source.get_ready_time() - GLib.get_monotonic_time()) / 1e6;
};
const near = (actual, want, label) => assert(actual > want - 1.5 && actual <= want + 1, `${label}: ${actual.toFixed(1)}s, expected ${want}s`);

function harness(answers) {
    const h = {calls: [], views: [], answers};
    h.controller = new PriceController({
        sources, now: () => 1000,
        fetchPrice: (url, cancellable) => {
            h.calls.push(url);
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
    near(delay(h.controller), 15, 'healthy interval');

    h.answers.cb = new Error('HTTP 503'); h.calls.length = 0;
    await h.controller.refresh();
    assert(h.calls.join() === 'cb,bn' && h.views.at(-1).quote.source === 'binance' && !h.views.at(-1).failing, 'Binance answers only after Coinbase fails');
    near(delay(h.controller), 15, 'a successful fallback keeps 15 s');

    h.answers.bn = new Error('offline'); h.calls.length = 0;
    await h.controller.refresh();
    assert(h.views.at(-1).failing && h.views.at(-1).quote.price === 61725.04, 'all sources failing keeps the last price and reports it');
    near(delay(h.controller), 30, 'first total failure backs off');
    await h.controller.refresh();
    near(delay(h.controller), 60, 'second total failure backs off further');

    h.answers.cb = 61800; h.calls.length = 0;
    await h.controller.refresh();
    assert(h.calls.join() === 'cb' && h.views.at(-1).quote.source === 'coinbase' && !h.views.at(-1).failing, 'Coinbase is retried first and recovery clears the failure');
    near(delay(h.controller), 15, 'recovery returns to 15 s');

    const before = h.calls.length;
    const first = h.controller.refresh(), second = h.controller.refresh();
    assert(first === second, 'overlapping refreshes share one read'); await first;
    assert(h.calls.length === before + 1, 'only one request for overlapping refreshes');

    h.controller.pause();
    assert(h.controller.timer === 0 && h.views.at(-1).paused, 'pause stops polling and marks the price as not live');
    await h.controller.refresh();
    assert(h.controller.timer === 0, 'a manual read while paused schedules nothing');
    const resumedAt = h.calls.length; h.controller.resume();
    assert(h.controller.pending !== null && h.calls.length === resumedAt + 1, 'resume reads at once'); await h.controller.pending;
    assert(!h.views.at(-1).paused, 'the fresh price is live again');
    near(delay(h.controller), 15, 'resume restores the interval');
    h.controller.stop();
    assert(h.controller.timer === 0, 'stop removes the timer');

    const idle = harness({cb: 1});
    idle.controller.pause(); idle.controller.start();
    assert(idle.calls.length === 0 && idle.controller.timer === 0, 'starting while paused does not read');
    idle.controller.stop();

    const stopped = harness({cb: 'hang'});
    stopped.controller.start(); const views = stopped.views.length;
    await tick(); stopped.controller.stop(); await tick();
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
    print('Controller GJS checks passed: Coinbase first, Binance fallback, backoff, recovery, coalescing, pause/resume, stop, restart guard, UI errors');
};
const loop = new GLib.MainLoop(null, false);
let failed = null;
run().catch(error => { failed = error; }).finally(() => loop.quit());
loop.run();
if (failed) throw failed;
