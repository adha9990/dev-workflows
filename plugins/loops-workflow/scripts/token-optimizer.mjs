#!/usr/bin/env node
// token-optimizer.mjs —— 互斥 token optimizer 的忠實度契約、receipt 與資格審查（#178）。
//
// 背景：把送進模型的工具輸出壓小很有價值，但壓縮是**有損**的——壓掉的如果是「規則擋下了什麼」
// 「哪個測試紅了」「security finding 在哪一行」，整條 loop 的判斷就建立在被刪改過的證據上，而且
// **沒有人會發現**（輸出看起來還是很像原本那份）。
//
// 因此本檔的核心不是壓縮，而是**壓縮之後的驗收**：
//   1. `checkFidelity()` —— 原始輸出裡的**受保護證據**（policy denial／測試失敗／security finding／
//      exit code／`file:line`／驗收證據）必須在處理後的輸出裡仍然找得到。少一項就判失敗。
//   2. `applyOptimizer()` —— 忠實度沒過、optimizer 出錯、或它根本沒回東西 → **一律 bypass 回原始輸出**。
//      失敗要被隔離：壞掉的 optimizer 只該讓人少省一點 token，不該讓人拿到殘缺的證據。
//   3. `buildReceipt()` —— 每次處理留下 source／version／原始與處理後大小／保留與截斷策略／錯誤／
//      是否 bypass。沒有 receipt 就沒有辦法回答「當時那份輸出是不是被動過」。
//   4. `qualificationReport()` —— 資格審查清單全綠才准進 wizard；任一項未過就維持在 catalog 之外
//      （沒有「自己冒險」的旗標）。
//   5. `compareCandidate()` —— **task success 與規則遵循度先於 token**：品質退步的候選一律不接受，
//      即使它省更多 token。token／call／duration **只報實測**；沒量到標 `not measured`、
//      量到但沒進步標 `not improved`——不拿宣傳數字當實測。
//
// 純函式；無 IO（optimizer 本身由 port 注入）。依賴：僅 node 內建。

import { pathToFileURL } from 'node:url';

/**
 * **受保護證據**：這些東西在壓縮後必須仍然找得到。每一條都對應一種「被壓掉就會讓判斷出錯」的資訊。
 * 判定用的是**可機械比對的圖樣**，不是語意——語意判定會讓這道閘變成另一個要被信任的黑盒。
 */
export const PROTECTED_EVIDENCE = Object.freeze([
  { id: 'policy-denial', re: /permissionDecision"?\s*[:=]\s*"?deny|拒絕執行|\bdeny\b/gi, why: '規則擋下了什麼——被壓掉就會以為自己被放行' },
  { id: 'test-failure', re: /\b(?:FAIL|failed|✗)\b|\d+\s*failed/g, why: '哪個測試紅了——被壓掉就會以為全綠' },
  { id: 'exit-code', re: /\bexit(?:\s+code)?\s*[:=]?\s*\d+\b/gi, why: '指令的結果碼——被壓掉就分不出成功與失敗' },
  { id: 'file-line', re: /[\w./\\-]+\.[A-Za-z]{1,5}:\d+/g, why: '哪個檔哪一行——被壓掉就無法回頭查證' },
  { id: 'security-finding', re: /\b(?:P0|P1|CVE-\d{4}-\d+|security finding)\b/g, why: 'blocking 等級與安全發現——被壓掉就會誤判可以收圈' },
]);

/** receipt 的必填欄位。 */
export const RECEIPT_FIELDS = Object.freeze(['source', 'version', 'rawBytes', 'processedBytes', 'strategy', 'errors', 'bypassed', 'fidelity']);

/** 資格審查清單——issue #178 逐項列的那組。全綠才准進 wizard。 */
export const QUALIFICATION_CHECKS = Object.freeze([
  'windows-platform',
  'harness-hook-ordering',
  'output-fidelity',
  'failure-isolation',
  'rollback',
  'real-benchmark',
]);

/** 品質維度**先於** token：這兩項退步就不接受候選，不論省多少 token。 */
export const QUALITY_DIMENSIONS = Object.freeze(['taskSuccess', 'ruleAdherence']);

// ── 忠實度（純函式）────────────────────────────────────────────────────────

const countMatches = (text, re) => (String(text ?? '').match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? []).length;

