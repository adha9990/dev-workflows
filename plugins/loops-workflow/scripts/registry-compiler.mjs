#!/usr/bin/env node
// registry-compiler.mjs —— policy / component / integration registry 的機械 guard（#170）。
// 涵蓋：policy 面 P1/P2/P4/P6/P7 + scope kind 一致性（P9）與 scope 關係三態 + 衝突三態（P5）；
//       component 面 C1/C3/C4 + 依賴環 + affected-source 查詢；integration 面 I2/I4/I5/I6。
// 結果有兩條並行的紅線：findings（違規）與 decisions（真衝突、要人裁決）。
// 兩者都必須讓 ok 為 false、也都必須被 formatSummary 印出來——只看 findings 的話，
// 真衝突會在「✓ 無 finding」與 exit 0 底下消失，那正是這支工具最該擋的假綠。
// 分層（沿用 codex-plugin-lint.mjs / check-registry-shape.mjs 的既有形狀）：
//   1) 解析 / 判定層（純函式，無 IO）：checkPolicy* / relateScopes / checkComponent* /
//      checkIntegration* / formatSummary —— 給單元測試直接 import。
//   2) IO 薄邊界：buildReport（讀檔 + 注入 pathExists／readText port）與 CLI main，
//      main 被 import 時不執行（import.meta.url 守門）。
// JSON 解析重用 check-registry-shape.mjs 已 export 的 parseRegistryJson（不寫第四份 parse）。
// I6 的平台工具名／vendor model 掃描重用 compat-lint.mjs 已 export 的 scanner：
//   compat-lint 的檔案 walker 只收 .md，掃不到 registry 的 .json，所以規則要在本檔自帶呼叫，
//   但正則只留一份在 compat-lint。
// 依賴：僅 node 內建（fs / path / url / process）＋本 repo 內既有 script，無外部套件。
// 用法：node registry-compiler.mjs [--root <dir>] [--policy <path>] [--json]
//       node registry-compiler.mjs --affected <path[,path...]> [--json] [--strict]

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseRegistryJson } from './check-registry-shape.mjs';
import { scanPlatformToolNames, scanVendorModelIds } from './compat-lint.mjs';

const POLICY_REGISTRY_REL = 'plugins/loops-workflow/references/policy-registry.json';
const COMPONENT_REGISTRY_REL = 'plugins/loops-workflow/references/component-registry.json';
const INTEGRATION_REGISTRY_REL = 'plugins/loops-workflow/references/integration-registry.json';
const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ENFORCEMENT_LEVELS = new Set(['forbid', 'require', 'warn', 'info']);
// T0 實填 AGENTS.md 規則 9／13／5 後定案：活動型規則（例如 Metric-Honesty）沒有自然的 path glob，
// 若逼它填 paths:["**"] 會與每一條規則假交集、讓 P5 衝突判定退化成噪音。改用 kind 明分兩種
// scope：path-based 走 path 交集，activity-based 走 activities 交集，跨 kind 不視為重疊。
const SCOPE_KINDS = new Set(['path-based', 'activity-based']);
// P2 檢查「必須實際存在」的三個路徑欄位（scope.paths 是 glob pattern，不在此列）。
const PATH_FIELDS = ['projection', 'tests', 'docs'];

const COMPONENT_KINDS = new Set(['hook', 'skill', 'agent', 'reference', 'script', 'doc', 'eval']);
const COMPONENT_VISIBILITIES = new Set(['public', 'internal']);
// required_checks 的四個桶：前三個是 repo 內路徑（C4），integrations 是 integration id（I5 跨表）。
const REQUIRED_CHECK_PATH_BUCKETS = ['hooks', 'evals', 'docs'];
const REQUIRED_CHECK_BUCKETS = [...REQUIRED_CHECK_PATH_BUCKETS, 'integrations'];

const SUPPORT_STATUSES = new Set(['supported', 'degraded', 'not_supported', 'not_measured']);
// integration 的路徑類欄位（選填；填了就必須指向真的存在的檔案）——三份 registry 的 dangling 一致覆蓋。
const INTEGRATION_PATH_FIELDS = ['docs'];
// I4：lifecycle 只驗形狀——每個階段是「指令字串或 null」，本檔絕不執行其中任何一個字串。
const LIFECYCLE_STAGES = ['detect', 'install_latest', 'update_latest', 'health', 'uninstall', 'rollback'];
// I6：自由文字欄（識別碼欄位如 id／exclusive_group 不在此列，它們是鍵不是敘述）。
const INTEGRATION_FREE_TEXT_FIELDS = ['capability', 'triggers', 'outputs'];

const GLOB_WILDCARD_RE = /[*?]/;

// ── 解析 / 判定層（純函式，無 IO，測試直接 import）──────────────────────────────

function finding(check, id, detail, file = POLICY_REGISTRY_REL) {
  return { check, severity: 'P1', file, id, detail };
}

function policyList(registry) {
  return Array.isArray(registry?.policies) ? registry.policies : [];
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 三份 registry 共用的信封形狀：schema_version 非空、清單欄位是非空陣列、每個元素是物件。
 * entries 為 null 代表清單欄位本身就不是陣列——呼叫端該直接收工，逐筆檢查沒有可信的輸入。
 * 空陣列必須紅：逐筆檢查對空清單全部恆真，「一條都沒登記」會被印成「無 finding」。
 */
function checkRegistryEnvelope(registry, { listKey, check, makeFinding }) {
  const findings = [];
  if (!registry?.schema_version) {
    findings.push(makeFinding(check, null, '缺少必要欄位 "schema_version"'));
  }
  if (!Array.isArray(registry?.[listKey])) {
    findings.push(makeFinding(check, null, `"${listKey}" 必須是陣列`));
    return { findings, entries: null };
  }
  if (registry[listKey].length === 0) {
    findings.push(makeFinding(check, null, `"${listKey}" 不得為空陣列——空清單會讓每一條逐筆檢查恆真，變成沒有內容的假綠`));
  }
  registry[listKey].forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      findings.push(makeFinding(check, null, `${listKey}[${index}] 必須是物件`));
    }
  });
  return { findings, entries: registry[listKey] };
}

/**
 * 三份 registry 共用的 id 衛生檢查：前後空白、以及「只差大小寫或空白」的近重複。
 * 正規化後比對是刻意的——"Foo-Bar" 與 "foo-bar"、" foo" 與 "foo" 在人眼裡是同一條規則，
 * 逐字比對會讓它們各自成立、繞過唯一性；訊息同時指名兩處出處，才知道要刪哪一筆。
 */
function idHygieneFindings(entries, { listKey, check, makeFinding }) {
  const findings = [];
  const firstByKey = new Map();
  entries.forEach((entry, index) => {
    const id = entry?.id;
    if (typeof id !== 'string' || id === '') return; // 空 id 由各表的必填檢查負責

    if (id !== id.trim()) {
      findings.push(makeFinding(check, id, `${listKey}[${index}] 的 "id" ${JSON.stringify(id)} 含前後空白——id 必須是去空白後的字面值`));
    }

    const key = id.trim().toLowerCase();
    const first = firstByKey.get(key);
    if (!first) {
      firstByKey.set(key, { id, index });
      return;
    }
    const source = `出處：${listKey}[${first.index}] 與 ${listKey}[${index}]`;
    findings.push(makeFinding(
      check,
      id,
      first.id === id
        ? `"id"=${JSON.stringify(id)} 重複——id 必須全表唯一（${source}）`
        : `"id"=${JSON.stringify(id)} 與 ${JSON.stringify(first.id)} 只差大小寫或前後空白，視為重複——id 必須全表唯一（${source}）`,
    ));
  });
  return findings;
}

