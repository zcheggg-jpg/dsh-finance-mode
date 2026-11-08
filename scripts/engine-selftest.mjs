#!/usr/bin/env node
// Offline engine self-test: no network required.
// 1) runs the backtester on the bundled 40-bar snapshot (plumbing check)
// 2) runs it on seeded synthetic series with hard invariants (correctness check)
//
//   node scripts/engine-selftest.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBacktest } from '../plugin/lib/quant/backtest.mjs';
import { DEFAULT_PARAMS, validateParams } from '../plugin/lib/quant/strategy-trend.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures += 1; console.log(`  FAIL  ${name} ${detail}`); }
};

function invariants(label, res, bars) {
  const { curve, trades, metrics } = res;
  check(`${label}: curve length == bars`, curve.length === bars.length, `(${curve.length} vs ${bars.length})`);
  check(`${label}: final equity == curve tail`, Math.abs(metrics.finalEquity - curve.at(-1).equity) <= 0.011 /* finalEquity is rounded to 2dp */);
  check(`${label}: equity always > 0`, curve.every((p) => p.equity > 0), `min=${Math.min(...curve.map((p) => p.equity)).toFixed(2)}`);
  check(`${label}: no lookahead (entryTs < exitTs)`, trades.every((t) => t.entryTs < t.exitTs));
  check(`${label}: all R finite`, trades.every((t) => Number.isFinite(t.rMultiple)));
  const stopTrades = trades.filter((t) => t.reason === 'stop');
  check(`${label}: stop exits are below entry`, stopTrades.every((t) => t.exit < t.entry), `n=${stopTrades.length}`);
  check(`${label}: maxDD in [0,100]`, metrics.maxDrawdownPct >= 0 && metrics.maxDrawdownPct <= 100, `${metrics.maxDrawdownPct}`);
  check(`${label}: trades non-overlapping`, trades.every((t, i) => i === 0 || t.entryTs >= trades[i - 1].exitTs));
  if (trades.length > 0) {
    const wins = trades.filter((t) => t.pnlUSDT > 0).length;
    check(`${label}: winRate consistent`, Math.abs(metrics.winRatePct - (wins / trades.length) * 100) < 0.051, `${metrics.winRatePct}`);
  }
}

// ---------- 1) bundled snapshot ----------
console.log('\n[1] bundled snapshot (plumbing only 鈥?40 bars, results meaningless)');
const snapPath = path.join(ROOT, 'plugin', 'data', 'snapshot.json');
if (fs.existsSync(snapPath)) {
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  for (const symbol of ['BTC', 'ETH']) {
    const raw = snap.symbols?.[symbol]?.candles || [];
    const bars = raw.map((c) => ({
      ts: Date.parse(`${c.time}T00:00:00Z`),
      open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close),
      volume: Number(c.volume || 0),
    })).sort((a, b) => a.ts - b.ts);
    if (bars.length < 30) { console.log(`  SKIP  ${symbol}: only ${bars.length} bars`); continue; }
    const res = runBacktest(bars, DEFAULT_PARAMS, { initialEquity: 1000 });
    console.log(`  ${symbol}: ${bars.length} bars, trades=${res.metrics.trades}, return=${res.metrics.totalReturnPct}%, maxDD=${res.metrics.maxDrawdownPct}%`);
    invariants(`snapshot-${symbol}`, res, bars);
  }
} else {
  console.log('  SKIP  snapshot.json not found');
}

// ---------- 2) synthetic seeded series ----------
console.log('\n[2] synthetic seeded series (deterministic, 800 bars)');
function lcg(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function makeSeries(seed, { bars = 800, drift = 0.0006, vol = 0.022, start = 100 } = {}) {
  const rnd = lcg(seed);
  const out = [];
  let px = start;
  let ts = Date.parse('2023-01-01T00:00:00Z');
  for (let i = 0; i < bars; i++) {
    const shock = (rnd() * 2 - 1) * vol;
    const open = px;
    px = Math.max(1, px * (1 + drift + shock));
    const close = px;
    const high = Math.max(open, close) * (1 + rnd() * vol * 0.5);
    const low = Math.min(open, close) * (1 - rnd() * vol * 0.5);
    out.push({ ts, open, high, low, close, volume: 1000 + rnd() * 500 });
    ts += 86400000;
  }
  return out;
}

for (const [label, opts] of [['uptrend', { drift: 0.0015 }], ['downtrend', { drift: -0.0012 }], ['chop', { drift: 0 }]]) {
  const bars = makeSeries(label === 'uptrend' ? 42 : label === 'downtrend' ? 77 : 99, opts);
  const res = runBacktest(bars, DEFAULT_PARAMS, { initialEquity: 1000 });
  console.log(`  ${label}: trades=${res.metrics.trades}, return=${res.metrics.totalReturnPct}%, maxDD=${res.metrics.maxDrawdownPct}%, stopExits=${res.metrics.stopExits}`);
  invariants(label, res, bars);
  if (label === 'uptrend') check('uptrend: strategy took at least 1 trade', res.metrics.trades >= 1);
  if (label === 'downtrend') check('downtrend: long-only must not blow up (> -60%)', res.metrics.totalReturnPct > -60, `${res.metrics.totalReturnPct}%`);
}

// ---------- 3) param gate ----------
console.log('\n[3] AI config gate (PARAM_BOUNDS)');
check('rejects riskPct > 1', validateParams({ riskPct: 5 }).ok === false);
check('rejects emaFast >= emaSlow', validateParams({ emaFast: 60, emaSlow: 50 }).ok === false);
check('accepts defaults', validateParams(DEFAULT_PARAMS).ok === true);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
