#!/usr/bin/env node
// test-stop-gate.mjs —— config-protection.mjs + edit-accumulator.mjs + stop-gate.mjs 的紅綠斷言
// （自帶極簡 harness，仿同目錄 test-cost-hooks.mjs，不引測試框架）。
//
// 用法（cwd = plugins/loops-workflow）：node hooks/test-stop-gate.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1（主線用此 exit code 判紅綠）。
//
// 預期 Red：hooks/config-protection.mjs、hooks/edit-accumulator.mjs、hooks/stop-gate.mjs
// 三個模組尚未實作，下面三行 import 會 ERR_MODULE_NOT_FOUND，整個檔在載入期就丟例外 → node 非 0
// 退出。這就是 TDD 的紅燈起點。三模組補齊後，下方斷言才有機會逐條轉綠。

import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { isProtectedConfig, shouldBlock } from './config-protection.mjs';
import { addEdit, loadEdits, clearEdits } from './edit-accumulator.mjs';
import { shouldRunGate, buildGateInjection } from './stop-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');
const GATE_GREEN = join(FIX, 'gate-green'); // 內有 .loops/gate.config.json，type 閘綠 exit0
const GATE_RED = join(FIX, 'gate-red'); // 內有 .loops/gate.config.json，type 閘紅（一筆 tsc error）
const CONFIG_PROT_SCRIPT = join(HERE, 'config-protection.mjs'); // 真跑的 hook（smoke）
const ACCUMULATOR_SCRIPT = join(HERE, 'edit-accumulator.mjs');
const STOP_GATE_SCRIPT = join(HERE, 'stop-gate.mjs');

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

// accumulator / stop-gate 共用的 state 檔路徑規則（與契約一致）：
//   os.tmpdir()/loops-edits-<sanitize session>.json
// sanitize：非 [A-Za-z0-9_-] → '_'（與 #15 一致）。impl 不一定 export 此規則，故在測試端自刻同規則
// 當「安全檔名單一真相源」，並把 smoke 的 session_id 都限制在 [A-Za-z0-9_-]，讓 sanitize 為 identity、
// 不致與 impl 漂移。
function sanitizeSession(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_');
}
function editsStateFile(sessionId) {
  return join(tmpdir(), 'loops-edits-' + sanitizeSession(sessionId) + '.json');
}
function seedEdits(stateFile, paths) {
  // 預置 accumulator：直接寫 stop-gate 會讀的 state 檔（同 loadEdits 解析得到的 {ts,paths:[]} 形態）。
  writeFileSync(stateFile, JSON.stringify({ ts: Date.now(), paths }), 'utf8');
}

let seq = 0;
function freshSession(prefix) {
  // 執行內唯一 session_id（pid+時間+序號），確保 smoke 跨「執行」冪等、不撞殘留 state 檔。
  return `${prefix}-${process.pid}-${Date.now()}-${++seq}`;
}

function runHook(scriptAbs, payload, extraEnv = {}) {
  const env = { ...process.env };
  delete env.LOOPS_CONFIG_PROTECTION; // 確保「未設」情境真的未設（不被外層環境污染）
  delete env.LOOPS_STOP_GATE;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [scriptAbs], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
  });
}

// =============================================================================
// A) config-protection.mjs — 純函式
// =============================================================================

// 受保護清單（逐欄釘死契約）。
const PROTECTED = [
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
  '.eslintrc',
  '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
  '.prettierrc',
  '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml',
  'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs',
  'biome.json', 'biome.jsonc',
  'ruff.toml', '.ruff.toml',
];
// 明確非受保護（含「看似 config 的 .json」邊界：tsconfig/package 不在 lint/format 清單）。
const NOT_PROTECTED = ['app.ts', 'tsconfig.json', 'package.json', 'README.md', 'index.js', 'vite.config.ts'];

// ── A1 isProtectedConfig：清單命中 → true ────────────────────────────────────
{
  for (const name of PROTECTED) {
    assert(isProtectedConfig(name) === true, `isProtectedConfig("${name}") === true（受保護清單命中）[A1]`);
  }
}

