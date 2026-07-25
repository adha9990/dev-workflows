#!/usr/bin/env node
// test-policy-runtime.mjs —— 四級規則執行引擎的斷言（#173）。
// 對應驗收標準：四級可編譯且能反查來源、forbid-wins、missing/malformed state fail closed、
// approval token 的 scope/expiry/audit、non-overridable 無法被核准繞過、semantic 評不到標 degraded、
// 以及**每條 hard rule 共用的五種測試契約**（allow／direct deny／common bypass／scoped approval／malformed state）。
// 用法：node test-policy-runtime.mjs [--filter <case-prefix>] [--min-cases <n>]

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  POLICY_TIERS, TIER_MECHANISM, BLOCKING_TIERS, APPROVAL_FIELDS, HARD_RULE_CONTRACT_CASES, DENY_MARKER,
  compilePolicyRuntime, isDeclared, rulesForGuard,
  parseApprovals, isWellFormedApproval, approvalCoversTarget, selectApproval,
  decide, decideAll, evaluateSemantic, hardRuleContract,
  checkGuardCoverage, listHookFiles, loadRegistry, recordApproval, approvalAuditPath,
} from './policy-runtime.mjs';
import { readEvents } from './loop-ledger.mjs';

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
function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'policy-rt-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** 合成 registry 工廠：每個 case 只覆蓋自己要測壞的欄位。 */
function policy(over = {}) {
  return {
    id: 'demo-rule', title: '示範規則',
    scope: { kind: 'activity-based', paths: [], activities: ['demo-action'], stages: [] },
    enforcement: 'forbid', tier: 'hard-invariant',
    runtime: { guard: 'demo-guard', protected_actions: ['demo-action'] },
    evaluator: null, overridable: false,
    approval: { required: false, by: null }, precedence: null,
    fail_closed_on_missing_state: true,
    requires: [], forbids: [], conflicts_with: [],
    projection: [], projection_marker: null, tests: [], docs: [],
    ...over,
  };
}
const reg = (...policies) => ({ schema_version: '1', policies });
const compileOf = (...policies) => compilePolicyRuntime(reg(...policies));
const futureToken = (over = {}) => ({ rule: 'demo-rule', target: 'demo-target', expires_at: '2099-01-01T00:00:00Z', reason: '本次例外', issued_by: 'owner', ...over });

// ══════════════════════════════════════════════════════════════════════════
testCase('R1', '四級模型：tier 值域、機制對照、能擋的只有前兩級', () => {
  assert(POLICY_TIERS.join(',') === 'hard-invariant,workflow-invariant,semantic,advisory', '四級順序固定');
  assert(TIER_MECHANISM['hard-invariant'] === 'pre-tool-deny' && TIER_MECHANISM.semantic === 'eval', '每級對應的機制寫死');
  assert(BLOCKING_TIERS.length === 2 && !BLOCKING_TIERS.includes('semantic'), '只有前兩級擋得住動作');
  const c = compileOf(policy());
  assert(c.rules.get('demo-rule').mechanism === 'pre-tool-deny', '編譯出的規則帶機制（可反查來源）');
  assert(c.findings.length === 0, '合法規則編譯無 finding');
});

testCase('R2', '編譯把半殘的規則擋在門外（寧可少一條，也不要無來源的判定）', () => {
  const noTier = compileOf(policy({ tier: undefined }));
  assert(noTier.rules.size === 0 && noTier.findings[0].check === 'policy-tier', '沒有 tier → 不編譯、報 policy-tier');

  const noGuard = compileOf(policy({ runtime: null }));
  assert(noGuard.rules.size === 0 && noGuard.findings[0].check === 'policy-runtime-binding', 'tier 1 沒綁 guard → 不編譯（沒有執行者的 hard rule 是自欺）');

  const noActions = compileOf(policy({ runtime: { guard: 'demo-guard', protected_actions: [] } }));
  assert(noActions.rules.size === 0, 'tier 1 沒列保護動作 → 不編譯');

  const noEvaluator = compileOf(policy({ tier: 'semantic', runtime: null, evaluator: null }));
  assert(noEvaluator.rules.size === 0 && noEvaluator.findings[0].check === 'policy-evaluator', 'semantic 沒指名 evaluator → 不編譯');

  const dup = compileOf(policy(), policy());
  assert(dup.rules.size === 1 && dup.findings.some((f) => f.check === 'policy-runtime-shape'), 'id 重複 → 只留一條並報錯');

  const advisory = compileOf(policy({ tier: 'advisory', runtime: null, fail_closed_on_missing_state: false }));
  assert(advisory.rules.size === 1 && advisory.rules.get('demo-rule').guard === null, 'advisory 不需要 guard');
});

