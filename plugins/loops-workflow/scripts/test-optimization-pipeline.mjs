#!/usr/bin/env node
// test-optimization-pipeline.mjs —— affected-source optimization pipeline 的斷言（#179）。
// 對應驗收標準：resolver（changed files → components → triggers → dedup/order）有測試；
// optimization_run_id 擋遞迴；docs-only／hook-only／shared-ref 等 edge case 只跑對應來源；
// candidate 有隔離 diff、證據與 accept/reject 理由；未跑來源標 not measured。
// 用法：node test-optimization-pipeline.mjs [--filter <case-prefix>] [--min-cases <n>]

import {
  ACTION_ORDER, ACTION_LABELS, TRIGGER_MAP, NOT_MEASURED,
  resolveActions, guardRecursion, runPlan, reviewCandidate, renderCandidateReview, reportCoverage,
} from './optimization-pipeline.mjs';

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

const P = 'plugins/loops-workflow/';
const CAND = '.loops/.candidates/';
const fullBaseline = { hardInvariantAdherence: 1.0, heldOutSuccess: 0.8, heldOutAdherence: 0.95 };
const fullMetrics = { ...fullBaseline };

// ══════════════════════════════════════════════════════════════════════════
testCase('O1', '執行順序：便宜且確定的先跑，貴且有雜訊的最後', () => {
  assert(ACTION_ORDER[0] === 'compiler-schema' && ACTION_ORDER[1] === 'deterministic-tests', 'compiler／schema 與確定性測試排最前（紅了就不必花錢跑後面）');
  assert(ACTION_ORDER[ACTION_ORDER.length - 1] === 'token-benchmark', 'token benchmark 排最後');
  assert(ACTION_ORDER.indexOf('skill-candidate') < ACTION_ORDER.indexOf('prompt-eval'), '先產候選、再評測它');
  assert(ACTION_ORDER.indexOf('prompt-eval') < ACTION_ORDER.indexOf('token-benchmark'), '先看品質、再比成本');
  assert(ACTION_ORDER.every((a) => ACTION_LABELS[a]), '每個 action 都有一句話說明');
});

testCase('O2', 'resolver：各類改動對應到正確的 action，且輸出依固定順序', () => {
  const skill = resolveActions([`${P}skills/plan/SKILL.md`]);
  assert(skill.actions.join(',') === 'skill-candidate,prompt-eval,token-benchmark', 'skill → 候選＋評測＋benchmark，且依序');
  const agent = resolveActions([`${P}agents/verify/x.md`]);
  assert(!agent.actions.includes('skill-candidate'), 'agent 不產 skill 候選');
  assert(agent.actions.includes('prompt-eval'), 'agent → 評測');
  const code = resolveActions(['src/a.ts']);
  assert(code.actions.includes('code-graph-refresh') && code.actions.includes('symbol-consistency'), 'code → 重建圖＋符號一致性');
  const policy = resolveActions([`${P}references/policy-registry.json`]);
  assert(policy.actions[0] === 'compiler-schema', 'policy → 先 compiler');
  assert(Object.keys(TRIGGER_MAP).length === 9, 'trigger map 覆蓋九類改動');
});

testCase('O3', 'edge case：docs-only 只跑文件檢查、不跑 prompt optimization', () => {
  const docs = resolveActions(['README.md', `${P}docs/FLOW.md`]);
  assert(docs.actions.join(',') === 'docs-devex-checks', 'docs-only → 只有文件檢查');
  assert(!docs.actions.includes('skill-candidate') && !docs.actions.includes('token-benchmark'), '不跑 skill 候選、不跑 benchmark');
  const mixed = resolveActions(['README.md', `${P}skills/plan/SKILL.md`]);
  assert(mixed.actions.includes('docs-devex-checks') && mixed.actions.includes('skill-candidate'), '反向：混了 skill 改動就兩邊都跑（殺掉「有 md 就當 docs-only」的實作）');
});

testCase('O4', 'edge case：hook-only 跑 compiler＋確定性測試＋評測＋重建圖', () => {
  const hook = resolveActions([`${P}hooks/pr-gate.mjs`]);
  assert(hook.actions.includes('compiler-schema') && hook.actions.includes('deterministic-tests'), 'hook → compiler＋確定性測試');
  assert(hook.actions.includes('prompt-eval'), 'hook 是規則執行者 → 遵循度重測');
  assert(hook.actions.includes('code-graph-refresh'), 'hook 也是 code → 圖要跟上');
  assert(!hook.actions.includes('skill-candidate'), 'hook 不產 skill 候選');
  const testOnly = resolveActions([`${P}hooks/test-pr-gate.mjs`]);
  assert(testOnly.actions.join(',') === 'deterministic-tests', '只改測試 → 只跑確定性測試（不觸發整套遵循度重測）');
});

