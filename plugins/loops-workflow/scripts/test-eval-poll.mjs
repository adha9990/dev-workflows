#!/usr/bin/env node
// test-eval-poll.mjs —— eval-poll.mjs 的紅綠斷言（自帶 harness，仿 test-eval-judge.mjs）。
// 用法（cwd = plugins/loops-workflow）：node scripts/test-eval-poll.mjs

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  cohenKappa, pollVote, aggregatePanel, pairJudgeVsGold,
} from './eval-poll.mjs';
// #87 修復輪 P2（sec）：loadRecords 新增可選 maxBytes 參數，現尚未 export（僅 CLI 內部用）。
// 用 namespace import 取用：未 export 時呼叫 undefined → TypeError → callSafe 捕捉，逐條轉紅
// （不連坐既有 T1-T5 斷言，比照 test-eval-gate.mjs 的 namespace-import 慣例）。
import * as EP from './eval-poll.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'eval-poll.mjs');

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed.push(msg); console.error(`  ✗ ${msg}`); }
}
const approx = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;
function callSafe(fn) {
  try { return { threw: false, val: fn() }; }
  catch (e) { return { threw: true, err: e }; }
}

// ── T1 cohenKappa（已知值）──────────────────────────────────────────────────────
{
  // 完全一致且有變異 → κ=1
  const k1 = cohenKappa([true, true, false, false], [true, true, false, false]);
  assert(approx(k1.kappa, 1) && approx(k1.po, 1), 'cohenKappa：完全一致(有變異) → κ=1 [T1]');
  // 完全相反 → κ=-1
  const k2 = cohenKappa([true, true, false, false], [false, false, true, true]);
  assert(approx(k2.kappa, -1), 'cohenKappa：完全相反 → κ=-1 [T1]');
  // 部分一致 [t,t,t,f] vs [t,t,f,f]：po=.75 pe=.5 κ=.5
  const k3 = cohenKappa([true, true, true, false], [true, true, false, false]);
  assert(approx(k3.kappa, 0.5) && approx(k3.po, 0.75) && approx(k3.pe, 0.5),
    'cohenKappa：部分一致 → κ=0.5（po=.75 pe=.5）[T1]');
  // 無變異（兩邊全 true）→ 1−pe=0 → κ null + reason
  const k4 = cohenKappa([true, true, true], [true, true, true]);
  assert(k4.kappa === null && /variance/.test(k4.reason), 'cohenKappa：無變異 → κ null + reason（不假裝 1）[T1]');
  // 不等長 / 空 → null
  assert(cohenKappa([true, true], [true]).kappa === null, 'cohenKappa：不等長 → null [T1]');
  assert(cohenKappa([], []).kappa === null && cohenKappa([], []).n === 0, 'cohenKappa：空 → null n=0 [T1]');
}

// ── T2 pollVote ─────────────────────────────────────────────────────────────────
{
  assert(pollVote([true, true, false], { method: 'majority' }) === true, 'pollVote：majority [t,t,f] → t [T2]');
  assert(pollVote([true, false], { method: 'majority' }) === null, 'pollVote：majority 平手 → null [T2]');
  assert(pollVote(['a', 'a', 'b', 'c'], { method: 'majority' }) === 'a', 'pollVote：majority 字串眾數 [T2]');
  assert(pollVote([1, 2, 3], { method: 'median' }) === 2, 'pollVote：median 奇數 → 中位 [T2]');
  assert(pollVote([1, 2, 3, 4], { method: 'median' }) === 2.5, 'pollVote：median 偶數 → 兩中位平均 [T2]');
  assert(pollVote([1, 5, 3], { method: 'max' }) === 5 && pollVote([1, 5, 3], { method: 'min' }) === 1,
    'pollVote：max/min [T2]');
  assert(pollVote([], { method: 'majority' }) === null, 'pollVote：空 → null [T2]');
  // tie-reset：先平手(a,b 各2)、後被更高票(c=3)打破 → 回真正眾數 c（殺 tie 未重置 mutant）
  assert(pollVote(['a', 'a', 'b', 'b', 'c', 'c', 'c'], { method: 'majority' }) === 'c',
    'pollVote：先平手後被更高票打破 → 回真眾數 c [T2]');
  assert(pollVote(['a', 'b', 'c'], { method: 'majority' }) === null, 'pollVote：3-way 全平手 → null [T2]');
}

