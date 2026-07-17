#!/usr/bin/env node
// test-outbound-comment-guard.mjs —— outbound-comment-guard.mjs 紅綠斷言（自帶極簡 harness，
// 仿同目錄 test-path-guard.mjs，不引測試框架）。
// 用法（cwd = plugins/loops-workflow）：node hooks/test-outbound-comment-guard.mjs
// 全綠 → exit 0；任一斷言失敗 → exit 1。

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  isCommentPostingCommand,
  extractCommentBody,
  findOutboundViolations,
} from './outbound-comment-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'outbound-comment-guard.mjs');

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed.push(msg); console.error(`  ✗ ${msg}`); }
}

// A) isCommentPostingCommand
assert(isCommentPostingCommand('gh pr comment 231 --body "x"') === true, '[A1] gh pr comment → true');
assert(isCommentPostingCommand('gh issue comment 5 --body-file f') === true, '[A2] gh issue comment → true');
assert(isCommentPostingCommand('gh api --method PATCH repos/x/y/issues/comments/1 -F body=@f') === true, '[A3] gh api .../comments +body → true');
assert(isCommentPostingCommand('gh api repos/x/y/issues/1/comments') === false, '[A4] gh api .../comments 無 body（GET）→ false');
assert(isCommentPostingCommand('gh pr create --draft --assignee @me') === false, '[A5] gh pr create → false（非 comment）');
assert(isCommentPostingCommand('git commit -m "x"') === false, '[A6] 非 gh → false');

// B) extractCommentBody（inline + file）
const rd = (map) => (p) => (p in map ? map[p] : null);
assert(extractCommentBody('gh pr comment 1 --body "hello @x"', rd({})) === 'hello @x', '[B1] inline --body 抽出');
assert(extractCommentBody("gh pr comment 1 -b 'inline body'", rd({})) === 'inline body', '[B2] inline -b 抽出');
assert(extractCommentBody('gh pr comment 1 --body-file notes.md', rd({ 'notes.md': 'file body' })) === 'file body', '[B3] --body-file 讀檔');
assert(extractCommentBody('gh api ... -F body=@notes.md', rd({ 'notes.md': 'F file body' })) === 'F file body', '[B4] -F body=@file 讀檔');
assert(extractCommentBody('gh pr comment 1 --body-file missing.md', rd({})) === null, '[B5] 讀不到檔 → null（fail-open）');

// C) findOutboundViolations
assert(findOutboundViolations('回覆 @Augus 的意見').length === 1, '[C1] prose @Augus → 1 violation');
assert(findOutboundViolations('這輪修好了\n\n## 1. 修法').length === 0, '[C2] 乾淨 → 0');
assert(findOutboundViolations('感謝 review，改好了').some((v) => v.includes('客套')), '[C3] 感謝開頭 → 客套 violation');
assert(findOutboundViolations('thanks for the review').some((v) => v.includes('客套')), '[C4] thanks 開頭 → 客套 violation');
assert(findOutboundViolations('thanksgiving planning').length === 0, '[C5] thanksgiving 不誤判客套');
assert(findOutboundViolations('assign to @me later').length === 0, '[C6] @me 不算點名');
assert(findOutboundViolations('用 `@sinclair/typebox`').length === 0, '[C7] scoped-package（inline code）不誤判');
assert(findOutboundViolations('```ts\n@Component()\nclass X {}\n```').length === 0, '[C8] code fence 內 @Component 不誤判');
assert(findOutboundViolations('mail me at user@example.com').length === 0, '[C9] email @ 不誤判');

// D) IO smoke（真跑 main、走 stdin/stdout）
function runHook(command, cwd, env = {}) {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_input: { command }, cwd }),
    encoding: 'utf8', env: { ...process.env, ...env },
  });
  return r.stdout || '';
}
const tmp = mkdtempSync(join(tmpdir(), 'ocg-'));
try {
  writeFileSync(join(tmp, 'at.md'), '回覆 @Augus');
  writeFileSync(join(tmp, 'clean.md'), '這輪修好了\n\n## 1.');
  assert(runHook('gh pr comment 1 --body "@Augus hi"', tmp).includes('"deny"'), '[D1] inline @ → deny');
  assert(runHook(`gh pr comment 1 --body-file ${join(tmp, 'at.md')}`, tmp).includes('"deny"'), '[D2] file @ → deny');
  assert(runHook(`gh pr comment 1 --body-file ${join(tmp, 'clean.md')}`, tmp).trim() === '', '[D3] 乾淨 → 放行（空輸出）');
  assert(runHook('git status', tmp).trim() === '', '[D4] 非 comment → 放行');
  assert(runHook('gh pr comment 1 --body "@Augus hi"', tmp, { LOOPS_COMMENT_GUARD: '0' }).trim() === '', '[D5] flag=0 opt-out → 放行');
  assert(runHook('not json', tmp).trim() !== undefined, '[D6] 存活（fail-open smoke）');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// =============================================================================
// E) #130 PowerShell matcher —— hooks.json 的 PreToolUse matcher 要同時涵蓋 Bash 與 PowerShell
// =============================================================================

// ── E1-E3：matcher regex 斷言（紅燈載體）—— PowerShell 呼叫此 hook 目前會被 matcher 擋在門外 ──
{
  const hooksConfig = JSON.parse(readFileSync(new URL('./hooks.json', import.meta.url), 'utf8'));
  const entry = (hooksConfig.hooks.PreToolUse || []).find((e) =>
    (e.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes('outbound-comment-guard.mjs')));
  const matcher = entry?.matcher;
  assert(typeof matcher === 'string', '[E1] hooks.json 的 PreToolUse 找得到 outbound-comment-guard.mjs 所在 entry 的 matcher');
  assert(new RegExp(matcher).test('Bash') === true, '[E2] matcher 對 "Bash" 仍 match（現有行為不退化）');
  assert(new RegExp(matcher).test('PowerShell') === true, '[E3] matcher 對 "PowerShell" 要 match（#130：現況必紅——matcher 目前僅 "Bash"）');
}

// ── E4-E5：PowerShell payload —— guard 腳本本身不讀 tool_name，只要 payload 送得到就會判 ──────
//          （characterization：現況已綠；#130 要修的是讓 matcher 在真實 PowerShell 呼叫時
//           把 payload 送到這裡——見上面 E3）
function runHookRaw(rawInput) {
  const r = spawnSync('node', [HOOK], { input: rawInput, encoding: 'utf8', env: { ...process.env } });
  return r.stdout || '';
}
{
  const raw = JSON.stringify({ tool_name: 'PowerShell', tool_input: { command: 'gh pr comment 1 --body "@someone 感謝"' }, cwd: HERE });
  assert(runHookRaw(raw).includes('"deny"'), '[E4] tool_name="PowerShell" + inline "@someone 感謝" → deny');
}
{
  const raw = JSON.stringify({ tool_name: 'PowerShell', tool_input: { command: 'gh pr view 1' }, cwd: HERE });
  assert(runHookRaw(raw).trim() === '', '[E5] tool_name="PowerShell" + 非 comment 指令 gh pr view 1 → 放行（零誤擋）');
}

console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
