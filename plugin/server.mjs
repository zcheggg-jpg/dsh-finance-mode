#!/usr/bin/env node
// Minimal stdio MCP server. It implements the legacy JSON-RPC MCP handshake
// (2025-06-18) so the DSH MCP client can discover tools without any npm
// dependency. All diagnostics go to stderr; stdout is protocol-only.

import readline from 'node:readline';
import { TOOLS, callTool } from './lib/tools.mjs';
import { listReportResources, readReportResource, reportTemplates } from './lib/report.mjs';

const SERVER_INFO = {
  name: 'okx-tradingagents',
  title: 'OKX + TradingAgents research desk',
  version: '1.5.0',
};
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const INSTRUCTIONS = [
  'Read-only OKX/BTC/ETH research server with a local paper-trading ledger.',
  'Use market_snapshot and technical_analysis for prices and indicators.',
  'Use tradingagents_debate for the multi-agent bull/bear/risk discussion, conditional buy advice, and concrete levels.',
  'Use paper_auto to run the debate and paper-execute only when price enters the plan entry zone; paper_order/paper_close/paper_account/paper_history/paper_reset manage the local ledger.',
  'auto_trade supports paper/dry_run/live; live is disabled unless OKX_TRADING_ENABLED=1, trade-only API keys, confirm="LIVE", fresh data, and configured limits are present. It is long-only spot and does not attach an automatic exit.',
  'Every debate is saved as a Markdown+JSON report; list them with list_reports or MCP resources okx://reports/*, and read them with read_report or read_mcp_resource.',
  'Live execution is off by default. If enabled, it is limited to OKX spot limit buys, requires confirm="LIVE", rejects stale data, and has no unattended exit. Never claim a fill without an OKX ordId and status check.',
].join(' ');

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return;
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    const requested = params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : '2025-06-18';
    respond(id, {
      protocolVersion,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: true },
      },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
    return;
  }

  // Some newer clients probe a discovery method before deciding whether to
  // use the legacy initialize handshake. Answer it with the same capability
  // document; harmless for clients that never call it.
  if (method === 'server/discover' || method === 'server/info') {
    respond(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
    return;
  }

  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'notifications/cancelled') return;
  if (method === 'ping') {
    respond(id, {});
    return;
  }
  if (method === 'tools/list') {
    respond(id, {
      tools: TOOLS.map(({ name, title, description, inputSchema }) => ({
        name,
        title,
        description,
        inputSchema,
      })),
    });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    if (!name) {
      respondError(id, -32602, 'tools/call requires params.name');
      return;
    }
    const result = await callTool(name, params?.arguments || {});
    respond(id, result);
    return;
  }
  if (method === 'resources/list') {
    try {
      respond(id, { resources: listReportResources(100) });
    } catch (e) {
      respondError(id, -32603, e.message);
    }
    return;
  }
  if (method === 'resources/templates/list') {
    respond(id, { resourceTemplates: reportTemplates() });
    return;
  }
  if (method === 'resources/read') {
    try {
      respond(id, readReportResource(params?.uri));
    } catch (e) {
      respondError(id, -32602, e.message);
    }
    return;
  }
  if (method === 'prompts/list') {
    respond(id, { prompts: [] });
    return;
  }
  if (method === 'logging/setLevel') {
    respond(id, {});
    return;
  }

  if (!isNotification) respondError(id, -32601, `Method not found: ${method}`);
}

async function serve() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (e) {
      process.stderr.write(`[okx-ta] invalid JSON-RPC line: ${e.message}\n`);
      continue;
    }
    try {
      await handle(message);
    } catch (e) {
      process.stderr.write(`[okx-ta] handler error: ${e.stack || e.message}\n`);
      if (message.id !== undefined && message.id !== null) {
        respondError(message.id, -32603, e.message);
      }
    }
  }
}

async function selftest() {
  process.env.MCP_OFFLINE = '1';
  const health = await callTool('health', {});
  const btc = await callTool('technical_analysis', { symbol: 'BTC' });
  const debate = await callTool('tradingagents_debate', { symbols: ['BTC', 'ETH'], riskProfile: 'balanced', capitalUSDT: 10000 });
  console.log(JSON.stringify({ health, btc, debate }, null, 2));
}

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function analyzeCli() {
  const riskProfile = argValue('--risk', 'balanced');
  const capitalUSDT = Number(argValue('--capital', '10000'));
  const res = await callTool('tradingagents_debate', {
    symbols: ['BTC', 'ETH'],
    riskProfile,
    capitalUSDT,
    saveReport: true,
  });
  if (res.isError) {
    process.stderr.write(`${res.content[0].text}\n`);
    process.exit(1);
  }
  console.log(res.content[0].text);
}

if (process.argv.includes('--analyze')) {
  analyzeCli().catch((e) => {
    process.stderr.write(`[okx-ta] analyze failed: ${e.stack || e.message}\n`);
    process.exit(1);
  });
} else if (process.argv.includes('--selftest')) {
  selftest().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  serve().catch((e) => {
    process.stderr.write(`[okx-ta] fatal: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}
