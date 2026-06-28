#!/usr/bin/env node
// eval-panel.mjs —— eval Phase 3：judge panel orchestrator 的確定性膠水（issue #47）。
//
// 把 #32 eval-judge + #33 eval-poll 的既有 export **組合**成：N 個 judge verdict → panel 共識（PoLL 投票）
//   + 該 case 對金標的 agreement。零重造（只 import 組合）。
//
// 混合：**派 N judge 留上層**（`references/eval-judge-panel.md` recipe、主迴圈同回合派、本 script **不 spawn**）；
//   本 script 只做組合的確定性部分。**跨 case 的 Cohen κ 校準＝既有 `eval-poll.mjs kappa`**（對累積的
//   judge-results.jsonl 跑），不在此重造（單 case κ 會退化）。
//
// 用法：node eval-panel.mjs run --rubric <rubric.md> --verdicts <verdicts.jsonl> --case-id <id> [--gold <gold.json>] [--judge-file <out.jsonl>]

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseRubricMeta, validateRubric, parseVerdict, validateVerdict, buildJudgeRecord, appendJudgeRecord } from './eval-judge.mjs';
import { aggregatePanel } from './eval-poll.mjs';

const CALIBRATION_NOTE = '跨 case 的 Cohen κ 校準：對累積的 judge-results.jsonl 跑 `eval-poll.mjs kappa --records <jsonl> --gold <json>`';

// ── 純函式：組合 N verdict → 共識 + 金標 agreement ────────────────────────────────

/**
 * 把 N 個 judge verdict（`{judgeId, model, output}`，output＝raw 文字）依 rubric 解析成 record →
 * aggregatePanel 出單 case 共識；有 gold 則算該 case 共識 vs 金標的 agreement。
 * 複用 #32 解析/驗證/分軌 + #33 投票聚合；不 spawn、跨 case κ 不在此（見 CALIBRATION_NOTE）。
 */
export function runPanel(verdicts, { rubricMeta = {}, caseId = null, gold = null, ts = null } = {}) {
  const list = Array.isArray(verdicts) ? verdicts : [];
  const params = {
    scaleMin: rubricMeta.scaleMin,
    scaleMax: rubricMeta.scaleMax,
    threshold: rubricMeta.threshold,
    dimension: rubricMeta.dimension,
  };
  const records = list.map((v) => {
    const validated = validateVerdict(parseVerdict(v?.output), params);
    return buildJudgeRecord(validated, { judgeId: v?.judgeId ?? null, model: v?.model ?? null, caseId, ts });
  });
  // **棄權語意**：只有 valid 的 verdict 投票——解析失敗 / 越界的 judge 是「沒投票」（不是投反對），否則 N=2
  // 時單一壞輸出會把共識翻成平手/不過。壞 record 仍計入 panelSize、仍落檔（透明），但不進投票池。
  const voting = records.filter((r) => r.valid === true);
  const consensus = aggregatePanel(voting, {})[0] ?? null;
  return {
    caseId,
    panelSize: records.length,
    validCount: voting.length,
    consensus,
    records,
    goldAgreement: computeGoldAgreement(gold, caseId, consensus),
    calibrationNote: CALIBRATION_NOTE,
  };
}

/** 該 case 的 panel 共識 pass vs 金標 goldPass 是否一致（跨 case κ 才是統計校準，見 note）。
 *  平手共識（passTie）= 沒有真共識 → agree:null（不把擲銅板說成與金標一致）。 */
function computeGoldAgreement(gold, caseId, consensus) {
  if (!Array.isArray(gold) || !consensus) return null;
  const g = gold.find((x) => x?.id === caseId);
  if (!g || typeof g.goldPass !== 'boolean') return null;
  if (consensus.passTie) return { gold: g.goldPass, consensus: consensus.pass, consensusTie: true, agree: null };
  return { gold: g.goldPass, consensus: consensus.pass, consensusTie: false, agree: g.goldPass === consensus.pass };
}

