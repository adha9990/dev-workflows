#!/usr/bin/env node
// codex-plugin-lint.mjs —— Tier A 機械 guard（#182）：驗證 Codex 薄 adapter（.codex-plugin/plugin.json
// ＋ .agents/plugins/marketplace.json）與既有 Claude 薄 adapter 是否同步、marketplace 是否正確指向
// canonical 樹、以及全 repo 有沒有人偷偷複製第二份 skills/references 樹（零複製不變式）。
// 分層：
//   1) 解析 / 判定層（純函式，無 IO）：parsePluginManifest / codexPluginRequiredFieldsCheck /
//      manifestEqualityCheck / marketplaceNameCheck / sourcePathCheck / duplicateTreeCheck /
//      formatSummary —— 給單元測試直接 import。
//   2) IO 薄邊界：walkRepo（掃檔）與 CLI main（組裝、印出、決定 exit code）——
//      main 被 import 時不執行（import.meta.url 守門）。
// 依賴：僅 node 內建（fs / path / url / process），無外部套件。
// 用法：node codex-plugin-lint.mjs [--root <dir>] [--json]
//
// 掃描基準＝repo root（--root 預設 repo root，不是 plugin-local）——marketplace.json 掛在 repo 根，
// plugin manifest 掛在 plugins/loops-workflow/ 底下，兩者必須同一次掃描才能對帳（#182 plan M2）。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CANONICAL_MARKETPLACE_NAME = 'dev-workflows';
const CODEX_MANIFEST_REL = 'plugins/loops-workflow/.codex-plugin/plugin.json';
const CLAUDE_MANIFEST_REL = 'plugins/loops-workflow/.claude-plugin/plugin.json';
const CODEX_MARKETPLACE_REL = '.agents/plugins/marketplace.json';
const CLAUDE_MARKETPLACE_REL = '.claude-plugin/marketplace.json';
const REQUIRED_CODEX_PLUGIN_FIELDS = ['name', 'version', 'description'];
const REQUIRED_SKILLS_VALUE = './skills/';
// 掃複製樹只認這兩個目錄名（本 repo 唯一在意的 canonical 內容樹）；掃描時排除的整棵目錄
// （不進遞迴）與「路徑含 fixtures 段」的檔案（自己的假 fixture 不該被當成真違規）。
const TREE_TOPIC_DIR_NAMES = ['skills', 'references'];
const EXCLUDED_DIR_NAMES = new Set(['.loops', '.claude', '.git', 'node_modules', '.superpowers']);

// ── 解析 / 判定層（純函式，無 IO，測試直接 import）──────────────────────────────

/**
 * 解析 plugin.json / marketplace.json 原始字串 → { manifest } 或 { error }。
 * 非合法 JSON、或解析出來不是物件（含陣列）→ { error: 訊息字串 }（呼叫端據此判斷「檔案本身壞了」，
 * 不會誤以為是空物件而悄悄放行）。
 */
