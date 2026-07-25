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
    lines.push(`✓ compat-lint（C2+C3+C4）：${filesScanned} 檔全綠，無 finding。`);
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

  // C2／C4 對帳與 scope 篩選無關（不是 markdown 面掃描），一律跑、findings 併入同一份報告。
  findings.push(...buildC2Report(root).findings);
  findings.push(...buildC4Report(root).findings);

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
