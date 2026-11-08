// Portfolio-level momentum-rotation + volatility-target strategy (long-only spot).
// Universe: BTC, ETH. Holds at most ONE symbol at a time (crypto beta is correlated).
//
// Logic (evaluated at daily close, executed at next open):
//   1) score_i = close_i / close_i[lookback] - 1        (momentum)
//   2) trend filter: close_i > EMA(trendLen)            (optional, default 50)
//   3) pick the strongest symbol whose score > minScore (default 0)
//   4) exposure = clamp(volTarget / realizedVol20, minLev, maxLev) * maxNotionalPct
//   5) stop = entry - atrMult * ATR
//   6) rotate out when the held symbol stops being the top pick, or trend breaks

import { ema, atr } from '../indicators.mjs';

export const MOMENTUM_DEFAULTS = Object.freeze({
  lookback: 60,
  trendLen: 50,
  minScore: 0,
  volTargetPct: 25,
  minLev: 0.25,
  maxLev: 1.0,
  maxNotionalPct: 50,
  atrLen: 14,
  atrMult: 3,
  riskPct: 1,
  sizingMode: 'risk',   // 'risk' = risk-budget sizing | 'voltarget' = vol-target notional sizing
});

export const MOMENTUM_BOUNDS = Object.freeze({
  lookback: [10, 180],
  trendLen: [20, 200],
  volTargetPct: [5, 60],
  maxNotionalPct: [5, 50],
  atrMult: [1, 6],
  riskPct: [0.1, 1],
});

export function validateMomentumParams(params = {}) {
  const merged = { ...MOMENTUM_DEFAULTS, ...params };
  const errors = [];
  for (const [k, [lo, hi]] of Object.entries(MOMENTUM_BOUNDS)) {
    const v = Number(merged[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) errors.push(`${k}=${merged[k]} outside [${lo}, ${hi}]`);
  }
  return { params: merged, errors, ok: errors.length === 0 };
}

export function prepareSeries(bars, params) {
  const closes = bars.map((b) => b.close);
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const vol20 = Array(closes.length).fill(null);
  const w = 20;
  for (let i = w; i < closes.length; i++) {
    const slice = rets.slice(i - w, i);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / (slice.length - 1);
    vol20[i] = Math.sqrt(variance) * Math.sqrt(365) * 100; // annualised %
  }
  return { emaTrend: ema(closes, params.trendLen), atr: atr(bars, params.atrLen), vol20, closes };
}

/** Score for symbol at index i. Returns null when not enough history. */
export function momentumScore(closes, i, lookback) {
  if (i - lookback < 0) return null;
  const past = closes[i - lookback];
  if (!(past > 0)) return null;
  return closes[i] / past - 1;
}
