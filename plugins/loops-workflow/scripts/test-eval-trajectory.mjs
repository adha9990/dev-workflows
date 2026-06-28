#!/usr/bin/env node
// test-eval-trajectory.mjs —— eval-trajectory.mjs 的紅綠斷言（自帶極簡 harness，仿 test-eval-metrics.mjs）。
// 用法（cwd = plugins/loops-workflow）：node scripts/test-eval-trajectory.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1。

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  parseStages, supersetMissing, subsetExtra, unorderedEqual, orderViolations, checkTrajectory,
} from './eval-trajectory.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../scripts
const ROOT = dirname(HERE); // plugin root
const REF = join(ROOT, 'evals', 'trajectories', 'issue-lifecycle.json'); // committed reference

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed.push(msg); console.error(`  ✗ ${msg}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── parseStages：抽 [stage]、箭頭展開、小寫、濾 outcome / 非標記 ────────────────────
{
  const journal = [
    '## Journal',
    '- E1 [dispatch→goal] 開 worktree',
    '- E2 [plan→build] 拍板',
    '- E3 [verify] 4 軸',
    '- E4 [iterate] 全修',
    '- 這行沒有標記，應跳過',
    '- ★[outcome] 完工 ｜ token≈高',
  ].join('\n');
  const stages = parseStages(journal);
  assert(eq(stages, ['dispatch', 'goal', 'plan', 'build', 'verify', 'iterate']),
    'parseStages：箭頭展開 + 小寫 + 濾 outcome/非標記行 [PS]');
  assert(eq(parseStages(''), []) && eq(parseStages(null), []), 'parseStages：空 / null → [] [PS]');
}

// ── supersetMissing：required 中 observed 沒有的（漏階段）─────────────────────────
{
  assert(eq(supersetMissing(['goal', 'build'], ['goal', 'plan', 'build']), ['plan']),
    'supersetMissing：缺 plan → ["plan"] [SM]');
  assert(eq(supersetMissing(['goal', 'plan', 'build'], ['goal', 'plan']), []),
    'supersetMissing：required 全在 → [] [SM]');
  assert(eq(supersetMissing(['a'], []), []) && eq(supersetMissing([], ['x', 'x']), ['x']),
    'supersetMissing：空 required → []；required 重複去重 [SM]');
}

// ── subsetExtra：observed 中不在 allowed 的（多餘步）；allowed 空 → 不判 ─────────────
{
  assert(eq(subsetExtra(['goal', 'hack', 'build'], ['goal', 'build']), ['hack']),
    'subsetExtra：hack 不在 allowed → ["hack"] [SE]');
  assert(eq(subsetExtra(['goal', 'build'], null), []) && eq(subsetExtra(['goal'], []), []),
    'subsetExtra：allowed null/空 → [] (不判多餘) [SE]');
  assert(eq(subsetExtra(['x', 'x', 'y'], ['z']), ['x', 'y']),
    'subsetExtra：多餘去重保序 [SE]');
}

// ── unorderedEqual：集合等價（順序/重複無關）──────────────────────────────────────
{
  assert(unorderedEqual(['a', 'b', 'c'], ['c', 'b', 'a']) === true, 'unorderedEqual：同集合不同序 → true [UE]');
  assert(unorderedEqual(['a', 'a', 'b'], ['b', 'a']) === true, 'unorderedEqual：重複無關 → true [UE]');
  assert(unorderedEqual(['a', 'b'], ['a', 'b', 'c']) === false, 'unorderedEqual：多一個 → false [UE]');
  assert(unorderedEqual(['a'], ['b']) === false, 'unorderedEqual：不同元素 → false [UE]');
}

// ── orderViolations：相對先後被破壞的 pair ───────────────────────────────────────
{
  // verify 在 build 之前 = 違反 build→verify
  assert(eq(orderViolations(['build', 'verify'], ['build', 'verify']), []),
    'orderViolations：build 先於 verify → 無違反 [OV]');
  assert(eq(orderViolations(['verify', 'build'], ['build', 'verify']), [['build', 'verify']]),
    'orderViolations：verify 在 build 前 → [["build","verify"]] [OV]');
  assert(eq(orderViolations(['goal', 'build'], ['goal', 'plan', 'build']), []),
    'orderViolations：order 中缺席的 plan 不影響 goal/build 判定 [OV]');
}

// ── checkTrajectory：好 / 漏階段 / 多餘步 / 禁止 / 順序 ────────────────────────────
const REF_OBJ = {
  required: ['goal', 'plan', 'build', 'verify', 'iterate'],
  optional: ['dispatch', 'ship'],
  order: ['goal', 'plan', 'build', 'verify', 'iterate'],
  forbidden: ['scaffold'],
};
{
  const good = checkTrajectory(['dispatch', 'goal', 'plan', 'build', 'verify', 'iterate', 'ship'], REF_OBJ);
  assert(good.ok === true && eq(good.missing, []) && eq(good.extra, []), 'checkTrajectory：完整合法 → ok=true、無漏無多餘 [CT-good]');

  const skip = checkTrajectory(['goal', 'build', 'verify', 'iterate'], REF_OBJ);
  assert(skip.ok === false && eq(skip.missing, ['plan']), 'checkTrajectory：跳 plan → ok=false、missing=[plan] [CT-skip]');

  const extra = checkTrajectory(['goal', 'plan', 'build', 'hack', 'verify', 'iterate'], REF_OBJ);
  assert(extra.ok === true && eq(extra.extra, ['hack']),
    'checkTrajectory：多餘步 hack → ok=true（效率警示不擋）、extra=[hack] [CT-extra]');

  const forb = checkTrajectory(['scaffold', 'goal', 'plan', 'build', 'verify', 'iterate'], REF_OBJ);
  assert(forb.ok === false && eq(forb.forbidden, ['scaffold']), 'checkTrajectory：含 forbidden scaffold → ok=false [CT-forbidden]');

  const ord = checkTrajectory(['goal', 'build', 'plan', 'verify', 'iterate'], REF_OBJ);
  assert(ord.ok === false && ord.orderViolations.some((p) => eq(p, ['plan', 'build'])),
    'checkTrajectory：plan 在 build 之後 → ok=false、order 違反 [CT-order]');

  assert(checkTrajectory(null, REF_OBJ).ok === false, 'checkTrajectory：observed null → ok=false（全漏）[CT-null]');
}

// ── e2e：真 spawn CLI 對 committed reference（好 loop.md exit0 / 跳階段 exit1 / 誤用 exit2）──
function run(args) {
  return spawnSync(process.execPath, ['scripts/eval-trajectory.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });
}
function writeLoop(stagesJournal) {
  const dir = mkdtempSync(join(tmpdir(), 'traj-'));
  const file = join(dir, 'loop.md');
  writeFileSync(file, `# loop\n## Journal\n${stagesJournal}\n`);
  return { dir, file };
}
{
  const goodJournal = '- E1 [dispatch→goal] x\n- E2 [plan→build] x\n- E3 [verify] x\n- E4 [iterate] x';
  const { dir, file } = writeLoop(goodJournal);
  try {
    const res = run(['check', '--observed', file, '--reference', REF]);
    assert(res.status === 0, 'E2E：合法 trajectory（對 committed issue-lifecycle）→ exit 0 [E2E-ok]');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
{
  const skipJournal = '- E1 [goal] x\n- E2 [build] x\n- E3 [verify] x\n- E4 [iterate] x'; // 跳 plan
  const { dir, file } = writeLoop(skipJournal);
  try {
    const res = run(['check', '--observed', file, '--reference', REF]);
    assert(res.status === 1, 'E2E：跳 plan → exit 1（漏關鍵階段）[E2E-skip]');
    assert(/plan/.test(res.stderr || ''), 'E2E：stderr 點出漏的 plan [E2E-skip]');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
{
  const res = run(['check', '--observed', 'nope']); // 缺 --reference
  assert(res.status === 2, 'E2E：缺必要旗標 → exit 2（誤用）[E2E-misuse]');
  assert(/usage/i.test(res.stderr || ''), 'E2E：誤用 stderr 含 usage [E2E-misuse]');
}

console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
