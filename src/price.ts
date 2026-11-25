export type SourceId = 'coinbase' | 'binance';
export interface Source { id: SourceId; url: string; }
export interface Quote { source: SourceId; price: number; receivedAt: number; }
export interface PriceView { quote: Quote | null; failing: boolean; }

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
/** Longest wait after failures. A network notification retries at once; without one the price is live again
 * within about a minute. Without a link requests fail locally; on a network that drops packets each source
 * waits out the request deadline, still only one or two requests a minute. */
export const MAX_RETRY_SECONDS = 60;
/** Also not live: a price older than a minute, e.g. the last price shown again after an unlock. */
export const STALE_MS = 60_000;

/** Both endpoints answer {"price": "61763.77", ...}; anything else is rejected, never shown.
 * A price below 1 would display as $0, so it is treated as a bad answer, not a price. */
export function parsePrice(body: string): number {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Price response is not a JSON object');
    const price = (value as Record<string, unknown>).price;
    if (typeof price !== 'string' || !/^\d{1,9}(?:\.\d{1,12})?$/.test(price))
        // Quoted, so server text cannot start a new log line.
        throw new Error(`Unexpected price field: ${JSON.stringify(String(price).slice(0, 40))}`);
    const number = Number(price);
    if (!(number >= 1)) throw new Error(`Price is below 1: ${price}`);
    return number;
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
    return view.quote !== null && !view.failing && now - view.quote.receivedAt <= STALE_MS;
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
export function statusText(view: PriceView): string {
    const quote = view.quote;
    if (!quote) return view.failing ? '가격을 받지 못했습니다 · 재시도 중' : '가격 확인 중…';
    const parts = [`${clock(quote.receivedAt)} 기준`];
    if (quote.source !== 'coinbase') parts.unshift('Coinbase 응답 없음');
    if (view.failing) parts.push('재시도 중');
    return parts.join(' · ');
}

/** 5 s while healthy; after every source failed 10, 20, 40, then 60 s. A success returns to 5 s. */
export function nextDelaySeconds(failures: number): number {
    return Math.min(MAX_RETRY_SECONDS, POLL_SECONDS * 2 ** failures);
}
