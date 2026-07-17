#!/usr/bin/env node
// test-read-accumulator.mjs —— read-accumulator.mjs 紅綠斷言（自帶極簡 harness，仿同目錄
// test-outbound-comment-guard.mjs / test-stop-gate.mjs，不引測試框架）。
//
// 用法（cwd = plugins/loops-workflow）：node hooks/test-read-accumulator.mjs
// 全綠 → exit 0；任一斷言失敗 → exit 1。
//
// #131：outbound-comment-guard v2 的 read-gate（「本 session 有沒有讀過 comment-policy.md /
// outbound-templates.md 才准貼對外內容」）靠這支 accumulator 記「本 session 讀過哪些對外規範
// 檔」。本檔只測 read-accumulator.mjs 自己（PostToolUse(Read) hook）；read-gate 消費端整合
// 測試在 test-outbound-comment-guard.mjs 的 v2 節。
//
// 預期 Red：hooks/read-accumulator.mjs 尚未實作（分層照抄 hooks/edit-accumulator.mjs 的契約）。
// 用動態 await import()（非靜態 import）：ESM 動態 import 對「檔案不存在」會 reject（被
// try-catch 接住、印一行錯誤，所有具名 export 留在 undefined）；對「檔案存在但缺具名 export」
// 不會 throw、解構出 undefined。兩種情況都先靠下面 typeof===function 的存在性斷言標記清楚的
// 紅，其餘行為斷言一律用「短路」（`fn && fn(...)` 或先賦值再 Array.isArray 守門）避免對
// undefined 呼叫拋例外把整個測試檔打斷（本檔沒有整檔 try-catch，一次未捕捉例外會讓後面所有
// 案例的輸出全部消失，違反 context-diet 的紅燈全文原則）。

import { rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { sanitizeSessionId } from './suggest-compact.mjs'; // 既有穩定 export，不受本 issue 影響

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'read-accumulator.mjs');

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed.push(msg); console.error(`  ✗ ${msg}`); }
}

// ── 動態 import（見檔頭說明）─────────────────────────────────────────────────
let addRead, loadReads, readsStateFile, readReadsForSession, writeReadsState;
try {
  const mod = await import('./read-accumulator.mjs');
  addRead = mod.addRead;
  loadReads = mod.loadReads;
  readsStateFile = mod.readsStateFile;
  readReadsForSession = mod.readReadsForSession;
  writeReadsState = mod.writeReadsState;
} catch (e) {
  console.error(`  ✗ read-accumulator.mjs import 失敗（檔案不存在 / 語法錯誤 / 模組頂層拋例外）：${e && e.message}`);
}

// ── 存在性斷言（缺檔或缺 export 都在這裡先標一條清楚的紅，見檔頭說明）───────────
assert(typeof addRead === 'function', 'export addRead 存在 [exist]');
assert(typeof loadReads === 'function', 'export loadReads 存在 [exist]');
assert(typeof readsStateFile === 'function', 'export readsStateFile 存在 [exist]');
assert(typeof readReadsForSession === 'function', 'export readReadsForSession 存在 [exist]');
assert(typeof writeReadsState === 'function', 'export writeReadsState 存在 [exist]');

// =============================================================================
// A) addRead(list, basename) —— 去重 append、回新陣列（不就地改入參）
// =============================================================================
{
  const r1 = addRead && addRead([], 'comment-policy.md');
  assert(JSON.stringify(r1) === JSON.stringify(['comment-policy.md']),
    `addRead：空陣列 append → ["comment-policy.md"]（實際：${JSON.stringify(r1)}）[A1]`);

  const r2 = addRead && addRead(['a.md'], 'b.md');
  assert(JSON.stringify(r2) === JSON.stringify(['a.md', 'b.md']),
    `addRead：append 第二筆保留順序 → ["a.md","b.md"]（實際：${JSON.stringify(r2)}）[A2]`);

  const r3 = addRead && addRead(['comment-policy.md'], 'comment-policy.md');
  assert(JSON.stringify(r3) === JSON.stringify(['comment-policy.md']),
    `addRead：已存在 → 去重不重覆加（實際：${JSON.stringify(r3)}）[A3]`);

  const orig = ['a.md'];
  const next = addRead && addRead(orig, 'b.md');
  assert(Array.isArray(next) && next !== orig, 'addRead：回「新」陣列（非同一參考）[A4]');
  assert(orig.length === 1 && orig[0] === 'a.md', 'addRead：不就地改原陣列（immutable）[A5]');
}

