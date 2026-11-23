import Gio from 'gi://Gio';
import type Meta from 'gi://Meta';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PriceClient} from './client.js';
import {PriceController} from './controller.js';
import {PriceIndicator} from './indicator.js';
import type {Quote} from './price.js';

// No keyboard or pointer input for this long pauses polling; any input resumes it at once.
// Idle inhibitors are respected, so the price stays live while a video plays.
const IDLE_PAUSE_MS = 5 * 60 * 1000;
// Survives the disable/enable that GNOME performs around the lock screen, so unlocking shows
// the last price (marked not live) instead of a blank until the first new read.
let lastQuote: Quote | null = null;
const CHART_URL = 'https://www.tradingview.com/chart/?symbol=COINBASE%3ABTCUSD';

export default class BtcPriceExtension extends Extension {
    private client: PriceClient | null = null;
    private controller: PriceController | null = null;
    private indicator: PriceIndicator | null = null;
    private idleMonitor: Meta.IdleMonitor | null = null;
    private idleWatch = 0;
    private activeWatch = 0;
    private idle = false;
    private launches = new Set<Gio.Cancellable>();

    override enable(): void {
        const client = new PriceClient();
        const indicator = new PriceIndicator({
            refresh: () => { void this.controller?.refresh(); },
            openChart: () => this.openChart(),
        });
        this.client = client;
        this.indicator = indicator;
        Main.panel.addToStatusArea(this.uuid, indicator.button);
        if (lastQuote) indicator.update({quote: lastQuote, failing: false, paused: true}, Date.now());
        this.controller = new PriceController({
            fetchPrice: (url, cancellable) => client.fetchPrice(url, cancellable),
            publish: view => { lastQuote = view.quote; this.indicator?.update(view, Date.now()); },
        });
        this.idleMonitor = global.backend.get_core_idle_monitor();
        this.idleWatch = this.idleMonitor.add_idle_watch(IDLE_PAUSE_MS, () => this.setIdle(true));
        this.controller.start();
    }

    private setIdle(idle: boolean): void {
        if (!this.controller || !this.idleMonitor || this.idle === idle) return;
        this.idle = idle;
        if (idle) {
            // Mutter's active watch is one-shot; it only needs removing if disable() comes first.
            this.activeWatch = this.idleMonitor.add_user_active_watch(() => { this.activeWatch = 0; this.setIdle(false); });
            this.controller.pause();
        } else {
            this.controller.resume();
        }
    }

    private openChart(): void {
        const cancellable = new Gio.Cancellable();
        this.launches.add(cancellable);
        Gio.AppInfo.launch_default_for_uri_async(CHART_URL, null, cancellable, (_source, result) => {
            this.launches.delete(cancellable);
            try {
                Gio.AppInfo.launch_default_for_uri_finish(result);
            } catch (error) {
                if (!cancellable.is_cancelled()) logError(error as Error, 'BTC Price: could not open the TradingView chart');
            }
        });
    }

    override disable(): void {
        for (const watch of [this.idleWatch, this.activeWatch]) if (watch) this.idleMonitor?.remove_watch(watch);
        this.idleWatch = this.activeWatch = 0;
        this.idleMonitor = null;
        this.idle = false;
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
