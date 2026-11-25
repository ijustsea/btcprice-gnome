import GLib from 'gi://GLib';
import {PriceController} from '../../build/controller.js';
import {nextDelaySeconds, PriceHttpError, statusText} from '../../build/price.js';

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

const reading = price => ({price, tradedAt: 1000, tradeAgeMs: 0});

function harness(answers, initialView = undefined, serverCooldowns = new Map()) {
    const h = {calls: [], views: [], cancellables: [], answers};
    h.controller = new PriceController({
        sources, now: () => 1000, monotonicNow: () => h.now ?? 1000, initialView, serverCooldowns,
        fetchPrice: ({url}, cancellable) => {
            h.calls.push(url);
            h.cancellables.push(cancellable);
            const answer = h.answers[url];
            if (answer === 'hang') return new Promise((_resolve, reject) => cancellable.connect(() => reject(new Error('cancelled'))));
            return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(reading(answer));
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
    gates[0](reading(1)); await tick(); await tick();
    assert(restart.views.length === 0, 'a read from before stop does not publish after restart');
    gates[1](reading(2)); await restart.controller.pending;
    assert(restart.views.length === 1 && restart.views[0].quote.price === 2, 'the read after restart publishes');
    restart.controller.stop();

    // A UI error after a successful Coinbase read is not a Coinbase failure.
    const ui = harness({cb: 61763.77, bn: 61725.04});
    ui.controller.options.publish = () => { throw new Error('UI failure'); };
    ui.controller.start();
    await ui.controller.pending.catch(() => {});
    assert(ui.calls.join() === 'cb' && ui.controller.view.failing === false, 'Binance is not asked and no backoff starts after a UI error');
    ui.controller.stop();

    // After an unlock the new controller starts from the last price and keeps it if the network is not back yet.
    const last = {source: 'coinbase', ...reading(61763.77), receivedAt: 1};
    const unlock = harness({cb: new Error('offline'), bn: new Error('offline')}, {quote: last, failing: false});
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
    const coldRestore = harness({cb: 'hang'}, fresh.views[0]);
    coldRestore.controller.start();
    assert(coldRestore.views.length === 1 && statusText(coldRestore.views[0], 1000) === '가격을 받지 못했습니다 · 재시도 중',
        'the no-price failure is visible before any reenabled request settles');
    const coldPending = coldRestore.controller.pending;
    coldRestore.controller.stop();
    await coldPending;

    // An automatic poll keeps serving Binance while the short Coinbase outage backoff runs.
    const ordinary = harness({cb: new Error('offline'), bn: 61725.04});
    ordinary.controller.start(); await ordinary.controller.pending;
    ordinary.now = 6000;
    await ordinary.controller.poll(false);
    assert(ordinary.calls.join() === 'cb,bn,bn', 'ordinary Coinbase outage does not halve the successful Binance refresh rate');
    ordinary.now = 11000;
    ordinary.answers.cb = 61800;
    await ordinary.controller.poll(false);
    assert(ordinary.calls.join() === 'cb,bn,bn,cb', 'Coinbase is tried first again when its local backoff expires');
    ordinary.controller.stop();

    const brieflyHealthy = harness({cb: new Error('offline'), bn: new Error('offline')});
    brieflyHealthy.controller.start(); await brieflyHealthy.controller.pending;
    brieflyHealthy.now = 6000;
    brieflyHealthy.answers.cb = 61800;
    await brieflyHealthy.controller.refresh();
    brieflyHealthy.now = 10000;
    brieflyHealthy.answers.cb = new Error('offline');
    await brieflyHealthy.controller.poll(false);
    assert(brieflyHealthy.calls.join() === 'cb,bn,cb,cb', 'Coinbase recovery does not clear an active Binance outage backoff');
    near(delay(brieflyHealthy.controller), 1, 'a nearly eligible source does not wait another healthy poll interval');
    brieflyHealthy.controller.stop();

    const serverCooldowns = new Map();
    const limited = harness({cb: new PriceHttpError(429, 120000, 'cb'), bn: 61725.04}, undefined, serverCooldowns);
    limited.controller.start(); await limited.controller.pending;
    limited.now = 6000;
    await limited.controller.poll(false);
    await limited.controller.refresh();
    assert(limited.calls.join() === 'cb,bn,bn,bn', 'automatic and manual refreshes skip Coinbase during Retry-After');
    const initialView = limited.views.at(-1);
    limited.controller.stop();
    const blocked = harness({cb: 61800, bn: new PriceHttpError(418, 240000, 'bn')}, initialView, serverCooldowns);
    blocked.now = 6000;
    blocked.controller.start(); await blocked.controller.pending;
    assert(blocked.calls.join() === 'bn', 'server cooldown survives controller recreation');
    near(delay(blocked.controller), 115, 'only one timer waits for the first eligible source');
    blocked.controller.retryIfFailing();
    await blocked.controller.refresh();
    assert(blocked.calls.join() === 'bn', 'connectivity and Refresh do not bypass either server cooldown');
    blocked.now = 120999;
    await blocked.controller.poll(false);
    assert(blocked.calls.join() === 'bn', 'an early timer cannot read a still-limited source');
    blocked.now = 121000;
    await blocked.controller.poll(false);
    assert(blocked.calls.join() === 'bn,cb' && blocked.views.at(-1).quote.price === 61800 && !blocked.views.at(-1).failing,
        'recovery tries Coinbase exactly when its server cooldown expires');
    blocked.controller.stop();

    const blockedWithoutHeader = harness({cb: new Error('offline'), bn: new PriceHttpError(418, null, 'bn')});
    blockedWithoutHeader.controller.start(); await blockedWithoutHeader.controller.pending;
    // A Coinbase success clears the expired local Binance delay, but leaves the 418 restriction.
    blockedWithoutHeader.now = 11000;
    blockedWithoutHeader.answers.cb = 61800;
    await blockedWithoutHeader.controller.refresh();
    blockedWithoutHeader.now = 120999;
    blockedWithoutHeader.answers.cb = new PriceHttpError(429, 120000, 'cb');
    await blockedWithoutHeader.controller.refresh();
    blockedWithoutHeader.controller.retryIfFailing();
    await blockedWithoutHeader.controller.refresh();
    assert(blockedWithoutHeader.calls.join() === 'cb,bn,cb,cb', '418 without Retry-After blocks Binance until two minutes, even after Coinbase recovery and Refresh');
    blockedWithoutHeader.now = 121000;
    blockedWithoutHeader.answers.bn = 61725.04;
    await blockedWithoutHeader.controller.poll(false);
    assert(blockedWithoutHeader.calls.join() === 'cb,bn,cb,cb,bn' && !blockedWithoutHeader.views.at(-1).failing,
        'Binance is eligible as soon as the default two-minute restriction expires');
    blockedWithoutHeader.controller.stop();

    // Recovery arriving during a first read is remembered and coalesced until that read settles.
    const recovering = harness({}, {quote: last, failing: true});
    let finishOldRead;
    recovering.controller.options.fetchPrice = ({url}) => {
        recovering.calls.push(url);
        if (recovering.calls.length === 1) return new Promise((_resolve, reject) => { finishOldRead = reject; });
        if (url === 'bn') return Promise.reject(new Error('old connection'));
        return Promise.resolve(reading(61800));
    };
    recovering.controller.start();
    const original = recovering.controller.pending;
    assert(recovering.views[0].failing && recovering.views[0].quote === last, 'offline unlock preserves the failure marker immediately');
    recovering.controller.retryIfFailing();
    recovering.controller.retryIfFailing();
    finishOldRead(new Error('old connection'));
    await original;
    await recovering.controller.pending;
    assert(recovering.calls.join() === 'cb,bn,cb' && recovering.views.at(-1).quote.price === 61800,
        'one immediate follow-up only after the active poll failed');
    recovering.controller.stop();

    const noRetry = harness({});
    let finishSuccess;
    noRetry.controller.options.fetchPrice = ({url}) => {
        noRetry.calls.push(url);
        return new Promise(resolve => { finishSuccess = resolve; });
    };
    noRetry.controller.start();
    noRetry.controller.retryIfFailing();
    finishSuccess(reading(61800));
    await noRetry.controller.pending;
    assert(noRetry.calls.join() === 'cb', 'a queued network event does not duplicate a successful poll');
    noRetry.controller.stop();

    // Each source's failure is logged once per streak, until that source succeeds itself.
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
    assert(warnings.length === 3 && /coinbase/.test(warnings[2]), 'one source recovering does not end the other source failure streak: ' + warnings);
    logs.controller.stop();

    warnings.length = 0;
    const recoveredAfterExpiry = harness({cb: new Error('offline'), bn: new Error('offline')});
    recoveredAfterExpiry.controller.start(); await recoveredAfterExpiry.controller.pending;
    recoveredAfterExpiry.now = 11000;
    recoveredAfterExpiry.answers.cb = 61800;
    await recoveredAfterExpiry.controller.poll(false);
    recoveredAfterExpiry.now = 16000;
    recoveredAfterExpiry.answers.cb = new Error('new outage');
    await recoveredAfterExpiry.controller.poll(false);
    assert(warnings.filter(message => message.includes('binance')).length === 2, 'an expired Binance failure is logged as a new outage after Coinbase recovered');
    recoveredAfterExpiry.now = 26000;
    await recoveredAfterExpiry.controller.poll(false);
    assert(recoveredAfterExpiry.calls.join() === 'cb,bn,cb,cb,bn,cb,bn', 'a new Binance outage restarts at ten seconds');
    recoveredAfterExpiry.controller.stop();
    print('Controller GJS checks passed: fallback and per-source backoff, server cooldown across restart, coalesced network recovery, shutdown and unlock failure state');
};
const loop = new GLib.MainLoop(null, false);
let failed = null;
run().catch(error => { failed = error; }).finally(() => loop.quit());
loop.run();
if (failed) throw failed;
