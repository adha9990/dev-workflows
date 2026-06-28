#!/usr/bin/env node
// test-eval-passk.mjs —— eval-passk.mjs 的紅綠斷言（自帶 harness）。
// 用法（cwd = plugins/loops-workflow）：node scripts/test-eval-passk.mjs

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { combinations, passAt1, passHatK, aggregateByTask } from './eval-passk.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'eval-passk.mjs');

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed.push(msg); console.error(`  ✗ ${msg}`); }
}
const approx = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;

// ── T1 combinations + passAt1 ───────────────────────────────────────────────────
{
  assert(combinations(5, 2) === 10 && combinations(4, 2) === 6 && combinations(3, 2) === 3,
    'combinations：C(5,2)=10 / C(4,2)=6 / C(3,2)=3 [T1]');
  assert(combinations(5, 0) === 1 && combinations(5, 5) === 1, 'combinations：k=0 / k=n → 1 [T1]');
  assert(combinations(5, 6) === 0 && combinations(5, -1) === 0, 'combinations：k>n / k<0 → 0 [T1]');
  assert(combinations(30, 15) === 155117520, 'combinations：大 N 數值穩定（C(30,15)）[T1]');

  assert(approx(passAt1(4, 5), 0.8) && passAt1(5, 5) === 1, 'passAt1：4/5=0.8 / 5/5=1 [T1]');
  assert(passAt1(0, 0) === 0, 'passAt1：除零守門 → 0 [T1]');
}

// ── T2 passHatK（無偏估計 C(c,k)/C(N,k)）─────────────────────────────────────────
{
  assert(approx(passHatK(5, 5, 2).value, 1), 'passHatK：5/5 k2 → 1（全綠可靠）[T2]');
  assert(approx(passHatK(4, 5, 2).value, 0.6), 'passHatK：4/5 k2 → 0.6（C(4,2)/C(5,2)）[T2]');
  assert(approx(passHatK(3, 5, 2).value, 0.3), 'passHatK：3/5 k2 → 0.3 [T2]');
  assert(passHatK(1, 5, 2).value === 0, 'passHatK：passed<k → 0 [T2]');
  const oob = passHatK(5, 5, 6);
  assert(oob.value === null && /k.*>.*total|cannot|無法/.test(oob.reason), 'passHatK：k>total → null + reason（不假裝）[T2]');
  assert(passHatK(5, 0, 2).value === null && passHatK(5, 5, 0).value === null,
    'passHatK：total/k 非正整數 → null [T2]');
  // 背離示範：pass@1=0.8 但 pass^2=0.6（平均沒退、可靠度卻掉）
  assert(passAt1(4, 5) > passHatK(4, 5, 2).value, 'passHatK：pass^k < pass@1（抓隨機性不穩）[T2]');
}

// ── T3 aggregateByTask ──────────────────────────────────────────────────────────
{
  const runs = [
    { taskId: 't1', pass: true }, { taskId: 't1', pass: true }, { taskId: 't1', pass: false },
    { taskId: 't1', pass: true }, { taskId: 't1', pass: true },
    { taskId: 't2', pass: true }, { taskId: 't2', pass: true },
  ];
  const agg = aggregateByTask(runs, { k: 2 });
  assert(agg.k === 2 && agg.tasks.length === 2, 'aggregateByTask：k + 2 task 分組 [T3]');
  const t1 = agg.tasks.find((t) => t.taskId === 't1');
  assert(t1.total === 5 && t1.passed === 4 && approx(t1.passAt1, 0.8) && approx(t1.passHatK, 0.6),
    'aggregateByTask：t1 4/5 → passAt1 0.8 passHatK 0.6 [T3]');
  const t2 = agg.tasks.find((t) => t.taskId === 't2');
  assert(t2.total === 2 && approx(t2.passHatK, 1), 'aggregateByTask：t2 2/2 k2 → passHatK 1 [T3]');
  assert(approx(agg.overallPassAt1, 6 / 7), 'aggregateByTask：overallPassAt1 = 6/7 [T3]');
}

// ── T4 CLI spawn smoke ──────────────────────────────────────────────────────────
function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}
{
  const dir = mkdtempSync(join(tmpdir(), 'evalpassk-'));
  const runsFile = join(dir, 'runs.jsonl');
  writeFileSync(runsFile, [
    '{"taskId":"t1","pass":true,"runIndex":0}',
    '{"taskId":"t1","pass":false,"runIndex":1}',
    'GARBAGE',
    '{"taskId":"t1","pass":true,"runIndex":2}',
  ].join('\n') + '\n');

  const res = run(['passk', '--runs', runsFile, '--k', '2']);
  let out = null; try { out = JSON.parse(res.stdout); } catch { /* leave null */ }
  assert(res.status === 0 && out && out.tasks.find((t) => t.taskId === 't1').total === 3,
    'CLI passk：exit 0 + per-task（壞行已跳）[T4]');
  assert(out && out.skipped === 1, 'CLI passk：揭露 skipped 壞行數 [T4]');
  assert(run(['passk', '--k', '2']).status === 2, 'CLI passk：缺 --runs → exit 2 [T4]');
  assert(run(['passk', '--runs', runsFile, '--k', '0']).status === 2, 'CLI passk：k 非正整數 → exit 2 [T4]');
  assert(run(['bogus']).status === 2, 'CLI：未知命令 → exit 2 [T4]');
  assert(run(['passk', '--runs', join(dir, 'nope.jsonl'), '--k', '2']).status === 3, 'CLI passk：讀檔失敗 → exit 3 [T4]');
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.error('FAILED:\n' + failed.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