export function parsePluginManifest(content) {
  let parsed;
  try {
    parsed = JSON.parse(String(content ?? ''));
  } catch (e) {
    return { error: `JSON 解析失敗：${e.message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'manifest 內容不是合法的 JSON 物件' };
  }
  return { manifest: parsed };
}

/**
 * .codex-plugin/plugin.json 必要欄位檢查（契約 C1）：name/version/description 缺一不可、
 * author.name 缺一不可、skills 欄位必須明寫 "./skills/"（不依賴 Claude 式資料夾慣例自動探——
 * 官方三份真實 manifest 範例皆明寫字串，不能省略或寫成別的路徑形狀）。全部 P1（執行期會真的
 * 被 Codex 解析器拒收或誤判）。
 */
export function codexPluginRequiredFieldsCheck(manifest, file) {
  const findings = [];
  for (const key of REQUIRED_CODEX_PLUGIN_FIELDS) {
    const value = manifest?.[key];
    if (value == null || value === '') {
      findings.push({ check: 'codex-plugin-required-field', severity: 'P1', file, detail: `缺少必要欄位 "${key}"` });
    }
  }
  if (!manifest?.author?.name) {
    findings.push({ check: 'codex-plugin-required-field', severity: 'P1', file, detail: '缺少必要欄位 "author.name"' });
  }
  if (manifest?.skills !== REQUIRED_SKILLS_VALUE) {
    findings.push({
      check: 'codex-plugin-required-field',
      severity: 'P1',
      file,
      detail: `"skills" 欄位須明寫 "${REQUIRED_SKILLS_VALUE}"（實際：${JSON.stringify(manifest?.skills)}）`,
    });
  }
  return findings;
}

/**
 * .codex-plugin/plugin.json 與 .claude-plugin/plugin.json 的 name/version 等值斷言（契約 C1 M3：
 * 同步靠 lint 機械對帳，不靠記得）。files 為 [codexFile, claudeFile] 供 finding 標示雙檔。
 */
export function manifestEqualityCheck(codexManifest, claudeManifest, files) {
  const [codexFile, claudeFile] = Array.isArray(files) ? files : [CODEX_MANIFEST_REL, CLAUDE_MANIFEST_REL];
  const findings = [];
  if (codexManifest?.name !== claudeManifest?.name) {
    findings.push({
      check: 'manifest-name-equality',
      severity: 'P1',
      file: `${codexFile}, ${claudeFile}`,
      detail: `name 不一致：.codex-plugin="${codexManifest?.name}" vs .claude-plugin="${claudeManifest?.name}"`,
    });
  }
  if (codexManifest?.version !== claudeManifest?.version) {
    findings.push({
      check: 'manifest-version-equality',
      severity: 'P1',
      file: `${codexFile}, ${claudeFile}`,
      detail: `version 不一致：.codex-plugin="${codexManifest?.version}" vs .claude-plugin="${claudeManifest?.version}"`,
    });
  }
  return findings;
}

/**
 * marketplace root name 等值斷言（契約 C2 R2：`codex plugin add loops-workflow@dev-workflows` 的
 * `@dev-workflows` 靠這個名字才解析得到）。兩邊 marketplace.json 的 name 都要等於 expectedName，
 * 不只是彼此相等——任一邊漂走都會讓對應 harness 的 marketplace 識別失效。
 */
export function marketplaceNameCheck({ codexMarketplace, claudeMarketplace, expectedName }) {
  const findings = [];
  if (codexMarketplace?.name !== expectedName) {
    findings.push({
      check: 'marketplace-name',
      severity: 'P1',
      file: CODEX_MARKETPLACE_REL,
      detail: `name 應為 "${expectedName}"，實際 "${codexMarketplace?.name}"`,
    });
  }
  if (claudeMarketplace?.name !== expectedName) {
    findings.push({
      check: 'marketplace-name',
      severity: 'P1',
      file: CLAUDE_MARKETPLACE_REL,
      detail: `name 應為 "${expectedName}"，實際 "${claudeMarketplace?.name}"`,
    });
  }
  return findings;
}

/**
 * marketplace 每個 plugin 條目的 source.path 是否解析得到 canonical 樹（契約 C2：零複製不變式的
 * 前提是 marketplace 真的指向既有目錄，不是隨口寫一個不存在的路徑）。existsFn 以 port 注入
 * （純函式可測；IO 層呼叫端負責把相對路徑解析到 root 下再判斷是否存在）。
 */
export function sourcePathCheck(codexMarketplace, existsFn) {
  const findings = [];
  const plugins = Array.isArray(codexMarketplace?.plugins) ? codexMarketplace.plugins : [];
  for (const entry of plugins) {
    const path = entry?.source?.path;
    if (typeof path !== 'string' || !existsFn(path)) {
      findings.push({
        check: 'marketplace-source-path',
        severity: 'P1',
        file: CODEX_MARKETPLACE_REL,
        detail: `plugin "${entry?.name}" 的 source.path "${path}" 無法解析至 canonical 樹`,
      });
    }
  }
  return findings;
}

// skill-local 形狀（.../skills/<skillname>/references/...）是既有合法慣例（每個 skill 可以有自己的
// references 子目錄），不算跟 plugin 層 references/ 競爭的複製樹——仿 skill-lint.mjs 的
// isUnderSkillsDir 判斷，這裡判斷的是「候選 topic 目錄的父路徑是否已經落在某個 skills/<name>/ 底下」。
const NESTED_UNDER_SKILL_RE = /(^|\/)skills\/[^/]+($|\/)/;

function isNestedUnderSkillDir(parentPath) {
  return NESTED_UNDER_SKILL_RE.test(parentPath);
}

/**
 * 全 repo 零複製樹檢查：同一個內容主題（skills / references）若有一個以上「非 skill-local」的擁有
 * 目錄，代表有人複製了第二份（例如誤把 Codex 專用的一份 skills 塞進 `.codex-plugin/skills/`）——
 * 單一 canonical 樹是 #168 硬條件，這裡機械擋。filePaths 為 repo-relative posix 路徑陣列（IO 層已
 * 套用排除規則）。
 */
export function duplicateTreeCheck(filePaths) {
  const list = Array.isArray(filePaths) ? filePaths : [];
  const rootsByTopic = new Map(TREE_TOPIC_DIR_NAMES.map((t) => [t, new Set()]));

  for (const relPath of list) {
    const segments = String(relPath).split('/');
    for (let i = 0; i < segments.length - 1; i += 1) {
      if (!TREE_TOPIC_DIR_NAMES.includes(segments[i])) continue;
      const parentPath = segments.slice(0, i).join('/');
      if (isNestedUnderSkillDir(parentPath)) continue; // skill-local，不計入 plugin 層樹的擁有目錄
      rootsByTopic.get(segments[i]).add(segments.slice(0, i + 1).join('/'));
    }
  }

  const findings = [];
  for (const topic of TREE_TOPIC_DIR_NAMES) {
    const roots = [...rootsByTopic.get(topic)];
    if (roots.length > 1) {
      findings.push({
        check: 'duplicate-tree',
        severity: 'P1',
        file: roots.join(', '),
        detail: `發現 ${roots.length} 個 ${topic}/ 樹（應只有一個 canonical）：${roots.join(', ')}`,
      });
    }
  }
  return findings;
}

/** 把整體檢查結果轉人讀摘要：全綠單行 ✓；有 finding → 逐條 "✗ [check] severity file — detail"。 */
export function formatSummary(result) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const filesScanned = result?.summary?.filesScanned ?? 0;

  if (findings.length === 0) {
    return `✓ codex-plugin-lint：${filesScanned} 檔全綠，無 finding。`;
  }
  return findings.map((f) => `✗ [${f.check}] ${f.severity} ${f.file} — ${f.detail}`).join('\n');
}

// ── IO 邊界：walkRepo（掃檔）+ CLI main ─────────────────────────────────────

function shouldSkipDir(name) {
  return EXCLUDED_DIR_NAMES.has(name) || name === 'fixtures';
}

function toRelPosix(root, absPath) {
  return relative(root, absPath).split('\\').join('/');
}

// 遞迴列出 root 底下所有檔案的 repo-relative posix 路徑；沿路跳過 EXCLUDED_DIR_NAMES 與任何名為
// fixtures 的目錄（本 lint 自己的假 fixture 不該被複製樹掃描誤判成真違規）。
function listFilesRecursive(root, dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      files.push(...listFilesRecursive(root, abs));
    } else if (entry.isFile()) {
      files.push(toRelPosix(root, abs));
    }
  }
  return files;
}

function readTextMaybe(absPath) {
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

/** 掃 root：回傳 { fileList, readManifest }。readManifest 依 repo-relative 路徑讀檔，讀不到回 null。 */
function walkRepo(root) {
  return {
    fileList: listFilesRecursive(root, root),
    readManifest: (rel) => readTextMaybe(join(root, ...rel.split('/'))),
  };
}

function manifestFindingsFor({ raw, rel, checkName }) {
  if (raw == null) {
    return { findings: [{ check: checkName, severity: 'P1', file: rel, detail: `找不到 ${rel}` }], manifest: null };
  }
  const parsed = parsePluginManifest(raw);
  if (parsed.error) {
    return { findings: [{ check: checkName, severity: 'P1', file: rel, detail: parsed.error }], manifest: null };
  }
  return { findings: [], manifest: parsed.manifest };
}

/** 掃描 root，跑全部檢查，組成完整結果物件（--json 與人讀摘要共用同一份）。 */
export function buildReport(root) {
  const { fileList, readManifest } = walkRepo(root);
  const findings = [];

  const codex = manifestFindingsFor({
    raw: readManifest(CODEX_MANIFEST_REL),
    rel: CODEX_MANIFEST_REL,
    checkName: 'codex-plugin-manifest',
  });
  findings.push(...codex.findings);
  if (codex.manifest) findings.push(...codexPluginRequiredFieldsCheck(codex.manifest, CODEX_MANIFEST_REL));

  const claude = manifestFindingsFor({
    raw: readManifest(CLAUDE_MANIFEST_REL),
    rel: CLAUDE_MANIFEST_REL,
    checkName: 'claude-plugin-manifest',
  });
  findings.push(...claude.findings);

  if (codex.manifest && claude.manifest) {
    findings.push(...manifestEqualityCheck(codex.manifest, claude.manifest, [CODEX_MANIFEST_REL, CLAUDE_MANIFEST_REL]));
  }

  const codexMkt = manifestFindingsFor({
    raw: readManifest(CODEX_MARKETPLACE_REL),
    rel: CODEX_MARKETPLACE_REL,
    checkName: 'codex-marketplace',
  });
  findings.push(...codexMkt.findings);

  const claudeMkt = manifestFindingsFor({
    raw: readManifest(CLAUDE_MARKETPLACE_REL),
    rel: CLAUDE_MARKETPLACE_REL,
    checkName: 'claude-marketplace',
  });
  findings.push(...claudeMkt.findings);

  if (codexMkt.manifest || claudeMkt.manifest) {
    findings.push(...marketplaceNameCheck({
      codexMarketplace: codexMkt.manifest ?? {},
      claudeMarketplace: claudeMkt.manifest ?? {},
      expectedName: CANONICAL_MARKETPLACE_NAME,
    }));
  }

  if (codexMkt.manifest) {
    findings.push(...sourcePathCheck(codexMkt.manifest, (relPath) => existsSync(join(root, relPath))));
  }

  findings.push(...duplicateTreeCheck(fileList));

  return {
    ok: findings.length === 0,
    findings,
    notes: [],
    summary: { filesScanned: fileList.length },
  };
}

function defaultRoot() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
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
