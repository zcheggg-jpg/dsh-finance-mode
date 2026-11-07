# 架构与讨论流程

## 一句话

DSH skill 负责“什么时候分析、怎么表述”，MCP plugin 负责“取数、计算、讨论、模拟执行、存档”。

```text
用户
  │  “分析 BTC/ETH” / “/okx-tradingagents”
  ▼
DSH skill  okx-tradingagents
  │  选择 paper_auto / tradingagents_debate
  ▼
MCP plugin  okx (stdio)
  ├─ data.mjs          OKX -> Stooq -> snapshot
  ├─ indicators.mjs    EMA/RSI/MACD/Bollinger/ATR/levels
  ├─ agents.mjs        TradingAgents 角色与辩论
  ├─ paper.mjs         本地模拟盘账本
  └─ report.mjs        Markdown/JSON + MCP resources
  ▼
DSH 对话 / 报告 / 模拟盘状态
```

## 金融模式 preset

安装 bundle 会同时注册一个 `@deepseek-ai/dsh-agent-preset`：

```yaml
id: finance
name: 金融模式
plugins:
  - persona
  - time-context
  - skill-filesystem
  - tool-skill
  - tool-web
  - tool-ask-user
  - tool-schedule
  - compaction
```

用户在 **新任务** 的模式选择器里选“金融模式”即可，不需要先找 skill 或手动拼接提示词。Preset 的 persona 会强制：

- 先调用 `okx` MCP，而不是只凭通用知识回答；
- 走完分析师 → 多空 → 研究经理 → 交易员 → 风险 → 组合经理；
- 输出评级、买入触发、止损/目标、情景、数据源和 stale 标记；
- 默认模拟盘；实盘必须单独授权并满足 `live_status` 闸门。

Preset 只影响**之后创建**的会话；已有会话保持原模式。切换后如果工具没出现，重启 DSH 或新建任务。

## TradingAgents 角色映射

参考 [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) 的团队结构：

1. **Analyst Team**
   - 市场分析师：趋势、动量、波动率、关键点位。
   - 情绪 / 资金分析师：恐惧贪婪、未平仓、清算、ETF 流向。
   - 基本面 / 相对价值分析师：加密资产没有公司现金流，改看周期位置与 ETH/BTC 相对强弱。
2. **Research Debate**
   - 多头研究员：强调支撑、超卖、空头清算、相对强弱。
   - 空头研究员：强调均线下方、MACD 负值、资金流出、更低高点。
3. **Research Manager**
   - 判断哪一边证据更强；如果空头正确但入场太晚，仍给 `Underweight` 而不是追空。
4. **Trader**
   - 给出方向、入场区、止损、目标、盈亏比。
5. **Risk Debate**
   - 激进 / 保守 / 中性三派；风险经理用 ATR、相关性、总敞口和单笔风险做约束。
6. **Portfolio Manager**
   - 最终五级评级：`Buy / Overweight / Hold / Underweight / Sell`。
   - 输出组合净偏、总敞口、相对偏好和“什么情况下改变观点”。

这套实现是**确定性规则引擎**，不调用第二个 LLM。它复刻的是流程和角色，不是官方 Python 包。好处是无需 LLM key、可复现、可测试；代价是语言表达不如 LLM 灵活。

## 五级评级如何得出

技术评分是 `-100..100` 的有界分，由这些信号加权：

- 价格 vs EMA20 / EMA50 / EMA200
- EMA20 vs EMA50、EMA50 vs EMA200
- MACD 柱
- 20 日 / 5 日收益
- RSI14
- 布林带位置

映射规则（简化）：

| 分数 | 评级 | 方向 |
|---:|---|---|
| ≥ 55 且未超买 | Buy | long |
| ≥ 25 | Overweight | long |
| -25 到 25 | Hold | neutral |
| -55 到 -25 | Underweight | short |
| ≤ -55 且接近 20 日低点 | Underweight（不追空） | short |
| ≤ -55 且不接近支撑 | Sell | short |

所以未来数据转多时，会自然切到 `Buy/Overweight` 和回踩买入计划，而不是永远输出 Underweight。

## 模拟盘

- 状态：`OKX_PAPER_STATE`（默认 `$DSH_HOME/okx-tradingagents/paper/account.json`）
- 初始 10,000 USDT；5 bps 手续费 + 5 bps 滑点
- 1% 单笔风险；25% 单品种名义上限；50% 总敞口上限
- 先检查已有持仓的止损/目标，再检查新入场
- 只有价格进入 `execution.entryZone` 才开仓；否则 `wait`
- 只写本地 JSON，不下真实单

## 报告与资源

每次 `tradingagents_debate` / `paper_auto` 都会写：

- `BTC-ETH-TradingAgents-YYYYMMDD-HHmmss.md`
- 对应 `.json`
- `latest.md` / `latest.json`

MCP resources：

- `okx://reports/<file>.md`
- `okx://reports/latest.md`

DSH 里可用 `list_reports`、`read_report` 或 `read_mcp_resource` 读取。

## 实盘执行层（默认关闭）

`auto_trade` 支持三种模式：

| 模式 | 行为 |
|---|---|
| `paper` | 走本地模拟盘，完全不动 OKX |
| `dry_run` | 输出 order ticket，不发送订单 |
| `live` | 通过 OKX 私有 REST 提交**现货限价买单** |

`live` 的闸门：

- `OKX_TRADING_ENABLED=1`
- `OKX_API_KEY` / `OKX_API_SECRET` / `OKX_API_PASSPHRASE`
- `confirm="LIVE"`
- 标的在 allowlist
- 数据源 `stale:false`
- 方向为 `long`（现货只做多）
- 价格在 `execution.entryZone`
- 单笔 / 单日限额
- 限价偏离最新价 ≤ 1%

当前**没有**自动卖出/止损挂单。报告里的止损/目标是监控位；真正无人值守需要独立 runner 和交易所条件单，这是下一阶段。

## 数据与失败模式

- OKX 公共 API 不可达时，自动降级到 Stooq，再降到 snapshot。
- Stooq 日配额耗尽会打开 6 小时熔断，不反复重试。
- 报告标注 `dataSources` 与 `stale`；`stale:true` 不能当实时行情。
- 真实交易未实现；`okx_account` 只读，且需要 API key。
