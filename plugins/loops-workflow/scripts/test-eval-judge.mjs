#!/usr/bin/env node
// test-eval-judge.mjs —— eval-judge.mjs 的紅綠斷言（自帶極簡 harness，仿 test-eval-trajectory.mjs）。
// 用法（cwd = plugins/loops-workflow）：node scripts/test-eval-judge.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1。

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  parseVerdict, parseRubricMeta, validateRubric, validateVerdict,
  buildJudgeRecord, partitionByTrack, rotateLines, appendJudgeRecord,
} from './eval-judge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../scripts
const SCRIPT = join(HERE, 'eval-judge.mjs');

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed.push(msg); console.error(`  ✗ ${msg}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 一份合法 rubric（frontmatter 純量 + ## Evaluation steps + ≥3 編號步驟）
const RUBRIC_OK = [
  '---',
  'dimension: explanation-quality',
  'scale_min: 1',
  'scale_max: 5',
  'threshold: 4',
  'schema: 1',
  '---',
  '# rubric：解釋/溝通品質',
  '## Evaluation steps',
  '1. 讀 artifact + 契約，標出它聲稱要溝通什麼',
  '2. 逐步檢查解釋是否完整、無誤導',
  '3. 給 1–5 分並寫 reasoning',
].join('\n');

// ── T1 parseVerdict：tolerant 三段降級 ──────────────────────────────────────────
{
  const clean = parseVerdict('{"dimension":"x","score":4,"pass":true,"reasoning":"ok"}');
  assert(clean.parseOk && clean.score === 4 && clean.pass === true && clean.reasoning === 'ok',
    'parseVerdict：clean JSON 全欄 [T1]');

  const fenced = parseVerdict('前言\n```json\n{"score":3,"pass":false,"reasoning":"meh"}\n```\n後話');
  assert(fenced.parseOk && fenced.score === 3 && fenced.pass === false,
    'parseVerdict：fenced ```json 抽出 [T1]');

  const prose = parseVerdict('Sure! verdict: {"score":5,"pass":true,"reasoning":"great"} done.');
  assert(prose.parseOk && prose.score === 5,
    'parseVerdict：prose 包夾 → 抽首個平衡物件 [T1]');

  const missing = parseVerdict('{"reasoning":"no score"}');
  assert(missing.parseOk && missing.score === null && missing.reasoning === 'no score',
    'parseVerdict：缺 score → null（仍 parseOk）[T1]');

  const nonNum = parseVerdict('{"score":"high","pass":true,"reasoning":"r"}');
  assert(nonNum.score === null,
    'parseVerdict：非數 score → null [T1]');

  const bad = parseVerdict('totally not json at all');
  assert(!bad.parseOk && bad.score === null && bad.pass === null && bad.reasoning === '',
    'parseVerdict：壞輸入 → parseOk:false 全 null [T1]');

  const nul = parseVerdict(null);
  assert(!nul.parseOk && nul.score === null,
    'parseVerdict：null → parseOk:false（不丟例外）[T1]');

  // reasoning 內含 } —— 平衡器跳過字串內括號（firstBalancedObject 存在的理由）
  const brace = parseVerdict('note: {"score":4,"pass":true,"reasoning":"close } brace"} end');
  assert(brace.parseOk && brace.score === 4 && brace.reasoning === 'close } brace',
    'parseVerdict：reasoning 含 } → 平衡器跳過字串內括號 [T1]');

  // 多物件取首個；無閉合 → parseOk:false
  assert(parseVerdict('a {"score":1,"reasoning":"x"} b {"score":5}').score === 1,
    'parseVerdict：多物件取首個平衡物件 [T1]');
  assert(!parseVerdict('prefix {"score":4 no close').parseOk,
    'parseVerdict：無閉合 { → parseOk:false [T1]');

  // fenced 優先 ```json 標籤：先非 json fence、後 json verdict → 抽到後者
  const preferJson = parseVerdict('```\nplain text block\n```\n```json\n{"score":5,"reasoning":"v"}\n```');
  assert(preferJson.parseOk && preferJson.score === 5,
    'parseVerdict：先非 json fence、後 ```json → 抽 json 那塊 [T1]');
}

