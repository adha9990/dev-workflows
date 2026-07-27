#!/usr/bin/env node
// validate-plan.mjs —— 檢查 02-plan.md 內嵌的 ```loops-plan JSON 區塊是否符合 machine-plan-schema。
//
// 兩種形：
//   · **evidence 形**（有 `behaviors`）—— 功能工作的預設。除了 slice 的可驗證性，另外機械核
//     `references/stages/evidence-portfolio.md` 的硬規則：每個 behavior 恰一份 primary evidence、
//     new_test 要有理由、第二層證據要有 distinct_risk、每個 slice 要有可驗證的 change budget、
//     每個 planned changed file 恰屬於一個 slice。
//   · **legacy `tasks` 形**（無 `behaviors`）—— 純內部 / 無行為承諾的瑣碎改動沿用舊檢查。
//     一旦出現 `behaviors`，evidence 規則就是必填，不能用 legacy 形繞過。
//
// 用法：node validate-plan.mjs <path-to-02-plan.md>
// 通過 → exit 0；任一問題 → 列出後 exit 1；讀不到檔 / 找不到區塊 → exit 2。依賴：無（純 Node）。
//
// 純函式（extractPlanBlock / validatePlan / summarize）＋ IO 薄邊界（main），測試直接 import 純函式。

import { readFileSync } from 'node:fs';

/** `primary_evidence` 的值域（證據階梯，正本見 evidence-portfolio.md）。 */
export const EVIDENCE_TYPES = Object.freeze([
  'existing-test',
  'static',
  'smoke',
  'unit-test',
  'contract-test',
  'integration-test',
  'acceptance-test',
  'manual-evidence',
]);

/** 不需要指名 existing_guard 的證據型別（它們本來就不是「某個既有測試」）。 */
const GUARD_OPTIONAL_EVIDENCE = new Set(['existing-test', 'static', 'smoke', 'manual-evidence']);

/** behavior 的風險值域，由低到高（順序有意義：risk_triggers 非空時要至少 medium）。 */
export const RISK_LEVELS = Object.freeze(['low', 'medium', 'high']);

/**
 * 從 02-plan.md 全文取出 ```loops-plan 區塊並解析。
 * @returns `{ plan }` 或 `{ error: { kind: 'missing'|'invalid-json', detail } }`
 */