// ── 薄 IO：CLI（被 import 時不執行）──────────────────────────────────────────────

const USAGE = [
  'usage:',
  '  node eval-panel.mjs run --rubric <rubric.md> --verdicts <verdicts.jsonl> --case-id <id> [--gold <gold.json>] [--judge-file <out.jsonl>]',
  '  （verdicts.jsonl 每行 {judgeId, model, output}；output＝raw judge verdict 文字）',
].join('\n');

function parseArgs(argv) {
  const opts = { rubric: null, verdicts: null, caseId: null, gold: null, judgeFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const f = argv[i];
    if (f === '--rubric') opts.rubric = argv[++i] ?? null;
    else if (f === '--verdicts') opts.verdicts = argv[++i] ?? null;
    else if (f === '--case-id') opts.caseId = argv[++i] ?? null;
    else if (f === '--gold') opts.gold = argv[++i] ?? null;
    else if (f === '--judge-file') opts.judgeFile = argv[++i] ?? null;
  }
  return opts;
}

function loadJsonl(file) {
  const text = readFileSync(file, 'utf8');
  const rows = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { skipped += 1; }
  }
  return { rows, skipped };
}

function cmdRun(argv) {
  const opts = parseArgs(argv);
  if (!opts.rubric || !opts.verdicts || !opts.caseId) { console.error(USAGE); process.exit(2); }
  let rubricText;
  try { rubricText = readFileSync(resolve(opts.rubric), 'utf8'); }
  catch (e) { console.error(`run: rubric 讀取失敗 ${opts.rubric}: ${e?.message ?? e}`); process.exit(3); }
  let loaded;
  try { loaded = loadJsonl(resolve(opts.verdicts)); }
  catch (e) { console.error(`run: verdicts 讀取失敗 ${opts.verdicts}: ${e?.message ?? e}`); process.exit(3); }
  let gold = null;
  if (opts.gold) {
    try { gold = JSON.parse(readFileSync(resolve(opts.gold), 'utf8')); }
    catch (e) { console.error(`run: gold 讀取失敗 ${opts.gold}: ${e?.message ?? e}`); process.exit(3); }
  }
  const rubricMeta = parseRubricMeta(rubricText);
  // 揭露 rubric 是否合法——殘缺 rubric（如缺 threshold）會讓每筆 verdict 越界 → 整 case 靜默全 fail；
  // 不靜默，印 stderr 警示 + report 帶 rubricValid/reasons（advisory，仍 exit 0）。
  const rubricCheck = validateRubric(rubricMeta);
  if (!rubricCheck.valid) {
    console.error(`run: 警告 — rubric 不合法（共識可能失真）：${rubricCheck.reasons.join('；')}`);
  }
  const result = runPanel(loaded.rows, { rubricMeta, caseId: opts.caseId, gold, ts: new Date().toISOString() });
  // 落檔（opt-in）：每筆 record append judge-results.jsonl；失敗不擋路（stderr + 仍印 report）。
  if (opts.judgeFile) {
    const jf = resolve(opts.judgeFile);
    let wrote = 0;
    try { for (const rec of result.records) { appendJudgeRecord(jf, rec); wrote += 1; } }
    catch (e) { console.error(`run: 落檔失敗 ${jf}（已寫 ${wrote}/${result.records.length} 筆，可能含部分 panel）: ${e?.message ?? e}（report 仍輸出）`); }
  }
  console.log(JSON.stringify({
    ...result,
    rubricValid: rubricCheck.valid,
    ...(rubricCheck.valid ? {} : { rubricReasons: rubricCheck.reasons }),
    skipped: loaded.skipped,
  }, null, 2));
  process.exit(0);
}

function main(argv) {
  const cmd = argv[0];
  if (cmd === 'run') return cmdRun(argv.slice(1));
  console.error(`unknown command: ${cmd ?? '(none)'}\n${USAGE}`);
  process.exit(2);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try { main(process.argv.slice(2)); }
  catch (err) { console.error(err?.message ?? String(err)); process.exit(3); }
}
