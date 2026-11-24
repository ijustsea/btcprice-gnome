export type SourceId = 'coinbase' | 'binance';
export interface Source { id: SourceId; url: string; }
export interface Quote { source: SourceId; price: number; receivedAt: number; }
export interface PriceView { quote: Quote | null; failing: boolean; paused: boolean; }

/** Priority order: Coinbase answers every poll; Binance is asked only when Coinbase fails.
 * Plain objects so the isolated Shell smoke test can point them at a local server. */
export const SOURCES: Source[] = [
    {id: 'coinbase', url: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker'},
    {id: 'binance', url: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'},
];

export const POLL_SECONDS = 15;
/** Longest wait after failures, so the price is live again about a minute after the network returns.
 * Without a link requests fail locally; on a network that drops packets each source waits out the
 * request deadline, still only one or two requests a minute. */
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

export function formatPrice(price: number): string {
    return Math.round(price).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function panelText(view: PriceView, now: number): string {
    const quote = view.quote;
    if (!quote) return 'BTC —';
    // `~` = not live: the latest poll failed everywhere, polling is paused, or the price is old.
    const marker = view.failing || view.paused || now - quote.receivedAt > STALE_MS ? '~' : '';
    const value = formatPrice(quote.price);
    return quote.source === 'coinbase' ? `BTC ${marker}$${value}` : `BTC ${marker}${value} USDT`;
}

function clock(ms: number): string {
    const date = new Date(ms);
    return [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':');
}

export function statusText(view: PriceView): string {
    const quote = view.quote;
    if (!quote) return view.failing ? '가격을 받지 못했습니다 · 재시도 중' : '가격 확인 중…';
    const source = quote.source === 'coinbase' ? 'Coinbase' : 'Binance (Coinbase 응답 없음)';
    const state = view.paused ? ' · 자리 비움으로 일시정지' : view.failing ? ' · 재시도 중' : '';
    return `${source} · ${clock(quote.receivedAt)} 기준${state}`;
}

/** 15 s while healthy; after every source failed 30 s, then 60 s. A success returns to 15 s. */
export function nextDelaySeconds(failures: number): number {
    return Math.min(MAX_RETRY_SECONDS, POLL_SECONDS * 2 ** failures);
}
