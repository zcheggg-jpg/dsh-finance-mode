<p align="center">
  <img src="plugin/icon.svg" width="88" alt="DSH Finance Mode" />
</p>

<h1 align="center">DSH 金融模式</h1>

<p align="center">
  <b>把 TradingAgents 装进 DeepSeek Harness。</b><br/>
  新建任务 → 选「金融模式」→ 问一句，就能拿到 BTC/ETH 多空辩论、评级、买入触发和模拟盘执行。
</p>

<p align="center">
  <img alt="DSH" src="https://img.shields.io/badge/DSH-DeepSeek%20Harness-4f46e5" />
  <img alt="MCP" src="https://img.shields.io/badge/MCP-okx%20%7C%20binance-0ea5e9" />
  <img alt="TradingAgents" src="https://img.shields.io/badge/TradingAgents-inspired-10b981" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-f59e0b" />
</p>

[![M8ven Score](https://m8ven.ai/badge/mcp/zcheggg-jpg-dsh-finance-mode-ujr6pv?v=b9430f3ee15c40893bf1d223e4ddb93e)](https://m8ven.ai/mcp/zcheggg-jpg-dsh-finance-mode-ujr6pv?s=readme)

> 默认只读 + 模拟盘。**真实交易适配器默认关闭；不会自动下单。**
>
> 不是“问一句 ChatGPT 怎么看”，而是把数据、指标、多角色辩论、风险约束、报告和模拟盘串成一条可重复的流水线。

## 为什么值得试

- **不用记命令**：装一次，新任务选「金融模式」，直接说“分析 BTC/ETH”。
- **不是单角色嘴炮**：市场 / 情绪 / 基本面 → 多空研究员 → 研究经理 → 交易员 → 三派风险辩论 → 组合经理。
- **有具体点位**：评级、入场区、止损、目标、情景概率、失效条件。
- **默认安全**：模拟盘优先；实盘是受控现货限价买入，默认关闭。
- **结果可追溯**：每次分析自动保存 Markdown + JSON，DSH 里可直接读。

## 30 秒体验

```text
1. 安装插件（见下方 Quick Start）
2. 新建任务 → 模式选择「金融模式」
3. 输入：分析 BTC/ETH，balanced，1 万 U，给买入触发和止损
```

## 这个项目解决什么

直接把“分析 BTC/ETH”变成 DSH 里可重复的一件事：

1. 拉取 OKX / Stooq 行情，计算 EMA、RSI、MACD、布林、ATR、20/60 日区间。
2. 按 TradingAgents 的团队拓扑跑一场讨论：
   - 市场分析师
   - 情绪 / 资金分析师
   - 基本面 / 相对价值分析师
   - 多头研究员 vs 空头研究员
   - 研究经理裁决
   - 交易员给出入场/止损/目标
   - 激进 / 保守 / 中性风险辩论
   - 组合经理给最终评级
3. 输出 `Buy / Overweight / Hold / Underweight / Sell`，以及具体点位。
4. 本地模拟盘按计划入场区执行，管理止损/止盈，记录成交和权益曲线。
5. 每个报告自动保存成 Markdown + JSON，DSH 里可直接读取。

## 快速开始

### 1. 安装

Windows：

```powershell
git clone https://github.com/zcheggg-jpg/dsh-finance-mode.git
cd dsh-finance-mode
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

> 如果 PowerShell 执行策略阻止脚本，使用上面的 `-ExecutionPolicy Bypass` 方式。

macOS / Linux：

```bash
git clone https://github.com/zcheggg-jpg/dsh-finance-mode.git
cd dsh-finance-mode
./install.sh
```

安装脚本会：

- 把插件复制到 `$DSH_HOME/plugin-sources/dsh-okx-tradingagents`
- 把 skill 复制到 `$DSH_HOME/skills/okx-tradingagents`
- 打印插件安装路径

### 2. 在 DSH 启用插件

打开 **DSH → 设置 → 插件管理 → 安装本地 bundle**，选择：

```text
$DSH_HOME/plugin-sources/dsh-okx-tradingagents
```

安装成功后：

- 工具以 `mcp__okx__*` 出现；
- **新任务**的模式选择器里出现 **“金融模式”**（Agent preset）；
- skill 以 `okx-tradingagents` 出现。

> 需要 Node 20+。DSH Desktop 自带 Node；如果插件启动失败，确认 `node` 可从 PATH 访问。

### 3. 一键进入金融模式

新建一个任务，在模式选择器里选 **“金融模式”**，然后直接说：

```text
分析 BTC/ETH，给买入触发和止损。
```

这个 preset 已内置：

- `okx` MCP；
- 金融研究 persona（强制走完整 TradingAgents 讨论）；
- 时间上下文；
- web 搜索 / skill / ask-user / schedule；
- 上下文压缩。

也可以不切 preset，在标准模式里用 skill：

```text
/okx-tradingagents
```

## 工具

| 工具 | 用途 |
|---|---|
| `mcp__okx__paper_auto` | **默认入口**：跑完整讨论 + 模拟盘执行 + 保存报告 |
| `mcp__okx__auto_trade` | 跑完整讨论后按 `paper / dry_run / live` 执行；live 默认关闭且有多重闸门 |
| `mcp__okx__live_status` | 查看实盘开关、key、限额、当日用量 |
| `mcp__okx__live_account` | 只读 OKX USDT 余额（需要 key） |
| `mcp__okx__tradingagents_debate` | 只分析，保存 Markdown/JSON 报告 |
| `mcp__okx__market_snapshot` | BTC/ETH 行情、24h/52 周区间 |
| `mcp__okx__technical_analysis` | EMA20/50/200、RSI14、MACD、布林、ATR、波动率、关键点位 |
| `mcp__okx__market_context` | 情绪指数、未平仓、清算、ETF 流向 |
| `mcp__okx__paper_account` | 模拟账户权益、持仓、浮盈亏 |
| `mcp__okx__paper_order` | 手动开模拟多/空 |
| `mcp__okx__paper_close` | 平模拟仓 |
| `mcp__okx__paper_history` | 历史成交、胜率、总盈亏 |
| `mcp__okx__paper_reset` | 重置模拟账户 |
| `mcp__okx__list_reports` / `read_report` | 列出 / 读取历史报告 |
| `mcp__okx__okx_account` | 只读 OKX USDT 余额（可选，需要 API key） |

## 数据策略

```text
OKX public REST  ->  Stooq quote/history  ->  bundled snapshot
```

- **OKX** 是主数据源；公共行情不需要 API key。
- **Stooq** 是 fallback，适配器会处理它的小型 proof-of-work 校验。
- **Bundled snapshot** 在交易所网络不可达时保证仍可复盘；报告会标记 `stale: true`。
- 当前主机无法直连 OKX 时，报告会明确写 snapshot，不会伪装成实时盘口。

## 模拟盘规则

- 初始资金：10,000 USDT（可重置）
- 手续费 5 bps + 滑点 5 bps
- 单笔风险：权益的 1%
- 单品种名义上限：25%
- 总敞口上限：50%
- 1x 简化模型，不模拟资金费率 / 强平 / 盘口深度
- 状态文件：`$DSH_HOME/okx-tradingagents/paper/account.json`

`paper_auto` 只有在价格进入计划 `execution.entryZone` 时才模拟开仓；没到点位就返回 `wait`。

## 量化层（v1.6 新增）

MCP 工具负责「研究与模拟盘」；量化层负责「可回测的确定性策略 + 常驻引擎 + 受控执行」。

| 模块 | 作用 |
|---|---|
| `plugin/lib/quant/history.mjs` | OKX 历史 K 线分页拉取 + 本地缓存 |
| `plugin/lib/quant/strategy-trend.mjs` | 单标的趋势（EMA + ATR 止损） |
| `plugin/lib/quant/strategy-momentum.mjs` | 动量轮动 + 波动率目标仓位 |
| `plugin/lib/quant/backtest.mjs` | 事件驱动回测（无未来函数、双边成本、现金约束） |
| `plugin/lib/quant/portfolio-backtest.mjs` | 多标的共享资金回测 + 真实 tick/lot/min 约束 |
| `plugin/lib/quant/execution.mjs` | 现货卖出 + **交易所侧 OCO 止损** + 成交确认 |
| `plugin/lib/quant/runner.mjs` | 常驻引擎（paper 账本）+ 三道硬守卫 |
| `plugin/lib/quant/live-runner.mjs` | 实盘引擎（七道闸门 + 金丝雀限额，默认 dry-run） |

回测结论（OKX 日线 2018-08 → 2026-11，扣 15 bps 双边成本）：

| 策略 | 仓位模式 | CAGR | 最大回撤 | Sharpe |
|---|---|---|---|---|
| 单标的趋势 | 风险 0.5%/笔 | 5.30% | 7.11% | 0.93 |
| 动量轮动 | 风险 1%/笔 | 5.44% | 8.04% | 1.11 |
| 动量轮动 | 波动率目标 25% | 8.91% | 14.04% | 1.16 |
| 动量轮动 | 波动率目标 50% | 16.62% | 25.87% | 1.15 |

同期 BTC 买入持有 +1069.6%。**稳健策略必然跑输满仓持有，这是取舍而不是缺陷。**

参数稳健性：趋势 18/18、轮动 24/24 组合全为正 → 收益不来自参数挑选。
细节见 [docs/QUANT.md](docs/QUANT.md)。

## TradingAgents 关系

角色顺序参考 [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents)：

```text
Analyst Team -> Bull/Bear Researchers -> Research Manager -> Trader
             -> Aggressive/Conservative/Neutral Risk Debate -> Portfolio Manager
```

本项目的实现是**确定性规则引擎**，不依赖第二个 LLM key，因此结果可复现、可测试。它不是官方 Python 包的替代品；如果你要官方实现，需要另外配置 LLM 与数据源 key。

## 真实交易：受控的现货入场

项目包含 `auto_trade` 的 `live` 模式，但它**默认关闭**，而且不是“无脑全自动”：

必须同时满足：

- `OKX_TRADING_ENABLED=1`
- `OKX_API_KEY` / `OKX_API_SECRET` / `OKX_API_PASSPHRASE`
- 工具参数 `confirm="LIVE"`
- 标的在 `OKX_ALLOWED_INSTRUMENTS`（默认 BTC-USDT, ETH-USDT）
- 数据不是 `stale` 快照
- TradingAgents 方向为 **long**（现货只做多）
- 价格在计划入场区
- 单笔 ≤ `OKX_MAX_ORDER_USDT`（默认 100）
- 当日累计 ≤ `OKX_MAX_DAILY_USDT`（默认 300）
- 限价偏离最新价 ≤ 1%
- 只提交**限价买单**，不提供自动卖出/止损挂单

**v1.6 起**量化层提供了常驻 runner 与交易所侧 OCO 止损单（`placeOcoStop`），但：

- `auto_trade` 的 `live` 模式**仍然只提交限价买单，不自动挂保护单**——要保护请走 `live-runner`
- `live-runner` 默认 dry-run，需 `--live --confirm LIVE` + `OKX_TRADING_ENABLED=1` + 密钥才会真实下单
- 真实下单路径**尚未在交易所验证**，必须先用 10 USDT 金丝雀人工确认成交与 OCO 挂单

不要用未验证的执行路径跑大资金。

API key 建议：只开交易权限、关闭提币、绑定 IP、单独子账户、先小额。

### 配置示例

在插件安装后的 `cordis.patch.yml` 里追加环境变量（不要提交到 git）：

```yaml
        env:
          ELECTRON_RUN_AS_NODE: '1'
          OKX_REPORT_DIR: '...'
          OKX_PAPER_STATE: '...'
          OKX_LIVE_STATE: '...'
          OKX_TRADING_ENABLED: '0'          # 先保持 0
          OKX_ALLOWED_INSTRUMENTS: 'BTC-USDT,ETH-USDT'
          OKX_MAX_ORDER_USDT: '100'
          OKX_MAX_DAILY_USDT: '300'
          OKX_API_KEY: !!js process.env.OKX_API_KEY
          OKX_API_SECRET: !!js process.env.OKX_API_SECRET
          OKX_API_PASSPHRASE: !!js process.env.OKX_API_PASSPHRASE
```

确认模拟盘稳定后，再把 `OKX_TRADING_ENABLED` 改成 `1`，并用 `auto_trade {mode:"live", confirm:"LIVE"}` 做一笔最小额测试。

不要仅凭“账号已登录”就假设 MCP 能下单；浏览器登录态不等于 API 交易权限。

## 目录

```text
plugin/                 DSH MCP bundle（server + lib + snapshot）
plugin/lib/quant/       量化层：回测 / 策略 / 执行 / 引擎
scripts/                回测与引擎 CLI + 自检脚本
scripts/set-okx-keys.ps1  交互式配置 OKX 密钥（写入用户环境变量）
skill/SKILL.md          DSH skill：一键分析入口
docs/ARCHITECTURE.md    架构与讨论流程
docs/QUANT.md           量化层设计、守卫与上线门槛
install.ps1             Windows 安装
install.sh              macOS/Linux 安装
```

## 开发

```powershell
cd plugin
node .\server.mjs --selftest
node .\server.mjs --analyze --risk balanced --capital 10000

# 量化层自检（三组共 56 项，无需 API key）
cd ..
node scripts/engine-selftest.mjs
node scripts/execution-selftest.mjs
node scripts/live-runner-selftest.mjs

# 回测（真实 OKX 历史 K 线）
node scripts/backtest.mjs --symbols BTC,ETH --bars 3000 --grid
node scripts/backtest-portfolio.mjs --bars 3000 --grid --sizing voltarget

# 引擎（默认 paper / dry-run，不会下单）
node scripts/runner-cli.mjs --once --dry-run
node scripts/live-runner-cli.mjs
```

## License

MIT。研究用途，不构成投资建议。加密资产可能损失全部本金。
