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
import { join, resolve, dirname, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../scripts
const PROJECT_ROOT = dirname(HERE); // plugin root：workspace 的信任邊界（不得 spawn 到此之外）
const GATE_RAN_STATES = new Set(['passed', 'failed']); // 只有真的跑了該 suite 才採信
const GATE_DIAGNOSTIC_REASON = 'gate result unavailable (quality-gate returned no usable JSON) — tests unverified';

// ── 純函式層（無 IO，測試直接 import）─────────────────────────────────────────────

/**
 * 比對單一 task 的 oracle 與 quality-gate 結果 → 評分（positive-presence）。
 *
 * 判定規則（不變量）：
 * - gate 結果不可用（null / 非物件 / 帶 gateError 診斷）→ errored:true、pass:false，reason 帶診斷字串。
 * - gate 有跑 ＝ gateResult.gates.test ∈ {passed, failed}；否則（not-run / errored / 缺）
 *   → errored:true、pass:false（永不誤判為 pass，因為根本沒驗到）。
 * - 對每個 required 名，依「觀察到的證據」三分類（命中＝完全相等 或 titlePath 以 " > <名>" 結尾）：
 *     inFailed（命中某 kind==='test' failure 的 titlePath）→ 入該組 missing（合法失敗）。
 *     inPassed（命中 gateResult.passedTests 某 titlePath）→ 入該組 passed。
 *     皆未命中（unobserved）→ 沒驗到，整 task errored（沒驗到永不當通過）。
 * - task pass ＝ gate 有跑 且 無任何 required unobserved 且 無任何 required 在 missing。
 *   reason 區分 errored（unobserved/未跑/結果不可用）與合法 fail（觀察到卻失敗）。
 */
export function scoreTask(gateResult, oracle) {
  const failToPassRequired = toNameList(oracle?.failToPass);
  const passToPassRequired = toNameList(oracle?.passToPass);

  // gate 結果整包不可用（spawn 失敗 / 非 JSON / null）→ graceful errored，reason 帶診斷（非泛用 missing）。
  if (!gateResult || typeof gateResult !== 'object') {
    return erroredResult(failToPassRequired, passToPassRequired, null, GATE_DIAGNOSTIC_REASON);
  }
  if (typeof gateResult.gateError === 'string' && gateResult.gateError.trim()) {
    return erroredResult(failToPassRequired, passToPassRequired, null, `gate result unavailable — ${gateResult.gateError}`);
  }

  // gate 沒真的跑該 suite → 無從驗證，一律 errored（不報綠），required 全列為未觀察。
  const gateStatus = gateResult.gates?.test;
  if (!GATE_RAN_STATES.has(gateStatus)) {
    return erroredResult(
      failToPassRequired,
      passToPassRequired,
      gateStatus ?? null,
      `gate did not run (test gate "${gateStatus ?? 'missing'}") — tests unverified`,
    );
  }

  // oracle 沒指定任何 required test（failToPass 與 passToPass 皆空，含 oracle 整個缺）→ 沒東西可驗，
  // 一律 errored：驗了零條測試不算通過，與「沒驗到永不當通過」同源。
  if (failToPassRequired.length === 0 && passToPassRequired.length === 0) {
    return erroredResult(
      failToPassRequired,
      passToPassRequired,
      gateStatus,
      'oracle specifies no required tests — nothing to verify',
    );
  }

  const failedTitlePaths = collectTestFailureTitlePaths(gateResult.failures);
  const passedTitlePaths = collectPassedTitlePaths(gateResult.passedTests);
  const failToPass = classifyRequired(failToPassRequired, passedTitlePaths, failedTitlePaths);
  const passToPass = classifyRequired(passToPassRequired, passedTitlePaths, failedTitlePaths);

  const errored = failToPass.unobserved.length > 0 || passToPass.unobserved.length > 0;
  const pass = !errored && failToPass.missing.length === 0 && passToPass.missing.length === 0;
  return {
    pass,
    errored,
    failToPass,
    passToPass,
    gateStatus,
    reason: describeOutcome({ pass, errored, failToPass, passToPass }),
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

/** quality-gate 的 passedTests＝通過 assertion 的 titlePath 清單（positive-presence 訊號）。 */
function collectPassedTitlePaths(passedTests) {
  return (Array.isArray(passedTests) ? passedTests : []).filter((s) => typeof s === 'string');
}

// 命中 ＝ 完全相等，或 titlePath 以 " > <名>" 結尾。卡 " > " 界線（非裸 endsWith 子字串）：
// 'math > checksum' 不可被名 'sum' 命中。failure 側與 passedTests 側用同一套界線。
function titlePathHits(titlePath, name) {
  return titlePath === name || titlePath.endsWith(` > ${name}`);
}

/**
 * 對 required 名單逐名做 positive-presence 三分類：
 *   inFailed → missing（觀察到卻失敗，合法 fail）；inPassed → passed（觀察到通過）；
 *   皆未命中 → unobserved（沒驗到，使整 task errored）。failed 優先於 passed（觀察到失敗即保守判失敗）。
 */
function classifyRequired(required, passedTitlePaths, failedTitlePaths) {
  const passed = [];
  const missing = [];
  const unobserved = [];
  for (const name of required) {
    if (failedTitlePaths.some((tp) => titlePathHits(tp, name))) missing.push(name);
    else if (passedTitlePaths.some((tp) => titlePathHits(tp, name))) passed.push(name);
    else unobserved.push(name);
  }
  return { required, passed, missing, unobserved };
}

/** gate 結果不可用 / 沒跑時的誠實視圖：沒驗到 ＝ 全部 unobserved（passed/missing 皆空）。 */
function unverified(required) {
  return { required, passed: [], missing: [], unobserved: [...required] };
}

/** 組一個 errored（gate 不可用 / 未跑）的 task 評分；required 全列 unobserved，pass=false。 */
function erroredResult(failToPassRequired, passToPassRequired, gateStatus, reason) {
  return {
    pass: false,
    errored: true,
    failToPass: unverified(failToPassRequired),
    passToPass: unverified(passToPassRequired),
    gateStatus,
    reason,
  };
}

/** reason 要能區分 errored（unobserved，沒驗到）與合法 fail（觀察到卻失敗）。 */
function describeOutcome({ pass, errored, failToPass, passToPass }) {
  if (pass) return 'all required tests passed';
  const parts = [];
  const unobserved = [...failToPass.unobserved, ...passToPass.unobserved];
  if (errored && unobserved.length) {
    parts.push(`required tests not observed in gate output (unverified) → ${unobserved.join(', ')}`);
  }
  const failed = [
    ...failToPass.missing.map((n) => `failToPass:${n}`),
    ...passToPass.missing.map((n) => `passToPass:${n}`),
  ];
  if (failed.length) parts.push(`unmet required tests → ${failed.join(', ')}`);
  return parts.join('; ') || 'task did not pass';
}

// ── IO 薄邊界：spawn quality-gate + CLI main（被 import 時不執行）─────────────────

/**
 * spawn 同目錄的 loops-quality-gate.mjs 跑單一 workspace → tolerant parse 其 --json stdout。
 * 非 0 退出（gate 紅）不丟例外（spawnSync 行為）。spawn 自身錯誤 / stdout 解不出 JSON →
 * 回帶 `gateError` 診斷字串的物件（含 res.error.message / 截尾 stderr），交給 scoreTask 判 errored
 * 並把診斷透傳到 reason（非僅泛用 missing），方便定位「gate 沒跑起來」vs「測試合法失敗」。
 */
export function spawnGate(workspaceAbsPath) {
  const gateScript = join(HERE, 'loops-quality-gate.mjs');
  const res = spawnSync('node', [gateScript, '--cwd', workspaceAbsPath, '--json'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) {
    return { gateError: `quality-gate failed to spawn: ${res.error.message}` };
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    const stderr = truncateTail(String(res.stderr ?? '').trim(), 500);
    return { gateError: `quality-gate produced no valid JSON${stderr ? ` (stderr: ${stderr})` : ''}` };
  }
}

function truncateTail(text, max) {
  return text.length > max ? `…${text.slice(text.length - max)}` : text;
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

// 評一個 task：解析 workspace（相對 tasks-dir，即 task 檔所在）→ containment 守門 → spawn gate → scoreTask。
// id/stage 透傳，供報告定位（行為評分全交給 scoreTask）。
function evaluateTask(task, tasksDir) {
  const requested = typeof task?.workspace === 'string' ? task.workspace : '.';
  const containment = resolveWorkspace(requested, tasksDir);
  if (!containment.ok) {
    // 越界 / 絕對路徑：直接 errored，不 spawn 到信任邊界外。
    return {
      id: task?.id,
      stage: task?.stage,
      ...erroredResult(toNameList(task?.oracle?.failToPass), toNameList(task?.oracle?.passToPass), null, containment.reason),
    };
  }
  const scored = scoreTask(spawnGate(containment.workspace), task?.oracle);
  return { id: task?.id, stage: task?.stage, ...scored };
}

/**
 * 解析並守門 workspace：相對 tasks-dir 解析後須落在 PROJECT_ROOT 內，否則拒絕（不 spawn）。
 * 絕對路徑型 workspace 一律拒絕（避免 task 檔指定任意磁碟位置）。
 */
function resolveWorkspace(requested, tasksDir) {
  if (isAbsolute(requested)) {
    return { ok: false, reason: `workspace "${requested}" is an absolute path (rejected; must stay inside project root) — not evaluated` };
  }
  const workspace = resolve(tasksDir, requested);
  if (!isInside(PROJECT_ROOT, workspace)) {
    return { ok: false, reason: `workspace "${requested}" resolves outside project root (path traversal / escape rejected) — not evaluated` };
  }
  return { ok: true, workspace };
}

/** target 是否在 base 之內（base 自身或其子路徑）。用平台 sep 卡界線，避免 prefix 假命中。 */
function isInside(base, target) {
  return target === base || target.startsWith(base + sep);
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
  const allTasks = loadTasks(tasksDir);
  const tasks = opts.task ? allTasks.filter((t) => t?.id === opts.task) : allTasks;
  // --task 命不中任何 id → 不可假成功（回空報告 exit0），明確報錯並非 0 退出。
  if (opts.task && tasks.length === 0) {
    console.error(`eval-oracle: no task matched --task "${opts.task}" in ${tasksDir}`);
    process.exit(2);
  }

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