export function extractPlanBlock(text) {
  const m = String(text ?? '').match(/```loops-plan\s*\n([\s\S]*?)\n```/);
  if (!m) return { error: { kind: 'missing', detail: '找不到 ```loops-plan 區塊（計畫未附機器可驗證結構）。' } };
  try {
    return { plan: JSON.parse(m[1]) };
  } catch (e) {
    return { error: { kind: 'invalid-json', detail: `loops-plan 區塊不是合法 JSON：${e.message}` } };
  }
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;

/** slices 是正式鍵；legacy 計畫用 `tasks`。兩者擇一（都有時以 slices 為準並回報）。 */
function readSlices(plan) {
  if (Array.isArray(plan?.slices)) return { key: 'slices', list: plan.slices, hasLegacy: Array.isArray(plan?.tasks) };
  if (Array.isArray(plan?.tasks)) return { key: 'tasks', list: plan.tasks, hasLegacy: false };
  return { key: 'slices', list: null, hasLegacy: false };
}

/** behaviors[] 的形狀與值域。回傳問題清單 + 合法 id 集合。 */
function checkBehaviors(behaviors) {
  const problems = [];
  const ids = new Set();
  for (const [i, b] of behaviors.entries()) {
    const where = `behavior #${i + 1}${b && b.id ? `（${b.id}）` : ''}`;
    if (!isPlainObject(b)) { problems.push(`${where}：不是物件。`); continue; }
    if (!isNonEmptyString(b.id)) problems.push(`${where}：id 缺或非字串。`);
    else if (ids.has(b.id)) problems.push(`${where}：id 重複。`);
    else ids.add(b.id);
    if (!isNonEmptyString(b.statement)) problems.push(`${where}：statement 缺（要一句可觀察的行為敘述）。`);
    if (!RISK_LEVELS.includes(b.risk)) problems.push(`${where}：risk 必須是 ${RISK_LEVELS.join(' / ')} 之一。`);
    if (b.risk_triggers !== undefined && !Array.isArray(b.risk_triggers)) {
      problems.push(`${where}：risk_triggers 必須是陣列。`);
    } else if (Array.isArray(b.risk_triggers) && b.risk_triggers.length > 0 && b.risk === 'low') {
      problems.push(`${where}：risk_triggers 非空（${b.risk_triggers.join('、')}）卻標 risk=low，至少要 medium。`);
    }
  }
  return { problems, ids };
}

/** slice / task 的形狀（兩形共用）。回傳問題清單 + 合法 id 集合。 */
function checkSliceShape(list, key) {
  const problems = [];
  const ids = new Set();
  for (const [i, t] of list.entries()) {
    const where = `${key} #${i + 1}${t && t.id ? `（${t.id}）` : ''}`;
    if (!isPlainObject(t)) { problems.push(`${where}：不是物件。`); continue; }
    if (!isNonEmptyString(t.id)) problems.push(`${where}：id 缺或非字串。`);
    else if (ids.has(t.id)) problems.push(`${where}：id 重複。`);
    else ids.add(t.id);
    if (!isNonEmptyString(t.title)) problems.push(`${where}：title 缺或非字串。`);
    else if (/\sand\s/i.test(t.title)) problems.push(`${where}：title 含 " and "（該再拆）。`);
    if (!isNonEmptyString(t.verification)) problems.push(`${where}：verification 必須是非空可執行指令。`);
    if (t.deps !== undefined && !Array.isArray(t.deps)) problems.push(`${where}：deps 必須是陣列。`);
    if (t.files !== undefined && !Array.isArray(t.files)) problems.push(`${where}：files 必須是陣列。`);
    if (t.acceptance !== undefined && !Array.isArray(t.acceptance)) problems.push(`${where}：acceptance 必須是陣列。`);
  }
  return { problems, ids };
}

/** deps 指向存在的 id，且不成環（DFS 找出一條環路指名）。 */
function checkDeps(list, ids, key) {
  const problems = [];
  for (const t of list) {
    for (const d of (isPlainObject(t) && Array.isArray(t.deps) ? t.deps : [])) {
      if (!ids.has(d)) problems.push(`${key} ${t.id}：依賴的 ${d} 不存在。`);
    }
  }
  const graph = new Map(list.filter(isPlainObject).map((t) => [t.id, (t.deps || []).filter((d) => ids.has(d))]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...ids].map((id) => [id, WHITE]));
  const stack = [];
  let cycle = null;
  const dfs = (u) => {
    color.set(u, GRAY); stack.push(u);
    for (const v of graph.get(u) || []) {
      if (color.get(v) === GRAY) { cycle = [...stack.slice(stack.indexOf(v)), v]; return true; }
      if (color.get(v) === WHITE && dfs(v)) return true;
    }
    color.set(u, BLACK); stack.pop(); return false;
  };
  for (const id of ids) { if (color.get(id) === WHITE && dfs(id)) break; }
  if (cycle) problems.push(`依賴成環：${cycle.join(' → ')}`);
  return problems;
}

/** 每個 planned changed file 恰屬於一個 slice（同檔跨 slice ＝ 切片沒切乾淨）。 */
function checkFileOwnership(list, key) {
  const problems = [];
  const owner = new Map();
  for (const t of list) {
    if (!isPlainObject(t) || !Array.isArray(t.files)) continue;
    for (const f of t.files) {
      if (typeof f !== 'string' || f.trim() === '') continue;
      if (owner.has(f) && owner.get(f) !== t.id) {
        problems.push(`檔案 ${f} 同時屬於 ${key} ${owner.get(f)} 與 ${t.id}（每個 planned changed file 只能屬於一個 slice）。`);
      } else if (!owner.has(f)) {
        owner.set(f, t.id);
      }
    }
  }
  return problems;
}

/** slice 的兩份 change budget（evidence 形必填）。 */
function checkBudgets(list, key) {
  const problems = [];
  for (const t of list) {
    if (!isPlainObject(t)) continue;
    for (const field of ['production_change_budget', 'test_change_budget']) {
      const b = t[field];
      if (!isPlainObject(b)) {
        problems.push(`${key} ${t.id}：缺 ${field}（缺少可驗證的 budget 不准進 build）。`);
        continue;
      }
      if (!isCount(b.files)) problems.push(`${key} ${t.id}：${field}.files 必須是 ≥0 整數。`);
      if (!isCount(b.lines)) problems.push(`${key} ${t.id}：${field}.lines 必須是 ≥0 整數。`);
    }
  }
  return problems;
}

/** slice ↔ behavior 的雙向認領。 */
function checkSliceBehaviorLinks(list, key, behaviorIds) {
  const problems = [];
  const claimed = new Set();
  for (const t of list) {
    if (!isPlainObject(t)) continue;
    if (!Array.isArray(t.behaviors) || t.behaviors.length === 0) {
      problems.push(`${key} ${t.id}：behaviors 必須是非空陣列（每個 slice 要交付至少一個 behavior）。`);
      continue;
    }
    for (const bid of t.behaviors) {
      if (!behaviorIds.has(bid)) problems.push(`${key} ${t.id}：behaviors 指向不存在的 ${bid}。`);
      else claimed.add(bid);
    }
  }
  for (const bid of behaviorIds) {
    if (!claimed.has(bid)) problems.push(`behavior ${bid}：沒有任何 slice 認領它（承諾了行為卻沒人做）。`);
  }
  return problems;
}

/** evidence portfolio 的硬規則（見 evidence-portfolio.md）。 */
function checkEvidencePortfolio(portfolio, behaviorIds, behaviorRisk) {
  const problems = [];
  const primaryCount = new Map([...behaviorIds].map((id) => [id, 0]));
  const seenLayers = new Set();

  for (const [i, e] of portfolio.entries()) {
    const where = `evidence #${i + 1}${e && e.behavior_id ? `（${e.behavior_id}）` : ''}`;
    if (!isPlainObject(e)) { problems.push(`${where}：不是物件。`); continue; }
    if (!isNonEmptyString(e.behavior_id)) { problems.push(`${where}：behavior_id 缺或非字串。`); continue; }
    if (!behaviorIds.has(e.behavior_id)) { problems.push(`${where}：behavior_id 指向不存在的 behavior。`); continue; }

    if (!EVIDENCE_TYPES.includes(e.primary_evidence)) {
      problems.push(`${where}：primary_evidence 必須是 ${EVIDENCE_TYPES.join(' / ')} 之一。`);
    }
    if (!isNonEmptyString(e.evidence_layer)) problems.push(`${where}：evidence_layer 缺（要寫這份證據落在哪一層）。`);
    if (typeof e.new_test !== 'boolean') problems.push(`${where}：new_test 必須是 boolean。`);
    if (e.new_test === true && !isNonEmptyString(e.new_test_reason)) {
      problems.push(`${where}：new_test=true 必須填 new_test_reason（既有證據缺哪個觀察點）。`);
    }
    if (e.new_test === false && EVIDENCE_TYPES.includes(e.primary_evidence)
      && !GUARD_OPTIONAL_EVIDENCE.has(e.primary_evidence) && !isNonEmptyString(e.existing_guard)) {
      problems.push(`${where}：new_test=false 但沒指名 existing_guard —— 這份 ${e.primary_evidence} 證據不知道由誰承接。`);
    }
    if (e.risk !== undefined && e.risk !== null && behaviorRisk.has(e.behavior_id)
      && e.risk !== behaviorRisk.get(e.behavior_id)) {
      problems.push(`${where}：risk=${e.risk} 與 behaviors[] 宣告的 ${behaviorRisk.get(e.behavior_id)} 不一致。`);
    }

    if (!isNonEmptyString(e.distinct_risk)) primaryCount.set(e.behavior_id, (primaryCount.get(e.behavior_id) ?? 0) + 1);

    const layerKey = `${e.behavior_id}::${e.evidence_layer}`;
    if (seenLayers.has(layerKey)) {
      problems.push(`${where}：${e.behavior_id} 在 ${e.evidence_layer} 層已有一份證據（同層重複，取一份即可）。`);
    } else {
      seenLayers.add(layerKey);
    }
  }

  for (const [bid, n] of primaryCount) {
    if (n === 0) problems.push(`behavior ${bid}：沒有 primary evidence（每個 behavior 恰要一份；追加層要填 distinct_risk）。`);
    else if (n > 1) problems.push(`behavior ${bid}：有 ${n} 份 primary evidence（恰一份；第二份起必須填 distinct_risk 說明它守什麼別的風險）。`);
  }
  return problems;
}

/**
 * 驗證一份已解析的 loops-plan。
 * @returns `{ ok, problems, mode }` —— mode: 'evidence'（有 behaviors）/ 'legacy'。
 */
export function validatePlan(plan) {
  const problems = [];
  const { key, list, hasLegacy } = readSlices(plan);
  const hasBehaviors = Array.isArray(plan?.behaviors);
  const mode = hasBehaviors ? 'evidence' : 'legacy';

  if (hasLegacy) problems.push('同時有 slices 與 tasks 兩個鍵（擇一；slices 是正式鍵）。');
  if (!list || list.length === 0) {
    problems.push(`${key} 必須是非空陣列。`);
    return { ok: false, problems, mode };
  }

  const slice = checkSliceShape(list, key);
  problems.push(...slice.problems);
  problems.push(...checkDeps(list, slice.ids, key));
  problems.push(...checkFileOwnership(list, key));

  if (!hasBehaviors) {
    if (Array.isArray(plan?.evidence_portfolio) && plan.evidence_portfolio.length > 0) {
      problems.push('有 evidence_portfolio 卻沒有 behaviors —— 證據要掛在行為上，先宣告 behaviors。');
    }
    return { ok: problems.length === 0, problems, mode };
  }

  if (plan.behaviors.length === 0) {
    problems.push('behaviors 是空陣列 —— 沒有行為要承諾就用 legacy tasks 形，別留一個空的 behaviors。');
    return { ok: false, problems, mode };
  }

  const behaviors = checkBehaviors(plan.behaviors);
  problems.push(...behaviors.problems);
  const behaviorRisk = new Map(plan.behaviors.filter(isPlainObject).map((b) => [b.id, b.risk]));

  problems.push(...checkSliceBehaviorLinks(list, key, behaviors.ids));
  problems.push(...checkBudgets(list, key));

  if (!Array.isArray(plan?.evidence_portfolio)) {
    problems.push('有 behaviors 就必須有 evidence_portfolio（每個 behavior 恰一份 primary evidence）。');
  } else {
    problems.push(...checkEvidencePortfolio(plan.evidence_portfolio, behaviors.ids, behaviorRisk));
  }

  return { ok: problems.length === 0, problems, mode };
}

/** 通過時的單行摘要（給人看的收據）。 */
export function summarize(plan, mode) {
  const { key, list } = readSlices(plan);
  if (mode === 'legacy') {
    return `✓ 計畫驗證通過（legacy 形：${list.length} 個 ${key}，依賴無環、verification 齊全）。`;
  }
  const newTests = plan.evidence_portfolio.filter((e) => e?.new_test === true).length;
  return `✓ 計畫驗證通過（${plan.behaviors.length} 個 behavior／${list.length} 個 slice／`
    + `${plan.evidence_portfolio.length} 份證據，其中 ${newTests} 份要新增測試；budget 齊全、依賴無環）。`;
}

// ── CLI（IO 薄邊界）─────────────────────────────────────────────────────────

function main(argv) {
  const file = argv[2];
  if (!file) {
    console.error('用法：node validate-plan.mjs <path-to-02-plan.md>');
    return 2;
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    console.error(`讀不到檔案：${file}`);
    return 2;
  }
  const extracted = extractPlanBlock(text);
  if (extracted.error) {
    console.error(extracted.error.detail);
    return extracted.error.kind === 'missing' ? 2 : 1;
  }
  const { ok, problems, mode } = validatePlan(extracted.plan);
  if (!ok) {
    console.error(`✗ 計畫驗證未通過（${problems.length} 個問題）：`);
    for (const p of problems) console.error('  - ' + p);
    return 1;
  }
  console.log(summarize(extracted.plan, mode));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
