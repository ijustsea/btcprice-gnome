// Real GNOME smoke in a separate bus, configuration, runtime and headless compositor,
// against a local fake Coinbase/Binance server (no internet needed).
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, readFile, appendFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {nextDelaySeconds} from '../build/price.js';

const repo = resolve(import.meta.dirname, '..');
if (process.argv[2] !== '--inner') {
    // A private bus with its own runtime dir keeps portal/gvfs activation away from the host session.
    const runtime = await mkdtemp(join(tmpdir(), 'btcprice-bus-'));
    const r = spawnSync('dbus-run-session', ['--', process.execPath, import.meta.filename, '--inner'],
        {env: {...process.env, XDG_RUNTIME_DIR: runtime}, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024});
    await rm(runtime, {recursive: true, force: true});
    if (r.error) throw r.error;
    if (r.status !== 0) console.error(r.stderr.slice(-12000));
    console.log(r.stdout.trim());
    process.exit(r.status ?? 1);
}

const modes = {coinbase: 'ok', binance: 'ok'};
const counts = {coinbase: 0, binance: 0};
const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/mode') {
        for (const key of ['coinbase', 'binance']) if (url.searchParams.has(key)) modes[key] = url.searchParams.get(key);
        response.end(JSON.stringify(counts));
        return;
    }
    const source = url.pathname.slice(1);
    if (!(source in counts)) { response.writeHead(404).end(); return; }
    counts[source]++;
    if (modes[source] === 'rate-limited') { response.writeHead(429, {'Retry-After': '120'}).end(); return; }
    if (modes[source] !== 'ok') { response.writeHead(503).end('{"message":"unavailable"}'); return; }
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(source === 'coinbase' ? JSON.stringify({price: '61763.77', time: new Date().toISOString()})
        : '{"symbol":"BTCUSDT","price":"61770.30000000"}');
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

const meta = JSON.parse(await readFile(join(repo, 'metadata.json'), 'utf8'));
const scratch = await mkdtemp(join(tmpdir(), 'btcprice-shell-'));
const env = {...process.env, XDG_CONFIG_HOME: join(scratch, 'config'), XDG_DATA_HOME: join(scratch, 'data'), XDG_CACHE_HOME: join(scratch, 'cache'),
    XDG_RUNTIME_DIR: join(scratch, 'runtime'), GSETTINGS_BACKEND: 'keyfile', LIBGL_ALWAYS_SOFTWARE: '1', NO_AT_BRIDGE: '1',
    GIO_USE_VFS: 'local', GIO_USE_VOLUME_MONITOR: 'unix', BTCPRICE_TEST_BASE: base, BTCPRICE_UI_REPORT: join(scratch, 'ui-report.json')};
