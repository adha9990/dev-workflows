#!/usr/bin/env node
// reference-graph.mjs —— 掃出全 repo 的 reference 字面引用、逐處分類、產出／比對搬遷基準快照
// （#171 T3＋T4）。
//
// 為什麼掃描口徑寫死在工具裡、而不是寫在文件上：同一份樹用不同口徑（含不含 .json、含不含 glob、
// 含不含測試檔）會得出 316／329／374 等好幾個數字，任何寫死在文件裡的「N 處」都不可重現。
// 驗收條件因此是「條目數與本工具當場算出的數相符」，口徑只有這一份實作。
//
// 掃描面 ＝ skill-lint.mjs 的 walk()（plugin 樹的 .md/.mjs ＋ repo 根 README/AGENTS）；
// 字面形狀 ＝ REFERENCE_LITERAL_RE（references/ 之後任意深度、允許 glob 星號，收尾 .md）。
// 只認 .md：references/ 底下的 *.json 登記檔（三份 registry）搬遷後路徑不變，不是本次重整的
// 標的，納進來只會讓條目數膨脹而沒有任何可比對的價值。
//
// 五類分類（規則寫死在本檔、各自有測試，判定順序即下列順序）：
//   glob        字面含 `*`（如 references/ 星號 .md）——它是「一批檔」的寫法，本身不是一處引用
//   placeholder 佔位符檔名，沿用 skill-lint 的 REFERENCE_PLACEHOLDER_FILENAMES（xxx.md）
//   fixture     referrer 是合成字面檔：沿用 skill-lint 的 isExcludedFromLintScan（skill-lint 自身
//               ＋ hooks/scripts 下的 test-*.mjs）再加 fixtures/ 目錄段（skill-lint 另一處既有
//               豁免概念）。這些檔裡的路徑是負向案例與斷言用的合成值，**必須保持原樣**，
//               一次全域改寫會把測試改壞或改成假綠。
//   skill-local referrer 落在 skills/<name>/ 底下、且該 skill 自己的子目錄真的有這份檔——
//               skill-lint 已明文處理這條歧義（skill 內的裸引用有 skill 自己的與 plugin 層兩種合法解法），
//               這裡沿用同一條判準：skill 自己有這份檔就算 skill-local，否則才算指向 plugin 層。
//   real        其餘：真的在引用一份規範，**只有這類進基準比對**。
//
// 基準快照（T4）：
//   邏輯鍵 ＝ (referrer_component_id, target_component_id, ordinal)，不是 file:line ——
//   搬檔後 source 與 literal 都會變，沒有配對鍵就無法逐條比對。
//   normalized_sha256 ＝ 目標檔「遮罩掉 references/… 字面之後」的內容雜湊 —— 有一批 reference
//   自己內部也含字面引用，正確搬遷會改寫它們內部的引用；不遮罩的話這些條目在完全正確的搬遷下
//   也會紅，而面對一整片紅，實作者只會去放寬檢查。
//   --compare 在 baseline_commit ≠ merge-base 時拒絕比對（並印出兩個實際 sha），另檢查工作樹的
//   快照與版控（HEAD）裡的同一份檔一致——兩者合起來擋「在搬檔後的樹上重產基準再跟自己比」的恆綠。
//
// 用法：
//   node reference-graph.mjs [--root <dir>] [--json]            掃描並印出五類分布
//   node reference-graph.mjs --emit-baseline [--out <path>]     產出基準快照（提交進版控）
//   node reference-graph.mjs --compare [--baseline <path>] [--base-ref <ref>]
//     --base-ref 預設 ＝ 快照的 baseline_commit（等價於「基準 commit 必須是 HEAD 的祖先」）；
//     整合時可傳 --base-ref master 收緊成「基準必須正好落在與 master 的分歧點」。
// 依賴：僅 node 內建；registry 解析與路徑解析一律走 component-resolver.mjs，不另造一套。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { walk, isExcludedFromLintScan, REFERENCE_PLACEHOLDER_FILENAMES } from './skill-lint.mjs';
import { globCovers } from './registry-compiler.mjs';
import { loadRegistry, resolveComponent, repoRoot } from './component-resolver.mjs';

