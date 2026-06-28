#!/usr/bin/env node
// test-eval-panel.mjs —— eval-panel.mjs 的紅綠斷言（自帶 harness）。
// 用法（cwd = plugins/loops-workflow）：node scripts/test-eval-panel.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { runPanel } from './eval-panel.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'eval-panel.mjs');

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed.push(msg); console.error(`  ✗ ${msg}`); }
}

const RUBRIC_META = { dimension: 'explanation-quality', scaleMin: 1, scaleMax: 5, threshold: 4 };
const VERDICTS = [
  { judgeId: 'a', model: 'm1', output: '{"score":4,"pass":true,"reasoning":"good"}' },
  { judgeId: 'b', model: 'm2', output: '{"score":5,"pass":true,"reasoning":"great"}' },
  { judgeId: 'c', model: 'm3', output: '{"score":3,"pass":false,"reasoning":"meh"}' },
];
const RUBRIC_MD = [
  '---', 'dimension: explanation-quality', 'scale_min: 1', 'scale_max: 5', 'threshold: 4', 'schema: 1', '---',
  '## Evaluation steps', '1. a', '2. b', '3. c',
].join('\n');

// ── T1 runPanel：N verdict → 共識 ────────────────────────────────────────────────
{
  const r = runPanel(VERDICTS, { rubricMeta: RUBRIC_META, caseId: 'c1' });
  assert(r.panelSize === 3 && r.validCount === 3 && r.records.length === 3,
    'runPanel：3 verdict → panelSize 3 / validCount 3 [T1]');
  assert(r.consensus.pass === true && r.consensus.score === 4 && r.consensus.passTie === false,
    'runPanel：共識 pass majority t / score median 4 [T1]');
  assert(r.records.every((rec) => rec.caseId === 'c1' && rec.track === 'judge-estimate'),
    'runPanel：record 帶 caseId + judge-estimate 軌 [T1]');
  assert(r.goldAgreement === null, 'runPanel：無金標 → goldAgreement null [T1]');

  // 壞 output：record 仍計入 panelSize/落檔，但 valid false → **棄權**（不投票、不翻盤共識）
  const withBad = runPanel([...VERDICTS, { judgeId: 'd', model: 'm4', output: 'garbage' }],
    { rubricMeta: RUBRIC_META, caseId: 'c1' });
  const bad = withBad.records.find((rec) => rec.judgeId === 'd');
  assert(withBad.panelSize === 4 && withBad.validCount === 3 && bad.valid === false && bad.pass === false,
    'runPanel：壞 output → 計入 panelSize 但不計 validCount（棄權）[T1]');
  assert(withBad.consensus.pass === true,
    'runPanel：壞 verdict 棄權 → 共識仍由 3 valid 決定（不被壞輸出翻盤）[T1]');

  // N=2：一真 pass + 一 garbage → garbage 棄權 → 共識 pass（非被稀釋成平手）
  const n2 = runPanel([VERDICTS[0], { judgeId: 'x', output: 'not json' }], { rubricMeta: RUBRIC_META, caseId: 'c1' });
  assert(n2.validCount === 1 && n2.consensus.pass === true && n2.consensus.passTie === false,
    'runPanel：N=2 一真 pass + 一壞 → 壞棄權、共識 pass（不稀釋）[T1]');

  // 空 / 全壞 verdict → consensus null（穩定、不 crash）
  const empty = runPanel([], { rubricMeta: RUBRIC_META, caseId: 'c1' });
  assert(empty.consensus === null && empty.panelSize === 0 && empty.validCount === 0,
    'runPanel：空 verdict → consensus null panelSize 0 [T1]');
  const allBad = runPanel([{ judgeId: 'a', output: 'x' }, { judgeId: 'b', output: 'y' }],
    { rubricMeta: RUBRIC_META, caseId: 'c1' });
  assert(allBad.consensus === null && allBad.panelSize === 2 && allBad.validCount === 0,
    'runPanel：全壞 verdict → consensus null（validCount 0）[T1]');
}

