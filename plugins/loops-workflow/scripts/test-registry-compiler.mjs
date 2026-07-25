#!/usr/bin/env node
// test-registry-compiler.mjs —— registry-compiler.mjs 的紅綠單元 + IO/CLI 整合斷言
// （自帶極簡 harness，仿 test-codex-plugin-lint.mjs，不引測試框架）。
// 用法：node test-registry-compiler.mjs [--filter <case-prefix>] [--min-cases <n>]
//   --filter T1      只跑 case id 以 T1 開頭的
//   --min-cases 6    斷言實際跑到的 case 數不得少於 6（沒有這個地板，一個沒寫測試的任務也會 exit 0）
// 全綠且達到 case 地板 → exit 0；任一斷言失敗 / case 數不足 / import 失敗 → exit 1。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  checkPolicyShape,
  checkPolicyIds,
  checkPolicyScope,
  checkPolicyPaths,
  checkPolicyApproval,
  checkPolicyFailClosed,
  checkPolicyTiers,
  checkPolicyProjectionMarkers,
  relateScopes,
  checkPolicies,
  checkComponentShape,
  checkComponentIds,
  checkComponentReciprocity,
  checkComponentRequiredChecks,
  checkComponentCycles,
  checkComponents,
  checkIntegrationShape,
  checkIntegrationIds,
  checkIntegrationPaths,
  checkIntegrationExclusiveGroups,
  checkIntegrationLifecycle,
  checkIntegrationRefs,
  checkIntegrationNeutralText,
  checkIntegrations,
  classifyConflict,
  collectPolicyDecisions,
  computeAffected,
  formatAffected,
  formatSummary,
  buildReport,
  buildAffectedReport,
} from './registry-compiler.mjs';
import { parseRegistryJson } from './check-registry-shape.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const SCRIPT = fileURLToPath(new URL('./registry-compiler.mjs', import.meta.url));
const POLICY_REL = 'plugins/loops-workflow/references/policy-registry.json';
const COMPONENT_REL = 'plugins/loops-workflow/references/component-registry.json';
const INTEGRATION_REL = 'plugins/loops-workflow/references/integration-registry.json';

// ── 極簡 harness ──────────────────────────────────────────────────────────────
let passed = 0;
const failed = [];
const cases = [];

function testCase(id, name, fn) {
  cases.push({ id, name, fn });
}

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function parseArgs(argv) {
  const opts = { filter: '', minCases: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--filter') opts.filter = argv[++i] ?? '';
    else if (flag === '--min-cases') opts.minCases = Number(argv[++i] ?? 0);
  }
  return opts;
}

// ── 共用 fixture 工廠：一筆合法 policy，各 case 只覆蓋要測壞的那個欄位 ───────────
function validPolicy(overrides = {}) {
  return {
    id: 'sample-rule',
    title: '範例規則',
    scope: { kind: 'path-based', paths: ['docs/**'], activities: [], stages: [] },
    enforcement: 'require',
    // #173：每條規則都要標 tier；advisory 是「靠 prompt 承接」那一級，不需要綁 runtime.guard，
    // 所以拿它當通用 fixture 的預設值，各 case 只覆蓋自己要測壞的欄位。
    tier: 'advisory',
    runtime: null,
    evaluator: null,
    overridable: false,
    approval: { required: false, by: null },
    precedence: null,
    fail_closed_on_missing_state: false,
    requires: [],
    forbids: [],
    conflicts_with: [],
    projection: [],
    projection_marker: null,
    tests: [],
    docs: [],
    ...overrides,
  };
}

function registryOf(...policies) {
  return { schema_version: '1', policies };
}

const ALL_PATHS_EXIST = { pathExists: () => true };

/** 讀真實 repo 的 registry（讀不到就讓例外冒出來——測試該紅，不該靜默）。 */
function readRealRegistry(rel = POLICY_REL) {
  return parseRegistryJson(readFileSync(join(REPO_ROOT, ...rel.split('/')), 'utf8'));
}

/**
 * 真實 registry 檔裡某個集合的實際筆數。
 * summary 只有「與檔案內容相符」才有意義，所以測試自己重數一次，
 * 不把某個當下的筆數寫死成期望值（那是鎖資料，不是鎖行為）。
 */
function realEntryCount(rel, key) {
  const parsed = readRealRegistry(rel);
  if (parsed.error) throw new Error(`${rel} 無法解析：${parsed.error}`);
  const entries = parsed.registry?.[key];
  if (!Array.isArray(entries)) throw new Error(`${rel} 缺少陣列欄位 "${key}"`);
  return entries.length;
}

function runCli(root, args = []) {
  const res = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    json = null;
  }
  return { res, json };
}

/** 把任一份 registry（policy／component／integration）寫進暫時 root 的對應相對路徑。 */
function writeRegistry(dir, rel, registry) {
  const abs = join(dir, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(registry, null, 2), 'utf8');
  return abs;
}

