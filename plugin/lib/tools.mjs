// MCP tool definitions and handlers for the OKX / TradingAgents server.

import { getMarketData, getOkxAccount, health, getSnapshotContext } from './data.mjs';
import { computeTechnicals } from './indicators.mjs';
import { runTradingAgents } from './agents.mjs';
import { saveReport, listReports, readReport } from './report.mjs';
import {
  loadState,
  resetState,
  accountSnapshot,
  openPosition,
  closePosition,
  autoTrade,
  history as paperHistory,
  marksFromSources,
  paperStatePath,
} from './paper.mjs';
import { liveStatus, dailyUsage, getUsdtBalance, getTicker, placeSpotLimitBuy } from './okx-live.mjs';

const SYMBOL_SCHEMA = { type: 'string', enum: ['BTC', 'ETH'], description: 'BTC or ETH' };

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: String(message) }], isError: true };
}

function summarize(data) {
  const a = data.analysis;
  return {
    symbol: data.symbol,
    source: data.source,
    sourceUrl: data.sourceUrl,
    stale: Boolean(data.stale),
    price: a?.price ?? data.price,
    quoteTime: a?.asOf ?? data.quoteTime,
    change24hPct: a?.change24hPct ?? data.quote?.change24hPct ?? null,
    high24h: a?.high24h ?? data.quote?.high24h ?? null,
    low24h: a?.low24h ?? data.quote?.low24h ?? null,
    high52w: a?.high52w ?? data.quote?.high52w ?? null,
    low52w: a?.low52w ?? data.quote?.low52w ?? null,
    bias: a?.bias ?? null,
    score: a?.score ?? null,
    regime: a?.regime ?? null,
    technicals: a
      ? {
          rsi14: a.rsi14,
          macdHistogram: a.macd?.histogram,
          ema20: a.ema?.ema20,
          ema50: a.ema?.ema50,
          atrPct: a.atrPct,
          drawdownFromHighPct: a.drawdownFromHighPct,
          returns: a.returns,
        }
      : null,
  };
}

async function analysisFor(symbol, options = {}) {
  const data = await getMarketData(symbol, options);
  if (data.analysis) {
    return { data, analysis: data.analysis };
  }
  if (!data.candles || data.candles.length < 30) {
    throw new Error(`Not enough candles for ${symbol} (${data.candles?.length || 0}); snapshot has no precomputed analysis`);
  }
  const analysis = computeTechnicals(data.candles, data.quote);
  return { data, analysis };
}

async function handleMarketSnapshot(args = {}) {
  const symbols = Array.isArray(args.symbols) && args.symbols.length ? args.symbols : ['BTC', 'ETH'];
  const out = { generatedAt: new Date().toISOString(), sourcePolicy: 'OKX public REST -> Stooq public quote/history -> bundled snapshot', symbols: {} };
  for (const symbol of symbols) {
    const data = await getMarketData(symbol);
    out.symbols[symbol] = summarize(data);
  }
  return out;
}

async function handleCandles(args = {}) {
  const symbol = args.symbol || 'BTC';
  const limit = Math.max(1, Math.min(300, Number(args.limit || 120)));
  const data = await getMarketData(symbol);
  if (!data.candles || !data.candles.length) {
    throw new Error(`No candle array is available for ${symbol} in the current source (${data.source}). Use technical_analysis for the snapshot summary.`);
  }
  return {
    symbol,
    source: data.source,
    stale: Boolean(data.stale),
    bar: args.bar || '1D',
    note: args.bar && args.bar !== '1D' ? 'Only daily bars are available from the current source; bar is reported as 1D.' : 'Daily bars.',
    candles: data.candles.slice(-limit),
  };
}

async function handleTechnicalAnalysis(args = {}) {
  const symbol = args.symbol || 'BTC';
  const { data, analysis } = await analysisFor(symbol);
  return {
    symbol,
    source: data.source,
    sourceUrl: data.sourceUrl,
    stale: Boolean(data.stale),
    quoteTime: data.quoteTime,
    analysis,
  };
}

async function handleMarketContext() {
  const context = getSnapshotContext();
  if (!context) return { available: false, note: 'No bundled market context.' };
  return {
    available: true,
    source: context.source,
    capturedAt: context.capturedAt || null,
    sentiment: context.sentiment,
    livePrices: context.livePrices,
    change24hPct: context.change24hPct,
    change7dPct: context.change7dPct,
    openInterestUsd: context.openInterestUsd,
    openInterestChangePct: context.openInterestChangePct,
    liquidations24hUsd: context.liquidations24hUsd,
    lastMajorLiquidation: context.lastMajorLiquidation,
    etfFlows: context.etfFlows,
    note: 'Aggregate derivatives/flow context from MyToken; not an OKX-native funding or open-interest feed.',
  };
}