/**
 * 處理後的輸出有沒有把受保護證據壓掉。回 `{ok, losses}`；`losses` 逐條列出**少了幾個**與**為什麼重要**。
 *
 * 判準刻意是「數量不得減少」而不是「字串完全相同」——壓縮本來就會改寫排版與空白，
 * 但**證據的條數不該變少**。多出來不算問題（optimizer 可能加了摘要行）。
 */
export function checkFidelity(raw, processed) {
  const losses = [];
  for (const { id, re, why } of PROTECTED_EVIDENCE) {
    const before = countMatches(raw, re);
    const after = countMatches(processed, re);
    if (after < before) losses.push({ id, before, after, why });
  }
  return { ok: losses.length === 0, losses };
}

/** 忠實度失敗的人話理由。 */
export function describeFidelity(result) {
  if (result.ok) return null;
  return `處理後的輸出少了受保護證據：\n${result.losses.map((l) => `- ${l.id}：${l.before} → ${l.after}（${l.why}）`).join('\n')}`;
}

// ── 套用（port 注入）───────────────────────────────────────────────────────

/**
 * 對一份原始輸出套用 optimizer，並在**任何**下列情況 bypass 回原始輸出：
 *   · optimizer 丟例外、回非字串、回空字串；
 *   · 忠實度檢查沒過（壓掉了受保護證據）。
 *
 * **失敗隔離**：壞掉的 optimizer 只該讓人少省一點 token，不該讓人拿到殘缺的證據。
 * 回 `{ output, receipt }`——`output` 永遠是可安全使用的那一份。
 */
export function applyOptimizer(raw, { source = 'unknown', version = 'unknown', strategy = 'unspecified', run = null } = {}) {
  const rawText = String(raw ?? '');
  const errors = [];
  let processed = null;
  try {
    processed = typeof run === 'function' ? run(rawText) : null;
    if (typeof processed !== 'string') { errors.push(`optimizer 沒有回傳字串（實際：${typeof processed}）`); processed = null; }
    else if (processed.trim() === '') { errors.push('optimizer 回傳空字串'); processed = null; }
  } catch (err) {
    errors.push(`optimizer 執行失敗：${err.message}`);
    processed = null;
  }

  let fidelity = { ok: true, losses: [] };
  if (processed !== null) {
    fidelity = checkFidelity(rawText, processed);
    if (!fidelity.ok) errors.push(describeFidelity(fidelity));
  }

  const bypassed = processed === null || !fidelity.ok;
  const output = bypassed ? rawText : processed;
  return {
    output,
    receipt: buildReceipt({
      source, version, strategy, errors, bypassed, fidelity,
      rawBytes: Buffer.byteLength(rawText, 'utf8'),
      processedBytes: Buffer.byteLength(output, 'utf8'),
    }),
  };
}

/** 組一張 receipt（欄位齊全由 validateReceipt 機械檢查）。 */
export function buildReceipt(fields) {
  return {
    source: fields.source ?? 'unknown',
    version: fields.version ?? 'unknown',
    rawBytes: fields.rawBytes ?? 0,
    processedBytes: fields.processedBytes ?? 0,
    strategy: fields.strategy ?? 'unspecified',
    errors: [...(fields.errors ?? [])].filter(Boolean),
    bypassed: fields.bypassed === true,
    fidelity: fields.fidelity ?? { ok: true, losses: [] },
    savedBytes: Math.max(0, (fields.rawBytes ?? 0) - (fields.processedBytes ?? 0)),
  };
}

/** receipt 欄位齊全嗎。 */
export function validateReceipt(receipt) {
  const errors = RECEIPT_FIELDS.filter((f) => receipt?.[f] === undefined || receipt?.[f] === null).map((f) => `缺欄位 ${f}`);
  if (receipt && receipt.bypassed === false && receipt.fidelity && receipt.fidelity.ok !== true) {
    errors.push('沒有 bypass 卻宣稱忠實度未過——那代表殘缺的輸出被送出去了');
  }
  return { ok: errors.length === 0, errors };
}

/** receipt → 人讀的一段（給 loop 的成本文件與 PR 回報用）。 */
export function renderReceipt(receipt) {
  const pct = receipt.rawBytes > 0 ? Math.round((receipt.savedBytes / receipt.rawBytes) * 1000) / 10 : 0;
  const lines = [
    `- 來源 \`${receipt.source}\`（版本 ${receipt.version}）｜策略 ${receipt.strategy}`,
    `- 大小 ${receipt.rawBytes} → ${receipt.processedBytes} bytes（${receipt.bypassed ? '已 bypass，未壓縮' : `省下 ${receipt.savedBytes} bytes，${pct}%`}）`,
  ];
  if (receipt.errors.length) lines.push(`- 錯誤：${receipt.errors.join('；')}`);
  if (!receipt.fidelity.ok) lines.push(`- 忠實度未過：${receipt.fidelity.losses.map((l) => l.id).join('、')} —— 已回原始輸出`);
  return lines.join('\n');
}

