# Security

- The MCP tools (`tradingagents_debate`, `paper_*`) never place real orders.
- Real orders are only possible through the guarded quantization layer: `plugin/lib/quant/live-runner.mjs` and `auto_trade` with `mode="live"`. Both are **off by default** and require `OKX_TRADING_ENABLED=1` + trade-only keys + `confirm="LIVE"`.
- The live path is **not yet verified against the exchange**; treat it as experimental until a canary run (10 USDT) has confirmed fills and OCO placement.
- No API key is required for market data, analysis, or paper trading.
- `okx_account` is read-only and is disabled unless `OKX_API_KEY`, `OKX_API_SECRET`, and `OKX_API_PASSPHRASE` are present. If you enable it, use a trade-only key with withdrawals disabled and an IP allowlist.
- Never paste API secrets into chat, issues, or pull requests.
- The paper ledger is local JSON under `$DSH_HOME/okx-tradingagents/paper/`. It is not encrypted; do not store real secrets in it.
- Reports may contain market views and simulated PnL; they are research output, not investment advice.
- To report a vulnerability, open a private security advisory on GitHub rather than a public issue.
