#!/usr/bin/env node
// test-edit-accumulator.mjs —— edit-accumulator.mjs（PostToolUse(Write|Edit|MultiEdit) hook）紅綠
// 斷言（自帶極簡 harness，仿同目錄 test-read-accumulator.mjs / test-pr-owner-guard.mjs，不引測試
// 框架）。
//
// 用法（cwd = plugins/loops-workflow）：node hooks/test-edit-accumulator.mjs
// 全綠 → exit 0；任一斷言失敗 → exit 1。
//
// 緣由（issue #183 T10）：edit-accumulator.mjs 原本只讀 `tool_input.file_path` 單一字串，Codex
// apply_patch 一次夾帶多檔 diff 時（`tool_input.command` 裡多個 `*** Add/Update/Delete File:`
// 標頭）完全記不到——只會讀到 undefined、無事可記。改吃 hook-input-normalize.mjs 的 normalize()
// 之 filePaths[]（逐檔累積）後，本檔補上這支既有 test-read-accumulator.mjs 檔頭明寫「不涵蓋」的
// 缺口：test-read-accumulator.mjs 只測 read-accumulator.mjs 自己，edit-accumulator.mjs 之前完全
// 沒有專屬測試檔（僅被 test-guard-characterization.mjs 位元鎖住現況輸出，非語意斷言）。
//
// state 檔格式不變（硬約束）：{ ts, paths }，仍靠 addEdit/loadEdits/editsStateFile 等既有純函式；
// 本檔不新增／不更動 state 序列化形狀，只驗證「filePaths 逐檔進 addEdit」這件事本身。

import { rmSync, existsSync } from 'node:fs';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'edit-accumulator.mjs');

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed.push(msg); console.error(`  ✗ ${msg}`); }
}

// ── 動態 import（既有 export，仿 test-read-accumulator.mjs 慣例）───────────────────
let addEdit, loadEdits, editsStateFile, readEditsForSession, writeEditsState;
try {
  const mod = await import('./edit-accumulator.mjs');
  addEdit = mod.addEdit;
  loadEdits = mod.loadEdits;
  editsStateFile = mod.editsStateFile;
  readEditsForSession = mod.readEditsForSession;
  writeEditsState = mod.writeEditsState;
} catch (e) {
  console.error(`  ✗ edit-accumulator.mjs import 失敗：${e && e.message}`);
}

assert(typeof addEdit === 'function', 'export addEdit 存在 [exist]');
assert(typeof loadEdits === 'function', 'export loadEdits 存在 [exist]');
assert(typeof editsStateFile === 'function', 'export editsStateFile 存在 [exist]');
assert(typeof readEditsForSession === 'function', 'export readEditsForSession 存在 [exist]');
assert(typeof writeEditsState === 'function', 'export writeEditsState 存在 [exist]');

// ── sandbox：一個含 .loops/ 的 Windows 形絕對路徑目錄（accumulator 的 loops-scoped 前提）───────
const root = mkdtempSync(join(tmpdir(), 'ea-test-'));
mkdirSync(join(root, '.loops'), { recursive: true });
const noLoopsRoot = mkdtempSync(join(tmpdir(), 'ea-noloops-'));

