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
// T18 補上 C2（capability-registry ↔ evals/baseline/codex/gaps.json 對帳）。
// T19 補上 C4（agent tier/effort/model 對帳，見下方 C4 區塊註解）。
// C2 驗的三條不變式：
//   I7　gaps.json 每筆 capability_id 二擇一——要嘛被某 facet 的 gaps_refs 引用、要嘛在 registry
//       的 deferred[]，不可兩者皆無（孤兒）、不可兩者皆有（歸屬不明）；gaps_refs 引用 gaps.json
//       沒有的 id 是懸空引用。
//   I10　facet 的 codex status／measurability 須與其 gaps_refs 對應筆一致；多筆 ref 狀態互異時
//       取最保守者（保守序 not_supported > degraded > not_measured > supported）；偏離須有
//       override_rationale。gaps_refs 為空的 facet 須有 rationale_if_no_gaps_ref。
// I5（descriptor fallback 完整性）／I6（not_measured 須有 repro）已由 check-registry-shape.mjs
// 的 checkDescriptorFallback／checkDescriptorRepro 驗過，C2 這裡不重複實作，避免同一件事兩個入口。
//
// C4（agent tier/effort/model 對帳，本次 T19 新增）：
//   對帳 capability-registry.json 的 agent_tiers／agent_effort／model_tier 三張表，與
//   plugins/loops-workflow/agents/*.md（25 支）frontmatter 的 model:／effort: 是否一致。
// 與既有檢查的分工（先讀過 check-registry-shape.mjs 與 skill-lint.mjs 才動手，避免兩個入口）：
//   - check-registry-shape.mjs 的 I8（checkAgentTiers）已經驗 agent_tiers／agent_effort **鍵集合**
//     是否恰好等於 agents/ 目錄現況、agent_tiers 的**值**是否落在 model_tier 鍵集合內、以及
//     agent_effort 的**值**是否與 frontmatter effort 一致——這條線其實已經有值級對帳，不是只驗鍵
//     集合（實測：把 eval-judge.md 的 effort 從 low 改成 medium，check-registry-shape.mjs 會紅）。
//   - 但完全沒有人驗 **model** 這條線：model_tier 展開後的 claude.model 是否等於 agents/*.md
//     frontmatter 的 model: 值——這是真正的洞，C4 補的就是這塊。
//   - effort 值對帳雖與 I8 有實質重疊，這裡仍在 C4 裡對稱寫一份（而不是 parse I8 的 detail 字串
//     或硬 import 內部細節去拼裝），理由：①I8 的 findings 是 registry-internal 形狀（不含
//     per-agent file 欄位），硬要在這裡改寫成 compat-lint 的 finding 形狀，需要從人讀 detail
//     字串反解 agent 名稱，比重寫一次同等於三行的等式判斷更脆弱；②C4 的定位是「registry ↔
//     agents frontmatter」這條跨檔關係的單一彙整報告（model + effort 對稱兩維），拆成一半 reuse
//     一半新寫，維護時更難看出全貌。effort 這一小段等式判斷刻意保持極簡（見 minimalism-ladder：
//     一行等式，不開新抽象），不是重造一個功能。
//   - skill-lint.mjs 的 agents 相關檢查完全不讀 model/effort/tier，管的是 description/body 文字
//     健康度（duplicateCheck、deepSyncCheck、footprint 字數），與 C4 零重疊。
//
// 誠實覆蓋面聲明（AGENTS.md 規則 5，別讓覆蓋面看起來比實際強）：25 支 agents 裡 **21 支是
// gen-reviewers.mjs 從 registry 生成的**（見 EXCLUDED_PATH_PREFIXES 對 agents/** 在 C3 的排除
// 理由同源）——對這 21 支跑 C4 對帳是**恆真**：生成物的 model/effort 本來就是抄 registry 填進去
// 的，C4 抓不到「生成器本身寫錯」這種洞，只能抓「生成後被手動改動、與 registry 脫鉤」。
// 真正有鑑別力的只有 **4 支手寫 agent**：referee、test-author、impl-author、eval-judge——
// 只有這 4 支的 model/effort 是人工填寫，才可能獨立於 registry 漂移，C4 的紅燈價值集中在這裡。
//
// T30 補上 C5（runtime scoped override 雙向對帳，見下方 C5 區塊註解）：對帳 canonical 散文裡
// `<!-- runtime: claude|codex id=<slug> -->` scoped span 與 capability-registry.json
// `overrides[]` 是否互相對得上（無孤兒 span、無懸空 override）；overrides 欄位本身的完整性
// （owner/rationale/test_ref/scope 非空且存在）已由 check-registry-shape.mjs 的 I15 驗過，
// C5 不重複實作。
//
// T25 補上 C6（hooks-codex.json 投影漂移檢查，見下方 C6 區塊註解）：對帳 hooks/hooks.json（Claude
// 側正本）＋ registry facets.hook_events.platforms.codex.projection_mapping（單一真相源）算出的
// 期望投影，與磁碟上 hooks/hooks-codex.json 是否結構相等；不相等（含手改任一欄位）→ 紅並指出漂移。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseRegistryJson } from './check-registry-shape.mjs';

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

