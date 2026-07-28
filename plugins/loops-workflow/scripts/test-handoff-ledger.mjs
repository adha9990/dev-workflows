#!/usr/bin/env node
// test-handoff-ledger.mjs —— handoff checkpoint 的契約、事件、stop_after 與 resume freshness（#219）。
//
// 釘死四件事：
//   ① **stop_after 解析的優先序**（明講的 > 意圖字面 > 入口預設）——猜錯的代價是跨過使用者要求的停點；
//   ② **contract 形狀**：值域全部來自 canonical vocabulary，`completed` 空的 ready 是自相矛盾；
//   ③ **freshness 的三態**：`not_measured` **不算通過**，而且失敗只回到最早受影響的階段、不整條重跑；
//   ④ **事件順序**：`workflow.paused` 必須在 `handoff.created` 成功之後——反過來會留下
//      「停住了、但沒有交接內容」的狀態，下一位既不知道做完了什麼也不知道從哪接。
//
// 用法：node test-handoff-ledger.mjs

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  NOT_MEASURED, checkHandoffContract, normalizeHandoff, resolveStopAfter, reachedStopAfter,
  crossesHandoff, evaluateFreshness, checkpointIds, stopAfterValues, checkpointRequiredContent,
  appendHandoffCreated, appendPaused, appendAccepted, appendResumed, readHandoffs, activePause,
} from './handoff-ledger.mjs';
import { classifyCommand, classifyWrite, classifyAction, evaluateAction } from './handoff-stop.mjs';

let passed = 0;
const failed = [];
const assert = (cond, msg) => {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); } else { failed.push(msg); console.error(`  ✗ ${msg}`); }
};

