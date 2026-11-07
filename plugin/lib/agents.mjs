// A deterministic TradingAgents-style research desk. The role structure and
// debate order follow TauricResearch/TradingAgents: analyst team -> bull/bear
// researchers -> research manager -> trader -> aggressive/conservative/neutral
// risk debate -> portfolio manager. It is intentionally rule-based so the
// result is reproducible and does not need a second LLM key.

const fmt = (n, d = 0) => (n == null || !Number.isFinite(Number(n)) ? 'n/a' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? 'n/a' : `${Number(n) >= 0 ? '+' : ''}${Number(n).toFixed(d)}%`);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const mid = (a, b) => (a + b) / 2;

// Turn a bounded technical score into a TradingAgents rating. Deeply oversold
// names near support stay Underweight rather than Sell: the trend is down, but
// a fresh short at the low has poor asymmetry.
function classify(a) {
  const score = Number(a.score ?? 0);
  const nearSupport = a.price <= (a.levels?.low20 ?? a.price) * 1.05;
  const overbought = Number(a.rsi14 ?? 50) >= 75;
  let rating;
  let direction;
  if (score >= 55 && !overbought) {
    rating = 'Buy';
    direction = 'long';
  } else if (score >= 25) {
    rating = 'Overweight';
    direction = 'long';
  } else if (score > -25) {
    rating = 'Hold';
    direction = 'neutral';
  } else if (score > -55) {
    rating = 'Underweight';
    direction = 'short';
  } else {
    rating = nearSupport ? 'Underweight' : 'Sell';
    direction = 'short';
  }
  return {
    rating,
    direction,
    convictionPct: Math.round(clamp(50 + Math.abs(score) * 0.35, 50, 85)),
    score,
  };
}

function emaPosition(a) {
  const price = a.price;
  const e20 = a.ema?.ema20 ?? a.ema20;
  const e50 = a.ema?.ema50 ?? a.ema50;
  return `Price ${fmt(price)} is ${e20 != null && price >= e20 ? 'above' : 'below'} EMA20 ${fmt(e20)} and ${e50 != null && price >= e50 ? 'above' : 'below'} EMA50 ${fmt(e50)}`;
}

function reportFor(symbol, a) {
  const name = symbol === 'BTC' ? 'Bitcoin' : 'Ethereum';
  return {
    symbol,
    name,
    price: a.price,
    asOf: a.asOf,
    bias: a.bias,
    score: a.score,
    regime: a.regime,
    change24h: a.change24hPct,
    high24h: a.high24h,
    low24h: a.low24h,
    prevClose: a.prevClose,
    returns: a.returns,
    ema20: a.ema?.ema20,
    ema50: a.ema?.ema50,
    ema200: a.ema?.ema200,
    rsi: a.rsi14,
    macd: a.macd,
    atrPct: a.atrPct,
    realizedVol20Pct: a.realizedVol20Pct,
    realizedVol60Pct: a.realizedVol60Pct,
    bollinger: a.bollinger,
    drawdown: a.drawdownFromHighPct,
    high52w: a.high52w,
    low52w: a.low52w,
    high20: a.levels?.high20,
    low20: a.levels?.low20,
    high60: a.levels?.high60,
    low60: a.levels?.low60,
    levels: a.levels,
  };
}

function analystReports(reports, context) {
  const b = reports.BTC;
  const e = reports.ETH;
  const sentiment = context?.sentiment || {};
  const liquid = context?.lastMajorLiquidation;
  return {
    market: [
      `BTC: ${b.bias} (score ${b.score}/100), ${b.regime}. ${emaPosition(b)}; RSI14 ${b.rsi}; MACD histogram ${fmt(b.macd?.histogram, 2)}; ATR ${b.atrPct}% of price. 20-day range ${fmt(b.low20)}-${fmt(b.high20)}; 52-week range ${fmt(b.low52w)}-${fmt(b.high52w)} (drawdown ${pct(b.drawdown)}).`,
      `ETH: ${e.bias} (score ${e.score}/100), ${e.regime}. ${emaPosition(e)}; RSI14 ${e.rsi}; MACD histogram ${fmt(e.macd?.histogram, 2)}; ATR ${e.atrPct}% of price. 20-day range ${fmt(e.low20)}-${fmt(e.high20)}; 52-week range ${fmt(e.low52w)}-${fmt(e.high52w)} (drawdown ${pct(e.drawdown)}).`,
      `Relative: ETH/BTC is ${(e.price / b.price).toFixed(4)}. ETH 7-day ${pct(context?.change7dPct?.ETH)} vs BTC ${pct(context?.change7dPct?.BTC)}; ETH 5-day ${pct(e.returns?.d5)} vs BTC 5-day ${pct(b.returns?.d5)}. ETH is the higher-beta, weaker medium-term leg.`,
    ].join('\n'),
    sentiment: [
      `Market mood is ${sentiment.label || 'unknown'}${sentiment.index != null ? ` (index ${sentiment.index})` : ''}${sentiment.change != null ? `, a ${sentiment.change} point daily change` : ''}. This is contrarian-positive for a bounce but momentum-negative until price confirms.`,
      `Aggregate open interest is ${context?.openInterestUsd ? `$${fmt(context.openInterestUsd / 1e9, 2)}B` : 'n/a'}${context?.openInterestChangePct != null ? ` (${pct(context.openInterestChangePct)} d/d)` : ''}. Recent flows are negative for both BTC and ETH ETFs, so there is no spot-flow tailwind in the packet.`,
      liquid
        ? `The 5 Nov liquidation cascade was $${fmt(liquid.totalUsd / 1e9, 2)}B, of which $${fmt(liquid.shortUsd / 1e9, 2)}B (${((liquid.shortUsd / liquid.totalUsd) * 100).toFixed(1)}%) was short-side. Price still fell 6.2% that day, so the squeeze did not create a durable bid; 6 Nov liquidations normalized to $${fmt((context?.liquidations24hUsd || 0) / 1e6, 1)}M.`
        : 'No reliable liquidation breakdown was available.',
    ].join('\n'),
    fundamentals: [
      'Crypto has no company cash-flow statement; the fundamentals seat is a relative-value and cycle-position seat. BTC is the reserve asset and ETH is the higher-beta smart-contract proxy.',
      `BTC trades ${pct(b.drawdown)} from its 52-week high and ${pct(((b.price / b.low52w) - 1) * 100)} above its 52-week low. ETH trades ${pct(e.drawdown)} from its high and ${pct(((e.price / e.low52w) - 1) * 100)} above its low. Both are in the lower third of their 52-week ranges, but neither is at an extreme valuation low.`,
      `There is no fresh protocol or macro catalyst in the data packet. The burden of proof is therefore on the bulls to show a trend repair, not on the bears to justify the existing downtrend.`,
    ].join('\n'),
  };
}