// ── A2 isProtectedConfig：清單外 → false ─────────────────────────────────────
{
  for (const name of NOT_PROTECTED) {
    assert(isProtectedConfig(name) === false, `isProtectedConfig("${name}") === false（非受保護）[A2]`);
  }
}

// ── A3 shouldBlock：受保護 && 存在 才擋；新建 / 非受保護 → 放行；用 basename 判斷 ─
{
  assert(shouldBlock('/repo/eslint.config.js', () => true) === true,
    'shouldBlock：受保護且存在 → true（擋修改既有 config）[A3]');
  assert(shouldBlock('/repo/eslint.config.js', () => false) === false,
    'shouldBlock：受保護但不存在（新建）→ false（放行新建）[A3]');
  assert(shouldBlock('/repo/app.ts', () => true) === false,
    'shouldBlock：非受保護（即便存在）→ false [A3]');
  assert(shouldBlock('/deep/nested/dir/.prettierrc', () => true) === true,
    'shouldBlock：以 basename 判斷（深路徑下 .prettierrc 仍命中）→ true [A3]');
}

// =============================================================================
// B) edit-accumulator.mjs — 純函式
// =============================================================================

// ── B1 addEdit：append + 去重 + 回新陣列（不可變）─────────────────────────────
{
  assert(JSON.stringify(addEdit([], 'a.ts')) === JSON.stringify(['a.ts']),
    'addEdit：空陣列 append → ["a.ts"] [B1]');
  assert(JSON.stringify(addEdit(['a.ts'], 'b.ts')) === JSON.stringify(['a.ts', 'b.ts']),
    'addEdit：append 第二筆 → ["a.ts","b.ts"] [B1]');
  assert(JSON.stringify(addEdit(['a.ts'], 'a.ts')) === JSON.stringify(['a.ts']),
    'addEdit：已存在 → 去重不重覆加 [B1]');

  const orig = ['a.ts'];
  const next = addEdit(orig, 'b.ts');
  assert(next !== orig, 'addEdit：回「新」陣列（非同一參考）[B1]');
  assert(orig.length === 1 && orig[0] === 'a.ts', 'addEdit：不就地改原陣列（immutable）[B1]');
}

// ── B2 loadEdits：解析 {ts,paths:[]} → paths；壞 JSON / 空 → []（容錯不丟）──────
{
  assert(
    JSON.stringify(loadEdits(JSON.stringify({ ts: 123, paths: ['a.ts', 'b.ts'] }))) === JSON.stringify(['a.ts', 'b.ts']),
    'loadEdits：合法 state → 回 paths 陣列 [B2]');
  assert(Array.isArray(loadEdits('not json')) && loadEdits('not json').length === 0,
    'loadEdits：壞 JSON → [] [B2]');
  assert(Array.isArray(loadEdits('')) && loadEdits('').length === 0,
    'loadEdits：空字串 → [] [B2]');
  assert(Array.isArray(loadEdits(JSON.stringify({ ts: 1 }))) && loadEdits(JSON.stringify({ ts: 1 })).length === 0,
    'loadEdits：缺 paths 欄 → [] [B2]');
  // 與 addEdit 的格式一致性：addEdit 產出的陣列塞進 state → loadEdits 取得回原樣
  const state = JSON.stringify({ ts: 7, paths: addEdit(addEdit([], 'x.ts'), 'y.ts') });
  assert(JSON.stringify(loadEdits(state)) === JSON.stringify(['x.ts', 'y.ts']),
    'loadEdits：吃 addEdit 產出的 paths → 往返一致 [B2]');
}

// ── B3 clearEdits：回空狀態（loadEdits(clear 後) === []）──────────────────────
{
  const cleared = clearEdits();
  const serialized = typeof cleared === 'string' ? cleared : JSON.stringify(cleared ?? { paths: [] });
  const back = loadEdits(serialized);
  assert(Array.isArray(back) && back.length === 0, 'clearEdits：回空狀態 → loadEdits(clear 後) === [] [B3]');
}

// =============================================================================
// C) stop-gate.mjs — 純函式
// =============================================================================

