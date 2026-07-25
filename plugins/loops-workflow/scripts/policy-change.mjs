#!/usr/bin/env node
// policy-change.mjs —— 規則變更閉環的機械層（#175）。
//
// 情境：使用者在 issue 過程中說「幫我把這條規則加進 plugin」。過去的做法偏向**只改 `AGENTS.md`**，
// 於是規則有寫、卻沒有任何東西在執行它；而且沒人先查「這條是不是已經有了 / 會不會跟既有規則打架」。
//
// 本檔提供四件**可機械判定**的事，讓 `skills/agents-md-maintainer` 的流程不必靠人記得：
//   1. `analyzeProposal()` —— 對既有 policy registry 做 duplicate / coverage / conflict 分析，
//      給出六種判定與各自的**唯一建議動作**；真衝突只回**一個**要問人的問題，未回答前不得建 issue。
//   2. `validateProposal()` / `renderProposalIssue()` —— proposal issue 的固定版型（九個必填區塊）。
//   3. `gateChangeSet()` —— **doc-only 的 policy PR 一律擋**：依規則的 tier 反查它至少該動到哪些面
//      （registry／projection 文件／執行它的 hook 或 script／測試／eval），少一面就指名少了什麼。
//   4. `gateOptimizerChange()` —— optimizer（SkillOpt 等）**不得**改 policy registry、hard hooks、
//      approval contract、eval oracle：那些是規則本身與判定基準，讓自動最佳化去動它等於讓被考的人改考卷。
//
// 純函式為主；registry 讀檔在 IO 薄邊界。依賴：僅 node 內建 ＋ 同目錄的 registry-compiler / policy-runtime。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { relateScopes, classifyConflict, CONFLICT_NEEDS_HUMAN, CONFLICT_AUTO_RESOLVED } from './registry-compiler.mjs';
import { POLICY_TIERS } from './policy-runtime.mjs';

/**
 * 五層架構（#168 的架構邊界）。每條規則要歸屬其中一層——歸不出來通常代表這條規則其實是兩條，
 * 或者它根本不是規則而是一個做法偏好。
 */
export const ARCH_LAYERS = Object.freeze(['harness', 'graph', 'loop', 'context', 'prompt']);

/** 每層一句話，供 proposal issue 直接引用（不必每次重寫）。 */
export const LAYER_DESCRIPTIONS = Object.freeze({
  harness: 'tools · hooks · worktrees · CI —— 動作發生的地方',
  graph: 'workflow graph · code graph —— 工作與程式碼之間的結構',
  loop: 'stages · gates · convergence —— 一條 loop 怎麼推進與收斂',
  context: 'retrieval · context pack · memory —— 每一步看得到什麼',
  prompt: 'skills · agents · questions —— 對模型怎麼說',
});

/** 六種判定。 */
export const CHANGE_VERDICTS = Object.freeze(['duplicate', 'compatible-extension', 'scoped-difference', 'true-contradiction', 'unknown', 'novel']);

/** 每種判定的**唯一**建議動作——不給「看情況」，否則等於沒分析。 */
export const VERDICT_ACTION = Object.freeze({
  duplicate: 'reuse-or-edit-existing',
  'compatible-extension': 'modify-existing',
  'scoped-difference': 'add-explicit-condition',
  'true-contradiction': 'ask-user-one-question',
  unknown: 'stop-do-not-guess',
  novel: 'create-new',
});

/** proposal issue 的固定區塊（缺一不可）。 */
export const PROPOSAL_SECTIONS = Object.freeze([
  'problem', 'purpose', 'related', 'layer', 'impact', 'enforcement', 'human_docs', 'affected_sources', 'acceptance',
]);

/** 每個區塊的中文標題（渲染用）。 */
const SECTION_TITLES = Object.freeze({
  problem: '問題（現在會出什麼包）',
  purpose: '這條規則要達成什麼',
  related: '相關 / 衝突的既有規則',
  layer: '五層歸屬',
  impact: '影響到的 stages / agents / tools / files',
  enforcement: '執行層級（tier）與怎麼擋',
  human_docs: '人要讀的文件怎麼改',
  affected_sources: '受影響的來源（含外部 optimizer）',
  acceptance: '驗收與回歸',
});

/**
 * 一次**完整**的規則變更，依 tier 至少要動到哪些面。
 * 這張表就是「PR 不得只改 AGENTS.md」的機械化定義。
 */
export const REQUIRED_TOUCH_BY_TIER = Object.freeze({
  'hard-invariant': ['registry', 'projection', 'hook', 'test'],
  'workflow-invariant': ['registry', 'projection', 'script', 'test'],
  semantic: ['registry', 'projection', 'eval'],
  advisory: ['registry', 'projection', 'prompt'],
});