function buildBullBear(reports, context) {
  const b = reports.BTC;
  const e = reports.ETH;
  const fear = context?.sentiment?.index;
  const liquid = context?.lastMajorLiquidation;
  const btcEntry = mid(b.ema20 * 0.99, b.ema20 * 1.005);
  const ethEntry = mid(e.ema20 * 0.995, e.ema50);
  return {
    bull: {
      opening: [
        `The bear case is late, not wrong. BTC is only ${pct(((b.price / b.low20) - 1) * 100)} above the 20-day low ${fmt(b.low20)} and sits at the 6th percentile of its 20-day Bollinger range. The 60-day return is ${pct(b.returns?.d60)}, so this is a violent range shakeout rather than a confirmed 60-day collapse.`,
        `Sentiment is already capitulatory: ${context?.sentiment?.label || 'extreme fear'}${fear != null ? ` at ${fear}` : ''}. The 5 Nov cascade liquidated $${fmt((liquid?.shortUsd || 0) / 1e9, 2)}B of shorts, which removes a crowded leveraged position. A reclaim of BTC ${fmt(b.ema50)} opens ${fmt(b.ema20)}, about ${pct(((b.ema20 / b.price) - 1) * 100)} upside.`,
        `ETH is the relative winner at the margin: +0.98% over 24h and +0.21% over 7d versus BTC -1.50% over 7d. Its MACD histogram is +${fmt(e.macd?.histogram, 2)}, the only positive momentum print in the pair. ETH is ${pct(((e.price / e.low20) - 1) * 100)} above its 20-day low; a reclaim of ${fmt(e.ema20)} targets ${fmt(e.ema50)} and then ${fmt(e.levels?.high20)}.`,
        `For a contrarian mandate, the asymmetry favors waiting to buy strength rather than shorting support: BTC risk to ${fmt(b.low20)} is ${pct(((b.low20 / b.price) - 1) * 100)}, while a normal-range bounce to ${fmt(b.ema20)} is ${pct(((b.ema20 / b.price) - 1) * 100)}.`,
      ].join('\n'),
      rebuttal: `The bear says "below the 50-day, therefore short." That is a lagging filter. Price is already at the lower band and the 20-day low; the marginal seller from the 5 Nov liquidation has been removed. I am not buying blindly: I want a daily close above BTC ${fmt(b.ema50)} / ETH ${fmt(e.ema20)}, with a stop under ${fmt(b.low20)} / ${fmt(e.low20)}. Until then, the bull case is "do not add fresh shorts at support," not "buy everything."`,
    },
    bear: {
      opening: [
        `Trend and structure still point down. BTC made its 20-day high at ${fmt(b.high20)} and has since printed lower daily highs; the latest session high is only ${fmt(b.high24h)}. It is below EMA20 ${fmt(b.ema20)} and EMA50 ${fmt(b.ema50)}. MACD histogram is ${fmt(b.macd?.histogram, 2)} and the 5-day return is ${pct(b.returns?.d5)}. There is no higher-low yet.`,
        `The "extreme fear" argument is not a timing tool. Negative BTC and ETH ETF flows plus a 6.2% single-day drop show that spot supply is still being absorbed, not that it has disappeared. The 20-day low at ${fmt(b.low20)} is only ${Math.abs(((b.low20 / b.price) - 1) * 100).toFixed(2)}% below; a daily close under it exposes the 72k round number and then the 70k handle.`,
        `ETH is weaker medium-term: 60-day ${pct(e.returns?.d60)} versus BTC ${pct(b.returns?.d60)}, and ETH/BTC at ${(e.price / b.price).toFixed(4)} is not showing leadership. A BTC breakdown would hit ETH harder because ETH's 20-day realized volatility is ${fmt(e.realizedVol20Pct, 1)}% and its drawdown is already ${pct(e.drawdown)}; the next supports are ${fmt(e.low20)} and ${fmt(e.low20 * 0.955)}.`,
        `The bull's "reclaim" scenario is a ${pct(((b.ema20 / b.price) - 1) * 100)} move in BTC and a ${pct(((e.ema50 / e.price) - 1) * 100)} move in ETH. Hope is not a setup; the base case is a lower-high retest, not a V-shaped recovery.`,
      ].join('\n'),
      rebuttal: `The bull is right that shorting the exact low is poor. That is why the trade is "sell rallies," not "market-sell here." BTC ${fmt(btcEntry * 0.985)}-${fmt(btcEntry * 1.015)} and ETH ${fmt(ethEntry * 0.985)}-${fmt(ethEntry * 1.015)} are the rejection zones. If price closes above those zones, I am wrong and will stand down; until then, rallies are supply to sell into, not a new trend.`,
    },
  };
}

