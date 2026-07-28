#!/usr/bin/env node
// test-decision-gate.mjs —— Single Decision Gate ＋ Explore-before-question Gate 的判定斷言（#219）。
//
// 釘死三件事：
//   ① **只擋看得見的三種形狀**：一次問多題、還有 pending decision、define／plan 沒有 exploration receipt；
//   ② **不判斷問題問得好不好**——那不可機械判定，擋了只會製造假訊號；
//   ③ **receipt 用既有的共享記憶事件**，不另造第二套資料格式。
//
// 用法：node test-decision-gate.mjs

import { evaluateQuestion, hasExplorationReceipt, pendingDecisions, EXPLORE_BEFORE_QUESTION_PHASES } from './decision-gate.mjs';
import { projectEvents } from './loop-graph.mjs';

let passed = 0;
const failed = [];
const assert = (cond, msg) => {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); } else { failed.push(msg); console.error(`  ✗ ${msg}`); }
};

const decisionEvent = (id, status) => ({ type: 'decision', payload: { decisionId: id, question: `問題 ${id}`, status } });
const claimEvent = () => ({
  type: 'knowledge.claimed',
  payload: {
    claimId: 'K1',
    claim: {
      claim_id: 'K1', kind: 'architecture', statement: 'route 只透過 viewmodel 取資料',
      scope: { files: ['client/**'], symbols: [] },
      sources: [{ type: 'repo-file', locator: 'client/AGENTS.md', digest: `sha256:${'a'.repeat(64)}` }],
      confidence: 'verified', validity: 'valid',
      created_by: { phase: 'define', agent_role: 'explore' }, created_at_revision: 'sha1',
    },
  },
});
const gapEvent = () => ({ type: 'context-gap.detected', payload: { packId: 'p1', role: 'define', gap: '不知道 X 落在哪一層', requestedScope: ['src/x.ts'] } });
const stageEvent = (stage) => ({ type: 'stage-enter', payload: { stage } });

const stateOf = (events) => projectEvents(events, { slug: 'demo' });

// ── ① receipt 判定 ─────────────────────────────────────────────────────────
console.log('\n[A] exploration receipt');
assert(hasExplorationReceipt(stateOf([])) === false, '什麼都沒查過 ⇒ 沒有 receipt [A1]');
assert(hasExplorationReceipt(stateOf([claimEvent()])) === true, '查到事實（knowledge.claimed）就算 receipt [A2]');
assert(hasExplorationReceipt(stateOf([gapEvent()])) === true,
  '指名缺口（context-gap.detected）也算 receipt——「知道自己缺什麼」同樣是探索過的證據 [A3]');
assert(hasExplorationReceipt(stateOf([decisionEvent('D1', 'decided')])) === false,
  '決策事件不是 receipt（那是問答結果，不是探索）[A4]');

// ── ② Explore-before-question ──────────────────────────────────────────────
console.log('\n[B] Explore-before-question');
for (const phase of EXPLORE_BEFORE_QUESTION_PHASES) {
  const r = evaluateQuestion({ state: stateOf([stageEvent(phase)]), phase, questionCount: 1 });
  assert(r.allowed === false && r.violation === 'no-exploration-receipt',
    `${phase} 沒有 receipt 就提問 ⇒ 擋 [B-${phase}]`);
}
assert(evaluateQuestion({ state: stateOf([stageEvent('define'), claimEvent()]), phase: 'define', questionCount: 1 }).allowed,
  '有 receipt 之後就可以問 [B1]');
assert(evaluateQuestion({ state: stateOf([stageEvent('build')]), phase: 'build', questionCount: 1 }).allowed,
  'build 的提問針對已知缺口，不套這條 [B2]');
assert(evaluateQuestion({ state: stateOf([]), phase: null, questionCount: 1 }).allowed,
  '判不出 phase 時不擋（擋錯比漏擋貴）[B3]');

// ── ③ Single Decision ──────────────────────────────────────────────────────
console.log('\n[C] Single Decision');
const withReceipt = [stageEvent('plan'), claimEvent()];
const multi = evaluateQuestion({ state: stateOf(withReceipt), phase: 'plan', questionCount: 3 });
assert(multi.allowed === false && multi.violation === 'multi-question', '一次問三題 ⇒ 擋 [C1]');
assert(multi.reason.includes('3'), 'deny 理由指名實際問了幾題 [C2]');

const pendingState = stateOf([...withReceipt, decisionEvent('D1', 'pending')]);
const blocked = evaluateQuestion({ state: pendingState, phase: 'plan', questionCount: 1 });
assert(blocked.allowed === false && blocked.violation === 'pending-decision',
  '還有未收掉的 decision 就開下一個 ⇒ 擋 [C3]');
assert(blocked.reason.includes('D1'), 'deny 理由指名是哪一筆還沒收 [C4]');
assert(pendingDecisions(pendingState).length === 1, 'pendingDecisions 只算 pending 且未被取代的 [C5]');

const decided = stateOf([...withReceipt, decisionEvent('D1', 'pending'), decisionEvent('D1', 'decided')]);
assert(evaluateQuestion({ state: decided, phase: 'plan', questionCount: 1 }).allowed,
  '答案寫回去（status=decided）之後就能問下一題 [C6]');

// 多題優先於 pending：一次問多題本身就是要擋的形狀，訊息不該先講 pending。
const both = evaluateQuestion({ state: pendingState, phase: 'plan', questionCount: 2 });
assert(both.violation === 'multi-question', '同時違反兩條時先報「一次問多題」[C7]');

console.log(`\n${failed.length === 0 ? '✓' : '✗'} decision-gate：${passed} 個斷言通過、${failed.length} 個失敗`);
for (const f of failed) console.error(`  ✗ ${f}`);
process.exit(failed.length === 0 ? 0 : 1);
