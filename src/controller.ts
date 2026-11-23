import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {SOURCES, nextDelaySeconds, type PriceView, type Quote, type Source} from './price.js';

interface Options {
    fetchPrice(url: string, cancellable: Gio.Cancellable): Promise<number>;
    publish(view: PriceView): void;
    sources?: Source[];
    now?: () => number;
}

/** Publishes only results, never an in-progress state, so the panel text does not flicker. */
export class PriceController {
    private quote: Quote | null = null;
    private failures = 0;
    private failing = new Set<string>();
    private active = false;
    private paused = false;
    private generation = 0;
    private timer = 0;
    private pending: Promise<void> | null = null;
    private cancel: Gio.Cancellable | null = null;

    constructor(private options: Options) {}

    start(): void {
        if (this.active) return;
        this.active = true;
        this.generation++;
        if (!this.paused) void this.refresh();
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
            if (this.active && !this.paused) this.schedule();
        });
        return this.pending;
    }

    private async read(generation: number, cancel: Gio.Cancellable): Promise<void> {
        for (const source of this.options.sources ?? SOURCES) {
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
            this.failing.delete(source.id);
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
        this.options.publish({quote: this.quote, failing: this.failures > 0, paused: this.paused});
    }

    /** While the user is away nobody reads the panel: stop polling and mark the price as not live. */
    pause(): void {
        if (this.paused) return;
        this.paused = true;
        if (this.timer) { GLib.Source.remove(this.timer); this.timer = 0; }
        if (this.active) this.publish();
    }

    resume(): void {
        if (!this.paused) return;
        this.paused = false;
        void this.refresh();
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