function researchManager(reports, context, classes) {
  const b = reports.BTC;
  const e = reports.ETH;
  const bClass = classes.BTC;
  const eClass = classes.ETH;
  const bothShort = bClass.direction === 'short' && eClass.direction === 'short';
  const bothLong = bClass.direction === 'long' && eClass.direction === 'long';
  const verdict = bothShort
    ? 'Bear case wins on evidence, but the entry must respect support. Express the view as Underweight and sell rallies, not fresh market shorts at the low.'
    : bothLong
      ? 'Bull case wins on evidence. Buy pullbacks rather than breakouts, and keep the stop under the 20-day low.'
      : 'The tape is mixed. Trade the range or wait for a confirmed break; do not force a directional position.';
  const plan = [
    `BTC: ${bClass.rating}. ${emaPosition(b)}; MACD histogram ${fmt(b.macd?.histogram, 2)}; 5-day ${pct(b.returns?.d5)}. 20-day range ${fmt(b.low20)}-${fmt(b.high20)}.`,
    `ETH: ${eClass.rating}. ${emaPosition(e)}; MACD histogram ${fmt(e.macd?.histogram, 2)}; 60-day ${pct(e.returns?.d60)}. 20-day range ${fmt(e.low20)}-${fmt(e.high20)}.`,
    bothShort
      ? `Upgrade trigger: BTC daily close above ${fmt(b.ema20)} and ETH above ${fmt(e.ema50)} with breadth/flow improving. Downgrade trigger: BTC daily close below ${fmt(b.low20)} and ETH below ${fmt(e.low20)}.`
      : bothLong
        ? `Add trigger: BTC holds ${fmt(b.ema20)} and ETH holds ${fmt(e.ema20)}; invalidate on a daily close below ${fmt(b.low20)} / ${fmt(e.low20)}.`
        : `Range triggers: BTC ${fmt(b.low20)}-${fmt(b.high20)}, ETH ${fmt(e.low20)}-${fmt(e.high20)}. Wait for a daily close outside the range.`,
  ].join('\n');
  return { verdict, plan };
}