/**
 * 路徑類欄位共用的 dangling 檢查：空字串／不存在／存在但不是檔案（例如指到目錄）。
 * isFile 未注入時退回 pathExists——舊呼叫端行為不變，只是不再多報型別那一條。
 * report(check, tail) 由呼叫端提供，好讓訊息保留 `policy "x" 的 …` 這種指名前綴。
 */
function pathEntryFindings(values, { label, shapeCheck, existsCheck, report, pathExists, isFile }) {
  const findings = [];
  const looksLikeFile = typeof isFile === 'function' ? isFile : pathExists;
  values.forEach((rel, index) => {
    if (typeof rel !== 'string' || rel === '') {
      findings.push(report(shapeCheck, `"${label}[${index}]" 不得為空字串`));
      return;
    }
    if (!pathExists(rel)) {
      findings.push(report(existsCheck, `"${label}[${index}]" 指向不存在的檔案：${rel}`));
      return;
    }
    if (!looksLikeFile(rel)) {
      findings.push(report(existsCheck, `"${label}[${index}]" 指向的目標存在但不是檔案（例如目錄）：${rel}`));
    }
  });
  return findings;
}

/** registry 頂層形狀：schema_version 非空、policies 為陣列且每筆是物件。 */
export function checkPolicyShape(registry) {
  return checkRegistryEnvelope(registry, {
    listKey: 'policies',
    check: 'policy-registry-shape',
    makeFinding: finding,
  }).findings;
}

/** P1：id 非空、kebab-case、且全表唯一；順帶驗 title 與 enforcement 的必填與值域。 */
export function checkPolicyIds(registry) {
  const policies = policyList(registry);
  const findings = idHygieneFindings(policies, {
    listKey: 'policies',
    check: 'policy-id',
    makeFinding: finding,
  });
  policies.forEach((policy, index) => {
    const id = policy?.id;
    if (typeof id !== 'string' || id === '') {
      findings.push(finding('policy-id', null, `policies[${index}] 的 "id" 不得為空`));
      return;
    }
    if (!KEBAB_CASE_RE.test(id)) {
      findings.push(finding('policy-id', id, `policy "${id}" 的 "id" 須為 kebab-case（小寫字母數字以單一連字號分隔）`));
    }

    if (typeof policy?.title !== 'string' || policy.title === '') {
      findings.push(finding('policy-id', id, `policy "${id}" 的 "title" 不得為空`));
    }
    if (!ENFORCEMENT_LEVELS.has(policy?.enforcement)) {
      findings.push(finding(
        'policy-id',
        id,
        `policy "${id}" 的 "enforcement" 須為 forbid／require／warn／info 之一（實際：${JSON.stringify(policy?.enforcement)}）`,
      ));
    }
  });
  return findings;
}

/**
 * P9（T0 折回）：scope.kind 必填且與 paths／activities 一致——
 * path-based ⇒ paths 非空、activities 空；activity-based ⇒ activities 非空、paths 空。
 * 另擋裸 "**"：那是「懶得填 scope」的逃生口，會讓每一對規則都假重疊。
 */
export function checkPolicyScope(registry) {
  const findings = [];
  for (const policy of policyList(registry)) {
    const id = policy?.id ?? null;
    const scope = policy?.scope;
    if (!isPlainObject(scope)) {
      findings.push(finding('policy-scope', id, `policy "${id}" 的 "scope" 必須是物件`));
      continue;
    }
    if (!SCOPE_KINDS.has(scope.kind)) {
      findings.push(finding(
        'policy-scope',
        id,
        `policy "${id}" 的 "scope.kind" 須為 path-based 或 activity-based（實際：${JSON.stringify(scope.kind)}）`,
      ));
      continue;
    }

    const paths = Array.isArray(scope.paths) ? scope.paths : [];
    const activities = Array.isArray(scope.activities) ? scope.activities : [];
    if (!Array.isArray(scope.paths) || !Array.isArray(scope.activities) || !Array.isArray(scope.stages)) {
      findings.push(finding('policy-scope', id, `policy "${id}" 的 "scope.paths"／"scope.activities"／"scope.stages" 都必須是陣列`));
      continue;
    }

    if (scope.kind === 'path-based') {
      if (paths.length === 0) {
        findings.push(finding('policy-scope', id, `policy "${id}" 的 "scope.kind"=path-based，"scope.paths" 不得為空`));
      }
      if (activities.length > 0) {
        findings.push(finding('policy-scope', id, `policy "${id}" 的 "scope.kind"=path-based，"scope.activities" 必須為空`));
      }
      if (paths.includes('**')) {
        findings.push(finding(
          'policy-scope',
          id,
          `policy "${id}" 的 "scope.paths" 不得使用裸 "**"——沒有路徑面的規則請改用 "scope.kind"=activity-based`,
        ));
      }
    } else {
      if (activities.length === 0) {
        findings.push(finding('policy-scope', id, `policy "${id}" 的 "scope.kind"=activity-based，"scope.activities" 不得為空`));
      }
      if (paths.length > 0) {
        findings.push(finding('policy-scope', id, `policy "${id}" 的 "scope.kind"=activity-based，"scope.paths" 必須為空`));
      }
    }
  }
  return findings;
}

/** P2：projection／tests／docs 的每個路徑必須實際存在且是檔案（pathExists／isFile 以 port 注入）。 */
export function checkPolicyPaths(registry, { pathExists, isFile } = {}) {
  if (typeof pathExists !== 'function') {
    throw new TypeError('checkPolicyPaths 需要注入 pathExists(relPath) => boolean');
  }
  const findings = [];
  for (const policy of policyList(registry)) {
    const id = policy?.id ?? null;
    const report = (check, tail) => finding(check, id, `policy "${id}" 的 ${tail}`);
    for (const field of PATH_FIELDS) {
      const value = policy?.[field];
      if (!Array.isArray(value)) {
        findings.push(report('policy-path-shape', `"${field}" 必須是陣列`));
        continue;
      }
      findings.push(...pathEntryFindings(value, {
        label: field,
        shapeCheck: 'policy-path-shape',
        existsCheck: 'policy-path-exists',
        report,
        pathExists,
        isFile,
      }));
    }
  }
  return findings;
}

/** P4：overridable === true ⇒ approval.required 為 true 且 approval.by 非空。 */
export function checkPolicyApproval(registry) {
  const findings = [];
  for (const policy of policyList(registry)) {
    const id = policy?.id ?? null;
    if (typeof policy?.overridable !== 'boolean') {
      findings.push(finding('policy-approval', id, `policy "${id}" 的 "overridable" 必須顯式為布林值`));
      continue;
    }
    if (!policy.overridable) continue;

    if (policy?.approval?.required !== true) {
      findings.push(finding('policy-approval', id, `policy "${id}" 的 "overridable"=true，"approval.required" 必須為 true`));
    }
    if (!policy?.approval?.by) {
      findings.push(finding('policy-approval', id, `policy "${id}" 的 "overridable"=true，"approval.by" 不得為空`));
    }
  }
  return findings;
}

