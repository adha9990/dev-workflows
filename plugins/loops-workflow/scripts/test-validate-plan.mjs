#!/usr/bin/env node
// test-validate-plan.mjs —— machine-plan（evidence 形 / legacy 形）驗證器的斷言（#215）。
// 對應驗收標準：每個 behavior 追得到一份 primary evidence、new_test 要有理由、重複證據要有
// distinct_risk、缺 budget 不准進 build、每個 planned changed file 恰屬於一個 slice，
// 以及「acceptance ≤3」這條舊耦合確實已移除。
// 用法：node test-validate-plan.mjs [--filter <case-prefix>] [--min-cases <n>]

import { EVIDENCE_TYPES, RISK_LEVELS, extractPlanBlock, validatePlan, summarize } from './validate-plan.mjs';

let passed = 0;
const failed = [];
const cases = [];
const testCase = (id, name, fn) => cases.push({ id, name, fn });
function assert(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); } else { failed.push(msg); console.error(`  ✗ ${msg}`); }
}
function parseArgs(argv) {
  const opts = { filter: '', minCases: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--filter') opts.filter = argv[++i] ?? '';
    else if (argv[i] === '--min-cases') opts.minCases = Number(argv[++i] ?? 0);
  }
  return opts;
}
/** 某條問題訊息是否出現（子字串比對，避免綁死措辭全文）。 */
const has = (problems, needle) => problems.some((p) => p.includes(needle));

// ── fixtures ────────────────────────────────────────────────────────────────

const budget = () => ({
  production_change_budget: { files: 3, lines: 180 },
  test_change_budget: { files: 1, lines: 60 },
});

/** 一份最小但完整合法的 evidence 形計畫。 */
function evidencePlan(over = {}) {
  return {
    behaviors: [{ id: 'B1', statement: '清單看得到子資料夾內容數', risk: 'medium', risk_triggers: [] }],
    slices: [{
      id: 'S1', title: '內容數走既有 count 服務', behaviors: ['B1'],
      verification: 'pnpm test -- folder-count', deps: [], files: ['src/a.ts'], ...budget(),
    }],
    evidence_portfolio: [{
      behavior_id: 'B1', risk: 'medium', existing_guard: 'tests/folders/navigation.test.ts',
      primary_evidence: 'integration-test', evidence_layer: 'service-ui-boundary',
      new_test: false, new_test_reason: null, distinct_risk: null,
    }],
    ...over,
  };
}

/** 一份最小合法的 legacy tasks 形計畫。 */
const legacyPlan = (over = {}) => ({
  tasks: [{ id: 'T1', title: '移除死碼', verification: 'pnpm lint', deps: [], files: ['src/legacy.ts'] }],
  ...over,
});

// ══════════════════════════════════════════════════════════════════════════
testCase('V1', '值域常數固定（證據階梯 + 風險等級）', () => {
  assert(EVIDENCE_TYPES.join(',') === 'existing-test,static,smoke,unit-test,contract-test,integration-test,acceptance-test,manual-evidence',
    '證據階梯由便宜到貴，八階固定');
  assert(RISK_LEVELS.join(',') === 'low,medium,high', '風險三級由低到高');
});

testCase('V2', 'extractPlanBlock：抓得到區塊 / 缺區塊 / 壞 JSON 三態', () => {
  const ok = extractPlanBlock('前言\n\n```loops-plan\n{"tasks":[]}\n```\n後話');
  assert(ok.plan && Array.isArray(ok.plan.tasks), '正常區塊解析成物件');
  assert(extractPlanBlock('沒有區塊').error?.kind === 'missing', '沒有區塊 → missing');
  assert(extractPlanBlock('```loops-plan\n{oops\n```').error?.kind === 'invalid-json', '壞 JSON → invalid-json');
});

