// Event-driven bar-by-bar backtester for long-only spot strategies.
// Honest by construction:
//   * signal at bar close, execution at NEXT bar open (no lookahead)
//   * intra-bar stop check against bar low, gap-down fills at open
//   * fees on both sides + slippage on both sides
//   * cash-constrained, no leverage, no shorting

import { evaluate, prepareIndicators, DEFAULT_PARAMS } from './strategy-trend.mjs';

export const BACKTEST_CONFIG = Object.freeze({
  feeBps: 10,          // 0.10% per side — OKX spot taker; maker is ~8bps
  slipBps: 5,          // 0.05% per side
  initialEquity: 1000, // USDT
});

export function runBacktest(bars, userParams = {}, userCfg = {}) {
  const params = { ...DEFAULT_PARAMS, ...userParams };
  const cfg = { ...BACKTEST_CONFIG, ...userCfg };
  const feeRate = cfg.feeBps / 10000;
  const slipRate = cfg.slipBps / 10000;

  const ind = prepareIndicators(bars, params);
  let cash = cfg.initialEquity;
  let pos = null;
  let pending = null;
  let barsInMarket = 0;

  const trades = [];
  const curve = [];

  const closePosition = (px, ts, reason) => {
    const proceeds = pos.qty * px;
    const fee = proceeds * feeRate;
    cash += proceeds - fee;
    const gross = (px - pos.entry) * pos.qty;
    const pnl = gross - pos.entryFee - fee;
    trades.push({
      entryTs: pos.entryTs,
      exitTs: ts,
      entry: Number(pos.entry.toFixed(2)),
      exit: Number(px.toFixed(2)),
      qty: Number(pos.qty.toFixed(8)),
      notionalEntry: Number((pos.qty * pos.entry).toFixed(2)),
      pnlUSDT: Number(pnl.toFixed(2)),
      pnlPctOnNotional: Number(((pnl / (pos.qty * pos.entry)) * 100).toFixed(2)),
      rMultiple: Number((pnl / (pos.riskPerUnit * pos.qty)).toFixed(3)),
      holdingBars: pos.barsHeld,
      reason,
    });
    pos = null;
  };

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // 1) execute pending order from previous close, at this bar's open
    if (pending && pending.type === 'entry' && !pos) {
      const px = bar.open * (1 + slipRate);
      const stop = px - params.atrMult * pending.atrAtSignal;
      const riskPerUnit = px - stop;
      if (riskPerUnit > 0) {
        const riskBudget = cash * (params.riskPct / 100);
        let qty = riskBudget / riskPerUnit;
        const maxNotional = cash * (params.maxNotionalPct / 100);
        qty = Math.min(qty, maxNotional / px);
        const notional = qty * px;
        const fee = notional * feeRate;
        if (qty > 0 && notional + fee <= cash) {
          cash -= notional + fee;
          pos = { qty, entry: px, stop, entryFee: fee, entryTs: bar.ts, riskPerUnit, barsHeld: 0 };
        }
      }
      pending = null;
    } else if (pending && pending.type === 'exit' && pos) {
      closePosition(bar.open * (1 - slipRate), bar.ts, 'signal');
      pending = null;
    }

    // 2) protective stop inside the bar (long → bar low)
    if (pos) {
      pos.barsHeld += 1;
      barsInMarket += 1;
      if (bar.low <= pos.stop) {
        const fillPx = Math.min(bar.open, pos.stop) * (1 - slipRate);
        closePosition(fillPx, bar.ts, 'stop');
      }
    }

    // 3) mark to market at close
    curve.push({ ts: bar.ts, equity: cash + (pos ? pos.qty * bar.close : 0), inPosition: Boolean(pos) });

    // 4) decisions at this close
    const sig = evaluate({ bars, ind, i, params });
    if (pos && sig.exit) pending = { type: 'exit' };
    else if (!pos && !pending && sig.entry) pending = { type: 'entry', atrAtSignal: sig.atr };
  }

  // Force-close at the final close, then reconcile the curve tail so that
  // realized cash (used by metrics) equals the last mark-to-market point.
  if (pos) {
    closePosition(bars.at(-1).close * (1 - slipRate), bars.at(-1).ts, 'end-of-data');
    curve[curve.length - 1] = { ...curve[curve.length - 1], equity: cash, inPosition: false };
  }

  return {
    params,
    cfg,
    bars: bars.length,
    trades,
    curve,
    metrics: computeMetrics({ bars, curve, trades, cfg, barsInMarket, params }),
  };
}

function stdev(xs) {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export function computeMetrics({ bars, curve, trades, cfg, barsInMarket, params }) {
  const end = curve.at(-1).equity;
  const days = (bars.at(-1).ts - bars[0].ts) / 86400000;
  const totalReturnPct = ((end / cfg.initialEquity) - 1) * 100;
  const cagr = days > 0 && end > 0 ? ((end / cfg.initialEquity) ** (365 / days) - 1) * 100 : null;

  let peak = -Infinity;
  let maxDD = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    maxDD = Math.max(maxDD, (peak - p.equity) / peak);
  }

  const dailyReturns = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].equity;
    if (prev > 0) dailyReturns.push(curve[i].equity / prev - 1);
  }
  const sd = stdev(dailyReturns);
  const meanDaily = dailyReturns.reduce((a, b) => a + b, 0) / (dailyReturns.length || 1);
  const sharpe = sd && sd > 0 ? (meanDaily / sd) * Math.sqrt(365) : null;

  const wins = trades.filter((t) => t.pnlUSDT > 0);
  const losses = trades.filter((t) => t.pnlUSDT <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnlUSDT, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlUSDT, 0));
  const avgR = trades.length ? trades.reduce((a, t) => a + t.rMultiple, 0) / trades.length : null;

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
  const yearly = Object.entries(byYear).map(([year, v]) => ({
    year: Number(year),
    returnPct: Number((((v.end / v.start) - 1) * 100).toFixed(2)),
    trades: v.trades,
  }));

  const buyHoldPct = (bars.at(-1).close / bars[0].close - 1) * 100;

  return {
    start: new Date(bars[0].ts).toISOString().slice(0, 10),
    end: new Date(bars.at(-1).ts).toISOString().slice(0, 10),
    days: Number(days.toFixed(0)),
    initialEquity: cfg.initialEquity,
    finalEquity: Number(end.toFixed(2)),
    totalReturnPct: Number(totalReturnPct.toFixed(2)),
    cagrPct: cagr == null ? null : Number(cagr.toFixed(2)),
    maxDrawdownPct: Number((maxDD * 100).toFixed(2)),
    sharpe: sharpe == null ? null : Number(sharpe.toFixed(2)),
    trades: trades.length,
    winRatePct: trades.length ? Number(((wins.length / trades.length) * 100).toFixed(1)) : null,
    avgR: avgR == null ? null : Number(avgR.toFixed(3)),
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : null,
    stopExits: trades.filter((t) => t.reason === 'stop').length,
    signalExits: trades.filter((t) => t.reason === 'signal').length,
    avgHoldingBars: trades.length ? Number((trades.reduce((a, t) => a + t.holdingBars, 0) / trades.length).toFixed(1)) : null,
    exposurePct: Number(((barsInMarket / bars.length) * 100).toFixed(1)),
    buyHoldPct: Number(buyHoldPct.toFixed(2)),
    params,
    cfg,
    yearly,
  };
}
