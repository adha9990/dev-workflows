#!/usr/bin/env node
// eval-poll.mjs —— eval E5：judge 校準（Cohen κ）+ 多 judge 投票（PoLL）。
//
// 混合架構（承 #32）：κ 計算 / 投票聚合是**純函式**（可 fixture 測）；judge panel fan-out
//   （派 N 個不同模型 judge）留**主迴圈 / Workflow**（opt-in、本 script **不 spawn**）。
//   在 #32 產的 judge-results.jsonl record 陣列上聚合（record 帶 judgeId/model/dimension/caseId/pass/score/track）。
//
// Metric-Honesty：κ / 投票結果是 **judge-estimate 估算**、標來源（人工金標），**不污染** oracle 回歸曲線
//   （只計 track==='judge-estimate' 的 record）。
//
// 分層（仿 eval-judge）：純函式 export（cohenKappa/pollVote/aggregatePanel/pairJudgeVsGold）+ 薄 IO CLI
//   （import.meta.url 守門）。依賴：僅 node 內建。
// 用法：
//   node eval-poll.mjs kappa --records <judge-results.jsonl> --gold <gold.json>
//   node eval-poll.mjs poll  --records <judge-results.jsonl> [--score-method median|max|min]

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const JUDGE_TRACK = 'judge-estimate'; // 只在 judge-estimate 軌上算，永不混入 measured

// ── 純函式：Cohen κ（兩 rater 類別一致性）──────────────────────────────────────────

/**
 * Cohen κ = (po − pe) / (1 − pe)。po＝觀察一致比例；pe＝隨機期望一致＝Σ_c p_A(c)·p_B(c)。
 * → { kappa:number|null, po, pe, n, reason? }。不等長/空 → null；**無變異 1−pe=0 → null + reason**（不假裝 1）。
 */
export function cohenKappa(labelsA, labelsB) {
  const a = Array.isArray(labelsA) ? labelsA : [];
  const b = Array.isArray(labelsB) ? labelsB : [];
  const n = a.length;
  if (n === 0 || b.length !== n) {
    return { kappa: null, po: 0, pe: 0, n, reason: n === 0 ? 'no items (n=0)' : 'label arrays length mismatch' };
  }
  let agree = 0;
  const countA = new Map();
  const countB = new Map();
  for (let i = 0; i < n; i += 1) {
    if (a[i] === b[i]) agree += 1;
    countA.set(a[i], (countA.get(a[i]) ?? 0) + 1);
    countB.set(b[i], (countB.get(b[i]) ?? 0) + 1);
  }
  const po = agree / n;
  let pe = 0;
  for (const c of new Set([...countA.keys(), ...countB.keys()])) {
    pe += ((countA.get(c) ?? 0) / n) * ((countB.get(c) ?? 0) / n);
  }
  if (1 - pe === 0) {
    return { kappa: null, po, pe, n, reason: 'no variance (1-pe=0) — κ undefined' };
  }
  return { kappa: (po - pe) / (1 - pe), po, pe, n };
}

/** κ 強度判讀（Landis-Koch 式粗分；估算非權威）。 */
export function interpretKappa(k) {
  if (k === null || typeof k !== 'number' || Number.isNaN(k)) return 'undefined';
  if (k >= 0.8) return 'strong';
  if (k >= 0.6) return 'moderate';
  if (k >= 0.4) return 'fair';
  return 'weak';
}

// ── 純函式：PoLL 投票聚合 ─────────────────────────────────────────────────────────

/**
 * 把多值聚合成單一共識。method：
 *   majority（預設）—眾數，**平手 → null**（誠實標歧義，不亂猜）；
 *   median —數值中位（偶數取兩中位平均）；max / min —數值極值。空 → null。
 */