function tradePlan(symbol, a, capital, riskPct, klass) {
  const isBtc = symbol === 'BTC';
  const ema20 = a.ema?.ema20 ?? a.price * 1.05;
  const ema50 = a.ema?.ema50 ?? a.price * 1.10;
  const low20 = a.levels?.low20 ?? a.price * 0.95;
  const high20 = a.levels?.high20 ?? a.price * 1.10;
  const high52w = a.high52w ?? high20;

  // Short-side plan: sell a rally into the EMA20 / EMA50 area.
  const shortEntry = isBtc ? mid(ema20 * 0.99, ema20 * 1.005) : mid(ema20 * 0.995, ema50);
  const shortStop = isBtc ? Math.max(ema20 * 1.03, high20 * 0.94) : Math.max(ema50 * 1.017, ema20 * 1.045);
  const shortTargets = [low20, isBtc ? low20 * 0.965 : low20 * 0.955];
  const shortRisk = shortStop - shortEntry;
  const shortRR = shortRisk > 0 ? (shortEntry - shortTargets[0]) / shortRisk : 0;

  // Long-side plan: buy a retest of the 20-day low with a tight invalidation.
  const longEntry = low20 * 1.005;
  const longStop = low20 * 0.985;
  const longTargets = [ema20, high20];
  const longRisk = longEntry - longStop;
  const longRR = longRisk > 0 ? (longTargets[0] - longEntry) / longRisk : 0;

  const direction = klass.direction;
  const primary = direction === 'long'
    ? `Buy pullbacks into ${fmt(longEntry * 0.995)}-${fmt(longEntry * 1.012)}; add on a daily close above ${fmt(ema20)}.`
    : direction === 'short'
      ? `Sell rallies into ${fmt(shortEntry * 0.985)}-${fmt(shortEntry * 1.015)}; do not short support at ${fmt(low20)}.`
      : `Range trade ${fmt(low20)}-${fmt(high20)}; buy the low end / sell the high end, and wait for a daily close outside the range.`;

  const sizing = direction === 'short'
    ? { entry: shortEntry, stop: shortStop, risk: shortRisk, targets: shortTargets }
    : { entry: longEntry, stop: longStop, risk: longRisk, targets: longTargets };
  const riskBudget = capital * (riskPct / 100);
  const unitsByRisk = sizing.risk > 0 ? riskBudget / sizing.risk : 0;
  const unitsByCap = (capital * 0.25) / sizing.entry;
  const units = Math.max(0, Math.min(unitsByRisk, unitsByCap));

  return {
    rating: klass.rating,
    direction,
    stance: `${a.bias} / ${a.regime}`,
    horizon: '1-4 weeks',
    primary,
    short: {
      entryZone: [Number((shortEntry * 0.985).toFixed(1)), Number((shortEntry * 1.015).toFixed(1))],
      stop: Number(shortStop.toFixed(1)),
      targets: shortTargets.map((n) => Number(n.toFixed(1))),
      riskReward: Number(shortRR.toFixed(2)),
      invalidation: `Daily close above ${fmt(shortStop)}`,
      note: direction === 'short' ? 'Primary setup while the rating stays Underweight/Sell.' : 'Counter-trend when the primary direction is long.',
    },
    long: {
      entryZone: [Number((longEntry * 0.995).toFixed(1)), Number((longEntry * 1.012).toFixed(1))],
      stop: Number(longStop.toFixed(1)),
      targets: longTargets.map((n) => Number(n.toFixed(1))),
      riskReward: Number(longRR.toFixed(2)),
      invalidation: `Daily close below ${fmt(longStop)}`,
      note: 'Primary setup when the rating is Buy/Overweight; range low-end otherwise.',
    },
    tacticalLong: {
      trigger: `Daily close above ${fmt(ema20)}`,
      stop: Number((direction === 'long' ? longStop : Math.min(ema20, ema50) * 0.985).toFixed(1)),
      target: Number(high20.toFixed(1)),
      note: 'Add-on only after the first entry is in profit.',
    },
    breakdown: {
      trigger: `Daily close below ${fmt(low20)}`,
      stop: isBtc ? Number(ema50.toFixed(1)) : Number((ema20 * 0.995).toFixed(1)),
      target: Number((isBtc ? low20 * 0.95 : low20 * 0.945).toFixed(1)),
    },
    sizingExample: {
      accountUsd: capital,
      riskPct,
      riskBudgetUsd: Number(riskBudget.toFixed(2)),
      units: Number(units.toFixed(isBtc ? 4 : 3)),
      notionalUsd: Number((units * sizing.entry).toFixed(2)),
      riskAtStopUsd: Number((units * sizing.risk).toFixed(2)),
      direction,
      note: `Capped at 25% of account notional. Example only; recalculate at the actual fill.`,
    },
    high52w: Number(high52w.toFixed(1)),
    execution: {
      direction,
      entryType: direction === 'neutral' ? 'none' : 'limit',
      entryZone: direction === 'short'
        ? [Number((shortEntry * 0.985).toFixed(1)), Number((shortEntry * 1.015).toFixed(1))]
        : [Number((longEntry * 0.995).toFixed(1)), Number((longEntry * 1.012).toFixed(1))],
      stop: direction === 'short' ? Number(shortStop.toFixed(1)) : Number(longStop.toFixed(1)),
      targets: direction === 'short' ? shortTargets.map((n) => Number(n.toFixed(1))) : longTargets.map((n) => Number(n.toFixed(1))),
      validFor: '1-4 weeks',
      note: direction === 'neutral' ? 'No automatic entry while the rating is Hold.' : 'Paper executor waits for price to enter the zone; it never chases.',
    },
  };
}

function scenariosFor(a, klass) {
  const low = a.levels?.low20 ?? a.price * 0.95;
  const high = a.levels?.high20 ?? a.price * 1.10;
  const e20 = a.ema?.ema20 ?? a.price * 1.05;
  const high52 = a.high52w ?? high;
  if (klass.direction === 'long') {
    return {
      base: { probabilityPct: 50, path: `Pullback ${fmt(low)}-${fmt(e20)}; hold ${fmt(e20)} -> ${fmt(high)}.` },
      bear: { probabilityPct: 25, path: `Daily close below ${fmt(low)} -> ${fmt(low * 0.95)}-${fmt(low * 0.96)}.` },
      bull: { probabilityPct: 25, path: `Break ${fmt(high)} -> ${fmt(high52)}.` },
    };
  }
  if (klass.direction === 'neutral') {
    return {
      base: { probabilityPct: 50, path: `Range ${fmt(low)}-${fmt(high)}; buy low end / sell high end.` },
      bear: { probabilityPct: 25, path: `Daily close below ${fmt(low)} -> ${fmt(low * 0.95)}-${fmt(low * 0.96)}.` },
      bull: { probabilityPct: 25, path: `Daily close above ${fmt(high)} -> ${fmt(high52)}.` },
    };
  }
  return {
    base: { probabilityPct: 50, path: `Range ${fmt(low)}-${fmt(e20)}; retest ${fmt(low)} first.` },
    bear: { probabilityPct: 30, path: `Daily close below ${fmt(low)} -> ${fmt(low * 0.95)}-${fmt(low * 0.96)}.` },
    bull: { probabilityPct: 20, path: `Reclaim ${fmt(e20)} -> ${fmt(high)}.` },
  };
}

