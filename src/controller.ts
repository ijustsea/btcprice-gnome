import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {SOURCES, PriceHttpError, nextDelaySeconds, POLL_SECONDS,
    type MarketPrice, type PriceView, type Source, type SourceId} from './price.js';

interface SourceFailure { count: number; retryAt: number; }

interface Options {
    fetchPrice(source: Source, cancellable: Gio.Cancellable): Promise<MarketPrice>;
    publish(view: PriceView): void;
    sources?: Source[];
    now?: () => number;
    monotonicNow?: () => number;
    /** Preserves both the last price and its failure marker through a lock-screen disable. */
    initialView?: PriceView;
    /** In-memory server cooldowns can outlive one enable/disable cycle. */
    serverCooldowns?: Map<SourceId, number>;
}

/** Publishes only results, never an in-progress state, so the panel text does not flicker. */
export class PriceController {
    private view: PriceView;
    private localFailures = new Map<SourceId, SourceFailure>();
    private serverCooldowns: Map<SourceId, number>;
    private sources: Source[];
    private active = false;
    private generation = 0;
    private timer = 0;
    private pending: Promise<void> | null = null;
    private cancel: Gio.Cancellable | null = null;
    private retryQueued = false;

    constructor(private options: Options) {
        this.view = options.initialView ?? {quote: null, failing: false};
        this.serverCooldowns = options.serverCooldowns ?? new Map();
        this.sources = options.sources ?? SOURCES;
    }

    start(): void {
        if (this.active) return;
        this.active = true;
        this.generation++;
        if (this.view.quote || this.view.failing) this.publish();
        void this.poll(false);
    }

    refresh(): Promise<void> {
        // Manual refresh can skip local outage backoff, but not a limit from the exchange.
        return this.poll(true);
    }

    private poll(skipLocalBackoff: boolean): Promise<void> {
        if (!this.active) return Promise.resolve();
        if (this.pending) return this.pending;
        if (this.timer) { GLib.Source.remove(this.timer); this.timer = 0; }
        const generation = this.generation;
        const cancel = new Gio.Cancellable();
        this.cancel = cancel;
        this.pending = this.read(generation, cancel, skipLocalBackoff).finally(() => {
            if (generation !== this.generation) return;
            this.pending = null;
            this.cancel = null;
            const retry = this.retryQueued;
            this.retryQueued = false;
            if (!this.active) return;
            if (retry && this.view.failing && this.canRetry()) void this.poll(true);
            else this.schedule();
        });
        return this.pending;
    }

    private async read(generation: number, cancel: Gio.Cancellable, skipLocalBackoff: boolean): Promise<void> {
        for (const source of this.sources) {
            if (this.eligibleAt(source.id, skipLocalBackoff) > this.monotonicNow()) continue;
            let reading: MarketPrice;
            try {
                reading = await this.options.fetchPrice(source, cancel);
            } catch (error) {
                if (generation !== this.generation || cancel.is_cancelled()) return;
                // Handled by trying the next source. Logged once per failure streak, not every poll.
                this.noteFailure(source.id, error);
                continue;
            }
            if (generation !== this.generation) return;
            this.localFailures.delete(source.id);
            this.serverCooldowns.delete(source.id);
            if (source.id === 'coinbase') {
                // Retire an old fallback outage once its local delay has passed. A current
                // delay or a server restriction must survive an unrelated source's success.
                const fallbackFailure = this.localFailures.get('binance');
                if (fallbackFailure && fallbackFailure.retryAt <= this.monotonicNow())
                    this.localFailures.delete('binance');
            }
            this.view = {quote: {...reading, source: source.id, receivedAt: (this.options.now ?? Date.now)()}, failing: false};
            this.publish();
            return;
        }
        if (!this.view.failing) {
            this.view = {...this.view, failing: true};
            this.publish();
        }
    }

    private monotonicNow(): number {
        return this.options.monotonicNow?.() ?? GLib.get_monotonic_time() / 1000;
    }

    private noteFailure(id: SourceId, error: unknown): void {
        const prior = this.localFailures.get(id);
        if (!prior) console.warn(`BTC Price: ${id} failed: ${error}`);
        const count = (prior?.count ?? 0) + 1;
        const now = this.monotonicNow();
        const localWait = nextDelaySeconds(count) * 1000;
        this.localFailures.set(id, {count, retryAt: now + localWait});
        if (!(error instanceof PriceHttpError)) return;
        let serverWait = error.retryAfterMs;
        // Even without a usable header, manual/network retries must not hammer a rate-limited source.
        if (error.status === 418 || error.status === 429) {
            const missingHeaderWait = error.status === 418 ? 120_000 : localWait;
            serverWait = Math.max(serverWait ?? missingHeaderWait, localWait);
        }
        if (serverWait !== null) this.serverCooldowns.set(id, now + serverWait);
    }

    private eligibleAt(id: SourceId, skipLocalBackoff: boolean): number {
        return Math.max(this.serverCooldowns.get(id) ?? 0,
            skipLocalBackoff ? 0 : this.localFailures.get(id)?.retryAt ?? 0);
    }

    private canRetry(): boolean {
        const now = this.monotonicNow();
        return this.sources.some(({id}) => this.eligibleAt(id, true) <= now);
    }

    private schedule(): void {
        if (this.timer) GLib.Source.remove(this.timer);
        const now = this.monotonicNow();
        const earliest = Math.min(...this.sources.map(({id}) => this.eligibleAt(id, false)));
        // Wait until a source is eligible. For very long waits, cap only the timer;
        // eligibility is checked again before sending each request.
        const refresh = () => {
            this.timer = 0;
            void this.poll(false);
            return GLib.SOURCE_REMOVE;
        };
        const waitMs = earliest - now;
        // The ordinary 5 s timer can be coalesced. A cooldown with little time left should
        // wake as soon as it expires rather than restarting the healthy polling interval.
        this.timer = waitMs > 0
            ? GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.min(2_147_483_647, Math.ceil(waitMs)), refresh)
            : GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, refresh);
    }

    private publish(): void {
        this.options.publish(this.view);
    }

    /** The network came back: read at once instead of waiting out the failure backoff (up to a minute).
     * Healthy polling ignores it, so frequent network notifications cost nothing. */
    retryIfFailing(): void {
        if (!this.active) return;
        if (this.pending) this.retryQueued = true;
        else if (this.view.failing && this.canRetry()) void this.poll(true);
    }

    stop(): void {
        this.active = false;
        this.generation++;
        this.retryQueued = false;
        this.cancel?.cancel();
        this.cancel = null;
        this.pending = null;
        if (this.timer) { GLib.Source.remove(this.timer); this.timer = 0; }
    }
}
