#!/usr/bin/env node
// eval-oracle.mjs —— 確定性 oracle 評分引擎（issue #27）。把「一個候選 workspace」透過既有
// scripts/loops-quality-gate.mjs（不重造 oracle）取得結構化 gate 結果，比對 task 的
// failToPass / passToPass test 清單 → 算 pass/fail。SWE-bench 式：FAIL_TO_PASS（改後該綠）+
// PASS_TO_PASS（既有綠不准轉紅）。**永不把「沒驗到」誤判為通過。**
//
// 分層（仿 scripts/loops-quality-gate.mjs、hooks/cost-tracker.mjs）：
//   1) 純函式（無 IO，測試直接 import）：scoreTask / loadTasks / buildReport。
//      （loadTasks 讀檔屬薄 IO，但語意是純資料轉換，無副作用、無外部行程。）
//   2) IO 薄邊界：spawnGate（spawn quality-gate 子行程）與 CLI main —— 被 import 時不執行
//      （import.meta.url 守門）。
// 安全：runner **不收 task 自帶 shell 命令**，oracle 一律走 loops-quality-gate.mjs（避免注入面）。
// 依賴：僅 node 內建（fs / path / url / child_process），零外部套件。
// 用法：node eval-oracle.mjs --dir <tasks-dir> [--task <id>] [--json]

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../scripts
const GATE_RAN_STATES = new Set(['passed', 'failed']); // 只有真的跑了該 suite 才採信

// ── 純函式層（無 IO，測試直接 import）─────────────────────────────────────────────

/**
 * 比對單一 task 的 oracle 與 quality-gate 結果 → 評分。
 *
 * 判定規則（不變量）：
 * - gate 有跑 ＝ gateResult.gates.test ∈ {passed, failed}；否則（not-run / errored / 缺）
 *   → errored:true、pass:false（永不誤判為 pass，因為根本沒驗到）。
 * - 某 test 名「pass」＝ failures 中**無任何 kind==='test'** 的 failure 其 titlePath 命中該名。
 *   titlePath ＝ failure.message 第一行（split('\n')[0]）；命中 ＝ 完全相等 **或**
 *   titlePath 以 " > <名>" 結尾（容許 oracle 只寫 leaf title）。
 * - task pass ＝ gate 有跑 且 failToPass.missing 空 且 passToPass.missing 空（與整體 gate 狀態解耦）。
 */
export function scoreTask(gateResult, oracle) {
  const gateStatus = gateResult?.gates?.test;
  const failToPassRequired = toNameList(oracle?.failToPass);
  const passToPassRequired = toNameList(oracle?.passToPass);

  // gate 沒真的跑該 suite → 無從驗證，一律 errored（不報綠），required 全列為未達成。
  if (!GATE_RAN_STATES.has(gateStatus)) {
    return {
      pass: false,
      errored: true,
      failToPass: unverified(failToPassRequired),
      passToPass: unverified(passToPassRequired),
      gateStatus: gateStatus ?? null,
      reason: `gate did not run (test gate "${gateStatus ?? 'missing'}") — tests unverified`,
    };
  }

  const failedTitlePaths = collectTestFailureTitlePaths(gateResult?.failures);
  const failToPass = classifyRequired(failToPassRequired, failedTitlePaths);
  const passToPass = classifyRequired(passToPassRequired, failedTitlePaths);

  const pass = failToPass.missing.length === 0 && passToPass.missing.length === 0;
  return {
    pass,
    errored: false,
    failToPass,
    passToPass,
    gateStatus,
    reason: pass ? 'all required tests passed' : describeMissing(failToPass, passToPass),
  };
}

/**
 * 讀 dir 下所有 *.json（非 .json 一律忽略；子目錄不遞迴）→ 解析成 task 物件陣列。
 * malformed JSON → throw 且訊息帶該檔名（讓壞檔可被定位，而非靜默吞掉）。
 */
export function loadTasks(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.json'))
    .map((d) => d.name)
    .sort(); // 穩定順序 → 輸出可重現

  return entries.map((name) => {
    const raw = readFileSync(join(dir, name), 'utf8');
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`loadTasks: invalid JSON in ${name}: ${err?.message ?? err}`);
    }
  });
}

/** 聚合 per-task results → { total, passed, failed, tasks }；passed＝pass===true 數，errored 算 failed。 */
export function buildReport(results) {
  const tasks = Array.isArray(results) ? results : [];
  const passed = tasks.filter((r) => r?.pass === true).length;
  return { total: tasks.length, passed, failed: tasks.length - passed, tasks };
}

