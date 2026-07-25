#!/usr/bin/env node
// check-registry-shape.mjs —— capability-registry.json 的機械形狀 guard（#183）：驗證 facet 身分
// 恰好等於 10 個規定 id、descriptor 的 fallback/repro 完整性（I5/I6）、agent tier/effort 與
// agents/*.md frontmatter 對帳（S8/S9，I8）、overrides 完整性（I15）。
// 分層：
//   1) 解析 / 判定層（純函式，無 IO）：parseRegistryJson / checkFacetIdentity /
//      checkDescriptorFallback / checkDescriptorRepro / checkAgentTiers / checkOverrides /
//      checkRegistry / formatSummary —— 給單元測試直接 import。
//   2) IO 薄邊界：讀 registry 檔、讀 agents/ 目錄與 frontmatter、buildReport 組裝，
//      main 被 import 時不執行（import.meta.url 守門）。
// 依賴：僅 node 內建（fs / path / url / process），無外部套件。
// 用法：node check-registry-shape.mjs [--root <dir>] [--registry <path>] [--agents-dir <dir>] [--json]

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// facet 身分恰好等於這 10 個規定 id（#183 registry schema）。
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

const EFFORT_FRONTMATTER_RE = /^effort:\s*(\S+)\s*$/m;
const REGISTRY_REL = 'plugins/loops-workflow/references/capability-registry.json';
const AGENTS_DIR_REL = 'plugins/loops-workflow/agents';

// ── 解析 / 判定層（純函式，無 IO，測試直接 import）──────────────────────────────

