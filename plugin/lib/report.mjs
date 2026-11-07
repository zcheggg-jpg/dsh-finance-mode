// Persistent report store. Reports are written as Markdown + JSON so DSH can
// read them through MCP resources (okx://reports/<name>) or directly on disk.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');

export function reportDir() {
  return path.resolve(process.env.OKX_REPORT_DIR || path.join(PACKAGE_ROOT, 'reports'));
}

function ensureDir() {
  const dir = reportDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  return `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}${get('second')}`;
}

function fmt(n, d = 0) {
  if (n == null || !Number.isFinite(Number(n))) return 'n/a';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
}

function pct(n, d = 2) {
  if (n == null || !Number.isFinite(Number(n))) return 'n/a';
  return `${Number(n) >= 0 ? '+' : ''}${Number(n).toFixed(d)}%`;
}

function buyRows(result) {
  return ['BTC', 'ETH'].map((symbol) => {
    const d = result.decision?.[symbol] || {};
    const buy = d.buyAdvice || {};
    return `| ${symbol} | ${d.rating || 'n/a'} | ${buy.action || 'n/a'} | ${buy.firstEntry?.trigger || 'n/a'} | ${buy.addEntry?.trigger || 'n/a'} | ${buy.stop || 'n/a'} | ${buy.targets?.join(' / ') || 'n/a'} |`;
  }).join('\n');
}

