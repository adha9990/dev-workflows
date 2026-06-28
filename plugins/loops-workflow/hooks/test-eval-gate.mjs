#!/usr/bin/env node
// test-eval-gate.mjs —— eval-gate.mjs 的紅綠斷言（自帶極簡 harness，仿 test-stop-gate.mjs）。
// 用法（cwd = plugins/loops-workflow）：node hooks/test-eval-gate.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1。

import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { shouldRunEvalGate, buildEvalGateInjection } from './eval-gate.mjs';
import { editsStateFile, readEditsForSession, writeEditsState } from './edit-accumulator.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_GATE_SCRIPT = join(HERE, 'eval-gate.mjs');

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed.push(msg); console.error(`  ✗ ${msg}`); }
}

let seq = 0;
function freshSession(prefix) {
  return `${prefix}-${process.pid}-${Date.now()}-${++seq}`;
}
function runHook(payload, extraEnv = {}) {
  const env = { ...process.env };
  delete env.LOOPS_EVAL_GATE;
  delete env.LOOPS_STOP_GATE;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [EVAL_GATE_SCRIPT], { input: JSON.stringify(payload), env, encoding: 'utf8' });
}
// 建一個含 .loops/.metrics/eval-results.jsonl 的暫存 cwd；rows = JSONL 行內容。
function makeMetricsCwd(prefix, rows) {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  const dir = join(cwd, '.loops', '.metrics');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'eval-results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return cwd;
}
const REGRESSED = [{ corpus: 'X', passRate: 1.0 }, { corpus: 'X', passRate: 0.5 }]; // check → 退化 exit 1
const STABLE = [{ corpus: 'X', passRate: 1.0 }, { corpus: 'X', passRate: 1.0 }]; // check → 無退化 exit 0

// =============================================================================
// A) 純函式
// =============================================================================

// ── A1 shouldRunEvalGate：三條件皆 true 才 true ──────────────────────────────
{
  assert(shouldRunEvalGate({ flagOn: true, hasMetrics: true, hasEdits: true }) === true, 'shouldRunEvalGate：三條件皆 true → true [A1]');
  assert(shouldRunEvalGate({ flagOn: false, hasMetrics: true, hasEdits: true }) === false, 'shouldRunEvalGate：flagOn=false → false [A1]');
  assert(shouldRunEvalGate({ flagOn: true, hasMetrics: false, hasEdits: true }) === false, 'shouldRunEvalGate：hasMetrics=false → false [A1]');
  assert(shouldRunEvalGate({ flagOn: true, hasMetrics: true, hasEdits: false }) === false, 'shouldRunEvalGate：hasEdits=false → false [A1]');
}

// ── A2 buildEvalGateInjection：僅 exit 1 注入；其餘 null；空輸出 fallback；截斷 ──
{
  assert(buildEvalGateInjection('regression: ...', 1) === 'regression: ...', 'buildEvalGateInjection：exit 1 → 回 check 輸出 [A2]');
  assert(buildEvalGateInjection('within tolerance', 0) === null, 'buildEvalGateInjection：exit 0（無退化）→ null（靜默）[A2]');
  assert(buildEvalGateInjection('usage: ...', 2) === null, 'buildEvalGateInjection：exit 2（誤用）→ null [A2]');
  assert(buildEvalGateInjection('whatever', null) === null, 'buildEvalGateInjection：exit null（spawn 異常）→ null [A2]');
  const fb = buildEvalGateInjection('   ', 1);
  assert(typeof fb === 'string' && fb.includes('退化'), 'buildEvalGateInjection：exit 1 但輸出空白 → fallback 退化提示（非空注入）[A2]');
  const long = buildEvalGateInjection('z'.repeat(10005), 1);
  assert(typeof long === 'string' && long.length === 10000, 'buildEvalGateInjection：>10000 截到 10000 [A2]');
}

// =============================================================================
// SMOKE — 真 spawn eval-gate.mjs
// =============================================================================