// ── T3 aggregatePanel（依 caseId 分組，只計 judge-estimate 軌）───────────────────
{
  const recs = [
    { caseId: 'c1', judgeId: 'a', pass: true, score: 4, track: 'judge-estimate' },
    { caseId: 'c1', judgeId: 'b', pass: true, score: 5, track: 'judge-estimate' },
    { caseId: 'c1', judgeId: 'c', pass: false, score: 3, track: 'judge-estimate' },
    { caseId: 'c2', judgeId: 'a', pass: false, score: 2, track: 'judge-estimate' },
    { caseId: 'x', judgeId: 'm', pass: true, score: 5, track: 'measured' }, // 不計
  ];
  const agg = aggregatePanel(recs, {});
  assert(agg.length === 2, 'aggregatePanel：measured 軌排除、2 組 [T3]');
  const c1 = agg.find((g) => g.caseId === 'c1');
  assert(c1.panelSize === 3 && c1.pass === true && c1.score === 4 && c1.passTie === false,
    'aggregatePanel：c1 三 judge → pass majority t、score median 4 [T3]');
  const c2 = agg.find((g) => g.caseId === 'c2');
  assert(c2.panelSize === 1 && c2.pass === false, 'aggregatePanel：c2 單 judge [T3]');

  // 平手 panel（2 judge 一 pass 一 fail）→ pass:false + passTie:true（誠實標歧義；殺 passTie 常數化 mutant）
  const tieAgg = aggregatePanel([
    { caseId: 't', judgeId: 'a', pass: true, score: 4, track: 'judge-estimate' },
    { caseId: 't', judgeId: 'b', pass: false, score: 2, track: 'judge-estimate' },
  ], {});
  assert(tieAgg[0].pass === false && tieAgg[0].passTie === true,
    'aggregatePanel：平手 panel → pass false + passTie true [T3]');

  // score 全非數 → score:null
  const noScore = aggregatePanel([{ caseId: 'n', judgeId: 'a', pass: true, score: null, track: 'judge-estimate' }], {});
  assert(noScore[0].score === null, 'aggregatePanel：score 全非數 → null [T3]');

  // scoreMethod max 端到端（CLI 旗標 → aggregatePanel → pollVote 傳遞）
  const maxAgg = aggregatePanel([
    { caseId: 'm', judgeId: 'a', pass: true, score: 3, track: 'judge-estimate' },
    { caseId: 'm', judgeId: 'b', pass: true, score: 5, track: 'judge-estimate' },
  ], { scoreMethod: 'max' });
  assert(maxAgg[0].score === 5, 'aggregatePanel：scoreMethod max → 取極值 5 [T3]');
}

// ── T4 pairJudgeVsGold + 端到端 κ ───────────────────────────────────────────────
{
  const recs = [
    { caseId: 'c1', pass: true, track: 'judge-estimate' },
    { caseId: 'c2', pass: false, track: 'judge-estimate' },
    { caseId: 'c3', pass: true, track: 'judge-estimate' },
    { caseId: 'c4', pass: false, track: 'judge-estimate' },
    { caseId: 'c9', pass: true, track: 'judge-estimate' }, // 無對應金標 → unmatched
  ];
  const gold = [
    { id: 'c1', goldPass: true }, { id: 'c2', goldPass: false },
    { id: 'c3', goldPass: false }, { id: 'c4', goldPass: false },
  ];
  const paired = pairJudgeVsGold(recs, gold);
  assert(paired.paired === 4 && paired.unmatched.length === 1 && paired.unmatched[0] === 'c9',
    'pairJudgeVsGold：4 配對 + c9 unmatched [T4]');
  // gold 有 id 但 goldPass 非布林 → 該 record 落 unmatched（守門）
  const badGold = pairJudgeVsGold(
    [{ caseId: 'cx', pass: true, track: 'judge-estimate' }],
    [{ id: 'cx', goldPass: 'yes' }]);
  assert(badGold.paired === 0 && badGold.unmatched[0] === 'cx',
    'pairJudgeVsGold：goldPass 非布林 → unmatched [T4]');
  // judgeLabels [t,f,t,f] vs goldLabels [t,f,f,f]：po=.75 pe=.5 κ=.5
  const k = cohenKappa(paired.judgeLabels, paired.goldLabels);
  assert(approx(k.kappa, 0.5), 'pairJudgeVsGold → cohenKappa 端到端 κ=0.5 [T4]');
}

