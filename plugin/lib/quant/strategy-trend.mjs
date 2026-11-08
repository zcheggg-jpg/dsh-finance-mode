// Deterministic long-only trend-following strategy (spot, leverage = 1).
// Pure function: given bars + precomputed indicators + index, return intent.
// No LLM, no randomness → fully replayable and backtestable.

import { ema, atr } from '../indicators.mjs';

export const DEFAULT_PARAMS = Object.freeze({
  emaFast: 20,
  emaSlow: 50,
  atrLen: 14,
  atrMult: 2.5,
  riskPct: 0.5,          // % of equity risked per trade (entry → stop)
  maxNotionalPct: 25,    // % of equity max position notional
});

// Hard bounds the AI may never exceed (P1 config gate).
export const PARAM_BOUNDS = Object.freeze({
  emaFast: [5, 60],
  emaSlow: [30, 200],
  atrLen: [7, 30],
  atrMult: [1.0, 5.0],
  riskPct: [0.1, 1.0],
  maxNotionalPct: [5, 25],
});

export function validateParams(params = {}) {
  const merged = { ...DEFAULT_PARAMS, ...params };
  const errors = [];
  for (const [key, [lo, hi]] of Object.entries(PARAM_BOUNDS)) {
    const v = Number(merged[key]);
    if (!Number.isFinite(v) || v < lo || v > hi) errors.push(`${key}=${merged[key]} outside [${lo}, ${hi}]`);
  }
  if (merged.emaFast >= merged.emaSlow) errors.push('emaFast must be < emaSlow');
  return { params: merged, errors, ok: errors.length === 0 };
}

export function prepareIndicators(bars, params = DEFAULT_PARAMS) {
  const closes = bars.map((b) => b.close);
  return {
    emaFast: ema(closes, params.emaFast),
    emaSlow: ema(closes, params.emaSlow),
    atr: atr(bars, params.atrLen),
  };
}

/**
 * Decide using only information available at the CLOSE of bar i.
 * Execution must happen at bar i+1 open (no lookahead).
 *
 * Entry : emaFast > emaSlow AND close > emaSlow   (trend up, price above trend)
 * Stop  : close - atrMult * ATR
 * Exit  : close < emaSlow                         (trend break)
 */
export function evaluate({ bars, ind, i, params = DEFAULT_PARAMS }) {
  const close = bars[i].close;
  const f = ind.emaFast[i];
  const s = ind.emaSlow[i];
  const a = ind.atr[i];
  if (f == null || s == null || a == null || !(a > 0)) return { entry: false, exit: false };

  const entry = f > s && close > s;
  const stop = close - params.atrMult * a;
  const exit = close < s;
  return { entry, exit, stop: Number(stop.toFixed(8)), emaFast: f, emaSlow: s, atr: a };
}