// ── T2 parseRubricMeta + validateRubric ───────────────────────────────────────
{
  const m = parseRubricMeta(RUBRIC_OK);
  assert(m.dimension === 'explanation-quality' && m.scaleMin === 1 && m.scaleMax === 5
    && m.threshold === 4 && m.stepCount === 3 && m.schema === 1,
    'parseRubricMeta：抽 frontmatter 純量 + 數編號步驟 [T2]');

  const v = validateRubric(m);
  assert(v.valid && v.reasons.length === 0, 'validateRubric：合法 rubric → valid [T2]');

  const noDim = validateRubric(parseRubricMeta(RUBRIC_OK.replace('dimension: explanation-quality', 'dimension: ')));
  assert(!noDim.valid, 'validateRubric：缺 dimension → invalid [T2]');

  const badThresh = validateRubric(parseRubricMeta(RUBRIC_OK.replace('threshold: 4', 'threshold: 9')));
  assert(!badThresh.valid, 'validateRubric：threshold 越界(9>scaleMax) → invalid [T2]');

  const noSteps = RUBRIC_OK.split('## Evaluation steps')[0] + '## Evaluation steps\n（沒有編號步驟）';
  assert(!validateRubric(parseRubricMeta(noSteps)).valid, 'validateRubric：無編號步驟(<3) → invalid [T2]');

  const badScale = validateRubric(parseRubricMeta(
    RUBRIC_OK.replace('scale_min: 1', 'scale_min: 5').replace('scale_max: 5', 'scale_max: 2')));
  assert(!badScale.valid, 'validateRubric：scaleMin≥scaleMax → invalid [T2]');

  // threshold 邊界：==scaleMin / ==scaleMax 皆 valid（含界）；<scaleMin invalid
  assert(validateRubric(parseRubricMeta(RUBRIC_OK.replace('threshold: 4', 'threshold: 1'))).valid,
    'validateRubric：threshold==scaleMin → valid [T2]');
  assert(validateRubric(parseRubricMeta(RUBRIC_OK.replace('threshold: 4', 'threshold: 5'))).valid,
    'validateRubric：threshold==scaleMax → valid [T2]');
  assert(!validateRubric(parseRubricMeta(
    RUBRIC_OK.replace('scale_min: 1', 'scale_min: 2').replace('threshold: 4', 'threshold: 1'))).valid,
    'validateRubric：threshold<scaleMin → invalid [T2]');
}

// ── T3 validateVerdict：門檻為準 + passMismatch ────────────────────────────────
{
  const params = { scaleMin: 1, scaleMax: 5, threshold: 4 };
  const p = validateVerdict({ score: 4, pass: true, reasoning: 'r', parseOk: true }, params);
  assert(p.scoreInRange && p.pass === true && p.passMismatch === false && p.valid,
    'validateVerdict：界內達門檻 → pass valid [T3]');

  const f = validateVerdict({ score: 2, pass: false, reasoning: 'r', parseOk: true }, params);
  assert(f.scoreInRange && f.pass === false && !f.passMismatch && f.valid,
    'validateVerdict：界內未達門檻 → fail valid [T3]');

  const oob = validateVerdict({ score: 9, pass: true, reasoning: 'r', parseOk: true }, params);
  assert(!oob.scoreInRange && !oob.valid,
    'validateVerdict：越界 → scoreInRange:false valid:false [T3]');

  const mism = validateVerdict({ score: 2, pass: true, reasoning: 'r', parseOk: true }, params);
  assert(mism.pass === false && mism.passMismatch === true,
    'validateVerdict：自報 pass=true 但 score<門檻 → 門檻為準 false + passMismatch [T3]');

  const noScore = validateVerdict({ score: null, pass: null, reasoning: '', parseOk: false }, params);
  assert(!noScore.valid && noScore.pass === false,
    'validateVerdict：parseOk false / score null → valid:false pass:false [T3]');

  // derivedPass gate：越界 score 不可能 pass（不只 valid:false）
  assert(oob.pass === false,
    'validateVerdict：越界 score → pass:false（gate on scoreInRange）[T3]');

  // score 邊界：==scaleMin / ==scaleMax 仍界內
  const lo = validateVerdict({ score: 1, pass: false, reasoning: 'r', parseOk: true }, params);
  assert(lo.scoreInRange && lo.valid, 'validateVerdict：score==scaleMin 界內 valid [T3]');
  const hi = validateVerdict({ score: 5, pass: true, reasoning: 'r', parseOk: true }, params);
  assert(hi.scoreInRange && hi.pass === true && hi.valid, 'validateVerdict：score==scaleMax 界內 pass valid [T3]');

  // passMismatch：self pass 缺(null) → 不算 mismatch
  const np = validateVerdict({ score: 4, pass: null, reasoning: 'r', parseOk: true }, params);
  assert(np.pass === true && np.passMismatch === false, 'validateVerdict：self pass null → passMismatch false [T3]');

  // dimensionMismatch：judge 自報 ≠ rubric → 標旗標 + rubric 為權威；一致 → false
  const dm = validateVerdict(
    { score: 4, pass: true, reasoning: 'r', parseOk: true, dimension: 'other' },
    { ...params, dimension: 'explanation-quality' });
  assert(dm.dimensionMismatch === true && dm.dimension === 'explanation-quality',
    'validateVerdict：dimension 自報≠rubric → dimensionMismatch + rubric 權威 [T3]');
  const dm2 = validateVerdict(
    { score: 4, pass: true, reasoning: 'r', parseOk: true, dimension: 'explanation-quality' },
    { ...params, dimension: 'explanation-quality' });
  assert(dm2.dimensionMismatch === false, 'validateVerdict：dimension 一致 → dimensionMismatch false [T3]');
}