// ── LR loadRecords(file, maxBytes) —— #87 修復輪 P2（sec）：新增可選 maxBytes 讀檔上限（預設 16MB 級）。
//    極小 maxBytes → 安全空值（records:[]，不拋錯、不讀入超限內容；poll 語意上「零 records」）；
//    正常小檔 + 不帶 maxBytes（沿用預設）→ 正常解析（函式簽名相容）。loadRecords 現未 export →
//    callSafe 捕捉 TypeError，兩條斷言皆先紅（新 export + maxBytes 尚未實作）。
{
  const dir = mkdtempSync(join(tmpdir(), 'ep-maxbytes-'));
  try {
    const file = join(dir, 'judge-results.jsonl');
    writeFileSync(file, '{"caseId":"c1","judgeId":"a","pass":true,"score":4,"track":"judge-estimate"}\n');

    const r = callSafe(() => EP.loadRecords(file, 10)); // 極小 maxBytes(10)，內容遠超此值
    assert(!r.threw, 'loadRecords(file, 10)：極小 maxBytes 不拋錯（安全空值，非拋錯）[LR-maxbytes-cap]');
    assert(r.val && Array.isArray(r.val.records) && r.val.records.length === 0,
      'loadRecords(file, 10)：超限 → 安全空值 records:[]（poll 語意上零 records）[LR-maxbytes-cap]');

    const r2 = callSafe(() => EP.loadRecords(file)); // 原呼叫方式：不帶第二參數
    assert(!r2.threw, 'loadRecords(file)：不帶 maxBytes 不拋錯（簽名相容）[LR-maxbytes-default]');
    assert(r2.val && Array.isArray(r2.val.records) && r2.val.records.length === 1 && r2.val.records[0].caseId === 'c1',
      'loadRecords(file)：小檔 + 預設上限 → 正常解析（行為不變）[LR-maxbytes-default]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── T5 CLI spawn smoke ──────────────────────────────────────────────────────────
function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}
{
  const dir = mkdtempSync(join(tmpdir(), 'evalpoll-'));
  const recFile = join(dir, 'judge-results.jsonl');
  writeFileSync(recFile, [
    '{"caseId":"c1","judgeId":"a","pass":true,"score":4,"track":"judge-estimate"}',
    '{"caseId":"c1","judgeId":"b","pass":false,"score":3,"track":"judge-estimate"}',
    '{"caseId":"c2","judgeId":"a","pass":true,"score":5,"track":"judge-estimate"}',
  ].join('\n') + '\n');
  const goldFile = join(dir, 'gold.json');
  writeFileSync(goldFile, JSON.stringify([{ id: 'c1', goldPass: true }, { id: 'c2', goldPass: true }]));

  assert(run(['kappa', '--records', recFile, '--gold', goldFile]).status === 0, 'CLI kappa：正常 → exit 0 [T5]');
  const poll = run(['poll', '--records', recFile]);
  assert(poll.status === 0 && /c1/.test(poll.stdout), 'CLI poll：正常 → exit 0 + 印 per-case [T5]');
  assert(run(['kappa', '--records', recFile]).status === 2, 'CLI kappa：缺 --gold → exit 2 [T5]');
  assert(run(['bogus']).status === 2, 'CLI：未知命令 → exit 2 [T5]');
  assert(run(['poll', '--records', join(dir, 'nope.jsonl')]).status === 3, 'CLI poll：records 讀檔失敗 → exit 3 [T5]');
  // 未知 --score-method → exit 2（不靜默落 majority）
  assert(run(['poll', '--records', recFile, '--score-method', 'mean']).status === 2,
    'CLI poll：未知 --score-method → exit 2 [T5]');
  // kappa 的 records / gold 讀檔失敗各為不同分支 → 皆 exit 3
  assert(run(['kappa', '--records', join(dir, 'nope.jsonl'), '--gold', goldFile]).status === 3,
    'CLI kappa：records 讀檔失敗 → exit 3 [T5]');
  assert(run(['kappa', '--records', recFile, '--gold', join(dir, 'nope.json')]).status === 3,
    'CLI kappa：gold 讀檔失敗 → exit 3 [T5]');
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.error('FAILED:\n' + failed.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