testCase('R3', '未登記的規則一律 deny（hook 只能執行 registry 宣告的規則）', () => {
  const c = compileOf(policy());
  assert(isDeclared(c, 'demo-rule') && !isDeclared(c, '沒登記的規則'), 'isDeclared 認得登記與未登記');
  const d = decide(c, { rule: '沒登記的規則', action: 'demo-action', violation: false });
  assert(d.outcome === 'deny' && d.code === 'undeclared-rule', '未登記 → deny（即使呼叫端說沒違反）');
  assert(rulesForGuard(c, 'demo-guard').length === 1 && rulesForGuard(c, '別的 guard').length === 0, 'rulesForGuard 反查得到某支 hook 憑什麼擋');
});

testCase('R4', 'tier 3/4 不在工具呼叫層擋，只回 advise（不假裝自己擋得住）', () => {
  const c = compileOf(policy({ tier: 'semantic', runtime: null, evaluator: 'promptfoo', enforcement: 'require', fail_closed_on_missing_state: false }));
  const d = decide(c, { rule: 'demo-rule', violation: true });
  assert(d.outcome === 'advise' && d.code === 'tier-semantic', 'semantic 級即使違反也只回 advise');
  const a = compileOf(policy({ tier: 'advisory', runtime: null, enforcement: 'require', fail_closed_on_missing_state: false }));
  assert(decide(a, { rule: 'demo-rule', violation: true }).outcome === 'advise', 'advisory 級同上');
});

testCase('R5', 'fail closed：protected action 的 state 缺失／壞掉一律擋', () => {
  const closed = compileOf(policy({ fail_closed_on_missing_state: true }));
  const d1 = decide(closed, { rule: 'demo-rule', action: 'demo-action', violation: true, stateAvailable: false });
  assert(d1.outcome === 'deny' && d1.code === 'missing-state', '標了 fail-closed → 讀不到狀態就擋');
  const d2 = decide(closed, { rule: 'demo-rule', action: 'demo-action', violation: false, stateAvailable: false });
  assert(d2.outcome === 'deny', '「讀不到狀態」時就算呼叫端說沒違反也擋——沒讀到就不知道有沒有違反');

  const open = compileOf(policy({ enforcement: 'warn', fail_closed_on_missing_state: false }));
  const d3 = decide(open, { rule: 'demo-rule', action: 'demo-action', violation: true, stateAvailable: false });
  assert(d3.outcome === 'allow' && d3.code === 'fail-open', '沒標 fail-closed 的規則維持家族既有 fail-open 慣例（刻意取捨、不是疏漏）');
});

testCase('R6', '保護動作以外的動作不受這條規則管', () => {
  const c = compileOf(policy());
  const d = decide(c, { rule: 'demo-rule', action: '別的動作', violation: true });
  assert(d.outcome === 'allow' && d.code === 'out-of-scope', '不在 protected_actions 內 → 這條規則不管');
  assert(decide(c, { rule: 'demo-rule', action: 'demo-action', violation: true }).outcome === 'deny', '在清單內才擋');
});

