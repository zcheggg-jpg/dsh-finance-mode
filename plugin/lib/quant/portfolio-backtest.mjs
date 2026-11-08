// Portfolio backtester: one shared USDT cash account, long-only spot, max one open leg.
// Universe = { BTC: bars[], ETH: bars[] }. Bars must be aligned by timestamp (outer join).

import { MOMENTUM_DEFAULTS, prepareSeries, momentumScore } from './strategy-momentum.mjs';

export const PORTFOLIO_CFG = Object.freeze({
  feeBps: 10,
  slipBps: 5,
  initialEquity: 1000,
  // real OKX spot specs (public/instruments, 2026-11-08)
  lotSize: { BTC: 0.00000001, ETH: 0.000001 },
  minSize: { BTC: 0.00001, ETH: 0.0001 },
  minNotionalUSDT: 0,
});

function align(frames) {
  const tsSet = new Set();
  for (const bars of Object.values(frames)) for (const b of bars) tsSet.add(b.ts);
  const ts = [...tsSet].sort((a, b) => a - b);
  const byKey = {};
  for (const [sym, bars] of Object.entries(frames)) {
    byKey[sym] = new Map(bars.map((b) => [b.ts, b]));
  }
  return { ts, byKey };
}

export function runPortfolioBacktest(frames, userParams = {}, userCfg = {}) {
  const params = { ...MOMENTUM_DEFAULTS, ...userParams };
  const cfg = { ...PORTFOLIO_CFG, ...userCfg };
  const feeRate = cfg.feeBps / 10000;
  const slipRate = cfg.slipBps / 10000;
  const symbols = Object.keys(frames);

  const { ts, byKey } = align(frames);
  const series = {};
  for (const sym of symbols) series[sym] = prepareSeries(frames[sym], params);
  // index by timestamp for each symbol's own arrays
  const idxOf = {};
  for (const sym of symbols) {
    idxOf[sym] = new Map(frames[sym].map((b, i) => [b.ts, i]));
  }

  let cash = cfg.initialEquity;
  let pos = null;            // { symbol, qty, entry, stop, entryFee, entryTs }
  let pending = null;        // { type:'open', symbol, atrAtSignal } | { type:'close' }
  const trades = [];
  const curve = [];
  let barsInMarket = 0;
  let skipped = 0;
  let daysInMarket = 0;

  const closePos = (px, t, reason) => {
    const proceeds = pos.qty * px;
    const fee = proceeds * feeRate;
    cash += proceeds - fee;
    const gross = (px - pos.entry) * pos.qty;
    const pnl = gross - pos.entryFee - fee;
    trades.push({
      symbol: pos.symbol,
      entryTs: pos.entryTs,
      exitTs: t,
      entry: Number(pos.entry.toFixed(2)),
      exit: Number(px.toFixed(2)),
      notional: Number((pos.qty * pos.entry).toFixed(2)),
      pnlUSDT: Number(pnl.toFixed(2)),
      pnlPct: Number(((pnl / (pos.qty * pos.entry)) * 100).toFixed(2)),
      reason,
    });
    pos = null;
  };

  for (const t of ts) {
    // 1) execute pending at this timestamp's open
    if (pending) {
      if (pending.type === 'close' && pos) {
        const bar = byKey[pos.symbol].get(t);
        if (bar) closePos(bar.open * (1 - slipRate), t, pending.reason || 'signal');
        pending = null;
      } else if (pending.type === 'open' && !pos) {
        const bar = byKey[pending.symbol].get(t);
        if (bar) {
          const px = bar.open * (1 + slipRate);
          const stop = px - params.atrMult * pending.atrAtSignal;
          const riskPerUnit = px - stop;
          if (riskPerUnit > 0) {
            const maxNotional = cash * (params.maxNotionalPct / 100) * pending.lev;
            const riskQty = (cash * (params.riskPct / 100)) / riskPerUnit;
            let qty = params.sizingMode === 'voltarget' ? maxNotional / px : Math.min(riskQty, maxNotional / px);
            const lot = cfg.lotSize?.[pending.symbol];
            if (lot) qty = Math.floor(qty / lot) * lot;
            const minSz = cfg.minSize?.[pending.symbol] || 0;
            const tooSmall = qty < minSz || qty * px < (cfg.minNotionalUSDT || 0);
            if (tooSmall) {
              skipped += 1;
            } else {
              const notional = qty * px;
              const fee = notional * feeRate;
              if (qty > 0 && notional + fee <= cash) {
                cash -= notional + fee;
                pos = { symbol: pending.symbol, qty, entry: px, stop, entryFee: fee, entryTs: t };
              }
            }
          }
        }
        pending = null;
      }
    }

    // 2) stop check on every symbol that has a bar at t (only for the held symbol)
    if (pos) {
      daysInMarket += 1;
      const bar = byKey[pos.symbol].get(t);
      if (bar) {
        if (bar.low <= pos.stop) closePos(Math.min(bar.open, pos.stop) * (1 - slipRate), t, 'stop');
      }
    }

    // 3) mark to market at close
    let mtm = cash;
    if (pos) {
      const bar = byKey[pos.symbol].get(t);
      if (bar) mtm += pos.qty * bar.close;
      else mtm += pos.qty * pos.entry;
      barsInMarket += 1;
    }
    curve.push({ ts: t, equity: mtm, symbol: pos?.symbol || null });

    // 4) ranking at this close → decisions for next open
    const ranked = [];
    for (const sym of symbols) {
      const i = idxOf[sym].get(t);
      if (i == null) continue;
      const s = series[sym];
      const score = momentumScore(s.closes, i, params.lookback);
      const trendOk = s.emaTrend[i] != null && s.closes[i] > s.emaTrend[i];
      const vol = s.vol20[i];
      const a = s.atr[i];
      if (score == null || vol == null || a == null || vol <= 0) continue;
      const lev = Math.max(params.minLev, Math.min(params.maxLev, params.volTargetPct / vol));
      ranked.push({ symbol: sym, score, trendOk, lev, atr: a });
    }
    ranked.sort((x, y) => y.score - x.score);
    const best = ranked[0];
    const tradable = best && best.score > params.minScore && best.trendOk;

    if (pos) {
      const heldRank = ranked.find((r) => r.symbol === pos.symbol);
      const stillBest = tradable && best.symbol === pos.symbol;
      const trendBroke = heldRank && !heldRank.trendOk;
      if (!pending && (!stillBest || trendBroke)) {
        pending = { type: 'close', reason: trendBroke ? 'trend-break' : 'rotate' };
      }
    } else if (!pending && tradable) {
      pending = { type: 'open', symbol: best.symbol, atrAtSignal: best.atr, lev: best.lev };
    }
  }

  if (pos) {
    const last = byKey[pos.symbol].get(ts.at(-1));
    const px = (last ? last.close : pos.entry) * (1 - slipRate);
    closePos(px, ts.at(-1), 'end-of-data');
    curve[curve.length - 1] = { ...curve[curve.length - 1], equity: cash, symbol: null };
  }

  return { params, cfg, trades, curve, metrics: { ...portfolioMetrics({ ts, curve, trades, cfg, barsInMarket, daysInMarket, params, frames }), skippedSignals: skipped } };
}

