#!/usr/bin/env node
// context-pack.mjs —— 依「當前階段 × 變更範圍 × token budget」組裝 context pack（#172）。
//
// 取代的舊做法是「每個階段把 loop.md ＋ 各 stage markdown 整包重讀」——長度隨 loop 成長無界，
// 且讀進來的多半跟這一步無關。本檔改成：由 work graph 挑**這一步真正需要的**節點，依優先序填進
// 一個**硬上限**的預算裡。
//
// 兩條不可退讓的規則：
//   1) **硬預算**：非受保護區段的總量絕不超過 budget（超出就丟，並在 `dropped` 誠實列出丟了什麼）。
//   2) **blocking 永不丟**：未修的 P0/P1 finding、沒過的閘、未決的決策屬**受保護區段**——預算再
//      緊也照放；真的塞不下時把 `overBudget` 標成 true 讓呼叫端知道（而不是靜默丟掉最關鍵的資訊）。
//      這條堵的是「為了省 token 把『還有什麼沒修完』擠掉」——那正是 #162/#188 反覆踩到的失效模式。
//      **這裡的 P0/P1 對應的是「完工前提」那一層（iterate §6：最近一輪 verify 無 actionable
//      findings），不是 pr-gate 閘⑥ 的機械下界（#211 起只認 P0）。兩層刻意不同、不要對齊**：
//      把 P1 從受保護區段拿掉，預算一緊 P1 就會被擠出 context，於是「還沒修完的 P1」沒人記得——
//      那正是本規則要防的事。詳見 `scripts/loop-graph.mjs` 的 `BLOCKING_SEVERITIES`。
//
// 純函式為主（estimateTokens / buildSections / packSections / buildContextPack）；
// 讀檔（artifact 內容）由呼叫端注入 `readSource`，本檔不自己碰 IO。

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readEvents } from './loop-ledger.mjs';
import { projectEvents, selectBlocking } from './loop-graph.mjs';
import { recentEvents, describeEvent } from './loop-snapshot.mjs';

/** 預設預算（token）。呼叫端一律顯式傳；這個值只是 CLI 的預設。 */
export const DEFAULT_BUDGET = 8000;

const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

/**
 * token 估算（**估算，不是實測**——依 Metric-Honesty，呼叫端回報時要標明這是估算值）。
 * CJK 字元約 1 token/字，其餘按 4 字元 ≈ 1 token。刻意保守（寧可高估、不要爆預算）。
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  let cjk = 0;
  for (const ch of s) if (CJK.test(ch)) cjk += 1;
  const rest = s.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

/** 依 token 上限截斷文字（保留開頭、尾端標明截斷）。 */
export function truncateToTokens(text, maxTokens) {
  const s = String(text ?? '');
  if (maxTokens <= 0) return '';
  if (estimateTokens(s) <= maxTokens) return s;
  const marker = '\n…（依 context pack 預算截斷）';
  const reserve = estimateTokens(marker);
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(s.slice(0, mid)) + reserve <= maxTokens) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo) + marker;
}

/** 每個階段最需要看的 node 種類（挑選器，不是硬性排除——只影響優先序）。 */
export const STAGE_FOCUS = Object.freeze({
  goal: ['Issue', 'Decision'],
  explore: ['Issue', 'Decision', 'Artifact'],
  plan: ['Issue', 'Decision', 'Task'],
  build: ['Task', 'Artifact', 'Commit'],
  verify: ['Task', 'Artifact', 'Finding', 'Gate'],
  iterate: ['Finding', 'Gate', 'Task', 'PR'],
});

/**
 * 由 state 組出候選區段（**尚未套預算**）。每段：
 *   `{id, title, priority（小者先）, protected, truncatable, text}`
 */
