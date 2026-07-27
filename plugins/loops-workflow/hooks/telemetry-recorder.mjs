#!/usr/bin/env node
// telemetry-recorder.mjs —— 把 runtime 實際觀測得到的東西轉成 canonical telemetry 事件（#217 增量 2）。
//
// 兩個入口，同一支 hook：
//   · **Stop**：掃主線 transcript 與所有子代理 transcript，把每個帶 usage 的回合寫成 `usage.turn`。
//   · **PostToolUse（Agent／Task）**：一次派工結束，寫 `agent.stopped`（明確的結束訊號）。
//
// **為什麼需要 watermark**：Stop 每個回合都會觸發，而 transcript 是累積的——每次重掃整份檔，
// 同一個 turn 會被重複看到幾十次。ledger 的 event_id 雖然 deterministic，但寫入前的去重只看檔尾
// 一段窗口（見 telemetry-ledger），早期的 turn 早就滑出窗口外了。所以這裡記住「這份 transcript
// 已經處理到第幾個回合」，每次只處理新增的部分：既冪等，成本也只跟新增量成正比、不跟總長度成正比。
// watermark 走 tmp+rename 原子覆寫（Stop 家族多支 hook 併發，reader 不能讀到半截檔）。
//
// **歸因誠實（#217 S3）**：
//   · 主線 turn 用 timestamp 接回**當時有效**的 phase；transcript 沒給 timestamp 時，退回「最後
//     一筆已知 phase」並在 evidence 標明 `attribution: last-known-phase`——標明推導方式，不假裝精確。
//   · 完全沒有 phase trace 時，不硬塞一個 phase：寫一筆 `telemetry.defect` 說明歸不了戶。
//   · 子代理的 role／task 一律來自 prompt 裡的結構化 envelope；沒有 envelope 就是
//     `unattributed:<runtime-id>`，**不用關鍵字猜**（那是 other-subagent 的來源）。
//
// 出錯一律吞掉、exit 0：觀測不該有能力擋住工作。依賴：僅 node 內建 ＋ 本 repo 內既有 hook／script。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { flagEnabled } from './hook-flags.mjs';
import { ACTIVE_HARNESS } from './hook-decision-emit.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { resolveLoopContext } from './loop-context.mjs';
import { resolveSubagentsDir } from './cost-tracker.mjs';
import { appendTelemetryEvent, normalizeUsage, makeTelemetryDefect } from '../scripts/telemetry-ledger.mjs';
import { readPhaseTrace, resolvePhaseAt, readSubagentTrace, extractTraceEnvelope } from '../scripts/agent-trace.mjs';

const WATERMARK_REL = join('telemetry', '.watermark.json');
/** 派工工具在不同版本叫 Agent 或 Task——兩個都認（與 agent-trace-guard 同一組值）。 */
const DISPATCH_TOOLS = new Set(['Agent', 'Task']);

// ── 純函式 ───────────────────────────────────────────────────────────────────

/**
 * 掃一份 transcript → 帶 usage 的回合清單（1-based index）。
 * 只取 `type==='assistant'` 且有 `message.usage` 的行——沒有 usage 的回合不是「用了 0 token」，
 * 而是「沒量到」，把它算成一個 0 成本的 turn 會讓平均值失真。
 */
export function scanTurns(content) {
  const out = [];
  let index = 0;
  for (const line of String(content ?? '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'assistant' || !entry?.message?.usage) continue;
    index += 1;
    out.push({
      index,
      turnId: typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : `#${index}`,
      at: typeof entry.timestamp === 'string' ? entry.timestamp : null,
      model: typeof entry.message.model === 'string' ? entry.message.model : null,
      usage: entry.message.usage,
    });
  }
  return out;
}

/**
 * 決定一個 turn 該歸到哪個 workflow node／phase／activity。
 * 回 `{ node, phase, activity, iteration, attribution }`，或 null（完全無從歸因）。
 */
export function attributeTurn(history, at) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const exact = at ? resolvePhaseAt(history, at) : null;
  if (exact) {
    return {
      node: exact.workflowNode, phase: exact.phase, activity: exact.activity,
      iteration: exact.iteration ?? 0, attribution: 'timestamped',
    };
  }
  // 沒有 timestamp，或這個時刻早於第一筆 phase：退回最後一筆已知 phase，並標明這是推導值。
  const last = history[history.length - 1];
  return {
    node: last.workflowNode, phase: last.phase, activity: last.activity,
    iteration: last.iteration ?? 0,
    attribution: at ? 'before-first-known-phase' : 'last-known-phase',
  };
}

