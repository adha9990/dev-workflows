#!/usr/bin/env node
// test-policy-change.mjs —— 規則變更閉環機械層的斷言（#175）。
// 對應驗收標準：duplicate／extension／scoped conflict／true contradiction／unknown 各有 fixture 與
// expected action；真衝突只問一個問題、未回答前不建 issue；doc-only policy PR 被擋；
// optimizer 不得改 policy registry／hard hooks／approval contract／eval oracle。
// 用法：node test-policy-change.mjs [--filter <case-prefix>] [--min-cases <n>]

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARCH_LAYERS, LAYER_DESCRIPTIONS, CHANGE_VERDICTS, VERDICT_ACTION, PROPOSAL_SECTIONS,
  REQUIRED_TOUCH_BY_TIER, OPTIMIZER_PROTECTED,
  normalizeRequirement, analyzeProposal, validateProposal, renderProposalIssue,
  touchedFacets, gateChangeSet, gateOptimizerChange, loadPolicyRegistry,
} from './policy-change.mjs';
import { POLICY_TIERS } from './policy-runtime.mjs';

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

// ── fixture：一條既有規則，以及五種相對於它的 proposal ────────────────────
const EXISTING = {
  id: 'existing-rule', title: '既有規則',
  scope: { kind: 'path-based', paths: ['docs/**'], activities: [], stages: [] },
  enforcement: 'forbid', tier: 'workflow-invariant', runtime: { guard: 'skill-lint', protected_actions: ['edit-docs'] },
  evaluator: null, overridable: false, approval: { required: false, by: null }, precedence: null,
  fail_closed_on_missing_state: true,
  requires: ['docs 改動要同步 README'], forbids: ['留下沒同步的文件'], conflicts_with: [],
  projection: ['AGENTS.md'], projection_marker: null, tests: [], docs: [],
};
const registry = { schema_version: '1', policies: [EXISTING] };

const proposalOf = (over = {}) => ({
  id: 'new-rule', title: '新規則',
  scope: { kind: 'path-based', paths: ['docs/**'], activities: [], stages: [] },
  enforcement: 'forbid', tier: 'workflow-invariant', precedence: null,
  requires: [], forbids: [], ...over,
});

const fullProposal = (over = {}) => ({
  ...proposalOf(),
  layer: 'loop',
  problem: '文件改了但 README 沒跟著改，讀的人會被舊敘述誤導',
  purpose: '讓文件與 README 一起維持一致',
  related: '見分析',
  impact: ['stage: iterate', 'file: README.md'],
  enforcement: '由 skill-lint 的 drift 檢查擋下',
  human_docs: ['AGENTS.md 規則段'],
  affected_sources: ['skill-lint'],
  acceptance: ['改文件沒同步 README → skill-lint 紅'],
  ...over,
});

// ══════════════════════════════════════════════════════════════════════════
testCase('C1', '五層與六種判定的值域固定，且每種判定只有一個建議動作', () => {
  assert(ARCH_LAYERS.join(',') === 'harness,graph,loop,context,prompt', '五層＝#168 的架構邊界');
  assert(ARCH_LAYERS.every((l) => LAYER_DESCRIPTIONS[l]), '每層都有一句話說明');
  assert(CHANGE_VERDICTS.length === 6, '六種判定');
  for (const v of CHANGE_VERDICTS) assert(typeof VERDICT_ACTION[v] === 'string', `${v} 有唯一的建議動作（不給「看情況」）`);
  assert(PROPOSAL_SECTIONS.length === 9, 'proposal issue 九個固定區塊');
  assert(POLICY_TIERS.every((t) => Array.isArray(REQUIRED_TOUCH_BY_TIER[t])), '每個 tier 都定義了「完整變更該動到哪幾面」');
});

testCase('C2', 'duplicate：scope 與要求都相同 → 改既有那條', () => {
  const a = analyzeProposal(proposalOf({ requires: ['docs 改動要同步 README'], forbids: ['留下沒同步的文件'] }), registry);
  assert(a.verdict === 'duplicate' && a.action === 'reuse-or-edit-existing', '判定 duplicate → reuse-or-edit-existing');
  assert(a.related.some((r) => r.id === 'existing-rule'), '指名撞到哪一條');
  assert(a.question === null, 'duplicate 不需要問人');
  assert(normalizeRequirement('docs 改動要同步 README') === normalizeRequirement('docs改動、要同步 README。'), '要求比對前先正規化（標點/空白不影響判定）');
});

testCase('C3', 'compatible-extension：scope 有交集但要求不互斥 → 擴充既有那條', () => {
  const a = analyzeProposal(proposalOf({ requires: ['docs 改動要附截圖'] }), registry);
  assert(a.verdict === 'compatible-extension' && a.action === 'modify-existing', '判定 compatible-extension → modify-existing');
  assert(a.reason.includes('existing-rule'), '理由指名既有規則');
  assert(a.question === null, '相容擴充不需要問人');
});