for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR']) await mkdir(env[key], {recursive: true, mode: 0o700});
const extension = join(env.XDG_DATA_HOME, 'gnome-shell/extensions', meta.uuid);
await mkdir(extension, {recursive: true});
const run = (bin, args) => {
    const r = spawnSync(bin, args, {env, encoding: 'utf8', timeout: 5000});
    if (r.status !== 0) throw new Error(`${bin} ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
};
run('unzip', ['-q', join(repo, 'dist', meta.uuid + '.shell-extension.zip'), '-d', extension]);
await appendFile(join(extension, 'extension.js'), await readFile(join(repo, 'tests/fixtures/shell-ui-probe.js'), 'utf8'));
run('gsettings', ['set', 'org.gnome.shell', 'enabled-extensions', `['${meta.uuid}']`]);
run('gsettings', ['set', 'org.gnome.shell', 'disable-user-extensions', 'false']);

let log = '';
const shell = spawn('gnome-shell', ['--wayland', '--headless', '--no-x11', '--virtual-monitor', process.env.BTCPRICE_TEST_MONITOR ?? '1280x720',
    '--wayland-display', 'btcprice-' + process.pid, '--debug-control'], {env, stdio: ['ignore', 'pipe', 'pipe']});
shell.stdout.on('data', b => { log = (log + b).slice(-12000); });
shell.stderr.on('data', b => { log = (log + b).slice(-12000); });
let exited = false;
shell.on('exit', () => { exited = true; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const call = (method, ...args) => run('gdbus', ['call', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/org/gnome/Shell', '--method', method, ...args]);
const near = (actual, want) => typeof actual === 'number' && actual > want - 1.5 && actual <= want + 1;
const fail = (message, value) => { throw new Error(`${message}: ${JSON.stringify(value)}`); };
try {
    let info = '';
    for (let i = 0; i < 80; i++) {
        if (exited) throw new Error('Headless Shell exited');
        try { info = call('org.gnome.Shell.Extensions.GetExtensionInfo', meta.uuid); if (/['"]state['"]: <(?:uint32 )?1(?:\.0)?>/.test(info)) break; } catch {}
        await sleep(250);
    }
    if (!/['"]state['"]: <(?:uint32 )?1(?:\.0)?>/.test(info)) throw new Error('Extension not enabled: ' + info);
    let report = null;
    for (let i = 0; i < 150 && !report; i++) { try { report = JSON.parse(await readFile(env.BTCPRICE_UI_REPORT, 'utf8')); } catch { await sleep(100); } }
    if (!report) fail('Probe report not produced', null);
    if (report.error) fail('Probe failed', report.error);
    const [healthy, backoff] = [nextDelaySeconds(0), nextDelaySeconds(1)];
    if (report.first !== 'BTC $61,764' || !near(report.firstDelay, healthy)) fail(`First Coinbase price or ${healthy} s schedule missing`, report);
    if (Math.max(...report.widths) - Math.min(...report.widths) > 0.5) fail('Digits are not tabular; the panel would shift', report.widths);
    if (report.steady.length !== 1 || report.steady[0] !== 'BTC $61,764') fail('Panel text changed during a refresh', report.steady);
    if (report.fallback.text !== 'BTC 61,770 USDT' || report.fallback.source !== 'Binance' || report.fallback.price !== '61,770.30 USDT'
        || !report.fallback.status.startsWith('대체 시세') || !near(report.fallback.delay, healthy))
        fail('Binance fallback not shown', report.fallback);
    if (report.allFail.text !== 'BTC ~61,770 USDT' || !report.allFail.status.includes('재시도') || !near(report.allFail.delay, backoff))
        fail(`Total failure must keep the last price marked not live and back off to ${backoff} s`, report.allFail);
    if (report.recovered.text !== 'BTC $61,764' || report.recovered.source !== 'Coinbase' || report.recovered.price !== '$61,763.77'
        || report.recovered.status.includes('재시도') || !near(report.recovered.delay, healthy))
        fail(`Recovery to Coinbase and ${healthy} s failed`, report.recovered);
    if (!report.refreshButton.open || report.refreshButton.reads !== 1) fail('Refresh must read once and keep the menu open', report.refreshButton);
    if (report.chartButton.open || report.chartButton.charts !== 1) fail('The chart button must close the menu and open the chart once', report.chartButton);
    if (report.colors.price !== report.colors.menu) fail('The menu card text is dimmed', report.colors);
    if (report.allFail.opacity >= 255 || report.recovered.opacity !== 255) fail('Only a price that is not live is dimmed in the menu', [report.allFail, report.recovered]);
    if (report.menu.x < 0 || report.menu.x + report.menu.width > report.menu.stageWidth + 1) fail('Menu overflows the screen', report.menu);
    // first + width restore + steady + fallback + all-fail + recovery + Refresh button reads; Binance only on Coinbase failure.
    if (report.counts.coinbase !== 7 || report.counts.binance !== 2) fail('Unexpected request counts', report.counts);
    const errors = call('org.gnome.Shell.Extensions.GetExtensionErrors', meta.uuid);
    if (!/\(\[\]|@as \[\]/.test(errors)) fail('Extension errors', errors);
    call('org.gnome.Shell.Extensions.DisableExtension', meta.uuid);
    const afterDisable = {...counts};
    await sleep(6250);
    if (counts.coinbase !== afterDisable.coinbase || counts.binance !== afterDisable.binance) fail('Requests continued after disable', counts);
    // Unlock while the network is still down: the last price must stay, marked not live.
    await fetch(`${base}/mode?coinbase=fail&binance=fail`);
    call('org.gnome.Shell.Extensions.EnableExtension', meta.uuid);
    const readRestore = async number => {
        for (let i = 0; i < 50; i++) {
            try { return JSON.parse(await readFile(env.BTCPRICE_UI_REPORT + '.reenable-' + number, 'utf8')); }
            catch { await sleep(100); }
        }
        return null;
    };
    const unlock = await readRestore(1);
    if (unlock?.atEnable.text !== 'BTC $61,764' || unlock.afterRead.text !== 'BTC ~$61,764'
        || unlock.afterRead.source !== 'Coinbase' || !unlock.afterRead.status.includes('재시도'))
        fail('After an offline unlock the last price must stay, marked not live', unlock);
    call('org.gnome.Shell.Extensions.DisableExtension', meta.uuid);
    call('org.gnome.Shell.Extensions.EnableExtension', meta.uuid);
    const failingRestore = await readRestore(2);
    if (failingRestore?.atEnable.text !== 'BTC ~$61,764' || failingRestore.afterRead.text !== 'BTC ~$61,764')
        fail('A previously failing price must keep its marker before and after the first read', failingRestore);
    if (counts.coinbase !== afterDisable.coinbase + 2 || counts.binance !== afterDisable.binance + 2)
        fail('Each re-enable should read Coinbase once, then Binance once', counts);

    // Let the real extension receive Retry-After, then recreate its controller through GNOME.
    call('org.gnome.Shell.Extensions.DisableExtension', meta.uuid);
    await fetch(`${base}/mode?coinbase=rate-limited&binance=ok`);
    const beforeLimit = {...counts};
    call('org.gnome.Shell.Extensions.EnableExtension', meta.uuid);
    const limited = await readRestore(3);
    if (limited?.afterRead.source !== 'Binance' || counts.coinbase !== beforeLimit.coinbase + 1 || counts.binance !== beforeLimit.binance + 1)
        fail('Coinbase should send a real 429 and fall back to Binance before re-enable', {limited, counts});

    call('org.gnome.Shell.Extensions.DisableExtension', meta.uuid);
    await fetch(`${base}/mode?coinbase=ok&binance=ok`);
    const beforeLimitedRestore = {...counts};
    call('org.gnome.Shell.Extensions.EnableExtension', meta.uuid);
    const limitedRestore = await readRestore(4);
    if (limitedRestore?.afterRead.source !== 'Binance' || counts.coinbase !== beforeLimitedRestore.coinbase
        || counts.binance !== beforeLimitedRestore.binance + 1)
        fail('The actual extension must keep Coinbase in server cooldown after re-enable', {limitedRestore, counts});
    const after = call('org.gnome.Shell.Extensions.GetExtensionErrors', meta.uuid);
    if (!/\(\[\]|@as \[\]/.test(after)) fail('Re-enable errors', after);
    console.log(`Panel ${report.first} (tabular widths ${report.widths.map(Math.round).join('/')}px), steady during refresh, fallback "${report.fallback.text}", all-fail backoff ${Math.round(report.allFail.delay)}s, recovery ${healthy}s, menu price "${report.recovered.price}", Refresh kept the menu open, menu ${Math.round(report.menu.width)}x${Math.round(report.menu.height)}`);
    console.log(`Restore preserves a healthy price before failure and "${failingRestore.atEnable.text}" after a previous failure`);
    console.log('Coinbase Retry-After survives an actual Shell disable/re-enable cycle while Binance remains available');
    console.log('Isolated GNOME Shell smoke passed: Coinbase first, Binance fallback, backoff, steady tabular panel, no requests after disable, offline unlock keeps the last price.');
} catch (error) {
    console.error(log);
    throw error;
} finally {
    shell.kill('SIGTERM');
    await Promise.race([new Promise(r => shell.once('exit', r)), sleep(3000)]);
    if (!exited) shell.kill('SIGKILL');
    server.close();
    await rm(scratch, {recursive: true, force: true});
}