// ── 資格審查（純函式）──────────────────────────────────────────────────────

/**
 * 資格審查報告。`checks` 是 `{檢查項: boolean|'not-measured'}`。
 * **只有六項全部為 true 才 `qualified`**——`not-measured` 與 false 一樣擋，因為「沒量」不是「過了」。
 */
export function qualificationReport(checks = {}) {
  const rows = QUALIFICATION_CHECKS.map((id) => {
    const v = checks[id];
    return { id, state: v === true ? 'passed' : (v === false ? 'failed' : 'not-measured') };
  });
  const blocking = rows.filter((r) => r.state !== 'passed');
  return {
    qualified: blocking.length === 0,
    rows,
    blocking: blocking.map((r) => r.id),
    reason: blocking.length ? `還缺：${blocking.map((r) => `${r.id}（${r.state}）`).join('、')}——未全綠前維持在 catalog 之外，不提供任何「自己冒險」的旗標` : null,
  };
}

// ── 候選比較（純函式）──────────────────────────────────────────────────────

/**
 * 比較一個 optimizer 候選與 baseline。**品質先於 token**：
 *   · `taskSuccess` 或 `ruleAdherence` 任一退步 → `accepted: false`，不論省多少 token；
 *   · token／call／duration **只在雙方都有實測值時**才給結論；缺一邊 → `not measured`；
 *     有實測但沒變好 → `not improved`（不拿宣傳數字當實測）。
 */
export function compareCandidate(baseline, candidate) {
  const quality = [];
  for (const dim of QUALITY_DIMENSIONS) {
    const b = baseline?.[dim];
    const c = candidate?.[dim];
    if (typeof b !== 'number' || typeof c !== 'number') { quality.push({ dim, verdict: 'not measured', before: b ?? null, after: c ?? null }); continue; }
    quality.push({ dim, verdict: c < b ? 'regressed' : (c > b ? 'improved' : 'unchanged'), before: b, after: c });
  }
  const regressed = quality.filter((q) => q.verdict === 'regressed');
  const unmeasuredQuality = quality.filter((q) => q.verdict === 'not measured');

  const cost = [];
  for (const dim of ['tokens', 'calls', 'durationMs']) {
    const b = baseline?.[dim];
    const c = candidate?.[dim];
    if (typeof b !== 'number' || typeof c !== 'number') { cost.push({ dim, verdict: 'not measured', before: b ?? null, after: c ?? null }); continue; }
    cost.push({ dim, verdict: c < b ? 'improved' : 'not improved', before: b, after: c });
  }

  const accepted = regressed.length === 0 && unmeasuredQuality.length === 0;
  return {
    accepted,
    quality,
    cost,
    reason: regressed.length
      ? `品質退步，不接受：${regressed.map((q) => `${q.dim} ${q.before}→${q.after}`).join('、')}——省 token 不能拿品質換`
      : (unmeasuredQuality.length ? `品質維度沒量到（${unmeasuredQuality.map((q) => q.dim).join('、')}），不接受——沒量不等於沒退步` : null),
  };
}

/** 候選比較 → 人讀的表（cost 欄位誠實標 not improved／not measured）。 */
export function renderComparison(result) {
  const rows = ['| 維度 | 前 | 後 | 判定 |', '|---|---|---|---|'];
  for (const q of [...result.quality, ...result.cost]) rows.push(`| ${q.dim} | ${q.before ?? '—'} | ${q.after ?? '—'} | ${q.verdict} |`);
  return [result.accepted ? '**接受這個候選**' : `**不接受**：${result.reason}`, '', ...rows, ''].join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function main() {
  process.stdout.write([
    'token-optimizer —— 互斥 token optimizer 的忠實度契約與 receipt（#178）',
    `  受保護證據：${PROTECTED_EVIDENCE.map((p) => p.id).join('、')}`,
    `  資格審查：${QUALIFICATION_CHECKS.join('、')}（全綠才進 wizard）`,
    `  品質維度（先於 token）：${QUALITY_DIMENSIONS.join('、')}`,
    '',
  ].join('\n'));
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