export const SNAPSHOT_SCHEMA_VERSION = '1';
export const BASELINE_REL = 'plugins/loops-workflow/references/reference-graph-baseline.json';

// references/ 之後任意深度的相對路徑，收尾 .md；字元集刻意含 `*`，好讓 glob 字面也被抓進來
// **並分類成 glob**（不抓就無從證明它被看過、也無從說明它為何不進比對）。
const REFERENCE_LITERAL_RE = /references\/[A-Za-z0-9_*.-]+(?:\/[A-Za-z0-9_*.-]+)*\.md/g;
// 遮罩 token 刻意不以 .md 收尾，避免遮罩後的內容再次被本規則（或 skill-lint 的 broken-ref）認成引用。
const MASK_TOKEN = 'references/<masked>';

const SKILL_DIR_RE = /^(plugins\/[^/]+\/skills\/[^/]+)\//;

// ── 分類層（純函式）────────────────────────────────────────────────────────────

/** 一段內容裡的所有 reference 字面（依出現順序）。 */
export function scanLiterals(content) {
  return [...String(content ?? '').matchAll(REFERENCE_LITERAL_RE)].map((m) => m[0]);
}

/** referrer 所屬的 skill 根目錄（skills/<name>），不在 skill 底下 → null。 */
function skillRootOf(referrerFile) {
  return String(referrerFile ?? '').match(SKILL_DIR_RE)?.[1] ?? null;
}

// fixture 界線：skill-lint 既有的兩個豁免概念（自身＋test-*.mjs 的 isExcludedFromLintScan、
// fixtures/ 目錄段）的聯集，不另立名單。
function isSyntheticReferrer(referrerFile) {
  const file = String(referrerFile ?? '');
  return isExcludedFromLintScan(file) || file.split('/').includes('fixtures');
}

/**
 * 一處字面引用 → 五類之一。skillLocalExists 是注入的存在性判定（相對 repo 根的路徑 → bool），
 * 預設一律 false：純函式不碰檔案系統，CLI 端才接上 existsSync。
 */
export function classifyMention(literal, referrerFile, { skillLocalExists = () => false } = {}) {
  const text = String(literal ?? '');
  if (text.includes('*')) return 'glob';
  if (REFERENCE_PLACEHOLDER_FILENAMES.has(text.split('/').pop())) return 'placeholder';
  if (isSyntheticReferrer(referrerFile)) return 'fixture';

  const skillRoot = skillRootOf(referrerFile);
  if (skillRoot && skillLocalExists(`${skillRoot}/${text}`)) return 'skill-local';
  return 'real';
}

/** 遮罩掉所有 reference 字面（並統一換行）——搬遷會改寫這些字面，它們不該算進內容雜湊。 */
export function maskReferenceLiterals(content) {
  return String(content ?? '').replace(/\r\n/g, '\n').replace(REFERENCE_LITERAL_RE, MASK_TOKEN);
}

/** 遮罩後內容的 sha256（hex）。 */
export function normalizedSha256(content) {
  return createHash('sha256').update(maskReferenceLiterals(content), 'utf8').digest('hex');
}

/** 邏輯鍵的字串化：比對時的唯一配對依據，也是 finding 指名的東西。 */
export function entryKey(entry) {
  return `${entry.referrer_component_id}→${entry.target_component_id}#${entry.ordinal}`;
}

/**
 * 掃描面（relPath → 內容）→ 條目 + findings。ctx 是注入的四個查詢埠（見 buildContext）：
 * componentIdOf（檔 → referrer 元件）、targetIdOf（字面 → 目標元件）、
 * existingPathOf（目標元件 → 磁碟上實際存在的相對路徑）、normalizedHashOf（目標元件 → 雜湊）。
 *
 * 五類全部進條目（class 欄位如實記錄），但只有 real 會被 compare 拿去比對——非 real 也留在快照裡，
 * 才看得出「某處從 real 變成別類」這種分類漂移，也讓分布數字可稽核。
 *
 * real 專屬的三條 finding：referrer 不在 registry（無法配鍵）、字面對不到元件、字面指向的路徑
 * 與該元件目前實際落點不符（stale-ref ＝ 搬檔漏改的那一處）。
 */
