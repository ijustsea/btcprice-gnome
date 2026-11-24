import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {PriceClient} from '../../build/client.js';
import {POLL_SECONDS} from '../../build/price.js';

// The real APIs are HTTPS and offer HTTP/2, so these checks run against a local TLS server that does the same.
const assert = (value, message) => { if (!value) throw new Error(message); };
// The server exits and deletes its certificate when its stdin closes, even if this process is killed.
const server = Gio.Subprocess.new(['node', 'tests/fixtures/tls-server.mjs'], Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
const output = new Gio.DataInputStream({base_stream: server.get_stdout_pipe()});
const readLine = () => new Promise((resolve, reject) => output.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
    try { resolve(stream.read_line_finish_utf8(result)[0]); } catch (error) { reject(error); }
}));
const sleep = seconds => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, seconds * 1000, () => { resolve(); return GLib.SOURCE_REMOVE; }));
const fails = async promise => { try { await promise; } catch (error) { return error; } return null; };

const run = async () => {
    const [tlsPort, , certPath] = (await readLine()).split(' ');
    const requests = [];
    void (async () => { for (let line; (line = await readLine()) !== null;) requests.push(line.split(' ')); })().catch(() => {});
    const base = `https://127.0.0.1:${tlsPort}`;
    const client = new PriceClient();
    // Trust the fixture's self-signed certificate in this client only.
    client.session.tls_database = Gio.TlsFileDatabase.new(certPath);

    const redirected = await fails(client.fetchPrice(base + '/redirect', new Gio.Cancellable()));
    assert(redirected?.message.includes('HTTP 302'), 'a redirect is a failure, not followed: ' + redirected);

    // Both run at once: a whole poll interval of idle time, and a body that trickles past the deadline.
    const started = GLib.get_monotonic_time();
    const [, trickled] = await Promise.all([
        (async () => {
            await client.fetchPrice(base + '/price', new Gio.Cancellable());
            await sleep(POLL_SECONDS);
            await client.fetchPrice(base + '/price', new Gio.Cancellable());
        })(),
        (async () => {
            // Without a working deadline this test still ends (and fails) instead of hanging.
            const guard = new Gio.Cancellable();
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 13, () => { guard.cancel(); return GLib.SOURCE_REMOVE; });
            const error = await fails(client.fetchPrice(base + '/trickle', guard));
            return {error, seconds: (GLib.get_monotonic_time() - started) / 1e6};
        })(),
    ]);
    assert(trickled.error?.message.includes('within 10 s') && trickled.seconds >= 9.8 && trickled.seconds < 11.5,
        `a trickling body is cut off at the 10 s deadline: ${trickled.error} after ${trickled.seconds.toFixed(1)} s`);
    await sleep(0.2);
    assert(!requests.some(([protocol]) => protocol === 'plain'), 'the redirect did not reach the plain-HTTP target');
    assert(requests.every(([protocol]) => protocol === '1.1'), 'every request uses HTTP/1.1: ' + requests.map(r => r.join(' ')).join('; '));
    const polls = requests.filter(([, , path]) => path === '/price');
    assert(polls.length === 2 && polls[0][1] === polls[1][1], `one TLS connection serves polls ${POLL_SECONDS} s apart: ` + polls.map(r => r[1]).join(', '));
    client.close();
    print(`Transport GJS checks passed over local TLS: HTTP/1.1 connection reused across ${POLL_SECONDS} s, redirect refused, 10 s deadline`);
};
const loop = new GLib.MainLoop(null, false);
let failed = null;
run().catch(error => { failed = error; }).finally(() => loop.quit());
loop.run();
server.get_stdin_pipe().close(null);
server.wait(null);
if (failed) throw failed;
