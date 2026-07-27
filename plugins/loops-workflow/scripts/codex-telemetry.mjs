#!/usr/bin/env node
// codex-telemetry.mjs —— Codex 的 capability probe 與 telemetry adapter（#217 增量 4）。
//
// 兩個 harness 共用同一套 workflow vocabulary、artifact contract、telemetry schema 與 cost renderer；
// adapter 只負責把「這個 runtime 實際拿得到的證據」翻成 canonical event。**能力差異只能表現在
// `measurement_status` 與 capability evidence 上，不得長出第二套 schema 或第二份 phase taxonomy**——
// 那會讓 cost 報表對兩個 harness 各說各話，而讀報表的人分不出是工具差異還是真的花得不一樣。
//
// **五種能力分別量測**（per-turn usage／agent identity／parent identity／tool fields／transcript
// locator）：不得用「拿得到 token」推論「拿得到 agent 身分」。這兩件事在 runtime 裡由不同機制提供，
// 用其中一個推另一個，會產生一份看起來完整、實際上有一半是猜的 capability report。
//
// ⚠️ **誠實標記**：本檔的 probe **不假設任何 Codex 輸出形狀**——它只認呼叫端餵進來的
// `runtime.sample`（實際觀測到的一筆樣本）。本 repo 目前**沒有可用的 Codex runtime 實測**，
// 因此 `references/capability-registry.json` 的 codex facets 仍是 `not_measured`。
// 要把它們轉成 supported，必須真的在 Codex 上跑一次 probe、把觀測到的欄位與來源行號填進 report，
// **不得**憑官方文件描述或本檔的參數命名反推——那正是規則 5 要防的形狀。
//
// 依賴：僅 node 內建 ＋ 本 repo 內既有 script。

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadWorkflowVocabulary } from './artifact-contract.mjs';
import { TOKEN_FIELDS, UNATTRIBUTED_PREFIX, TELEMETRY_SCHEMA_VERSION } from './telemetry-ledger.mjs';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 要分別量測的五種能力。刻意逐項列出——少一項就是一個沒人會發現的盲區。 */
export const CAPABILITY_FACETS = Object.freeze([
  'per_turn_usage',
  'agent_identity',
  'parent_identity',
  'tool_fields',
  'transcript_locator',
]);

/** 每種能力「算有證據」的判準：看樣本裡實際出現了哪些欄位，不看文件怎麼寫。 */
const FACET_EVIDENCE = Object.freeze({
  per_turn_usage: (s) => (s?.usage && typeof s.usage === 'object' ? Object.keys(s.usage) : []),
  agent_identity: (s) => (s?.agent_id ? ['agent_id'] : []),
  parent_identity: (s) => (s?.parent_agent_id ? ['parent_agent_id'] : []),
  tool_fields: (s) => (s?.tool && typeof s.tool === 'object' ? Object.keys(s.tool) : []),
  transcript_locator: (s) => (s?.transcript_path ? ['transcript_path'] : []),
});

// ── capability probe ─────────────────────────────────────────────────────────

/**
 * non-mutating probe：只讀呼叫端提供的觀測樣本，**不執行任何會改變狀態的指令**。
 * 回一份 capability report：runtime 版本、逐能力狀態、evidence 欄位與來源行號、量不到的原因。
 */