// ── watermark ────────────────────────────────────────────────────────────────

function readWatermark(loopDir) {
  try {
    return JSON.parse(readFileSync(join(loopDir, WATERMARK_REL), 'utf8'));
  } catch {
    return { main: {}, subagents: {} }; // 沒有就是還沒處理過任何東西
  }
}

function writeWatermark(loopDir, mark) {
  try {
    writeFileAtomic(join(loopDir, WATERMARK_REL), `${JSON.stringify(mark, null, 2)}\n`);
  } catch { /* 寫不進去：下次會重做一次，最壞是多寫幾筆重複事件、由 replay 去重 */ }
}

// ── 事件寫入 ─────────────────────────────────────────────────────────────────

function writeTurnEvent(ctx, { turn, plane, attribution, agentId, agentRole, taskId, taskSummary, parentAgentId, sessionId, reason }) {
  const normalized = normalizeUsage(turn.usage);
  // 兩種「說不清楚」要一起講：歸不了戶的原因（unattributed）與量不到的原因（usage 缺欄）。
  // ledger 對 unattributed 事件強制要求 evidence.reason——少了它整筆會被拒絕寫入。
  const reasons = [reason, normalized.reason].filter(Boolean);
  appendTelemetryEvent(ctx.loopDir, {
    event_type: 'usage.turn',
    occurred_at: turn.at ?? new Date().toISOString(),
    harness: ACTIVE_HARNESS,
    loop_slug: ctx.slug,
    session_id: sessionId,
    iteration: attribution.iteration,
    plane,
    workflow_node: attribution.node,
    phase: attribution.phase,
    activity: attribution.activity,
    agent_id: agentId,
    parent_agent_id: parentAgentId ?? null,
    agent_role: agentRole,
    task_id: taskId ?? null,
    task_summary: taskSummary ?? null,
    model: turn.model,
    effort: null,
    turn_id: turn.turnId,
    measurement_status: normalized.measurement_status,
    usage: normalized.usage,
    evidence: {
      source: plane === 'main' ? 'main-transcript' : 'subagent-transcript',
      attribution: attribution.attribution,
      ...(reasons.length > 0 ? { reason: reasons.join('；') } : {}),
    },
    event_nonce: `${plane}:${turn.turnId}`,
  });
}

/** 主線：只處理 watermark 之後新增的回合。 */
function recordMainTurns(ctx, payload, mark) {
  let content;
  try { content = readFileSync(payload.transcript_path, 'utf8'); } catch { return; }

  const turns = scanTurns(content);
  const key = String(payload.transcript_path);
  const done = Number(mark.main?.[key] ?? 0);
  const fresh = turns.filter((t) => t.index > done);
  if (fresh.length === 0) return;

  const history = readPhaseTrace(ctx.loopDir);
  const attribution = attributeTurn(history, null);
  if (!attribution) {
    // 有 loop、但這條 loop 一個 phase 事件都沒有 → 記診斷，不編一個 phase 出來。
    appendTelemetryEvent(ctx.loopDir, {
      ...makeTelemetryDefect({
        reason: `有 ${fresh.length} 個主線回合待歸因，但這條 loop 沒有任何 phase trace`,
        evidence: { session: payload.session_id ?? null, transcript: key },
      }),
      occurred_at: new Date().toISOString(),
      harness: ACTIVE_HARNESS,
      loop_slug: ctx.slug,
      event_nonce: `main-unattributed:${done}:${turns.length}`,
    });
    return;
  }

  for (const turn of fresh) {
    writeTurnEvent(ctx, {
      turn,
      plane: 'main',
      attribution: attributeTurn(history, turn.at) ?? attribution,
      agentId: 'main',
      agentRole: 'orchestrator',
      sessionId: payload.session_id ?? 'unknown',
    });
  }

  mark.main = { ...(mark.main ?? {}), [key]: turns.length };
}

