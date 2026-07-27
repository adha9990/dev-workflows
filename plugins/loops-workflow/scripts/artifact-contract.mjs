#!/usr/bin/env node
// artifact-contract.mjs —— Artifact Contract Registry 的載入、比對與驗證核心（#217 增量 1）。
//
// 要解的問題：同一種人類可見的 Markdown，在不同 loop 長出不同標題、不同欄位、不同顆粒度，
// 而且沒有任何機械訊號會發現。文字規範寫了「請照模板」擋不住——runtime 可能根本沒載入那份規範。
// 所以這裡把「一份文件宣稱自己是什麼」變成**可機械判定**的事：
//   ① 每份受管文件第一行帶 `<!-- loops-artifact: <id>@<v> -->`；
//   ② 這個 id 必須在 references/artifact-registry.json 裡登記過；
//   ③ 登記時就要一併給 template、validator 與 gate——缺任何一項，registry 自己就不合格。
//
// 分層（沿用 docs-lint.mjs / registry-compiler.mjs 的既有形狀）：
//   1) 純函式（無 IO，測試直接 import）：parseMarker / extractMarker / matchPathPattern /
//      extractSections / checkArtifactRegistry / validateArtifactDocument / formatSummary。
//   2) IO 薄邊界：loadArtifactRegistry / loadWorkflowVocabulary / buildRegistryReport / main，
//      main 被 import 時不執行（import.meta.url 守門）。
//
// 重用（AGENTS 規則 6）：
//   · code fence 的剝除走 `hooks/pr-gate.mjs` 已 export 的 `stripCodeForMarker`——它對**未閉合
//     fence** 穩健（逐行 toggle、開了沒關就吃到 EOF）。文件內文貼一段含 `## 標題` 的範例 code
//     時，若用成對比對的 stripCode，那個假標題會被算成真的 section，讓缺 section 的文件蒙混過關。
//   · JSON 解析走 `check-registry-shape.mjs` 已 export 的 `parseRegistryJson`（不寫第五份 parse）。
//
// 依賴：僅 node 內建 ＋ 本 repo 內既有 script。
// 用法：node artifact-contract.mjs [--root <dir>] [--json]
//       node artifact-contract.mjs --check <file> [--json]

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseRegistryJson } from './check-registry-shape.mjs';
import { stripCodeForMarker } from '../hooks/pr-gate.mjs';

const ARTIFACT_REGISTRY_REL = join('references', 'artifact-registry.json');
const VOCABULARY_REL = join('references', 'workflow-vocabulary.json');

/** marker 的唯一形狀。id 一律 kebab-case、version 一律純數字——寬鬆比對會讓兩份不同契約撞成同一個。 */
export const MARKER_RE = /^<!--\s*loops-artifact:\s*([a-z0-9][a-z0-9-]*)@(\d+)\s*-->$/;

export const RENDER_MODES = Object.freeze(['deterministic', 'hybrid', 'authored-docs']);
export const VALIDATORS = Object.freeze(['deterministic-sections', 'required-sections', 'outbound-contract', 'doc-classification']);
export const GATES = Object.freeze(['creation', 'phase', 'outbound', 'finalize', 'docs']);

/** producer 除了 vocabulary 的節點外，只多這一個字面：跨階段都可能重生的產物（loop.md／PROGRESS.md）。 */
export const ANY_PHASE = 'any-phase';

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;

// ── 純函式：marker ───────────────────────────────────────────────────────────

/** 單一行 → `{ artifactId, version }`；不合格一律 null（不猜、不半信）。 */
export function parseMarker(line) {
  if (typeof line !== 'string') return null;
  const m = MARKER_RE.exec(line.trim());
  if (!m) return null;
  return { artifactId: m[1], version: Number(m[2]) };
}

/**
 * 取文件的 artifact marker——**只認第一行**。
 * 刻意不掃全文：文件內文如果引用了另一份產物的 marker（教學、範例、貼上來的別人的報告），
 * 全文掃描會讓這份檔悄悄改變身分。第一行是唯一的宣告位置，其他位置一律不算數。
 * BOM 與 CRLF 容忍——那是編輯器與平台差異，不是作者的宣告意圖。
 */
export function extractMarker(text) {
  if (typeof text !== 'string') return null;
  const first = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  return parseMarker(first);
}

// ── 純函式：path pattern ─────────────────────────────────────────────────────

const norm = (p) => String(p ?? '').split('\\').join('/');

/**
 * path_pattern → RegExp。支援三種佔位：
 *   `<slug>` → 恰好一個路徑段（不得跨 `/`——跨了就會讓 `.loops/a/b/deliverables/cost.md` 誤中）；
 *   `**`     → 任意層（含 0 層以上的目錄）；
 *   `*`      → 單一路徑段內的任意字元。
 * 其餘字元逐字比對（正則元字元先轉義）。
 */