/** 解析 capability-registry.json 原始字串 → { registry } 或 { error }。 */
export function parseRegistryJson(content) {
  let parsed;
  try {
    parsed = JSON.parse(String(content ?? ''));
  } catch (e) {
    return { error: `JSON 解析失敗：${e.message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'registry 內容不是合法的 JSON 物件' };
  }
  return { registry: parsed };
}

/** facet 鍵集合須「恰好」等於 10 個規定 id（不只是數量對，換名字也要抓）。 */
export function checkFacetIdentity(registry) {
  const actualKeys = Object.keys(registry?.facets ?? {});
  const expectedSet = new Set(EXPECTED_FACETS);
  const actualSet = new Set(actualKeys);
  const missing = EXPECTED_FACETS.filter((id) => !actualSet.has(id));
  const extra = actualKeys.filter((id) => !expectedSet.has(id));
  if (missing.length === 0 && extra.length === 0) return [];
  return [{
    check: 'facet-identity',
    severity: 'P1',
    detail: `facet 鍵集合須恰好等於 10 個規定 id；缺少：[${missing.join(', ')}]，多餘：[${extra.join(', ')}]`,
  }];
}

// I5 對三種非 supported 狀態一視同仁，與 I6 並存不互斥：repro（I6）答的是「怎麼去量」，
// fallback（I5）答的是「在量出來 / 補上之前，流程實際上怎麼辦」——not_measured 兩者都要，
// 不能因為有 repro 就免除 fallback，否則「絕不靜默假裝已執行」（S5）只保護到 not_supported/
// degraded，not_measured（gaps.json 實測 17 筆裡佔 14 筆）會整片失守。
const STATUSES_REQUIRING_FALLBACK = new Set(['not_supported', 'degraded', 'not_measured']);

/** I5：status !== 'supported' → fallback 必須非空（與 I6 並存，not_measured 也要）。 */
export function checkDescriptorFallback(registry) {
  const findings = [];
  for (const [facetId, facet] of Object.entries(registry?.facets ?? {})) {
    for (const [platformId, descriptor] of Object.entries(facet?.platforms ?? {})) {
      if (STATUSES_REQUIRING_FALLBACK.has(descriptor?.status) && !descriptor?.fallback) {
        findings.push({
          check: 'descriptor-fallback',
          severity: 'P1',
          detail: `facet "${facetId}" 的 ${platformId} 平台 status="${descriptor?.status}"，須填 fallback（實際為空）`,
        });
      }
    }
  }
  return findings;
}

/** I6：任一平台 descriptor 的 status === 'not_measured' → repro 必須非空。 */
export function checkDescriptorRepro(registry) {
  const findings = [];
  for (const [facetId, facet] of Object.entries(registry?.facets ?? {})) {
    for (const [platformId, descriptor] of Object.entries(facet?.platforms ?? {})) {
      if (descriptor?.status === 'not_measured' && !descriptor?.repro) {
        findings.push({
          check: 'descriptor-repro',
          severity: 'P1',
          detail: `facet "${facetId}" 的 ${platformId} 平台 status="not_measured"，須填 repro（實際為空）`,
        });
      }
    }
  }
  return findings;
}

/**
 * I8（S8/S9）：agent_tiers / agent_effort 鍵集合須恰好等於 agents/*.md 現況；
 * agent_tiers 的值須是 model_tier 裡存在的 tier id；agent_effort 的值須對帳
 * agents/*.md frontmatter 的 effort（漂移即命中）。
 * agentNames / effortByAgent 由呼叫端注入（IO 已在邊界讀完，這裡純比對）。
 */
export function checkAgentTiers(registry, { agentNames, effortByAgent } = {}) {
  const findings = [];
  const names = Array.isArray(agentNames) ? agentNames : [];
  const nameSet = new Set(names);

  const agentTiers = registry?.agent_tiers ?? {};
  const tierKeySet = new Set(Object.keys(agentTiers));
  const missingTierKeys = names.filter((n) => !tierKeySet.has(n));
  const extraTierKeys = Object.keys(agentTiers).filter((n) => !nameSet.has(n));
  if (missingTierKeys.length > 0 || extraTierKeys.length > 0) {
    findings.push({
      check: 'agent-tier-keys',
      severity: 'P1',
      detail: `agent_tiers 鍵集合須恰好等於 agents/ 目錄現況；缺少：[${missingTierKeys.join(', ')}]，多餘：[${extraTierKeys.join(', ')}]`,
    });
  }

  const agentEffort = registry?.agent_effort ?? {};
  const effortKeySet = new Set(Object.keys(agentEffort));
  const missingEffortKeys = names.filter((n) => !effortKeySet.has(n));
  const extraEffortKeys = Object.keys(agentEffort).filter((n) => !nameSet.has(n));
  if (missingEffortKeys.length > 0 || extraEffortKeys.length > 0) {
    findings.push({
      check: 'agent-effort-keys',
      severity: 'P1',
      detail: `agent_effort 鍵集合須恰好等於 agents/ 目錄現況；缺少：[${missingEffortKeys.join(', ')}]，多餘：[${extraEffortKeys.join(', ')}]`,
    });
  }

  const modelTierKeys = new Set(Object.keys(registry?.model_tier ?? {}));
  for (const name of names) {
    if (!tierKeySet.has(name)) continue; // 缺鍵已由上面回報，避免重複噪音
    const tierValue = agentTiers[name];
    if (!modelTierKeys.has(tierValue)) {
      findings.push({
        check: 'agent-tier-value',
        severity: 'P1',
        detail: `agent_tiers["${name}"]="${tierValue}" 不在 model_tier 鍵集合中`,
      });
    }
  }

  for (const name of names) {
    if (!effortKeySet.has(name)) continue;
    const actualEffort = effortByAgent?.[name];
    if (actualEffort == null) continue; // frontmatter 無 effort 欄位，無法對帳，略過
    const registryEffort = agentEffort[name];
    if (registryEffort !== actualEffort) {
      findings.push({
        check: 'agent-effort-value',
        severity: 'P1',
        detail: `agent_effort["${name}"]="${registryEffort}" 與 agents/${name}.md frontmatter 的 effort="${actualEffort}" 不符`,
      });
    }
  }

  return findings;
}

/**
 * I15：overrides 不可為空；每筆 owner/rationale/test_ref/scope 皆須非空；
 * test_ref 與 scope 指向的檔案須真的存在（pathExists 以 port 注入，供純函式可測）。
 */
export function checkOverrides(registry, { pathExists } = {}) {
  const findings = [];
  const overrides = Array.isArray(registry?.overrides) ? registry.overrides : [];
  if (overrides.length === 0) {
    findings.push({
      check: 'overrides-non-empty',
      severity: 'P1',
      detail: 'overrides 陣列不可為空——至少要有一筆真實 override 記錄',
    });
    return findings;
  }

  overrides.forEach((ov, index) => {
    const label = ov?.id || `#${index}`;
    const missingFields = ['owner', 'rationale'].filter((key) => !ov?.[key]);
    if (missingFields.length > 0) {
      findings.push({
        check: 'overrides-fields',
        severity: 'P1',
        detail: `override "${label}" 缺少必要欄位：${missingFields.join(', ')}`,
      });
    }

    if (!ov?.test_ref) {
      findings.push({ check: 'overrides-fields', severity: 'P1', detail: `override "${label}" 缺少必要欄位：test_ref` });
    } else if (!pathExists(ov.test_ref)) {
      findings.push({
        check: 'overrides-test-ref-exists',
        severity: 'P1',
        detail: `override "${label}" 的 test_ref "${ov.test_ref}" 不存在`,
      });
    }

    if (!ov?.scope) {
      findings.push({ check: 'overrides-fields', severity: 'P1', detail: `override "${label}" 缺少必要欄位：scope` });
    } else if (!pathExists(ov.scope)) {
      findings.push({
        check: 'overrides-scope-exists',
        severity: 'P1',
        detail: `override "${label}" 的 scope "${ov.scope}" 不存在`,
      });
    }
  });

  return findings;
}