testCase('O5', 'edge case：shared reference 沿依賴圖把 consumer 拉進來', () => {
  const shared = `${P}references/shared/quality/clean-code.md`;
  const consumers = { [shared]: [`${P}skills/build/SKILL.md`, `${P}agents/verify/code-quality-reviewer.md`] };
  const withGraph = resolveActions([shared], { consumersOf: (f) => consumers[f] ?? [] });
  assert(withGraph.actions.includes('skill-candidate'), '沿圖找到的 skill consumer 觸發候選');
  assert(withGraph.actions.includes('prompt-eval'), 'consumer 要重測');
  const withoutGraph = resolveActions([shared]);
  assert(withoutGraph.actions.includes('prompt-eval') && !withoutGraph.actions.includes('skill-candidate'), '沒有依賴圖時只做路徑觸發的最小集（不亂猜 consumer）');
  const cyclic = resolveActions([shared], { consumersOf: () => [shared] });
  assert(cyclic.actions.length > 0, '依賴圖有環也不會無限展開');
});

testCase('O6', 'resolver：同一個 action 被多個檔觸發時只出現一次，理由累積', () => {
  const r = resolveActions([`${P}skills/plan/SKILL.md`, `${P}skills/build/SKILL.md`]);
  assert(r.actions.filter((a) => a === 'skill-candidate').length === 1, '去重');
  assert(r.plan.find((s) => s.action === 'skill-candidate').reasons.length === 2, '理由累積兩個來源（可回答「為什麼要跑這個」）');
  assert(resolveActions([]).actions.length === 0, '空清單 → 什麼都不跑');
  assert(resolveActions(['assets/logo.png']).actions.length === 0, '無關檔案 → 什麼都不跑');
});

testCase('O7', 'components port：把「哪個檔屬於哪個元件」的知識留在 registry', () => {
  const r = resolveActions([`${P}skills/plan/SKILL.md`], { componentsOf: (f) => (f.includes('skills/plan') ? ['plan-skill'] : []) });
  assert(r.components.join(',') === 'plan-skill', '元件由 port 解出來');
  assert(resolveActions([`${P}skills/plan/SKILL.md`]).components.length === 0, '沒注入 port → 不假造元件');
});

testCase('O8', 'optimization_run_id 擋遞迴：同一個 run 內每個來源最多跑一次', () => {
  let state = null;
  const first = guardRecursion(state, { runId: 'run-1', action: 'skill-candidate' });
  assert(first.ok && !first.skipped, '第一次跑得動');
  state = first.next;
  const again = guardRecursion(state, { runId: 'run-1', action: 'skill-candidate' });
  assert(!again.ok && again.skipped, '同一個 run 內第二次被擋');
  assert(again.reason.includes('無限迴圈'), '理由講明在防什麼');
  const other = guardRecursion(state, { runId: 'run-1', action: 'prompt-eval' });
  assert(other.ok, '同一個 run 內不同 action 照跑');
  const nextRun = guardRecursion(state, { runId: 'run-2', action: 'skill-candidate' });
  assert(nextRun.ok && nextRun.next.runId === 'run-2', '換一個 run 就重新開始（殺掉「永遠只能跑一次」的實作）');
});

testCase('O9', 'runPlan：optimizer 產出的改動再觸發時，本 run 內不會重跑', () => {
  const plan = resolveActions([`${P}skills/plan/SKILL.md`]).plan;
  const first = runPlan(plan, { runId: 'run-1' });
  assert(first.ran.join(',') === 'skill-candidate,prompt-eval,token-benchmark', '第一輪照序跑完');
  assert(first.skipped.length === 0, '第一輪沒有被跳過的');
  // 模擬：candidate 改了 skill 檔 → 又解析出同一批 action
  const second = runPlan(resolveActions([`${P}skills/plan/SKILL.md`]).plan, { runId: 'run-1', state: first.state });
  assert(second.ran.length === 0 && second.skipped.length === 3, '同一個 run 內再觸發 → 全部跳過（這就是遞迴保護）');
  const nextRun = runPlan(plan, { runId: 'run-2', state: first.state });
  assert(nextRun.ran.length === 3, '下一個 run 照跑');
});

