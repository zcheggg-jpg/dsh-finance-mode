#!/usr/bin/env node
// Live-runner safety self-test. Proves every guard fails closed BEFORE keys exist.
//
//   node scripts/live-runner-selftest.mjs

import fs from 'node:fs';
import path from 'node:path';
import { runLiveOnce } from '../plugin/lib/quant/live-runner.mjs';
import { RUNNER_DIR } from '../plugin/lib/quant/runner.mjs';

let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { fail += 1; console.log(`  FAIL  ${name} ${detail}`); }
};
const throws = async (name, fn, match) => {
  try { await fn(); fail += 1; console.log(`  FAIL  ${name} (did not throw)`); }
  catch (e) { ok(name, match ? String(e.message).includes(match) : true, `got: ${e.message}`); }
};

const killFile = path.join(RUNNER_DIR, 'KILL');
const hadKill = fs.existsSync(killFile);

console.log('\n[1] fail-closed gates (no keys configured)');
await throws('live requires confirm="LIVE"', () => runLiveOnce({ dryRun: false }), 'confirm');
await throws('live refuses when disabled / no keys', () => runLiveOnce({ dryRun: false, confirm: 'LIVE' }), 'disabled');

console.log('\n[2] dry-run produces a plan without credentials');
const dry = await runLiveOnce({ dryRun: true });
ok('dry-run returns guards', Boolean(dry.guards));
ok('dry-run reports liveEnabled=false', dry.guards.liveEnabled === false);
ok('dry-run reports keysConfigured=false', dry.guards.keysConfigured === false);
ok('canary max order is 100 USDT', dry.guards.canaryMaxOrderUSDT === 100, String(dry.guards.canaryMaxOrderUSDT));
ok('has at least one action', dry.actions.length >= 1);

const openAct = dry.actions.find((a) => a.action === 'would-open');
if (openAct) {
  ok('would-open has OCO plan', Boolean(openAct.plan?.steps?.length === 3));
  ok('stop below entry', openAct.stop < openAct.price);
  ok('target above entry', openAct.target > openAct.price);
  ok('notional within canary cap', openAct.notionalUSDT <= dry.guards.canaryMaxOrderUSDT + 1e-9, String(openAct.notionalUSDT));
} else {
  console.log(`  SKIP  no entry candidate right now (actions: ${dry.actions.map((a) => a.action).join(',')})`);
}

console.log('\n[3] KILL switch blocks new entries');
fs.mkdirSync(RUNNER_DIR, { recursive: true });
fs.writeFileSync(killFile, 'kill', 'utf8');
try {
  const killed = await runLiveOnce({ dryRun: true });
  ok('killSwitch flag set', killed.guards.killSwitch === true);
  const skip = killed.actions.find((a) => a.action === 'skip-entry');
  ok('entry skipped with kill reason', Boolean(skip) && String(skip.reason).includes('kill'), JSON.stringify(killed.actions));
} finally {
  if (!hadKill) fs.rmSync(killFile, { force: true });
}

console.log('\n[4] forced tradable market -> entry plan must be correct');
const fakeMarket = {
  BTC: { close: 76000, closeTime: '2026-11-07T00:00:00.000Z', score: 0.25, trendOk: true, emaTrend: 70000, atr: 2000, vol20: 40, lev: 0.625, bars: 400 },
  ETH: { close: 2200, closeTime: '2026-11-07T00:00:00.000Z', score: 0.10, trendOk: true, emaTrend: 2100, atr: 90, vol20: 60, lev: 0.4167, bars: 400 },
};
const forced = await runLiveOnce({ dryRun: true, market: fakeMarket });
const forcedOpen = forced.actions.find((a) => a.action === 'would-open');
ok('picks the strongest symbol (BTC)', forcedOpen?.symbol === 'BTC', JSON.stringify(forced.actions.map((a) => a.action)));
ok('notional respects canary cap (<=100)', forcedOpen && forcedOpen.notionalUSDT <= 100 + 1e-9, String(forcedOpen?.notionalUSDT));
ok('qty is above minSz and lot-aligned', forcedOpen && forcedOpen.qty >= 0.00001, String(forcedOpen?.qty));
ok('stop below entry price', forcedOpen && forcedOpen.stop < forcedOpen.price, `${forcedOpen?.stop} < ${forcedOpen?.price}`);
ok('target above entry price', forcedOpen && forcedOpen.target > forcedOpen.price, `${forcedOpen?.target} > ${forcedOpen?.price}`);
ok('OCO plan has 3 steps', forcedOpen?.plan?.steps?.length === 3);
ok('OCO is a sell/oco order', forcedOpen?.plan?.steps?.[2]?.body?.side === 'sell' && forcedOpen?.plan?.steps?.[2]?.body?.ordType === 'oco');
ok('OCO triggers floored to tick', forcedOpen?.plan?.steps?.[2]?.body?.slTriggerPx === '70000' && forcedOpen?.plan?.steps?.[2]?.body?.tpTriggerPx === '88000', `${forcedOpen?.plan?.steps?.[2]?.body?.slTriggerPx}/${forcedOpen?.plan?.steps?.[2]?.body?.tpTriggerPx}`);
console.log(`\n${fail === 0 ? 'ALL LIVE-RUNNER GUARDS PASSED' : fail + ' CHECK(S) FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
