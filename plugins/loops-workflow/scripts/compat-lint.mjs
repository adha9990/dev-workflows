#!/usr/bin/env node
// compat-lint.mjs —— 雙 harness 相容層 drift 檢查（#183）：C3「canonical 散文的平台表面禁令」——
// skills / references / plugin-docs / repo-root / root-docs 這五個文字面，不准寫死平台專屬互動
// 工具名、廠商 model ID、未標平台邊界的機制細節；三種明確標註的豁免（adapter-projection 區塊、
// 緊貼訊號詞的 inline code span、runtime scoped span）之外，逮到就紅。
// 分層：
//   1) 掃描 / 判定層（純函式，無 IO）：scanPlatformToolNames / scanVendorModelIds /
//      scanMechanismDetails / scanViolations（三合一）、findAdapterProjectionRanges /
//      findRuntimeScopeRanges / findInlineCodeSpans / isAdjacentToSignal / classifyExemption /
//      lintFileText（單檔文字 → findings + notes）、isExcludedPath / normalizeScopes /
//      formatSummary —— 給單元測試直接 import。
//   2) IO 薄邊界：listScopeFiles（依 scope 掃檔）與 CLI main（組裝、印出、決定 exit code）——
//      main 被 import 時不執行（import.meta.url 守門）。
// 依賴：僅 node 內建（fs / path / url / process），無外部套件。
// 用法：node compat-lint.mjs [--root <dir>] [--scope <a,b,c>] [--json]
//
// notes 設計理由：每一筆被豁免的命中都逐筆記錄（file:line — 豁免種類 — 原文片段），不是只讓
// findings 歸零就收工——否則「整段包 marker」就能不真正抽象化、豁免面積會隱形，notes 讓豁免面積
// 對審查者可見（#183 plan「不得靜默假裝已執行」同源精神）。
//
// 本次只實作 C3；C2（能力對照表對帳）、C4（persona 能力等級對帳）留給後續任務接續同一支腳本。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── 常數 ─────────────────────────────────────────────────────────────────

const SCOPE_IDS = ['skills', 'references', 'plugin-docs', 'repo-root', 'root-docs'];

// scope → 掃描基準目錄 + 是否遞迴（references 頂層 .md 才算，其餘遞迴）。
const SCOPE_DIR_DEFS = {
  skills: { baseDir: 'plugins/loops-workflow/skills', recursive: true },
  references: { baseDir: 'plugins/loops-workflow/references', recursive: false },
  'plugin-docs': { baseDir: 'plugins/loops-workflow/docs', recursive: true },
  'repo-root': { baseDir: 'docs', recursive: true },
};
// root-docs 不是目錄掃描，是明確兩個檔案（repo 根 AGENTS.md、README.md）。
const ROOT_DOCS_FILES = ['AGENTS.md', 'README.md'];

// 排除集（寫死，比照 codex-plugin-lint.mjs 的 EXCLUDED_DIR_NAMES）：
// - 生成真相源（reviewer 人設由 gen-reviewers.mjs 生成，不是手寫 canonical 散文）
// - agents/**（同樣是生成產物）
// - scaffold-fullstack/assets/**（要 scaffold 出去的專案模板，不是本 plugin 的規則文字）
const EXCLUDED_PATH_PREFIXES = [
  'plugins/loops-workflow/references/reviewers/',
  'plugins/loops-workflow/agents/',
  'plugins/loops-workflow/skills/scaffold-fullstack/assets/',
];
const EXCLUDED_EXACT_FILES = new Set(['plugins/loops-workflow/references/reviewer-shared.md']);
const EXCLUDED_DIR_NAMES = new Set(['.loops', '.claude', '.git', 'node_modules', '.superpowers', 'fixtures']);

