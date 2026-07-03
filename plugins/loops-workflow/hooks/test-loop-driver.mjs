#!/usr/bin/env node
// test-loop-driver.mjs —— Stop hook loop-driver.mjs 的紅綠斷言。
// 自帶極簡 harness（仿同目錄 test-stop-gate.mjs：assert 累加器 + spawnSync stdin payload +
// flag 隔離 delete env + mkdtemp fixture + finally rmSync teardown），不引測試框架。
//
// 用法（cwd = plugins/loops-workflow）：node hooks/test-loop-driver.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1。
//
// 預期 Red：hooks/loop-driver.mjs 尚未實作，下面具名 import 會 ERR_MODULE_NOT_FOUND，
// 整個檔在載入期就丟例外 → node 非 0 退出。這就是 TDD 的紅燈起點。

import {
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { deriveCursor, shouldContinue, judgeLedger, buildContinuationReason } from './loop-driver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');
const GATE_GREEN = join(FIX, 'gate-green'); // .loops/gate.config.json → type 閘綠
const GATE_RED = join(FIX, 'gate-red'); // .loops/gate.config.json → type 閘紅
const GATE_LINT_ONLY_GREEN = join(FIX, 'loop-driver', 'gate-lint-only-green'); // 只配 lint 綠、無 test/type
const SCRIPT = join(HERE, 'loop-driver.mjs');

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

let seq = 0;
function freshSession(prefix) {
  return `${prefix}-${process.pid}-${Date.now()}-${++seq}`;
}

function runHook(payload, extraEnv = {}) {
  const env = { ...process.env };
  delete env.LOOPS_LOOP_DRIVER; // 確保「未設」情境真的未設（不被外層環境污染）
  delete env.LOOPS_AUTO;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
  });
}

// ── state fixture helpers ────────────────────────────────────────────────────

const SLUG = 'demo-slug';

function stateFilePath(cwd, slug = SLUG) {
  return join(cwd, '.loops', slug, 'state.json');
}

function writeLoopState(cwd, stateObjOrRaw, slug = SLUG) {
  const dir = join(cwd, '.loops', slug);
  mkdirSync(dir, { recursive: true });
  const raw = typeof stateObjOrRaw === 'string' ? stateObjOrRaw : JSON.stringify(stateObjOrRaw);
  writeFileSync(stateFilePath(cwd, slug), raw);
  return stateFilePath(cwd, slug);
}

