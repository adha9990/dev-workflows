#!/usr/bin/env node
// phase-vocabulary-gate.mjs —— Phase Vocabulary Gate（#219）。
//
// 要解的問題：#219 把 `clarify`／`goal`／`explore`／`iterate` 從 phase 表移出去（它們分別是
// capability 或 control node）。這種重構最典型的失敗形狀不是「改不完」，而是**改了一半**：
// registry 換成新詞彙、但某份文件的流程圖還畫著舊七階段、某支腳本還寫死一份舊 stage 清單，
// 於是舊八階段與新五階段長期並行——兩套詞彙一起活著，報表對不起來，也沒有人會發現。
//
// 所以本檔查四件事（每一件都可否證、都指名檔案與字面）：
//   ① **vocabulary 自洽** —— phase 表不得含已退場的 id；退場項的 successor 指得到；capability 引用的
//      activity／role 真的存在。
//   ② **artifact registry** —— producer 不得是已退場的 phase。
//   ③ **文字面的流程鏈** —— 主流程圖／phase 表不得再串著退場的 phase（`goal → explore → plan …`、
//      `goal/explore/plan/build/verify/iterate`）。只抓**串連形狀**，不抓單獨提到那幾個字的句子：
//      解釋「goal 為什麼不再是 phase」本來就得寫出它的名字。
//   ④ **程式碼裡寫死的 stage 清單** —— `['goal', 'explore', …]` 這種 array literal 是第二份詞彙來源，
//      registry 一改它就落後。讀舊 loop 的相容碼是例外（明列在 allowlist）。
//
// 用法：node phase-vocabulary-gate.mjs [--root <dir>] [--json]

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadWorkflowVocabulary } from './artifact-contract.mjs';
import { parseRegistryJson } from './check-registry-shape.mjs';

const SCAN_SKIP_DIRS = new Set(['.git', '.claude', 'node_modules', '.loops']);
const TEXT_FILE_RE = /\.(md|json)$/;
const CODE_FILE_RE = /\.mjs$/;

/**
 * 允許保留舊詞彙的地方，逐項附理由。
 * 這份名單刻意短：每多一條，就多一個「舊詞彙在這裡是合法的」的例外，而例外會被下一個人當成慣例。
 */
export const PHASE_VOCABULARY_ALLOWLIST = [
  {
    file: 'plugins/loops-workflow/references/workflow-vocabulary.json',
    reason: 'canonical 詞彙本身：retired_phases 區段就是用來記錄哪些 phase 退場、退到哪裡去，必須寫得出舊 id。',
  },
  {
    file: 'plugins/loops-workflow/scripts/loop-migrate.mjs',
    reason: '舊 loop 的讀取相容：遷移器要認得舊 Journal 裡的 stage 名，才讀得回舊事件流（#219 明列「舊 .loops 不回填、只維持讀取相容」）。',
  },
  {
    file: 'plugins/loops-workflow/scripts/phase-vocabulary-gate.mjs',
    reason: '本檔自己：檢查邏輯與說明文字必然寫出要抓的舊字面。',
  },
];

/** 掃描面（相對 repo 根）。evals 的凍結語料不在內——那是評測輸入的快照，改字面等於竄改語料。 */
export const SCAN_ROOTS = Object.freeze([
  'AGENTS.md',
  'README.md',
  'docs',
  '.claude-plugin',
  'plugins/loops-workflow/docs',
  'plugins/loops-workflow/skills',
  'plugins/loops-workflow/references',
  'plugins/loops-workflow/agents',
  'plugins/loops-workflow/.claude-plugin',
  'plugins/loops-workflow/.codex-plugin',
  'plugins/loops-workflow/scripts',
  'plugins/loops-workflow/hooks',
]);

const norm = (p) => String(p ?? '').split('\\').join('/');

/**
 * 測試檔與 fixtures 底下的合成資料：裡面的舊 stage 名是斷言用的假值，不是還活著的第二份詞彙。
 * 判準沿用 repo 既有的「這些檔是測試資料」慣例（`test-*.mjs` ＋ `fixtures/`），不另立一份名單。
 * 測試本身當然要跟著改，但那由測試自己失敗來逼——不是由這道閘。
 */
export function isSyntheticFixture(rel) {
  return /(^|\/)test-[^/]+\.mjs$/.test(rel) || /(^|\/)fixtures\//.test(rel);
}

function finding(check, file, detail) {
  return { check, severity: 'P1', file, detail };
}

// ── ① vocabulary 自洽 ───────────────────────────────────────────────────────