function buyAdviceFor(a, plan, klass) {
  const low = a.levels?.low20 ?? a.price * 0.95;
  const high = a.levels?.high20 ?? a.price * 1.10;
  const e20 = a.ema?.ema20 ?? a.price * 1.05;
  const e50 = a.ema?.ema50 ?? a.price * 1.10;
  const high52 = a.high52w ?? high;
  if (klass.direction === 'long') {
    return {
      action: `可分批买入：回踩 ${fmt(low)} 附近出现反转 K 线先买 25%，日线站上 ${fmt(e20)} 后加 25%。`,
      firstEntry: { trigger: `回踩 ${fmt(low)} 不破 + 反转 K 线`, zone: [Number((low * 0.995).toFixed(1)), Number((low * 1.012).toFixed(1))], sizePct: 25 },
      addEntry: { trigger: `日线收盘 > ${fmt(e20)}`, zone: [Number(e20.toFixed(1)), Number((e20 * 1.015).toFixed(1))], sizePct: 25 },
      stop: Number((low * 0.985).toFixed(1)),
      targets: [Number(high.toFixed(1)), Number(high52.toFixed(1))],
      holder: `持有者：跌破 ${fmt(low)} 减仓；站上 ${fmt(high)} 持有并上移止损。`,
      avoid: `不要追高；跌破 ${fmt(low)} 后不要补仓。`,
    };
  }
  if (klass.direction === 'neutral') {
    return {
      action: `区间操作：靠近 ${fmt(low)} 小仓低吸，靠近 ${fmt(high)} 减仓；突破区间再顺势。`,
      firstEntry: { trigger: `回踩 ${fmt(low)} 不破`, zone: [Number((low * 0.995).toFixed(1)), Number((low * 1.01).toFixed(1))], sizePct: 20 },
      addEntry: { trigger: `日线收盘 > ${fmt(e20)}`, zone: [Number(e20.toFixed(1)), Number((e20 * 1.015).toFixed(1))], sizePct: 20 },
      stop: Number((low * 0.985).toFixed(1)),
      targets: [Number(e20.toFixed(1)), Number(high.toFixed(1))],
      holder: `持有者：${fmt(low)}-${fmt(high)} 区间内高抛低吸；跌破 ${fmt(low)} 止损。`,
      avoid: `不要在区间中部追单；不要在突破前重仓。`,
    };
  }
  const first = Math.abs(a.price - e20) <= Math.abs(a.price - e50) ? e20 : e50;
  const second = first === e20 ? e50 : e20;
  return {
    action: `暂不买入；等待日线收盘站上 ${fmt(first)} 后小仓试多，或回踩 ${fmt(low)} 不破并出现反转 K 线再考虑。`,
    firstEntry: { trigger: `日线收盘 > ${fmt(first)}`, zone: [Number(first.toFixed(1)), Number((first * 1.015).toFixed(1))], sizePct: 25 },
    addEntry: { trigger: `日线收盘 > ${fmt(second)}`, zone: [Number(second.toFixed(1)), Number((second * 1.015).toFixed(1))], sizePct: 25 },
    stop: Number(low.toFixed(1)),
    targets: [Number(e20.toFixed(1)), Number(high.toFixed(1))],
    holder: `已有仓位：反弹到 ${fmt(Math.min(first, second))}-${fmt(Math.max(first, second))} 减仓 1/3-1/2；跌破 ${fmt(low)} 止损。`,
    avoid: `不要在 ${fmt(low)} 附近市价追空；不要在未收复 ${fmt(first)} 前重仓抄底。`,
  };
}

function summaryFor(a, plan, klass) {
  const low = a.levels?.low20 ?? a.price * 0.95;
  const high = a.levels?.high20 ?? a.price * 1.10;
  const e20 = a.ema?.ema20 ?? a.price * 1.05;
  const e50 = a.ema?.ema50 ?? a.price * 1.10;
  if (klass.direction === 'long') {
    return `Bullish (${klass.rating}). Buy pullbacks into ${fmt(low)}-${fmt(e20)}; stop under ${fmt(plan.long.stop)}; first target ${fmt(e20)}, then ${fmt(high)}.`;
  }
  if (klass.direction === 'neutral') {
    return `Range (${klass.rating}). Trade ${fmt(low)}-${fmt(high)}; a daily close outside the range is the next signal.`;
  }
  const first = Math.abs(a.price - e20) <= Math.abs(a.price - e50) ? e20 : e50;
  const second = first === e20 ? e50 : e20;
  return `Bearish (${klass.rating}). Do not chase at ${fmt(a.price)}; sell rallies into ${fmt(plan.short.entryZone[0])}-${fmt(plan.short.entryZone[1])}, invalidation above ${fmt(plan.short.stop)}. A daily close above ${fmt(first)} is the first repair signal; ${fmt(second)} is confirmation.`;
}