// C2 對帳的兩份資料源（repo-relative posix，與 check-registry-shape.mjs 的 REGISTRY_REL 同源）。
const CAPABILITY_REGISTRY_REL = 'plugins/loops-workflow/references/capability-registry.json';
const GAPS_JSON_REL = 'plugins/loops-workflow/evals/baseline/codex/gaps.json';

// C6 對帳的兩份資料源：hooks/hooks.json（Claude 側正本）與 hooks/hooks-codex.json（generated 投影）。
const HOOKS_JSON_REL = 'plugins/loops-workflow/hooks/hooks.json';
const HOOKS_CODEX_JSON_REL = 'plugins/loops-workflow/hooks/hooks-codex.json';

// C4 對帳的資料源：agents/*.md（與 check-registry-shape.mjs 的 AGENTS_DIR_REL 同源）。
const AGENTS_DIR_REL = 'plugins/loops-workflow/agents';
const MODEL_FRONTMATTER_RE = /^model:\s*(\S+)\s*$/m;
const EFFORT_FRONTMATTER_RE = /^effort:\s*(\S+)\s*$/m;

// I10 保守序：數字越大越保守，取 gaps_refs 對應筆狀態互異時的最保守者。
const STATUS_CONSERVATISM_RANK = { not_supported: 3, degraded: 2, not_measured: 1, supported: 0 };

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

/**
 * 豁免③的區段：`<!-- runtime: claude|codex [id=<slug>] -->` … `<!-- /runtime -->`（記下是哪個
 * runtime，以及選填的 `id`）。`id` 屬性是 C5（見下方 C5 區塊）用來對應 registry `overrides[]`
 * 的 key——C3 豁免判定本身不看 id，這裡只是同一個 marker 順手多抽一個欄位，不必另開一條正則
 * （reuse-check：兩個檢查共用同一個掃描結果，比各自掃一次成本低）。
 */
export function findRuntimeScopeRanges(text) {
  const re = /<!--\s*runtime:\s*(claude|codex)(?:\s+id=([\w.-]+))?\s*-->([\s\S]*?)<!--\s*\/runtime\s*-->/g;
  const ranges = [];
  let m = re.exec(text);
  while (m !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length, runtime: m[1], id: m[2] ?? null });
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
    lines.push(`✓ compat-lint（C2+C3+C4+C5+C6）：${filesScanned} 檔全綠，無 finding。`);
  } else {
    lines.push(...findings.map((f) => `✗ [${f.check}] ${f.severity} ${f.file} — ${f.detail}`));
  }
  if (notes.length > 0) {
    lines.push(`（另有 ${notes.length} 筆豁免命中記錄於 notes，見 --json）`);
  }
  return lines.join('\n');
}

// ── C2：capability-registry ↔ gaps.json 對帳（純函式，無 IO，測試直接 import）──────────

/**
 * I7：gaps.json 每筆 capability_id 與 registry 的二擇一歸屬——
 * ①懸空：facet.gaps_refs 引用了 gaps.json 沒有的 id。
 * ②孤兒：gaps.json 的 id 既未被任何 facet.gaps_refs 引用、也不在 registry.deferred[]。
 * ③歸屬不明：gaps.json 的 id 同時被某 facet 引用、又出現在 registry.deferred[]。
 */