function stdev(xs) {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
}

export function portfolioMetrics({ ts, curve, trades, cfg, barsInMarket, daysInMarket, params, frames }) {
  const end = curve.at(-1).equity;
  const days = (ts.at(-1) - ts[0]) / 86400000;
  const totalReturnPct = (end / cfg.initialEquity - 1) * 100;
  const cagr = days > 0 && end > 0 ? ((end / cfg.initialEquity) ** (365 / days) - 1) * 100 : null;

  let peak = -Infinity;
  let maxDD = 0;
  for (const p of curve) { peak = Math.max(peak, p.equity); maxDD = Math.max(maxDD, (peak - p.equity) / peak); }

  const dr = [];
  for (let i = 1; i < curve.length; i++) if (curve[i - 1].equity > 0) dr.push(curve[i].equity / curve[i - 1].equity - 1);
  const sd = stdev(dr);
  const mean = dr.reduce((a, b) => a + b, 0) / (dr.length || 1);
  const sharpe = sd && sd > 0 ? (mean / sd) * Math.sqrt(365) : null;

  const wins = trades.filter((t) => t.pnlUSDT > 0);
  const losses = trades.filter((t) => t.pnlUSDT <= 0);
  const gw = wins.reduce((a, t) => a + t.pnlUSDT, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnlUSDT, 0));

  const byYear = {};
  for (let i = 0; i < curve.length; i++) {
    const y = new Date(curve[i].ts).getUTCFullYear();
    if (!byYear[y]) byYear[y] = { start: i === 0 ? cfg.initialEquity : curve[i - 1].equity, end: curve[i].equity, trades: 0 };
    byYear[y].end = curve[i].equity;
  }
  for (const t of trades) {
    const y = new Date(t.exitTs).getUTCFullYear();
    if (byYear[y]) byYear[y].trades += 1;
  }

  const perSymbol = {};
  for (const [sym, bars] of Object.entries(frames)) {
    const bh = (bars.at(-1).close / bars[0].close - 1) * 100;
    const tr = trades.filter((t) => t.symbol === sym);
    perSymbol[sym] = {
      trades: tr.length,
      pnlUSDT: Number(tr.reduce((a, t) => a + t.pnlUSDT, 0).toFixed(2)),
      buyHoldPct: Number(bh.toFixed(2)),
    };
  }

  return {
    start: new Date(ts[0]).toISOString().slice(0, 10),
    end: new Date(ts.at(-1)).toISOString().slice(0, 10),
    days: Number(days.toFixed(0)),
    initialEquity: cfg.initialEquity,
    finalEquity: Number(end.toFixed(2)),
    totalReturnPct: Number(totalReturnPct.toFixed(2)),
    cagrPct: cagr == null ? null : Number(cagr.toFixed(2)),
    maxDrawdownPct: Number((maxDD * 100).toFixed(2)),
    sharpe: sharpe == null ? null : Number(sharpe.toFixed(2)),
    trades: trades.length,
    winRatePct: trades.length ? Number(((wins.length / trades.length) * 100).toFixed(1)) : null,
    profitFactor: gl > 0 ? Number((gw / gl).toFixed(2)) : null,
    exposurePct: Number(((daysInMarket / curve.length) * 100).toFixed(1)),
    perSymbol,
    yearly: Object.entries(byYear).map(([y, v]) => ({ year: Number(y), returnPct: Number(((v.end / v.start - 1) * 100).toFixed(2)), trades: v.trades })),
    params,
    cfg,
  };
}
