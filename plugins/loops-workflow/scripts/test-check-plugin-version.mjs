#!/usr/bin/env node
// test-check-plugin-version.mjs —— 「對外表面變動要 bump 版本」的斷言（#203）。
// 正反都驗：表面變了沒 bump 要紅、表面沒變不 bump 要綠、版本倒退要紅、取不到基準不誤報。
// 用法：node test-check-plugin-version.mjs [--filter <case-prefix>] [--min-cases <n>]

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SURFACE_FACETS,
  parseSemver, compareSemver, isPublicEntry, surfaceOf, diffSurface, checkVersionBump,
  readSurfaceHere, readSurfaceAt, buildReport, formatSummary,
} from './check-plugin-version.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

let passed = 0;
const failed = [];
const cases = [];
const testCase = (id, name, fn) => cases.push({ id, name, fn });
function assert(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); } else { failed.push(msg); console.error(`  ✗ ${msg}`); }
}
function parseArgs(argv) {
  const opts = { filter: '', minCases: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--filter') opts.filter = argv[++i] ?? '';
    else if (argv[i] === '--min-cases') opts.minCases = Number(argv[++i] ?? 0);
  }
  return opts;
}

const surface = (over = {}) => ({ skills: ['dispatch', 'goal'], publicEntries: ['dispatch'], hooks: ['pr-gate.mjs'], ...over });

/** 假 git 埠：以固定的樹內容回應，讓判定邏輯不必造一顆真 repo 就測得動。 */
function stubGit({ head = 'HEAD-SHA', mergeBase = 'BASE-SHA', tree = {}, files = {} } = {}) {
  return {
    headSha: () => head,
    mergeBase: () => mergeBase,
    listTree: (sha, rel) => tree[`${sha}:${rel}`] ?? null,
    showFile: (sha, rel) => files[`${sha}:${rel}`] ?? null,
  };
}

// ══════════════════════════════════════════════════════════════════════════
testCase('V1', 'semver 解析與比較', () => {
  assert(JSON.stringify(parseSemver('1.2.3')) === '[1,2,3]', '正常版本解析得出來');
  for (const bad of ['1.2', 'v1.2.3', '1.2.3-beta', '', null, undefined]) {
    assert(parseSemver(bad) === null, `${JSON.stringify(bad)} → null（不猜）`);
  }
  assert(compareSemver('0.57.0', '0.56.4') === 1, '0.57.0 > 0.56.4');
  assert(compareSemver('0.56.4', '0.57.0') === -1, '0.56.4 < 0.57.0');
  assert(compareSemver('0.56.4', '0.56.4') === 0, '相等');
  assert(compareSemver('0.56.10', '0.56.9') === 1, '數字比較不是字串比較（10 > 9）');
  assert(compareSemver('1.0.0', '0.99.99') === 1, 'major 優先');
  assert(compareSemver('x', '1.0.0') === null, '解析不了 → null');
});

testCase('V2', 'surfaceOf：公開入口靠 frontmatter 判、測試檔不算 hook', () => {
  assert(isPublicEntry('---\nuser-invocable: true\n---'), '顯式 true → 公開入口');
  assert(!isPublicEntry('---\nuser-invocable: false\n---'), '顯式 false → 內部能力');
  // 極性沿用 repo 既有慣例：沒寫那一行＝公開（dispatch 的 frontmatter 就是這樣，實測踩過）
  assert(isPublicEntry('---\nname: dispatch\ndescription: x\n---'), '沒寫那一行 → 公開（不是預設不公開）');
  assert(!isPublicEntry(null) && !isPublicEntry(''), '讀不到檔 → 不算公開（壞掉的 skill 目錄交給 skill-lint）');

  const s = surfaceOf({
    skillDirs: ['goal', 'dispatch'],
    hookFiles: ['pr-gate.mjs', 'test-pr-gate.mjs', 'README.md'],
    readSkill: (n) => (n === 'dispatch' ? '---\nname: dispatch\n---' : '---\nuser-invocable: false\n---'),
  });
  assert(s.skills.join(',') === 'dispatch,goal', 'skill 集合排序固定（比對才穩定）');
  assert(s.publicEntries.join(',') === 'dispatch', '只有標 true 的算公開入口');
  assert(s.hooks.join(',') === 'pr-gate.mjs', '測試檔與非 .mjs 都不算 hook（否則加個測試就要 bump）');
  assert(SURFACE_FACETS.join(',') === 'skills,publicEntries,hooks', '三個面向固定');
});