export function checkGapsFacetReconciliation(registry, gapsArray) {
  const gaps = Array.isArray(gapsArray) ? gapsArray : [];
  const gapsIds = new Set(gaps.map((g) => g?.capability_id));
  const deferredIds = new Set(
    (Array.isArray(registry?.deferred) ? registry.deferred : []).map((d) => d?.capability_id),
  );
  const facets = registry?.facets ?? {};

  const findings = [];
  // owners：capability_id → 引用它的 facet id 清單（只收「gaps.json 真的有這筆」的引用，
  // 懸空的另外在下面就地回報，不進這個 map，避免孤兒/歸屬不明誤判懸空 id）。
  const owners = new Map();
  for (const [facetId, facet] of Object.entries(facets)) {
    for (const capId of Array.isArray(facet?.gaps_refs) ? facet.gaps_refs : []) {
      if (!gapsIds.has(capId)) {
        findings.push({
          check: 'C2',
          severity: 'P1',
          file: GAPS_JSON_REL,
          detail: `facet "${facetId}" 的 gaps_refs 引用了 gaps.json 沒有的 capability_id "${capId}"（懸空引用，I7）`,
        });
        continue;
      }
      if (!owners.has(capId)) owners.set(capId, []);
      owners.get(capId).push(facetId);
    }
  }

  for (const gap of gaps) {
    const capId = gap?.capability_id;
    const owningFacets = owners.get(capId) ?? [];
    const inDeferred = deferredIds.has(capId);
    if (owningFacets.length === 0 && !inDeferred) {
      findings.push({
        check: 'C2',
        severity: 'P1',
        file: GAPS_JSON_REL,
        detail: `capability_id "${capId}" 既未被任何 facet 的 gaps_refs 引用、也不在 registry 的 deferred[] 清單裡（孤兒，I7）`,
      });
    } else if (owningFacets.length > 0 && inDeferred) {
      findings.push({
        check: 'C2',
        severity: 'P1',
        file: GAPS_JSON_REL,
        detail: `capability_id "${capId}" 同時被 facet [${owningFacets.join(', ')}] 的 gaps_refs 引用、又出現在 registry 的 deferred[] 清單裡（歸屬不明，I7）`,
      });
    }
  }

  return findings;
}

/**
 * I10：facet 的 codex status／measurability 須與其 gaps_refs 對應筆一致。
 * status：多筆 ref 狀態互異時取最保守者（保守序見 STATUS_CONSERVATISM_RANK）；偏離須有
 * override_rationale 才放行。measurability：僅在引用集合的 measurability 彼此一致、有唯一
 * 期望值時才對帳（互異時無明訂規則，不強行判定，避免 false positive）。
 * 懸空 ref（gaps.json 沒有的 id）已由 I7 回報，這裡直接濾掉不重複計入。
 */
export function checkFacetStatusConsistency(registry, gapsArray) {
  const gapsById = new Map(
    (Array.isArray(gapsArray) ? gapsArray : []).map((g) => [g?.capability_id, g]),
  );
  const facets = registry?.facets ?? {};
  const findings = [];

  for (const [facetId, facet] of Object.entries(facets)) {
    const refs = Array.isArray(facet?.gaps_refs) ? facet.gaps_refs : [];
    const gapEntries = refs.map((id) => gapsById.get(id)).filter(Boolean);
    if (gapEntries.length === 0) continue; // 無 ref 或 ref 全懸空 → 無可對帳對象

    const codexDescriptor = facet?.platforms?.codex ?? {};
    const hasOverride = Boolean(facet?.override_rationale);

    const expectedStatus = gapEntries.reduce((worst, g) => {
      const rank = STATUS_CONSERVATISM_RANK[g.status] ?? -1;
      const worstRank = STATUS_CONSERVATISM_RANK[worst] ?? -1;
      return rank > worstRank ? g.status : worst;
    }, gapEntries[0].status);
    if (codexDescriptor.status !== expectedStatus && !hasOverride) {
      findings.push({
        check: 'C2',
        severity: 'P1',
        file: CAPABILITY_REGISTRY_REL,
        detail: `facet "${facetId}" 的 codex status="${codexDescriptor.status}" 與 gaps_refs 保守序推導值 "${expectedStatus}" 不一致，且無 override_rationale 說明偏離原因（I10）`,
      });
    }

    const measurabilities = new Set(gapEntries.map((g) => g.measurability));
    if (measurabilities.size === 1) {
      const [expectedMeasurability] = measurabilities;
      if (codexDescriptor.measurability !== expectedMeasurability && !hasOverride) {
        findings.push({
          check: 'C2',
          severity: 'P1',
          file: CAPABILITY_REGISTRY_REL,
          detail: `facet "${facetId}" 的 codex measurability="${codexDescriptor.measurability}" 與 gaps_refs 一致值 "${expectedMeasurability}" 不符，且無 override_rationale 說明偏離原因（I10）`,
        });
      }
    }
  }

  return findings;
}