/**
 * P6：enforcement === 'forbid' 或 approval.required === true 的規則，
 * fail_closed_on_missing_state 必須顯式為 true（缺欄位或 false 皆紅）。
 * 這條是決策 4 留在本票那一半的唯一守門人——少了它，該欄位就只是沒人檢查的 schema 鍵。
 */
export function checkPolicyFailClosed(registry) {
  const findings = [];
  for (const policy of policyList(registry)) {
    const id = policy?.id ?? null;
    const isForbid = policy?.enforcement === 'forbid';
    const needsApproval = policy?.approval?.required === true;
    if (!isForbid && !needsApproval) continue;
    if (policy?.fail_closed_on_missing_state === true) continue;

    const reason = isForbid ? '"enforcement"=forbid' : '"approval.required"=true';
    findings.push(finding(
      'policy-fail-closed',
      id,
      `policy "${id}" 的 ${reason}，"fail_closed_on_missing_state" 必須顯式為 true（實際：${JSON.stringify(policy?.fail_closed_on_missing_state)}）`,
    ));
  }
  return findings;
}

/**
 * P7（generated drift）：projection[] 的每個目標檔必須逐字含有該規則的標記
 * （projection_marker，未填則預設為 id）。只驗「檔案存在」不夠——檔案還在、規則段落被拿掉，
 * 正是要抓的漂移；readText 以 port 注入（讀不到回 null）。
 */
export function checkPolicyProjectionMarkers(registry, { readText } = {}) {
  if (typeof readText !== 'function') {
    throw new TypeError('checkPolicyProjectionMarkers 需要注入 readText(relPath) => string|null');
  }
  const findings = [];
  for (const policy of policyList(registry)) {
    const id = policy?.id ?? null;
    const declaredMarker = policy?.projection_marker;
    // 宣告了欄位卻給空字串 ⇒ 標記比對會退化成「任何文字都含空字串」的恆真——一律紅，要放棄請填 null。
    if (declaredMarker !== null && declaredMarker !== undefined
      && (typeof declaredMarker !== 'string' || declaredMarker === '')) {
      findings.push(finding(
        'policy-projection-drift',
        id,
        `policy "${id}" 的 "projection_marker" 宣告了卻不是非空字串（實際：${JSON.stringify(declaredMarker)}）——不用標記請填 null`,
      ));
      continue;
    }
    const marker = declaredMarker ?? id;
    const targets = Array.isArray(policy?.projection) ? policy.projection : [];
    if (typeof marker !== 'string' || marker === '') {
      if (targets.length > 0) {
        findings.push(finding('policy-projection-drift', id, `policy "${id}" 有 projection 目標，但 "projection_marker" 與 "id" 都無法當作可比對的標記字串`));
      }
      continue;
    }

    targets.forEach((target, index) => {
      if (typeof target !== 'string' || target === '') return; // 形狀由 P2 的 policy-path-shape 負責
      const text = readText(target);
      if (text === null || text === undefined) {
        findings.push(finding('policy-projection-drift', id, `policy "${id}" 的 "projection[${index}]" 讀不到投影目標：${target}`));
        return;
      }
      if (!text.includes(marker)) {
        findings.push(finding(
          'policy-projection-drift',
          id,
          `policy "${id}" 的投影目標 "${target}"（projection[${index}]）已不含標記 "${marker}"——檔案還在但規則被拿掉了`,
        ));
      }
    });
  }
  return findings;
}

/** pattern 中第一個萬用字元之前的字面前綴（無萬用字元則整串都是前綴）。 */
function literalPrefix(pattern) {
  const at = pattern.search(GLOB_WILDCARD_RE);
  return at === -1 ? pattern : pattern.slice(0, at);
}

/** pattern 中最後一個萬用字元之後的字面尾綴（例如 "**\/*.md" → ".md"）。 */
function literalSuffix(pattern) {
  for (let i = pattern.length - 1; i >= 0; i -= 1) {
    if (GLOB_WILDCARD_RE.test(pattern[i])) return pattern.slice(i + 1);
  }
  return '';
}

function hasWildcard(pattern) {
  return GLOB_WILDCARD_RE.test(pattern);
}

/**
 * outer 是否涵蓋 inner：以字面前綴 + 字面尾綴近似 glob 覆蓋（不做完整 glob 展開）。
 * export 給 test-registry-coverage 的逐檔枚舉地板用——覆蓋判定只留這一份實作，
 * 測試端另寫一套近似比對，兩邊對「什麼叫涵蓋」的認定遲早會分岔。
 */
export function globCovers(outer, inner) {
  if (outer === inner) return true;
  if (!hasWildcard(outer)) return false;
  if (!inner.startsWith(literalPrefix(outer))) return false;
  const suffix = literalSuffix(outer);
  return suffix === '' || inner.endsWith(suffix);
}

