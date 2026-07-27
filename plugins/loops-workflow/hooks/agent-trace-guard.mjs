#!/usr/bin/env node
// agent-trace-guard.mjs —— Agent Gate：派工缺 trace envelope 就擋（#217 增量 2）。
//
// 為什麼要在**派工當下**擋，而不是事後補：子代理的成本歸戶只有兩種做法——派工時把身分寫進
// prompt，或事後讀 transcript 用關鍵字猜。後者猜錯時沒有任何訊號（一個歸錯戶的數字看起來跟
// 正確的一模一樣），而且猜不到的一律落進一個叫 `other-subagent` 的桶子，於是「哪個 reviewer 最貴」
// 這種問題永遠問不出來。事前補一行 envelope，好過事後猜一輩子。
//
// **作用範圍刻意很窄**（三道前置，任一不成立就完全 no-op）：
//   ① flag 未關；② 這次呼叫真的是 Agent／Task 派工；③ cwd 對應到一條**新制** loop
//      （`.loops/<slug>/telemetry/` 已存在）。舊 loop 沒有那個資料夾，所以完全不受影響——
//      這是 #217「舊 loop 不受影響」的機械邊界，不靠日期或人工名單。
//
// 出錯一律 **fail-open**（放行）：判不出來就擋，代價是整個派工面失效，而擋到的不一定是違規。
// 事件寫入是 best-effort：寫不進去不影響放行與否（觀測不該有能力擋住工作）。
//
// 依賴：僅 node 內建 ＋ 本 repo 內既有 hook／script。

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { flagEnabled } from './hook-flags.mjs';
import { emitDecision, ACTIVE_HARNESS } from './hook-decision-emit.mjs';
import { resolveLoopContext } from './loop-context.mjs';
import { evaluateAgentDispatch } from '../scripts/agent-trace.mjs';
import { appendTelemetryEvent } from '../scripts/telemetry-ledger.mjs';

const HOOK_EVENT = 'PreToolUse';
/** 派工工具在不同版本叫 Agent 或 Task——兩個都認，少認一個等於這道閘在該版本形同關閉。 */
const DISPATCH_TOOLS = new Set(['Agent', 'Task']);

/** 這次呼叫是不是一次 agent 派工。 */
export function isAgentDispatch(toolName) {
  return DISPATCH_TOOLS.has(String(toolName ?? ''));
}

/**
 * 把一次成功放行的派工記成 `agent.dispatched`。
 * best-effort：任何失敗都吞掉——telemetry 是觀測，不該有能力擋住真正的工作。
 */
export function recordDispatch(ctx, trace, payload) {
  try {
    appendTelemetryEvent(ctx.loopDir, {
      event_type: 'agent.dispatched',
      occurred_at: new Date().toISOString(),
      harness: ACTIVE_HARNESS,
      loop_slug: ctx.slug,
      session_id: payload?.session_id ?? 'unknown',
      iteration: trace.iteration,
      plane: 'main', // 派工這個動作本身發生在主線；子代理自己的 turn 另外記在 subagent plane
      workflow_node: trace.workflowNode,
      phase: trace.phase,
      activity: trace.activity,
      agent_id: trace.dispatchId,
      parent_agent_id: trace.parentAgentId,
      agent_role: trace.agentRole,
      task_id: trace.taskId,
      task_summary: trace.taskSummary,
      model: payload?.tool_input?.model ?? null,
      effort: payload?.tool_input?.effort ?? null,
      turn_id: null,
      measurement_status: 'not_measured', // 派工當下還沒有任何 usage 可言
      evidence: { source: 'PreToolUse', dispatch_id: trace.dispatchId },
      event_nonce: trace.dispatchId,
    });
  } catch { /* 觀測失敗不影響放行 */ }
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return; // payload 壞掉 → 靜默 no-op
  }

  if (!flagEnabled('LOOPS_AGENT_TRACE_GATE', process.env)) return;
  if (!isAgentDispatch(payload?.tool_name)) return;

  const ctx = resolveLoopContext(payload?.cwd);
  if (!ctx || !ctx.hasTelemetry) return; // 非 loop／舊制 loop：完全不受管

  const decision = evaluateAgentDispatch(payload?.tool_input);
  if (!decision.allowed) {
    const out = emitDecision({ kind: 'deny', reason: decision.reason }, ACTIVE_HARNESS, HOOK_EVENT);
    if (out) process.stdout.write(`${out}\n`);
    return;
  }
  if (decision.trace) recordDispatch(ctx, decision.trace, payload);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch {
    // hook 絕不可因錯誤擋路：吞掉所有例外
  }
  process.exit(0);
}