/** phase 表不得含退場 id；successor 指得到；capability 引用的 activity／role 存在。 */
export function checkVocabularySelfConsistency(vocabulary) {
  const findings = [];
  const file = 'plugins/loops-workflow/references/workflow-vocabulary.json';
  const phaseIds = new Set((vocabulary?.phases ?? []).map((p) => p.id));
  const controlIds = new Set((vocabulary?.control_nodes ?? []).map((c) => c.id));
  const capabilityIds = new Set((vocabulary?.capabilities ?? []).map((c) => c.id));
  const activityIds = new Set((vocabulary?.activities ?? []).map((a) => a.id));
  const roleIds = new Set((vocabulary?.knowledge?.roles ?? []).map((r) => r.id));
  const retired = vocabulary?.retired_phases ?? [];

  if (retired.length === 0) {
    findings.push(finding('vocabulary-retired-missing', file, 'retired_phases 不得為空——沒有退場紀錄，就沒有東西能證明舊詞彙已經被移除（#219）'));
  }

  for (const r of retired) {
    if (phaseIds.has(r.id)) {
      findings.push(finding('retired-still-a-phase', file, `「${r.id}」同時出現在 phases 與 retired_phases——退場了就不該還是 phase`));
    }
    const s = r.successor ?? {};
    const exists = (s.kind === 'phase' && phaseIds.has(s.id))
      || (s.kind === 'control_node' && controlIds.has(s.id))
      || (s.kind === 'capability' && capabilityIds.has(s.id));
    if (!exists) {
      findings.push(finding('retired-successor-missing', file, `「${r.id}」的 successor（${s.kind ?? '?'}:${s.id ?? '?'}）在 vocabulary 裡找不到——退場沒有去處，等於這條規則沒有落點`));
    }
  }

  for (const c of vocabulary?.capabilities ?? []) {
    for (const a of c.activities ?? []) {
      if (!activityIds.has(a)) findings.push(finding('capability-activity-missing', file, `capability「${c.id}」引用的 activity「${a}」不存在`));
    }
    for (const role of c.roles ?? []) {
      if (!roleIds.has(role)) findings.push(finding('capability-role-missing', file, `capability「${c.id}」引用的 role「${role}」不在 knowledge.roles`));
    }
  }

  for (const e of vocabulary?.entries ?? []) {
    if (e.start_phase !== null && !phaseIds.has(e.start_phase)) {
      findings.push(finding('entry-phase-missing', file, `入口「${e.id}」的 start_phase「${e.start_phase}」不是 canonical phase`));
    }
  }

  const checkpointIds = new Set((vocabulary?.handoff?.checkpoints ?? []).map((c) => c.id));
  for (const c of vocabulary?.handoff?.checkpoints ?? []) {
    if (!phaseIds.has(c.after_phase)) {
      findings.push(finding('checkpoint-phase-missing', file, `checkpoint「${c.id}」的 after_phase「${c.after_phase}」不是 canonical phase`));
    }
  }
  for (const s of vocabulary?.handoff?.stop_after ?? []) {
    if (!checkpointIds.has(s)) {
      findings.push(finding('stop-after-missing-checkpoint', file, `stop_after「${s}」沒有對應的 checkpoint`));
    }
  }

  return findings;
}

// ── ② artifact registry ────────────────────────────────────────────────────

export function checkArtifactProducers(registry, retiredIds) {
  const file = 'plugins/loops-workflow/references/artifact-registry.json';
  return (registry?.artifacts ?? [])
    .filter((a) => retiredIds.has(a.producer))
    .map((a) => finding('retired-producer', file, `artifact「${a.artifact_id}」的 producer 仍是已退場的「${a.producer}」`));
}

// ── ③ 文字面的流程鏈 ───────────────────────────────────────────────────────

const CHAIN_SEPARATOR = /\s*(?:→|->|＞|>)\s*/;
const SLASH_SEPARATOR = /\s*[/／、]\s*/;
const TOKEN_RE = /^[a-z][a-z-]*$/;

/**
 * 一行文字裡有沒有「串著退場 phase 的流程鏈」→ 命中的鏈（沒有回 []）。
 *
 * 判準刻意是**串連**而非單一字面：`goal → explore → plan` 是在畫流程；「goal 不再是 phase」是在解釋。
 * 只抓前者——把後者也抓進來，等於禁止文件說明這次改了什麼。
 *
 * 斜線串（`a/b/c`）另外要求鏈裡有 **2 個以上 canonical phase**：`clarify` 同時也是合法的 activity id，
 * 而 activity 清單（`route/clarify/author-issue…`）長得跟流程串一模一樣。少了這道界，
 * 每一份列出 activity 的文件都會變紅，而那不是這道閘要抓的東西。
 */
