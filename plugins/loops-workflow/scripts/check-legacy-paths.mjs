#!/usr/bin/env node
// check-legacy-paths.mjs —— #171 T11①：舊路徑殘留檢查（可執行、可否證）。
//
// 為什麼要另一支工具、不是重用 reference-graph.mjs 的既有分類：reference-graph 只掃 plugin 樹
// （skill-lint 的 walk()：skills/agents/docs/references/hooks/scripts）、只認 references/ 字面，
// 目的是逐元件比對搬遷前後的內容漂移。本檢查的目的不同——找「還寫死著扁平舊路徑」的殘留字面，
// 範圍必須涵蓋 walk() 掃不到的角落（repo 根 docs/specs 的歷史設計文件、plugin 的 evals/ 凍結語料），
// 且同時要認 agents/ 與 references/ 兩種舊扁平根，用兩套不同目的的正則硬套同一支工具只會兩邊互相遷就。
//
// 判準：新結構下 agents/ 與 references/ 底下的檔案一律落在分類子目錄，任何字面若滿足
// `(references|agents)/<檔名>.md`（<檔名> 不含 `/`，即字面在 root 與 .md 之間只有一段）即為舊扁平形狀。
// 字元集刻意不含 `*`，等價於自動排除 glob 選取字面（如 `references/*.md`）——那是「泛指一批檔」的
// 描述性寫法、不是指向某個特定舊路徑，不屬於本檢查要抓的殘留。
//
// 兩層排除，第一層結構性（不必列名單，理由是「這本來就不是殘留」，全部重用既有單一定義）：
//   1) 佔位符檔名（xxx.md）—— 沿用 skill-lint 的 REFERENCE_PLACEHOLDER_FILENAMES，不重造第二份。
//   2) 合成測試檔——沿用 skill-lint 的 isExcludedFromLintScan（skill-lint.mjs／test-skill-lint.mjs
//      自身 ＋ hooks／scripts 下的 test-*.mjs）：這些檔裡的字面是斷言用的假值，reference-graph 的
//      fixture 分類也是同一份判準，不重造第二份「這些檔是測試資料」的定義。
//   3) skill-local：字面落在某個 skill 自己的 references 子目錄底下且真的存在（如
//      `skills/plan/SKILL.md` 提到某份規範檔名、實際檔就放在該 skill 自己的子目錄底下）——
//      它正確解析到一個現存檔案，根本不是「殘留」，只是採用 skill 自己的裸引用慣例
//      （reference-graph 也用同一條判準）。
// 第二層是明確 allowlist（本檔 LEGACY_PATH_ALLOWLIST，逐檔附理由）——結構性排除接不到的角落：
//   歷史設計文件——描述尚未落地功能的舊 spec，字面是文件寫成當下的用詞、不隨後續搬遷同步維護；
//   凍結評測語料——eval 的 corpus / gold artifact 是評測輸入輸出的凍結快照，改字面等於改了語料本身；
//   fixtures/ 負向資料——不是 test-*.mjs（isExcludedFromLintScan 認不到）、而是 fixtures/ 目錄底下
//   的合成 .json 測資，字面是測試斷言用的假值；
//   self-reference——本檔自己：allowlist 的 reason 欄位裡會引述別處檔案的舊字面作說明文字，
//   會被自己的正則命中，比照 skill-lint.mjs 排除自身的既有慣例。
// 不在這兩層任一層 → 判紅，指名 file + 字面。
//
// 用法：node check-legacy-paths.mjs [--root <dir>] [--json]

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { REFERENCE_PLACEHOLDER_FILENAMES, isExcludedFromLintScan } from './skill-lint.mjs';

const LEGACY_FLAT_RE = /(references|agents)\/([A-Za-z0-9_.-]+\.md)/g;
const SKILL_DIR_RE = /^(plugins\/[^/]+\/skills\/[^/]+)\//;
const SCAN_SKIP_DIRS = new Set(['.git', '.claude', 'node_modules']);
const SCAN_FILE_RE = /\.(md|mjs|json)$/;

// ── allowlist（明確列名、逐檔附理由；結構性排除〔佔位符／合成測試檔／skill-local〕接不到的角落）──

export const LEGACY_PATH_ALLOWLIST = [
  {
    file: 'docs/specs/2026-07-02-pr-watch-design.md',
    category: 'historical-design-doc',
    reason: '#171 之前的舊 spec，描述尚未落地的 pr-watch 功能；字面是撰寫當下（搬遷前）的扁平慣例，凍結為歷史紀錄、不隨後續搬遷同步改寫。',
  },
  {
    file: 'plugins/loops-workflow/evals/baseline/corpus/feature-150-reviewer-templating.json',
    category: 'frozen-eval-corpus',
    reason: 'eval baseline corpus：評測輸入的凍結快照，字面是語料本身的一部分，改字面等於竄改語料。',
  },
  {
    file: 'plugins/loops-workflow/evals/gold/artifacts/explanation-quality.json',
    category: 'frozen-eval-corpus',
    reason: 'eval gold artifact：judge 校準用的金標輸出快照，同上，字面屬凍結語料。',
  },
  {
    file: 'plugins/loops-workflow/scripts/fixtures/codex-bootstrap/clean-file-list.json',
    category: 'negative-fixture',
    reason: 'codex-plugin-lint 的合成檔案清單 fixture（非 test-*.mjs，isExcludedFromLintScan 認不到），字面是測試資料。',
  },
  {
    file: 'plugins/loops-workflow/scripts/fixtures/codex-bootstrap/duplicate-tree-file-list.json',
    category: 'negative-fixture',
    reason: '同上，另一個合成檔案清單 fixture。',
  },
  {
    file: 'plugins/loops-workflow/scripts/fixtures/registry-shape/registry-overrides-bad-scope.json',
    category: 'negative-fixture',
    reason: 'registry-shape 負向 fixture：刻意寫一個對不到任何檔的字面，用來斷言「查無此檔」分支會紅。',
  },
  {
    file: 'plugins/loops-workflow/scripts/check-legacy-paths.mjs',
    category: 'self-reference',
    reason: '本檔自身：allowlist 條目的 reason 欄位裡引述了別處檔案的舊扁平字面（如 plan-comment-template.md）作為說明文字，會被自己的正則命中；比照 skill-lint.mjs 排除自身的既有慣例。',
  },
];

