#!/usr/bin/env node
// test-eval-metrics.mjs —— eval-metrics.mjs 的紅綠斷言（自帶極簡 harness，仿 scripts/test-eval-oracle.mjs，不引測試框架）。
// 用法（cwd = plugins/loops-workflow）：node scripts/test-eval-metrics.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1（主線用此 exit code 判紅綠）。
//
// 預期 Red：eval-metrics.mjs 尚未實作，下面的 import 會 ERR_MODULE_NOT_FOUND，
// 整個檔在載入期就丟例外 → node 以非 0 退出。這就是 TDD 的紅燈起點。
// e2e smoke 真 spawn `scripts/eval-metrics.mjs`（同樣未實作 → 子程序非 0 / 無輸出），
// 補齊純函式 + CLI(record/check) 後，下方斷言才有機會逐條轉綠。

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { buildEvalRow, readEvalRows, parseEvalRows, computeRegression, rotateLines, appendEvalRow } from './eval-metrics.mjs';
// #51 新 export（summarizeVersions / groupRowsByVersion）尚未實作。用 namespace import 取用：
// 缺 export 時是 undefined（非 link-time crash），既有測仍綠，新斷言透過 callSafe 逐條轉紅。
import * as EM from './eval-metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../scripts
const ROOT = dirname(HERE); // plugin root（契約：record/check e2e 的 cwd；committed 語料庫在 evals/build）

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
const near = (a, b, eps = 1e-9) => typeof a === 'number' && Number.isFinite(a) && Math.abs(a - b) < eps;
function callSafe(fn) {
  try {
    return { threw: false, val: fn() };
  } catch (e) {
    return { threw: true, err: e };
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  buildEvalRow(aggregate, { corpus, ts, runs }) —— 把 oracle --json report 攤平成一行 metric row
//  契約欄位：{ ts, corpus, schema:1, runs, total, passed, failed, errored, passRate, passK }
//  passRate = total>0 ? passed/total : 0（不可除以 0）；passK = passRate（MVP 確定性）；
//  errored = aggregate.tasks 中 errored===true 的數；runs 預設 1。
// ════════════════════════════════════════════════════════════════════════════

// ── R-allpass(a)：全綠 5/5 → passRate=1、passK=1、errored=0、schema=1、runs=1、欄位透傳 [契約(a)]
{
  const aggregate = {
    total: 5,
    passed: 5,
    failed: 0,
    tasks: [
      { errored: false }, { errored: false }, { errored: false }, { errored: false }, { errored: false },
    ],
  };
  const row = buildEvalRow(aggregate, { corpus: 'evals/build', ts: 'T', runs: 1 });
  assert(row && row.passRate === 1, 'buildEvalRow：5/5 → passRate===1 [R-allpass/(a)]');
  assert(row && row.passK === 1, 'buildEvalRow：passK===passRate===1（MVP 確定性）[R-allpass/(a)]');
  assert(row && row.errored === 0, 'buildEvalRow：tasks 無 errored → errored===0 [R-allpass/(a)]');
  assert(row && row.schema === 2, 'buildEvalRow：schema===2（契約 bump v1→v2，#51）[R-allpass/(a)]');
  assert(row && row.runs === 1, 'buildEvalRow：runs===1 [R-allpass/(a)]');
  assert(row && row.total === 5, 'buildEvalRow：total 透傳===5 [R-allpass/(a)]');
  assert(row && row.passed === 5, 'buildEvalRow：passed 透傳===5 [R-allpass/(a)]');
  assert(row && row.failed === 0, 'buildEvalRow：failed 透傳===0 [R-allpass/(a)]');
  assert(row && row.corpus === 'evals/build', 'buildEvalRow：corpus 原樣帶出 [R-allpass/(a)]');
  assert(row && row.ts === 'T', 'buildEvalRow：ts 原樣帶出 [R-allpass/(a)]');
}

// ── R-mixed(b)：4 task 2 過、含 1 errored → passRate=0.5、errored=1（errored 數來自 tasks 旗標）[契約(b)]
{
  const aggregate = {
    total: 4,
    passed: 2,
    failed: 2,
    tasks: [
      { errored: false, pass: true },
      { errored: false, pass: true },
      { errored: true },
      { errored: false, pass: false },
    ],
  };
  const row = buildEvalRow(aggregate, { corpus: 'evals/build', ts: 'T', runs: 1 });
  assert(row && row.passRate === 0.5, 'buildEvalRow：2/4 → passRate===0.5 [R-mixed/(b)]');
  assert(row && row.passK === 0.5, 'buildEvalRow：passK===passRate===0.5 [R-mixed/(b)]');
  assert(row && row.errored === 1, 'buildEvalRow：tasks 中 errored===true 計數===1（不是 failed-passed 反推）[R-mixed/(b)]');
  assert(row && row.failed === 2, 'buildEvalRow：failed 透傳===2 [R-mixed/(b)]');
}

// ── R-empty(c)：total=0 → passRate=0（不可 NaN / Infinity，守 0/0 除零）[契約(c)]
{
  const aggregate = { total: 0, passed: 0, failed: 0, tasks: [] };
  const row = buildEvalRow(aggregate, { corpus: 'evals/empty', ts: 'T', runs: 1 });
  assert(row && row.passRate === 0, 'buildEvalRow：total=0 → passRate===0（不除以 0）[R-empty/(c)]');
  assert(row && Number.isFinite(row.passRate), 'buildEvalRow：total=0 → passRate 為有限數（非 NaN / Infinity）[R-empty/(c)]');
  assert(row && row.passK === 0 && Number.isFinite(row.passK), 'buildEvalRow：total=0 → passK===0 且有限 [R-empty/(c)]');
  assert(row && row.errored === 0, 'buildEvalRow：空 tasks → errored===0 [R-empty/(c)]');
}

// ── R-runsdefault：meta 省略 runs → runs 預設 1 [契約：runs 預設 1]
{
  const aggregate = { total: 2, passed: 1, failed: 1, tasks: [{ errored: false }, { errored: false }] };
  const row = buildEvalRow(aggregate, { corpus: 'evals/build', ts: 'T' });
  assert(row && row.runs === 1, 'buildEvalRow：未給 runs → 預設 runs===1 [R-runsdefault]');
}

// ── R-toFinite（防呆）：total/passed/failed 收到非數（string 'x' / undefined / NaN）→ 一律 toFiniteNumber→0，
//    passRate 連帶為 0；四欄皆 Number.isFinite。裸傳 aggregate.total 會讓 total==='x'（或 NaN）→ 本條紅 [契約 toFiniteNumber 防呆]
{
  const row = buildEvalRow({ total: 'x', passed: undefined, failed: NaN, tasks: [] }, { corpus: 'c', ts: 't' });
  assert(row && row.total === 0 && Number.isFinite(row.total), "buildEvalRow：total='x' → total===0 且有限 [R-toFinite]");
  assert(row && row.passed === 0 && Number.isFinite(row.passed), 'buildEvalRow：passed=undefined → passed===0 且有限 [R-toFinite]');
  assert(row && row.failed === 0 && Number.isFinite(row.failed), 'buildEvalRow：failed=NaN → failed===0 且有限 [R-toFinite]');
  assert(row && row.passRate === 0 && Number.isFinite(row.passRate), 'buildEvalRow：壞輸入 → passRate===0 且有限（非 NaN / Infinity）[R-toFinite]');
}

// ════════════════════════════════════════════════════════════════════════════
//  summarizeVersions(tasks) -> string[]（#51 契約1，新 export）—— 純函式 (unit)
//  非陣列 → []；tasks 中 version != null 者取 String(version)、去重、升冪排序（穩定可重現）；
//  全無 version → []；數值 version 也經 String() 納入。新 export → callSafe 包覆，缺函式時轉紅而非中斷整檔。
// ════════════════════════════════════════════════════════════════════════════

// ── SV-nonarray：非陣列輸入（null/undefined/物件/數字/字串）→ [] [契約1 非陣列防呆]
{
  for (const bad of [null, undefined, {}, 42, 'x']) {
    const r = callSafe(() => EM.summarizeVersions(bad));
    assert(!r.threw && Array.isArray(r.val) && r.val.length === 0,
      `summarizeVersions：非陣列(${JSON.stringify(bad)}) → [] [SV-nonarray]`);
  }
}

// ── SV-dedup-sort：契約範例 [1.1,1.0,1.0] → ['1.0','1.1']（去重 + 升冪排序）[契約1 去重排序]
{
  const r = callSafe(() => EM.summarizeVersions([{ version: '1.1' }, { version: '1.0' }, { version: '1.0' }]));
  assert(!r.threw && JSON.stringify(r.val) === JSON.stringify(['1.0', '1.1']),
    "summarizeVersions：[1.1,1.0,1.0] → ['1.0','1.1'] [SV-dedup-sort]");
}

// ── SV-sort-stable：亂序 + 重複 → 升冪去重；重複呼叫逐位元相同（穩定可重現）[契約1 穩定排序]
{
  const input = [{ version: '1.2' }, { version: '1.0' }, { version: '1.1' }, { version: '1.0' }, { version: '1.2' }];
  const r1 = callSafe(() => EM.summarizeVersions(input));
  const r2 = callSafe(() => EM.summarizeVersions(input));
  assert(!r1.threw && JSON.stringify(r1.val) === JSON.stringify(['1.0', '1.1', '1.2']),
    "summarizeVersions：亂序去重 → ['1.0','1.1','1.2'] [SV-sort-stable]");
  assert(!r2.threw && JSON.stringify(r1.val) === JSON.stringify(r2.val),
    'summarizeVersions：同輸入重複呼叫逐位元相同（可重現）[SV-sort-stable]');
}

// ── SV-allnull：全部 task 無 version（undefined/null/缺欄）→ [] [契約1 全無 version]
{
  const r = callSafe(() => EM.summarizeVersions([{ version: undefined }, { version: null }, {}]));
  assert(!r.threw && Array.isArray(r.val) && r.val.length === 0,
    'summarizeVersions：全部無 version（undefined/null/缺欄）→ [] [SV-allnull]');
}

// ── SV-numeric：數值 version 經 String() 納入（2 → '2'），與字串 '2' 跨型去重 [契約1 String() 納入]
{
  const r = callSafe(() => EM.summarizeVersions([{ version: 2 }, { version: '2' }]));
  assert(!r.threw && JSON.stringify(r.val) === JSON.stringify(['2']),
    "summarizeVersions：數值 2 與字串 '2' → String() 後去重 → ['2'] [SV-numeric]");
}

// ── SV-zero（Prove-It：!=null 非 truthy）：version 0 → '0'（0 != null 為真須納入；truthy 過濾會漏 → 紅）[契約1 version!=null]
{
  const r = callSafe(() => EM.summarizeVersions([{ version: 0 }]));
  assert(!r.threw && JSON.stringify(r.val) === JSON.stringify(['0']),
    "summarizeVersions：version 0 → '0'（!= null 而非 truthy 過濾）[SV-zero]");
}

// ════════════════════════════════════════════════════════════════════════════
//  buildEvalRow 擴充（#51 契約2）—— schema 1→2 bump、新增 versions 欄（= summarizeVersions(aggregate.tasks)）。
//  既有欄（ts/corpus/runs/total/passed/failed/errored/passRate/passK）語意與值完全不變。
// ════════════════════════════════════════════════════════════════════════════

// ── BV-schema2：schema 常數 bump 為 2 [契約2 schema:2]
{
  const row = buildEvalRow({ total: 1, passed: 1, failed: 0, tasks: [{ errored: false }] }, { corpus: 'c', ts: 't', runs: 1 });
  assert(row && row.schema === 2, 'buildEvalRow：schema===2（契約 bump）[BV-schema2]');
}

// ── BV-versions：tasks 帶 version → row.versions = 去重排序版本；且既有欄值不變（versions 不污染既有計算）[契約2 versions 欄]
{
  const aggregate = {
    total: 3, passed: 3, failed: 0,
    tasks: [
      { errored: false, version: '1.0' },
      { errored: false, version: '1.1' },
      { errored: false, version: '1.0' },
    ],
  };
  const row = buildEvalRow(aggregate, { corpus: 'evals/build', ts: 'T', runs: 1 });
  assert(row && JSON.stringify(row.versions) === JSON.stringify(['1.0', '1.1']),
    "buildEvalRow：tasks 帶 version → row.versions===['1.0','1.1'] [BV-versions]");
  assert(row && row.passRate === 1 && row.passed === 3 && row.total === 3 && row.errored === 0,
    'buildEvalRow：新增 versions 欄後既有欄（passRate/passed/total/errored）值不變 [BV-versions]');
}

// ── BV-versions-empty：空 tasks / 無 tasks 欄 → row.versions===[]（不丟）[契約2 無 tasks/空→[]]
{
  const a = callSafe(() => buildEvalRow({ total: 0, passed: 0, failed: 0, tasks: [] }, { corpus: 'c', ts: 't' }));
  assert(!a.threw && a.val && Array.isArray(a.val.versions) && a.val.versions.length === 0,
    'buildEvalRow：空 tasks → versions===[] [BV-versions-empty]');
  const b = callSafe(() => buildEvalRow({ total: 0, passed: 0, failed: 0 }, { corpus: 'c', ts: 't' }));
  assert(!b.threw && b.val && Array.isArray(b.val.versions) && b.val.versions.length === 0,
    'buildEvalRow：無 tasks 欄 → versions===[]（不丟）[BV-versions-empty]');
}

// ════════════════════════════════════════════════════════════════════════════
//  parseEvalRows(content) —— 純函式：把 JSONL 字串逐行解析成 row 陣列。
//  壞行跳過、空字串→[]、永不丟；readEvalRows(file) 變薄 reader（缺檔→[]）委派它。
// ════════════════════════════════════════════════════════════════════════════

// ── P-parse：壞行置中（2 合法夾 1 GARBAGE）→ 回 2 筆、後續合法行續讀（第 2 筆 passRate===0.5）；空字串→[]；全程不丟（in-memory）[契約 parseEvalRows 純函式]
{
  const r = callSafe(() => parseEvalRows('{"passRate":1}\nGARBAGE\n{"passRate":0.5}\n'));
  assert(!r.threw, 'parseEvalRows：含壞行不丟例外（純函式 tolerant）[P-parse]');
  const rows = r.val || [];
  assert(Array.isArray(rows) && rows.length === 2, 'parseEvalRows：2 合法 + 1 壞 → 回 2 筆（壞行被跳過）[P-parse]');
  assert(rows[0] && rows[0].passRate === 1, 'parseEvalRows：第 1 筆 passRate===1 [P-parse]');
  assert(rows[1] && rows[1].passRate === 0.5, 'parseEvalRows：壞行（置中）之後的合法行仍續讀（第 2 筆 passRate===0.5）[P-parse]');

  const e = callSafe(() => parseEvalRows(''));
  assert(!e.threw, 'parseEvalRows：空字串不丟例外 [P-parse]');
  assert(Array.isArray(e.val) && e.val.length === 0, 'parseEvalRows：空字串 → [] [P-parse]');
}

// ════════════════════════════════════════════════════════════════════════════
//  readEvalRows(file) —— 讀 JSONL 成 row 陣列；tolerant：壞行跳過、檔不存在回 []
// ════════════════════════════════════════════════════════════════════════════

// ── RR-tolerant：2 合法 JSON 行夾 1 壞行 → 回 2 筆，round-trip 正確（壞行在中間 → 證後續仍續讀）[契約 readEvalRows]
{
  const dir = mkdtempSync(join(tmpdir(), 'em-read-'));
  try {
    const file = join(dir, 'eval-results.jsonl');
    const lines = [
      JSON.stringify({ ts: 'T1', corpus: 'c', passRate: 1.0, total: 5 }),
      'this is not valid json {{{',
      JSON.stringify({ ts: 'T2', corpus: 'c', passRate: 0.5, total: 4 }),
    ];
    writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    const r = callSafe(() => readEvalRows(file));
    assert(!r.threw, 'readEvalRows：含壞行不丟例外（逐行 tolerant）[RR-tolerant]');
    const rows = r.val || [];
    assert(Array.isArray(rows) && rows.length === 2, 'readEvalRows：2 合法 + 1 壞 → 回 2 筆（壞行被跳過）[RR-tolerant]');
    assert(rows[0] && rows[0].passRate === 1.0 && rows[0].ts === 'T1', 'readEvalRows：第 1 筆 round-trip 正確 [RR-tolerant]');
    assert(rows[1] && rows[1].passRate === 0.5 && rows[1].ts === 'T2', 'readEvalRows：壞行之後的合法行仍被解析（第 2 筆 round-trip）[RR-tolerant]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── RR-missing：檔不存在 → 回 []（不丟例外）[契約 readEvalRows]
{
  const dir = mkdtempSync(join(tmpdir(), 'em-nofile-'));
  try {
    const missing = join(dir, 'does-not-exist.jsonl');
    const r = callSafe(() => readEvalRows(missing));
    assert(!r.threw, 'readEvalRows：不存在檔不丟例外 [RR-missing]');
    assert(Array.isArray(r.val) && r.val.length === 0, 'readEvalRows：不存在檔 → 回 [] [RR-missing]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  computeRegression(rows, { baseline, tolerance }) —— 退化判定
//  baseline row = rows[baseline]（預設 0）；current = 最後一行；
//  regressed = currentRate < baselineRate - tolerance（嚴格小於）；delta = currentRate - baselineRate。
//  rows<2 → regressed:false（沒得比）。
// ════════════════════════════════════════════════════════════════════════════
const rowsOf = (...rates) => rates.map((p) => ({ passRate: p }));

// ── CR-drop：[1.0, 0.8]、tolerance 0 → regressed=true、delta≈-0.2、baseline/current 取值正確 [契約]
{
  const r = computeRegression(rowsOf(1.0, 0.8), { baseline: 0, tolerance: 0 });
  assert(r && r.regressed === true, 'computeRegression：[1.0→0.8] tol0 → regressed=true [CR-drop]');
  assert(r && r.baselineRate === 1.0, 'computeRegression：baselineRate=rows[0].passRate=1.0 [CR-drop]');
  assert(r && r.currentRate === 0.8, 'computeRegression：currentRate=最後一行 passRate=0.8 [CR-drop]');
  assert(r && near(r.delta, -0.2), 'computeRegression：delta≈-0.2（current-baseline）[CR-drop]');
  assert(r && typeof r.reason === 'string', 'computeRegression：reason 是字串 [CR-drop]');
}

// ── CR-equal：[1.0, 1.0] → regressed=false（持平不退化）、delta≈0 [契約：相等 → 不退化]
{
  const r = computeRegression(rowsOf(1.0, 1.0), { baseline: 0, tolerance: 0 });
  assert(r && r.regressed === false, 'computeRegression：[1.0→1.0] → regressed=false（持平）[CR-equal]');
  assert(r && near(r.delta, 0), 'computeRegression：持平 → delta≈0 [CR-equal]');
}

// ── CR-within：[1.0, 0.95]、tolerance 0.1 → regressed=false（在容忍內）[契約]
{
  const r = computeRegression(rowsOf(1.0, 0.95), { baseline: 0, tolerance: 0.1 });
  assert(r && r.regressed === false, 'computeRegression：跌 0.05 < tol 0.1 → regressed=false（容忍內）[CR-within]');
  assert(r && near(r.delta, -0.05), 'computeRegression：delta≈-0.05 [CR-within]');
}

// ── CR-exceed：[1.0, 0.85]、tolerance 0.1 → regressed=true（超過容忍）[契約]
{
  const r = computeRegression(rowsOf(1.0, 0.85), { baseline: 0, tolerance: 0.1 });
  assert(r && r.regressed === true, 'computeRegression：跌 0.15 > tol 0.1 → regressed=true（超容忍）[CR-exceed]');
  assert(r && near(r.delta, -0.15), 'computeRegression：delta≈-0.15 [CR-exceed]');
}

// ── CR-boundary（Prove-It：嚴格小於）：[1.0, 0.9]、tolerance 0.1 → 跌幅恰等於 tolerance → regressed=false。
//    若實作用 <=（而非嚴格 <）會把此邊界誤判為退化 → 本條抓出來。
{
  const r = computeRegression(rowsOf(1.0, 0.9), { baseline: 0, tolerance: 0.1 });
  assert(r && r.regressed === false, 'computeRegression：跌幅===tolerance（0.1）→ regressed=false（嚴格小於才算退化）[CR-boundary]');
}

// ── CR-single：單行 [1.0] → regressed=false（沒得比）[契約：rows<2 → false]
{
  const r = computeRegression(rowsOf(1.0), { baseline: 0, tolerance: 0 });
  assert(r && r.regressed === false, 'computeRegression：單行 → regressed=false（沒 baseline 可比）[CR-single]');
}

// ── CR-empty：空 rows → regressed=false 且不丟例外 [契約：rows<2 → false]
{
  const r = callSafe(() => computeRegression([], { baseline: 0, tolerance: 0 }));
  assert(!r.threw, 'computeRegression：空 rows 不丟例外 [CR-empty]');
  assert(r.val && r.val.regressed === false, 'computeRegression：空 rows → regressed=false [CR-empty]');
}

// ── CR-current-is-last（Prove-It）：[1.0, 0.5, 0.95]、baseline 0 → current 必須取「最後一行」(0.95)，非 rows[1](0.5)。
//    若實作把 current 取成 rows[1]，currentRate 會是 0.5 → 本條轉紅。
{
  const r = computeRegression(rowsOf(1.0, 0.5, 0.95), { baseline: 0, tolerance: 0 });
  assert(r && r.currentRate === 0.95, 'computeRegression：current=最後一行(0.95)，非中間行(0.5) [CR-current-is-last]');
  assert(r && r.baselineRate === 1.0, 'computeRegression：baseline=rows[0]=1.0 [CR-current-is-last]');
  assert(r && r.regressed === true, 'computeRegression：0.95 < 1.0（tol0）→ regressed=true [CR-current-is-last]');
  assert(r && near(r.delta, -0.05), 'computeRegression：delta≈-0.05 [CR-current-is-last]');
}

// ── CR-baseline-index：baseline 覆寫為 index 1 → baselineRate 取 rows[1]、current 仍取最後一行 [契約：baseline=rows[baseline]]
{
  const r = computeRegression(rowsOf(1.0, 0.5, 0.95), { baseline: 1, tolerance: 0 });
  assert(r && r.baselineRate === 0.5, 'computeRegression：baseline index 1 → baselineRate=rows[1]=0.5 [CR-baseline-index]');
  assert(r && r.currentRate === 0.95, 'computeRegression：current 仍=最後一行(0.95) [CR-baseline-index]');
  assert(r && r.regressed === false, 'computeRegression：0.95 不< 0.5 → regressed=false [CR-baseline-index]');
}

// ── CR-corpus（corpus-aware）：只比「最後一行的 corpus」歷史、跨 corpus 不混比。
//    rows=[B0.5, A1.0, A0.95]、tol0 → 只取 A：baseline=A 首筆 1.0、current=A 末筆 0.95 → regressed=true。
//    刻意把別組 B 的 0.5 擺第一筆：若「移除 corpus filter」(scoped=整段歷史)，baseline 會撈到 B 的 0.5
//    → baselineRate 變 0.5、regressed 變 false → 本條自身就獨立轉紅（mutation Prove-It，不必倚賴 CR-corpus-isolation）[契約 corpus-aware 回歸比較]
{
  const rows = [
    { corpus: 'B', passRate: 0.5 },
    { corpus: 'A', passRate: 1.0 },
    { corpus: 'A', passRate: 0.95 },
  ];
  const r = computeRegression(rows, { tolerance: 0 });
  assert(r && r.baselineRate === 1.0, 'computeRegression：baseline 取最後 corpus(A) 的首筆=1.0（非別組 B 的 0.5）[CR-corpus]');
  assert(r && r.currentRate === 0.95, 'computeRegression：current 取最後一行 A 的 0.95（非 B 的 0.5）[CR-corpus]');
  assert(r && r.regressed === true, 'computeRegression：A 0.95<1.0（tol0）→ regressed=true [CR-corpus]');
}

// ── CR-corpus-isolation（corpus-aware）：current 是 B 且 B 只一筆 → 沒前例可比 → regressed=false；
//    且 A 的 0.5 不得洩漏成 B 的 baseline（若跨 corpus 撈 A 當 baseline，baselineRate 會是 0.5 → 本條紅）[契約 corpus 隔離]
{
  const rows = [
    { corpus: 'A', passRate: 0.5 },
    { corpus: 'B', passRate: 1.0 },
  ];
  const r = computeRegression(rows, { tolerance: 0 });
  assert(r && r.regressed === false, 'computeRegression：最後 corpus(B) 僅 1 筆、無前例 → regressed=false [CR-corpus-isolation]');
  assert(r && r.baselineRate !== 0.5, 'computeRegression：B 的 baseline 不被別組 A 的 0.5 汙染 [CR-corpus-isolation]');
}

// ── CR-negtol-clamp（Prove-It）：負 tolerance 須 clamp 到 0。[1.0,1.0]、tolerance -0.1 → 持平不算退化 → regressed=false。
//    未 clamp 時門檻被收緊到 baseline 之上：current < baseline-(-0.1)，即 1.0 < 1.1 → 會誤判 regressed=true → 本條紅 [契約 負 tolerance clamp]
{
  const r = computeRegression(rowsOf(1.0, 1.0), { tolerance: -0.1 });
  assert(r && r.regressed === false, 'computeRegression：負 tolerance clamp 到 0、持平 → regressed=false [CR-negtol-clamp]');
}

// ── CR-mixed-corpus（窄邊界）：corpus 欄有無混存 → 只比最後一筆 corpus 的同組，缺 corpus 欄者自成一組（undefined）不混入。
//    rows=[{A 1.0},{無欄 0.9},{A 0.8}] → 最後是 A：scoped=[A1.0, A0.8]、baseline 1.0、current 0.8 → regressed=true（中間缺欄 0.9 不混入）[契約 corpus 分組]
{
  const rows = [
    { corpus: 'A', passRate: 1.0 },
    { passRate: 0.9 },
    { corpus: 'A', passRate: 0.8 },
  ];
  const r = computeRegression(rows, { tolerance: 0 });
  assert(r && r.baselineRate === 1.0 && r.currentRate === 0.8, 'computeRegression：混 corpus 欄 → 只取最後 corpus(A) 同組、缺欄者不混入 [CR-mixed-corpus]');
  assert(r && r.regressed === true, 'computeRegression：A 0.8<1.0 → regressed=true [CR-mixed-corpus]');
}

// ── CR-baseline-oob（窄邊界）：--baseline 越界 index（scoped 僅 2 筆卻指 9）→ baselineRate 安全 fallback、不丟例外、regressed=false（無合法 baseline 不誤判退化）[契約 越界 graceful]
{
  const r = callSafe(() => computeRegression(rowsOf(1.0, 0.8), { baseline: 9, tolerance: 0 }));
  assert(!r.threw, 'computeRegression：baseline 越界 index 不丟例外 [CR-baseline-oob]');
  assert(r.val && r.val.regressed === false, 'computeRegression：baseline 越界 → 無合法 baseline、regressed=false（不誤判退化）[CR-baseline-oob]');
}

// ════════════════════════════════════════════════════════════════════════════
//  groupRowsByVersion(rows) -> { [versionKey]: row[] }（#51 契約3，新 export）—— 純函式 (unit)
//  非陣列 → {}；每 row 依其 versions 陣列「每個」version 各歸一桶（多 version → 出現於多桶）；
//  versions 缺欄 / 非陣列 / 空陣列 → '(none)' 桶（向後相容舊 row，不 crash、不丟棄）；
//  proto 安全：用 Object.create(null)，版本鍵 '__proto__' 不污染原型。
// ════════════════════════════════════════════════════════════════════════════

// ── GR-nonarray：非陣列輸入 → {} [契約3 非陣列防呆]
{
  for (const bad of [null, undefined, {}, 7, 'x']) {
    const r = callSafe(() => EM.groupRowsByVersion(bad));
    assert(!r.threw && r.val && typeof r.val === 'object' && !Array.isArray(r.val) && Object.keys(r.val).length === 0,
      `groupRowsByVersion：非陣列(${JSON.stringify(bad)}) → {} [GR-nonarray]`);
  }
}

// ── GR-multibucket：多 version 的 row 同時進多桶；單 version row 只在其桶 [契約3 每 version 各歸一桶]
{
  const r1 = { id: 'r1', versions: ['1.0'] };
  const r2 = { id: 'r2', versions: ['1.0', '1.1'] };
  const out = callSafe(() => EM.groupRowsByVersion([r1, r2]));
  assert(!out.threw && out.val, 'groupRowsByVersion：多 version rows 不丟例外 [GR-multibucket]');
  const g = out.val || {};
  assert(Array.isArray(g['1.0']) && g['1.0'].includes(r1) && g['1.0'].includes(r2),
    "groupRowsByVersion：'1.0' 桶含 r1 與 r2（多 version row 進多桶）[GR-multibucket]");
  assert(Array.isArray(g['1.1']) && g['1.1'].includes(r2) && !g['1.1'].includes(r1),
    "groupRowsByVersion：'1.1' 桶只含 r2 [GR-multibucket]");
}

// ── GR-none（向後相容）：versions 缺欄 / 非陣列 / 空陣列 → 全歸 '(none)' 桶，不丟不丟棄（模擬舊 jsonl row）[契約3 向後相容]
{
  const noField = { id: 'a' };               // 舊 eval-results.jsonl row：無 versions 欄
  const nonArr = { id: 'b', versions: null };
  const empty = { id: 'c', versions: [] };
  const out = callSafe(() => EM.groupRowsByVersion([noField, nonArr, empty]));
  assert(!out.threw, 'groupRowsByVersion：舊 row（無/非陣列/空 versions）不丟例外 [GR-none]');
  const none = (out.val || {})['(none)'] || [];
  assert(none.includes(noField) && none.includes(nonArr) && none.includes(empty),
    "groupRowsByVersion：versions 缺/非陣列/空 → 全歸 '(none)' 桶（舊 row 不丟棄）[GR-none]");
}

// ── GR-proto（proto 安全）：版本鍵 '__proto__' 不污染原型；結果為 Object.create(null) [契約3 proto 安全]
{
  const row = { id: 'p', versions: ['__proto__'] };
  const out = callSafe(() => EM.groupRowsByVersion([row]));
  assert(!out.threw && out.val, "groupRowsByVersion：版本鍵 '__proto__' 不丟例外 [GR-proto]");
  const g = out.val || {};
  assert(Object.getPrototypeOf(g) === null,
    'groupRowsByVersion：結果為 Object.create(null)（null 原型）[GR-proto]');
  assert(Object.prototype.hasOwnProperty.call(g, '__proto__') && Array.isArray(g['__proto__']) && g['__proto__'].includes(row),
    "groupRowsByVersion：'__proto__' 成為自身屬性桶（含該 row），未污染原型鏈 [GR-proto]");
}

// ════════════════════════════════════════════════════════════════════════════
//  computeRegression 回歸不變（#51 契約4）—— row 多 versions 欄後，退化判定逐位元不變。
//  computeRegression 只讀 corpus/passRate；拿含 versions 與不含的同組 rows 比，結果須完全相同。
//  （此為相容守則 guard：正確實作下從一開始即綠，誤把 versions 接進退化判定才會轉紅。）
// ════════════════════════════════════════════════════════════════════════════

// ── CR-versions-invariant：含 versions vs 不含 versions 同組 rows → regressed/delta/baseline/current 逐位元相同 [契約4 回歸不變]
{
  const withV = [
    { corpus: 'A', passRate: 1.0, versions: ['1.0'] },
    { corpus: 'A', passRate: 0.8, versions: ['1.1', '1.2'] },
  ];
  const withoutV = [
    { corpus: 'A', passRate: 1.0 },
    { corpus: 'A', passRate: 0.8 },
  ];
  const a = computeRegression(withV, { tolerance: 0 });
  const b = computeRegression(withoutV, { tolerance: 0 });
  assert(a && b && a.regressed === b.regressed, 'computeRegression：versions 欄不影響 regressed [CR-versions-invariant]');
  assert(a && b && a.delta === b.delta, 'computeRegression：versions 欄不影響 delta（逐位元）[CR-versions-invariant]');
  assert(a && b && a.baselineRate === b.baselineRate && a.currentRate === b.currentRate,
    'computeRegression：versions 欄不影響 baselineRate/currentRate [CR-versions-invariant]');
  assert(a && a.regressed === true && near(a.delta, -0.2),
    'computeRegression：含 versions 的 [1.0→0.8] 仍 regressed=true、delta≈-0.2（語意一致）[CR-versions-invariant]');
}

// ════════════════════════════════════════════════════════════════════════════
//  e2e smoke —— 真 spawn `scripts/eval-metrics.mjs`（cwd = plugin root），驗檔案最終狀態 / exit code。
//  record：跑 committed 語料庫 evals/build（5/5）→ 寫一行 metric row。
//  為避免污染 plugin repo，一律以 --metrics-file <暫存路徑> 指定輸出檔，跑完 rmSync 清掉。
// ════════════════════════════════════════════════════════════════════════════
function runMetrics(args) {
  return spawnSync(process.execPath, ['scripts/eval-metrics.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120000,
  });
}
function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((ln) => {
    try {
      return JSON.parse(ln);
    } catch {
      return null;
    }
  });
}

// ── E-record：record --dir evals/build --metrics-file <tmp> → 多一行、可 parse、passRate=1、total=5 [契約 record]
{
  const dir = mkdtempSync(join(tmpdir(), 'em-record-'));
  const metricsFile = join(dir, 'eval-results.jsonl');
  try {
    const res = runMetrics(['record', '--dir', 'evals/build', '--metrics-file', metricsFile]);
    assert(res.error == null, 'E-record：node 啟動成功（spawn 無 error）[E-record]');
    assert(res.status === 0, 'E-record：通過語料庫 record → exit 0 [E-record]');
    assert(existsSync(metricsFile), 'E-record：寫出 --metrics-file 指定的 eval-results.jsonl [E-record]');
    const rows = readJsonl(metricsFile);
    assert(rows.length === 1, 'E-record：一次 record → 檔內恰 1 行 [E-record]');
    const row = rows[0];
    assert(row && typeof row === 'object', 'E-record：該行 JSON.parse 成功 [E-record]');
    assert(row && row.total === 5, 'E-record：committed evals/build → total===5 [E-record]');
    assert(row && row.passRate === 1, 'E-record：committed 語料庫 5/5 → passRate===1 [E-record]');
    assert(row && row.passed === 5, 'E-record：passed===5 [E-record]');
    assert(row && row.errored === 0, 'E-record：5/5 全綠 → errored===0 [E-record]');
    // committed corpus：5 task 中僅 b1-add.json 帶 version:"1.0"，其餘 4 task 無 version。
    // summarizeVersions 去重 → ['1.0']。此條釘整條 oracle report → buildEvalRow → 落盤 鏈
    // 真把 corpus 的 version 攤進 row.versions（鏈中任一環沒帶過 version 就會紅）。
    assert(JSON.stringify(row && row.versions) === JSON.stringify(['1.0']),
      'E-record：record 把 corpus 真實 version 寫進 row.versions（整條 oracle passthrough→buildEvalRow→落盤鏈）[E-record]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── E-record-append：同一 --metrics-file 連跑兩次 → 累積 2 行（append 非覆寫；writeFileSync 只會剩 1 行 → 紅）[契約 record append]
{
  const dir = mkdtempSync(join(tmpdir(), 'em-append-'));
  const metricsFile = join(dir, 'eval-results.jsonl');
  try {
    const r1 = runMetrics(['record', '--dir', 'evals/build', '--metrics-file', metricsFile]);
    const r2 = runMetrics(['record', '--dir', 'evals/build', '--metrics-file', metricsFile]);
    assert(r1.status === 0 && r2.status === 0, 'E-record-append：連跑兩次皆 exit 0 [E-record-append]');
    const rows = readJsonl(metricsFile);
    assert(rows.length === 2, 'E-record-append：append 累積 → 2 行（覆寫式只會剩 1 行 → 紅）[E-record-append]');
    assert(rows.every((r) => r && typeof r === 'object'), 'E-record-append：兩行皆為合法 JSON [E-record-append]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── E-record-fail：record --dir 指向不存在的語料庫目錄 → 程序 exit 0（永不擋路）、但 stderr 非空（有診斷），
//    且 metrics 檔未被寫入垃圾（不存在或 0 行）[契約 record 失敗有診斷仍 exit 0]
{
  const dir = mkdtempSync(join(tmpdir(), 'em-record-fail-'));
  const missingCorpus = join(dir, 'no-such-corpus'); // 永不建立
  const metricsFile = join(dir, 'eval-results.jsonl');
  try {
    const res = runMetrics(['record', '--dir', missingCorpus, '--metrics-file', metricsFile]);
    assert(res.error == null, 'E-record-fail：node 啟動成功（spawn 無 error）[E-record-fail]');
    assert(res.status === 0, 'E-record-fail：record 失敗仍 exit 0（永不擋路）[E-record-fail]');
    assert((res.stderr || '').trim().length > 0, 'E-record-fail：失敗時 stderr 非空（有診斷）[E-record-fail]');
    assert(/skipped|oracle/.test(res.stderr || ''), 'E-record-fail：stderr 含關鍵診斷字（skipped/oracle）、非任意雜訊冒充 [E-record-fail]');
    assert(readJsonl(metricsFile).length === 0, 'E-record-fail：metrics 檔未被寫入垃圾（不存在或 0 行）[E-record-fail]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── E-check-regress：兩行 passRate 1.0 then 0.5 → check 偵測退化 → exit code===1 [契約 check]
{
  const dir = mkdtempSync(join(tmpdir(), 'em-check-red-'));
  const metricsFile = join(dir, 'eval-results.jsonl');
  try {
    writeFileSync(metricsFile, [
      JSON.stringify({ ts: 'T1', corpus: 'evals/build', schema: 1, runs: 1, total: 5, passed: 5, failed: 0, errored: 0, passRate: 1.0, passK: 1.0 }),
      JSON.stringify({ ts: 'T2', corpus: 'evals/build', schema: 1, runs: 1, total: 4, passed: 2, failed: 2, errored: 0, passRate: 0.5, passK: 0.5 }),
    ].join('\n') + '\n', 'utf8');
    const res = runMetrics(['check', '--metrics-file', metricsFile]);
    assert(res.error == null, 'E-check-regress：node 啟動成功 [E-check-regress]');
    assert(res.status === 1, 'E-check-regress：passRate 1.0→0.5 退化 → exit code===1（擋路）[E-check-regress]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── E-check-ok：兩行皆 passRate 1.0 → 無退化 → exit code===0 [契約 check]
{
  const dir = mkdtempSync(join(tmpdir(), 'em-check-green-'));
  const metricsFile = join(dir, 'eval-results.jsonl');
  try {
    writeFileSync(metricsFile, [
      JSON.stringify({ ts: 'T1', corpus: 'evals/build', schema: 1, runs: 1, total: 5, passed: 5, failed: 0, errored: 0, passRate: 1.0, passK: 1.0 }),
      JSON.stringify({ ts: 'T2', corpus: 'evals/build', schema: 1, runs: 1, total: 5, passed: 5, failed: 0, errored: 0, passRate: 1.0, passK: 1.0 }),
    ].join('\n') + '\n', 'utf8');
    const res = runMetrics(['check', '--metrics-file', metricsFile]);
    assert(res.status === 0, 'E-check-ok：兩行皆 1.0 無退化 → exit code===0 [E-check-ok]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── E-check-missing：--metrics-file 指向不存在檔 → exit code===0（永不擋路）[契約 check]
{
  const dir = mkdtempSync(join(tmpdir(), 'em-check-miss-'));
  const metricsFile = join(dir, 'no-such-eval-results.jsonl');
  try {
    const res = runMetrics(['check', '--metrics-file', metricsFile]);
    assert(res.error == null, 'E-check-missing：node 啟動成功（未崩在 spawn 層）[E-check-missing]');
    assert(res.status === 0, 'E-check-missing：metrics-file 不存在 → exit code===0（沒資料不退化、永不擋路）[E-check-missing]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── E-check-tolerance：手寫同 corpus 兩行 passRate 1.0→0.5（跌 0.5）→ check --tolerance 0.6 → exit 0。
//    若 CLI 沒把 --tolerance 接到 computeRegression（用預設 tol 0）→ 跌 0.5 會 exit 1 → 本條紅 [契約 CLI 接線 tolerance]
{
  const dir = mkdtempSync(join(tmpdir(), 'em-check-tol-'));
  const metricsFile = join(dir, 'eval-results.jsonl');
  try {
    writeFileSync(metricsFile, [
      JSON.stringify({ ts: 'T1', corpus: 'evals/build', schema: 1, runs: 1, total: 5, passed: 5, failed: 0, errored: 0, passRate: 1.0, passK: 1.0 }),
      JSON.stringify({ ts: 'T2', corpus: 'evals/build', schema: 1, runs: 1, total: 4, passed: 2, failed: 2, errored: 0, passRate: 0.5, passK: 0.5 }),
    ].join('\n') + '\n', 'utf8');
    const res = runMetrics(['check', '--metrics-file', metricsFile, '--tolerance', '0.6']);
    assert(res.error == null, 'E-check-tolerance：node 啟動成功 [E-check-tolerance]');
    assert(res.status === 0, 'E-check-tolerance：跌 0.5 < --tolerance 0.6 → exit 0（容忍度經 CLI 生效）[E-check-tolerance]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── E-check-baseline：手寫同 corpus 三行 passRate [1.0,0.5,0.95] → check --baseline 1 → exit 0。
//    baseline index 經 CLI 生效：baseline=rows[1]=0.5、current=0.95、0.95 不< 0.5 → 不退化。
//    若 CLI 沒接 --baseline（用預設 0）→ baseline=1.0、current=0.95 → 退化 exit 1 → 本條紅 [契約 CLI 接線 baseline]
{
  const dir = mkdtempSync(join(tmpdir(), 'em-check-base-'));
  const metricsFile = join(dir, 'eval-results.jsonl');
  try {
    writeFileSync(metricsFile, [
      JSON.stringify({ ts: 'T1', corpus: 'evals/build', schema: 1, runs: 1, total: 5, passed: 5, failed: 0, errored: 0, passRate: 1.0, passK: 1.0 }),
      JSON.stringify({ ts: 'T2', corpus: 'evals/build', schema: 1, runs: 1, total: 4, passed: 2, failed: 2, errored: 0, passRate: 0.5, passK: 0.5 }),
      JSON.stringify({ ts: 'T3', corpus: 'evals/build', schema: 1, runs: 1, total: 20, passed: 19, failed: 1, errored: 0, passRate: 0.95, passK: 0.95 }),
    ].join('\n') + '\n', 'utf8');
    const res = runMetrics(['check', '--metrics-file', metricsFile, '--baseline', '1']);
    assert(res.error == null, 'E-check-baseline：node 啟動成功 [E-check-baseline]');
    assert(res.status === 0, 'E-check-baseline：--baseline 1 → baseline=0.5、current=0.95、不退化 → exit 0 [E-check-baseline]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── E-misuse：CLI 誤用 → exit 2（與「資料缺/操作失敗 exit 0」明確區隔）。
//    record 不帶必要 --dir → status 2；未知命令 bogus → status 2 [契約 CLI 誤用]
{
  const noDir = runMetrics(['record']);
  assert(noDir.error == null, 'E-misuse：record 無 --dir node 啟動成功 [E-misuse]');
  assert(noDir.status === 2, 'E-misuse：record 缺必要 --dir → exit status===2（誤用）[E-misuse]');
  assert(/usage/i.test(noDir.stderr || ''), 'E-misuse：缺 --dir stderr 含 usage 提示（非任意雜訊）[E-misuse]');

  const bogus = runMetrics(['bogus']);
  assert(bogus.error == null, 'E-misuse：未知命令 node 啟動成功 [E-misuse]');
  assert(bogus.status === 2, 'E-misuse：未知命令 bogus → exit status===2（誤用）[E-misuse]');
  assert(/usage/i.test(bogus.stderr || ''), 'E-misuse：未知命令 stderr 含 usage 提示（非任意雜訊）[E-misuse]');
}

// ── 摘要 + exit code ─────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════
//  rotation —— rotateLines 純函式 + appendEvalRow 上限（避免 eval-results.jsonl 無界成長）。
// ════════════════════════════════════════════════════════════════════════════

// ── ROT-pure：rotateLines 保留最後 cap 行；cap<=0 / 未超過 / 恰等於 / 非陣列 邊界 ──
{
  assert(JSON.stringify(rotateLines(['a', 'b', 'c'], 2)) === JSON.stringify(['b', 'c']), 'rotateLines：超過 cap → 保留最後 cap 行 [ROT-pure]');
  assert(JSON.stringify(rotateLines(['a', 'b', 'c'], 3)) === JSON.stringify(['a', 'b', 'c']), 'rotateLines：恰等於 cap → 原樣不截 [ROT-pure]');
  assert(JSON.stringify(rotateLines(['a'], 5)) === JSON.stringify(['a']), 'rotateLines：未超過 cap → 原樣 [ROT-pure]');
  assert(JSON.stringify(rotateLines(['a', 'b'], 0)) === JSON.stringify(['a', 'b']), 'rotateLines：cap<=0 → 不 rotation [ROT-pure]');
  assert(JSON.stringify(rotateLines('not-array', 2)) === JSON.stringify([]), 'rotateLines：非陣列 → [] [ROT-pure]');
}

// ── ROT-e2e：appendEvalRow 以小 cap 連寫 5 行 → 檔只剩最後 cap 行、保留的是最後 N 筆、每行仍可 parse ──
{
  const dir = mkdtempSync(join(tmpdir(), 'em-rot-'));
  const file = join(dir, 'eval-results.jsonl');
  try {
    for (let i = 0; i < 5; i++) appendEvalRow(file, { corpus: 'R', seqno: i, passRate: 1.0 }, 3);
    const rows = readEvalRows(file);
    assert(rows.length === 3, 'ROT-e2e：cap=3 連寫 5 → 檔只剩 3 行（rotation 生效）[ROT-e2e]');
    assert(rows[0].seqno === 2 && rows[2].seqno === 4, 'ROT-e2e：保留的是最後 3 筆（seqno 2,3,4）[ROT-e2e]');
    assert(rows.every((r) => typeof r.seqno === 'number'), 'ROT-e2e：rotation 後每行仍是合法 JSON（可 parse）[ROT-e2e]');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── ROT-writefail：appendEvalRow 寫檔失敗（路徑為既有目錄）→ 不丟例外（catch 吞、永不擋路）[契約 寫檔容錯] ──
{
  const dir = mkdtempSync(join(tmpdir(), 'em-wf-'));
  try {
    const r = callSafe(() => appendEvalRow(dir, { corpus: 'W', passRate: 1.0 }, 3)); // file=目錄 → append/write 失敗
    assert(!r.threw, 'appendEvalRow：寫檔失敗（路徑為目錄）→ 不丟例外 [ROT-writefail]');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ════════════════════════════════════════════════════════════════════════════
//  CLI versions 子命令 smoke（#51 契約5）—— 真 spawn `scripts/eval-metrics.mjs versions`（薄 IO）。
//  寫含「部分帶 versions、部分不帶」的暫存 jsonl → versions → exit 0、stdout 含各 version 摘要 + '(none)'。
//  暫存檔放 os.tmpdir()、測完 rmSync 清掉（冪等）。
// ════════════════════════════════════════════════════════════════════════════

// ── E-versions：多筆 row（含/不含 versions）→ versions → exit 0；新 CLI 契約＝每行
//    `<version>  records <N>  avgPassRate <X>`（label 為 records 非 runs；avgPassRate 4 位小數），
//    且版本鍵升冪輸出、'(none)' 殿後。fixture 刻意「亂序寫入」（1.1 先於 1.0）讓排序斷言有 teeth [契約5 versions 摘要]
{
  const dir = mkdtempSync(join(tmpdir(), 'em-versions-'));
  const metricsFile = join(dir, 'eval-results.jsonl');
  try {
    // 可預測 fixture（每筆 runs:1，桶內 record 數 ≠ runs 欄值 → 驗 label 為 records）：
    //   1.0 桶 = rowB(1.0) + rowC(0.5) → records 2、avgPassRate (1.0+0.5)/2 = 0.7500
    //   1.1 桶 = rowA(1.0)            → records 1、avgPassRate 1.0000
    //   (none) 桶 = rowD(無 versions)  → records 1、avgPassRate 1.0000
    // 寫入序刻意亂（rowA=1.1 先、rowB/rowC=1.0 後、rowD=(none) 最後）：
    //   不排序的 impl（Object.keys 插入序）會印成 1.1 先於 1.0 → 排序斷言先紅。
    writeFileSync(metricsFile, [
      JSON.stringify({ ts: 'T1', corpus: 'evals/build', schema: 2, runs: 1, total: 5, passed: 5, failed: 0, errored: 0, passRate: 1.0, passK: 1.0, versions: ['1.1'] }), // rowA
      JSON.stringify({ ts: 'T2', corpus: 'evals/build', schema: 2, runs: 1, total: 5, passed: 5, failed: 0, errored: 0, passRate: 1.0, passK: 1.0, versions: ['1.0'] }), // rowB
      JSON.stringify({ ts: 'T3', corpus: 'evals/build', schema: 2, runs: 1, total: 4, passed: 2, failed: 2, errored: 0, passRate: 0.5, passK: 0.5, versions: ['1.0'] }), // rowC
      JSON.stringify({ ts: 'T4', corpus: 'evals/build', schema: 1, runs: 1, total: 5, passed: 5, failed: 0, errored: 0, passRate: 1.0, passK: 1.0 }), // rowD：舊 row 無 versions → (none)
    ].join('\n') + '\n', 'utf8');
    const res = runMetrics(['versions', '--metrics-file', metricsFile]);
    assert(res.error == null, 'E-versions：node 啟動成功（spawn 無 error）[E-versions]');
    assert(res.status === 0, 'E-versions：versions 子命令被識別 → exit 0（非未知命令 exit 2）[E-versions]');
    const out = res.stdout || '';
    assert(out.includes('1.0'), "E-versions：stdout 含版本 '1.0' 摘要 [E-versions]");
    assert(out.includes('1.1'), "E-versions：stdout 含版本 '1.1' 摘要 [E-versions]");
    assert(out.includes('(none)'), "E-versions：stdout 含 '(none)' 那組（舊無 versions row）[E-versions]");

    // 版本鍵在行首；用 \s 邊界避免把 avg 值裡的 '1.0000' 當成 '1.0' 行首誤吃。
    const lines = out.split('\n').map((l) => l.trim());
    const idx10 = lines.findIndex((l) => /^1\.0\s/.test(l));
    const idx11 = lines.findIndex((l) => /^1\.1\s/.test(l));
    const idxNone = lines.findIndex((l) => /^\(none\)\s/.test(l));
    const v10 = idx10 >= 0 ? lines[idx10] : '';

    // (1) label rename：1.0 桶含 2 record → 印 `records 2`（現 impl 印 `runs 2` → 先紅）
    assert(v10.includes('records 2'),
      "E-versions：'1.0' 桶印 records 2（label 由 runs 改 records；row 自身 runs 欄語意不同）[E-versions]");
    // (2) avgPassRate 數值：1.0 桶 (1.0+0.5)/2 = 0.7500（4 位小數）。改壞平均（錯分母/漏項/回 0）→ 紅
    assert(v10.includes('avgPassRate 0.7500'),
      "E-versions：'1.0' 桶 avgPassRate===0.7500（兩筆 1.0/0.5 平均、4 位小數）[E-versions]");
    // (3) 排序：版本鍵升冪、'(none)' 殿後（1.0 < 1.1 < (none)）。亂序寫入下不排序則紅
    assert(idx10 >= 0 && idx11 >= 0 && idxNone >= 0,
      'E-versions：三個版本桶摘要行皆出現於 stdout [E-versions]');
    assert(idx10 < idx11 && idx11 < idxNone,
      "E-versions：版本桶升冪輸出、'(none)' 殿後（1.0 < 1.1 < (none)）；亂序寫入(1.1 先) → 不排序則紅 [E-versions]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── E-versions-missing：--metrics-file 不存在 → exit 0 + 空摘要不炸（永不擋路）[契約5 缺檔 graceful]
{
  const dir = mkdtempSync(join(tmpdir(), 'em-versions-miss-'));
  const metricsFile = join(dir, 'no-such-eval-results.jsonl');
  try {
    const res = runMetrics(['versions', '--metrics-file', metricsFile]);
    assert(res.error == null, 'E-versions-missing：node 啟動成功 [E-versions-missing]');
    assert(res.status === 0, 'E-versions-missing：缺檔 → exit 0（空摘要不炸）[E-versions-missing]');
    assert(!(res.stdout || '').includes('1.0'), 'E-versions-missing：缺檔 → stdout 無版本資料（空摘要）[E-versions-missing]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
