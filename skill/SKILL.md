---
name: okx-tradingagents
description: 用 OKX 数据运行 TradingAgents 式 BTC/ETH 多空与风险辩论，输出评级、买入触发、止损/目标和本地模拟盘执行；用户提到 OKX、BTC、ETH、TradingAgents、走势分析、买入建议或模拟盘时使用。
whenToUse: 用户要求分析 BTC/ETH 走势、给出买入/卖出建议、查看 TradingAgents 讨论、运行模拟盘或读取历史报告时。
user-invocable: true
---

# OKX TradingAgents 研究台

> 首选入口：在 DSH **新任务**的模式选择器里选 **“金融模式”**。该 preset 已内置本流程和 `okx` MCP；本 skill 也可在标准模式下手动调用。

使用已安装的 `okx` MCP。默认只做**研究 + 本地模拟盘**；实盘入口默认关闭，只有用户明确要求并满足 `live_status` 的全部闸门时才可使用。

## 默认流程

1. 先调用 `mcp__okx__paper_auto`（参数 `riskProfile` 默认 `balanced`，`capitalUSDT` 默认 `10000`）。
   - 它会运行完整 TradingAgents 流程：市场 / 情绪 / 基本面分析师 → 多头 vs 空头研究员 → 研究经理 → 交易员 → 激进/保守/中性风险辩论 → 组合经理。
   - 它会先管理模拟盘止损/止盈，再只在价格进入计划入场区时模拟开仓。
   - 它会自动保存 Markdown + JSON 报告。
2. 读取 `report.uri`，或调用 `mcp__okx__read_report {name:"latest.md"}`，把报告里的关键结论转述给用户。
3. 需要纯分析、不执行模拟盘时，改用 `mcp__okx__tradingagents_debate`。
4. 需要账户/持仓时，调用 `mcp__okx__paper_account`；需要历史成交时调用 `mcp__okx__paper_history`。

## 实盘入口（默认关闭）

只有用户**明确要求实盘**，并且 `mcp__okx__live_status` 显示 `enabled:true`、`keysConfigured:true` 时，才可以建议：

```text
mcp__okx__auto_trade {mode:"live", confirm:"LIVE"}
```

规则：

- 先 `dry_run`，让用户看到 order ticket；确认后再 `live`。
- 现货只做多；`Underweight/Sell` 不开新多。
- 数据 `stale:true` 时拒绝实盘。
- 单笔/单日限额由插件环境变量控制；不要擅自提高。
- 当前没有自动卖出/止损挂单；报告里的止损/目标是监控位，不是交易所挂单。
- 绝不说“已买入/卖出”，除非工具返回了 OKX `ordId`；即使有 `ordId`，也要说明可能未成交。

## 输出格式

用中文回答，先给结论表：

| 资产 | 现价/技术收盘 | 趋势 | 评级 | 信心 | 买入触发 | 止损 | 目标 |
|---|---:|---|---|---:|---:|---:|---:|

然后给：

- **讨论裁决**：研究经理为什么选多头/空头/观望。
- **具体点位**：入场区、止损、目标、失效条件。
- **模拟盘动作**：本次是 `open` / `wait` / `hold` / `close`，以及原因。
- **数据状态**：`dataSources` 是 OKX、Stooq 还是 snapshot；`stale:true` 时必须明确说明。
- **风险提示**：研究用途，不构成投资建议。

## 硬性规则

- `paper_*` 只写本地 JSON，绝不能说成真实成交；只有 `auto_trade mode=live` 返回 OKX `ordId` 时，才能说“已提交”，不能说“已成交”。
- 真实交易需要用户明确授权、OKX API key（仅交易权限、关闭提币、IP 白名单）、限额和 kill switch；当前不要自行开通。
- 不使用过期快照假装实时行情；报告里 `stale:true` 就直说。
- 不在聊天中回显 API secret/passphrase。
- 不因为“Extreme Fear”或单一指标直接建议满仓；必须走完多空/风险辩论。
- 没有触发入场区时，正确动作是等待，不是追单。

## 常用工具

- `mcp__okx__paper_auto` — 分析 + 模拟执行（默认）
- `mcp__okx__auto_trade` — `paper / dry_run / live` 执行入口
- `mcp__okx__live_status` / `live_account` — 实盘闸门和只读余额
- `mcp__okx__tradingagents_debate` — 只分析 + 保存报告
- `mcp__okx__paper_account` / `paper_history` / `paper_order` / `paper_close` / `paper_reset`
- `mcp__okx__list_reports` / `read_report` / `read_mcp_resource`
- `mcp__okx__market_snapshot` / `technical_analysis` / `market_context`
