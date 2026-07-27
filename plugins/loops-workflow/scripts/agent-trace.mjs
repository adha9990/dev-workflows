#!/usr/bin/env node
// agent-trace.mjs —— agent 派工的結構化 trace envelope，與 phase 的 timestamped 歷史（#217 增量 2）。
//
// 要解的問題：現行做法是事後讀子代理 transcript 的第一段文字、**用關鍵字猜**它是哪種角色
// （含 "reviewer" 就算 verify、含 "impl-author" 就算 build），猜不到的一律丟進 `other-subagent`。
// 於是「哪個 reviewer 最貴」「這筆錢花在 remediate 還是 reverify」永遠問不出來，而且猜錯時
// 沒有任何訊號——一個歸錯戶的數字看起來跟正確的數字一模一樣。
//
// 這裡改成**派工當下就把身分寫進 prompt**：一行 HTML 註解，帶 loop／iteration／workflow node／
// activity／role／task id／task summary／parent／dispatch id。子代理的 transcript 第一則訊息就有它，
// 事後只要解析、不必猜。缺這行的派工由 guard 擋下——**事前補一行，好過事後猜一輩子**。
//
// 另一半是 phase 的 timestamped 歷史：主線 turn 的歸因不能只讀「目前 phase」，否則 session 結束後
// 回頭處理較早的 turn 時，會把它們全部算到最後一個 phase 名下。留下轉換時刻，才接得回當時有效的 phase。
//
// 重用（AGENTS 規則 6）：
//   · 事件的 append／讀回走 `loop-ledger.mjs`（同一套 JSONL 原語，不另寫一份）。
//   · 子代理 transcript 的第一則使用者訊息走 `hooks/cost-tracker.mjs` 已 export 的 `extractFirstUserText`。
//   · workflow node／activity 的值域走 `artifact-contract.mjs` 載入的 canonical vocabulary。
//
// 依賴：僅 node 內建 ＋ 本 repo 內既有 script。

import { mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendEvent, readEvents } from './loop-ledger.mjs';
import { loadWorkflowVocabulary } from './artifact-contract.mjs';
import { extractFirstUserText } from '../hooks/cost-tracker.mjs';
import { normalizeUsage, UNATTRIBUTED_PREFIX } from './telemetry-ledger.mjs';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** envelope 的欄位名（marker 內的 key）↔ 回傳物件的欄位名。 */
const FIELDS = Object.freeze([
  ['loop', 'loopSlug'],
  ['iteration', 'iteration'],
  ['node', 'workflowNode'],
  ['phase', 'phase'],
  ['activity', 'activity'],
  ['role', 'agentRole'],
  ['task', 'taskId'],
  ['summary', 'taskSummary'],
  ['parent', 'parentAgentId'],
  ['dispatch', 'dispatchId'],
]);

const FORBIDDEN_ROLE = 'other-subagent';
const PHASE_TRACE_REL = join('telemetry', 'phase-trace.jsonl');

// ── 值域（來自 canonical vocabulary，不在這裡寫死第二份清單）─────────────────

let vocabularyCache = null;
function vocabulary() {
  if (!vocabularyCache) {
    const loaded = loadWorkflowVocabulary(PLUGIN_ROOT);
    if (loaded.error) throw new Error(`agent-trace：讀不到 workflow vocabulary —— ${loaded.error}`);
    vocabularyCache = loaded.vocabulary;
  }
  return vocabularyCache;
}

/** workflow node ＝ phase 或 control node（`iterate` 不是 node，`iteration-controller` 才是）。 */
export function knownWorkflowNodes() {
  const v = vocabulary();
  return new Set([...v.phases.map((p) => p.id), ...v.control_nodes.map((c) => c.id)]);
}

export function knownPhases() {
  return new Set(vocabulary().phases.map((p) => p.id));
}

export function knownActivities() {
  return new Set(vocabulary().activities.map((a) => a.id));
}

// ── envelope ────────────────────────────────────────────────────────────────