/** gaps_refs 為空的 facet（目前是 hook_concurrency）須有 rationale_if_no_gaps_ref，沒有就紅。 */
export function checkRationaleForEmptyGapsRefs(registry) {
  const facets = registry?.facets ?? {};
  const findings = [];
  for (const [facetId, facet] of Object.entries(facets)) {
    const refs = Array.isArray(facet?.gaps_refs) ? facet.gaps_refs : [];
    if (refs.length === 0 && !facet?.rationale_if_no_gaps_ref) {
      findings.push({
        check: 'C2',
        severity: 'P1',
        file: CAPABILITY_REGISTRY_REL,
        detail: `facet "${facetId}" 的 gaps_refs 為空，須填 rationale_if_no_gaps_ref 說明理由（實際為空）`,
      });
    }
  }
  return findings;
}

/** C2 彙整器：I7 + I10 + rationale_if_no_gaps_ref 三批 findings 合併。 */
export function checkCapabilityRegistryReconciliation(registry, gapsArray) {
  return [
    ...checkGapsFacetReconciliation(registry, gapsArray),
    ...checkFacetStatusConsistency(registry, gapsArray),
    ...checkRationaleForEmptyGapsRefs(registry),
  ];
}

/** gaps.json 原始字串 → { gapsArray } 或 { error }（陣列形狀；與 parseRegistryJson 的物件形狀互補）。 */
export function parseGapsArrayJson(content) {
  let parsed;
  try {
    parsed = JSON.parse(String(content ?? ''));
  } catch (e) {
    return { error: `gaps.json 解析失敗：${e.message}` };
  }
  if (!Array.isArray(parsed)) {
    return { error: 'gaps.json 內容不是合法的 JSON 陣列' };
  }
  return { gapsArray: parsed };
}

// ── C4：agent tier/effort/model 對帳（純函式，無 IO，測試直接 import）──────────────

/**
 * C4：對每一支有 agent_tiers 對應 tier 的 agent，比對兩維：
 * ①effort：registry.agent_effort[name] 與 frontmatter effort 是否一致（與 check-registry-shape.mjs
 *   的 I8 有實質重疊，見檔頭 C4 分工說明，這裡刻意保持極簡的一行等式，不是重造功能）；
 * ②model：registry.agent_tiers[name] 展開 model_tier[tier].claude.model 是否等於 frontmatter
 *   model:（目前唯一沒人驗的洞，見檔頭）。
 * agentNames / effortByAgent / modelByAgent 由呼叫端注入（IO 已在邊界讀完，這裡純比對）。
 * 任一邊缺值（tier 未知、model_tier 未填 claude.model、frontmatter 缺欄位）→ 略過該筆，不誤報
 * ——鍵集合本身的缺失已由 check-registry-shape.mjs 的 I8 回報，C4 不重複那個噪音。
 */
export function checkAgentTierEffortModelReconciliation(registry, { agentNames, effortByAgent, modelByAgent } = {}) {
  const names = Array.isArray(agentNames) ? agentNames : [];
  const agentTiers = registry?.agent_tiers ?? {};
  const agentEffort = registry?.agent_effort ?? {};
  const modelTier = registry?.model_tier ?? {};
  const findings = [];

  for (const name of names) {
    const tier = agentTiers[name];
    if (tier == null) continue; // 鍵集合缺失已由 check-registry-shape.mjs 的 I8 回報

    const registryEffort = agentEffort[name];
    const actualEffort = effortByAgent?.[name];
    if (registryEffort != null && actualEffort != null && registryEffort !== actualEffort) {
      findings.push({
        check: 'C4',
        severity: 'P1',
        file: `${AGENTS_DIR_REL}/${name}.md`,
        detail: `agent "${name}" 的 registry agent_effort="${registryEffort}"，與 agents/${name}.md frontmatter 的 effort="${actualEffort}" 不符`,
      });
    }

    const expectedModel = modelTier[tier]?.claude?.model;
    const actualModel = modelByAgent?.[name];
    if (expectedModel != null && actualModel != null && actualModel !== expectedModel) {
      findings.push({
        check: 'C4',
        severity: 'P1',
        file: `${AGENTS_DIR_REL}/${name}.md`,
        detail: `agent "${name}" 的 agent_tiers="${tier}" 展開 model_tier.claude.model="${expectedModel}"，與 agents/${name}.md frontmatter 的 model="${actualModel}" 不符`,
      });
    }
  }

  return findings;
}

