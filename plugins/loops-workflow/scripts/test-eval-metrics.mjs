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

import { buildEvalRow, readEvalRows, parseEvalRows, computeRegression } from './eval-metrics.mjs';

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
  assert(row && row.schema === 1, 'buildEvalRow：schema===1（常數）[R-allpass/(a)]');
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
//    rows=[A1.0, B0.5, A0.95]、tol0 → 只取 A：baseline=A 首筆 1.0、current=A 末筆 0.95 → regressed=true；
//    中間 B 的 0.5 不得當 baseline/current（若用「整體前一行」當 baseline 會撈到 B 的 0.5 → baselineRate 變 0.5 → 本條紅）[契約 corpus-aware 回歸比較]
{
  const rows = [
    { corpus: 'A', passRate: 1.0 },
    { corpus: 'B', passRate: 0.5 },
    { corpus: 'A', passRate: 0.95 },
  ];
  const r = computeRegression(rows, { tolerance: 0 });
  assert(r && r.baselineRate === 1.0, 'computeRegression：baseline 取最後 corpus(A) 的首筆=1.0（非中間 B 的 0.5）[CR-corpus]');
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

  const bogus = runMetrics(['bogus']);
  assert(bogus.error == null, 'E-misuse：未知命令 node 啟動成功 [E-misuse]');
  assert(bogus.status === 2, 'E-misuse：未知命令 bogus → exit status===2（誤用）[E-misuse]');
}

// ── 摘要 + exit code ─────────────────────────────────────────────────────────
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
