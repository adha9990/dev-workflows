#!/usr/bin/env node
// cost-report.mjs —— 由 telemetry ledger deterministic 產生 `deliverables/cost.md`（#217 增量 3）。
//
// 要解的問題：先前的 cost.md 是人手寫的敘述，數字多半是「估的」，而且每條 loop 的欄位與顆粒度都不同，
// 於是它回答不了最該回答的問題——**錢花在哪**。這支 renderer 只做一件事：把 ledger 裡的事件
// 按固定維度攤開成固定的 11 個 section。數字全部來自事件，AI 不得手改（改了下次重生就蓋掉）。
//
// **determinism 是這份檔的核心契約**（#217 S6）：同一份 ledger 重複 render 必須逐位元組相同。
// 因此本檔：① 不讀時鐘（沒有 `Date.now()`／`new Date()`）；② 一切排序都有明確 key，不依賴事件到達
// 順序（併發 hook 的落盤順序本來就不保證）；③ 以 event id 去重（併發寫者會寫出同一 logical event，
// 不去重就會把同一筆算兩次，而金額看起來仍然「合理」、沒有任何訊號會發現）。
//
// **誠實邊界**：沒量到的一律寫 `not_measured`，不補 0——「沒量到」和「量到 0」在成本報表上是
// 完全不同的兩件事，混在一起會讓人以為某個階段很便宜。未知 model 的金額歸零並標註，不套用預設費率。
//
// 重用（AGENTS 規則 6）：費率表與 USD 估算走 `hooks/cost-tracker.mjs` 已 export 的
// `estimateCostUsd`／`isKnownModel`（同一份費率不寫第二份）；phase／activity 的順序與值域走
// canonical vocabulary。既有 `.loops/.metrics/costs.jsonl` 只能當 projection，不反向決定本報表。
//
// 用法：node cost-report.mjs --loop <loopDir> [--out <path>]
//       node cost-report.mjs --loop <loopDir> --stdout

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { estimateCostUsd, isKnownModel } from '../hooks/cost-tracker.mjs';
import { loadWorkflowVocabulary } from './artifact-contract.mjs';
import { readTelemetryEvents, TOKEN_FIELDS } from './telemetry-ledger.mjs';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const ARTIFACT_MARKER = '<!-- loops-artifact: cost-report@1 -->';
const NOT_MEASURED = 'not_measured';
const EMPTY = '（無）';

/** hotspot 的判定門檻。集中成一張表：改門檻是一次刻意的決定，不是散落在各處的魔術數字。 */
export const HOTSPOT_THRESHOLDS = Object.freeze({
  verifyShare: 0.5, // verify＋reverify 佔總 token 超過一半 → 值得看一眼
  findingYield: 0.5, // 確認率低於一半，且發出的條數夠多（見 minFindings）才算訊號
  minFindings: 3,
  duplicateTool: 5, // 同一支工具被叫超過這個次數 → 可能在重複讀同一批東西
  artifactPerPhase: 3,
});

// ── 純函式：彙總 ─────────────────────────────────────────────────────────────

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const zeroTokens = () => ({ input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 });

