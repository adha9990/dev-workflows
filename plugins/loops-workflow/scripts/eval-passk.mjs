#!/usr/bin/env node
// eval-passk.mjs —— eval：live-candidate 真 pass^k（issue #36）。
//
// 混合 framing：本 script 只做**確定性 pass^k 計算**；「真跑 workflow 重生候選」屬**上層**
//   （主迴圈/Workflow，opt-in、協定見 evals/live/README-protocol.md、**script 不 spawn**）。
//
// pass^k＝隨機性下「連 k 次全綠」的可靠度，用**無偏估計** C(passed,k)/C(total,k)（一隨機 k-子集全綠的機率），
//   非 (passed/total)^k（後者假設獨立、小樣本偏差大）。Metric-Honesty：pass^k 為估算（N 有限）；
//   k>total 無法估計 → 誠實回 null + reason，不假裝。
//
// 分層（仿 eval 家族）：純函式 export + 薄 IO CLI（import.meta.url 守門）。依賴：僅 node 內建。
// 用法：node eval-passk.mjs passk --runs <runs.jsonl> --k <k>

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── 純函式 ───────────────────────────────────────────────────────────────────────

/** C(n,k)，乘法式（小 N 精確、避免大階乘溢位）+ Math.round 收浮點。k<0/k>n → 0。 */
export function combinations(n, k) {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < kk; i += 1) result = (result * (n - i)) / (i + 1);
  return Math.round(result);
}

/** pass@1＝平均成功率＝passed/total（守除零 → 0）。 */
export function passAt1(passed, total) {
  return Number.isFinite(total) && total > 0 ? passed / total : 0;
}

/**
 * pass^k 無偏估計 → { value:number|null, reason? }：
 *   total/k 非正整數 → null；k>total → null（無法估計、誠實不假裝）；passed<k → 0（湊不出 k 次通過）；
 *   否則 C(passed,k)/C(total,k)。
 */
export function passHatK(passed, total, k) {
  if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(k) || k <= 0) {
    return { value: null, reason: 'invalid total/k (need positive integers)' };
  }
  if (k > total) return { value: null, reason: `k (${k}) > total runs (${total}) — cannot estimate pass^k` };
  if (passed < k) return { value: 0, reason: `fewer than k passes (${passed} < ${k})` };
  return { value: combinations(passed, k) / combinations(total, k) };
}

/** 依 taskId 分組 N 跑 → per-task {total, passed, passAt1, passHatK} + 整體 {tasks, k, overallPassAt1}。只認 pass===true。 */
export function aggregateByTask(runs, { k = 2 } = {}) {
  const list = Array.isArray(runs) ? runs : [];
  const groups = new Map();
  for (const r of list) {
    const id = r?.taskId ?? null;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }
  let totalRuns = 0;
  let totalPassed = 0;
  const tasks = [];
  for (const [taskId, recs] of groups) {
    const total = recs.length;
    const p = recs.filter((r) => r?.pass === true).length;
    totalRuns += total;
    totalPassed += p;
    const hk = passHatK(p, total, k);
    tasks.push({
      taskId,
      total,
      passed: p,
      passAt1: passAt1(p, total),
      passHatK: hk.value,
      ...(hk.reason ? { passHatKReason: hk.reason } : {}),
    });
  }
  return { tasks, k, overallPassAt1: passAt1(totalPassed, totalRuns) };
}

// ── 薄 IO：CLI（被 import 時不執行）──────────────────────────────────────────────

const USAGE = [
  'usage:',
  '  node eval-passk.mjs passk --runs <runs.jsonl> --k <k>',
].join('\n');

function parseArgs(argv) {
  const opts = { runs: null, k: 2 };
  for (let i = 0; i < argv.length; i += 1) {
    const f = argv[i];
    if (f === '--runs') opts.runs = argv[++i] ?? null;
    else if (f === '--k') opts.k = Number.parseInt(argv[++i] ?? '', 10);
  }
  return opts;
}

/** tolerant 讀 jsonl：檔不存在 → throw（CLI 接住 exit 3）；單行壞 → 跳過並計數（揭露）。 */
function loadRuns(file) {
  const text = readFileSync(file, 'utf8');
  const runs = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { runs.push(JSON.parse(line)); } catch { skipped += 1; }
  }
  return { runs, skipped };
}

function cmdPassk(argv) {
  const opts = parseArgs(argv);
  if (!opts.runs) { console.error(USAGE); process.exit(2); }
  if (!Number.isInteger(opts.k) || opts.k <= 0) { console.error('passk: --k 須為正整數'); process.exit(2); }
  let loaded;
  try { loaded = loadRuns(resolve(opts.runs)); }
  catch (e) { console.error(`passk: runs 讀取失敗 ${opts.runs}: ${e?.message ?? e}`); process.exit(3); }
  console.log(JSON.stringify({
    ...aggregateByTask(loaded.runs, { k: opts.k }),
    loaded: loaded.runs.length,
    skipped: loaded.skipped,
    note: 'pass^k 為無偏估計（C(c,k)/C(N,k)）、隨機性下可靠度；候選重生由上層、本 script 不 spawn',
  }, null, 2));
  process.exit(0);
}

function main(argv) {
  const cmd = argv[0];
  if (cmd === 'passk') return cmdPassk(argv.slice(1));
  console.error(`unknown command: ${cmd ?? '(none)'}\n${USAGE}`);
  process.exit(2);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try { main(process.argv.slice(2)); }
  catch (err) { console.error(err?.message ?? String(err)); process.exit(3); }
}