// 值一律包在雙引號內。兩個字元必須轉義：`"` 會提前關掉值，`>` 會讓 `-->` 提前結束整個註解
// （task summary 是自由文字，真的可能含到）。其餘字元原樣保留——envelope 要維持人看得懂。
const escapeValue = (v) => String(v).replace(/"/g, '&quot;').replace(/>/g, '&gt;');
const unescapeValue = (v) => String(v).replace(/&gt;/g, '>').replace(/&quot;/g, '"');

/**
 * 組出 trace envelope 一行。**缺必填欄位或值域不合就直接拋出**——寫出一個必然解析失敗的
 * envelope，等於在派工當下就製造一筆事後歸不了戶的資料。
 */
export function buildTraceEnvelope(input) {
  const v = input ?? {};
  const missing = FIELDS.filter(([, prop]) => v[prop] === undefined || v[prop] === null || v[prop] === '')
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`agent-trace：envelope 缺必填欄位 ${missing.join('、')}`);
  }
  if (!Number.isInteger(v.iteration) || v.iteration < 0) {
    throw new Error(`agent-trace：iteration 必須是 ≥0 的整數（實際：${v.iteration}）`);
  }
  if (v.agentRole === FORBIDDEN_ROLE) {
    throw new Error(`agent-trace：role 不得是 ${FORBIDDEN_ROLE}——每個 agent 都要有真實角色`);
  }
  if (!knownWorkflowNodes().has(v.workflowNode)) {
    throw new Error(`agent-trace：workflow node「${v.workflowNode}」不在 vocabulary 內（成本會歸到一個不存在的維度）`);
  }
  if (!knownPhases().has(v.phase)) {
    throw new Error(`agent-trace：phase「${v.phase}」不在 vocabulary 內`);
  }
  if (!knownActivities().has(v.activity)) {
    throw new Error(`agent-trace：activity「${v.activity}」不在 vocabulary 內`);
  }

  const body = FIELDS.map(([key, prop]) => `${key}="${escapeValue(v[prop])}"`).join(' ');
  return `<!-- loops-trace ${body} -->`;
}

/** 解析一行 envelope → 物件；缺任一必填欄位一律 null（半套 envelope 比沒有更危險）。 */
export function parseTraceEnvelope(line) {
  if (typeof line !== 'string') return null;
  const m = /<!--\s*loops-trace\s+([^>]*?)\s*-->/.exec(line);
  if (!m) return null;

  const attrs = new Map();
  for (const a of m[1].matchAll(/([a-z]+)="([^"]*)"/g)) attrs.set(a[1], unescapeValue(a[2]));

  const out = {};
  for (const [key, prop] of FIELDS) {
    const raw = attrs.get(key);
    if (raw === undefined || raw === '') return null;
    out[prop] = key === 'iteration' ? Number(raw) : raw;
  }
  if (!Number.isInteger(out.iteration)) return null;
  return out;
}

/** 從整段 prompt 中找出 envelope（它可能被放在說明文字之間）。 */
export function extractTraceEnvelope(text) {
  if (typeof text !== 'string') return null;
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseTraceEnvelope(line);
    if (parsed) return parsed;
  }
  return null;
}

// ── guard 判定 ──────────────────────────────────────────────────────────────

/**
 * 判斷一次 Agent 派工是否帶了 trace envelope → `{ allowed, reason?, trace? }`。
 * **抽不到 prompt 一律放行**（fail-open）：判不出來就擋，代價是整個派工面失效，
 * 而擋到的不一定是違規——這是本 hook 家族的既有慣例。
 */
export function evaluateAgentDispatch(toolInput) {
  const prompt = toolInput?.prompt;
  if (typeof prompt !== 'string' || prompt === '') return { allowed: true };

  const trace = extractTraceEnvelope(prompt);
  if (trace) return { allowed: true, trace };

  return {
    allowed: false,
    reason: [
      'agent 派工缺少 trace envelope，成本將無法歸戶（事後只能靠關鍵字猜 role／phase／task，猜錯也沒有訊號）。',
      '請在 prompt 內加入一行：',
      '<!-- loops-trace loop="<slug>" iteration="<n>" node="<phase 或 control node>" phase="<phase>" activity="<activity>" role="<agent role>" task="<task id>" summary="<一句話>" parent="<parent agent id>" dispatch="<dispatch id>" -->',
      'node／phase／activity 的合法值見 references/workflow-vocabulary.json。',
    ].join('\n'),
  };
}

