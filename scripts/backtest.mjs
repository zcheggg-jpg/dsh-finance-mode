#!/usr/bin/env node
// CLI: fetch real OKX history → run the deterministic trend backtest → print honest metrics.
//
//   node scripts/backtest.mjs --symbols BTC,ETH --bars 1500 --equity 1000
//   node scripts/backtest.mjs --symbols BTC --grid
//   node scripts/backtest.mjs --symbols BTC --risk 1 --notional 50      (parameter override)
//
// Read-only. No OKX order is ever sent by this script.

import fs from 'node:fs';
import path from 'node:path';
import { fetchHistory, CACHE_DIR } from '../plugin/lib/quant/history.mjs';
import { runBacktest } from '../plugin/lib/quant/backtest.mjs';
import { DEFAULT_PARAMS } from '../plugin/lib/quant/strategy-trend.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i += 1; }
    else out[key] = true;
  }
  return out;
}

const args = parseArgs(process.argv);
const symbols = String(args.symbols || 'BTC,ETH').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const bar = String(args.bar || '1D');
const totalBars = Number(args.bars || 1500);
const equity = Number(args.equity || 1000);
const feeBps = Number(args.fee ?? 10);
const slipBps = Number(args.slip ?? 5);
const doGrid = Boolean(args.grid);

const cfg = { feeBps, slipBps, initialEquity: equity };

const override = {};
for (const [flag, key] of [['risk', 'riskPct'], ['notional', 'maxNotionalPct'], ['atrmult', 'atrMult'], ['emafast', 'emaFast'], ['emaslow', 'emaSlow']]) {
  if (args[flag] != null) override[key] = Number(args[flag]);
}
const PARAMS = { ...DEFAULT_PARAMS, ...override };
if (Object.keys(override).length) console.log('参数覆盖: ' + JSON.stringify(override));

const num = (v, n = 2) => (v == null ? 'n/a' : Number(v).toFixed(n));

function printReport(symbol, res) {
  const m = res.metrics;
  console.log(`\n=== ${symbol}-USDT  ${bar}  ${m.start} → ${m.end} (${m.days} 天, ${res.bars} 根) ===`);
  console.log(`  初始权益 ${m.initialEquity} → 期末 ${m.finalEquity} USDT   总收益 ${num(m.totalReturnPct)}%   CAGR ${num(m.cagrPct)}%`);
  console.log(`  最大回撤 ${num(m.maxDrawdownPct)}%   Sharpe ${num(m.sharpe)}   在场时间 ${num(m.exposurePct, 1)}%`);
  console.log(`  交易 ${m.trades} 笔   胜率 ${num(m.winRatePct, 1)}%   平均R ${num(m.avgR, 3)}   盈亏比(PF) ${num(m.profitFactor)}`);
  console.log(`  止损出场 ${m.stopExits}  趋势出场 ${m.signalExits}  平均持仓 ${num(m.avgHoldingBars, 1)} 根`);
  console.log(`  同期买入持有 ${num(m.buyHoldPct)}%   超额 ${num(m.totalReturnPct - m.buyHoldPct)}%`);
  console.log(`  费率假设: 手续费 ${feeBps}bps/边  滑点 ${slipBps}bps/边`);
  if (m.yearly?.length) {
    console.log('  分年: ' + m.yearly.map((y) => `${y.year}:${num(y.returnPct)}%(${y.trades}笔)`).join('  '));
  }
}

function summarizeGrid(rows) {
  const cagrs = rows.map((r) => r.metrics.cagrPct).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const rets = rows.map((r) => r.metrics.totalReturnPct).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const dds = rows.map((r) => r.metrics.maxDrawdownPct).filter((v) => Number.isFinite(v));
  const profitable = rows.filter((r) => r.metrics.totalReturnPct > 0).length;
  const med = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : null);
  return {
    combos: rows.length,
    profitableCombos: profitable,
    profitablePct: Number(((profitable / rows.length) * 100).toFixed(1)),
    medianReturnPct: Number(num(med(rets))),
    bestReturnPct: Number(num(rets.at(-1))),
    worstReturnPct: Number(num(rets[0])),
    medianCagrPct: Number(num(med(cagrs))),
    medianMaxDDPct: Number(num(med(dds))),
  };
}

const output = { generatedAt: new Date().toISOString(), bar, totalBars, cfg, params: PARAMS, symbols: {} };

for (const symbol of symbols) {
  const instId = `${symbol}-USDT`;
  process.stdout.write(`fetching ${instId} ${bar} history (target ${totalBars} bars)... `);
  const bars = await fetchHistory(instId, { bar, totalBars });
  console.log(`${bars.length} bars`);
  if (bars.length < 200) {
    console.log(`  !! only ${bars.length} bars, too few for a meaningful test — skipped`);
    continue;
  }

  const base = runBacktest(bars, PARAMS, cfg);
  printReport(symbol, base);
  const entry = { bars: bars.length, baseline: base.metrics };

  if (doGrid) {
    const rows = [];
    for (const emaFast of [10, 20, 30]) {
      for (const emaSlow of [50, 80, 120]) {
        for (const atrMult of [2, 3]) {
          const p = { ...PARAMS, emaFast, emaSlow, atrMult };
          const r = runBacktest(bars, p, cfg);
          rows.push({ params: p, metrics: r.metrics });
        }
      }
    }
    const grid = summarizeGrid(rows);
    console.log(`  参数稳健性 (${grid.combos} 组): 盈利组合 ${grid.profitableCombos}/${grid.combos} (${grid.profitablePct}%)`);
    console.log(`    中位收益 ${grid.medianReturnPct}%  最好 ${grid.bestReturnPct}%  最差 ${grid.worstReturnPct}%`);
    console.log(`    中位CAGR ${grid.medianCagrPct}%  中位最大回撤 ${grid.medianMaxDDPct}%`);
    console.log('    → 若盈利组合占比低或中位数接近 0，说明基线收益来自参数挑选（过拟合），不可上线');
    entry.grid = grid;
    entry.gridRows = rows.map((r) => ({ ...r.params, ...r.metrics }));
  }

  // capital realism: does this survive a 150 USDT account?
  const small = runBacktest(bars, PARAMS, { ...cfg, initialEquity: 150 });
  console.log(`  小额账户模拟 (150 USDT): 收益 ${num(small.metrics.totalReturnPct)}%  回撤 ${num(small.metrics.maxDrawdownPct)}%  交易 ${small.metrics.trades} 笔`);
  entry.smallAccount = small.metrics;

  output.symbols[symbol] = entry;
}

fs.mkdirSync(CACHE_DIR, { recursive: true });
const outFile = path.join(CACHE_DIR, `backtest-${symbols.join('-')}-${bar}-${Date.now()}.json`);
fs.writeFileSync(outFile, JSON.stringify(output, null, 2), 'utf8');
console.log(`\nJSON 结果已写入: ${outFile}`);
console.log('数据来源: OKX /api/v5/market/history-candles（已收盘K线）');
console.log('研究用途，不构成投资建议；回测正期望不代表实盘盈利。');
