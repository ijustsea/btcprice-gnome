# Project instructions

- Runtime code is TypeScript emitted as readable GJS ESM. Node is development-only.
- Coinbase `BTC-USD` is the only normal source. Binance is asked when Coinbase fails or is in cooldown, and the panel shows its USDT unit. Validate its `BTCUSDT` symbol. Never use TradingView data or any unofficial or scraped endpoint.
- Poll every 5 seconds through one long-lived Soup session (connection reuse is the main efficiency gain). Keep requests on HTTP/1.1: in tested libsoup 3.8, HTTP/2 cancellation while awaiting headers did not enforce the deadline. Refuse redirects and use a 10 s request deadline. Publish results only. Each failed source backs off (10, 20, 40, then 60 s). A Coinbase success may retire only an expired local Binance failure. Server cooldowns from request limits and Retry-After survive re-enable, and manual refreshes or connectivity events must honor them.
- Preserve the last price and failure marker across disable/enable, including when there is no price. Latch full-connectivity notifications during a poll so a failed poll can retry once immediately, subject to server cooldowns. Compare Coinbase trade time with response Date, allow up to 3 s of negative skew independently of cache Age, and show receive time for Binance.
- Do not impose load or side effects: no subprocesses, no settings files, no automatic browser launch, no polling after disable. Do not pause on input idleness: a price on screen must stay live, and GNOME (with GDM/logind) already disables the extension when the screen blanks or locks.
- Parse untrusted responses strictly (bounded body, decimal `price` string of at least 1), quote server text in logs, and show only plain text.
- The menu is one card in a `PopupMenuSection`; a non-reactive `PopupBaseMenuItem` would be drawn dimmed as an inactive item.
- Run `npm run check` (includes a local TLS server offering HTTP/2, like the real APIs); for lifecycle, UI or network changes also `npm run test:shell` (isolated, local fake server).
- Package runtime files through the source-derived manifest. Do not copy build/ wholesale.
- Do not claim lower resource use without a measurement under equivalent conditions.
