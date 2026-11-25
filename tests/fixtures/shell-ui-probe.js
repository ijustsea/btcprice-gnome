
// Test-only instrumentation appended to an isolated installed COPY, never the ZIP.
import ProbeGLib from 'gi://GLib';
import ProbeGio from 'gi://Gio';
import ProbeShell from 'gi://Shell';
import ProbeSoup from 'gi://Soup?version=3.0';
import {SOURCES as probeSources} from './price.js';

const probeBase = ProbeGLib.getenv('BTCPRICE_TEST_BASE');
if (probeBase) {
    probeSources[0].url = probeBase + '/coinbase';
    probeSources[1].url = probeBase + '/binance';
}
const probeWrite = (path, report) => ProbeGio.File.new_for_path(path).replace_contents(new TextEncoder().encode(JSON.stringify(report)),
    null, false, ProbeGio.FileCreateFlags.PRIVATE, null);
const probeEnable = BtcPriceExtension.prototype.enable;
BtcPriceExtension.prototype.enable = function () {
    probeEnable.call(this);
    const extension = this;
    const reportPath = ProbeGLib.getenv('BTCPRICE_UI_REPORT');
    if (!reportPath) return;
    if (extension.probed) {
        // Record the visible state immediately and after the startup poll on each re-enable.
        const restoreNumber = (extension.restoreNumber ?? 0) + 1;
        extension.restoreNumber = restoreNumber;
        const panel = () => ({text: extension.indicator.label.get_text(), source: extension.indicator.source.get_text(),
            status: extension.indicator.status.get_text()});
        const atEnable = panel();
        void extension.controller.pending.then(() => probeWrite(reportPath + '.reenable-' + restoreNumber, {atEnable, afterRead: panel()}));
        return;
    }
    extension.probed = true;
    const session = new ProbeSoup.Session();
    const control = query => new Promise((resolve, reject) => session.send_and_read_async(
        ProbeSoup.Message.new('GET', `${probeBase}/mode?${query}`), ProbeGLib.PRIORITY_DEFAULT, null,
        (s, result) => { try { resolve(new TextDecoder().decode(s.send_and_read_finish(result).get_data())); } catch (error) { reject(error); } }));
    const pause = ms => new Promise(resolve => ProbeGLib.timeout_add(ProbeGLib.PRIORITY_DEFAULT, ms, () => { resolve(); return ProbeGLib.SOURCE_REMOVE; }));
    const label = () => extension.indicator.label;
    const card = () => ({text: label().get_text(), source: extension.indicator.source.get_text(), price: extension.indicator.price.get_text(),
        status: extension.indicator.status.get_text(), opacity: extension.indicator.price.opacity, delay: delay()});
    const findButton = (actor, text) => {
        if (actor.label === text && typeof actor.get_label === 'function') return actor;
        for (const child of actor.get_children()) { const found = findButton(child, text); if (found) return found; }
        return null;
    };
    const delay = () => {
        const source = ProbeGLib.MainContext.default().find_source_by_id(extension.controller.timer);
        return source ? (source.get_ready_time() - ProbeGLib.get_monotonic_time()) / 1e6 : null;
    };
    void (async () => {
        const report = {};
        try {
            for (let i = 0; i < 200 && label().get_text() !== 'BTC $61,764'; i++) await pause(25);
            report.first = label().get_text();
            report.firstDelay = delay();
            // Tabular digits: same-length prices must have the same width, so the panel never shifts.
            const width = text => { label().set_text(text); return label().get_preferred_width(-1)[1]; };
            report.widths = ['BTC $11,111', 'BTC $88,888', 'BTC $40,707'].map(width);
            await extension.controller.refresh();
            // A refresh with an unchanged price must not change the label at any moment.
            const texts = new Set([label().get_text()]);
            let done = false;
            extension.controller.refresh().then(() => { done = true; });
            while (!done) { texts.add(label().get_text()); await pause(2); }
            texts.add(label().get_text());
            report.steady = [...texts];
            await control('coinbase=fail&binance=ok');
            await extension.controller.refresh();
            report.fallback = card();
            await control('coinbase=fail&binance=fail');
            await extension.controller.refresh();
            report.allFail = card();
            await control('coinbase=ok&binance=ok');
            await extension.controller.refresh();
            report.recovered = card();
            extension.indicator.button.menu.open();
            await pause(400);
            // Refresh is a button inside the card: it reads at once and the menu stays open.
            const before = JSON.parse(await control('report=1')).coinbase;
            findButton(extension.indicator.button.menu.actor, 'Refresh').emit('clicked', 1);
            await extension.controller.pending;
            report.refreshButton = {open: extension.indicator.button.menu.isOpen, reads: JSON.parse(await control('report=1')).coinbase - before};
            // The card must not inherit GNOME's dimmed inactive-item colour: its text matches the menu's own.
            const rgba = actor => { const c = actor.get_theme_node().get_foreground_color(); return [c.red, c.green, c.blue, c.alpha].join(','); };
            report.colors = {price: rgba(extension.indicator.price), menu: rgba(extension.indicator.button.menu.box)};
            let charts = 0;
            extension.openChart = () => { charts++; };
            findButton(extension.indicator.button.menu.actor, 'TradingView chart ↗').emit('clicked', 1);
            report.chartButton = {open: extension.indicator.button.menu.isOpen, charts};
            extension.indicator.button.menu.open();
            await pause(400);
            const menu = extension.indicator.button.menu.actor;
            const [menuX, menuY] = menu.get_transformed_position();
            report.menu = {width: menu.width, height: menu.height, x: menuX, y: menuY, stageWidth: global.stage.width};
            const capture = ProbeGLib.getenv('BTCPRICE_UI_CAPTURE');
            if (capture) await new Promise(resolve => {
                const screenshot = new ProbeShell.Screenshot();
                const output = ProbeGio.File.new_for_path(capture).replace(null, false, ProbeGio.FileCreateFlags.PRIVATE, null);
                screenshot.screenshot_area(Math.floor(menuX) - 220, 0, Math.ceil(menu.width) + 240, Math.ceil(menuY + menu.height) + 4, output,
                    (_object, result) => { try { screenshot.screenshot_area_finish(result); } finally { output.close(null); resolve(); } });
            });
            extension.indicator.button.menu.close();
            report.counts = JSON.parse(await control('report=1'));
        } catch (error) {
            report.error = `${error}\n${error.stack}`;
        }
        probeWrite(reportPath, report);
    })();
};
