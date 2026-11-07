// Local paper-trading ledger for the OKX/TradingAgents desk. It never talks
// to OKX and never places a real order. State is a single JSON file so the
// account survives DSH restarts and can be audited.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const PAPER_CONFIG = {
  startingBalance: 10000,
  feeBps: 5,
  slippageBps: 5,
  riskPct: 1,
  maxPositionPct: 25,
  maxGrossPct: 50,
};

export function paperStatePath() {
  return path.resolve(process.env.OKX_PAPER_STATE || path.join(ROOT, 'paper', 'account.json'));
}

function now() {
  return new Date().toISOString();
}

function freshState(startingBalance = PAPER_CONFIG.startingBalance) {
  return {
    version: 1,
    createdAt: now(),
    updatedAt: now(),
    mode: 'paper',
    startingBalance: Number(startingBalance),
    cash: Number(startingBalance),
    realizedPnl: 0,
    feesPaid: 0,
    positions: {},
    trades: [],
    orders: [],
    config: { ...PAPER_CONFIG, startingBalance: Number(startingBalance) },
  };
}

function ensureDir() {
  fs.mkdirSync(path.dirname(paperStatePath()), { recursive: true });
}

export function loadState() {
  const file = paperStatePath();
  ensureDir();
  if (!fs.existsSync(file)) {
    const state = freshState();
    saveState(state);
    return state;
  }
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Paper state is not valid JSON (${file}): ${e.message}`);
  }
  if (!state || state.version !== 1 || typeof state.cash !== 'number') {
    throw new Error(`Paper state has an unsupported shape (${file}); run paper_reset with confirm=RESET`);
  }
  state.positions ||= {};
  state.trades ||= [];
  state.orders ||= [];
  state.config = { ...PAPER_CONFIG, ...(state.config || {}) };
  return state;
}

export function saveState(state) {
  state.updatedAt = now();
  const file = paperStatePath();
  ensureDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function resetState(startingBalance = PAPER_CONFIG.startingBalance) {
  const state = freshState(Number(startingBalance) || PAPER_CONFIG.startingBalance);
  saveState(state);
  return state;
}

function fillPrice(price, side) {
  const bps = Number(loadStateConfig().slippageBps || PAPER_CONFIG.slippageBps) / 10000;
  return side === 'long' ? Number(price) * (1 + bps) : Number(price) * (1 - bps);
}

function loadStateConfig() {
  try {
    return loadState().config;
  } catch {
    return PAPER_CONFIG;
  }
}

function feeFor(notional, config) {
  return Math.abs(notional) * (Number(config.feeBps) / 10000);
}

export function marksFromSources(sources) {
  const marks = {};
  for (const [symbol, s] of Object.entries(sources || {})) {
    const v = Number(s.price);
    if (Number.isFinite(v) && v > 0) marks[symbol] = v;
  }
  return marks;
}

export function equity(state, marks = {}) {
  let value = Number(state.cash);
  for (const [symbol, pos] of Object.entries(state.positions)) {
    const mark = Number(marks[symbol] ?? pos.entryPrice);
    value += Number(pos.qty) * mark;
  }
  return value;
}

export function grossExposure(state, marks = {}) {
  let gross = 0;
  for (const [symbol, pos] of Object.entries(state.positions)) {
    const mark = Number(marks[symbol] ?? pos.entryPrice);
    gross += Math.abs(Number(pos.qty) * mark);
  }
  return gross;
}

export function accountSnapshot(state, marks = {}) {
  const positions = Object.entries(state.positions).map(([symbol, pos]) => {
    const mark = Number(marks[symbol] ?? pos.entryPrice);
    const pnl = (mark - Number(pos.entryPrice)) * Number(pos.qty);
    const notional = Math.abs(Number(pos.qty) * mark);
    return {
      symbol,
      side: pos.side,
      qty: Number(pos.qty),
      entryPrice: Number(pos.entryPrice),
      mark,
      stop: Number(pos.stop),
      target: Number(pos.target),
      notionalUSDT: Number(notional.toFixed(2)),
      unrealizedPnlUSDT: Number(pnl.toFixed(2)),
      unrealizedPnlPct: Number(((pnl / Math.max(1, Math.abs(Number(pos.qty) * Number(pos.entryPrice)))) * 100).toFixed(2)),
      openedAt: pos.openedAt,
      reason: pos.reason,
    };
  });
  const eq = equity(state, marks);
  const gross = grossExposure(state, marks);
  const unrealized = positions.reduce((a, p) => a + Number(p.unrealizedPnlUSDT || 0), 0);
  const unlevered = gross <= eq * 1.001;
  return {
    mode: 'paper',
    statePath: paperStatePath(),
    startingBalance: Number(state.startingBalance),
    cash: Number(state.cash.toFixed(2)),
    equity: Number(eq.toFixed(2)),
    realizedPnl: Number(state.realizedPnl.toFixed(2)),
    unrealizedPnl: Number(unrealized.toFixed(2)),
    totalReturnPct: Number((((eq - Number(state.startingBalance)) / Number(state.startingBalance)) * 100).toFixed(2)),
    feesPaid: Number(state.feesPaid.toFixed(2)),
    grossExposureUSDT: Number(gross.toFixed(2)),
    grossExposurePct: Number(((gross / Math.max(1, eq)) * 100).toFixed(2)),
    leverageLike: Number((gross / Math.max(1, eq)).toFixed(2)),
    noLeverage: unlevered,
    positions,
    openPositionCount: positions.length,
    updatedAt: state.updatedAt,
  };
}

export function openPosition(state, { symbol, side, price, stop, target, riskPct, maxPositionPct, notionalCapUSDT, reason = 'manual' }) {
  if (!['BTC', 'ETH'].includes(symbol)) throw new Error('Paper trading supports BTC and ETH only');
  if (!['long', 'short'].includes(side)) throw new Error('side must be long or short');
  if (state.positions[symbol]) throw new Error(`${symbol} already has an open paper position; close it first`);
  const mark = Number(price);
  if (!Number.isFinite(mark) || mark <= 0) throw new Error('price must be positive');
  const fill = fillPrice(mark, side);
  const stopN = Number(stop);
  const targetN = Number(target);
  if (!Number.isFinite(stopN) || stopN <= 0) throw new Error('stop must be positive');
  if (!Number.isFinite(targetN) || targetN <= 0) throw new Error('target must be positive');
  if (side === 'long' && !(stopN < fill && targetN > fill)) throw new Error('long requires stop < fill < target');
  if (side === 'short' && !(stopN > fill && targetN < fill)) throw new Error('short requires stop > fill > target');

  const eq = equity(state, { [symbol]: mark });
  const cfg = state.config;
  const riskBudget = eq * (Number(riskPct ?? cfg.riskPct) / 100);
  const riskPerUnit = Math.abs(fill - stopN);
  const maxNotional = eq * (Number(maxPositionPct ?? cfg.maxPositionPct) / 100);
  const qtyByRisk = riskBudget / riskPerUnit;
  const qtyByCap = maxNotional / fill;
  const qtyByNotional = Number.isFinite(Number(notionalCapUSDT)) && Number(notionalCapUSDT) > 0
    ? Number(notionalCapUSDT) / fill
    : Number.POSITIVE_INFINITY;
  const qty = Math.min(qtyByRisk, qtyByCap, qtyByNotional);
  if (!(qty > 0)) throw new Error('calculated paper quantity is zero');
  const notional = qty * fill;
  const fee = feeFor(notional, cfg);
  if (side === 'long') {
    if (state.cash < notional + fee) throw new Error('paper cash is insufficient for this long');
    state.cash -= notional + fee;
  } else {
    state.cash += notional - fee;
  }
  state.feesPaid += fee;
  const order = {
    id: crypto.randomUUID(),
    ts: now(),
    type: 'open',
    symbol,
    side,
    qty: Number(qty.toFixed(6)),
    price: Number(fill.toFixed(2)),
    notionalUSDT: Number(notional.toFixed(2)),
    feeUSDT: Number(fee.toFixed(2)),
    stop: Number(stopN.toFixed(2)),
    target: Number(targetN.toFixed(2)),
    riskUSDT: Number((qty * riskPerUnit).toFixed(2)),
    reason,
  };
  state.positions[symbol] = {
    symbol,
    side,
    qty: side === 'long' ? order.qty : -order.qty,
    entryPrice: order.price,
    entryFee: order.feeUSDT,
    stop: order.stop,
    target: order.target,
    openedAt: order.ts,
    reason,
  };
  state.orders.push(order);
  saveState(state);
  return order;
}

export function closePosition(state, { symbol, price, reason = 'manual' }) {
  const pos = state.positions[symbol];
  if (!pos) throw new Error(`No open paper position for ${symbol}`);
  const mark = Number(price);
  if (!Number.isFinite(mark) || mark <= 0) throw new Error('price must be positive');
  const fill = fillPrice(mark, pos.side === 'long' ? 'short' : 'long');
  const absQty = Math.abs(Number(pos.qty));
  const notional = absQty * fill;
  const fee = feeFor(notional, state.config);
  let pnl;
  if (pos.side === 'long') {
    state.cash += notional - fee;
    pnl = (fill - Number(pos.entryPrice)) * absQty - Number(pos.entryFee) - fee;
  } else {
    state.cash -= notional + fee;
    pnl = (Number(pos.entryPrice) - fill) * absQty - Number(pos.entryFee) - fee;
  }
  state.feesPaid += fee;
  state.realizedPnl += pnl;
  const trade = {
    id: crypto.randomUUID(),
    symbol,
    side: pos.side,
    qty: Number(absQty.toFixed(6)),
    entryPrice: Number(pos.entryPrice),
    exitPrice: Number(fill.toFixed(2)),
    notionalUSDT: Number(notional.toFixed(2)),
    pnlUSDT: Number(pnl.toFixed(2)),
    pnlPct: Number(((pnl / Math.max(1, absQty * Number(pos.entryPrice))) * 100).toFixed(2)),
    feeUSDT: Number((Number(pos.entryFee) + fee).toFixed(2)),
    openedAt: pos.openedAt,
    closedAt: now(),
    reason,
  };
  state.trades.push(trade);
  state.orders.push({ id: trade.id, ts: trade.closedAt, type: 'close', symbol, side: pos.side, qty: trade.qty, price: trade.exitPrice, feeUSDT: trade.feeUSDT, pnlUSDT: trade.pnlUSDT, reason });
  delete state.positions[symbol];
  saveState(state);
  return trade;
}

function checkTrigger(execution, mark) {
  if (!execution || execution.direction === 'neutral' || execution.entryType === 'none') return false;
  const [lo, hi] = execution.entryZone || [];
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
  if (execution.direction === 'long') {
    return mark <= hi && mark >= execution.stop;
  }
  return mark >= lo && mark <= execution.stop;
}

export function autoTrade(state, decision, marks = {}) {
  const actions = [];
  // 1) Protective exits first.
  for (const [symbol, pos] of Object.entries(state.positions)) {
    const mark = Number(marks[symbol] ?? pos.entryPrice);
    const hitStop = pos.side === 'long' ? mark <= Number(pos.stop) : mark >= Number(pos.stop);
    const hitTarget = pos.side === 'long' ? mark >= Number(pos.target) : mark <= Number(pos.target);
    if (hitStop || hitTarget) {
      const trade = closePosition(state, { symbol, price: mark, reason: hitStop ? 'stop' : 'target' });
      actions.push({ action: 'close', symbol, side: pos.side, reason: hitStop ? 'stop' : 'target', trade });
    } else {
      actions.push({ action: 'hold', symbol, side: pos.side, mark, stop: pos.stop, target: pos.target });
    }
  }
  // 2) New entries only when the TradingAgents plan has a machine-readable level.
  for (const symbol of ['BTC', 'ETH']) {
    if (state.positions[symbol]) continue;
    const execution = decision?.[symbol]?.execution;
    const mark = Number(marks[symbol]);
    if (!Number.isFinite(mark)) {
      actions.push({ action: 'skip', symbol, reason: 'no mark price' });
      continue;
    }
    if (!checkTrigger(execution, mark)) {
      actions.push({
        action: 'wait',
        symbol,
        reason: execution?.direction === 'neutral' ? 'rating is Hold' : `price ${mark} is outside the ${execution?.direction || 'n/a'} entry zone`,
        entryZone: execution?.entryZone || null,
      });
      continue;
    }
    try {
      const order = openPosition(state, {
        symbol,
        side: execution.direction,
        price: mark,
        stop: execution.stop,
        target: execution.targets?.[0],
        riskPct: state.config.riskPct,
        maxPositionPct: state.config.maxPositionPct,
        reason: 'tradingagents-signal',
      });
      actions.push({ action: 'open', symbol, side: execution.direction, order });
    } catch (e) {
      actions.push({ action: 'reject', symbol, side: execution.direction, reason: e.message });
    }
  }
  saveState(state);
  return { actions, account: accountSnapshot(state, marks) };
}

export function history(state, limit = 50) {
  const trades = (state.trades || []).slice(-Math.max(1, Math.min(200, Number(limit) || 50))).reverse();
  const wins = trades.filter((t) => t.pnlUSDT > 0).length;
  const total = trades.reduce((a, t) => a + Number(t.pnlUSDT || 0), 0);
  return {
    count: trades.length,
    wins,
    winRatePct: trades.length ? Number(((wins / trades.length) * 100).toFixed(1)) : null,
    totalPnlUSDT: Number(total.toFixed(2)),
    trades,
    orders: (state.orders || []).slice(-Math.max(1, limit * 2)).reverse(),
  };
}
