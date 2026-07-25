#!/usr/bin/env node
// test-stop-concurrency.mjs —— #183 T14/T15 紅綠斷言：Stop 家族覆寫型寫檔的 tmp+rename 原子化
// （atomic-write.mjs）＋ Windows rename 失敗時清殘檔、清理失敗不冒泡。自帶極簡 harness（仿同目錄
// test-stop-gate.mjs），不引測試框架。
//
// 用法（cwd = plugins/loops-workflow）：node hooks/test-stop-concurrency.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1。
//
// 三段涵蓋範圍（對應任務描述 1/2/3）：
//   C1 併發寫入不產生半截檔——① atomic-write.mjs 的 writeFileAtomic 原語本身：多個真子行程同時對
//      同一路徑呼叫，讀回永遠是完整一份、不是截斷/混雜。② edit-accumulator.mjs 的 writeEditsState：
//      stop-gate 與 eval-gate 在 Stop 時會對同一 session 併發呼叫 clearEditsState（同一份 state
//      檔），用真子行程重現這個實際場景。
//   C2 rename 失敗會清 tmp——把目標路徑預先建成一個目錄（Windows 上 renameSync 覆蓋既存目錄必失敗），
//      驗證失敗後目錄裡不殘留任何 `.*.tmp` 檔。
//   C3 清理失敗不影響決策——① 單元層：用 writeFileAtomic 的 deps 注入點同時模擬 rename 與 unlink
//      皆失敗，驗證拋出的仍是原始 rename 錯誤（不被 cleanup 錯誤蓋掉、不多拋東西）。② hook 層：真跑
//      stop-gate.mjs，把發現性提示 state 檔路徑預先建成目錄逼真實 rename 失敗，驗證 hook 仍照既有
//      fail-open 契約 exit 0（不因寫檔失敗而崩潰或改變 exit code）。

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

import { writeFileAtomic } from './atomic-write.mjs';
import { editsStateFile, writeEditsState } from './edit-accumulator.mjs';
import {
  buildSandbox,
  cleanupSandbox,
  runCase,
  stopGateHintStateFilePath,
} from './fixtures/characterization/shared.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 子行程 dynamic import 需要 file:// URL（Windows 上絕對路徑不是合法 ESM specifier scheme）。
const ATOMIC_WRITE_ABS = pathToFileURL(join(HERE, 'atomic-write.mjs')).href;
const EDIT_ACCUMULATOR_ABS = pathToFileURL(join(HERE, 'edit-accumulator.mjs')).href;
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

let seq = 0;
function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), `loops-t14-${prefix}-`));
}
function freshSession(prefix) {
  return `${prefix}-${process.pid}-${Date.now()}-${++seq}`;
}

/** 以子行程 dynamic import atomic-write.mjs 並呼叫 writeFileAtomic——用真行程而非同行程 async 交錯，貼近真實併發。 */
function spawnAtomicWriter(targetPath, content) {
  const script =
    `import('${ATOMIC_WRITE_ABS}').then(m => ` +
    `m.writeFileAtomic(${JSON.stringify(targetPath)}, ${JSON.stringify(content)}));`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
    child.on('exit', (code) => resolve(code));
  });
}

/** 以子行程呼叫 edit-accumulator.mjs 的 writeEditsState(sessionId, paths)——重現 stop-gate/eval-gate 併發清 state 的真實場景。 */
function spawnWriteEditsState(sessionId, paths) {
  const script =
    `import('${EDIT_ACCUMULATOR_ABS}').then(m => ` +
    `m.writeEditsState(${JSON.stringify(sessionId)}, ${JSON.stringify(paths)}));`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
    child.on('exit', (code) => resolve(code));
  });
}

