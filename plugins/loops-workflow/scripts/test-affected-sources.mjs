#!/usr/bin/env node
// test-affected-sources.mjs —— 波及來源 mapping／reindex 批次策略／degraded 語意／敏感資料遮罩的斷言（#177）。
// 用法：node test-affected-sources.mjs [--filter <case-prefix>] [--min-cases <n>]

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SOURCE_KINDS, CHANGE_KINDS, REINDEX_TRIGGERS, EVALUATOR_STATUSES,
  classifyChange, affectedSources, shouldReindex, evaluatorStatus,
  checkNoHardInvariantDelegation, redactEvidence, hasSensitiveResidue,
} from './affected-sources.mjs';
import { compilePolicyRuntime, loadRegistry } from './policy-runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

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

// ══════════════════════════════════════════════════════════════════════════
testCase('A1', 'classifyChange：各類改動辨識正確，測試檔不被誤認成 hook', () => {
  assert(classifyChange(`${P}hooks/pr-gate.mjs`) === 'hook', 'hook');
  assert(classifyChange(`${P}hooks/test-pr-gate.mjs`) === 'test', 'hook 的測試是 test，不是 hook（否則改個測試就會觸發整套遵循度重測）');
  assert(classifyChange(`${P}references/policy-registry.json`) === 'policy', 'policy registry');
  assert(classifyChange(`${P}skills/plan/SKILL.md`) === 'skill', 'skill');
  assert(classifyChange(`${P}agents/verify/x.md`) === 'agent', 'agent');
  assert(classifyChange(`${P}evals/build/b1.json`) === 'eval', 'eval');
  assert(classifyChange('AGENTS.md') === 'docs', '根目錄文件');
  assert(classifyChange('src/app.ts') === 'code', 'code');
  assert(classifyChange('assets/logo.png') === 'other', '其他');
  assert(classifyChange(`${P}hooks\\pr-gate.mjs`) === 'hook', 'Windows 反斜線路徑也認得');
  assert(CHANGE_KINDS.length === 9, '改動類別值域固定');
});

testCase('A2', 'mapping：code → graph；skill/agent → trajectory；policy/hook → adherence', () => {
  const code = affectedSources(['src/a.ts']);
  assert(code.sources.has('code-graph') && code.sources.size === 1, 'code 改動只波及 code graph');

  const skill = affectedSources([`${P}skills/plan/SKILL.md`]);
  assert(skill.sources.has('eval-route') && skill.sources.has('eval-trajectory'), 'skill → 路由與 trajectory 兩套');
  assert(!skill.sources.has('code-graph'), 'skill 正文不是 code，不必重建圖');

  const agent = affectedSources([`${P}agents/verify/x.md`]);
  assert(agent.sources.has('eval-trajectory') && !agent.sources.has('eval-route'), 'agent → 只影響 trajectory');

  const policy = affectedSources([`${P}references/policy-registry.json`]);
  assert(policy.sources.has('eval-adherence'), 'policy → 遵循度');

  const hook = affectedSources([`${P}hooks/pr-gate.mjs`]);
  assert(hook.sources.has('eval-adherence') && hook.sources.has('code-graph'), 'hook 同時是規則執行者與 code');

  assert(SOURCE_KINDS.includes('prompt-optimization'), '來源種類含 prompt optimization');
});

testCase('A3', '純文件改動不觸發 prompt optimization', () => {
  const docs = affectedSources(['AGENTS.md', `${P}docs/FLOW.md`]);
  assert(docs.onlyDocs === true, '判定為純文件改動');
  assert(!docs.sources.has('prompt-optimization'), '不觸發 prompt optimization');
  assert(docs.sources.size === 0, '純文件不波及任何來源');
  assert(docs.reasons.some((r) => r.reason.includes('燒錢')), '理由講明為什麼不跑');

  const mixed = affectedSources(['AGENTS.md', `${P}skills/plan/SKILL.md`]);
  assert(mixed.onlyDocs === false, '反向：混了 skill 改動就不是純文件（殺掉「有 md 就當純文件」的實作）');
  assert(mixed.sources.has('eval-route'), '混合改動照常波及');
  assert(affectedSources([]).onlyDocs === false, '空清單不算純文件改動');
});

testCase('A4', 'reindex 只在穩定批次邊界，不在每次 file edit', () => {
  assert(!REINDEX_TRIGGERS.includes('file-edit'), 'file-edit 不在允許的重建時機內（這正是要避免的形狀）');
  const r = shouldReindex({ trigger: 'file-edit', files: ['src/a.ts'] });
  assert(!r.ok && r.reason.includes('file edit'), 'file-edit → 不重建，理由講明為什麼');
  for (const t of REINDEX_TRIGGERS) {
    assert(shouldReindex({ trigger: t, files: ['src/a.ts'] }).ok, `${t} + 有 code 改動 → 重建`);
  }
  const noCode = shouldReindex({ trigger: 'stage-exit', files: ['AGENTS.md'] });
  assert(!noCode.ok && noCode.reason.includes('沒有 code'), '批次邊界但沒有 code 改動 → 不重建（圖不會因此變舊）');
  assert(!shouldReindex({ trigger: 'stage-exit', files: [] }).ok, '空批次 → 不重建');
});

