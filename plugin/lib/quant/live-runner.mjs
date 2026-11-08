// Live runner: the only module allowed to risk real money.
// Defaults to dry-run. Every path is fail-closed:
//   - OKX_TRADING_ENABLED must be 1 and keys configured
//   - caller must pass confirm: 'LIVE'
//   - canary caps from OKX_MAX_ORDER_USDT / OKX_MAX_DAILY_USDT still apply
//   - no entry without an exchange-side OCO attached afterwards
//   - KILL switch file blocks new entries
import fs from 'node:fs';
import path from 'node:path';
import { liveStatus, getUsdtBalance } from '../okx-live.mjs';
import { evaluateMarket, rank, RUNNER_DEFAULTS, RUNNER_DIR, killSwitchActive } from './runner.mjs';
import { openWithProtection, closeProtected, listAlgo, getSpecs, floorToStep } from './execution.mjs';

export const LIVE_LEDGER = path.join(RUNNER_DIR, 'live-ledger.json');
export const LIVE_LOG = path.join(RUNNER_DIR, 'live-decisions.jsonl');

const readLedger = () => {
  try { return JSON.parse(fs.readFileSync(LIVE_LEDGER, 'utf8')); }
  catch { return { version: 1, position: null, dayStartEquity: null, day: null, consecutiveStops: 0, cooldownUntil: null, history: [] }; }
};
const writeLedger = (l) => {
  fs.mkdirSync(RUNNER_DIR, { recursive: true });
  const tmp = `${LIVE_LEDGER}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(l, null, 2), 'utf8');
  fs.renameSync(tmp, LIVE_LEDGER);
};
const appendLiveLog = (o) => {
  fs.mkdirSync(RUNNER_DIR, { recursive: true });
  fs.appendFileSync(LIVE_LOG, JSON.stringify(o) + '\n', 'utf8');
};

function todayUtc8() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Reconcile: does the exchange still hold our protective order? */
export async function protectionHealth(instId) {
  const algos = await listAlgo({ instId });
  return { algoCount: algos.length, algos };
}

/**
 * One live cycle.
 * dryRun=true  -> builds the full plan, contacts no trading endpoint, needs no keys.
 * dryRun=false -> requires live enabled + keys + confirm:'LIVE'.
 */
export async function runLiveOnce({
  dryRun = true,
  confirm = null,
  cfg = RUNNER_DEFAULTS,
  now = new Date(),
  market = null,   // test seam: inject a synthetic snapshot
} = {}) {
  const st = liveStatus();
  const ledger = readLedger();
  const actions = [];
  const day = todayUtc8();
  if (ledger.day !== day) { ledger.day = day; ledger.dayStartEquity = null; }

  if (!dryRun) {
    if (confirm !== 'LIVE') throw new Error('runLiveOnce requires confirm="LIVE" for real execution');
    if (!st.enabled) throw new Error('live trading disabled: set OKX_TRADING_ENABLED=1');
    if (!st.keysConfigured) throw new Error('OKX credentials are not configured');
  }

  const kill = killSwitchActive();
  const perSymbol = market ?? await evaluateMarket({ params: cfg.params });
  const ranked = rank(perSymbol, cfg.params);
  const marks = {};
  for (const [s, v] of Object.entries(perSymbol)) if (!v.error) marks[s] = v.close;

  let equity = null;
  if (!dryRun) {
    const bal = await getUsdtBalance();
    equity = Number(bal.usdt?.available || 0);
    if (ledger.dayStartEquity == null) ledger.dayStartEquity = equity;
  }
  const dayPnlPct = equity != null && ledger.dayStartEquity
    ? (equity / ledger.dayStartEquity - 1) * 100
    : 0;
  const guards = {
    killSwitch: kill,
    liveEnabled: st.enabled,
    keysConfigured: st.keysConfigured,
    dayPnlPct: Number(dayPnlPct.toFixed(2)),
    dailyLossBlocked: dayPnlPct <= -cfg.dailyLossLimitPct,
    cooldownActive: ledger.cooldownUntil ? new Date(ledger.cooldownUntil) > now : false,
    canaryMaxOrderUSDT: st.maxOrderUSDT,
    canaryMaxDailyUSDT: st.maxDailyUSDT,
  };

  // ---- 1) manage the open position -------------------------------------------
  if (ledger.position) {
    const { symbol, stop, target } = ledger.position;
    const px = marks[symbol];
    const held = ranked.find((r) => r.symbol === symbol);
    let reason = null;
    if (px == null) reason = null;
    else if (px <= stop) reason = 'stop';
    else if (px >= target) reason = 'target';
    else if (held && held.trendOk === false) reason = 'trend-break';
    else if (ranked[0]?.tradable && ranked[0].symbol !== symbol) reason = 'rotate';

    if (reason && px != null) {
      if (dryRun) {
        actions.push({ action: 'would-close', symbol, reason, price: px, plan: await closeProtected({ instId: `${symbol}-USDT`, dryRun: true }) });
      } else {
        const res = await closeProtected({ instId: `${symbol}-USDT` });
        const pnl = ledger.position.qty * (px - ledger.position.entry);
        ledger.position = null;
        ledger.consecutiveStops = reason === 'stop' ? (ledger.consecutiveStops || 0) + 1 : 0;
        if (ledger.consecutiveStops >= cfg.consecutiveStopCooldown) {
          ledger.cooldownUntil = new Date(now.getTime() + cfg.cooldownHours * 3600e3).toISOString();
        }
        actions.push({ action: 'close', symbol, reason, price: px, pnlUSDT: Number(pnl.toFixed(2)), result: res });
      }
    } else {
      // protection check: never let a position sit without an exchange-side stop
      if (!dryRun) {
        const health = await protectionHealth(`${symbol}-USDT`);
        if (health.algoCount === 0) {
          actions.push({ action: 'ALERT', symbol, reason: 'position has NO exchange-side protective order' });
        }
      }
      actions.push({ action: 'hold', symbol, mark: px, stop, target });
    }
  }

  // ---- 2) new entry -----------------------------------------------------------
  const blocked = kill || guards.dailyLossBlocked || guards.cooldownActive;
  if (!ledger.position) {
    if (blocked) {
      actions.push({
        action: 'skip-entry',
        reason: kill ? 'kill switch' : guards.dailyLossBlocked ? `daily loss ${guards.dayPnlPct}%` : 'cooldown',
      });
    } else {
      const pick = ranked.find((r) => r.tradable);
      if (!pick) {
        actions.push({ action: 'wait', reason: 'no tradable symbol' });
      } else {
        const spec = await getSpecs(`${pick.symbol}-USDT`);
        const riskPerUnit = cfg.params.atrMult * pick.atr;
        const stop = pick.close - riskPerUnit;
        const target = pick.close + cfg.rr * riskPerUnit;
        const baseEquity = equity ?? cfg.params.maxNotionalPct * 100; // dry-run placeholder
        const capByNotional = baseEquity * (cfg.params.maxNotionalPct / 100) * (pick.lev ?? 1);
        const capByRisk = (baseEquity * (cfg.params.riskPct / 100) / riskPerUnit) * pick.close;
        const capByCanary = Math.min(st.maxOrderUSDT, Math.max(0, st.maxDailyUSDT));
        const notional = Math.min(capByNotional, capByRisk, capByCanary);
        const qty = floorToStep(notional / pick.close, spec.lotSz);
        if (!(qty >= spec.minSz)) {
          actions.push({ action: 'skip-entry', reason: `qty ${qty} below minSz ${spec.minSz}` });
        } else if (dryRun) {
          actions.push({
            action: 'would-open',
            symbol: pick.symbol,
            price: pick.close,
            qty,
            notionalUSDT: Number((qty * pick.close).toFixed(2)),
            stop: Number(stop.toFixed(2)),
            target: Number(target.toFixed(2)),
            plan: await openWithProtection({
              instId: `${pick.symbol}-USDT`, px: pick.close, sz: qty,
              slTriggerPx: stop, tpTriggerPx: target, dryRun: true,
            }),
          });
        } else {
          const res = await openWithProtection({
            instId: `${pick.symbol}-USDT`, px: pick.close, sz: qty,
            slTriggerPx: stop, tpTriggerPx: target, dryRun: false,
          });
          if (res.filledQty > 0 && res.oco) {
            ledger.position = {
              symbol: pick.symbol,
              qty: res.filledQty,
              entry: pick.close,
              stop: Number(stop.toFixed(2)),
              target: Number(target.toFixed(2)),
              algoId: res.oco.algoId,
              openedAt: now.toISOString(),
            };
            actions.push({ action: 'open', symbol: pick.symbol, qty: res.filledQty, entry: pick.close, stop, target, algoId: res.oco.algoId });
          } else {
            actions.push({ action: 'ALERT', symbol: pick.symbol, reason: res.warning || 'entry did not produce a protected position', detail: res });
          }
        }
      }
    }
  }

  const result = { at: now.toISOString(), day, dryRun, guards, actions };
  if (!dryRun) {
    writeLedger(ledger);
    appendLiveLog(result);
  }
  return result;
}
