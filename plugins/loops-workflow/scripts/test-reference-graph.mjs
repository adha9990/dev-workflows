#!/usr/bin/env node
// test-reference-graph.mjs —— reference-graph.mjs 的紅綠斷言（#171 T3 掃描/分類 ＋ T4 基準快照）。
// 用法：node test-reference-graph.mjs [--filter <case-prefix>] [--min-cases <n>]
//   --min-cases 8  斷言實際跑到的 case 數不得少於 8
// 全綠且達到 case 地板 → exit 0；任一斷言失敗 / case 數不足 / import 失敗 → exit 1。
//
// 本檔自己就是 fixture 類 referrer（scripts/test-*.mjs），底下的合成路徑字面
// 一律不得被當成真引用去改寫——C3 正是驗這條。
//
// 兩條負向 fixture（T4 的防自比恆綠）：
//   N1 搬檔漏改一處引用 → 紅，且 finding 指名該邏輯鍵
//   N2 用搬檔後的樹重產基準再比對 → 紅（拒絕比對），不得因為「自己跟自己比」而恆綠

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  classifyMention,
  scanLiterals,
  maskReferenceLiterals,
  normalizedSha256,
  entryKey,
  buildEntries,
  buildContext,
  scanTree,
  buildSnapshot,
  compareToBaseline,
  buildReport,
  formatSummary,
  BASELINE_REL,
  SNAPSHOT_SCHEMA_VERSION,
} from './reference-graph.mjs';
import { walk } from './skill-lint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const SCRIPT = fileURLToPath(new URL('./reference-graph.mjs', import.meta.url));
const REGISTRY_REL = 'plugins/loops-workflow/references/component-registry.json';

// ── 極簡 harness ──────────────────────────────────────────────────────────────
let passed = 0;
const failed = [];
const cases = [];

function testCase(id, name, fn) {
  cases.push({ id, name, fn });
}

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function parseArgs(argv) {
  const opts = { filter: '', minCases: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--filter') opts.filter = argv[++i] ?? '';
    else if (flag === '--min-cases') opts.minCases = Number(argv[++i] ?? 0);
  }
  return opts;
}

// ── 合成樹：一棵最小 plugin 樹＋自帶 registry，含五類引用各至少一處 ──────────────
const SKILL_MD_REL = 'plugins/loops-workflow/skills/demo/SKILL.md';
const ALPHA_REL = 'plugins/loops-workflow/references/alpha.md';
const BETA_REL = 'plugins/loops-workflow/references/beta.md';
const ALPHA_TARGET_REL = 'plugins/loops-workflow/references/shared/runtime/alpha.md';
const BETA_TARGET_REL = 'plugins/loops-workflow/references/personas/beta.md';

const SYNTHETIC_COMPONENTS = [
  { id: 'ref-alpha', paths: [ALPHA_REL], target_path: ALPHA_TARGET_REL, owner_class: 'shared-runtime' },
  { id: 'ref-beta', paths: [BETA_REL], target_path: BETA_TARGET_REL, owner_class: 'persona' },
  { id: 'demo-skill', paths: ['plugins/loops-workflow/skills/demo/**'], target_path: 'plugins/loops-workflow/skills/demo', owner_class: 'stage' },
  { id: 'demo-tests', paths: ['plugins/loops-workflow/scripts/test-demo.mjs'], target_path: null, owner_class: null },
];

function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
}

function makeTree() {
  const dir = mkdtempSync(join(tmpdir(), 'refg-'));
  writeFiles(dir, {
    [REGISTRY_REL]: JSON.stringify({ schema_version: '1', notes: '合成 fixture', components: SYNTHETIC_COMPONENTS }, null, 2),
    [ALPHA_REL]: '# alpha\n細節見 references/beta.md。\n',
    [BETA_REL]: '# beta\n沒有對外引用。\n',
    [SKILL_MD_REL]: [
      '# demo skill',
      '先讀 references/alpha.md，再讀 references/beta.md。',
      '收尾時回頭核對 references/alpha.md。',
      '批次寫法 references/*.md 不是一處引用。',
      '任意檔名佔位 references/xxx.md 也不是。',
      '本 skill 自己的 references/local.md 走 skill-local。',
      '',
    ].join('\n'),
    'plugins/loops-workflow/skills/demo/references/local.md': '# skill 自己的 reference\n',
    'plugins/loops-workflow/scripts/test-demo.mjs': '// 合成斷言用：references/alpha.md 與 references/ghost.md 必須保持原樣\n',
  });
  return dir;
}