// ── 判定層（純函式，無 IO）──────────────────────────────────────────────────────

/** 一段內容裡所有舊扁平字面（依出現順序）。 */
export function scanLegacyLiterals(content) {
  return [...String(content ?? '').matchAll(LEGACY_FLAT_RE)].map((m) => m[0]);
}

function skillRootOf(file) {
  return String(file ?? '').match(SKILL_DIR_RE)?.[1] ?? null;
}

/**
 * 整份檔案是否結構性地豁免掃描（合成測試檔——內容全是假值，逐條字面判定沒有意義）。
 * 沿用 skill-lint 單一定義，不重造第二份「這是測試資料」判準。
 */
export function isFileStructurallyExempt(file) {
  return isExcludedFromLintScan(file);
}

/**
 * 一處字面是否結構性地不算殘留（佔位符 / skill-local 正確解析）。
 * skillLocalExists 由呼叫端注入（IO 已在邊界完成，這裡純判定）。
 */
export function isStructurallyExempt(file, literal, { skillLocalExists = () => false } = {}) {
  const filename = literal.split('/').pop();
  if (REFERENCE_PLACEHOLDER_FILENAMES.has(filename)) return true;
  const skillRoot = skillRootOf(file);
  if (skillRoot && literal.startsWith('references/') && skillLocalExists(`${skillRoot}/${literal}`)) return true;
  return false;
}

/**
 * 檔案 map（relPath → 內容）→ findings。allowlist 用 file 全豁免（見檔頭理由分類）；
 * 不在 allowlist 也非結構性豁免 → 逐條指名判紅。
 */
export function checkLegacyPaths(fileMap, { allowlist = LEGACY_PATH_ALLOWLIST, skillLocalExists = () => false } = {}) {
  const allowed = new Map(allowlist.map((e) => [e.file, e]));
  const findings = [];

  for (const file of Object.keys(fileMap ?? {}).sort()) {
    if (isFileStructurallyExempt(file)) continue;
    const literals = scanLegacyLiterals(fileMap[file]);
    if (literals.length === 0) continue;
    if (allowed.has(file)) continue;

    for (const literal of literals) {
      if (isStructurallyExempt(file, literal, { skillLocalExists })) continue;
      findings.push({
        check: 'legacy-flat-path',
        severity: 'P1',
        file,
        detail: `${literal}：扁平舊路徑殘留（新結構下 references/ 與 agents/ 底下都應落在分類子目錄），且不在 allowlist（見 check-legacy-paths.mjs 的 LEGACY_PATH_ALLOWLIST）`,
      });
    }
  }

  return { ok: findings.length === 0, findings };
}

export function formatSummary(result) {
  if (result?.ok) return `✓ check-legacy-paths：無舊扁平路徑殘留（allowlist ${LEGACY_PATH_ALLOWLIST.length} 檔已知豁免）。`;
  return (result?.findings ?? []).map((f) => `✗ [${f.check}] ${f.severity} ${f.file} — ${f.detail}`).join('\n');
}

// ── IO 邊界：掃全樹（含 walk() 掃不到的 docs/specs、evals/）＋ CLI main ─────────────

function walkRepo(root) {
  const map = {};
  (function recurse(dir) {
    for (const name of readdirSync(dir)) {
      if (SCAN_SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) recurse(abs);
      else if (SCAN_FILE_RE.test(name)) {
        const rel = abs.slice(root.length + 1).split(sep).join('/');
        map[rel] = readFileSync(abs, 'utf8');
      }
    }
  })(root);
  return map;
}

export function buildReport(root) {
  const fileMap = walkRepo(root);
  const skillLocalExists = (rel) => existsSync(join(root, ...rel.split('/')));
  return checkLegacyPaths(fileMap, { skillLocalExists });
}

function defaultRoot() {
  const scriptDir = fileURLToPath(new URL('.', import.meta.url));
  return join(scriptDir, '..', '..', '..');
}

function parseArgs(argv) {
  const opts = { root: defaultRoot(), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--root') opts.root = argv[++i] ?? opts.root;
    else if (flag === '--json') opts.json = true;
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const result = buildReport(opts.root);
  console.log(opts.json ? JSON.stringify(result, null, 2) : formatSummary(result));
  process.exit(result.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2));
}