// ── C1a：writeFileAtomic 原語——N 個真子行程同時整檔覆寫同一路徑，讀回必為完整一份 ──────────────
async function testC1aPrimitiveConcurrency() {
  const dir = freshDir('c1a');
  const target = join(dir, 'shared.json');
  try {
    const N = 8;
    const contents = Array.from({ length: N }, (_, i) =>
      JSON.stringify({ writer: i, filler: 'x'.repeat(20000), tail: `END-${i}` }));
    const codes = await Promise.all(contents.map((c) => spawnAtomicWriter(target, c)));
    assert(codes.every((c) => c === 0), 'C1a：8 個併發 writer 子行程皆正常結束（exit 0）[C1]');

    const raw = readFileSync(target, 'utf8');
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* 留 null，下面斷言會抓到 */ }
    assert(parsed !== null, 'C1a：併發寫入後讀回的檔案仍是合法完整 JSON（未被截斷成半截檔）[C1]');
    assert(
      parsed !== null && typeof parsed.writer === 'number' && raw.endsWith(`END-${parsed.writer}"}`),
      'C1a：讀回內容首尾一致、對應同一個 writer（不是兩個 writer 內容被交錯拼接）[C1]',
    );

    // .tmp 殘檔：8 個 writer 全部跑完後，目錄裡不該留下任何一個 tmp 檔（成功路徑 rename 會清掉 tmp 這個名字本身）。
    const leftoverTmp = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    assert(leftoverTmp.length === 0, `C1a：成功路徑跑完後目錄無 .tmp 殘檔（實得 ${leftoverTmp.length} 個）[C1]`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── C1b：真實場景重現——stop-gate 與 eval-gate 在 Stop 時對同一 session 併發呼叫 writeEditsState/
//    clearEditsState（同一份 loops-edits-<session>.json），讀回必為完整一份，不半截 ──────────────
async function testC1bEditAccumulatorConcurrency() {
  const sessionId = freshSession('c1b');
  const stateFile = editsStateFile(sessionId);
  try {
    const N = 6;
    const paths = Array.from({ length: N }, (_, i) =>
      Array.from({ length: 500 }, (_, j) => `src/file-${i}-${j}.ts`)); // 夠大，若半截寫會產生壞 JSON
    const codes = await Promise.all(paths.map((p) => spawnWriteEditsState(sessionId, p)));
    assert(codes.every((c) => c === 0), 'C1b：6 個併發 writeEditsState 子行程皆正常結束（exit 0）[C1]');

    const raw = readFileSync(stateFile, 'utf8');
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* 留 null */ }
    assert(parsed !== null && Array.isArray(parsed.paths), 'C1b：併發 clearEditsState 場景讀回仍是合法 { ts, paths } 結構（不是半截 JSON）[C1]');
    assert(
      parsed !== null && parsed.paths.length === 500 &&
        paths.some((p) => JSON.stringify(p) === JSON.stringify(parsed.paths)),
      'C1b：paths 陣列完整對應某一個 writer 的內容，不是兩個 writer 交錯拼接的殘片 [C1]',
    );
  } finally {
    rmSync(stateFile, { force: true });
  }
}

// ── C2：renameSync 失敗（目標路徑預先建成目錄）→ 清掉已寫出的 .tmp，不留殘檔 ──────────────────
function testC2CleansTmpOnRenameFailure() {
  const dir = freshDir('c2');
  const target = join(dir, 'target-is-dir');
  mkdirSync(target); // 目標路徑本身是一個既存目錄——renameSync(tmp, target) 在 Windows 上必失敗
  try {
    let threw = null;
    try {
      writeFileAtomic(target, JSON.stringify({ hello: 'world' }));
    } catch (err) {
      threw = err;
    }
    assert(threw != null, 'C2：目標為既存目錄時 renameSync 確實失敗、writeFileAtomic 往上拋出 [C2]');

    const remaining = readdirSync(dir);
    const leftoverTmp = remaining.filter((f) => f.endsWith('.tmp'));
    assert(leftoverTmp.length === 0, `C2：rename 失敗後目錄裡不殘留 .tmp（實得 ${JSON.stringify(remaining)}）[C2]`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── C3a：單元層——rename 與 cleanup(unlink) 同時失敗，仍拋出「原始 rename 錯誤」，不被 cleanup
//    錯誤蓋掉、也不會多拋出東西（T15 的「清理失敗不得冒泡」核心契約）────────────────────────────
function testC3aCleanupFailureDoesNotMaskOriginalError() {
  const dir = freshDir('c3a');
  const target = join(dir, 'target.json');
  try {
    let threw = null;
    try {
      writeFileAtomic(target, JSON.stringify({ a: 1 }), 'utf8', {
        rename: () => { throw new Error('rename-boom'); },
        unlink: () => { throw new Error('cleanup-boom'); }, // cleanup 本身也失敗
      });
    } catch (err) {
      threw = err;
    }
    assert(threw?.message === 'rename-boom',
      `C3a：rename 與 cleanup 皆失敗時，拋出的仍是原始 rename 錯誤而非 cleanup 錯誤（實得 "${threw?.message}"）[C3]`);
  } finally {
    // deps 皆是假函式、未真的呼叫 unlink，tmp 檔仍留在磁碟上——測試自行收拾，不留垃圾。
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── C3b：hook 層——stop-gate.mjs 的發現性提示 state 檔路徑預先建成目錄，逼真實 rename 失敗；
//    驗證 hook 仍照既有 fail-open 契約 exit 0，不因寫檔失敗（含其後的清理嘗試）而改變決策輸出 ────
function testC3bHookDecisionUnaffectedByWriteFailure() {
  const { root, roles } = buildSandbox();
  const sessionNormal = freshSession('c3b-normal');
  const sessionCollide = freshSession('c3b-collide');
  const hintPathCollide = stopGateHintStateFilePath(sessionCollide);
  try {
    // 基線：正常情境（flag 關 + cwd 有 gate.config.json + 本 session 未提示過）→ exit 0 + 有提示。
    const normal = runCase(STOP_GATE_SCRIPT, {
      payload: { session_id: sessionNormal, cwd: roles.SG_HINT_ROOT },
      env: {},
      sandboxRoot: root,
    });
    assert(normal.error == null && normal.status === 0, 'C3b：基線（無寫檔衝突）hook exit 0 [C3]');
    assert((normal.stdout || '').includes('LOOPS_STOP_GATE=1'), 'C3b：基線 hook 正常印出發現性提示 [C3]');

    // 衝突情境：把本 session 的提示 state 檔路徑預先建成目錄 → writeFileAtomic 內部 renameSync 必失敗
    // （cleanup 嘗試 unlink 一個目錄同樣會失敗，兩者皆真實失敗，貼近 T15 情境）。
    mkdirSync(hintPathCollide, { recursive: true });
    const collide = runCase(STOP_GATE_SCRIPT, {
      payload: { session_id: sessionCollide, cwd: roles.SG_HINT_ROOT },
      env: {},
      sandboxRoot: root,
    });
    assert(collide.error == null && collide.status === 0,
      'C3b：state 檔路徑衝突（真實 rename+cleanup 皆失敗）時 hook 仍 exit 0——不因寫檔失敗崩潰或改變 exit code [C3]');
  } finally {
    rmSync(hintPathCollide, { recursive: true, force: true });
    cleanupSandbox(root);
  }
}

// ── 執行 ──────────────────────────────────────────────────────────────────────
await testC1aPrimitiveConcurrency();
await testC1bEditAccumulatorConcurrency();
testC2CleansTmpOnRenameFailure();
testC3aCleanupFailureDoesNotMaskOriginalError();
testC3bHookDecisionUnaffectedByWriteFailure();

console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
