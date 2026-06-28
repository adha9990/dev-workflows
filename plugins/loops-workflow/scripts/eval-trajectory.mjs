#!/usr/bin/env node
// eval-trajectory.mjs —— lifecycle 階段序列的 trajectory 檢查（純規則比對、零 LLM judge）。
// 把「必經階段 / 允許階段 / 相對順序 / 禁止階段」存成 reference，對 observed 階段序列做四種比對：
//   superset：required ⊆ observed？—— 漏關鍵階段（跳了該走的關卡）→ 失敗。
//   subset：observed ⊆ allowed？—— 多餘步 / step efficiency（走了 reference 沒列的步）→ 警示（不失敗）。
//   unordered：集合等價（順序無關）。
//   order：reference.order 規定的相對先後是否被破壞（如 verify 在 build 之前）→ 失敗。
//   forbidden：不該出現的階段是否出現 → 失敗。
// 抓「最終看似對、但流程走錯 / 漏階段」的退化（純規則、無 judge；judge 維度走 E4）。
//
// 分層（仿 scripts/eval-oracle.mjs / eval-metrics.mjs）：
//   1) 純函式（無 IO，測試直接 import）：parseStages / supersetMissing / subsetExtra /
//      unorderedEqual / orderViolations / checkTrajectory。
//   2) 薄 IO：readReference / readObservedStages / CLI main——被 import 時不執行（import.meta.url 守門）。
// 依賴：僅 node 內建（fs / url），零外部套件。

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// loop.md Journal 的 `[...]` 標記裡，這些不是 lifecycle 階段（排除避免誤判成多餘步）。
const NON_STAGE_MARKERS = new Set(['outcome']);

// ── 純函式層（無 IO，測試直接 import）─────────────────────────────────────────────

/**
 * 從 loop.md Journal 文字抽階段序列：取每行第一個 `[...]` 標記，箭頭（→ 或 ->）展開成多階段，
 * 正規化小寫去空白，濾掉 NON_STAGE_MARKERS。非標記行跳過。回階段名陣列（保序、可重複）。
 */
export function parseStages(journalText) {
  const stages = [];
  for (const line of String(journalText ?? '').split('\n')) {
    const bracket = line.match(/\[([^\]\n]+)\]/);
    if (!bracket) continue;
    for (const part of bracket[1].split(/→|->/)) {
      const s = part.trim().toLowerCase();
      if (s && /^[a-z][a-z0-9-]*$/.test(s) && !NON_STAGE_MARKERS.has(s)) stages.push(s);
    }
  }
  return stages;
}

/** required 中 observed 沒有的階段（漏階段／superset 失敗）。保序、不重複。 */
export function supersetMissing(observed, required) {
  const seen = new Set(observed ?? []);
  const out = [];
  const dedup = new Set();
  for (const s of required ?? []) {
    if (!seen.has(s) && !dedup.has(s)) { dedup.add(s); out.push(s); }
  }
  return out;
}

/** observed 中不在 allowed 的階段（多餘步／subset 警示）。allowed 未定義/空 → 不判（回 []）。保序、不重複。 */
export function subsetExtra(observed, allowed) {
  if (!allowed || allowed.length === 0) return [];
  const ok = new Set(allowed);
  const out = [];
  const dedup = new Set();
  for (const s of observed ?? []) {
    if (!ok.has(s) && !dedup.has(s)) { dedup.add(s); out.push(s); }
  }
  return out;
}

/** 集合等價（順序、重複無關）：a 與 b 的去重集合相同 → true。 */
export function unorderedEqual(a, b) {
  const sa = new Set(a ?? []);
  const sb = new Set(b ?? []);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/**
 * order 違反：reference.order 規定的相對先後（子序列）。只看 observed 與 order 都含的階段，
 * 以「首次出現位置」判先後；order[i] 應早於 order[j] 卻晚出現 → 回報一個 [before, after] pair。
 */
export function orderViolations(observed, order) {
  const obs = Array.isArray(observed) ? observed : [];
  const seq = (order ?? []).filter((s) => obs.includes(s));
  const violations = [];
  for (let i = 0; i < seq.length; i++) {
    for (let j = i + 1; j < seq.length; j++) {
      if (obs.indexOf(seq[i]) > obs.indexOf(seq[j])) violations.push([seq[i], seq[j]]);
    }
  }
  return violations;
}

/**
 * 綜合 trajectory 檢查。reference：{ required[], optional[], allowed[], order[], forbidden[] }。
 * allowed 未給時退回 required ∪ optional（兩者皆未給 → 不判多餘步）。
 * ok＝無漏階段（missing）＆無禁止階段（forbidden）＆無順序違反（orderViolations）；
 *   extra（多餘步）是效率警示、**不**影響 ok（subset 抓低效非錯誤）。
 */
export function checkTrajectory(observed, reference) {
  const obs = Array.isArray(observed) ? observed : [];
  const ref = reference ?? {};
  const missing = supersetMissing(obs, ref.required);
  const allowed = ref.allowed
    ?? ((ref.required || ref.optional) ? [...(ref.required ?? []), ...(ref.optional ?? [])] : null);
  const extra = subsetExtra(obs, allowed);
  const forbiddenSet = new Set(ref.forbidden ?? []);
  const forbidden = [...new Set(obs.filter((s) => forbiddenSet.has(s)))];
  const order = orderViolations(obs, ref.order);
  const ok = missing.length === 0 && forbidden.length === 0 && order.length === 0;
  return { ok, missing, extra, forbidden, orderViolations: order };
}

// ── 薄 IO（被 import 時不執行）────────────────────────────────────────────────────

/** 讀 reference JSON；讀不到 / 壞 JSON → 丟（reference 是必要輸入，不該靜默吞）。 */
export function readReference(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** 讀 observed：loop.md（或任意含 Journal 標記的文字）→ parseStages。 */
export function readObservedStages(file) {
  return parseStages(readFileSync(file, 'utf8'));
}

function parseArgs(argv) {
  const opts = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--observed') opts.observed = argv[++i];
    else if (a === '--reference') opts.reference = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === 'check') opts.command = 'check';
  }
  return opts;
}

const USAGE = 'usage: node eval-trajectory.mjs check --observed <loop.md> --reference <ref.json> [--json]';

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.command !== 'check' || !opts.observed || !opts.reference) {
    console.error(USAGE);
    return 2; // 誤用
  }
  const reference = readReference(opts.reference);
  const observed = readObservedStages(opts.observed);
  const result = checkTrajectory(observed, reference);
  if (opts.json) {
    console.log(JSON.stringify({ ...result, observed, reference: reference.name ?? null }, null, 2));
  } else if (result.ok) {
    console.log(`✓ trajectory ok (${reference.name ?? 'reference'})${result.extra.length ? ` — 多餘步: ${result.extra.join(', ')}` : ''}`);
  } else {
    const parts = [];
    if (result.missing.length) parts.push(`漏階段: ${result.missing.join(', ')}`);
    if (result.forbidden.length) parts.push(`禁止階段: ${result.forbidden.join(', ')}`);
    if (result.orderViolations.length) parts.push(`順序違反: ${result.orderViolations.map((p) => p.join('→應早於→')).join('; ')}`);
    console.error(`✗ trajectory not ok (${reference.name ?? 'reference'}) — ${parts.join(' | ')}`);
  }
  return result.ok ? 0 : 1; // 失敗 exit 1（漏/禁止/順序）；多餘步不擋（仍 0）
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(err?.message ?? String(err));
    process.exit(1);
  }
}