// ── T4 buildJudgeRecord / partitionByTrack / rotateLines / appendJudgeRecord ───
{
  const validated = {
    score: 4, pass: true, scoreInRange: true, passMismatch: false,
    reasoning: 'r', parseOk: true, valid: true, dimension: 'explanation-quality',
  };
  const rec = buildJudgeRecord(validated, { judgeId: 'j1', model: 'claude-x', ts: '2026-06-28T00:00:00Z' });
  assert(rec.track === 'judge-estimate', 'buildJudgeRecord：track 硬編 judge-estimate [T4]');
  assert(rec.judgeId === 'j1' && rec.model === 'claude-x' && rec.score === 4
    && rec.dimension === 'explanation-quality' && rec.schema === 1 && rec.ts === '2026-06-28T00:00:00Z',
    'buildJudgeRecord：攜 judgeId/model/ts + 透傳欄 [T4]');
  const forced = buildJudgeRecord({ ...validated, track: 'measured' }, { judgeId: 'j', model: 'm' });
  assert(forced.track === 'judge-estimate',
    'buildJudgeRecord：外部塞 track:measured 無效（永遠 judge-estimate）[T4]');
  const recDm = buildJudgeRecord({ ...validated, dimensionMismatch: true }, { judgeId: 'j', model: 'm' });
  assert(recDm.dimensionMismatch === true, 'buildJudgeRecord：透傳 dimensionMismatch [T4]');

  const part = partitionByTrack([
    { track: 'measured', id: 1 }, { track: 'judge-estimate', id: 2 },
    { track: 'judge-estimate', id: 3 }, { track: 'weird', id: 4 },
  ]);
  assert(part.measured.length === 1 && part.judgeEstimate.length === 2,
    'partitionByTrack：分軌 measured/judge-estimate（other 不混入兩軌）[T4]');

  assert(eq(rotateLines(['a', 'b', 'c', 'd'], 2), ['c', 'd']), 'rotateLines：超 cap 保留末 N [T4]');
  assert(eq(rotateLines(['a'], 5), ['a']), 'rotateLines：未超 cap 原樣 [T4]');
  assert(eq(rotateLines(['a', 'b'], 0), ['a', 'b']), 'rotateLines：cap<=0 不旋轉（視為停用）[T4]');

  const dir = mkdtempSync(join(tmpdir(), 'evaljudge-'));
  const file = join(dir, 'judge-results.jsonl');
  appendJudgeRecord(file, { a: 1 });
  appendJudgeRecord(file, { a: 2 });
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  assert(lines.length === 2 && JSON.parse(lines[0]).a === 1 && JSON.parse(lines[1]).a === 2,
    'appendJudgeRecord：連 append 2 次 → 2 行各可 parse [T4]');
  for (let i = 0; i < 5; i += 1) appendJudgeRecord(file, { a: 100 + i }, 3);
  const lines2 = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  assert(lines2.length === 3, 'appendJudgeRecord：cap=3 rotation 後僅 3 行 [T4]');
  assert(lines2.map((l) => JSON.parse(l).a).join(',') === '102,103,104',
    'appendJudgeRecord：rotation 保留最新 N（非最舊）[T4]');
  rmSync(dir, { recursive: true, force: true });
}

