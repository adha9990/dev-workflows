#!/usr/bin/env node
// decision-gate.mjs —— Single Decision Gate ＋ Explore-before-question Gate 的 hook 外殼（#219）。
//
// 為什麼要在**提問當下**擋：這兩條規則過去只寫在 skill 正文裡，而違反它們的代價是延遲的——
// 一次問三題會讓人跳答、漏答，等到發現「這題的答案其實跟那題矛盾」已經是好幾個階段之後；
// 沒探索就提問則會問出「查 code 就有答案」的題目，把 agent 該做的事推回給人。兩者都不會有任何
// 立即訊號，所以只能在動作發生的那一刻擋。
//
// **作用範圍刻意很窄**（三道前置，任一不成立就完全 no-op）：
//   ① flag 未關；② 這次呼叫真的是結構化提問；③ cwd 對應到一條**新制** loop（`telemetry/` 已存在）。
//   ③ 讓舊 loop 完全不受影響——不靠日期或人工名單。
//
// 判定本體在 `scripts/decision-gate.mjs`（純函式、可單測）；本檔只負責讀 payload、解 loop、
// 把結果翻成 hook 的決策信封。出錯一律 **fail-open**（放行）：判不出來就擋，代價是整個提問面失效。
//
// 依賴：僅 node 內建 ＋ 本 repo 內既有 hook／script。

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { flagEnabled } from './hook-flags.mjs';
import { emitDecision, ACTIVE_HARNESS } from './hook-decision-emit.mjs';
import { resolveLoopContext } from './loop-context.mjs';
import { evaluateQuestion, loadLoopState } from '../scripts/decision-gate.mjs';

const HOOK_EVENT = 'PreToolUse';

/**
 * 這次呼叫是不是「向使用者提出結構化問題」。
 *
 * 工具名是**平台細節**：canonical 規則文字（AGENTS／references／skills）一律用「決策點」這個能力
 * 描述，工具名只出現在 hook 與 hook 註冊檔這一層（adapter）。認不得的名字一律回 false —— 猜錯會
 * 讓一個完全無關的工具被擋下來。
 */
export function isStructuredQuestion(toolName) {
  return typeof toolName === 'string' && /(^|_)AskUserQuestion$/.test(toolName);
}

/** 這次要問幾題（拿不到就當一題——多問才是要擋的形狀，拿不到不該擴大打擊面）。 */
export function questionCountOf(toolInput) {
  const questions = toolInput?.questions;
  return Array.isArray(questions) ? questions.length : 1;
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return; // payload 壞掉 → 靜默 no-op
  }

  if (!flagEnabled('LOOPS_DECISION_GATE', process.env)) return;
  if (!isStructuredQuestion(payload?.tool_name)) return;

  const ctx = resolveLoopContext(payload?.cwd);
  if (!ctx || !ctx.hasTelemetry) return; // 非 loop／舊制 loop：完全不受管

  let state;
  try {
    state = loadLoopState(ctx.loopDir);
  } catch {
    return; // 讀不出狀態就放行（fail-open）
  }

  const decision = evaluateQuestion({
    state,
    phase: state.currentStage,
    questionCount: questionCountOf(payload?.tool_input),
  });
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