export function renderMarkdown(result, meta = {}) {
  const decision = result.decision || {};
  const trader = result.trader || {};
  const sources = result.dataSources || {};
  const lines = [];
  lines.push('# BTC / ETH TradingAgents 分析报告');
  lines.push('');
  lines.push(`- 生成时间：${meta.generatedAt || result.asOf || new Date().toISOString()}`);
  lines.push(`- 框架：[TradingAgents](${result.frameworkUrl || 'https://github.com/TauricResearch/TradingAgents'}) 角色与辩论流程复刻（分析师 → 多空研究员 → 研究经理 → 交易员 → 风险辩论 → 组合经理）`);
  lines.push(`- 性质：研究输出，不构成投资建议；本 MCP 只读，不下单`);
  lines.push(`- 报告文件：${meta.name || 'latest.md'}`);
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  lines.push('| 资产 | 技术收盘 | 24h | 趋势 | 评级 | 信心 | 一句话 |');
  lines.push('|---|---:|---:|---|---|---:|---|');
  for (const symbol of ['BTC', 'ETH']) {
    const d = decision[symbol] || {};
    const s = sources[symbol] || {};
    const techPrice = s.price ?? d.price ?? null;
    const summary = (d.summary || '').replace(/\|/g, '/').slice(0, 120);
    lines.push(`| ${symbol} | ${fmt(techPrice)} | ${pct(s.change24hPct)} | ${s.bias || 'n/a'} | ${d.rating || 'n/a'} | ${d.convictionPct ?? 'n/a'}% | ${summary} |`);
  }
  lines.push('');
  lines.push('## 买入 / 操作建议');
  lines.push('');
  lines.push('| 资产 | 评级 | 当前动作 | 首次买入触发 | 加仓触发 | 止损 | 目标 |');
  lines.push('|---|---|---|---|---|---:|---|');
  lines.push(buyRows(result));
  lines.push('');
  lines.push('> “首次买入触发”是条件单思路，不是当前市价买入。趋势未修复前，现金也是仓位。');
  lines.push('');
  for (const symbol of ['BTC', 'ETH']) {
    const d = decision[symbol] || {};
    const buy = d.buyAdvice || {};
    lines.push(`### ${symbol}`);
    lines.push('');
    lines.push(`- 评级：**${d.rating || 'n/a'}**（信心 ${d.convictionPct ?? 'n/a'}%）`);
    lines.push(`- 当前动作：${buy.action || 'n/a'}`);
    lines.push(`- 首次买入：${buy.firstEntry?.trigger || 'n/a'}；止损 ${buy.stop ?? 'n/a'}；目标 ${buy.targets?.join(' / ') || 'n/a'}`);
    lines.push(`- 加仓：${buy.addEntry?.trigger || 'n/a'}`);
    lines.push(`- 持有者：${buy.holder || 'n/a'}`);
    lines.push(`- 不要做：${buy.avoid || 'n/a'}`);
    lines.push(`- 主要情景：基准 ${d.scenarios?.base?.probabilityPct ?? 'n/a'}% · ${d.scenarios?.base?.path || 'n/a'}`);
    lines.push(`- 悲观情景 ${d.scenarios?.bear?.probabilityPct ?? 'n/a'}% · ${d.scenarios?.bear?.path || 'n/a'}`);
    lines.push(`- 乐观情景 ${d.scenarios?.bull?.probabilityPct ?? 'n/a'}% · ${d.scenarios?.bull?.path || 'n/a'}`);
    lines.push('');
  }
  lines.push('## 关键点位');
  lines.push('');
  for (const symbol of ['BTC', 'ETH']) {
    const t = trader[symbol] || {};
    lines.push(`### ${symbol}`);
    lines.push('');
    if (t.direction === 'short') {
      lines.push(`- 反弹卖出区：${t.short?.entryZone?.join('–') || 'n/a'}`);
      lines.push(`- 空头止损：${t.short?.stop ?? 'n/a'}；目标：${t.short?.targets?.join(' / ') || 'n/a'}；盈亏比：${t.short?.riskReward ?? 'n/a'}`);
    } else {
      lines.push(`- 回踩买入区：${t.long?.entryZone?.join('–') || 'n/a'}`);
      lines.push(`- 多头止损：${t.long?.stop ?? 'n/a'}；目标：${t.long?.targets?.join(' / ') || 'n/a'}；盈亏比：${t.long?.riskReward ?? 'n/a'}`);
    }
    lines.push(`- 加仓触发：${t.tacticalLong?.trigger || 'n/a'}；止损 ${t.tacticalLong?.stop ?? 'n/a'}；目标 ${t.tacticalLong?.target ?? 'n/a'}`);
    lines.push(`- 破位触发：${t.breakdown?.trigger || 'n/a'}；止损 ${t.breakdown?.stop ?? 'n/a'}；目标 ${t.breakdown?.target ?? 'n/a'}`);
    lines.push(`- 仓位示例：${t.sizingExample?.units ?? 'n/a'} 单位，名义 $${fmt(t.sizingExample?.notionalUsd)}，止损风险 $${fmt(t.sizingExample?.riskAtStopUsd)}（风险预算 $${fmt(t.sizingExample?.riskBudgetUsd)}）`);
    lines.push('');
  }
  lines.push('## 讨论纪要');
  lines.push('');
  lines.push('### 市场分析师');
  lines.push(result.analysts?.market || 'n/a');
  lines.push('');
  lines.push('### 情绪 / 资金分析师');
  lines.push(result.analysts?.sentiment || 'n/a');
  lines.push('');
  lines.push('### 基本面 / 相对价值分析师');
  lines.push(result.analysts?.fundamentals || 'n/a');
  lines.push('');
  lines.push('### 多头研究员');
  lines.push(result.debate?.bull?.opening || 'n/a');
  lines.push('');
  lines.push(`**多头反驳：** ${result.debate?.bull?.rebuttal || 'n/a'}`);
  lines.push('');
  lines.push('### 空头研究员');
  lines.push(result.debate?.bear?.opening || 'n/a');
  lines.push('');
  lines.push(`**空头反驳：** ${result.debate?.bear?.rebuttal || 'n/a'}`);
  lines.push('');
  lines.push('### 研究经理裁决');
  lines.push(`**结论：** ${result.debate?.researchManager?.verdict || 'n/a'}`);
  lines.push('');
  lines.push(result.debate?.researchManager?.plan || 'n/a');
  lines.push('');
  lines.push('### 风险辩论');
  for (const [key, label] of [['aggressive', '激进派'], ['conservative', '保守派'], ['neutral', '中性派'], ['riskManager', '风险经理']]) {
    lines.push(`- **${label}：** ${result.riskDebate?.[key] || 'n/a'}`);
  }
  lines.push('');
  lines.push('### 组合经理');
  lines.push(`- 净偏：${result.decision?.portfolio?.netBias || 'n/a'}`);
  lines.push(`- Gross crypto：${result.decision?.portfolio?.grossCryptoExposurePct ?? 'n/a'}%`);
  lines.push(`- 偏好：${result.decision?.portfolio?.preferred || 'n/a'}`);
  lines.push(`- 观点改变：${result.decision?.portfolio?.whatWouldChange || 'n/a'}`);
  lines.push('');
  if (result.paper) {
    const p = result.paper;
    const a = p.account || {};
    lines.push('## 模拟盘执行');
    lines.push('');
    lines.push(`- 账户权益：$${fmt(a.equity, 2)}；现金：$${fmt(a.cash, 2)}；已实现盈亏：$${fmt(a.realizedPnl, 2)}；总回报：${pct(a.totalReturnPct)}`);
    lines.push(`- 持仓：${a.positions?.length || 0} 个；总敞口：$${fmt(a.grossExposureUSDT, 2)}（${a.grossExposurePct ?? 'n/a'}%）`);
    if (a.positions?.length) {
      for (const pos of a.positions) {
        lines.push(`  - ${pos.symbol} ${pos.side} ${pos.qty} @ ${fmt(pos.entryPrice, 2)}；标记 ${fmt(pos.mark, 2)}；止损 ${fmt(pos.stop, 2)}；目标 ${fmt(pos.target, 2)}；浮盈亏 $${fmt(pos.unrealizedPnlUSDT, 2)}`);
      }
    }
    lines.push('- 本次动作：');
    for (const act of p.actions || []) {
      const detail = act.order
        ? `${act.order.side} ${act.order.qty} @ ${fmt(act.order.price, 2)}`
        : act.trade
          ? `平仓 ${act.trade.qty} @ ${fmt(act.trade.exitPrice, 2)}，盈亏 $${fmt(act.trade.pnlUSDT, 2)}`
          : act.reason || '';
      lines.push(`  - ${act.action} ${act.symbol || ''} ${detail}`.trimEnd());
    }
    lines.push('');
    lines.push('> 模拟盘只写本地 JSON，不会向 OKX 发送任何订单。');
    lines.push('');
  }
  if (result.execution) {
    const e = result.execution;
    lines.push('## 执行结果');
    lines.push('');
    lines.push(`- 模式：**${e.mode}**`);
    lines.push(`- 自动退出：${e.autoExit ? '是' : '否（止损/目标为监控位，不是交易所挂单）'}`);
    for (const act of e.actions || []) {
      const detail = act.order ? `ordId ${act.order.ordId || 'n/a'}` : act.px ? `${act.side} ${act.sz} @ ${act.px}` : act.reason || '';
      lines.push(`- ${act.action} ${act.symbol || ''} ${detail}`.trimEnd());
    }
    if (e.note) lines.push(`- 说明：${e.note}`);
    lines.push('');
  }
  lines.push('## 数据质量与限制');
  lines.push('');
  for (const q of result.dataQuality || []) lines.push(`- ${q}`);
  lines.push('');
  lines.push('## 数据源');
  lines.push('');
  for (const symbol of ['BTC', 'ETH']) {
    const s = sources[symbol];
    if (s) lines.push(`- ${symbol}: ${s.source}${s.stale ? '（stale snapshot）' : ''}，quoteTime ${s.quoteTime || 'n/a'}`);
  }
  lines.push('');
  lines.push('## 风险提示');
  lines.push('');
  lines.push(result.disclaimer || '研究用途，不构成投资建议。');
  lines.push('');
  return lines.join('\n');
}