/**
 * C4 的 IO 邊界：讀 capability-registry.json + agents/*.md frontmatter，跑
 * checkAgentTierEffortModelReconciliation。任一資料源不存在（假 repo fixture 常常兩者都沒準備）
 * → 靜默回傳空 findings，理由同 buildC2Report：C4 對該 root 不適用不該讓整體報告失敗。
 */
export function buildC4Report(root) {
  const registryAbs = join(root, ...CAPABILITY_REGISTRY_REL.split('/'));
  const agentsDirAbs = join(root, ...AGENTS_DIR_REL.split('/'));
  if (!existsSync(registryAbs) || !existsSync(agentsDirAbs)) return { findings: [] };

  let registryRaw;
  let agentFileNames;
  try {
    registryRaw = readFileSync(registryAbs, 'utf8');
    agentFileNames = readdirSync(agentsDirAbs).filter((f) => f.endsWith('.md'));
  } catch (e) {
    return { findings: [{ check: 'C4', severity: 'P1', file: CAPABILITY_REGISTRY_REL, detail: `讀取失敗：${e.message}` }] };
  }

  const parsedRegistry = parseRegistryJson(registryRaw);
  if (parsedRegistry.error) {
    return { findings: [{ check: 'C4', severity: 'P1', file: CAPABILITY_REGISTRY_REL, detail: parsedRegistry.error }] };
  }

  const agentNames = agentFileNames.map((f) => f.replace(/\.md$/, ''));
  const effortByAgent = {};
  const modelByAgent = {};
  for (const name of agentNames) {
    let content;
    try {
      content = readFileSync(join(agentsDirAbs, `${name}.md`), 'utf8');
    } catch {
      continue;
    }
    effortByAgent[name] = content.match(EFFORT_FRONTMATTER_RE)?.[1] ?? null;
    modelByAgent[name] = content.match(MODEL_FRONTMATTER_RE)?.[1] ?? null;
  }

  return {
    findings: checkAgentTierEffortModelReconciliation(parsedRegistry.registry, { agentNames, effortByAgent, modelByAgent }),
  };
}

// ── C5：runtime scoped override 雙向對帳（本次 T30 新增，純函式，無 IO，測試直接 import）──

// C5 契約（本次 T30 新增，落點對齊既有 C2/C4 分工註解的形狀）：
//   issue 明文要求「平台專屬規則若真的存在，用有明確 scope 的 override（`runtime: claude` /
//   `runtime: codex`），而不是複製整份規則或 skill」，且驗收條件要求「平台專屬行為以 scoped
//   override 表達，且有 owner、理由與測試」。C5 驗的就是這個機制本身有沒有被誠實使用：
//   ①canonical 散文裡每一段帶 id 的 `<!-- runtime: … id=<slug> -->` scoped span，registry
//     的 `overrides[]` 都要有對應 id 的一筆（找不到 → 孤兒 span）；沒帶 id 的 scoped span
//     本身就無法對應任何 override，視同孤兒（見下方 checkRuntimeOverrideCorrespondence）。
//   ②registry 每一筆 `overrides[]`（有 id 的）都要在散文裡找得到至少一處同 id 的使用
//     （找不到 → 懸空 override，只在資料層宣告、canonical 散文從未真的引用它）。
//   ③owner／rationale／test_ref／scope 是否非空、test_ref／scope 指向的檔案是否存在——這條線
//     已由 check-registry-shape.mjs 的 I15（checkOverrides）驗過（overrides-non-empty /
//     overrides-fields / overrides-test-ref-exists / overrides-scope-exists 四個 check id），
//     C5 不重複實作，避免同一件事兩個入口——C5 專注在①②這條「散文 ↔ registry」的跨檔關係，
//     I15 專注在 registry 自身的欄位完整性，兩者互補、由各自 CLI（compat-lint.mjs／
//     check-registry-shape.mjs）分別負責，同一份 registry 兩者都要跑過。
//   掃描面：與 C3 相同的五個 scope（skills/references/plugin-docs/repo-root/root-docs），
//   理由是 runtime scoped override 本來就是 canonical 散文的豁免機制，只該出現在 C3 掃的
//   那五個文字面；不掃 agents/**（生成物，同 C3 排除邏輯）。

/**
 * C5 對帳核心：spans（跨檔掃到的 runtime scoped span 清單，見 buildC5Report）×
 * overrides（registry.overrides[]）→ findings。
 * spans 缺 id、或 id 在 overrides 找不到對應筆 → 孤兒（span 側報）；
 * overrides 有 id 但沒有任何 span 用過 → 懸空（registry 側報）。
 */