/** 以 event id 去重，並依「型別＋id」排序 —— 讓後續每一步都與事件到達順序無關。 */
export function normalizeEvents(events) {
  const seen = new Set();
  const out = [];
  for (const e of events ?? []) {
    if (!isObj(e) || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

const payloadOf = (e) => (isObj(e?.payload) ? e.payload : {});
const typeOf = (e) => String(payloadOf(e).event_type ?? e?.type ?? '');

function addTokens(target, usage) {
  for (const f of TOKEN_FIELDS) if (Number.isFinite(usage?.[f])) target[f] += usage[f];
}

/** 一個桶：四種 token ＋ turn 數 ＋ duration ＋ USD ＋ 量測狀態。 */
function makeBucket(label) {
  return { label, turns: 0, tokens: zeroTokens(), durationMs: 0, usd: 0, measured: 0, notMeasured: 0, unknownModel: false };
}

function accumulate(bucket, p) {
  bucket.turns += 1;
  if (!isObj(p.usage)) { bucket.notMeasured += 1; return; }
  bucket.measured += 1;
  addTokens(bucket.tokens, p.usage);
  if (Number.isFinite(p.usage.duration_ms)) bucket.durationMs += p.usage.duration_ms;
  if (isKnownModel(p.model)) {
    bucket.usd += estimateCostUsd({
      inputTokens: p.usage.input_tokens ?? 0,
      outputTokens: p.usage.output_tokens ?? 0,
      cacheWriteTokens: p.usage.cache_creation_tokens ?? 0,
      cacheReadTokens: p.usage.cache_read_tokens ?? 0,
    }, p.model);
  } else {
    bucket.unknownModel = true; // 未知 model 不套預設費率頂替：金額不計入，並在報表標明
  }
}

/** 整體彙總（給 Executive Summary 與 Measurement Status 用）。 */
export function summarize(events) {
  const list = normalizeEvents(events);
  const tokens = zeroTokens();
  let turns = 0;
  let notMeasuredTurns = 0;
  let usd = 0;
  let unknownModel = false;

  for (const e of list) {
    if (typeOf(e) !== 'usage.turn') continue;
    const p = payloadOf(e);
    turns += 1;
    if (!isObj(p.usage)) { notMeasuredTurns += 1; continue; }
    addTokens(tokens, p.usage);
    if (isKnownModel(p.model)) {
      usd += estimateCostUsd({
        inputTokens: p.usage.input_tokens ?? 0,
        outputTokens: p.usage.output_tokens ?? 0,
        cacheWriteTokens: p.usage.cache_creation_tokens ?? 0,
        cacheReadTokens: p.usage.cache_read_tokens ?? 0,
      }, p.model);
    } else {
      unknownModel = true;
    }
  }
  return { turns, notMeasuredTurns, tokens, usd, unknownModel, eventCount: list.length };
}

/** 依一個 key 函式把 usage.turn 分桶。`filter` 讓 phase 與 control node 各自只收自己那部分。 */
function bucketize(events, keyOf, filter = () => true) {
  const buckets = new Map();
  for (const e of events) {
    if (typeOf(e) !== 'usage.turn') continue;
    const p = payloadOf(e);
    if (!filter(p)) continue;
    const key = keyOf(p);
    if (key === null || key === undefined) continue;
    if (!buckets.has(key)) buckets.set(key, makeBucket(String(key)));
    accumulate(buckets.get(key), p);
  }
  return buckets;
}

// ── 純函式：格式化 ───────────────────────────────────────────────────────────

const num = (n) => (Number.isFinite(n) ? String(n) : NOT_MEASURED);
const usdOf = (b) => (b.unknownModel && b.usd === 0 ? NOT_MEASURED : `$${b.usd.toFixed(4)}`);
const durationOf = (b) => (b.durationMs > 0 ? `${b.durationMs} ms` : NOT_MEASURED);
const statusOf = (b) => {
  if (b.measured === 0) return NOT_MEASURED;
  if (b.notMeasured > 0 || b.unknownModel) return `partial（${b.measured}/${b.turns} 量到）`;
  return 'exact';
};

/** 一張表：沒有資料列時印「（無）」而不是留一張空表——空表分不出「沒查」還是「沒問題」。 */
function table(header, rows) {
  if (rows.length === 0) return EMPTY;
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

function bucketRow(b) {
  return [
    b.label, String(b.turns),
    num(b.tokens.input_tokens), num(b.tokens.output_tokens),
    num(b.tokens.cache_creation_tokens), num(b.tokens.cache_read_tokens),
    durationOf(b), usdOf(b), statusOf(b),
  ];
}

const BUCKET_HEADER = ['項目', 'Turns', 'Input', 'Output', 'Cache write', 'Cache read', 'Duration', 'USD', '狀態'];

/** 取出報告中某個 section 的內容（不含標題行）。給測試與其他消費端用。 */
export function sectionOf(markdown, title) {
  const lines = String(markdown ?? '').split('\n');
  const start = lines.findIndex((l) => l === `## ${title}`);
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

// ── 各 section ───────────────────────────────────────────────────────────────

function phaseOrder() {
  const { vocabulary, error } = loadWorkflowVocabulary(PLUGIN_ROOT);
  if (error) return { phases: [], controls: [], activities: [] };
  return {
    phases: vocabulary.phases.map((p) => p.id),
    controls: vocabulary.control_nodes.map((c) => c.id),
    activities: vocabulary.activities.map((a) => a.id),
  };
}

/** 依 canonical 順序排序；不在清單裡的排在後面並依字母序（順序固定＝可重現）。 */
function sortByCanonical(keys, canonical) {
  return [...keys].sort((a, b) => {
    const ia = canonical.indexOf(a);
    const ib = canonical.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
}

function renderMeasurementStatus(s, agents) {
  const rows = [
    ['turn token',
      s.turns === 0 ? NOT_MEASURED
        : (s.notMeasuredTurns === 0 ? 'exact' : `partial（${s.turns - s.notMeasuredTurns}/${s.turns} 量到，${s.notMeasuredTurns} 筆 ${NOT_MEASURED}）`),
      s.turns === 0 ? '沒有任何 usage.turn 事件' : `ledger 的 usage.turn 事件；${s.notMeasuredTurns} 個回合沒有 usage`],
    ['USD', s.unknownModel ? `partial（有未知 model，金額不計入）` : (s.turns === 0 ? NOT_MEASURED : 'estimated'),
      '依公開費率由 token 估算，非帳單權威'],
    ['tool context token', 'estimated', 'tool 只量得到搬動的位元組，位元組不是 token'],
    ['agent 歸戶', agents.unattributed === 0 ? 'exact' : `partial（${agents.unattributed}/${agents.total} 歸不了戶）`,
      'agent 身分取自派工的 trace envelope'],
  ];
  return table(['維度', '狀態', '依據'], rows);
}

function renderExecutiveSummary(s, slug) {
  const total = TOKEN_FIELDS.reduce((acc, f) => acc + s.tokens[f], 0);
  return table(['項目', '值'], [
    ['loop', slug],
    ['事件數', String(s.eventCount)],
    ['回合數（usage.turn）', String(s.turns)],
    ['沒量到用量的回合', String(s.notMeasuredTurns)],
    ['token 合計（四種相加）', s.turns === 0 ? NOT_MEASURED : String(total)],
    ['USD（估算）', s.turns === 0 ? NOT_MEASURED : `$${s.usd.toFixed(4)}`],
  ]);
}

function renderIterationSection(events) {
  const buckets = bucketize(events, (p) => p.iteration);
  const keys = [...buckets.keys()].sort((a, b) => Number(a) - Number(b));
  const rows = keys.map((k) => {
    const b = buckets.get(k);
    const reason = String(k) === '0' ? '初次實作' : '回環（verify 有 finding）';
    return [b.label, reason, ...bucketRow(b).slice(1)];
  });
  return table(['Iteration', '觸發原因', ...BUCKET_HEADER.slice(1)], rows);
}

/**
 * 逐 agent 明細。**分組鍵是 (agent × iteration × phase × activity)，不只是 agent**——
 * 主線 agent 一定會跨多個階段，只用 agent 分組的話，這一列的 Phase／Activity 欄就會停在
 * 它第一次出現的地方，把「3 個回合分散在 build 與 verify」顯示成「3 個回合都在 build」。
 * 數字加總仍然正確，但歸屬欄會誤導讀報表的人——而那正是這張表存在的理由。
 */
function renderAgentDetail(events) {
  const byRow = new Map();
  for (const e of events) {
    if (typeOf(e) !== 'usage.turn') continue;
    const p = payloadOf(e);
    const id = String(p.agent_id ?? NOT_MEASURED);
    const node = p.workflow_node ?? NOT_MEASURED;
    const activity = p.activity ?? NOT_MEASURED;
    const iteration = Number.isInteger(p.iteration) ? p.iteration : 0;
    const key = `${id} ${iteration} ${node} ${activity}`;
    if (!byRow.has(key)) {
      byRow.set(key, {
        key,
        bucket: makeBucket(id),
        id,
        role: p.agent_role ?? NOT_MEASURED,
        taskId: p.task_id ?? '—',
        taskSummary: p.task_summary ?? '—',
        iteration,
        node,
        activity,
        reason: p.evidence?.reason ?? '',
      });
    }
    accumulate(byRow.get(key).bucket, p);
  }

  const rows = [...byRow.keys()].sort().map((key) => {
    const a = byRow.get(key);
    const b = a.bucket;
    return [
      a.id, a.role, `${a.taskId}｜${a.taskSummary}`, String(a.iteration),
      `${a.node} / ${a.activity}`, String(b.turns),
      num(b.tokens.input_tokens), num(b.tokens.output_tokens),
      num(b.tokens.cache_creation_tokens), num(b.tokens.cache_read_tokens),
      durationOf(b), usdOf(b), statusOf(b), a.reason || '—',
    ];
  });
  return table(
    ['Agent', 'Role', 'Task', 'Iteration', 'Phase / Activity', 'Turns', 'Input', 'Output', 'Cache write', 'Cache read', 'Duration', 'USD', '狀態', '備註'],
    rows,
  );
}

function renderToolFootprint(events) {
  const byTool = new Map();
  for (const e of events) {
    if (!typeOf(e).startsWith('tool.')) continue;
    const t = payloadOf(e).tool ?? {};
    const name = String(t.name ?? NOT_MEASURED);
    if (!byTool.has(name)) byTool.set(name, { name, count: 0, input: 0, output: 0, duration: 0, purpose: t.purpose ?? '—' });
    const agg = byTool.get(name);
    agg.count += 1;
    if (Number.isFinite(t.input_bytes)) agg.input += t.input_bytes;
    if (Number.isFinite(t.output_bytes)) agg.output += t.output_bytes;
    if (Number.isFinite(t.duration_ms)) agg.duration += t.duration_ms;
  }
  const rows = [...byTool.keys()].sort().map((k) => {
    const a = byTool.get(k);
    return [a.name, String(a.count), a.purpose, String(a.input), String(a.output),
      a.duration > 0 ? `${a.duration} ms` : NOT_MEASURED, `estimated（位元組不是 token）`];
  });
  return table(['Tool', '次數', '用途', 'Input bytes', 'Output bytes', 'Duration', 'Context tokens'], rows);
}

/** finding 的生命週期計數（去重後以 finding_id 為準，同一條被記兩次不會變成兩條）。 */
export function findingYield(events) {
  const sets = { emitted: new Set(), validated: new Set(), resolved: new Set(), rejected: new Set() };
  const map = {
    'quality.finding-emitted': 'emitted',
    'quality.finding-validated': 'validated',
    'quality.finding-resolved': 'resolved',
    'quality.finding-rejected': 'rejected',
  };
  for (const e of events) {
    const bucket = map[typeOf(e)];
    if (!bucket) continue;
    sets[bucket].add(String(payloadOf(e).finding_id ?? e.id));
  }
  return { emitted: sets.emitted.size, validated: sets.validated.size, resolved: sets.resolved.size, rejected: sets.rejected.size };
}

function renderArtifactFootprint(events) {
  const byArtifact = new Map();
  for (const e of events) {
    const t = typeOf(e);
    if (!t.startsWith('artifact.')) continue;
    const p = payloadOf(e);
    const key = `${p.artifact_id ?? NOT_MEASURED}@${p.template_version ?? '?'}`;
    if (!byArtifact.has(key)) {
      byArtifact.set(key, { id: p.artifact_id ?? NOT_MEASURED, version: p.template_version ?? '?', phase: p.phase ?? '—', validated: false, published: false });
    }
    const a = byArtifact.get(key);
    if (t === 'artifact.validated') a.validated = true;
    if (t === 'artifact.published') a.published = true;
  }
  const rows = [...byArtifact.keys()].sort().map((k) => {
    const a = byArtifact.get(k);
    return [a.id, String(a.version), a.phase, a.validated ? '✓' : '—', a.published ? '✓' : '—'];
  });
  return table(['Artifact', '版本', '產生於', '驗證', '發布'], rows);
}

/** 歸戶概況（unattributed 的數量是 Measurement Status 與 hotspot 共用的訊號）。 */
function agentAttribution(events) {
  const ids = new Set();
  const unattributed = new Set();
  for (const e of events) {
    if (typeOf(e) !== 'usage.turn') continue;
    const id = String(payloadOf(e).agent_id ?? '');
    if (!id) continue;
    ids.add(id);
    if (id.startsWith('unattributed:')) unattributed.add(id);
  }
  return { total: ids.size, unattributed: unattributed.size };
}

function renderHotspots(events, s, agents) {
  const rows = [];
  const add = (phenomenon, evidence, advice) => rows.push([String(rows.length + 1), phenomenon, evidence, advice]);

  // ① verify／reverify 佔比異常
  const verifyBuckets = bucketize(events, () => 'verify', (p) => p.activity === 'review' || p.activity === 'reverify');
  const verifyTokens = verifyBuckets.has('verify')
    ? TOKEN_FIELDS.reduce((acc, f) => acc + verifyBuckets.get('verify').tokens[f], 0) : 0;
  const totalTokens = TOKEN_FIELDS.reduce((acc, f) => acc + s.tokens[f], 0);
  if (totalTokens > 0 && verifyTokens / totalTokens > HOTSPOT_THRESHOLDS.verifyShare) {
    add('驗證動作佔掉大半成本',
      `review＋reverify ${verifyTokens} / 總計 ${totalTokens} token`,
      '看是不是同一批 reviewer 重複派、或修一輪就重驗全部');
  }

  // ② 重複 reviewer / 重複 tool
  const roleCount = new Map();
  for (const e of events) {
    if (typeOf(e) !== 'usage.turn') continue;
    const role = String(payloadOf(e).agent_role ?? '');
    if (!role || role === 'orchestrator' || role === 'unattributed') continue;
    roleCount.set(role, (roleCount.get(role) ?? 0) + 1);
  }
  for (const role of [...roleCount.keys()].sort()) {
    if (roleCount.get(role) > 1) {
      add('同一種 reviewer 出現多次', `role=${role} 共 ${roleCount.get(role)} 個回合`, '確認是分工不同的多次派工，不是同一件事重派');
    }
  }
  const toolCount = new Map();
  for (const e of events) {
    if (!typeOf(e).startsWith('tool.')) continue;
    const name = String(payloadOf(e).tool?.name ?? '');
    if (name) toolCount.set(name, (toolCount.get(name) ?? 0) + 1);
  }
  for (const name of [...toolCount.keys()].sort()) {
    if (toolCount.get(name) > HOTSPOT_THRESHOLDS.duplicateTool) {
      add('同一支工具被大量呼叫', `${name} ${toolCount.get(name)} 次`, '看是不是在重複讀同一批檔案');
    }
  }

  // ③ finding 發很多、確認很少
  const y = findingYield(events);
  if (y.emitted >= HOTSPOT_THRESHOLDS.minFindings && (y.validated / y.emitted) < HOTSPOT_THRESHOLDS.findingYield) {
    add('finding 發得多、確認得少',
      `emitted ${y.emitted}／validated ${y.validated}／resolved ${y.resolved}`,
      '第二輪確認可能沒跑滿，或第一輪產出太多雜訊');
  }

  // ④ unattributed usage
  if (agents.unattributed > 0) {
    add('有歸不了戶的用量',
      `${agents.unattributed} 個 agent 只有 unattributed:<runtime-id>`,
      '派工時補上 trace envelope，這些成本才追得到人');
  }

  // ⑤ measurement gap
  if (s.notMeasuredTurns > 0) {
    add('有回合量不到用量',
      `${s.notMeasuredTurns}／${s.turns} 個回合沒有 usage`,
      '確認 runtime 是否提供 per-turn usage；量不到就維持 not_measured，不要補估算值');
  }

  // ⑥ artifact 產出過度
  const created = events.filter((e) => typeOf(e) === 'artifact.created').length;
  const phases = new Set(events.filter((e) => typeOf(e) === 'usage.turn').map((e) => payloadOf(e).phase)).size || 1;
  if (created > phases * HOTSPOT_THRESHOLDS.artifactPerPhase) {
    add('產出的文件偏多', `${created} 份 artifact / ${phases} 個 phase`, '看是不是產了沒人會讀的中間文件');
  }

  if (rows.length === 0) return EMPTY;
  return table(['#', '現象', '證據', '建議'], rows);
}

// ── 主 renderer ──────────────────────────────────────────────────────────────

/**
 * 由事件流產生完整的 cost.md 內容。
 * 純函式：同樣的 events 一定得到同樣的字串（不讀時鐘、不依賴事件順序、以 id 去重）。
 */
export function renderCostReport(events, { slug = '(unknown)' } = {}) {
  const list = normalizeEvents(events);
  const s = summarize(list);
  const agents = agentAttribution(list);
  const order = phaseOrder();

  const phaseBuckets = bucketize(list, (p) => p.workflow_node, (p) => order.phases.includes(p.workflow_node));
  const controlBuckets = bucketize(list, (p) => p.workflow_node, (p) => order.controls.includes(p.workflow_node));
  const activityBuckets = bucketize(list, (p) => p.activity);
  const y = findingYield(list);

  const phaseRows = sortByCanonical(phaseBuckets.keys(), order.phases).map((k) => bucketRow(phaseBuckets.get(k)));
  const controlRows = sortByCanonical(controlBuckets.keys(), order.controls).map((k) => bucketRow(controlBuckets.get(k)));
  const activityRows = sortByCanonical(activityBuckets.keys(), order.activities).map((k) => bucketRow(activityBuckets.get(k)));

  return [
    ARTIFACT_MARKER,
    `# cost — ${slug} 成本歸因`,
    '',
    '> 這份檔由 `scripts/cost-report.mjs` 從 telemetry ledger 完全生成。手改沒有意義：下次重生會蓋掉。',
    '> 要改內容就補事件，不要改這份檔。沒量到的一律寫 `not_measured`，不補 0。',
    '',
    '## Measurement Status',
    '',
    renderMeasurementStatus(s, agents),
    '',
    '## Executive Summary',
    '',
    renderExecutiveSummary(s, slug),
    '',
    '## By Phase',
    '',
    '只列工作階段。控制節點的成本不併進這張表，見下一節。',
    '',
    table(['Phase', ...BUCKET_HEADER.slice(1)], phaseRows),
    '',
    '## Control Overhead',
    '',
    table(['控制節點', ...BUCKET_HEADER.slice(1)], controlRows),
    '',
    '## By Iteration',
    '',
    renderIterationSection(list),
    '',
    '## By Activity',
    '',
    table(['Activity', ...BUCKET_HEADER.slice(1)], activityRows),
    '',
    '## Agent & Task Detail',
    '',
    renderAgentDetail(list),
    '',
    '## Tool / Context Footprint',
    '',
    renderToolFootprint(list),
    '',
    '## Quality Yield',
    '',
    table(['指標', '數量'], [
      ['finding emitted', String(y.emitted)],
      ['finding validated', String(y.validated)],
      ['finding resolved', String(y.resolved)],
      ['finding rejected', String(y.rejected)],
    ]),
    '',
    '## Artifact & Delivery Footprint',
    '',
    renderArtifactFootprint(list),
    '',
    '## Hotspots and Recommendations',
    '',
    renderHotspots(list, s, agents),
    '',
  ].join('\n');
}

// ── IO 薄邊界 ────────────────────────────────────────────────────────────────

/** 讀一條 loop 的 ledger → 產出 cost.md 內容。 */
export function buildCostReport(loopDir, { slug } = {}) {
  const { events, warnings } = readTelemetryEvents(loopDir);
  const body = renderCostReport(events, { slug: slug ?? loopDir.split(/[/\\]/).pop() });
  // ledger 的健康度警告要浮出來：讀取端靜默吞掉「有東西被丟掉」正是這份設計要防的。
  if (warnings.length === 0) return body;
  return body.replace('## Measurement Status\n',
    `## Measurement Status\n\n> ⚠ 事件流健康度警告：\n${warnings.map((w) => `> - ${w}`).join('\n')}\n`);
}

function main() {
  const args = process.argv.slice(2);
  const loopDir = args.includes('--loop') ? args[args.indexOf('--loop') + 1] : null;
  if (!loopDir) {
    process.stderr.write('用法：node cost-report.mjs --loop <loopDir> [--out <path>] [--stdout]\n');
    return 1;
  }
  const content = buildCostReport(loopDir);
  if (args.includes('--stdout')) {
    process.stdout.write(content);
    return 0;
  }
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(loopDir, 'deliverables', 'cost.md');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, content, 'utf8');
  process.stdout.write(`✓ 已由 telemetry ledger 產生 ${out}\n`);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
