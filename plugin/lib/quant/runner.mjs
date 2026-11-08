// Deterministic strategy runner (paper by default).
// - evaluates the momentum-rotation strategy once per completed daily bar
// - enforces hard guards: kill switch, daily loss limit, consecutive-stop cooldown
// - writes an append-only decision log + heartbeat so a crash is visible
// - never places a real order in this module; live execution stays in execution.mjs

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fetchHistory } from './history.mjs';
import { MOMENTUM_DEFAULTS, prepareSeries, momentumScore } from './strategy-momentum.mjs';
import { loadState, saveState, openPosition, closePosition, accountSnapshot, equity } from '../paper.mjs';

export const RUNNER_DIR = process.env.OKX_RUNNER_DIR
  || path.join(os.homedir(), '.dsh', 'okx-tradingagents', 'quant', 'runner');

export const RUNNER_DEFAULTS = Object.freeze({
  symbols: ['BTC', 'ETH'],
  bars: 400,
  rr: 2.0,                    // take-profit distance as a multiple of stop distance
  dailyLossLimitPct: 3,       // stop opening new positions after -3% on the day
  consecutiveStopCooldown: 3, // N stop-outs in a row -> cooldown
  cooldownHours: 24,
  params: { ...MOMENTUM_DEFAULTS },
});

const file = {
  heartbeat: path.join(RUNNER_DIR, 'heartbeat.json'),
  meta: path.join(RUNNER_DIR, 'runner-meta.json'),
  log: path.join(RUNNER_DIR, 'decisions.jsonl'),
  kill: path.join(RUNNER_DIR, 'KILL'),
};

function ensureDir() { fs.mkdirSync(RUNNER_DIR, { recursive: true }); }

function readJson(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
}
function writeJson(f, obj) {
  ensureDir();
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}
function appendLog(obj) {
  ensureDir();
  fs.appendFileSync(file.log, JSON.stringify(obj) + '\n', 'utf8');
}
export function killSwitchActive() { return fs.existsSync(file.kill); }

function todayUtc8() {
  const utc8 = new Date(Date.now() + 8 * 3600 * 1000);
  return utc8.toISOString().slice(0, 10);
}

/** Build the decision for the latest CLOSED daily bar. Pure apart from fetching bars. */
export async function evaluateMarket({ symbols = RUNNER_DEFAULTS.symbols, bars = RUNNER_DEFAULTS.bars, params = RUNNER_DEFAULTS.params } = {}) {
  const out = {};
  for (const sym of symbols) {
    const rows = await fetchHistory(`${sym}-USDT`, { bar: '1D', totalBars: bars });
    if (rows.length < Math.max(params.lookback, params.trendLen, 30)) {
      out[sym] = { error: `only ${rows.length} bars` };
      continue;
    }
    const series = prepareSeries(rows, params);
    const i = rows.length - 1;
    const last = rows[i];
    const score = momentumScore(series.closes, i, params.lookback);
    const trendOk = series.emaTrend[i] != null && last.close > series.emaTrend[i];
    const vol = series.vol20[i];
    const atrVal = series.atr[i];
    out[sym] = {
      close: last.close,
      closeTime: last.time,
      score,
      trendOk,
      emaTrend: series.emaTrend[i],
      atr: atrVal,
      vol20: vol,
      lev: vol ? Math.max(params.minLev, Math.min(params.maxLev, params.volTargetPct / vol)) : null,
      bars: rows.length,
    };
  }
  return out;
}

export function rank(perSymbol, params = RUNNER_DEFAULTS.params) {
  return Object.entries(perSymbol)
    .filter(([, v]) => !v.error && v.score != null && v.atr != null)
    .map(([symbol, v]) => ({ symbol, ...v }))
    .sort((a, b) => b.score - a.score)
    .map((r, idx) => ({ ...r, tradable: idx === 0 && r.score > params.minScore && r.trendOk }));
}

/**
 * One decision cycle. Mutates the paper ledger unless dryRun.
 * Returns a full audit trail of what was considered and what was done.
 */
