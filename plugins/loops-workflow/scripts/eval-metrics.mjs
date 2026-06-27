#!/usr/bin/env node
// eval-metrics.mjs —— eval 結果聚合 + 退化閘門（issue #28）。把 eval-oracle.mjs 的 --json
// aggregate report 攤平成一行 metric row、append 進 JSONL 歷史，並比對歷史判定 passRate 是否退化。
//
// 分層（仿 hooks/cost-tracker.mjs、scripts/eval-oracle.mjs）：
//   1) 純函式（無 IO，測試直接 import）：buildEvalRow / readEvalRows / computeRegression。
//   2) IO 薄邊界：appendEvalRow（append JSONL）與 CLI main（spawn oracle / 讀寫 metrics 檔）——
//      被 import 時不執行（import.meta.url 守門）。
//
// 安全 / 永不擋路：record / check 遇 spawn 失敗、JSON 壞、檔讀不到一律不丟例外；
//   check 只在「真的算出退化」時 exit 1，其餘 exit 0；CLI 誤用（未知命令 / 缺 --dir）exit 2。
// 依賴：僅 node 內建（fs / path / url / child_process），零外部套件。
// 用法：
//   node eval-metrics.mjs record --dir <corpus> [--metrics-file <path>]
//   node eval-metrics.mjs check [--metrics-file <path>] [--baseline <n>] [--tolerance <Δ>]

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../scripts —— 解析同目錄的 eval-oracle.mjs
const SCHEMA_VERSION = 1; // metric row schema 版本（常數，隨格式演進才升）
const MAX_ORACLE_STDOUT = 16 * 1024 * 1024; // oracle --json 報告上限，避免無上限緩衝
const DEFAULT_METRICS_PATH = ['.loops', '.metrics', 'eval-results.jsonl']; // 相對 cwd 的預設歷史檔
const USAGE = [
  'usage:',
  '  node eval-metrics.mjs record --dir <corpus> [--metrics-file <path>]',
  '  node eval-metrics.mjs check [--metrics-file <path>] [--baseline <n>] [--tolerance <Δ>]',
].join('\n');

const EXIT_OK = 0; // 成功 / 無退化 / 無事可做
const EXIT_REGRESSED = 1; // 僅 check：真的算出退化（唯一會擋路的退出碼）
const EXIT_USAGE = 2; // CLI 誤用（未知命令 / 缺必填旗標）

// ── 純函式層（無 IO，測試直接 import）─────────────────────────────────────────────

/**
 * 把 oracle aggregate report（{ total, passed, failed, tasks:[{ errored }] }）攤平成一行 metric row。
 * passRate 守除零：total<=0 → 0（不可 NaN / Infinity）；passK＝passRate（MVP 確定性）；
 * errored 來自 tasks 旗標計數（非由 failed-passed 反推）；缺欄 / 非有限數一律退回 0。
 */
export function buildEvalRow(aggregate, { corpus, ts, runs = 1 } = {}) {
  const total = toFiniteNumber(aggregate?.total, 0);
  const passed = toFiniteNumber(aggregate?.passed, 0);
  const failed = toFiniteNumber(aggregate?.failed, 0);
  const passRate = total > 0 ? passed / total : 0;
  return {
    ts,
    corpus,
    schema: SCHEMA_VERSION,
    runs,
    total,
    passed,
    failed,
    errored: countErroredTasks(aggregate?.tasks),
    passRate,
    passK: passRate,
  };
}

/**
 * 純函式：把 JSONL 字串逐行解析成 row 陣列。tolerant：壞行逐行跳過、空字串 → []、永不丟例外。
 * 不碰檔案（IO 留給 readEvalRows）；比照 cost-tracker sumUsageFromTranscript(content) 的純解析拆法。
 */
export function parseEvalRows(content) {
  const rows = [];
  for (const line of String(content ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      continue; // 壞行跳過，後續合法行照常解析
    }
  }
  return rows;
}

/**
 * 讀 JSONL 歷史檔成 row 陣列。薄 reader：檔不存在 / 讀不到回 []（沒資料不等於錯誤），
 * 解析委派 parseEvalRows（純函式，承襲壞行跳過、永不丟）。
 */
export function readEvalRows(file) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return []; // 檔不存在 / 讀不到 → 空歷史（沒資料不等於錯誤）
  }
  return parseEvalRows(content);
}

/**
 * 退化判定（corpus-aware）：只在「最後一筆的 corpus」歷史子集內比，跨 corpus 不混比，
 * 避免不同語料庫的 passRate 互相當 baseline。scoped＝最後一筆 corpus 的所有 row；
 * baseline row＝scoped[baseline]（預設 0）、current＝scoped 末筆；delta＝currentRate - baselineRate；
 * regressed＝currentRate < baselineRate - tolerance（嚴格小於，恰等於 tolerance 不算退化）。
 * tolerance 夾到 ≥ 0（負值收緊門檻會誤判持平為退化）。該 corpus 不足兩筆 → regressed:false（沒得比）。
 * 無 corpus 欄的舊資料（corpus 皆 undefined）會 collapse 成同一組，行為與整體比較一致。
 */
