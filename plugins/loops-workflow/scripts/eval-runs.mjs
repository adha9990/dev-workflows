#!/usr/bin/env node
// eval-runs.mjs —— eval Phase 3：live-candidate orchestrator 的 spawn-oracle 膠水（issue #48）。
//
// 把 #36 候選協定接成可跑：spawn eval-oracle 評**當前候選 workspace** → 抽該 task pass → append 一行 run
//   `{taskId, pass, runIndex}` 到 runs.jsonl。recipe 每 task 重生 N 候選（覆寫 workspace）後各跑一次 record，
//   再用既有 `eval-passk.mjs` 算真 pass@1 + pass^k。
//
// 混合：**候選重生（覆寫 workspace）留上層 recipe**（`references/eval-live-candidate.md`、本 script 不重生、不 spawn workflow）；
//   本 script 只 spawn eval-oracle 收一行 run（仿 eval-metrics spawn eval-oracle）。
//
// infra 錯 vs 候選 fail 分清：oracle 取不到結果 / task 不在報告 → exit 3（不偽裝成 pass:false）；
//   task 在報告（pass 或 errored）→ append 一行 run（errored 候選＝pass:false 的合法失敗 run）。
//
// 分層（仿 eval 家族）：純函式 export + 薄 IO + import.meta.url 守門。依賴：僅 node 內建。
// 用法：node eval-runs.mjs record --dir <task-dir> --task <id> --runs-file <runs.jsonl> [--run-index <i>]

import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../scripts

// ── 純函式 ───────────────────────────────────────────────────────────────────────

/** 從 eval-oracle aggregate 抽該 task 的 run 結果 → {taskId, pass, errored, found}。task 不在報告 → found:false。 */
export function extractRunResult(oracleReport, taskId) {
  const tasks = Array.isArray(oracleReport?.tasks) ? oracleReport.tasks : null;
  if (!tasks) return { taskId, pass: false, errored: true, found: false };
  const t = tasks.find((x) => x?.id === taskId);
  if (!t) return { taskId, pass: false, errored: true, found: false };
  return { taskId, pass: t.pass === true, errored: t.errored === true, found: true };
}

/** 組一行 runs.jsonl（與 #36 schema 對齊）：pass 強制 boolean、runIndex 非整數 → null。 */
export function buildRunLine(taskId, pass, runIndex) {
  return { taskId, pass: !!pass, runIndex: Number.isInteger(runIndex) ? runIndex : null };
}

// ── 薄 IO ────────────────────────────────────────────────────────────────────────

/** spawn 同目錄 eval-oracle.mjs 評單一 task（當前 workspace 狀態）→ tolerant parse；失敗回 {oracleError}。 */
export function spawnOracle(taskDir, taskId) {
  const oracleScript = join(HERE, 'eval-oracle.mjs');
  const res = spawnSync(process.execPath, [oracleScript, '--dir', taskDir, '--task', taskId, '--json'], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) return { oracleError: `eval-oracle failed to spawn: ${res.error.message}` };
  try { return JSON.parse(res.stdout); }
  catch {
    const stderr = String(res.stderr ?? '').trim().slice(-500);
    return { oracleError: `eval-oracle produced no valid JSON${stderr ? ` (stderr: ${stderr})` : ''}` };
  }
}

export function appendRunLine(file, line) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(line)}\n`);
}

// ── CLI（被 import 時不執行）─────────────────────────────────────────────────────

const USAGE = [
  'usage:',
  '  node eval-runs.mjs record --dir <task-dir> --task <id> --runs-file <runs.jsonl> [--run-index <i>]',
  '  （spawn eval-oracle 評當前候選 workspace → append 一行 run；候選重生由上層 recipe）',
].join('\n');

function parseArgs(argv) {
  const opts = { dir: null, task: null, runsFile: null, runIndex: null };
  for (let i = 0; i < argv.length; i += 1) {
    const f = argv[i];
    if (f === '--dir') opts.dir = argv[++i] ?? null;
    else if (f === '--task') opts.task = argv[++i] ?? null;
    else if (f === '--runs-file') opts.runsFile = argv[++i] ?? null;
    else if (f === '--run-index') opts.runIndex = Number.parseInt(argv[++i] ?? '', 10);
  }
  return opts;
}

function cmdRecord(argv) {
  const opts = parseArgs(argv);
  if (!opts.dir || !opts.task || !opts.runsFile) { console.error(USAGE); process.exit(2); }
  const report = spawnOracle(resolve(opts.dir), opts.task);
  if (report?.oracleError) {
    console.error(`record: oracle 取不到結果 — ${report.oracleError}`);
    process.exit(3);
  }
  const rr = extractRunResult(report, opts.task);
  if (!rr.found) {
    console.error(`record: task "${opts.task}" 不在 oracle 報告（語料/任務 id 不符）— 不偽裝成 fail run`);
    process.exit(3);
  }
  const line = buildRunLine(opts.task, rr.pass, opts.runIndex);
  try { appendRunLine(resolve(opts.runsFile), line); }
  catch (e) { console.error(`record: append runs 失敗 ${opts.runsFile}: ${e?.message ?? e}`); process.exit(3); }
  console.log(JSON.stringify(line));
  process.exit(0);
}

function main(argv) {
  const cmd = argv[0];
  if (cmd === 'record') return cmdRecord(argv.slice(1));
  console.error(`unknown command: ${cmd ?? '(none)'}\n${USAGE}`);
  process.exit(2);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try { main(process.argv.slice(2)); }
  catch (err) { console.error(err?.message ?? String(err)); process.exit(3); }
}