function patternToRegExp(pattern) {
  const s = norm(pattern);
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s.startsWith('<slug>', i)) { out += '[^/]+'; i += 5; continue; }
    if (s.startsWith('**', i)) { out += '.*'; i += 1; continue; }
    const c = s[i];
    if (c === '*') { out += '[^/]*'; continue; }
    out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** 路徑是否命中 pattern。兩邊都先把反斜線正規化成 `/`（Windows 上的路徑同樣要判得出來）。 */
export function matchPathPattern(pattern, path) {
  if (typeof pattern !== 'string' || typeof path !== 'string') return false;
  return patternToRegExp(pattern).test(norm(path));
}

/** 這條路徑是否落在 registry 的 unmanaged 名單（agent-facing 檔與模板來源本身）。 */
export function isUnmanagedPath(registry, path) {
  return (registry?.unmanaged ?? []).some((u) => matchPathPattern(u.path_pattern, path));
}

/** 路徑命中的所有契約（同一條 `docs/**` 會有多個候選，交給 marker 決定是哪一個）。 */
export function resolveArtifactCandidates(registry, path) {
  if (isUnmanagedPath(registry, path)) return [];
  return (registry?.artifacts ?? []).filter((a) => matchPathPattern(a.path_pattern, path));
}

/** 路徑對應的契約（多個候選時回第一個；要全部請用 resolveArtifactCandidates）。不納管 → null。 */
export function resolveArtifactForPath(registry, path) {
  return resolveArtifactCandidates(registry, path)[0] ?? null;
}

// ── 純函式：section ──────────────────────────────────────────────────────────

/**
 * 抽出文件的標題清單（去 code fence 之後才抓）。
 * 回 `[{ level, title }]`，title 已 trim、去掉尾端的 closing `#`。
 */