export function buildEntries(fileMap, ctx) {
  const { componentIdOf, targetIdOf, existingPathOf, normalizedHashOf, skillLocalExists } = ctx;
  const entries = [];
  const findings = [];
  const ordinals = new Map();

  for (const file of Object.keys(fileMap ?? {}).sort()) {
    const referrerId = componentIdOf(file);
    for (const literal of scanLiterals(fileMap[file])) {
      const cls = classifyMention(literal, file, { skillLocalExists });
      const targetId = targetIdOf(literal);
      const pairKey = `${referrerId}|${targetId}`;
      const ordinal = ordinals.get(pairKey) ?? 0;
      ordinals.set(pairKey, ordinal + 1);

      const entry = {
        referrer_component_id: referrerId,
        target_component_id: targetId,
        ordinal,
        class: cls,
        normalized_sha256: targetId ? normalizedHashOf(targetId) : null,
      };
      entries.push(entry);

      if (cls !== 'real') continue;
      if (!referrerId) {
        findings.push({ check: 'unmapped-referrer', severity: 'P1', file, detail: `${literal}：referrer 不在 component registry，無法配出邏輯鍵` });
        continue;
      }
      if (!targetId) {
        findings.push({ check: 'unresolved-target', severity: 'P1', file, detail: `${literal}：對不到任何 component（registry 未登記或字面拼錯）` });
        continue;
      }
      const actual = existingPathOf(targetId);
      if (actual && !actual.endsWith(literal)) {
        findings.push({
          check: 'stale-ref',
          severity: 'P1',
          file,
          key: entryKey(entry),
          detail: `${entryKey(entry)}：字面仍寫 ${literal}，但 ${targetId} 目前實際落點是 ${actual}`,
        });
      }
    }
  }

  return { entries, findings };
}

// ── IO 邊界：查詢埠、git、快照 ────────────────────────────────────────────────

function literalPathsOf(component) {
  return [...(Array.isArray(component.paths) ? component.paths : []), component.target_path]
    .filter((p) => typeof p === 'string' && p !== '');
}

/**
 * 檔案 → referrer 元件 id 的索引。逐字路徑優先於 glob（glob 元件如 docs/** 只是兜底），
 * 多個 glob 命中時取最長（最specific）的那條，避免結果隨 registry 排列順序漂移。
 */
function buildReferrerIndex(components) {
  const exact = new Map();
  const globs = [];
  for (const component of components) {
    for (const p of literalPathsOf(component)) {
      if (p.includes('*')) globs.push([p, component.id]);
      else if (!exact.has(p)) exact.set(p, component.id);
    }
  }
  globs.sort((a, b) => b[0].length - a[0].length);
  return (file) => {
    const hit = exact.get(file);
    if (hit) return hit;
    return globs.find(([pattern]) => globCovers(pattern, file))?.[1] ?? null;
  };
}

/**
 * 字面（references/… 相對段）→ 目標元件 id 的索引。同時收現況 paths 與 target_path 的尾段，
 * 這樣同一支工具在「搬檔前」與「搬檔後」的樹上都對得到同一個元件——沒有這一點，搬完之後所有
 * 條目都會變成「舊鍵消失、新鍵冒出」，逐條比對退化成整批重寫。
 */
function buildTargetIndex(components) {
  const index = new Map();
  const ambiguous = [];
  for (const component of components) {
    for (const p of literalPathsOf(component)) {
      if (p.includes('*')) continue;
      const at = p.indexOf('references/');
      if (at < 0) continue;
      const suffix = p.slice(at);
      const owner = index.get(suffix);
      if (owner == null) index.set(suffix, component.id);
      else if (owner !== component.id) ambiguous.push({ suffix, ids: [owner, component.id] });
    }
  }
  return { lookup: (literal) => index.get(literal) ?? null, ambiguous };
}