export function buildSections({ state, events, stage = null, affected = [], readSource = null } = {}) {
  const blocking = selectBlocking(state);
  const focus = STAGE_FOCUS[stage] || [];
  const sections = [];

  // ── 受保護：blocking（永不丟）───────────────────────────────────────────
  const blockingLines = [];
  for (const f of blocking.findings) blockingLines.push(`- finding \`${f.id}\` **${f.severity}**（第 ${f.round} 輪，${f.axis || '未標軸'}）：${f.title}`);
  for (const g of blocking.gates) blockingLines.push(`- 閘 \`${g.gate}\` = **${g.status}**${g.detail ? `（${g.detail}）` : ''}`);
  for (const d of blocking.decisions) blockingLines.push(`- 未決決策 \`${d.id}\`：${d.question}`);
  sections.push({
    id: 'blocking',
    title: '仍擋著完工的（受保護區段，不因預算丟棄）',
    priority: 0,
    protected: true,
    truncatable: false,
    text: blockingLines.length ? blockingLines.join('\n') : '（無未修 P0/P1、無未過的閘、無未決決策）',
  });

  // ── 當前狀態 brief ─────────────────────────────────────────────────────
  const L = state.loop;
  sections.push({
    id: 'brief',
    title: '當前狀態',
    priority: 1,
    protected: false,
    truncatable: true,
    text: [
      `loop：${L.slug}${state.issue != null ? `（issue #${state.issue}）` : ''}`,
      `類型 ${L.type || '?'}　operation ${L.operation || '-'}　推進模式 ${L.mode || 'closed'}`,
      `階段 ${L.done ? '完工' : (state.currentStage || '未進入')}　回環 #${state.round}`,
      L.stopCondition ? `停止條件：${L.stopCondition}` : '',
    ].filter(Boolean).join('\n'),
  });

  // ── 本階段最相關的 node ────────────────────────────────────────────────
  if (focus.length) {
    const rows = [];
    if (focus.includes('Task')) for (const t of state.tasks.filter((x) => x.status !== 'done')) rows.push(`- 任務 \`${t.id}\` ${t.title}（${t.status}）`);
    if (focus.includes('Decision')) for (const d of state.decisions.filter((x) => !x.supersededBy).slice(-8)) rows.push(`- 決策 \`${d.id}\`[${d.status}]：${d.question} → ${d.choice}`);
    if (focus.includes('Finding')) for (const f of state.findings.filter((x) => x.status === 'open')) rows.push(`- finding \`${f.id}\`[${f.severity}] ${f.title}`);
    if (focus.includes('Gate')) for (const g of state.gates.slice(-6)) rows.push(`- 閘 \`${g.gate}\` = ${g.status}`);
    if (focus.includes('Artifact')) for (const a of state.artifacts.slice(-10)) rows.push(`- 產出 \`${a.path}\`${a.summary ? ` — ${a.summary}` : ''}`);
    if (focus.includes('Commit')) for (const c of state.commits.slice(-6)) rows.push(`- commit \`${String(c.sha).slice(0, 8)}\` ${c.subject}`);
    if (focus.includes('PR')) for (const p of state.prs) rows.push(`- PR #${p.number}${p.merged ? '（已合併）' : ''} ${p.title}`);
    if (focus.includes('Issue') && state.issue != null) rows.push(`- issue #${state.issue}`);
    if (rows.length) {
      sections.push({ id: 'stage-focus', title: `${stage} 階段相關節點`, priority: 2, protected: false, truncatable: true, text: rows.join('\n') });
    }
  }

  // ── 變更範圍（affected）────────────────────────────────────────────────
  if (affected && affected.length) {
    const rows = [];
    for (const key of affected) {
      const art = state.artifacts.find((a) => a.path === key || a.id === key);
      const body = readSource ? readSource(key) : null;
      if (body) rows.push(`### ${key}\n${body}`);
      else rows.push(`- ${key}${art && art.summary ? ` — ${art.summary}` : ''}`);
    }
    sections.push({ id: 'affected', title: '本次變更範圍', priority: 3, protected: false, truncatable: true, text: rows.join('\n\n') });
  }

  // ── 最近事件（有界）────────────────────────────────────────────────────
  const recent = recentEvents(events || [], 12).map(({ ordinal, event }) => `- [E${ordinal}] ${describeEvent(event)}`);
  if (recent.length) sections.push({ id: 'recent', title: '最近事件', priority: 4, protected: false, truncatable: true, text: recent.join('\n') });

  return sections;
}

