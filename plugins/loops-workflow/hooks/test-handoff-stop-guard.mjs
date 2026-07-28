#!/usr/bin/env node
// test-handoff-stop-guard.mjs —— Handoff Stop Gate 掛上去之後的端到端斷言（#219）。
// 用法（cwd = plugins/loops-workflow）：node hooks/test-handoff-stop-guard.mjs
//
// 這支 hook 的價值全在「在對的時候擋、在對的時候完全不擋」，所以一律用 spawnSync 真的跑起來、
// 餵真的 payload、看真的 stdout（沿用 test-context-pack-guard.mjs 的做法）——import 純函式看回傳值
// 證明不了掛上去會怎樣。
//
// 覆蓋：
//   N-*  完全不管的情形：不是受管 tool、非 loop、沒有 handoff、已 resume、flag 關掉。
//   D-*  該擋的情形：停在 H1 卻要建 worktree / 改 code / 開 PR；停在 H3 卻自己去開 PR。
//   A-*  該放行的情形：同階段的收尾動作、寫 loop 記憶體、唯讀查詢。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendHandoffCreated, appendPaused, appendResumed } from '../scripts/handoff-ledger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, 'handoff-stop-guard.mjs');

let passed = 0;
const failed = [];
const assert = (cond, msg) => {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); } else { failed.push(msg); console.error(`  ✗ ${msg}`); }
};

const TMP = mkdtempSync(join(tmpdir(), 'loops-handoff-guard-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失敗不影響結果 */ } });

const SLUG = '219-demo';
const REVISION = 'a'.repeat(40);

/** 造一個看起來像真的 repo：`.git/HEAD` 指向 loop 分支、`.loops/<slug>/loop.md` 代表已建的 loop。 */
function makeRepo(name, { withHandoff = true, checkpoint = 'issue', resumed = false } = {}) {
  const root = join(TMP, name);
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), `ref: refs/heads/${SLUG}\n`);
  writeFileSync(join(root, '.git', 'refs', 'heads', SLUG), `${REVISION}\n`);
  const loopDir = join(root, '.loops', SLUG);
  mkdirSync(loopDir, { recursive: true });
  writeFileSync(join(loopDir, 'loop.md'), '# loop\n');

  if (withHandoff) {
    const created = appendHandoffCreated(loopDir, {
      checkpoint,
      completed: ['做完這個 checkpoint 的範圍'],
      pending: ['下一位的工作'],
      artifacts: [`.loops/${SLUG}/handoff/${checkpoint}.md`],
      source_revision: REVISION,
      goal_revision: 1,
    }, { stopAfter: checkpoint });
    appendPaused(loopDir, { handoffId: created.handoffId, stopAfter: checkpoint });
    if (resumed) {
      appendResumed(loopDir, { handoffId: created.handoffId, verdict: 'fresh', resumeFrom: 'plan', stopAfter: 'finalized' });
    }
  }
  return root;
}

function run(root, toolName, toolInput, env = {}) {
  const payload = JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd: root, session_id: 's1' });
  const r = spawnSync('node', [GUARD], { input: payload, encoding: 'utf8', env: { ...process.env, ...env } });
  return { stdout: r.stdout ?? '', status: r.status, error: r.error };
}
const denied = (out) => out.stdout.includes('deny');

// ── N：完全不管 ────────────────────────────────────────────────────────────
console.log('\n[N] 作用範圍外一律 no-op');
const paused = makeRepo('paused');
assert(!denied(run(paused, 'Read', { file_path: 'src/a.ts' })), '不是受管 tool ⇒ 不管 [N1]');
assert(!denied(run(join(TMP, 'nowhere'), 'Write', { file_path: 'src/a.ts' })), '非 loop 目錄 ⇒ 不管 [N2]');
assert(!denied(run(makeRepo('no-handoff', { withHandoff: false }), 'Write', { file_path: 'src/a.ts' })),
  '沒有 handoff 事件的 loop（含所有舊 loop）⇒ 完全不管 [N3]');
