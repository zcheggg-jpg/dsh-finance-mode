// OKX paginated history fetch + local JSONL cache.
// Read-only: only hits /api/v5/market/history-candles. No auth, no orders.

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = 'https://www.okx.com';
const CACHE_DIR = process.env.OKX_QUANT_DIR
  || path.join(os.homedir(), '.dsh', 'okx-tradingagents', 'quant');

function httpGetJson(pathname, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'www.okx.com', path: pathname, method: 'GET', headers: { accept: 'application/json' }, timeout: timeoutMs },
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
            reject(new Error(`non-JSON response (${text.slice(0, 120)})`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('OKX request timeout')));
    req.on('error', reject);
    req.end();
  });
}

export function candleCachePath(instId, bar) {
  return path.join(CACHE_DIR, `candles-${instId}-${bar}.jsonl`);
}

function readCache(instId, bar) {
  const file = candleCachePath(instId, bar);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  return out;
}

function writeCache(instId, bar, bars) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = candleCachePath(instId, bar);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bars.map((b) => JSON.stringify(b)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

const toBar = (row) => ({
  ts: Number(row[0]),
  time: new Date(Number(row[0])).toISOString(),
  open: Number(row[1]),
  high: Number(row[2]),
  low: Number(row[3]),
  close: Number(row[4]),
  volume: Number(row[5]),
  confirm: row[8],
});

/**
 * Fetch up to `totalBars` closed candles, paginating via the `after` cursor.
 * Returns ascending-by-ts array of closed bars only.
 */
export async function fetchHistory(instId, { bar = '1D', totalBars = 1500, useCache = true } = {}) {
  const byTs = new Map();
  if (useCache) {
    for (const b of readCache(instId, bar)) byTs.set(b.ts, b);
  }
  let cursor = null;
  let guard = 0;
  while (byTs.size < totalBars && guard < 60) {
    guard += 1;
    const qs = new URLSearchParams({ instId, bar, limit: '100' });
    const oldest = [...byTs.keys()].sort((a, b) => a - b)[0];
    if (cursor != null) qs.set('after', String(cursor));
    else if (oldest != null) qs.set('after', String(oldest));
    const rows = await httpGetJson(`/api/v5/market/history-candles?${qs.toString()}`);
    if (!Array.isArray(rows) || rows.length === 0) break;
    let added = 0;
    for (const row of rows) {
      const b = toBar(row);
      if (b.confirm !== '1') continue;          // closed bars only
      if (!Number.isFinite(b.close) || b.close <= 0) continue;
      if (!byTs.has(b.ts)) { byTs.set(b.ts, b); added += 1; }
      cursor = Math.min(cursor == null ? b.ts : cursor, b.ts);
    }
    if (added === 0) break;                      // no progress → stop
  }
  const bars = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  const sliced = bars.slice(-totalBars);
  if (useCache) writeCache(instId, bar, sliced);
  return sliced;
}

export { CACHE_DIR };