testCase('V3', 'evidence 形：完整合法的計畫通過', () => {
  const r = validatePlan(evidencePlan());
  assert(r.ok, `合法 evidence 計畫通過（實際問題：${r.problems.join(' / ')}）`);
  assert(r.mode === 'evidence', 'mode 判為 evidence');
  assert(summarize(evidencePlan(), 'evidence').includes('1 個 behavior'), '摘要點出 behavior 數');
});

testCase('V4', '每個 behavior 恰一份 primary evidence', () => {
  const zero = evidencePlan({ evidence_portfolio: [] });
  assert(!validatePlan(zero).ok && has(validatePlan(zero).problems, '沒有 primary evidence'), '零份 primary → 擋');

  const p = evidencePlan();
  const two = evidencePlan({
    evidence_portfolio: [
      p.evidence_portfolio[0],
      { ...p.evidence_portfolio[0], evidence_layer: 'unit', primary_evidence: 'unit-test' },
    ],
  });
  const r = validatePlan(two);
  assert(!r.ok && has(r.problems, '2 份 primary evidence'), '同一 behavior 兩份未標 distinct_risk 的證據 → 擋');
});

testCase('V5', '第二層證據要填 distinct_risk 才放行（重複證據的唯一出口）', () => {
  const p = evidencePlan();
  const layered = evidencePlan({
    evidence_portfolio: [
      p.evidence_portfolio[0],
      {
        behavior_id: 'B1', existing_guard: null, primary_evidence: 'contract-test',
        evidence_layer: 'http-contract', new_test: true,
        new_test_reason: '既有整合測試不驗回應形狀', distinct_risk: '對外 JSON 形狀改變不會被整合測試看見',
      },
    ],
  });
  const r = validatePlan(layered);
  assert(r.ok, `寫得出 distinct_risk 的第二層證據放行（實際問題：${r.problems.join(' / ')}）`);

  const noRisk = evidencePlan({
    evidence_portfolio: [
      p.evidence_portfolio[0],
      {
        behavior_id: 'B1', existing_guard: null, primary_evidence: 'contract-test',
        evidence_layer: 'http-contract', new_test: true, new_test_reason: '理由', distinct_risk: '   ',
      },
    ],
  });
  assert(!validatePlan(noRisk).ok, 'distinct_risk 只填空白 → 仍算 primary、擋下');
});

testCase('V6', 'new_test=true 必須寫得出 new_test_reason', () => {
  const p = evidencePlan();
  const noReason = evidencePlan({
    evidence_portfolio: [{ ...p.evidence_portfolio[0], primary_evidence: 'unit-test', new_test: true, new_test_reason: null }],
  });
  const r = validatePlan(noReason);
  assert(!r.ok && has(r.problems, 'new_test_reason'), '要新增測試卻沒寫既有證據缺什麼 → 擋');

  const withReason = evidencePlan({
    evidence_portfolio: [{
      ...p.evidence_portfolio[0], existing_guard: null, primary_evidence: 'unit-test',
      new_test: true, new_test_reason: '既有測試沒有涵蓋 0 筆時的顯示',
    }],
  });
  assert(validatePlan(withReason).ok, '寫了理由就放行');
});

testCase('V7', 'new_test=false 但沒指名 existing_guard → 擋（證據沒有承接者）', () => {
  const p = evidencePlan();
  const orphan = evidencePlan({
    evidence_portfolio: [{ ...p.evidence_portfolio[0], existing_guard: null, new_test: false }],
  });
  assert(!validatePlan(orphan).ok && has(validatePlan(orphan).problems, 'existing_guard'), 'integration-test 型沒有 guard → 擋');

  const staticOk = evidencePlan({
    evidence_portfolio: [{
      ...p.evidence_portfolio[0], existing_guard: null, primary_evidence: 'static',
      evidence_layer: 'typecheck', new_test: false,
    }],
  });
  assert(validatePlan(staticOk).ok, 'static / smoke / manual 這類本來就不是「某個既有測試」的證據免填 guard');
});