/** 組出 buildEntries 需要的查詢埠（會碰檔案系統與 registry）。 */
export function buildContext(root) {
  const registry = loadRegistry(root);
  const componentIdOf = buildReferrerIndex(registry.components);
  const target = buildTargetIndex(registry.components);
  const hashCache = new Map();
  const pathCache = new Map();

  const existingPathOf = (id) => {
    if (!pathCache.has(id)) {
      let rel = null;
      try {
        rel = relative(registry.root, resolveComponent(id, { root, registry })).split('\\').join('/');
      } catch {
        rel = null; // 目標檔不在磁碟上：由呼叫端的 finding 說明，這裡不猜
      }
      pathCache.set(id, rel);
    }
    return pathCache.get(id);
  };

  const normalizedHashOf = (id) => {
    if (!hashCache.has(id)) {
      const rel = existingPathOf(id);
      hashCache.set(id, rel ? normalizedSha256(readFileSync(join(registry.root, rel), 'utf8')) : null);
    }
    return hashCache.get(id);
  };

  return {
    registry,
    componentIdOf,
    targetIdOf: target.lookup,
    ambiguousTargets: target.ambiguous,
    existingPathOf,
    normalizedHashOf,
    skillLocalExists: (rel) => existsSync(join(registry.root, rel)),
  };
}

function countByClass(entries) {
  const byClass = { real: 0, fixture: 0, placeholder: 0, glob: 0, 'skill-local': 0 };
  for (const entry of entries) byClass[entry.class] += 1;
  return byClass;
}

/** 掃描一棵樹 → { entries, findings, byClass }（不含 commit 資訊，供 scan 與 emit 共用）。 */
export function scanTree(root) {
  const ctx = buildContext(root);
  const { entries, findings } = buildEntries(walk(root), ctx);
  for (const { suffix, ids } of ctx.ambiguousTargets) {
    findings.push({ check: 'ambiguous-target', severity: 'P1', file: BASELINE_REL, detail: `${suffix} 同時被 ${ids.join(' 與 ')} 宣告，目標歸屬不唯一` });
  }
  return { entries, findings, byClass: countByClass(entries) };
}

function runGit(root, args) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (res.error || res.status !== 0) return null;
  return res.stdout;
}

/** 真實 git 埠；測試可注入替身，免得為了驗比對邏輯去造一顆 git repo。 */
export function gitPort(root) {
  return {
    headSha: () => runGit(root, ['rev-parse', 'HEAD'])?.trim() ?? null,
    mergeBase: (baseRef) => runGit(root, ['merge-base', 'HEAD', baseRef])?.trim() ?? null,
    showFile: (sha, rel) => runGit(root, ['show', `${sha}:${rel}`]),
  };
}

/** 產出基準快照物件。baseline_commit ＝ 產出當下的 HEAD sha（拿不到 → 丟例外，不寫出無主快照）。 */
export function buildSnapshot(root, { git = gitPort(root) } = {}) {
  const { entries, findings } = scanTree(root);
  const baselineCommit = git.headSha();
  if (!baselineCommit) {
    throw new Error('reference-graph：取不到 HEAD sha，無法產出帶 commit 標記的基準快照');
  }
  return {
    snapshot: {
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      baseline_commit: baselineCommit,
      entries: sortEntries(entries),
    },
    findings,
  };
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    const ra = `${a.referrer_component_id}`.localeCompare(`${b.referrer_component_id}`);
    if (ra !== 0) return ra;
    const rt = `${a.target_component_id}`.localeCompare(`${b.target_component_id}`);
    if (rt !== 0) return rt;
    return a.ordinal - b.ordinal;
  });
}

function realEntryMap(entries) {
  const map = new Map();
  for (const entry of entries ?? []) {
    if (entry?.class !== 'real') continue;
    map.set(entryKey(entry), entry);
  }
  return map;
}

function sameSnapshot(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 快照 ⇄ 現況逐條比對。兩道前置閘先擋「自己跟自己比」的恆綠：
 *   1) baseline_commit ≠ merge-base → 拒絕比對（印出兩個實際 sha）。在搬檔後的樹上重產快照，
 *      它的 commit 會落在 merge-base 之後，這一閘就會擋下。
 *   2) 快照內容 ≠ 版控裡（HEAD）的同一份檔 → 拒絕比對。這一閘擋的是「未提交就地重產」
 *      （commit 標記還是舊的、內容卻已經是搬完後的）。快照尚未進版控時跳過本閘並記 note。
 * 過閘後只比 real 條目：缺鍵／多鍵／目標內容雜湊漂移各自成 P1，一律指名邏輯鍵。
 */
