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
  assert(matcher === 'Bash|PowerShell', '[E3b] matcher 精確等於 "Bash|PowerShell"（防截斷值假綠——unanchored .test() 對 "Bash|Power" 也會過）[C]');
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

// =============================================================================
// F) #131 v2 —— classifyOutboundCommand / findFormatViolations / buildReadGateReason
//    + read-gate（消費 hooks/read-accumulator.mjs 的 session 已讀狀態）
// =============================================================================
// 動態 import：outbound-comment-guard.mjs 的三個新 export、read-accumulator.mjs 的
// writeReadsState 若尚未實作，解構為 undefined；ESM 動態 import 對「檔案不存在」會 reject
// （被 try-catch 接住、印一行錯誤，具名 export 留在 undefined），對「檔案存在但缺具名 export」
// 不會 throw、一樣解構出 undefined。下面每條直呼叫斷言一律用短路（`fn && fn(...)`）避免對
// undefined 呼叫拋例外把本檔打斷——這樣 A–E 節（既有 export、靜態 import）不受影響，v2 新組
// 在實作補齊前逐條清楚地紅，不是整檔崩潰。main() 端到端案例走真 spawn（見 F5），不直接呼叫
// 這些函式，天然靠 stdout 比對紅綠，不需要短路守門。
let classifyOutboundCommand, findFormatViolations, buildReadGateReason;
try {
  const modV2 = await import('./outbound-comment-guard.mjs');
  classifyOutboundCommand = modV2.classifyOutboundCommand;
  findFormatViolations = modV2.findFormatViolations;
  buildReadGateReason = modV2.buildReadGateReason;
} catch (e) {
  console.error(`  ✗ #131 v2 新符號 import 失敗：${e && e.message}`);
}
let raWriteReadsState;
try {
  const modRA = await import('./read-accumulator.mjs');
  raWriteReadsState = modRA.writeReadsState;
} catch (e) {
  console.error(`  ✗ #131 read-accumulator.mjs import 失敗（read-gate 放行案例的 seed 依賴此 export）：${e && e.message}`);
}

assert(typeof classifyOutboundCommand === 'function', 'export classifyOutboundCommand 存在 [F-exist]');
assert(typeof findFormatViolations === 'function', 'export findFormatViolations 存在 [F-exist]');
assert(typeof buildReadGateReason === 'function', 'export buildReadGateReason 存在 [F-exist]');
assert(typeof raWriteReadsState === 'function', 'read-accumulator.mjs 的 writeReadsState 存在（read-gate 放行案例的 seed 依賴）[F-exist]');

// ── F1 classifyOutboundCommand：comment / issue-create / pr-create / issue-edit / pr-edit / null ──
{
  const c = (cmd) => classifyOutboundCommand && classifyOutboundCommand(cmd);
  assert(c('gh pr comment 231 --body "x"') === 'comment', '[F1-1] gh pr comment → "comment"');
  assert(c('gh issue comment 5 --body-file f') === 'comment', '[F1-2] gh issue comment → "comment"');
  assert(c('gh api --method PATCH repos/x/y/issues/comments/1 -F body=@f') === 'comment', '[F1-3] gh api .../comments +body → "comment"');
  assert(c('gh api repos/x/y/issues/1/comments') === null, '[F1-4] gh api .../comments 無 body（GET）→ null');

  assert(c('gh issue create --title t --body "x"') === 'issue-create', '[F1-5] gh issue create +body → "issue-create"');
  assert(c('gh issue create --title t --body-file f.md') === 'issue-create', '[F1-6] gh issue create +body-file → "issue-create"');
  assert(c('gh issue create --title t') === null, '[F1-7] gh issue create 無 body → null');

  assert(c('gh pr create --title t --body "x"') === 'pr-create', '[F1-8] gh pr create +body → "pr-create"');
  assert(c('gh pr create --title t -b "x"') === 'pr-create', '[F1-9] gh pr create -b（短旗標）→ "pr-create"');
  assert(c('gh pr create --title t -F body=@f.md') === 'pr-create', '[F1-10] gh pr create -F body=@file → "pr-create"');
  assert(c('gh pr create --title t') === null, '[F1-11] gh pr create 無 body → null');
  assert(c('gh pr create --draft --assignee @me') === null, '[F1-12] gh pr create 無 body（含 @me）→ null（既有 A5 場景延伸）');

  assert(c('gh issue edit 5 --body "x"') === 'issue-edit', '[F1-13] gh issue edit +body → "issue-edit"');
  assert(c('gh issue edit 5 --add-label bug') === null, '[F1-14] gh issue edit 無 body（只改 label）→ null');

  assert(c('gh pr edit 5 --body "x"') === 'pr-edit', '[F1-15] gh pr edit +body → "pr-edit"');
  assert(c('gh pr edit 5 --add-label bug') === null, '[F1-16] gh pr edit 無 body → null');

  assert(c('gh pr view 1') === null, '[F1-17] gh pr view → null（純讀）');
  assert(c('git commit -m "x"') === null, '[F1-18] 非 gh → null');
}