export function saveReport(result, { prefix = 'BTC-ETH', generatedAt } = {}) {
  const dir = ensureDir();
  const createdAt = generatedAt || new Date().toISOString();
  const name = `${prefix}-TradingAgents-${stamp()}.md`;
  const jsonName = name.replace(/\.md$/, '.json');
  const mdPath = path.join(dir, name);
  const jsonPath = path.join(dir, jsonName);
  const payload = { ...result, report: { name, createdAt, framework: result.framework } };
  const md = renderMarkdown(payload, { name, generatedAt: createdAt });
  fs.writeFileSync(mdPath, md, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify({ ...payload, report: { name, createdAt } }, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'latest.md'), md, 'utf8');
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(payload, null, 2), 'utf8');
  const stat = fs.statSync(mdPath);
  return {
    name,
    createdAt,
    uri: `okx://reports/${encodeURIComponent(name)}`,
    mdPath,
    jsonPath,
    bytes: stat.size,
  };
}

export function listReports(limit = 50) {
  const dir = reportDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name !== 'latest.md')
    .map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return {
        name,
        uri: `okx://reports/${encodeURIComponent(name)}`,
        path: full,
        createdAt: stat.mtime.toISOString(),
        bytes: stat.size,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
}

export function readReport(name) {
  const dir = reportDir();
  const safe = path.basename(String(name || ''));
  if (!/\.(md|json)$/i.test(safe)) throw new Error('Only .md or .json reports can be read');
  const full = path.join(dir, safe);
  if (!full.startsWith(dir + path.sep)) throw new Error('Report path escapes the report directory');
  if (!fs.existsSync(full)) throw new Error(`Report not found: ${safe}`);
  const stat = fs.statSync(full);
  if (stat.size > 2 * 1024 * 1024) throw new Error('Report is too large to read');
  return {
    name: safe,
    mimeType: safe.endsWith('.json') ? 'application/json' : 'text/markdown',
    text: fs.readFileSync(full, 'utf8'),
    uri: `okx://reports/${encodeURIComponent(safe)}`,
  };
}

export function listReportResources(limit = 50) {
  return listReports(limit).map((r) => ({
    uri: r.uri,
    name: r.name,
    title: r.name.replace(/\.md$/i, '').replace(/-TradingAgents-/, ' TradingAgents '),
    description: `TradingAgents report generated ${r.createdAt}`,
    mimeType: 'text/markdown',
    size: r.bytes,
  }));
}

export function readReportResource(uri) {
  const m = String(uri || '').match(/^okx:\/\/reports\/(.+)$/);
  if (!m) throw new Error(`Unsupported resource URI: ${uri}`);
  const report = readReport(decodeURIComponent(m[1]));
  return { contents: [{ uri, mimeType: report.mimeType, text: report.text }] };
}

export function reportTemplates() {
  return [{
    uriTemplate: 'okx://reports/{name}',
    name: 'TradingAgents report',
    description: 'Read a saved TradingAgents Markdown report by file name.',
    mimeType: 'text/markdown',
  }];
}