export function computeRegression(rows, { baseline = 0, tolerance = 0 } = {}) {
  const history = Array.isArray(rows) ? rows : [];
  const targetCorpus = history[history.length - 1]?.corpus;
  const scoped = history.filter((row) => row?.corpus === targetCorpus);
  const safeTolerance = Math.max(0, tolerance); // 負 tolerance 會把門檻收到 baseline 之上 → 夾到 0

  const baselineRate = passRateOf(scoped[baseline]);
  const currentRate = passRateOf(scoped[scoped.length - 1]);
  const delta = currentRate - baselineRate;

  if (scoped.length < 2) {
    return { regressed: false, currentRate, baselineRate, delta, reason: 'insufficient history (need at least 2 records for this corpus) — no comparison' };
  }

  const regressed = currentRate < baselineRate - safeTolerance;
  return { regressed, currentRate, baselineRate, delta, reason: describeRegression({ regressed, baselineRate, currentRate, delta, tolerance: safeTolerance }) };
}

// ── 純函式的內部小工具 ──────────────────────────────────────────────────────────

/** 把任意值安全轉成有限數；NaN / Infinity / 非數字 → fallback。守住下游不被髒值污染。 */
function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** tasks 中 errored===true 的筆數；非陣列 → 0。 */
function countErroredTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  return list.filter((task) => task?.errored === true).length;
}

/** 取一筆 row 的 passRate（有限數），缺 / 髒 → 0。 */
function passRateOf(row) {
  return toFiniteNumber(row?.passRate, 0);
}

/** 人類可讀的退化原因（delta 顯示用四位小數修飾；回傳物件的 delta 仍是原始值）。 */
function describeRegression({ regressed, baselineRate, currentRate, delta, tolerance }) {
  const trend = `passRate ${baselineRate} -> ${currentRate} (Δ ${delta.toFixed(4)}, tolerance ${tolerance})`;
  return regressed ? `regression: ${trend}` : `within tolerance: ${trend}`;
}

// ── IO 薄邊界（被 import 時不執行）────────────────────────────────────────────────

/**
 * append 一行 JSON（+ \n）進 JSONL 檔，必要時建立父目錄。比照 cost-tracker append idiom。
 * 寫檔失敗（權限 / 磁碟 / 路徑）→ 出聲診斷但不丟例外：記錄動作非 gate，永不擋路（≠ 永不出聲）。
 */
export function appendEvalRow(file, row) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(row)}\n`);
  } catch (err) {
    console.error(`eval-metrics: failed to append metric row to "${file}" — ${err?.message ?? err}`);
  }
}

/** spawn 同目錄 eval-oracle.mjs 跑語料庫 → tolerant parse 其 --json aggregate；失敗回 null（不丟）。 */
function runOracle(corpusDir) {
  const oracleScript = join(HERE, 'eval-oracle.mjs');
  const res = spawnSync(process.execPath, [oracleScript, '--dir', corpusDir, '--json'], {
    encoding: 'utf8',
    maxBuffer: MAX_ORACLE_STDOUT,
  });
  if (res.error) return null; // spawn 自身失敗（找不到 node / 權限）→ 不記錄、不擋路
  try {
    return JSON.parse(res.stdout); // 非 0 退出（有 task 失敗）仍會印 JSON，照常採用
  } catch {
    return null; // oracle 沒給合法 JSON → 不記錄
  }
}

function resolveMetricsFile(metricsFile) {
  return metricsFile ?? join(process.cwd(), ...DEFAULT_METRICS_PATH);
}

/** record：跑語料庫 → 攤平成 row → append 進歷史檔。記錄動作非 gate，恆 exit 0。 */
function runRecord(opts) {
  if (!opts.dir) {
    console.error(`record requires --dir <corpus>\n${USAGE}`);
    return EXIT_USAGE;
  }
  const aggregate = runOracle(opts.dir);
  if (!aggregate) {
    // oracle 跑不起來 / 結果不可用 → 不寫垃圾進 metrics，但永不擋路（出聲診斷、仍 exit 0）。
    console.error(`eval-metrics: record skipped — oracle produced no usable report for --dir "${opts.dir}"`);
    return EXIT_OK;
  }
  const row = buildEvalRow(aggregate, { corpus: opts.dir, ts: new Date().toISOString() });
  appendEvalRow(resolveMetricsFile(opts.metricsFile), row);
  return EXIT_OK;
}

/** check：讀歷史 → 算退化 → 退化印訊息 + exit 1，否則 exit 0。沒資料 / 讀不到視為無退化。 */
function runCheck(opts) {
  const rows = readEvalRows(resolveMetricsFile(opts.metricsFile));
  const result = computeRegression(rows, { baseline: opts.baseline, tolerance: opts.tolerance });
  if (result.regressed) {
    console.error(`eval-metrics: regression detected — ${result.reason}`);
    return EXIT_REGRESSED;
  }
  console.log(`eval-metrics: ${result.reason}`);
  return EXIT_OK;
}

function parseArgs(argv) {
  const opts = { command: argv[0] ?? null, dir: null, metricsFile: null, baseline: 0, tolerance: 0 };
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dir') opts.dir = argv[++i] ?? null;
    // --metrics-file 是檔案路徑：參數來自可信 operator/CI；勿接不可信輸入。
    else if (flag === '--metrics-file') opts.metricsFile = argv[++i] ?? null;
    else if (flag === '--baseline') opts.baseline = Math.trunc(toFiniteNumber(argv[++i], 0));
    else if (flag === '--tolerance') opts.tolerance = toFiniteNumber(argv[++i], 0);
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.command === 'record') return runRecord(opts);
  if (opts.command === 'check') return runCheck(opts);
  console.error(`unknown command "${opts.command ?? ''}"\n${USAGE}`);
  return EXIT_USAGE;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  let exitCode = EXIT_OK;
  try {
    exitCode = main(process.argv.slice(2));
  } catch {
    exitCode = EXIT_OK; // 永不因未預期例外擋路（gate 安全：只有真的算出退化才回 1）
  }
  process.exit(exitCode);
}