export function pollVote(values, { method = 'majority' } = {}) {
  const v = Array.isArray(values) ? values : [];
  if (v.length === 0) return null;
  if (method === 'median' || method === 'max' || method === 'min') {
    const nums = v.filter((x) => typeof x === 'number' && Number.isFinite(x));
    if (nums.length === 0) return null;
    if (method === 'max') return Math.max(...nums);
    if (method === 'min') return Math.min(...nums);
    const sorted = [...nums].sort((x, y) => x - y);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  // majority：眾數；逐一比較，最終最大者唯一才回，否則平手 → null。
  const counts = new Map();
  for (const x of v) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best = null;
  let bestCount = 0;
  let tie = false;
  for (const [val, c] of counts) {
    if (c > bestCount) { best = val; bestCount = c; tie = false; }
    else if (c === bestCount) { tie = true; }
  }
  return tie ? null : best;
}

// ── 純函式：panel 投票聚合 + judge↔gold 配對 ─────────────────────────────────────

/**
 * 依 record[key]（預設 caseId）把同一 item 的 N 個 judge record 分組 → 每組投票出共識。
 * 只計 track==='judge-estimate'（防混入 measured）。→ [{caseId, panelSize, pass, passTie, score, judges}]。
 */
export function aggregatePanel(records, { key = 'caseId', scoreMethod = 'median' } = {}) {
  const list = (Array.isArray(records) ? records : []).filter((r) => r?.track === JUDGE_TRACK);
  const groups = new Map();
  for (const r of list) {
    const k = r?.[key] ?? null;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const [caseId, recs] of groups) {
    const passMajority = pollVote(recs.map((r) => r.pass === true), { method: 'majority' });
    const scores = recs.map((r) => r.score).filter((s) => typeof s === 'number' && Number.isFinite(s));
    out.push({
      caseId,
      panelSize: recs.length,
      pass: passMajority === true,
      passTie: passMajority === null,
      score: scores.length ? pollVote(scores, { method: scoreMethod }) : null,
      judges: recs.map((r) => r.judgeId ?? null),
    });
  }
  return out;
}

/**
 * 把 judge record 依 caseId 配到 gold[].id → 出 pass 布林 label pairs 餵 cohenKappa。
 * 只計 judge-estimate 軌；gold 須有 boolean goldPass。無配對的 record → unmatched（記其 caseId）。
 */
export function pairJudgeVsGold(records, gold) {
  const list = (Array.isArray(records) ? records : []).filter((r) => r?.track === JUDGE_TRACK);
  const goldMap = new Map((Array.isArray(gold) ? gold : []).map((g) => [g?.id, g]));
  const judgeLabels = [];
  const goldLabels = [];
  const unmatched = [];
  for (const r of list) {
    const g = goldMap.get(r?.caseId);
    if (g && typeof g.goldPass === 'boolean') {
      judgeLabels.push(r.pass === true);
      goldLabels.push(g.goldPass);
    } else {
      unmatched.push(r?.caseId ?? null);
    }
  }
  return { judgeLabels, goldLabels, paired: judgeLabels.length, unmatched };
}

// ── 薄 IO：CLI（被 import 時不執行）──────────────────────────────────────────────

const USAGE = [
  'usage:',
  '  node eval-poll.mjs kappa --records <judge-results.jsonl> --gold <gold.json>',
  '  node eval-poll.mjs poll  --records <judge-results.jsonl> [--score-method median|max|min]',
].join('\n');

function parseArgs(argv) {
  const opts = { records: null, gold: null, scoreMethod: 'median' };
  for (let i = 0; i < argv.length; i += 1) {
    const f = argv[i];
    if (f === '--records') opts.records = argv[++i] ?? null;
    else if (f === '--gold') opts.gold = argv[++i] ?? null;
    else if (f === '--score-method') opts.scoreMethod = argv[++i] ?? opts.scoreMethod;
  }
  return opts;
}

const VALID_SCORE_METHODS = new Set(['median', 'max', 'min']);

/** tolerant 讀 jsonl：檔不存在 → throw（CLI 接住 exit 3）；單行壞 → 跳過並計數（揭露於輸出，非靜默吞）。 */
function loadRecords(file) {
  const text = readFileSync(file, 'utf8');
  const records = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { skipped += 1; }
  }
  return { records, skipped };
}

function cmdKappa(argv) {
  const opts = parseArgs(argv);
  if (!opts.records || !opts.gold) { console.error(USAGE); process.exit(2); }
  let loaded;
  let gold;
  try { loaded = loadRecords(resolve(opts.records)); }
  catch (e) { console.error(`kappa: records 讀取失敗 ${opts.records}: ${e?.message ?? e}`); process.exit(3); }
  try { gold = JSON.parse(readFileSync(resolve(opts.gold), 'utf8')); }
  catch (e) { console.error(`kappa: gold 讀取失敗 ${opts.gold}: ${e?.message ?? e}`); process.exit(3); }
  const paired = pairJudgeVsGold(loaded.records, gold);
  const k = cohenKappa(paired.judgeLabels, paired.goldLabels);
  console.log(JSON.stringify({
    kappa: k.kappa, interpretation: interpretKappa(k.kappa),
    po: k.po, pe: k.pe, paired: paired.paired, unmatched: paired.unmatched, reason: k.reason ?? null,
    loaded: loaded.records.length, skipped: loaded.skipped,
    note: 'judge-estimate vs 人工金標 — κ 為估算、非確定性權威',
  }, null, 2));
  process.exit(0);
}

function cmdPoll(argv) {
  const opts = parseArgs(argv);
  if (!opts.records) { console.error(USAGE); process.exit(2); }
  // 未知 --score-method 不可靜默落 majority（會把 score 語意悄悄換掉）→ 明確拒絕。
  if (!VALID_SCORE_METHODS.has(opts.scoreMethod)) {
    console.error(`poll: 未知 --score-method "${opts.scoreMethod}"（用 median|max|min）`);
    process.exit(2);
  }
  let loaded;
  try { loaded = loadRecords(resolve(opts.records)); }
  catch (e) { console.error(`poll: records 讀取失敗 ${opts.records}: ${e?.message ?? e}`); process.exit(3); }
  // 缺 caseId 的 judge record 會被併進單一 null 群一起投票（跨無關 item）→ 警示，避免假共識被誤讀。
  const nullCase = loaded.records.filter((r) => r?.track === JUDGE_TRACK && (r?.caseId === null || r?.caseId === undefined)).length;
  if (nullCase > 0) {
    console.error(`poll: 警告 — ${nullCase} 筆 judge record 無 caseId，已併為單一 null 群組，PoLL 結果可能無意義（請給 --case-id）`);
  }
  console.log(JSON.stringify({
    cases: aggregatePanel(loaded.records, { scoreMethod: opts.scoreMethod }),
    loaded: loaded.records.length, skipped: loaded.skipped,
    note: 'PoLL 多 judge 投票聚合 — judge-estimate 軌（advisory）',
  }, null, 2));
  process.exit(0);
}

function main(argv) {
  const cmd = argv[0];
  if (cmd === 'kappa') return cmdKappa(argv.slice(1));
  if (cmd === 'poll') return cmdPoll(argv.slice(1));
  console.error(`unknown command: ${cmd ?? '(none)'}\n${USAGE}`);
  process.exit(2);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try { main(process.argv.slice(2)); }
  catch (err) { console.error(err?.message ?? String(err)); process.exit(3); }
}