/**
 * 套預算。受保護區段先無條件放進去；剩下的依 priority 填，塞不下就先嘗試截斷（truncatable），
 * 截到剩不到 `minSectionTokens` 就整段丟。回傳的 `dropped` 逐條列出丟了什麼與為什麼——
 * **不做靜默截斷**（AGENTS〈no silent caps〉）。
 */
export function packSections(sections, budget, { minSectionTokens = 40 } = {}) {
  const ordered = [...sections].sort((a, b) => a.priority - b.priority);
  const kept = [];
  const dropped = [];
  let used = 0;

  for (const s of ordered.filter((x) => x.protected)) {
    const cost = estimateTokens(s.text) + estimateTokens(s.title);
    kept.push({ ...s, tokens: cost, truncated: false });
    used += cost;
  }
  const overBudget = used > budget;

  for (const s of ordered.filter((x) => !x.protected)) {
    const titleCost = estimateTokens(s.title);
    const room = budget - used - titleCost;
    const full = estimateTokens(s.text);
    if (room >= full) {
      kept.push({ ...s, tokens: full + titleCost, truncated: false });
      used += full + titleCost;
      continue;
    }
    if (s.truncatable && room >= minSectionTokens) {
      const text = truncateToTokens(s.text, room);
      const cost = estimateTokens(text) + titleCost;
      kept.push({ ...s, text, tokens: cost, truncated: true });
      used += cost;
      dropped.push({ id: s.id, reason: 'truncated', droppedTokens: full - estimateTokens(text) });
      continue;
    }
    dropped.push({ id: s.id, reason: overBudget ? 'protected-section-consumed-budget' : 'no-room', droppedTokens: full });
  }

  return { sections: kept, tokensUsed: used, budget, overBudget, dropped };
}

/** 一步到位：state + events → 套好預算的 context pack。 */
export function buildContextPack({ state, events, stage = null, affected = [], budget = DEFAULT_BUDGET, readSource = null } = {}) {
  const sections = buildSections({ state, events, stage, affected, readSource });
  const packed = packSections(sections, budget);
  return { ...packed, stage, loop: state.loop.slug, estimateMethod: 'heuristic（CJK 1 token/字、其餘 4 字元/token）——估算值，非實測' };
}

/** pack → 可直接塞進 prompt 的 markdown。 */
export function renderPack(pack) {
  const head = [
    `<!-- context pack：loop ${pack.loop}${pack.stage ? ` · ${pack.stage} 階段` : ''} · ${pack.tokensUsed}/${pack.budget} tokens（估算）${pack.overBudget ? ' · 受保護區段已超出預算' : ''} -->`,
  ];
  for (const s of pack.sections) head.push('', `## ${s.title}`, '', s.text);
  if (pack.dropped.length) {
    head.push('', '## 因預算未納入的內容（誠實揭露，非靜默截斷）', '');
    for (const d of pack.dropped) head.push(`- \`${d.id}\`：${d.reason}，約 ${d.droppedTokens} tokens 未納入`);
  }
  return `${head.join('\n')}\n`;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    process.stdout.write('用法：node context-pack.mjs <loop 目錄> [--stage <name>] [--budget <n>] [--json]\n');
    return 0;
  }
  const stage = args.includes('--stage') ? args[args.indexOf('--stage') + 1] : null;
  const budget = args.includes('--budget') ? Number(args[args.indexOf('--budget') + 1]) : DEFAULT_BUDGET;
  const { events } = readEvents(join(dir, 'events.jsonl'));
  const state = projectEvents(events, { slug: dir.split(/[\\/]/).filter(Boolean).pop() });
  const pack = buildContextPack({ state, events, stage, budget });
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(pack, null, 2)}\n` : renderPack(pack));
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