testCase('R7', 'approval token：欄位完整性、scope 涵蓋、到期', () => {
  assert(APPROVAL_FIELDS.join(',') === 'rule,target,expires_at,reason,issued_by', '必填欄位固定五個');
  assert(isWellFormedApproval(futureToken()), '完整 token 合格');
  for (const f of APPROVAL_FIELDS) {
    const broken = { ...futureToken() };
    delete broken[f];
    assert(!isWellFormedApproval(broken), `缺 ${f} → 不合格`);
  }
  assert(!isWellFormedApproval({ ...futureToken(), reason: '   ' }), '理由只有空白 → 不合格（沒有「懶得寫理由」的授權）');

  assert(approvalCoversTarget('a/b', 'a/b'), 'target 完全相等 → 涵蓋');
  assert(approvalCoversTarget('a/*', 'a/b/c'), '前綴形 `a/*` → 涵蓋 a/ 底下');
  assert(!approvalCoversTarget('a/*', 'ab/c'), '前綴比對卡在斜線邊界，不誤蓋兄弟目錄');
  assert(!approvalCoversTarget('*', 'anything'), '裸 `*` 不是涵蓋語法（不給萬用逃生口）');

  const now = Date.parse('2026-07-26T00:00:00Z');
  assert(selectApproval([futureToken()], { rule: 'demo-rule', target: 'demo-target', now }).token, '未過期且相符 → 挑得到');
  const expired = selectApproval([futureToken({ expires_at: '2020-01-01T00:00:00Z' })], { rule: 'demo-rule', target: 'demo-target', now });
  assert(!expired.token && expired.reason.includes('過期'), '過期 → 挑不到，理由指名過期');
  const wrongRule = selectApproval([futureToken({ rule: '別條規則' })], { rule: 'demo-rule', target: 'demo-target', now });
  assert(!wrongRule.token && wrongRule.reason.includes('別條規則'), '規則不符 → 挑不到，理由指名');
  const wrongTarget = selectApproval([futureToken({ target: '別的目標' })], { rule: 'demo-rule', target: 'demo-target', now });
  assert(!wrongTarget.token && wrongTarget.reason.includes('未涵蓋'), 'target 不涵蓋 → 挑不到');
  const badExpiry = selectApproval([futureToken({ expires_at: '不是日期' })], { rule: 'demo-rule', target: 'demo-target', now });
  assert(!badExpiry.token, 'expires_at 解析不了 → 不當成有效授權');
  assert(selectApproval([], { rule: 'demo-rule', target: 'x', now }).token === null, '沒有 token → 挑不到');
});

testCase('R8', 'parseApprovals：壞掉的授權檔一律當「沒有授權」（逃生口本身也 fail closed）', () => {
  assert(parseApprovals(null).length === 0, 'null → 空');
  assert(parseApprovals('{壞掉的 JSON').length === 0, '壞 JSON → 空（不是丟例外、也不是當成授權）');
  assert(parseApprovals(JSON.stringify(futureToken())).length === 1, '單一物件 → 一張');
  assert(parseApprovals(JSON.stringify([futureToken(), futureToken()])).length === 2, '陣列 → 多張');
  assert(parseApprovals(JSON.stringify(['字串不是 token'])).length === 0, '非物件元素被濾掉');
});

testCase('R9', 'non-overridable 的規則，任何 token 都繞不過', () => {
  const c = compileOf(policy({ overridable: false }));
  const d = decide(c, { rule: 'demo-rule', action: 'demo-action', target: 'demo-target', violation: true, approvals: [futureToken()], now: Date.parse('2026-07-26T00:00:00Z') });
  assert(d.outcome === 'deny' && d.code === 'non-overridable', '不可繞過的規則：有完全相符的有效 token 也照擋');
  assert(d.audit === null, '被擋下時沒有稽核紀錄（沒發生繞過這件事）');
});

testCase('R10', 'overridable 的規則：有 scope 的有效 token 才放行，且產出稽核內容', () => {
  const c = compileOf(policy({ overridable: true }));
  const now = Date.parse('2026-07-26T00:00:00Z');
  const ok = decide(c, { rule: 'demo-rule', action: 'demo-action', target: 'demo-target', violation: true, approvals: [futureToken()], now });
  assert(ok.outcome === 'allow' && ok.code === 'approved', '有效 token → 放行');
  assert(ok.audit && ok.audit.rule === 'demo-rule' && ok.audit.target === 'demo-target' && ok.audit.issued_by === 'owner' && ok.audit.expires_at, '稽核內容含 rule/target/核准人/到期');
  assert(ok.audit.reason === '本次例外', '稽核帶理由（不記理由的授權等於沒授權）');

  const none = decide(c, { rule: 'demo-rule', action: 'demo-action', target: 'demo-target', violation: true, approvals: [], now });
  assert(none.outcome === 'deny' && none.code === 'no-valid-approval', '可繞過但沒 token → 仍擋');
  const stale = decide(c, { rule: 'demo-rule', action: 'demo-action', target: 'demo-target', violation: true, approvals: [futureToken({ expires_at: '2020-01-01T00:00:00Z' })], now });
  assert(stale.outcome === 'deny' && stale.reason.includes('過期'), '過期 token → 擋，理由講明過期');
  const otherTarget = decide(c, { rule: 'demo-rule', action: 'demo-action', target: '別的檔', violation: true, approvals: [futureToken()], now });
  assert(otherTarget.outcome === 'deny', 'token 的 scope 不涵蓋這個 target → 擋（授權是有範圍的）');
});