testCase('V8', 'budget 缺一份就不准進 build', () => {
  const p = evidencePlan();
  const noProd = evidencePlan({ slices: [{ ...p.slices[0], production_change_budget: undefined }] });
  assert(!validatePlan(noProd).ok && has(validatePlan(noProd).problems, 'production_change_budget'), '缺 production budget → 擋');

  const noTest = evidencePlan({ slices: [{ ...p.slices[0], test_change_budget: undefined }] });
  assert(!validatePlan(noTest).ok && has(validatePlan(noTest).problems, 'test_change_budget'), '缺 test budget → 擋');

  const bad = evidencePlan({ slices: [{ ...p.slices[0], test_change_budget: { files: -1, lines: 60 } }] });
  assert(!validatePlan(bad).ok, '負數 budget → 擋');

  const zero = evidencePlan({ slices: [{ ...p.slices[0], test_change_budget: { files: 0, lines: 0 } }] });
  assert(validatePlan(zero).ok, '0 是合法 budget（這個 slice 明說不新增測試）');
});

testCase('V9', '每個 planned changed file 恰屬於一個 slice', () => {
  const dup = evidencePlan({
    behaviors: [
      { id: 'B1', statement: '行為一', risk: 'low', risk_triggers: [] },
      { id: 'B2', statement: '行為二', risk: 'low', risk_triggers: [] },
    ],
    slices: [
      { id: 'S1', title: '切片一', behaviors: ['B1'], verification: 'a', deps: [], files: ['src/a.ts'], ...budget() },
      { id: 'S2', title: '切片二', behaviors: ['B2'], verification: 'b', deps: [], files: ['src/a.ts'], ...budget() },
    ],
    evidence_portfolio: [
      { behavior_id: 'B1', primary_evidence: 'static', evidence_layer: 'typecheck', new_test: false, existing_guard: null, distinct_risk: null },
      { behavior_id: 'B2', primary_evidence: 'static', evidence_layer: 'typecheck', new_test: false, existing_guard: null, distinct_risk: null },
    ],
  });
  const r = validatePlan(dup);
  assert(!r.ok && has(r.problems, '只能屬於一個 slice'), '同一檔出現在兩個 slice → 擋');
});

testCase('V10', 'slice ↔ behavior 雙向認領', () => {
  const p = evidencePlan();
  const dangling = evidencePlan({ slices: [{ ...p.slices[0], behaviors: ['B9'] }] });
  assert(!validatePlan(dangling).ok && has(validatePlan(dangling).problems, '不存在的 B9'), 'slice 指向不存在的 behavior → 擋');

  const unclaimed = evidencePlan({
    behaviors: [
      { id: 'B1', statement: '行為一', risk: 'low', risk_triggers: [] },
      { id: 'B2', statement: '沒人做的行為', risk: 'low', risk_triggers: [] },
    ],
    evidence_portfolio: [
      p.evidence_portfolio[0],
      { behavior_id: 'B2', primary_evidence: 'static', evidence_layer: 'typecheck', new_test: false, existing_guard: null, distinct_risk: null },
    ],
  });
  assert(!validatePlan(unclaimed).ok && has(validatePlan(unclaimed).problems, '沒有任何 slice 認領'), '承諾了行為卻沒 slice 做 → 擋');
});

testCase('V11', 'behaviors 的形狀與 risk_triggers ↔ risk 自洽', () => {
  const lowButTriggered = evidencePlan({
    behaviors: [{ id: 'B1', statement: '行為', risk: 'low', risk_triggers: ['concurrency'] }],
  });
  const r = validatePlan(lowButTriggered);
  assert(!r.ok && has(r.problems, '至少要 medium'), 'risk_triggers 非空卻標 low → 擋');

  const badRisk = evidencePlan({ behaviors: [{ id: 'B1', statement: '行為', risk: 'huge', risk_triggers: [] }] });
  assert(!validatePlan(badRisk).ok, 'risk 值域外 → 擋');
});

