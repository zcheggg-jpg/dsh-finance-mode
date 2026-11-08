#!/usr/bin/env node
// Offline + public-data self-test for the execution layer.
// No API keys required: it verifies builders, quantisation, guards, and live specs.
//
//   node scripts/execution-selftest.mjs

import {
  getSpecs, floorToStep, makeClOrdId, buildSpotOrder, buildOcoBody,
  placeSpotSell, placeOcoStop, getBaseBalance, openWithProtection, closeProtected,
} from '../plugin/lib/quant/execution.mjs';

let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { fail += 1; console.log(`  FAIL  ${name} ${detail}`); }
};
const throws = async (name, fn, match) => {
  try { await fn(); fail += 1; console.log(`  FAIL  ${name} (did not throw)`); }
  catch (e) { ok(name, match ? String(e.message).includes(match) : true, `got: ${e.message}`); }
};

console.log('\n[1] live OKX instrument specs (public endpoint, no keys)');
const btc = await getSpecs('BTC-USDT');
const eth = await getSpecs('ETH-USDT');
console.log(`  BTC-USDT tick=${btc.tickSz} lot=${btc.lotSz} min=${btc.minSz} state=${btc.state}`);
console.log(`  ETH-USDT tick=${eth.tickSz} lot=${eth.lotSz} min=${eth.minSz} state=${eth.state}`);
ok('BTC tickSz is 0.1', btc.tickSz === 0.1);
ok('BTC lotSz is 1e-8', btc.lotSz === 1e-8);
ok('ETH lotSz is 1e-6', eth.lotSz === 1e-6);
ok('specs are live', btc.state === 'live' && eth.state === 'live');

console.log('\n[2] quantisation (float-drift safe)');
ok('floorToStep 0.000065999999 -> 0.00006599', floorToStep(0.000065999999, 1e-8) === 0.00006599, String(floorToStep(0.000065999999, 1e-8)));
ok('floorToStep 75829.29 @0.1 -> 75829.2', floorToStep(75829.29, 0.1) === 75829.2, String(floorToStep(75829.29, 0.1)));
ok('floorToStep 0.00223999 @1e-6 -> 0.002239', floorToStep(0.00223999, 1e-6) === 0.002239, String(floorToStep(0.00223999, 1e-6)));
await throws('floorToStep rejects step 0', () => floorToStep(1, 0), 'positive step');

console.log('\n[3] spot order builders');
const buy = buildSpotOrder({ instId: 'BTC-USDT', side: 'buy', ordType: 'limit', px: 75829.24, sz: 0.00006599, clOrdId: 'dsh', spec: btc });
ok('buy body instId', buy.instId === 'BTC-USDT');
ok('buy body tdMode cash (no leverage)', buy.tdMode === 'cash');
ok('buy price floored to tick', buy.px === '75829.2', buy.px);
ok('buy size floored to lot', buy.sz === '0.00006599', buy.sz);
ok('buy clOrdId <= 32 chars', buy.clOrdId.length <= 32 && /^[a-zA-Z0-9]+$/.test(buy.clOrdId), buy.clOrdId);

const sell = buildSpotOrder({ instId: 'BTC-USDT', side: 'sell', ordType: 'market', sz: 0.0001, spec: btc });
ok('market sell has no px', sell.px === undefined);
ok('market sell side sell', sell.side === 'sell');

await throws('rejects size below minSz', () => buildSpotOrder({ instId: 'BTC-USDT', side: 'buy', ordType: 'limit', px: 75000, sz: 0.000001, spec: btc }), 'below minSz');
await throws('rejects bad side', () => buildSpotOrder({ instId: 'BTC-USDT', side: 'hodl', ordType: 'limit', px: 1, sz: 1, spec: btc }), 'side must be');
await throws('rejects limit without price', () => buildSpotOrder({ instId: 'BTC-USDT', side: 'buy', ordType: 'limit', sz: 0.0001, spec: btc }), 'positive px');

console.log('\n[4] OCO protective order');
const oco = buildOcoBody({ instId: 'BTC-USDT', sz: 0.0001, slTriggerPx: 70000.09, tpTriggerPx: 80000.11, spec: btc });
ok('oco ordType', oco.ordType === 'oco');
ok('oco exits with sell', oco.side === 'sell');
ok('oco uses market on trigger (-1)', oco.slOrdPx === '-1' && oco.tpOrdPx === '-1');
ok('oco sl floored', oco.slTriggerPx === '70000', oco.slTriggerPx);
ok('oco tp floored', oco.tpTriggerPx === '80000.1', oco.tpTriggerPx);
await throws('oco rejects sl >= tp', () => buildOcoBody({ instId: 'BTC-USDT', sz: 0.0001, slTriggerPx: 80000, tpTriggerPx: 70000, spec: btc }), 'slTriggerPx < tpTriggerPx');
await throws('oco rejects size below minSz', () => buildOcoBody({ instId: 'BTC-USDT', sz: 0.000001, slTriggerPx: 70000, tpTriggerPx: 80000, spec: btc }), 'below minSz');

console.log('\n[5] live guards (must refuse without enablement/keys)');
await throws('placeSpotSell refuses when live disabled', () => placeSpotSell({ instId: 'BTC-USDT', sz: 0.0001 }), 'disabled');
await throws('placeOcoStop refuses when live disabled', () => placeOcoStop({ instId: 'BTC-USDT', sz: 0.0001, slTriggerPx: 70000, tpTriggerPx: 80000 }), 'disabled');
await throws('getBaseBalance needs credentials', () => getBaseBalance('BTC-USDT'), 'credentials');

console.log('\n[6] clOrdId generator');
const ids = new Set(Array.from({ length: 200 }, () => makeClOrdId('dsh')));
ok('200 ids are unique', ids.size === 200, `unique=${ids.size}`);
ok('ids are <= 32 chars', [...ids].every((i) => i.length <= 32));
ok('ids are alphanumeric', [...ids].every((i) => /^[a-zA-Z0-9]+$/.test(i)));

console.log('\n[7] end-to-end dry-run plans (no exchange contact)');
const entryPlan = await openWithProtection({ instId: 'BTC-USDT', px: 75829.24, sz: 0.00006599, slTriggerPx: 74800.09, tpTriggerPx: 79000.11 });
ok('entry plan has 3 steps', entryPlan.steps.length === 3, String(entryPlan.steps.length));
ok('entry plan starts with limit-buy', entryPlan.steps[0].step === 'limit-buy');
ok('entry buy qty floored', entryPlan.steps[0].body.sz === '0.00006599', entryPlan.steps[0].body.sz);
ok('entry buy price floored', entryPlan.steps[0].body.px === '75829.2', entryPlan.steps[0].body.px);
ok('entry attaches OCO before fill size known', entryPlan.steps[2].body.sz === '<filledQty>');
ok('entry OCO uses sell+oco', entryPlan.steps[2].body.side === 'sell' && entryPlan.steps[2].body.ordType === 'oco');
ok('entry OCO triggers floored', entryPlan.steps[2].body.slTriggerPx === '74800' && entryPlan.steps[2].body.tpTriggerPx === '79000.1', `${entryPlan.steps[2].body.slTriggerPx}/${entryPlan.steps[2].body.tpTriggerPx}`);
const exitPlan = await closeProtected({ instId: 'BTC-USDT' });
ok('exit plan cancels OCO first', exitPlan.steps[0].step === 'cancel-oco');
ok('exit plan then sells', exitPlan.steps[1].step === 'market-sell');
console.log(`\n${fail === 0 ? 'ALL EXECUTION CHECKS PASSED' : fail + ' CHECK(S) FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