// =============================================================================
// B) loadReads(rawString) —— 壞 JSON / 空 / 非物件 / 無關欄位 → []（容錯不丟）
// =============================================================================
{
  const b1 = loadReads && loadReads('not valid json{');
  assert(Array.isArray(b1) && b1.length === 0, `loadReads：壞 JSON → []（實際：${JSON.stringify(b1)}）[B1]`);

  const b2 = loadReads && loadReads('');
  assert(Array.isArray(b2) && b2.length === 0, `loadReads：空字串 → []（實際：${JSON.stringify(b2)}）[B2]`);

  const b3 = loadReads && loadReads('null');
  assert(Array.isArray(b3) && b3.length === 0, `loadReads：合法 JSON 但非物件（null）→ []（實際：${JSON.stringify(b3)}）[B3]`);

  const b4 = loadReads && loadReads('42');
  assert(Array.isArray(b4) && b4.length === 0, `loadReads：合法 JSON 但非物件（數字）→ []（實際：${JSON.stringify(b4)}）[B4]`);

  const b5 = loadReads && loadReads('{}');
  assert(Array.isArray(b5) && b5.length === 0, `loadReads：合法物件但無相關欄位 → []（實際：${JSON.stringify(b5)}）[B5]`);
}

// =============================================================================
// C) readsStateFile(sessionId) —— os.tmpdir()/loops-reads-<safe>.json，沿用 sanitizeSessionId
// =============================================================================
{
  const p1 = readsStateFile && readsStateFile('sess123');
  const expected1 = join(tmpdir(), 'loops-reads-sess123.json');
  assert(p1 === expected1, `readsStateFile：純英數 session → tmpdir()/loops-reads-sess123.json（實際：${p1}，預期：${expected1}）[C1]`);

  const dirty = 'a/b c!123';
  const p2 = readsStateFile && readsStateFile(dirty);
  const expected2 = join(tmpdir(), `loops-reads-${sanitizeSessionId(dirty)}.json`);
  assert(p2 === expected2,
    `readsStateFile：特殊字元 session 用 sanitizeSessionId 消毒（實際：${p2}，預期：${expected2}）[C2]`);
}

// =============================================================================
// D) readReadsForSession / writeReadsState —— state IO 往返一致（真落盤真讀回）
// =============================================================================
let seq = 0;
function freshSession(prefix) {
  return `ra-${prefix}-${process.pid}-${Date.now()}-${++seq}`;
}
function stateFileFor(sessionId) {
  return readsStateFile ? readsStateFile(sessionId) : join(tmpdir(), `loops-reads-${sanitizeSessionId(sessionId)}.json`);
}
function readsOf(sessionId) {
  return typeof readReadsForSession === 'function' ? readReadsForSession(sessionId) : [];
}