testCase('V3', 'diffSurface：逐面向指出多了什麼、少了什麼', () => {
  assert(diffSurface(surface(), surface()).changed === false, '一樣 → 沒變');
  const added = diffSurface(surface(), surface({ skills: ['dispatch', 'goal', 'setup'] }));
  assert(added.changed && added.changes[0].facet === 'skills' && added.changes[0].added.join(',') === 'setup', '新增 skill 被指名');
  const removed = diffSurface(surface(), surface({ hooks: [] }));
  assert(removed.changes[0].facet === 'hooks' && removed.changes[0].removed.join(',') === 'pr-gate.mjs', '移除 hook 也被指名');
  const entry = diffSurface(surface(), surface({ publicEntries: ['dispatch', 'setup'] }));
  assert(entry.changes[0].facet === 'publicEntries', '公開入口變動被指名（skill 沒變、只是變公開也算）');
  const multi = diffSurface(surface(), surface({ skills: ['dispatch'], hooks: [] }));
  assert(multi.changes.length === 2, '多個面向同時變 → 全部列出');
});

testCase('V4', '表面變了但版本沒前進 → 紅，並指名是哪一類表面', () => {
  const r = checkVersionBump({
    baseVersion: '0.56.4', headVersion: '0.56.4',
    baseSurface: surface(), headSurface: surface({ skills: ['dispatch', 'goal', 'setup'], publicEntries: ['dispatch', 'setup'] }),
  });
  assert(!r.ok && r.findings[0].check === 'plugin-version-bump', '判紅');
  assert(r.findings[0].detail.includes('skill 集合') && r.findings[0].detail.includes('setup'), '指名哪一類表面、多了什麼');
  assert(r.findings[0].detail.includes('公開入口集合'), '兩類都指名');
  assert(r.findings[0].detail.includes('更新不到新版'), '講清楚後果');

  const back = checkVersionBump({ baseVersion: '0.57.0', headVersion: '0.56.4', baseSurface: surface(), headSurface: surface({ skills: ['dispatch'] }) });
  assert(!back.ok, '版本倒退也紅');
  const bad = checkVersionBump({ baseVersion: '0.56.4', headVersion: 'nope', baseSurface: surface(), headSurface: surface({ skills: ['dispatch'] }) });
  assert(!bad.ok && bad.findings[0].check === 'plugin-version-format', '版本格式不合 → 另一種 finding');
});

testCase('V5', '反向：表面沒變不要求 bump、有 bump 就過（不製造假紅）', () => {
  const same = checkVersionBump({ baseVersion: '0.56.4', headVersion: '0.56.4', baseSurface: surface(), headSurface: surface() });
  assert(same.ok && same.notes[0].check === 'surface-unchanged', '表面沒變 → 綠並說明');
  assert(same.findings.length === 0, '沒有 finding');
  const bumped = checkVersionBump({ baseVersion: '0.56.4', headVersion: '0.57.0', baseSurface: surface(), headSurface: surface({ skills: ['dispatch', 'goal', 'setup'] }) });
  assert(bumped.ok, '表面變了且版本前進 → 綠（殺掉「凡是表面變就擋」的實作）');
  const internalOnly = checkVersionBump({ baseVersion: '0.56.4', headVersion: '0.56.4', baseSurface: surface(), headSurface: surface({ hooks: ['pr-gate.mjs'] }) });
  assert(internalOnly.ok, '只改實作內容（集合沒變）不要求 bump');
});

testCase('V6', '取不到基準 → 綠並說明原因，不誤報', () => {
  const r = checkVersionBump({ baseVersion: null, headVersion: '0.57.0', baseSurface: null, headSurface: surface() });
  assert(r.ok && r.notes[0].check === 'no-baseline', '沒有基準 → 綠');
  assert(r.notes[0].detail.includes('略過'), '說明是略過而不是通過');
  assert(r.findings.length === 0, '不製造假紅');
});