export function findRetiredChains(line, retiredIds, phaseIds = new Set()) {
  const hits = [];
  const scan = (separator, kind, requirePhases) => {
    for (const segment of String(line).split(/[，。；()（）「」`|]/)) {
      const parts = segment.split(separator).map((t) => t.trim().toLowerCase()).filter(Boolean);
      if (parts.length < 3) continue;
      if (!parts.every((t) => TOKEN_RE.test(t))) continue;
      if (!parts.some((t) => retiredIds.has(t))) continue;
      if (requirePhases && parts.filter((t) => phaseIds.has(t)).length < 2) continue;
      hits.push({ kind, chain: parts.join(kind === 'arrow' ? ' → ' : '/') });
    }
  };
  scan(CHAIN_SEPARATOR, 'arrow', false);
  scan(SLASH_SEPARATOR, 'slash', true);
  return hits;
}

// ── ④ 程式碼裡寫死的 stage 清單 ────────────────────────────────────────────

const ARRAY_LITERAL_RE = /\[((?:\s*'[a-z][a-z-]*'\s*,){2,}\s*'[a-z][a-z-]*'\s*)\]/g;

/**
 * 一段程式碼裡有沒有「寫死且含退場 phase」的 stage 清單 → 命中的字面。
 * 同樣要求清單裡有 2 個以上 canonical phase——否則 `['dispatch', 'goal', 'setup']`（skill 名清單）
 * 與 activity 清單都會被誤判成第二份 phase 詞彙。
 */
export function findHardcodedStageLists(source, retiredIds, phaseIds = new Set()) {
  const hits = [];
  for (const m of String(source).matchAll(ARRAY_LITERAL_RE)) {
    const items = m[1].split(',').map((t) => t.trim().replace(/^'|'$/g, '')).filter(Boolean);
    if (!items.some((t) => retiredIds.has(t))) continue;
    if (items.filter((t) => phaseIds.has(t)).length < 2) continue;
    hits.push(`[${items.map((i) => `'${i}'`).join(', ')}]`);
  }
  return hits;
}

// ── IO 薄邊界 ──────────────────────────────────────────────────────────────

function walk(root, base) {
  const out = [];
  let stat;
  try { stat = statSync(root); } catch { return out; }
  if (stat.isFile()) return [root];
  for (const name of readdirSync(root)) {
    if (SCAN_SKIP_DIRS.has(name)) continue;
    const full = join(root, name);
    try {
      if (statSync(full).isDirectory()) out.push(...walk(full, base));
      else out.push(full);
    } catch { /* 單一檔失敗跳過 */ }
  }
  return out;
}

export function buildReport(repoRoot, opts = {}) {
  const pluginRoot = join(repoRoot, 'plugins', 'loops-workflow');
  const loaded = opts.vocabulary ? { vocabulary: opts.vocabulary } : loadWorkflowVocabulary(pluginRoot);
  if (loaded.error) {
    return { ok: false, findings: [finding('vocabulary-load', 'plugins/loops-workflow/references/workflow-vocabulary.json', loaded.error)] };
  }
  const vocabulary = loaded.vocabulary;
  const retiredIds = new Set((vocabulary.retired_phases ?? []).map((r) => r.id));

  const findings = [...checkVocabularySelfConsistency(vocabulary)];

  const registryRaw = (() => {
    try { return readFileSync(join(pluginRoot, 'references', 'artifact-registry.json'), 'utf8'); } catch { return null; }
  })();
  if (registryRaw) {
    const parsed = parseRegistryJson(registryRaw);
    if (!parsed.error) findings.push(...checkArtifactProducers(parsed.registry, retiredIds));
  }

  const phaseIds = new Set((vocabulary.phases ?? []).map((p) => p.id));
  const allowed = new Set(PHASE_VOCABULARY_ALLOWLIST.map((a) => a.file));
  let scanned = 0;
  for (const rootRel of SCAN_ROOTS) {
    for (const abs of walk(join(repoRoot, rootRel), repoRoot)) {
      const rel = norm(relative(repoRoot, abs));
      if (allowed.has(rel) || isSyntheticFixture(rel)) continue;
      const isText = TEXT_FILE_RE.test(rel);
      const isCode = CODE_FILE_RE.test(rel);
      if (!isText && !isCode) continue;
      let content;
      try { content = readFileSync(abs, 'utf8'); } catch { continue; }
      scanned += 1;

      if (isText) {
        content.split(/\r?\n/).forEach((line, i) => {
          for (const hit of findRetiredChains(line, retiredIds, phaseIds)) {
            findings.push(finding('retired-phase-chain', `${rel}:${i + 1}`, `流程鏈仍串著已退場的 phase：${hit.chain}`));
          }
        });
      }
      if (isCode) {
        for (const hit of findHardcodedStageLists(content, retiredIds, phaseIds)) {
          findings.push(finding('hardcoded-stage-list', rel, `寫死的 stage 清單含已退場的 phase：${hit}——值域請從 references/workflow-vocabulary.json 取`));
        }
      }
    }
  }

  return { ok: findings.length === 0, findings, scanned };
}

export function formatSummary(report) {
  if (report.ok) return `✓ phase-vocabulary-gate：${report.scanned ?? 0} 檔全綠，phase 詞彙沒有新舊並行。`;
  return [`✗ phase-vocabulary-gate：${report.findings.length} 個 finding。`,
    ...report.findings.map((f) => `  ✗ [${f.check}] ${f.file} — ${f.detail}`)].join('\n');
}

// ── CLI ────────────────────────────────────────────────────────────────────

function defaultRepoRoot() {
  return join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
}

function main() {
  const args = process.argv.slice(2);
  const repoRoot = args.includes('--root') ? args[args.indexOf('--root') + 1] : defaultRepoRoot();
  const report = buildReport(repoRoot);
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${formatSummary(report)}\n`);
  return report.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