// ── T5 CLI spawn smoke：validate-rubric 0/1/3、parse 0/2/3 + 落檔 ──────────────
function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}
{
  const dir = mkdtempSync(join(tmpdir(), 'evaljudge-cli-'));
  const rubricFile = join(dir, 'rubric.md');
  writeFileSync(rubricFile, RUBRIC_OK);
  const badRubric = join(dir, 'bad.md');
  writeFileSync(badRubric, '---\ndimension: \nscale_min: 5\nscale_max: 1\nthreshold: 9\n---\n沒有步驟');
  const outFile = join(dir, 'judge-out.json');
  writeFileSync(outFile, '{"dimension":"explanation-quality","score":4,"pass":true,"reasoning":"good"}');
  const oobOut = join(dir, 'oob.json');
  writeFileSync(oobOut, '{"score":99,"pass":true,"reasoning":"x"}');
  const judgeFile = join(dir, 'judge-results.jsonl');

  assert(run(['validate-rubric', rubricFile]).status === 0, 'CLI validate-rubric：合法 → exit 0 [T5]');
  assert(run(['validate-rubric', badRubric]).status === 1, 'CLI validate-rubric：不合法 → exit 1 [T5]');
  assert(run(['validate-rubric', join(dir, 'nope.md')]).status === 3, 'CLI validate-rubric：讀檔失敗 → exit 3 [T5]');

  const p = run(['parse', '--rubric', rubricFile, '--output', outFile, '--judge-file', judgeFile]);
  assert(p.status === 0, 'CLI parse：正常 → exit 0 [T5]');
  let rec = null; try { rec = JSON.parse(p.stdout); } catch { /* leave null */ }
  assert(rec && rec.track === 'judge-estimate' && rec.pass === true && rec.valid === true,
    'CLI parse：stdout record 可 parse + 分軌 + 門檻 pass [T5]');
  assert(existsSync(judgeFile) && readFileSync(judgeFile, 'utf8').includes('judge-estimate'),
    'CLI parse：落檔 judge-results.jsonl 含 record [T5]');

  const pOob = run(['parse', '--rubric', rubricFile, '--output', oobOut, '--judge-file', judgeFile]);
  assert(pOob.status === 0, 'CLI parse：verdict 越界 → 仍 exit 0（advisory 永不擋路）[T5]');
  let recOob = null; try { recOob = JSON.parse(pOob.stdout); } catch { /* leave null */ }
  assert(recOob && recOob.valid === false && recOob.scoreInRange === false,
    'CLI parse：越界 record valid:false 誠實標 [T5]');

  assert(run(['parse', '--rubric', rubricFile]).status === 2, 'CLI parse：缺 --output → exit 2 [T5]');
  assert(run(['bogus']).status === 2, 'CLI：未知命令 → exit 2 [T5]');
  assert(run(['parse', '--rubric', join(dir, 'nope.md'), '--output', outFile, '--judge-file', judgeFile]).status === 3,
    'CLI parse：rubric 讀檔失敗 → exit 3 [T5]');
  // output 讀檔失敗（rubric ok）→ exit 3（與 rubric-read-fail 為不同分支）
  assert(run(['parse', '--rubric', rubricFile, '--output', join(dir, 'nope.json'), '--judge-file', judgeFile]).status === 3,
    'CLI parse：output 讀檔失敗 → exit 3 [T5]');

  // --output - 從 stdin 讀
  const pStdin = spawnSync(process.execPath,
    [SCRIPT, 'parse', '--rubric', rubricFile, '--output', '-', '--judge-file', judgeFile],
    { encoding: 'utf8', input: '{"score":4,"pass":true,"reasoning":"r"}' });
  let recStdin = null; try { recStdin = JSON.parse(pStdin.stdout); } catch { /* leave null */ }
  assert(pStdin.status === 0 && recStdin && recStdin.score === 4,
    'CLI parse：--output - 從 stdin 讀 [T5]');

  // 落檔失敗仍 exit 0 + 印 record + stderr 診斷（--judge-file 指向目錄 → EISDIR）
  const dirAsFile = join(dir, 'isdir'); mkdirSync(dirAsFile);
  const pWf = run(['parse', '--rubric', rubricFile, '--output', outFile, '--judge-file', dirAsFile]);
  let recWf = null; try { recWf = JSON.parse(pWf.stdout); } catch { /* leave null */ }
  assert(pWf.status === 0 && recWf && recWf.track === 'judge-estimate' && /落檔失敗/.test(pWf.stderr),
    'CLI parse：落檔失敗仍 exit 0 + 印 record + stderr 診斷（永不擋路≠永不出聲）[T5]');

  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.error('FAILED:\n' + failed.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