// ── C1 shouldRunGate：三 gate 條件皆 true 才 true，任一 false → false ─────────
{
  assert(shouldRunGate({ flagOn: true, hasConfig: true, hasEdits: true }) === true,
    'shouldRunGate：flagOn && hasConfig && hasEdits → true [C1]');
  assert(shouldRunGate({ flagOn: false, hasConfig: true, hasEdits: true }) === false,
    'shouldRunGate：flagOn=false → false [C1]');
  assert(shouldRunGate({ flagOn: true, hasConfig: false, hasEdits: true }) === false,
    'shouldRunGate：hasConfig=false → false [C1]');
  assert(shouldRunGate({ flagOn: true, hasConfig: true, hasEdits: false }) === false,
    'shouldRunGate：hasEdits=false → false [C1]');
  assert(shouldRunGate({ flagOn: false, hasConfig: false, hasEdits: false }) === false,
    'shouldRunGate：全 false → false [C1]');
}

// ── C2 buildGateInjection：ok → null；非 ok → summary（>10000 截到 10000）──────
{
  assert(buildGateInjection('whatever summary', true) === null,
    'buildGateInjection：ok===true → null（綠靜默不注入）[C2]');
  assert(buildGateInjection('the red summary', false) === 'the red summary',
    'buildGateInjection：ok===false → 回 summary 字串 [C2]');

  const short = 'y'.repeat(500);
  assert(buildGateInjection(short, false) === short,
    'buildGateInjection：summary ≤10000 → 原樣回 [C2]');
  const exact = 'z'.repeat(10000);
  const exactOut = buildGateInjection(exact, false);
  assert(typeof exactOut === 'string' && exactOut.length === 10000,
    'buildGateInjection：summary === 10000 → 不截（長度仍 10000）[C2]');
  const long = 'x'.repeat(10005);
  const longOut = buildGateInjection(long, false);
  assert(typeof longOut === 'string' && longOut.length === 10000,
    'buildGateInjection：summary >10000 → 截到 10000 [C2]');
}

// =============================================================================
// SMOKE — config-protection.mjs（真 spawn、真讀寫、驗 stdout/exit 最終狀態）
// =============================================================================

