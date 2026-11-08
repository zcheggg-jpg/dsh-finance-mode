// Execution layer: spot sell + exchange-side protective orders (OCO).
// Reuses signing from okx-live.mjs. Live trading still requires OKX_TRADING_ENABLED=1,
// trade-only keys, and is long-only spot. Nothing here runs unattended.
//
// IMPORTANT: order placement paths are UNVERIFIED against the live API until the
// operator configures keys and a dry-run/canary check is done.

import https from 'node:https';
import { request, liveStatus } from '../okx-live.mjs';

const BASE_HOST = 'www.okx.com';
const specCache = new Map();
const SPEC_TTL_MS = 10 * 60 * 1000;

function publicGet(pathname, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: BASE_HOST, path: pathname, method: 'GET', timeout: timeoutMs, headers: { accept: 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            const json = JSON.parse(text);
            if (json.code !== '0') return reject(new Error(`OKX ${json.code}: ${json.msg}`));
            resolve(json.data);
          } catch {
            reject(new Error(`non-JSON response: ${text.slice(0, 120)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('OKX public request timeout')));
    req.on('error', reject);
    req.end();
  });
}

export async function getSpecs(instId, { fresh = false } = {}) {
  const key = String(instId).toUpperCase();
  const hit = specCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < SPEC_TTL_MS) return hit.spec;
  const rows = await publicGet(`/api/v5/public/instruments?instType=SPOT&instId=${encodeURIComponent(key)}`);
  const row = rows?.[0];
  if (!row) throw new Error(`no instrument spec for ${key}`);
  const spec = {
    instId: row.instId,
    state: row.state,
    tickSz: Number(row.tickSz),
    lotSz: Number(row.lotSz),
    minSz: Number(row.minSz),
  };
  specCache.set(key, { at: Date.now(), spec });
  return spec;
}

/** Decimals implied by a step, including scientific notation (1e-8 -> 8). */
function stepDecimals(step) {
  const str = String(step);
  if (str.includes('e-')) return Number(str.split('e-')[1]);
  const frac = str.split('.')[1];
  return frac ? frac.length : 0;
}

/** Floor a number to a step without floating-point drift (BTC lotSz is 1e-8). */
export function floorToStep(value, step) {
  const v = Number(value);
  const s = Number(step);
  if (!(s > 0) || !Number.isFinite(v)) throw new Error('floorToStep requires positive step and finite value');
  const decimals = stepDecimals(s);
  const units = Math.floor(v / s + 1e-9);
  return Number((units * s).toFixed(Math.min(decimals, 12)));
}

export function makeClOrdId(prefix = 'dsh') {
  const id = `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
}

/**
 * Pure builder for spot order bodies. `spec` is required for quantisation and
 * makes the function testable without network access.
 */
export function buildSpotOrder({ instId, side, ordType = 'limit', px = null, sz, clOrdId, spec }) {
  const inst = String(instId).toUpperCase();
  if (!['buy', 'sell'].includes(side)) throw new Error("side must be 'buy' or 'sell'");
  if (!spec) throw new Error('spec {tickSz, lotSz, minSz} is required');
  const qty = floorToStep(sz, spec.lotSz);
  if (!(qty > 0)) throw new Error('size rounds to zero');
  if (qty < spec.minSz) throw new Error(`size ${qty} is below minSz ${spec.minSz} for ${inst}`);
  const body = { instId: inst, tdMode: 'cash', side, ordType };
  if (ordType === 'limit') {
    const price = floorToStep(px, spec.tickSz);
    if (!(price > 0)) throw new Error('limit order requires a positive px');
    body.px = String(price);
    body.sz = String(qty);
  } else if (ordType === 'market') {
    body.sz = String(qty);
  } else {
    throw new Error(`unsupported ordType ${ordType}`);
  }
  if (clOrdId) body.clOrdId = makeClOrdId(clOrdId);
  return body;
}

/**
 * Spot OCO: attach a stop-loss and take-profit to an existing long.
 * Returns two legs so the position can never be left unprotected by a single leg.
 */
export function buildOcoBody({ instId, sz, slTriggerPx, tpTriggerPx, spec }) {
  const inst = String(instId).toUpperCase();
  if (!spec) throw new Error('spec is required');
  const qty = floorToStep(sz, spec.lotSz);
  if (!(qty > 0) || qty < spec.minSz) throw new Error(`OCO size ${qty} below minSz ${spec.minSz}`);
  const sl = floorToStep(slTriggerPx, spec.tickSz);
  const tp = floorToStep(tpTriggerPx, spec.tickSz);
  if (!(sl > 0) || !(tp > 0)) throw new Error('OCO needs positive slTriggerPx and tpTriggerPx');
  if (!(sl < tp)) throw new Error('OCO requires slTriggerPx < tpTriggerPx for a long exit');
  return {
    instId: inst,
    tdMode: 'cash',
    side: 'sell',
    ordType: 'oco',
    sz: String(qty),
    slTriggerPx: String(sl),
    slOrdPx: '-1',   // -1 = market on trigger
    tpTriggerPx: String(tp),
    tpOrdPx: '-1',
  };
}

function assertLive() {
  const st = liveStatus();
  if (!st.enabled) throw new Error('Live trading is disabled. Set OKX_TRADING_ENABLED=1 and use confirm="LIVE".');
  if (!st.keysConfigured) throw new Error('OKX API credentials are not configured');
  if (!st.spotOnly || !st.longOnly) throw new Error('execution layer only supports long-only spot');
  return st;
}

export async function getBaseBalance(instId) {
  const ccy = String(instId).split('-')[0].toUpperCase();
  const data = await request('GET', `/api/v5/account/balance?ccy=${encodeURIComponent(ccy)}`);
  const detail = data?.[0]?.details?.find((d) => d.ccy === ccy);
  return {
    ccy,
    available: Number(detail?.availBal ?? 0),
    frozen: Number(detail?.frozenBal ?? 0),
    cash: Number(detail?.cashBal ?? 0),
  };
}

/** Sell spot. Market when px is null, otherwise limit. Never exceeds held balance. */
export async function placeSpotSell({ instId, sz, px = null }) {
  const st = assertLive();
  if (!st.allowedInstruments.includes(String(instId).toUpperCase())) throw new Error(`${instId} not allowed`);
  const spec = await getSpecs(instId);
  const bal = await getBaseBalance(instId);
  const qty = floorToStep(sz, spec.lotSz);
  if (!(qty > 0)) throw new Error('sell size rounds to zero');
  if (qty > bal.available + 1e-12) {
    throw new Error(`sell size ${qty} exceeds available ${bal.available} ${bal.ccy}`);
  }
  const body = buildSpotOrder({ instId, side: 'sell', ordType: px == null ? 'market' : 'limit', px, sz, spec });
  const data = await request('POST', '/api/v5/trade/order', JSON.stringify(body));
  const order = data?.[0];
  if (!order || order.sCode !== '0') throw new Error(`OKX sell rejected: ${order?.sCode || 'unknown'} ${order?.sMsg || ''}`);
  return { ...order, requestedQty: qty, availableBefore: bal.available };
}

/**
 * Attach exchange-side OCO. Survives process crash / disconnect, unlike a local
 * stop loop. `last` is the latest price, used to sanity-check trigger placement.
 */
export async function placeOcoStop({ instId, sz, slTriggerPx, tpTriggerPx, last = null }) {
  const st = assertLive();
  if (!st.allowedInstruments.includes(String(instId).toUpperCase())) throw new Error(`${instId} not allowed`);
  const spec = await getSpecs(instId);
  const bal = await getBaseBalance(instId);
  const body = buildOcoBody({ instId, sz, slTriggerPx, tpTriggerPx, spec });
  const qty = Number(body.sz);
  if (qty > bal.available + 1e-12) throw new Error(`OCO size ${qty} exceeds available ${bal.available}`);
  if (Number.isFinite(Number(last))) {
    const px = Number(last);
    if (!(Number(body.slTriggerPx) < px)) throw new Error(`stop ${body.slTriggerPx} is not below last ${px}`);
    if (!(Number(body.tpTriggerPx) > px)) throw new Error(`target ${body.tpTriggerPx} is not above last ${px}`);
  }
  const data = await request('POST', '/api/v5/trade/order-algo', JSON.stringify(body));
  const algo = data?.[0];
  if (!algo || algo.sCode !== '0') throw new Error(`OKX OCO rejected: ${algo?.sCode || 'unknown'} ${algo?.sMsg || ''}`);
  return { ...algo, body, availableBefore: bal.available };
}

export async function cancelAlgo({ instId, algoId }) {
  assertLive();
  const body = JSON.stringify([{ instId, algoId }]);
  const data = await request('POST', '/api/v5/trade/cancel-algos', body);
  return data?.[0];
}

export async function listAlgo({ instId, ordType = 'oco' } = {}) {
  assertLive();
  const qs = new URLSearchParams({ ordType, instId: instId || '' });
  const data = await request('GET', `/api/v5/trade/orders-algo-pending?${qs.toString()}`);
  return data || [];
}

/**
 * Full entry loop: place the buy, wait for an actual fill, then attach the OCO.
 * A buy that never fills is reported as unprotected — never as success.
 * dryRun=true builds and returns the plan without touching the exchange.
 */
export async function openWithProtection({ instId, px, sz, slTriggerPx, tpTriggerPx, fillTimeoutMs = 60000, pollMs = 3000, dryRun = true }) {
  const spec = await getSpecs(instId);
  const buyBody = buildSpotOrder({ instId, side: 'buy', ordType: 'limit', px, sz, clOrdId: 'dsh', spec });
  const ocoBody = buildOcoBody({ instId, sz: buyBody.sz, slTriggerPx, tpTriggerPx, spec });

  if (dryRun) {
    return { dryRun: true, steps: [
      { step: 'limit-buy', body: buyBody },
      { step: 'wait-fill', timeoutMs: fillTimeoutMs, pollMs },
      { step: 'attach-oco', body: { ...ocoBody, sz: '<filledQty>' } },
    ], note: 'No OKX request was sent (dryRun).' };
  }

  assertLive();
  const buyRes = await request('POST', '/api/v5/trade/order', JSON.stringify(buyBody));
  const order = buyRes?.[0];
  if (!order || order.sCode !== '0') throw new Error(`OKX buy rejected: ${order?.sCode || 'unknown'} ${order?.sMsg || ''}`);

  const deadline = Date.now() + fillTimeoutMs;
  let filled = 0;
  let lastState = 'live';
  while (Date.now() < deadline) {
    const st = await request('GET', `/api/v5/trade/order?instId=${encodeURIComponent(instId)}&clOrdId=${encodeURIComponent(order.clOrdId)}`);
    const row = st?.[0];
    if (!row) break;
    lastState = row.state;
    filled = Number(row.accFillSz || 0);
    if (lastState === 'filled' || lastState === 'canceled' || lastState === 'mmp_canceled') break;
    if (filled > 0 && lastState === 'partially_filled') { /* keep waiting for the rest */ }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  if (!(filled > 0)) {
    return { order, filledQty: 0, state: lastState, oco: null, warning: 'NO FILL — position is empty and UNPROTECTED. Cancel or retry manually.' };
  }

  const oco = await placeOcoStop({ instId, sz: filled, slTriggerPx, tpTriggerPx, last: px });
  return {
    order,
    filledQty: filled,
    state: lastState,
    oco,
    warning: lastState === 'partially_filled' ? 'partial fill: OCO covers filled qty only' : undefined,
  };
}

/**
 * Full exit loop: cancel protective algo orders first, then sell.
 * Cancelling first avoids two exits racing each other (OCO firing after the sell).
 */
export async function closeProtected({ instId, sz = null, px = null, dryRun = true }) {
  const spec = await getSpecs(instId);
  if (dryRun) {
    return {
      dryRun: true,
      steps: [
        { step: 'cancel-oco', instId },
        { step: px == null ? 'market-sell' : 'limit-sell', sz: sz ?? '<available>', px: px ?? null },
      ],
      note: 'No OKX request was sent (dryRun).',
    };
  }
  assertLive();
  const open = await listAlgo({ instId });
  const cancelled = [];
  for (const a of open) cancelled.push(await cancelAlgo({ instId, algoId: a.algoId }));
  const bal = await getBaseBalance(instId);
  const qty = sz != null ? floorToStep(sz, spec.lotSz) : floorToStep(bal.available, spec.lotSz);
  if (!(qty > 0)) throw new Error('nothing to sell (available balance rounds to zero)');
  const sell = await placeSpotSell({ instId, sz: qty, px });
  return { cancelledAlgos: cancelled.length, sell };
}
