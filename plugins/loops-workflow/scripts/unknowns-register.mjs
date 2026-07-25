#!/usr/bin/env node
// unknowns-register.mjs —— 四象限 Unknowns Register（#174）。
//
// 問題：clarify / define 已經一次一問，但那偏向「把**已知**需求補完整」。真正拖垮 loop 的是
// **沒被問出來的東西**——使用者知道卻沒寫下的 tacit knowledge、以及雙方都沒想到的盲點。同時，人
// 也需要隨時看得到「AI 現在把什麼當事實、什麼還沒決定」。
//
// 四象限（`kind`）：
//
// | kind | 是什麼 | 怎麼變成它 |
// |---|---|---|
// | `known-known` | 使用者明示、已確認的決策，或可查證的證據 | 只能由 `researched` / `decided` 轉入——**AI 的假設不得自行升格** |
// | `known-unknown` | 已知但還沒答案的問題（帶 owner / stage / blocking） | 訪談問出來、或已知事實被推翻 |
// | `unknown-known` | 使用者沒寫下、但看到例子／原型／反例就認得出來的 tacit knowledge | 拿具體例子去撞出來 |
// | `unknown-unknown` | 探索 code、外部研究、blind-spot pass 或 reviewer 才發現的盲點 | 只能被「發現」，發現後即轉 `known-unknown` |
//
// **系統永遠不宣稱 unknown-unknown ＝ 0**（那是不可知的）——只記錄「做過哪些 blind-spot pass」
// 與「殘餘風險」。`summarize()` 因此把 unknown-unknown 那格標成 `未知（僅記錄已做的盤查）`。
//
// 硬規則：**blocking unknown 未解決前不得進 build**（影響 scope / UX / data / security /
// architecture / acceptance 任一面向者為 blocking）。這條由 `gateBuild()` 機械判定，並在
// policy-registry 以 tier-2（workflow-invariant）登記。
//
// 純函式（validateUnknown / applyTransition / summarize / gateBuild / renderRegister）＋
// IO 薄邊界（readUnknowns / recordUnknown）。依賴：僅 node 內建。

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { appendEvent, readEvents } from './loop-ledger.mjs';

/** 四象限。順序即報告呈現順序（從最確定到最不確定）。 */
export const QUADRANTS = Object.freeze(['known-known', 'known-unknown', 'unknown-known', 'unknown-unknown']);

/** unknown node 的生命週期狀態。 */
export const UNKNOWN_STATUSES = Object.freeze(['discovered', 'open', 'researching', 'resolved', 'invalidated']);

/**
 * 允許的狀態轉移。刻意**不允許** `discovered → resolved`（沒經過「被問出來成為明確問題」這一步，
 * 等於 AI 自己認定它解決了），也不允許 `resolved → discovered`（要退回請走 `invalidated`）。
 */
export const UNKNOWN_TRANSITIONS = Object.freeze({
  discovered: ['open', 'invalidated'],
  open: ['researching', 'resolved', 'invalidated'],
  researching: ['resolved', 'open', 'invalidated'],
  resolved: ['invalidated'],
  invalidated: ['open'],
});

/** 觸及這些面向的 unknown 一律 blocking（未解決不得進 build）。 */
export const BLOCKING_AFFECTS = Object.freeze(['scope', 'ux', 'data', 'security', 'architecture', 'acceptance']);

/** unknown node 的必填欄位（issue #174 驗收標準逐字列的那組）。 */
export const UNKNOWN_FIELDS = Object.freeze(['id', 'kind', 'statement', 'source', 'owner', 'discovered_at', 'affects', 'blocking', 'status', 'resolution', 'evidence']);

/** 事件型別（寫進 loop ledger 的 `type`）。 */
export const UNKNOWN_EVENT_TYPE = 'unknown';

const ISO_TS = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/;

// ── 驗證（純函式）───────────────────────────────────────────────────────────

/**
 * 驗一筆 unknown node。回 `{ok, errors}`。
 * `blocking` 刻意允許呼叫端顯式指定，但**與 affects 不一致時判錯**——不讓「明明動到 security
 * 卻標 blocking:false」這種自我豁免靜默通過。
 */
