# GitHub 发布信息

## 仓库名

```text
dsh-finance-mode
```

## 简介（GitHub Description）

```text
一键金融模式 for DSH：TradingAgents 式 BTC/ETH 多空辩论、买入触发、模拟盘与受控实盘。One-click Finance Mode for DeepSeek Harness.
```

## Topics

```text
dsh
deepseek-harness
tradingagents
mcp
okx
binance
crypto
paper-trading
ai-agent
```

## 置顶说明

- 默认模拟盘；实盘默认关闭，需要环境变量 + 交易密钥 + `confirm="LIVE"` 三重条件。
- 不承诺收益；研究用途，不构成投资建议。任何策略都可能亏损本金。
- v1.6 新增量化层：确定性策略、事件驱动回测、常驻引擎、交易所侧 OCO 止损单。
- `auto_trade` 的 live 模式仍只提交限价买单；需要自动保护请走 `live-runner`。
- **真实下单路径尚未在交易所验证**：先用 10 USDT 金丝雀确认成交与 OCO 挂单。
- 安装一次，新任务选「金融模式」即可。
