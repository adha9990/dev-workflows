#!/usr/bin/env node
// test-eval-runs.mjs —— eval-runs.mjs 的紅綠斷言（自帶 harness）。
// 用法（cwd = plugins/loops-workflow）：node scripts/test-eval-runs.mjs

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { extractRunResult, buildRunLine } from './eval-runs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../scripts
const ROOT = dirname(HERE); // plugin root
const SCRIPT = join(HERE, 'eval-runs.mjs');
const FIXTURES = 'scripts/fixtures/eval-oracle'; // eval-oracle 既有 fixtures（cwd=plugin root）

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed.push(msg); console.error(`  ✗ ${msg}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── T1 extractRunResult + buildRunLine ──────────────────────────────────────────
{
  const report = {
    total: 3, passed: 1, failed: 2,
    tasks: [
      { id: 't1', pass: true, errored: false },
      { id: 't2', pass: false, errored: false },
      { id: 't3', pass: false, errored: true },
    ],
  };
  const r1 = extractRunResult(report, 't1');
  assert(r1.found === true && r1.pass === true && r1.errored === false && r1.taskId === 't1',
    'extractRunResult：found pass [T1]');
  const r3 = extractRunResult(report, 't3');
  assert(r3.found === true && r3.pass === false && r3.errored === true,
    'extractRunResult：found errored（pass false）[T1]');
  const rn = extractRunResult(report, 'nope');
  assert(rn.found === false && rn.pass === false && rn.errored === true,
    'extractRunResult：task 不在 report → found false [T1]');
  assert(extractRunResult(null, 't1').found === false && extractRunResult({}, 't1').found === false,
    'extractRunResult：null/無 tasks → found false [T1]');

  assert(eq(buildRunLine('t1', true, 0), { taskId: 't1', pass: true, runIndex: 0 }),
    'buildRunLine：完整 [T1]');
  assert(eq(buildRunLine('t1', false), { taskId: 't1', pass: false, runIndex: null }),
    'buildRunLine：缺 runIndex → null [T1]');
  assert(buildRunLine('t1', 1, 1.5).pass === true && buildRunLine('t1', 1, 1.5).runIndex === null,
    'buildRunLine：pass !! 強制 boolean、非整數 runIndex → null [T1]');
}

// ── T2 CLI record integration（真 spawn eval-oracle 既有 fixtures）─────────────────
function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
}
{
  const dir = mkdtempSync(join(tmpdir(), 'evalruns-'));
  const runsFile = join(dir, 'runs.jsonl');

  // et-pass：候選全綠 → run pass true
  const rp = run(['record', '--dir', FIXTURES, '--task', 'et-pass', '--runs-file', runsFile, '--run-index', '0']);
  let line0 = null; try { line0 = JSON.parse(rp.stdout); } catch { /* leave null */ }
  assert(rp.status === 0 && line0 && line0.taskId === 'et-pass' && line0.pass === true && line0.runIndex === 0,
    'CLI record：et-pass → 印 run line pass true exit 0 [T2]');
  const persisted = readFileSync(runsFile, 'utf8').split('\n').filter((l) => l.trim());
  assert(persisted.length === 1 && JSON.parse(persisted[0]).pass === true,
    'CLI record：append 一行 run 進 runs.jsonl [T2]');

  // et-failtopass：failToPass 仍紅 → run pass false
  const rf = run(['record', '--dir', FIXTURES, '--task', 'et-failtopass', '--runs-file', runsFile, '--run-index', '1']);
  let line1 = null; try { line1 = JSON.parse(rf.stdout); } catch { /* leave null */ }
  assert(rf.status === 0 && line1 && line1.pass === false, 'CLI record：et-failtopass → run pass false [T2]');
  assert(readFileSync(runsFile, 'utf8').split('\n').filter((l) => l.trim()).length === 2,
    'CLI record：累積第二行 run [T2]');

  // task 不在語料 → exit 3（不偽裝成 pass:false）
  assert(run(['record', '--dir', FIXTURES, '--task', 'no-such-task', '--runs-file', runsFile]).status === 3,
    'CLI record：task 不在語料 → exit 3 [T2]');
  // 缺旗標 → exit 2
  assert(run(['record', '--dir', FIXTURES, '--task', 'et-pass']).status === 2, 'CLI record：缺 --runs-file → exit 2 [T2]');
  assert(run(['bogus']).status === 2, 'CLI：未知命令 → exit 2 [T2]');

  // run line 與 eval-passk 相容：跑 eval-passk 對累積 runs.jsonl 不報錯（schema 對齊）
  const pk = spawnSync(process.execPath, [join(HERE, 'eval-passk.mjs'), 'passk', '--runs', runsFile, '--k', '2'],
    { encoding: 'utf8', cwd: ROOT });
  assert(pk.status === 0 && /et-pass|et-failtopass/.test(pk.stdout), 'CLI record：runs.jsonl 餵 eval-passk 相容 [T2]');
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.error('FAILED:\n' + failed.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