// ── F2 相容：舊名 isCommentPostingCommand 仍存在，對 comment 三型與 classifyOutboundCommand 一致 ──
{
  const sample = [
    'gh pr comment 231 --body "x"',
    'gh issue comment 5 --body-file f',
    'gh api --method PATCH repos/x/y/issues/comments/1 -F body=@f',
    'gh api repos/x/y/issues/1/comments',
    'gh issue create --title t --body "x"',
    'gh pr create --title t --body "x"',
    'gh pr view 1',
    'git commit -m "x"',
  ];
  for (const cmd of sample) {
    const legacy = isCommentPostingCommand(cmd); // 既有靜態 import，一律可呼叫，不受本節影響
    const viaV2 = classifyOutboundCommand && classifyOutboundCommand(cmd) === 'comment';
    assert(legacy === viaV2,
      `[F2] isCommentPostingCommand("${cmd}") 與 classifyOutboundCommand===\"comment\" 一致（實際 ${legacy} vs ${viaV2}）`);
  }
}

// ── F3 findFormatViolations：① .loops/ 或 stages/0N-*.md 路徑 ② U+FFFD ③ 長非中文 prose ──
{
  const fv = (body) => findFormatViolations && findFormatViolations(body);

  // ①：.loops/ 路徑（含裸 stages/0N-*.md）→ 違規；code fence 內不算
  const loopsPathBody = '詳見 .loops/131-comment-guard-v2/stages/02-plan.md 的決策記錄，說明了完整的設計理由。';
  const v1 = fv(loopsPathBody);
  assert(Array.isArray(v1) && v1.length === 1, `[F3-1] prose 含 .loops/ 路徑 → 1 個 violation（實際：${JSON.stringify(v1)}）`);

  const bareStagesBody = '詳見 stages/03-build.md 的建置記錄。';
  const v2 = fv(bareStagesBody);
  assert(Array.isArray(v2) && v2.length === 1, `[F3-2] prose 含裸 stages/0N-*.md（無 .loops/ 前綴）→ 1 個 violation（實際：${JSON.stringify(v2)}）`);

  const fencedLoopsBody = '```\n.loops/131-x/stages/02-plan.md\n```\n這段程式碼片段僅供參考。';
  const v3 = fv(fencedLoopsBody);
  assert(JSON.stringify(v3) === JSON.stringify([]), `[F3-3] .loops/ 路徑在 code fence 內 → 不算違規（實際：${JSON.stringify(v3)}）`);

  // ②：U+FFFD（raw body 全域檢查，不受 stripCode 影響——即便在 code fence 內也算）
  const mojibakeBody = '這是一段測試內容�包含亂碼字元';
  const v4 = fv(mojibakeBody);
  assert(Array.isArray(v4) && v4.length === 1, `[F3-4] raw body 含 U+FFFD → 1 個 violation（實際：${JSON.stringify(v4)}）`);

  const mojibakeInFence = '```\n�\n```';
  const v5 = fv(mojibakeInFence);
  assert(Array.isArray(v5) && v5.length === 1,
    `[F3-5] U+FFFD 即便在 code fence 內仍算違規（raw body 全域檢查，不同於①）（實際：${JSON.stringify(v5)}）`);

  // ③：stripCode + 去 URL 後 prose ≥120 字元且 CJK <10 → 違規
  const pureEnglish140 = 'This change fixes a null pointer issue in the parser module and adds proper validation for edge cases that were previously unhandled by code.';
  const v6 = fv(pureEnglish140);
  assert(Array.isArray(v6) && v6.length === 1, `[F3-6] 140 字純英文（0 CJK）→ 1 個 violation（實際：${JSON.stringify(v6)}）`);

  const shortEnglish = 'Fixed the null check bug in the parser and added a regression test for it.';
  const v7 = fv(shortEnglish);
  assert(JSON.stringify(v7) === JSON.stringify([]), `[F3-7] 短英文（<120 字）→ 不違規（實際：${JSON.stringify(v7)}）`);

  const cjk40 = '這次修好三個問題第一是格式判斷寫反第二是路徑算錯第三是測試少蓋情況附上錯誤記錄';
  const englishLog300 = Array.from({ length: 3 }, (_, i) =>
    `[ERROR] worker-${i} failed at step processData near offset ${i * 37} while parsing upstream response body chunk`).join(' ');
  const redTeamBody = `${cjk40}\n${englishLog300}`;
  const v8 = fv(redTeamBody);
  assert(JSON.stringify(v8) === JSON.stringify([]),
    `[F3-8] 紅隊放行：40 字繁中 + 300 字元未 fence 英文 log（CJK≥10）→ 不違規（實際：${JSON.stringify(v8)}）`);

  const identifierDense = '這次修改了 hooks/read-accumulator.mjs 的 addRead 函式與 hooks/outbound-comment-guard.mjs 的 classifyOutboundCommand 函式，並補上對應的測試案例，確保這兩個模組的行為都有涵蓋到。';
  const v9 = fv(identifierDense);
  assert(JSON.stringify(v9) === JSON.stringify([]), `[F3-9] 識別字密集繁中（長但 CJK≥10）→ 不違規（實際：${JSON.stringify(v9)}）`);

  // 去 URL：長 URL 不該被算進非中文長度
  const urlBody = '詳見 https://github.com/some-org/some-very-long-repository-name-goes-here/pull/123456789/files#diff-abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef1234567890abcdef';
  const v10 = fv(urlBody);
  assert(JSON.stringify(v10) === JSON.stringify([]),
    `[F3-10] 長 URL 需先去除才判長度（去除後 prose 很短）→ 不違規（實際：${JSON.stringify(v10)}）`);

  const clean = '這次修好了三個問題，詳細記錄如下。';
  const v11 = fv(clean);
  assert(JSON.stringify(v11) === JSON.stringify([]), `[F3-11] 乾淨中文短句 → 不違規（實際：${JSON.stringify(v11)}）`);
}