assert(!denied(run(makeRepo('resumed', { resumed: true }), 'Write', { file_path: 'src/a.ts' })),
  '已經明確 resume ⇒ 不管 [N4]');
assert(!denied(run(paused, 'Write', { file_path: 'src/a.ts' }, { LOOPS_HANDOFF_STOP_GATE: '0' })),
  'flag 關掉 ⇒ 不管 [N5]');
assert(!run(paused, 'Write', { file_path: 'src/a.ts' }).error, 'spawn 無 error [N6]');

// ── D：該擋 ───────────────────────────────────────────────────────────────
console.log('\n[D] 停在 handoff 上、卻要做下一階段的事');
assert(denied(run(paused, 'Write', { file_path: 'src/a.ts' })), '停在 H1 卻改 repo 檔 ⇒ 擋 [D1]');
assert(denied(run(paused, 'Edit', { file_path: 'client/x.tsx' })), 'Edit 同樣受管 [D2]');
assert(denied(run(paused, 'Bash', { command: 'git worktree add .claude/worktrees/219-demo -b 219-demo master' })),
  '停在 H1 卻開 worktree ⇒ 擋 [D3]');
assert(denied(run(paused, 'Bash', { command: 'gh pr create --draft' })), '停在 H1 卻開 PR ⇒ 擋 [D4]');

const pausedAtBuild = makeRepo('paused-build', { checkpoint: 'build' });
assert(denied(run(pausedAtBuild, 'Bash', { command: 'gh pr create --draft' })),
  '停在 H3（交給 QA）卻自己開 PR ⇒ 擋 [D5]');
assert(!denied(run(pausedAtBuild, 'Write', { file_path: 'src/a.ts' })),
  '停在 H3 時同階段的收尾寫入 ⇒ 放行（擋的是下一階段，不是這一階段）[D6]');

const denyOut = run(paused, 'Bash', { command: 'gh pr create' }).stdout;
assert(denyOut.includes('H-issue-1') || denyOut.includes('issue'), 'deny 理由指名停在哪個 handoff [D7]');
assert(denyOut.includes('freshness'), 'deny 理由講得出怎麼才能繼續（跑 freshness → 明確 resume）[D8]');

// ── A：該放行 ─────────────────────────────────────────────────────────────
console.log('\n[A] 停著也做得了的事');
assert(!denied(run(paused, 'Write', { file_path: `.loops/${SLUG}/handoff/issue.md` })),
  '寫交接文件 ⇒ 放行（那正是停下來要做的事）[A1]');
assert(!denied(run(paused, 'Write', { file_path: `.loops/${SLUG}/loop.md` })), '更新 loop 記憶體 ⇒ 放行 [A2]');
assert(!denied(run(paused, 'Bash', { command: 'gh pr view 219 --json state' })), '唯讀查詢 ⇒ 放行 [A3]');
assert(!denied(run(paused, 'Bash', { command: 'git status' })), '看狀態 ⇒ 放行 [A4]');
assert(!denied(run(paused, 'Bash', { command: 'pnpm test' })), '跑測試 ⇒ 放行（不推進工作成果）[A5]');

// ── 壞輸入 ────────────────────────────────────────────────────────────────
console.log('\n[M] 壞輸入不崩');
const bad = spawnSync('node', [GUARD], { input: 'not json', encoding: 'utf8' });
assert(!bad.error && bad.status === 0 && !String(bad.stdout).includes('deny'), 'payload 壞掉 ⇒ 靜默 no-op、exit 0 [M1]');

console.log(`\n${failed.length === 0 ? '✓' : '✗'} handoff-stop-guard：${passed} 個斷言通過、${failed.length} 個失敗`);
for (const f of failed) console.error(`  ✗ ${f}`);
process.exit(failed.length === 0 ? 0 : 1);
