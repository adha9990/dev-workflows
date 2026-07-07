#!/usr/bin/env node
// eval-tags.mjs —— eval E6：eval↔verify 銜接 + scenario 版本/tag。
//
// **tags 為連結脊椎**：同一組 tag 同時驅動「跨 run 聚合分組」（groupByTag / summarizeByTag）與
//   「eval↔verify 互指」（crossLink：eval 失敗 ↔ 共享 tag/axis 的 verify finding）。不造兩套機制。
//
// 互指是**純函式 + 慣例**：crossLink 可 fixture 測；「verify 把 findings 寫哪供 eval 讀」＝上層慣例
//   （見 eval-harness E6），本 script 不硬接 verify 流程。與 eval-metrics 回歸 gate 分離（另一個 cut）。
//
// 分層（仿 eval 家族）：純函式 export + 薄 IO CLI（import.meta.url 守門）。依賴：僅 node 內建。
// 用法：
//   node eval-tags.mjs by-tag --results <oracle-report.json>
//   node eval-tags.mjs link   --eval <oracle-report.json> --findings <findings.json>

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// 防惡意巨檔 DoS（#87 defaultOn 後自動吃 repo 可控輸入，security review）：readJson 讀檔前的
// 位元組上限，與 eval-metrics.mjs 的 MAX_INPUT_FILE_BYTES / MAX_ORACLE_STDOUT 同款量級。
const MAX_INPUT_FILE_BYTES = 16 * 1024 * 1024;

// ── 純函式：tag 分組 / 聚合 ───────────────────────────────────────────────────────

/** 依 item[field]（預設 tags 陣列）分組：一 item 多 tag 各入一組；無 tags 的 item 不入任何組。
 *  用 Object.create(null) → tag 名為 `__proto__` 等也安全當一般鍵。 */
export function groupByTag(items, { field = 'tags' } = {}) {
  const groups = Object.create(null);
  for (const item of Array.isArray(items) ? items : []) {
    const tags = Array.isArray(item?.[field]) ? item[field] : [];
    // 同一 item 內去重 tag（new Set）——否則 tags:['x','x'] 會讓該 item 在 x 組計兩次、灌大 summarizeByTag；
    // 與 crossLink 的 Set 語意一致。
    for (const tag of new Set(tags)) {
      if (typeof tag !== 'string') continue;
      (groups[tag] ??= []).push(item);
    }
  }
  return groups;
}

/** per-tag pass/fail 聚合（用 result.pass===true）→ [{tag, total, passed, failed}]，依 tag 字典序。 */
export function summarizeByTag(results) {
  const groups = groupByTag(results);
  return Object.keys(groups).sort().map((tag) => {
    const items = groups[tag];
    const passed = items.filter((r) => r?.pass === true).length;
    return { tag, total: items.length, passed, failed: items.length - passed };
  });
}

// ── 純函式：eval↔verify 雙向互指 ─────────────────────────────────────────────────

/**
 * 依「共享 tag/axis」雙向連結 eval 結果與 verify findings：
 *   eval key 集＝(result.tags ∪ result.verifyAxes)；finding key 集＝([finding.axis] ∪ finding.tags)；交集非空 → 連結。
 *   onlyFailures（預設 true）只取 pass!==true 的 eval（呼應「eval 失敗情境 ↔ finding」）。
 * → { evalToVerify:[{evalId, keys, findings:[id]}], verifyToEval:[{findingId, axis, evals:[id]}] }。
 */
export function crossLink(evalResults, verifyFindings, { onlyFailures = true } = {}) {
  const evals = (Array.isArray(evalResults) ? evalResults : []).filter((e) => (onlyFailures ? e?.pass !== true : true));
  const findings = Array.isArray(verifyFindings) ? verifyFindings : [];
  const evalKeys = (e) => new Set([...toArr(e?.tags), ...toArr(e?.verifyAxes)]);
  const findingKeys = (f) => new Set([...(typeof f?.axis === 'string' ? [f.axis] : []), ...toArr(f?.tags)]);
  const intersects = (sa, sb) => [...sa].some((x) => sb.has(x));

  return {
    evalToVerify: evals.map((e) => {
      const ek = evalKeys(e);
      return {
        evalId: e?.id ?? null,
        keys: [...ek],
        findings: findings.filter((f) => intersects(ek, findingKeys(f))).map((f) => f?.id ?? null),
      };
    }),
    verifyToEval: findings.map((f) => {
      const fk = findingKeys(f);
      return {
        findingId: f?.id ?? null,
        axis: f?.axis ?? null,
        evals: evals.filter((e) => intersects(evalKeys(e), fk)).map((e) => e?.id ?? null),
      };
    }),
  };
}

