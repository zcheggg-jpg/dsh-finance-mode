# Changelog

## 1.5.0

- Added the **金融模式** DSH agent preset (`finance`): selects the OKX MCP, financial persona, web search, skill loader, ask-user, schedule and compaction in one click.
- Persona enforces the full TradingAgents analyst → bull/bear → research manager → trader → risk → portfolio-manager path.
- Preset only affects new sessions; existing sessions keep their current mode.

## 1.4.0

- Added `auto_trade` with `paper`, `dry_run`, `live` modes.
- Added guarded OKX spot live adapter: trade-only keys, `OKX_TRADING_ENABLED=1`, `confirm="LIVE"`, allowlist, max order/daily limits, stale-data rejection, price sanity, long-only.
- Added `live_status` and `live_account`.
- Reports now include an execution section.
- Explicitly no unattended live exit/stop-loss loop yet.

## 1.3.0

- Added local paper-trading ledger: `paper_account`, `paper_order`, `paper_close`, `paper_auto`, `paper_history`, `paper_reset`.
- Added risk limits: 1% risk, 25% per-position notional, 50% gross, 5 bps fee/slippage.
- Paper actions included in reports.

## 1.2.1

- Dynamic five-level rating (`Buy`/`Overweight`/`Hold`/`Underweight`/`Sell`) instead of fixed Underweight.
- Added conditional buy triggers and repair levels.

## 1.2.0

- Added persistent Markdown/JSON reports and MCP resources (`okx://reports/*`).
- Added `list_reports` and `read_report`.
- Added live-first data refresh with Stooq quota circuit breaker.

## 1.1.0

- Added dynamic report templates, buy advice fields, and paper report sections.

## 1.0.0

- Initial MCP: OKX/Stooq data, technical analysis, TradingAgents-style debate, BTC/ETH ratings.