/** 子代理：逐 transcript 檔各自 watermark（它們各自獨立成長）。 */
function recordSubagentTurns(ctx, payload, mark) {
  const dir = resolveSubagentsDir(payload.transcript_path);
  if (!dir || !existsSync(dir)) return;

  let files = [];
  try { files = readdirSync(dir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl')); } catch { return; }

  const history = readPhaseTrace(ctx.loopDir);
  for (const file of files) {
    const info = readSubagentTrace(join(dir, file));
    const done = Number(mark.subagents?.[file] ?? 0);
    const fresh = info.turns.filter((_, i) => i + 1 > done);
    if (fresh.length === 0) continue;

    // 子代理的 phase／activity 一律取自它自己的 envelope；沒有 envelope 就退回主線的歸因，
    // 並且 agent 身分已經是 unattributed——兩件事分開表達，不互相掩蓋。
    const attribution = info.trace
      ? {
        node: info.trace.workflowNode, phase: info.trace.phase,
        activity: info.trace.activity, iteration: info.trace.iteration, attribution: 'trace-envelope',
      }
      : attributeTurn(history, null);
    if (!attribution) continue;

    // 逐個子代理各自包起來：一個子代理寫不進去（例如它的資料湊不齊該有的欄位），
    // 不該讓同一輪其他子代理的成本一起消失——那會讓帳本少一整批人卻沒有任何訊號。
    try {
      for (const [offset, turn] of fresh.entries()) {
        writeTurnEvent(ctx, {
          turn: { ...turn, at: null, turnId: turn.turn_id ?? `${info.runtimeId}#${done + offset + 1}` },
          plane: 'subagent',
          attribution,
          agentId: info.agentId,
          agentRole: info.trace?.agentRole ?? 'unattributed',
          taskId: info.trace?.taskId ?? null,
          taskSummary: info.trace?.taskSummary ?? null,
          parentAgentId: info.trace?.parentAgentId ?? null,
          sessionId: payload.session_id ?? 'unknown',
          reason: info.reason,
        });
      }
      mark.subagents = { ...(mark.subagents ?? {}), [file]: info.turns.length };
    } catch { /* 這個子代理這輪記不成：不推進它的 watermark，下次再試 */ }
  }
}

/**
 * PostToolUse(Agent／Task)：一次派工結束的明確訊號。
 * 沒有 envelope 的派工在 Agent Gate 就被擋掉了，所以這裡解不到就是解不到——**不猜**。
 * 這個訊號本身不帶 usage（token 由 Stop 分支逐 turn 記），所以 measurement_status 是 not_measured。
 * tool_response 只記「有沒有回應」而不記內容：ledger 是成本帳本，不是把整份回應複製一份的地方。
 */
export function recordAgentStopped(ctx, payload) {
  const trace = extractTraceEnvelope(payload?.tool_input?.prompt ?? '');
  if (!trace) return;

  appendTelemetryEvent(ctx.loopDir, {
    event_type: 'agent.stopped',
    occurred_at: new Date().toISOString(),
    harness: ACTIVE_HARNESS,
    loop_slug: ctx.slug,
    session_id: payload?.session_id ?? 'unknown',
    iteration: trace.iteration,
    plane: 'main',
    workflow_node: trace.workflowNode,
    phase: trace.phase,
    activity: trace.activity,
    agent_id: trace.dispatchId,
    parent_agent_id: trace.parentAgentId,
    agent_role: trace.agentRole,
    task_id: trace.taskId,
    task_summary: trace.taskSummary,
    model: null,
    effort: null,
    turn_id: null,
    measurement_status: 'not_measured',
    evidence: {
      source: 'PostToolUse',
      dispatch_id: trace.dispatchId,
      has_response: Boolean(payload?.tool_response),
    },
    event_nonce: `stopped:${trace.dispatchId}`,
  });
}

/** 這次呼叫是不是 PostToolUse 的 agent 派工分支。 */
export function isAgentPostToolUse(payload) {
  return DISPATCH_TOOLS.has(String(payload?.tool_name ?? ''));
}

// ── IO 薄邊界 ────────────────────────────────────────────────────────────────

function main() {
  let payload;
  try { payload = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }

  if (!flagEnabled('LOOPS_TELEMETRY', process.env)) return;

  const ctx = resolveLoopContext(payload?.cwd);
  if (!ctx || !ctx.hasTelemetry) return; // 非 loop／舊制 loop：完全不受管

  // PostToolUse 分支：一次派工結束，只寫 agent.stopped，不掃 transcript。
  if (isAgentPostToolUse(payload)) {
    recordAgentStopped(ctx, payload);
    return;
  }

  if (!payload?.transcript_path) return;

  const mark = readWatermark(ctx.loopDir);
  recordMainTurns(ctx, payload, mark);
  recordSubagentTurns(ctx, payload, mark);
  writeWatermark(ctx.loopDir, mark);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch {
    // 觀測 hook 絕不可因錯誤擋路
  }
  process.exit(0);
}
