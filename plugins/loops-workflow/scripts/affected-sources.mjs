#!/usr/bin/env node
// affected-sources.mjs —— 一批改動要讓哪些外部來源跟著更新（#177）。
//
// 兩個具體問題：
//   1. **code graph 什麼時候重建**。每存一次檔就 reindex 會把時間都花在重建索引上；完全不重建則
//      reviewer 查到的是舊圖。答案是**在穩定的批次邊界重建**（階段離開／build checkpoint／進 verify 前），
//      不是每次 file edit。
//   2. **哪些改動要重跑哪一套評測**。skills／agents／policies／hooks 各自對應不同的評測面；
//      **純文件改動不觸發 prompt optimization**——那只會製造沒有訊號的重跑。
//
// 另外兩件與「誠實」直接相關的事：
//   · `evaluatorStatus()`：語意評測器不可用時一律 `degraded` 或 `not-measured`，**絕不寫成 passed**。
//   · `redactEvidence()`：fixture 與報告不得寫進絕對路徑與外部憑證——那些會隨報告散出去。
//
// 純函式；無 IO。依賴：僅 node 內建。

import { pathToFileURL } from 'node:url';

/** 會被這批改動波及、需要跟著更新的來源種類。 */
export const SOURCE_KINDS = Object.freeze(['code-graph', 'eval-route', 'eval-adherence', 'eval-trajectory', 'prompt-optimization']);

/** 一個檔案屬於哪一類改動。 */
export const CHANGE_KINDS = Object.freeze(['code', 'skill', 'agent', 'policy', 'hook', 'eval', 'docs', 'test', 'other']);

/**
 * code graph 允許重建的時機。**刻意不含 `file-edit`**——那正是要避免的形狀
 * （每存一次檔就重建，時間全花在索引上，而且中途的半成品狀態進了圖也沒有意義）。
 */
export const REINDEX_TRIGGERS = Object.freeze(['stage-exit', 'build-checkpoint', 'pre-verify', 'manual']);

/** 語意評測的狀態值域。`passed` 只有在**真的跑過而且過了**時才准出現。 */
export const EVALUATOR_STATUSES = Object.freeze(['passed', 'failed', 'degraded', 'not-measured']);

const normalize = (f) => String(f ?? '').split('\\').join('/');