export function checkRuntimeOverrideCorrespondence(spans, overrides) {
  const overrideIds = new Set(
    (Array.isArray(overrides) ? overrides : []).map((ov) => ov?.id).filter(Boolean),
  );
  const usedIds = new Set();
  const findings = [];

  for (const span of Array.isArray(spans) ? spans : []) {
    if (!span.id) {
      findings.push({
        check: 'C5',
        severity: 'P1',
        file: span.file,
        line: span.line,
        detail: `runtime scoped span 缺少 id 屬性（寫法應為 <!-- runtime: ${span.runtime} id=<slug> -->），無法對應 registry overrides[]（孤兒）`,
      });
      continue;
    }
    if (!overrideIds.has(span.id)) {
      findings.push({
        check: 'C5',
        severity: 'P1',
        file: span.file,
        line: span.line,
        detail: `runtime scoped span 的 id="${span.id}" 在 registry overrides[] 找不到對應筆（孤兒）`,
      });
      continue;
    }
    usedIds.add(span.id);
  }

  for (const ov of Array.isArray(overrides) ? overrides : []) {
    if (!ov?.id) continue; // 無 id 的 override 屬欄位缺失，由 check-registry-shape.mjs 的 I15 負責攔
    if (!usedIds.has(ov.id)) {
      findings.push({
        check: 'C5',
        severity: 'P1',
        file: CAPABILITY_REGISTRY_REL,
        detail: `override "${ov.id}" 在 canonical 散文找不到任何 <!-- runtime: ... id=${ov.id} --> 使用處（懸空）`,
      });
    }
  }

  return findings;
}

/**
 * C5 的 IO 邊界：掃 C3 同五個 scope 的散文找 runtime scoped span（含 id），讀 registry 的
 * overrides[]，跑 checkRuntimeOverrideCorrespondence。registry 不存在 → 靜默回傳空 findings
 * （理由同 buildC2Report／buildC4Report：對該 root 不適用不該讓整體報告失敗）。
 */
export function buildC5Report(root) {
  const registryAbs = join(root, ...CAPABILITY_REGISTRY_REL.split('/'));
  if (!existsSync(registryAbs)) return { findings: [] };

  let registryRaw;
  try {
    registryRaw = readFileSync(registryAbs, 'utf8');
  } catch (e) {
    return { findings: [{ check: 'C5', severity: 'P1', file: CAPABILITY_REGISTRY_REL, detail: `讀取失敗：${e.message}` }] };
  }

  const parsedRegistry = parseRegistryJson(registryRaw);
  if (parsedRegistry.error) {
    return { findings: [{ check: 'C5', severity: 'P1', file: CAPABILITY_REGISTRY_REL, detail: parsedRegistry.error }] };
  }

  const relFiles = [...new Set(SCOPE_IDS.flatMap((scopeId) => listScopeFiles(root, scopeId)))];
  const spans = [];
  for (const rel of relFiles) {
    let text;
    try {
      text = readFileSync(join(root, ...rel.split('/')), 'utf8');
    } catch {
      continue;
    }
    const lineOffsets = buildLineIndex(text);
    for (const range of findRuntimeScopeRanges(text)) {
      spans.push({ file: rel, line: lineOf(lineOffsets, range.start), runtime: range.runtime, id: range.id });
    }
  }

  return { findings: checkRuntimeOverrideCorrespondence(spans, parsedRegistry.registry?.overrides) };
}

// ── C6：hooks-codex.json 投影漂移檢查（本次 T25 新增，純函式，無 IO，測試直接 import）────────

// C6 契約（本次 T25 新增，落點對齊既有 C2/C4/C5 分工註解的形狀）：
//   #183 §5 x183_action 要求「hook normalization layer：產 hooks-codex.json 投影（事件/matcher/
//   payload/env），統一交既有 guard/recorder」。C6 驗的是這份投影檔沒有跟正本脫鉤：
//   ①事件集合：hooks-codex.json 的頂層事件 key 須與 hooks.json 逐一對應（見 projectHooksToCodex，
//     目前規則是 1:1 直接沿用，官方文件未載事件改名）。
//   ②matcher：依 registry projection_mapping.matcher_tool_alias 表（單一真相源，見
//     capability-registry.json 的 hook_events facet）把工具名 pipe-list 投影成 Codex 側等價
//     matcher；非工具名 pipe-list（含正則特殊字元的 matcher，例如 pr-owner-guard 的
//     update_pull_request pattern）不轉換、原樣保留。
//   ③command／hooks 陣列（payload 層）：與正本逐字相同——command 字面（含 ${CLAUDE_PLUGIN_ROOT}）
//     不改寫，官方文件載 Codex 相容此環境變數（env 層）。
//   ④_meta 誠實標記：generated===true、warning、verification_status 三個非空欄位缺一不可，
//     防止「拿掉誠實標記」這種手改被誤判為綠燈。
//   判定方式是「重新算一次期望投影、與磁碟版本結構相等比對」（見 checkHooksCodexProjectionDrift），
//   不是各自維護一份規則字串比對——這樣手改 hooks-codex.json 任一欄位都會被抓到，不會退化成
//   「檔案存在即綠」。