testCase('C4', 'scoped-difference：要求互斥但可由 forbid-wins／precedence 排序 → 各自寫明適用條件', () => {
  // 嚴格度不同（forbid vs warn）⇒ 自動取嚴，屬「兩條各有適用範圍」而非真衝突
  const a = analyzeProposal(proposalOf({ enforcement: 'warn', forbids: ['docs 改動要同步 README'] }), registry);
  assert(a.verdict === 'scoped-difference' && a.action === 'add-explicit-condition', '判定 scoped-difference → add-explicit-condition');
  assert(a.reason.includes('適用條件'), '理由講明要各自寫清楚適用條件（別留給讀者推理）');
  assert(a.question === null, '排得出順序就不必問人');
});

testCase('C5', 'true-contradiction：只問一個問題，且未回答前不得建 issue', () => {
  const a = analyzeProposal(proposalOf({ enforcement: 'forbid', forbids: ['docs 改動要同步 README'] }), registry);
  assert(a.verdict === 'true-contradiction' && a.action === 'ask-user-one-question', '判定 true-contradiction → ask-user-one-question');
  assert(typeof a.question === 'string' && a.question.length > 0, '有一個要問人的問題');
  assert(!a.question.includes('？') || a.question.split('？').length - 1 === 1, '只問一題（不是三題一起丟）');
  assert(a.question.includes('existing-rule') && a.question.includes('new-rule'), '問句指名是哪兩條在打架');
  assert(a.reason.includes('不得建 issue'), '明講未拍板前不建 issue、不寫規則');
});

testCase('C6', 'unknown：scope 解析不出來就停下，不猜 precedence', () => {
  for (const bad of [undefined, null, {}, { paths: ['x'] }]) {
    const a = analyzeProposal({ id: 'x', scope: bad }, registry);
    assert(a.verdict === 'unknown' && a.action === 'stop-do-not-guess', `scope=${JSON.stringify(bad)} → unknown → stop-do-not-guess`);
  }
  assert(analyzeProposal(null, registry).verdict === 'unknown', 'proposal 為 null → unknown');
  assert(analyzeProposal({ id: 'x', scope: { paths: [] } }, registry).reason.includes('不要猜'), '理由明講不要猜 precedence');
  // 反向：scope 解析得出來就不該落到 unknown（殺掉「凡事都回 unknown」的實作）
  assert(analyzeProposal(proposalOf({ requires: ['新要求'] }), registry).verdict !== 'unknown', 'scope 解析得出來 → 不落 unknown');
});

testCase('C7', 'novel：scope 無交集 → 開新規則', () => {
  const a = analyzeProposal(proposalOf({ scope: { kind: 'path-based', paths: ['src/**'], activities: [], stages: [] }, requires: ['src 改動要有測試'] }), registry);
  assert(a.verdict === 'novel' && a.action === 'create-new', '判定 novel → create-new');
  assert(a.related.length === 0, '沒有相關規則');
  assert(analyzeProposal(proposalOf({ id: 'existing-rule' }), registry).verdict === 'novel', '同 id 視為「編輯這一條」，不跟自己比');
});

testCase('C8', 'proposal 九個區塊缺一不可', () => {
  assert(validateProposal(fullProposal()).ok, '完整 proposal 通過');
  for (const s of PROPOSAL_SECTIONS) {
    if (s === 'layer') continue;
    const broken = fullProposal();
    delete broken[s];
    const v = validateProposal(broken);
    assert(!v.ok && v.errors.some((e) => e.includes(s)), `缺 ${s} → 不通過並指名`);
  }
  assert(!validateProposal(fullProposal({ layer: '第六層' })).ok, '層歸不出來 → 不通過（通常代表這其實是兩條規則）');
  assert(!validateProposal(fullProposal({ tier: 'nope' })).ok, 'tier 不合法 → 不通過');
  assert(!validateProposal(fullProposal({ impact: [] })).ok, '區塊是空陣列也算空');
});

testCase('C9', 'renderProposalIssue：九個區塊都渲染，且帶上分析判定', () => {
  const p = fullProposal();
  const a = analyzeProposal(p, registry);
  const md = renderProposalIssue(p, a);
  for (const title of ['問題（現在會出什麼包）', '這條規則要達成什麼', '相關 / 衝突的既有規則', '五層歸屬', '影響到的 stages', '執行層級', '人要讀的文件', '受影響的來源', '驗收與回歸']) {
    assert(md.includes(title), `區塊「${title}」有渲染`);
  }
  assert(md.includes(`**${a.verdict}**`) && md.includes(a.action), '把分析判定與建議動作寫進 issue（reviewer 看得到依據）');
  assert(md.includes('`loop`') && md.includes(LAYER_DESCRIPTIONS.loop), '五層歸屬帶那一層的說明');
});

