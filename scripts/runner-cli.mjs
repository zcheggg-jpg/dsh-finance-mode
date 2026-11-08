#!/usr/bin/env node
// Resident strategy runner CLI (paper ledger by default).
//
//   node scripts/runner-cli.mjs --once --dry-run
//   node scripts/runner-cli.mjs --once
//   node scripts/runner-cli.mjs --loop --interval 3600000
//
// State lives in OKX_PAPER_STATE (default ~/.dsh/okx-tradingagents/paper/account.json).
// Use --state to keep the runner separate from the MCP paper account.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

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
const once = Boolean(args.once) || !args.loop;
const dryRun = Boolean(args['dry-run']);
const intervalMs = Number(args.interval || 3600_000);
const statePath = args.state
  ? path.resolve(String(args.state))
  : path.join(os.homedir(), '.dsh', 'okx-tradingagents', 'quant', 'runner', 'paper-state.json');

process.env.OKX_PAPER_STATE = statePath;

const { runOnce, runLoop, runnerPaths, killSwitchActive } = await import('../plugin/lib/quant/runner.mjs');

const fline = (s = '', n = 78) => console.log(s);

if (killSwitchActive()) {
  fline('⚠  检测到 KILL 开关：' + runnerPaths.kill);
  fline('   引擎将不会开新仓（现有持仓仍会管理）。');
}

console.log(`runner 状态文件: ${statePath}`);
console.log(`模式: ${dryRun ? 'DRY-RUN（不写账本）' : 'PAPER（写本地账本）'}   ${once ? '单次执行' : `循环，间隔 ${intervalMs}ms`}`);

function render(res) {
  console.log(`\n[${res.at}] UTC+8 day=${res.day}  equity=${res.account.equity} USDT  现金=${res.account.cash}  敞口=${res.account.exposurePct}%  持仓=${res.account.openPositions}`);
  console.log(`  守卫: kill=${res.guards.killSwitch} 当日盈亏=${res.guards.dayPnlPct}% 日亏熔断=${res.guards.dailyLossBlocked} 冷却=${res.guards.cooldownActive}`);
  if (res.ranking.length) {
    console.log('  排名: ' + res.ranking.map((r) => `${r.symbol} score=${r.score} trend=${r.trendOk ? 'OK' : 'FAIL'} ${r.tradable ? '←可交易' : ''}`).join('  |  '));
  }
  for (const a of res.actions) console.log('  → ' + JSON.stringify(a));
}

if (once) {
  const res = await runOnce({ dryRun });
  render(res);
  console.log('\n研究用途，不构成投资建议。');
} else {
  const res = await runLoop({
    intervalMs,
    dryRun,
    onResult: (r) => render(r),
  });
  console.log(`\n循环结束，共执行 ${res.runs} 次。`);
}