/**
 * 依 registry 宣告的 matcher_tool_alias 表，把單一 matcher 字串投影成 Codex 側等價值。
 * 只對「純工具名 pipe-list」（例如 "Write|Edit|MultiEdit"，全由 \w 與 | 組成）做別名替換並去重；
 * 含正則特殊字元（例如 ".*(update_pull_request|request_copilot_review).*"）視為非工具名 matcher，
 * 原樣保留——這條規則本身就是 C6 的對帳依據，不是憑空判斷。
 */
export function aliasMatcherTokens(matcher, aliasMap) {
  if (typeof matcher !== 'string' || matcher.length === 0) return matcher;
  if (!/^\w+(\|\w+)*$/.test(matcher)) return matcher; // 非純工具名 pipe-list，原樣保留
  const map = aliasMap ?? {};
  const tokens = matcher.split('|').map((t) => map[t] ?? t);
  return [...new Set(tokens)].join('|'); // 去重：多個 token 別名成同一目標時（如 Edit/Write→apply_patch）避免重複
}

/** 兩個任意 JSON 值的結構性深比對（鍵順序不敏感），供 C6 判定投影是否漂移。 */
export function deepEqualJson(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqualJson(v, b[i]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqualJson(a[k], b[k]));
}

/**
 * C6 投影核心：hooks.json 的 `hooks` 物件 → Codex 側等價 `hooks` 物件。純函式，mappingRules 取自
 * registry facets.hook_events.platforms.codex.projection_mapping（單一真相源，不在此函式內寫死
 * 別名表——見檔頭 C6 契約①②）。
 */
export function projectHooksToCodex(hooksJson, mappingRules) {
  const aliasMap = mappingRules?.matcher_tool_alias ?? {};
  const sourceHooks = hooksJson?.hooks ?? {};
  const projected = {};
  for (const [eventName, blocks] of Object.entries(sourceHooks)) {
    projected[eventName] = (Array.isArray(blocks) ? blocks : []).map((block) => {
      const out = { ...block };
      if (typeof out.matcher === 'string') out.matcher = aliasMatcherTokens(out.matcher, aliasMap);
      return out;
    });
  }
  return projected;
}

/**
 * C6 對帳：actual（hooks-codex.json 解析後全文，含 _meta）與 expectedHooks（projectHooksToCodex
 * 算出的 hooks 物件）→ findings。兩線：①actual.hooks 與 expectedHooks 結構相等（drift 核心判定，
 * 見檔頭契約①②③）；②_meta 三個必要誠實標記欄位非空（見檔頭契約④）。
 */
export function checkHooksCodexProjectionDrift(actual, expectedHooks) {
  const findings = [];
  if (!deepEqualJson(actual?.hooks, expectedHooks)) {
    findings.push({
      check: 'C6',
      severity: 'P1',
      file: HOOKS_CODEX_JSON_REL,
      detail: 'hooks-codex.json 的 hooks 事件／matcher／command 結構與 hooks.json + registry projection_mapping 推導出的投影不一致（drift）；請勿手改此檔，改正本或 registry 再重生。',
    });
  }
  const meta = actual?._meta ?? {};
  if (meta.generated !== true || !meta.warning || !meta.verification_status) {
    findings.push({
      check: 'C6',
      severity: 'P1',
      file: HOOKS_CODEX_JSON_REL,
      detail: 'hooks-codex.json 缺少或損壞 _meta 誠實標記（須含 generated===true、warning、verification_status 三個非空欄位）',
    });
  }
  return findings;
}

/**
 * C6 的 IO 邊界：讀 hooks.json + hooks-codex.json + capability-registry.json，跑
 * checkHooksCodexProjectionDrift。任一資料源不存在 → 靜默回傳空 findings，理由同 buildC2Report。
 */
