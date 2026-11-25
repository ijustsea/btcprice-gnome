import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {parsePrice} from './price.js';

const MAX_BODY = 16 * 1024;
/** The whole request (DNS, connect, TLS, headers, body) must finish within this. Soup's own timeout
 * (60 s by default) only bounds each socket wait, so a trickling body or a slow DNS answer could
 * otherwise hold every later poll. */
const DEADLINE_SECONDS = 10;

/** One session for the extension's lifetime, so polls reuse one HTTPS connection
 * (measured process CPU per Coinbase poll: 11-12.5 ms when each poll opened a new TLS connection,
 * 4.6-4.8 ms reusing one). Requests stay on HTTP/1.1 because the deadline below must be able to end
 * them: in libsoup 3.8, cancelling an HTTP/2 request that awaits headers did not end it (still
 * pending 11 s later), while HTTP/1.1 ended at once. HTTP/2 also dropped an idle connection after
 * the session timeout, which made the previous 10 s timeout cost a new connection every poll. */
export class PriceClient {
    private session = new Soup.Session({user_agent: 'btcprice-gnome'});

    async fetchPrice(url: string, cancellable: Gio.Cancellable): Promise<number> {
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
            return await this.read(url, request);
        } catch (error) {
            if (expired) throw new Error(`No complete answer from ${url} within ${DEADLINE_SECONDS} s`, {cause: error});
            throw error;
        } finally {
            if (deadline) GLib.Source.remove(deadline);
            cancellable.disconnect(link);
        }
    }

    private async read(url: string, cancellable: Gio.Cancellable): Promise<number> {
        const message = Soup.Message.new('GET', url);
        message.set_force_http1(true);
        // Both APIs answer directly; a redirect could leave HTTPS or the expected host, so it is a failure.
        message.add_flags(Soup.MessageFlags.NO_REDIRECT);
        const stream = await new Promise<Gio.InputStream>((resolve, reject) =>
            this.session.send_async(message, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
                try { resolve(session!.send_finish(result)); } catch (error) { reject(error); }
            }));
        try {
            const status = message.get_status();
            if (status !== Soup.Status.OK) throw new Error(`HTTP ${status} from ${url}`);
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
            return parsePrice(new TextDecoder('utf-8', {fatal: true}).decode(body));
        } finally {
            stream.close(null);
        }
    }

    close(): void {
        this.session.abort();
    }
}