// ── F4 buildReadGateReason(kind)：comment→§7/§8+comment-policy.md；create→outbound-templates+通則 ──
{
  const r = (kind) => buildReadGateReason && buildReadGateReason(kind);

  const commentReason = r('comment');
  assert(typeof commentReason === 'string' && commentReason.includes('§7'),
    `[F4-1] buildReadGateReason('comment') 含 "§7"（實際：${JSON.stringify(commentReason)}）`);
  assert(typeof commentReason === 'string' && commentReason.includes('§8'),
    `[F4-2] buildReadGateReason('comment') 含 "§8"（實際：${JSON.stringify(commentReason)}）`);
  assert(typeof commentReason === 'string' && commentReason.includes('comment-policy.md'),
    `[F4-3] buildReadGateReason('comment') 含 "comment-policy.md" 路徑（實際：${JSON.stringify(commentReason)}）`);
  assert(typeof commentReason === 'string' && /fence/i.test(commentReason),
    `[F4-4] buildReadGateReason('comment') 含 code fence 提示語（實際：${JSON.stringify(commentReason)}）`);

  for (const kind of ['issue-create', 'pr-create']) {
    const reason = r(kind);
    assert(typeof reason === 'string' && reason.includes('outbound-templates'),
      `[F4-5] buildReadGateReason('${kind}') 含 "outbound-templates"（實際：${JSON.stringify(reason)}）`);
    assert(typeof reason === 'string' && reason.includes('通則'),
      `[F4-6] buildReadGateReason('${kind}') 含 "通則"（實際：${JSON.stringify(reason)}）`);
    assert(typeof reason === 'string' && /fence/i.test(reason),
      `[F4-7] buildReadGateReason('${kind}') 含 code fence 提示語（實際：${JSON.stringify(reason)}）`);
  }
}