testCase('A5', '語意評測：評不到一律 degraded／not-measured，絕不是 passed', () => {
  assert(EVALUATOR_STATUSES.join(',') === 'passed,failed,degraded,not-measured', '狀態值域固定');
  assert(evaluatorStatus({ planned: false }).status === 'not-measured', '本輪沒安排 → not-measured');
  assert(evaluatorStatus({ available: false }).status === 'degraded', '評測器不可用 → degraded');
  assert(evaluatorStatus({ available: true, ran: false }).status === 'degraded', '可用但沒跑 → degraded');
  assert(evaluatorStatus({ available: true, ran: true, result: null }).status === 'degraded', '跑了但沒結論 → degraded');
  assert(evaluatorStatus({ available: true, ran: true, result: 'passed' }).status === 'passed', '真的跑過且過了 → passed');
  assert(evaluatorStatus({ available: true, ran: true, result: 'failed' }).status === 'failed', '真的跑過但沒過 → failed');
  for (const bad of [{ available: false }, { available: true, ran: false }, { planned: false }]) {
    assert(evaluatorStatus(bad).status !== 'passed', `${JSON.stringify(bad)} → 絕不是 passed`);
  }
  assert(evaluatorStatus({ available: false }).reason.includes('不得寫成 passed'), '理由明講不得寫成 passed');
});

testCase('A6', 'hard invariant 不交給 LLM grader', () => {
  const registry = loadRegistry(REPO_ROOT);
  const { rules } = compilePolicyRuntime(registry);
  const hardRule = [...rules.values()].find((r) => r.mechanism === 'pre-tool-deny');
  const semanticRule = [...rules.values()].find((r) => r.mechanism === 'eval');
  assert(hardRule && semanticRule, '真 registry 同時有 hard 與 semantic 規則（本 case 的前提）');

  const bad = checkNoHardInvariantDelegation({ rules: [hardRule.id] }, rules);
  assert(bad.length === 1 && bad[0].check === 'hard-invariant-delegated', `評測套件宣告要判 hard 規則 "${hardRule.id}" → 紅`);
  assert(bad[0].detail.includes(hardRule.guard), '理由指名它本來由誰機械判定');

  const ok = checkNoHardInvariantDelegation({ rules: [semanticRule.id] }, rules);
  assert(ok.length === 0, `反向：semantic 規則 "${semanticRule.id}" 本來就走 eval → 不紅（殺掉「凡是規則都不准評」的實作）`);
  assert(checkNoHardInvariantDelegation({ rules: ['不存在的規則'] }, rules).length === 0, '未登記的規則不在此檢查範圍');
});

testCase('A7', 'redactEvidence：絕對路徑與憑證都洗掉，且誠實列出遮了什麼', () => {
  const root = 'C:/Users/someone/repo';
  const raw = [
    `錯誤發生在 ${root}/src/app.ts:42`,
    'export API_KEY=sk-abcdefghijklmnopqrstuvwx',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123',
    'token gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    '聯絡 someone@example.com',
    '/home/other/project/x.mjs',
  ].join('\n');
  const { text, redactions } = redactEvidence(raw, { repoRoot: root });
  assert(text.includes('<repo>/src/app.ts:42'), 'repo 路徑收斂成 <repo>（file:line 仍保留，證據不因遮罩而失效）');
  assert(!text.includes('sk-abcdefghijklmnopqrstuvwx'), 'api key 被遮');
  assert(!text.includes('abcdefghijklmnopqrstuvwxyz123'), 'bearer token 被遮');
  assert(!text.includes('gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), 'forge token 被遮');
  assert(!text.includes('someone@example.com'), 'email 被遮');
  assert(!text.includes('/home/other'), '別人的家目錄也收斂');
  assert(redactions.length >= 4 && redactions.every((r) => r.label && r.count > 0), '逐項列出遮了什麼型別幾次（不是靜默改寫）');
  assert(!hasSensitiveResidue(text), '洗完之後沒有殘留');
  assert(hasSensitiveResidue(raw), '反向：原文確實有殘留（殺掉「恆回 false」的實作）');
  assert(redactEvidence('乾淨的文字', { repoRoot: root }).redactions.length === 0, '本來就乾淨 → 不遮、不誤報');
});

testCase('A8', '真 repo：evidence 遮罩用在真實路徑上不會把 file:line 洗掉', () => {
  const sample = `${REPO_ROOT}/plugins/loops-workflow/scripts/affected-sources.mjs:12 有問題`;
  const { text } = redactEvidence(sample, { repoRoot: REPO_ROOT });
  assert(text.includes('plugins/loops-workflow/scripts/affected-sources.mjs:12'), 'repo 相對路徑與行號保留（Metric-Honesty 需要的證據不能被遮掉）');
  assert(!text.includes(REPO_ROOT.split('\\').join('/')), '機器上的絕對前綴不見了');
  assert(!hasSensitiveResidue(text), '遮完沒有殘留');
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
