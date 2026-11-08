# Changelog

## 1.6.0

### 量化层

- 新增确定性策略族：单标的趋势（EMA + ATR）、BTC/ETH 动量轮动 + 波动率目标仓位。
- 新增事件驱动回测 `backtest.mjs`：收盘产生信号、次日开盘成交（无未来函数），双边手续费与滑点，现金约束，禁止做空。
- 新增组合回测 `portfolio-backtest.mjs`：共享资金、单腿持仓、按 OKX 真实 `tickSz/lotSz/minSz` 量化数量。
- 新增 `history.mjs`：OKX `history-candles` 分页拉取 + JSONL 本地缓存。

### 执行层（关键修复）

- **补上卖出/平仓能力**：此前只有买入，仓位无法自动退出。
- 新增交易所侧 OCO 止损止盈单（`/api/v5/trade/order-algo`），进程崩溃后保护单仍然有效。
- `openWithProtection`：买入 → 轮询真实成交 → 按成交数量挂 OCO；未成交显式标记 `UNPROTECTED`。
- `closeProtected`：先撤算法单再卖出，避免两个退出路径互相打脸。
- 修复：时钟校偏（`syncClock`，解决 50102）、日额度改用 UTC+8 口径、状态文件损坏改为 fail-closed。

### 引擎

- `runner.mjs`：常驻 paper 引擎，三道硬守卫（KILL 开关、日亏 −3% 熔断、连亏 3 笔冷却 24h），写心跳与追加式决策日志。
- `live-runner.mjs`：实盘引擎，七道闸门（开关、密钥、`confirm=LIVE`、金丝雀限额、KILL、日亏、冷却）+ 无保护不开仓。
- 新增 CLI：`scripts/runner-cli.mjs`、`scripts/live-runner-cli.mjs`。

### 自检

- 三组离线/公开数据自检：回测不变量、执行层 builders/guards、实盘闸门，共 56 项，全部通过且不需要 API key。
- 实盘闸门在无密钥时必须拒绝，这一点本身就是被测行为。


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
