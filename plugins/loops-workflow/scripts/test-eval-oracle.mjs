#!/usr/bin/env node
// test-eval-oracle.mjs —— eval-oracle.mjs 的紅綠斷言（自帶極簡 harness，不引測試框架）。
// 用法：node test-eval-oracle.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1（主線用此 exit code 判紅綠）。
//
// 預期 Red：eval-oracle.mjs 尚未實作，下面的 import 會 ERR_MODULE_NOT_FOUND，
// 整個檔在載入期就丟例外 → node 以非 0 退出。這就是 TDD 的紅燈起點。
// e2e smoke 另需 scripts/fixtures/eval-oracle/ 下的 3 個 task fixtures（由 impl-author 建）。

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { scoreTask, loadTasks, buildReport } from './eval-oracle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../scripts
const ROOT = dirname(HERE); // plugin root（契約：e2e 的 cwd）

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

// ── helpers ───────────────────────────────────────────────────────────────────
// 一筆 test 類 failure：契約規定 message 第一行＝titlePath，第二行起是細節。
function testFail(titlePath, detail = 'AssertionError: boom') {
  return { kind: 'test', severity: 'error', file: 'src/x.test.ts', line: 1, message: `${titlePath}\n${detail}` };
}
// 組一個 GateResult（scoreTask 只看 gates.test 與 failures，其餘欄位填合理值即可）。
function gate({ test = 'passed', failures = [] } = {}) {
  return {
    ok: failures.length === 0,
    status: test,
    counts: { test: failures.filter((f) => f.kind === 'test').length, lint: 0, type: 0, total: failures.length },
    gates: { test, lint: 'passed', type: 'passed' },
    failures,
    truncated: false,
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  scoreTask —— 不變量斷言
// ════════════════════════════════════════════════════════════════════════════

// ── S-green：全綠（gates.test=passed、無 test 類 failure）→ pass=true、missing 皆空 [契約(a)]
{
  const oracle = { failToPass: ['add returns sum', 'mul works'], passToPass: ['sub works'] };
  const r = scoreTask(gate({ test: 'passed', failures: [] }), oracle);
  assert(r.pass === true, 'scoreTask：全綠 → pass=true [S-green/(a)]');
  assert(r.errored === false, 'scoreTask：全綠 → errored=false [S-green/(a)]');
  assert(Array.isArray(r.failToPass.missing) && r.failToPass.missing.length === 0, 'scoreTask：全綠 → failToPass.missing 空 [S-green/(a)]');
  assert(Array.isArray(r.passToPass.missing) && r.passToPass.missing.length === 0, 'scoreTask：全綠 → passToPass.missing 空 [S-green/(a)]');
  assert(
    r.failToPass.passed.includes('add returns sum') && r.failToPass.passed.includes('mul works'),
    'scoreTask：全綠 → failToPass.passed 含全部 required [S-green/(a)]',
  );
  assert(
    Array.isArray(r.failToPass.required) && r.failToPass.required.length === 2,
    'scoreTask：failToPass.required＝oracle 的 failToPass 清單 [S-green/(a)]',
  );
  assert(r.gateStatus === 'passed', 'scoreTask：gateStatus＝gates.test [S-green/(a)]');
  assert(typeof r.reason === 'string', 'scoreTask：reason 是字串 [S-green/(a)]');
}

// ── S-kindfilter：非 test 類 failure（lint）即使 message 撞到 test 名也不可影響判定 [契約：名 pass＝沒有 kind==='test' 命中]
{
  // gates.test=passed，但 failures 裡有一筆 lint，其 message 第一行剛好＝某 test 的 titlePath。
  const lintFail = { kind: 'lint', severity: 'error', file: 'a.ts', line: 1, ruleId: 'x', message: 'math > add returns sum\nlint noise' };
  const r = scoreTask(gate({ test: 'passed', failures: [lintFail] }), { failToPass: ['add returns sum'], passToPass: [] });
  assert(r.failToPass.missing.length === 0, 'scoreTask：lint failure 撞名不算 test 失敗 → missing 空 [S-kindfilter]');
  assert(r.pass === true, 'scoreTask：只有 lint failure → 該 test 仍 pass=true [S-kindfilter]');
}

// ── S-failtopass：failToPass 未達成（test failure 命中該名）→ pass=false、該名入 missing [契約(b)]
{
  const oracle = { failToPass: ['add returns sum', 'mul works'], passToPass: [] };
  const r = scoreTask(gate({ test: 'failed', failures: [testFail('math > add returns sum')] }), oracle);
  assert(r.pass === false, 'scoreTask：failToPass 有 test 仍紅 → pass=false [S-failtopass/(b)]');
  assert(r.failToPass.missing.includes('add returns sum'), 'scoreTask：命中的 failToPass 名進 missing [S-failtopass/(b)]');
  assert(r.failToPass.passed.includes('mul works'), 'scoreTask：沒被命中的 failToPass 名進 passed [S-failtopass/(b)]');
}

// ── S-passtopass：passToPass 回歸（test failure 命中該名）→ pass=false、該名入 passToPass.missing [契約(c)]
{
  const oracle = { failToPass: ['add returns sum'], passToPass: ['sub works'] };
  const r = scoreTask(gate({ test: 'failed', failures: [testFail('math > sub works')] }), oracle);
  assert(r.pass === false, 'scoreTask：passToPass 轉紅 → pass=false [S-passtopass/(c)]');
  assert(r.passToPass.missing.includes('sub works'), 'scoreTask：回歸的 passToPass 名進 missing [S-passtopass/(c)]');
  assert(r.failToPass.missing.length === 0, 'scoreTask：未被命中的 failToPass 名不受影響 → missing 空 [S-passtopass/(c)]');
}

// ── S-leaf：oracle 只寫 leaf title，failure titlePath 帶祖先 → 以 " > <名>" 結尾視為命中 [契約(d)]
{
  const r = scoreTask(gate({ test: 'failed', failures: [testFail('math > add returns sum')] }), { failToPass: ['add returns sum'], passToPass: [] });
  assert(r.failToPass.missing.includes('add returns sum'), 'scoreTask：leaf 名以 " > 名" 結尾命中 → 進 missing [S-leaf/(d)]');
  assert(r.pass === false, 'scoreTask：leaf 命中 → pass=false [S-leaf/(d)]');
}

// ── S-exact：titlePath 與 oracle 名完全相等（無祖先）→ 命中 [契約：命中＝完全相等]
{
  const r = scoreTask(gate({ test: 'failed', failures: [testFail('add returns sum')] }), { failToPass: ['add returns sum'], passToPass: [] });
  assert(r.failToPass.missing.includes('add returns sum'), 'scoreTask：titlePath 完全相等 → 命中進 missing [S-exact]');
}

// ── S-boundary：邊界 Prove-It —— "checksum" 不可被 "sum" 命中（須卡 " > " 界線，非 endsWith 子字串）
{
  // 'math > checksum' 結尾是 ' > checksum'，不是 ' > sum'；naive endsWith('sum') 會誤判 → 這條會抓出來。
  const r = scoreTask(gate({ test: 'failed', failures: [testFail('math > checksum')] }), { failToPass: ['sum'], passToPass: [] });
  assert(r.failToPass.missing.length === 0, 'scoreTask：" > checksum" 不可被 "sum" 命中 → missing 空 [S-boundary]');
  assert(r.failToPass.passed.includes('sum'), 'scoreTask："sum" 未被命中 → 進 passed [S-boundary]');
}

// ── S-firstline：只有 message 第一行算 titlePath；第二行提到的名不算命中 [契約：第一行＝titlePath]
{
  // line1='math > unrelated regression'（不命中）；line2 文字含 'add returns sum'（須被忽略）。
  const f = testFail('math > unrelated regression', 'expected add returns sum to equal 3');
  const r = scoreTask(gate({ test: 'failed', failures: [f] }), { failToPass: ['add returns sum'], passToPass: [] });
  assert(r.failToPass.missing.length === 0, 'scoreTask：只看第一行 titlePath，第二行撞名不算命中 → missing 空 [S-firstline]');
  // 此例 gate 雖整體 failed，但該 task 的 failToPass 全 pass、無 passToPass → pass 解耦於整體 gate 狀態。
  assert(r.pass === true, 'scoreTask：整體 gate failed 但本 task 指定測全 pass → pass=true [S-firstline]');
}

// ── S-notrun：gate not-run → errored:true、pass:false（永不誤判為 pass，即使無命中）[契約(e)]
{
  const notRun = { ...gate({ test: 'passed', failures: [] }), gates: { test: 'not-run', lint: 'passed', type: 'passed' } };
  const r = scoreTask(notRun, { failToPass: ['add returns sum'], passToPass: [] });
  assert(r.errored === true, 'scoreTask：gate not-run → errored=true [S-notrun/(e)]');
  assert(r.pass === false, 'scoreTask：gate not-run → pass=false（無法判，不可報綠）[S-notrun/(e)]');
  assert(r.gateStatus === 'not-run', 'scoreTask：gateStatus 透傳 gates.test="not-run" [S-notrun/(e)]');
}

// ── S-errored：gate errored → errored:true、pass:false [契約(f)]
{
  const errored = { ...gate({ test: 'passed', failures: [] }), gates: { test: 'errored', lint: 'passed', type: 'passed' } };
  const r = scoreTask(errored, { failToPass: ['add returns sum'], passToPass: [] });
  assert(r.errored === true, 'scoreTask：gate errored → errored=true [S-errored/(f)]');
  assert(r.pass === false, 'scoreTask：gate errored → pass=false [S-errored/(f)]');
  assert(r.gateStatus === 'errored', 'scoreTask：gateStatus 透傳 gates.test="errored" [S-errored/(f)]');
}

// ── S-missing：gates.test 缺值（gate 物件無 test 鍵）→ errored:true、pass:false [契約：缺→errored]
{
  const r = scoreTask({ gates: {}, failures: [] }, { failToPass: ['add returns sum'], passToPass: [] });
  assert(r.errored === true, 'scoreTask：gates.test 缺 → errored=true [S-missing]');
  assert(r.pass === false, 'scoreTask：gates.test 缺 → pass=false [S-missing]');
}

// ════════════════════════════════════════════════════════════════════════════
//  loadTasks —— 讀 dir 下所有 *.json（非 .json 忽略；malformed 應 throw 帶檔名）
// ════════════════════════════════════════════════════════════════════════════

// ── L-ok：2 個合法 task json + 1 個非 .json → 回 2 筆，內容 round-trip [契約 loadTasks]
{
  const dir = mkdtempSync(join(tmpdir(), 'eo-tasks-'));
  try {
    writeFileSync(join(dir, 'et-1.json'), JSON.stringify({ id: 'et-1', failToPass: ['a'], passToPass: [] }), 'utf8');
    writeFileSync(join(dir, 'et-2.json'), JSON.stringify({ id: 'et-2', failToPass: [], passToPass: ['b'] }), 'utf8');
    writeFileSync(join(dir, 'notes.txt'), 'ignore me — not a task', 'utf8');
    const tasks = loadTasks(dir);
    assert(Array.isArray(tasks) && tasks.length === 2, 'loadTasks：2 json + 1 非json → 回 2 筆（.txt 忽略）[L-ok]');
    const ids = tasks.map((t) => t && t.id).sort();
    assert(ids[0] === 'et-1' && ids[1] === 'et-2', 'loadTasks：解析內容 round-trip（id 保留）[L-ok]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── L-malformed：壞掉的 .json → throw，且錯誤訊息帶該檔名 [契約 loadTasks]
{
  const dir = mkdtempSync(join(tmpdir(), 'eo-bad-'));
  try {
    writeFileSync(join(dir, 'good.json'), JSON.stringify({ id: 'g' }), 'utf8');
    writeFileSync(join(dir, 'broken.json'), '{ not valid json', 'utf8');
    let threw = false;
    let msg = '';
    try {
      loadTasks(dir);
    } catch (e) {
      threw = true;
      msg = String((e && e.message) || e);
    }
    assert(threw === true, 'loadTasks：遇 malformed JSON → throw [L-malformed]');
    assert(msg.includes('broken.json'), 'loadTasks：錯誤訊息帶問題檔名 broken.json [L-malformed]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  buildReport —— 聚合（passed=pass===true 的數；errored 算 failed/非 passed）
// ════════════════════════════════════════════════════════════════════════════

// ── B-agg：3 results（1 pass、1 fail、1 errored）→ total3/passed1/failed2 [契約 buildReport]
{
  const results = [
    { id: 'a', pass: true, errored: false, failToPass: { required: [], passed: [], missing: [] }, passToPass: { required: [], passed: [], missing: [] } },
    { id: 'b', pass: false, errored: false, failToPass: { required: ['x'], passed: [], missing: ['x'] }, passToPass: { required: [], passed: [], missing: [] } },
    { id: 'c', pass: false, errored: true, failToPass: { required: [], passed: [], missing: [] }, passToPass: { required: [], passed: [], missing: [] } },
  ];
  const rep = buildReport(results);
  assert(rep.total === 3, 'buildReport：total＝results 數＝3 [B-agg]');
  assert(rep.passed === 1, 'buildReport：passed＝pass===true 的數＝1 [B-agg]');
  assert(rep.failed === 2, 'buildReport：failed＝非 passed（含 errored）＝2 [B-agg]');
  assert(Array.isArray(rep.tasks) && rep.tasks.length === 3, 'buildReport：tasks 收齊 3 筆 [B-agg]');
}

// ════════════════════════════════════════════════════════════════════════════
//  e2e smoke —— spawn 真 runner 跑契約固定 fixtures（fixtures 未建好時會紅＝正常）
//  契約：scripts/fixtures/eval-oracle/ 下 et-pass(全綠→pass)、
//        et-failtopass(failToPass 仍紅→fail)、et-regression(passToPass 轉紅→fail)
// ════════════════════════════════════════════════════════════════════════════
function runOracle(extraArgs) {
  const res = spawnSync('node', ['scripts/eval-oracle.mjs', ...extraArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    json = null;
  }
  return { res, json };
}
// 在聚合 tasks 內以慣用 id 欄位定位某 task 結果（行為斷言仍嚴格，僅放寬「欄位叫什麼」）。
function findResult(tasks, name) {
  if (!Array.isArray(tasks)) return null;
  const hits = tasks.filter((t) => t && [t.id, t.name, t.task, t.taskId, t.title].includes(name));
  return hits.length === 1 ? hits[0] : null;
}

// ── E1：跑整個 corpus（3 task）→ aggregate total3/passed1/failed2、各 task 結果正確、exit 1 [契約 e2e]
{
  const { res, json } = runOracle(['--dir', 'scripts/fixtures/eval-oracle', '--json']);
  assert(res.error == null, 'E1：node 啟動成功（spawn 無 error）[E1]');
  assert(json && json.total === 3 && json.passed === 1 && json.failed === 2, 'E1：aggregate total3/passed1/failed2 [E1]');

  const etPass = json ? findResult(json.tasks, 'et-pass') : null;
  assert(etPass && etPass.pass === true, 'E1：et-pass 全綠 → pass=true [E1]');

  const etF2P = json ? findResult(json.tasks, 'et-failtopass') : null;
  assert(etF2P && etF2P.pass === false, 'E1：et-failtopass failToPass 仍紅 → pass=false [E1]');
  assert(etF2P && etF2P.failToPass && Array.isArray(etF2P.failToPass.missing) && etF2P.failToPass.missing.length > 0, 'E1：et-failtopass failToPass.missing 非空 [E1]');

  const etReg = json ? findResult(json.tasks, 'et-regression') : null;
  assert(etReg && etReg.pass === false, 'E1：et-regression passToPass 轉紅 → pass=false [E1]');
  assert(etReg && etReg.passToPass && Array.isArray(etReg.passToPass.missing) && etReg.passToPass.missing.length > 0, 'E1：et-regression passToPass.missing 非空 [E1]');

  assert(res.status === 1, 'E1：有 fail → 程序 exit code===1 [E1]');
}

// ── E2：只跑 et-pass（--task）→ 只該 task 入列、全綠、exit 0 [契約 e2e]
{
  const { res, json } = runOracle(['--dir', 'scripts/fixtures/eval-oracle', '--task', 'et-pass', '--json']);
  assert(res.error == null, 'E2：node 啟動成功 [E2]');
  assert(json && json.total === 1 && json.passed === 1 && json.failed === 0, 'E2：--task 過濾 → 只跑 et-pass、全綠 [E2]');
  assert(res.status === 0, 'E2：無 fail → 程序 exit code===0 [E2]');
}

// ── 摘要 + exit code ─────────────────────────────────────────────────────────
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