/** 各「面」怎麼從檔案路徑認出來。 */
const TOUCH_MATCHERS = Object.freeze({
  registry: (f) => /references\/policy-registry\.json$/.test(f),
  projection: (f) => /(^|\/)AGENTS\.md$/.test(f) || /references\/.+\.md$/.test(f) || /docs\/.+\.md$/.test(f),
  hook: (f) => /hooks\/[^/]+\.mjs$/.test(f) && !/hooks\/test-/.test(f),
  script: (f) => /scripts\/[^/]+\.mjs$/.test(f) && !/scripts\/test-/.test(f),
  test: (f) => /(hooks|scripts)\/test-[^/]+\.mjs$/.test(f),
  eval: (f) => /evals\//.test(f),
  prompt: (f) => /(skills|agents)\//.test(f),
});

/** 每個「面」少了的時候要講的人話。 */
const TOUCH_HINTS = Object.freeze({
  registry: '規則的正式來源在 references/policy-registry.json，沒改它等於這條規則不存在',
  projection: '人要讀得到：AGENTS.md／references／docs 至少要有一處寫下這條規則',
  hook: 'tier=hard-invariant 要有一支 hooks/*.mjs 真的擋得住，否則只是宣稱',
  script: 'tier=workflow-invariant 要有一支 scripts/*.mjs 狀態閘在查',
  test: '沒有測試的規則沒人守得住——改了執行者就要有對應的 test-*.mjs',
  eval: 'tier=semantic 由 eval 承接，evals/ 下要有對應案例',
  prompt: 'tier=advisory 由 skills／agents 正文承接，要真的寫進去',
});

/**
 * optimizer（SkillOpt 等自動最佳化）**絕不可**改的東西：規則本身、擋人的 hook、
 * 逃生口契約、以及評分基準。讓自動最佳化去動它們＝讓被考的人改考卷。
 */