function globsIntersect(a, b) {
  if (globCovers(a, b) || globCovers(b, a)) return true;
  if (!hasWildcard(a) || !hasWildcard(b)) return false;
  const [pa, pb] = [literalPrefix(a), literalPrefix(b)];
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/** 兩組 pattern 的三態關係；任一組為空視為互斥（空集合不該被當成「涵蓋一切」）。 */
function relatePatternSets(a, b) {
  if (a.length === 0 || b.length === 0) return 'disjoint';
  const aCoversB = b.every((x) => a.some((y) => globCovers(y, x)));
  const bCoversA = a.every((x) => b.some((y) => globCovers(y, x)));
  if (aCoversB || bCoversA) return 'contains';
  if (a.some((x) => b.some((y) => globsIntersect(x, y)))) return 'overlaps';
  return 'disjoint';
}

/** stages 空陣列＝全階段，因此只要任一邊為空就一定有交集。 */
function stagesIntersect(a, b) {
  if (a.length === 0 || b.length === 0) return true;
  return a.some((stage) => b.includes(stage));
}

function scopeDimension(scope) {
  const values = scope.kind === 'path-based' ? scope.paths : scope.activities;
  return Array.isArray(values) ? values.filter((v) => typeof v === 'string' && v !== '') : [];
}

/**
 * T6：兩個 scope 的關係三態 'contains'（一方涵蓋另一方）／'overlaps'／'disjoint'。
 * 依 P9 的分軸決定：先比 scope.kind，只有同 kind 才比對應維度（path-based 比 paths、
 * activity-based 比 activities）；跨 kind 不視為重疊，否則活動型規則會與每條路徑型規則假交集。
 * 回傳是對稱的——「誰涵蓋誰」的方向留給衝突判定（T7）需要時再談。
 */
export function relateScopes(scopeA, scopeB) {
  if (!isPlainObject(scopeA) || !isPlainObject(scopeB)) return 'disjoint';
  if (!SCOPE_KINDS.has(scopeA.kind) || scopeA.kind !== scopeB.kind) return 'disjoint';
  const stagesA = Array.isArray(scopeA.stages) ? scopeA.stages : [];
  const stagesB = Array.isArray(scopeB.stages) ? scopeB.stages : [];
  if (!stagesIntersect(stagesA, stagesB)) return 'disjoint';
  return relatePatternSets(scopeDimension(scopeA), scopeDimension(scopeB));
}

/**
 * 把非互斥的規則對列成 note（不是 finding）——重疊本身不違規，
 * 但「哪些規則在同一片 scope 上」是衝突判定（T7）與人審都需要的可觀測性。
 */
export function describeScopeRelations(registry) {
  const policies = policyList(registry);
  const notes = [];
  for (let i = 0; i < policies.length; i += 1) {
    for (let j = i + 1; j < policies.length; j += 1) {
      const relation = relateScopes(policies[i]?.scope, policies[j]?.scope);
      if (relation === 'disjoint') continue;
      notes.push(`scope ${relation}：policy "${policies[i]?.id}" 與 "${policies[j]?.id}"`);
    }
  }
  return notes;
}

// ── T7：衝突三態 ───────────────────────────────────────────────────────────────
// 三態刻意只有三個值（compatible／resolved-by-forbid-wins／requires-human-decision）：
// 前兩態都是「機器自己決定得了、不該打擾人」，第三態才進 decisions[] 擋 CI。
// precedence 已宣告的情形歸在第二態（自動取嚴的一般化：作者事先排好了誰壓誰），
// 用 resolution 欄位區分是「取嚴」還是「依宣告的 precedence」，不讓 status 說謊。
export const CONFLICT_COMPATIBLE = 'compatible';
export const CONFLICT_AUTO_RESOLVED = 'resolved-by-forbid-wins';
export const CONFLICT_NEEDS_HUMAN = 'requires-human-decision';

// 由嚴到寬；差一階就有「取嚴」可循，不必問人。
const ENFORCEMENT_STRICTNESS = ['forbid', 'require', 'warn', 'info'];

function strictnessOf(policy) {
  const at = ENFORCEMENT_STRICTNESS.indexOf(policy?.enforcement);
  return at === -1 ? ENFORCEMENT_STRICTNESS.length : at;
}

/**
 * 兩條規則的要求是否互斥：一邊 forbids 的項目正是另一邊 requires 的項目，
 * 或任一邊在 conflicts_with 裡點名對方（單向點名就算——要求雙向宣告等於留一個漏報缺口）。
 */
function requirementClashes(a, b) {
  const clashes = [];
  for (const [x, y] of [[a, b], [b, a]]) {
    for (const item of stringArrayOf(x?.forbids)) {
      if (!stringArrayOf(y?.requires).includes(item)) continue;
      clashes.push(`"${x?.id}" forbids "${item}"，"${y?.id}" 卻 requires 同一項`);
    }
    if (stringArrayOf(x?.conflicts_with).includes(y?.id)) {
      clashes.push(`"${x?.id}" 在 "conflicts_with" 點名 "${y?.id}"`);
    }
  }
  return clashes;
}

function describeSharedScope(a, b, relation) {
  const kind = a?.scope?.kind ?? 'unknown';
  const dims = [a, b].map((p) => JSON.stringify(scopeDimension(p?.scope ?? {})));
  return `${kind}／${relation}：${dims[0]} × ${dims[1]}`;
}

/** precedence 皆為數字且不相等 ⇒ 作者已排好順序；相等或有一邊為 null 都不算排好。 */
function winnerByPrecedence(a, b) {
  const [pa, pb] = [a?.precedence, b?.precedence];
  if (typeof pa !== 'number' || typeof pb !== 'number' || pa === pb) return null;
  return pa > pb ? a : b;
}

/**
 * T7：一對規則的衝突三態。
 * 依 P5／P9 修訂版：先比 scope.kind（跨 kind 不重疊），同 kind 才比對應維度；
 * scope 有交集 ＋ 要求互斥 ＋ enforcement 同嚴格度 ＋ precedence 無從排序 ⇒ 才需要人決定。
 * 反過來說：只是 scope 重疊但要求不互斥 ⇒ 相容 extension，一律不報——否則第三態會退化成
 * 「凡同 scope 就報」的噪音，人很快就學會忽略它。
 */
export function classifyConflict(policyA, policyB) {
  const relation = relateScopes(policyA?.scope, policyB?.scope);
  const rules = [policyA?.id ?? null, policyB?.id ?? null];
  const base = { rules, scope: describeSharedScope(policyA, policyB, relation) };

  if (relation === 'disjoint') {
    return { ...base, status: CONFLICT_COMPATIBLE, reason: 'scope 無交集，兩條規則各管各的' };
  }

  const clashes = requirementClashes(policyA, policyB);
  if (clashes.length === 0) {
    return { ...base, status: CONFLICT_COMPATIBLE, reason: `scope ${relation} 但要求不互斥，可直接疊加（相容 extension）` };
  }

  const [strictA, strictB] = [strictnessOf(policyA), strictnessOf(policyB)];
  if (strictA !== strictB) {
    const winner = strictA < strictB ? policyA : policyB;
    const loser = winner === policyA ? policyB : policyA;
    return {
      ...base,
      status: CONFLICT_AUTO_RESOLVED,
      resolution: winner.enforcement === 'forbid' ? 'forbid-wins' : 'stricter-enforcement-wins',
      winner: winner?.id ?? null,
      reason: `${clashes.join('；')}；"${winner?.id}" 的 enforcement=${winner?.enforcement} 比 "${loser?.id}" 的 ${loser?.enforcement} 嚴，自動取嚴`,
    };
  }

  const precedenceWinner = winnerByPrecedence(policyA, policyB);
  if (precedenceWinner) {
    return {
      ...base,
      status: CONFLICT_AUTO_RESOLVED,
      resolution: 'declared-precedence',
      winner: precedenceWinner.id ?? null,
      reason: `${clashes.join('；')}；依已宣告的 precedence 由 "${precedenceWinner.id}"（${precedenceWinner.precedence}）壓過對方`,
    };
  }

  return {
    ...base,
    status: CONFLICT_NEEDS_HUMAN,
    reason: `${clashes.join('；')}；雙方 enforcement 同為 ${JSON.stringify(policyA?.enforcement)}、precedence 也無從排序，機器不得替人選一邊`,
  };
}

/** 掃描所有規則對，把第三態整理成結構化 decisions[]（前兩態自動處理，不進清單）。 */
export function collectPolicyDecisions(registry) {
  const policies = policyList(registry);
  const decisions = [];
  for (let i = 0; i < policies.length; i += 1) {
    for (let j = i + 1; j < policies.length; j += 1) {
      const verdict = classifyConflict(policies[i], policies[j]);
      if (verdict.status !== CONFLICT_NEEDS_HUMAN) continue;
      decisions.push({
        kind: verdict.status,
        scope: verdict.scope,
        rules: verdict.rules,
        reason: verdict.reason,
      });
    }
  }
  return decisions;
}

/** 彙整 policy 面全部檢查；真衝突走 decisions（不是 finding），但一樣讓整體不綠。 */
export function checkPolicies(registry, ctx = {}) {
  const shapeFindings = checkPolicyShape(registry);
  if (shapeFindings.length > 0) return { findings: shapeFindings, decisions: [] };
  return {
    findings: [
      ...checkPolicyIds(registry),
      ...checkPolicyScope(registry),
      ...checkPolicyPaths(registry, ctx),
      ...checkPolicyApproval(registry),
      ...checkPolicyFailClosed(registry),
      // 沒注入 readText 時以「讀不到」代入 —— 有 projection 就會紅（fail-closed），不會靜默跳過。
      ...checkPolicyProjectionMarkers(registry, { readText: ctx.readText ?? (() => null) }),
    ],
    decisions: collectPolicyDecisions(registry),
  };
}

// ── component registry（C1／C3／C4 ＋ 依賴環）──────────────────────────────────

function componentFinding(check, id, detail) {
  return finding(check, id, detail, COMPONENT_REGISTRY_REL);
}

function componentList(registry) {
  return Array.isArray(registry?.components) ? registry.components : [];
}

function stringArrayOf(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}

const COMPONENT_SHAPE_CHECK = 'component-registry-shape';

/** 單筆 component 的欄位形狀（kind／visibility 值域、paths、stage_role、關聯陣列、required_checks 桶）。 */
function componentFieldFindings(component, index) {
  const findings = [];
  const id = component.id ?? null;
  const shape = (detail, findingId = id) => componentFinding(COMPONENT_SHAPE_CHECK, findingId, detail);

  if (typeof id !== 'string' || id === '') {
    findings.push(shape(`components[${index}] 的 "id" 不得為空`, null));
  }
  if (!COMPONENT_KINDS.has(component.kind)) {
    findings.push(shape(`component "${id}" 的 "kind" 須為 ${[...COMPONENT_KINDS].join('／')} 之一（實際：${JSON.stringify(component.kind)}）`));
  }
  if (!COMPONENT_VISIBILITIES.has(component.visibility)) {
    findings.push(shape(`component "${id}" 的 "visibility" 須為 public 或 internal（實際：${JSON.stringify(component.visibility)}）`));
  }
  if (!Array.isArray(component.paths) || component.paths.length === 0) {
    findings.push(shape(`component "${id}" 的 "paths" 必須是非空陣列`));
  }
  // 空字串一律不收：宣告了欄位又留白，等於用一個不會被任何查詢命中的值假裝有填。
  if (component.stage_role !== null && (typeof component.stage_role !== 'string' || component.stage_role === '')) {
    findings.push(shape(`component "${id}" 的 "stage_role" 必須是非空字串或 null（實際：${JSON.stringify(component.stage_role)}）`));
  }
  for (const field of ['dependencies', 'consumers']) {
    if (!Array.isArray(component[field])) {
      findings.push(shape(`component "${id}" 的 "${field}" 必須是陣列`));
    }
  }

  if (!isPlainObject(component.required_checks)) {
    findings.push(shape(`component "${id}" 的 "required_checks" 必須是物件`));
    return findings;
  }
  for (const bucket of REQUIRED_CHECK_BUCKETS) {
    if (!Array.isArray(component.required_checks[bucket])) {
      findings.push(shape(`component "${id}" 的 "required_checks.${bucket}" 必須是陣列`));
    }
  }
  return findings;
}

/** component registry 頂層與逐筆欄位形狀。 */
export function checkComponentShape(registry) {
  const { findings, entries } = checkRegistryEnvelope(registry, {
    listKey: 'components',
    check: COMPONENT_SHAPE_CHECK,
    makeFinding: componentFinding,
  });
  if (entries === null) return findings;
  entries.forEach((component, index) => {
    if (!isPlainObject(component)) return; // 非物件已由信封檢查報過
    findings.push(...componentFieldFindings(component, index));
  });
  return findings;
}

/** C1：id 全表唯一；dependencies／consumers 引用的 id 必須存在（dangling 要指名是哪個 id）。 */
export function checkComponentIds(registry) {
  const components = componentList(registry);
  const findings = idHygieneFindings(components, {
    listKey: 'components',
    check: 'component-id',
    makeFinding: componentFinding,
  });
  const known = new Set(components
    .map((c) => c?.id)
    .filter((id) => typeof id === 'string' && id !== ''));

  for (const component of components) {
    const id = component?.id ?? null;
    for (const field of ['dependencies', 'consumers']) {
      stringArrayOf(component?.[field]).forEach((ref, index) => {
        if (known.has(ref)) return;
        findings.push(componentFinding(
          'component-ref',
          id,
          `component "${id}" 的 "${field}[${index}]" 指向不存在的 component id："${ref}"`,
        ));
      });
    }
  }
  return findings;
}

/** C3：dependencies 與 consumers 雙向一致——A 依賴 B ⇒ B 的 consumers 必須含 A（反向亦然）。 */
export function checkComponentReciprocity(registry) {
  const findings = [];
  const byId = new Map(componentList(registry)
    .filter((c) => typeof c?.id === 'string' && c.id !== '')
    .map((c) => [c.id, c]));

  for (const [id, component] of byId) {
    for (const dependencyId of stringArrayOf(component.dependencies)) {
      const dependency = byId.get(dependencyId);
      if (!dependency) continue; // dangling 由 C1 負責，不重複報
      if (!stringArrayOf(dependency.consumers).includes(id)) {
        findings.push(componentFinding(
          'component-reciprocity',
          id,
          `component "${id}" 的 "dependencies" 含 "${dependencyId}"，但 "${dependencyId}" 的 "consumers" 沒有 "${id}"——雙向必須一致`,
        ));
      }
    }
    for (const consumerId of stringArrayOf(component.consumers)) {
      const consumer = byId.get(consumerId);
      if (!consumer) continue;
      if (!stringArrayOf(consumer.dependencies).includes(id)) {
        findings.push(componentFinding(
          'component-reciprocity',
          id,
          `component "${id}" 的 "consumers" 含 "${consumerId}"，但 "${consumerId}" 的 "dependencies" 沒有 "${id}"——雙向必須一致`,
        ));
      }
    }
  }
  return findings;
}

/** C4：required_checks 的 hooks／evals／docs 每個路徑必須實際存在（integrations 走 I5 跨表）。 */
export function checkComponentRequiredChecks(registry, { pathExists, isFile } = {}) {
  if (typeof pathExists !== 'function') {
    throw new TypeError('checkComponentRequiredChecks 需要注入 pathExists(relPath) => boolean');
  }
  const findings = [];
  for (const component of componentList(registry)) {
    const id = component?.id ?? null;
    const report = (check, tail) => componentFinding(check, id, `component "${id}" 的 ${tail}`);
    for (const bucket of REQUIRED_CHECK_PATH_BUCKETS) {
      const entries = component?.required_checks?.[bucket];
      if (!Array.isArray(entries)) continue; // 形狀由 checkComponentShape 負責
      findings.push(...pathEntryFindings(entries, {
        label: `required_checks.${bucket}`,
        shapeCheck: 'component-required-check',
        existsCheck: 'component-required-check',
        report,
        pathExists,
        isFile,
      }));
    }
  }
  return findings;
}

/**
 * T5：dependencies 成環 → 紅，訊息帶出環上節點序列；自我引用（a → a）同樣算環。
 * 以 DFS 走訪堆疊偵測回邊，每個環只報一次（用正規化後的節點集合去重）。
 */
export function checkComponentCycles(registry) {
  const dependenciesById = new Map(componentList(registry)
    .filter((c) => typeof c?.id === 'string' && c.id !== '')
    .map((c) => [c.id, stringArrayOf(c.dependencies)]));

  const findings = [];
  const reported = new Set();
  const visited = new Set();

  const walk = (id, stack) => {
    const at = stack.indexOf(id);
    if (at !== -1) {
      const cycle = [...stack.slice(at), id];
      const signature = [...new Set(cycle)].sort().join('|');
      if (!reported.has(signature)) {
        reported.add(signature);
        findings.push(componentFinding(
          'component-cycle',
          cycle[0],
          `component 依賴成環：${cycle.join(' → ')}——dependencies 必須是有向無環圖`,
        ));
      }
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    for (const next of dependenciesById.get(id) ?? []) {
      if (!dependenciesById.has(next)) continue; // dangling 由 C1 負責
      walk(next, [...stack, id]);
    }
  };

  for (const id of dependenciesById.keys()) walk(id, []);
  return findings;
}

/** 彙整 component 面全部檢查（形狀先擋掉，後續檢查才有可信的欄位型別）。 */
export function checkComponents(registry, ctx = {}) {
  const shapeFindings = checkComponentShape(registry);
  if (shapeFindings.length > 0) return shapeFindings;
  return [
    ...checkComponentIds(registry),
    ...checkComponentReciprocity(registry),
    ...checkComponentRequiredChecks(registry, ctx),
    ...checkComponentCycles(registry),
  ];
}

// ── integration registry（I2／I4／I5／I6）──────────────────────────────────────

function integrationFinding(check, id, detail) {
  return finding(check, id, detail, INTEGRATION_REGISTRY_REL);
}

function integrationList(registry) {
  return Array.isArray(registry?.integrations) ? registry.integrations : [];
}

const INTEGRATION_SHAPE_CHECK = 'integration-registry-shape';

/** 單筆 integration 的欄位形狀（capability 非空、support_status 值域、exclusive_group、triggers／outputs）。 */
function integrationFieldFindings(integration, index) {
  const findings = [];
  const id = integration.id ?? null;
  const shape = (detail, findingId = id) => integrationFinding(INTEGRATION_SHAPE_CHECK, findingId, detail);

  if (typeof id !== 'string' || id === '') {
    findings.push(shape(`integrations[${index}] 的 "id" 不得為空`, null));
  }
  if (typeof integration.capability !== 'string' || integration.capability === '') {
    findings.push(shape(`integration "${id}" 的 "capability" 不得為空`));
  }
  if (!SUPPORT_STATUSES.has(integration.support_status)) {
    findings.push(shape(`integration "${id}" 的 "support_status" 須為 ${[...SUPPORT_STATUSES].join('／')} 之一（實際：${JSON.stringify(integration.support_status)}）`));
  }
  // 空字串是 I2 的直接繞過口：group="" 會被互斥判定當成「沒填」而整條略過，不互斥組就此消失。
  if (integration.exclusive_group !== null && (typeof integration.exclusive_group !== 'string' || integration.exclusive_group === '')) {
    findings.push(shape(`integration "${id}" 的 "exclusive_group" 必須是非空字串或 null（實際：${JSON.stringify(integration.exclusive_group)}）——不屬於任何互斥組請填 null`));
  }
  for (const field of ['triggers', 'outputs']) {
    if (!Array.isArray(integration[field])) {
      findings.push(shape(`integration "${id}" 的 "${field}" 必須是陣列`));
    }
  }
  for (const field of INTEGRATION_PATH_FIELDS) {
    if (integration[field] !== undefined && !Array.isArray(integration[field])) {
      findings.push(shape(`integration "${id}" 的 "${field}" 若宣告就必須是陣列（實際：${JSON.stringify(integration[field])}）`));
    }
  }
  return findings;
}

/** integration registry 頂層與逐筆欄位形狀。 */
export function checkIntegrationShape(registry) {
  const { findings, entries } = checkRegistryEnvelope(registry, {
    listKey: 'integrations',
    check: INTEGRATION_SHAPE_CHECK,
    makeFinding: integrationFinding,
  });
  if (entries === null) return findings;
  entries.forEach((integration, index) => {
    if (!isPlainObject(integration)) return; // 非物件已由信封檢查報過
    findings.push(...integrationFieldFindings(integration, index));
  });
  return findings;
}

/** id 全表唯一（含只差大小寫／前後空白的近重複），訊息指名 id 與兩處出處。 */
export function checkIntegrationIds(registry) {
  return idHygieneFindings(integrationList(registry), {
    listKey: 'integrations',
    check: 'integration-id',
    makeFinding: integrationFinding,
  });
}

/** 選填的路徑欄位（docs）：填了就必須指向真的存在的檔案——三份 registry 的 dangling 同一套標準。 */
export function checkIntegrationPaths(registry, { pathExists, isFile } = {}) {
  if (typeof pathExists !== 'function') {
    throw new TypeError('checkIntegrationPaths 需要注入 pathExists(relPath) => boolean');
  }
  const findings = [];
  for (const integration of integrationList(registry)) {
    const id = integration?.id ?? null;
    const report = (check, tail) => integrationFinding(check, id, `integration "${id}" 的 ${tail}`);
    for (const field of INTEGRATION_PATH_FIELDS) {
      const value = integration?.[field];
      if (!Array.isArray(value)) continue; // 未宣告＝不適用；宣告成非陣列由 shape 負責
      findings.push(...pathEntryFindings(value, {
        label: field,
        shapeCheck: 'integration-path-shape',
        existsCheck: 'integration-path-exists',
        report,
        pathExists,
        isFile,
      }));
    }
  }
  return findings;
}

/** I2：同一個 exclusive_group 內至多一個 supported（group 為 null 者不互斥、不參與）。 */
export function checkIntegrationExclusiveGroups(registry) {
  const supportedByGroup = new Map();
  for (const integration of integrationList(registry)) {
    const group = integration?.exclusive_group;
    if (typeof group !== 'string' || group === '') continue;
    if (integration?.support_status !== 'supported') continue;
    const ids = supportedByGroup.get(group) ?? [];
    ids.push(integration.id ?? null);
    supportedByGroup.set(group, ids);
  }

  const findings = [];
  for (const [group, ids] of supportedByGroup) {
    if (ids.length <= 1) continue;
    findings.push(integrationFinding(
      'integration-exclusive-group',
      ids[0],
      `"exclusive_group"="${group}" 內有 ${ids.length} 個 "support_status"=supported（${ids.join('、')}）——同組至多一個`,
    ));
  }
  return findings;
}

/**
 * I4：lifecycle 六個階段鍵必須齊全，每個值是指令字串或 null。
 * 本檔只讀字串形狀，絕不執行其中任何指令——registry 是宣告，不是執行入口。
 */
export function checkIntegrationLifecycle(registry) {
  const findings = [];
  for (const integration of integrationList(registry)) {
    const id = integration?.id ?? null;
    const lifecycle = integration?.lifecycle;
    if (!isPlainObject(lifecycle)) {
      findings.push(integrationFinding('integration-lifecycle', id, `integration "${id}" 的 "lifecycle" 必須是物件`));
      continue;
    }
    for (const stage of LIFECYCLE_STAGES) {
      if (!(stage in lifecycle)) {
        findings.push(integrationFinding('integration-lifecycle', id, `integration "${id}" 的 "lifecycle" 缺少階段 "${stage}"（無此能力請顯式填 null）`));
        continue;
      }
      const command = lifecycle[stage];
      if (command === null) continue;
      if (typeof command !== 'string' || command === '') {
        findings.push(integrationFinding(
          'integration-lifecycle',
          id,
          `integration "${id}" 的 "lifecycle.${stage}" 必須是非空指令字串或 null（實際：${JSON.stringify(command)}）`,
        ));
      }
    }
    const unknownStages = Object.keys(lifecycle).filter((key) => !LIFECYCLE_STAGES.includes(key));
    for (const stage of unknownStages) {
      findings.push(integrationFinding('integration-lifecycle', id, `integration "${id}" 的 "lifecycle" 有未定義階段 "${stage}"`));
    }
  }
  return findings;
}

/** I5：被 component 的 required_checks.integrations 引用的 id 必須存在於 integration registry（跨表 dangling）。 */
export function checkIntegrationRefs(integrationRegistry, componentRegistry) {
  const known = new Set(integrationList(integrationRegistry)
    .map((i) => i?.id)
    .filter((id) => typeof id === 'string' && id !== ''));

  const findings = [];
  for (const component of componentList(componentRegistry)) {
    const id = component?.id ?? null;
    stringArrayOf(component?.required_checks?.integrations).forEach((ref, index) => {
      if (known.has(ref)) return;
      findings.push(componentFinding(
        'integration-ref',
        id,
        `component "${id}" 的 "required_checks.integrations[${index}]" 指向不存在的 integration id："${ref}"`,
      ));
    });
  }
  return findings;
}

/**
 * I6：自由文字欄不得寫死平台專屬工具名或 vendor model id。
 * 這條必須由本檔自帶：compat-lint 的檔案 walker 只收 .md，掃不到 registry 的 .json，
 * 靠它等於一條恆真的空綠；正則與 scanner 仍重用 compat-lint 的單一份實作。
 */
export function checkIntegrationNeutralText(registry) {
  const findings = [];
  for (const integration of integrationList(registry)) {
    const id = integration?.id ?? null;
    for (const field of INTEGRATION_FREE_TEXT_FIELDS) {
      const value = integration?.[field];
      const texts = typeof value === 'string' ? [value] : stringArrayOf(value);
      texts.forEach((text, index) => {
        const label = typeof value === 'string' ? field : `${field}[${index}]`;
        for (const hit of [...scanPlatformToolNames(text), ...scanVendorModelIds(text)]) {
          findings.push(integrationFinding(
            'integration-platform-neutral',
            id,
            `integration "${id}" 的 "${label}" 出現${hit.check === 'platform-tool-name' ? '平台專屬工具名' : ' vendor model id'} "${hit.match}"——自由文字欄只寫能力描述`,
          ));
        }
      });
    }
  }
  return findings;
}

/**
 * 彙整 integration 單表檢查。跨表的 I5 不在此——它需要 component registry，
 * 由 buildReport 無條件呼叫 checkIntegrationRefs（integration 表缺席時以空表代入，
 * 這樣「引用了不存在的 integration」仍會紅，不會因為缺檔而變成空綠）。
 */
export function checkIntegrations(registry, ctx = {}) {
  const shapeFindings = checkIntegrationShape(registry);
  if (shapeFindings.length > 0) return shapeFindings;
  return [
    ...checkIntegrationIds(registry),
    ...checkIntegrationPaths(registry, ctx),
    ...checkIntegrationExclusiveGroups(registry),
    ...checkIntegrationLifecycle(registry),
    ...checkIntegrationNeutralText(registry),
  ];
}

// ── T8：affected-source 查詢（哪些 component 被動到、連帶要跑哪些檢查）──────────────

/** 統一成 repo 相對、正斜線的比較形式（Windows 傳進來的反斜線路徑也要能命中）。 */
function normalizeRepoPath(value) {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function componentOwnsPath(component, path) {
  return stringArrayOf(component?.paths).some((owned) => globCovers(normalizeRepoPath(owned), path));
}

/**
 * T8：給一組改動路徑，回「要跑哪些檢查」。
 * 沿 consumers 做傳遞閉包——改到被依賴的元件，下游消費者的檢查也得跑，只看直接命中會漏。
 * 未命中任何 component 的路徑一律進 unmatched：靜默回空等於宣告「這次改動不用跑任何檢查」，
 * 那是這支工具最危險的假綠，寧可讓查詢的人看到 registry 沒登記這條路徑。
 */
export function computeAffected(componentRegistry, changedPaths) {
  const components = componentList(componentRegistry);
  const byId = new Map(components
    .filter((c) => typeof c?.id === 'string' && c.id !== '')
    .map((c) => [c.id, c]));

  const affected = new Set();
  const unmatched = [];
  for (const raw of Array.isArray(changedPaths) ? changedPaths : []) {
    const path = normalizeRepoPath(raw);
    if (path === '') continue;
    const owners = components.filter((c) => componentOwnsPath(c, path));
    if (owners.length === 0) {
      if (!unmatched.includes(path)) unmatched.push(path);
      continue;
    }
    for (const owner of owners) affected.add(owner.id);
  }

  const queue = [...affected];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const consumerId of stringArrayOf(byId.get(current)?.consumers)) {
      if (affected.has(consumerId) || !byId.has(consumerId)) continue; // dangling 由 C1 負責
      affected.add(consumerId);
      queue.push(consumerId);
    }
  }

  const buckets = Object.fromEntries(REQUIRED_CHECK_BUCKETS.map((bucket) => [bucket, new Set()]));
  for (const id of affected) {
    for (const bucket of REQUIRED_CHECK_BUCKETS) {
      for (const entry of stringArrayOf(byId.get(id)?.required_checks?.[bucket])) buckets[bucket].add(entry);
    }
  }

  const sorted = (set) => [...set].sort();
  return {
    components: sorted(affected),
    hooks: sorted(buckets.hooks),
    evals: sorted(buckets.evals),
    docs: sorted(buckets.docs),
    integrations: sorted(buckets.integrations),
    unmatched,
  };
}

/** affected 查詢的人讀輸出：四類必跑清單逐行列出，unmatched 明講「registry 沒登記」。 */
export function formatAffected(affected) {
  const lines = [`affected components（含 consumers 傳遞閉包）：${affected.components.join('、') || '無'}`];
  for (const bucket of REQUIRED_CHECK_BUCKETS) {
    lines.push(`必跑 ${bucket}：${affected[bucket].join('、') || '無'}`);
  }
  lines.push(affected.unmatched.length === 0
    ? 'unmatched：無（每條路徑都對得到已登記的 component）'
    : `unmatched（component-registry 沒登記，無法判定要跑什麼）：${affected.unmatched.join('、')}`);
  return lines.join('\n');
}

/**
 * 人讀摘要：全綠單行 ✓；否則逐條列 finding 與 decision。
 * decisions 必須被渲染——ok 已把它算進去，摘要漏印會讓「需要人決定」在人眼前消失。
 */
export function formatSummary(result) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const decisions = Array.isArray(result?.decisions) ? result.decisions : [];
  const notes = Array.isArray(result?.notes) ? result.notes : [];
  const noteLines = notes.map((note) => `· ${note}`);
  if (findings.length === 0 && decisions.length === 0) {
    const { policies = 0, components = 0, integrations = 0 } = result?.summary ?? {};
    const head = `✓ registry-compiler：policy ${policies} 條、component ${components} 個、integration ${integrations} 個，無 finding。`;
    return [head, ...noteLines].join('\n');
  }
  const lines = findings.map((f) => {
    const idPart = f.id ? ` id "${f.id}"` : '';
    return `✗ [${f.check}] ${f.severity ?? 'P1'} ${f.file ?? POLICY_REGISTRY_REL}${idPart} — ${f.detail}`;
  });
  for (const d of decisions) {
    lines.push(`✗ [${d.kind}] P1 ${POLICY_REGISTRY_REL} — 需要人決定`);
    lines.push(`  scope: ${d.scope}`);
    lines.push(`  rules: ${(d.rules ?? []).join(', ')}`);
    lines.push(`  reason: ${d.reason}`);
  }
  return lines.join('\n');
}