function freshSession(prefix) {
  return `ea-${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function stateFileFor(sessionId) {
  return editsStateFile(sessionId);
}
function editsOf(sessionId) {
  return readEditsForSession(sessionId);
}
function runHook(payload, env = {}) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const ADD_UPDATE_DELETE_PATCH = [
  '*** Begin Patch',
  '*** Add File: src/new-file.js',
  '+export const value = 1;',
  '*** Update File: src/protected.js',
  '@@',
  '-const a = 1;',
  '+const a = 2;',
  '*** Delete File: src/old-file.js',
  '*** End Patch',
].join('\n');

// =============================================================================
// A) Claude 形狀單檔 → 正確累積（現有行為，回歸釘）
// =============================================================================
{
  const sessionId = freshSession('a-claude-single');
  const stateFile = stateFileFor(sessionId);
  rmSync(stateFile, { force: true });
  try {
    const res = runHook({ cwd: root, session_id: sessionId, tool_input: { file_path: 'foo.txt' } });
    assert(res.status === 0, `A1：exit 0（實際 status：${res.status}，stderr：${res.stderr}）[A1]`);
    const edits = editsOf(sessionId);
    assert(edits.length === 1 && edits.includes('foo.txt'),
      `A1：Claude 單檔 file_path='foo.txt' → 累積 1 筆（實際：${JSON.stringify(edits)}）[A1]`);
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// =============================================================================
// B) apply_patch 多檔 → 逐檔都被累積（核心修復）
// =============================================================================
{
  const sessionId = freshSession('b-apply-patch-multi');
  const stateFile = stateFileFor(sessionId);
  rmSync(stateFile, { force: true });
  try {
    const res = runHook({
      cwd: root,
      session_id: sessionId,
      tool_input: { command: ADD_UPDATE_DELETE_PATCH },
    });
    assert(res.status === 0, `B1：exit 0（實際 status：${res.status}，stderr：${res.stderr}）[B1]`);
    const edits = editsOf(sessionId);
    assert(edits.length === 3,
      `B1：apply_patch 含 3 個檔（Add/Update/Delete 各一）→ 累積 3 筆（實際：${JSON.stringify(edits)}）[B1]`);
    assert(edits.includes('src/new-file.js'), 'B2：filePaths 含 Add File 的路徑 src/new-file.js [B2]');
    assert(edits.includes('src/protected.js'),
      'B3：filePaths 含 Update File 的路徑 src/protected.js（非首檔，只抽首檔的舊實作會讓這條紅）[B3]');
    assert(edits.includes('src/old-file.js'), 'B4：filePaths 含 Delete File 的路徑 src/old-file.js [B4]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── B5：apply_patch 多檔累積到既有 session 上（與既存 Claude 單檔累積結果疊加、不覆蓋）───
{
  const sessionId = freshSession('b5-accumulate-onto-existing');
  const stateFile = stateFileFor(sessionId);
  rmSync(stateFile, { force: true });
  try {
    runHook({ cwd: root, session_id: sessionId, tool_input: { file_path: 'already-edited.txt' } });
    const res = runHook({
      cwd: root,
      session_id: sessionId,
      tool_input: { command: ADD_UPDATE_DELETE_PATCH },
    });
    assert(res.status === 0, `B5：exit 0（實際 status：${res.status}）[B5]`);
    const edits = editsOf(sessionId);
    assert(edits.length === 4 && edits.includes('already-edited.txt'),
      `B5：既存 1 筆 + apply_patch 3 筆 → 累積 4 筆、不覆蓋既存（實際：${JSON.stringify(edits)}）[B5]`);
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// =============================================================================
// C) 反向：不該累積的情況不累積
// =============================================================================
// ── C1：消費端 flag 全關 → no-op、不寫 state 檔 ─────────────────────────────────
{
  const sessionId = freshSession('c1-flags-off');
  const stateFile = stateFileFor(sessionId);
  rmSync(stateFile, { force: true });
  try {
    const res = runHook(
      { cwd: root, session_id: sessionId, tool_input: { file_path: 'foo.txt' } },
      { LOOPS_STOP_GATE: '0', LOOPS_EVAL_GATE: '0', LOOPS_EVAL_TAGS_GATE: '0', LOOPS_EVAL_POLL_GATE: '0' },
    );
    assert(res.status === 0, `C1：exit 0（實際 status：${res.status}）[C1]`);
    assert(existsSync(stateFile) === false, 'C1：消費端 flag 全關 → 不寫 state 檔 [C1]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── C2：cwd 下無 .loops/ → no-op、不寫 state 檔 ─────────────────────────────────
{
  const sessionId = freshSession('c2-no-loops-dir');
  const stateFile = stateFileFor(sessionId);
  rmSync(stateFile, { force: true });
  try {
    const res = runHook({ cwd: noLoopsRoot, session_id: sessionId, tool_input: { file_path: 'foo.txt' } });
    assert(res.status === 0, `C2：exit 0（實際 status：${res.status}）[C2]`);
    assert(existsSync(stateFile) === false, 'C2：cwd 下無 .loops/ → 不寫 state 檔 [C2]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── C3：無檔路徑（tool_input 空、非 apply_patch 的普通 shell 指令）→ no-op、不寫 state 檔 ──
{
  const sessionId = freshSession('c3-no-file-path');
  const stateFile = stateFileFor(sessionId);
  rmSync(stateFile, { force: true });
  try {
    const res = runHook({ cwd: root, session_id: sessionId, tool_input: { command: 'echo hi' } });
    assert(res.status === 0, `C3：exit 0（實際 status：${res.status}）[C3]`);
    assert(existsSync(stateFile) === false,
      'C3：tool_input.command 是普通 shell 指令（非 apply_patch、無 file_path）→ filePaths 空、不寫 state 檔 [C3]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── C4：壞 payload（非 JSON）→ no-op、exit 0、不崩 ─────────────────────────────
{
  const res = spawnSync(process.execPath, [HOOK], { input: 'not json at all', encoding: 'utf8', env: { ...process.env } });
  assert(res.error == null, 'C4：spawn 無 error（存活）[C4]');
  assert(res.status === 0, `C4：壞 payload → exit 0（fail-open）（實際 status：${res.status}）[C4]`);
}

// =============================================================================
// D) 結構殘缺 → degraded 可見但不影響累積契約
// =============================================================================
// ── D1：normalize() 本身在判不出 harness 時把 degraded 填非 null（可見性驗證，直接呼叫純函式）──
{
  const { normalize } = await import('./hook-input-normalize.mjs');
  const unrecognizable = { foo: 'bar', tool_input: {} };
  const result = normalize(unrecognizable, {});
  assert(result?.harness === 'unknown', 'D1：判不出來的 payload → normalize() harness === "unknown"（degraded 前提）[D1]');
  assert(result?.degraded != null, 'D1：harness 判不出來 → degraded 非 null（可見降級）[D1]');
}

// ── D2：即使 rootSource='none'（env 無 CLAUDE_PLUGIN_ROOT 等，degraded 非 null）→ accumulator
//    的累積結果不受影響、照樣正確記錄（degraded 只可見、不改擋不擋——本 hook 根本不用 pluginRoot）──
{
  const sessionId = freshSession('d2-degraded-rootsource-none');
  const stateFile = stateFileFor(sessionId);
  rmSync(stateFile, { force: true });
  const envWithoutRoots = { ...process.env };
  delete envWithoutRoots.CLAUDE_PLUGIN_ROOT;
  delete envWithoutRoots.CLAUDE_PROJECT_DIR;
  delete envWithoutRoots.PLUGIN_ROOT;
  delete envWithoutRoots.PROJECT_DIR;
  try {
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ cwd: root, session_id: sessionId, tool_input: { file_path: 'still-recorded.txt' } }),
      encoding: 'utf8',
      env: envWithoutRoots,
    });
    assert(res.status === 0, `D2：exit 0（實際 status：${res.status}，stderr：${res.stderr}）[D2]`);
    const edits = editsOf(sessionId);
    assert(edits.length === 1 && edits.includes('still-recorded.txt'),
      `D2：rootSource=none（degraded 非 null）不影響累積結果，仍正確記入 1 筆（實際：${JSON.stringify(edits)}）[D2]`);
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── D3：apply_patch 結構殘缺（缺 *** End Patch、標頭不完整）→ 仍儘量抽出可辨識的檔案、不崩、
//    不因結構殘缺就整批放棄累積（degraded 是「講清楚」不是「改判斷」——這裡驗證的是「不崩且盡力
//    累積」，非釘死某個必然結果，容錯行為與現有 loadEdits 壞 JSON 容錯精神一致）───────────────
{
  const sessionId = freshSession('d3-malformed-patch');
  const stateFile = stateFileFor(sessionId);
  rmSync(stateFile, { force: true });
  const malformedPatch = ['*** Begin Patch', '*** Add File: src/only-file.js', '+export const x = 1;'].join('\n');
  try {
    const res = runHook({ cwd: root, session_id: sessionId, tool_input: { command: malformedPatch } });
    assert(res.status === 0, `D3：結構殘缺（缺 End Patch）→ 仍 exit 0、不崩（實際 status：${res.status}，stderr：${res.stderr}）[D3]`);
    const edits = editsOf(sessionId);
    assert(edits.includes('src/only-file.js'),
      `D3：即使缺 End Patch，仍能抽出已出現的 Add File 路徑並累積（實際：${JSON.stringify(edits)}）[D3]`);
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── 清理 sandbox ────────────────────────────────────────────────────────────
rmSync(root, { recursive: true, force: true });
rmSync(noLoopsRoot, { recursive: true, force: true });

// ── 摘要 + exit code ─────────────────────────────────────────────────────────
const total = passed + failed.length;
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
console.log(`(共 ${total} 條斷言：A=Claude單檔／B=apply_patch多檔逐檔累積／C=反向不累積／D=degraded可見不改擋不擋)`);
process.exit(failed.length === 0 ? 0 : 1);