// ── phase trace history ─────────────────────────────────────────────────────

const phaseTracePath = (loopDir) => join(loopDir, PHASE_TRACE_REL);

/**
 * append 一筆 phase 轉換（`at` 為 ISO 時刻）。
 * 目錄在這裡建：`loop-ledger` 明文不建任何目錄，那是呼叫端的責任，而這裡就是呼叫端。
 */
export function appendPhaseTrace(loopDir, entry) {
  const path = phaseTracePath(loopDir);
  mkdirSync(dirname(path), { recursive: true });
  return appendEvent(path, { type: 'phase-trace', payload: { ...entry } });
}

/** 讀回 phase 歷史，**依時間排序**——併發 hook 的落盤順序不保證與發生順序一致。 */
export function readPhaseTrace(loopDir) {
  const { events } = readEvents(phaseTracePath(loopDir));
  return events
    .map((e) => e.payload)
    .filter((p) => p && typeof p.at === 'string')
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * 某個時刻當時有效的 phase → entry 或 null。
 * **第一筆之前一律回 null**：把更早的 turn 歸給最近的一個 phase，就是偽造歸因——
 * 那筆 turn 真的不屬於任何已知 phase，該讓它以 unattributed 的身分被看見。
 */
export function resolvePhaseAt(history, at) {
  if (!Array.isArray(history) || typeof at !== 'string') return null;
  let hit = null;
  for (const entry of history) {
    if (typeof entry?.at !== 'string' || entry.at > at) break;
    hit = entry;
  }
  return hit;
}

// ── 從子代理 transcript 還原 ────────────────────────────────────────────────

/**
 * 讀一份子代理 transcript → `{ runtimeId, agentId, trace, turns, measurement_status, reason? }`。
 *
 * · `runtimeId` 取自檔名（`agent-<id>.jsonl`）——那是 runtime 真正給的身分。
 * · `trace` 來自 prompt 裡的結構化 envelope。**沒有 envelope 就是沒有**：不用關鍵字猜，
 *   agentId 降級成 `unattributed:<runtime-id>` 並附上原因。
 * · `turns` 逐 turn 帶 usage（token 的最小精確單位是 turn）；沒有 usage 的 assistant 行
 *   不算一個可計費 turn，也不補 0。
 */
export function readSubagentTrace(transcriptPath) {
  const runtimeId = basename(String(transcriptPath ?? '')).replace(/\.jsonl$/i, '');
  let content = '';
  try {
    content = readFileSync(transcriptPath, 'utf8');
  } catch (err) {
    return {
      runtimeId,
      agentId: `${UNATTRIBUTED_PREFIX}${runtimeId}`,
      trace: null,
      turns: [],
      measurement_status: 'not_measured',
      reason: `讀不到子代理 transcript：${err?.message ?? err}`,
    };
  }

  const trace = extractTraceEnvelope(extractFirstUserText(content));
  const turns = [];
  let index = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'assistant' || !entry?.message?.usage) continue;
    index += 1;
    const normalized = normalizeUsage(entry.message.usage);
    turns.push({
      turn_id: `${runtimeId}#${index}`,
      model: typeof entry.message.model === 'string' ? entry.message.model : null,
      usage: normalized.usage,
      measurement_status: normalized.measurement_status,
    });
  }

  const measurement_status = turns.length === 0
    ? 'not_measured'
    : (turns.every((t) => t.measurement_status === 'exact') ? 'exact' : 'estimated');

  const result = { runtimeId, agentId: runtimeId, trace, turns, measurement_status };
  if (!trace) {
    result.agentId = `${UNATTRIBUTED_PREFIX}${runtimeId}`;
    result.reason = '子代理 prompt 沒有 trace envelope，無法還原 role／phase／task——不以關鍵字猜測代替';
  }
  if (turns.length === 0) {
    result.reason = result.reason ?? 'transcript 沒有帶 usage 的 assistant 回合，token 用量無從量起';
  }
  return result;
}