// ── 純函式的內部小工具 ──────────────────────────────────────────────────────────

function toNameList(value) {
  return Array.isArray(value) ? value.filter((s) => typeof s === 'string') : [];
}

/** 只取 kind==='test' 的 failure，把每筆 message 第一行當 titlePath（非 test 類撞名不算數）。 */
function collectTestFailureTitlePaths(failures) {
  const list = Array.isArray(failures) ? failures : [];
  return list
    .filter((f) => f?.kind === 'test')
    .map((f) => String(f?.message ?? '').split('\n')[0]);
}

// 命中 ＝ 完全相等，或 titlePath 以 " > <名>" 結尾。卡 " > " 界線（非裸 endsWith 子字串）：
// 'math > checksum' 不可被名 'sum' 命中。
function titlePathHits(titlePath, name) {
  return titlePath === name || titlePath.endsWith(` > ${name}`);
}

/** 對 required 名單，逐名判斷是否被 test failure 命中 → 命中入 missing、否則入 passed。 */
function classifyRequired(required, failedTitlePaths) {
  const passed = [];
  const missing = [];
  for (const name of required) {
    if (failedTitlePaths.some((tp) => titlePathHits(tp, name))) missing.push(name);
    else passed.push(name);
  }
  return { required, passed, missing };
}

/** gate 沒跑時的誠實視圖：沒驗到 ＝ 全部未達成（passed 空、missing＝required）。 */
function unverified(required) {
  return { required, passed: [], missing: [...required] };
}

function describeMissing(failToPass, passToPass) {
  const parts = [
    ...failToPass.missing.map((n) => `failToPass:${n}`),
    ...passToPass.missing.map((n) => `passToPass:${n}`),
  ];
  return `unmet required tests → ${parts.join(', ')}`;
}

// ── IO 薄邊界：spawn quality-gate + CLI main（被 import 時不執行）─────────────────

/**
 * spawn 同目錄的 loops-quality-gate.mjs 跑單一 workspace → tolerant parse 其 --json stdout。
 * 非 0 退出（gate 紅）不丟例外（spawnSync 行為）；stdout 解不出 JSON → 回 null，
 * 交給 scoreTask 判為 errored（不報綠）。
 */
export function spawnGate(workspaceAbsPath) {
  const gateScript = join(HERE, 'loops-quality-gate.mjs');
  const res = spawnSync('node', [gateScript, '--cwd', workspaceAbsPath, '--json'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null; // gate 沒吐合法 JSON → 視為未驗到
  }
}

function parseArgs(argv) {
  const opts = { dir: null, task: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dir') opts.dir = argv[++i] ?? null;
    else if (flag === '--task') opts.task = argv[++i] ?? null;
    else if (flag === '--json') opts.json = true;
  }
  return opts;
}

// 評一個 task：解析 workspace（相對 tasks-dir，即 task 檔所在）→ spawn gate → scoreTask。
// id/stage 透傳，供報告定位（行為評分全交給 scoreTask）。
function evaluateTask(task, tasksDir) {
  const workspace = resolve(tasksDir, task?.workspace ?? '.');
  const scored = scoreTask(spawnGate(workspace), task?.oracle);
  return { id: task?.id, stage: task?.stage, ...scored };
}

function formatTextReport(report) {
  const lines = [`eval-oracle: ${report.passed}/${report.total} passed (${report.failed} failed)`];
  for (const t of report.tasks) {
    const mark = t.pass ? '✓' : t.errored ? '⚠' : '✗';
    lines.push(`  ${mark} ${t.id ?? '(no id)'} [${t.gateStatus ?? 'n/a'}] ${t.reason}`);
  }
  return lines.join('\n');
}

function main(rawArgv) {
  const opts = parseArgs(rawArgv);
  if (!opts.dir) {
    console.error('usage: node eval-oracle.mjs --dir <tasks-dir> [--task <id>] [--json]');
    process.exit(1);
  }

  const tasksDir = resolve(opts.dir);
  const tasks = loadTasks(tasksDir).filter((t) => !opts.task || t?.id === opts.task);
  const results = tasks.map((task) => evaluateTask(task, tasksDir));
  const report = buildReport(results);

  console.log(opts.json ? JSON.stringify(report, null, 2) : formatTextReport(report));
  process.exit(report.failed > 0 ? 1 : 0);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err?.message ?? String(err));
    process.exit(1);
  }
}