export function validateUnknown(node) {
  const errors = [];
  if (!node || typeof node !== 'object' || Array.isArray(node)) return { ok: false, errors: ['unknown node 不是物件'] };
  for (const f of UNKNOWN_FIELDS) if (!(f in node)) errors.push(`缺欄位 ${f}`);
  if (typeof node.id !== 'string' || !node.id.trim()) errors.push('id 須為非空字串');
  if (!QUADRANTS.includes(node.kind)) errors.push(`kind 須為 ${QUADRANTS.join('／')} 之一（實際：${JSON.stringify(node.kind)}）`);
  if (typeof node.statement !== 'string' || !node.statement.trim()) errors.push('statement 須為非空字串（講清楚不知道的是什麼）');
  if (typeof node.source !== 'string' || !node.source.trim()) errors.push('source 須為非空字串（這條是怎麼冒出來的）');
  if (typeof node.owner !== 'string' || !node.owner.trim()) errors.push('owner 須為非空字串（誰負責把它解掉）');
  if (typeof node.discovered_at !== 'string' || !ISO_TS.test(node.discovered_at)) errors.push('discovered_at 須為 ISO 日期或時間戳');
  if (!Array.isArray(node.affects)) errors.push('affects 須為陣列');
  else for (const a of node.affects) if (typeof a !== 'string' || !a.trim()) errors.push('affects 內含空項目');
  if (typeof node.blocking !== 'boolean') errors.push('blocking 須為布林');
  if (!UNKNOWN_STATUSES.includes(node.status)) errors.push(`status 須為 ${UNKNOWN_STATUSES.join('／')} 之一（實際：${JSON.stringify(node.status)}）`);
  if (typeof node.resolution !== 'string') errors.push('resolution 須為字串（未解決填空字串）');
  if (!Array.isArray(node.evidence)) errors.push('evidence 須為陣列');

  // 「動到六面向就得 blocking」只約束**還沒解決**的節點——已解決的東西依定義不擋任何事，
  // 若連 resolved 都要求 blocking:true，`gateBuild` 就永遠綠不了。
  if (Array.isArray(node.affects) && typeof node.blocking === 'boolean' && node.status !== 'resolved') {
    const mustBlock = node.affects.some((a) => BLOCKING_AFFECTS.includes(a));
    if (mustBlock && node.blocking !== true) {
      errors.push(`affects 含 ${node.affects.filter((a) => BLOCKING_AFFECTS.includes(a)).join('、')} → blocking 必須為 true（不得自我豁免）`);
    }
  }
  if (node.kind === 'known-known' && node.status !== 'resolved') {
    errors.push('known-known 只能由 researched／decided 之後轉入，status 必須是 resolved（AI 的假設不得自行升格成事實）');
  }
  if (node.status === 'resolved' && (typeof node.resolution !== 'string' || !node.resolution.trim())) {
    errors.push('status=resolved 必須寫 resolution（怎麼解掉的）');
  }
  return { ok: errors.length === 0, errors };
}

