#!/usr/bin/env node
// test-decision-gate.mjs —— Single Decision Gate ＋ Explore-before-question Gate 掛上去之後的端到端斷言（#219）。
// 用法（cwd = plugins/loops-workflow）：node hooks/test-decision-gate.mjs
//
// 一律 spawnSync 真的跑起來、餵真的 payload、看真的 stdout——import 純函式證明不了掛上去會怎樣。
//
// 覆蓋：
//   N-*  完全不管的情形：不是提問、非 loop、舊制 loop、flag 關掉。
//   D-*  該擋的情形：一次問多題、還有未收掉的 decision、define/plan 沒探索就提問。
//   A-*  該放行的情形：有 receipt 的單題提問、build 階段的提問。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendEvent } from '../scripts/loop-ledger.mjs';
import { digestOf, appendClaim } from '../scripts/knowledge-ledger.mjs';
import { isStructuredQuestion, questionCountOf } from './decision-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, 'decision-gate.mjs');

let passed = 0;
const failed = [];
const assert = (cond, msg) => {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); } else { failed.push(msg); console.error(`  ✗ ${msg}`); }
};

const TMP = mkdtempSync(join(tmpdir(), 'loops-decision-gate-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失敗不影響結果 */ } });

const SLUG = '219-ask';
const REVISION = 'a'.repeat(40);

function makeRepo(name, { newProtocol = true, phase = 'define', withReceipt = true, pending = false } = {}) {
  const root = join(TMP, name);
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), `ref: refs/heads/${SLUG}\n`);
  writeFileSync(join(root, '.git', 'refs', 'heads', SLUG), `${REVISION}\n`);
  const loopDir = join(root, '.loops', SLUG);
  mkdirSync(loopDir, { recursive: true });
  writeFileSync(join(loopDir, 'loop.md'), '# loop\n');
  if (newProtocol) mkdirSync(join(loopDir, 'telemetry'), { recursive: true });

  const ledger = join(loopDir, 'events.jsonl');
  appendEvent(ledger, { type: 'stage-enter', payload: { stage: phase } });
  if (withReceipt) {
    appendClaim(loopDir, {
      claim_id: 'K1', kind: 'convention', statement: 'issue 一律用 repo template 開',
      scope: { files: ['.github/**'], symbols: [] },
      sources: [{ type: 'repo-file', locator: '.github/ISSUE_TEMPLATE/feature.yml', digest: digestOf('內容') }],
      confidence: 'verified', validity: 'valid',
      created_by: { phase, agent_role: 'explore' }, created_at_revision: REVISION,
    });
  }
  if (pending) {
    appendEvent(ledger, { type: 'decision', payload: { decisionId: 'D1', question: '要不要納入 X', status: 'pending' } });
  }
  return root;
}

function run(root, toolName, toolInput, env = {}) {
  const payload = JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd: root, session_id: 's1' });
  const r = spawnSync('node', [GUARD], { input: payload, encoding: 'utf8', env: { ...process.env, ...env } });
  return { stdout: r.stdout ?? '', status: r.status, error: r.error };
}
const denied = (out) => out.stdout.includes('deny');
const oneQuestion = { questions: [{ question: '要納入 X 嗎？', header: 'Scope', options: [] }] };
const threeQuestions = { questions: [oneQuestion.questions[0], oneQuestion.questions[0], oneQuestion.questions[0]] };

// ── 純函式：工具名與題數 ───────────────────────────────────────────────────
console.log('\n[P] 工具名與題數判定');
assert(isStructuredQuestion('AskUserQuestion') === true, '認得結構化提問工具 [P1]');
assert(isStructuredQuestion('mcp__x__AskUserQuestion') === true, '帶前綴的同名工具也認得 [P2]');
assert(isStructuredQuestion('Read') === false && isStructuredQuestion(undefined) === false,
  '認不得的名字一律 false（猜錯會擋到無關的工具）[P3]');
assert(questionCountOf(threeQuestions) === 3, '題數取自 questions 陣列 [P4]');
assert(questionCountOf({}) === 1, '拿不到題數就當一題（不擴大打擊面）[P5]');

// ── N：完全不管 ────────────────────────────────────────────────────────────
console.log('\n[N] 作用範圍外一律 no-op');
const ready = makeRepo('ready');
assert(!denied(run(ready, 'Read', { file_path: 'a.ts' })), '不是提問 ⇒ 不管 [N1]');
assert(!denied(run(join(TMP, 'nowhere'), 'AskUserQuestion', threeQuestions)), '非 loop 目錄 ⇒ 不管 [N2]');
assert(!denied(run(makeRepo('legacy', { newProtocol: false, withReceipt: false }), 'AskUserQuestion', threeQuestions)),
  '舊制 loop（沒有 telemetry/）⇒ 完全不管 [N3]');
assert(!denied(run(ready, 'AskUserQuestion', threeQuestions, { LOOPS_DECISION_GATE: '0' })), 'flag 關掉 ⇒ 不管 [N4]');
assert(!run(ready, 'AskUserQuestion', oneQuestion).error, 'spawn 無 error [N5]');

// ── D：該擋 ───────────────────────────────────────────────────────────────
console.log('\n[D] 該擋的三種形狀');
const multi = run(ready, 'AskUserQuestion', threeQuestions);
assert(denied(multi), '一次問三題 ⇒ 擋 [D1]');
assert(multi.stdout.includes('3'), 'deny 理由指名問了幾題 [D2]');

const withPending = run(makeRepo('pending', { pending: true }), 'AskUserQuestion', oneQuestion);
assert(denied(withPending) && withPending.stdout.includes('D1'),
  '還有未收掉的 decision 就開下一個 ⇒ 擋，並指名是哪一筆 [D3]');

const noReceipt = run(makeRepo('no-receipt', { withReceipt: false }), 'AskUserQuestion', oneQuestion);
assert(denied(noReceipt) && noReceipt.stdout.includes('receipt'),
  'define 沒有 exploration receipt 就提問 ⇒ 擋 [D4]');

const planNoReceipt = run(makeRepo('plan-no-receipt', { phase: 'plan', withReceipt: false }), 'AskUserQuestion', oneQuestion);
assert(denied(planNoReceipt), 'plan 同樣受這條約束 [D5]');

// ── A：該放行 ─────────────────────────────────────────────────────────────
console.log('\n[A] 該放行');
assert(!denied(run(ready, 'AskUserQuestion', oneQuestion)), '有 receipt 的單題提問 ⇒ 放行 [A1]');
assert(!denied(run(makeRepo('build', { phase: 'build', withReceipt: false }), 'AskUserQuestion', oneQuestion)),
  'build 的提問針對已知缺口，不套 explore-before-question [A2]');

// ── 壞輸入 ────────────────────────────────────────────────────────────────
console.log('\n[M] 壞輸入不崩');
const bad = spawnSync('node', [GUARD], { input: 'not json', encoding: 'utf8' });
assert(!bad.error && bad.status === 0 && !String(bad.stdout).includes('deny'), 'payload 壞掉 ⇒ 靜默 no-op、exit 0 [M1]');

console.log(`\n${failed.length === 0 ? '✓' : '✗'} decision-gate（hook）：${passed} 個斷言通過、${failed.length} 個失敗`);
for (const f of failed) console.error(`  ✗ ${f}`);
process.exit(failed.length === 0 ? 0 : 1);