/** 把合成樹搬成「重整後」的樣子：檔案移到 target_path，所有 real 字面同步改寫。 */
function applyMove(root, { skipOneRewrite = false } = {}) {
  mkdirSync(join(root, dirname(ALPHA_TARGET_REL)), { recursive: true });
  mkdirSync(join(root, dirname(BETA_TARGET_REL)), { recursive: true });
  renameSync(join(root, ALPHA_REL), join(root, ALPHA_TARGET_REL));
  renameSync(join(root, BETA_REL), join(root, BETA_TARGET_REL));

  const rewrite = (rel, fn) => {
    const abs = join(root, rel);
    writeFileSync(abs, fn(readFileSync(abs, 'utf8')), 'utf8');
  };
  rewrite(ALPHA_TARGET_REL, (t) => t.replace('references/beta.md', 'references/personas/beta.md'));
  rewrite(SKILL_MD_REL, (t) => {
    const moved = t
      .split('references/beta.md').join('references/personas/beta.md')
      .split('references/alpha.md').join('references/shared/runtime/alpha.md');
    // 負向 fixture N1：故意把最後一處改回舊路徑，模擬「搬檔漏改一處引用」
    return skipOneRewrite
      ? moved.replace('收尾時回頭核對 references/shared/runtime/alpha.md', '收尾時回頭核對 references/alpha.md')
      : moved;
  });
  // scripts/test-demo.mjs 刻意不動：測試檔裡的合成路徑必須保持原樣
}

function stubGit(sha) {
  return { headSha: () => sha, mergeBase: () => sha, showFile: () => null };
}

