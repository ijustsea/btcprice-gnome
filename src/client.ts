import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {parseMarketPrice, PriceHttpError, secondsHeader, type MarketPrice, type Source} from './price.js';

const MAX_BODY = 16 * 1024;
/** The whole request (DNS, connect, TLS, headers, body) must finish within this. Soup's own timeout
 * (60 s by default) only bounds each socket wait, so a trickling body or a slow DNS answer could
 * otherwise hold every later poll. */
const DEADLINE_SECONDS = 10;
// An unanchored HTTP date can look expired when this PC's clock is ahead.
const UNANCHORED_RETRY_MIN_MS = 120_000;

function httpDate(value: string | null): number | null {
    if (!value || value.length > 80) return null;
    const date = Soup.date_time_new_from_http_string(value);
    return date === null ? null : date.to_unix() * 1000;
}

function retryAfter(value: string | null, date: number | null): number | null {
    const seconds = secondsHeader(value);
    if (seconds !== null) return seconds * 1000;
    const retryAt = httpDate(value);
    if (retryAt === null) return null;
    return date === null
        ? Math.max(UNANCHORED_RETRY_MIN_MS, retryAt - Date.now())
        : Math.max(0, retryAt - date);
}

/** One session for the extension's lifetime, so polls reuse one HTTPS connection
 * (measured process CPU per Coinbase poll: 11-12.5 ms when each poll opened a new TLS connection,
 * 4.6-4.8 ms reusing one). Requests stay on HTTP/1.1 because the deadline below must be able to end
 * them: in libsoup 3.8, cancelling an HTTP/2 request that awaits headers did not end it (still
 * pending 11 s later), while HTTP/1.1 ended at once. HTTP/2 also dropped an idle connection after
 * the session timeout, which made the previous 10 s timeout cost a new connection every poll. */
export class PriceClient {
    private session = new Soup.Session({user_agent: 'btcprice-gnome'});

    async fetchPrice(source: Source, cancellable: Gio.Cancellable): Promise<MarketPrice> {
        // Cancelled by the caller (stop/disable) or by the deadline, whichever comes first.
        const request = new Gio.Cancellable();
        const link = cancellable.connect(() => request.cancel());
        let expired = false;
        // Millisecond timer, so the deadline is 10 s rather than up to a second later.
        let deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEADLINE_SECONDS * 1000, () => {
            deadline = 0;
            expired = true;
            request.cancel();
            return GLib.SOURCE_REMOVE;
        });
        try {
            return await this.read(source, request);
        } catch (error) {
            if (expired) throw new Error(`No complete answer from ${source.url} within ${DEADLINE_SECONDS} s`, {cause: error});
            throw error;
        } finally {
            if (deadline) GLib.Source.remove(deadline);
            cancellable.disconnect(link);
        }
    }

    private async read({id, url}: Source, cancellable: Gio.Cancellable): Promise<MarketPrice> {
        const message = Soup.Message.new('GET', url);
        message.set_force_http1(true);
        // Both APIs answer directly; a redirect could leave HTTPS or the expected host, so it is a failure.
        message.add_flags(Soup.MessageFlags.NO_REDIRECT);
        const stream = await new Promise<Gio.InputStream>((resolve, reject) =>
            this.session.send_async(message, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
                try { resolve(session!.send_finish(result)); } catch (error) { reject(error); }
            }));
        try {
            // The numeric property also represents codes absent from the GI enum, such as 429 and 418.
            const status = message.status_code;
            const headers = message.get_response_headers();
            const date = httpDate(headers.get_one('Date'));
            if (status !== Soup.Status.OK) throw new PriceHttpError(status,
                [418, 429, 503].includes(status) ? retryAfter(headers.get_one('Retry-After'), date) : null, url);
            const headersAt = GLib.get_monotonic_time();
            // Bounded read: an unexpectedly large body is rejected instead of buffered.
            const chunks: Uint8Array[] = [];
            let size = 0;
            for (;;) {
                const chunk = await new Promise<Uint8Array>((resolve, reject) =>
                    stream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, cancellable, (_stream, result) => {
                        try { resolve(stream.read_bytes_finish(result).toArray()); } catch (error) { reject(error); }
                    }));
                if (!chunk.length) break;
                size += chunk.length;
                if (size > MAX_BODY) throw new Error(`Price response from ${url} exceeds ${MAX_BODY} bytes`);
                chunks.push(chunk);
            }
            const body = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
            const reading = parseMarketPrice(new TextDecoder('utf-8', {fatal: true}).decode(body), id, date, headers.get_one('Age'));
            if (reading.tradeAgeMs !== null) reading.tradeAgeMs += (GLib.get_monotonic_time() - headersAt) / 1000;
            return reading;
        } finally {
            stream.close(null);
        }
    }

    close(): void {
        this.session.abort();
    }
}