export async function runOnce({ dryRun = false, now = new Date(), cfg = RUNNER_DEFAULTS } = {}) {
  ensureDir();
  const state = loadState();
  const meta = readJson(file.meta, { date: todayUtc8(), dayStartEquity: null, consecutiveStops: 0, cooldownUntil: null });

  const perSymbol = await evaluateMarket({ params: cfg.params });
  const ranked = rank(perSymbol, cfg.params);
  const marks = {};
  for (const [sym, v] of Object.entries(perSymbol)) if (!v.error) marks[sym] = v.close;

  const before = accountSnapshot(state, marks);
  if (meta.date !== todayUtc8() || meta.dayStartEquity == null) {
    meta.date = todayUtc8();
    meta.dayStartEquity = before.equity;
  }
  const dayPnlPct = meta.dayStartEquity > 0 ? ((before.equity / meta.dayStartEquity) - 1) * 100 : 0;

  const actions = [];
  const guards = {
    killSwitch: killSwitchActive(),
    dayPnlPct: Number(dayPnlPct.toFixed(2)),
    dailyLossBlocked: dayPnlPct <= -cfg.dailyLossLimitPct,
    cooldownActive: meta.cooldownUntil ? new Date(meta.cooldownUntil) > now : false,
  };

  // 1) manage open positions
  for (const [symbol, pos] of Object.entries(state.positions || {})) {
    const px = marks[symbol];
    if (!Number.isFinite(px)) { actions.push({ action: 'warn', symbol, reason: 'no mark price' }); continue; }
    const held = ranked.find((r) => r.symbol === symbol);
    const hitStop = pos.side === 'long' ? px <= Number(pos.stop) : px >= Number(pos.stop);
    const hitTarget = pos.side === 'long' ? px >= Number(pos.target) : px <= Number(pos.target);
    const trendBreak = pos.side === 'long' && held && held.trendOk === false;
    const rotate = pos.side === 'long' && ranked.length > 1 && ranked[0].symbol !== symbol && ranked[0].tradable;

    let reason = null;
    if (hitStop) reason = 'stop';
    else if (hitTarget) reason = 'target';
    else if (trendBreak) reason = 'trend-break';
    else if (rotate) reason = 'rotate';

    if (reason) {
      if (!dryRun) {
        const trade = closePosition(state, { symbol, price: px, reason });
        actions.push({ action: 'close', symbol, reason, price: px, pnlUSDT: trade?.pnlUSDT });
      } else {
        actions.push({ action: 'would-close', symbol, reason, price: px });
      }
      meta.consecutiveStops = reason === 'stop' ? (meta.consecutiveStops || 0) + 1 : 0;
      if (meta.consecutiveStops >= cfg.consecutiveStopCooldown) {
        meta.cooldownUntil = new Date(now.getTime() + cfg.cooldownHours * 3600 * 1000).toISOString();
      }
    } else {
      actions.push({ action: 'hold', symbol, mark: px, stop: pos.stop, target: pos.target, score: held?.score ?? null });
    }
  }

  // 2) consider a new entry
  const openCount = Object.keys(state.positions || {}).length;
  const blocked = guards.killSwitch || guards.dailyLossBlocked || guards.cooldownActive;
  if (openCount > 0) {
    actions.push({ action: 'skip-entry', reason: 'position already open (single leg only)' });
  } else if (blocked) {
    actions.push({
      action: 'skip-entry',
      reason: guards.killSwitch ? 'kill switch' : guards.dailyLossBlocked ? `daily loss ${guards.dayPnlPct}% <= -${cfg.dailyLossLimitPct}%` : 'cooldown after consecutive stops',
    });
  } else {
    const pick = ranked.find((r) => r.tradable);
    if (!pick) {
      actions.push({ action: 'wait', reason: 'no tradable symbol (momentum<=0 or trend filter failed)', ranking: ranked.map((r) => ({ symbol: r.symbol, score: Number(r.score.toFixed(4)), trendOk: r.trendOk })) });
    } else {
      const riskPerUnit = cfg.params.atrMult * pick.atr;
      const stop = pick.close - riskPerUnit;
      const target = pick.close + cfg.rr * riskPerUnit;
      const notional = Math.min(
        before.equity * (cfg.params.riskPct / 100) / (riskPerUnit / pick.close),
        before.equity * (cfg.params.maxNotionalPct / 100) * (pick.lev ?? 1),
      );
      if (!dryRun) {
        try {
          const order = openPosition(state, {
            symbol: pick.symbol,
            side: 'long',
            price: pick.close,
            stop,
            target,
            riskPct: cfg.params.riskPct,
            maxPositionPct: cfg.params.maxNotionalPct * (pick.lev ?? 1),
            notionalCapUSDT: notional,
            reason: 'momentum-rotation',
          });
          actions.push({ action: 'open', symbol: pick.symbol, price: pick.close, stop: order.stop, target: order.target, notionalUSDT: order.notionalUSDT, score: Number(pick.score.toFixed(4)) });
        } catch (e) {
          actions.push({ action: 'reject', symbol: pick.symbol, reason: e.message });
        }
      } else {
        actions.push({ action: 'would-open', symbol: pick.symbol, price: pick.close, stop: Number(stop.toFixed(2)), target: Number(target.toFixed(2)), notionalUSDT: Number(notional.toFixed(2)), score: Number(pick.score.toFixed(4)) });
      }
    }
  }

  const after = accountSnapshot(state, marks);
  const result = {
    at: now.toISOString(),
    day: todayUtc8(),
    dryRun,
    guards,
    ranking: ranked.map((r) => ({ symbol: r.symbol, score: Number((r.score ?? 0).toFixed(4)), trendOk: r.trendOk, tradable: r.tradable, close: r.close })),
    actions,
    account: { equity: after.equity, cash: after.cash, exposurePct: after.grossExposurePct, openPositions: after.openPositionCount },
  };

  if (!dryRun) {
    saveState(state);
    writeJson(file.meta, { ...meta, lastRunAt: result.at });
    appendLog(result);
  }
  writeJson(file.heartbeat, {
    pid: process.pid,
    lastRunAt: result.at,
    dryRun,
    equity: after.equity,
    openPositions: after.openPositionCount,
    lastActions: actions,
    guards,
  });
  return result;
}

/** Simple resident loop. `maxRuns` makes it testable without waiting forever. */
export async function runLoop({ intervalMs = 3600_000, maxRuns = Infinity, dryRun = false, onResult = null } = {}) {
  let runs = 0;
  // eslint-disable-next-line no-constant-condition
  while (runs < maxRuns) {
    runs += 1;
    try {
      const res = await runOnce({ dryRun });
      if (onResult) onResult(res);
      else console.log(JSON.stringify(res.actions));
    } catch (e) {
      console.error(`[runner] iteration ${runs} failed: ${e.message}`);
    }
    if (runs >= maxRuns) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { runs };
}

export const runnerPaths = file;
