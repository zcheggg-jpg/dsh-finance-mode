// Market-data adapters: OKX public REST first, Stooq public quote/history as
// a reachable fallback, and a bundled last-known snapshot as a final resort.
// No API keys are required for any of these read-only paths.

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SNAPSHOT_PATH = path.join(ROOT, 'data', 'snapshot.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const STOOQ_BASE = 'https://stooq.com';
const STOOQ_SYMBOLS = { BTC: 'btcusd', ETH: 'eth.v' };
const OKX_INST = { BTC: 'BTC-USDT', ETH: 'ETH-USDT' };

let stooqCookie = '';
const stooqQuoteCache = new Map();
let okxDownUntil = 0;
let stooqDownUntil = 0;
const cache = new Map();

function log(...args) {
  process.stderr.write(`[okx-ta] ${args.join(' ')}\n`);
}

function requestText(url, { method = 'GET', headers = {}, body, timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const setCookie = res.headers['set-cookie'] || [];
        if (setCookie.length) {
          stooqCookie = setCookie.map((v) => v.split(';')[0]).join('; ');
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function stooqGet(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (stooqCookie) headers.cookie = stooqCookie;
  return requestText(url, { ...options, headers });
}

async function verifyStooq(pageUrl, html) {
  const m = html.match(/const c="([^"]+)",d=(\d+)/);
  if (!m) return html;
  const challenge = m[1];
  const difficulty = Number(m[2]);
  const target = '0'.repeat(difficulty);
  let nonce = 0;
  while (nonce < 5_000_000) {
    const digest = crypto.createHash('sha256').update(challenge + nonce).digest('hex');
    if (digest.startsWith(target)) break;
    nonce++;
  }
  if (nonce >= 5_000_000) throw new Error('Stooq proof-of-work did not converge');
  const body = `c=${encodeURIComponent(challenge)}&n=${nonce}`;
  await stooqGet(`${STOOQ_BASE}/__verify`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      referer: pageUrl,
    },
    body,
  });
  const again = await stooqGet(pageUrl);
  return again.text;
}

async function stooqPage(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await stooqGet(url, { timeoutMs: 15000 });
    if (res.status === 403) {
      // Rate limited. Back off briefly; a new challenge usually clears it.
      await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
      stooqCookie = '';
      continue;
    }
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (res.status >= 400) throw new Error(`Stooq HTTP ${res.status} for ${url}`);
    if (res.text.includes('Exceeded the daily site hits limit')) {
      stooqDownUntil = Date.now() + 6 * 60 * 60 * 1000;
      throw new Error('Stooq daily history quota exhausted');
    }
    if (res.text.includes('const c="')) {
      const html = await verifyStooq(url, res.text);
      if (html.includes('const c="')) throw new Error('Stooq verification did not clear');
      return html;
    }
    return res.text;
  }
  throw new Error(`Stooq unavailable after retries for ${url}`);
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function toNumber(value) {
  if (value == null) return null;
  const cleaned = String(value).replace(/,/g, '').replace(/%/g, '').trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseStooqDate(text) {
  const m = text.match(/(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{4})/);
  if (!m) return null;
  const months = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  const month = months[m[2]];
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseStooqQuote(html, stooqSymbol) {
  const id = escapeRegex(stooqSymbol);
  const field = (suffix) => {
    const re = new RegExp(`id=aq_${id}_${suffix}[^>]*>([^<]+)`, 'i');
    return html.match(re)?.[1]?.trim() ?? null;
  };
  const price =
    toNumber(field('c1(?:\\|3)?')) ??
    toNumber(field('c2(?:\\|3)?')) ??
    toNumber(html.match(new RegExp(`id=aq_${id}_c[12](?:\\|3)?>([\\d.,]+)`, 'i'))?.[1]);
  const date = field('d2');
  const time = field('t1');
  const changePctMatch = html.match(new RegExp(`id=aq_${id}_m3>\\(([+-]?[\\d.]+%)`, 'i'));
  const changeAbsMatch = html.match(new RegExp(`id=aq_${id}_m2>([+-]?[\\d.,]+)`, 'i'));
  const changePct = changePctMatch ? toNumber(changePctMatch[1]) : null;
  const high52Match = html.match(/52W High\/Low[\s\S]{0,180}?([\d.]+)\s*<br>\s*([\d.]+)/i);
  const title = html.match(/<title>(.*?)<\/title>/i)?.[1]?.trim() ?? null;
  return {
    symbol: stooqSymbol,
    name: title ? title.replace(/\s*\([+-]?[\d.]+%\).*$/, '').trim() : stooqSymbol,
    price: price ?? toNumber(field('c1')),
    date,
    time,
    quoteTime: date && time ? `${date}T${time}` : date,
    changePct,
    changeAbs: changeAbsMatch ? toNumber(changeAbsMatch[1]) : null,
    open: toNumber(field('o')),
    high: toNumber(field('h')),
    low: toNumber(field('l')),
    prevClose: toNumber(field('p')),
    high52w: high52Match ? toNumber(high52Match[1]) : null,
    low52w: high52Match ? toNumber(high52Match[2]) : null,
  };
}

function parseStooqHistory(html) {
  const text = stripHtml(html);
  const rows = [];
  const re = /(\d{1,6})\s+(\d{1,2} [A-Z][a-z]{2} \d{4})\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([+-]?[\d.]+%)\s+([+-]?[\d.]+)(?:\s+([\d,]+))?/g;
  for (const m of text.matchAll(re)) {
    const time = parseStooqDate(m[2]);
    if (!time) continue;
    rows.push({
      time,
      open: Number(m[3]),
      high: Number(m[4]),
      low: Number(m[5]),
      close: Number(m[6]),
      volume: m[9] ? toNumber(m[9]) : null,
    });
  }
  const byDate = new Map();
  for (const row of rows) byDate.set(row.time, row);
  return [...byDate.values()].sort((a, b) => a.time.localeCompare(b.time));
}

async function fetchStooq(symbol, pages = 4) {
  const stooqSymbol = STOOQ_SYMBOLS[symbol];
  if (!stooqSymbol) throw new Error(`Unsupported symbol ${symbol}`);
  if (!stooqQuoteCache.has(stooqSymbol)) {
    const pending = stooqPage(`${STOOQ_BASE}/q/?s=${encodeURIComponent(stooqSymbol)}`).catch((e) => {
      stooqQuoteCache.delete(stooqSymbol);
      throw e;
    });
    stooqQuoteCache.set(stooqSymbol, pending);
  }
  const quoteHtml = await stooqQuoteCache.get(stooqSymbol);
  const quote = parseStooqQuote(quoteHtml, stooqSymbol);
  if (quote.price == null) throw new Error(`Stooq quote for ${stooqSymbol} did not contain a price`);

  const all = [];
  for (let page = 1; page <= Math.max(1, Math.min(8, pages)); page++) {
    const url = page === 1
      ? `${STOOQ_BASE}/q/d/?s=${encodeURIComponent(stooqSymbol)}`
      : `${STOOQ_BASE}/q/d/?s=${encodeURIComponent(stooqSymbol)}&i=d&l=${page}`;
    const html = await stooqPage(url);
    const rows = parseStooqHistory(html);
    if (!rows.length) break;
    all.push(...rows);
    if (page < pages) await new Promise((r) => setTimeout(r, 250));
  }
  const byDate = new Map();
  for (const row of all) byDate.set(row.time, row);
  let candles = [...byDate.values()].sort((a, b) => a.time.localeCompare(b.time));

  // The quote can be fresher than the last downloaded daily row (weekends,
  // half sessions). Add it only when it represents a newer date.
  const quoteDate = quote.date?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? quote.date;
  if (quoteDate && (!candles.length || quoteDate > candles.at(-1).time)) {
    candles.push({
      time: quoteDate,
      open: quote.open ?? quote.price,
      high: quote.high ?? quote.price,
      low: quote.low ?? quote.price,
      close: quote.price,
      volume: null,
    });
  }
  if (candles.length < 30) throw new Error(`Stooq history for ${stooqSymbol} returned only ${candles.length} rows`);

  return {
    symbol,
    source: 'Stooq public quote/history (OKX fallback)',
    sourceUrl: `${STOOQ_BASE}/q/?s=${encodeURIComponent(stooqSymbol)}`,
    price: quote.price,
    quoteTime: quote.quoteTime,
    quote: {
      price: quote.price,
      quoteTime: quote.quoteTime,
      change24hPct: quote.changePct,
      open24h: quote.open,
      high24h: quote.high,
      low24h: quote.low,
      prevClose: quote.prevClose,
      high52w: quote.high52w,
      low52w: quote.low52w,
    },
    candles,
    stale: isQuoteStale(quote.quoteTime),
    quoteAgeHours: Number(((quoteAgeMs(quote.quoteTime) ?? Number.NaN) / 3600000).toFixed(1)),
  };
}

/** Quote age helpers. A fallback quote is only trustworthy if it is recent;
 *  reporting stale:false on a two-day-old price is how a strategy buys the wrong level. */
export function quoteAgeMs(quoteTime) {
  const t = Date.parse(String(quoteTime || ''));
  if (!Number.isFinite(t)) return null;
  return Date.now() - t;
}

export function isQuoteStale(quoteTime, maxAgeMs = 36 * 3600 * 1000) {
  const age = quoteAgeMs(quoteTime);
  if (age == null) return true;          // unparseable timestamp → do not trust
  if (age < -2 * 3600 * 1000) return true; // "future" by >2h → clock/format mismatch
  return age > maxAgeMs;
}
function okxRequest(pathname, { timeoutMs = 4500 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(`https://www.okx.com${pathname}`);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'user-agent': UA, accept: 'application/json' },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) return reject(new Error(`OKX HTTP ${res.statusCode}`));
          try {
            const json = JSON.parse(text);
            if (json.code && json.code !== '0') return reject(new Error(`OKX code ${json.code}: ${json.msg}`));
            resolve(json);
          } catch (e) {
            reject(new Error(`OKX returned non-JSON (${text.slice(0, 80)})`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('OKX request timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchOkx(symbol) {
  if (process.env.OKX_DISABLED === '1') throw new Error('OKX disabled by OKX_DISABLED=1');
  if (Date.now() < okxDownUntil) throw new Error('OKX circuit breaker open');
  const instId = OKX_INST[symbol];
  try {
    const [ticker, candles] = await Promise.all([
      okxRequest(`/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`),
      okxRequest(`/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=1D&limit=300`),
    ]);
    const t = ticker.data?.[0];
    const rows = (candles.data || []).map((r) => ({
      time: new Date(Number(r[0])).toISOString().slice(0, 10),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
    })).sort((a, b) => a.time.localeCompare(b.time));
    if (!t || rows.length < 30) throw new Error('OKX returned incomplete ticker/candles');
    return {
      symbol,
      source: 'OKX public REST',
      sourceUrl: `https://www.okx.com/trade-spot/${instId.toLowerCase()}`,
      price: Number(t.last),
      quoteTime: new Date(Number(t.ts)).toISOString(),
      quote: {
        price: Number(t.last),
        quoteTime: new Date(Number(t.ts)).toISOString(),
        change24hPct: t.open24h ? ((Number(t.last) - Number(t.open24h)) / Number(t.open24h)) * 100 : null,
        open24h: Number(t.open24h),
        high24h: Number(t.high24h),
        low24h: Number(t.low24h),
        prevClose: null,
        high52w: null,
        low52w: null,
      },
      candles: rows,
      stale: false,
    };
  } catch (e) {
    okxDownUntil = Date.now() + 10 * 60 * 1000;
    throw e;
  }
}

function readSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function fromSnapshot(symbol) {
  const snap = readSnapshot();
  const item = snap?.symbols?.[symbol];
  if (!item) throw new Error('No bundled snapshot for this symbol');
  return {
    ...item,
    symbol,
    source: `Bundled snapshot (${snap.generatedAt})`,
    sourceUrl: 'data/snapshot.json',
    stale: true,
  };
}

export async function getMarketData(symbol, { pages = 4, ttlMs = 120_000 } = {}) {
  if (process.env.MCP_OFFLINE === '1') return fromSnapshot(symbol);
  const key = `${symbol}:${pages}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;

  const errors = [];
  try {
    const data = await fetchOkx(symbol);
    cache.set(key, { at: Date.now(), value: data });
    return data;
  } catch (e) {
    errors.push(`OKX: ${e.message}`);
  }
  if (Date.now() < stooqDownUntil) {
    errors.push(`Stooq: circuit open until ${new Date(stooqDownUntil).toISOString()}`);
  } else {
    try {
      const data = await fetchStooq(symbol, pages);
      cache.set(key, { at: Date.now(), value: data });
      return data;
    } catch (e) {
      errors.push(`Stooq: ${e.message}`);
    }
  }
  try {
    const data = fromSnapshot(symbol);
    cache.set(key, { at: Date.now(), value: data });
    return data;
  } catch (e) {
    errors.push(`snapshot: ${e.message}`);
  }
  throw new Error(`No market data available for ${symbol}. ${errors.join(' | ')}`);
}

export async function getMarketDataFor(symbols, options = {}) {
  const out = {};
  for (const symbol of symbols) {
    out[symbol] = await getMarketData(symbol, options);
  }
  return out;
}

export async function getOkxAccount() {
  const key = process.env.OKX_API_KEY;
  const secret = process.env.OKX_API_SECRET;
  const passphrase = process.env.OKX_API_PASSPHRASE;
  if (!key || !secret || !passphrase) {
    throw new Error('OKX private API credentials are not configured (OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE)');
  }
  const ts = new Date().toISOString();
  const requestPath = '/api/v5/account/balance?ccy=USDT';
  const prehash = `${ts}GET${requestPath}`;
  const sign = crypto.createHmac('sha256', secret).update(prehash).digest('base64');
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'www.okx.com',
        path: requestPath,
        method: 'GET',
        headers: {
          'OK-ACCESS-KEY': key,
          'OK-ACCESS-SIGN': sign,
          'OK-ACCESS-TIMESTAMP': ts,
          'OK-ACCESS-PASSPHRASE': passphrase,
          accept: 'application/json',
          'user-agent': UA,
        },
        timeout: 6000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (json.code !== '0') return reject(new Error(`OKX ${json.code}: ${json.msg}`));
            resolve(json.data);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('OKX account request timeout')));
    req.on('error', reject);
    req.end();
  });
}

export function health() {
  const snap = readSnapshot();
  return {
    status: 'ok',
    okx: {
      baseUrl: 'https://www.okx.com',
      circuitOpen: Date.now() < okxDownUntil,
      retryAfter: Date.now() < okxDownUntil ? new Date(okxDownUntil).toISOString() : null,
      credentialsConfigured: Boolean(process.env.OKX_API_KEY && process.env.OKX_API_SECRET && process.env.OKX_API_PASSPHRASE),
    },
    stooq: {
      baseUrl: STOOQ_BASE,
      challengeCookie: Boolean(stooqCookie),
      circuitOpen: Date.now() < stooqDownUntil,
      retryAfter: Date.now() < stooqDownUntil ? new Date(stooqDownUntil).toISOString() : null,
    },
    snapshot: snap ? { generatedAt: snap.generatedAt, symbols: Object.keys(snap.symbols || {}) } : null,
    cacheEntries: cache.size,
    now: new Date().toISOString(),
  };
}

export function getSnapshotContext() {
  const snap = readSnapshot();
  return snap?.marketContext ?? null;
}


export const DATA_SOURCES = {
  BTC: { okx: OKX_INST.BTC, stooq: STOOQ_SYMBOLS.BTC },
  ETH: { okx: OKX_INST.ETH, stooq: STOOQ_SYMBOLS.ETH },
};