export function probeCapabilities({ runtime } = {}) {
  const sample = runtime?.sample ?? null;
  const capabilities = {};

  for (const facet of CAPABILITY_FACETS) {
    const fields = runtime ? (FACET_EVIDENCE[facet](sample) ?? []) : [];
    capabilities[facet] = fields.length > 0
      ? {
        status: 'supported',
        evidence: { fields, source_line: sample?.source_line ?? null },
      }
      : {
        status: 'not_measured',
        evidence: { fields: [], source_line: null },
        unavailable_reason: runtime
          ? `這次觀測的樣本沒有出現 ${facet} 對應的欄位——不以其他能力推論它可用`
          : '這台機器上沒有可用的 Codex runtime，沒有任何樣本可觀測',
      };
  }

  const hasPerTurn = capabilities.per_turn_usage.status === 'supported';
  const hasCumulative = Boolean(sample?.cumulative_usage);
  const decided = decideMode({ perTurnUsage: hasPerTurn, cumulativeCounters: hasCumulative });

  const report = {
    schema_version: TELEMETRY_SCHEMA_VERSION,
    harness: 'codex',
    available: Boolean(runtime),
    runtime_version: runtime?.version ?? null,
    mode: decided.mode,
    strategy: decided.strategy,
    capabilities,
  };
  if (!runtime) {
    report.unavailable_reason = '這台機器上沒有可用的 Codex runtime：probe 沒有觀測到任何東西，'
      + '所有能力維持 not_measured。要轉成 supported 必須真的跑一次並填入觀測欄位與來源行號。';
  }
  return report;
}

/**
 * 依實際證據決定 adapter mode。三段式，**沒有第四種「大概可以」**：
 *   · 直接拿得到 per-turn usage → `exact`
 *   · 只有累計計數器 → `estimated` ＋ 明寫策略 `cumulative-delta`（讓讀的人知道數字怎麼來的）
 *   · 兩者都沒有 → `not_measured`，且不給策略（沒有可用做法時不編一個出來）
 */
export function decideMode({ perTurnUsage = false, cumulativeCounters = false } = {}) {
  if (perTurnUsage) return { mode: 'exact', strategy: 'per-turn' };
  if (cumulativeCounters) return { mode: 'estimated', strategy: 'cumulative-delta' };
  return { mode: 'not_measured', strategy: null };
}

/**
 * 累計計數器 → 每個 turn 的用量（相鄰兩筆相減）。
 *
 * 兩個刻意的行為：
 * ① **n 筆快照只推得出 n−1 筆 delta**——第一筆之前沒有基準，把它整筆當成一個 turn 會把
 *    「session 開始前的既有用量」算進第一個 turn。
 * ② **倒退（重置／換 session）不產生負數**：那代表基準換了，這一段就是量不到——
 *    標 `not_measured` 並附原因，而不是記成負數（污染總和）或當成 0（看起來像免費）。
 */
export function cumulativeDeltas(snapshots) {
  const list = Array.isArray(snapshots) ? snapshots : [];
  const out = [];
  for (let i = 1; i < list.length; i += 1) {
    const prev = list[i - 1] ?? {};
    const cur = list[i] ?? {};
    const regressed = TOKEN_FIELDS.some((f) => Number.isFinite(cur[f]) && Number.isFinite(prev[f]) && cur[f] < prev[f]);
    if (regressed) {
      const entry = { measurement_status: 'not_measured', reason: '累計計數器倒退（多半是 session 重置或換了一條 session），這一段的基準已經不同，無法相減' };
      for (const f of TOKEN_FIELDS) entry[f] = null;
      out.push(entry);
      continue;
    }
    const entry = { measurement_status: 'estimated' };
    for (const f of TOKEN_FIELDS) {
      entry[f] = Number.isFinite(cur[f]) && Number.isFinite(prev[f]) ? cur[f] - prev[f] : null;
    }
    out.push(entry);
  }
  return out;
}

// ── normalization ────────────────────────────────────────────────────────────

/** Codex 的欄位名 → canonical 欄位名。只列**實際觀測到**的別名，不預先塞入猜測的對應。 */
const CODEX_USAGE_ALIASES = Object.freeze({
  input_tokens: ['input_tokens'],
  output_tokens: ['output_tokens'],
  cache_creation_tokens: ['cache_creation_tokens'],
  cache_read_tokens: ['cache_read_tokens', 'cached_input_tokens'],
});

/**
 * Codex 原始 usage → canonical 四欄 ＋ measurement_status。
 * 缺的欄位是 `null` 而不是 0：「沒提供」和「用了 0 個」在成本報表上是兩件完全不同的事。
 */