testCase('O10', 'candidate：碰到規則本身或評分基準一律拒', () => {
  const protectedFiles = [
    `${P}references/policy-registry.json`,
    `${P}hooks/merge-guard.mjs`,
    `${P}scripts/policy-runtime.mjs`,
    `${P}scripts/eval-oracle.mjs`,
    `${P}evals/gold/explanation-quality.json`,
  ];
  for (const f of protectedFiles) {
    const r = reviewCandidate({ files: [f], metrics: fullMetrics }, { baseline: fullBaseline });
    assert(!r.accepted && r.reasons.some((x) => x.gate === 'write-scope'), `candidate 改 ${f.split('/').pop()} → 拒（write-scope）`);
  }
});

testCase('O11', 'candidate：只能寫進 candidate 目錄，不得覆寫正式 skill', () => {
  const direct = reviewCandidate({ files: [`${P}skills/plan/SKILL.md`], metrics: fullMetrics }, { baseline: fullBaseline });
  assert(!direct.accepted && direct.reasons.some((r) => r.gate === 'candidate-only'), '直接覆寫正式 skill → 拒');
  assert(direct.reasons.find((r) => r.gate === 'candidate-only').detail.includes('不得直接覆寫'), '理由講明');
  const isolated = reviewCandidate({ files: [`${CAND}plan/SKILL.md`], metrics: fullMetrics }, { baseline: fullBaseline });
  assert(isolated.accepted, '寫進 candidate 目錄 → 過（隔離 diff）');
});

testCase('O12', 'candidate：品質不得低於 baseline，沒量到也拒；品質關過了才比成本', () => {
  for (const dim of ['hardInvariantAdherence', 'heldOutSuccess', 'heldOutAdherence']) {
    const worse = reviewCandidate({ files: [`${CAND}x.md`], metrics: { ...fullMetrics, [dim]: fullBaseline[dim] - 0.1 } }, { baseline: fullBaseline });
    assert(!worse.accepted && worse.reasons.some((r) => r.gate === 'quality-floor'), `${dim} 低於 baseline → 拒`);
    assert(worse.costComparable === false, `${dim} 退步時不比較成本（省 token 不能拿品質換）`);
    const missing = { ...fullMetrics };
    delete missing[dim];
    const unmeasured = reviewCandidate({ files: [`${CAND}x.md`], metrics: missing }, { baseline: fullBaseline });
    assert(!unmeasured.accepted, `${dim} 沒量到 → 拒（沒量不等於沒退步）`);
    assert(unmeasured.quality.find((q) => q.dim === dim).verdict === NOT_MEASURED, `${dim} 如實標 ${NOT_MEASURED}`);
  }
  const better = reviewCandidate({ files: [`${CAND}x.md`], metrics: { ...fullMetrics, heldOutSuccess: 0.9 } }, { baseline: fullBaseline });
  assert(better.accepted && better.costComparable, '品質變好 → 接受，且可以開始比成本');
  const md = renderCandidateReview(better);
  assert(md.includes('accept') && md.includes('才比較 token'), '報告寫明判定與成本比較的前提');
  assert(renderCandidateReview(reviewCandidate({ files: [`${P}skills/plan/SKILL.md`], metrics: fullMetrics }, { baseline: fullBaseline })).includes('不比較成本'), '拒絕時明講不比成本');
});

testCase('O13', '未跑的來源標 not measured——「已安裝」不等於「已優化」', () => {
  const plan = resolveActions([`${P}skills/plan/SKILL.md`]).plan;
  const coverage = reportCoverage(plan, ['skill-candidate']);
  assert(coverage.find((c) => c.action === 'skill-candidate').status === 'ran', '跑過的標 ran');
  for (const a of ['prompt-eval', 'token-benchmark']) {
    assert(coverage.find((c) => c.action === a).status === NOT_MEASURED, `${a} 沒跑 → 標 ${NOT_MEASURED}`);
  }
  assert(reportCoverage(plan, []).every((c) => c.status === NOT_MEASURED), '一個都沒跑 → 全部 not measured');
  assert(reportCoverage(plan, plan.map((s) => s.action)).every((c) => c.status === 'ran'), '全跑過 → 全部 ran（殺掉「恆 not measured」的實作）');
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