/** 這個狀態轉移合法嗎。 */
export function canTransition(from, to) {
  return (UNKNOWN_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * 套一次狀態轉移。回 `{ok, node, error}`；非法轉移**不會**改到原節點。
 * `resolved` 一律要求 resolution；轉 `invalidated` 時把 kind 降回 `known-unknown`
 * （既有事實被推翻＝重新變成待答問題，這正是 issue 要的 `invalidated known → known unknown`）。
 */
export function applyTransition(node, to, { resolution = '', evidence = [], kind = null } = {}) {
  if (!canTransition(node?.status, to)) {
    return { ok: false, node, error: `不允許的狀態轉移：${node?.status} → ${to}（合法：${(UNKNOWN_TRANSITIONS[node?.status] ?? []).join('／') || '無'}）` };
  }
  const next = { ...node, status: to };
  if (to === 'resolved') {
    if (!String(resolution).trim()) return { ok: false, node, error: '轉 resolved 必須附 resolution' };
    next.resolution = resolution;
    next.evidence = [...(node.evidence ?? []), ...evidence];
    next.kind = kind ?? 'known-known';
    next.blocking = false;
  } else if (to === 'invalidated') {
    next.kind = 'known-unknown';
    next.resolution = '';
    next.blocking = node.affects.some((a) => BLOCKING_AFFECTS.includes(a));
  } else if (to === 'open' && node.status === 'invalidated') {
    next.kind = 'known-unknown';
  } else if (to === 'open' && node.status === 'discovered') {
    // 被發現的盲點一旦問成明確問題，就是 known-unknown（unknown-unknown 只存在於「還沒被發現」）
    next.kind = 'known-unknown';
  }
  return { ok: true, node: next, error: null };
}

// ── 摘要與閘（純函式）──────────────────────────────────────────────────────

/** 仍未解決（會擋 build）的 unknown。 */
export function openBlocking(nodes) {
  return (nodes || []).filter((n) => n.blocking === true && n.status !== 'resolved');
}

/**
 * 四象限摘要。**unknown-unknown 那格永遠不報「0」**——已被發現的盲點依定義已經轉成
 * known-unknown，所以那格計數只會是 0，報 0 會讓人誤以為「沒有盲點了」。改報已做的盤查次數。
 */
export function summarize(nodes, { blindSpotPasses = [] } = {}) {
  const list = nodes || [];
  const counts = {};
  for (const q of QUADRANTS) counts[q] = list.filter((n) => n.kind === q && n.status !== 'invalidated').length;
  const blocking = openBlocking(list);
  return {
    counts,
    blocking: blocking.map((n) => ({ id: n.id, statement: n.statement, owner: n.owner, affects: [...n.affects] })),
    residualRisk: list.filter((n) => n.status !== 'resolved' && !n.blocking).map((n) => ({ id: n.id, statement: n.statement, owner: n.owner })),
    blindSpotPasses: [...blindSpotPasses],
    unknownUnknownClaim: '未知（本系統不宣稱盲點已清零；只記錄已做的盤查與殘餘風險）',
  };
}

/**
 * build 前的閘：**還有未解決的 blocking unknown 就不准進 build**。
 * 回 `{ok, blocking, reason}`——`ok===false` 時 reason 逐條列出擋在哪、誰負責。
 */
export function gateBuild(nodes) {
  const blocking = openBlocking(nodes);
  if (!blocking.length) return { ok: true, blocking: [], reason: null };
  const lines = blocking.map((n) => `- \`${n.id}\`（owner ${n.owner}，影響 ${n.affects.join('、')}）：${n.statement}`);
  return { ok: false, blocking, reason: `仍有 ${blocking.length} 條未解決的 blocking unknown，不得進 build：\n${lines.join('\n')}` };
}

/** 四象限摘要 → PROGRESS.md／loop.md 用的 markdown 區塊。 */
export function renderRegister(summary) {
  const out = ['## Unknowns Register（四象限）', '', '| 象限 | 數量 |', '|---|---|'];
  for (const q of QUADRANTS) {
    out.push(`| ${q} | ${q === 'unknown-unknown' ? summary.unknownUnknownClaim : summary.counts[q]} |`);
  }
  out.push('');
  if (summary.blocking.length) {
    out.push('**擋著 build 的（未解決）**：', '');
    for (const b of summary.blocking) out.push(`- \`${b.id}\`（owner ${b.owner}，影響 ${b.affects.join('、')}）：${b.statement}`);
    out.push('');
  } else {
    out.push('**擋著 build 的（未解決）**：（無）', '');
  }
  if (summary.residualRisk.length) {
    out.push('**殘餘風險（未解決但不擋）**：', '');
    for (const r of summary.residualRisk) out.push(`- \`${r.id}\`（owner ${r.owner}）：${r.statement}`);
    out.push('');
  }
  out.push(`**已做的 blind-spot pass**：${summary.blindSpotPasses.length ? summary.blindSpotPasses.join('、') : '（尚未做）'}`, '');
  return out.join('\n');
}

// ── IO 薄邊界 ────────────────────────────────────────────────────────────────

/** 從 loop ledger 讀出 unknown node 的最新狀態（同 id 後者覆蓋前者，依檔案行序）。 */
export function readUnknowns(loopDir) {
  const { events, warnings } = readEvents(join(loopDir, 'events.jsonl'));
  const byId = new Map();
  const passes = [];
  for (const ev of events) {
    if (ev.type !== UNKNOWN_EVENT_TYPE) continue;
    const p = ev.payload ?? {};
    if (p.blindSpotPass) { passes.push(String(p.blindSpotPass)); continue; }
    if (typeof p.id !== 'string' || !p.id) continue;
    byId.set(p.id, { ...(byId.get(p.id) ?? {}), ...p });
  }
  return { nodes: [...byId.values()], blindSpotPasses: passes, warnings };
}

/** 把一筆 unknown 寫進 ledger（走 #172 的唯一寫入路徑）。不合法就不寫。 */
export function recordUnknown(loopDir, node) {
  const verdict = validateUnknown(node);
  if (!verdict.ok) throw new Error(`unknowns-register：拒絕寫入不合法的 unknown —— ${verdict.errors.join('；')}`);
  const file = join(loopDir, 'events.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  return appendEvent(file, { type: UNKNOWN_EVENT_TYPE, payload: { ...node } });
}

/** 記一次 blind-spot pass（做過什麼盤查）。 */
export function recordBlindSpotPass(loopDir, label) {
  const file = join(loopDir, 'events.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  return appendEvent(file, { type: UNKNOWN_EVENT_TYPE, payload: { blindSpotPass: String(label) } });
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    process.stdout.write('用法：node unknowns-register.mjs <loop 目錄> [--gate-build] [--json]\n');
    return 0;
  }
  const { nodes, blindSpotPasses } = readUnknowns(dir);
  const summary = summarize(nodes, { blindSpotPasses });
  if (args.includes('--gate-build')) {
    const gate = gateBuild(nodes);
    if (args.includes('--json')) process.stdout.write(`${JSON.stringify(gate, null, 2)}\n`);
    else process.stdout.write(gate.ok ? '✓ 無未解決的 blocking unknown，可進 build\n' : `✗ ${gate.reason}\n`);
    return gate.ok ? 0 : 1;
  }
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(summary, null, 2)}\n` : renderRegister(summary));
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