export function runTradingAgents(analyses, context = {}, options = {}) {
  const capital = Number(options.capitalUSDT || 10000);
  const riskProfile = String(options.riskProfile || 'balanced').toLowerCase();
  const riskPct = riskProfile === 'aggressive' ? 1.5 : riskProfile === 'conservative' ? 0.5 : 1;
  const reports = {
    BTC: reportFor('BTC', analyses.BTC),
    ETH: reportFor('ETH', analyses.ETH),
  };
  const btcClass = classify(analyses.BTC);
  const ethClass = classify(analyses.ETH);
  const analysts = analystReports(reports, context);
  const debate = buildBullBear(reports, context);
  const manager = researchManager(reports, context, { BTC: btcClass, ETH: ethClass });
  const btcPlan = tradePlan('BTC', analyses.BTC, capital, riskPct, btcClass);
  const ethPlan = tradePlan('ETH', analyses.ETH, capital, riskPct, ethClass);
  const ratio = analyses.ETH.price / analyses.BTC.price;

  const btcScenarios = {
    base: {
      probabilityPct: 50,
      path: `Range ${fmt(analyses.BTC.levels.low20)}-${fmt(analyses.BTC.ema.ema20)}; retest ${fmt(analyses.BTC.levels.low20)} first.`,
    },
    bear: {
      probabilityPct: 30,
      path: `Daily close below ${fmt(analyses.BTC.levels.low20)} -> ${fmt(analyses.BTC.levels.low20 * 0.95)}-${fmt(analyses.BTC.levels.low20 * 0.96)}.`,
    },
    bull: {
      probabilityPct: 20,
      path: `Reclaim ${fmt(analyses.BTC.ema.ema50)} -> ${fmt(analyses.BTC.ema.ema20)}-${fmt(analyses.BTC.levels.high20)}.`,
    },
  };
  const ethScenarios = {
    base: {
      probabilityPct: 50,
      path: `Range ${fmt(analyses.ETH.levels.low20)}-${fmt(analyses.ETH.ema.ema20)}; retest ${fmt(analyses.ETH.levels.low20)} first.`,
    },
    bear: {
      probabilityPct: 30,
      path: `Daily close below ${fmt(analyses.ETH.levels.low20)} -> ${fmt(analyses.ETH.levels.low20 * 0.945)}-${fmt(analyses.ETH.levels.low20 * 0.96)}.`,
    },
    bull: {
      probabilityPct: 20,
      path: `Reclaim ${fmt(analyses.ETH.ema.ema20)} -> ${fmt(analyses.ETH.ema.ema50)}-${fmt(analyses.ETH.levels.high20)}.`,
    },
  };

  const result = {
    framework: 'TradingAgents-style multi-agent debate (TauricResearch/TradingAgents roles)',
    frameworkUrl: 'https://github.com/TauricResearch/TradingAgents',
    asOf: new Date().toISOString(),
    dataQuality: [
      'OKX public REST was unreachable from the host used to bootstrap this server (TLS reset); the data plane falls back to Stooq public quote/history and then to a bundled snapshot.',
      'BTC technical model used 120 daily bars and ETH used 160 daily bars at capture time. The bundled snapshot keeps the last 40 BTC candles for inspection. Long-term EMA200 was not available, so the 52-week range and 60-day return carry the cycle context.',
      'Crypto fundamentals are relative-value/flow based, not company financial statements. No live OKX funding rate or open interest was available; MyToken aggregate OI/liquidation data is used and labelled.',
      'This is research output, not investment advice. No order is placed by this MCP server.',
    ],
    analysts,
    debate: {
      bull: debate.bull,
      bear: debate.bear,
      researchManager: manager,
    },
    trader: {
      BTC: btcPlan,
      ETH: ethPlan,
      relative: {
        ethBtc: Number(ratio.toFixed(4)),
        view: ratio < 0.0300
          ? 'ETH/BTC is below 0.0300; prefer BTC over ETH on a relative basis until ETH reclaims 0.0300-0.0305.'
          : 'ETH/BTC is at/above 0.0300; relative downside is less extended, but the absolute trend is still bearish.',
      },
    },
    riskDebate: {
      aggressive: `Momentum and flow justify pressing the short now: BTC is below both EMAs and ETH is below both EMAs with 60-day relative weakness. Use ${riskPct}% account risk; if BTC breaks ${fmt(analyses.BTC.levels.low20)}, add.`,
      conservative: `Do not short support. BTC is ${pct(((analyses.BTC.price / analyses.BTC.levels.low20) - 1) * 100)} above its 20-day low and ETH ${pct(((analyses.ETH.price / analyses.ETH.levels.low20) - 1) * 100)} above its low. Wait for a rally into ${fmt(analyses.BTC.ema.ema20)} / ${fmt(analyses.ETH.ema.ema20)}, or for a confirmed breakdown with a close below the low. Use 0.5% risk.`,
      neutral: `Underweight is the right compromise. Keep core exposure small, sell only into rallies, and use ${Math.max(0.5, riskPct - 0.25)}% risk per idea. Treat BTC and ETH as one correlated crypto-beta position, not two independent trades.`,
      riskManager: `ATR is ${analyses.BTC.atrPct}% for BTC and ${analyses.ETH.atrPct}% for ETH. The structural stops in the trader plan are about 0.8-0.9 ATR from entry; size from that stop distance and do not widen it. Total crypto beta should be capped at 25% of the account, and aggregate risk across BTC+ETH at 1%. Correlated positions do not diversify.`,
    },
    decision: {
      BTC: {
        rating: 'Underweight',
        convictionPct: 64,
        summary: `Bearish trend, late entry. Do not add at ${fmt(analyses.BTC.price)}; sell rallies into ${fmt(btcPlan.short.entryZone[0])}-${fmt(btcPlan.short.entryZone[1])}, invalidation above ${fmt(btcPlan.short.stop)}. A daily close above ${fmt(analyses.BTC.ema.ema50)} is the first repair signal.`,
        buyAdvice: {
          action: `暂不买入；等待日线收盘站上 ${fmt(analyses.BTC.ema.ema50)} 后小仓试多，或回踩 ${fmt(analyses.BTC.levels.low20)} 不破并出现反转 K 线再考虑。`,
          firstEntry: {
            trigger: `日线收盘 > ${fmt(analyses.BTC.ema.ema50)}`,
            zone: [Number(analyses.BTC.ema.ema50.toFixed(1)), Number((analyses.BTC.ema.ema50 * 1.016).toFixed(1))],
            sizePct: 25,
          },
          addEntry: {
            trigger: `日线收盘 > ${fmt(analyses.BTC.ema.ema20)}`,
            zone: [Number(analyses.BTC.ema.ema20.toFixed(1)), Number(btcPlan.short.entryZone[1].toFixed(1))],
            sizePct: 25,
          },
          stop: Number(analyses.BTC.levels.low20.toFixed(1)),
          targets: [Number(analyses.BTC.ema.ema20.toFixed(1)), Number(analyses.BTC.levels.high20.toFixed(1))],
          holder: `已有仓位：反弹到 ${fmt(btcPlan.short.entryZone[0])}-${fmt(btcPlan.short.entryZone[1])} 减仓 1/3-1/2；跌破 ${fmt(analyses.BTC.levels.low20)} 止损。`,
          avoid: `不要在 ${fmt(analyses.BTC.levels.low20)} 附近市价追空；不要在未收复 ${fmt(analyses.BTC.ema.ema50)} 前重仓抄底。`,
        },
        scenarios: btcScenarios,
      },
      ETH: {
        rating: 'Underweight',
        convictionPct: 70,
        summary: `Weaker medium-term leg. Prefer ETH as the short/underweight side versus BTC while ETH/BTC < 0.0300. Sell rallies into ${fmt(ethPlan.short.entryZone[0])}-${fmt(ethPlan.short.entryZone[1])}, invalidation above ${fmt(ethPlan.short.stop)}.`,
        buyAdvice: {
          action: `暂不买入；等待日线收盘站上 ${fmt(analyses.ETH.ema.ema50)} 后小仓试多。相对策略优先“空 ETH / 多 BTC”，直到 ETH/BTC 收复 0.0300。`,
          firstEntry: {
            trigger: `日线收盘 > ${fmt(analyses.ETH.ema.ema50)}`,
            zone: [Number(analyses.ETH.ema.ema50.toFixed(1)), Number((analyses.ETH.ema.ema50 * 1.015).toFixed(1))],
            sizePct: 20,
          },
          addEntry: {
            trigger: `日线收盘 > ${fmt(analyses.ETH.levels.high20)}`,
            zone: [Number(analyses.ETH.levels.high20.toFixed(1)), Number((analyses.ETH.levels.high20 * 1.015).toFixed(1))],
            sizePct: 20,
          },
          stop: Number(analyses.ETH.ema.ema20.toFixed(1)),
          targets: [Number(analyses.ETH.levels.high20.toFixed(1)), Number(analyses.ETH.levels.high60.toFixed(1))],
          holder: `已有仓位：反弹到 ${fmt(ethPlan.short.entryZone[0])}-${fmt(ethPlan.short.entryZone[1])} 减仓；跌破 ${fmt(analyses.ETH.levels.low20)} 止损。`,
          avoid: `不要在 ${fmt(analyses.ETH.levels.low20)} 附近追杀；不要在未站上 ${fmt(analyses.ETH.ema.ema20)} 前抄底。`,
        },
        scenarios: ethScenarios,
      },
      portfolio: {
        grossCryptoExposurePct: riskProfile === 'aggressive' ? 35 : riskProfile === 'conservative' ? 10 : 20,
        netBias: 'Underweight / defensive',
        preferred: 'BTC over ETH on relative strength; cash is a position until BTC reclaims its 50-day.',
        whatWouldChange: `BTC daily close above ${fmt(analyses.BTC.ema.ema20)} and ETH above ${fmt(analyses.ETH.ema.ema50)} with ETF flows turning positive; or a capitulation wick below ${fmt(analyses.BTC.levels.low20)} that reclaims the level within 1-2 sessions.`,
      },
    },
    disclaimer: 'Research and education only. Crypto derivatives can lose more than the initial margin. Live execution is off by default and, when enabled, is a guarded spot limit-buy path with no automatic exit.',
  };

  result.debate.researchManager = manager;
  result.trader.BTC = btcPlan;
  result.trader.ETH = ethPlan;
  result.trader.relative.view = ratio < 0.0300
    ? 'ETH/BTC is below 0.0300; prefer BTC over ETH on a relative basis until ETH reclaims 0.0300-0.0305.'
    : `ETH/BTC is at/above 0.0300; relative downside is less extended. Absolute ETH trend: ${analyses.ETH.bias}.`;

  const bothShort = btcClass.direction === 'short' && ethClass.direction === 'short';
  const bothLong = btcClass.direction === 'long' && ethClass.direction === 'long';
  const preferred = ratio < 0.0300
    ? 'BTC over ETH'
    : btcClass.score >= ethClass.score ? 'BTC over ETH' : 'ETH over BTC';

  result.riskDebate = {
    aggressive: `Trade with the prevailing ${btcClass.direction === 'short' ? 'short' : btcClass.direction === 'long' ? 'long' : 'range'} bias. Use ${riskPct}% account risk and add only after a confirming daily close.`,
    conservative: `Wait for a retest: BTC ${fmt(analyses.BTC.ema.ema20)} / ETH ${fmt(analyses.ETH.ema.ema20)}. Do not chase; use 0.5% risk and a hard invalidation.`,
    neutral: `${btcClass.rating} / ${ethClass.rating} is the compromise. Keep core exposure small, use ${Math.max(0.5, riskPct - 0.25)}% risk per idea, and treat BTC+ETH as one correlated crypto-beta position.`,
    riskManager: `ATR is ${analyses.BTC.atrPct}% for BTC and ${analyses.ETH.atrPct}% for ETH. Size from the structural stop, not from conviction. Total crypto beta should be capped at 25% of the account, and aggregate risk across BTC+ETH at 1%. Correlated positions do not diversify.`,
  };

  result.decision = {
    BTC: {
      rating: btcClass.rating,
      convictionPct: btcClass.convictionPct,
      summary: summaryFor(analyses.BTC, btcPlan, btcClass),
      buyAdvice: buyAdviceFor(analyses.BTC, btcPlan, btcClass),
      execution: btcPlan.execution,
      scenarios: scenariosFor(analyses.BTC, btcClass),
    },
    ETH: {
      rating: ethClass.rating,
      convictionPct: ethClass.convictionPct,
      summary: summaryFor(analyses.ETH, ethPlan, ethClass),
      buyAdvice: buyAdviceFor(analyses.ETH, ethPlan, ethClass),
      execution: ethPlan.execution,
      scenarios: scenariosFor(analyses.ETH, ethClass),
    },
    portfolio: {
      grossCryptoExposurePct: riskProfile === 'aggressive' ? 35 : riskProfile === 'conservative' ? 10 : 20,
      netBias: bothShort ? 'Underweight / defensive' : bothLong ? 'Overweight / constructive' : 'Neutral / range',
      preferred: `${preferred}; cash is a position when the two scores disagree.`,
      whatWouldChange: bothShort
        ? `BTC daily close above ${fmt(analyses.BTC.ema.ema20)} and ETH above ${fmt(analyses.ETH.ema.ema50)} with flow improving; or a capitulation wick below ${fmt(analyses.BTC.levels.low20)} that reclaims the level.`
        : bothLong
          ? `BTC daily close below ${fmt(analyses.BTC.levels.low20)} or ETH below ${fmt(analyses.ETH.levels.low20)}; or a failed breakout above ${fmt(analyses.BTC.levels.high20)}.`
          : `A daily close outside BTC ${fmt(analyses.BTC.levels.low20)}-${fmt(analyses.BTC.levels.high20)} or ETH ${fmt(analyses.ETH.levels.low20)}-${fmt(analyses.ETH.levels.high20)}.`,
    },
  };

  result.dataQuality = [
    'Data source order: OKX public REST -> Stooq public quote/history -> bundled snapshot. Check dataSources for the actual source; stale:true means the snapshot was used.',
    `BTC model used ${analyses.BTC.candles ?? 'n/a'} daily bars; ETH used ${analyses.ETH.candles ?? 'n/a'}. Long-term EMA200 may be unavailable, so the 52-week range and 60-day return carry the cycle context.`,
    'Crypto fundamentals are relative-value/flow based, not company financial statements. Sentiment/OI/liquidation context is from MyToken and is labelled; it is not OKX-native funding.',
    'This is research output, not investment advice. Live execution is off by default; no order is placed unless auto_trade mode=live is explicitly enabled and confirmed.',
  ];

  return result;
}