// ── S-prot①：env=1 + 既有 eslint.config.js → deny ───────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'prot-deny-'));
  try {
    const cfg = join(dir, 'eslint.config.js');
    writeFileSync(cfg, 'export default [];\n');
    const res = runHook(
      CONFIG_PROT_SCRIPT,
      { tool_name: 'Edit', tool_input: { file_path: cfg } },
      { LOOPS_CONFIG_PROTECTION: '1' },
    );
    assert(res.error == null, 'S-prot①：node 啟動成功（spawn 無 error）[S-prot①]');
    let out = null;
    try { out = JSON.parse(res.stdout); } catch { out = null; }
    assert(out && out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision === 'deny',
      'S-prot①：env=1 + 受保護且存在 → stdout JSON hookSpecificOutput.permissionDecision === "deny" [S-prot①]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── S-prot②：env=1 + 受保護 basename 但檔不存在（新建）→ 無輸出（放行）───────────
{
  const dir = mkdtempSync(join(tmpdir(), 'prot-new-'));
  try {
    const newCfg = join(dir, 'eslint.config.js'); // 刻意不建立 → 視為新建
    const res = runHook(
      CONFIG_PROT_SCRIPT,
      { tool_name: 'Edit', tool_input: { file_path: newCfg } },
      { LOOPS_CONFIG_PROTECTION: '1' },
    );
    assert(res.status === 0, 'S-prot②：新建路徑 → exit 0 [S-prot②]');
    assert(typeof res.stdout === 'string' && res.stdout.trim() === '',
      'S-prot②：env=1 但檔不存在（新建）→ 無輸出（放行，不 deny）[S-prot②]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── S-prot③：env=1 + 非受保護 app.ts（即便存在）→ 無輸出（放行）────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'prot-app-'));
  try {
    const appFile = join(dir, 'app.ts');
    writeFileSync(appFile, '// app\n');
    const res = runHook(
      CONFIG_PROT_SCRIPT,
      { tool_name: 'Edit', tool_input: { file_path: appFile } },
      { LOOPS_CONFIG_PROTECTION: '1' },
    );
    assert(res.status === 0, 'S-prot③：非受保護 → exit 0 [S-prot③]');
    assert(typeof res.stdout === 'string' && res.stdout.trim() === '',
      'S-prot③：app.ts（非受保護）→ 無輸出（放行）[S-prot③]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── S-prot④：env 未設 + 既有 eslint.config.js → 無輸出（放行）─────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'prot-off-'));
  try {
    const cfg = join(dir, 'eslint.config.js');
    writeFileSync(cfg, 'export default [];\n');
    const res = runHook(CONFIG_PROT_SCRIPT, { tool_name: 'Edit', tool_input: { file_path: cfg } });
    assert(res.status === 0, 'S-prot④：env 未設 → exit 0 [S-prot④]');
    assert(typeof res.stdout === 'string' && res.stdout.trim() === '',
      'S-prot④：未設 LOOPS_CONFIG_PROTECTION → 無輸出（放行，即便受保護且存在）[S-prot④]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// =============================================================================
// SMOKE — edit-accumulator.mjs（真 spawn 累積 state 檔，驗去重 / 多筆）
// =============================================================================

// ── S-acc①：兩次不同 path → state 檔 paths 累積 2 筆 ─────────────────────────
{
  const sessionId = freshSession('acc');
  const stateFile = editsStateFile(sessionId);
  rmSync(stateFile, { force: true });
  try {
    const pa = join(tmpdir(), `acc-a-${sessionId}.ts`); // 絕對路徑：避免 impl 正規化造成 includes 漂移
    const pb = join(tmpdir(), `acc-b-${sessionId}.ts`);
    const r1 = runHook(ACCUMULATOR_SCRIPT, { session_id: sessionId, tool_input: { file_path: pa } });
    const r2 = runHook(ACCUMULATOR_SCRIPT, { session_id: sessionId, tool_input: { file_path: pb } });
    assert(r1.status === 0 && r2.status === 0, 'S-acc①：兩次 spawn 皆 exit 0 [S-acc①]');
    assert(existsSync(stateFile), 'S-acc①：accumulator 產生 state 檔 [S-acc①]');
    const paths = existsSync(stateFile) ? loadEdits(readFileSync(stateFile, 'utf8')) : [];
    assert(paths.length === 2, 'S-acc①：兩不同 path → state 檔 paths 累積 2 筆 [S-acc①]');
    assert(paths.includes(pa) && paths.includes(pb), 'S-acc①：兩 path 都被記錄 [S-acc①]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── S-acc②：同一 path 兩次 → 去重 1 筆 ──────────────────────────────────────
{
  const sessionId = freshSession('acc-dup');
  const stateFile = editsStateFile(sessionId);
  rmSync(stateFile, { force: true });
  try {
    const p = join(tmpdir(), `acc-dup-${sessionId}.ts`);
    runHook(ACCUMULATOR_SCRIPT, { session_id: sessionId, tool_input: { file_path: p } });
    runHook(ACCUMULATOR_SCRIPT, { session_id: sessionId, tool_input: { file_path: p } });
    const paths = existsSync(stateFile) ? loadEdits(readFileSync(stateFile, 'utf8')) : [];
    assert(paths.length === 1, 'S-acc②：同 path 兩次 → 去重後 paths 只 1 筆 [S-acc②]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// =============================================================================
// SMOKE — stop-gate.mjs（最重要：真 spawn stop-gate → 真跑 quality-gate fixtures）
// =============================================================================

// ── S-gate①：env=1 + gate-green cwd + 預置 edit → 綠靜默 + accumulator 被清空 ──
{
  const sessionId = freshSession('gate-green');
  const stateFile = editsStateFile(sessionId);
  seedEdits(stateFile, [join(tmpdir(), `edited-${sessionId}.ts`)]);
  try {
    const res = runHook(
      STOP_GATE_SCRIPT,
      { session_id: sessionId, cwd: GATE_GREEN },
      { LOOPS_STOP_GATE: '1' },
    );
    assert(res.error == null, 'S-gate①：node 啟動成功（spawn 無 error）[S-gate①]');
    assert(res.status === 0, 'S-gate①：gate 綠 → hook exit 0 [S-gate①]');
    assert(typeof res.stdout === 'string' && !res.stdout.includes('additionalContext'),
      'S-gate①：gate 綠 → stdout 無 additionalContext（綠靜默）[S-gate①]');
    const after = existsSync(stateFile) ? loadEdits(readFileSync(stateFile, 'utf8')) : [];
    assert(after.length === 0, 'S-gate①：綠跑完 → accumulator 被清空（loadEdits === []）[S-gate①]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── S-gate②：env=1 + gate-red cwd + 預置 edit → 注入 additionalContext（含 ✗）──
{
  const sessionId = freshSession('gate-red');
  const stateFile = editsStateFile(sessionId);
  seedEdits(stateFile, [join(tmpdir(), `edited-${sessionId}.ts`)]);
  try {
    const res = runHook(
      STOP_GATE_SCRIPT,
      { session_id: sessionId, cwd: GATE_RED },
      { LOOPS_STOP_GATE: '1' },
    );
    assert(res.error == null, 'S-gate②：node 啟動成功（spawn 無 error）[S-gate②]');
    let out = null;
    try { out = JSON.parse(res.stdout); } catch { out = null; }
    const ctx = out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext;
    assert(typeof ctx === 'string' && ctx.length > 0,
      'S-gate②：gate 紅 → stdout JSON 有 hookSpecificOutput.additionalContext [S-gate②]');
    assert(typeof ctx === 'string' && (ctx.includes('✗') || /error/i.test(ctx)),
      'S-gate②：additionalContext 含 ✗ / error（quality-gate 紅摘要被注入）[S-gate②]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── S-gate③a：env 關（其餘齊備）→ no-op（不跑 gate、無 additionalContext）──────
{
  const sessionId = freshSession('gate-off');
  const stateFile = editsStateFile(sessionId);
  seedEdits(stateFile, [join(tmpdir(), `edited-${sessionId}.ts`)]);
  try {
    const res = runHook(STOP_GATE_SCRIPT, { session_id: sessionId, cwd: GATE_GREEN }); // 未設 LOOPS_STOP_GATE
    assert(res.status === 0, 'S-gate③a：env 關 → exit 0 [S-gate③a]');
    assert(typeof res.stdout === 'string' && !res.stdout.includes('additionalContext'),
      'S-gate③a：未設 LOOPS_STOP_GATE → no-op（無 additionalContext）[S-gate③a]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── S-gate③b：env=1 但 cwd 無 .loops/gate.config.json → no-op ────────────────
{
  const sessionId = freshSession('gate-nocfg');
  const stateFile = editsStateFile(sessionId);
  seedEdits(stateFile, [join(tmpdir(), `edited-${sessionId}.ts`)]);
  const noCfgCwd = mkdtempSync(join(tmpdir(), 'gate-nocfg-'));
  try {
    const res = runHook(
      STOP_GATE_SCRIPT,
      { session_id: sessionId, cwd: noCfgCwd },
      { LOOPS_STOP_GATE: '1' },
    );
    assert(res.status === 0, 'S-gate③b：無 .loops/gate.config.json → exit 0 [S-gate③b]');
    assert(typeof res.stdout === 'string' && !res.stdout.includes('additionalContext'),
      'S-gate③b：cwd 無 gate.config.json → no-op（hasConfig=false 不跑 gate）[S-gate③b]');
  } finally {
    rmSync(stateFile, { force: true });
    rmSync(noCfgCwd, { recursive: true, force: true });
  }
}

// ── S-gate③c：env=1 + gate-green cwd 但 accumulator 空 → no-op ───────────────
{
  const sessionId = freshSession('gate-noedits');
  const stateFile = editsStateFile(sessionId);
  rmSync(stateFile, { force: true }); // 確保無任何預置 edit（accumulator 空）
  try {
    const res = runHook(
      STOP_GATE_SCRIPT,
      { session_id: sessionId, cwd: GATE_GREEN },
      { LOOPS_STOP_GATE: '1' },
    );
    assert(res.status === 0, 'S-gate③c：accumulator 空 → exit 0 [S-gate③c]');
    assert(typeof res.stdout === 'string' && !res.stdout.includes('additionalContext'),
      'S-gate③c：無 edits → no-op（hasEdits=false 不跑 gate）[S-gate③c]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── 摘要 + exit code ─────────────────────────────────────────────────────────
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
