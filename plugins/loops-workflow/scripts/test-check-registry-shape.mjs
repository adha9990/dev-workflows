#!/usr/bin/env node
// test-check-registry-shape.mjs —— check-registry-shape.mjs 的紅綠單元 + IO/CLI 整合斷言。
// 用法：node test-check-registry-shape.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1（主線用此 exit code 判紅綠）。
//
// 預期 Red：check-registry-shape.mjs 與 references/capability-registry.json 尚未實作，
// 下面的 import 會 ERR_MODULE_NOT_FOUND，整個檔在載入期就丟例外 → node 以非 0 退出。
// 這就是 TDD 的紅燈起點。
//
// 場景對映（references/bdd-scenarios.md 的 GWT 慣例）：
//   S4：capability-registry.json 機械可讀且對帳（facet 身分、fallback/repro、overrides 完整性）
//   S8：agent 分層（tier）與 model_tier 一致
//   S9：agent_effort 與 agents/*.md frontmatter 不漂移

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  parseRegistryJson,
  checkFacetIdentity,
  checkDescriptorFallback,
  checkDescriptorRepro,
  checkAgentTiers,
  checkOverrides,
  checkRegistry,
  formatSummary,
} from './check-registry-shape.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = fileURLToPath(new URL('./check-registry-shape.mjs', import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures', 'registry-shape');
const AGENTS_DIR = join(HERE, '..', 'agents');
const REPO_ROOT = join(HERE, '..', '..', '..'); // scripts -> loops-workflow -> plugins -> repo root

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'));
}

// 10 個規定的 facet 身分（順序不拘，但鍵集合要「恰好」等於這 10 個）
const EXPECTED_FACETS = [
  'plugin_root',
  'skill_discovery',
  'structured_question',
  'subagent_dispatch',
  'model_tier',
  'hook_events',
  'hook_concurrency',
  'shell_file_transport',
  'worktree_and_state',
  'transcript_metrics',
];

// ══════════════════════════════════════════════════════════════════════════
// 真實 repo agents/ 目錄的實況（用來對真實資料跑 I8 漂移偵測，S8/S9）
// ══════════════════════════════════════════════════════════════════════════
function readActualAgentNames() {
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => basename(f, '.md'));
}

function readActualAgentEffort() {
  const map = {};
  for (const name of readActualAgentNames()) {
    const content = readFileSync(join(AGENTS_DIR, `${name}.md`), 'utf8');
    const m = content.match(/^effort:\s*(\S+)\s*$/m);
    map[name] = m ? m[1] : null;
  }
  return map;
}

const ACTUAL_AGENT_NAMES = readActualAgentNames();
const ACTUAL_AGENT_EFFORT = readActualAgentEffort();

// ══════════════════════════════════════════════════════════════════════════
// 0. parseRegistryJson
// ══════════════════════════════════════════════════════════════════════════
{
  const r = parseRegistryJson('{"schema_version":"1","facets":{}}');
  assert(r && r.registry && r.registry.schema_version === '1', 'parseRegistryJson：合法 JSON → registry 物件 [S4-parse-a]');
  assert(!r.error, 'parseRegistryJson：合法 JSON → 無 error [S4-parse-a]');
}
{
  const r = parseRegistryJson('{not valid json');
  assert(r && typeof r.error === 'string', 'parseRegistryJson：壞 JSON → 回傳 {error} [S4-parse-b]');
}

