# Project instructions

- Runtime code is TypeScript emitted as readable GJS ESM. Node is development-only.
- Coinbase `BTC-USD` is the only normal source. Binance `BTCUSDT` is asked only in a poll where Coinbase failed, and the panel shows its USDT unit. Never use TradingView data or any unofficial or scraped endpoint.
- Poll every 15 seconds through one long-lived Soup session (connection reuse is the main efficiency gain). Publish results only, never an in-progress state. Back off only after every source failed.
- Do not impose load or side effects: no subprocesses, no settings files, no automatic browser launch, no polling while idle (5 minutes without input; idle inhibitors such as video playback keep it live) or after disable.
- Parse untrusted responses strictly (bounded body, positive decimal `price` string), and show only plain text.
- Run `npm run check`; for lifecycle, UI or network changes also `npm run test:shell` (isolated, local fake server).
- Package runtime files through the source-derived manifest. Do not copy build/ wholesale.
- Do not claim lower resource use without a measurement under equivalent conditions.