// ── IO 邊界：讀 registry 檔 + CLI main ─────────────────────────────────────────

const EMPTY_SUMMARY = { policies: 0, components: 0, integrations: 0 };

function emptyReport(findings) {
  return { ok: false, findings, notes: [], decisions: [], summary: { ...EMPTY_SUMMARY } };
}

// V8 的 JSON 錯誤有兩種形狀：一種帶 position，一種只回出錯處的原文片段。
const JSON_POSITION_RE = /position (\d+)/;
const JSON_SNIPPET_RE = /(?:\.\.\.)?"([\s\S]*)" is not valid JSON/;

/**
 * 片段形狀的訊息只給「出錯處前後那一小段原文」，取它在原文中的起點當定位：
 * 那個視窗起點落在錯誤點的前面幾個字元內，寧可指早一點，也不要順著視窗尾巴指到檔尾去。
 */
function jsonFailureOffset(raw, message) {
  const byPosition = message.match(JSON_POSITION_RE);
  if (byPosition) return Number(byPosition[1]);
  const bySnippet = message.match(JSON_SNIPPET_RE);
  if (!bySnippet) return null;
  const at = raw.indexOf(bySnippet[1]);
  return at === -1 ? null : at;
}

/**
 * 壞掉的 registry 一定要講「哪一份、大概第幾行」——對一份幾百行的 JSON，
 * 只說「解析失敗」等於要人自己二分搜尋。V8 只在部分錯誤型態給 position，
 * 另一種只給出錯處的原文片段，兩種都換算成行號；兩種線索都拿不到就退回原訊息，
 * 寧可少一句，也不要報一個猜出來的行號。
 */
