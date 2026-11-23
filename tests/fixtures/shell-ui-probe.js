
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
const probeEnable = BtcPriceExtension.prototype.enable;
BtcPriceExtension.prototype.enable = function () {
    probeEnable.call(this);
    const extension = this;
    const reportPath = ProbeGLib.getenv('BTCPRICE_UI_REPORT');
    if (!reportPath || extension.probed) return;
    extension.probed = true;
    const session = new ProbeSoup.Session();
    const control = query => new Promise((resolve, reject) => session.send_and_read_async(
        ProbeSoup.Message.new('GET', `${probeBase}/mode?${query}`), ProbeGLib.PRIORITY_DEFAULT, null,
        (s, result) => { try { resolve(new TextDecoder().decode(s.send_and_read_finish(result).get_data())); } catch (error) { reject(error); } }));
    const pause = ms => new Promise(resolve => ProbeGLib.timeout_add(ProbeGLib.PRIORITY_DEFAULT, ms, () => { resolve(); return ProbeGLib.SOURCE_REMOVE; }));
    const label = () => extension.indicator.label;
    const status = () => extension.indicator.status.label.get_text();
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
            report.fallback = {text: label().get_text(), status: status(), delay: delay()};
            await control('coinbase=fail&binance=fail');
            await extension.controller.refresh();
            report.allFail = {text: label().get_text(), status: status(), delay: delay()};
            await control('coinbase=ok&binance=ok');
            await extension.controller.refresh();
            report.recovered = {text: label().get_text(), status: status(), delay: delay()};
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
        ProbeGio.File.new_for_path(reportPath).replace_contents(new TextEncoder().encode(JSON.stringify(report)), null, false,
            ProbeGio.FileCreateFlags.PRIVATE, null);
    })();
};
