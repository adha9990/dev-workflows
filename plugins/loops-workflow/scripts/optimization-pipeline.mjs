#!/usr/bin/env node
// optimization-pipeline.mjs —— affected-source optimization pipeline（#179）。
//
// 問題：把 optimizer 裝起來本身**不會**讓 repo 變好。要真的有用，得回答四件事：
//   1. **這批改動該跑哪些東西**（不是每次都全跑，也不是憑感覺挑）；
//   2. **順序是什麼**（便宜且確定的先跑：compiler／schema → deterministic tests → …；
//      貴且有雜訊的最後）；
//   3. **怎麼不遞迴**（optimizer 產出的改動又觸發 optimizer）；
//   4. **什麼情況接受它的產出**（品質不得低於 baseline，才輪到比 token）。
//
// 三條安全邊界（與 #175 的 optimizer 保護面同一套，不另立第二份）：
//   · optimizer **只產 candidate**，不直接覆寫正式 skill；
//   · policy registry／hard hooks／approval contract／eval oracle **永遠不在 write scope**；
//   · hard invariant 與 held-out 的 success／adherence **不得低於 baseline**，才比較 token／call／duration。
//
// 誠實：**沒跑的來源標 `not measured`**——「已安裝」不等於「已優化」。
//
// 純函式；無 IO（實際執行由呼叫端）。依賴：僅 node 內建 ＋ 同目錄的 affected-sources／policy-change。

import { pathToFileURL } from 'node:url';

import { classifyChange } from './affected-sources.mjs';
import { gateOptimizerChange } from './policy-change.mjs';

/**
 * 執行順序（小者先）。**便宜且確定的先跑**——compiler／schema 與 deterministic tests 幾秒就知道結果，
 * 紅了就不必再花錢跑後面那些貴的；SkillOpt／評測／benchmark 擺最後。
 */
export const ACTION_ORDER = Object.freeze([
  'compiler-schema',
  'deterministic-tests',
  'code-graph-refresh',
  'symbol-consistency',
  'replay-migration',
  'lifecycle-canary',
  'docs-devex-checks',
  'skill-candidate',
  'prompt-eval',
  'token-benchmark',
]);

/** 每個 action 一句話（報告直接用，不必每次重寫）。 */
export const ACTION_LABELS = Object.freeze({
  'compiler-schema': 'registry／schema 編譯檢查',
  'deterministic-tests': '確定性測試（hook／逃生口／單元）',
  'code-graph-refresh': 'code graph 重建',
  'symbol-consistency': '符號與引用一致性檢查',
  'replay-migration': '事件流 replay／遷移／resume 一致性',
  'lifecycle-canary': '來源 lifecycle canary',
  'docs-devex-checks': '文件／devex／連結／指令檢查',
  'skill-candidate': 'skill 改寫候選（只產 candidate）',
  'prompt-eval': '規則遵循／路由／trajectory 評測',
  'token-benchmark': 'token／call／duration 實測對照',
});

/**
 * 改動類別 → 要跑哪些 action（issue #179 的 trigger mapping 逐條落地）。
 * **`docs` 刻意不含 `skill-candidate`**：純文件改動不跑 prompt optimization。
 */
export const TRIGGER_MAP = Object.freeze({
  skill: ['skill-candidate', 'prompt-eval', 'token-benchmark'],
  agent: ['prompt-eval', 'token-benchmark'],
  policy: ['compiler-schema', 'deterministic-tests', 'prompt-eval'],
  hook: ['compiler-schema', 'deterministic-tests', 'prompt-eval', 'code-graph-refresh'],
  code: ['code-graph-refresh', 'symbol-consistency', 'deterministic-tests'],
  test: ['deterministic-tests'],
  eval: ['prompt-eval'],
  docs: ['docs-devex-checks'],
  other: [],
});

