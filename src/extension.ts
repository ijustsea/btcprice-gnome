import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PriceClient} from './client.js';
import {PriceController} from './controller.js';
import {PriceIndicator} from './indicator.js';
import type {PriceView, SourceId} from './price.js';

// Survives the disable/enable that GNOME performs around the lock screen, so unlocking shows the
// last price at once (marked not live when older than a minute) and keeps it if the first read fails.
let lastView: PriceView | undefined;
const serverCooldowns = new Map<SourceId, number>();
const CHART_URL = 'https://www.tradingview.com/chart/?symbol=COINBASE%3ABTCUSD';

/** No input-idle pause: lack of input is no reason to freeze a price that is still on screen. Polling stops
 * when the screen blanks or locks, because GNOME's screen shield then enters the unlock-dialog session mode
 * and disables the extension (GNOME Shell 51 with GDM and logind, as on Fedora), and timers do not run
 * during suspend. It continues while the session is unlocked, e.g. under a fullscreen window. */
export default class BtcPriceExtension extends Extension {
    private client: PriceClient | null = null;
    private controller: PriceController | null = null;
    private indicator: PriceIndicator | null = null;
    private launches = new Set<Gio.Cancellable>();
    private networkMonitor: Gio.NetworkMonitor | null = null;
    private networkChanged = 0;

    override enable(): void {
        const client = new PriceClient();
        const indicator = new PriceIndicator({
            refresh: () => { void this.controller?.refresh(); },
            openChart: () => this.openChart(),
        });
        this.client = client;
        this.indicator = indicator;
        Main.panel.addToStatusArea(this.uuid, indicator.button);
        this.controller = new PriceController({
            initialView: lastView,
            serverCooldowns,
            fetchPrice: (source, cancellable) => client.fetchPrice(source, cancellable),
            publish: view => { lastView = view; this.indicator?.update(view, Date.now()); },
        });
        this.controller.start();
        // Event-driven: when the internet is reachable again, a failing price is read at once instead of
        // after the backoff. Connectivity becomes full when a default route returns or NetworkManager's
        // connectivity check passes again.
        const monitor = Gio.NetworkMonitor.get_default();
        this.networkMonitor = monitor;
        this.networkChanged = monitor.connect('notify::connectivity', () => {
            if (monitor.connectivity === Gio.NetworkConnectivity.FULL) this.controller?.retryIfFailing();
        });
    }

    private openChart(): void {
        const cancellable = new Gio.Cancellable();
        this.launches.add(cancellable);
        // The launch context carries the activation token, as GNOME Shell's own launches do.
        Gio.AppInfo.launch_default_for_uri_async(CHART_URL, global.create_app_launch_context(0, -1), cancellable, (_source, result) => {
            this.launches.delete(cancellable);
            try {
                Gio.AppInfo.launch_default_for_uri_finish(result);
            } catch (error) {
                if (!cancellable.is_cancelled()) logError(error as Error, 'BTC Price: could not open the TradingView chart');
            }
        });
    }

    override disable(): void {
        if (this.networkChanged) this.networkMonitor?.disconnect(this.networkChanged);
        this.networkChanged = 0;
        this.networkMonitor = null;
        this.controller?.stop();
        this.controller = null;
        this.client?.close();
        this.client = null;
        for (const cancellable of this.launches) cancellable.cancel();
        this.launches.clear();
        this.indicator?.destroy();
        this.indicator = null;
    }
}