function writeText(dir, rel, text) {
  const abs = join(dir, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
  return abs;
}

// ── component / integration fixture 工廠（各 case 只覆蓋要測壞的那個欄位）───────────
function validComponent(overrides = {}) {
  return {
    id: 'sample-component',
    kind: 'script',
    paths: ['plugins/loops-workflow/scripts/registry-compiler.mjs'],
    stage_role: null,
    visibility: 'internal',
    dependencies: [],
    consumers: [],
    required_checks: { hooks: [], evals: [], docs: [], integrations: [] },
    ...overrides,
  };
}

function componentRegistryOf(...components) {
  return { schema_version: '1', components };
}

function validIntegration(overrides = {}) {
  return {
    id: 'sample-integration',
    capability: '以指令列建立隔離工作區',
    support_status: 'not_measured',
    exclusive_group: null,
    lifecycle: {
      detect: 'git --version',
      install_latest: null,
      update_latest: null,
      health: null,
      uninstall: null,
      rollback: null,
    },
    triggers: [],
    outputs: [],
    ...overrides,
  };
}

function integrationRegistryOf(...integrations) {
  return { schema_version: '1', integrations };
}

function pathScope(paths, stages = []) {
  return { kind: 'path-based', paths, activities: [], stages };
}

function activityScope(activities, stages = []) {
  return { kind: 'activity-based', paths: [], activities, stages };
}

// ══════════════════════════════════════════════════════════════════════════
// T0：用三條真實 AGENTS.md 規則試填 policy schema（風險探路，不含 compiler 邏輯設計）
// ══════════════════════════════════════════════════════════════════════════

testCase('T0-1', '真實 policy-registry.json 收得下三條規則', () => {
  const parsed = readRealRegistry();
  assert(!parsed.error, `T0-1：policy-registry.json 可解析（實際 error：${parsed.error ?? '無'}）`);
  const ids = (parsed.registry?.policies ?? []).map((p) => p.id);
  for (const expected of ['worktree-isolation', 'canonical-platform-neutral', 'metric-honesty']) {
    assert(ids.includes(expected), `T0-1：registry 含規則 "${expected}"（實際：${ids.join(', ')}）`);
  }
});

testCase('T0-2', '活動型規則用 activity-based scope、不靠裸 ** 假裝有路徑面', () => {
  const policies = readRealRegistry().registry?.policies ?? [];
  const byId = Object.fromEntries(policies.map((p) => [p.id, p]));
  assert(byId['worktree-isolation']?.scope?.kind === 'path-based', 'T0-2：worktree-isolation 為 path-based');
  assert(byId['canonical-platform-neutral']?.scope?.kind === 'path-based', 'T0-2：canonical-platform-neutral 為 path-based');
  assert(byId['metric-honesty']?.scope?.kind === 'activity-based', 'T0-2：metric-honesty 為 activity-based（純活動型、無路徑面）');
  assert(
    (byId['metric-honesty']?.scope?.activities ?? []).length > 0,
    'T0-2：metric-honesty 以 scope.activities 表達適用面',
  );
  const bareGlob = policies.filter((p) => (p.scope?.paths ?? []).includes('**')).map((p) => p.id);
  assert(bareGlob.length === 0, `T0-2：沒有任何規則用裸 "**" 當 scope（實際：${bareGlob.join(', ') || '無'}）`);
});

testCase('T0-3', '真實 registry 對真實 repo 全綠（三條都填得進去）', () => {
  const result = buildReport(REPO_ROOT);
  assert(result.ok === true, `T0-3：buildReport 全綠（實際 findings：${JSON.stringify(result.findings)}）`);
  const actual = realEntryCount(POLICY_REL, 'policies');
  assert(
    result.summary.policies === actual,
    `T0-3：summary.policies 等於 policy-registry.json 實際筆數（摘要：${result.summary.policies}／實際：${actual}）`,
  );
});

// ══════════════════════════════════════════════════════════════════════════
// T1：policy schema 與 typed parser（P1 / P2 / P4 / P6 ＋ scope kind 一致性）
// ══════════════════════════════════════════════════════════════════════════

testCase('T1-1', '合法 registry → 0 finding', () => {
  const registry = registryOf(validPolicy());
  const { findings, decisions } = checkPolicies(registry, ALL_PATHS_EXIST);
  assert(findings.length === 0, `T1-1：合法 registry 無 finding（實際：${JSON.stringify(findings)}）`);
  assert(Array.isArray(decisions) && decisions.length === 0, 'T1-1：decisions 為空陣列');
});

testCase('T1-2', 'P1 負向：id 重複 / 非 kebab-case / 空', () => {
  const dup = checkPolicyIds(registryOf(validPolicy(), validPolicy()));
  assert(
    dup.some((f) => f.id === 'sample-rule' && f.detail.includes('重複')),
    `T1-2：id 重複命中且指名 id（實際：${JSON.stringify(dup)}）`,
  );

  const bad = checkPolicyIds(registryOf(validPolicy({ id: 'Sample_Rule' })));
  assert(
    bad.some((f) => f.id === 'Sample_Rule' && f.detail.includes('kebab-case')),
    `T1-2：非 kebab-case 命中且訊息指名欄位（實際：${JSON.stringify(bad)}）`,
  );

  const empty = checkPolicyIds(registryOf(validPolicy({ id: '' })));
  assert(
    empty.some((f) => f.detail.includes('"id"') && f.detail.includes('policies[0]')),
    `T1-2：空 id 命中且指名位置（實際：${JSON.stringify(empty)}）`,
  );
});

testCase('T1-3', 'scope kind 一致性負向：activity-based 卻填 paths、path-based 用裸 **', () => {
  const mixed = checkPolicyScope(registryOf(validPolicy({
    id: 'activity-rule',
    scope: { kind: 'activity-based', paths: ['**'], activities: ['claim-metric'], stages: [] },
  })));
  assert(
    mixed.some((f) => f.id === 'activity-rule' && f.detail.includes('scope.paths')),
    `T1-3：activity-based 填了 paths → 命中且指名 id 與欄位（實際：${JSON.stringify(mixed)}）`,
  );

  const bare = checkPolicyScope(registryOf(validPolicy({ scope: { kind: 'path-based', paths: ['**'], activities: [], stages: [] } })));
  assert(
    bare.some((f) => f.id === 'sample-rule' && f.detail.includes('**')),
    `T1-3：path-based 用裸 ** → 命中（實際：${JSON.stringify(bare)}）`,
  );

  const missingKind = checkPolicyScope(registryOf(validPolicy({ scope: { paths: ['docs/**'], activities: [], stages: [] } })));
  assert(
    missingKind.some((f) => f.detail.includes('scope.kind')),
    `T1-3：缺 scope.kind → 命中（實際：${JSON.stringify(missingKind)}）`,
  );
});

testCase('T1-4', 'P2 負向：tests/docs/projection dangling 且訊息指名 id 與欄位索引', () => {
  const registry = registryOf(validPolicy({
    id: 'metric-honesty',
    tests: ['scripts/test-exists.mjs', 'scripts/test-nonexistent.mjs'],
  }));
  const findings = checkPolicyPaths(registry, { pathExists: (rel) => rel === 'scripts/test-exists.mjs' });
  assert(findings.length === 1, `T1-4：只命中不存在的那一筆（實際：${JSON.stringify(findings)}）`);
  const [f] = findings;
  assert(
    f.id === 'metric-honesty' && f.detail.includes('tests[1]') && f.detail.includes('scripts/test-nonexistent.mjs'),
    `T1-4：訊息同時指名 id、欄位索引與路徑（實際：${JSON.stringify(f)}）`,
  );
});

testCase('T1-5', 'P4 負向：overridable=true 但 approval 不完整', () => {
  const noRequired = checkPolicyApproval(registryOf(validPolicy({
    id: 'override-rule',
    overridable: true,
    approval: { required: false, by: 'owner' },
  })));
  assert(
    noRequired.some((f) => f.id === 'override-rule' && f.detail.includes('approval.required')),
    `T1-5：approval.required 非 true → 命中（實際：${JSON.stringify(noRequired)}）`,
  );

  const noBy = checkPolicyApproval(registryOf(validPolicy({
    id: 'override-rule',
    overridable: true,
    approval: { required: true, by: null },
  })));
  assert(
    noBy.some((f) => f.id === 'override-rule' && f.detail.includes('approval.by')),
    `T1-5：approval.by 為空 → 命中（實際：${JSON.stringify(noBy)}）`,
  );

  const ok = checkPolicyApproval(registryOf(validPolicy({
    overridable: true,
    approval: { required: true, by: 'capability-registry-override-owner' },
  })));
  assert(ok.length === 0, `T1-5：完整 approval → 0 finding（實際：${JSON.stringify(ok)}）`);
});

testCase('T1-6', 'P6 負向：forbid 規則缺 fail_closed_on_missing_state 或為 false', () => {
  const missing = validPolicy({ id: 'worktree-isolation', enforcement: 'forbid' });
  delete missing.fail_closed_on_missing_state;
  const findingsMissing = checkPolicyFailClosed(registryOf(missing));
  assert(
    findingsMissing.some((f) => f.id === 'worktree-isolation' && f.detail.includes('fail_closed_on_missing_state')),
    `T1-6：forbid 缺欄位 → 命中且指名 id 與欄位（實際：${JSON.stringify(findingsMissing)}）`,
  );

  const explicitFalse = checkPolicyFailClosed(registryOf(validPolicy({
    id: 'worktree-isolation',
    enforcement: 'forbid',
    fail_closed_on_missing_state: false,
  })));
  assert(
    explicitFalse.some((f) => f.detail.includes('enforcement')),
    `T1-6：forbid 且顯式 false → 命中（實際：${JSON.stringify(explicitFalse)}）`,
  );
});

testCase('T1-7', 'P6：approval.required=true 同樣要 fail-closed；顯式 true 才放行', () => {
  const approvalCase = checkPolicyFailClosed(registryOf(validPolicy({
    id: 'canonical-platform-neutral',
    enforcement: 'require',
    overridable: true,
    approval: { required: true, by: 'owner' },
    fail_closed_on_missing_state: false,
  })));
  assert(
    approvalCase.some((f) => f.id === 'canonical-platform-neutral' && f.detail.includes('approval.required')),
    `T1-7：需核可但 fail-closed=false → 命中（實際：${JSON.stringify(approvalCase)}）`,
  );

  const green = checkPolicyFailClosed(registryOf(validPolicy({
    enforcement: 'forbid',
    fail_closed_on_missing_state: true,
  })));
  assert(green.length === 0, `T1-7：forbid 且顯式 true → 0 finding（實際：${JSON.stringify(green)}）`);

  const untouched = checkPolicyFailClosed(registryOf(validPolicy({ enforcement: 'info' })));
  assert(untouched.length === 0, `T1-7：info 規則不受 P6 約束（實際：${JSON.stringify(untouched)}）`);
});

testCase('T1-8', 'registry 形狀負向：policies 非陣列 / 元素非物件 / 缺 schema_version', () => {
  const notArray = checkPolicyShape({ schema_version: '1', policies: {} });
  assert(
    notArray.some((f) => f.detail.includes('"policies"')),
    `T1-8：policies 非陣列 → 命中（實際：${JSON.stringify(notArray)}）`,
  );

  const noVersion = checkPolicyShape({ policies: [] });
  assert(
    noVersion.some((f) => f.detail.includes('schema_version')),
    `T1-8：缺 schema_version → 命中（實際：${JSON.stringify(noVersion)}）`,
  );

  const badElement = checkPolicyShape({ schema_version: '1', policies: ['x'] });
  assert(
    badElement.some((f) => f.detail.includes('policies[0]')),
    `T1-8：元素非物件 → 命中（實際：${JSON.stringify(badElement)}）`,
  );
});

testCase('T1-9', 'CLI 整合：壞 registry → exit 1 且 --json 指名 id；好 registry → exit 0', () => {
  const badDir = mkdtempSync(join(tmpdir(), 'regc-'));
  try {
    writeRegistry(badDir, POLICY_REL, registryOf(validPolicy({
      id: 'worktree-isolation',
      enforcement: 'forbid',
      fail_closed_on_missing_state: false,
    })));
    const { res, json } = runCli(badDir, ['--json']);
    assert(res.status === 1, `T1-9：壞 registry → exit 1（實際：${res.status}）`);
    assert(
      json && json.findings.some((f) => f.check === 'policy-fail-closed' && f.id === 'worktree-isolation'),
      `T1-9：--json finding 含 policy-fail-closed 且指名 id（實際：${res.stdout}）`,
    );
  } finally {
    rmSync(badDir, { recursive: true, force: true });
  }

  const goodDir = mkdtempSync(join(tmpdir(), 'regc-'));
  try {
    writeRegistry(goodDir, POLICY_REL, registryOf(validPolicy()));
    const { res } = runCli(goodDir);
    assert(res.status === 0, `T1-9：合法 registry → exit 0（實際：${res.status}／${res.stdout}${res.stderr}）`);
    assert(res.stdout.includes('✓ registry-compiler'), `T1-9：人讀摘要為全綠單行（實際：${res.stdout.trim()}）`);
  } finally {
    rmSync(goodDir, { recursive: true, force: true });
  }

  const missingDir = mkdtempSync(join(tmpdir(), 'regc-'));
  try {
    const { res, json } = runCli(missingDir, ['--json']);
    assert(res.status === 1, `T1-9：registry 檔不存在 → exit 1（實際：${res.status}）`);
    assert(
      json && json.findings.some((f) => f.check === 'policy-registry-file'),
      `T1-9：缺檔 → 命中 policy-registry-file（實際：${res.stdout}）`,
    );
  } finally {
    rmSync(missingDir, { recursive: true, force: true });
  }
});

testCase('T1-10', 'formatSummary 同時渲染 findings 與 decisions（decisions 不得被吞掉）', () => {
  const green = formatSummary({ ok: true, findings: [], decisions: [], summary: { policies: 3 } });
  assert(green.includes('✓ registry-compiler') && green.includes('3'), `T1-10：全綠摘要含條數（實際：${green}）`);

  const withDecision = formatSummary({
    ok: false,
    findings: [],
    decisions: [{ kind: 'requires-human-decision', scope: 'docs/**', rules: ['a', 'b'], reason: '互斥且皆未宣告 precedence' }],
    summary: { policies: 2 },
  });
  assert(
    withDecision.includes('requires-human-decision') && withDecision.includes('a, b'),
    `T1-10：有 decision 時摘要必須渲染出來（實際：${withDecision}）`,
  );
});

// ══════════════════════════════════════════════════════════════════════════
// T2：component registry（C1 id 唯一 + dangling／C3 雙向一致／C4 required_checks 路徑存在）
// ══════════════════════════════════════════════════════════════════════════

testCase('T2-1', '真實 component-registry.json 對真實 repo 全綠', () => {
  const result = buildReport(REPO_ROOT);
  assert(result.ok === true, `T2-1：buildReport 全綠（實際 findings：${JSON.stringify(result.findings)}）`);
  const registry = readRealRegistry(COMPONENT_REL);
  assert(!registry.error, `T2-1：component-registry.json 可解析（實際 error：${registry.error ?? '無'}）`);
  const actual = realEntryCount(COMPONENT_REL, 'components');
  assert(
    result.summary.components === actual,
    `T2-1：summary.components 等於 component-registry.json 實際筆數（摘要：${result.summary.components}／實際：${actual}）`,
  );
});

testCase('T2-2', 'C1 負向：id 重複 → 紅且訊息指名 id', () => {
  const findings = checkComponentIds(componentRegistryOf(validComponent(), validComponent()));
  assert(
    findings.some((f) => f.check === 'component-id' && f.id === 'sample-component' && f.detail.includes('重複')),
    `T2-2：id 重複命中且指名 id（實際：${JSON.stringify(findings)}）`,
  );
});

testCase('T2-3', 'C1 負向：dependencies／consumers 指向不存在的 id → 紅且訊息指名該 id', () => {
  const danglingDep = checkComponentIds(componentRegistryOf(validComponent({ dependencies: ['ghost-component'] })));
  assert(
    danglingDep.some((f) => f.check === 'component-ref' && f.id === 'sample-component'
      && f.detail.includes('dependencies[0]') && f.detail.includes('ghost-component')),
    `T2-3：dangling dependency 命中且指名 id 與欄位（實際：${JSON.stringify(danglingDep)}）`,
  );

  const danglingConsumer = checkComponentIds(componentRegistryOf(validComponent({ consumers: ['ghost-consumer'] })));
  assert(
    danglingConsumer.some((f) => f.detail.includes('consumers[0]') && f.detail.includes('ghost-consumer')),
    `T2-3：dangling consumer 命中（實際：${JSON.stringify(danglingConsumer)}）`,
  );
});

testCase('T2-4', 'C3 負向：A 依賴 B 但 B 的 consumers 沒有 A → 紅（雙向都要抓）', () => {
  const oneWay = checkComponentReciprocity(componentRegistryOf(
    validComponent({ id: 'a', dependencies: ['b'] }),
    validComponent({ id: 'b', consumers: [] }),
  ));
  assert(
    oneWay.some((f) => f.check === 'component-reciprocity' && f.id === 'a'
      && f.detail.includes('"b"') && f.detail.includes('consumers')),
    `T2-4：單向 dependency 命中且指名雙方 id（實際：${JSON.stringify(oneWay)}）`,
  );

  const orphanConsumer = checkComponentReciprocity(componentRegistryOf(
    validComponent({ id: 'a', consumers: ['b'] }),
    validComponent({ id: 'b', dependencies: [] }),
  ));
  assert(
    orphanConsumer.some((f) => f.id === 'a' && f.detail.includes('dependencies')),
    `T2-4：單向 consumer 命中（實際：${JSON.stringify(orphanConsumer)}）`,
  );

  const green = checkComponentReciprocity(componentRegistryOf(
    validComponent({ id: 'a', dependencies: ['b'] }),
    validComponent({ id: 'b', consumers: ['a'] }),
  ));
  assert(green.length === 0, `T2-4：雙向一致 → 0 finding（實際：${JSON.stringify(green)}）`);
});

testCase('T2-5', 'C4 負向：required_checks 路徑不存在 → 紅且指名 component id 與桶位索引', () => {
  const registry = componentRegistryOf(validComponent({
    id: 'loops-path-guard',
    required_checks: {
      hooks: ['hooks/test-exists.mjs', 'hooks/test-gone.mjs'],
      evals: [],
      docs: [],
      integrations: ['worktree-cli'],
    },
  }));
  const findings = checkComponentRequiredChecks(registry, { pathExists: (rel) => rel === 'hooks/test-exists.mjs' });
  assert(findings.length === 1, `T2-5：只命中不存在的那一筆（實際：${JSON.stringify(findings)}）`);
  assert(
    findings[0].id === 'loops-path-guard' && findings[0].detail.includes('required_checks.hooks[1]')
      && findings[0].detail.includes('hooks/test-gone.mjs'),
    `T2-5：訊息指名 id、欄位索引與路徑（實際：${JSON.stringify(findings[0])}）`,
  );
  assert(
    findings.every((f) => !f.detail.includes('worktree-cli')),
    'T2-5：required_checks.integrations 是 id 不是路徑，不由 C4 當檔案檢查',
  );
});

testCase('T2-6', 'shape 負向：kind／visibility 非列舉、paths 空、required_checks 缺桶', () => {
  const badKind = checkComponentShape(componentRegistryOf(validComponent({ kind: 'plugin' })));
  assert(
    badKind.some((f) => f.id === 'sample-component' && f.detail.includes('"kind"')),
    `T2-6：kind 非列舉 → 命中（實際：${JSON.stringify(badKind)}）`,
  );

  const badVisibility = checkComponentShape(componentRegistryOf(validComponent({ visibility: 'private' })));
  assert(
    badVisibility.some((f) => f.detail.includes('"visibility"')),
    `T2-6：visibility 非列舉 → 命中（實際：${JSON.stringify(badVisibility)}）`,
  );

  const emptyPaths = checkComponentShape(componentRegistryOf(validComponent({ paths: [] })));
  assert(
    emptyPaths.some((f) => f.detail.includes('"paths"')),
    `T2-6：paths 為空 → 命中（實際：${JSON.stringify(emptyPaths)}）`,
  );

  const missingBucket = checkComponentShape(componentRegistryOf(validComponent({
    required_checks: { hooks: [], evals: [], docs: [] },
  })));
  assert(
    missingBucket.some((f) => f.detail.includes('required_checks.integrations')),
    `T2-6：required_checks 缺 integrations 桶 → 命中（實際：${JSON.stringify(missingBucket)}）`,
  );
});

testCase('T2-7', 'CLI 整合：component registry 壞掉 → exit 1 且 --json 指名 component id 與檔案', () => {
  const dir = mkdtempSync(join(tmpdir(), 'regc-'));
  try {
    writeRegistry(dir, POLICY_REL, registryOf(validPolicy()));
    writeRegistry(dir, COMPONENT_REL, componentRegistryOf(validComponent({ id: 'a', dependencies: ['ghost'] })));
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 1, `T2-7：dangling dependency → exit 1（實際：${res.status}）`);
    assert(
      json && json.findings.some((f) => f.check === 'component-ref' && f.id === 'a' && f.file === COMPONENT_REL),
      `T2-7：--json finding 指名 component id 與 component-registry 檔（實際：${res.stdout}）`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// T3：integration registry（I2 互斥組／I4 只驗形狀不執行／I5 跨表 dangling／I6 平台中立）
// ══════════════════════════════════════════════════════════════════════════

testCase('T3-1', '真實 integration-registry.json 對真實 repo 全綠', () => {
  const result = buildReport(REPO_ROOT);
  assert(result.ok === true, `T3-1：buildReport 全綠（實際 findings：${JSON.stringify(result.findings)}）`);
  const actual = realEntryCount(INTEGRATION_REL, 'integrations');
  assert(
    result.summary.integrations === actual,
    `T3-1：summary.integrations 等於 integration-registry.json 實際筆數（摘要：${result.summary.integrations}／實際：${actual}）`,
  );
});

testCase('T3-2', 'I2 負向：同一 exclusive_group 內兩個 supported → 紅且指名 group 與 id', () => {
  const findings = checkIntegrationExclusiveGroups(integrationRegistryOf(
    validIntegration({ id: 'worktree-cli', support_status: 'supported', exclusive_group: 'workspace-isolation' }),
    validIntegration({ id: 'workspace-clone', support_status: 'supported', exclusive_group: 'workspace-isolation' }),
  ));
  assert(
    findings.some((f) => f.check === 'integration-exclusive-group'
      && f.detail.includes('workspace-isolation')
      && f.detail.includes('worktree-cli') && f.detail.includes('workspace-clone')),
    `T3-2：同組兩個 supported → 命中且指名 group 與 ids（實際：${JSON.stringify(findings)}）`,
  );

  const green = checkIntegrationExclusiveGroups(integrationRegistryOf(
    validIntegration({ id: 'worktree-cli', support_status: 'supported', exclusive_group: 'workspace-isolation' }),
    validIntegration({ id: 'workspace-clone', support_status: 'not_measured', exclusive_group: 'workspace-isolation' }),
  ));
  assert(green.length === 0, `T3-2：同組只有一個 supported → 0 finding（實際：${JSON.stringify(green)}）`);
});

testCase('T3-3', 'I4：lifecycle 缺階段／值非字串 → 紅；且檢查全程不執行任何指令', () => {
  const missingStage = checkIntegrationLifecycle(integrationRegistryOf(validIntegration({
    id: 'forge-cli',
    lifecycle: { detect: 'gh --version', install_latest: null, update_latest: null, health: null, uninstall: null },
  })));
  assert(
    missingStage.some((f) => f.id === 'forge-cli' && f.detail.includes('rollback')),
    `T3-3：缺 rollback 階段 → 命中且指名 id 與階段（實際：${JSON.stringify(missingStage)}）`,
  );

  const badValue = checkIntegrationLifecycle(integrationRegistryOf(validIntegration({
    lifecycle: {
      detect: 42, install_latest: null, update_latest: null, health: null, uninstall: null, rollback: null,
    },
  })));
  assert(
    badValue.some((f) => f.detail.includes('lifecycle.detect')),
    `T3-3：階段值非字串或 null → 命中（實際：${JSON.stringify(badValue)}）`,
  );

  const dir = mkdtempSync(join(tmpdir(), 'regc-'));
  const sentinel = join(dir, 'executed.txt');
  try {
    const findings = checkIntegrationLifecycle(integrationRegistryOf(validIntegration({
      lifecycle: {
        detect: `node -e "require('fs').writeFileSync(${JSON.stringify(sentinel).replace(/\\/g, '\\\\')},'x')"`,
        install_latest: null,
        update_latest: null,
        health: null,
        uninstall: null,
        rollback: null,
      },
    })));
    assert(findings.length === 0, `T3-3：合法 lifecycle → 0 finding（實際：${JSON.stringify(findings)}）`);
    assert(!existsSync(sentinel), 'T3-3：lifecycle 指令只被當字串驗形狀，絕不執行（sentinel 檔不得出現）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

testCase('T3-4', 'I5 負向：component 的 required_checks.integrations 指向不存在的 integration id → 紅', () => {
  const componentRegistry = componentRegistryOf(validComponent({
    id: 'loops-path-guard',
    required_checks: { hooks: [], evals: [], docs: [], integrations: ['ghost-integration'] },
  }));
  const findings = checkIntegrationRefs(integrationRegistryOf(validIntegration({ id: 'worktree-cli' })), componentRegistry);
  assert(
    findings.some((f) => f.check === 'integration-ref' && f.id === 'loops-path-guard'
      && f.detail.includes('required_checks.integrations[0]') && f.detail.includes('ghost-integration')),
    `T3-4：跨表 dangling 命中且指名 component id 與 integration id（實際：${JSON.stringify(findings)}）`,
  );

  const green = checkIntegrationRefs(
    integrationRegistryOf(validIntegration({ id: 'ghost-integration' })),
    componentRegistry,
  );
  assert(green.length === 0, `T3-4：id 存在 → 0 finding（實際：${JSON.stringify(green)}）`);
});

testCase('T3-5', 'I6 負向：capability／triggers 出現平台專屬工具名或 vendor model → 紅', () => {
  const toolName = checkIntegrationNeutralText(integrationRegistryOf(validIntegration({
    id: 'forge-cli',
    capability: '用 AskUserQuestion 問使用者要不要開 PR',
  })));
  assert(
    toolName.some((f) => f.check === 'integration-platform-neutral' && f.id === 'forge-cli'
      && f.detail.includes('capability') && f.detail.includes('AskUserQuestion')),
    `T3-5：capability 含平台工具名 → 命中且指名 id 與欄位（實際：${JSON.stringify(toolName)}）`,
  );

  const vendorModel = checkIntegrationNeutralText(integrationRegistryOf(validIntegration({
    triggers: ['需要 claude-3-5-sonnet 才能跑的步驟'],
  })));
  assert(
    vendorModel.some((f) => f.detail.includes('triggers[0]')),
    `T3-5：triggers 含 vendor model id → 命中且指名索引（實際：${JSON.stringify(vendorModel)}）`,
  );

  const green = checkIntegrationNeutralText(integrationRegistryOf(validIntegration()));
  assert(green.length === 0, `T3-5：純能力描述 → 0 finding（實際：${JSON.stringify(green)}）`);
});

testCase('T3-6', 'shape 負向：support_status 非列舉、capability 空、integrations 非陣列', () => {
  const badStatus = checkIntegrationShape(integrationRegistryOf(validIntegration({ support_status: 'maybe' })));
  assert(
    badStatus.some((f) => f.id === 'sample-integration' && f.detail.includes('support_status')),
    `T3-6：support_status 非列舉 → 命中（實際：${JSON.stringify(badStatus)}）`,
  );

  const emptyCapability = checkIntegrationShape(integrationRegistryOf(validIntegration({ capability: '' })));
  assert(
    emptyCapability.some((f) => f.detail.includes('capability')),
    `T3-6：capability 為空 → 命中（實際：${JSON.stringify(emptyCapability)}）`,
  );

  const notArray = checkIntegrationShape({ schema_version: '1', integrations: {} });
  assert(
    notArray.some((f) => f.detail.includes('"integrations"')),
    `T3-6：integrations 非陣列 → 命中（實際：${JSON.stringify(notArray)}）`,
  );
});

// ══════════════════════════════════════════════════════════════════════════
// T4b：generated drift（P7 —— projection 目標必須逐字含有該規則的 projection_marker）
// ══════════════════════════════════════════════════════════════════════════

testCase('T4b-1', '真實 registry：三條規則的 projection 標記在 AGENTS.md 裡都還在', () => {
  const result = buildReport(REPO_ROOT);
  const drift = result.findings.filter((f) => f.check === 'policy-projection-drift');
  assert(drift.length === 0, `T4b-1：真實 repo 無投影漂移（實際：${JSON.stringify(drift)}）`);

  const policies = readRealRegistry().registry?.policies ?? [];
  assert(
    policies.every((p) => (p.projection ?? []).length > 0),
    'T4b-1：三條規則都有 projection 目標（否則這條檢查對真實 registry 是空綠）',
  );
});

testCase('T4b-2', 'P7 負向：投影檔還在但標記被拿掉 → 紅且指名是哪條規則的哪個投影目標', () => {
  const registry = registryOf(validPolicy({
    id: 'metric-honesty',
    projection: ['AGENTS.md'],
    projection_marker: 'Metric-Honesty',
  }));
  const findings = checkPolicyProjectionMarkers(registry, {
    readText: () => '# AGENTS\n這份檔案還在，但那段規則已經被拿掉了。\n',
  });
  assert(findings.length === 1, `T4b-2：命中一筆漂移（實際：${JSON.stringify(findings)}）`);
  assert(
    findings[0].id === 'metric-honesty' && findings[0].detail.includes('AGENTS.md')
      && findings[0].detail.includes('projection[0]') && findings[0].detail.includes('Metric-Honesty'),
    `T4b-2：訊息指名規則 id、投影目標與標記（實際：${JSON.stringify(findings[0])}）`,
  );

  const stillThere = checkPolicyProjectionMarkers(registry, {
    readText: () => '# AGENTS\n## Metric-Honesty：沒實測的數字一律標 not measured\n',
  });
  assert(stillThere.length === 0, `T4b-2：標記還在 → 0 finding（實際：${JSON.stringify(stillThere)}）`);
});

testCase('T4b-3', 'P7 負向：投影目標讀不到 → 紅（存在與否也不能靜默略過）', () => {
  const findings = checkPolicyProjectionMarkers(
    registryOf(validPolicy({ id: 'worktree-isolation', projection: ['docs/gone.md'], projection_marker: 'git worktree' })),
    { readText: () => null },
  );
  assert(
    findings.some((f) => f.id === 'worktree-isolation' && f.detail.includes('docs/gone.md')),
    `T4b-3：讀不到投影目標 → 命中且指名檔案（實際：${JSON.stringify(findings)}）`,
  );
});

testCase('T4b-4', 'P7：projection_marker 為 null 時以 id 當標記比對', () => {
  const registry = registryOf(validPolicy({
    id: 'worktree-isolation',
    projection: ['AGENTS.md'],
    projection_marker: null,
  }));
  const hit = checkPolicyProjectionMarkers(registry, { readText: () => '完全沒提到那條規則\n' });
  assert(
    hit.some((f) => f.detail.includes('worktree-isolation')),
    `T4b-4：預設標記＝id，不含即紅（實際：${JSON.stringify(hit)}）`,
  );

  const green = checkPolicyProjectionMarkers(registry, { readText: () => '見 worktree-isolation 規則\n' });
  assert(green.length === 0, `T4b-4：文字含 id → 0 finding（實際：${JSON.stringify(green)}）`);
});

testCase('T4b-5', 'CLI 整合：投影目標存在但標記被拿掉 → exit 1（只驗存在會漏掉的那種漂移）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'regc-'));
  try {
    writeRegistry(dir, POLICY_REL, registryOf(validPolicy({
      id: 'metric-honesty',
      projection: ['AGENTS.md'],
      projection_marker: 'Metric-Honesty',
      docs: ['AGENTS.md'],
    })));
    writeText(dir, 'AGENTS.md', '# AGENTS\n規則段落已被刪除。\n');
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 1, `T4b-5：投影漂移 → exit 1（實際：${res.status}）`);
    assert(
      json && json.findings.some((f) => f.check === 'policy-projection-drift' && f.id === 'metric-honesty'),
      `T4b-5：--json 指名 policy-projection-drift 與 id（實際：${res.stdout}）`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// T5：component dependencies 成環（含自我引用）
// ══════════════════════════════════════════════════════════════════════════

testCase('T5-1', '無環的依賴圖 → 0 finding', () => {
  const findings = checkComponentCycles(componentRegistryOf(
    validComponent({ id: 'a', dependencies: ['b', 'c'] }),
    validComponent({ id: 'b', dependencies: ['c'] }),
    validComponent({ id: 'c', dependencies: [] }),
  ));
  assert(findings.length === 0, `T5-1：DAG 無 finding（實際：${JSON.stringify(findings)}）`);
});

testCase('T5-2', '負向：a → b → c → a 成環 → 紅且訊息含環上節點序列', () => {
  const findings = checkComponentCycles(componentRegistryOf(
    validComponent({ id: 'a', dependencies: ['b'] }),
    validComponent({ id: 'b', dependencies: ['c'] }),
    validComponent({ id: 'c', dependencies: ['a'] }),
  ));
  assert(findings.length === 1, `T5-2：同一個環只報一次（實際：${JSON.stringify(findings)}）`);
  const [f] = findings;
  assert(
    f.check === 'component-cycle' && f.detail.includes('a → b → c → a'),
    `T5-2：訊息含環上節點序列（實際：${JSON.stringify(f)}）`,
  );
});

testCase('T5-3', '負向：自我引用 a → a 也算環', () => {
  const findings = checkComponentCycles(componentRegistryOf(validComponent({ id: 'a', dependencies: ['a'] })));
  assert(
    findings.some((f) => f.check === 'component-cycle' && f.id === 'a' && f.detail.includes('a → a')),
    `T5-3：自我引用命中且指名 id（實際：${JSON.stringify(findings)}）`,
  );
});

testCase('T5-4', '真實 component-registry 的依賴圖無環', () => {
  const registry = parseRegistryJson(readFileSync(join(REPO_ROOT, ...COMPONENT_REL.split('/')), 'utf8')).registry;
  const findings = checkComponentCycles(registry);
  assert(findings.length === 0, `T5-4：真實依賴圖無環（實際：${JSON.stringify(findings)}）`);
});

// ══════════════════════════════════════════════════════════════════════════
// T6：scope 關係三態（包含／重疊／互斥；依 P9 先比 kind，跨 kind 不視為重疊）
// ══════════════════════════════════════════════════════════════════════════

testCase('T6-1', 'glob 前綴包含 → contains', () => {
  assert(
    relateScopes(pathScope(['docs/**']), pathScope(['docs/api/spec.md'])) === 'contains',
    'T6-1：docs/** 涵蓋 docs/api/spec.md',
  );
  assert(
    relateScopes(pathScope(['plugins/**/*.md']), pathScope(['plugins/loops-workflow/references/reuse-check.md'])) === 'contains',
    'T6-1：帶尾綴的 glob 仍判得出涵蓋',
  );
  assert(
    relateScopes(pathScope(['plugins/**/*.md']), pathScope(['plugins/loops-workflow/scripts/x.mjs'])) !== 'contains',
    'T6-1：尾綴不符不算涵蓋（*.md 不吃 .mjs）',
  );
});

testCase('T6-2', '部分交集、互不涵蓋 → overlaps', () => {
  const relation = relateScopes(pathScope(['docs/**']), pathScope(['docs/api.md', 'src/**']));
  assert(relation === 'overlaps', `T6-2：一組只有部分被涵蓋 → overlaps（實際：${relation}）`);
});

testCase('T6-3', '不同前綴 → disjoint', () => {
  const relation = relateScopes(pathScope(['.loops/**']), pathScope(['plugins/loops-workflow/**']));
  assert(relation === 'disjoint', `T6-3：無交集的 glob → disjoint（實際：${relation}）`);
});

testCase('T6-4', '跨 kind 不視為重疊（P9）：path-based vs activity-based → disjoint', () => {
  const relation = relateScopes(pathScope(['AGENTS.md'], ['build']), activityScope(['claim-metric'], ['build']));
  assert(relation === 'disjoint', `T6-4：跨 kind 即使 stages 相同也不重疊（實際：${relation}）`);
});

testCase('T6-5', 'stages 無交集 → disjoint（即使路徑完全相同）', () => {
  const disjointStages = relateScopes(pathScope(['docs/**'], ['build']), pathScope(['docs/**'], ['verify']));
  assert(disjointStages === 'disjoint', `T6-5：stages 無交集 → disjoint（實際：${disjointStages}）`);

  const sharedStage = relateScopes(pathScope(['docs/**'], ['build', 'verify']), pathScope(['docs/**'], ['verify']));
  assert(sharedStage === 'contains', `T6-5：stages 有交集 → 回到維度比對（實際：${sharedStage}）`);
});

testCase('T6-6', '空 stages＝全階段，與任何 stages 都有交集', () => {
  const relation = relateScopes(pathScope(['docs/**'], []), pathScope(['docs/api/**'], ['iterate']));
  assert(relation === 'contains', `T6-6：空 stages 視為全階段（實際：${relation}）`);
});

testCase('T6-7', 'activity-based 同 kind 比 activities；空維度不當成涵蓋一切', () => {
  const overlap = relateScopes(activityScope(['claim-metric', 'cite-tool-result']), activityScope(['claim-metric', 'open-pr']));
  assert(overlap === 'overlaps', `T6-7：activities 部分交集 → overlaps（實際：${overlap}）`);

  const contains = relateScopes(activityScope(['claim-metric', 'open-pr']), activityScope(['claim-metric']));
  assert(contains === 'contains', `T6-7：activities 涵蓋 → contains（實際：${contains}）`);

  const empty = relateScopes(activityScope([]), activityScope(['claim-metric']));
  assert(empty === 'disjoint', `T6-7：空 activities 不得被當成涵蓋一切（實際：${empty}）`);
});

// ══════════════════════════════════════════════════════════════════════════
// T4：duplicate 與 dangling 總成（三份 registry 都要抓，訊息指名 id 與兩處出處）
// ══════════════════════════════════════════════════════════════════════════

/** 「重複」訊息必須同時說出是哪個 id、以及重複的兩個位置——只說「有重複」修不了。 */
function namesBothSources(f, listKey, first, second) {
  return f.detail.includes(`${listKey}[${first}]`) && f.detail.includes(`${listKey}[${second}]`);
}

testCase('T4-1', 'duplicate：policy id 重複 → 紅且指名 id 與兩處出處', () => {
  const findings = checkPolicyIds(registryOf(
    validPolicy({ id: 'metric-honesty' }),
    validPolicy({ id: 'worktree-isolation' }),
    validPolicy({ id: 'metric-honesty' }),
  ));
  const dup = findings.filter((f) => f.detail.includes('重複'));
  assert(dup.length === 1, `T4-1：只報一次重複（實際：${JSON.stringify(dup)}）`);
  assert(
    dup[0].id === 'metric-honesty' && dup[0].detail.includes('metric-honesty'),
    `T4-1：訊息指名重複的 id（實際：${JSON.stringify(dup[0])}）`,
  );
  assert(
    namesBothSources(dup[0], 'policies', 0, 2),
    `T4-1：訊息指名兩處出處 policies[0] 與 policies[2]（實際：${dup[0].detail}）`,
  );
});

testCase('T4-2', 'duplicate：component id 重複 → 紅且指名 id 與兩處出處', () => {
  const findings = checkComponentIds(componentRegistryOf(
    validComponent({ id: 'registry-compiler' }),
    validComponent({ id: 'loops-path-guard' }),
    validComponent({ id: 'registry-compiler' }),
  ));
  const dup = findings.filter((f) => f.detail.includes('重複'));
  assert(
    dup.length === 1 && dup[0].check === 'component-id' && dup[0].id === 'registry-compiler',
    `T4-2：component id 重複命中且指名 id（實際：${JSON.stringify(dup)}）`,
  );
  assert(
    namesBothSources(dup[0], 'components', 0, 2) && dup[0].file === COMPONENT_REL,
    `T4-2：訊息指名兩處出處與 component-registry 檔（實際：${JSON.stringify(dup[0])}）`,
  );
});

testCase('T4-3', 'duplicate：integration id 重複 → 紅且指名 id 與兩處出處', () => {
  const findings = checkIntegrationIds(integrationRegistryOf(
    validIntegration({ id: 'worktree-cli' }),
    validIntegration({ id: 'forge-cli' }),
    validIntegration({ id: 'worktree-cli' }),
  ));
  const dup = findings.filter((f) => f.detail.includes('重複'));
  assert(
    dup.length === 1 && dup[0].check === 'integration-id' && dup[0].id === 'worktree-cli',
    `T4-3：integration id 重複命中且指名 id（實際：${JSON.stringify(dup)}）`,
  );
  assert(
    namesBothSources(dup[0], 'integrations', 0, 2) && dup[0].file === INTEGRATION_REL,
    `T4-3：訊息指名兩處出處與 integration-registry 檔（實際：${JSON.stringify(dup[0])}）`,
  );

  const green = checkIntegrationIds(integrationRegistryOf(
    validIntegration({ id: 'worktree-cli' }),
    validIntegration({ id: 'forge-cli' }),
  ));
  assert(green.length === 0, `T4-3：id 互異 → 0 finding（實際：${JSON.stringify(green)}）`);
});

testCase('T4-4', 'dangling：policy 的 projection／tests／docs 三個路徑欄位都要抓', () => {
  const registry = registryOf(validPolicy({
    id: 'worktree-isolation',
    projection: ['AGENTS.md'],
    projection_marker: 'x',
    tests: ['plugins/gone-test.mjs'],
    docs: ['docs/gone.md'],
  }));
  const findings = checkPolicyPaths(registry, { pathExists: (rel) => rel === 'AGENTS.md' });
  const fields = ['projection', 'tests', 'docs'].filter(
    (field) => findings.some((f) => f.id === 'worktree-isolation' && f.detail.includes(`"${field}[0]"`)),
  );
  assert(
    fields.join(',') === 'tests,docs',
    `T4-4：只有不存在的 tests[0]／docs[0] 命中，存在的 projection[0] 不誤報（實際命中欄位：${fields.join(',') || '無'}）`,
  );
  assert(
    findings.every((f) => f.check === 'policy-path-exists'),
    `T4-4：命中的都是 policy-path-exists（實際：${JSON.stringify(findings)}）`,
  );
});

testCase('T4-5', 'dangling：component required_checks 三桶與 integration docs 都要抓', () => {
  const componentFindings = checkComponentRequiredChecks(componentRegistryOf(validComponent({
    id: 'loops-path-guard',
    required_checks: {
      hooks: ['hooks/gone.mjs'],
      evals: ['evals/gone.yaml'],
      docs: ['docs/gone.md'],
      integrations: ['worktree-cli'],
    },
  })), { pathExists: () => false });
  for (const bucket of ['hooks', 'evals', 'docs']) {
    assert(
      componentFindings.some((f) => f.id === 'loops-path-guard' && f.detail.includes(`required_checks.${bucket}[0]`)),
      `T4-5：component required_checks.${bucket} dangling 命中（實際：${JSON.stringify(componentFindings)}）`,
    );
  }

  const integrationFindings = checkIntegrationPaths(integrationRegistryOf(validIntegration({
    id: 'forge-cli',
    docs: ['AGENTS.md', 'docs/gone.md'],
  })), { pathExists: (rel) => rel === 'AGENTS.md' });
  assert(
    integrationFindings.length === 1 && integrationFindings[0].id === 'forge-cli'
      && integrationFindings[0].detail.includes('docs[1]') && integrationFindings[0].detail.includes('docs/gone.md'),
    `T4-5：integration 路徑欄位 dangling 命中且指名 id 與索引（實際：${JSON.stringify(integrationFindings)}）`,
  );
});

testCase('T4-6', 'CLI 整合：三份 registry 的重複 id 一次跑出來，各自指名自己的檔案', () => {
  const dir = mkdtempSync(join(tmpdir(), 'regc-'));
  try {
    writeRegistry(dir, POLICY_REL, registryOf(validPolicy({ id: 'dup-rule' }), validPolicy({ id: 'dup-rule' })));
    writeRegistry(dir, COMPONENT_REL, componentRegistryOf(
      validComponent({ id: 'dup-component' }),
      validComponent({ id: 'dup-component' }),
    ));
    writeRegistry(dir, INTEGRATION_REL, integrationRegistryOf(
      validIntegration({ id: 'dup-integration' }),
      validIntegration({ id: 'dup-integration' }),
    ));
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 1, `T4-6：三份都有重複 id → exit 1（實際：${res.status}）`);
    const expected = [
      ['policy-id', POLICY_REL, 'dup-rule'],
      ['component-id', COMPONENT_REL, 'dup-component'],
      ['integration-id', INTEGRATION_REL, 'dup-integration'],
    ];
    for (const [check, file, id] of expected) {
      assert(
        json && json.findings.some((f) => f.check === check && f.file === file && f.id === id && f.detail.includes('重複')),
        `T4-6：--json 含 ${check}（${file}）且指名 id "${id}"（實際：${res.stdout}）`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// T7：衝突三態（compatible／resolved-by-forbid-wins／requires-human-decision）
// ══════════════════════════════════════════════════════════════════════════

/** 同一片 scope、真正互斥、雙方 enforcement 相同且都沒宣告 precedence ⇒ 第三態的最小配方。 */
function conflictingPair(overridesA = {}, overridesB = {}) {
  return [
    validPolicy({
      id: 'rule-a',
      scope: pathScope(['docs/**']),
      forbids: ['auto-generated-docs'],
      ...overridesA,
    }),
    validPolicy({
      id: 'rule-b',
      scope: pathScope(['docs/**']),
      requires: ['auto-generated-docs'],
      ...overridesB,
    }),
  ];
}

testCase('T7-1', '第一態 compatible：scope 重疊但要求不互斥 → 不得報成衝突', () => {
  const [a, b] = [
    validPolicy({ id: 'rule-a', scope: pathScope(['docs/**']), requires: ['front-matter'] }),
    validPolicy({ id: 'rule-b', scope: pathScope(['docs/api/**']), requires: ['changelog-entry'] }),
  ];
  const verdict = classifyConflict(a, b);
  assert(
    verdict.status === 'compatible',
    `T7-1：同 scope 但要求可疊加 → compatible（實際：${verdict.status}／${verdict.reason}）`,
  );
  assert(
    collectPolicyDecisions(registryOf(a, b)).length === 0,
    'T7-1：相容的一對不得進 decisions（否則第三態退化成「凡同 scope 就報」的噪音）',
  );
});

testCase('T7-2', '第一態 compatible：scope 無交集時，即使要求互斥也不是衝突', () => {
  const [a, b] = conflictingPair({ scope: pathScope(['docs/**']) }, { scope: activityScope(['claim-metric']) });
  const verdict = classifyConflict(a, b);
  assert(
    verdict.status === 'compatible',
    `T7-2：跨 kind（P9）不重疊 → compatible（實際：${verdict.status}）`,
  );

  const disjointPaths = classifyConflict(...conflictingPair(
    { scope: pathScope(['docs/**']) },
    { scope: pathScope(['src/**']) },
  ));
  assert(
    disjointPaths.status === 'compatible',
    `T7-2：路徑無交集 → compatible（實際：${disjointPaths.status}）`,
  );
});

testCase('T7-3', '第二態 resolved-by-forbid-wins：一邊 forbid 一邊較寬鬆 → 自動取嚴、不報衝突', () => {
  const [a, b] = conflictingPair({ enforcement: 'forbid' }, { enforcement: 'warn' });
  const verdict = classifyConflict(a, b);
  assert(
    verdict.status === 'resolved-by-forbid-wins',
    `T7-3：forbid vs warn → resolved-by-forbid-wins（實際：${verdict.status}／${verdict.reason}）`,
  );
  assert(
    verdict.winner === 'rule-a' && verdict.resolution === 'forbid-wins',
    `T7-3：取嚴的贏家是 forbid 那條（實際：${JSON.stringify({ winner: verdict.winner, resolution: verdict.resolution })}）`,
  );
  assert(
    collectPolicyDecisions(registryOf(a, b)).length === 0,
    'T7-3：自動取嚴的一對不進 decisions',
  );
});

testCase('T7-4', '第三態 requires-human-decision：真衝突 → 結構化結果進 decisions[]', () => {
  const [a, b] = conflictingPair();
  const verdict = classifyConflict(a, b);
  assert(
    verdict.status === 'requires-human-decision',
    `T7-4：互斥＋enforcement 相同＋precedence 皆 null → 第三態（實際：${verdict.status}）`,
  );

  const decisions = collectPolicyDecisions(registryOf(a, b));
  assert(decisions.length === 1, `T7-4：進 decisions[] 一筆（實際：${JSON.stringify(decisions)}）`);
  const [d] = decisions;
  assert(
    d.kind === 'requires-human-decision' && d.rules.join(',') === 'rule-a,rule-b',
    `T7-4：decision 指名衝突的兩條規則（實際：${JSON.stringify(d)}）`,
  );
  assert(
    typeof d.scope === 'string' && d.scope.includes('docs/**'),
    `T7-4：decision 帶出衝突發生的 scope（實際：${JSON.stringify(d.scope)}）`,
  );
  assert(
    d.reason.includes('auto-generated-docs') && d.reason.includes('precedence'),
    `T7-4：reason 說明互斥的項目與為何機器無從取捨（實際：${d.reason}）`,
  );
});

testCase('T7-5', '第三態的另一個來源是 conflicts_with；宣告 precedence 則自動排序、不進 decisions', () => {
  const declared = conflictingPair(
    { forbids: [], conflicts_with: ['rule-b'] },
    { requires: [] },
  );
  assert(
    classifyConflict(...declared).status === 'requires-human-decision',
    `T7-5：conflicts_with 點名 → 第三態（實際：${classifyConflict(...declared).status}）`,
  );

  const [a, b] = conflictingPair({ precedence: 10 }, { precedence: 20 });
  const verdict = classifyConflict(a, b);
  assert(
    verdict.status === 'resolved-by-forbid-wins' && verdict.resolution === 'declared-precedence' && verdict.winner === 'rule-b',
    `T7-5：precedence 已宣告 → 自動排序且贏家為高 precedence 那條（實際：${JSON.stringify(verdict)}）`,
  );
  assert(collectPolicyDecisions(registryOf(a, b)).length === 0, 'T7-5：已排序的一對不進 decisions');
});

testCase('T7-6', 'CLI 子行程：真衝突 → exit≠0、摘要不得印「無 finding」、decisions 要被渲染', () => {
  const dir = mkdtempSync(join(tmpdir(), 'regc-'));
  try {
    writeRegistry(dir, POLICY_REL, registryOf(...conflictingPair()));

    const { res } = runCli(dir);
    assert(res.status !== 0, `T7-6：真衝突 → exit≠0（實際：${res.status}／${res.stdout}${res.stderr}）`);
    assert(
      !res.stdout.includes('無 finding'),
      `T7-6：不得在有真衝突時印出「無 finding」的全綠摘要（實際：${res.stdout.trim()}）`,
    );
    assert(
      res.stdout.includes('requires-human-decision') && res.stdout.includes('rule-a, rule-b'),
      `T7-6：人讀摘要渲染出 decision 與涉及的規則（實際：${res.stdout.trim()}）`,
    );

    const { res: jsonRes, json } = runCli(dir, ['--json']);
    assert(jsonRes.status !== 0, `T7-6：--json 同樣 exit≠0（實際：${jsonRes.status}）`);
    assert(
      json && json.ok === false && json.findings.length === 0 && json.decisions.length === 1,
      `T7-6：findings 為空但 decisions 非空時 ok 必須是 false（實際：${jsonRes.stdout}）`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

testCase('T7-7', '真實 policy registry 三條規則彼此不衝突（第三態不得對現況誤報）', () => {
  const decisions = collectPolicyDecisions(readRealRegistry().registry);
  assert(decisions.length === 0, `T7-7：真實 registry 無需人決定的衝突（實際：${JSON.stringify(decisions)}）`);
  const result = buildReport(REPO_ROOT);
  assert(
    Array.isArray(result.decisions) && result.decisions.length === 0 && result.ok === true,
    `T7-7：buildReport 的 decisions 為空且全綠（實際：${JSON.stringify(result.decisions)}）`,
  );
});

// ══════════════════════════════════════════════════════════════════════════
// T8：affected-source 查詢（--affected：四類必跑清單 ＋ consumers 傳遞閉包 ＋ unmatched）
// ══════════════════════════════════════════════════════════════════════════

const AFFECTED_KEYS = ['components', 'hooks', 'evals', 'docs', 'integrations', 'unmatched'];

testCase('T8-1', '直接命中：改到某 component 的 paths → 該 component 進 components[]', () => {
  const registry = componentRegistryOf(validComponent({
    id: 'registry-compiler',
    paths: ['plugins/loops-workflow/scripts/registry-compiler.mjs'],
  }));
  const affected = computeAffected(registry, ['plugins/loops-workflow/scripts/registry-compiler.mjs']);
  assert(
    affected.components.join(',') === 'registry-compiler',
    `T8-1：直接命中（實際：${JSON.stringify(affected.components)}）`,
  );
  assert(
    AFFECTED_KEYS.every((key) => Array.isArray(affected[key])),
    `T8-1：輸出含 components／hooks／evals／docs／integrations／unmatched 六個陣列（實際鍵：${Object.keys(affected).join(',')}）`,
  );
});

testCase('T8-2', 'consumers 傳遞閉包：改到被依賴者，下游的下游也要進清單', () => {
  const registry = componentRegistryOf(
    validComponent({ id: 'policy-registry', paths: ['refs/policy.json'], consumers: ['compiler'] }),
    validComponent({ id: 'compiler', paths: ['scripts/compiler.mjs'], dependencies: ['policy-registry'], consumers: ['compiler-tests'] }),
    validComponent({ id: 'compiler-tests', paths: ['scripts/test-compiler.mjs'], dependencies: ['compiler'] }),
  );
  const affected = computeAffected(registry, ['refs/policy.json']);
  assert(
    affected.components.join(',') === 'compiler,compiler-tests,policy-registry',
    `T8-2：沿 consumers 傳遞閉包收到兩層下游（實際：${JSON.stringify(affected.components)}）`,
  );

  const leaf = computeAffected(registry, ['scripts/test-compiler.mjs']);
  assert(
    leaf.components.join(',') === 'compiler-tests',
    `T8-2：葉節點不往上游反推（實際：${JSON.stringify(leaf.components)}）`,
  );
});

testCase('T8-3', '四類必跑清單（含 integrations）都要交付，且去重排序', () => {
  const registry = componentRegistryOf(
    validComponent({
      id: 'policy-registry',
      paths: ['refs/policy.json'],
      consumers: ['guard'],
      required_checks: { hooks: ['hooks/a.mjs'], evals: ['evals/a.yaml'], docs: ['AGENTS.md'], integrations: ['worktree-cli'] },
    }),
    validComponent({
      id: 'guard',
      paths: ['hooks/guard.mjs'],
      dependencies: ['policy-registry'],
      required_checks: { hooks: ['hooks/a.mjs', 'hooks/b.mjs'], evals: [], docs: ['AGENTS.md'], integrations: ['forge-cli'] },
    }),
  );
  const affected = computeAffected(registry, ['refs/policy.json']);
  assert(affected.hooks.join(',') === 'hooks/a.mjs,hooks/b.mjs', `T8-3：hooks 去重且排序（實際：${JSON.stringify(affected.hooks)}）`);
  assert(affected.evals.join(',') === 'evals/a.yaml', `T8-3：evals 收齊（實際：${JSON.stringify(affected.evals)}）`);
  assert(affected.docs.join(',') === 'AGENTS.md', `T8-3：docs 去重（實際：${JSON.stringify(affected.docs)}）`);
  assert(
    affected.integrations.join(',') === 'forge-cli,worktree-cli',
    `T8-3：integrations 也是必跑四類之一，不得漏掉（實際：${JSON.stringify(affected.integrations)}）`,
  );
});

testCase('T8-4', '未命中的路徑列進 unmatched[]，不得靜默回空', () => {
  const registry = componentRegistryOf(validComponent({ id: 'guard', paths: ['hooks/guard.mjs'] }));
  const affected = computeAffected(registry, ['hooks/never-registered.mjs', 'hooks/guard.mjs']);
  assert(
    affected.unmatched.join(',') === 'hooks/never-registered.mjs',
    `T8-4：沒登記的路徑進 unmatched（實際：${JSON.stringify(affected.unmatched)}）`,
  );
  assert(affected.components.join(',') === 'guard', `T8-4：命中的仍照常回報（實際：${JSON.stringify(affected.components)}）`);

  const allUnknown = computeAffected(registry, ['docs/whatever.md']);
  assert(
    allUnknown.components.length === 0 && allUnknown.unmatched.length === 1,
    `T8-4：全部沒命中時不得回一個「什麼都不用跑」的空結果（實際：${JSON.stringify(allUnknown)}）`,
  );
});

testCase('T8-5', 'CLI --affected 是查詢不是 lint：即使有 unmatched，exit code 一律 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'regc-'));
  try {
    writeRegistry(dir, POLICY_REL, registryOf(validPolicy()));
    writeRegistry(dir, COMPONENT_REL, componentRegistryOf(validComponent({ id: 'guard', paths: ['hooks/guard.mjs'] })));
    const { res, json } = runCli(dir, ['--affected', 'hooks/guard.mjs,hooks/ghost.mjs', '--json']);
    assert(res.status === 0, `T8-5：--affected exit 0（實際：${res.status}／${res.stderr}）`);
    assert(
      json && json.components.join(',') === 'guard' && json.unmatched.join(',') === 'hooks/ghost.mjs',
      `T8-5：--json 同時交付命中與 unmatched（實際：${res.stdout}）`,
    );

    const { res: human } = runCli(dir, ['--affected', 'hooks/ghost.mjs']);
    assert(
      human.status === 0 && human.stdout.includes('unmatched') && human.stdout.includes('hooks/ghost.mjs'),
      `T8-5：人讀輸出也要指名 unmatched 的路徑（實際：${human.stdout.trim()}）`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

testCase('T8-6', 'CLI --affected --strict：有 unmatched → exit 1；全部命中 → exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'regc-'));
  try {
    writeRegistry(dir, POLICY_REL, registryOf(validPolicy()));
    writeRegistry(dir, COMPONENT_REL, componentRegistryOf(validComponent({ id: 'guard', paths: ['hooks/guard.mjs'] })));
    const { res: strictRed } = runCli(dir, ['--affected', 'hooks/ghost.mjs', '--strict']);
    assert(strictRed.status === 1, `T8-6：--strict 遇 unmatched → exit 1（實際：${strictRed.status}）`);

    const { res: strictGreen } = runCli(dir, ['--affected', 'hooks/guard.mjs', '--strict']);
    assert(strictGreen.status === 0, `T8-6：--strict 全部命中 → exit 0（實際：${strictGreen.status}／${strictGreen.stdout}）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

testCase('T8-7', '真實 component-registry：改到 policy-registry.json 要連帶跑下游檢查', () => {
  const affected = buildAffectedReport(REPO_ROOT, ['plugins/loops-workflow/references/policy-registry.json']);
  for (const expected of ['policy-registry', 'registry-compiler', 'registry-compiler-tests', 'loops-path-guard']) {
    assert(
      affected.components.includes(expected),
      `T8-7：傳遞閉包含 "${expected}"（實際：${JSON.stringify(affected.components)}）`,
    );
  }
  assert(
    affected.hooks.includes('plugins/loops-workflow/hooks/test-path-guard.mjs')
      && affected.docs.includes('AGENTS.md')
      && affected.integrations.includes('worktree-cli'),
    `T8-7：四類必跑清單從真實 registry 收得出來（實際：${JSON.stringify(affected)}）`,
  );
  assert(affected.unmatched.length === 0, `T8-7：已登記的路徑不進 unmatched（實際：${JSON.stringify(affected.unmatched)}）`);
  assert(
    formatAffected(affected).includes('必跑 integrations'),
    'T8-7：人讀輸出四類齊全（integrations 也要印）',
  );
});

// ══════════════════════════════════════════════════════════════════════════
// T9：registry 檔缺失／JSON 壞掉（都必須紅，且指名是哪一份、壞在哪裡）
// ══════════════════════════════════════════════════════════════════════════

/** JSON 解析錯誤訊息必須換算出行號——對幾百行的 registry，只說「解析失敗」等於要人自己二分搜尋。 */
function reportsLine(detail, line) {
  return detail.includes(`第 ${line} 行`);
}

testCase('T9-1', 'policy registry 缺檔 → 紅並指名是哪一份；子行程不得靜默 exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'regc-'));
  try {
    const report = buildReport(dir);
    assert(
      report.ok === false && report.findings.some((f) => f.check === 'policy-registry-file' && f.detail.includes('policy registry')),
      `T9-1：缺檔命中且指名 policy registry（實際：${JSON.stringify(report.findings)}）`,
    );
    const { res } = runCli(dir);
    assert(res.status === 1, `T9-1：子行程 exit 1（實際：${res.status}／${res.stdout}）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

testCase('T9-2', 'policy registry JSON 壞掉 → 紅、指名檔案與位置，且子行程 exit≠0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'regc-'));
  try {
    writeText(dir, POLICY_REL, '{\n  "schema_version": "1",\n  "policies": [ }\n}\n');
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status !== 0, `T9-2：壞 JSON 不得靜默 exit 0（實際：${res.status}）`);
    const parseFinding = json?.findings.find((f) => f.check === 'policy-registry-parse');
    assert(
      parseFinding && parseFinding.detail.includes(POLICY_REL),
      `T9-2：訊息指名壞掉的是哪一份（實際：${res.stdout}）`,
    );
    assert(
      parseFinding && reportsLine(parseFinding.detail, 3),
      `T9-2：訊息指出壞在第 3 行（實際：${parseFinding?.detail}）`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

testCase('T9-3', 'component registry JSON 壞掉 → 紅、指名 component-registry 與位置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'regc-'));
  try {
    writeRegistry(dir, POLICY_REL, registryOf(validPolicy()));
    writeText(dir, COMPONENT_REL, '{\n  "schema_version": "1",\n  "components": [\n    { "id": "a" \n  ]\n}\n');
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status !== 0, `T9-3：壞 JSON 不得靜默 exit 0（實際：${res.status}）`);
    const parseFinding = json?.findings.find((f) => f.check === 'registry-parse' && f.file === COMPONENT_REL);
    assert(
      parseFinding && parseFinding.detail.includes(COMPONENT_REL) && reportsLine(parseFinding.detail, 5),
      `T9-3：指名 component-registry 與出錯的第 5 行（實際：${res.stdout}）`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

testCase('T9-4', 'integration registry JSON 壞掉 → 紅、指名 integration-registry 與位置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'regc-'));
  try {
    writeRegistry(dir, POLICY_REL, registryOf(validPolicy()));
    writeText(dir, INTEGRATION_REL, '{\n  "schema_version": "1",\n  "integrations": [{]\n}\n');
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status !== 0, `T9-4：壞 JSON 不得靜默 exit 0（實際：${res.status}）`);
    const parseFinding = json?.findings.find((f) => f.check === 'registry-parse' && f.file === INTEGRATION_REL);
    assert(
      parseFinding && parseFinding.detail.includes(INTEGRATION_REL) && reportsLine(parseFinding.detail, 3),
      `T9-4：指名 integration-registry 與出錯的第 3 行（實際：${res.stdout}）`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

testCase('T9-5', 'component／integration 缺檔：檢查沒跑就要在 notes 指名哪一份被跳過', () => {
  const dir = mkdtempSync(join(tmpdir(), 'regc-'));
  try {
    writeRegistry(dir, POLICY_REL, registryOf(validPolicy()));
    const report = buildReport(dir);
    assert(
      report.notes.some((n) => n.includes('skipped') && n.includes(COMPONENT_REL)),
      `T9-5：component registry 缺席要指名（實際：${JSON.stringify(report.notes)}）`,
    );
    assert(
      report.notes.some((n) => n.includes('skipped') && n.includes(INTEGRATION_REL)),
      `T9-5：integration registry 缺席要指名（實際：${JSON.stringify(report.notes)}）`,
    );
    const { res } = runCli(dir);
    assert(
      res.stdout.includes('skipped'),
      `T9-5：人讀輸出也要看得到「哪一份沒跑」（實際：${res.stdout.trim()}）`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// T10：常見 bypass（空陣列恆真／大小寫空白/空字串繞過／自我引用／型別錯誤的目標）
// ══════════════════════════════════════════════════════════════════════════

testCase('T10-1', '空陣列不得恆真：三份 registry 的清單為空一律紅', () => {
  const policyFindings = checkPolicyShape({ schema_version: '1', policies: [] });
  assert(
    policyFindings.some((f) => f.detail.includes('"policies"') && f.detail.includes('空陣列')),
    `T10-1：policies:[] 命中（實際：${JSON.stringify(policyFindings)}）`,
  );
  assert(
    checkPolicies({ schema_version: '1', policies: [] }, ALL_PATHS_EXIST).findings.length > 0,
    'T10-1：policies:[] 不得讓整組 policy 檢查變成「無 finding」',
  );

  const componentFindings = checkComponentShape({ schema_version: '1', components: [] });
  assert(
    componentFindings.some((f) => f.detail.includes('"components"') && f.detail.includes('空陣列')),
    `T10-1：components:[] 命中（實際：${JSON.stringify(componentFindings)}）`,
  );

  const integrationFindings = checkIntegrationShape({ schema_version: '1', integrations: [] });
  assert(
    integrationFindings.some((f) => f.detail.includes('"integrations"') && f.detail.includes('空陣列')),
    `T10-1：integrations:[] 命中（實際：${JSON.stringify(integrationFindings)}）`,
  );
});

testCase('T10-2', 'id 只差大小寫或前後空白 → 視為重複，三份都要抓', () => {
  const policyFindings = checkPolicyIds(registryOf(
    validPolicy({ id: 'foo-bar' }),
    validPolicy({ id: 'Foo-Bar' }),
  ));
  assert(
    policyFindings.some((f) => f.detail.includes('大小寫') && f.detail.includes('Foo-Bar') && f.detail.includes('foo-bar')),
    `T10-2："Foo-Bar" vs "foo-bar" 視為重複（實際：${JSON.stringify(policyFindings)}）`,
  );

  const componentFindings = checkComponentIds(componentRegistryOf(
    validComponent({ id: 'foo' }),
    validComponent({ id: ' foo' }),
  ));
  assert(
    componentFindings.some((f) => f.detail.includes('前後空白') && f.detail.includes('components[1]')),
    `T10-2：" foo" 的前後空白被抓且指名位置（實際：${JSON.stringify(componentFindings)}）`,
  );
  assert(
    componentFindings.some((f) => f.detail.includes('重複')),
    `T10-2：" foo" 與 "foo" 視為重複（實際：${JSON.stringify(componentFindings)}）`,
  );

  const integrationFindings = checkIntegrationIds(integrationRegistryOf(
    validIntegration({ id: 'forge-cli' }),
    validIntegration({ id: 'FORGE-CLI ' }),
  ));
  assert(
    integrationFindings.filter((f) => f.detail.includes('重複') || f.detail.includes('前後空白')).length === 2,
    `T10-2：integration 的大小寫＋空白差異都被抓（實際：${JSON.stringify(integrationFindings)}）`,
  );
});

testCase('T10-3', '宣告了欄位但值為空字串 → 紅（空字串是「假裝有填」的繞過口）', () => {
  const markerFindings = checkPolicyProjectionMarkers(
    registryOf(validPolicy({ id: 'metric-honesty', projection: [], projection_marker: '' })),
    { readText: () => '任何文字都含有空字串' },
  );
  assert(
    markerFindings.some((f) => f.id === 'metric-honesty' && f.detail.includes('projection_marker')),
    `T10-3：projection_marker:"" 命中（實際：${JSON.stringify(markerFindings)}）`,
  );

  const stageRole = checkComponentShape(componentRegistryOf(validComponent({ stage_role: '' })));
  assert(
    stageRole.some((f) => f.detail.includes('stage_role')),
    `T10-3：stage_role:"" 命中（實際：${JSON.stringify(stageRole)}）`,
  );

  const group = checkIntegrationShape(integrationRegistryOf(validIntegration({ exclusive_group: '' })));
  assert(
    group.some((f) => f.detail.includes('exclusive_group')),
    `T10-3：exclusive_group:"" 命中——否則互斥組會被一個空字串整條略過（實際：${JSON.stringify(group)}）`,
  );
});

testCase('T10-4', '循環自我引用：dependencies 與 consumers 都自指也不得矇混過關', () => {
  const registry = componentRegistryOf(validComponent({ id: 'self', dependencies: ['self'], consumers: ['self'] }));
  assert(
    checkComponentReciprocity(registry).length === 0,
    'T10-4：自指的一筆在雙向一致檢查下是「合法」的——所以環偵測是唯一能抓到它的關卡',
  );
  const findings = checkComponents(registry, ALL_PATHS_EXIST);
  assert(
    findings.some((f) => f.check === 'component-cycle' && f.id === 'self' && f.detail.includes('self → self')),
    `T10-4：自我引用被環偵測抓到且指名 id（實際：${JSON.stringify(findings)}）`,
  );
});

testCase('T10-5', '目標存在但型別錯誤（projection 指向目錄）→ 紅，訊息說清楚不是檔案', () => {
  const findings = checkPolicyPaths(
    registryOf(validPolicy({ id: 'worktree-isolation', projection: ['docs'] })),
    { pathExists: () => true, isFile: (rel) => rel !== 'docs' },
  );
  assert(
    findings.some((f) => f.id === 'worktree-isolation' && f.detail.includes('projection[0]') && f.detail.includes('不是檔案')),
    `T10-5：指向目錄命中且指名 id 與欄位（實際：${JSON.stringify(findings)}）`,
  );

  const dir = mkdtempSync(join(tmpdir(), 'regc-'));
  try {
    writeRegistry(dir, POLICY_REL, registryOf(validPolicy({
      id: 'worktree-isolation',
      projection: ['docs'],
      projection_marker: 'worktree',
    })));
    mkdirSync(join(dir, 'docs'), { recursive: true });
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 1, `T10-5：CLI 對「存在但是目錄」的目標 → exit 1（實際：${res.status}）`);
    assert(
      json && json.findings.some((f) => f.check === 'policy-path-exists' && f.detail.includes('不是檔案')),
      `T10-5：--json 指名型別錯誤（實際：${res.stdout}）`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

testCase('T10-6', 'CLI：空 registry 不得 exit 0（一條都沒登記＝檢查全體恆真）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'regc-'));
  try {
    writeRegistry(dir, POLICY_REL, { schema_version: '1', policies: [] });
    writeRegistry(dir, COMPONENT_REL, { schema_version: '1', components: [] });
    writeRegistry(dir, INTEGRATION_REL, { schema_version: '1', integrations: [] });
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 1, `T10-6：三份都空 → exit 1（實際：${res.status}／${res.stdout}）`);
    const emptyChecks = (json?.findings ?? []).filter((f) => f.detail.includes('空陣列')).map((f) => f.file);
    for (const rel of [POLICY_REL, COMPONENT_REL, INTEGRATION_REL]) {
      assert(emptyChecks.includes(rel), `T10-6：${rel} 的空清單被指名（實際：${JSON.stringify(emptyChecks)}）`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

testCase('T12-1', 'checkPolicyTiers（#173）：tier 與執行綁定必須自洽', () => {
  const ok = checkPolicyTiers(registryOf(validPolicy()));
  assert(ok.length === 0, `advisory + 無 runtime → 無 finding（實際：${JSON.stringify(ok)}）`);

  const noTier = checkPolicyTiers(registryOf(validPolicy({ tier: undefined })));
  assert(noTier.some((f) => f.check === 'policy-tier'), '缺 tier → policy-tier finding');

  const hardNoGuard = checkPolicyTiers(registryOf(validPolicy({ tier: 'hard-invariant', runtime: null })));
  assert(hardNoGuard.some((f) => f.check === 'policy-runtime-binding'), 'tier 1 缺 guard → policy-runtime-binding finding（沒有執行者的 hard rule 是自欺）');

  const advisoryWithGuard = checkPolicyTiers(registryOf(validPolicy({ tier: 'advisory', runtime: { guard: 'some-hook', protected_actions: ['x'] } })));
  assert(advisoryWithGuard.some((f) => f.check === 'policy-tier' && f.detail.includes('advisory')), 'advisory 綁 guard → 紅（會讓人誤以為它擋得住）');

  const wrongEvaluator = checkPolicyTiers(registryOf(validPolicy({ tier: 'advisory', evaluator: 'promptfoo' })));
  assert(wrongEvaluator.some((f) => f.check === 'policy-tier' && f.detail.includes('evaluator')), '非 semantic 卻指名 evaluator → 紅');

  const semanticOk = checkPolicyTiers(registryOf(validPolicy({ tier: 'semantic', evaluator: 'promptfoo' })));
  assert(semanticOk.length === 0, '反向：semantic + evaluator → 無 finding（殺掉「恆紅」的實作）');
});

testCase('T12-2', 'checkPolicies 已把 tier 檢查接進既有 gate（不是另開一支沒人跑的腳本）', () => {
  const { findings } = checkPolicies(registryOf(validPolicy({ tier: undefined })), { readText: () => 'x', pathExists: () => true });
  assert(findings.some((f) => f.check === 'policy-tier'), '缺 tier 會讓 checkPolicies 直接紅');
});

// ══════════════════════════════════════════════════════════════════════════
// 執行（含 --filter 與 --min-cases 地板）
// ══════════════════════════════════════════════════════════════════════════
const opts = parseArgs(process.argv.slice(2));
const selected = cases.filter((c) => c.id.startsWith(opts.filter));

for (const c of selected) {
  console.log(`\n[${c.id}] ${c.name}`);
  c.fn();
}

console.log(`\n${selected.length} cases run, ${passed} passed, ${failed.length} failed`);

if (opts.minCases > 0 && selected.length < opts.minCases) {
  console.error(`\n✗ case 數地板未達成：--min-cases ${opts.minCases}，實際跑到 ${selected.length}（filter="${opts.filter}"）`);
  process.exit(1);
}

if (failed.length > 0) {
  console.error('\n失敗清單：');
  for (const msg of failed) console.error(`  - ${msg}`);
  process.exit(1);
}
process.exit(0);
