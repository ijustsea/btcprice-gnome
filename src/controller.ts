import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {SOURCES, nextDelaySeconds, type PriceView, type Quote, type Source} from './price.js';

interface Options {
    fetchPrice(url: string, cancellable: Gio.Cancellable): Promise<number>;
    publish(view: PriceView): void;
    sources?: Source[];
    now?: () => number;
    /** Kept until a new price arrives, e.g. the last price from before a lock-screen disable. */
    initialQuote?: Quote | null;
}

/** Publishes only results, never an in-progress state, so the panel text does not flicker. */
export class PriceController {
    private quote: Quote | null;
    private failures = 0;
    private failing = new Set<string>();
    private active = false;
    private generation = 0;
    private timer = 0;
    private pending: Promise<void> | null = null;
    private cancel: Gio.Cancellable | null = null;

    constructor(private options: Options) {
        this.quote = options.initialQuote ?? null;
    }

    start(): void {
        if (this.active) return;
        this.active = true;
        this.generation++;
        if (this.quote) this.publish();
        void this.refresh();
    }

    refresh(): Promise<void> {
        if (!this.active) return Promise.resolve();
        if (this.pending) return this.pending;
        if (this.timer) { GLib.Source.remove(this.timer); this.timer = 0; }
        const generation = this.generation;
        const cancel = new Gio.Cancellable();
        this.cancel = cancel;
        this.pending = this.read(generation, cancel).finally(() => {
            if (generation !== this.generation) return;
            this.pending = null;
            this.cancel = null;
            if (this.active) this.schedule();
        });
        return this.pending;
    }

    private async read(generation: number, cancel: Gio.Cancellable): Promise<void> {
        const sources = this.options.sources ?? SOURCES;
        for (const [index, source] of sources.entries()) {
            let price: number;
            try {
                price = await this.options.fetchPrice(source.url, cancel);
            } catch (error) {
                if (generation !== this.generation || cancel.is_cancelled()) return;
                // Handled by trying the next source. Logged once per failure streak, not every poll.
                if (!this.failing.has(source.id)) console.warn(`BTC Price: ${source.id} failed: ${error}`);
                this.failing.add(source.id);
                continue;
            }
            if (generation !== this.generation) return;
            // Sources after this one were not needed, so their failure streaks end here too.
            for (const {id} of sources.slice(index)) this.failing.delete(id);
            this.quote = {source: source.id, price, receivedAt: (this.options.now ?? Date.now)()};
            this.failures = 0;
            this.publish();
            return;
        }
        this.failures++;
        this.publish();
    }

    private schedule(): void {
        if (this.timer) GLib.Source.remove(this.timer);
        this.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, nextDelaySeconds(this.failures), () => {
            this.timer = 0;
            void this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    private publish(): void {
        this.options.publish({quote: this.quote, failing: this.failures > 0});
    }

    /** The network came back: read at once instead of waiting out the failure backoff (up to a minute).
     * Healthy polling ignores it, so frequent network notifications cost nothing. */
    retryIfFailing(): void {
        if (this.failures > 0) void this.refresh();
    }

    stop(): void {
        this.active = false;
        this.generation++;
        this.cancel?.cancel();
        this.cancel = null;
        this.pending = null;
        if (this.timer) { GLib.Source.remove(this.timer); this.timer = 0; }
    }
}
