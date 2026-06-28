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
// 組一個 GateResult。新契約：scoreTask 走 positive-presence，會同時看 gates.test、failures 與 passedTests。
// passedTests＝通過 assertion 的 titlePath 清單（quality-gate 加性輸出）；truncated 透傳「清單可能被截斷」旗標。
function gate({ test = 'passed', failures = [], passedTests = [], truncated = false } = {}) {
  return {
    ok: failures.length === 0,
    status: test,
    counts: { test: failures.filter((f) => f.kind === 'test').length, lint: 0, type: 0, total: failures.length },
    gates: { test, lint: 'passed', type: 'passed' },
    failures,
    passedTests,
    truncated,
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  scoreTask —— 不變量斷言
// ════════════════════════════════════════════════════════════════════════════

// ── S-green：全綠（gates.test=passed、required 名皆出現在 passedTests）→ pass=true、missing 皆空 [契約(a) + positive-presence]
{
  const oracle = { failToPass: ['add returns sum', 'mul works'], passToPass: ['sub works'] };
  // 新契約：pass 案例每個 required 名都要真的出現在 passedTests，否則 unobserved → errored。
  const r = scoreTask(
    gate({ test: 'passed', failures: [], passedTests: ['math > add returns sum', 'math > mul works', 'math > sub works'] }),
    oracle,
  );
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
  // gates.test=passed，名出現在 passedTests（觀察到通過），但 failures 裡有一筆 lint 其 message 第一行剛好＝該 titlePath。
  const lintFail = { kind: 'lint', severity: 'error', file: 'a.ts', line: 1, ruleId: 'x', message: 'math > add returns sum\nlint noise' };
  const r = scoreTask(
    gate({ test: 'passed', failures: [lintFail], passedTests: ['math > add returns sum'] }),
    { failToPass: ['add returns sum'], passToPass: [] },
  );
  assert(r.failToPass.missing.length === 0, 'scoreTask：lint failure 撞名不算 test 失敗 → missing 空 [S-kindfilter]');
  assert(r.pass === true, 'scoreTask：名在 passedTests、只有 lint failure 撞名 → 該 test 仍 pass=true [S-kindfilter]');
}

// ── S-failtopass：failToPass 未達成（test failure 命中該名）→ pass=false、該名入 missing [契約(b)]
{
  const oracle = { failToPass: ['add returns sum', 'mul works'], passToPass: [] };
  // 'add returns sum' 觀察到失敗（在 failures）；'mul works' 觀察到通過（在 passedTests），否則 unobserved → errored。
  const r = scoreTask(
    gate({ test: 'failed', failures: [testFail('math > add returns sum')], passedTests: ['math > mul works'] }),
    oracle,
  );
  assert(r.pass === false, 'scoreTask：failToPass 有 test 仍紅 → pass=false [S-failtopass/(b)]');
  assert(r.errored === false, 'scoreTask：觀察到的失敗是合法 fail（非 errored）[S-failtopass/(b)]');
  assert(r.failToPass.missing.includes('add returns sum'), 'scoreTask：命中的 failToPass 名進 missing [S-failtopass/(b)]');
  assert(r.failToPass.passed.includes('mul works'), 'scoreTask：在 passedTests 的 failToPass 名進 passed [S-failtopass/(b)]');
}

// ── S-passtopass：passToPass 回歸（test failure 命中該名）→ pass=false、該名入 passToPass.missing [契約(c)]
{
  const oracle = { failToPass: ['add returns sum'], passToPass: ['sub works'] };
  // 'sub works' 觀察到回歸失敗；'add returns sum' 觀察到通過（在 passedTests），否則 unobserved → errored。
  const r = scoreTask(
    gate({ test: 'failed', failures: [testFail('math > sub works')], passedTests: ['math > add returns sum'] }),
    oracle,
  );
  assert(r.pass === false, 'scoreTask：passToPass 轉紅 → pass=false [S-passtopass/(c)]');
  assert(r.errored === false, 'scoreTask：觀察到的回歸是合法 fail（非 errored）[S-passtopass/(c)]');
  assert(r.passToPass.missing.includes('sub works'), 'scoreTask：回歸的 passToPass 名進 missing [S-passtopass/(c)]');
  assert(r.failToPass.missing.length === 0, 'scoreTask：在 passedTests 的 failToPass 名不受影響 → missing 空 [S-passtopass/(c)]');
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

// ── S-boundary：failure 側邊界 Prove-It —— failure "math > checksum" 不可被 "sum" 命中（須卡 " > " 界線）
{
  // 'sum' 由 passedTests 觀察到通過；failure 'math > checksum' 結尾是 ' > checksum'，非 ' > sum'。
  // naive endsWith('sum') 會把 checksum 失敗誤算到 sum 頭上 → 這條會抓出來。
  const r = scoreTask(
    gate({ test: 'failed', failures: [testFail('math > checksum')], passedTests: ['math > sum'] }),
    { failToPass: ['sum'], passToPass: [] },
  );
  assert(r.failToPass.missing.length === 0, 'scoreTask：failure " > checksum" 不可被 "sum" 命中 → missing 空 [S-boundary]');
  assert(r.failToPass.passed.includes('sum'), 'scoreTask："sum" 由 passedTests 命中 → 進 passed [S-boundary]');
  assert(r.pass === true && r.errored === false, 'scoreTask："sum" 觀察到且通過 → pass=true、非 errored [S-boundary]');
}

// ── S-presentboundary：passedTests 側邊界 Prove-It —— passedTests "math > checksum" 不可被 "sum" 命中
{
  // 防新匹配面用子字串放水：passedTests 只有 ' > checksum'，"sum" 既不在 passedTests 也不在 failures → unobserved → errored。
  // naive endsWith('sum') 會把 'math > checksum' 當成 sum 通過 → 假綠；正確 " > sum" 界線使其 unobserved。
  const r = scoreTask(
    gate({ test: 'passed', failures: [], passedTests: ['math > checksum'] }),
    { failToPass: ['sum'], passToPass: [] },
  );
  assert(r.errored === true, 'scoreTask：passedTests " > checksum" 不命中 "sum" → sum unobserved → errored=true [S-presentboundary]');
  assert(r.pass === false, 'scoreTask：sum unobserved → pass=false（不可被子字串假綠）[S-presentboundary]');
}

// ── S-firstline：只有 message 第一行算 titlePath；第二行提到的名不算命中 [契約：第一行＝titlePath]
{
  // line1='math > unrelated regression'（不命中）；line2 文字含 'add returns sum'（須被忽略，不算 failure 命中）。
  // 'add returns sum' 由 passedTests 觀察到通過（pass 案例必須在 passedTests，否則 unobserved → errored）。
  const f = testFail('math > unrelated regression', 'expected add returns sum to equal 3');
  const r = scoreTask(
    gate({ test: 'failed', failures: [f], passedTests: ['math > add returns sum'] }),
    { failToPass: ['add returns sum'], passToPass: [] },
  );
  assert(r.failToPass.missing.length === 0, 'scoreTask：failure 只看第一行 titlePath，第二行撞名不算命中 → missing 空 [S-firstline]');
  // 此例 gate 雖整體 failed，但該 task 指定測在 passedTests、無 failure 命中 → pass 解耦於整體 gate 狀態。
  assert(r.pass === true, 'scoreTask：整體 gate failed 但本 task 指定測皆觀察到通過 → pass=true [S-firstline]');
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

// ── S-notpresent：核心回歸（守 verify P1）—— gates.test=passed、failures 空，但 required failToPass 名
//    不在 passedTests（也不在 failures）→ unobserved → errored:true、pass:false。
//    舊「不在 failures 即通過」會回 pass:true（required test 缺席/打錯被當通過＝假綠），故本條必紅。
{
  const r = scoreTask(
    gate({ test: 'passed', failures: [], passedTests: ['math > something unrelated'] }),
    { failToPass: ['add returns sum'], passToPass: [] },
  );
  assert(r.errored === true, 'scoreTask：failToPass 名不在 passedTests 也不在 failures → unobserved → errored=true [S-notpresent]');
  assert(r.pass === false, 'scoreTask：required 未觀察 → pass=false（不可用「不在 failures」反推假綠）[S-notpresent]');
}
// ── S-notpresent-p2p：passToPass 版 —— failToPass 觀察到通過，但 passToPass 名缺席於 passedTests/failures → errored
{
  const r = scoreTask(
    gate({ test: 'passed', failures: [], passedTests: ['math > add returns sum'] }),
    { failToPass: ['add returns sum'], passToPass: ['sub works'] },
  );
  assert(r.errored === true, 'scoreTask：passToPass 名不在 passedTests 也不在 failures → unobserved → errored=true [S-notpresent-p2p]');
  assert(r.pass === false, 'scoreTask：passToPass 未觀察 → pass=false [S-notpresent-p2p]');
}

// ── S-truncated：gates.test=failed 且 truncated=true（清單可能被截斷）—— 某 passToPass 名既不在
//    passedTests 也不在 failures → unobserved → errored:true、不可 pass（沒驗到就不能算過）。
{
  const r = scoreTask(
    gate({ test: 'failed', failures: [testFail('math > add returns sum')], passedTests: [], truncated: true }),
    { failToPass: ['add returns sum'], passToPass: ['sub works'] },
  );
  assert(r.errored === true, 'scoreTask：truncated 下 passToPass 名 unobserved → errored=true [S-truncated]');
  assert(r.pass === false, 'scoreTask：truncated 下有未觀察 required → pass=false [S-truncated]');
}

// ── S-failobserved：failToPass 名出現在 failures（觀察到但失敗）→ pass:false 且「非」errored（合法失敗），名入 missing
{
  const r = scoreTask(
    gate({ test: 'failed', failures: [testFail('math > add returns sum')], passedTests: [] }),
    { failToPass: ['add returns sum'], passToPass: [] },
  );
  assert(r.pass === false, 'scoreTask：failToPass 觀察到但失敗 → pass=false [S-failobserved]');
  assert(r.errored === false, 'scoreTask：觀察到的失敗是合法 fail，非 errored（與 unobserved 區分）[S-failobserved]');
  assert(r.failToPass.missing.includes('add returns sum'), 'scoreTask：觀察到的失敗名入 failToPass.missing [S-failobserved]');
}

// ── S-emptyoracle：oracle 無任何 required test（failToPass 與 passToPass 皆空）→「什麼都沒驗」→
//    errored:true、pass:false。與「永不把沒驗到誤判為通過」一致：驗了零條測試不算通過。
//    現行實作對空 oracle 會回 pass:true（零測試被當真空綠），故本條必紅＝正確的紅燈起點。
{
  const r = scoreTask(
    gate({ test: 'passed', failures: [], passedTests: [] }),
    { failToPass: [], passToPass: [] },
  );
  assert(r.errored === true, 'scoreTask：oracle 無任何 required test → errored=true（零測試不算驗）[S-emptyoracle]');
  assert(r.pass === false, 'scoreTask：oracle 無任何 required test → pass=false（不可真空綠）[S-emptyoracle]');
}

// ── S-missingoracle：oracle 整個缺（undefined）→ 不丟例外、pass!==true（同樣什麼都沒驗 → 應 errored）。
//    與 S-emptyoracle 同源：缺 oracle 代表零條 required test，沒驗到就不能報綠。
{
  let r;
  let threw = false;
  try {
    r = scoreTask(gate({ test: 'passed', failures: [], passedTests: [] }), undefined);
  } catch {
    threw = true;
    r = {};
  }
  assert(threw === false, 'scoreTask：oracle 整個缺（undefined）不丟例外（graceful）[S-missingoracle]');
  assert(r.pass !== true, 'scoreTask：oracle 整個缺 → pass!==true（什麼都沒驗，不可報綠）[S-missingoracle]');
}

// ── T-spawndiag：gate 結果不可用（null / 非 JSON / 子程序 error）→ scoreTask graceful 回 errored，
//    reason 帶「gate/結果不可用」診斷字串（非僅泛用 missing test 名）[P2 診斷]
{
  let r;
  let threw = false;
  try {
    r = scoreTask(null, { failToPass: ['add returns sum'], passToPass: [] });
  } catch {
    threw = true;
    r = {};
  }
  assert(threw === false, 'scoreTask(null) 不丟例外（gate 無結果應 graceful）[T-spawndiag]');
  assert(r.errored === true, 'scoreTask(null) → errored=true [T-spawndiag]');
  assert(r.pass === false, 'scoreTask(null) → pass=false [T-spawndiag]');
  assert(typeof r.reason === 'string' && r.reason.trim().length > 0, 'scoreTask(null) → reason 非空 [T-spawndiag]');
  assert(
    typeof r.reason === 'string' &&
      /gate|result|結果|spawn|JSON|無法|沒有|未產出|無結果|null|診斷|工具|invalid|無效/i.test(r.reason),
    'scoreTask(null)：reason 帶 gate/結果不可用診斷（非僅泛用 missing test 名）[T-spawndiag]',
  );
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
//        et-failtopass(failToPass 仍紅→fail)、et-regression(passToPass 轉紅→fail)、
//        et-errored(oracle 指名 fixture 裡不存在的 test → unobserved → errored)
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

// ── E1：跑整個 corpus（4 task）→ aggregate total4/passed1/failed3、各 task 結果正確、exit 1 [契約 e2e + T-erroredE2E]
{
  const { res, json } = runOracle(['--dir', 'scripts/fixtures/eval-oracle', '--json']);
  assert(res.error == null, 'E1：node 啟動成功（spawn 無 error）[E1]');
  assert(json && json.total === 4 && json.passed === 1 && json.failed === 3, 'E1：aggregate total4/passed1/failed3（含 et-errored，errored 計入 failed）[E1]');

  const etPass = json ? findResult(json.tasks, 'et-pass') : null;
  assert(etPass && etPass.pass === true, 'E1：et-pass 全綠 → pass=true [E1]');

  const etF2P = json ? findResult(json.tasks, 'et-failtopass') : null;
  assert(etF2P && etF2P.pass === false, 'E1：et-failtopass failToPass 仍紅 → pass=false [E1]');
  assert(etF2P && etF2P.failToPass && Array.isArray(etF2P.failToPass.missing) && etF2P.failToPass.missing.length > 0, 'E1：et-failtopass failToPass.missing 非空 [E1]');

  const etReg = json ? findResult(json.tasks, 'et-regression') : null;
  assert(etReg && etReg.pass === false, 'E1：et-regression passToPass 轉紅 → pass=false [E1]');
  assert(etReg && etReg.passToPass && Array.isArray(etReg.passToPass.missing) && etReg.passToPass.missing.length > 0, 'E1：et-regression passToPass.missing 非空 [E1]');

  // T-erroredE2E：oracle 指名 fixture 裡不存在的 test → 該名 unobserved → 整 task errored、pass=false、不計入 passed
  const etErr = json ? findResult(json.tasks, 'et-errored') : null;
  assert(etErr && etErr.errored === true, 'E1：et-errored 指名不存在 test → errored=true [T-erroredE2E]');
  assert(etErr && etErr.pass === false, 'E1：et-errored → pass=false（unobserved 不可當 pass）[T-erroredE2E]');

  assert(res.status === 1, 'E1：有 fail → 程序 exit code===1 [E1]');
}

// ── E2：只跑 et-pass（--task）→ 只該 task 入列、全綠、exit 0 [契約 e2e]
{
  const { res, json } = runOracle(['--dir', 'scripts/fixtures/eval-oracle', '--task', 'et-pass', '--json']);
  assert(res.error == null, 'E2：node 啟動成功 [E2]');
  assert(json && json.total === 1 && json.passed === 1 && json.failed === 0, 'E2：--task 過濾 → 只跑 et-pass、全綠 [E2]');
  assert(res.status === 0, 'E2：無 fail → 程序 exit code===0 [E2]');
  // #34 passthrough：結果帶 task 的 tags/version/verifyAxes（供 eval-tags 分組 / eval↔verify 互指）
  const t = json?.tasks?.[0];
  assert(t && JSON.stringify(t.tags) === JSON.stringify(['arithmetic', 'regression'])
    && t.version === '1.0' && JSON.stringify(t.verifyAxes) === JSON.stringify(['tests']),
    'E2：result passthrough tags/version/verifyAxes [E2]');
}

// ════════════════════════════════════════════════════════════════════════════
//  P2 行為 —— main/CLI/IO 層（路徑安全、CLI 錯誤碼）
// ════════════════════════════════════════════════════════════════════════════

// ── T-traversal：task.workspace 指向 tasksDir 外（"../escape" / 絕對路徑）→ 該 task errored、
//    reason 提及越界，且不得 spawn 到 tasksDir 外（此處以 errored + reason 越界證明已攔下）[P2 路徑安全]
{
  const dir = mkdtempSync(join(tmpdir(), 'eo-evil-'));
  try {
    const absEscape = process.platform === 'win32' ? 'C:/Windows/Temp/eo-escape' : '/tmp/eo-escape';
    writeFileSync(join(dir, 'et-evil-rel.json'), JSON.stringify({ id: 'et-evil-rel', workspace: '../escape', failToPass: ['x'], passToPass: [] }), 'utf8');
    writeFileSync(join(dir, 'et-evil-abs.json'), JSON.stringify({ id: 'et-evil-abs', workspace: absEscape, failToPass: ['x'], passToPass: [] }), 'utf8');
    const { json } = runOracle(['--dir', dir, '--json']);
    const boundary = /越界|範圍外|逃逸|傳越|超出|traversal|escape|outside|out[- ]?of[- ]?bounds|absolute|絕對路徑|path[- ]?traversal/i;

    const evilRel = json ? findResult(json.tasks, 'et-evil-rel') : null;
    assert(evilRel && evilRel.errored === true, 'oracle：workspace "../escape" → 該 task errored=true [T-traversal]');
    assert(evilRel && evilRel.pass === false, 'oracle：workspace 越界 → pass=false [T-traversal]');
    assert(
      evilRel && typeof evilRel.reason === 'string' && boundary.test(evilRel.reason),
      'oracle：workspace "../escape" → reason 提及越界/路徑逃逸（非泛用 missing）[T-traversal]',
    );

    const evilAbs = json ? findResult(json.tasks, 'et-evil-abs') : null;
    assert(evilAbs && evilAbs.errored === true, 'oracle：workspace 絕對路徑 → 該 task errored=true [T-traversal]');
    assert(
      evilAbs && typeof evilAbs.reason === 'string' && boundary.test(evilAbs.reason),
      'oracle：workspace 絕對路徑 → reason 提及越界/絕對路徑 [T-traversal]',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── T-taskmiss：--task 指向 dir 內不存在的 id → 程序 exit≠0 + stderr 有訊息
//    （現在會 exit 0＝假成功，必紅；用獨立 tmp dir 隔離「dir 不存在」這個別的失敗原因）[P2 CLI]
{
  const dir = mkdtempSync(join(tmpdir(), 'eo-taskmiss-'));
  try {
    writeFileSync(join(dir, 'et-real.json'), JSON.stringify({ id: 'et-real', failToPass: [], passToPass: [] }), 'utf8');
    const { res } = runOracle(['--dir', dir, '--task', 'no-such-task', '--json']);
    assert(res.status !== 0, 'oracle：--task 指向不存在的 id → exit code≠0（不可假成功）[T-taskmiss]');
    assert(typeof res.stderr === 'string' && res.stderr.trim().length > 0, 'oracle：--task 不存在 → stderr 有訊息 [T-taskmiss]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// ── T-taskmiss-dir：缺 --dir 參數 → 程序 exit≠0 + stderr 含 usage/用法 [P2 CLI]
{
  const res = spawnSync('node', ['scripts/eval-oracle.mjs', '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert(res.status !== 0, 'oracle：缺 --dir 參數 → exit code≠0 [T-taskmiss-dir]');
  assert(
    typeof res.stderr === 'string' && /usage|用法|--dir/i.test(res.stderr),
    'oracle：缺 --dir → stderr 含 usage/用法/--dir 提示 [T-taskmiss-dir]',
  );
}

// ── 摘要 + exit code ─────────────────────────────────────────────────────────
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
