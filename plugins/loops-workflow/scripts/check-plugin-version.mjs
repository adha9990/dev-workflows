#!/usr/bin/env node
// check-plugin-version.mjs —— plugin 對外表面變動時，版本必須前進（#203）。
//
// 踩過的坑：現代化那批把 skill 從 11 個加到 14 個、公開入口從 1 個變成 2 個，`plugin.json` 的
// `version` 卻完全沒動。後果是**使用者更新不到新版**——版本號沒前進，更新機制無從分辨新舊。
// 而且當時**沒有任何檢查抓得到**：skill-lint 查引用與計數、codex-plugin-lint 查 manifest 形狀，
// 但沒有人查「使用者拿到的東西變了，版本要跟著動」。
//
// 「對外表面」＝使用者觀察得到的三件事，任一變動就要求版本前進：
//   · **skill 集合**（`skills/` 底下的目錄名）
//   · **公開入口集合**（frontmatter `user-invocable: true` 的 skill）
//   · **hook 集合**（`hooks/` 底下非測試的 `.mjs`）
// 內部重構（改實作、加測試、改 reference 內文）**不觸發**——那些不改變使用者拿到的東西。
//
// 基準錨在**與主幹的分歧點**（同 reference-graph 的錨點慣例：squash merge 會換掉 feature 分支的
// commit，錨在 HEAD 會讓檢查在合併後永久失效）。分歧點取不到、或等於 HEAD（例如就在主幹上）＝
// **沒有可比對的基準**，回綠並說明原因，不製造假紅。
//
// 刻意**不自動 bump**：這次算 patch 還是 minor 是人的判斷，機械只負責「你忘了」。
//
// 純函式（parseSemver / compareSemver / surfaceOf / diffSurface / checkVersionBump）＋
// IO 薄邊界（gitPort / readSurfaceAt）。依賴：僅 node 內建。

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_REL = 'plugins/loops-workflow/.claude-plugin/plugin.json';
const SKILLS_REL = 'plugins/loops-workflow/skills';
const HOOKS_REL = 'plugins/loops-workflow/hooks';

/** 對外表面的三個面向。任一變動就要求版本前進。 */
export const SURFACE_FACETS = Object.freeze(['skills', 'publicEntries', 'hooks']);

/** 每個面向變動時要講的人話。 */
const FACET_LABEL = Object.freeze({
  skills: 'skill 集合',
  publicEntries: '公開入口集合',
  hooks: 'hook 集合',
});

// ── semver（純函式）────────────────────────────────────────────────────────

/** `1.2.3` → `[1,2,3]`；解析不了 → null（不猜）。 */
export function parseSemver(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** a 比 b 大回 1、小回 -1、相等回 0；任一解析不了回 null（呼叫端據此報「版本格式不合」）。 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

// ── 表面（純函式）─────────────────────────────────────────────────────────

/**
 * 這個 skill 是不是公開入口。
 *
 * **極性沿用 repo 既有慣例（見 test-canonical-contracts.mjs 的 `userInvocable !== false`）：
 * 顯式寫 `user-invocable: false` 才是內部能力，沒寫那一行就是公開。** 實測踩過：`dispatch`
 * 的 frontmatter 根本沒有這一行，用「要寫 true 才算公開」去判會把它漏掉。
 *
 * 讀不到檔（null）不算公開——那是壞掉的 skill 目錄，屬 skill-lint 的守備範圍，本檢查不臆測。
 */
export function isPublicEntry(skillText) {
  if (typeof skillText !== 'string' || skillText === '') return false;
  return !/^user-invocable:\s*false\s*$/m.test(skillText);
}

/**
 * 由「檔案清單 ＋ 讀檔函式」組出表面。以 port 注入，讓同一份邏輯可以同時算
 * **工作樹的現況**與**分歧點那個 commit 的樣子**（後者靠 git show 讀）。
 */
export function surfaceOf({ skillDirs = [], hookFiles = [], readSkill = () => null } = {}) {
  const skills = [...skillDirs].sort();
  const publicEntries = skills.filter((name) => isPublicEntry(readSkill(name))).sort();
  const hooks = [...hookFiles].filter((f) => f.endsWith('.mjs') && !f.startsWith('test-')).sort();
  return { skills, publicEntries, hooks };
}

/** 兩個表面的差集，逐面向列出多了什麼、少了什麼。 */
export function diffSurface(before, after) {
  const changes = [];
  for (const facet of SURFACE_FACETS) {
    const a = new Set(before?.[facet] ?? []);
    const b = new Set(after?.[facet] ?? []);
    const added = [...b].filter((x) => !a.has(x)).sort();
    const removed = [...a].filter((x) => !b.has(x)).sort();
    if (added.length || removed.length) changes.push({ facet, label: FACET_LABEL[facet], added, removed });
  }
  return { changed: changes.length > 0, changes };
}

/**
 * 主判定。回 `{ok, findings, notes}`。
 *
 * 三種結果：
 *   · 沒有可比對的基準 → ok，並在 notes 說明（不製造假紅）。
 *   · 表面沒變 → ok（版本動不動都可以，那是作者的自由）。
 *   · 表面變了 → **版本必須嚴格前進**；相等或倒退都紅，並指名是哪一類表面變了。
 */
export function checkVersionBump({ baseVersion, headVersion, baseSurface, headSurface, baseRef = 'master' } = {}) {
  const findings = [];
  const notes = [];

  if (baseVersion === null || baseVersion === undefined || baseSurface === null) {
    notes.push({ check: 'no-baseline', detail: `取不到與 ${baseRef} 的分歧點（或分歧點就是 HEAD）——沒有可比對的基準，本檢查略過` });
    return { ok: true, findings, notes, diff: { changed: false, changes: [] } };
  }

  const diff = diffSurface(baseSurface, headSurface);
  if (!diff.changed) {
    notes.push({ check: 'surface-unchanged', detail: '對外表面沒有變動（skill／公開入口／hook 集合都一樣）——不要求 bump' });
    return { ok: true, findings, notes, diff };
  }

  const cmp = compareSemver(headVersion, baseVersion);
  const what = diff.changes.map((c) => {
    const bits = [];
    if (c.added.length) bits.push(`新增 ${c.added.join('、')}`);
    if (c.removed.length) bits.push(`移除 ${c.removed.join('、')}`);
    return `${c.label}（${bits.join('；')}）`;
  }).join('；');

  if (cmp === null) {
    findings.push({ check: 'plugin-version-format', severity: 'P1', file: PLUGIN_REL, detail: `版本格式不是 x.y.z，無法比較（分歧點 ${JSON.stringify(baseVersion)}／現在 ${JSON.stringify(headVersion)}）` });
  } else if (cmp <= 0) {
    findings.push({
      check: 'plugin-version-bump',
      severity: 'P1',
      file: PLUGIN_REL,
      detail: `對外表面變了但版本沒有前進（分歧點 ${baseVersion} → 現在 ${headVersion}）：${what}。使用者更新不到新版——版本號沒動，更新機制無從分辨新舊。`,
    });
  }
  return { ok: findings.length === 0, findings, notes, diff };
}

// ── IO 薄邊界 ────────────────────────────────────────────────────────────────

function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function runGit(root, args) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (res.error || res.status !== 0) return null;
  return res.stdout;
}

