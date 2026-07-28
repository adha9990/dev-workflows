#!/usr/bin/env node
// decision-gate.mjs —— Single Decision Gate ＋ Explore-before-question Gate 的判定核心（#219）。
//
// 兩件事在這裡變成可機械判定：
//   ① **一個 user turn 只能有一個 active blocking decision**。一次多問會讓人跳答、漏答，而且下一題
//      本來就該由上一題的答案收斂——一起問等於放棄收斂。已經有一筆 pending decision 時也不得再開第二筆：
//      先把答案寫回去、重算佇列，才問下一個。
//   ② **`define`／`plan` 第一次提問前必須先探索**。尚未理解現有實作就訪談，會把問題越問越偏；
//      更糟的是問出「查 code 就有答案」的問題，讓人替 agent 做本來該 agent 自己查的事。
//
// **receipt 用既有的共享記憶事件，不另造第二套**（#218 的 `knowledge.claimed`／`context-pack.built`／
// `context-gap.detected` 正好就是「查到什麼、給了誰、還缺什麼」）。再定義一種 receipt 檔案格式，
// 只會多一份要維護、又會漂移的東西。
//
// 誠實邊界：本檔**不判斷問題問得好不好**——那不可機械判定。它只判三件看得見的事：問幾題、
// 有沒有還沒收掉的 pending decision、有沒有探索過。語意品質由 skill 正文與人承接。
//
// 分層：純函式（判定）＋ 薄 IO（讀事件流）。依賴：僅 node 內建 ＋ 本 repo 內既有 script。

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readEvents } from './loop-ledger.mjs';
import { projectEvents } from './loop-graph.mjs';

/** 需要「先探索再提問」的 phase。build／verify 的提問是針對已知缺口，不套這條。 */
export const EXPLORE_BEFORE_QUESTION_PHASES = Object.freeze(['define', 'plan']);

/**
 * 這條 loop 有沒有 exploration receipt。
 * 三種事件任一存在即算數——它們分別是「查到的事實」「組給誰的切片」「指名的缺口」，
 * 都證明「提問之前真的去看過現況」。
 */
export function hasExplorationReceipt(state) {
  const k = state?.knowledge;
  if (!k) return false;
  return (k.claims?.length ?? 0) > 0 || (k.packs?.length ?? 0) > 0 || (k.gaps?.length ?? 0) > 0;
}

/** 仍未收掉的決策（pending 且沒有被後續決策取代）。 */
export function pendingDecisions(state) {
  return (state?.decisions ?? []).filter((d) => d.status === 'pending' && !d.supersededBy);
}

/**
 * 判定一次提問是否放行 → `{ allowed, reason?, violation? }`。
 *
 * `questionCount` 是這次要問幾題（平台的結構化提問一次可以塞多題，那正是要擋的形狀）。
 * `phase` 是目前階段；認不得或不在名單內時只跑 Single Decision 那一條。
 */
export function evaluateQuestion({ state, phase = null, questionCount = 1 } = {}) {
  if (Number.isFinite(questionCount) && questionCount > 1) {
    return {
      allowed: false,
      violation: 'multi-question',
      reason: [
        `一次問了 ${questionCount} 個問題——一個 user turn 只能有一個 active blocking decision（#219 Single Decision Gate）。`,
        '一次多問會讓人跳著答、漏答，而且下一題本來就該由上一題的答案收斂；一起問等於放棄收斂。',
        '請只問優先序最高、且仍然 blocking 的那一題；答案寫回 decision 事件後重算佇列，再問下一題。',
      ].join('\n'),
    };
  }

  const pending = pendingDecisions(state);
  if (pending.length > 0) {
    const list = pending.map((d) => `\`${d.id}\`：${d.question || '(未記錄問題)'}`).join('；');
    return {
      allowed: false,
      violation: 'pending-decision',
      reason: [
        `還有未收掉的決策：${list}`,
        '先把上一題的答案與依據寫回 decision 事件（status: decided），再重算剩下要問什麼——',
        '被那個答案消除的問題不得照舊再問，性質改變的要改寫再問（#219 Decision Queue）。',
      ].join('\n'),
    };
  }

  if (EXPLORE_BEFORE_QUESTION_PHASES.includes(phase) && !hasExplorationReceipt(state)) {
    return {
      allowed: false,
      violation: 'no-exploration-receipt',
      reason: [
        `${phase} 階段在第一次提問之前必須先探索現況（#219 Explore-before-question Gate），目前這條 loop 還沒有任何 exploration receipt。`,
        'receipt ＝ 事件流裡的 `knowledge.claimed`／`context-pack.built`／`context-gap.detected`（查到什麼、給了誰、還缺什麼），',
        '不要求寫長篇探索報告。先看現在怎麼運作、有什麼可重用、有什麼限制，再問**查 code 或 docs 查不到**的那一題。',
      ].join('\n'),
    };
  }

  return { allowed: true };
}

// ── 薄 IO ───────────────────────────────────────────────────────────────────

/** 讀一條 loop 的投影狀態（判定要用的三件事：decisions、knowledge、currentStage）。 */
export function loadLoopState(loopDir) {
  const { events } = readEvents(join(loopDir, 'events.jsonl'));
  return projectEvents(events, { slug: loopDir.split(/[\\/]/).filter(Boolean).pop() });
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    process.stdout.write('用法：node decision-gate.mjs <loop 目錄> [--questions <n>] [--phase <name>] [--json]\n');
    return 0;
  }
  const questionCount = args.includes('--questions') ? Number(args[args.indexOf('--questions') + 1]) : 1;
  const state = loadLoopState(dir);
  const phase = args.includes('--phase') ? args[args.indexOf('--phase') + 1] : state.currentStage;
  const result = evaluateQuestion({ state, phase, questionCount });

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ...result, phase, questionCount }, null, 2)}\n`);
  } else if (result.allowed) {
    process.stdout.write(`✓ decision-gate：可以問這一題（phase ${phase ?? '?'}）。\n`);
  } else {
    process.stdout.write(`✗ decision-gate [${result.violation}]\n${result.reason}\n`);
  }
  return result.allowed ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
