#!/usr/bin/env node
// handoff-stop-guard.mjs —— Handoff Stop Gate 的 hook 外殼（#219）。
//
// 為什麼要在**動作當下**擋：使用者說「先幫我開 issue 就好」，agent 順手建 worktree、進 plan、
// 開始改 code——帳單、context 與 review 面積全部照跑，事後只看得到「這條 loop 比較貴」，
// 沒有任何訊號指出「它跨過了使用者要求的停點」。規範文字擋不住這件事，因為違反它沒有立即代價。
//
// **作用範圍刻意很窄**（三道前置，任一不成立就完全 no-op）：
//   ① flag 未關；② 這次呼叫是會推進工作成果的動作（Bash／PowerShell／檔案寫入）；
//   ③ cwd 對應到一條 loop，**而且這條 loop 目前真的停在某個 handoff 上**。
//   ③ 讓沒有 handoff 事件的舊 loop 與正常推進中的 loop 完全不受影響——不靠日期或人工名單。
//
// 判定本體在 `scripts/handoff-stop.mjs`（純函式、可單測）；本檔只負責讀 payload、解 loop、
// 把結果翻成 hook 的決策信封。出錯一律 **fail-open**（放行）。
//
// 依賴：僅 node 內建 ＋ 本 repo 內既有 hook／script。

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { flagEnabled } from './hook-flags.mjs';
import { emitDecision, ACTIVE_HARNESS } from './hook-decision-emit.mjs';
import { resolveLoopContext } from './loop-context.mjs';
import { evaluateAction } from '../scripts/handoff-stop.mjs';
import { activePause, readHandoffs } from '../scripts/handoff-ledger.mjs';

const HOOK_EVENT = 'PreToolUse';

/** 本 hook 認得的 tool（其餘一律 no-op——擴大打擊面只會擋到不相干的東西）。 */
export function isGuardedTool(toolName) {
  return /^(Bash|PowerShell|Write|Edit|MultiEdit)$/.test(String(toolName ?? ''));
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return; // payload 壞掉 → 靜默 no-op
  }

  if (!flagEnabled('LOOPS_HANDOFF_STOP_GATE', process.env)) return;
  if (!isGuardedTool(payload?.tool_name)) return;

  const ctx = resolveLoopContext(payload?.cwd);
  if (!ctx) return;

  let pause;
  try {
    pause = activePause(readHandoffs(ctx.loopDir).state);
  } catch {
    return; // 讀不出狀態就放行（fail-open）
  }
  if (!pause.paused) return; // 沒停在 handoff 上：完全不受管

  const decision = evaluateAction({ pause, toolName: payload?.tool_name, toolInput: payload?.tool_input });
  if (decision.allowed) return;

  const out = emitDecision({ kind: 'deny', reason: decision.reason }, ACTIVE_HARNESS, HOOK_EVENT);
  if (out) process.stdout.write(`${out}\n`);
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