export function normalizeCodexUsage(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { measurement_status: 'not_measured', usage: null, reason: 'runtime 沒有提供這個 turn 的 usage' };
  }
  const usage = {};
  for (const [canonical, aliases] of Object.entries(CODEX_USAGE_ALIASES)) {
    const hit = aliases.find((a) => Number.isFinite(raw[a]));
    usage[canonical] = hit ? raw[hit] : null;
  }
  const missing = TOKEN_FIELDS.filter((f) => usage[f] === null);
  if (missing.length === TOKEN_FIELDS.length) {
    return { measurement_status: 'not_measured', usage: null, reason: 'usage 物件存在但四種 token 一個都沒有' };
  }
  if (missing.length > 0) {
    return { measurement_status: 'estimated', usage, reason: `runtime 只提供了部分欄位，缺：${missing.join('、')}（缺的欄位為 null，不補 0）` };
  }
  return { measurement_status: 'exact', usage };
}

/**
 * runtime 的一個 turn → canonical telemetry 事件。
 * **欄位集合與 Claude 端完全相同**：降級只改 `measurement_status` 與 evidence，不減欄位——
 * 少欄位等於逼下游為兩個 harness 各寫一套讀法。
 */
export function toCanonicalEvent({ runtimeTurn, context, occurredAt, harness = 'codex' }) {
  const t = runtimeTurn ?? {};
  const c = context ?? {};
  const normalized = normalizeCodexUsage(t.usage);

  const hasIdentity = Boolean(c.agent_id);
  const agentId = hasIdentity ? c.agent_id : `${UNATTRIBUTED_PREFIX}${t.runtime_id ?? 'unknown'}`;
  const reasons = [
    hasIdentity ? null : 'runtime 沒有提供 agent identity，無法還原 role／task——不以關鍵字猜測代替',
    normalized.reason,
  ].filter(Boolean);

  return {
    event_type: 'usage.turn',
    occurred_at: occurredAt,
    harness,
    loop_slug: c.loop_slug ?? null,
    session_id: c.session_id ?? 'unknown',
    iteration: Number.isInteger(c.iteration) ? c.iteration : 0,
    plane: c.plane ?? 'main',
    workflow_node: c.workflow_node ?? null,
    phase: c.phase ?? null,
    activity: c.activity ?? null,
    agent_id: agentId,
    parent_agent_id: c.parent_agent_id ?? null,
    agent_role: c.agent_role ?? (hasIdentity ? null : 'unattributed'),
    task_id: c.task_id ?? null,
    task_summary: c.task_summary ?? null,
    model: t.model ?? null,
    effort: t.effort ?? null,
    turn_id: t.turn_id ?? null,
    measurement_status: normalized.measurement_status,
    usage: normalized.usage,
    evidence: {
      source: `${harness}-runtime`,
      ...(reasons.length > 0 ? { reason: reasons.join('；') } : {}),
    },
    event_nonce: `${harness}:${t.turn_id ?? 'unknown'}`,
  };
}

/** 兩個 harness 共用的 workflow taxonomy（唯一來源＝canonical vocabulary）。 */
export function vocabularyFacts() {
  const { vocabulary, error } = loadWorkflowVocabulary(PLUGIN_ROOT);
  if (error) throw new Error(`codex-telemetry：讀不到 workflow vocabulary —— ${error}`);
  return {
    phases: vocabulary.phases.map((p) => p.id),
    controlNodes: vocabulary.control_nodes.map((c) => c.id),
    activities: vocabulary.activities.map((a) => a.id),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  // 這台機器上沒有 Codex runtime 時，probe 依然可跑——它會誠實回報「什麼都沒量到」。
  // 真的要量，由呼叫端把實際觀測到的一筆樣本餵進來（見檔頭誠實標記）。
  const report = probeCapabilities({ runtime: null });
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write([
      `· codex capability probe：available=${report.available}、mode=${report.mode}`,
      ...CAPABILITY_FACETS.map((f) => `  · ${f}：${report.capabilities[f].status}`),
      report.unavailable_reason ? `  → ${report.unavailable_reason}` : '',
    ].filter(Boolean).join('\n') + '\n');
  }
  return 0; // probe 本身永遠成功：「量不到」是一個結果，不是一次失敗
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