async function handleOkxAccount() {
  const data = await getOkxAccount();
  return { readOnly: true, source: 'OKX private REST /api/v5/account/balance', data };
}

async function buildDesk(args = {}) {
  const symbols = Array.isArray(args.symbols) && args.symbols.length ? args.symbols : ['BTC', 'ETH'];
  const needed = [...new Set([...symbols, 'BTC', 'ETH'])];
  const analyses = {};
  const sources = {};
  for (const symbol of needed) {
    const { data, analysis } = await analysisFor(symbol);
    analyses[symbol] = analysis;
    sources[symbol] = {
      source: data.source,
      sourceUrl: data.sourceUrl,
      stale: Boolean(data.stale),
      quoteTime: data.quoteTime,
      price: analysis.price,
      change24hPct: analysis.change24hPct,
      bias: analysis.bias,
      score: analysis.score,
    };
  }
  const context = getSnapshotContext() || {};
  const result = runTradingAgents(analyses, context, {
    capitalUSDT: args.capitalUSDT,
    riskProfile: args.riskProfile,
  });
  result.dataSources = sources;
  return { result, sources, needed };
}

async function handleDebate(args = {}) {
  const { result, needed } = await buildDesk(args);
  let report = null;
  if (args.saveReport !== false) {
    report = saveReport(result, { prefix: needed.join('-'), generatedAt: result.asOf });
  }
  return {
    ...result,
    report: report
      ? {
          name: report.name,
          uri: report.uri,
          mdPath: report.mdPath,
          jsonPath: report.jsonPath,
          bytes: report.bytes,
          note: 'Saved locally; read it in DSH with read_mcp_resource on this URI, or call read_report with this name.',
        }
      : { saved: false },
  };
}

async function handleListReports(args = {}) {
  const reports = listReports(args.limit || 50);
  return {
    reportDir: process.env.OKX_REPORT_DIR || 'package reports/ directory',
    count: reports.length,
    reports,
    note: 'Read a report with read_report {name} or read_mcp_resource {uri}.',
  };
}

async function handleReadReport(args = {}) {
  const name = args.name || 'latest.md';
  const report = readReport(name);
  return report;
}

async function markFor(symbol) {
  const { analysis } = await analysisFor(symbol);
  return Number(analysis.price);
}

async function marksForState(state) {
  const marks = {};
  for (const symbol of Object.keys(state.positions || {})) {
    try {
      marks[symbol] = await markFor(symbol);
    } catch {
      // accountSnapshot falls back to entryPrice when a mark is unavailable.
    }
  }
  return marks;
}

async function handlePaperAccount() {
  const state = loadState();
  const marks = await marksForState(state);
  return { ...accountSnapshot(state, marks), statePath: paperStatePath() };
}

async function handlePaperOrder(args = {}) {
  if (args.confirm !== 'PAPER') throw new Error('paper_order requires confirm="PAPER"');
  const symbol = args.symbol || 'BTC';
  const side = args.side === 'buy' ? 'long' : args.side === 'sell' ? 'short' : args.side;
  if (!['long', 'short'].includes(side)) throw new Error('side must be long, short, buy or sell');
  const price = Number(args.price) || await markFor(symbol);
  const state = loadState();
  const order = openPosition(state, {
    symbol,
    side,
    price,
    stop: args.stop,
    target: args.target,
    riskPct: state.config.riskPct,
    maxPositionPct: state.config.maxPositionPct,
    notionalCapUSDT: args.notionalUSDT || 1000,
    reason: 'manual-paper',
  });
  return { order, account: accountSnapshot(state, { [symbol]: price }) };
}

async function handlePaperClose(args = {}) {
  if (args.confirm !== 'CLOSE') throw new Error('paper_close requires confirm="CLOSE"');
  const symbol = args.symbol || 'BTC';
  const state = loadState();
  if (!state.positions[symbol]) throw new Error(`No open paper position for ${symbol}`);
  const price = Number(args.price) || await markFor(symbol);
  const trade = closePosition(state, { symbol, price, reason: args.reason || 'manual-paper' });
  return { trade, account: accountSnapshot(state, { [symbol]: price }) };
}

