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
import {
  addEdit,
  loadEdits,
  clearEdits,
  editsStateFile,
  readEditsForSession,
  writeEditsState,
} from './edit-accumulator.mjs';
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

// accumulator / stop-gate 的 state 檔「路徑 / 讀 / 寫」一律走 edit-accumulator.mjs 的 export
// （editsStateFile / readEditsForSession / writeEditsState）當單一真相源——測試端不再自刻 sanitize、
// 路徑組法或 seed 寫法，避免與 impl 漂移。seed accumulator 用 writeEditsState(sessionId, paths)：直接
// 落盤 state 檔、不經 PostToolUse hook，故不受「accumulator 僅在 LOOPS_STOP_GATE=1 才寫」這道 flag 閘影響。

let seq = 0;
function freshSession(prefix) {
  // 執行內唯一 session_id（pid+時間+序號），確保 smoke 跨「執行」冪等、不撞殘留 state 檔。
  return `${prefix}-${process.pid}-${Date.now()}-${++seq}`;
}

function runHook(scriptAbs, payload, extraEnv = {}) {
  const env = { ...process.env };
  delete env.LOOPS_CONFIG_PROTECTION; // 確保「未設」情境真的未設（不被外層環境污染）
  delete env.LOOPS_STOP_GATE;
  delete env.LOOPS_EVAL_GATE; // #35：accumulator 現也認 eval-gate flag，須一併隔離才能測「兩 flag 都關 → no-op」
  delete env.LOOPS_EVAL_TAGS_GATE; // #87：accumulator 消費 flag 擴至三個 eval 訊號，皆須隔離避免污染「全關」情境
  delete env.LOOPS_EVAL_POLL_GATE;
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

  // A3 空注入 guard 回歸：非 ok 但摘要空 / 全空白 → 仍回 null（gate 崩潰 stdout 為空時不注入空 additionalContext）。
  // Prove-It：把 impl 的 `out.trim() ? out : null` 改回 `return out`，下兩條會轉紅（''/全空白會被當成有效注入回傳）。
  assert(buildGateInjection('', false) === null,
    'buildGateInjection：ok===false 但 summary 空字串 → null（空注入 guard）[C2]');
  assert(buildGateInjection('   \n ', false) === null,
    'buildGateInjection：ok===false 但 summary 全空白 → null（空注入 guard）[C2]');
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

// ── S-prot④：env 未設 + 無 cwd（無從判定 .loops）+ 既有 eslint.config.js → 無輸出（放行）──
// 新語意（#87）：LOOPS_CONFIG_PROTECTION 翻轉為 defaultOn 但 loops-scoped——「未設」時只在
// payload.cwd 下有 .loops/ 才生效；此處 payload 根本無 cwd 欄位，無從確認 .loops 存在 → 視為不生效、放行。
{
  const dir = mkdtempSync(join(tmpdir(), 'prot-off-'));
  try {
    const cfg = join(dir, 'eslint.config.js');
    writeFileSync(cfg, 'export default [];\n');
    const res = runHook(CONFIG_PROT_SCRIPT, { tool_name: 'Edit', tool_input: { file_path: cfg } });
    assert(res.status === 0, 'S-prot④：env 未設 → exit 0 [S-prot④]');
    assert(typeof res.stdout === 'string' && res.stdout.trim() === '',
      'S-prot④：未設 LOOPS_CONFIG_PROTECTION 且無 cwd 可查 .loops → 無輸出（放行）[S-prot④]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// =============================================================================
// #87 config-protection 新行為（defaultOn 但 loops-scoped）新增案例
// =============================================================================

// ── S-prot⑤（defaultOn + loops-scoped）：env 未設 + payload.cwd 下有 .loops/ + 既有受保護檔 → deny ──
{
  const cwd = mkdtempSync(join(tmpdir(), 'prot-unset-loops-'));
  try {
    mkdirSync(join(cwd, '.loops'), { recursive: true });
    const cfg = join(cwd, 'eslint.config.js');
    writeFileSync(cfg, 'export default [];\n');
    const res = runHook(CONFIG_PROT_SCRIPT, { tool_name: 'Edit', cwd, tool_input: { file_path: cfg } }); // env 未設
    let out = null; try { out = JSON.parse(res.stdout); } catch { out = null; }
    assert(res.status === 0, 'S-prot⑤：exit 0 [S-prot⑤]');
    assert(out && out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision === 'deny',
      'S-prot⑤：未設 LOOPS_CONFIG_PROTECTION 但 payload.cwd 下有 .loops/ → deny（defaultOn 於 loops 工作區生效）[S-prot⑤]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── S-prot⑥（defaultOn + loops-scoped）：env 未設 + payload.cwd 下無 .loops/ + 既有受保護檔 → 放行（不擾非 loops 專案）──
{
  const cwd = mkdtempSync(join(tmpdir(), 'prot-unset-noloops-'));
  try {
    const cfg = join(cwd, 'eslint.config.js');
    writeFileSync(cfg, 'export default [];\n'); // 無 .loops/ 目錄
    const res = runHook(CONFIG_PROT_SCRIPT, { tool_name: 'Edit', cwd, tool_input: { file_path: cfg } }); // env 未設
    assert(res.status === 0, 'S-prot⑥：exit 0 [S-prot⑥]');
    assert(typeof res.stdout === 'string' && res.stdout.trim() === '',
      'S-prot⑥：未設 LOOPS_CONFIG_PROTECTION 且 cwd 下無 .loops/ → 無輸出（放行，不擾非 loops 專案）[S-prot⑥]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── S-prot⑦（顯式 '1' 全域生效）：env='1' + payload.cwd 下「無」.loops/ + 既有受保護檔 → 仍 deny（不查 .loops，既有行為）──
{
  const cwd = mkdtempSync(join(tmpdir(), 'prot-explicit1-'));
  try {
    const cfg = join(cwd, 'eslint.config.js');
    writeFileSync(cfg, 'export default [];\n'); // 無 .loops/ 目錄
    const res = runHook(
      CONFIG_PROT_SCRIPT,
      { tool_name: 'Edit', cwd, tool_input: { file_path: cfg } },
      { LOOPS_CONFIG_PROTECTION: '1' },
    );
    let out = null; try { out = JSON.parse(res.stdout); } catch { out = null; }
    assert(res.status === 0, 'S-prot⑦：exit 0 [S-prot⑦]');
    assert(out && out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision === 'deny',
      'S-prot⑦：顯式 LOOPS_CONFIG_PROTECTION=\'1\' → 全域生效（即便 cwd 無 .loops/ 仍 deny，不查 .loops）[S-prot⑦]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── S-prot⑧（顯式 '0' 關）：env='0' + payload.cwd 下有 .loops/ + 既有受保護檔 → 放行 ──
{
  const cwd = mkdtempSync(join(tmpdir(), 'prot-explicit0-'));
  try {
    mkdirSync(join(cwd, '.loops'), { recursive: true });
    const cfg = join(cwd, 'eslint.config.js');
    writeFileSync(cfg, 'export default [];\n');
    const res = runHook(
      CONFIG_PROT_SCRIPT,
      { tool_name: 'Edit', cwd, tool_input: { file_path: cfg } },
      { LOOPS_CONFIG_PROTECTION: '0' },
    );
    assert(res.status === 0, 'S-prot⑧：exit 0 [S-prot⑧]');
    assert(typeof res.stdout === 'string' && res.stdout.trim() === '',
      'S-prot⑧：顯式 LOOPS_CONFIG_PROTECTION=\'0\' → 放行（即便 cwd 有 .loops/ 且受保護檔存在）[S-prot⑧]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// =============================================================================
// SMOKE — edit-accumulator.mjs（真 spawn 累積 state 檔，驗去重 / 多筆）
// =============================================================================

// accumulator 新前置條件（#87）：除了「任一消費 flag 依新語意啟用」，還須 payload.cwd 下存在 .loops/
// 才會記錄（loops-scoped）。以下 smoke 一律建一個帶 .loops/ 的暫存 cwd 並塞進 payload，符合新契約。
function makeAccCwd(prefix) {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(cwd, '.loops'), { recursive: true });
  return cwd;
}

// ── S-acc①：兩次不同 path（cwd 有 .loops/）→ state 檔 paths 累積 2 筆（accumulator hook 僅消費 flag 開才寫 state）──
{
  const sessionId = freshSession('acc');
  const stateFile = editsStateFile(sessionId);
  rmSync(stateFile, { force: true });
  const cwd = makeAccCwd('acc-cwd-');
  try {
    const pa = join(tmpdir(), `acc-a-${sessionId}.ts`); // 絕對路徑：避免 impl 正規化造成 includes 漂移
    const pb = join(tmpdir(), `acc-b-${sessionId}.ts`);
    // A1：edit-accumulator 的 PostToolUse hook 只在消費 flag 啟用「且」payload.cwd 下有 .loops/ 時才寫 state。
    const r1 = runHook(ACCUMULATOR_SCRIPT, { session_id: sessionId, cwd, tool_input: { file_path: pa } }, { LOOPS_STOP_GATE: '1' });
    const r2 = runHook(ACCUMULATOR_SCRIPT, { session_id: sessionId, cwd, tool_input: { file_path: pb } }, { LOOPS_STOP_GATE: '1' });
    assert(r1.status === 0 && r2.status === 0, 'S-acc①：兩次 spawn 皆 exit 0 [S-acc①]');
    assert(existsSync(stateFile), 'S-acc①：accumulator 產生 state 檔 [S-acc①]');
    const paths = readEditsForSession(sessionId); // 單一真相源讀回（不自刻路徑/解析）
    assert(paths.length === 2, 'S-acc①：兩不同 path → state 檔 paths 累積 2 筆 [S-acc①]');
    assert(paths.includes(pa) && paths.includes(pb), 'S-acc①：兩 path 都被記錄 [S-acc①]');
  } finally {
    rmSync(stateFile, { force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── S-acc②：同一 path 兩次（cwd 有 .loops/）→ 去重 1 筆 ─────────────────────
{
  const sessionId = freshSession('acc-dup');
  const stateFile = editsStateFile(sessionId);
  rmSync(stateFile, { force: true });
  const cwd = makeAccCwd('acc-dup-cwd-');
  try {
    const p = join(tmpdir(), `acc-dup-${sessionId}.ts`);
    // A1：accumulator hook 須在消費 flag 啟用「且」cwd 有 .loops/ 下才會寫 state。
    runHook(ACCUMULATOR_SCRIPT, { session_id: sessionId, cwd, tool_input: { file_path: p } }, { LOOPS_STOP_GATE: '1' });
    runHook(ACCUMULATOR_SCRIPT, { session_id: sessionId, cwd, tool_input: { file_path: p } }, { LOOPS_STOP_GATE: '1' });
    const paths = readEditsForSession(sessionId); // 單一真相源讀回
    assert(paths.length === 1, 'S-acc②：同 path 兩次 → 去重後 paths 只 1 筆 [S-acc②]');
  } finally {
    rmSync(stateFile, { force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── S-acc③（改）：三個 eval flag 皆顯式 '0'（且 LOOPS_STOP_GATE 未設）+ cwd 有 .loops/ → accumulator no-op、不寫出 state 檔 ──
// 新語意（#87）：LOOPS_STOP_GATE 仍是 optIn（未設＝關），但 LOOPS_EVAL_GATE / _TAGS_GATE / _POLL_GATE 三者已翻轉為
// defaultOn；若只是「未設」不足以代表關閉（見下方 S-acc③c 的翻轉斷言），本條須把三者顯式設 '0' 才是「全部消費 flag 皆關」。
{
  const sessionId = freshSession('acc-alloff');
  const stateFile = editsStateFile(sessionId);
  rmSync(stateFile, { force: true }); // 起始確保無殘留 state 檔（冪等）
  const cwd = makeAccCwd('acc-alloff-cwd-');
  try {
    const p = join(tmpdir(), `acc-alloff-${sessionId}.ts`);
    // Prove-It：若 impl 把 GATE/TAGS/POLL 的「關」判斷退化成只看未設（而非新 flagEnabled 語意），
    // 顯式 '0' 仍應正確判為關；反之若忽略顯式 '0' 仍記錄 → 此條轉紅。
    runHook(
      ACCUMULATOR_SCRIPT,
      { session_id: sessionId, cwd, tool_input: { file_path: p } },
      { LOOPS_EVAL_GATE: '0', LOOPS_EVAL_TAGS_GATE: '0', LOOPS_EVAL_POLL_GATE: '0' }, // LOOPS_STOP_GATE 維持未設（optIn 關）
    );
    assert(existsSync(editsStateFile(sessionId)) === false,
      'S-acc③：四個消費 flag 皆判定關閉（STOP 未設 + 三 eval flag 顯式 \'0\'）→ accumulator no-op、不寫出 state 檔 [S-acc③]');
  } finally {
    rmSync(stateFile, { force: true }); // 防衛性清（預期本就無檔）
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── S-acc③b（loops-scoped 新前置）：消費 flag 未設（defaultOn）但 cwd 下「無」.loops/ → accumulator no-op、不寫出 state 檔 ──
// 釘住 #87 新前置條件：即便 GATE/TAGS/POLL 因未設而判定為開，缺 .loops/ 仍不該記錄（不擾非 loops 專案）。
{
  const sessionId = freshSession('acc-noloops');
  const stateFile = editsStateFile(sessionId);
  rmSync(stateFile, { force: true });
  const cwd = mkdtempSync(join(tmpdir(), 'acc-noloops-cwd-')); // 刻意不建 .loops/
  try {
    const p = join(tmpdir(), `acc-noloops-${sessionId}.ts`);
    runHook(ACCUMULATOR_SCRIPT, { session_id: sessionId, cwd, tool_input: { file_path: p } }); // 全部消費 flag 未設
    assert(existsSync(editsStateFile(sessionId)) === false,
      'S-acc③b：消費 flag 未設（defaultOn）但 cwd 下無 .loops/ → accumulator no-op、不寫出 state 檔 [S-acc③b]');
  } finally {
    rmSync(stateFile, { force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── S-acc③c（defaultOn 翻轉）：消費 flag 全未設（defaultOn）且 cwd 下「有」.loops/ → accumulator 仍記錄 ──
// 釘住 #87 翻轉契約：LOOPS_EVAL_GATE 等三個 eval flag 現為 defaultOn，「未設」等同「開」；
// 搭配 cwd 有 .loops/，前置條件（任一消費 flag 開 + cwd 有 .loops/）齊備 → 應記錄 edit。
{
  const sessionId = freshSession('acc-unset-loops');
  const stateFile = editsStateFile(sessionId);
  rmSync(stateFile, { force: true });
  const cwd = makeAccCwd('acc-unset-loops-cwd-');
  try {
    const p = join(tmpdir(), `acc-unset-loops-${sessionId}.ts`);
    runHook(ACCUMULATOR_SCRIPT, { session_id: sessionId, cwd, tool_input: { file_path: p } }); // 全部消費 flag 未設（defaultOn 三者仍算開）
    const paths = readEditsForSession(sessionId);
    assert(paths.length === 1 && paths.includes(p),
      'S-acc③c：消費 flag 全未設（defaultOn）+ cwd 有 .loops/ → accumulator 仍記錄（defaultOn 翻轉）[S-acc③c]');
  } finally {
    rmSync(stateFile, { force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

// =============================================================================
// SMOKE — stop-gate.mjs（最重要：真 spawn stop-gate → 真跑 quality-gate fixtures）
// =============================================================================

// ── S-gate①：env=1 + gate-green cwd + 預置 edit → 綠靜默 + accumulator 被清空 ──
{
  const sessionId = freshSession('gate-green');
  const stateFile = editsStateFile(sessionId);
  writeEditsState(sessionId, [join(tmpdir(), `edited-${sessionId}.ts`)]); // seed：直接落盤、不受 flag 閘影響
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
    const after = readEditsForSession(sessionId);
    assert(after.length === 0, 'S-gate①：綠跑完 → accumulator 被清空（readEditsForSession === []）[S-gate①]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── S-gate②：env=1 + gate-red cwd + 預置 edit → 注入 additionalContext（含 ✗）+ accumulator 被清空 ──
{
  const sessionId = freshSession('gate-red');
  const stateFile = editsStateFile(sessionId);
  writeEditsState(sessionId, [join(tmpdir(), `edited-${sessionId}.ts`)]); // seed：直接落盤、不受 flag 閘影響
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
    // A6：紅燈跑完也要清 accumulator（與 S-gate① 綠燈清空對稱；把「只綠燈才清」改壞→此條轉紅）。
    const after = readEditsForSession(sessionId);
    assert(after.length === 0,
      'S-gate②：紅跑完 → accumulator 也被清空（readEditsForSession === []）[A6]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── S-gate③a：env 關（其餘齊備、已 seed 一筆）→ no-op（不跑 gate、無 additionalContext、不清 accumulator）──
{
  const sessionId = freshSession('gate-off');
  const stateFile = editsStateFile(sessionId);
  writeEditsState(sessionId, [join(tmpdir(), `edited-${sessionId}.ts`)]); // seed 一筆：直接落盤、不受 flag 閘影響
  try {
    const res = runHook(STOP_GATE_SCRIPT, { session_id: sessionId, cwd: GATE_GREEN }); // 未設 LOOPS_STOP_GATE
    assert(res.status === 0, 'S-gate③a：env 關 → exit 0 [S-gate③a]');
    assert(typeof res.stdout === 'string' && !res.stdout.includes('additionalContext'),
      'S-gate③a：未設 LOOPS_STOP_GATE → no-op（無 additionalContext）[S-gate③a]');
    // A5：no-op 不該動 accumulator——若拆掉 flag 守衛、gate 照跑就會清成 0，此條轉紅。
    assert(readEditsForSession(sessionId).length === 1,
      'S-gate③a：no-op 不清 accumulator（seed 的 1 筆仍在，readEditsForSession.length === 1）[A5]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── S-gate③b：env=1 但 cwd 無 .loops/gate.config.json（已 seed 一筆）→ no-op（不清 accumulator）──
{
  const sessionId = freshSession('gate-nocfg');
  const stateFile = editsStateFile(sessionId);
  writeEditsState(sessionId, [join(tmpdir(), `edited-${sessionId}.ts`)]); // seed 一筆：直接落盤、不受 flag 閘影響
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
    // A5：no-op 不該動 accumulator——若拆掉 hasConfig 守衛、gate 照跑就會清成 0，此條轉紅。
    assert(readEditsForSession(sessionId).length === 1,
      'S-gate③b：no-op 不清 accumulator（seed 的 1 筆仍在，readEditsForSession.length === 1）[A5]');
  } finally {
    rmSync(stateFile, { force: true });
    rmSync(noCfgCwd, { recursive: true, force: true });
  }
}

// ── S-gate③c：env=1 + gate-green cwd 但 accumulator 空 → no-op（連 state 檔都不寫出）───────────────
{
  const sessionId = freshSession('gate-noedits');
  const stateFile = editsStateFile(sessionId);
  rmSync(stateFile, { force: true }); // 確保無任何預置 edit（accumulator 空、state 檔不存在）
  try {
    const res = runHook(
      STOP_GATE_SCRIPT,
      { session_id: sessionId, cwd: GATE_GREEN },
      { LOOPS_STOP_GATE: '1' },
    );
    assert(res.status === 0, 'S-gate③c：accumulator 空 → exit 0 [S-gate③c]');
    assert(typeof res.stdout === 'string' && !res.stdout.includes('additionalContext'),
      'S-gate③c：無 edits → no-op（hasEdits=false 不跑 gate）[S-gate③c]');
    // A5：no-op 不該寫出 state 檔——若拆掉 hasEdits 守衛、gate 照跑就會 clearEditsState 落出空檔，existsSync 轉 true、此條轉紅。
    assert(existsSync(editsStateFile(sessionId)) === false,
      'S-gate③c：no-op 不寫出 state 檔（existsSync(editsStateFile) === false）[A5]');
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// =============================================================================
// SMOKE — stop-gate.mjs 發現性提示（#87：optIn 未開時，主動提示可設 LOOPS_STOP_GATE=1）
// =============================================================================
// 契約：①main 重排「先讀 stdin 再查 flag」（本節各案例本身即驗證此重排——若 main 仍在讀 stdin 前就
//   因 flag 關而 return，將永遠讀不到 payload.cwd，以下「應提示」案例會全部轉紅）。
// ②flag 關（optIn 未開）且 payload.cwd 有 .loops/gate.config.json 且本 session 未提示過
//   → stdout 注入一行提示（含字面 LOOPS_STOP_GATE=1 與「信任」字樣）；已開 / 無 config / 同 session
//   第二次 → 無提示。提示 state 檔於 os.tmpdir()（檔名含 session id，仿 suggest-compact），
//   本測試不預知其確切檔名，靠「未設過的 fresh session」+「同 session 連續兩次呼叫」驗證行為。

// ── D①（應提示）：flag 關（未設）+ cwd=GATE_GREEN（有 gate.config.json）+ fresh session → stdout 含提示 ──
{
  const sessionId = freshSession('discover-1');
  const res = runHook(STOP_GATE_SCRIPT, { session_id: sessionId, cwd: GATE_GREEN }); // 未設 LOOPS_STOP_GATE
  assert(res.status === 0, 'D①：flag 關 + 有 config + 未提示過 → exit 0 [D①]');
  const out = res.stdout || '';
  assert(out.includes('LOOPS_STOP_GATE=1'),
    'D①：flag 關 + cwd 有 .loops/gate.config.json + 本 session 未提示過 → stdout 含字面 "LOOPS_STOP_GATE=1" [D①]');
  assert(out.includes('信任'),
    'D①：發現性提示含「信任」字樣（提醒此 flag 會自動執行 repo 命令、需信任 repo）[D①]');
}

// ── D②（不該提示：已開）：flag='1' + cwd=GATE_GREEN + fresh session、無 edits → stdout 不含提示文案 ──
{
  const sessionId = freshSession('discover-2');
  const res = runHook(STOP_GATE_SCRIPT, { session_id: sessionId, cwd: GATE_GREEN }, { LOOPS_STOP_GATE: '1' });
  assert(res.status === 0, 'D②：flag 開 → exit 0 [D②]');
  assert(!(res.stdout || '').includes('LOOPS_STOP_GATE=1'),
    'D②：LOOPS_STOP_GATE 已顯式開（\'1\'）→ 不該再提示「可設 LOOPS_STOP_GATE=1」（已開無需提示）[D②]');
}

// ── D③（不該提示：無 config）：flag 關 + cwd 下無 .loops/gate.config.json → stdout 不含提示文案 ──
{
  const sessionId = freshSession('discover-3');
  const noCfgCwd = mkdtempSync(join(tmpdir(), 'discover-nocfg-'));
  try {
    const res = runHook(STOP_GATE_SCRIPT, { session_id: sessionId, cwd: noCfgCwd }); // 未設 LOOPS_STOP_GATE
    assert(res.status === 0, 'D③：flag 關 + 無 config → exit 0 [D③]');
    assert(!(res.stdout || '').includes('LOOPS_STOP_GATE=1'),
      'D③：cwd 下無 .loops/gate.config.json → 不該提示（非 gate 工作區、提示無意義）[D③]');
  } finally {
    rmSync(noCfgCwd, { recursive: true, force: true });
  }
}

// ── D④（不該提示：同 session 第二次）：flag 關 + cwd=GATE_GREEN + 同 session 連呼兩次 → 第二次無提示 ──
{
  const sessionId = freshSession('discover-4');
  const first = runHook(STOP_GATE_SCRIPT, { session_id: sessionId, cwd: GATE_GREEN }); // 未設 LOOPS_STOP_GATE
  const second = runHook(STOP_GATE_SCRIPT, { session_id: sessionId, cwd: GATE_GREEN }); // 同 session 再呼叫一次
  assert(first.status === 0 && second.status === 0, 'D④：兩次呼叫皆 exit 0 [D④]');
  assert((first.stdout || '').includes('LOOPS_STOP_GATE=1'),
    'D④：首次（同 session）→ 有提示（含 "LOOPS_STOP_GATE=1"）[D④]');
  assert(!(second.stdout || '').includes('LOOPS_STOP_GATE=1'),
    'D④：同 session 第二次呼叫 → 無提示（state 已記住本 session 提示過，不重複洗版）[D④]');
}

// ── D⑤（安全邊界 + 驗主重排①）：flag 關 + payload 缺 cwd → exit 0、不崩、無提示（早讀 stdin 但仍優雅早退）──
// 本條同時驗①的「先讀 stdin」重排不會因缺 cwd 而崩：main 必須先讀完 stdin（拿到 payload）才能判斷 cwd 是否存在，
// 若 main 仍是「先查 flag、flag 關就直接 return」的舊序，本條仍會綠（因為兩種順序在缺 cwd 時結果一致）——
// 故本條的真正判別力來自 D①（有 config 時必須真的讀到 payload.cwd 才提得出提示）。
{
  const sessionId = freshSession('discover-5');
  const res = runHook(STOP_GATE_SCRIPT, { session_id: sessionId }); // 未設 LOOPS_STOP_GATE、無 cwd
  assert(res.status === 0, 'D⑤：flag 關 + 缺 cwd → exit 0（不崩）[D⑤]');
  assert(!(res.stdout || '').includes('LOOPS_STOP_GATE=1'),
    'D⑤：缺 cwd 無從查 .loops/gate.config.json → 不提示 [D⑤]');
}

// ── 摘要 + exit code ─────────────────────────────────────────────────────────
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
