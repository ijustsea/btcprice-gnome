import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {PriceClient} from '../../build/client.js';

const assert = (value, message) => { if (!value) throw new Error(message); };
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
const fails = async (path, cancellable = new Gio.Cancellable()) => {
    try { await client.fetchPrice(base + path, cancellable); } catch (error) { return error; }
    return null;
};

const run = async () => {
    assert(await client.fetchPrice(base + '/coinbase', new Gio.Cancellable()) === 61763.77, 'Coinbase body parsed');
    assert(await client.fetchPrice(base + '/binance', new Gio.Cancellable()) === 61725.04, 'Binance body parsed');
    assert(ports.length === 2 && ports[0] === ports[1], 'consecutive healthy reads reuse one connection: ' + ports.join());
    assert((await fails('/error'))?.message.includes('HTTP 503'), 'HTTP errors reject with the status');
    assert(await fails('/html'), 'a non-JSON body rejects');
    assert((await fails('/big'))?.message.includes('exceeds'), 'an oversized body is rejected, not buffered');
    assert(await client.fetchPrice(base + '/limit', new Gio.Cancellable()) === 61763.77, 'a body just under the bound is accepted');
    const cancellable = new Gio.Cancellable();
    const pending = fails('/hang', cancellable);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => { cancellable.cancel(); return GLib.SOURCE_REMOVE; });
    assert(await pending, 'cancellation rejects a hanging request');
    const midBody = new Gio.Cancellable();
    const stalled = fails('/stall', midBody);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => { midBody.cancel(); return GLib.SOURCE_REMOVE; });
    const started = GLib.get_monotonic_time();
    assert(await stalled && GLib.get_monotonic_time() - started < 2e6, 'cancelling in the middle of a body rejects promptly');
    client.close();
    print('Client GJS checks passed: real HTTP pipes, both body shapes, status, non-JSON, 16 KiB bound, connection reuse, cancellation incl. mid-body');
};
const loop = new GLib.MainLoop(null, false);
let failed = null;
run().catch(error => { failed = error; }).finally(() => loop.quit());
loop.run();
server.disconnect();
if (failed) throw failed;