const TMP = mkdtempSync(join(tmpdir(), 'loops-handoff-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失敗不影響結果 */ } });

const baseHandoff = (over = {}) => ({
  checkpoint: 'issue',
  status: 'ready',
  stop_reason: 'requested-scope',
  completed: ['開好 issue #219'],
  pending: ['plan 設計'],
  artifacts: ['.loops/219-x/handoff/issue.md'],
  source_revision: 'a'.repeat(40),
  goal_revision: 1,
  next_entry: 'issue',
  suggested_owner: 'pm',
  ...over,
});

// ── ① 值域與 stop_after 解析 ───────────────────────────────────────────────
console.log('\n[A] 值域與 stop_after 解析');
assert(checkpointIds().join(',') === 'issue,plan,build,verified,finalized,research-finalized',
  'checkpoint 值域＝六個，順序固定 [A1]');
assert(stopAfterValues().every((v) => checkpointIds().includes(v)),
  '每個 stop_after 都對得到一個 checkpoint [A2]');

assert(resolveStopAfter({ explicit: 'build', intent: '先開 issue', entry: 'issue' }).stopAfter === 'build',
  '明講的優先於意圖與入口預設 [A3]');
assert(resolveStopAfter({ intent: '幫我先開 issue 就好', entry: 'no-issue' }).stopAfter === 'issue',
  '意圖字面優先於入口預設 [A4]');
assert(resolveStopAfter({ entry: 'verify-only' }).stopAfter === 'verified',
  '都沒有時才用入口的安全預設終點 [A5]');
assert(resolveStopAfter({}).stopAfter === null && resolveStopAfter({}).source === 'unresolved',
  '什麼都沒有時誠實回 unresolved，不猜一個 [A6]');
let threw = false;
try { resolveStopAfter({ explicit: 'buidl' }); } catch { threw = true; }
assert(threw, '打錯字的 stop_after 直接拋，不靜默退成預設 [A7]');

// ── ② contract 形狀 ────────────────────────────────────────────────────────
console.log('\n[B] contract 形狀');
assert(checkHandoffContract(baseHandoff()) === null, '完整的 contract 通過 [B1]');
assert(checkHandoffContract(baseHandoff({ checkpoint: 'H1' }))?.reason.includes('checkpoint'),
  '認不得的 checkpoint 被指名擋下 [B2]');
assert(checkHandoffContract(baseHandoff({ suggested_owner: 'boss' }))?.reason.includes('suggested_owner'),
  '認不得的 owner 被指名擋下 [B3]');
assert(checkHandoffContract(baseHandoff({ completed: [] }))?.reason.includes('completed'),
  'status=ready 但 completed 為空＝自相矛盾，擋下 [B4]');
assert(checkHandoffContract(baseHandoff({ pending: undefined }))?.reason.includes('pending'),
  '陣列欄位省略（而非給空陣列）擋下——省略與「刻意沒有」分不出來 [B5]');
assert(checkHandoffContract(baseHandoff({ source_revision: '' }))?.reason.includes('source_revision'),
  'source_revision 留空擋下，量不到要寫 not_measured [B6]');
assert(checkHandoffContract(baseHandoff({ next_entry: null })) === null,
  '終點 checkpoint 的 next_entry 可以是 null [B7]');
assert(checkHandoffContract(baseHandoff({ next_entry: 'somewhere' }))?.reason.includes('next_entry'),
  'next_entry 填了就得是認得的入口 [B8]');

const { handoff: normalized, adjustments } = normalizeHandoff({
  checkpoint: 'build', completed: ['做完 slice 1'], pending: [], artifacts: [],
});
assert(normalized.next_entry === 'verify-only' && normalized.suggested_owner === 'engineer',
  'next_entry / suggested_owner 由 checkpoint 推得 [B9]');
assert(normalized.source_revision === NOT_MEASURED && adjustments.some((a) => a.includes('not_measured')),
  '沒給 source_revision ⇒ 降級成 not_measured 並留痕，不編一個值 [B10]');
assert(checkpointRequiredContent('build').some((x) => x.includes('deterministic')),
  'checkpoint 的必交代內容從 vocabulary 取得（不在程式碼裡抄第二份）[B11]');

// ── ③ 越界判定 ─────────────────────────────────────────────────────────────
console.log('\n[C] 越界判定');
assert(reachedStopAfter('define', 'issue') === true, '做完 define 就到達 stop_after=issue [C1]');
assert(reachedStopAfter('build', 'issue') === true,
  '跳過中間階段也算到達（用 order 比較，不是字串相等）[C2]');
assert(reachedStopAfter('define', 'finalized') === false, '離終點還早就不算到達 [C3]');
assert(crossesHandoff('issue', 'plan') === true, '停在 H1 時進 plan 算越界 [C4]');
assert(crossesHandoff('issue', 'define') === false, '停在 H1 時做 define 自己的收尾不算越界 [C5]');
assert(crossesHandoff('build', 'verify') === true, '停在 H3 時自己去 verify 算越界 [C6]');
assert(crossesHandoff('finalized', 'finalize') === false, '停在終點時 finalize 本身不算越界 [C7]');

// ── ④ 動作分類（Handoff Stop Gate 的判定核心）───────────────────────────────
console.log('\n[D] 動作分類');
assert(classifyCommand('gh issue create --title x') === 'issue-create', '認得建 issue [D1]');
assert(classifyCommand('git worktree add .claude/worktrees/x -b x master') === 'worktree-create',
  '認得開 worktree [D2]');
assert(classifyCommand('git -C /other worktree add w -b b') === 'worktree-create',
  '夾了 -C 全域選項的 git 呼叫也認得 [D3]');
assert(classifyCommand('gh pr create --draft') === 'pr-write', '認得開 PR [D4]');
assert(classifyCommand('gh issue comment 219 --body x') === 'outbound-comment', '認得對外留言 [D5]');
assert(classifyCommand('gh pr view 219 --json state') === null,
  '唯讀查詢不歸類（停在 handoff 上仍然可以看）[D6]');
assert(classifyCommand('gh issue comment 1 --body "別忘了 gh pr create"') === 'outbound-comment',
  '引號內的指令字樣不會讓它被誤判成更後面的階段 [D7]');
assert(classifyWrite('src/index.ts') === 'repo-write', '改 repo 檔算 build [D8]');
assert(classifyWrite('.loops/219-x/handoff/issue.md') === null,
  '寫 loop 記憶體一律放行——那正是交接本身要做的事 [D9]');
assert(classifyAction({ toolName: 'Read', toolInput: { file_path: 'a.ts' } }) === null,
  '認不得的 tool 一律放行（擋錯比漏擋貴）[D10]');

const pause = { paused: true, stopAfter: 'issue', handoff: { handoffId: 'H-issue-1', checkpoint: 'issue' } };
assert(evaluateAction({ pause, toolName: 'Write', toolInput: { file_path: 'src/a.ts' } }).allowed === false,
  '停在 H1 時改 repo 檔被擋 [D11]');
assert(evaluateAction({ pause, toolName: 'Write', toolInput: { file_path: '.loops/x/loop.md' } }).allowed === true,
  '停在 H1 時寫 loop 記憶體放行 [D12]');
assert(evaluateAction({ pause: { paused: false }, toolName: 'Write', toolInput: { file_path: 'src/a.ts' } }).allowed === true,
  '沒停在 handoff 上就完全不管 [D13]');
assert(evaluateAction({ pause, toolName: 'Bash', toolInput: { command: 'gh pr create' } }).reason.includes('resume'),
  'deny 理由要講得出「怎麼才能繼續」（明確 resume）[D14]');

// ── ⑤ freshness ────────────────────────────────────────────────────────────
console.log('\n[E] resume freshness');
const h = baseHandoff({ checkpoint: 'issue', next_entry: 'issue' });
const fresh = evaluateFreshness({
  handoff: h,
  observed: { sourceRevision: h.source_revision, goalRevision: 1, missingArtifacts: [], pendingStillValid: true },
});
assert(fresh.verdict === 'fresh' && fresh.resumeFrom === 'plan',
  '四項全過 ⇒ fresh，且直接從下一個入口的起點續跑（不重跑 define）[E1]');
assert(fresh.invalidated.length === 0, 'fresh 時沒有東西被失效 [E2]');

const staleGoal = evaluateFreshness({
  handoff: h,
  observed: { sourceRevision: h.source_revision, goalRevision: 2, missingArtifacts: [], pendingStillValid: true },
});
assert(staleGoal.verdict === 'stale' && staleGoal.resumeFrom === 'plan',
  'Goal Contract 改版 ⇒ 回到 plan（不是回到 define 整條重跑）[E3]');

const staleSource = evaluateFreshness({
  handoff: baseHandoff({ checkpoint: 'build', next_entry: 'verify-only' }),
  observed: { sourceRevision: 'b'.repeat(40), goalRevision: 1, missingArtifacts: [], pendingStillValid: true },
});
assert(staleSource.verdict === 'stale' && staleSource.resumeFrom === 'build',
  '來源版本變了 ⇒ 回到 build [E4]');

const unmeasured = evaluateFreshness({
  handoff: baseHandoff({ source_revision: NOT_MEASURED }),
  observed: { goalRevision: 1, missingArtifacts: [], pendingStillValid: true },
});
assert(unmeasured.verdict === 'uncertain',
  'not_measured 不算通過——沒查過就當沒問題正是靜默重跑錯東西的來源 [E5]');
assert(unmeasured.checks.find((c) => c.id === 'source-revision').result === NOT_MEASURED,
  '沒量到的那一項如實標 not_measured [E6]');

const partial = evaluateFreshness({
  handoff: h,
  observed: { sourceRevision: h.source_revision, goalRevision: 1, missingArtifacts: ['.loops/219-x/handoff/issue.md'] },
});
assert(partial.verdict === 'stale' && partial.invalidated.some((i) => i.check === 'artifact-validity'),
  '產物不見了 ⇒ stale，並指名是哪一項失效 [E7]');

// ── ⑥ 事件流 ───────────────────────────────────────────────────────────────
console.log('\n[F] 事件流與投影');
const loopDir = join(TMP, 'loop');
mkdirSync(loopDir, { recursive: true });
writeFileSync(join(loopDir, 'loop.md'), '# loop\n');

let pausedThrew = false;
try { appendPaused(loopDir, { handoffId: 'H-issue-1', stopAfter: 'issue' }); } catch { pausedThrew = true; }
assert(pausedThrew, 'handoff.created 之前寫 workflow.paused 直接拋 [F1]');

const created = appendHandoffCreated(loopDir, baseHandoff(), { stopAfter: 'issue' });
assert(created.handoffId === 'H-issue-1', 'handoff id 可讀且可查（checkpoint + 序號）[F2]');
appendPaused(loopDir, { handoffId: created.handoffId, stopAfter: 'issue' });

let state = readHandoffs(loopDir).state;
assert(activePause(state).paused === true && activePause(state).stopAfter === 'issue',
  'paused 之後 activePause 讀得出停在哪 [F3]');

appendAccepted(loopDir, { handoffId: created.handoffId, owner: 'engineer' });
appendResumed(loopDir, { handoffId: created.handoffId, verdict: 'fresh', resumeFrom: 'plan', stopAfter: 'finalized' });
state = readHandoffs(loopDir).state;
assert(activePause(state).paused === false, 'resume 之後不再是暫停狀態 [F4]');
assert(state.handoffs[0].accepted === true && state.resumes[0].resumeFrom === 'plan',
  '接手與 resume 的判定都留在事件流裡（事後查得出憑什麼不重跑）[F5]');

let verdictThrew = false;
try { appendResumed(loopDir, { handoffId: created.handoffId, verdict: 'probably-fine', resumeFrom: 'plan' }); } catch { verdictThrew = true; }
assert(verdictThrew, '認不得的 freshness verdict 直接拋 [F6]');

const second = appendHandoffCreated(loopDir, baseHandoff({ checkpoint: 'plan', completed: ['plan 定案'], next_entry: 'approved-plan', suggested_owner: 'architect' }), { stopAfter: 'plan' });
assert(second.handoffId === 'H-plan-1', '不同 checkpoint 各自編號 [F7]');
assert(readHandoffs(loopDir).state.handoffs.length === 2, '兩份 handoff 都投影得出來 [F8]');

// ── 結果 ───────────────────────────────────────────────────────────────────
console.log(`\n${failed.length === 0 ? '✓' : '✗'} handoff-ledger：${passed} 個斷言通過、${failed.length} 個失敗`);
for (const f of failed) console.error(`  ✗ ${f}`);
process.exit(failed.length === 0 ? 0 : 1);