function makeTask(overrides = {}) {
  return {
    id: 'T1',
    title: 'Implement ratio rule',
    body: 'Do the thing.',
    status: 'pending',
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return {
    schema: 1,
    slug: SLUG,
    session: 'sess-fixed-1',
    stage: 'build',
    progressionMode: 'auto',
    tasks: [makeTask()],
    iteration: 0,
    maxIterations: 10,
    awaitingApproval: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function mkFixtureCwd(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cloneFixtureCwd(srcFixture, prefix) {
  const dest = mkdtempSync(join(tmpdir(), prefix));
  cpSync(srcFixture, dest, { recursive: true });
  return dest;
}

function parseStdoutJson(res) {
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

function decisionOf(res) {
  const out = parseStdoutJson(res);
  return out?.decision ?? null;
}

function reasonOf(res) {
  const out = parseStdoutJson(res);
  return out?.reason ?? '';
}

// =============================================================================
// A) deriveCursor — 純函式
// =============================================================================
{
  assert(deriveCursor([]) === -1, 'deriveCursor：空陣列 → -1 [A1]');
  assert(
    deriveCursor([{ status: 'done' }, { status: 'done' }]) === -1,
    'deriveCursor：全 done → -1 [A2]',
  );
  assert(
    deriveCursor([{ status: 'pending' }, { status: 'done' }]) === 0,
    'deriveCursor：首筆非 done → 0 [A3]',
  );
  assert(
    deriveCursor([{ status: 'done' }, { status: 'pending' }, { status: 'done' }]) === 1,
    'deriveCursor：中間筆非 done（跳號假帳情境）→ 回該 index [A4]',
  );
}

// =============================================================================
// B) shouldContinue — 純函式（8 步序，逐一隔離變因）
// =============================================================================
{
  const goodArgs = () => ({
    flagOn: true,
    stopHookActive: false,
    state: makeState(),
    sessionId: 'sess-fixed-1',
    loopsAuto: false,
  });

  assert(
    shouldContinue({ ...goodArgs(), flagOn: false }).action === 'pass',
    'shouldContinue：flagOn=false → pass（flag 關防呆）[B1]',
  );
  assert(
    shouldContinue({ ...goodArgs(), stopHookActive: true }).action === 'pass',
    'shouldContinue：stopHookActive=true → pass（防重入）[B2]',
  );
  assert(
    shouldContinue({ ...goodArgs(), state: null }).action === 'pass',
    'shouldContinue：state=null → pass（fail-open）[B3]',
  );
  assert(
    shouldContinue({ ...goodArgs(), state: 'not-an-object' }).action === 'pass',
    'shouldContinue：state 壞（非物件）→ pass（fail-open）[B3b]',
  );
  assert(
    shouldContinue({ ...goodArgs(), state: makeState({ stage: 'plan' }) }).action === 'pass',
    'shouldContinue：state.stage!==\'build\' → pass [B4]',
  );
  assert(
    shouldContinue({ ...goodArgs(), sessionId: 'other-session' }).action === 'pass',
    'shouldContinue：session 不符 → pass [B5]',
  );
  assert(
    shouldContinue({ ...goodArgs(), state: makeState({ awaitingApproval: true }) }).action === 'pass',
    'shouldContinue：awaitingApproval=true → pass [B6]',
  );
  assert(
    shouldContinue({
      ...goodArgs(),
      state: makeState({ progressionMode: 'closed' }),
      loopsAuto: false,
    }).action === 'pass',
    'shouldContinue：progressionMode=closed 且無 LOOPS_AUTO → pass [B7]',
  );
  assert(
    shouldContinue({
      ...goodArgs(),
      state: makeState({ progressionMode: 'closed' }),
      loopsAuto: true,
    }).action === 'block',
    'shouldContinue：progressionMode=closed 但 LOOPS_AUTO 開 → block（覆蓋語意）[B8]',
  );
  assert(
    shouldContinue({
      ...goodArgs(),
      state: makeState({ iteration: 10, maxIterations: 10 }),
    }).action === 'pass',
    'shouldContinue：iteration>=maxIterations → pass（保險絲）[B9]',
  );
  assert(
    shouldContinue({
      ...goodArgs(),
      state: makeState({ tasks: [makeTask({ status: 'done' })] }),
    }).action === 'complete',
    'shouldContinue：全 tasks done（cursor=-1）→ complete [B10]',
  );
  assert(
    shouldContinue(goodArgs()).action === 'block',
    'shouldContinue：正常續跑（有未完成 task、其餘條件皆通過）→ block [B11]',
  );
}

// =============================================================================
// C) judgeLedger — 純函式（至少 6 組：已跑紅 / test not-run+lint 綠 / 全 not-run / 全綠 / tasks 未全 done / errored）
// =============================================================================
{
  const allDoneTasks = [makeTask({ status: 'done' })];
  const pendingTasks = [makeTask({ status: 'pending' })];

  const gateAllPassed = { ok: true, status: 'passed', gates: { test: 'passed', lint: 'passed', type: 'passed' } };
  const gateLintFailed = { ok: false, status: 'failed', gates: { test: 'not-run', lint: 'failed', type: 'not-run' } };
  const gateTypeErrored = { ok: false, status: 'failed', gates: { test: 'not-run', lint: 'not-run', type: 'errored' } };
  const gateTestNotRunLintGreen = { ok: true, status: 'partial', gates: { test: 'not-run', lint: 'passed', type: 'not-run' } };
  const gateAllNotRun = { ok: true, status: 'partial', gates: { test: 'not-run', lint: 'not-run', type: 'not-run' } };

  assert(
    judgeLedger(gateAllPassed, pendingTasks).verdict === 'block',
    'judgeLedger：tasks 有非 done（即便 gate 全綠）→ block（跳號假帳防呆）[C1]',
  );
  assert(
    judgeLedger(gateLintFailed, allDoneTasks).verdict === 'block',
    'judgeLedger：已跑 gate（lint）failed → block [C2]',
  );
  assert(
    judgeLedger(gateTypeErrored, allDoneTasks).verdict === 'block',
    'judgeLedger：已跑 gate（type）errored → block [C3]',
  );
  assert(
    judgeLedger(gateTestNotRunLintGreen, allDoneTasks).verdict === 'degraded',
    'judgeLedger：test gate not-run（即便 lint 綠）→ degraded（不得被 lint 綠燈頂替）[C4]',
  );
  assert(
    judgeLedger(gateAllNotRun, allDoneTasks).verdict === 'degraded',
    'judgeLedger：全 gate not-run → degraded [C5]',
  );
  assert(
    judgeLedger(gateAllPassed, allDoneTasks).verdict === 'pass',
    'judgeLedger：test 已跑 passed 且已跑者無紅、tasks 全 done → pass [C6]',
  );
}

// =============================================================================
// D) buildContinuationReason — 純函式（必含要素 + 10K cap）
// =============================================================================
{
  const task = makeTask({ id: 'T7', title: '實作比例規則', body: 'Body detail line.\nSecond line.' });
  const reason = buildContinuationReason(task, 0, 3, 1, 10);

  assert(typeof reason === 'string' && reason.length > 0, 'buildContinuationReason：回字串 [D1]');
  assert(reason.includes('T7'), 'buildContinuationReason：含 task id [D2]');
  assert(reason.includes('實作比例規則'), 'buildContinuationReason：含 task title [D3]');
  assert(reason.includes('Body detail line.'), 'buildContinuationReason：含 task body [D4]');
  assert(reason.includes('git status --porcelain'), 'buildContinuationReason：含半成品前置檢查指令 git status --porcelain [D5]');
  assert(/status/i.test(reason) && /done/i.test(reason), 'buildContinuationReason：含「status 改 done」推進契約字樣 [D6]');
  assert(reason.includes('awaitingApproval') && /true/.test(reason), 'buildContinuationReason：含「awaitingApproval 設 true」停下指令 [D7]');
  assert(reason.includes('02-plan'), 'buildContinuationReason：含「以 02-plan 為準、此為快照」註記 [D8]');

  // 10K cap：超長 body 必須被截斷（tail marker 消失、head 仍在）
  const longBody = 'B'.repeat(10000) + 'TAILMARKER_UNIQUE_NOT_TRUNCATED';
  const longTask = makeTask({ id: 'T9', title: 'Long body task', body: longBody });
  const longReason = buildContinuationReason(longTask, 0, 1, 1, 10);
  assert(
    typeof longReason === 'string' && longReason.includes('B'.repeat(3000)),
    'buildContinuationReason：超長 body 的 head 段仍在 reason 中 [D9]',
  );
  assert(
    typeof longReason === 'string' && !longReason.includes('TAILMARKER_UNIQUE_NOT_TRUNCATED'),
    'buildContinuationReason：超長 body 的 tail 被截斷（cap 10K，尾端 marker 消失）[D10]',
  );
}

// =============================================================================
// SMOKE — main()（真 spawn，真讀寫 state.json）
// =============================================================================

// ── M1：flag 未設/非 '1' → exit 0、stdout 無 block（即便 state 本可續跑）──────────
{
  const cwd = mkFixtureCwd('ld-flagoff-');
  try {
    writeLoopState(cwd, makeState());
    const res = runHook({ cwd, session_id: 'sess-fixed-1' }); // 未設 LOOPS_LOOP_DRIVER
    assert(res.error == null, 'M1：spawn 無 error [M1]');
    assert(res.status === 0, 'M1：flag 未設 → exit 0 [M1]');
    assert(decisionOf(res) !== 'block', 'M1：flag 未設 → stdout 無 block [M1]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── M2：flag='1' 但 stop_hook_active===true → exit 0 無 block（防重入）──────────
{
  const cwd = mkFixtureCwd('ld-reentry-');
  try {
    writeLoopState(cwd, makeState());
    const res = runHook(
      { cwd, session_id: 'sess-fixed-1', stop_hook_active: true },
      { LOOPS_LOOP_DRIVER: '1' },
    );
    assert(res.status === 0, 'M2：exit 0 [M2]');
    assert(decisionOf(res) !== 'block', 'M2：stop_hook_active=true → 無 block（防重入）[M2]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── M3：flag='1'、無 state 檔 → exit 0 無 block ─────────────────────────────
{
  const cwd = mkFixtureCwd('ld-nostate-');
  try {
    const res = runHook({ cwd, session_id: 'sess-fixed-1' }, { LOOPS_LOOP_DRIVER: '1' });
    assert(res.status === 0, 'M3：exit 0 [M3]');
    assert(decisionOf(res) !== 'block', 'M3：無 state 檔 → 無 block [M3]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── M4：state.stage!=='build' → exit 0 無 block ─────────────────────────────
{
  const cwd = mkFixtureCwd('ld-stage-');
  try {
    writeLoopState(cwd, makeState({ stage: 'plan' }));
    const res = runHook({ cwd, session_id: 'sess-fixed-1' }, { LOOPS_LOOP_DRIVER: '1' });
    assert(res.status === 0, 'M4：exit 0 [M4]');
    assert(decisionOf(res) !== 'block', 'M4：stage!=="build" → 無 block [M4]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── M5：state.session ≠ payload.session_id → exit 0 無 block ────────────────
{
  const cwd = mkFixtureCwd('ld-sessmismatch-');
  try {
    writeLoopState(cwd, makeState({ session: 'sess-fixed-1' }));
    const res = runHook({ cwd, session_id: 'sess-DIFFERENT' }, { LOOPS_LOOP_DRIVER: '1' });
    assert(res.status === 0, 'M5：exit 0 [M5]');
    assert(decisionOf(res) !== 'block', 'M5：session 不符 → 無 block [M5]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── M6：壞 JSON state → exit 0 無 block（fail-open）───────────────────────
{
  const cwd = mkFixtureCwd('ld-badjson-');
  try {
    writeLoopState(cwd, '{ this is not : valid json');
    const res = runHook({ cwd, session_id: 'sess-fixed-1' }, { LOOPS_LOOP_DRIVER: '1' });
    assert(res.status === 0, 'M6：exit 0 [M6]');
    assert(decisionOf(res) !== 'block', 'M6：壞 JSON state → 無 block（fail-open）[M6]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── M7：awaitingApproval:true → exit 0 無 block ─────────────────────────────
{
  const cwd = mkFixtureCwd('ld-awaiting-');
  try {
    writeLoopState(cwd, makeState({ awaitingApproval: true }));
    const res = runHook({ cwd, session_id: 'sess-fixed-1' }, { LOOPS_LOOP_DRIVER: '1' });
    assert(res.status === 0, 'M7：exit 0 [M7]');
    assert(decisionOf(res) !== 'block', 'M7：awaitingApproval=true → 無 block [M7]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── M8：progressionMode='closed' 且 env 無 LOOPS_AUTO → exit 0 無 block ──────
{
  const cwd = mkFixtureCwd('ld-closed-noauto-');
  try {
    writeLoopState(cwd, makeState({ progressionMode: 'closed' }));
    const res = runHook({ cwd, session_id: 'sess-fixed-1' }, { LOOPS_LOOP_DRIVER: '1' }); // 未設 LOOPS_AUTO
    assert(res.status === 0, 'M8：exit 0 [M8]');
    assert(decisionOf(res) !== 'block', 'M8：closed 模式 + 無 LOOPS_AUTO → 無 block [M8]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── M9：progressionMode='closed' 且 env LOOPS_AUTO='1' → block（覆蓋語意）───
{
  const cwd = mkFixtureCwd('ld-closed-auto-');
  try {
    writeLoopState(cwd, makeState({ progressionMode: 'closed' }));
    const res = runHook(
      { cwd, session_id: 'sess-fixed-1' },
      { LOOPS_LOOP_DRIVER: '1', LOOPS_AUTO: '1' },
    );
    assert(res.status === 0, 'M9：exit 0（Stop hook 以 stdout JSON 傳達 block，非 process exit code）[M9]');
    assert(decisionOf(res) === 'block', 'M9：closed 模式 + LOOPS_AUTO=1 → block（覆蓋語意）[M9]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── M10：iteration>=maxIterations → exit 0 無 block（保險絲）＋ 再跑一次仍 exit 0（冪等）──
{
  const cwd = mkFixtureCwd('ld-fuse-');
  try {
    writeLoopState(cwd, makeState({ iteration: 10, maxIterations: 10 }));
    const res1 = runHook({ cwd, session_id: 'sess-fixed-1' }, { LOOPS_LOOP_DRIVER: '1' });
    assert(res1.status === 0, 'M10：第一次 exit 0 [M10]');
    assert(decisionOf(res1) !== 'block', 'M10：iteration>=maxIterations → 無 block（保險絲）[M10]');
    const res2 = runHook({ cwd, session_id: 'sess-fixed-1' }, { LOOPS_LOOP_DRIVER: '1' });
    assert(res2.status === 0, 'M10：第二次連跑仍 exit 0（冪等放行）[M10]');
    assert(decisionOf(res2) !== 'block', 'M10：第二次連跑仍無 block（冪等放行）[M10]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── M11：正常續跑（auto、cursor=0、iteration<max）→ block + reason 含要素 + state.iteration+1、updatedAt 更新 ──
{
  const cwd = mkFixtureCwd('ld-continue-');
  try {
    const before = makeState({
      tasks: [makeTask({ id: 'T1', title: 'Implement ratio rule', status: 'pending' })],
      iteration: 3,
      maxIterations: 10,
      updatedAt: '2020-01-01T00:00:00.000Z',
    });
    const sf = writeLoopState(cwd, before);
    const res = runHook({ cwd, session_id: 'sess-fixed-1' }, { LOOPS_LOOP_DRIVER: '1' });
    assert(res.status === 0, 'M11：exit 0（block 走 stdout JSON，非 process exit code）[M11]');
    assert(decisionOf(res) === 'block', 'M11：正常續跑 → decision===block [M11]');
    const reason = reasonOf(res);
    assert(typeof reason === 'string' && reason.includes('Implement ratio rule'),
      'M11：reason 含當前任務標題 [M11]');
    assert(typeof reason === 'string' && reason.includes('git status --porcelain'),
      'M11：reason 含 git status --porcelain 半成品前置檢查指令 [M11]');

    const after = JSON.parse(readFileSync(sf, 'utf8'));
    assert(after.iteration === before.iteration + 1, 'M11：state.json 的 iteration 確實 +1（重讀檔斷言）[M11]');
    assert(after.updatedAt !== before.updatedAt, 'M11：state.json 的 updatedAt 已更新 [M11]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── M12：完工紅（全 done + gate-red fixture）→ block + reason 含失敗訊息 + iteration+1（重讀）──
{
  const cwd = cloneFixtureCwd(GATE_RED, 'ld-done-red-');
  try {
    const before = makeState({
      tasks: [makeTask({ status: 'done' })],
      iteration: 0,
      maxIterations: 10,
    });
    const sf = writeLoopState(cwd, before);
    const res = runHook({ cwd, session_id: 'sess-fixed-1' }, { LOOPS_LOOP_DRIVER: '1' });
    assert(res.status === 0, 'M12：exit 0（block 走 stdout JSON）[M12]');
    assert(decisionOf(res) === 'block', 'M12：全 done + gate 紅 → decision===block [M12]');
    const reason = reasonOf(res);
    assert(typeof reason === 'string' && (reason.includes('TS1') || /error/i.test(reason)),
      'M12：reason 含 quality-gate 失敗訊息 [M12]');
    assert(existsSync(sf), 'M12：完工紅不收攤，state.json 仍在（供重讀 iteration）[M12]');
    const after = JSON.parse(readFileSync(sf, 'utf8'));
    assert(after.iteration === before.iteration + 1, 'M12：state.json 的 iteration 確實 +1（重讀斷言）[M12]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── M13：完工綠（全 done + gate-green fixture）→ exit 0 無 block + state.json 已刪除（收攤）──
{
  const cwd = cloneFixtureCwd(GATE_GREEN, 'ld-done-green-');
  try {
    const sf = writeLoopState(cwd, makeState({ tasks: [makeTask({ status: 'done' })] }));
    const res = runHook({ cwd, session_id: 'sess-fixed-1' }, { LOOPS_LOOP_DRIVER: '1' });
    assert(res.status === 0, 'M13：exit 0 [M13]');
    assert(decisionOf(res) !== 'block', 'M13：全 done + gate 綠 → 無 block [M13]');
    assert(existsSync(sf) === false, 'M13：完工收攤 → state.json 已被刪除 [M13]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── M14：完工但 test gate not-run（只配 lint 綠、無 test）→ 降級放行 + 弱帳本標記 + state.json 已刪除 ──
{
  const cwd = cloneFixtureCwd(GATE_LINT_ONLY_GREEN, 'ld-done-degraded-');
  try {
    const sf = writeLoopState(cwd, makeState({ tasks: [makeTask({ status: 'done' })] }));
    const res = runHook({ cwd, session_id: 'sess-fixed-1' }, { LOOPS_LOOP_DRIVER: '1' });
    assert(res.status === 0, 'M14：exit 0 [M14]');
    assert(decisionOf(res) !== 'block',
      'M14：test gate not-run → 降級仍放行（不 block，未因 lint 綠而被當成強帳本擋下）[M14]');
    const full = `${res.stdout || ''}\n${res.stderr || ''}`;
    assert(full.includes('弱帳本'),
      'M14：test gate not-run → 明標「弱帳本」標記（不得被 lint 綠燈靜默頂替）[M14]');
    assert(existsSync(sf) === false, 'M14：降級仍完工收攤 → state.json 已被刪除 [M14]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── M15：status 跳號假帳（[done, pending, done]，cursor 指中間）→ block 續跑指回 index 1 任務 ──
{
  const cwd = mkFixtureCwd('ld-skewed-');
  try {
    const before = makeState({
      tasks: [
        makeTask({ id: 'T1', title: 'Task One', status: 'done' }),
        makeTask({ id: 'T2', title: 'Task Two', status: 'pending' }),
        makeTask({ id: 'T3', title: 'Task Three', status: 'done' }),
      ],
    });
    writeLoopState(cwd, before);
    const res = runHook({ cwd, session_id: 'sess-fixed-1' }, { LOOPS_LOOP_DRIVER: '1' });
    assert(res.status === 0, 'M15：exit 0 [M15]');
    assert(decisionOf(res) === 'block', 'M15：跳號假帳 → 仍 block 續跑（指回未完成任務）[M15]');
    const reason = reasonOf(res);
    assert(typeof reason === 'string' && reason.includes('Task Two'),
      'M15：reason 含中間未完成任務（T2）標題，不誤判成已完工 [M15]');
    assert(typeof reason === 'string' && !reason.includes('Task Three'),
      'M15：reason 不指向 cursor 之後的 Task Three（精準指回 index 1）[M15]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── M16（EPIPE-guard）：flag 未設 + 256KB padding payload → 先讀滿 stdin，無 EPIPE、exit 0 ──
{
  const big = JSON.stringify({
    session_id: 'epipe-loop-driver',
    padding: 'A'.repeat(256 * 1024),
  });
  const res = spawnSync(process.execPath, [SCRIPT], {
    input: big,
    env: (() => {
      const env = { ...process.env };
      delete env.LOOPS_LOOP_DRIVER;
      delete env.LOOPS_AUTO;
      return env;
    })(),
    encoding: 'utf8',
  });
  assert(res.error == null, 'M16：flag 未設 + 256KB payload → 無 spawn error（stdin 已讀滿、無 EPIPE/EOF）[M16]');
  assert(res.status === 0, 'M16：exit 0 [M16]');
}

// ── 摘要 + exit code ─────────────────────────────────────────────────────────
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
