# Project instructions

- Runtime code is TypeScript emitted as readable GJS ESM. Node is development-only.
- Coinbase `BTC-USD` is the only normal source. Binance `BTCUSDT` is asked only in a poll where Coinbase failed, and the panel shows its USDT unit. Never use TradingView data or any unofficial or scraped endpoint.
- Poll every 15 seconds through one long-lived Soup session (connection reuse is the main efficiency gain). Keep requests on HTTP/1.1 (in libsoup 3.8, cancelling an HTTP/2 request awaiting headers did not end it, so the 10 s request deadline would not work), refuse redirects, and end each request within that deadline. Publish results only, never an in-progress state. Back off (30 s, then 60 s) only after every source failed.
- Do not impose load or side effects: no subprocesses, no settings files, no automatic browser launch, no polling while idle (5 minutes without input; idle inhibitors such as video playback keep it live) or after disable.
- Parse untrusted responses strictly (bounded body, decimal `price` string of at least 1), quote server text in logs, and show only plain text.
- Run `npm run check` (includes a local TLS server offering HTTP/2, like the real APIs); for lifecycle, UI or network changes also `npm run test:shell` (isolated, local fake server).
- Package runtime files through the source-derived manifest. Do not copy build/ wholesale.
- Do not claim lower resource use without a measurement under equivalent conditions.