/** 這些檔案路徑另外觸發特定 action（與改動類別正交）。 */
const PATH_TRIGGERS = Object.freeze([
  { re: /references\/(setup-catalog|integration-registry)\.json$/, actions: ['lifecycle-canary'], why: '來源 catalog／registry 變了，要跑 lifecycle canary' },
  { re: /scripts\/(loop-ledger|loop-graph|loop-snapshot|loop-migrate)\.mjs$/, actions: ['replay-migration'], why: '.loops schema 相關，要驗 replay／遷移／resume 一致性' },
  { re: /references\/shared\//, actions: ['prompt-eval'], why: '共用 reference 變了，沿依賴圖找到的 consumer 要重測' },
]);

/** 未跑的來源一律用這個字面，別寫成「已優化」。 */
export const NOT_MEASURED = 'not measured';

// ── resolver（純函式）──────────────────────────────────────────────────────

/**
 * changed files → components → triggers → 去重 → 排序。
 *
 * `componentsOf` 以 port 注入（`(file) => string[]`），讓「哪個檔屬於哪個元件」的知識留在
 * component registry，本檔只負責觸發與排序。共用 reference 的 consumer 沿依賴圖展開後，
 * 用它們各自的類別再跑一次 trigger map——這樣「改一份共用規範」才會連帶測到真的讀它的那些東西。
 */
export function resolveActions(files, { componentsOf = null, consumersOf = null } = {}) {
  const triggered = new Map(); // action → reasons[]
  const add = (action, reason) => {
    if (!ACTION_ORDER.includes(action)) return;
    if (!triggered.has(action)) triggered.set(action, []);
    if (!triggered.get(action).includes(reason)) triggered.get(action).push(reason);
  };

  const seenFiles = new Set();
  const queue = [...(files || [])].map((f) => String(f).split('\\').join('/'));
  const components = new Set();

  while (queue.length) {
    const file = queue.shift();
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);

    const kind = classifyChange(file);
    for (const action of TRIGGER_MAP[kind] ?? []) add(action, `${file}（${kind}）`);
    for (const { re, actions, why } of PATH_TRIGGERS) {
      if (re.test(file)) for (const a of actions) add(a, `${file}：${why}`);
    }
    for (const c of componentsOf ? componentsOf(file) ?? [] : []) components.add(c);

    // 共用 reference：沿依賴圖把 consumer 拉進來（它們的內容依賴這份檔）
    if (/references\/shared\//.test(file) && consumersOf) {
      for (const consumerFile of consumersOf(file) ?? []) {
        if (!seenFiles.has(consumerFile)) queue.push(consumerFile);
      }
    }
  }

  const actions = [...triggered.keys()].sort((a, b) => ACTION_ORDER.indexOf(a) - ACTION_ORDER.indexOf(b));
  return {
    actions,
    plan: actions.map((a) => ({ action: a, label: ACTION_LABELS[a], reasons: triggered.get(a) })),
    components: [...components].sort(),
    kinds: [...seenFiles].reduce((acc, f) => { const k = classifyChange(f); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
  };
}

// ── 遞迴保護（純函式）──────────────────────────────────────────────────────

/**
 * 同一個 `optimization_run_id` 內，**每個來源最多跑一次**。
 * 這條擋的是「optimizer 產出的改動又觸發 optimizer」——沒有它，一次 skill 改寫可以無限自我引用。
 *
 * `state` 是 `{runId, done:Set}`；回 `{ok, skipped, reason}`。
 */
export function guardRecursion(state, { runId, action }) {
  if (!state || state.runId !== runId) {
    return { ok: true, skipped: false, reason: null, next: { runId, done: new Set([action]) } };
  }
  if (state.done.has(action)) {
    return { ok: false, skipped: true, reason: `"${action}" 在本次 optimization run（${runId}）已經跑過——同一個 run 內每個來源最多一次，防止彼此觸發造成無限迴圈`, next: state };
  }
  const done = new Set(state.done);
  done.add(action);
  return { ok: true, skipped: false, reason: null, next: { runId, done } };
}

/** 依序跑一份 plan，並用 run id 擋掉重複觸發。回實際跑了什麼、跳過了什麼。 */
export function runPlan(plan, { runId, state = null } = {}) {
  let cursor = state;
  const ran = [];
  const skipped = [];
  for (const step of plan) {
    const g = guardRecursion(cursor, { runId, action: step.action });
    cursor = g.next;
    if (g.skipped) skipped.push({ action: step.action, reason: g.reason });
    else ran.push(step.action);
  }
  return { ran, skipped, state: cursor };
}

// ── candidate 驗收（純函式）───────────────────────────────────────────────

/**
 * 一份 optimizer candidate 能不能被接受。三關，順序不可換：
 *   1. **write scope**：碰到規則本身或評分基準 → 直接拒（重用 #175 的 `gateOptimizerChange`，不另立一套）。
 *   2. **只產 candidate**：改動必須落在 candidate 目錄，不得直接覆寫正式 skill。
 *   3. **品質不得低於 baseline**：hard invariant adherence 與 held-out success／adherence 任一低於
 *      baseline → 拒；**沒量到也拒**（沒量不等於沒退步）。過了才輪到比 token／call／duration。
 */
export function reviewCandidate(candidate, { baseline = {}, candidateRoot = '.loops/.candidates/' } = {}) {
  const reasons = [];
  const files = candidate?.files ?? [];

  const scope = gateOptimizerChange(files);
  if (!scope.ok) reasons.push({ gate: 'write-scope', detail: scope.reason });

  const outside = files.filter((f) => !String(f).split('\\').join('/').startsWith(candidateRoot));
  if (outside.length) {
    reasons.push({ gate: 'candidate-only', detail: `candidate 只能寫進 ${candidateRoot}，這幾個落在外面：${outside.join('、')}——optimizer 不得直接覆寫正式 skill` });
  }

  const quality = [];
  for (const dim of ['hardInvariantAdherence', 'heldOutSuccess', 'heldOutAdherence']) {
    const b = baseline?.[dim];
    const c = candidate?.metrics?.[dim];
    if (typeof b !== 'number' || typeof c !== 'number') { quality.push({ dim, verdict: NOT_MEASURED, before: b ?? null, after: c ?? null }); continue; }
    quality.push({ dim, verdict: c < b ? 'regressed' : (c > b ? 'improved' : 'unchanged'), before: b, after: c });
  }
  const regressed = quality.filter((q) => q.verdict === 'regressed');
  const unmeasured = quality.filter((q) => q.verdict === NOT_MEASURED);
  if (regressed.length) reasons.push({ gate: 'quality-floor', detail: `品質低於 baseline：${regressed.map((q) => `${q.dim} ${q.before}→${q.after}`).join('、')}` });
  if (unmeasured.length) reasons.push({ gate: 'quality-floor', detail: `品質維度沒量到：${unmeasured.map((q) => q.dim).join('、')}——沒量不等於沒退步` });

  const accepted = reasons.length === 0;
  return {
    accepted,
    reasons,
    quality,
    // 只有品質關過了才輪到成本——順序寫死在這裡，避免「省很多 token」的候選蓋過品質退步
    costComparable: accepted,
    decision: accepted ? 'accept' : 'reject',
  };
}

/** candidate 驗收 → 人讀報告（含 accept／reject 理由，逐條）。 */
export function renderCandidateReview(review) {
  const lines = [`**判定：${review.decision}**`, ''];
  if (review.reasons.length) {
    lines.push('拒絕理由：', '');
    for (const r of review.reasons) lines.push(`- [${r.gate}] ${r.detail}`);
    lines.push('');
  }
  lines.push('| 品質維度 | 前 | 後 | 判定 |', '|---|---|---|---|');
  for (const q of review.quality) lines.push(`| ${q.dim} | ${q.before ?? '—'} | ${q.after ?? '—'} | ${q.verdict} |`);
  lines.push('', review.costComparable ? '品質關已過 → 才比較 token／call／duration。' : '品質關未過 → **不比較成本**（省 token 不能拿品質換）。', '');
  return lines.join('\n');
}

/** 沒跑的 action 一律標 not measured——「已安裝」不等於「已優化」。 */
export function reportCoverage(plan, ran) {
  const ranSet = new Set(ran);
  return plan.map((step) => ({
    action: step.action,
    label: step.label,
    status: ranSet.has(step.action) ? 'ran' : NOT_MEASURED,
  }));
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith('--'));
  if (!files.length) {
    process.stdout.write([
      '用法：node optimization-pipeline.mjs <改到的檔...> [--json]',
      `  執行順序：${ACTION_ORDER.join(' → ')}`,
      '',
    ].join('\n'));
    return 0;
  }
  const resolved = resolveActions(files);
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
  else {
    process.stdout.write(`要跑的 action（依序）：${resolved.actions.length ? resolved.actions.join(' → ') : '（無）'}\n`);
    for (const s of resolved.plan) process.stdout.write(`  · ${s.action}（${s.label}）：${s.reasons.join('；')}\n`);
  }
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
