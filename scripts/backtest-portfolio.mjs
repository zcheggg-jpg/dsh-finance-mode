#!/usr/bin/env node
// CLI: momentum-rotation portfolio backtest (BTC/ETH, long-only spot, one leg at a time).
//
//   node scripts/backtest-portfolio.mjs --bars 3000 --equity 1000
//   node scripts/backtest-portfolio.mjs --bars 3000 --grid
//   node scripts/backtest-portfolio.mjs --lookback 40 --voltarget 30 --notional 50

import fs from 'node:fs';
import path from 'node:path';
import { fetchHistory, CACHE_DIR } from '../plugin/lib/quant/history.mjs';
import { runPortfolioBacktest } from '../plugin/lib/quant/portfolio-backtest.mjs';
import { MOMENTUM_DEFAULTS } from '../plugin/lib/quant/strategy-momentum.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const nx = argv[i + 1];
    if (nx && !nx.startsWith('--')) { out[k] = nx; i += 1; } else out[k] = true;
  }
  return out;
}

const args = parseArgs(process.argv);
const totalBars = Number(args.bars || 3000);
const equity = Number(args.equity || 1000);
const feeBps = Number(args.fee ?? 10);
const slipBps = Number(args.slip ?? 5);
const doGrid = Boolean(args.grid);

const override = {};
for (const [flag, key] of [['lookback', 'lookback'], ['trendlen', 'trendLen'], ['voltarget', 'volTargetPct'], ['notional', 'maxNotionalPct'], ['risk', 'riskPct'], ['atrmult', 'atrMult']]) {
  if (args[flag] != null) override[key] = Number(args[flag]);
}
if (args.sizing) override.sizingMode = String(args.sizing);
const PARAMS = { ...MOMENTUM_DEFAULTS, ...override };
const cfg = { feeBps, slipBps, initialEquity: equity };
const num = (v, n = 2) => (v == null ? 'n/a' : Number(v).toFixed(n));

console.log(`参数: ${JSON.stringify(PARAMS)}`);
console.log(`费率: 手续费 ${feeBps}bps/边  滑点 ${slipBps}bps/边  初始 ${equity} USDT`);

const frames = {};
for (const symbol of ['BTC', 'ETH']) {
  process.stdout.write(`fetching ${symbol}-USDT... `);
  frames[symbol] = await fetchHistory(`${symbol}-USDT`, { bar: '1D', totalBars });
  console.log(`${frames[symbol].length} bars`);
}

function report(label, res) {
  const m = res.metrics;
  console.log(`\n=== ${label}  ${m.start} → ${m.end} (${m.days} 天) ===`);
  console.log(`  期末 ${m.finalEquity} USDT   总收益 ${num(m.totalReturnPct)}%   CAGR ${num(m.cagrPct)}%`);
  console.log(`  最大回撤 ${num(m.maxDrawdownPct)}%   Sharpe ${num(m.sharpe)}   在场 ${num(m.exposurePct, 1)}%`);
  console.log(`  交易 ${m.trades} 笔   胜率 ${num(m.winRatePct, 1)}%   PF ${num(m.profitFactor)}`);
  console.log(`  分标的: ` + Object.entries(m.perSymbol).map(([s, v]) => `${s} ${v.trades}笔 ${v.pnlUSDT>0?'+':''}${v.pnlUSDT}U (买入持有 ${v.buyHoldPct}%)`).join('  |  '));
  console.log(`  分年: ` + m.yearly.map((y) => `${y.year}:${num(y.returnPct)}%(${y.trades}笔)`).join('  '));
}

const base = runPortfolioBacktest(frames, PARAMS, cfg);
report('动量轮动 基线', base);

let gridSummary = null;
if (doGrid) {
  const rows = [];
  for (const lookback of [20, 40, 60, 90]) {
    for (const volTargetPct of [15, 25, 35]) {
      for (const trendLen of [50, 100]) {
        const p = { ...PARAMS, lookback, volTargetPct, trendLen };
        const r = runPortfolioBacktest(frames, p, cfg);
        rows.push({ lookback, volTargetPct, trendLen, ...r.metrics });
      }
    }
  }
  const rets = rows.map((r) => r.totalReturnPct).sort((a, b) => a - b);
  const cagrs = rows.map((r) => r.cagrPct).filter(Number.isFinite).sort((a, b) => a - b);
  const dds = rows.map((r) => r.maxDrawdownPct).sort((a, b) => a - b);
  const profitable = rows.filter((r) => r.totalReturnPct > 0).length;
  const med = (a) => a[Math.floor(a.length / 2)];
  gridSummary = {
    combos: rows.length,
    profitable,
    profitablePct: Number(((profitable / rows.length) * 100).toFixed(1)),
    medianReturnPct: Number(num(med(rets))),
    best: rows.reduce((a, b) => (b.totalReturnPct > a.totalReturnPct ? b : a)),
    worst: rows.reduce((a, b) => (b.totalReturnPct < a.totalReturnPct ? b : a)),
    medianCagrPct: Number(num(med(cagrs))),
    medianMaxDDPct: Number(num(med(dds))),
  };
  console.log(`\n参数稳健性 (${gridSummary.combos} 组): 盈利 ${gridSummary.profitable}/${gridSummary.combos} (${gridSummary.profitablePct}%)`);
  console.log(`  中位收益 ${gridSummary.medianReturnPct}%   中位CAGR ${gridSummary.medianCagrPct}%   中位回撤 ${gridSummary.medianMaxDDPct}%`);
  console.log(`  最好: ${gridSummary.best.totalReturnPct}% (lookback=${gridSummary.best.lookback}, volTarget=${gridSummary.best.volTargetPct}, trendLen=${gridSummary.best.trendLen})`);
  console.log(`  最差: ${gridSummary.worst.totalReturnPct}% (lookback=${gridSummary.worst.lookback}, volTarget=${gridSummary.worst.volTargetPct}, trendLen=${gridSummary.worst.trendLen})`);
}

fs.mkdirSync(CACHE_DIR, { recursive: true });
const outFile = path.join(CACHE_DIR, `portfolio-backtest-${Date.now()}.json`);
fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), params: PARAMS, cfg, baseline: base.metrics, grid: gridSummary }, null, 2), 'utf8');
console.log(`\nJSON: ${outFile}`);
console.log('数据: OKX history-candles 1D（已收盘）。研究用途，不构成投资建议。');
