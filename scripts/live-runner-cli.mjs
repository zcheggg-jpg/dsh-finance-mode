#!/usr/bin/env node
// Live runner CLI. Dry-run by default; real orders need --live --confirm LIVE.
//
//   node scripts/live-runner-cli.mjs                 (dry-run)
//   node scripts/live-runner-cli.mjs --live --confirm LIVE

import { runLiveOnce } from '../plugin/lib/quant/live-runner.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const nx = argv[i + 1];
    if (nx && !nx.startsWith('--')) { out[k] = nx; i += 1; } else out[k] = true;
  }
  return out;
}

const args = parseArgs(process.argv);
const live = Boolean(args.live);
const confirm = typeof args.confirm === 'string' ? args.confirm : null;

console.log(live ? '模式: LIVE（会真实下单）' : '模式: DRY-RUN（不下单）');

try {
  const res = await runLiveOnce({ dryRun: !live, confirm });
  console.log(JSON.stringify(res, null, 2));
  console.log('\n研究用途，不构成投资建议。');
} catch (e) {
  console.error('REFUSED: ' + e.message);
  process.exit(1);
}