export function extractSections(text) {
  const out = [];
  for (const line of stripCodeForMarker(String(text ?? '')).split(/\r?\n/)) {
    const m = HEADING_RE.exec(line);
    if (!m) continue;
    out.push({ level: (line.match(/#/g) ?? []).length, title: m[1].trim() });
  }
  return out;
}

/**
 * required section 是否出現。**用前綴比對，不是全等**——真實 renderer 的標題會帶動態尾綴
 * （例如 `## 最近事件（最多 12 筆，非完整 Journal）`）。全等比對的話，renderer 改一個上限數字
 * 就會讓每一份既有文件同時變紅，而那些文件其實完全合格。
 */
function hasSection(sections, required) {
  const want = String(required).trim();
  return sections.some((s) => s.title === want || s.title.startsWith(want));
}

// ── 純函式：registry 形狀檢查 ────────────────────────────────────────────────

function finding(check, id, detail) {
  return { check, severity: 'P1', file: ARTIFACT_REGISTRY_REL, id, detail };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * registry 自身的形狀（不碰檔案系統——template 是否真的存在由 buildRegistryReport 補）。
 * 空 artifacts 陣列必須紅：逐筆檢查對空清單全部恆真，「一條都沒登記」會被印成「無 finding」。
 */
export function checkArtifactRegistry(registry) {
  const findings = [];

  if (!registry?.schema_version) {
    findings.push(finding('registry-envelope', null, '缺少必要欄位 "schema_version"'));
  }
  if (!isPlainObject(registry?.marker) || typeof registry.marker.regex !== 'string') {
    findings.push(finding('registry-envelope', null, '缺少 "marker.regex"——marker 形狀必須有單一真相源'));
  }
  if (!Array.isArray(registry?.artifacts)) {
    findings.push(finding('registry-envelope', null, '"artifacts" 必須是陣列'));
    return findings;
  }
  if (registry.artifacts.length === 0) {
    findings.push(finding('registry-envelope', null, '"artifacts" 不得為空陣列——空清單會讓每一條逐筆檢查恆真，變成沒有內容的假綠'));
  }

  const seen = new Map();
  registry.artifacts.forEach((a, index) => {
    if (!isPlainObject(a)) {
      findings.push(finding('registry-envelope', null, `artifacts[${index}] 必須是物件`));
      return;
    }
    const id = a.artifact_id;
    if (typeof id !== 'string' || !KEBAB_RE.test(id)) {
      findings.push(finding('artifact-id-format', String(id ?? `#${index}`), 'artifact_id 必須是非空 kebab-case'));
    } else if (seen.has(id)) {
      findings.push(finding('artifact-id-unique', id, `artifact_id 重複（已出現在 artifacts[${seen.get(id)}]）`));
    } else {
      seen.set(id, index);
    }

    for (const field of ['path_pattern', 'style_contract', 'producer', 'audience', 'channel']) {
      if (typeof a[field] !== 'string' || a[field] === '') {
        findings.push(finding('required-field', id, `缺少必要欄位 "${field}"`));
      }
    }
    if (!Number.isInteger(a.template_version) || a.template_version < 1) {
      findings.push(finding('required-field', id, '"template_version" 必須是 ≥1 的整數'));
    }
    for (const field of ['required_sections', 'optional_sections', 'data_source']) {
      if (!Array.isArray(a[field])) {
        findings.push(finding('required-field', id, `"${field}" 必須是陣列（沒有就給空陣列，不要省略——省略與「刻意沒有」分不出來）`));
      }
    }
    if (!RENDER_MODES.includes(a.render_mode)) {
      findings.push(finding('render-mode', id, `render_mode 必須是 ${RENDER_MODES.join('｜')}（實際：${a.render_mode}）`));
    }
    if (!VALIDATORS.includes(a.validator)) {
      findings.push(finding('validator', id, `validator 必須是 ${VALIDATORS.join('｜')}（實際：${a.validator}）`));
    }
    if (!GATES.includes(a.gate)) {
      findings.push(finding('gate', id, `gate 必須是 ${GATES.join('｜')}（實際：${a.gate}）`));
    }
    // deterministic 的定義就是「由資料生成、可重現」——沒有 renderer 就沒有東西能重現它，
    // 那它實際上是 hybrid（人手寫），登記成 deterministic 只是把假設寫進契約。
    if (a.render_mode === 'deterministic' && (typeof a.renderer !== 'string' || a.renderer === '')) {
      findings.push(finding('deterministic-renderer', id, 'render_mode=deterministic 必須指定 renderer'));
    }
    if (a.render_mode === 'deterministic' && (!Array.isArray(a.data_source) || a.data_source.length === 0)) {
      findings.push(finding('deterministic-renderer', id, 'render_mode=deterministic 必須至少一個 data_source（沒有資料來源就不可能是生成的）'));
    }
  });

  return findings;
}

/** producer 必須是 vocabulary 認得的 phase／control node／activity（或 any-phase）。 */
export function checkProducerVocabulary(registry, vocabulary) {
  const known = new Set([
    ANY_PHASE,
    ...(vocabulary?.phases ?? []).map((p) => p.id),
    ...(vocabulary?.control_nodes ?? []).map((c) => c.id),
    ...(vocabulary?.activities ?? []).map((a) => a.id),
  ]);
  return (registry?.artifacts ?? [])
    .filter((a) => !known.has(a.producer))
    .map((a) => finding('producer-vocabulary', a.artifact_id, `producer "${a.producer}" 不在 workflow vocabulary 內`));
}

// ── 純函式：文件驗證 ─────────────────────────────────────────────────────────

/**
 * 驗一份文件是否符合它宣稱的契約 → `{ ok, managed, artifactId, findings }`。
 *
 * `managed:false` 代表這條路徑不納管（unmanaged 名單、或沒有任何 path_pattern 命中）——
 * 這種情況一律 `ok:true`：本檔的職責是「受管的要合格」，不是「所有 Markdown 都得被管」。
 */
export function validateArtifactDocument(registry, { path, text }) {
  const candidates = resolveArtifactCandidates(registry, path);
  if (candidates.length === 0) return { ok: true, managed: false, artifactId: null, findings: [] };

  const findings = [];
  const mark = extractMarker(text);
  const at = (check, detail) => findings.push({ check, severity: 'P1', file: path, detail });

  if (!mark) {
    at('missing-marker',
      `受管產物第一行必須是 \`<!-- loops-artifact: <id>@<版本> -->\`；這條路徑對應的契約：${candidates.map((c) => c.artifact_id).join('｜')}`);
    return { ok: false, managed: true, artifactId: null, findings };
  }

  const entry = (registry.artifacts ?? []).find((a) => a.artifact_id === mark.artifactId);
  if (!entry) {
    at('unregistered-artifact',
      `marker 宣稱的 \`${mark.artifactId}\` 沒有登記在 artifact registry——新增人類 Markdown 產物必須同時補 catalog entry、template 與 validator`);
    return { ok: false, managed: true, artifactId: mark.artifactId, findings };
  }

  // 宣稱的 id 與這條路徑對得上的契約不同：不是「沒登記」，是「貼錯契約」，訊息要分得開。
  if (!candidates.some((c) => c.artifact_id === entry.artifact_id)) {
    at('path-mismatch',
      `marker 宣稱 \`${entry.artifact_id}\`，但這條路徑對應的是 ${candidates.map((c) => c.artifact_id).join('｜')}`);
  }

  if (mark.version !== entry.template_version) {
    at('template-version',
      `文件宣稱 @${mark.version}，registry 目前是 @${entry.template_version}——改版時要一併更新文件，否則舊版格式會被當成合格`);
  }

  // authored-docs 刻意不查 section：那類文件依目的選 type-specific 標題，強迫長一樣就是把
  // 教學寫壞（#217 明列的非目標）。它們由 doc-classification 走另一條規則。
  if (entry.render_mode !== 'authored-docs') {
    const sections = extractSections(text);
    for (const required of entry.required_sections ?? []) {
      if (!hasSection(sections, required)) {
        at('required-section', `缺少必填區塊「${required}」`);
      }
    }
  }

  return { ok: findings.length === 0, managed: true, artifactId: entry.artifact_id, findings };
}

// ── IO 薄邊界 ────────────────────────────────────────────────────────────────

function readJson(absPath) {
  let raw;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (err) {
    return { error: `讀不到 ${absPath}：${err?.message ?? err}` };
  }
  const parsed = parseRegistryJson(raw);
  return parsed.error ? { error: `${absPath}：${parsed.error}` } : { registry: parsed.registry };
}

/** 讀 artifact registry → `{ registry }` 或 `{ error }`。 */
export function loadArtifactRegistry(pluginRoot) {
  const r = readJson(join(pluginRoot, ARTIFACT_REGISTRY_REL));
  return r.error ? r : { registry: r.registry };
}

/** 讀 workflow vocabulary → `{ vocabulary }` 或 `{ error }`。 */
export function loadWorkflowVocabulary(pluginRoot) {
  const r = readJson(join(pluginRoot, VOCABULARY_REL));
  return r.error ? r : { vocabulary: r.registry };
}

/**
 * registry 的完整體檢：形狀 ＋ producer 對得上 vocabulary ＋ template 指到真的存在的檔。
 * `opts.registry` / `opts.vocabulary` 可注入（測試用），不給就從 pluginRoot 讀。
 */
export function buildRegistryReport(pluginRoot, opts = {}) {
  const loadedRegistry = opts.registry ? { registry: opts.registry } : loadArtifactRegistry(pluginRoot);
  if (loadedRegistry.error) {
    return { ok: false, findings: [finding('registry-load', null, loadedRegistry.error)] };
  }
  const registry = loadedRegistry.registry;

  const findings = [...checkArtifactRegistry(registry)];

  const loadedVocab = opts.vocabulary ? { vocabulary: opts.vocabulary } : loadWorkflowVocabulary(pluginRoot);
  if (loadedVocab.error) findings.push(finding('vocabulary-load', null, loadedVocab.error));
  else findings.push(...checkProducerVocabulary(registry, loadedVocab.vocabulary));

  // template 是契約的一部分：指到一個不存在的檔，等於這條契約沒有骨架來源。
  for (const a of registry.artifacts ?? []) {
    if (typeof a?.template !== 'string' || a.template === '') continue;
    if (!existsSync(join(pluginRoot, a.template))) {
      findings.push(finding('template-exists', a.artifact_id, `template 指不到檔案：${a.template}`));
    }
  }

  return { ok: findings.length === 0, findings };
}

/** 人讀摘要。 */
export function formatSummary(report) {
  if (report.ok) return '✓ artifact-contract：artifact registry 形狀全綠，無 finding。';
  return [`✗ artifact-contract：${report.findings.length} 個 finding。`,
    ...report.findings.map((f) => `  ✗ [${f.check}] ${f.id ?? f.file ?? '-'} — ${f.detail}`)].join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function defaultPluginRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

function main() {
  const args = process.argv.slice(2);
  const pluginRoot = args.includes('--root') ? args[args.indexOf('--root') + 1] : defaultPluginRoot();
  const asJson = args.includes('--json');

  if (args.includes('--check')) {
    const target = args[args.indexOf('--check') + 1];
    const loaded = loadArtifactRegistry(pluginRoot);
    if (loaded.error) {
      process.stderr.write(`${loaded.error}\n`);
      return 1;
    }
    let text = '';
    try {
      text = readFileSync(target, 'utf8');
    } catch (err) {
      process.stderr.write(`讀不到 ${target}：${err?.message ?? err}\n`);
      return 1;
    }
    const result = validateArtifactDocument(loaded.registry, { path: target, text });
    if (asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (!result.managed) process.stdout.write(`· ${target} 不是受管產物，跳過。\n`);
    else if (result.ok) process.stdout.write(`✓ ${target} 符合 \`${result.artifactId}\` 契約。\n`);
    else process.stdout.write([`✗ ${target}（${result.artifactId ?? '未知契約'}）`,
      ...result.findings.map((f) => `  ✗ [${f.check}] ${f.detail}`)].join('\n') + '\n');
    return result.ok ? 0 : 1;
  }

  const report = buildRegistryReport(pluginRoot);
  if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${formatSummary(report)}\n`);
  return report.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