function withTree(fn) {
  const root = makeTree();
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// C 組：五類分類規則各自有測試
// ══════════════════════════════════════════════════════════════════════════
testCase('C1', 'glob 字面（含 *）→ glob，不是一處引用', () => {
  const cls = classifyMention('references/*.md', 'plugins/loops-workflow/skills/demo/SKILL.md');
  assert(cls === 'glob', `references/ 星號 .md 應分類為 glob（實際：${cls}）`);
  assert(scanLiterals('見 references/*.md 全部').length === 1, 'glob 字面仍要被掃到（掃到才說得出它為何不進比對）');
});

testCase('C2', '佔位符檔名 → placeholder（沿用 skill-lint 的既有常數）', () => {
  const cls = classifyMention('references/xxx.md', 'AGENTS.md');
  assert(cls === 'placeholder', `佔位符檔名應分類為 placeholder（實際：${cls}）`);
  const other = classifyMention('references/clean-code.md', 'AGENTS.md');
  assert(other === 'real', `非佔位符的同位置字面仍是 real（實際：${other}）`);
});

testCase('C3', '測試檔／fixtures 目錄裡的合成路徑 → fixture（必須保持原樣）', () => {
  const inTest = classifyMention('references/r1.md', 'plugins/loops-workflow/scripts/test-skill-lint.mjs');
  assert(inTest === 'fixture', `scripts/test-*.mjs 裡的字面應為 fixture（實際：${inTest}）`);
  const inHookTest = classifyMention('references/other-file.md', 'plugins/loops-workflow/hooks/test-read-accumulator.mjs');
  assert(inHookTest === 'fixture', `hooks/test-*.mjs 裡的字面應為 fixture（實際：${inHookTest}）`);
  const inFixtureDir = classifyMention('references/auto-mode.md', 'plugins/loops-workflow/scripts/fixtures/safe-stop-assertion/x.md');
  assert(inFixtureDir === 'fixture', `fixtures/ 目錄裡的字面應為 fixture（實際：${inFixtureDir}）`);
  const inRealDoc = classifyMention('references/journaling.md', 'plugins/loops-workflow/skills/build/SKILL.md');
  assert(inRealDoc === 'real', `同一個檔名在非測試檔裡仍是 real（實際：${inRealDoc}）——fixture 是依 referrer 判、不是依檔名判`);
});

testCase('C4', 'skill 自己子目錄下有這份檔 → skill-local；沒有才算指向 plugin 層', () => {
  const referrer = 'plugins/loops-workflow/skills/plan/SKILL.md';
  const local = classifyMention('references/plan-comment-template.md', referrer, {
    skillLocalExists: (rel) => rel === 'plugins/loops-workflow/skills/plan/references/plan-comment-template.md',
  });
  assert(local === 'skill-local', `skill 自己有這份檔 → skill-local（實際：${local}）`);
  const notLocal = classifyMention('references/clean-code.md', referrer, { skillLocalExists: () => false });
  assert(notLocal === 'real', `skill 自己沒有這份檔 → 指向 plugin 層，算 real（實際：${notLocal}）`);
  const outsideSkill = classifyMention('references/plan-comment-template.md', 'AGENTS.md', { skillLocalExists: () => true });
  assert(outsideSkill === 'real', `referrer 不在 skills/ 底下就不可能是 skill-local（實際：${outsideSkill}）`);
});

testCase('C5', 'buildEntries：邏輯鍵是 (referrer, target, ordinal)，同一對重複引用 ordinal 遞增', () => {
  const fileMap = { 'a/SKILL.md': '看 references/alpha.md 與 references/beta.md，再看 references/alpha.md' };
  const { entries } = buildEntries(fileMap, {
    componentIdOf: () => 'a-skill',
    targetIdOf: (lit) => (lit.includes('alpha') ? 'ref-alpha' : 'ref-beta'),
    existingPathOf: (id) => (id === 'ref-alpha' ? 'x/references/alpha.md' : 'x/references/beta.md'),
    normalizedHashOf: () => 'deadbeef',
    skillLocalExists: () => false,
  });
  const alpha = entries.filter((e) => e.target_component_id === 'ref-alpha');
  assert(alpha.length === 2 && alpha[0].ordinal === 0 && alpha[1].ordinal === 1, `同一對的兩處引用 ordinal 應為 0/1（實際：${JSON.stringify(alpha.map((e) => e.ordinal))}）`);
  assert(entryKey(alpha[1]) === 'a-skill→ref-alpha#1', `邏輯鍵字串應為 referrer→target#ordinal（實際：${entryKey(alpha[1])}）`);
  assert(entries.every((e) => e.class === 'real' && e.normalized_sha256 === 'deadbeef'), '三處都應是 real 且帶目標內容雜湊');
});

testCase('C6', 'buildEntries：real 引用對不到 referrer/target/實際落點時各自有 P1', () => {
  const base = {
    componentIdOf: () => 'a-skill',
    targetIdOf: () => 'ref-alpha',
    existingPathOf: () => 'x/references/shared/runtime/alpha.md',
    normalizedHashOf: () => 'h',
    skillLocalExists: () => false,
  };
  const stale = buildEntries({ 'a/SKILL.md': '見 references/alpha.md' }, base);
  assert(stale.findings.some((f) => f.check === 'stale-ref' && f.key === 'a-skill→ref-alpha#0'), `字面與實際落點不符要出 stale-ref 並指名邏輯鍵（實際：${JSON.stringify(stale.findings)}）`);

  const unmapped = buildEntries({ 'a/SKILL.md': '見 references/alpha.md' }, { ...base, componentIdOf: () => null });
  assert(unmapped.findings.some((f) => f.check === 'unmapped-referrer'), `referrer 不在 registry 要出 unmapped-referrer（實際：${JSON.stringify(unmapped.findings)}）`);

  const unresolved = buildEntries({ 'a/SKILL.md': '見 references/alpha.md' }, { ...base, targetIdOf: () => null });
  assert(unresolved.findings.some((f) => f.check === 'unresolved-target'), `字面對不到元件要出 unresolved-target（實際：${JSON.stringify(unresolved.findings)}）`);

  const fixture = buildEntries({ 'plugins/loops-workflow/scripts/test-x.mjs': '見 references/alpha.md' }, base);
  assert(fixture.findings.length === 0, `fixture 類不進比對、也不該出 finding（實際：${JSON.stringify(fixture.findings)}）`);
});

testCase('C7', 'normalized_sha256 遮罩掉 references 字面：只改引用路徑 → 雜湊不變；改正文 → 雜湊變', () => {
  const before = '# 標題\n見 references/beta.md 的規則。\n';
  const afterMove = '# 標題\n見 references/personas/beta.md 的規則。\n';
  const afterEdit = '# 標題\n見 references/beta.md 的規則（新增一句）。\n';
  assert(normalizedSha256(before) === normalizedSha256(afterMove), '只改引用字面 → 遮罩後雜湊必須相同（否則正確搬遷也會整批紅）');
  assert(normalizedSha256(before) !== normalizedSha256(afterEdit), '正文被改 → 雜湊必須不同（遮罩不得寬到吃掉真實內容變更）');
  assert(!/\.md$/.test(maskReferenceLiterals('references/beta.md').trim()), '遮罩 token 不得再長得像一處引用');
});

// ══════════════════════════════════════════════════════════════════════════
// S 組：對真實 repo 的掃描與基準比對
// ══════════════════════════════════════════════════════════════════════════
testCase('S1', '真實 repo：掃描全綠，五類分布加總＝條目總數', () => {
  const result = buildReport(REPO_ROOT, { mode: 'scan' });
  const { byClass, entriesScanned } = result.summary;
  const sum = Object.values(byClass).reduce((a, b) => a + b, 0);
  assert(sum === entriesScanned, `五類加總要等於條目總數（${sum} vs ${entriesScanned}）`);
  assert(Object.keys(byClass).length === 5, `分類必須恰為五類（實際：${Object.keys(byClass).join(',')}）`);
  assert(byClass.real > 0 && byClass.fixture > 0 && byClass.placeholder > 0 && byClass.glob > 0 && byClass['skill-local'] > 0, `五類在真實 repo 都要有實例（實際：${JSON.stringify(byClass)}）`);
  assert(result.ok === true, `真實 repo 掃描不該有 finding（實際：${JSON.stringify(result.findings)}）`);
  assert(entriesScanned === scanLiterals(Object.values(walk(REPO_ROOT)).join('\n')).length, '條目數要等於掃描面上字面出現次數（工具當場算，不看文件宣稱的數字）');
});

testCase('S2', '真實 repo：已提交的基準快照存在、schema 正確，且 --compare 為綠', () => {
  const snapshot = JSON.parse(readFileSync(join(REPO_ROOT, BASELINE_REL), 'utf8'));
  assert(snapshot.schema_version === SNAPSHOT_SCHEMA_VERSION, `快照 schema_version 應為 ${SNAPSHOT_SCHEMA_VERSION}（實際：${snapshot.schema_version}）`);
  assert(/^[0-9a-f]{40}$/.test(snapshot.baseline_commit ?? ''), `快照要帶產出時的 commit sha（實際：${snapshot.baseline_commit}）`);
  const fields = Object.keys(snapshot.entries[0] ?? {}).sort().join(',');
  assert(fields === 'class,normalized_sha256,ordinal,referrer_component_id,target_component_id', `條目欄位固定五欄（實際：${fields}）`);

  const res = spawnSync('node', [SCRIPT, '--compare', '--json'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const json = JSON.parse(res.stdout);
  assert(res.status === 0, `--compare 對已產出的基準應 exit 0（實際 ${res.status}：${res.stdout.slice(0, 400)}）`);
  assert(json.ok === true && json.mode === 'compare', `--json 應回 ok/mode 契約（實際：${JSON.stringify(json.summary)}）`);
  assert(json.summary.comparedEntries === snapshot.entries.filter((e) => e.class === 'real').length, `比對條數應等於快照裡的 real 條數（實際：${json.summary.comparedEntries}）`);
  assert(typeof formatSummary(json) === 'string' && formatSummary(json).includes('✓'), '人讀摘要在全綠時要有 ✓');
});

// ══════════════════════════════════════════════════════════════════════════
// M 組：合成樹上的完整搬遷情境（正向 ＋ 兩條負向 fixture）
// ══════════════════════════════════════════════════════════════════════════
testCase('M1', '合成樹：五類都掃得到，且測試檔裡的合成路徑被分成 fixture', () => {
  withTree((root) => {
    const { entries, findings, byClass } = scanTree(root);
    assert(findings.length === 0, `合成樹掃描應全綠（實際：${JSON.stringify(findings)}）`);
    assert(byClass.real === 4 && byClass.fixture === 2 && byClass.glob === 1 && byClass.placeholder === 1 && byClass['skill-local'] === 1,
      `五類分布應為 real4/fixture2/glob1/placeholder1/skill-local1（實際：${JSON.stringify(byClass)}）`);
    assert(entries.filter((e) => e.referrer_component_id === 'demo-tests').every((e) => e.class === 'fixture'), '測試檔的引用一律 fixture');
  });
});

testCase('M2', '正確搬遷（檔案搬走＋引用同步改寫）→ 逐條比對全綠', () => {
  withTree((root) => {
    const { snapshot } = buildSnapshot(root, { git: stubGit('aaa') });
    applyMove(root);
    const { entries } = scanTree(root);
    const result = compareToBaseline(snapshot, entries, { mergeBase: 'aaa' });
    assert(result.ok === true, `完全正確的搬遷必須綠（實際：${JSON.stringify(result.findings)}）`);
    assert(result.compared === 4, `應比對到 4 條 real（實際：${result.compared}）`);
    const stillFixture = readFileSync(join(root, 'plugins/loops-workflow/scripts/test-demo.mjs'), 'utf8');
    assert(stillFixture.includes('references/alpha.md'), '測試檔裡的合成路徑保持原樣時不得被判紅');
  });
});

testCase('N1', '負向 fixture 1：搬檔漏改一處引用 → 紅並指名該邏輯鍵', () => {
  withTree((root) => {
    const { snapshot } = buildSnapshot(root, { git: stubGit('aaa') });
    applyMove(root, { skipOneRewrite: true });
    const baselinePath = join(root, 'baseline.json');
    const noBaseline = buildReport(root, { mode: 'compare', baselinePath, git: stubGit('aaa') });
    assert(noBaseline.ok === false && noBaseline.findings.some((f) => f.check === 'baseline-missing'), `基準檔不存在時要紅並說明（實際：${JSON.stringify(noBaseline.findings)}）`);

    writeFileSync(baselinePath, JSON.stringify(snapshot, null, 2), 'utf8');
    const withBaseline = buildReport(root, { mode: 'compare', baselinePath, git: stubGit('aaa') });
    assert(withBaseline.ok === false, `漏改一處引用必須紅（實際：${JSON.stringify(withBaseline.findings)}）`);
    const stale = withBaseline.findings.find((f) => f.check === 'stale-ref');
    assert(stale != null && stale.key === 'demo-skill→ref-alpha#1', `finding 要指名邏輯鍵 demo-skill→ref-alpha#1（實際：${JSON.stringify(withBaseline.findings)}）`);
    assert(stale.detail.includes('references/alpha.md') && stale.detail.includes('shared/runtime/alpha.md'), `detail 要同時給出漏改的字面與實際落點（實際：${stale?.detail}）`);
  });
});

testCase('N2', '負向 fixture 2：用搬檔後的樹重產基準再比對 → 必須紅（拒絕自比）', () => {
  withTree((root) => {
    applyMove(root);
    // 在搬檔後的樹上重產基準：它的 commit 落在分歧點之後
    const { snapshot: regenerated } = buildSnapshot(root, { git: stubGit('bbb') });
    const { entries } = scanTree(root);
    const selfCompare = compareToBaseline(regenerated, entries, { mergeBase: 'aaa' });
    assert(selfCompare.ok === false, '拿搬檔後的樹重產的基準跟自己比，不得綠');
    const mismatch = selfCompare.findings.find((f) => f.check === 'baseline-commit-mismatch');
    assert(mismatch != null, `應命中 baseline-commit-mismatch（實際：${JSON.stringify(selfCompare.findings)}）`);
    assert(mismatch.detail.includes('bbb') && mismatch.detail.includes('aaa'), `拒絕訊息要印出兩個實際 sha（實際：${mismatch.detail}）`);
    assert(selfCompare.compared === 0, '拒絕比對時不得回報「比過了 N 條」');

    // 同一份基準沒有內容變更、只是未提交 → 內容一致性閘記 note 但不誤擋
    const tampered = compareToBaseline(regenerated, entries, { mergeBase: 'bbb', committedBaseline: { ...regenerated, entries: [] } });
    assert(tampered.findings.some((f) => f.check === 'baseline-tampered'), `工作樹快照與該 commit 版本不符時要拒絕（實際：${JSON.stringify(tampered.findings)}）`);
  });
});

testCase('N3', '比對層本身：缺鍵／多鍵／目標內容漂移各自紅並指名邏輯鍵', () => {
  const entry = { referrer_component_id: 'demo-skill', target_component_id: 'ref-alpha', ordinal: 0, class: 'real', normalized_sha256: 'h1' };
  const baseline = { schema_version: SNAPSHOT_SCHEMA_VERSION, baseline_commit: 'aaa', entries: [entry] };

  const missing = compareToBaseline(baseline, [], { mergeBase: 'aaa' });
  assert(missing.findings.some((f) => f.check === 'missing-entry' && f.key === 'demo-skill→ref-alpha#0'), `缺鍵要紅並指名（實際：${JSON.stringify(missing.findings)}）`);

  const extra = compareToBaseline(baseline, [entry, { ...entry, ordinal: 1 }], { mergeBase: 'aaa' });
  assert(extra.findings.some((f) => f.check === 'extra-entry' && f.key === 'demo-skill→ref-alpha#1'), `多鍵要紅並指名（實際：${JSON.stringify(extra.findings)}）`);

  const drift = compareToBaseline(baseline, [{ ...entry, normalized_sha256: 'h2' }], { mergeBase: 'aaa' });
  assert(drift.findings.some((f) => f.check === 'content-drift' && f.key === 'demo-skill→ref-alpha#0'), `目標內容漂移要紅並指名（實際：${JSON.stringify(drift.findings)}）`);

  const nonReal = compareToBaseline(
    { ...baseline, entries: [{ ...entry, class: 'fixture' }] },
    [],
    { mergeBase: 'aaa' },
  );
  assert(nonReal.ok === true && nonReal.compared === 0, `非 real 類不進比對（實際：${JSON.stringify(nonReal.findings)}）`);

  const noMergeBase = compareToBaseline(baseline, [entry], { mergeBase: null });
  assert(noMergeBase.ok === false, '取不到 merge-base 時要 fail closed，不得當作通過');
});

testCase('X1', 'buildContext：referrer 逐字路徑優先於 glob，目標索引同時認舊路徑與 target_path', () => {
  withTree((root) => {
    const ctx = buildContext(root);
    assert(ctx.componentIdOf('plugins/loops-workflow/scripts/test-demo.mjs') === 'demo-tests', '逐字登記的檔案要對到自己的元件');
    assert(ctx.componentIdOf(SKILL_MD_REL) === 'demo-skill', 'glob 登記的目錄成員要對到該 glob 元件');
    assert(ctx.componentIdOf('plugins/loops-workflow/docs/nowhere.md') === null, '沒登記的檔案要回 null（由呼叫端決定怎麼報）');
    assert(ctx.targetIdOf('references/alpha.md') === 'ref-alpha', '搬檔前的字面要對到元件');
    assert(ctx.targetIdOf('references/shared/runtime/alpha.md') === 'ref-alpha', '搬檔後的字面要對到同一個元件（否則逐條比對會退化成整批重寫）');
  });
});

// ══════════════════════════════════════════════════════════════════════════
const opts = parseArgs(process.argv.slice(2));
const selected = cases.filter((c) => c.id.startsWith(opts.filter));

for (const c of selected) {
  console.log(`\n[${c.id}] ${c.name}`);
  c.fn();
}

console.log(`\n${selected.length} cases run, ${passed} passed, ${failed.length} failed`);

if (opts.minCases > 0 && selected.length < opts.minCases) {
  console.error(`\n✗ case 數地板未達成：--min-cases ${opts.minCases}，實際跑到 ${selected.length}（filter="${opts.filter}"）`);
  process.exit(1);
}

if (failed.length > 0) {
  console.error('\n失敗清單：');
  for (const msg of failed) console.error(`  - ${msg}`);
  process.exit(1);
}
process.exit(0);