// 三類違規（各自獨立正則，findings 用 check 欄位分類）。
const PLATFORM_TOOL_NAME_RE = /\b(AskUserQuestion|EnterWorktree|TodoWrite|ExitPlanMode|SlashCommand)\b/g;
// opus/sonnet/haiku 獨立單字大小寫不分；claude- 開頭的 model id 整段吃掉（含版本號），避免同一個
// token 被兩條規則各報一次（例如 "claude-opus-4-1-20250805" 只報一筆，不是 claude- 開頭一筆、
// opus 又一筆）。
const VENDOR_MODEL_ID_RE = /\bclaude-[A-Za-z0-9][\w.-]*|\b(?:opus|sonnet|haiku)\b/gi;
const MECHANISM_DETAIL_RE = /\b(hookSpecificOutput|permissionDecision|PreToolUse|PostToolUse|costs\.jsonl|CLAUDE_PLUGIN_ROOT|CLAUDE_CODE_SESSION_ID)\b/g;

// 訊號詞豁免：訊號詞與 inline code span 開始位置之間相隔不超過這個字元數（不含換行）才算「緊貼」。
const SIGNAL_WORDS = ['例如', '討論', '比方', '舉例', '像是', 'e.g.'];
const SIGNAL_ADJACENCY_MAX_GAP = 12;

const EXEMPTION_LABELS = {
  adapterProjection: 'adapter-projection 標記區塊豁免',
  runtimeScope: (runtime) => `runtime 標記範圍豁免（${runtime}）`,
  signalWordSpan: 'inline code span 緊貼訊號詞豁免',
};

// ── 掃描 / 判定層（純函式，無 IO，測試直接 import）──────────────────────────────

function scanPattern(text, regex, check) {
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
  const out = [];
  let m = re.exec(text);
  while (m !== null) {
    out.push({ check, index: m.index, length: m[0].length, match: m[0] });
    if (m[0].length === 0) re.lastIndex += 1; // 防禦：理論上三條正則都不會零寬，仍保留防無限迴圈
    m = re.exec(text);
  }
  return out;
}

/** 違規①：平台專屬互動／能力工具名（AskUserQuestion 等 5 個）。 */
export function scanPlatformToolNames(text) {
  return scanPattern(text, PLATFORM_TOOL_NAME_RE, 'platform-tool-name');
}

/** 違規②：vendor model ID（opus/sonnet/haiku 獨立單字、claude- 開頭 id，大小寫不分）。 */
export function scanVendorModelIds(text) {
  return scanPattern(text, VENDOR_MODEL_ID_RE, 'vendor-model-id');
}

/** 違規③：未標平台邊界的機制細節（hook payload 欄位、CLAUDE_* 環境變數等）。 */
export function scanMechanismDetails(text) {
  return scanPattern(text, MECHANISM_DETAIL_RE, 'mechanism-detail');
}

/** 三合一：合併三類違規、依出現順序（index）排序，供 lintFileText 逐筆過豁免判定。 */
export function scanViolations(text) {
  return [...scanPlatformToolNames(text), ...scanVendorModelIds(text), ...scanMechanismDetails(text)]
    .sort((a, b) => a.index - b.index);
}

function findMarkerRanges(text, markerName) {
  const re = new RegExp(`<!--\\s*${markerName}\\s*-->[\\s\\S]*?<!--\\s*/${markerName}\\s*-->`, 'g');
  const ranges = [];
  let m = re.exec(text);
  while (m !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex += 1;
    m = re.exec(text);
  }
  return ranges;
}

/** 豁免①的區段：`<!-- adapter-projection -->` … `<!-- /adapter-projection -->`。 */
export function findAdapterProjectionRanges(text) {
  return findMarkerRanges(text, 'adapter-projection');
}

/** 豁免③的區段：`<!-- runtime: claude|codex -->` … `<!-- /runtime -->`（記下是哪個 runtime）。 */
export function findRuntimeScopeRanges(text) {
  const re = /<!--\s*runtime:\s*(claude|codex)\s*-->([\s\S]*?)<!--\s*\/runtime\s*-->/g;
  const ranges = [];
  let m = re.exec(text);
  while (m !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length, runtime: m[1] });
    if (m[0].length === 0) re.lastIndex += 1;
    m = re.exec(text);
  }
  return ranges;
}

/**
 * 全文所有單反引號 inline code span，回傳 { start, end, contentStart, contentEnd }
 * （start/end 含反引號本身；content 不含）。span 不跨行（markdown inline code 慣例）。
 */