function parseFailureDetail(rel, raw, message) {
  const offset = jsonFailureOffset(raw, message);
  if (offset === null) return `${rel}：${message}`;
  return `${rel}：${message}（約在第 ${raw.slice(0, offset).split('\n').length} 行）`;
}

/**
 * 讀一份選用的 registry：檔案不存在 → { registry: null }（呼叫端記成指名該檔的 skipped note）；
 * 存在但壞掉 → { findings }（缺檔可以是「還沒建」，壞檔一律是紅）。
 * 壞檔訊息一定要帶出是哪一份檔案 —— parseRegistryJson 只講「JSON 解析失敗＋位置」，
 * 三份 registry 共用同一句話，不冠檔名就看不出要去修哪一個。
 */
function loadOptionalRegistry(absPath, rel) {
  if (!existsSync(absPath)) return { registry: null };
  const raw = readFileSync(absPath, 'utf8');
  const parsed = parseRegistryJson(raw);
  if (parsed.error) {
    return { registry: null, findings: [finding('registry-parse', null, parseFailureDetail(rel, raw, parsed.error), rel)] };
  }
  return { registry: parsed.registry };
}

/** 讀 root 底下三份 registry，跑全部檢查，組成完整結果物件。 */
export function buildReport(root, opts = {}) {
  const abs = (rel) => join(root, ...rel.split('/'));
  const policyPath = opts.policy ?? abs(POLICY_REGISTRY_REL);

  let raw;
  try {
    raw = readFileSync(policyPath, 'utf8');
  } catch {
    return emptyReport([finding('policy-registry-file', null, `找不到 policy registry：${policyPath}`)]);
  }

  const parsedPolicy = parseRegistryJson(raw);
  if (parsedPolicy.error) {
    return emptyReport([finding('policy-registry-parse', null, parseFailureDetail(POLICY_REGISTRY_REL, raw, parsedPolicy.error))]);
  }

  const pathExists = (rel) => existsSync(abs(String(rel)));
  // 「存在」與「是檔案」分兩個 port：只問存在，projection 指到一個目錄也會被當成合格目標。
  const isFile = (rel) => {
    try {
      return statSync(abs(String(rel))).isFile();
    } catch {
      return false;
    }
  };
  const readText = (rel) => {
    const target = abs(String(rel));
    return isFile(rel) ? readFileSync(target, 'utf8') : null;
  };

  const component = loadOptionalRegistry(abs(COMPONENT_REGISTRY_REL), COMPONENT_REGISTRY_REL);
  const integration = loadOptionalRegistry(abs(INTEGRATION_REGISTRY_REL), INTEGRATION_REGISTRY_REL);

  const { findings: policyFindings, decisions } = checkPolicies(parsedPolicy.registry, { pathExists, isFile, readText });
  const notes = describeScopeRelations(parsedPolicy.registry);

  const findings = [...policyFindings, ...(component.findings ?? []), ...(integration.findings ?? [])];
  if (component.registry) {
    findings.push(...checkComponents(component.registry, { pathExists, isFile }));
  } else if (!component.findings) {
    notes.push(`skipped：找不到 ${COMPONENT_REGISTRY_REL}，component 面檢查未執行`);
  }
  if (integration.registry) {
    findings.push(...checkIntegrations(integration.registry, { pathExists, isFile }));
  } else if (!integration.findings) {
    notes.push(`skipped：找不到 ${INTEGRATION_REGISTRY_REL}，integration 單表檢查未執行`);
  }
  // I5 無條件跑：integration 表缺席時以空表代入，引用不存在的 id 仍然紅。
  findings.push(...checkIntegrationRefs(integration.registry ?? {}, component.registry ?? {}));

  return {
    ok: findings.length === 0 && decisions.length === 0,
    findings,
    notes,
    decisions,
    summary: {
      policies: policyList(parsedPolicy.registry).length,
      components: componentList(component.registry).length,
      integrations: integrationList(integration.registry).length,
    },
  };
}

