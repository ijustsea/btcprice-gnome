import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {parsePrice} from './price.js';

const MAX_BODY = 16 * 1024;

/** One session for the extension's lifetime, so 15-second polls reuse the HTTPS connection
 * (measured 24-28 ms per Coinbase poll instead of a ~250 ms handshake and ~6x the CPU). */
export class PriceClient {
    private session = new Soup.Session({timeout: 10, user_agent: 'btcprice-gnome'});

    async fetchPrice(url: string, cancellable: Gio.Cancellable): Promise<number> {
        const message = Soup.Message.new('GET', url);
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