// ── S1：flag 關 → no-op（無輸出、不動 accumulator）─────────────────────────────
{
  const sessionId = freshSession('eg-off');
  const cwd = makeMetricsCwd('eg-off-', REGRESSED);
  writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    const res = runHook({ session_id: sessionId, cwd }); // 未設 LOOPS_EVAL_GATE
    assert(res.status === 0, 'S1：flag 關 → exit 0 [S1]');
    assert((res.stdout || '').trim() === '', 'S1：flag 關 → 無輸出（no-op）[S1]');
    assert(readEditsForSession(sessionId).length === 1, 'S1：flag 關 → 不動 accumulator（seed 仍在）[S1]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S2：flag 開 + 無歷史檔 → no-op ───────────────────────────────────────────
{
  const sessionId = freshSession('eg-nofile');
  const cwd = mkdtempSync(join(tmpdir(), 'eg-nofile-')); // 無 .loops/.metrics
  writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    const res = runHook({ session_id: sessionId, cwd }, { LOOPS_EVAL_GATE: '1' });
    assert(res.status === 0 && (res.stdout || '').trim() === '', 'S2：flag 開但無 eval-results.jsonl → no-op [S2]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S3：flag 開 + 歷史檔 + 無 edits → no-op（控成本：只在改檔回合跑）──────────────
{
  const sessionId = freshSession('eg-noedit');
  const cwd = makeMetricsCwd('eg-noedit-', REGRESSED);
  rmSync(editsStateFile(sessionId), { force: true }); // 無 edits
  try {
    const res = runHook({ session_id: sessionId, cwd }, { LOOPS_EVAL_GATE: '1' });
    assert(res.status === 0 && (res.stdout || '').trim() === '', 'S3：無 edits → no-op（即便有退化也不跑，控成本）[S3]');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

// ── S4：flag 開 + 退化歷史 + edits（stop-gate 關）→ 注入退化警示 + accumulator 被清 ──
{
  const sessionId = freshSession('eg-reg');
  const cwd = makeMetricsCwd('eg-reg-', REGRESSED);
  writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    const res = runHook({ session_id: sessionId, cwd }, { LOOPS_EVAL_GATE: '1' }); // LOOPS_STOP_GATE 未設
    assert(res.error == null, 'S4：node 啟動成功 [S4]');
    let out = null; try { out = JSON.parse(res.stdout); } catch { out = null; }
    const ctx = out?.hookSpecificOutput?.additionalContext;
    assert(typeof ctx === 'string' && ctx.length > 0, 'S4：退化 → 注入 hookSpecificOutput.additionalContext [S4]');
    assert(readEditsForSession(sessionId).length === 0, 'S4：stop-gate 關 → 本 hook 清 accumulator（readEditsForSession === []）[S4]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S5：flag 開 + 退化 + edits + LOOPS_STOP_GATE=1 → 仍注入，但 accumulator 不清（留給 stop-gate）──
{
  const sessionId = freshSession('eg-coexist');
  const cwd = makeMetricsCwd('eg-coexist-', REGRESSED);
  writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    const res = runHook({ session_id: sessionId, cwd }, { LOOPS_EVAL_GATE: '1', LOOPS_STOP_GATE: '1' });
    let out = null; try { out = JSON.parse(res.stdout); } catch { out = null; }
    assert(typeof out?.hookSpecificOutput?.additionalContext === 'string', 'S5：退化 → 仍注入 [S5]');
    assert(readEditsForSession(sessionId).length === 1, 'S5：stop-gate 開 → 本 hook 不清 accumulator（留給 stop-gate；seed 仍在）[S5]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S6：flag 開 + 無退化歷史 + edits → 靜默（無注入）+ accumulator 被清（stop-gate 關）──
{
  const sessionId = freshSession('eg-stable');
  const cwd = makeMetricsCwd('eg-stable-', STABLE);
  writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    const res = runHook({ session_id: sessionId, cwd }, { LOOPS_EVAL_GATE: '1' });
    assert(res.status === 0, 'S6：無退化 → exit 0 [S6]');
    assert(!(res.stdout || '').includes('additionalContext'), 'S6：無退化 → 無注入（靜默）[S6]');
    assert(readEditsForSession(sessionId).length === 0, 'S6：跑完清 accumulator（stop-gate 關）[S6]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
