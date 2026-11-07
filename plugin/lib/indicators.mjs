// Deterministic technical-analysis primitives. No external dependencies.

export function sma(values, period) {
  const out = Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]);
    sum += v;
    if (i >= period) sum -= Number(values[i - period]);
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  const seed = values.slice(0, period).reduce((a, b) => a + Number(b), 0) / period;
  out[period - 1] = seed;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    out[i] = Number(values[i]) * k + out[i - 1] * (1 - k);
  }
  return out;
}

export function rsi(values, period = 14) {
  const out = Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = Number(values[i]) - Number(values[i - 1]);
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = Number(values[i]) - Number(values[i - 1]);
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const line = values.map((_, i) =>
    fastEma[i] == null || slowEma[i] == null ? null : fastEma[i] - slowEma[i]
  );
  const first = line.findIndex((v) => v != null);
  const compact = first === -1 ? [] : line.slice(first);
  const signalCompact = ema(compact, signalPeriod);
  const signal = Array(values.length).fill(null);
  if (first !== -1) {
    for (let i = 0; i < signalCompact.length; i++) signal[first + i] = signalCompact[i];
  }
  const hist = line.map((v, i) => (v == null || signal[i] == null ? null : v - signal[i]));
  return { line, signal, hist };
}

export function stdev(values, period) {
  const out = Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const slice = values.slice(i - period + 1, i + 1).map(Number);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    out[i] = Math.sqrt(variance);
  }
  return out;
}

export function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const sd = stdev(values, period);
  const upper = mid.map((m, i) => (m == null || sd[i] == null ? null : m + mult * sd[i]));
  const lower = mid.map((m, i) => (m == null || sd[i] == null ? null : m - mult * sd[i]));
  return { mid, upper, lower, sd };
}

export function atr(candles, period = 14) {
  const out = Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
  let seed = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = seed;
  for (let i = period + 1; i < candles.length; i++) {
    seed = (seed * (period - 1) + tr[i]) / period;
    out[i] = seed;
  }
  return out;
}

export function pctChange(current, previous) {
  if (previous == null || previous === 0 || !Number.isFinite(previous) || !Number.isFinite(current)) return null;
  return ((current - previous) / previous) * 100;
}

export function round(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function lastDefined(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null && Number.isFinite(arr[i])) return arr[i];
  return null;
}