// ── F5 main() 端到端（真 spawn，read-gate + 機械規則；session_id 各自獨一無二避免 state 互染）──
function sanitizeIdF(id) { return String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '_'); } // 與 suggest-compact.mjs 的 sanitizeSessionId 同規則；本節自帶、不動既有頂層 import
function readsStateFileForF(sessionId) { return join(tmpdir(), `loops-reads-${sanitizeIdF(sessionId)}.json`); }
function seedReadsF(sessionId, files) {
  // 優先用 read-accumulator 的 writeReadsState（單一真相源，格式必與 main() 讀法一致）；該
  // export 不存在時整行短路 no-op——依賴此 seed 的「read-gate 放行」案例會在下面對應的斷言處
  // 因 state 沒寫入而正確轉紅，不是在這裡假裝 seed 成功。
  typeof raWriteReadsState === 'function' && raWriteReadsState(sessionId, files);
}
let fseq = 0;
function freshV2Session(prefix) {
  return `v2-${prefix}-${process.pid}-${Date.now()}-${++fseq}`;
}
function runHookV2(payload, env = {}) {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8', env: { ...process.env, ...env },
  });
  return r.stdout || '';
}

// ── F5-1/2：read-gate deny —— 全新 session（無 read state）+ 乾淨 body → 仍 deny，理由對應 kind ──
{
  const sessionId = freshV2Session('deny-comment');
  const stateFile = readsStateFileForF(sessionId);
  rmSync(stateFile, { force: true }); // 確保真的無 state
  try {
    const out = runHookV2({ session_id: sessionId, tool_input: { command: 'gh pr comment 1 --body "這次修好了三個問題，詳細記錄如下。"' } });
    assert(out.includes('"deny"'),
      `[F5-1] comment kind + 無 read state + 乾淨 body → 仍 deny（read-gate 擋）（實際 stdout：${JSON.stringify(out)}）`);
    assert(out.includes('§7') && out.includes('§8'),
      `[F5-1b] read-gate deny 理由含 §7/§8（實際：${JSON.stringify(out)}）`);
  } finally {
    rmSync(stateFile, { force: true });
  }
}
{
  const sessionId = freshV2Session('deny-create');
  const stateFile = readsStateFileForF(sessionId);
  rmSync(stateFile, { force: true });
  try {
    const out = runHookV2({ session_id: sessionId, tool_input: { command: 'gh issue create --title t --body "新增一個功能讓使用者可以匯出報表。"' } });
    assert(out.includes('"deny"'),
      `[F5-2] issue-create kind + 無 read state + 乾淨 body → 仍 deny（read-gate 擋）（實際：${JSON.stringify(out)}）`);
    assert(out.includes('outbound-templates'),
      `[F5-2b] read-gate deny 理由含 "outbound-templates"（實際：${JSON.stringify(out)}）`);
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── F5-3/4：read-gate 放行 —— seed 對應 state 後同指令 → 通過 read-gate，body 乾淨 → 全放行 ──
{
  const sessionId = freshV2Session('pass-comment');
  const stateFile = readsStateFileForF(sessionId);
  rmSync(stateFile, { force: true });
  try {
    seedReadsF(sessionId, ['comment-policy.md']);
    const out = runHookV2({ session_id: sessionId, tool_input: { command: 'gh pr comment 1 --body "這次修好了三個問題，詳細記錄如下。"' } });
    assert(out.trim() === '',
      `[F5-3] comment kind + 已 seed comment-policy.md + 乾淨 body → 放行（空輸出）（實際：${JSON.stringify(out)}）`);
  } finally {
    rmSync(stateFile, { force: true });
  }
}
{
  const sessionId = freshV2Session('pass-create');
  const stateFile = readsStateFileForF(sessionId);
  rmSync(stateFile, { force: true });
  try {
    seedReadsF(sessionId, ['outbound-templates.md']);
    const out = runHookV2({ session_id: sessionId, tool_input: { command: 'gh issue create --title t --body "新增一個功能讓使用者可以匯出報表。"' } });
    assert(out.trim() === '',
      `[F5-4] issue-create kind + 已 seed outbound-templates.md + 乾淨 body → 放行（空輸出）（實際：${JSON.stringify(out)}）`);
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── F5-5/6（判別力）：seed 錯的文件 → read-gate 仍 deny（按 kind 對應文件，不是「讀過任何東西就算數」）──
{
  const sessionId = freshV2Session('wrongdoc-comment');
  const stateFile = readsStateFileForF(sessionId);
  rmSync(stateFile, { force: true });
  try {
    seedReadsF(sessionId, ['outbound-templates.md']); // 讀過的是「另一份」文件
    const out = runHookV2({ session_id: sessionId, tool_input: { command: 'gh pr comment 1 --body "這次修好了三個問題，詳細記錄如下。"' } });
    assert(out.includes('"deny"'),
      `[F5-5] comment kind 只 seed outbound-templates.md（非 comment-policy.md）→ read-gate 仍 deny（實際：${JSON.stringify(out)}）`);
  } finally {
    rmSync(stateFile, { force: true });
  }
}
{
  const sessionId = freshV2Session('wrongdoc-create');
  const stateFile = readsStateFileForF(sessionId);
  rmSync(stateFile, { force: true });
  try {
    seedReadsF(sessionId, ['comment-policy.md']); // 讀過的是「另一份」文件
    const out = runHookV2({ session_id: sessionId, tool_input: { command: 'gh issue create --title t --body "新增一個功能讓使用者可以匯出報表。"' } });
    assert(out.includes('"deny"'),
      `[F5-6] issue-create kind 只 seed comment-policy.md（非 outbound-templates.md）→ read-gate 仍 deny（實際：${JSON.stringify(out)}）`);
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── F5-7..13：機械規則（皆在已讀 comment-policy.md 的 state 下測，統一用 comment kind）──
{
  const sessionId = freshV2Session('mech');
  const stateFile = readsStateFileForF(sessionId);
  const mechTmp = mkdtempSync(join(tmpdir(), 'ocg-v2-'));
  rmSync(stateFile, { force: true });
  try {
    seedReadsF(sessionId, ['comment-policy.md']);

    const loopsPathBody = '詳見 .loops/131-comment-guard-v2/stages/02-plan.md 的決策記錄，說明了完整的設計理由。';
    const mojibakeBody = '這是一段測試內容�包含亂碼字元';
    const pureEnglish140 = 'This change fixes a null pointer issue in the parser module and adds proper validation for edge cases that were previously unhandled by code.';
    const cjk40 = '這次修好三個問題第一是格式判斷寫反第二是路徑算錯第三是測試少蓋情況附上錯誤記錄';
    const englishLog300 = Array.from({ length: 3 }, (_, i) =>
      `[ERROR] worker-${i} failed at step processData near offset ${i * 37} while parsing upstream response body chunk`).join(' ');
    const redTeamBody = `${cjk40}\n${englishLog300}`;
    const identifierDense = '這次修改了 hooks/read-accumulator.mjs 的 addRead 函式與 hooks/outbound-comment-guard.mjs 的 classifyOutboundCommand 函式，並補上對應的測試案例，確保這兩個模組的行為都有涵蓋到。';
    const shortEnglish = 'Fixed the null check bug in the parser and added a regression test for it.';
    const fencedLoopsBody = '```\n.loops/131-x/stages/02-plan.md\n```\n這段程式碼片段僅供參考。';

    const f = {
      loopsPath: join(mechTmp, 'loops-path.md'),
      mojibake: join(mechTmp, 'mojibake.md'),
      pureEnglish: join(mechTmp, 'pure-english.md'),
      redTeam: join(mechTmp, 'red-team.md'),
      identifierDense: join(mechTmp, 'identifier-dense.md'),
      shortEnglish: join(mechTmp, 'short-english.md'),
      fencedLoops: join(mechTmp, 'fenced-loops.md'),
    };
    writeFileSync(f.loopsPath, loopsPathBody);
    writeFileSync(f.mojibake, mojibakeBody);
    writeFileSync(f.pureEnglish, pureEnglish140);
    writeFileSync(f.redTeam, redTeamBody);
    writeFileSync(f.identifierDense, identifierDense);
    writeFileSync(f.shortEnglish, shortEnglish);
    writeFileSync(f.fencedLoops, fencedLoopsBody);

    const run = (path) => runHookV2({ session_id: sessionId, tool_input: { command: `gh pr comment 1 --body-file ${path}` } });

    assert(run(f.loopsPath).includes('"deny"'),
      '[F5-7] 已讀 state + body 含 .loops/.../stages/02-plan.md → deny（機械規則①）');
    assert(run(f.mojibake).includes('"deny"'),
      '[F5-8] 已讀 state + body 含 U+FFFD → deny（機械規則②）');
    assert(run(f.pureEnglish).includes('"deny"'),
      '[F5-9] 已讀 state + 140 字純英文 prose → deny（機械規則③）');
    assert(run(f.redTeam).trim() === '',
      '[F5-10] 紅隊放行：已讀 state + 40 字繁中 + 300 字元未 fence 英文 log → 放行（CJK≥10 不誤擋）');
    assert(run(f.identifierDense).trim() === '',
      '[F5-11] 已讀 state + 識別字密集繁中（長但 CJK≥10）→ 放行');
    assert(run(f.shortEnglish).trim() === '',
      '[F5-12] 已讀 state + 短英文（<120 字）→ 放行');
    assert(run(f.fencedLoops).trim() === '',
      '[F5-13] 已讀 state + code fence 內 .loops 路徑 → 放行（fence 內不算）');
  } finally {
    rmSync(stateFile, { force: true });
    rmSync(mechTmp, { recursive: true, force: true });
  }
}

// ── F5-14/15：覆蓋面 —— 既有 @/客套規則現在也管 create；不帶 body 的 create 不算、直接放行 ──
{
  const sessionId = freshV2Session('coverage-create-violation');
  const stateFile = readsStateFileForF(sessionId);
  rmSync(stateFile, { force: true });
  try {
    seedReadsF(sessionId, ['outbound-templates.md']); // pr-create kind 的 read-gate 對應文件
    const out = runHookV2({ session_id: sessionId, tool_input: { command: 'gh pr create --title t --body "@someone 感謝"' } });
    assert(out.includes('"deny"'),
      `[F5-14] 已讀 state + gh pr create body 含 @someone → deny（既有 @ 規則現在也管 create）（實際：${JSON.stringify(out)}）`);
  } finally {
    rmSync(stateFile, { force: true });
  }
}
{
  const sessionId = freshV2Session('coverage-create-nobody');
  const stateFile = readsStateFileForF(sessionId);
  rmSync(stateFile, { force: true }); // 刻意不 seed 任何 read state
  try {
    const out = runHookV2({ session_id: sessionId, tool_input: { command: 'gh pr create --title t' } });
    assert(out.trim() === '',
      `[F5-15] gh pr create 不帶 body → classifyOutboundCommand 回 null，不進 read-gate、直接放行（實際：${JSON.stringify(out)}）`);
  } finally {
    rmSync(stateFile, { force: true });
  }
}

console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
