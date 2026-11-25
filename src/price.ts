export type SourceId = 'coinbase' | 'binance';
export interface Source { id: SourceId; url: string; }
export interface MarketPrice {
    price: number;
    tradedAt: number | null;
    tradeAgeMs: number | null;
}
export interface Quote extends MarketPrice { source: SourceId; receivedAt: number; }
export interface PriceView { quote: Quote | null; failing: boolean; }

export class PriceHttpError extends Error {
    constructor(readonly status: number, readonly retryAfterMs: number | null, url: string) {
        super(`HTTP ${status} from ${url}`);
    }
}

/** Priority order: Coinbase answers every poll; Binance is asked only when Coinbase fails.
 * Plain objects so the isolated Shell smoke test can point them at a local server. */
export const SOURCES: Source[] = [
    {id: 'coinbase', url: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker'},
    {id: 'binance', url: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'},
];

/** Coinbase serves the ticker with max-age=1; in a 2-minute sample the last trade was at most 1.4 s old and
 * the whole-dollar price differed between reads 5 s apart 84% of the time. 0.2 requests/s is far below
 * Coinbase's public limit of 10 per second per IP. */
export const POLL_SECONDS = 5;
/** Maximum local backoff. A longer Retry-After sent by a source takes precedence. */
export const MAX_RETRY_SECONDS = 60;
/** Also not live: a price older than a minute, e.g. the last price shown again after an unlock. */
export const STALE_MS = 60_000;
const TRADE_CLOCK_SKEW_MS = 3_000;

function priceObject(body: string): Record<string, unknown> {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Price response is not a JSON object');
    return value as Record<string, unknown>;
}

/** A price below 1 would display as $0, so it is treated as a bad answer. */
function decimalPrice(price: unknown): number {
    if (typeof price !== 'string' || !/^\d{1,9}(?:\.\d{1,12})?$/.test(price))
        // Quoted, so server text cannot start a new log line.
        throw new Error(`Unexpected price field: ${JSON.stringify(String(price).slice(0, 40))}`);
    const number = Number(price);
    if (!(number >= 1)) throw new Error(`Price is below 1: ${price}`);
    return number;
}

function tradeTime(value: unknown): number | null {
    // Coinbase uses UTC ISO timestamps with up to nanosecond precision.
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)) return null;
    const ms = Date.parse(value);
    // Date.parse can normalize invalid calendar dates; keep those unknown.
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19) ? ms : null;
}

export function secondsHeader(value: string | null): number | null {
    if (value === null || !/^\d+$/.test(value.trim())) return null;
    return Math.min(Number(value), Math.floor(Number.MAX_SAFE_INTEGER / 1000));
}

export function parseMarketPrice(body: string, source: SourceId, responseDate: number | null, ageHeader: string | null): MarketPrice {
    const data = priceObject(body);
    if (source === 'binance' && data.symbol !== 'BTCUSDT') throw new Error('Unexpected Binance symbol');
    const price = decimalPrice(data.price);
    const tradedAt = source === 'coinbase' ? tradeTime(data.time) : null;
    let tradeAgeMs: number | null = null;
    if (tradedAt !== null && responseDate !== null) {
        const atOrigin = responseDate - tradedAt;
        // Response and trade clocks can differ slightly. Clock skew cannot erase time spent in a cache.
        if (Number.isFinite(atOrigin) && atOrigin >= -TRADE_CLOCK_SKEW_MS)
            tradeAgeMs = Math.max(0, atOrigin) + (secondsHeader(ageHeader) ?? 0) * 1000;
    }
    return {price, tradedAt, tradeAgeMs};
}

export function formatPrice(price: number, decimals = 0): string {
    const [whole, fraction] = price.toFixed(decimals).split('.');
    return whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '');
}

function withUnit(quote: Quote, value: string): string {
    return quote.source === 'coinbase' ? `$${value}` : `${value} USDT`;
}

/** Not live: the latest poll failed everywhere, or the price is old (e.g. shown again after an unlock). */
export function isLive(view: PriceView, now: number): boolean {
    const {quote} = view;
    if (!quote || view.failing) return false;
    const elapsed = now - quote.receivedAt;
    if (elapsed < 0 || elapsed > STALE_MS) return false;
    return quote.source === 'binance' || (quote.tradeAgeMs !== null && quote.tradeAgeMs + elapsed <= STALE_MS);
}

export function panelText(view: PriceView, now: number): string {
    const quote = view.quote;
    if (!quote) return 'BTC —';
    return `BTC ${isLive(view, now) ? '' : '~'}${withUnit(quote, formatPrice(quote.price))}`;
}

/** The menu shows the exact price; the panel rounds to whole dollars. */
export function menuPrice(view: PriceView): string {
    return view.quote ? withUnit(view.quote, formatPrice(view.quote.price, 2)) : '—';
}

export function sourceName(source: SourceId): string {
    return source === 'coinbase' ? 'Coinbase' : 'Binance';
}

function clock(ms: number): string {
    const date = new Date(ms);
    return [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':');
}

/** The source itself is shown beside the title, so this says only when the price was received and why it may differ. */
export function statusText(view: PriceView, now: number): string {
    const quote = view.quote;
    if (!quote) return view.failing ? '가격을 받지 못했습니다 · 재시도 중' : '가격 확인 중…';
    const parts: string[] = [];
    if (quote.source === 'binance') {
        parts.push('대체 시세', `${clock(quote.receivedAt)} 수신`);
    } else if (quote.tradedAt === null || quote.tradeAgeMs === null) {
        parts.push(`${clock(quote.receivedAt)} 수신`, '신선도 미확인');
    } else {
        parts.push(`${clock(quote.tradedAt)} 체결`);
        if (quote.tradeAgeMs + Math.max(0, now - quote.receivedAt) > STALE_MS) parts.push('오래된 체결');
    }
    if (view.failing) parts.push('재시도 중');
    return parts.join(' · ');
}

/** 5 s while healthy; after every source failed 10, 20, 40, then 60 s. A success returns to 5 s. */
export function nextDelaySeconds(failures: number): number {
    return Math.min(MAX_RETRY_SECONDS, POLL_SECONDS * 2 ** failures);
}