export function annualizedVol(closes, lookback = 20) {
  if (closes.length < lookback + 1) return null;
  const rets = [];
  for (let i = closes.length - lookback; i < closes.length; i++) {
    rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(365) * 100;
}

/**
 * Compute the full technical picture for one instrument.
 * candles: ascending [{time, open, high, low, close, volume?}]
 * quote: optional snapshot with change24hPct, high52w, low52w, quoteTime
 */
export function computeTechnicals(candles, quote = {}) {
  if (!Array.isArray(candles) || candles.length < 30) {
    throw new Error('Need at least 30 daily candles for technical analysis');
  }
  const closes = candles.map((c) => Number(c.close));
  const highs = candles.map((c) => Number(c.high));
  const lows = candles.map((c) => Number(c.low));
  const volumes = candles.map((c) => Number(c.volume || 0));
  const last = candles.at(-1);
  const price = Number(quote.price ?? last.close);

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const macdRes = macd(closes);
  const boll = bollinger(closes, 20, 2);
  const atr14 = atr(candles, 14);
  const vol20 = annualizedVol(closes, 20);
  const vol60 = annualizedVol(closes, 60);

  const ema20v = lastDefined(ema20);
  const ema50v = lastDefined(ema50);
  const ema200v = lastDefined(ema200);
  const rsiV = lastDefined(rsi14);
  const macdLine = lastDefined(macdRes.line);
  const macdSignal = lastDefined(macdRes.signal);
  const macdHist = lastDefined(macdRes.hist);
  const atrV = lastDefined(atr14);
  const bollUpper = lastDefined(boll.upper);
  const bollMid = lastDefined(boll.mid);
  const bollLower = lastDefined(boll.lower);

  const window20 = candles.slice(-20);
  const window60 = candles.slice(-60);
  const high20 = Math.max(...window20.map((c) => c.high));
  const low20 = Math.min(...window20.map((c) => c.low));
  const high60 = Math.max(...window60.map((c) => c.high));
  const low60 = Math.min(...window60.map((c) => c.low));
  const high252 = Math.max(...candles.slice(-252).map((c) => c.high));
  const low252 = Math.min(...candles.slice(-252).map((c) => c.low));

  const return1d = pctChange(price, closes.at(-2));
  const return5d = pctChange(price, closes.at(-6));
  const return20d = pctChange(price, closes.at(-21));
  const return60d = pctChange(price, closes.at(-61));

  const bbPosition = bollUpper != null && bollLower != null && bollUpper !== bollLower
    ? (price - bollLower) / (bollUpper - bollLower)
    : null;

  const volume20 = volumes.length >= 20
    ? volumes.slice(-20).reduce((a, b) => a + b, 0) / 20
    : null;
  const volumeRatio = volume20 > 0 ? volumes.at(-1) / volume20 : null;

  // Weighted, bounded trend/momentum score. Positive = bullish.
  const signals = [];
  const add = (name, value, weight, detail) => signals.push({ name, value, weight, detail });
  if (ema20v != null) add('price_vs_ema20', price >= ema20v ? 1 : -1, 1.4, `${round(price)} vs ${round(ema20v)}`);
  if (ema50v != null) add('price_vs_ema50', price >= ema50v ? 1 : -1, 1.2, `${round(price)} vs ${round(ema50v)}`);
  if (ema200v != null) add('price_vs_ema200', price >= ema200v ? 1 : -1, 1.5, `${round(price)} vs ${round(ema200v)}`);
  if (ema20v != null && ema50v != null) add('ema20_vs_ema50', ema20v >= ema50v ? 1 : -1, 0.9, `${round(ema20v)} vs ${round(ema50v)}`);
  if (ema50v != null && ema200v != null) add('ema50_vs_ema200', ema50v >= ema200v ? 1 : -1, 1.1, `${round(ema50v)} vs ${round(ema200v)}`);
  if (macdHist != null) add('macd_histogram', macdHist >= 0 ? 1 : -1, 1.0, `${round(macdHist, 3)}`);
  if (return20d != null) add('return_20d', return20d >= 0 ? 1 : -1, 0.9, `${round(return20d, 2)}%`);
  if (return5d != null) add('return_5d', return5d >= 0 ? 1 : -1, 0.5, `${round(return5d, 2)}%`);
  if (rsiV != null) {
    let v = 0;
    if (rsiV >= 70) v = -0.6;
    else if (rsiV >= 55) v = 0.8;
    else if (rsiV >= 45) v = 0.15;
    else if (rsiV >= 35) v = -0.5;
    else v = -0.2; // deeply oversold: bearish trend, but mean-reversion risk
    add('rsi14', v, 0.7, `${round(rsiV, 1)}`);
  }
  if (bbPosition != null) add('bollinger_position', bbPosition >= 0.5 ? 0.5 : -0.5, 0.4, `${round(bbPosition * 100, 0)}%`);
  const rawScore = signals.reduce((a, s) => a + s.value * s.weight, 0);
  const maxScore = signals.reduce((a, s) => a + Math.abs(s.weight), 0) || 1;
  const score = Math.max(-100, Math.min(100, (rawScore / maxScore) * 100));

  let bias;
  if (score >= 45) bias = 'Bullish';
  else if (score >= 12) bias = 'Mildly bullish';
  else if (score > -12) bias = 'Neutral';
  else if (score > -45) bias = 'Mildly bearish';
  else bias = 'Bearish';

  let regime = 'range';
  if (ema20v != null && ema50v != null && ema200v != null) {
    if (price > ema20v && ema20v > ema50v && ema50v > ema200v) regime = 'uptrend';
    else if (price < ema20v && ema20v < ema50v && ema50v < ema200v) regime = 'downtrend';
    else if (price < ema200v && ema20v > ema50v) regime = 'bear-market rally';
    else if (price > ema200v && ema20v < ema50v) regime = 'bull-market pullback';
  }

  const atrPct = atrV != null ? (atrV / price) * 100 : null;
  const riskDistance = atrV != null ? atrV * 1.5 : price * 0.05;
  const stopLong = Math.max(price - riskDistance, low20 * 0.995);
  const stopShort = Math.min(price + riskDistance, high20 * 1.005);

  const change24hPct = quote.change24hPct ?? return1d;
  const high52w = quote.high52w ?? high252;
  const low52w = quote.low52w ?? low252;
  const drawdownFromHigh = pctChange(price, high52w);

  return {
    price: round(price),
    asOf: quote.quoteTime ?? last.time,
    change24hPct: round(change24hPct, 2),
    open24h: round(quote.open24h ?? last.open),
    high24h: round(quote.high24h ?? last.high),
    low24h: round(quote.low24h ?? last.low),
    prevClose: round(quote.prevClose ?? closes.at(-2)),
    high52w: round(high52w),
    low52w: round(low52w),
    drawdownFromHighPct: round(drawdownFromHigh, 2),
    returns: {
      d1: round(return1d, 2),
      d5: round(return5d, 2),
      d20: round(return20d, 2),
      d60: round(return60d, 2),
    },
    ema: { ema20: round(ema20v), ema50: round(ema50v), ema200: round(ema200v) },
    rsi14: round(rsiV, 1),
    macd: {
      line: round(macdLine, 2),
      signal: round(macdSignal, 2),
      histogram: round(macdHist, 2),
    },
    bollinger: {
      upper: round(bollUpper),
      mid: round(bollMid),
      lower: round(bollLower),
      positionPct: bbPosition == null ? null : round(bbPosition * 100, 0),
    },
    atr14: round(atrV),
    atrPct: round(atrPct, 2),
    realizedVol20Pct: round(vol20, 1),
    realizedVol60Pct: round(vol60, 1),
    volumeRatio20: round(volumeRatio, 2),
    levels: {
      high20: round(high20),
      low20: round(low20),
      high60: round(high60),
      low60: round(low60),
      high252: round(high252),
      low252: round(low252),
      pivot: round((last.high + last.low + last.close) / 3),
      r1: round(2 * ((last.high + last.low + last.close) / 3) - last.low),
      s1: round(2 * ((last.high + last.low + last.close) / 3) - last.high),
      stopLong: round(stopLong),
      stopShort: round(stopShort),
    },
    score: round(score, 1),
    bias,
    regime,
    signals,
    candles: candles.length,
  };
}