testCase('R11', 'forbid-wins：多條規則同時適用時，任一條 deny 就整體 deny', () => {
  const c = compilePolicyRuntime(reg(
    policy({ id: 'rule-a' }),
    policy({ id: 'rule-b', enforcement: 'require' }),
  ));
  const all = decideAll(c, [
    { rule: 'rule-a', action: 'demo-action', violation: false },
    { rule: 'rule-b', action: 'demo-action', violation: true },
  ]);
  assert(all.outcome === 'deny', '一條放行、一條擋 → 整體擋（不取最寬鬆的）');
  assert(all.denies.length === 1 && all.reason.includes('rule-b'), '理由指名是哪一條擋的');

  const both = decideAll(c, [
    { rule: 'rule-a', action: 'demo-action', violation: true },
    { rule: 'rule-b', action: 'demo-action', violation: true },
  ]);
  assert(both.denies.length === 2 && both.reason.split('\n').length === 2, '多條同時擋 → 理由一次列全（不讓人修一項再撞下一項）');

  const clean = decideAll(c, [{ rule: 'rule-a', action: 'demo-action', violation: false }]);
  assert(clean.outcome === 'allow' && clean.reason === null, '反向：都沒違反 → 放行、無理由');
  assert(decideAll(c, []).outcome === 'allow', '空清單 → 放行');
});

testCase('R12', 'semantic 級：評不到一律標 degraded，絕不寫成 passed', () => {
  const c = compileOf(policy({ tier: 'semantic', runtime: null, evaluator: 'promptfoo', enforcement: 'require', fail_closed_on_missing_state: false }));
  assert(evaluateSemantic(c, 'demo-rule').status === 'degraded', 'evaluator 沒注入 → degraded');
  assert(evaluateSemantic(c, 'demo-rule').reason.includes('degraded'), '理由明講「不得寫成 passed」的意思');
  assert(evaluateSemantic(c, 'demo-rule', { runEval: () => { throw new Error('promptfoo 掛了'); } }).status === 'degraded', 'evaluator 丟例外 → degraded');
  assert(evaluateSemantic(c, 'demo-rule', { runEval: () => ({}) }).status === 'degraded', 'evaluator 沒回結論 → degraded');
  assert(evaluateSemantic(c, 'demo-rule', { runEval: () => ({ status: 'passed' }) }).status === 'passed', '真的評過 → passed');
  assert(evaluateSemantic(c, 'demo-rule', { runEval: () => ({ status: 'failed' }) }).status === 'failed', '真的評不過 → failed');
  assert(evaluateSemantic(c, '沒登記的規則').status === 'degraded', '未登記 → degraded（不是 passed）');
  const hard = compileOf(policy());
  assert(evaluateSemantic(hard, 'demo-rule').status === 'not-applicable', 'hard 級不走 eval');
});

testCase('R13', '共用測試契約：每條 hard rule 的五種情形都被驗到，且結果符合它自己的宣告', () => {
  assert(HARD_RULE_CONTRACT_CASES.length === 5, '契約固定五種情形');
  for (const over of [{ overridable: false, fail_closed_on_missing_state: true }, { overridable: true, fail_closed_on_missing_state: true }, { overridable: true, enforcement: 'warn', fail_closed_on_missing_state: false }]) {
    const c = compileOf(policy(over));
    const contract = hardRuleContract(c, 'demo-rule');
    assert(contract.length === 5, `overridable=${over.overridable} failClosed=${over.fail_closed_on_missing_state !== false}：產出五個 case`);
    for (const cse of contract) {
      const got = decide(c, { ...cse.input, now: Date.parse('2026-07-26T00:00:00Z') });
      assert(got.outcome === cse.expect, `  ${cse.name} → 期望 ${cse.expect}、實際 ${got.outcome}`);
    }
  }
  assert(hardRuleContract(compileOf(policy()), '不存在') === null, '未登記的規則產不出契約');
});