/** 一個檔案屬於哪一類改動（順序有意義：先判最具體的）。 */
export function classifyChange(file) {
  const f = normalize(file);
  if (/(^|\/)(hooks|scripts)\/test-[^/]+\.mjs$/.test(f)) return 'test';
  if (/(^|\/)hooks\/[^/]+\.mjs$/.test(f)) return 'hook';
  if (/references\/policy-registry\.json$/.test(f)) return 'policy';
  if (/(^|\/)skills\//.test(f)) return 'skill';
  if (/(^|\/)agents\//.test(f)) return 'agent';
  if (/(^|\/)evals\//.test(f)) return 'eval';
  if (/(^|\/)AGENTS\.md$/.test(f) || /\.md$/.test(f)) return 'docs';
  if (/\.(mjs|js|ts|tsx|jsx|py|go|rs|java|rb|c|cc|cpp|h|hpp)$/.test(f)) return 'code';
  return 'other';
}

/**
 * 這批改動波及哪些來源。回 `{sources, reasons, kinds}`。
 *
 * mapping（逐條對應 issue #177 的〈Mapping〉）：
 *   · code／symbol 改動 → `code-graph`（圖要跟上）
 *   · skills → `eval-route` ＋ `eval-trajectory`（路由與走過的階段序列會變）
 *   · agents → `eval-trajectory`
 *   · policies／hooks → `eval-adherence`（規則遵循度）
 *   · **docs-only → 不觸發 `prompt-optimization`**（沒有訊號可比，重跑只是燒錢）
 */
export function affectedSources(files) {
  const kinds = new Map();
  for (const f of files || []) {
    const kind = classifyChange(f);
    if (!kinds.has(kind)) kinds.set(kind, []);
    kinds.get(kind).push(normalize(f));
  }
  const sources = new Set();
  const reasons = [];
  const add = (source, reason) => { sources.add(source); reasons.push({ source, reason }); };

  if (kinds.has('code')) add('code-graph', `${kinds.get('code').length} 個 code 檔改動 → code graph 要跟上（否則 reviewer 查到的是舊圖）`);
  if (kinds.has('hook')) add('code-graph', 'hook 本身也是 code，圖要跟上');
  if (kinds.has('skill')) { add('eval-route', 'skill 正文改動會影響路由判斷'); add('eval-trajectory', 'skill 正文改動會影響走過的階段序列'); }
  if (kinds.has('agent')) add('eval-trajectory', 'agent 正文改動會影響它在流程裡做的事');
  if (kinds.has('policy')) add('eval-adherence', '規則本身改了，遵循度要重測');
  if (kinds.has('hook')) add('eval-adherence', 'hook 是規則的執行者，改了要重測遵循度');

  const onlyDocs = kinds.size > 0 && [...kinds.keys()].every((k) => k === 'docs');
  if (onlyDocs) reasons.push({ source: null, reason: '純文件改動：不觸發 prompt optimization（沒有可比的訊號，重跑只是燒錢）' });

  return { sources, reasons, kinds: Object.fromEntries(kinds), onlyDocs };
}

/**
 * 這個時機該不該重建 code graph。
 * **`file-edit` 一律 false**——每存一次檔就重建是本設計要避免的形狀；沒有 code 類改動時也不重建。
 */
export function shouldReindex({ trigger, files = [] } = {}) {
  if (!REINDEX_TRIGGERS.includes(trigger)) {
    return { ok: false, reason: `"${trigger}" 不是允許的重建時機（允許：${REINDEX_TRIGGERS.join('／')}）——每次 file edit 就重建會把時間全花在索引上` };
  }
  const { sources } = affectedSources(files);
  if (!sources.has('code-graph')) return { ok: false, reason: '這批改動沒有 code／hook 檔，圖不會因此變舊' };
  return { ok: true, reason: `批次邊界 "${trigger}"，且有 code 改動 → 重建` };
}

/**
 * 語意評測的狀態判定。**`passed` 只有在「評測器可用 ∧ 真的跑了 ∧ 結果是過」三者同時成立時才出現。**
 * 其餘一律 `degraded`（想跑但跑不成）或 `not-measured`（根本沒打算跑）——
 * 「評不到」與「評過了」是兩件事，混為一談等於偽造證據。
 */
export function evaluatorStatus({ available = false, ran = false, result = null, planned = true } = {}) {
  if (!planned) return { status: 'not-measured', reason: '本輪沒有安排這項評測' };
  if (!available) return { status: 'degraded', reason: '評測器不可用（未安裝／健康檢查未過）——標 degraded，不得寫成 passed' };
  if (!ran) return { status: 'degraded', reason: '評測器可用但這輪沒跑起來——標 degraded，不得寫成 passed' };
  if (result === 'passed' || result === 'failed') return { status: result, reason: '實際跑過並得到結論' };
  return { status: 'degraded', reason: `跑了但沒有得到 passed／failed 結論（實際：${JSON.stringify(result)}）` };
}

/**
 * **hard invariant 不交給 LLM grader**。評測套件宣告要判的規則裡，若混進 tier-1/2 的機械規則，
 * 判紅——那些一律由 hook／state 測試判定，交給 grader 等於把確定的東西變成機率的。
 */
export function checkNoHardInvariantDelegation(suite, compiledRules) {
  const findings = [];
  for (const rule of suite?.rules ?? []) {
    const r = compiledRules?.get?.(rule) ?? null;
    if (!r) continue;
    if (r.mechanism === 'pre-tool-deny' || r.mechanism === 'state-guard') {
      findings.push({ check: 'hard-invariant-delegated', rule, detail: `規則 "${rule}" 是 ${r.tier}，由 ${r.guard} 機械判定；評測套件不得改由 grader 判（那會把確定的東西變成機率的）` });
    }
  }
  return findings;
}

// ── 敏感資料遮罩（純函式）──────────────────────────────────────────────────

/** 常見憑證形狀。刻意保守：寧可多遮，也不要讓一把 key 隨報告散出去。 */
const SECRET_PATTERNS = Object.freeze([
  { re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, label: 'api-key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, label: 'forge-token' },
  { re: /\bBearer\s+[A-Za-z0-9._-]{16,}/gi, label: 'bearer' },
  { re: /\b(?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|APIKEY|API_KEY))\s*[=:]\s*\S+/g, label: 'env-secret' },
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, label: 'email' },
]);

/**
 * 把要寫進 fixture／報告的文字洗乾淨：**絕對路徑改成 `<repo>/…`、憑證遮成 `<redacted:型別>`**。
 * 報告會被貼進 issue／PR、fixture 會進版控——那兩個地方都不該出現使用者的機器路徑與金鑰。
 * 回 `{text, redactions}`，`redactions` 逐項列出遮了什麼型別幾次（誠實揭露，不是靜默改寫）。
 */
export function redactEvidence(text, { repoRoot = null } = {}) {
  let out = String(text ?? '');
  const redactions = [];
  if (repoRoot) {
    const variants = [normalize(repoRoot), String(repoRoot)];
    for (const v of variants) {
      if (!v) continue;
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const before = out;
      out = out.replace(new RegExp(escaped, 'g'), '<repo>');
      if (out !== before) redactions.push({ label: 'repo-path', count: before.split(v).length - 1 });
    }
  }
  // 剩下的絕對路徑（Windows 磁碟機代號 / POSIX 家目錄）也一併收斂
  const homeish = /(?:[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+|\/(?:home|Users)\/[^\\/\s"']+)/g;
  const homeHits = out.match(homeish);
  if (homeHits) { out = out.replace(homeish, '<home>'); redactions.push({ label: 'home-path', count: homeHits.length }); }

  for (const { re, label } of SECRET_PATTERNS) {
    const hits = out.match(re);
    if (!hits) continue;
    out = out.replace(re, `<redacted:${label}>`);
    redactions.push({ label, count: hits.length });
  }
  return { text: out, redactions };
}

/** 這份文字還有沒有殘留的機器路徑或憑證（寫進 fixture／報告前的最後一道檢查）。 */
export function hasSensitiveResidue(text) {
  const t = String(text ?? '');
  if (/(?:[A-Za-z]:[\\/]Users[\\/])|(?:\/(?:home|Users)\/)/.test(t)) return true;
  return SECRET_PATTERNS.some(({ re }) => new RegExp(re.source, re.flags.replace('g', '')).test(t));
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith('--'));
  if (!files.length) {
    process.stdout.write([
      '用法：node affected-sources.mjs <改到的檔...> [--json]',
      `  來源種類：${SOURCE_KINDS.join('／')}`,
      `  允許的重建時機：${REINDEX_TRIGGERS.join('／')}（刻意不含 file-edit）`,
      '',
    ].join('\n'));
    return 0;
  }
  const result = affectedSources(files);
  const payload = { sources: [...result.sources], reasons: result.reasons, onlyDocs: result.onlyDocs };
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    process.stdout.write(`波及來源：${payload.sources.length ? payload.sources.join('、') : '（無）'}\n`);
    for (const r of payload.reasons) process.stdout.write(`  · ${r.source ?? '—'}：${r.reason}\n`);
  }
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