export function compareToBaseline(baseline, current, { mergeBase, committedBaseline = null } = {}) {
  const findings = [];
  const notes = [];

  if (baseline?.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
    findings.push({ check: 'baseline-schema', severity: 'P1', detail: `快照 schema_version=${baseline?.schema_version ?? '(缺)'}，預期 ${SNAPSHOT_SCHEMA_VERSION}` });
    return { ok: false, findings, notes, compared: 0 };
  }
  if (!mergeBase) {
    findings.push({ check: 'merge-base-unknown', severity: 'P1', detail: '取不到 merge-base，無法確認快照是否對得上分歧點——拒絕比對' });
    return { ok: false, findings, notes, compared: 0 };
  }
  if (baseline.baseline_commit !== mergeBase) {
    findings.push({
      check: 'baseline-commit-mismatch',
      severity: 'P1',
      detail: `拒絕比對：快照 baseline_commit=${baseline.baseline_commit}，實際 merge-base=${mergeBase}——請以分歧點的樹重產快照，不要拿搬檔後的樹當基準`,
    });
    return { ok: false, findings, notes, compared: 0 };
  }
  if (committedBaseline == null) {
    notes.push({ check: 'baseline-not-committed', detail: `快照在 ${mergeBase} 尚未進版控，略過內容一致性閘（提交後這一閘才會生效）` });
  } else if (!sameSnapshot(committedBaseline, baseline)) {
    findings.push({ check: 'baseline-tampered', severity: 'P1', detail: '拒絕比對：工作樹的快照與版控裡的同一份檔內容不符，疑似在搬檔後的樹上就地重產基準（未提交）' });
    return { ok: false, findings, notes, compared: 0 };
  }

  const before = realEntryMap(baseline.entries);
  const after = realEntryMap(current);

  for (const [key, entry] of before) {
    const now = after.get(key);
    if (!now) {
      findings.push({ check: 'missing-entry', severity: 'P1', key, detail: `${key}：基準有、現況沒有（引用被刪、改寫成別的目標，或漏改導致配不上）` });
      continue;
    }
    if (now.normalized_sha256 !== entry.normalized_sha256) {
      findings.push({ check: 'content-drift', severity: 'P1', key, detail: `${key}：目標內容（遮罩引用字面後）雜湊變了 ${entry.normalized_sha256?.slice(0, 12)}→${now.normalized_sha256?.slice(0, 12)}` });
    }
  }
  for (const key of after.keys()) {
    if (!before.has(key)) {
      findings.push({ check: 'extra-entry', severity: 'P1', key, detail: `${key}：現況有、基準沒有（新增引用或改寫成了別的目標）` });
    }
  }

  return { ok: findings.length === 0, findings, notes, compared: before.size };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function readJsonMaybe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 統一輸出契約：{ ok, mode, findings, notes, summary }。mode='scan' 只掃描分類；
 * mode='compare' 另外跑基準比對（掃描期的 findings 一併計入——搬檔漏改會在掃描期就以 stale-ref 現形）。
 */
export function buildReport(root, { mode = 'scan', baselinePath, baseRef = null, git = gitPort(root) } = {}) {
  const { entries, findings, byClass } = scanTree(root);
  const summary = { root: resolve(root), entriesScanned: entries.length, byClass };

  if (mode !== 'compare') {
    return { ok: findings.length === 0, mode: 'scan', findings, notes: [], summary };
  }

  const absBaseline = baselinePath ?? join(root, BASELINE_REL);
  const baseline = readJsonMaybe(absBaseline);
  if (!baseline) {
    return {
      ok: false,
      mode: 'compare',
      findings: [...findings, { check: 'baseline-missing', severity: 'P1', detail: `讀不到基準快照 ${absBaseline}（先跑 --emit-baseline）` }],
      notes: [],
      summary,
    };
  }

  // 錨點 ref 預設 ＝ 快照自己的 baseline_commit，此時 merge-base 檢查等於「該 commit 必須是 HEAD
  // 的祖先」——在 feature branch 上逐步搬檔的情境下這才是可用的錨（對 master 取 merge-base 會固定
  // 落在分支起點、跟基準產出時的樹不是同一棵）。整合時可用 --base-ref master 收緊成分歧點錨定。
  const mergeBase = git.mergeBase(baseRef ?? baseline.baseline_commit);
  const baselineRel = relative(resolve(root), resolve(absBaseline)).split('\\').join('/');
  // 內容一致性閘讀的是 **HEAD 版本**、不是 baseline_commit 版本：快照記的 baseline_commit 是
  // 「被掃描的那棵樹」的 sha，而快照本身只能在那之後才進版控（一份檔不可能記載自己所在 commit
  // 的 sha —— 那是雜湊自指），對 baseline_commit 取檔必然拿到 null、這一閘就永遠被略過。
  // 改讀 HEAD 後，「工作樹就地重產、還沒提交」立刻現形（工作樹 ≠ HEAD 版本 → baseline-tampered）；
  // 「重產後連 commit 一起做掉」則由第一閘負責——整合時以 `--base-ref master` 錨在分歧點，
  // 重產出來的 baseline_commit 不會等於分歧點。兩閘合起來覆蓋原設計要擋的兩種恆綠。
  const committedText = mergeBase ? git.showFile('HEAD', baselineRel) : null;
  const compared = compareToBaseline(baseline, entries, {
    mergeBase,
    committedBaseline: committedText ? JSON.parse(committedText) : null,
  });

  return {
    ok: findings.length === 0 && compared.ok,
    mode: 'compare',
    findings: [...findings, ...compared.findings],
    notes: compared.notes,
    summary: { ...summary, baselineCommit: baseline.baseline_commit, mergeBase, comparedEntries: compared.compared },
  };
}

export function formatSummary(result) {
  const { byClass = {}, entriesScanned = 0 } = result?.summary ?? {};
  const dist = Object.entries(byClass).map(([k, v]) => `${k}=${v}`).join(' ');
  const head = result?.ok
    ? `✓ reference-graph（${result.mode}）：${entriesScanned} 處引用，${dist}`
    : `✗ reference-graph（${result.mode}）：${entriesScanned} 處引用，${dist}`;
  const lines = [head];
  if (result?.mode === 'compare') lines.push(`  基準 ${result.summary?.baselineCommit ?? '(無)'}｜merge-base ${result.summary?.mergeBase ?? '(無)'}｜比對 ${result.summary?.comparedEntries ?? 0} 條 real`);
  for (const f of result?.findings ?? []) lines.push(`  ✗ [${f.check}] ${f.severity} ${f.file ?? f.key ?? ''} — ${f.detail}`);
  for (const n of result?.notes ?? []) lines.push(`  ⚠ [${n.check}] ${n.detail}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const opts = { root: repoRoot(), json: false, mode: 'scan', out: null, baselinePath: null, baseRef: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--root') opts.root = argv[++i] ?? opts.root;
    else if (flag === '--json') opts.json = true;
    else if (flag === '--compare') opts.mode = 'compare';
    else if (flag === '--emit-baseline') opts.mode = 'emit';
    else if (flag === '--out') opts.out = argv[++i] ?? null;
    else if (flag === '--baseline') opts.baselinePath = argv[++i] ?? null;
    else if (flag === '--base-ref') opts.baseRef = argv[++i] ?? opts.baseRef;
  }
  return opts;
}

function emitBaseline(opts) {
  const { snapshot, findings } = buildSnapshot(opts.root);
  const outPath = opts.out ?? join(opts.root, BASELINE_REL);
  writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  const byClass = countByClass(snapshot.entries);
  return {
    ok: findings.length === 0,
    mode: 'emit',
    findings,
    notes: [{ check: 'baseline-written', detail: `${outPath}（commit ${snapshot.baseline_commit}，${snapshot.entries.length} 條）` }],
    summary: { root: resolve(opts.root), entriesScanned: snapshot.entries.length, byClass },
  };
}

function main(argv) {
  const opts = parseArgs(argv);
  const result = opts.mode === 'emit'
    ? emitBaseline(opts)
    : buildReport(opts.root, { mode: opts.mode, baselinePath: opts.baselinePath, baseRef: opts.baseRef });
  console.log(opts.json ? JSON.stringify(result, null, 2) : formatSummary(result));
  process.exit(result.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2));
}
