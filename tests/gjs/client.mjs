import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';
import {PriceClient} from '../../build/client.js';

const assert = (value, message) => { if (!value) throw new Error(message); };
// No deadline timer or handler on the caller's cancellable may outlive a request, whatever its outcome.
const deadlines = [];
const timeoutAdd = GLib.timeout_add;
GLib.timeout_add = (priority, interval, callback) => {
    const id = timeoutAdd(priority, interval, callback);
    if (interval === 10_000) deadlines.push(id);
    return id;
};
const callers = [];
const caller = () => { const cancellable = new Gio.Cancellable(); callers.push(cancellable); return cancellable; };
const cancelled = GObject.signal_lookup('cancelled', Gio.Cancellable);
// A real local HTTP server, so the client's Soup pipes, status handling and size bound are exercised.
const server = new Soup.Server({});
const routes = {
    '/coinbase': [200, '{"ask":"61764.10","price":"61763.77","time":"2026-11-23T17:27:15Z"}'],
    '/binance': [200, '{"symbol":"BTCUSDT","price":"61725.04000000"}'],
    '/error': [503, '{"message":"unavailable"}'],
    '/html': [200, '<html>maintenance</html>'],
    '/big': [200, '{"price":"61763.77","pad":"' + 'x'.repeat(20000) + '"}'],
    '/limit': [200, '{"price":"61763.77","pad":"' + 'x'.repeat(16 * 1024 - 32) + '"}'],
};
const ports = [];
server.add_handler(null, (_server, message, path) => {
    ports.push(message.get_remote_address().get_port());
    if (path === '/hang') { message.pause(); return; }
    if (path === '/stall') {
        // Headers and part of the body arrive, then the server stops sending.
        message.set_status(200, null);
        message.get_response_headers().set_encoding(Soup.Encoding.CHUNKED);
        message.get_response_body().append(new TextEncoder().encode('{"price":"617'));
        message.pause();
        return;
    }
    const [status, body] = routes[path] ?? [404, '{}'];
    message.set_status(status, null);
    message.set_response('application/json', Soup.MemoryUse.COPY, new TextEncoder().encode(body));
});
server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
const base = server.get_uris()[0].to_string().replace(/\/$/, '');
const client = new PriceClient();
const source = (path, id = 'coinbase') => ({id, url: base + path});
const fails = async (path, cancellable = caller(), id = 'coinbase') => {
    try { await client.fetchPrice(source(path, id), cancellable); } catch (error) { return error; }
    return null;
};

const run = async () => {
    assert((await client.fetchPrice(source('/coinbase'), caller())).price === 61763.77, 'Coinbase body parsed');
    assert((await client.fetchPrice(source('/binance', 'binance'), caller())).price === 61725.04, 'Binance body parsed');
    assert(ports.length === 2 && ports[0] === ports[1], 'consecutive healthy reads reuse one connection: ' + ports.join());
    assert((await fails('/error'))?.message.includes('HTTP 503'), 'HTTP errors reject with the status');
    assert(await fails('/html'), 'a non-JSON body rejects');
    assert((await fails('/big'))?.message.includes('exceeds'), 'an oversized body is rejected, not buffered');
    assert((await client.fetchPrice(source('/limit'), caller())).price === 61763.77, 'a body just under the bound is accepted');
    const cancellable = caller();
    const pending = fails('/hang', cancellable);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => { cancellable.cancel(); return GLib.SOURCE_REMOVE; });
    assert(await pending, 'cancellation rejects a hanging request');
    const midBody = caller();
    const stalled = fails('/stall', midBody);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => { midBody.cancel(); return GLib.SOURCE_REMOVE; });
    const started = GLib.get_monotonic_time();
    assert(await stalled && GLib.get_monotonic_time() - started < 2e6, 'cancelling in the middle of a body rejects promptly');
    assert(deadlines.length === callers.length && deadlines.every(id => !GLib.MainContext.default().find_source_by_id(id)),
        `every request's deadline timer is gone once it settles (${deadlines.length} timers, ${callers.length} requests)`);
    assert(callers.every(cancellable => !GObject.signal_has_handler_pending(cancellable, cancelled, 0, false)),
        'no request leaves a handler on the caller\'s cancellable');
    client.close();
    print('Client GJS checks passed: real HTTP pipes, both body shapes, status, non-JSON, 16 KiB bound, connection reuse, cancellation incl. mid-body, no leftover timers or handlers');
};
const loop = new GLib.MainLoop(null, false);
let failed = null;
run().catch(error => { failed = error; }).finally(() => loop.quit());
loop.run();
server.disconnect();
if (failed) throw failed;