// ── T2 runPanel goldAgreement ────────────────────────────────────────────────────
{
  const agree = runPanel(VERDICTS, { rubricMeta: RUBRIC_META, caseId: 'c1', gold: [{ id: 'c1', goldPass: true }] });
  assert(agree.goldAgreement && agree.goldAgreement.agree === true && agree.goldAgreement.consensusTie === false,
    'runPanel：共識 pass===gold → agree true [T2]');
  const dis = runPanel(VERDICTS, { rubricMeta: RUBRIC_META, caseId: 'c1', gold: [{ id: 'c1', goldPass: false }] });
  assert(dis.goldAgreement && dis.goldAgreement.agree === false, 'runPanel：共識 pass≠gold → agree false [T2]');
  const noCase = runPanel(VERDICTS, { rubricMeta: RUBRIC_META, caseId: 'c1', gold: [{ id: 'other', goldPass: true }] });
  assert(noCase.goldAgreement === null, 'runPanel：金標無此 case → goldAgreement null [T2]');
  // 平手共識（2 valid 對半）→ agree null（不把擲銅板說成與金標一致）
  const tie = runPanel(
    [{ judgeId: 'a', output: '{"score":5,"pass":true,"reasoning":"x"}' },
      { judgeId: 'b', output: '{"score":2,"pass":false,"reasoning":"y"}' }],
    { rubricMeta: RUBRIC_META, caseId: 'c1', gold: [{ id: 'c1', goldPass: false }] });
  assert(tie.consensus.passTie === true && tie.goldAgreement.agree === null && tie.goldAgreement.consensusTie === true,
    'runPanel：平手共識 → agree null + consensusTie true [T2]');
}

// ── T3 CLI spawn smoke ──────────────────────────────────────────────────────────
function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}
{
  const dir = mkdtempSync(join(tmpdir(), 'evalpanel-'));
  const rubricFile = join(dir, 'rubric.md');
  writeFileSync(rubricFile, RUBRIC_MD);
  const verdictsFile = join(dir, 'verdicts.jsonl');
  writeFileSync(verdictsFile, VERDICTS.map((v) => JSON.stringify(v)).join('\n') + '\nGARBAGE\n');
  const judgeFile = join(dir, 'judge-results.jsonl');
  const goldFile = join(dir, 'gold.json');
  writeFileSync(goldFile, JSON.stringify([{ id: 'c1', goldPass: true }]));

  const res = run(['run', '--rubric', rubricFile, '--verdicts', verdictsFile, '--case-id', 'c1',
    '--gold', goldFile, '--judge-file', judgeFile]);
  let out = null; try { out = JSON.parse(res.stdout); } catch { /* leave null */ }
  assert(res.status === 0 && out && out.consensus.pass === true && out.panelSize === 3,
    'CLI run：exit 0 + 共識 pass [T3]');
  assert(out && out.skipped === 1, 'CLI run：揭露 verdicts 壞行 skipped [T3]');
  assert(out && out.goldAgreement && out.goldAgreement.agree === true, 'CLI run：金標 agreement [T3]');
  const recLines = readFileSync(judgeFile, 'utf8').split('\n').filter((l) => l.trim());
  assert(recLines.length === 3 && JSON.parse(recLines[0]).track === 'judge-estimate',
    'CLI run：--judge-file 落 3 筆 record [T3]');

  assert(run(['run', '--rubric', rubricFile, '--case-id', 'c1']).status === 2, 'CLI run：缺 --verdicts → exit 2 [T3]');
  assert(run(['bogus']).status === 2, 'CLI：未知命令 → exit 2 [T3]');
  assert(run(['run', '--rubric', join(dir, 'nope.md'), '--verdicts', verdictsFile, '--case-id', 'c1']).status === 3,
    'CLI run：rubric 讀檔失敗 → exit 3 [T3]');
  // 落檔 record 欄位完整（非只 track）+ rubricValid
  const rec0 = JSON.parse(recLines[0]);
  assert(rec0.caseId === 'c1' && typeof rec0.pass === 'boolean' && rec0.score !== undefined && rec0.judgeId,
    'CLI run：落檔 record 欄位完整（caseId/pass/score/judgeId）[T3]');
  assert(out.rubricValid === true, 'CLI run：合法 rubric → rubricValid true [T3]');
  // 錯誤路徑：缺 --case-id exit2、verdicts/gold 讀檔失敗 exit3
  assert(run(['run', '--rubric', rubricFile, '--verdicts', verdictsFile]).status === 2,
    'CLI run：缺 --case-id → exit 2 [T3]');
  assert(run(['run', '--rubric', rubricFile, '--verdicts', join(dir, 'nope.jsonl'), '--case-id', 'c1']).status === 3,
    'CLI run：verdicts 讀檔失敗 → exit 3 [T3]');
  assert(run(['run', '--rubric', rubricFile, '--verdicts', verdictsFile, '--case-id', 'c1', '--gold', join(dir, 'nope.json')]).status === 3,
    'CLI run：gold 讀檔失敗 → exit 3 [T3]');
  // --judge-file 落檔失敗（指向目錄 EISDIR）仍 exit 0 + 印 report + stderr
  const dirAsFile = join(dir, 'isdir'); mkdirSync(dirAsFile);
  const pWf = run(['run', '--rubric', rubricFile, '--verdicts', verdictsFile, '--case-id', 'c1', '--judge-file', dirAsFile]);
  assert(pWf.status === 0 && /落檔失敗/.test(pWf.stderr), 'CLI run：落檔失敗仍 exit 0 + stderr [T3]');
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.error('FAILED:\n' + failed.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