function toArr(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

// ── 薄 IO：CLI（被 import 時不執行）──────────────────────────────────────────────

const USAGE = [
  'usage:',
  '  node eval-tags.mjs by-tag --results <oracle-report.json>',
  '  node eval-tags.mjs link   --eval <oracle-report.json> --findings <findings.json>',
].join('\n');

function parseArgs(argv) {
  const opts = { results: null, eval: null, findings: null };
  for (let i = 0; i < argv.length; i += 1) {
    const f = argv[i];
    if (f === '--results') opts.results = argv[++i] ?? null;
    else if (f === '--eval') opts.eval = argv[++i] ?? null;
    else if (f === '--findings') opts.findings = argv[++i] ?? null;
  }
  return opts;
}

/**
 * 讀檔並 JSON.parse。maxBytes（可選，預設 MAX_INPUT_FILE_BYTES）：讀前先 statSync 檔大小，
 * 超限 → 回安全空值 null（不讀入超限內容，不拋錯）——防惡意巨檔 DoS；讀檔 / parse 失敗仍拋錯，
 * 交由呼叫端（cmdByTag / cmdLink）的既有 try/catch 判 exit 3（行為不變）。
 * export 供測試 import（單一真相源，CLI 內部與測試共用同一份實作）。
 */
export function readJson(path, maxBytes = MAX_INPUT_FILE_BYTES) {
  const resolved = resolve(path);
  if (statSync(resolved).size > maxBytes) return null; // 超限 → 安全空值，不讀入內容
  return JSON.parse(readFileSync(resolved, 'utf8'));
}

/** 容受 oracle aggregate（{tasks:[...]}）或裸陣列。 */
function tasksOf(report) {
  if (Array.isArray(report?.tasks)) return report.tasks;
  return Array.isArray(report) ? report : [];
}

function cmdByTag(argv) {
  const opts = parseArgs(argv);
  if (!opts.results) { console.error(USAGE); process.exit(2); }
  let report;
  try { report = readJson(opts.results); }
  catch (e) { console.error(`by-tag: 讀取失敗 ${opts.results}: ${e?.message ?? e}`); process.exit(3); }
  console.log(JSON.stringify({ byTag: summarizeByTag(tasksOf(report)), note: 'per-tag 聚合（依 task.tags 分組）' }, null, 2));
  process.exit(0);
}

function cmdLink(argv) {
  const opts = parseArgs(argv);
  if (!opts.eval || !opts.findings) { console.error(USAGE); process.exit(2); }
  let report;
  let findings;
  try { report = readJson(opts.eval); }
  catch (e) { console.error(`link: eval 讀取失敗 ${opts.eval}: ${e?.message ?? e}`); process.exit(3); }
  try { findings = readJson(opts.findings); }
  catch (e) { console.error(`link: findings 讀取失敗 ${opts.findings}: ${e?.message ?? e}`); process.exit(3); }
  // findings 必須是陣列：傳錯檔（如把 oracle report 物件當 findings）→ 明確報錯，不靜默回空連結（misuse vs 真無連結要可區分）。
  if (!Array.isArray(findings)) {
    console.error(`link: --findings 須為 JSON 陣列（收到 ${typeof findings}）— 別把 oracle report 當 findings`);
    process.exit(2);
  }
  console.log(JSON.stringify({
    ...crossLink(tasksOf(report), findings, {}),
    note: 'eval↔verify 依共享 tag/axis 雙向索引（onlyFailures）',
  }, null, 2));
  process.exit(0);
}

function main(argv) {
  const cmd = argv[0];
  if (cmd === 'by-tag') return cmdByTag(argv.slice(1));
  if (cmd === 'link') return cmdLink(argv.slice(1));
  console.error(`unknown command: ${cmd ?? '(none)'}\n${USAGE}`);
  process.exit(2);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try { main(process.argv.slice(2)); }
  catch (err) { console.error(err?.message ?? String(err)); process.exit(3); }
}