export function buildC6Report(root) {
  const hooksAbs = join(root, ...HOOKS_JSON_REL.split('/'));
  const hooksCodexAbs = join(root, ...HOOKS_CODEX_JSON_REL.split('/'));
  const registryAbs = join(root, ...CAPABILITY_REGISTRY_REL.split('/'));
  if (!existsSync(hooksAbs) || !existsSync(hooksCodexAbs) || !existsSync(registryAbs)) return { findings: [] };

  let hooksRaw;
  let hooksCodexRaw;
  let registryRaw;
  try {
    hooksRaw = readFileSync(hooksAbs, 'utf8');
    hooksCodexRaw = readFileSync(hooksCodexAbs, 'utf8');
    registryRaw = readFileSync(registryAbs, 'utf8');
  } catch (e) {
    return { findings: [{ check: 'C6', severity: 'P1', file: HOOKS_CODEX_JSON_REL, detail: `讀取失敗：${e.message}` }] };
  }

  let hooksJson;
  let hooksCodexJson;
  try {
    hooksJson = JSON.parse(hooksRaw);
  } catch (e) {
    return { findings: [{ check: 'C6', severity: 'P1', file: HOOKS_JSON_REL, detail: `hooks.json 解析失敗：${e.message}` }] };
  }
  try {
    hooksCodexJson = JSON.parse(hooksCodexRaw);
  } catch (e) {
    return { findings: [{ check: 'C6', severity: 'P1', file: HOOKS_CODEX_JSON_REL, detail: `hooks-codex.json 解析失敗：${e.message}` }] };
  }

  const parsedRegistry = parseRegistryJson(registryRaw);
  if (parsedRegistry.error) {
    return { findings: [{ check: 'C6', severity: 'P1', file: CAPABILITY_REGISTRY_REL, detail: parsedRegistry.error }] };
  }

  const mappingRules = parsedRegistry.registry?.facets?.hook_events?.platforms?.codex?.projection_mapping ?? null;
  const expectedHooks = projectHooksToCodex(hooksJson, mappingRules);
  return { findings: checkHooksCodexProjectionDrift(hooksCodexJson, expectedHooks) };
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

/**
 * C2 的 IO 邊界：讀 capability-registry.json + gaps.json，跑 checkCapabilityRegistryReconciliation。
 * 兩份資料源只要有一份不存在（例如測試用的假 repo 只準備了 markdown scope fixture）→ C2 對帳在該
 * root 上不適用，靜默回傳空 findings，不是「找不到就報錯」——C3 的 scope 掃描本來就與這兩份檔案
 * 無關，不該因為它們不存在而讓整體 buildReport 失敗。
 */
export function buildC2Report(root) {
  const registryAbs = join(root, ...CAPABILITY_REGISTRY_REL.split('/'));
  const gapsAbs = join(root, ...GAPS_JSON_REL.split('/'));
  if (!existsSync(registryAbs) || !existsSync(gapsAbs)) return { findings: [] };

  let registryRaw;
  let gapsRaw;
  try {
    registryRaw = readFileSync(registryAbs, 'utf8');
    gapsRaw = readFileSync(gapsAbs, 'utf8');
  } catch (e) {
    return { findings: [{ check: 'C2', severity: 'P1', file: CAPABILITY_REGISTRY_REL, detail: `讀取失敗：${e.message}` }] };
  }

  const parsedRegistry = parseRegistryJson(registryRaw);
  if (parsedRegistry.error) {
    return { findings: [{ check: 'C2', severity: 'P1', file: CAPABILITY_REGISTRY_REL, detail: parsedRegistry.error }] };
  }
  const parsedGaps = parseGapsArrayJson(gapsRaw);
  if (parsedGaps.error) {
    return { findings: [{ check: 'C2', severity: 'P1', file: GAPS_JSON_REL, detail: parsedGaps.error }] };
  }

  return { findings: checkCapabilityRegistryReconciliation(parsedRegistry.registry, parsedGaps.gapsArray) };
}

/** 掃描 root（依 opts.scope 篩選面），跑 lintFileText（C3）+ buildC2Report（C2），組成完整結果物件。 */
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

  // C2／C4／C5 對帳與 scope 篩選無關（不是本次呼叫指定的單一 scope 掃描），一律跑全域資料源、
  // findings 併入同一份報告（C5 內部另外自行掃五個 scope，見 buildC5Report 註解）。
  findings.push(...buildC2Report(root).findings);
  findings.push(...buildC4Report(root).findings);
  findings.push(...buildC5Report(root).findings);
  findings.push(...buildC6Report(root).findings);

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