async function handlePaperAuto(args = {}) {
  const { result, needed } = await buildDesk(args);
  const marks = marksFromSources(result.dataSources);
  const state = loadState();
  const paper = autoTrade(state, result.decision, marks);
  result.paper = paper;
  let report = null;
  if (args.saveReport !== false) {
    report = saveReport(result, { prefix: `${needed.join('-')}-paper`, generatedAt: result.asOf });
  }
  return {
    ...result,
    paper,
    report: report
      ? {
          name: report.name,
          uri: report.uri,
          mdPath: report.mdPath,
          bytes: report.bytes,
          note: 'Paper run saved locally; no real order was sent.',
        }
      : { saved: false },
    executionMode: 'paper',
  };
}

async function handlePaperHistory(args = {}) {
  const state = loadState();
  return { ...paperHistory(state, args.limit || 50), statePath: paperStatePath() };
}

async function handlePaperReset(args = {}) {
  if (args.confirm !== 'RESET') throw new Error('paper_reset requires confirm="RESET"');
  const state = resetState(args.startingBalance || 10000);
  return { reset: true, account: accountSnapshot(state), statePath: paperStatePath() };
}

async function handleAutoTrade(args = {}) {
  const mode = String(args.mode || 'paper').toLowerCase();
  if (mode === 'paper') {
    const result = await handlePaperAuto(args);
    return { ...result, executionMode: 'paper' };
  }
  if (!['dry_run', 'live'].includes(mode)) throw new Error('mode must be paper, dry_run or live');

  const { result, needed } = await buildDesk(args);
  const status = liveStatus();
  const actions = [];
  let liveBalances = null;

  if (mode === 'live') {
    if (args.confirm !== 'LIVE') throw new Error('live mode requires confirm="LIVE"');
    if (!status.enabled) throw new Error('Live trading is disabled. Set OKX_TRADING_ENABLED=1 in the DSH profile.');
    if (!status.keysConfigured) throw new Error('OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE are not configured');
    liveBalances = await getUsdtBalance();
  }

  for (const symbol of ['BTC', 'ETH']) {
    const instId = `${symbol}-USDT`;
    const execution = result.decision?.[symbol]?.execution;
    const source = result.dataSources?.[symbol] || {};
    const mark = Number(source.price);
    if (!execution || execution.direction !== 'long') {
      actions.push({ action: 'skip', symbol, reason: `spot live/dry-run is long-only; current direction is ${execution?.direction || 'n/a'}` });
      continue;
    }
    if (source.stale) {
      actions.push({ action: 'reject', symbol, reason: 'stale/snapshot data; live execution refuses stale marks' });
      continue;
    }
    if (!Number.isFinite(mark)) {
      actions.push({ action: 'skip', symbol, reason: 'no mark price' });
      continue;
    }
    const [lo, hi] = execution.entryZone || [];
    if (!(mark <= hi && mark >= execution.stop)) {
      actions.push({ action: 'wait', symbol, reason: `price ${mark} is outside the long entry zone ${lo}-${hi}` });
      continue;
    }

    const remaining = Math.max(0, status.maxDailyUSDT - dailyUsage().notionalUSDT);
    let notional = Math.min(status.maxOrderUSDT, remaining);
    if (mode === 'live') {
      const available = Number(liveBalances?.usdt?.available || 0);
      notional = Math.min(notional, available * 0.95, available * (status.maxPositionPct / 100));
    } else {
      notional = Math.min(notional, Number(args.capitalUSDT || 10000) * (status.maxPositionPct / 100));
    }
    if (!(notional >= 10)) {
      actions.push({ action: 'reject', symbol, reason: `order notional ${notional.toFixed(2)} USDT is below 10` });
      continue;
    }
    const px = Number(Math.min(mark, hi).toFixed(2));
    const sz = Math.floor((notional / px) * 1e6) / 1e6;
    if (!(sz > 0)) {
      actions.push({ action: 'reject', symbol, reason: 'calculated size is zero' });
      continue;
    }

    if (mode === 'dry_run') {
      actions.push({
        action: 'dry-run-order',
        symbol,
        instId,
        side: 'buy',
        ordType: 'limit',
        px,
        sz,
        notionalUSDT: Number((px * sz).toFixed(2)),
        stop: execution.stop,
        target: execution.targets?.[0],
        note: 'No OKX order was sent.',
      });
      continue;
    }

    const ticker = await getTicker(instId);
    const deviation = Math.abs(px - ticker.last) / ticker.last;
    if (deviation > 0.01) {
      actions.push({ action: 'reject', symbol, reason: `limit price ${px} deviates ${(deviation * 100).toFixed(2)}% from last ${ticker.last}` });
      continue;
    }
    const clOrdId = `dsh${Date.now()}${symbol}`.slice(0, 32);
    const order = await placeSpotLimitBuy({ instId, px, sz, clOrdId });
    actions.push({ action: 'live-order', symbol, instId, side: 'buy', px, sz, order, note: 'Submitted spot limit buy. No automatic exit is attached.' });
  }

  result.execution = {
    mode,
    status,
    dailyUsage: dailyUsage(),
    balances: liveBalances,
    actions,
    autoExit: false,
    note: mode === 'live'
      ? 'Live spot entries only. Stops/targets in the report are monitoring levels, not attached exchange orders. Run a separate exit workflow.'
      : 'Dry run only. No OKX order was sent.',
  };
  let report = null;
  if (args.saveReport !== false) {
    report = saveReport(result, { prefix: `${needed.join('-')}-${mode}`, generatedAt: result.asOf });
  }
  return { ...result, report: report ? { name: report.name, uri: report.uri, mdPath: report.mdPath } : { saved: false } };
}