export function findInlineCodeSpans(text) {
  const re = /`([^`\n]*)`/g;
  const spans = [];
  let m = re.exec(text);
  while (m !== null) {
    spans.push({
      start: m.index,
      end: m.index + m[0].length,
      contentStart: m.index + 1,
      contentEnd: m.index + m[0].length - 1,
    });
    m = re.exec(text);
  }
  return spans;
}

/**
 * 豁免②的「緊貼」判定：span 級，不是行級。從 spanStart（開反引號位置）往前找最近一個訊號詞，
 * 兩者間隔（不計換行字元）須 ≤ SIGNAL_ADJACENCY_MAX_GAP 才算緊貼。每個訊號詞只取「最靠近
 * spanStart 的那一次出現」（`lastIndexOf` 已保證）；同一行其他不緊貼的訊號詞不影響判定
 * ——這正是 S3b 反例要鎖住的行為：訊號詞緊貼第一個 span，不代表同行後面的 span 也豁免。
 */
export function isAdjacentToSignal(text, spanStart) {
  for (const word of SIGNAL_WORDS) {
    const idx = text.lastIndexOf(word, spanStart - 1);
    if (idx === -1) continue;
    const wordEnd = idx + word.length;
    if (wordEnd > spanStart) continue; // 訊號詞尾端不可能蓋過 span 起點，防禦性跳過
    const gap = text.slice(wordEnd, spanStart).replace(/[\r\n]/g, '').length;
    if (gap <= SIGNAL_ADJACENCY_MAX_GAP) return true;
  }
  return false;
}

/**
 * 一筆違規命中是否落在三種豁免之一：命中 → { label }；沒命中 → null。
 * 順序：adapter-projection → runtime scope → 緊貼訊號詞的 inline code span
 * （三者互斥的機會很低，這裡採「第一個符合的就回」，不強求窮舉所有可能原因）。
 */
export function classifyExemption({ text, violation, adapterRanges, runtimeRanges, spans }) {
  const vStart = violation.index;
  const vEnd = violation.index + violation.length;

  const inAdapter = adapterRanges.find((r) => vStart >= r.start && vEnd <= r.end);
  if (inAdapter) return { label: EXEMPTION_LABELS.adapterProjection };

  const inRuntime = runtimeRanges.find((r) => vStart >= r.start && vEnd <= r.end);
  if (inRuntime) return { label: EXEMPTION_LABELS.runtimeScope(inRuntime.runtime) };

  const enclosingSpan = spans.find((s) => vStart >= s.contentStart && vEnd <= s.contentEnd);
  if (enclosingSpan && isAdjacentToSignal(text, enclosingSpan.start)) {
    return { label: EXEMPTION_LABELS.signalWordSpan };
  }

  return null;
}

function buildLineIndex(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

function lineOf(lineOffsets, index) {
  let lo = 0;
  let hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineOffsets[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * 單檔文字 → { findings, notes }。findings 是非豁免命中（Finding 形狀，含新增 optional line）；
 * notes 是每一筆被豁免的命中（"file:line — 豁免種類 — 原文片段"），逐筆輸出，不彙總、不省略
 * ——理由見檔頭：不這樣做的話豁免面積會隱形。
 */
export function lintFileText(text, file) {
  const violations = scanViolations(text);
  const adapterRanges = findAdapterProjectionRanges(text);
  const runtimeRanges = findRuntimeScopeRanges(text);
  const spans = findInlineCodeSpans(text);
  const lineOffsets = buildLineIndex(text);

  const findings = [];
  const notes = [];

  for (const violation of violations) {
    const line = lineOf(lineOffsets, violation.index);
    const exemption = classifyExemption({ text, violation, adapterRanges, runtimeRanges, spans });
    if (exemption) {
      notes.push(`${file}:${line} — ${exemption.label} — ${violation.match}`);
      continue;
    }
    findings.push({
      check: violation.check,
      severity: 'P1',
      file,
      line,
      detail: `出現平台專屬字面「${violation.match}」（第 ${line} 行）`,
    });
  }

  return { findings, notes };
}

/** 排除規則：路徑前綴、精確檔名、或任一路徑段命中 EXCLUDED_DIR_NAMES。relPath 為 repo-relative posix。 */
export function isExcludedPath(relPath) {
  if (EXCLUDED_EXACT_FILES.has(relPath)) return true;
  if (EXCLUDED_PATH_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return true;
  return relPath.split('/').some((seg) => EXCLUDED_DIR_NAMES.has(seg));
}

/**
 * `--scope` 字串（逗號分隔）→ 合法 scope id 陣列。省略／空字串 → 全部 5 個（全掃）。
 * 顯式提供但整批都不合法 → 回空陣列（刻意不 fallback 回全掃，打錯字時應該「掃不到東西」讓人
 * 發現，而不是靜默掃全部給人假安全感）。
 */
export function normalizeScopes(scopeArg) {
  if (scopeArg == null || scopeArg === '') return [...SCOPE_IDS];
  const requested = String(scopeArg).split(',').map((s) => s.trim()).filter(Boolean);
  return requested.filter((s) => SCOPE_IDS.includes(s));
}

/** 把整體檢查結果轉人讀摘要：全綠單行 ✓；有 finding → 逐條 "✗ [check] severity file — detail"。 */
export function formatSummary(result) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const notes = Array.isArray(result?.notes) ? result.notes : [];
  const filesScanned = result?.summary?.filesScanned ?? 0;

  const lines = [];
  if (findings.length === 0) {
    lines.push(`✓ compat-lint（C3）：${filesScanned} 檔全綠，無 finding。`);
  } else {
    lines.push(...findings.map((f) => `✗ [${f.check}] ${f.severity} ${f.file} — ${f.detail}`));
  }
  if (notes.length > 0) {
    lines.push(`（另有 ${notes.length} 筆豁免命中記錄於 notes，見 --json）`);
  }
  return lines.join('\n');
}

// ── IO 邊界：依 scope 掃檔 + CLI main ────────────────────────────────────────

function toRelPosix(root, absPath) {
  return relative(root, absPath).split('\\').join('/');
}

function listFilesRecursive(root, dir, recursive) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!recursive) continue;
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      out.push(...listFilesRecursive(root, abs, recursive));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(toRelPosix(root, abs));
    }
  }
  return out;
}

/** 依 scope id 掃出 repo-relative posix 檔案清單，已套用排除規則。root 須為已 resolve 的絕對路徑。 */
export function listScopeFiles(root, scopeId) {
  if (scopeId === 'root-docs') {
    return ROOT_DOCS_FILES.filter((f) => existsSync(join(root, f)));
  }
  const def = SCOPE_DIR_DEFS[scopeId];
  if (!def) return [];
  const baseDirAbs = join(root, ...def.baseDir.split('/'));
  return listFilesRecursive(root, baseDirAbs, def.recursive).filter((rel) => !isExcludedPath(rel));
}

/** 掃描 root（依 opts.scope 篩選面），跑 lintFileText，組成完整結果物件（--json 與人讀摘要共用）。 */
export function buildReport(root, opts = {}) {
  const scopeArg = Array.isArray(opts.scope) ? opts.scope.join(',') : opts.scope;
  const scopes = normalizeScopes(scopeArg);

  const relFiles = [...new Set(scopes.flatMap((scopeId) => listScopeFiles(root, scopeId)))];

  const findings = [];
  const notes = [];
  let filesScanned = 0;

  for (const rel of relFiles) {
    let text;
    try {
      text = readFileSync(join(root, ...rel.split('/')), 'utf8');
    } catch {
      continue;
    }
    filesScanned += 1;
    const result = lintFileText(text, rel);
    findings.push(...result.findings);
    notes.push(...result.notes);
  }

  return {
    ok: findings.length === 0,
    findings,
    notes,
    summary: { filesScanned, scopes },
  };
}

function defaultRoot() {
  const scriptDir = fileURLToPath(new URL('.', import.meta.url));
  return join(scriptDir, '..', '..', '..');
}

function parseArgs(argv) {
  const opts = { root: defaultRoot(), json: false, scope: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--root') opts.root = argv[++i] ?? opts.root;
    else if (flag === '--scope') opts.scope = argv[++i] ?? null;
    else if (flag === '--json') opts.json = true;
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const result = buildReport(opts.root, { scope: opts.scope });
  console.log(opts.json ? JSON.stringify(result, null, 2) : formatSummary(result));
  process.exit(result.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2));
}