{
  const sessionId = freshSession('io-roundtrip');
  const stateFile = stateFileFor(sessionId);
  rmSync(stateFile, { force: true });
  try {
    const before = readsOf(sessionId);
    assert(Array.isArray(before) && before.length === 0,
      `readReadsForSession：無 state 檔（未寫過）→ []（實際：${JSON.stringify(before)}）[D1]`);

    typeof writeReadsState === 'function' && writeReadsState(sessionId, ['comment-policy.md']);
    const after1 = readsOf(sessionId);
    assert(Array.isArray(after1) && after1.length === 1 && after1.includes('comment-policy.md'),
      `writeReadsState → readReadsForSession：寫 1 筆 → 讀回 1 筆（實際：${JSON.stringify(after1)}）[D2]`);

    typeof writeReadsState === 'function' && writeReadsState(sessionId, ['comment-policy.md', 'outbound-templates.md']);
    const after2 = readsOf(sessionId);
    assert(Array.isArray(after2) && after2.length === 2,
      `writeReadsState：覆寫 → readReadsForSession 回最新 2 筆（實際：${JSON.stringify(after2)}）[D3]`);
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// =============================================================================
// E) main()（PostToolUse Read hook）—— 真 spawn，走 stdin/stdout，驗真落盤 state
// =============================================================================
function runHook(payload, env = {}) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

// ── E1：file_path basename === comment-policy.md（無目錄）→ 記入 state ─────────
{
  const sessionId = freshSession('e1-plain');
  const stateFile = stateFileFor(sessionId);
  rmSync(stateFile, { force: true });
  try {
    const res = runHook({ session_id: sessionId, tool_input: { file_path: 'comment-policy.md' } });
    assert(res.status === 0, `E1：exit 0（實際 status：${res.status}，stderr：${res.stderr}）[E1]`);
    assert(readsOf(sessionId).includes('comment-policy.md'), 'E1：純檔名 comment-policy.md → 記入 state [E1]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── E2：POSIX 深路徑 /home/x/references/comment-policy.md → 記入（basename 判斷）──
{
  const sessionId = freshSession('e2-posix');
  const stateFile = stateFileFor(sessionId);
  rmSync(stateFile, { force: true });
  try {
    const res = runHook({ session_id: sessionId, tool_input: { file_path: '/home/x/references/comment-policy.md' } });
    assert(res.status === 0, `E2：exit 0（實際 status：${res.status}）[E2]`);
    assert(readsOf(sessionId).includes('comment-policy.md'), 'E2：POSIX 深路徑 → basename 命中 → 記入 [E2]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── E3：Windows 反斜線深路徑 C:\Users\x\references\comment-policy.md → 記入 ─────
//    （不能只用 node path.basename——它在非 Windows host 不會把 \ 當分隔符）
{
  const sessionId = freshSession('e3-win');
  const stateFile = stateFileFor(sessionId);
  rmSync(stateFile, { force: true });
  try {
    const res = runHook({ session_id: sessionId, tool_input: { file_path: 'C:\\Users\\x\\references\\comment-policy.md' } });
    assert(res.status === 0, `E3：exit 0（實際 status：${res.status}）[E3]`);
    assert(readsOf(sessionId).includes('comment-policy.md'),
      'E3：Windows 反斜線深路徑 → basename 判斷仍命中 → 記入 [E3]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── E4：大小寫不敏感 COMMENT-POLICY.MD → 記入 ─────────────────────────────────
{
  const sessionId = freshSession('e4-case');
  const stateFile = stateFileFor(sessionId);
  rmSync(stateFile, { force: true });
  try {
    const res = runHook({ session_id: sessionId, tool_input: { file_path: 'references/COMMENT-POLICY.MD' } });
    assert(res.status === 0, `E4：exit 0（實際 status：${res.status}）[E4]`);
    assert(readsOf(sessionId).length === 1, 'E4：大小寫不敏感（COMMENT-POLICY.MD）→ 仍記入（state 有 1 筆）[E4]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── E5：混合反斜線＋大小寫 foo\bar\Comment-Policy.MD → 記入 ────────────────────
{
  const sessionId = freshSession('e5-mixed');
  const stateFile = stateFileFor(sessionId);
  rmSync(stateFile, { force: true });
  try {
    const res = runHook({ session_id: sessionId, tool_input: { file_path: 'foo\\bar\\Comment-Policy.MD' } });
    assert(res.status === 0, `E5：exit 0（實際 status：${res.status}）[E5]`);
    assert(readsOf(sessionId).length === 1, 'E5：混合反斜線＋大小寫 → 仍記入 [E5]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── E6：其他檔名（不相關）→ 不記、不建 state 檔 ────────────────────────────────
{
  const sessionId = freshSession('e6-other');
  const stateFile = stateFileFor(sessionId);
  rmSync(stateFile, { force: true });
  try {
    const res = runHook({ session_id: sessionId, tool_input: { file_path: 'references/other-file.md' } });
    assert(res.status === 0, `E6：exit 0（實際 status：${res.status}）[E6]`);
    assert(existsSync(stateFile) === false, 'E6：不相關檔名 → 不建 state 檔 [E6]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── E7：後綴相似但非精確 basename（comment-policy.md.bak）→ 不記 ───────────────
{
  const sessionId = freshSession('e7-suffix');
  const stateFile = stateFileFor(sessionId);
  rmSync(stateFile, { force: true });
  try {
    const res = runHook({ session_id: sessionId, tool_input: { file_path: 'comment-policy.md.bak' } });
    assert(res.status === 0, `E7：exit 0（實際 status：${res.status}）[E7]`);
    assert(existsSync(stateFile) === false, 'E7：comment-policy.md.bak（非精確 basename）→ 不記、不建 state 檔 [E7]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── E8：前綴相似但非精確 basename（not-comment-policy.md）→ 不記 ───────────────
{
  const sessionId = freshSession('e8-prefix');
  const stateFile = stateFileFor(sessionId);
  rmSync(stateFile, { force: true });
  try {
    const res = runHook({ session_id: sessionId, tool_input: { file_path: 'not-comment-policy.md' } });
    assert(res.status === 0, `E8：exit 0（實際 status：${res.status}）[E8]`);
    assert(existsSync(stateFile) === false, 'E8：not-comment-policy.md（非精確 basename）→ 不記、不建 state 檔 [E8]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── E9：不相關檔名 + 已有既存 state → state 內容不變（不誤清、不誤加）─────────
{
  const sessionId = freshSession('e9-preserve');
  const stateFile = stateFileFor(sessionId);
  rmSync(stateFile, { force: true });
  try {
    typeof writeReadsState === 'function' && writeReadsState(sessionId, ['comment-policy.md']);
    const before = readsOf(sessionId);
    assert(before.length === 1 && before.includes('comment-policy.md'),
      `E9：前置 seed 生效（讀回含 comment-policy.md，實際：${JSON.stringify(before)}）[E9-pre]`);
    const res = runHook({ session_id: sessionId, tool_input: { file_path: 'references/unrelated.md' } });
    assert(res.status === 0, `E9：exit 0（實際 status：${res.status}）[E9]`);
    const after = readsOf(sessionId);
    assert(JSON.stringify(after) === JSON.stringify(before),
      `E9：不相關檔名 → 既存 state 不變（前：${JSON.stringify(before)}，後：${JSON.stringify(after)}）[E9]`);
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── E10：LOOPS_COMMENT_GUARD='0' → 完全 no-op、不寫檔（即便命中 comment-policy.md）─
{
  const sessionId = freshSession('e10-flagoff');
  const stateFile = stateFileFor(sessionId);
  rmSync(stateFile, { force: true });
  try {
    const res = runHook(
      { session_id: sessionId, tool_input: { file_path: 'comment-policy.md' } },
      { LOOPS_COMMENT_GUARD: '0' },
    );
    assert(res.status === 0, `E10：exit 0（實際 status：${res.status}）[E10]`);
    assert(existsSync(stateFile) === false,
      'E10：LOOPS_COMMENT_GUARD=0 → 完全 no-op，不寫 state 檔（即便命中 comment-policy.md）[E10]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── E11：壞 payload（非 JSON）→ no-op、exit 0、不崩 ────────────────────────────
{
  const res = spawnSync(process.execPath, [HOOK], { input: 'not json at all', encoding: 'utf8', env: { ...process.env } });
  assert(res.error == null, 'E11：spawn 無 error（存活）[E11]');
  assert(res.status === 0, `E11：壞 payload → exit 0（fail-open）（實際 status：${res.status}）[E11]`);
}

// ── E12：兩次不同目錄但同 basename 命中 → 去重仍 1 筆 ──────────────────────────
{
  const sessionId = freshSession('e12-dedup');
  const stateFile = stateFileFor(sessionId);
  rmSync(stateFile, { force: true });
  try {
    runHook({ session_id: sessionId, tool_input: { file_path: 'references/comment-policy.md' } });
    runHook({ session_id: sessionId, tool_input: { file_path: '/other/dir/comment-policy.md' } });
    const reads = readsOf(sessionId);
    assert(reads.length === 1 && reads.includes('comment-policy.md'),
      `E12：兩次不同目錄但同 basename → 去重仍 1 筆（實際：${JSON.stringify(reads)}）[E12]`);
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── E13：outbound-templates.md 深路徑 → 記入 state（allowlist 第二檔正向記錄案例）─
//    E1–E8 只測過 comment-policy.md；TRACKED_REFERENCE_FILES 的第二筆 outbound-templates.md
//    目前缺測試釘住（實作 read-accumulator.mjs 的 matchTrackedReference 已支援兩檔）。
{
  const sessionId = freshSession('e13-outbound-templates');
  const stateFile = stateFileFor(sessionId);
  rmSync(stateFile, { force: true });
  try {
    const res = runHook({ session_id: sessionId, tool_input: { file_path: '/home/x/references/outbound-templates.md' } });
    assert(res.status === 0, `E13：exit 0（實際 status：${res.status}）[E13]`);
    assert(readsOf(sessionId).includes('outbound-templates.md'),
      `E13：outbound-templates.md 深路徑 → allowlist 第二檔正向記錄（實際：${JSON.stringify(readsOf(sessionId))}）[E13]`);
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// =============================================================================
// E14: hooks.json 接線斷言（#130 慣例）—— PostToolUse 存在 matcher==="Read" 且 command 含
//      read-accumulator.mjs 的 entry（釘住 read-accumulator 確實掛在 PostToolUse(Read)，不是
//      寫好函式卻忘了接進 hooks.json；仿 test-outbound-comment-guard.mjs 的 E1 慣例）
// =============================================================================
{
  const hooksConfig = JSON.parse(readFileSync(join(HERE, 'hooks.json'), 'utf8'));
  const entry = (hooksConfig.hooks.PostToolUse || []).find((e) =>
    e.matcher === 'Read' && (e.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes('read-accumulator.mjs')));
  assert(entry !== undefined,
    'E14：hooks.json 的 PostToolUse 存在 matcher==="Read" 且 command 含 read-accumulator.mjs 的 entry [E14]');
}

// ── 摘要 + exit code ─────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