export const TOOLS = [
  {
    name: 'health',
    title: 'MCP and data-source health',
    description: 'Check the OKX/Stooq data plane, OKX circuit breaker, credential presence, and bundled snapshot age. Does not place orders.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => health(),
  },
  {
    name: 'market_snapshot',
    title: 'BTC/ETH market snapshot',
    description: 'Get the latest BTC-USDT and ETH-USDT quote, 24h/52w range, and technical summary from OKX public REST, with Stooq and snapshot fallbacks. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: { type: 'array', items: SYMBOL_SCHEMA, description: 'Defaults to BTC and ETH' },
      },
      additionalProperties: false,
    },
    handler: handleMarketSnapshot,
  },
  {
    name: 'candles',
    title: 'Daily OHLCV candles',
    description: 'Return daily OHLCV candles for BTC or ETH. OKX supplies 1D bars when reachable; the Stooq fallback is daily. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: SYMBOL_SCHEMA,
        bar: { type: 'string', enum: ['1D', '4H', '1H'], default: '1D' },
        limit: { type: 'integer', minimum: 20, maximum: 300, default: 120 },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
    handler: handleCandles,
  },
  {
    name: 'technical_analysis',
    title: 'Technical analysis',
    description: 'Compute trend, EMA20/50/200, RSI14, MACD, Bollinger, ATR, realized volatility, 20/60-day levels, and a bounded bias score for BTC or ETH.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: SYMBOL_SCHEMA,
        timeframe: { type: 'string', enum: ['1D'], default: '1D' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
    handler: handleTechnicalAnalysis,
  },
  {
    name: 'market_context',
    title: 'Sentiment and derivatives context',
    description: 'Return the captured crypto sentiment index, aggregate open interest, liquidation breakdown, ETF-flow direction, and live reference prices. Labelled as MyToken aggregate data, not OKX funding.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: handleMarketContext,
  },
  {
    name: 'okx_account',
    title: 'OKX account balance (read-only)',
    description: 'Read the OKX USDT account balance with private REST signing. Requires OKX_API_KEY, OKX_API_SECRET and OKX_API_PASSPHRASE. No order placement.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: handleOkxAccount,
  },
  {
    name: 'tradingagents_debate',
    title: 'TradingAgents debate and decision',
    description: 'Run the TradingAgents-style desk: market/sentiment/fundamentals analysts, bull vs bear researchers, research manager, trader, aggressive/conservative/neutral risk debate, and portfolio-manager ratings for BTC and ETH. Returns concrete levels and scenarios, not just prose.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: { type: 'array', items: SYMBOL_SCHEMA, description: 'Defaults to BTC and ETH' },
        timeframe: { type: 'string', enum: ['1D'], default: '1D' },
        riskProfile: { type: 'string', enum: ['conservative', 'balanced', 'aggressive'], default: 'balanced' },
        capitalUSDT: { type: 'number', minimum: 100, maximum: 10000000, default: 10000 },
        saveReport: { type: 'boolean', default: true, description: 'Save a Markdown + JSON report and expose it as an MCP resource' },
      },
      additionalProperties: false,
    },
    handler: handleDebate,
  },
  {
    name: 'paper_account',
    title: 'Paper account',
    description: 'Show the local paper-trading account: cash, equity, positions, unrealized PnL, exposure. No OKX order is sent.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: handlePaperAccount,
  },
  {
    name: 'paper_order',
    title: 'Open a paper position',
    description: 'Open a simulated BTC/ETH long or short at the current mark. No real order is sent. Requires confirm="PAPER".',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: SYMBOL_SCHEMA,
        side: { type: 'string', enum: ['long', 'short', 'buy', 'sell'] },
        notionalUSDT: { type: 'number', minimum: 10, maximum: 100000, default: 1000 },
        stop: { type: 'number', description: 'Protective stop price' },
        target: { type: 'number', description: 'Take-profit price' },
        price: { type: 'number', description: 'Optional mark override; defaults to the current data mark' },
        confirm: { type: 'string', enum: ['PAPER'] },
      },
      required: ['symbol', 'side', 'stop', 'target', 'confirm'],
      additionalProperties: false,
    },
    handler: handlePaperOrder,
  },
  {
    name: 'paper_close',
    title: 'Close a paper position',
    description: 'Close an open paper position at the current mark or a supplied price. No real order is sent. Requires confirm="CLOSE".',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: SYMBOL_SCHEMA,
        price: { type: 'number' },
        reason: { type: 'string' },
        confirm: { type: 'string', enum: ['CLOSE'] },
      },
      required: ['symbol', 'confirm'],
      additionalProperties: false,
    },
    handler: handlePaperClose,
  },
  {
    name: 'paper_auto',
    title: 'Run TradingAgents and paper-execute',
    description: 'Run the full TradingAgents debate, manage paper stops/targets, and open a simulated position only when the plan entry zone is touched. Saves a paper report. No real order is sent.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: { type: 'array', items: SYMBOL_SCHEMA },
        riskProfile: { type: 'string', enum: ['conservative', 'balanced', 'aggressive'], default: 'balanced' },
        capitalUSDT: { type: 'number', minimum: 100, maximum: 10000000, default: 10000 },
        saveReport: { type: 'boolean', default: true },
      },
      additionalProperties: false,
    },
    handler: handlePaperAuto,
  },
  {
    name: 'paper_history',
    title: 'Paper trade history',
    description: 'Show closed paper trades, win rate, total PnL and the recent order audit trail.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      additionalProperties: false,
    },
    handler: handlePaperHistory,
  },
  {
    name: 'paper_reset',
    title: 'Reset the paper account',
    description: 'Reset the local paper account to a clean starting balance. Does not touch OKX. Requires confirm="RESET".',
    inputSchema: {
      type: 'object',
      properties: {
        startingBalance: { type: 'number', minimum: 100, maximum: 10000000, default: 10000 },
        confirm: { type: 'string', enum: ['RESET'] },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    handler: handlePaperReset,
  },
  {
    name: 'auto_trade',
    title: 'Analyze and execute (paper / dry-run / live)',
    description: 'Run the full TradingAgents debate, then execute paper, dry-run, or guarded live spot entry. Live requires OKX_TRADING_ENABLED=1, trade-only API keys, confirm="LIVE", allowed BTC/ETH-USDT, non-stale data, and max order/daily limits. Long-only; no automatic exit is attached.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['paper', 'dry_run', 'live'], default: 'paper' },
        symbols: { type: 'array', items: SYMBOL_SCHEMA },
        riskProfile: { type: 'string', enum: ['conservative', 'balanced', 'aggressive'], default: 'balanced' },
        capitalUSDT: { type: 'number', minimum: 100, maximum: 10000000, default: 10000 },
        confirm: { type: 'string', enum: ['LIVE'], description: 'Required for mode=live' },
        saveReport: { type: 'boolean', default: true },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    handler: handleAutoTrade,
  },
  {
    name: 'live_status',
    title: 'Live trading gates and limits',
    description: 'Show whether live OKX trading is enabled, whether trade-only API keys are configured, the allowed instruments, max order/daily limits, and today’s usage. Does not place an order.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({ ...liveStatus(), dailyUsage: dailyUsage() }),
  },
  {
    name: 'live_account',
    title: 'OKX live USDT balance',
    description: 'Read the OKX USDT balance with private REST signing. Requires trade-only API keys. No order is placed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({ readOnly: true, balances: await getUsdtBalance() }),
  },
  {
    name: 'list_reports',
    title: 'List saved TradingAgents reports',
    description: 'List locally saved TradingAgents Markdown reports, newest first, with their okx:// resource URIs. Read one with read_report or read_mcp_resource.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
    handler: handleListReports,
  },
  {
    name: 'read_report',
    title: 'Read a saved TradingAgents report',
    description: 'Read a local Markdown or JSON TradingAgents report by file name (use list_reports to find names; latest.md always exists after the first run).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Report file name, e.g. BTC-ETH-TradingAgents-20261107-154500.md, or latest.md' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: handleReadReport,
  },
];

export async function callTool(name, args = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return errorResult(`Unknown tool: ${name}`);
  try {
    return textResult(await tool.handler(args || {}));
  } catch (e) {
    return errorResult(`${name} failed: ${e.message}`);
  }
}