// ══════════════════════════════════════════════════════════════════════════
// 1. checkFacetIdentity（facet 鍵集合恰好等於 10 個規定 id）
// ══════════════════════════════════════════════════════════════════════════
{
  const registry = loadFixture('registry-valid-full.json');
  const findings = checkFacetIdentity(registry);
  assert(
    Array.isArray(findings) && findings.length === 0,
    `checkFacetIdentity：合法 10 個 facet → 0 筆 finding（實際：${JSON.stringify(findings)}）[S4-facet-identity-a]`,
  );
}
{
  // hook_events 被改名成 hook_event（少了尾巴 s）——驗身分要抓出「換掉其中一個名字」
  const registry = loadFixture('registry-facet-renamed.json');
  const findings = checkFacetIdentity(registry);
  assert(
    findings.some((f) => f.check === 'facet-identity'),
    `checkFacetIdentity：facet 鍵被改名 → 命中 facet-identity（實際：${JSON.stringify(findings)}）[S4-facet-identity-b]`,
  );
  assert(
    findings.some((f) => f.detail.includes('hook_events') || f.detail.includes('hook_event')),
    `checkFacetIdentity：finding detail 要指出是哪個 facet 名字出問題（實際：${JSON.stringify(findings)}）[S4-facet-identity-b]`,
  );
}
{
  // 只是缺數量不同 facet 但鍵集合仍不等——驗證不是只驗數量：拿掉一個、加一個不同名字的，數量相同但集合不同
  const registry = {
    facets: {
      plugin_root: {}, skill_discovery: {}, structured_question: {}, subagent_dispatch: {},
      model_tier: {}, hook_events: {}, hook_concurrency: {}, shell_file_transport: {},
      worktree_and_state: {}, transcript_metrics_v2: {}, // 最後一個改了名字，數量仍是 10
    },
  };
  const findings = checkFacetIdentity(registry);
  assert(
    findings.some((f) => f.check === 'facet-identity'),
    `checkFacetIdentity：數量對但集合不同（transcript_metrics→transcript_metrics_v2）仍要命中（實際：${JSON.stringify(findings)}）[S4-facet-identity-c]`,
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 2. checkDescriptorFallback（I5：`status !== 'supported'` ⇒ fallback 必須非空——
//    這條對 not_supported / degraded / not_measured 三種非 supported 狀態一視同仁，
//    不是「只有 not_supported/degraded 才要」。I5 與 I6（repro）並存、不互斥：
//    not_measured 的 descriptor 必須同時有 fallback（量出來之前怎麼辦）與
//    repro（怎麼去量），見 S5 場景——「unsupported / not measured」都要有明確 fallback
//    或安全停，不得靜默假裝已執行。）
// ══════════════════════════════════════════════════════════════════════════
{
  const registry = loadFixture('registry-valid-full.json');
  const findings = checkDescriptorFallback(registry);
  assert(
    Array.isArray(findings) && findings.length === 0,
    `checkDescriptorFallback：非 supported 的 descriptor（含 not_measured）皆有 fallback → 0 筆 finding（實際：${JSON.stringify(findings)}）[S4-I5-a]`,
  );
}
{
  const registry = loadFixture('registry-fallback-missing.json');
  const findings = checkDescriptorFallback(registry);
  assert(
    findings.some((f) => f.check === 'descriptor-fallback' && f.detail.includes('hook_events')),
    `checkDescriptorFallback：codex not_supported 缺 fallback → 命中且指名 hook_events（實際：${JSON.stringify(findings)}）[S4-I5-b]`,
  );
}
{
  // S5 回歸測試：not_measured 也要有 fallback，不能因為有 repro 就免責。
  // 這是本次修正的缺陷根因——之前的 valid fixture 誤放了「not_measured 缺 fallback」
  // 進通過集合，導致實作把 I5 誤縮成只管 not_supported/degraded。
  const registry = loadFixture('registry-not-measured-missing-fallback.json');
  const findings = checkDescriptorFallback(registry);
  assert(
    findings.some((f) => f.check === 'descriptor-fallback' && f.detail.includes('transcript_metrics')),
    `checkDescriptorFallback：codex not_measured 缺 fallback（雖有 repro）→ 仍要命中且指名 transcript_metrics（實際：${JSON.stringify(findings)}）[S5-not-measured-fallback]`,
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 3. checkDescriptorRepro（I6：status === 'not_measured' → repro 必須非空）
// ══════════════════════════════════════════════════════════════════════════
{
  const registry = loadFixture('registry-valid-full.json');
  const findings = checkDescriptorRepro(registry);
  assert(
    Array.isArray(findings) && findings.length === 0,
    `checkDescriptorRepro：not_measured 的 descriptor 皆有 repro → 0 筆 finding（實際：${JSON.stringify(findings)}）[S4-I6-a]`,
  );
}
{
  const registry = loadFixture('registry-repro-missing.json');
  const findings = checkDescriptorRepro(registry);
  assert(
    findings.some((f) => f.check === 'descriptor-repro' && f.detail.includes('transcript_metrics')),
    `checkDescriptorRepro：codex not_measured 缺 repro → 命中且指名 transcript_metrics（實際：${JSON.stringify(findings)}）[S4-I6-b]`,
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 4. checkAgentTiers（I8：agent_tiers/agent_effort 鍵集合對帳 agents/*.md，
//    值對帳 model_tier 鍵與 frontmatter effort。對真實 repo 的 25 支 agent 跑，S8/S9）
// ══════════════════════════════════════════════════════════════════════════
{
  // 先確認測試自己讀到的「真實 repo 現況」符合任務描述（25 支、high×5/medium×19/low×1），
  // 這樣後面拿它當 valid fixture 的 context 才站得住腳
  assert(ACTUAL_AGENT_NAMES.length === 25, `真實 agents/ 目錄恰有 25 支 .md（實際：${ACTUAL_AGENT_NAMES.length}）[S8-precondition]`);
  const efforts = Object.values(ACTUAL_AGENT_EFFORT);
  assert(efforts.filter((e) => e === 'high').length === 5, 'S8-precondition：真實 effort high 恰 5 支');
  assert(efforts.filter((e) => e === 'medium').length === 19, 'S8-precondition：真實 effort medium 恰 19 支');
  assert(efforts.filter((e) => e === 'low').length === 1, 'S8-precondition：真實 effort low 恰 1 支');
}
{
  const registry = loadFixture('registry-valid-full.json');
  const findings = checkAgentTiers(registry, { agentNames: ACTUAL_AGENT_NAMES, effortByAgent: ACTUAL_AGENT_EFFORT });
  assert(
    Array.isArray(findings) && findings.length === 0,
    `checkAgentTiers：對真實 25 支 agent 現況 → 0 筆 finding（實際：${JSON.stringify(findings)}）[S8-S9-a]`,
  );
}
{
  // 拿掉 eval-judge 這把鑰匙 → agent_tiers 鍵集合對不上真實 25 支 → 命中
  const registry = loadFixture('registry-agent-tiers-missing-key.json');
  const findings = checkAgentTiers(registry, { agentNames: ACTUAL_AGENT_NAMES, effortByAgent: ACTUAL_AGENT_EFFORT });
  assert(
    findings.some((f) => f.check === 'agent-tier-keys' && f.detail.includes('eval-judge')),
    `checkAgentTiers：agent_tiers 缺 eval-judge 鍵 → 命中 agent-tier-keys 且指名（實際：${JSON.stringify(findings)}）[S8-b]`,
  );
}
{
  // eval-judge 的 agent_effort 被改成 medium，但真實 frontmatter 是 low → 值不對帳，命中
  const registry = loadFixture('registry-agent-effort-wrong-value.json');
  const findings = checkAgentTiers(registry, { agentNames: ACTUAL_AGENT_NAMES, effortByAgent: ACTUAL_AGENT_EFFORT });
  assert(
    findings.some((f) => f.check === 'agent-effort-value' && f.detail.includes('eval-judge')),
    `checkAgentTiers：agent_effort['eval-judge'] 與真實 frontmatter（low）不符 → 命中 agent-effort-value（實際：${JSON.stringify(findings)}）[S9-c]`,
  );
}
{
  // eval-judge 的 tier 值改成一個 model_tier 裡不存在的 tier id → 命中
  const registry = loadFixture('registry-agent-tier-bad-value.json');
  const findings = checkAgentTiers(registry, { agentNames: ACTUAL_AGENT_NAMES, effortByAgent: ACTUAL_AGENT_EFFORT });
  assert(
    findings.some((f) => f.check === 'agent-tier-value' && f.detail.includes('eval-judge')),
    `checkAgentTiers：agent_tiers['eval-judge']='nonexistent-tier' 不在 model_tier 鍵中 → 命中 agent-tier-value（實際：${JSON.stringify(findings)}）[S8-d]`,
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 5. checkOverrides（overrides 非空 + I15：owner/rationale/test_ref 非空、
//    test_ref 與 scope 指向的檔案要真的存在）
// ══════════════════════════════════════════════════════════════════════════
function realPathExists(relPath) {
  return existsSync(join(REPO_ROOT, relPath));
}
{
  const registry = loadFixture('registry-valid-full.json');
  const findings = checkOverrides(registry, { pathExists: realPathExists });
  assert(
    Array.isArray(findings) && findings.length === 0,
    `checkOverrides：合法 overrides（欄位齊全、路徑真實存在）→ 0 筆 finding（實際：${JSON.stringify(findings)}）[S4-I15-a]`,
  );
}
{
  const registry = loadFixture('registry-overrides-empty.json');
  const findings = checkOverrides(registry, { pathExists: realPathExists });
  assert(
    findings.some((f) => f.check === 'overrides-non-empty'),
    `checkOverrides：overrides 清空 → 命中 overrides-non-empty（實際：${JSON.stringify(findings)}）[S4-overrides-empty]`,
  );
}
{
  const registry = loadFixture('registry-overrides-missing-fields.json');
  const findings = checkOverrides(registry, { pathExists: realPathExists });
  assert(
    findings.some((f) => f.check === 'overrides-fields' && f.detail.includes('owner')),
    `checkOverrides：owner 空字串 → 命中 overrides-fields 且指出 owner（實際：${JSON.stringify(findings)}）[S4-I15-b]`,
  );
  assert(
    findings.some((f) => f.check === 'overrides-fields' && f.detail.includes('rationale')),
    `checkOverrides：rationale 空字串 → 命中 overrides-fields 且指出 rationale（實際：${JSON.stringify(findings)}）[S4-I15-b]`,
  );
}
{
  const registry = loadFixture('registry-overrides-bad-test-ref.json');
  const findings = checkOverrides(registry, { pathExists: realPathExists });
  assert(
    findings.some((f) => f.check === 'overrides-test-ref-exists'),
    `checkOverrides：test_ref 指向不存在的檔案 → 命中 overrides-test-ref-exists（實際：${JSON.stringify(findings)}）[S4-I15-c]`,
  );
}
{
  const registry = loadFixture('registry-overrides-bad-scope.json');
  const findings = checkOverrides(registry, { pathExists: realPathExists });
  assert(
    findings.some((f) => f.check === 'overrides-scope-exists'),
    `checkOverrides：scope 指向不存在的檔案 → 命中 overrides-scope-exists（實際：${JSON.stringify(findings)}）[S4-overrides-scope]`,
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 6. checkRegistry（彙整器）＋ formatSummary
// ══════════════════════════════════════════════════════════════════════════
{
  const registry = loadFixture('registry-valid-full.json');
  const result = checkRegistry(registry, {
    agentNames: ACTUAL_AGENT_NAMES,
    effortByAgent: ACTUAL_AGENT_EFFORT,
    pathExists: realPathExists,
  });
  assert(result && result.ok === true, `checkRegistry：全合法 fixture → ok===true（實際：${JSON.stringify(result)}）[S4-aggregate-a]`);
  assert(Array.isArray(result.findings) && result.findings.length === 0, 'checkRegistry：全合法 fixture → findings===[] [S4-aggregate-a]');
}
{
  const registry = loadFixture('registry-facet-renamed.json');
  const result = checkRegistry(registry, {
    agentNames: ACTUAL_AGENT_NAMES,
    effortByAgent: ACTUAL_AGENT_EFFORT,
    pathExists: realPathExists,
  });
  assert(result && result.ok === false, `checkRegistry：facet 被改名的 fixture → ok===false（實際：${JSON.stringify(result)}）[S4-aggregate-b]`);
  assert(result.findings.length > 0, 'checkRegistry：facet 被改名的 fixture → findings 非空 [S4-aggregate-b]');
}
{
  const summary = formatSummary({ ok: true, findings: [] });
  assert(typeof summary === 'string' && summary.includes('✓'), 'formatSummary：ok===true → 含 ✓ [S4-summary-a]');
}
{
  const summary = formatSummary({ ok: false, findings: [{ check: 'facet-identity', detail: 'x 缺失' }] });
  assert(typeof summary === 'string' && summary.includes('✗'), 'formatSummary：ok===false → 含 ✗ [S4-summary-b]');
}

// ══════════════════════════════════════════════════════════════════════════
// IO/CLI 整合（spawnSync 真跑 check-registry-shape.mjs --root <repo根>）
// 用合成的最小 registry + 2 支合成 agent，跟真實 25 支 agent 解耦，讓 CLI 級測試輕量、可控。
// ══════════════════════════════════════════════════════════════════════════
function writeFiles(root, filesObj) {
  for (const [rel, content] of Object.entries(filesObj)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
}

function jsonFile(obj) {
  return JSON.stringify(obj, null, 2);
}

function syntheticFacets() {
  const facets = {};
  for (const id of EXPECTED_FACETS) {
    facets[id] = {
      description: `${id} 的說明`,
      gaps_refs: [],
      platforms: {
        claude: { status: 'supported', measurability: 'login_free', interface: 'cli', fallback: '', repro: '' },
        codex: { status: 'supported', measurability: 'login_free', interface: 'cli', fallback: '', repro: '' },
      },
    };
  }
  return facets;
}

function syntheticRegistry() {
  return {
    schema_version: '1',
    facets: syntheticFacets(),
    overrides: [
      {
        id: 'sample-override',
        runtime: 'codex',
        scope: 'plugins/loops-workflow/agents/agent-a.md',
        owner: 'team-x',
        rationale: '合成 fixture 的 override 理由',
        test_ref: 'plugins/loops-workflow/scripts/test-check-registry-shape.mjs',
      },
    ],
    deferred: [],
    model_tier: {
      'broad-review': { claude: { model: 'sonnet' }, codex: { model: 'gpt-5-codex', status: 'supported' } },
      implementation: { claude: { model: 'sonnet' }, codex: { model: 'gpt-5-codex', status: 'supported' } },
    },
    agent_tiers: {
      'agent-a': 'broad-review',
      'agent-b': 'implementation',
    },
    agent_effort: {
      'agent-a': 'medium',
      'agent-b': 'high',
    },
  };
}

function baselineCliFiles() {
  return {
    'plugins/loops-workflow/references/capability-registry.json': jsonFile(syntheticRegistry()),
    'plugins/loops-workflow/agents/agent-a.md': '---\nname: agent-a\neffort: medium\n---\n# agent-a\n',
    'plugins/loops-workflow/agents/agent-b.md': '---\nname: agent-b\neffort: high\n---\n# agent-b\n',
    // test_ref / scope 指向的檔案，本 repo 內真實存在，故用相對路徑複寫到暫存 root 下對應位置
    'plugins/loops-workflow/scripts/test-check-registry-shape.mjs': '# placeholder for test_ref existence check\n',
  };
}

function makeCliRepo(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'crs-'));
  writeFiles(dir, { ...baselineCliFiles(), ...extra });
  return dir;
}

function runCli(root, args = ['--json']) {
  const res = spawnSync('node', [SCRIPT, '--root', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  let json = null;
  if (args.includes('--json')) {
    try {
      json = JSON.parse(res.stdout);
    } catch {
      json = null;
    }
  }
  return { res, json };
}

// IO-1：合成健康 repo → 綠
{
  const dir = makeCliRepo();
  try {
    const { res, json } = runCli(dir, ['--json']);
    assert(res.error == null, 'IO-1：node 啟動成功（spawn 無 error）[S4-IO-1]');
    assert(res.status === 0, `IO-1：健康合成 repo → exit code===0（實際 stdout：${res.stdout}；stderr：${res.stderr}）[S4-IO-1]`);
    assert(json && json.ok === true, `IO-1：--json ok===true（實際：${JSON.stringify(json)}）[S4-IO-1]`);
    assert(json && Array.isArray(json.findings) && json.findings.length === 0, 'IO-1：--json findings===[] [S4-IO-1]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-2：capability-registry.json 檔案存在但壞 JSON → 紅，走 parse error 分支
{
  const files = baselineCliFiles();
  files['plugins/loops-workflow/references/capability-registry.json'] = '{this is not valid json';
  const dir = mkdtempSync(join(tmpdir(), 'crs-'));
  writeFiles(dir, files);
  try {
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 1, 'IO-2：壞 JSON → exit code===1 [S4-IO-2]');
    assert(
      json === null || (json && Array.isArray(json.findings)),
      `IO-2：--json 仍輸出可解析的錯誤結構，或至少非 0 exit（實際 stdout：${res.stdout}）[S4-IO-2]`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-3：facet 鍵被改名（少一個規定 facet、多一個不明 facet）→ 紅，命中 facet-identity
{
  const registry = syntheticRegistry();
  delete registry.facets.hook_events;
  registry.facets.hook_event = registry.facets.hook_concurrency; // 改名成不在規定清單內的 key
  const files = baselineCliFiles();
  files['plugins/loops-workflow/references/capability-registry.json'] = jsonFile(registry);
  const dir = mkdtempSync(join(tmpdir(), 'crs-'));
  writeFiles(dir, files);
  try {
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 1, 'IO-3：facet 鍵被改名 → exit code===1 [S4-IO-3]');
    assert(
      json && json.findings.some((f) => f.check === 'facet-identity'),
      `IO-3：--json findings 含 facet-identity（實際：${JSON.stringify(json)}）[S4-IO-3]`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-4：overrides 被清空 → 紅，命中 overrides-non-empty
{
  const registry = syntheticRegistry();
  registry.overrides = [];
  const files = baselineCliFiles();
  files['plugins/loops-workflow/references/capability-registry.json'] = jsonFile(registry);
  const dir = mkdtempSync(join(tmpdir(), 'crs-'));
  writeFiles(dir, files);
  try {
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 1, 'IO-4：overrides 清空 → exit code===1 [S4-IO-4]');
    assert(
      json && json.findings.some((f) => f.check === 'overrides-non-empty'),
      `IO-4：--json findings 含 overrides-non-empty（實際：${JSON.stringify(json)}）[S4-IO-4]`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-5：agent_tiers 鍵集合對不上 agents/ 目錄實況（拿掉 agent-a.md）→ 紅，命中 agent-tier-keys
{
  const files = baselineCliFiles();
  delete files['plugins/loops-workflow/agents/agent-a.md'];
  const dir = mkdtempSync(join(tmpdir(), 'crs-'));
  writeFiles(dir, files);
  try {
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 1, 'IO-5：agents/ 目錄缺 agent-a.md → exit code===1 [S8-IO-5]');
    assert(
      json && json.findings.some((f) => f.check === 'agent-tier-keys'),
      `IO-5：--json findings 含 agent-tier-keys（實際：${JSON.stringify(json)}）[S8-IO-5]`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-6：agent_effort 值與 frontmatter 漂移（agent-a.md 改成 high，registry 仍寫 medium）→ 紅
{
  const files = baselineCliFiles();
  files['plugins/loops-workflow/agents/agent-a.md'] = '---\nname: agent-a\neffort: high\n---\n# agent-a\n';
  const dir = mkdtempSync(join(tmpdir(), 'crs-'));
  writeFiles(dir, files);
  try {
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 1, 'IO-6：agent-a effort 漂移（frontmatter high、registry medium）→ exit code===1 [S9-IO-6]');
    assert(
      json && json.findings.some((f) => f.check === 'agent-effort-value'),
      `IO-6：--json findings 含 agent-effort-value（實際：${JSON.stringify(json)}）[S9-IO-6]`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-7：非 --json 模式，健康 repo 印出繁體中文成功摘要，exit 0
{
  const dir = makeCliRepo();
  try {
    const { res } = runCli(dir, []);
    assert(res.status === 0, `IO-7：健康合成 repo（非 --json）→ exit code===0（實際 stdout：${res.stdout}）[S4-IO-7]`);
    assert(res.stdout.length > 0, 'IO-7：非 --json 模式仍印出摘要文字（非空 stdout）[S4-IO-7]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-8（S4 對真實交付物）：不帶 --registry / --agents-dir，對本 repo 真實預設路徑跑，
// 驗 check-registry-shape.mjs 讀到的是真的 plugins/loops-workflow/references/capability-registry.json
// 且對真實 25 支 agent 全過。這條在 capability-registry.json 尚未建立前必然紅（檔案不存在），
// 是本任務的核心紅燈：實作者必須同時交付合格的 references/capability-registry.json 才能讓它轉綠。
{
  const res = spawnSync('node', [SCRIPT, '--root', REPO_ROOT, '--json'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    json = null;
  }
  assert(
    res.status === 0,
    `IO-8：對真實 repo 預設路徑跑 → exit code===0（實際 status：${res.status}；stdout：${res.stdout}；stderr：${res.stderr}）[S4-IO-8]`,
  );
  assert(json && json.ok === true, `IO-8：真實 capability-registry.json 對真實 agents/ 全過 → ok===true（實際：${JSON.stringify(json)}）[S4-IO-8]`);
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.error('\n失敗清單：');
  for (const msg of failed) console.error(`  - ${msg}`);
  process.exit(1);
}
process.exit(0);