testCase('V7', 'git 邊界：分歧點等於 HEAD（在主幹上）視為沒有基準', () => {
  const git = stubGit({ head: 'SAME', mergeBase: 'SAME' });
  const r = buildReport(REPO_ROOT, { git });
  assert(r.ok && r.notes.some((n) => n.check === 'no-baseline'), '分歧點＝HEAD → 沒有可比對的基準');

  const missing = buildReport(REPO_ROOT, { git: stubGit({ mergeBase: null }) });
  assert(missing.ok && missing.notes.some((n) => n.check === 'no-baseline'), '取不到分歧點 → 同上');
});

testCase('V8', 'readSurfaceAt：讀得出某個 commit 當下的表面', () => {
  const git = stubGit({
    tree: {
      'BASE-SHA:plugins/loops-workflow/skills': 'dispatch\ngoal\n',
      'BASE-SHA:plugins/loops-workflow/hooks': 'pr-gate.mjs\ntest-pr-gate.mjs\n',
    },
    files: {
      'BASE-SHA:plugins/loops-workflow/.claude-plugin/plugin.json': '{"version":"0.56.4"}',
      'BASE-SHA:plugins/loops-workflow/skills/dispatch/SKILL.md': '---\nuser-invocable: true\n---',
      'BASE-SHA:plugins/loops-workflow/skills/goal/SKILL.md': '---\nuser-invocable: false\n---',
    },
  });
  const at = readSurfaceAt(git, 'BASE-SHA');
  assert(at.version === '0.56.4', '版本讀得到');
  assert(at.surface.skills.join(',') === 'dispatch,goal', 'skill 集合讀得到');
  assert(at.surface.publicEntries.join(',') === 'dispatch', '公開入口讀得到');
  assert(at.surface.hooks.join(',') === 'pr-gate.mjs', 'hook 集合讀得到、測試檔排除');
  assert(readSurfaceAt(git, null).surface === null, '沒給 sha → null');
  assert(readSurfaceAt(stubGit(), 'NOPE').surface === null, '讀不到那個 commit → null（交給 no-baseline 處理）');
});

testCase('V9', '真 repo：現況讀得出來，且版本已反映新增的三個 skill', () => {
  const here = readSurfaceHere(REPO_ROOT);
  assert(here.version && here.version !== '0.56.4', `版本已前進（實際：${here.version}）——現代化那批新增了三個 skill 卻沒 bump，本票補上`);
  assert(here.surface.skills.length >= 14, `skill 集合 ${here.surface.skills.length} 個`);
  for (const s of ['setup', 'decision-interview', 'agents-md-maintainer']) {
    assert(here.surface.skills.includes(s), `新增的 ${s} 在 skill 集合裡`);
  }
  assert(here.surface.publicEntries.sort().join(',') === 'dispatch,setup', '公開入口恰為兩個');
  assert(here.surface.hooks.length > 10 && !here.surface.hooks.some((h) => h.startsWith('test-')), 'hook 集合非空且不含測試檔');
  assert(formatSummary({ ok: true, headVersion: here.version, notes: [] }).includes('✓'), '摘要格式');
});

// ══════════════════════════════════════════════════════════════════════════
const opts = parseArgs(process.argv.slice(2));
const selected = cases.filter((c) => c.id === opts.filter || c.id.startsWith(opts.filter));
for (const c of selected) { console.log(`\n[${c.id}] ${c.name}`); c.fn(); }
console.log(`\n${selected.length} cases run, ${passed} passed, ${failed.length} failed`);
if (opts.minCases > 0 && selected.length < opts.minCases) {
  console.error(`\n✗ case 數地板未達成：--min-cases ${opts.minCases}，實際 ${selected.length}`);
  process.exit(1);
}
if (failed.length) { console.error('\n失敗清單：'); for (const m of failed) console.error(`  - ${m}`); process.exit(1); }
process.exit(0);
