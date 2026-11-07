// Guarded OKX spot execution adapter. Live trading is disabled unless the
// operator explicitly enables it, supplies trade-only API keys, and passes
// confirm="LIVE". The default product path remains analysis + paper trading.

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://www.okx.com';

function numEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function liveStatus() {
  const allowed = String(process.env.OKX_ALLOWED_INSTRUMENTS || 'BTC-USDT,ETH-USDT')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return {
    mode: 'okx-spot-live',
    enabled: process.env.OKX_TRADING_ENABLED === '1',
    keysConfigured: Boolean(process.env.OKX_API_KEY && process.env.OKX_API_SECRET && process.env.OKX_API_PASSPHRASE),
    allowedInstruments: allowed,
    maxOrderUSDT: numEnv('OKX_MAX_ORDER_USDT', 100),
    maxDailyUSDT: numEnv('OKX_MAX_DAILY_USDT', 300),
    maxPositionPct: numEnv('OKX_MAX_POSITION_PCT', 25),
    orderType: 'limit',
    spotOnly: true,
    longOnly: true,
    requiresConfirm: 'LIVE',
    staleDataRejected: true,
    autoExit: false,
    statePath: liveStatePath(),
    note: 'Live spot entries only. No unattended stop-loss/take-profit loop is included; exits remain manual until a separate runner is tested.',
  };
}

export function liveStatePath() {
  return path.resolve(process.env.OKX_LIVE_STATE || path.join(ROOT, 'live', 'state.json'));
}

function loadLiveState() {
  const file = liveStatePath();
  const today = new Date().toISOString().slice(0, 10);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    state = null;
  }
  if (!state || state.date !== today) {
    state = { date: today, notionalUSDT: 0, orders: [] };
  }
  state.orders ||= [];
  return state;
}

function saveLiveState(state) {
  const file = liveStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function dailyUsage() {
  const state = loadLiveState();
  const status = liveStatus();
  return {
    date: state.date,
    notionalUSDT: Number(Number(state.notionalUSDT || 0).toFixed(2)),
    remainingUSDT: Number(Math.max(0, status.maxDailyUSDT - Number(state.notionalUSDT || 0)).toFixed(2)),
    orders: state.orders.slice(-20),
    maxDailyUSDT: status.maxDailyUSDT,
  };
}

function assertLiveConfig() {
  const status = liveStatus();
  if (!status.enabled) throw new Error('Live trading is disabled. Set OKX_TRADING_ENABLED=1 and use confirm="LIVE".');
  if (!status.keysConfigured) throw new Error('OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE are not configured');
  return status;
}

function request(method, requestPath, body = '') {
  const key = process.env.OKX_API_KEY;
  const secret = process.env.OKX_API_SECRET;
  const passphrase = process.env.OKX_API_PASSPHRASE;
  if (!key || !secret || !passphrase) throw new Error('OKX API credentials are not configured');
  const timestamp = new Date().toISOString();
  const prehash = `${timestamp}${method}${requestPath}${body}`;
  const sign = crypto.createHmac('sha256', secret).update(prehash).digest('base64');
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'www.okx.com',
        path: requestPath,
        method,
        headers: {
          'OK-ACCESS-KEY': key,
          'OK-ACCESS-SIGN': sign,
          'OK-ACCESS-TIMESTAMP': timestamp,
          'OK-ACCESS-PASSPHRASE': passphrase,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'dsh-okx-tradingagents/1.4',
          ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
        },
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            return reject(new Error(`OKX returned non-JSON (${text.slice(0, 120)})`));
          }
          if (json.code !== '0') return reject(new Error(`OKX ${json.code}: ${json.msg}`));
          resolve(json.data);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('OKX live request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function getUsdtBalance() {
  const data = await request('GET', '/api/v5/account/balance?ccy=USDT');
  const details = data?.[0]?.details || [];
  const usdt = details.find((d) => d.ccy === 'USDT');
  return {
    totalEq: data?.[0]?.totalEq,
    usdt: usdt ? { available: Number(usdt.availBal), frozen: Number(usdt.frozenBal), cash: Number(usdt.cashBal) } : null,
  };
}

export async function getTicker(instId) {
  const data = await request('GET', `/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`);
  const t = data?.[0];
  if (!t) throw new Error(`No ticker for ${instId}`);
  return { instId: t.instId, last: Number(t.last), bid: Number(t.bidPx), ask: Number(t.askPx), ts: Number(t.ts) };
}

export async function placeSpotLimitBuy({ instId, px, sz, clOrdId }) {
  const status = assertLiveConfig();
  if (!status.allowedInstruments.includes(String(instId).toUpperCase())) {
    throw new Error(`${instId} is not in OKX_ALLOWED_INSTRUMENTS`);
  }
  if (!(Number(px) > 0) || !(Number(sz) > 0)) throw new Error('px and sz must be positive');
  const body = JSON.stringify({
    instId,
    tdMode: 'cash',
    side: 'buy',
    ordType: 'limit',
    px: Number(px).toFixed(2),
    sz: Number(sz).toFixed(6),
    clOrdId,
  });
  const data = await request('POST', '/api/v5/trade/order', body);
  const order = data?.[0];
  if (!order || order.sCode !== '0') throw new Error(`OKX order rejected: ${order?.sCode || 'unknown'} ${order?.sMsg || ''}`);
  const state = loadLiveState();
  const notional = Number(px) * Number(sz);
  state.notionalUSDT = Number(state.notionalUSDT || 0) + notional;
  state.orders.push({
    ts: new Date().toISOString(),
    instId,
    side: 'buy',
    px: Number(px),
    sz: Number(sz),
    notionalUSDT: Number(notional.toFixed(2)),
    ordId: order.ordId,
    clOrdId: order.clOrdId,
    status: 'submitted',
  });
  saveLiveState(state);
  return order;
}

export async function cancelSpotOrder({ instId, ordId }) {
  assertLiveConfig();
  const body = JSON.stringify({ instId, ordId });
  const data = await request('POST', '/api/v5/trade/cancel-order', body);
  return data?.[0];
}

export async function getSpotOrder({ instId, clOrdId }) {
  assertLiveConfig();
  const pathname = `/api/v5/trade/order?instId=${encodeURIComponent(instId)}&clOrdId=${encodeURIComponent(clOrdId)}`;
  const data = await request('GET', pathname);
  return data?.[0];
}