function defaultRoot() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return join(scriptDir, '..', '..', '..');
}

/**
 * affected 查詢的 IO 邊界：讀 component registry，跑純函式 computeAffected。
 * registry 缺席或壞掉時往 stderr 講一聲並指名檔案——所有路徑都會落進 unmatched，
 * 不說一聲會讓「registry 讀不到」長得跟「這些路徑沒登記」一模一樣。
 */
export function buildAffectedReport(root, changedPaths) {
  const componentPath = join(root, ...COMPONENT_REGISTRY_REL.split('/'));
  const loaded = loadOptionalRegistry(componentPath, COMPONENT_REGISTRY_REL);
  if (!loaded.registry) {
    const why = loaded.findings ? loaded.findings[0].detail : `找不到 ${COMPONENT_REGISTRY_REL}`;
    console.error(`! affected 查詢讀不到 component registry：${why}`);
  }
  return computeAffected(loaded.registry ?? {}, changedPaths);
}

function parseArgs(argv) {
  const opts = { root: defaultRoot(), policy: null, json: false, affected: null, strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--root') opts.root = argv[++i] ?? opts.root;
    else if (flag === '--policy') opts.policy = argv[++i] ?? null;
    else if (flag === '--json') opts.json = true;
    else if (flag === '--strict') opts.strict = true;
    else if (flag === '--affected') opts.affected = (argv[++i] ?? '').split(',');
  }
  return opts;
}

/**
 * --affected 是查詢不是 lint：exit code 一律 0，讓它能安全地餵給別的指令。
 * 要讓 CI 因為「改到沒登記的路徑」而擋，得顯式加 --strict。
 */
function runAffected(opts) {
  const affected = buildAffectedReport(opts.root, opts.affected);
  console.log(opts.json ? JSON.stringify(affected, null, 2) : formatAffected(affected));
  return opts.strict && affected.unmatched.length > 0 ? 1 : 0;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.affected) {
    process.exit(runAffected(opts));
  }
  const result = buildReport(opts.root, { policy: opts.policy });
  console.log(opts.json ? JSON.stringify(result, null, 2) : formatSummary(result));
  process.exit(result.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2));
}