testCase('R14', '真 repo：policy registry 編譯得動，且每支發得出 deny 的 hook 都有宣告來源', () => {
  const registry = loadRegistry(REPO_ROOT);
  assert(registry && Array.isArray(registry.policies), '讀得到真 repo 的 policy-registry.json');
  const c = compilePolicyRuntime(registry);
  assert(c.findings.length === 0, `真 repo 全部規則編譯無 finding（實際：${JSON.stringify(c.findings)}）`);
  assert(c.rules.size === registry.policies.length, '每條 policy 都編譯成可執行規則（沒有被靜默丟掉的）');
  for (const tier of POLICY_TIERS) {
    assert([...c.rules.values()].some((r) => r.tier === tier), `四級都有實際規則落在上面：${tier}`);
  }
  const hooks = listHookFiles(REPO_ROOT);
  assert(hooks.length > 0 && hooks.every((h) => typeof h.text === 'string'), 'listHookFiles 讀得到 hooks');
  const cov = checkGuardCoverage(c, { hooks });
  assert(cov.denyHooks.length >= 7, `偵測到 ${cov.denyHooks.length} 支發得出 deny 的 hook`);
  assert(cov.findings.length === 0, `每支 deny hook 都有 policy 宣告、且每條 policy 指名的 hook 都存在（實際：${JSON.stringify(cov.findings)}）`);
  for (const r of c.rules.values()) {
    if (r.mechanism === 'pre-tool-deny') assert(r.tests.length > 0, `hard rule "${r.id}" 有指名測試檔（可反查誰在驗它）`);
  }
});

testCase('R15', '鑑別力：拿掉一條 policy，對應的 deny hook 立刻被判成沒有來源', () => {
  const registry = loadRegistry(REPO_ROOT);
  const trimmed = { ...registry, policies: registry.policies.filter((p) => p?.runtime?.guard !== 'merge-guard') };
  const cov = checkGuardCoverage(compilePolicyRuntime(trimmed), { hooks: listHookFiles(REPO_ROOT) });
  assert(cov.findings.some((f) => f.check === 'guard-not-declared' && f.file.includes('merge-guard')), '拿掉 merge-guard 的 policy → 立刻紅（殺掉「恆綠」的實作）');

  const ghost = { ...registry, policies: [...registry.policies, { ...registry.policies.find((p) => p.id === 'merge-is-human-gate'), id: 'ghost-rule', runtime: { guard: '不存在的-hook', protected_actions: ['x'] } }] };
  const cov2 = checkGuardCoverage(compilePolicyRuntime(ghost), { hooks: listHookFiles(REPO_ROOT) });
  assert(cov2.findings.some((f) => f.check === 'guard-missing'), '反向：policy 指名不存在的 hook → 也紅');
  assert(String(DENY_MARKER).includes('deny'), 'deny 判準是可讀的字面標記');
});

testCase('R16', '稽核：核准繞過會寫進 append-only 帳本（逃生口用了幾次查得到）', () => {
  withTmp((root) => {
    assert(approvalAuditPath(root).exists === false, '一開始沒有帳本');
    const c = compileOf(policy({ overridable: true }));
    const d = decide(c, { rule: 'demo-rule', action: 'demo-action', target: 'demo-target', violation: true, approvals: [futureToken()], now: Date.parse('2026-07-26T00:00:00Z') });
    recordApproval(root, d.audit, { now: Date.parse('2026-07-26T00:00:00Z') });
    const { file, exists } = approvalAuditPath(root);
    assert(exists, '核准後帳本存在');
    const { events, warnings } = readEvents(file);
    assert(warnings.length === 0 && events.length === 1, '帳本是合法的 append-only 事件流（重用 #172 的寫入路徑）');
    assert(events[0].type === 'policy-approval', '事件型別是 policy-approval');
    const p = events[0].payload;
    assert(p.rule === 'demo-rule' && p.target === 'demo-target' && p.issued_by === 'owner' && p.reason && p.expires_at && p.recorded_at, '留痕含規則/範圍/核准人/理由/到期/落帳時間');
    recordApproval(root, d.audit, { now: Date.parse('2026-07-26T01:00:00Z') });
    assert(readEvents(file).events.length === 2, '第二次核准 append 上去（只增不改）');
    assert(readFileSync(file, 'utf8').split('\n').filter(Boolean).length === 2, '每筆一行 JSONL');
    assert(existsSync(join(root, '.loops', '.audit')), '帳本落在 .loops/.audit/ 底下');
  });
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
