# Security

- This project does **not** place, amend, or cancel real OKX orders.
- No API key is required for market data, analysis, or paper trading.
- `okx_account` is read-only and is disabled unless `OKX_API_KEY`, `OKX_API_SECRET`, and `OKX_API_PASSPHRASE` are present. If you enable it, use a trade-only key with withdrawals disabled and an IP allowlist.
- Never paste API secrets into chat, issues, or pull requests.
- The paper ledger is local JSON under `$DSH_HOME/okx-tradingagents/paper/`. It is not encrypted; do not store real secrets in it.
- Reports may contain market views and simulated PnL; they are research output, not investment advice.
- To report a vulnerability, open a private security advisory on GitHub rather than a public issue.
