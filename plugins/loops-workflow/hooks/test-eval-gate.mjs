#!/usr/bin/env node
// test-eval-gate.mjs —— eval-gate.mjs 的紅綠斷言（自帶極簡 harness，仿 test-stop-gate.mjs）。
// 用法（cwd = plugins/loops-workflow）：node hooks/test-eval-gate.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1。

import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { shouldRunEvalGate, buildEvalGateInjection } from './eval-gate.mjs';
// #49 新 export（shouldRunTagsGate / shouldRunPollGate / buildTagsGateInjection /
// buildPollGateInjection / composeInjections）尚未實作。用 namespace import 取用：缺 export 時為
// undefined（非 link-time crash），既有 9 smoke 不連坐，新斷言透過 callSafe 逐條轉紅。
import * as EG from './eval-gate.mjs';
import { editsStateFile, readEditsForSession, writeEditsState } from './edit-accumulator.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_GATE_SCRIPT = join(HERE, 'eval-gate.mjs');
const ACCUMULATOR_SCRIPT = join(HERE, 'edit-accumulator.mjs'); // 整合測試：真跑 producer

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed.push(msg); console.error(`  ✗ ${msg}`); }
}
// 仿 #51 test：包覆「尚未存在的 export」。缺函式 → 呼叫 undefined 丟 TypeError → threw=true →
// 對應斷言細粒度轉紅，而不在 link-time 連坐既有 smoke。
function callSafe(fn) {
  try { return { threw: false, val: fn() }; }
  catch (e) { return { threw: true, err: e }; }
}

let seq = 0;
function freshSession(prefix) {
  return `${prefix}-${process.pid}-${Date.now()}-${++seq}`;
}
function runHook(payload, extraEnv = {}) {
  const env = { ...process.env };
  delete env.LOOPS_EVAL_GATE;
  delete env.LOOPS_STOP_GATE;
  // #49：也清掉新旗標，確保只有本測明設者生效（否則繼承環境 → tags/poll 閘門意外觸發汙染斷言）。
  delete env.LOOPS_EVAL_TAGS_GATE;
  delete env.LOOPS_EVAL_POLL_GATE;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [EVAL_GATE_SCRIPT], { input: JSON.stringify(payload), env, encoding: 'utf8' });
}
// 建一個含 .loops/.metrics/eval-results.jsonl 的暫存 cwd；rows = JSONL 行內容。
function makeMetricsCwd(prefix, rows) {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  const dir = join(cwd, '.loops', '.metrics');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'eval-results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return cwd;
}
const REGRESSED = [{ corpus: 'X', passRate: 1.0 }, { corpus: 'X', passRate: 0.5 }]; // check → 退化 exit 1
const STABLE = [{ corpus: 'X', passRate: 1.0 }, { corpus: 'X', passRate: 1.0 }]; // check → 無退化 exit 0

