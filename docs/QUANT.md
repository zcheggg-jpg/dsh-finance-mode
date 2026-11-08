# 量化层（v1.6）

> 研究用途，不构成投资建议。任何策略都可能亏损本金。

## 1. 分层

```text
数据层  quant/history.mjs          OKX history-candles 分页 + JSONL 缓存
研究层  quant/strategy-trend.mjs   单标的趋势（EMA + ATR 止损）
        quant/strategy-momentum.mjs 动量轮动 + 波动率目标仓位
        quant/backtest.mjs         事件驱动回测（单标的）
        quant/portfolio-backtest.mjs 共享资金组合回测 + 真实 lot/min 约束
执行层  quant/execution.mjs        买入 / 卖出 / 交易所侧 OCO / 成交确认
引擎层  quant/runner.mjs           常驻 paper 引擎 + 三道硬守卫
        quant/live-runner.mjs      实盘引擎 + 七道闸门 + 金丝雀限额
监盘层  MCP 工具（TradingAgents 辩论）+ 人工复盘
```

设计原则：**引擎掌盘（快、确定、可审计），AI 掌舵（研究、参数、复盘）**。
LLM 不进入执行环，只写配置与提出建议；参数有硬边界（`PARAM_BOUNDS` / `MOMENTUM_BOUNDS`），越界直接拒绝。

## 2. 回测结果（OKX 日线 2018-08 → 2026-11，扣 15 bps 双边）

| 策略 | 仓位模式 | 总收益 | CAGR | 最大回撤 | Sharpe | 交易 |
|---|---|---|---|---|---|---|
| 单标的趋势 | 风险 0.5%/笔 | +52.9% | 5.30% | 7.11% | 0.93 | 61 |
| 动量轮动 | 风险 1%/笔 | +54.5% | 5.44% | 8.04% | 1.11 | 151 |
| 动量轮动 | 波动率目标 25% | +101.6% | 8.91% | 14.04% | 1.16 | 151 |
| 动量轮动 | 波动率目标 50% | +253.7% | 16.62% | 25.87% | 1.15 | 151 |

同期买入持有：BTC +1069.6%、ETH +711.7%。

**结论：**

1. 参数稳健：趋势 18/18、轮动 24/24 组合全为正，收益不是挑参数挑出来的。
2. 最大杠杆是**仓位管理**而非信号：同一信号从 5.44% → 8.91% → 16.62%，只改仓位算法。
3. 收益/回撤比恒定约 0.64，**放大收益必然等比放大回撤**。
4. 稳健策略必然跑输满仓持有——这是取舍，不是缺陷。

## 3. 真实交易约束（实测 OKX 公开规格）

| 标的 | minSz | 折合金额 | lotSz | tickSz |
|---|---|---|---|---|
| BTC-USDT | 0.00001 | ≈ 0.76 USDT | 1e-8 | 0.1 |
| ETH-USDT | 0.0001 | ≈ 0.22 USDT | 1e-6 | 0.01 |

回测引擎按这些规格量化数量，并统计 `skippedSignals`。
20 USDT 账户实测：收益率与 1000 USDT 几乎一致（+101.60% vs +101.61%），说明**规模不影响百分比收益**；但一年只能赚约 1.78 USDT，不值得承担实盘风险。

## 3.5 小资金可行性（20 USDT 实测）

把 OKX 真实 `lotSz/minSz` 写进回测后：

| 账户 | 期末 | 总收益 | CAGR | 最大回撤 |
|---|---|---|---|---|
| 1000 USDT | 2016.07 | +101.61% | 8.91% | 14.04% |
| 20 USDT | 40.32 | +101.60% | 8.91% | 14.04% |

- **收益率与账户规模无关**，lot 量化误差可忽略 → 20 USDT 技术上能跑通全流程。
- 但 8.91% 年化在 20 USDT 上 = 约 **1.78 USDT/年**，投入产出比不成立。
- 建议：小资金停留在 paper；账户到 300–500 USDT 再上金丝雀（单笔 10–20 USDT）。

## 4. 执行层

| 函数 | 作用 |
|---|---|
| `buildSpotOrder` / `buildOcoBody` | 纯函数，可离线测试，按 tick/lot 取整 |
| `placeSpotSell` | 市价/限价卖出，强制 ≤ 可用余额 |
| `placeOcoStop` | 交易所侧 OCO：`slTriggerPx` + `tpTriggerPx`，`slOrdPx/tpOrdPx = -1`（触发后市价） |
| `openWithProtection` | 买入 → 轮询真实成交 → 按 `filledQty` 挂 OCO；未成交返回 `UNPROTECTED` |
| `closeProtected` | 先撤算法单，再卖出（避免 OCO 与卖单互相打脸） |

**为什么把止损放到交易所**：进程崩溃、DSH 关闭、断网时，本地循环全部失效，而交易所的条件单仍然有效。这是"最多亏一个止损"和"可能亏光"的分界线。

## 5. 引擎与守卫

`runner.mjs`（paper，默认安全）

| 守卫 | 触发 | 动作 |
|---|---|---|
| KILL 开关 | 文件 `quant/runner/KILL` 存在 | 禁止开新仓 |
| 日亏熔断 | 当日权益 ≤ −3% | 当日禁止开仓 |
| 连亏冷却 | 连续 3 笔止损 | 冷却 24h |

输出：`heartbeat.json`（心跳）、`decisions.jsonl`（追加日志）、`runner-meta.json`（日初权益/连亏数）、`paper-state.json`（账本）。

`live-runner.mjs`（实盘，默认 dry-run）

七道闸门：`OKX_TRADING_ENABLED=1` · 密钥齐备 · `confirm=LIVE` · 金丝雀限额（单笔 100 / 日 300 USDT）· KILL · 日亏 · 冷却。
另有两条硬规则：

- **无保护不开仓**：成交后必须成功挂上 OCO，否则报 `ALERT`，不写持仓
- **保护单体检**：持仓却无算法单时显式 `ALERT`，不当成正常状态

## 6. 上线门槛（不满足就停在 paper）

- paper 连续 ≥ 4 周、≥ 40 笔
- 扣费后正期望，盈亏比 PF > 1.3
- 最大回撤 < 10%（相对策略权益）
- 回测与 paper 收益差 < 20%
- 全程零风控越界事件

## 7. 自检

```powershell
node scripts/engine-selftest.mjs        # 回测不变量（无未来函数、仓位不重叠、止损价合理）
node scripts/execution-selftest.mjs     # 取整、builder、OCO、闸门、dry-run 计划
node scripts/live-runner-selftest.mjs   # 实盘闸门 + 强制可交易场景的开仓计划
```

三组共 56 项，全部不需要 API key。

## 8. 未验证部分（必须诚实标注）

- 真实下单、真实成交、真实 OCO 触发：**尚未在交易所验证**
- OKX 对现货 OCO 的具体参数要求（如是否要求 `reduceOnly`）：若被拒，代码抛错而不是吞掉
- 长周期稳定性：需连续运行数周观察信号漂移

## 9. 命令速查

```powershell
node scripts/backtest.mjs --symbols BTC,ETH --bars 3000 --grid
node scripts/backtest-portfolio.mjs --bars 3000 --grid --sizing voltarget
node scripts/runner-cli.mjs --once --dry-run
node scripts/live-runner-cli.mjs                       # dry-run
node scripts/live-runner-cli.mjs --live --confirm LIVE # 真实下单（需密钥）
```


代码缺陷与修复状态见 [AUDIT.md](AUDIT.md)。