/** 真實 git 埠；測試可注入替身，免得為了驗判定邏輯去造一顆 repo。 */
export function gitPort(root) {
  return {
    headSha: () => runGit(root, ['rev-parse', 'HEAD'])?.trim() ?? null,
    mergeBase: (baseRef) => runGit(root, ['merge-base', 'HEAD', baseRef])?.trim() ?? null,
    showFile: (sha, rel) => runGit(root, ['show', `${sha}:${rel}`]),
    listTree: (sha, rel) => runGit(root, ['ls-tree', '--name-only', `${sha}:${rel}`]),
  };
}

const safeJson = (text) => { try { return JSON.parse(text); } catch { return null; } };

/** 工作樹現況的表面與版本。 */
export function readSurfaceHere(root) {
  const version = safeJson(existsSync(join(root, PLUGIN_REL)) ? readFileSync(join(root, PLUGIN_REL), 'utf8') : '')?.version ?? null;
  const skillDirs = existsSync(join(root, SKILLS_REL))
    ? readdirSync(join(root, SKILLS_REL)).filter((n) => { try { return statSync(join(root, SKILLS_REL, n)).isDirectory(); } catch { return false; } })
    : [];
  const hookFiles = existsSync(join(root, HOOKS_REL)) ? readdirSync(join(root, HOOKS_REL)) : [];
  const readSkill = (name) => { try { return readFileSync(join(root, SKILLS_REL, name, 'SKILL.md'), 'utf8'); } catch { return null; } };
  return { version, surface: surfaceOf({ skillDirs, hookFiles, readSkill }) };
}

/** 某個 commit 當下的表面與版本（讀不到 → `{version:null, surface:null}`）。 */
export function readSurfaceAt(git, sha) {
  if (!sha) return { version: null, surface: null };
  const version = safeJson(git.showFile(sha, PLUGIN_REL) ?? '')?.version ?? null;
  const skillDirs = (git.listTree(sha, SKILLS_REL) ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  const hookFiles = (git.listTree(sha, HOOKS_REL) ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (version === null && !skillDirs.length) return { version: null, surface: null };
  const readSkill = (name) => git.showFile(sha, `${SKILLS_REL}/${name}/SKILL.md`);
  return { version, surface: surfaceOf({ skillDirs, hookFiles, readSkill }) };
}

/** 完整報告。 */
export function buildReport(root = repoRoot(), { baseRef = 'master', git = null } = {}) {
  const g = git ?? gitPort(root);
  const head = readSurfaceHere(root);
  const mergeBase = g.mergeBase(baseRef);
  const headSha = g.headSha();
  // 分歧點就是 HEAD（例如正站在主幹上）⇒ 沒有可比對的基準
  const base = !mergeBase || mergeBase === headSha ? { version: null, surface: null } : readSurfaceAt(g, mergeBase);
  return {
    ...checkVersionBump({ baseVersion: base.version, headVersion: head.version, baseSurface: base.surface, headSurface: head.surface, baseRef }),
    baseRef,
    mergeBase,
    baseVersion: base.version,
    headVersion: head.version,
  };
}

/** 人讀摘要。 */
export function formatSummary(report) {
  if (report.ok) {
    const note = report.notes[0]?.detail ?? '';
    return `✓ check-plugin-version：${report.headVersion ?? '?'}${note ? `——${note}` : ''}`;
  }
  return [`✗ check-plugin-version：${report.findings.length} 個 finding。`,
    ...report.findings.map((f) => `  ✗ [${f.check}] ${f.file} — ${f.detail}`)].join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : repoRoot();
  const baseRef = args.includes('--base-ref') ? args[args.indexOf('--base-ref') + 1] : 'master';
  const report = buildReport(root, { baseRef });
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${formatSummary(report)}\n`);
  return report.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