// ── #49 共用 helper / fixture（tags + poll 閘門）──────────────────────────────────
// 失敗 tag 的 per-task report（eval-tags by-tag 吃 {tasks:[{id,tags,pass}]}）：
//   alpha 兩 task 1 過 1 敗 → summarizeByTag 得 alpha total 2 / passed 1 / failed 1（failed>0）。
const FAILED_TAG_TASKS = [
  { id: 't1', tags: ['alpha'], pass: true },
  { id: 't2', tags: ['alpha'], pass: false },
];
// 全綠 per-task report（alpha 兩 task 皆過 → summarizeByTag alpha failed===0 → buildTagsGateInjection 回 null）：
//   用於「ran-but-silent」斷言（閘門有跑但無失敗 → 不注入，仍需消費 edits）。
const ALLPASS_TAG_TASKS = [
  { id: 't1', tags: ['alpha'], pass: true },
  { id: 't2', tags: ['alpha'], pass: true },
];
// judge record（eval-poll poll 吃 track:'judge-estimate' 的 jsonl；欄位仿 buildJudgeRecord/aggregatePanel）：
//   c1 兩 judge 皆過 → 共識 pass、c2 兩 judge 皆敗 → 共識 fail → aggregatePanel 得 2 cases、loaded 4。
const JUDGE_RECORDS = [
  { track: 'judge-estimate', caseId: 'c1', judgeId: 'j1', model: 'm1', dimension: 'correctness', pass: true, score: 0.9 },
  { track: 'judge-estimate', caseId: 'c1', judgeId: 'j2', model: 'm2', dimension: 'correctness', pass: true, score: 0.8 },
  { track: 'judge-estimate', caseId: 'c2', judgeId: 'j1', model: 'm1', dimension: 'correctness', pass: false, score: 0.2 },
  { track: 'judge-estimate', caseId: 'c2', judgeId: 'j2', model: 'm2', dimension: 'correctness', pass: false, score: 0.3 },
];
const metricsDirOf = (cwd) => join(cwd, '.loops', '.metrics');
function makeGateCwd(prefix) {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(metricsDirOf(cwd), { recursive: true });
  return cwd;
}
function writeMetricsRows(cwd, rows) {
  writeFileSync(join(metricsDirOf(cwd), 'eval-results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
function writeTagsReport(cwd, tasks) {
  writeFileSync(join(metricsDirOf(cwd), 'eval-report.json'), JSON.stringify({ tasks }, null, 2));
}
function writeJudgeRecords(cwd, records) {
  writeFileSync(join(metricsDirOf(cwd), 'judge-results.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
// 在 cwd 放 .loops/gate.config.json（stop-gate 真會跑的判據；P2 defer 條件之一）。
function writeGateConfig(cwd, config = {}) {
  const dir = join(cwd, '.loops');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'gate.config.json'), JSON.stringify(config, null, 2));
}
// 仿既有 runHook，但額外清掉新旗標（LOOPS_EVAL_TAGS_GATE/LOOPS_EVAL_POLL_GATE），確保只有本測明設的旗標生效。
function runGate(payload, extraEnv = {}) {
  const env = { ...process.env };
  delete env.LOOPS_EVAL_GATE; delete env.LOOPS_STOP_GATE;
  delete env.LOOPS_EVAL_TAGS_GATE; delete env.LOOPS_EVAL_POLL_GATE;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [EVAL_GATE_SCRIPT], { input: JSON.stringify(payload), env, encoding: 'utf8' });
}
function ctxOf(res) {
  let out = null; try { out = JSON.parse(res.stdout); } catch { out = null; }
  return out?.hookSpecificOutput?.additionalContext ?? null;
}
const POLL_TRACE = /共識|eval-poll/;          // poll 注入痕跡
const METRICS_TRACE = /退化|regression|passRate/i; // 既有 metrics 退化注入痕跡

// =============================================================================
// A) 純函式
// =============================================================================

// ── A1 shouldRunEvalGate：三條件皆 true 才 true ──────────────────────────────
{
  assert(shouldRunEvalGate({ flagOn: true, hasMetrics: true, hasEdits: true }) === true, 'shouldRunEvalGate：三條件皆 true → true [A1]');
  assert(shouldRunEvalGate({ flagOn: false, hasMetrics: true, hasEdits: true }) === false, 'shouldRunEvalGate：flagOn=false → false [A1]');
  assert(shouldRunEvalGate({ flagOn: true, hasMetrics: false, hasEdits: true }) === false, 'shouldRunEvalGate：hasMetrics=false → false [A1]');
  assert(shouldRunEvalGate({ flagOn: true, hasMetrics: true, hasEdits: false }) === false, 'shouldRunEvalGate：hasEdits=false → false [A1]');
}

// ── A2 buildEvalGateInjection：僅 exit 1 注入；其餘 null；空輸出 fallback；截斷 ──
{
  assert(buildEvalGateInjection('regression: ...', 1) === 'regression: ...', 'buildEvalGateInjection：exit 1 → 回 check 輸出 [A2]');
  assert(buildEvalGateInjection('within tolerance', 0) === null, 'buildEvalGateInjection：exit 0（無退化）→ null（靜默）[A2]');
  assert(buildEvalGateInjection('usage: ...', 2) === null, 'buildEvalGateInjection：exit 2（誤用）→ null [A2]');
  assert(buildEvalGateInjection('whatever', null) === null, 'buildEvalGateInjection：exit null（spawn 異常）→ null [A2]');
  const fb = buildEvalGateInjection('   ', 1);
  assert(typeof fb === 'string' && fb.includes('退化'), 'buildEvalGateInjection：exit 1 但輸出空白 → fallback 退化提示（非空注入）[A2]');
  const long = buildEvalGateInjection('z'.repeat(10005), 1);
  assert(typeof long === 'string' && long.length === 10000, 'buildEvalGateInjection：>10000 截到 10000 [A2]');
}

// ── A3 shouldRunTagsGate：三條件（flagOn/hasEdits/hasReport）皆 true 才 true（真值表）[#49 契約] ──
{
  const f = (a) => callSafe(() => EG.shouldRunTagsGate(a));
  let r;
  r = f({ flagOn: true, hasEdits: true, hasReport: true });
  assert(!r.threw && r.val === true, 'shouldRunTagsGate：三皆 true → true [A3]');
  r = f({ flagOn: false, hasEdits: true, hasReport: true });
  assert(!r.threw && r.val === false, 'shouldRunTagsGate：flagOn=false → false [A3]');
  r = f({ flagOn: true, hasEdits: false, hasReport: true });
  assert(!r.threw && r.val === false, 'shouldRunTagsGate：hasEdits=false → false [A3]');
  r = f({ flagOn: true, hasEdits: true, hasReport: false });
  assert(!r.threw && r.val === false, 'shouldRunTagsGate：hasReport=false → false [A3]');
}

// ── A4 shouldRunPollGate：三條件（flagOn/hasEdits/hasJudge）皆 true 才 true（真值表）[#49 契約] ──
{
  const f = (a) => callSafe(() => EG.shouldRunPollGate(a));
  let r;
  r = f({ flagOn: true, hasEdits: true, hasJudge: true });
  assert(!r.threw && r.val === true, 'shouldRunPollGate：三皆 true → true [A4]');
  r = f({ flagOn: false, hasEdits: true, hasJudge: true });
  assert(!r.threw && r.val === false, 'shouldRunPollGate：flagOn=false → false [A4]');
  r = f({ flagOn: true, hasEdits: false, hasJudge: true });
  assert(!r.threw && r.val === false, 'shouldRunPollGate：hasEdits=false → false [A4]');
  r = f({ flagOn: true, hasEdits: true, hasJudge: false });
  assert(!r.threw && r.val === false, 'shouldRunPollGate：hasJudge=false → false [A4]');
}

// ── A5 buildTagsGateInjection(stdout, exitCode)：by-tag 輸出 → 失敗 tag 注入；非 0 / 無失敗 / 壞輸入 → null；cap ──
{
  // eval-tags by-tag 的合法輸出形狀（含失敗 tag alpha：failed 1 / total 2）
  const failStdout = JSON.stringify({ byTag: [{ tag: 'alpha', total: 2, passed: 1, failed: 1 }], note: 'per-tag' });
  // exitCode !== 0（含 1/2/3/null：by-tag 誤用 2、讀檔失敗 3、spawn 異常 null）→ null（不拿非法輸出當注入）
  for (const ec of [1, 2, 3, null]) {
    const r = callSafe(() => EG.buildTagsGateInjection(failStdout, ec));
    assert(!r.threw && r.val === null, `buildTagsGateInjection：exitCode=${ec} → null [A5]`);
  }
  // exit 0 + 有 failed>0 → 回字串，含失敗 tag 名與 <failed>/<total>
  {
    const r = callSafe(() => EG.buildTagsGateInjection(failStdout, 0));
    assert(!r.threw && typeof r.val === 'string' && r.val.includes('alpha'),
      'buildTagsGateInjection：exit0 有失敗 tag → 注入含 tag 名(alpha) [A5]');
    assert(!r.threw && typeof r.val === 'string' && r.val.includes('1/2'),
      'buildTagsGateInjection：注入含 <failed>/<total>（1/2）[A5]');
  }
  // 全 failed===0 → null（無事不擾）
  {
    const allPass = JSON.stringify({ byTag: [{ tag: 'alpha', total: 2, passed: 2, failed: 0 }], note: 'per-tag' });
    const r = callSafe(() => EG.buildTagsGateInjection(allPass, 0));
    assert(!r.threw && r.val === null, 'buildTagsGateInjection：全 failed===0 → null（無事不擾）[A5]');
  }
  // parse 失敗（亂字串）→ null
  {
    const r = callSafe(() => EG.buildTagsGateInjection('not-json {{{', 0));
    assert(!r.threw && r.val === null, 'buildTagsGateInjection：parse 失敗 → null [A5]');
  }
  // valid JSON 但形狀不符（無 byTag 欄）→ null（不拿空殼硬湊注入）[F4 wrong-shape]
  {
    const r = callSafe(() => EG.buildTagsGateInjection('{}', 0));
    assert(!r.threw && r.val === null, 'buildTagsGateInjection：valid JSON 但無 byTag → null（wrong-shape）[A5]');
  }
  // 整體超長 → cap 10000：用大量失敗 tag 逐 tag 累積超限 → 截到 10000。
  //   （單一 20000 字 tag 會先被「單 tag 長度上限」消毒截短、無法逼近 10000，故改以大量 tag 驗整體 cap；
  //    見 A8-security 的 per-tag cap 契約）
  {
    const byTag = [];
    for (let i = 0; i < 2000; i++) byTag.push({ tag: 'tag-' + 'y'.repeat(40) + i, total: 2, passed: 0, failed: 2 });
    const r = callSafe(() => EG.buildTagsGateInjection(JSON.stringify({ byTag, note: '' }), 0));
    assert(!r.threw && typeof r.val === 'string' && r.val.length === 10000, 'buildTagsGateInjection：整體超長（大量失敗 tag）→ cap 10000 [A5]');
  }
}

// ── A6 buildPollGateInjection(stdout, exitCode)：poll 輸出 → 共識注入；非 0 / loaded0 / 無 cases / 壞輸入 → null；cap ──
{
  // eval-poll poll 的合法輸出形狀（2 cases、loaded 4）
  const pollStdout = JSON.stringify({
    cases: [
      { caseId: 'c1', panelSize: 2, pass: true, passTie: false, score: 0.85, judges: ['j1', 'j2'] },
      { caseId: 'c2', panelSize: 2, pass: false, passTie: false, score: 0.25, judges: ['j1', 'j2'] },
    ],
    loaded: 4, skipped: 0, note: 'PoLL',
  });
  // exitCode !== 0 → null
  for (const ec of [1, 2, 3, null]) {
    const r = callSafe(() => EG.buildPollGateInjection(pollStdout, ec));
    assert(!r.threw && r.val === null, `buildPollGateInjection：exitCode=${ec} → null [A6]`);
  }
  // exit 0 + loaded>0 + 有 cases → 回字串，含「共識」與 case 數/loaded
  {
    const r = callSafe(() => EG.buildPollGateInjection(pollStdout, 0));
    assert(!r.threw && typeof r.val === 'string' && r.val.includes('共識'),
      'buildPollGateInjection：exit0 有 cases → 注入含「共識」[A6]');
    assert(!r.threw && typeof r.val === 'string' && r.val.includes('2 case') && r.val.includes('loaded 4'),
      'buildPollGateInjection：注入精確反映 case 數("2 case")與 loaded("loaded 4")（非任意含 2/4 的空殼）[A6]');
  }
  // loaded===0 → null
  {
    const empty = JSON.stringify({ cases: [], loaded: 0, skipped: 0, note: 'PoLL' });
    const r = callSafe(() => EG.buildPollGateInjection(empty, 0));
    assert(!r.threw && r.val === null, 'buildPollGateInjection：loaded===0 → null [A6]');
  }
  // loaded>0 但 cases 空 → null（無共識可報）
  {
    const noCases = JSON.stringify({ cases: [], loaded: 5, skipped: 0, note: 'PoLL' });
    const r = callSafe(() => EG.buildPollGateInjection(noCases, 0));
    assert(!r.threw && r.val === null, 'buildPollGateInjection：有 loaded 但 cases 空 → null [A6]');
  }
  // parse 失敗 → null
  {
    const r = callSafe(() => EG.buildPollGateInjection('garbage {{', 0));
    assert(!r.threw && r.val === null, 'buildPollGateInjection：parse 失敗 → null [A6]');
  }
  // valid JSON 但缺 loaded 欄（只有 cases:[]）→ null（形狀不符不硬湊）[F4 wrong-shape]
  {
    const r = callSafe(() => EG.buildPollGateInjection('{"cases":[]}', 0));
    assert(!r.threw && r.val === null, 'buildPollGateInjection：缺 loaded 欄 → null（wrong-shape）[A6]');
  }
  // 超長 → 永不超限（cap ≤ 10000）。塞大量 case → 任何「逐 case 列出」實作都會超限被截；
  //   純聚合實作天然 < 10000、亦合「永不超限」契約。本條 guard 抓「未 cap」實作。
  {
    const many = { cases: [], loaded: 0, skipped: 0, note: '' };
    for (let i = 0; i < 3000; i++) {
      many.cases.push({ caseId: 'case-' + 'z'.repeat(40) + i, panelSize: 1, pass: false, passTie: false, score: 0.1, judges: ['j'] });
    }
    many.loaded = many.cases.length;
    const r = callSafe(() => EG.buildPollGateInjection(JSON.stringify(many), 0));
    assert(!r.threw && typeof r.val === 'string' && r.val.length <= 10000, 'buildPollGateInjection：超長 → cap ≤10000（永不超限）[A6]');
  }
}

// ── A7 composeInjections(parts)：濾 null/空白 → 雙換行 join；全空 → null；非陣列 → null；cap ──
{
  // 全 null/空白 → null
  {
    const r = callSafe(() => EG.composeInjections([null, undefined, '', '   ']));
    assert(!r.threw && r.val === null, 'composeInjections：全 null/空白 → null [A7]');
  }
  // 空陣列 → null
  {
    const r = callSafe(() => EG.composeInjections([]));
    assert(!r.threw && r.val === null, 'composeInjections：空陣列 → null [A7]');
  }
  // 多個非 null：濾掉 null/空白後以雙換行 join，各段都在
  {
    const r = callSafe(() => EG.composeInjections(['第一段', null, '   ', '第二段']));
    assert(!r.threw && r.val === '第一段\n\n第二段', "composeInjections：濾 null/空白後以雙換行 join → '第一段\\n\\n第二段' [A7]");
    const parts = typeof r.val === 'string' ? r.val.split('\n\n') : [];
    assert(parts.length === 2 && parts[0] === '第一段' && parts[1] === '第二段',
      'composeInjections：各段都在、以雙換行分隔（split 還原為 2 段）[A7]');
  }
  // 單一非空 → 該段本身（無多餘分隔）
  {
    const r = callSafe(() => EG.composeInjections(['only', null]));
    assert(!r.threw && r.val === 'only', 'composeInjections：單一非空 → 該段本身（無前後多餘換行）[A7]');
  }
  // 整體超長 → cap 10000
  {
    const r = callSafe(() => EG.composeInjections(['x'.repeat(20000)]));
    assert(!r.threw && typeof r.val === 'string' && r.val.length === 10000, 'composeInjections：整體超長 → cap 10000 [A7]');
  }
  // 非陣列 → null（不丟）
  {
    const r = callSafe(() => EG.composeInjections(null));
    assert(!r.threw && r.val === null, 'composeInjections：非陣列 → null（不丟）[A7]');
  }
}

// ── A8 security：buildTagsGateInjection 消毒 tag 名（strip 換行/控制字元、單 tag 名 cap 80）後才注入 ──
//    tag 名來自 corpus 資料，未消毒直接拼進 additionalContext = prompt-injection / 偽造行面（LLM 會讀此 context）。
//    對「verbatim（原樣拼接）」impl 先紅。
{
  const RAW_X = 'x'.repeat(200);                                // 超長（> 80 上限）
  const evilTag = 'mark1\nmark2\r[31m' + RAW_X;     // 換行(LF) + CR + 超長（皆消毒目標）
  const stdout = JSON.stringify({ byTag: [{ tag: evilTag, total: 2, passed: 0, failed: 2 }], note: '' });
  const r = callSafe(() => EG.buildTagsGateInjection(stdout, 0));
  assert(!r.threw && typeof r.val === 'string', 'security：有失敗 tag → 消毒後仍回注入字串 [A8-security]');
  const s = typeof r.val === 'string' ? r.val : '';
  // (1) tag 內換行被 strip：tag 原樣換行串 'mark1\nmark2' 不得出現於注入（否則惡意 tag 可偽造額外行）
  assert(!s.includes('mark1\nmark2'),
    'security：tag 名換行被 strip → 注入不含 tag 原樣換行串(mark1\\nmark2)（防偽造行注入）[A8-security]');
  // (2) 控制字元（CR / BEL / ESC）被 strip、不殘留（合法格式只用 \n，不會有 \r//）
  assert(!/[\r]/.test(s),
    'security：tag 名控制字元（CR/BEL/ESC）被 strip、不殘留於注入 [A8-security]');
  // (3) 單 tag 名超長被截到上限（≤80）：200 連續 x 不得整段保留（出現 81 連 x 即未截）
  assert(!s.includes('x'.repeat(81)),
    'security：單 tag 名超長被截到上限（≤80）→ 注入無 81 連續 x（verbatim 保留 200 x → 先紅）[A8-security]');
}

// =============================================================================
// SMOKE — 真 spawn eval-gate.mjs
// =============================================================================

// ── S1：flag 關 → no-op（無輸出、不動 accumulator）─────────────────────────────
{
  const sessionId = freshSession('eg-off');
  const cwd = makeMetricsCwd('eg-off-', REGRESSED);
  writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    const res = runHook({ session_id: sessionId, cwd }); // 未設 LOOPS_EVAL_GATE
    assert(res.status === 0, 'S1：flag 關 → exit 0 [S1]');
    assert((res.stdout || '').trim() === '', 'S1：flag 關 → 無輸出（no-op）[S1]');
    assert(readEditsForSession(sessionId).length === 1, 'S1：flag 關 → 不動 accumulator（seed 仍在）[S1]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S2：flag 開 + 無歷史檔 → no-op ───────────────────────────────────────────
{
  const sessionId = freshSession('eg-nofile');
  const cwd = mkdtempSync(join(tmpdir(), 'eg-nofile-')); // 無 .loops/.metrics
  writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    const res = runHook({ session_id: sessionId, cwd }, { LOOPS_EVAL_GATE: '1' });
    assert(res.status === 0 && (res.stdout || '').trim() === '', 'S2：flag 開但無 eval-results.jsonl → no-op [S2]');
    assert(readEditsForSession(sessionId).length === 1, 'S2：無歷史檔 → 未進閘門、不清 accumulator（seed 仍在；分辨「短路 vs 跑空閘」）[S2]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S3：flag 開 + 歷史檔 + 無 edits → no-op（控成本：只在改檔回合跑）──────────────
{
  const sessionId = freshSession('eg-noedit');
  const cwd = makeMetricsCwd('eg-noedit-', REGRESSED);
  rmSync(editsStateFile(sessionId), { force: true }); // 無 edits
  try {
    const res = runHook({ session_id: sessionId, cwd }, { LOOPS_EVAL_GATE: '1' });
    assert(res.status === 0 && (res.stdout || '').trim() === '', 'S3：無 edits → no-op（即便有退化也不跑，控成本）[S3]');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

// ── S4：flag 開 + 退化歷史 + edits（stop-gate 關）→ 注入退化警示 + accumulator 被清 ──
{
  const sessionId = freshSession('eg-reg');
  const cwd = makeMetricsCwd('eg-reg-', REGRESSED);
  writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    const res = runHook({ session_id: sessionId, cwd }, { LOOPS_EVAL_GATE: '1' }); // LOOPS_STOP_GATE 未設
    assert(res.error == null, 'S4：node 啟動成功 [S4]');
    let out = null; try { out = JSON.parse(res.stdout); } catch { out = null; }
    const ctx = out?.hookSpecificOutput?.additionalContext;
    assert(typeof ctx === 'string' && ctx.length > 0, 'S4：退化 → 注入 hookSpecificOutput.additionalContext [S4]');
    assert(out?.hookSpecificOutput?.hookEventName === 'Stop', 'S4：注入帶 hookEventName===Stop（CC 才認）[S4]');
    assert(/退化|regression|passRate/i.test(ctx || ''), 'S4：注入內容反映真退化（含 退化/regression/passRate）非空殼 [S4]');
    assert(readEditsForSession(sessionId).length === 0, 'S4：stop-gate 關 → 本 hook 清 accumulator（readEditsForSession === []）[S4]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S5：flag 開 + 退化 + edits + LOOPS_STOP_GATE=1 + gate.config.json（stop-gate 真會跑）→ 仍注入、accumulator 不清（defer 給 stop-gate）──
//    P2 契約：defer = (LOOPS_STOP_GATE==='1' && existsSync(cwd/.loops/gate.config.json))。此處兩條件齊備 → 須 defer、不清。
{
  const sessionId = freshSession('eg-coexist');
  const cwd = makeMetricsCwd('eg-coexist-', REGRESSED);
  writeGateConfig(cwd); // stop-gate 真會跑的判據 → eval-gate 才該 defer
  writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    const res = runHook({ session_id: sessionId, cwd }, { LOOPS_EVAL_GATE: '1', LOOPS_STOP_GATE: '1' });
    let out = null; try { out = JSON.parse(res.stdout); } catch { out = null; }
    assert(typeof out?.hookSpecificOutput?.additionalContext === 'string', 'S5：退化 → 仍注入 [S5]');
    assert(readEditsForSession(sessionId).length === 1, 'S5：STOP_GATE=1 + gate.config.json（stop-gate 會跑）→ defer、本 hook 不清 accumulator（seed 仍在）[S5]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S-leak-noconfig（P2 先紅）：STOP_GATE=1 + EVAL_GATE=1 + 退化 + edits + 無 gate.config.json → 跑完須清 accumulator ──
//    P2 契約：defer 須同時 STOP_GATE=1 *且* gate.config.json 存在。此處缺 config → stop-gate 根本不會跑 →
//    不該 defer，本 hook 自己清。現 impl 只看 STOP_GATE=1 就盲 defer → 不清 → edits 洩漏（沒人清）→ 本條先紅。
{
  const sessionId = freshSession('eg-leak-noconfig');
  const cwd = makeMetricsCwd('eg-leak-noconfig-', REGRESSED); // 無 gate.config.json
  writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    const res = runHook({ session_id: sessionId, cwd }, { LOOPS_EVAL_GATE: '1', LOOPS_STOP_GATE: '1' });
    let out = null; try { out = JSON.parse(res.stdout); } catch { out = null; }
    assert(typeof out?.hookSpecificOutput?.additionalContext === 'string', 'S-leak-noconfig：退化 → 仍注入 [S-leak-noconfig]');
    assert(readEditsForSession(sessionId).length === 0,
      'S-leak-noconfig：STOP_GATE=1 但無 gate.config.json（stop-gate 不會跑）→ 不該 defer、本 hook 須清 accumulator（現 impl 盲 defer → 洩漏 → 先紅）[S-leak-noconfig]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S6：flag 開 + 無退化歷史 + edits → 靜默（無注入）+ accumulator 被清（stop-gate 關）──
{
  const sessionId = freshSession('eg-stable');
  const cwd = makeMetricsCwd('eg-stable-', STABLE);
  writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    const res = runHook({ session_id: sessionId, cwd }, { LOOPS_EVAL_GATE: '1' });
    assert(res.status === 0, 'S6：無退化 → exit 0 [S6]');
    assert(!(res.stdout || '').includes('additionalContext'), 'S6：無退化 → 無注入（靜默）[S6]');
    assert(readEditsForSession(sessionId).length === 0, 'S6：跑完清 accumulator（stop-gate 關）[S6]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S7（整合）：只開 LOOPS_EVAL_GATE → 真 edit-accumulator 累積 → eval-gate 端到端跑（producer→consumer 接線；守 P1 回歸）──
{
  const sessionId = freshSession('eg-integ');
  const cwd = makeMetricsCwd('eg-integ-', REGRESSED);
  rmSync(editsStateFile(sessionId), { force: true });
  try {
    const accEnv = { ...process.env }; delete accEnv.LOOPS_STOP_GATE; accEnv.LOOPS_EVAL_GATE = '1';
    const acc = spawnSync(process.execPath, [ACCUMULATOR_SCRIPT], {
      input: JSON.stringify({ session_id: sessionId, tool_input: { file_path: join(tmpdir(), `f-${sessionId}.ts`) } }),
      env: accEnv, encoding: 'utf8',
    });
    assert(acc.status === 0, 'S7：edit-accumulator exit 0 [S7]');
    assert(readEditsForSession(sessionId).length === 1, 'S7：只開 LOOPS_EVAL_GATE → accumulator 仍累積（producer 認 eval-gate；守 P1）[S7]');
    const res = runHook({ session_id: sessionId, cwd }, { LOOPS_EVAL_GATE: '1' });
    let out = null; try { out = JSON.parse(res.stdout); } catch { out = null; }
    assert(typeof out?.hookSpecificOutput?.additionalContext === 'string', 'S7：accumulator 有編輯 → eval-gate 端到端跑並注入退化 [S7]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S8：flag 開但 payload 壞（非 JSON）→ no-op exit 0、無輸出（永不擋路）──
{
  const cwd = makeMetricsCwd('eg-badpay-', REGRESSED);
  try {
    const res = spawnSync(process.execPath, [EVAL_GATE_SCRIPT], { input: 'not-json', env: { ...process.env, LOOPS_EVAL_GATE: '1' }, encoding: 'utf8' });
    assert(res.status === 0 && (res.stdout || '').trim() === '', 'S8：payload 壞 → exit 0、無輸出（永不擋路）[S8]');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

// ── S9：flag 開但 payload 缺 cwd（已 seed edits）→ no-op、不清 accumulator（早退在清之前）──
{
  const sessionId = freshSession('eg-nocwd');
  writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    const res = runHook({ session_id: sessionId }, { LOOPS_EVAL_GATE: '1' }); // 無 cwd
    assert(res.status === 0 && (res.stdout || '').trim() === '', 'S9：缺 cwd → exit 0、無輸出 [S9]');
    assert(readEditsForSession(sessionId).length === 1, 'S9：缺 cwd 早退 → 不清 accumulator（seed 仍在）[S9]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); }
}

// =============================================================================
// SMOKE — #49 tags / poll 閘門（真 spawn eval-gate.mjs；新閘門尚未實作 → 驅動條先紅）
// =============================================================================

// ── S-tags-on：LOOPS_EVAL_TAGS_GATE=1 + eval-report.json（失敗 tag）+ edits → 注入含 eval-tags 與失敗 tag ──
{
  const sessionId = freshSession('eg-tags-on');
  const cwd = makeGateCwd('eg-tags-on-');
  writeTagsReport(cwd, FAILED_TAG_TASKS);
  writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    const res = runGate({ session_id: sessionId, cwd }, { LOOPS_EVAL_TAGS_GATE: '1' });
    assert(res.status === 0, 'S-tags-on：TAGS 開 + report + edits → exit 0 [S-tags-on]');
    const ctx = ctxOf(res);
    assert(typeof ctx === 'string' && ctx.includes('eval-tags'), 'S-tags-on：注入 additionalContext 含 eval-tags 標記 [S-tags-on]');
    assert(typeof ctx === 'string' && ctx.includes('alpha'), 'S-tags-on：注入含失敗 tag(alpha)（反映真 report，非空殼）[S-tags-on]');
    // P2 清理：tags 閘門 ran（消費 edits）、stop-gate 關（無 STOP_GATE/config）→ ranAny 含 tags.ran → 跑完須清 accumulator。
    //   guard：正確 ranAny（含 tags.ran）下即綠；若有人把 ranAny 收窄成只認 gate.ran，本條轉紅。
    assert(readEditsForSession(sessionId).length === 0,
      'S-tags-on：tags 閘門 ran → 跑完清 accumulator（ranAny 須含 tags.ran；stop-gate 關）[S-tags-on]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S-poll-on：LOOPS_EVAL_POLL_GATE=1 + judge-results.jsonl + edits → 注入含 eval-poll / 共識 ──
{
  const sessionId = freshSession('eg-poll-on');
  const cwd = makeGateCwd('eg-poll-on-');
  writeJudgeRecords(cwd, JUDGE_RECORDS);
  writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    const res = runGate({ session_id: sessionId, cwd }, { LOOPS_EVAL_POLL_GATE: '1' });
    assert(res.status === 0, 'S-poll-on：POLL 開 + judge + edits → exit 0 [S-poll-on]');
    const ctx = ctxOf(res);
    assert(typeof ctx === 'string' && ctx.includes('eval-poll'), 'S-poll-on：注入含 eval-poll 標記 [S-poll-on]');
    assert(typeof ctx === 'string' && ctx.includes('共識'), 'S-poll-on：注入含「共識」（反映真 judge 投票聚合）[S-poll-on]');
    // P2 清理：poll 閘門 ran（消費 edits）、stop-gate 關 → ranAny 含 poll.ran → 跑完須清 accumulator（guard，同 S-tags-on）。
    assert(readEditsForSession(sessionId).length === 0,
      'S-poll-on：poll 閘門 ran → 跑完清 accumulator（ranAny 須含 poll.ran；stop-gate 關）[S-poll-on]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S-tags-producer（P1 整合，先紅）：只開 LOOPS_EVAL_TAGS_GATE → 真 edit-accumulator producer 記 edit → eval-gate 端到端注入 ──
//    仿 S7，但餵新旗標。P1 契約：producer 認 4 旗標任一開即記 edit。現 producer 只認 STOP/EVAL_GATE →
//    只開 TAGS 時不記 edit → length===0 → producer 斷言先紅。
{
  const sessionId = freshSession('eg-tags-prod');
  const cwd = makeGateCwd('eg-tags-prod-');
  writeTagsReport(cwd, FAILED_TAG_TASKS);
  rmSync(editsStateFile(sessionId), { force: true });
  try {
    const accEnv = { ...process.env };
    delete accEnv.LOOPS_STOP_GATE; delete accEnv.LOOPS_EVAL_GATE;
    delete accEnv.LOOPS_EVAL_TAGS_GATE; delete accEnv.LOOPS_EVAL_POLL_GATE;
    accEnv.LOOPS_EVAL_TAGS_GATE = '1'; // 只開第 3 旗標
    const acc = spawnSync(process.execPath, [ACCUMULATOR_SCRIPT], {
      input: JSON.stringify({ session_id: sessionId, tool_input: { file_path: join(tmpdir(), `f-${sessionId}.ts`) } }),
      env: accEnv, encoding: 'utf8',
    });
    assert(acc.status === 0, 'S-tags-producer：edit-accumulator exit 0 [S-tags-producer]');
    assert(readEditsForSession(sessionId).length === 1,
      'S-tags-producer：只開 LOOPS_EVAL_TAGS_GATE → producer 仍記 edit（P1 契約 producer 認 4 旗標任一；現只認 STOP/EVAL_GATE → 先紅）[S-tags-producer]');
    const res = runGate({ session_id: sessionId, cwd }, { LOOPS_EVAL_TAGS_GATE: '1' });
    const ctx = ctxOf(res);
    assert(typeof ctx === 'string' && ctx.includes('eval-tags') && ctx.includes('alpha'),
      'S-tags-producer：producer 有 edit → eval-gate 端到端注入含 eval-tags 與失敗 tag(alpha)（producer→consumer 接線）[S-tags-producer]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S-poll-producer（P1 整合，先紅）：只開 LOOPS_EVAL_POLL_GATE → producer 記 edit → eval-gate 端到端注入「共識」──
{
  const sessionId = freshSession('eg-poll-prod');
  const cwd = makeGateCwd('eg-poll-prod-');
  writeJudgeRecords(cwd, JUDGE_RECORDS);
  rmSync(editsStateFile(sessionId), { force: true });
  try {
    const accEnv = { ...process.env };
    delete accEnv.LOOPS_STOP_GATE; delete accEnv.LOOPS_EVAL_GATE;
    delete accEnv.LOOPS_EVAL_TAGS_GATE; delete accEnv.LOOPS_EVAL_POLL_GATE;
    accEnv.LOOPS_EVAL_POLL_GATE = '1'; // 只開第 4 旗標
    const acc = spawnSync(process.execPath, [ACCUMULATOR_SCRIPT], {
      input: JSON.stringify({ session_id: sessionId, tool_input: { file_path: join(tmpdir(), `f-${sessionId}.ts`) } }),
      env: accEnv, encoding: 'utf8',
    });
    assert(acc.status === 0, 'S-poll-producer：edit-accumulator exit 0 [S-poll-producer]');
    assert(readEditsForSession(sessionId).length === 1,
      'S-poll-producer：只開 LOOPS_EVAL_POLL_GATE → producer 仍記 edit（P1 契約 producer 認 4 旗標任一；現只認 STOP/EVAL_GATE → 先紅）[S-poll-producer]');
    const res = runGate({ session_id: sessionId, cwd }, { LOOPS_EVAL_POLL_GATE: '1' });
    const ctx = ctxOf(res);
    assert(typeof ctx === 'string' && ctx.includes('共識'),
      'S-poll-producer：producer 有 edit → eval-gate 端到端注入含「共識」（producer→consumer 接線）[S-poll-producer]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S-tags-allpass-clears（P2）：TAGS=1 + 全綠 report（無失敗 tag → 無注入）+ edits → 無注入「且」ran 仍消費 edits ──
//    驗 ran-but-silent：閘門有跑（hasReport 成立）但無失敗 tag 故靜默；ranAny 仍須為真 → 清 accumulator。
{
  const sessionId = freshSession('eg-tags-allpass');
  const cwd = makeGateCwd('eg-tags-allpass-');
  writeTagsReport(cwd, ALLPASS_TAG_TASKS);
  writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    const res = runGate({ session_id: sessionId, cwd }, { LOOPS_EVAL_TAGS_GATE: '1' });
    assert(res.status === 0, 'S-tags-allpass-clears：exit 0 [S-tags-allpass-clears]');
    assert(!(res.stdout || '').includes('additionalContext'),
      'S-tags-allpass-clears：tag 全綠 → 無失敗 tag → 無注入（靜默）[S-tags-allpass-clears]');
    assert(readEditsForSession(sessionId).length === 0,
      'S-tags-allpass-clears：tags 閘門 ran（雖無注入）→ 仍消費 edits（ran-but-silent 也清 accumulator）[S-tags-allpass-clears]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S-tags-corrupt（F5 corrupt-input smoke）：TAGS=1 + eval-report.json 為亂字串（非 JSON）+ edits → 真 spawn eval-gate ──
//    eval-tags 讀檔/parse 失敗 → exit 3 → buildTagsGateInjection(out,3)===null：壞輸入不擋路（exit 0、無注入），
//    但閘門 ran（hasReport=檔存在）→ 仍消費 edits（ranAny 為真 → 清）。
{
  const sessionId = freshSession('eg-tags-corrupt');
  const cwd = makeGateCwd('eg-tags-corrupt-');
  writeFileSync(join(metricsDirOf(cwd), 'eval-report.json'), 'not-json {{{ totally broken   garbage');
  writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    const res = runGate({ session_id: sessionId, cwd }, { LOOPS_EVAL_TAGS_GATE: '1' });
    assert(res.status === 0, 'S-tags-corrupt：壞 eval-report.json → exit 0（壞輸入不擋路）[S-tags-corrupt]');
    assert(!(res.stdout || '').includes('additionalContext'),
      'S-tags-corrupt：eval-tags 讀檔失敗(exit 3) → 無注入（不拿非法輸出硬湊）[S-tags-corrupt]');
    assert(readEditsForSession(sessionId).length === 0,
      'S-tags-corrupt：閘門 ran（即便讀檔失敗）→ 仍消費 edits（ranAny 為真 → 清 accumulator）[S-tags-corrupt]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S-independent：三輸入齊但只開 TAGS（GATE/POLL 關）→ 只有 tags 注入、無 metrics/poll 痕跡（驗三 flag 獨立）──
{
  const sessionId = freshSession('eg-indep');
  const cwd = makeGateCwd('eg-indep-');
  writeMetricsRows(cwd, REGRESSED);       // 退化 metrics（GATE 關 → 不該注入）
  writeTagsReport(cwd, FAILED_TAG_TASKS); // 失敗 tag（TAGS 開 → 該注入）
  writeJudgeRecords(cwd, JUDGE_RECORDS);  // judge（POLL 關 → 不該注入）
  writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    const res = runGate({ session_id: sessionId, cwd }, { LOOPS_EVAL_TAGS_GATE: '1' }); // 只開 TAGS
    assert(res.status === 0, 'S-independent：exit 0 [S-independent]');
    const ctx = ctxOf(res);
    assert(typeof ctx === 'string' && ctx.includes('eval-tags') && ctx.includes('alpha'), 'S-independent：只開 TAGS → 有 tags 注入 [S-independent]');
    assert(typeof ctx === 'string' && !POLL_TRACE.test(ctx), 'S-independent：POLL 關 → 無 poll 痕跡（共識/eval-poll）[S-independent]');
    assert(typeof ctx === 'string' && !METRICS_TRACE.test(ctx), 'S-independent：GATE 關 → 無 metrics 退化痕跡（退化/regression/passRate）[S-independent]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S-tags-noinput：TAGS 開 + edits 但無 eval-report.json → no-op exit 0、無注入（缺輸入不炸不擋）[guard] ──
{
  const sessionId = freshSession('eg-tags-noin');
  const cwd = makeGateCwd('eg-tags-noin-'); // 有 .loops/.metrics 但無 eval-report.json
  writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    const res = runGate({ session_id: sessionId, cwd }, { LOOPS_EVAL_TAGS_GATE: '1' });
    assert(res.status === 0 && (res.stdout || '').trim() === '', 'S-tags-noinput：TAGS 開但無 eval-report.json → no-op exit 0、無注入 [S-tags-noinput]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S-poll-noinput：POLL 開 + edits 但無 judge-results.jsonl → no-op exit 0、無注入 [guard] ──
{
  const sessionId = freshSession('eg-poll-noin');
  const cwd = makeGateCwd('eg-poll-noin-'); // 無 judge-results.jsonl
  writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    const res = runGate({ session_id: sessionId, cwd }, { LOOPS_EVAL_POLL_GATE: '1' });
    assert(res.status === 0 && (res.stdout || '').trim() === '', 'S-poll-noinput：POLL 開但無 judge-results.jsonl → no-op exit 0、無注入 [S-poll-noinput]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S-noedits：TAGS 開 + 有 eval-report.json 但無 edits → no-op（控成本：只在改檔回合跑）[guard] ──
{
  const sessionId = freshSession('eg-tags-noedit');
  const cwd = makeGateCwd('eg-tags-noedit-');
  writeTagsReport(cwd, FAILED_TAG_TASKS);
  rmSync(editsStateFile(sessionId), { force: true }); // 確保無 edits
  try {
    const res = runGate({ session_id: sessionId, cwd }, { LOOPS_EVAL_TAGS_GATE: '1' });
    assert(res.status === 0 && (res.stdout || '').trim() === '', 'S-noedits：TAGS 開 + 有 report 但無 edits → no-op（控成本）[S-noedits]');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

// ── S-alloff：三 flag 全關 + 三輸入齊 → no-op exit 0、無輸出、不動 accumulator（新增不破壞「預設全關」）[guard] ──
{
  const sessionId = freshSession('eg-alloff');
  const cwd = makeGateCwd('eg-alloff-');
  writeMetricsRows(cwd, REGRESSED);
  writeTagsReport(cwd, FAILED_TAG_TASKS);
  writeJudgeRecords(cwd, JUDGE_RECORDS);
  writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    const res = runGate({ session_id: sessionId, cwd }); // runGate 清掉全部旗標 → 三 flag 全關
    assert(res.status === 0, 'S-alloff：三 flag 全關 → exit 0 [S-alloff]');
    assert((res.stdout || '').trim() === '', 'S-alloff：三 flag 全關 → 無輸出（no-op）即便三輸入齊 [S-alloff]');
    assert(readEditsForSession(sessionId).length === 1, 'S-alloff：全關 → 不動 accumulator（seed 仍在）[S-alloff]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S-combo：GATE+TAGS+POLL 全開 + 三輸入齊 → 單一 additionalContext 同時含三訊號痕跡（合併注入）──
{
  const sessionId = freshSession('eg-combo');
  const cwd = makeGateCwd('eg-combo-');
  writeMetricsRows(cwd, REGRESSED);
  writeTagsReport(cwd, FAILED_TAG_TASKS);
  writeJudgeRecords(cwd, JUDGE_RECORDS);
  writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    const res = runGate({ session_id: sessionId, cwd }, { LOOPS_EVAL_GATE: '1', LOOPS_EVAL_TAGS_GATE: '1', LOOPS_EVAL_POLL_GATE: '1' });
    assert(res.status === 0, 'S-combo：三 gate 全開 → exit 0 [S-combo]');
    let out = null; try { out = JSON.parse(res.stdout); } catch { out = null; }
    const ctx = out?.hookSpecificOutput?.additionalContext;
    assert(typeof ctx === 'string' && ctx.length > 0, 'S-combo：合併為單一 additionalContext [S-combo]');
    assert(out?.hookSpecificOutput?.hookEventName === 'Stop', 'S-combo：注入帶 hookEventName===Stop（CC 才認）[S-combo]');
    assert(typeof ctx === 'string' && METRICS_TRACE.test(ctx), 'S-combo：含 metrics 退化痕跡（退化/regression/passRate）[S-combo]');
    assert(typeof ctx === 'string' && ctx.includes('eval-tags') && ctx.includes('alpha'), 'S-combo：含 tags 痕跡（eval-tags + 失敗 tag alpha）[S-combo]');
    assert(typeof ctx === 'string' && ctx.includes('共識'), 'S-combo：含 poll 痕跡（共識）[S-combo]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S-combo-idempotent：S-combo 連跑兩次（每跑前 re-seed edits）→ additionalContext 逐字相同（確定性/冪等）──
{
  const sessionId = freshSession('eg-combo-idem');
  const cwd = makeGateCwd('eg-combo-idem-');
  writeMetricsRows(cwd, REGRESSED);
  writeTagsReport(cwd, FAILED_TAG_TASKS);
  writeJudgeRecords(cwd, JUDGE_RECORDS);
  const env = { LOOPS_EVAL_GATE: '1', LOOPS_EVAL_TAGS_GATE: '1', LOOPS_EVAL_POLL_GATE: '1' };
  const seed = () => writeEditsState(sessionId, [join(tmpdir(), `e-${sessionId}.ts`)]);
  try {
    seed();
    const r1 = runGate({ session_id: sessionId, cwd }, env);
    seed(); // 首跑（stop-gate 關）會清 accumulator → 第二跑前先 re-seed，否則無 edits 退化成 no-op
    const r2 = runGate({ session_id: sessionId, cwd }, env);
    const c1 = ctxOf(r1);
    const c2 = ctxOf(r2);
    assert(typeof c1 === 'string' && typeof c2 === 'string', 'S-combo-idempotent：兩跑皆有注入 [S-combo-idempotent]');
    assert(c1 === c2, 'S-combo-idempotent：同輸入連跑兩次 additionalContext 逐字相同（確定性/冪等）[S-combo-idempotent]');
    assert(typeof c1 === 'string' && METRICS_TRACE.test(c1) && c1.includes('eval-tags') && c1.includes('共識'),
      'S-combo-idempotent：注入仍同時含三訊號痕跡（合併注入未退化）[S-combo-idempotent]');
  } finally { rmSync(editsStateFile(sessionId), { force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

// ── S-badpayload：任一 flag 開 + payload 非 JSON → exit 0、無輸出（永不擋路）[guard] ──
{
  const cwd = makeGateCwd('eg-tags-badpay-');
  writeTagsReport(cwd, FAILED_TAG_TASKS);
  try {
    const env = { ...process.env };
    delete env.LOOPS_EVAL_GATE; delete env.LOOPS_STOP_GATE; delete env.LOOPS_EVAL_POLL_GATE;
    env.LOOPS_EVAL_TAGS_GATE = '1';
    const res = spawnSync(process.execPath, [EVAL_GATE_SCRIPT], { input: 'not-json', env, encoding: 'utf8' });
    assert(res.status === 0 && (res.stdout || '').trim() === '', 'S-badpayload：TAGS 開 + payload 非 JSON → exit 0、無輸出（永不擋路）[S-badpayload]');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
