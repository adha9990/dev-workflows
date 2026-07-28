#!/usr/bin/env node
// context-pack-guard.mjs —— Context Pack Gate ＋ Invalidation Gate 的 hook 外殼（#218）。
//
// 為什麼要在**派工當下**擋：共享記憶只有在「每個 repo-aware agent 都從 broker 拿 context」時才成立。
// 只要有一條派工繞過去自己讀整包，那個 agent 就會把架構重新理解一遍——而重複理解在事後的報表上
// 看起來只是「這個 agent 比較貴」，沒有任何訊號指出原因。順帶擋掉更貴的一種：拿**已經失效的事實**
// 去派工，那個 agent 會信心十足地做錯事。
//
// **作用範圍刻意很窄**（四道前置，任一不成立就完全 no-op）：
//   ① flag 未關；② 這次呼叫真的是 Agent／Task 派工；③ cwd 對應到一條**新制** loop
//      （`.loops/<slug>/telemetry/` 已存在）；④ 這條 loop 真的用過共享記憶（事件流裡有 knowledge 事件）。
//   ④ 讓「還沒開始用共享記憶的 loop」與舊 loop 一樣完全不受影響——不靠日期或人工名單。
//
// 判定本體在 `scripts/context-gate.mjs`（純函式、可單測）；本檔只負責讀 payload、解 loop、
// 把結果翻成 hook 的決策信封。出錯一律 **fail-open**（放行）：判不出來就擋，代價是整個派工面失效，
// 而擋到的不一定是違規。事件寫入是 best-effort：寫不進去不影響放行與否。
//
// 依賴：僅 node 內建 ＋ 本 repo 內既有 hook／script。

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { flagEnabled } from './hook-flags.mjs';
import { emitDecision, ACTIVE_HARNESS } from './hook-decision-emit.mjs';
import { resolveLoopContext } from './loop-context.mjs';
import { readGitRevision } from './pr-gate.mjs';
import { isAgentDispatch } from './agent-trace-guard.mjs';
import { evaluateDispatch, loadKnowledge } from '../scripts/context-gate.mjs';
import { NOT_MEASURED, appendConsumed, appendPackConsumed } from '../scripts/knowledge-ledger.mjs';

const HOOK_EVENT = 'PreToolUse';

/**
 * 把一次放行的派工記成 `context-pack.consumed` ＋ 逐條 `knowledge.consumed`。
 *
 * 為什麼要逐條記、而不是只記一筆 pack：「哪個 agent 重用了哪幾條事實」是 S1 唯一直接的訊號。
 * 只記 pack 也推得出來（pack 帶 claimIds），但那是**推導值**——pack 內容之後若被 refresh 或
 * superseded，推導會答出當下的清單而不是當時給出去的那份。逐條記下來，事後問「這個 agent 當時
 * 到底拿到什麼」永遠有正確答案，而且量到的是**實際重用**、不是理論上可重用。
 *
 * 記在**派工當下**而不是交給 skill 自律：漏記不會有任何訊號，重用率就會看起來莫名其妙地低。
 * best-effort：任何失敗都吞掉（觀測不該有能力擋住工作）。
 */
export function recordPackConsumed(ctx, decision, payload) {
  if (!decision?.marker) return;
  const agentRole = decision.marker.role;
  const agentId = payload?.tool_input?.subagent_type ?? agentRole;
  const dispatchId = `${decision.marker.packId}:${payload?.session_id ?? 'unknown'}`;
  try {
    appendPackConsumed(ctx.loopDir, { packId: decision.marker.packId, agentRole, agentId, dispatchId });
    for (const claimId of decision.pack?.claimIds ?? []) {
      appendConsumed(ctx.loopDir, {
        claimId,
        packId: decision.marker.packId,
        agentRole,
        agentId,
        phase: decision.pack?.phase ?? '',
        taskId: decision.marker.taskId,
      });
    }
  } catch { /* 觀測失敗不影響放行 */ }
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return; // payload 壞掉 → 靜默 no-op
  }

  if (!flagEnabled('LOOPS_CONTEXT_PACK_GATE', process.env)) return;
  if (!isAgentDispatch(payload?.tool_name)) return;

  const ctx = resolveLoopContext(payload?.cwd);
  if (!ctx || !ctx.hasTelemetry) return; // 非 loop／舊制 loop：完全不受管

  const knowledge = loadKnowledge(ctx.loopDir);
  if (!knowledge?.enabled) return; // 這條 loop 還沒用共享記憶：無從比對，也無從要求

  const decision = evaluateDispatch({
    prompt: payload?.tool_input?.prompt,
    knowledge,
    revision: readGitRevision(payload?.cwd) ?? NOT_MEASURED,
    loopSlug: ctx.slug,
  });

  if (!decision.allowed) {
    const out = emitDecision({ kind: 'deny', reason: decision.reason }, ACTIVE_HARNESS, HOOK_EVENT);
    if (out) process.stdout.write(`${out}\n`);
    return;
  }
  recordPackConsumed(ctx, decision, payload);
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