testCase('C10', 'doc-only 的 policy PR 一律擋，且指名少了哪幾面', () => {
  const docOnly = ['AGENTS.md'];
  for (const tier of POLICY_TIERS) {
    const g = gateChangeSet(docOnly, { tier });
    assert(!g.ok, `tier=${tier}：只改 AGENTS.md → 擋`);
    assert(g.missing.includes('registry'), `tier=${tier}：指出少了 registry`);
    assert(g.reason.includes('registry'), `tier=${tier}：理由講人話`);
  }
  const hardComplete = ['AGENTS.md', 'plugins/loops-workflow/references/policy-registry.json', 'plugins/loops-workflow/hooks/merge-guard.mjs', 'plugins/loops-workflow/hooks/test-merge-guard.mjs'];
  assert(gateChangeSet(hardComplete, { tier: 'hard-invariant' }).ok, '反向：hard 規則四面俱到 → 放行（殺掉「恆擋」的實作）');
  const hardNoHook = hardComplete.filter((f) => !/hooks\/merge-guard/.test(f));
  const g2 = gateChangeSet(hardNoHook, { tier: 'hard-invariant' });
  assert(!g2.ok && g2.missing.includes('hook'), 'hard 規則沒動 hook → 擋（只是宣稱、擋不住）');
  assert(gateChangeSet(['plugins/loops-workflow/references/policy-registry.json', 'AGENTS.md', 'plugins/loops-workflow/evals/build/b1-add.json'], { tier: 'semantic' }).ok, 'semantic 規則要動到 evals');
  assert(gateChangeSet(['plugins/loops-workflow/references/policy-registry.json', 'AGENTS.md', 'plugins/loops-workflow/skills/plan/SKILL.md'], { tier: 'advisory' }).ok, 'advisory 規則要動到 skills／agents');
  assert(!gateChangeSet(hardComplete, { tier: '亂寫' }).ok, 'tier 判不出來 → 擋（不知道誰執行就無從檢查完整性）');
  assert(gateChangeSet([], { tier: 'advisory' }).ok === false, '什麼都沒改 → 擋');
});

testCase('C11', 'touchedFacets：各面辨識正確、測試檔不被誤認成實作', () => {
  const t = touchedFacets([
    'AGENTS.md',
    'plugins/loops-workflow/references/policy-registry.json',
    'plugins/loops-workflow/hooks/pr-gate.mjs',
    'plugins/loops-workflow/hooks/test-pr-gate.mjs',
    'plugins/loops-workflow/evals/gold/explanation-quality.json',
    'plugins/loops-workflow/agents/x.md',
  ]);
  for (const f of ['registry', 'projection', 'hook', 'test', 'eval', 'prompt']) assert(t.has(f), `辨識得出 ${f}`);
  const onlyTest = touchedFacets(['plugins/loops-workflow/hooks/test-pr-gate.mjs']);
  assert(onlyTest.has('test') && !onlyTest.has('hook'), '只改測試不算改了 hook（否則「加個測試」就能過閘）');
  assert(touchedFacets(['plugins\\loops-workflow\\hooks\\pr-gate.mjs']).has('hook'), 'Windows 反斜線路徑也認得');
});

testCase('C12', 'optimizer 不得改規則本身與判定基準', () => {
  const cases = [
    ['plugins/loops-workflow/references/policy-registry.json', 'policy registry'],
    ['plugins/loops-workflow/hooks/merge-guard.mjs', 'hard hook'],
    ['plugins/loops-workflow/scripts/policy-runtime.mjs', 'approval contract'],
    ['plugins/loops-workflow/scripts/eval-oracle.mjs', 'eval oracle'],
    ['plugins/loops-workflow/evals/gold/explanation-quality.json', 'gold artifact'],
  ];
  for (const [file, what] of cases) {
    const g = gateOptimizerChange([file]);
    assert(!g.ok && g.violations.some((v) => v.file === file), `optimizer 改 ${what} → 擋`);
  }
  assert(gateOptimizerChange(['plugins/loops-workflow/skills/plan/SKILL.md']).ok, '反向：改 skill 正文可以（那正是 optimizer 該做的事）');
  assert(gateOptimizerChange(['plugins/loops-workflow/hooks/test-merge-guard.mjs']).ok, '反向：改 hook 的測試不在保護面（保護的是擋人的實作本身）');
  assert(gateOptimizerChange([]).ok, '沒改東西 → 放行');
  assert(OPTIMIZER_PROTECTED.every((p) => p.reason), '每條保護規則都寫了理由');
});

testCase('C13', '真 repo：既有 17 條規則兩兩之間沒有未拍板的真衝突流進 proposal 分析', () => {
  const real = loadPolicyRegistry(REPO_ROOT);
  assert(real && Array.isArray(real.policies) && real.policies.length > 0, '讀得到真 repo 的 policy registry');
  // 拿每一條既有規則當「proposal」去撞其餘規則：真衝突應為 0（否則 registry 本身就有未拍板的矛盾）
  const contradictions = [];
  for (const p of real.policies) {
    const a = analyzeProposal(p, { policies: real.policies.filter((x) => x.id !== p.id) });
    if (a.verdict === 'true-contradiction') contradictions.push({ id: p.id, question: a.question });
  }
  assert(contradictions.length === 0, `真 repo 沒有未拍板的真衝突（實際：${JSON.stringify(contradictions)}）`);
  const duplicates = real.policies.filter((p) => analyzeProposal(p, { policies: real.policies.filter((x) => x.id !== p.id) }).verdict === 'duplicate');
  assert(duplicates.length === 0, `真 repo 沒有完全重複的規則（實際：${duplicates.map((d) => d.id)}）`);
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