/** 彙整器：跑全部檢查，回傳 { ok, findings }（--json 與人讀摘要共用同一份）。 */
export function checkRegistry(registry, ctx = {}) {
  const findings = [
    ...checkFacetIdentity(registry),
    ...checkDescriptorFallback(registry),
    ...checkDescriptorRepro(registry),
    ...checkAgentTiers(registry, ctx),
    ...checkOverrides(registry, ctx),
  ];
  return { ok: findings.length === 0, findings };
}

/** 把整體檢查結果轉人讀摘要：全綠單行 ✓；有 finding → 逐條 "✗ [check] severity — detail"。 */
export function formatSummary(result) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  if (result?.ok && findings.length === 0) {
    return '✓ check-registry-shape：capability-registry.json 全綠，無 finding。';
  }
  return findings.map((f) => `✗ [${f.check}] ${f.severity ?? 'P1'} — ${f.detail}`).join('\n');
}

// ── IO 邊界：讀 registry / agents 目錄 + CLI main ───────────────────────────────

/**
 * agents 樹底下**任意深度**的 .md → agent 名（檔名去 .md，不含目錄段；registry 的鍵本身是扁平的）。
 * 遞迴：agents/ 已依角色分巢狀子目錄，非遞迴會讓子目錄裡的 agent 整批從鍵集合對帳中消失，
 * 而且是「registry 有、現況空」的靜默塌陷（比照 compat-lint C4 的 listFilesRecursive）。
 * 回 { name: 絕對路徑 }，讓後續讀 frontmatter 不必再推路徑形狀。
 */
export function readAgentFiles(agentsDirAbs) {
  const out = {};
  let entries;
  try {
    entries = readdirSync(agentsDirAbs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = join(agentsDirAbs, entry.name);
    if (entry.isDirectory()) Object.assign(out, readAgentFiles(abs));
    else if (entry.name.endsWith('.md')) out[basename(entry.name, '.md')] = abs;
  }
  return out;
}

function readAgentEffort(agentFiles, names) {
  const map = {};
  for (const name of names) {
    let content;
    try {
      content = readFileSync(agentFiles[name], 'utf8');
    } catch {
      map[name] = null;
      continue;
    }
    const match = content.match(EFFORT_FRONTMATTER_RE);
    map[name] = match ? match[1] : null;
  }
  return map;
}

/** 掃描 root，讀 registry + agents/ 現況，跑全部檢查，組成完整結果物件。 */
export function buildReport(opts) {
  const registryPath = opts.registry ?? join(opts.root, ...REGISTRY_REL.split('/'));
  const agentsDirAbs = opts.agentsDir ?? join(opts.root, ...AGENTS_DIR_REL.split('/'));

  let raw;
  try {
    raw = readFileSync(registryPath, 'utf8');
  } catch {
    return {
      ok: false,
      findings: [{ check: 'registry-file', severity: 'P1', detail: `找不到 registry 檔案：${registryPath}` }],
    };
  }

  const parsed = parseRegistryJson(raw);
  if (parsed.error) {
    return { ok: false, findings: [{ check: 'registry-parse', severity: 'P1', detail: parsed.error }] };
  }

  const agentFiles = readAgentFiles(agentsDirAbs);
  const agentNames = Object.keys(agentFiles);
  const effortByAgent = readAgentEffort(agentFiles, agentNames);
  const pathExists = (rel) => existsSync(join(opts.root, ...String(rel).split('/')));

  return checkRegistry(parsed.registry, { agentNames, effortByAgent, pathExists });
}

function defaultRoot() {
  const scriptDir = fileURLToPath(new URL('.', import.meta.url));
  return join(scriptDir, '..', '..', '..');
}

function parseArgs(argv) {
  const opts = { root: defaultRoot(), registry: null, agentsDir: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--root') opts.root = argv[++i] ?? opts.root;
    else if (flag === '--registry') opts.registry = argv[++i] ?? null;
    else if (flag === '--agents-dir') opts.agentsDir = argv[++i] ?? null;
    else if (flag === '--json') opts.json = true;
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const result = buildReport(opts);
  console.log(opts.json ? JSON.stringify(result, null, 2) : formatSummary(result));
  process.exit(result.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2));
}