export const OPTIMIZER_PROTECTED = Object.freeze([
  { pattern: /references\/policy-registry\.json$/, reason: 'policy registry 是規則的正式來源' },
  { pattern: /hooks\/(?!test-)[^/]+\.mjs$/, reason: 'hard hook 是擋人的機械層' },
  { pattern: /scripts\/policy-runtime\.mjs$/, reason: 'approval contract（逃生口）的判定實作' },
  { pattern: /scripts\/eval-oracle\.mjs$/, reason: 'eval oracle 是評分基準' },
  { pattern: /evals\/gold\//, reason: 'gold artifact 是評分基準的凍結快照' },
]);

// ── 分析（純函式）───────────────────────────────────────────────────────────

/** 正規化一句要求：去空白與標點，只留可比對的字元。 */
export function normalizeRequirement(text) {
  return String(text ?? '').toLowerCase().replace(/[\s`"'()（）、，。．,.:：;；「」【】\-_/]/g, '');
}

const reqSet = (p) => new Set([...(p?.requires ?? []), ...(p?.forbids ?? [])].map(normalizeRequirement).filter(Boolean));
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * 兩個 scope 是否**完全一樣**。
 * 刻意不拿 `relateScopes` 的 `'contains'` 當「相同」——它對「完全相同」與「一方涵蓋另一方」回同一個
 * 標籤（實測：兩個一模一樣的 path-based scope 回 `contains`），拿它判重複會把「擴大涵蓋範圍」誤判成
 * 「已經有一條一樣的了」。重複的判準是**逐維度相同**。
 */
function sameScope(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  const dim = (s) => (s.kind === 'path-based' ? s.paths : s.activities) ?? [];
  const norm = (xs) => [...new Set((Array.isArray(xs) ? xs : []).filter((x) => typeof x === 'string' && x))].sort().join('|');
  return norm(dim(a)) === norm(dim(b)) && norm(a.stages) === norm(b.stages);
}

/**
 * 對既有 registry 分析一份 proposal。回：
 * `{ verdict, action, related[], question, reason }`
 *
 * `question` 只在 `true-contradiction` 時非 null，而且**永遠只有一題**——真衝突要人拍板的是
 * 「哪一條贏」這一件事，問三題只會讓人放棄回答。
 */
export function analyzeProposal(proposal, registry) {
  const policies = Array.isArray(registry?.policies) ? registry.policies : [];
  if (!proposal || !proposal.scope || typeof proposal.scope !== 'object' || !proposal.scope.kind) {
    return { verdict: 'unknown', action: VERDICT_ACTION.unknown, related: [], question: null, reason: 'proposal 沒有可解析的 scope——無從判斷它與既有規則的關係，停下來補清楚，不要猜 precedence' };
  }

  const related = [];
  let contradiction = null;
  let scopedDifference = null;
  let duplicate = null;
  let extension = null;

  for (const p of policies) {
    if (p?.id === proposal.id) continue; // 同 id 是「編輯這條」，不是新增
    const relation = relateScopes(proposal.scope, p?.scope);
    if (relation === 'disjoint') continue;
    const verdictPair = classifyConflict(proposal, p);
    const entry = { id: p.id, relation, status: verdictPair.status, reason: verdictPair.reason };
    related.push(entry);

    if (verdictPair.status === CONFLICT_NEEDS_HUMAN) { contradiction ??= entry; continue; }
    if (verdictPair.status === CONFLICT_AUTO_RESOLVED) { scopedDifference ??= { ...entry, winner: verdictPair.winner }; continue; }
    // 無 clash：scope 逐維度相同且要求集合也相同 ⇒ 重複；否則是相容擴充
    if (sameScope(proposal.scope, p?.scope) && sameSet(reqSet(proposal), reqSet(p))) duplicate ??= entry;
    else extension ??= entry;
  }

  if (contradiction) {
    return {
      verdict: 'true-contradiction',
      action: VERDICT_ACTION['true-contradiction'],
      related,
      question: `新規則「${proposal.id}」與既有規則「${contradiction.id}」在同一 scope 上要求互斥，且兩者嚴格度相同、沒有 precedence 可排。要哪一條贏？（${contradiction.reason}）`,
      reason: '真衝突：未經使用者拍板前不得建 issue、不得寫規則',
    };
  }
  if (duplicate) {
    return { verdict: 'duplicate', action: VERDICT_ACTION.duplicate, related, question: null, reason: `與「${duplicate.id}」scope 與要求完全相同——改既有那條，不要再開一條` };
  }
  if (scopedDifference) {
    return { verdict: 'scoped-difference', action: VERDICT_ACTION['scoped-difference'], related, question: null, reason: `與「${scopedDifference.id}」要求互斥但可由 forbid-wins／precedence 排序（勝方 ${scopedDifference.winner ?? '?'}）——在兩條上各寫明適用條件，別留給讀者推理` };
  }
  if (extension) {
    return { verdict: 'compatible-extension', action: VERDICT_ACTION['compatible-extension'], related, question: null, reason: `與「${extension.id}」scope ${extension.relation} 且要求不互斥——擴充既有那條，不要疊一條新的` };
  }
  return { verdict: 'novel', action: VERDICT_ACTION.novel, related, question: null, reason: '與既有規則 scope 無交集，是一條新規則' };
}

// ── proposal issue（純函式）────────────────────────────────────────────────

/** proposal 的九個必填區塊都在、且非空。 */
export function validateProposal(proposal) {
  const errors = [];
  if (!proposal || typeof proposal !== 'object') return { ok: false, errors: ['proposal 不是物件'] };
  if (typeof proposal.id !== 'string' || !proposal.id.trim()) errors.push('缺 id');
  if (!POLICY_TIERS.includes(proposal.tier)) errors.push(`tier 須為 ${POLICY_TIERS.join('／')} 之一`);
  if (!ARCH_LAYERS.includes(proposal.layer)) errors.push(`layer 須為 ${ARCH_LAYERS.join('／')} 之一（歸不出層通常代表這其實是兩條規則）`);
  for (const s of PROPOSAL_SECTIONS) {
    if (s === 'layer') continue; // 由上面的 layer 欄位承載
    const v = proposal[s];
    const empty = v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0);
    if (empty) errors.push(`區塊 ${s}（${SECTION_TITLES[s]}）不得為空`);
  }
  return { ok: errors.length === 0, errors };
}

/** proposal → issue 內文（repo house style：繁中敘述、identifier 保留英文）。 */
export function renderProposalIssue(proposal, analysis) {
  const asList = (v) => (Array.isArray(v) ? v.map((x) => `- ${x}`).join('\n') : String(v ?? ''));
  const out = [
    `## ${SECTION_TITLES.problem}`, '', String(proposal.problem ?? ''), '',
    `## ${SECTION_TITLES.purpose}`, '', String(proposal.purpose ?? ''), '',
    `## ${SECTION_TITLES.related}`, '',
    analysis ? `判定：**${analysis.verdict}** → 建議動作 \`${analysis.action}\`（${analysis.reason}）` : '（未分析）', '',
    analysis && analysis.related.length ? analysis.related.map((r) => `- \`${r.id}\`（scope ${r.relation}）：${r.reason}`).join('\n') : '- （與既有規則無交集）', '',
    `## ${SECTION_TITLES.layer}`, '', `\`${proposal.layer}\` —— ${LAYER_DESCRIPTIONS[proposal.layer] ?? ''}`, '',
    `## ${SECTION_TITLES.impact}`, '', asList(proposal.impact), '',
    `## ${SECTION_TITLES.enforcement}`, '', `tier \`${proposal.tier}\`：${String(proposal.enforcement ?? '')}`, '',
    `## ${SECTION_TITLES.human_docs}`, '', asList(proposal.human_docs), '',
    `## ${SECTION_TITLES.affected_sources}`, '', asList(proposal.affected_sources), '',
    `## ${SECTION_TITLES.acceptance}`, '', asList(proposal.acceptance), '',
  ];
  return out.join('\n');
}

// ── 閘（純函式）────────────────────────────────────────────────────────────

/** 這批改動碰到了哪些「面」。 */
export function touchedFacets(files) {
  const touched = new Set();
  for (const f of files || []) {
    const path = String(f).split('\\').join('/');
    for (const [facet, match] of Object.entries(TOUCH_MATCHERS)) if (match(path)) touched.add(facet);
  }
  return touched;
}

/**
 * **doc-only 的 policy PR 一律擋**：依 tier 反查必須動到的面，少一面就指名少了什麼與為什麼。
 * 只改 `AGENTS.md` 的規則變更是這條要擋的典型形狀——規則有寫、沒有任何東西在執行它。
 */
export function gateChangeSet(files, { tier } = {}) {
  if (!POLICY_TIERS.includes(tier)) {
    return { ok: false, missing: [], reason: `無法判定 tier（實際：${JSON.stringify(tier)}）——不知道這條規則由誰執行，就無從檢查這次改動完不完整` };
  }
  const required = REQUIRED_TOUCH_BY_TIER[tier];
  const touched = touchedFacets(files);
  const missing = required.filter((f) => !touched.has(f));
  if (!missing.length) return { ok: true, missing: [], reason: null };
  return {
    ok: false,
    missing,
    reason: `tier=${tier} 的規則變更還少了 ${missing.length} 面：\n${missing.map((m) => `- ${m}：${TOUCH_HINTS[m]}`).join('\n')}`,
  };
}

/** optimizer 這批改動有沒有碰到不該碰的東西。 */
export function gateOptimizerChange(files) {
  const violations = [];
  for (const f of files || []) {
    const path = String(f).split('\\').join('/');
    for (const { pattern, reason } of OPTIMIZER_PROTECTED) {
      if (pattern.test(path)) violations.push({ file: path, reason });
    }
  }
  return {
    ok: violations.length === 0,
    violations,
    reason: violations.length ? `optimizer 不得改這些檔（規則本身與判定基準）：\n${violations.map((v) => `- ${v.file}：${v.reason}`).join('\n')}` : null,
  };
}

// ── IO 薄邊界 ────────────────────────────────────────────────────────────────

function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/** 讀 policy registry（讀不到 → null）。 */
export function loadPolicyRegistry(root = repoRoot()) {
  try {
    return JSON.parse(readFileSync(join(root, 'plugins', 'loops-workflow', 'references', 'policy-registry.json'), 'utf8'));
  } catch {
    return null;
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--gate-change')) {
    const tier = args[args.indexOf('--tier') + 1];
    const files = args.filter((a) => !a.startsWith('--') && a !== tier);
    const g = gateChangeSet(files, { tier });
    process.stdout.write(g.ok ? '✓ 規則變更涵蓋完整\n' : `✗ ${g.reason}\n`);
    return g.ok ? 0 : 1;
  }
  if (args.includes('--gate-optimizer')) {
    const files = args.filter((a) => !a.startsWith('--'));
    const g = gateOptimizerChange(files);
    process.stdout.write(g.ok ? '✓ optimizer 沒有碰到受保護的檔\n' : `✗ ${g.reason}\n`);
    return g.ok ? 0 : 1;
  }
  process.stdout.write([
    '用法：',
    '  node policy-change.mjs --gate-change --tier <tier> <改到的檔...>   查規則變更是否只改了文件',
    '  node policy-change.mjs --gate-optimizer <改到的檔...>              查 optimizer 有沒有碰規則本身',
    `  五層：${ARCH_LAYERS.join('／')}｜六種判定：${CHANGE_VERDICTS.join('／')}`,
    '',
  ].join('\n'));
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