testCase('V12', 'legacy tasks 形仍可用，但不能用它繞過 evidence 規則', () => {
  const r = validatePlan(legacyPlan());
  assert(r.ok && r.mode === 'legacy', 'legacy 形（無 behaviors）通過且標 legacy');
  assert(summarize(legacyPlan(), 'legacy').includes('legacy 形'), 'legacy 摘要標示形別');

  const sneaky = legacyPlan({
    evidence_portfolio: [{ behavior_id: 'B1', primary_evidence: 'static', evidence_layer: 'x', new_test: false, distinct_risk: null }],
  });
  assert(!validatePlan(sneaky).ok, '有 evidence_portfolio 卻沒 behaviors → 擋');

  const emptyBehaviors = validatePlan({ behaviors: [], slices: [{ id: 'S1', title: 't', verification: 'v' }] });
  assert(!emptyBehaviors.ok, '空的 behaviors 陣列 → 擋（要嘛宣告行為、要嘛用 legacy 形）');
});

testCase('V13', 'slice 的可驗證性（沿用舊閘）：id 唯一 / title 無 and / verification 可執行 / deps 無環', () => {
  const p = evidencePlan();
  const noVerify = evidencePlan({ slices: [{ ...p.slices[0], verification: '   ' }] });
  assert(!validatePlan(noVerify).ok && has(validatePlan(noVerify).problems, 'verification'), '空 verification → 擋');

  const andTitle = evidencePlan({ slices: [{ ...p.slices[0], title: 'do A and B' }] });
  assert(!validatePlan(andTitle).ok && has(validatePlan(andTitle).problems, '" and "'), 'title 含 and → 該再拆');

  const cyclic = validatePlan({
    tasks: [
      { id: 'T1', title: 'a', verification: 'x', deps: ['T2'] },
      { id: 'T2', title: 'b', verification: 'y', deps: ['T1'] },
    ],
  });
  assert(!cyclic.ok && has(cyclic.problems, '依賴成環'), '依賴成環 → 擋');
});

testCase('V14', '舊耦合已移除：acceptance 超過 3 條不再是錯誤', () => {
  const many = evidencePlan();
  many.slices[0].acceptance = ['一', '二', '三', '四', '五'];
  const r = validatePlan(many);
  assert(r.ok, `acceptance 5 條仍通過（舊「≤3 條」硬限制已隨 evidence portfolio 移除；實際問題：${r.problems.join(' / ')}）`);

  const legacyMany = validatePlan(legacyPlan({
    tasks: [{ id: 'T1', title: 't', verification: 'v', deps: [], files: [], acceptance: ['1', '2', '3', '4'] }],
  }));
  assert(legacyMany.ok, 'legacy 形同樣不再受 ≤3 限制');
});

testCase('V15', 'slices 與 tasks 不得並存（避免兩份真相）', () => {
  const both = evidencePlan({ tasks: [{ id: 'T1', title: 't', verification: 'v' }] });
  assert(!validatePlan(both).ok && has(validatePlan(both).problems, '兩個鍵'), 'slices + tasks 同時存在 → 擋');
});

// ══════════════════════════════════════════════════════════════════════════
const opts = parseArgs(process.argv.slice(2));
const selected = cases.filter((c) => c.id === opts.filter || c.id.startsWith(opts.filter));
for (const c of selected) { console.log(`\n[${c.id}] ${c.name}`); c.fn(); }
console.log(`\n${selected.length} cases run, ${passed} passed, ${failed.length} failed`);
if (opts.minCases > 0 && selected.length < opts.minCases) {
  console.error(`\n✗ case 數地板未達成：--min-cases ${opts.minCases}，實際 ${selected.length}`);
  process.exit(1);
}
if (failed.length) { console.error('\n失敗清單：'); for (const m of failed) console.error(`  - ${m}`); process.exit(1); }
process.exit(0);
