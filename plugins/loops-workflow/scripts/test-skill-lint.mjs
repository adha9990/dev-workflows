#!/usr/bin/env node
// test-skill-lint.mjs —— skill-lint.mjs 的紅綠單元 + IO/CLI 整合斷言（自帶極簡 harness，不引測試框架）。
// 用法：node test-skill-lint.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1（主線用此 exit code 判紅綠）。
//
// 預期 Red：skill-lint.mjs 尚未實作，下面的 import 會 ERR_MODULE_NOT_FOUND，
// 整個檔在載入期就丟例外 → node 以非 0 退出。這就是 TDD 的紅燈起點。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  parseDescription,
  footprintCheck,
  wordSet,
  jaccard,
  stripDeepVariantNote,
  stripFrontmatter,
  duplicateCheck,
  deepSyncCheck,
  referenceIntegrityCheck,
  countLintCheck,
  deadCommandCheck,
  formatSummary,
} from './skill-lint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = fileURLToPath(new URL('./skill-lint.mjs', import.meta.url));
// 真實 repo 根（本 worktree），供整合 smoke 測試對真資料跑
const REAL_REPO_ROOT = join(HERE, '..', '..', '..');

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 1. parseDescription
// ══════════════════════════════════════════════════════════════════════════
{
  // 單行 description
  const content = [
    '---',
    'name: sample',
    'description: Sample description text.',
    'user-invocable: true',
    '---',
    '',
    '# Sample',
    '',
  ].join('\n');
  const r = parseDescription(content);
  assert(r && r.name === 'sample', 'parseDescription：單行 frontmatter name 對 [1a]');
  assert(
    r && r.description === 'Sample description text.',
    'parseDescription：單行 description 對 [1a]',
  );
  assert(r && r.userInvocable === true, 'parseDescription：user-invocable:true → userInvocable=true [1a]');
}
{
  // >- 折疊塊（仿 scaffold-fullstack 形狀）：後續縮排行以單一空格拼接
  const content = [
    '---',
    'name: sample-skill',
    'user-invocable: false',
    'description: >-',
    '  Do a thing that spans multiple',
    '  lines and needs to be folded into',
    '  a single space-joined string.',
    '---',
    '',
    '# Sample',
    '',
  ].join('\n');
  const r = parseDescription(content);
  assert(r && r.name === 'sample-skill', 'parseDescription：>- 折疊塊 name 對 [1b]');
  assert(r && r.userInvocable === false, 'parseDescription：user-invocable:false → userInvocable=false [1b]');
  assert(
    r &&
      r.description ===
        'Do a thing that spans multiple lines and needs to be folded into a single space-joined string.',
    'parseDescription：>- 折疊塊 description 以單一空格拼接多行 [1b]',
  );
}
{
  // 無 frontmatter → description=''
  const content = '# Just a heading\n\nNo frontmatter here.\n';
  const r = parseDescription(content);
  assert(r && r.description === '', 'parseDescription：無 frontmatter → description="" [1c]');
}

// ══════════════════════════════════════════════════════════════════════════
// 2. footprintCheck
// ══════════════════════════════════════════════════════════════════════════
{
  // 501 字元 → 紅（footprint P2）
  const items = [{ file: 'agents/long.md', description: 'a'.repeat(501) }];
  const r = footprintCheck(items);
  assert(
    r && Array.isArray(r.findings) && r.findings.length === 1,
    'footprintCheck：501 字元 description → 1 筆 finding [2a]',
  );
  const f = (r && r.findings[0]) || {};
  assert(f.check === 'footprint', 'footprintCheck：finding.check==="footprint" [2a]');
  assert(f.severity === 'P2', 'footprintCheck：finding.severity==="P2" [2a]');
  assert(f.file === 'agents/long.md', 'footprintCheck：finding.file 對 [2a]');
}
{
  // 500 字元 → 綠（不觸發）
  const items = [{ file: 'agents/ok.md', description: 'a'.repeat(500) }];
  const r = footprintCheck(items);
  assert(
    r && Array.isArray(r.findings) && r.findings.length === 0,
    'footprintCheck：500 字元 description → 無 finding [2b]',
  );
}
{
  // summary 加總正確：500+501=1001 字元；ASCII → bytes=chars；estTokens=ceil(1001/4)=251
  const items = [
    { file: 'a.md', description: 'a'.repeat(500) },
    { file: 'b.md', description: 'b'.repeat(501) },
  ];
  const r = footprintCheck(items);
  assert(
    r && r.summary && r.summary.totalChars === 1001,
    'footprintCheck：summary.totalChars=1001（500+501）[2c]',
  );
  assert(
    r && r.summary && r.summary.estTokens === 251,
    'footprintCheck：summary.estTokens=ceil(1001/4)=251 [2c]',
  );
}
{
  // GUARD-5：500 個 astral 字元（'😀'.repeat(500)）→ 以 code point 計數不超標
  // '😀' 是代理對（surrogate pair），JS .length===2；.length 天真計數會誤判為 1000（超標紅）。
  // 正確行為：以 Unicode code point 計數 → 500，不超過 500 上限門檻 → 綠。
  const emoji = '😀'.repeat(500);
  assert(emoji.length === 1000, '前提：\'😀\'.repeat(500).length===1000（surrogate pair，非 code point 數）[GUARD-5-pre]');
  const items = [{ file: 'agents/emoji.md', description: emoji }];
  const r = footprintCheck(items);
  assert(
    r && Array.isArray(r.findings) && r.findings.length === 0,
    'footprintCheck：500 個 astral code point description 不誤判超標（以 code point 計數，非 .length）[GUARD-5]',
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 3. wordSet / jaccard
// ══════════════════════════════════════════════════════════════════════════
{
  const s = wordSet('Hello, World! I am a Tester.');
  assert(s instanceof Set, 'wordSet：回傳 Set [3a]');
  assert(s.size === 4, 'wordSet：長度<2 的 token（i/a）被濾掉，剩 4 個 [3a]');
  assert(
    s.has('hello') && s.has('world') && s.has('am') && s.has('tester'),
    'wordSet：小寫化 + 去標點，含 hello/world/am/tester [3a]',
  );
  assert(!s.has('i') && !s.has('a'), 'wordSet：單字元 token（i/a）被排除 [3a]');
}
{
  const s = wordSet('Hello, World! I am a Tester.');
  assert(jaccard(s, s) === 1, 'jaccard：同集合自比 → 1 [3b]');
}
{
  const a = wordSet('apple banana cherry');
  const b = wordSet('zulu yankee xray');
  assert(jaccard(a, b) === 0, 'jaccard：無交集 → 0 [3c]');
}
{
  assert(jaccard(new Set(), new Set()) === 1, 'jaccard：雙空集 → 1 [3d]');
}

// ══════════════════════════════════════════════════════════════════════════
// 4. stripDeepVariantNote
// ══════════════════════════════════════════════════════════════════════════
const NOTE_LINE =
  '> **此檔是 `architecture-reviewer.md` 的高風險 opus·high 變體（審查內容逐字複製 base）；base 若改審查行為，本檔須一併同步。**';
{
  const body = `${NOTE_LINE}\n\n審查內容主體文字，不需變動。\n`;
  const stripped = stripDeepVariantNote(body);
  assert(
    typeof stripped === 'string' && !stripped.includes('此檔是'),
    'stripDeepVariantNote：剝除整句 blockquote，不含「此檔是」[4a]',
  );
  assert(
    typeof stripped === 'string' && !stripped.includes('opus·high'),
    'stripDeepVariantNote：剝除整句 blockquote，不含「opus·high」[4a]',
  );
  assert(
    typeof stripped === 'string' && stripped.includes('審查內容主體文字'),
    'stripDeepVariantNote：剝除後保留其餘本文 [4a]',
  );
}
{
  const body = '審查內容主體文字，不需變動。\n';
  const stripped = stripDeepVariantNote(body);
  assert(stripped === body, 'stripDeepVariantNote：無變體句 → 原樣返回 [4b]');
}

// ══════════════════════════════════════════════════════════════════════════
// 4b（GUARD F-B）：stripFrontmatter → stripDeepVariantNote 整合（真實 deep 檔同形：
// frontmatter 後有空行，慣例句前導 "\n" 使天真的 ^> 錨定失效）
// ══════════════════════════════════════════════════════════════════════════
{
  const BODY_TEXT = '審查內容主體文字，不需變動。';
  const fullDeepFile = [
    '---',
    'name: x-deep',
    'model: opus',
    '---',
    '',
    NOTE_LINE,
    '',
    BODY_TEXT,
    '',
  ].join('\n');
  const bodyAfterFrontmatter = stripFrontmatter(fullDeepFile);
  assert(
    typeof bodyAfterFrontmatter === 'string' && bodyAfterFrontmatter.includes(NOTE_LINE),
    '前提：stripFrontmatter 後 body 仍含慣例句原文（尚未剝句）[F-B-pre]',
  );
  const stripped = stripDeepVariantNote(bodyAfterFrontmatter);
  assert(
    typeof stripped === 'string' && !stripped.includes('此檔是'),
    'stripFrontmatter→stripDeepVariantNote 整合：即使 frontmatter 後有前導空行，慣例句仍被剝除（不含「此檔是」）[F-B]',
  );
  assert(
    typeof stripped === 'string' && stripped.includes(BODY_TEXT),
    'stripFrontmatter→stripDeepVariantNote 整合：剝句後保留其餘本文 [F-B]',
  );
}
{
  // F-B deepSync 整合：兩份「帶 frontmatter 的完整檔案」（deep=base+慣例句）經真實管線 → 無 finding
  const BODY_TEXT = '審查基準涵蓋架構分層依賴規則與設計模式對症判斷落點是否合理。';
  const baseFull = ['---', 'name: architecture-reviewer', 'model: sonnet', '---', '', BODY_TEXT, ''].join('\n');
  const deepFull = [
    '---',
    'name: architecture-reviewer-deep',
    'model: opus',
    '---',
    '',
    NOTE_LINE,
    '',
    BODY_TEXT,
    '',
  ].join('\n');
  const baseBody = stripFrontmatter(baseFull);
  const deepBody = stripFrontmatter(deepFull);

  // 自我驗證前提：未剝句直接比較 raw jaccard < 0.9（證明管線確實需要剝句）
  const rawJ = jaccard(wordSet(baseBody), wordSet(deepBody));
  assert(rawJ < 0.9, `前提：frontmatter 完整檔管線下 raw jaccard=${rawJ} < 0.9 [F-B2-pre]`);

  const findings = deepSyncCheck([
    {
      baseFile: 'architecture-reviewer.md',
      baseBody,
      deepFile: 'architecture-reviewer-deep.md',
      deepBody,
    },
  ]);
  assert(
    Array.isArray(findings) && findings.length === 0,
    '完整檔案（含 frontmatter）經 stripFrontmatter+deepSyncCheck 真實管線 → 剝句後高相似 → 無 finding [F-B2]',
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 5. duplicateCheck
// ══════════════════════════════════════════════════════════════════════════
{
  // 兩份近逐字（此處刻意用完全相同內容以確保 jaccard≥0.9，不依賴 tokenizer 細節）
  // 且非 base⇄deep 命名對 → 紅
  const body =
    '本審查涵蓋架構分層、依賴規則、命名一致性、錯誤處理與測試覆蓋率，逐項檢查程式碼品質與可維護性指標。';
  const agents = [
    { file: 'code-quality-reviewer.md', body },
    { file: 'docs-devex-reviewer.md', body },
  ];
  const findings = duplicateCheck(agents, 0.9);
  assert(
    Array.isArray(findings) && findings.length === 1,
    'duplicateCheck：兩份非 deep 對逐字相同 → 1 筆 finding [5a]',
  );
  const f = (findings && findings[0]) || {};
  assert(f.check === 'duplicate', 'duplicateCheck：finding.check==="duplicate" [5a]');
  assert(f.severity === 'P3', 'duplicateCheck：finding.severity==="P3" [5a]');
}
{
  // deep 命名對（X.md / X-deep.md）近逐字 → 不由 duplicateCheck 報（歸 deepSyncCheck 管）
  const body = '本審查涵蓋架構分層、依賴規則、契約同步、降級路徑與假警報清單維護。';
  const agents = [
    { file: 'architecture-reviewer.md', body },
    { file: 'architecture-reviewer-deep.md', body },
  ];
  const findings = duplicateCheck(agents, 0.9);
  assert(
    Array.isArray(findings) && findings.length === 0,
    'duplicateCheck：base⇄deep 命名對即使逐字相同也不報（歸 deepSyncCheck）[5b]',
  );
}
{
  // 低相似 → 綠
  const agents = [
    { file: 'a.md', body: 'alpha beta gamma delta epsilon' },
    { file: 'b.md', body: 'zulu yankee xray whiskey victor' },
  ];
  const findings = duplicateCheck(agents, 0.9);
  assert(Array.isArray(findings) && findings.length === 0, 'duplicateCheck：低相似 → 無 finding [5c]');
}

// ══════════════════════════════════════════════════════════════════════════
// 6. deepSyncCheck（先各自 stripDeepVariantNote 再 jaccard）
// ══════════════════════════════════════════════════════════════════════════
{
  // 設計審查 M4 情境：deep = base + 慣例句（模擬 raw 相似度 0.80–0.84）→ 剝句後 ≈1 → 綠
  const BASE_BODY = '審查基準涵蓋架構分層依賴規則與設計模式對症判斷落點是否合理。';
  const deepGreen = `${NOTE_LINE}\n\n${BASE_BODY}`;

  // 自我驗證前提：不剝句直接比較，raw jaccard 明顯 <0.9（證明「先剝再比」確有其必要）
  const rawJ = jaccard(wordSet(BASE_BODY), wordSet(deepGreen));
  assert(
    rawJ < 0.9,
    `前提：deep(未剝句) vs base 的 raw jaccard=${rawJ} < 0.9（模擬 M4 0.80–0.84 情境）[6a-pre]`,
  );

  const pairs = [
    {
      baseFile: 'architecture-reviewer.md',
      baseBody: BASE_BODY,
      deepFile: 'architecture-reviewer-deep.md',
      deepBody: deepGreen,
    },
  ];
  const findings = deepSyncCheck(pairs);
  assert(
    Array.isArray(findings) && findings.length === 0,
    'deepSyncCheck：deep=base+慣例句 → 剝句後高相似 → 綠（無 P1）[6a]',
  );
}
{
  // 審查段真的分叉（剝句後仍差很多）→ 紅 P1
  const BASE_BODY = '審查基準涵蓋架構分層依賴規則與設計模式對症判斷落點是否合理。';
  const DIVERGED_BODY = '這裡是完全不同主題的內容，討論的是資料庫遷移腳本與回滾流程。';
  const deepRed = `${NOTE_LINE}\n\n${DIVERGED_BODY}`;

  // 自我驗證前提：剝句後仍 <0.9（證明分叉本身才是紅燈原因，不是慣例句造成）
  const strippedJ = jaccard(wordSet(BASE_BODY), wordSet(stripDeepVariantNote(deepRed)));
  assert(strippedJ < 0.9, `前提：剝句後 base vs deep 仍 <0.9（jaccard=${strippedJ}）[6b-pre]`);

  const pairs = [
    {
      baseFile: 'architecture-reviewer.md',
      baseBody: BASE_BODY,
      deepFile: 'architecture-reviewer-deep.md',
      deepBody: deepRed,
    },
  ];
  const findings = deepSyncCheck(pairs);
  assert(
    Array.isArray(findings) && findings.length === 1,
    'deepSyncCheck：剝句後仍分叉 → 1 筆 finding [6b]',
  );
  const f = (findings && findings[0]) || {};
  assert(f.check === 'deep-sync', 'deepSyncCheck：finding.check==="deep-sync" [6b]');
  assert(f.severity === 'P1', 'deepSyncCheck：finding.severity==="P1" [6b]');
}

// ══════════════════════════════════════════════════════════════════════════
// 7. referenceIntegrityCheck
// ══════════════════════════════════════════════════════════════════════════
{
  // 斷鏈：引用檔不在 map → broken-ref P1
  const map = {
    'plugins/loops-workflow/agents/a2.md': '詳見 references/missing-target.md 的說明。',
  };
  const findings = referenceIntegrityCheck(map);
  const f = (findings || []).find((x) => x.check === 'broken-ref');
  assert(!!f, 'referenceIntegrityCheck：引用的檔不存在 → broken-ref finding [7a]');
  assert(f && f.severity === 'P1', 'referenceIntegrityCheck：broken-ref severity===P1 [7a]');
  assert(
    f && JSON.stringify(f).includes('missing-target.md'),
    'referenceIntegrityCheck：broken-ref 內容含缺失的目標檔名 [7a]',
  );
}
{
  // 孤兒：plugin references/*.md 無任何 referrer → orphan-ref P2
  const map = {
    'plugins/loops-workflow/references/orphan-target.md': '# Orphan\n沒有人引用這份檔案。\n',
  };
  const findings = referenceIntegrityCheck(map);
  const f = (findings || []).find((x) => x.check === 'orphan-ref');
  assert(!!f, 'referenceIntegrityCheck：references/*.md 無 referrer → orphan-ref finding [7b]');
  assert(f && f.severity === 'P2', 'referenceIntegrityCheck：orphan-ref severity===P2 [7b]');
  assert(
    f && JSON.stringify(f).includes('orphan-target.md'),
    'referenceIntegrityCheck：orphan-ref 內容含該檔名 [7b]',
  );
}
{
  // 委派鏈綠：A 只被 references/B.md 引用 → 非孤兒（referrer 集合含 references→references）
  const map = {
    'plugins/loops-workflow/references/hub.md': '細節見 references/leaf.md。',
    'plugins/loops-workflow/references/leaf.md': '# Leaf\n葉節點內容。\n',
  };
  const findings = referenceIntegrityCheck(map);
  const orphanedLeaf = (findings || []).some(
    (x) => x.check === 'orphan-ref' && JSON.stringify(x).includes('leaf.md'),
  );
  assert(!orphanedLeaf, 'referenceIntegrityCheck：ref→ref 委派鏈 → leaf.md 非孤兒 [7c]');
}
{
  // glob 綠：字面 references/*.md 不算引用，也不誤判斷鏈
  const map = {
    'plugins/loops-workflow/docs/glob-doc.md': '規則樣式：references/*.md 代表所有 reference 檔案。',
  };
  const findings = referenceIntegrityCheck(map);
  const falseHit = (findings || []).some((x) => JSON.stringify(x).includes('references/*.md'));
  assert(!falseHit, 'referenceIntegrityCheck：字面 glob "references/*.md" 不誤判為引用 [7d]');
}
{
  // skill-local 綠：skills/plan/references/x.md 形狀的引用不查 plugin references/
  const map = {
    'plugins/loops-workflow/skills/plan/SKILL.md': '模板見 skills/plan/references/plan-comment-template.md。',
  };
  const findings = referenceIntegrityCheck(map);
  const falseBroken = (findings || []).some(
    (x) => x.check === 'broken-ref' && JSON.stringify(x).includes('plan-comment-template.md'),
  );
  assert(!falseBroken, 'referenceIntegrityCheck：skill-local references/ 形狀不查 plugin references/ [7e]');
}
{
  // allowlist：.loops/00-goal.md、目標專案模板 docs/architecture.md、<rubric.md> 佔位符 → 皆不誤報
  const map = {
    'plugins/loops-workflow/docs/allowlist-doc.md':
      '參考 .loops/00-goal.md 取得目標描述；範本輸出 docs/architecture.md；審查基準見 <rubric.md>。',
  };
  const findings = referenceIntegrityCheck(map);
  const brokenAny = (findings || []).filter((x) => x.check === 'broken-ref');
  assert(
    brokenAny.length === 0,
    `referenceIntegrityCheck：allowlist token（.loops/00-goal.md／docs/architecture.md／<rubric.md>）不誤報 broken-ref [7f]（實際：${JSON.stringify(brokenAny)}）`,
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 8. countLintCheck
// ══════════════════════════════════════════════════════════════════════════
{
  // 後綴錯數 → 紅
  const map = { 'docs/x.md': '目前共有 51 份 reference，涵蓋所有情境。' };
  const r = countLintCheck(map, { reference: 50, skill: 12, hook: 9 });
  const f = (r.findings || []).find((x) => x.check === 'count-drift');
  assert(!!f, 'countLintCheck：後綴「51 份 reference」對 actual=50 → count-drift finding [8a]');
  assert(f && f.severity === 'P1', 'countLintCheck：count-drift severity===P1 [8a]');
}
{
  // 前綴表格形錯數（M3）：「**hook** 8 個」 vs actual hook=9 → 紅
  const map = { 'docs/y.md': '**hook** 8 個\n' };
  const r = countLintCheck(map, { reference: 50, skill: 12, hook: 9 });
  const f = (r.findings || []).find((x) => x.check === 'count-drift' && JSON.stringify(x).includes('hook'));
  assert(!!f, 'countLintCheck：前綴表格「**hook** 8 個」對 actual=9 → count-drift finding [8b/M3]');
}
{
  // 正確數 → 綠
  const map = { 'docs/z.md': '目前共 51 份 reference、12 個 skill、9 個 hook，皆已核實。' };
  const r = countLintCheck(map, { reference: 51, skill: 12, hook: 9 });
  assert(
    Array.isArray(r.findings) && r.findings.length === 0,
    'countLintCheck：數字與 actualCounts 一致 → 無 finding [8c]',
  );
}
{
  // 「當時快照」行 → 跳過，即使數字錯
  const map = { 'docs/hist.md': '（當時快照）99 份 reference，僅供歷史參考。' };
  const r = countLintCheck(map, { reference: 2, skill: 1, hook: 1 });
  assert(
    Array.isArray(r.findings) && r.findings.length === 0,
    'countLintCheck：含「當時快照」的行即使數字錯也不觸發 [8d]',
  );
}
{
  // 「10 條件式」不誤中計數詞（條 緊接 件 不算計數詞），同行合法計數仍正常判定
  const map = { 'docs/cond.md': '共 10 條件式，另有 50 份 reference。' };
  const r = countLintCheck(map, { reference: 50, skill: 1, hook: 1 });
  assert(
    Array.isArray(r.findings) && r.findings.length === 0,
    'countLintCheck：「10 條件式」不誤判為計數詞，且同行合法計數（50 份 reference）判定正確 → 無 finding [8e]',
  );
}
{
  // agent 錯數 → 只進 notes，不進 findings（強制鍵限 reference/skill/hook）
  const map = { 'docs/agent.md': '目前有 12 個 agent。' };
  const r = countLintCheck(map, { reference: 1, skill: 1, hook: 1, agent: 11 });
  assert(
    Array.isArray(r.findings) && r.findings.length === 0,
    'countLintCheck：agent 鍵不在強制三鍵內 → 不進 findings [8f]',
  );
  const notesStr = JSON.stringify(r.notes || []);
  assert(notesStr.includes('agent'), 'countLintCheck：agent 誤差仍記錄進 notes [8f]');
}

// ══════════════════════════════════════════════════════════════════════════
// 9. deadCommandCheck
// ══════════════════════════════════════════════════════════════════════════
{
  const map = { 'plugins/loops-workflow/docs/old.md': '請改用 loops-workflow:loop 繼續。' };
  const findings = deadCommandCheck(map);
  const f = (findings || []).find((x) => x.check === 'dead-command');
  assert(!!f, 'deadCommandCheck：.md 含死指令 token → finding [9a]');
  assert(f && f.severity === 'P1', 'deadCommandCheck：severity===P1 [9a]');
}
{
  const map = { 'plugins/loops-workflow/scripts/old.mjs': "// TODO: use loops-workflow:resume instead\n" };
  const findings = deadCommandCheck(map);
  const f = (findings || []).find((x) => x.check === 'dead-command');
  assert(!!f, 'deadCommandCheck：.mjs 含死指令 token → finding [9b]');
}
{
  const map = { 'plugins/loops-workflow/docs/clean.md': '這裡完全沒有提到任何舊指令名稱。\n' };
  const findings = deadCommandCheck(map);
  assert(Array.isArray(findings) && findings.length === 0, 'deadCommandCheck：乾淨內容 → 無 finding [9c]');
}
{
  // GUARD-4：loops-workflow:status token → 紅（mutation 實證現有 fixture 殺不死漏這個 token 的 mutant）
  const map = { 'plugins/loops-workflow/docs/status-old.md': '請改用 loops-workflow:status 查看進度。' };
  const findings = deadCommandCheck(map);
  const f = (findings || []).find((x) => x.check === 'dead-command');
  assert(!!f, 'deadCommandCheck：含 "loops-workflow:status" token → finding [GUARD-4a]');
}
{
  // GUARD-4：loops-workflow:progress token → 紅
  const map = { 'plugins/loops-workflow/docs/progress-old.md': '請改用 loops-workflow:progress 查看進度。' };
  const findings = deadCommandCheck(map);
  const f = (findings || []).find((x) => x.check === 'dead-command');
  assert(!!f, 'deadCommandCheck：含 "loops-workflow:progress" token → finding [GUARD-4b]');
}
{
  // GUARD-6：大小寫不敏感 —— "Loops-Workflow:resume"（混合大小寫）仍應命中
  const map = { 'plugins/loops-workflow/docs/mixed-case.md': '舊用法：Loops-Workflow:resume 已停用。' };
  const findings = deadCommandCheck(map);
  const f = (findings || []).find((x) => x.check === 'dead-command');
  assert(!!f, 'deadCommandCheck：大小寫混合 "Loops-Workflow:resume" 仍命中（lowercase 比對）[GUARD-6]');
}

// ══════════════════════════════════════════════════════════════════════════
// 10. formatSummary（純函式部分）
// ══════════════════════════════════════════════════════════════════════════
{
  const green = { ok: true, findings: [], notes: [], summary: { filesScanned: 7, totalChars: 100, estTokens: 25 } };
  const s = formatSummary(green);
  assert(typeof s === 'string' && s.trim().split('\n').length === 1, 'formatSummary：全綠回單行 [10a]');
  assert(typeof s === 'string' && s.includes('✓'), 'formatSummary：全綠含 ✓ [10a]');
  assert(typeof s === 'string' && s.includes('7'), 'formatSummary：全綠含檔數 7 [10a]');
}
{
  const red = {
    ok: false,
    findings: [
      { check: 'footprint', severity: 'P2', file: 'a.md', detail: '523 chars' },
      { check: 'broken-ref', severity: 'P1', file: 'b.md', detail: 'refs missing.md' },
    ],
    notes: [],
    summary: { filesScanned: 7, totalChars: 100, estTokens: 25 },
  };
  const s = formatSummary(red);
  assert(
    typeof s === 'string' && /✗\s*\[footprint\]\s*P2\s*a\.md\s*—\s*523 chars/.test(s),
    'formatSummary：footprint finding 逐條格式 "✗ [check] severity file — detail" [10b]',
  );
  assert(
    typeof s === 'string' && /✗\s*\[broken-ref\]\s*P1\s*b\.md\s*—\s*refs missing\.md/.test(s),
    'formatSummary：broken-ref finding 逐條格式對 [10b]',
  );
}
{
  // GUARD F-A：plain 模式 notes 可見 —— findings 空、notes 非空時，輸出仍含 ✓ 綠行，
  // 且額外含至少一行可辨識的提醒（含該 note 的檔名或 "footprint" 字樣）。
  const result = {
    ok: true,
    findings: [],
    notes: [
      {
        file: 'plugins/loops-workflow/skills/scaffold-fullstack/SKILL.md',
        message: 'footprint: description 接近 500 字元上限',
      },
    ],
    summary: { filesScanned: 3, totalChars: 100, estTokens: 25 },
  };
  const s = formatSummary(result);
  const lines = typeof s === 'string' ? s.split('\n').filter(Boolean) : [];
  assert(lines.some((l) => l.includes('✓')), 'formatSummary：findings 空、notes 非空 → 仍含 ✓ 綠行 [F-A]');
  assert(
    lines.length >= 2,
    'formatSummary：notes 非空時輸出不只一行（額外含提醒行）[F-A]',
  );
  assert(
    lines.some((l) => l.includes('scaffold-fullstack') || l.includes('footprint')),
    'formatSummary：提醒行含 note 檔名（scaffold-fullstack）或 "footprint" 字樣 [F-A]',
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 11.（#128）flagSyncCheck / hooksWiringCheck / parseFlagDefaults
// 三個新符號尚未實作：一律動態 await import()＋try-catch，讓本組逐條紅（斷言失敗），
// 不讓整檔在載入期崩潰、不影響上面 1–10 組與後面 IO-1..8 既有測試照常執行。
// 案例編號對映 issue #128 契約：
//   [128-0]=parseFlagDefaults 直測（乾淨 fixture）        [128-1]=settings 漏一旗標→P1
//   [128-2]=歸類錯段（defaultOn 落在預設關段）→P1         [128-3]=header 計數矛盾→P1
//   [128-4]=hooks.json 引用不存在腳本→P1                  [128-5]=multi-name cell 併列三全名→綠
//   [128-6]=FLAG_DEFAULTS 結構改壞「無法解析」→P1          [128-7]=未知 LOOPS_*（拼錯名）→P2 note
//   [128-7b]=allowlist（LOOPS_AUTO 等）不誤報              [128-8]=乾淨 fixture→全綠
//   [128-9]=fixtures／test-*／hook-flags.mjs 路徑不報 P2
// 真 repo 整合煙測（對映契約案例⑩）見後面 IO-9。
// ══════════════════════════════════════════════════════════════════════════
let parseFlagDefaults;
let flagSyncCheck;
let hooksWiringCheck;
let buildReport;
let walk;
try {
  const mod128 = await import('./skill-lint.mjs');
  parseFlagDefaults = mod128.parseFlagDefaults;
  flagSyncCheck = mod128.flagSyncCheck;
  hooksWiringCheck = mod128.hooksWiringCheck;
  buildReport = mod128.buildReport;
  walk = mod128.walk;
} catch (e) {
  console.error(`  ✗ #128 新符號 import 失敗：${e && e.message}`);
}

// fixture 建構 helper —— 皆內嵌字串、抄真實 hook-flags.mjs／settings.md／journaling.md 的形狀
// （headers 含括號後綴、決策表帶 "> " blockquote 前綴，比照 hooks/hook-flags.mjs、docs/settings.md、
// references/journaling.md 原檔）。
function makeHookFlagsContent({ flags, totalClaim, defaultOnClaim, optInClaim }) {
  const onFlags = flags.filter((f) => f.defaultOn);
  const offFlags = flags.filter((f) => !f.defaultOn);
  return [
    '// hook-flags.mjs 測試 fixture —— loops-workflow flag 分類單一真相源。',
    `// 把「${totalClaim} 個 flag」各自屬於 defaultOn 還是 optIn 都收斂到這一處。`,
    'export const FLAG_DEFAULTS = {',
    `  // defaultOn（${defaultOnClaim}）：安全防護類，預設啟用，僅字面 '0' 可關閉。`,
    ...onFlags.map((f) => `  ${f.name}: { defaultOn: true },`),
    `  // optIn（${optInClaim}）：會自動執行命令類，預設關閉，僅字面 '1' 可開啟。`,
    ...offFlags.map((f) => `  ${f.name}: { defaultOn: false },`),
    '};',
    '',
  ].join('\n');
}

function makeSettingsContent({ defaultOnSection, optInSection }) {
  const rows = (names) => names.map((n) => `| \`${n}\` | 說明文字。 |`).join('\n');
  return [
    '# settings.md 測試 fixture',
    '',
    '## 預設開（想關才需要設，值填 `"0"`）',
    '',
    '| 參數 | 幫你做什麼 |',
    '|---|---|',
    rows(defaultOnSection),
    '',
    '## 預設關（想用才需要設，值填 `"1"`）',
    '',
    '| 參數 | 幫你做什麼 |',
    '|---|---|',
    rows(optInSection),
    '',
  ].join('\n');
}

function makeJournalingContent(rows) {
  const tableRows = rows.map((r) => `> | ${r.cell} | ${r.classification} | ${r.reason} |`).join('\n');
  return [
    '# journaling.md 測試 fixture',
    '',
    '> **flag 決策表**：',
    '>',
    '> | flag | 預設 | 一句理由 |',
    '> |---|---|---|',
    tableRows,
    '',
  ].join('\n');
}

const BASELINE_FLAGS = [
  { name: 'LOOPS_ALPHA_GUARD', defaultOn: true },
  { name: 'LOOPS_BETA_TRACKER', defaultOn: true },
  { name: 'LOOPS_GAMMA_GATE', defaultOn: false },
  { name: 'LOOPS_DELTA_HINT', defaultOn: false },
];

function baselineHookFlagsContent() {
  return makeHookFlagsContent({ flags: BASELINE_FLAGS, totalClaim: 4, defaultOnClaim: 2, optInClaim: 2 });
}
function baselineSettingsContent() {
  return makeSettingsContent({
    defaultOnSection: ['LOOPS_ALPHA_GUARD', 'LOOPS_BETA_TRACKER'],
    optInSection: ['LOOPS_GAMMA_GATE', 'LOOPS_DELTA_HINT'],
  });
}
function baselineJournalingContent() {
  return makeJournalingContent([
    { cell: '`LOOPS_ALPHA_GUARD`', classification: '開', reason: '理由 A' },
    { cell: '`LOOPS_BETA_TRACKER`', classification: '開', reason: '理由 B' },
    { cell: '`LOOPS_GAMMA_GATE`', classification: 'opt-in', reason: '理由 C' },
    { cell: '`LOOPS_DELTA_HINT`', classification: 'opt-in', reason: '理由 D' },
  ]);
}

// ── [128-0] parseFlagDefaults：乾淨 fixture → 正確抽出 flags[] 與 headerClaims{} ──────
{
  const parsed = parseFlagDefaults && parseFlagDefaults(baselineHookFlagsContent());
  assert(
    parsed && Array.isArray(parsed.flags) && parsed.flags.length === 4,
    `parseFlagDefaults：乾淨 fixture → flags.length===4（實際：${JSON.stringify(parsed)}）[128-0]`,
  );
  assert(
    parsed &&
      Array.isArray(parsed.flags) &&
      parsed.flags.some((f) => f.name === 'LOOPS_ALPHA_GUARD' && f.defaultOn === true),
    'parseFlagDefaults：flags 含 {name:"LOOPS_ALPHA_GUARD", defaultOn:true} [128-0]',
  );
  assert(
    parsed &&
      Array.isArray(parsed.flags) &&
      parsed.flags.some((f) => f.name === 'LOOPS_GAMMA_GATE' && f.defaultOn === false),
    'parseFlagDefaults：flags 含 {name:"LOOPS_GAMMA_GATE", defaultOn:false} [128-0]',
  );
  assert(
    parsed && parsed.headerClaims && Number(parsed.headerClaims.total) === 4,
    `parseFlagDefaults：headerClaims.total===4（實際：${JSON.stringify(parsed && parsed.headerClaims)}）[128-0]`,
  );
  assert(
    parsed && parsed.headerClaims && Number(parsed.headerClaims.defaultOn) === 2,
    'parseFlagDefaults：headerClaims.defaultOn===2 [128-0]',
  );
  assert(
    parsed && parsed.headerClaims && Number(parsed.headerClaims.optIn) === 2,
    'parseFlagDefaults：headerClaims.optIn===2 [128-0]',
  );
}

// ── [128-1] settings 漏一旗標 → P1 ──────────────────────────────────────────
{
  const settingsContent = makeSettingsContent({
    defaultOnSection: ['LOOPS_ALPHA_GUARD'], // 漏了 LOOPS_BETA_TRACKER
    optInSection: ['LOOPS_GAMMA_GATE', 'LOOPS_DELTA_HINT'],
  });
  const findings = flagSyncCheck && flagSyncCheck({
    hookFlagsContent: baselineHookFlagsContent(),
    settingsContent,
    journalingContent: baselineJournalingContent(),
  });
  const f = (findings || []).find(
    (x) => x.check === 'flag-sync' && x.severity === 'P1' && JSON.stringify(x).includes('LOOPS_BETA_TRACKER'),
  );
  assert(
    !!f,
    `flagSyncCheck：settings.md 漏列 LOOPS_BETA_TRACKER → P1 finding（實際：${JSON.stringify(findings)}）[128-1]`,
  );
}

// ── [128-2] 歸類錯段（defaultOn 出現在預設關段）→ P1 ─────────────────────────
{
  const settingsContent = makeSettingsContent({
    defaultOnSection: ['LOOPS_ALPHA_GUARD'],
    optInSection: ['LOOPS_GAMMA_GATE', 'LOOPS_DELTA_HINT', 'LOOPS_BETA_TRACKER'], // 錯段
  });
  const findings = flagSyncCheck && flagSyncCheck({
    hookFlagsContent: baselineHookFlagsContent(),
    settingsContent,
    journalingContent: baselineJournalingContent(),
  });
  const f = (findings || []).find(
    (x) => x.check === 'flag-sync' && x.severity === 'P1' && JSON.stringify(x).includes('LOOPS_BETA_TRACKER'),
  );
  assert(
    !!f,
    `flagSyncCheck：defaultOn 旗標 LOOPS_BETA_TRACKER 出現在「預設關」段 → P1 finding（實際：${JSON.stringify(findings)}）[128-2]`,
  );
}

// ── [128-3] header 計數矛盾 → P1 ────────────────────────────────────────────
{
  // 實際 FLAG_DEFAULTS 仍是 4 個（2+2），但 header 宣稱總數 5 個——單一維度矛盾，
  // settings/journaling 皆與「實際 4 個」保持一致，隔離只讓 header 計數這一件事觸發。
  const hookFlagsContent = makeHookFlagsContent({
    flags: BASELINE_FLAGS,
    totalClaim: 5,
    defaultOnClaim: 2,
    optInClaim: 2,
  });
  const findings = flagSyncCheck && flagSyncCheck({
    hookFlagsContent,
    settingsContent: baselineSettingsContent(),
    journalingContent: baselineJournalingContent(),
  });
  const f = (findings || []).find(
    (x) => x.check === 'flag-sync' && x.severity === 'P1' && JSON.stringify(x).includes('5'),
  );
  assert(
    !!f,
    `flagSyncCheck：header 宣稱「5 個 flag」對實際 4 個 → P1 finding 含數字 5（實際：${JSON.stringify(findings)}）[128-3]`,
  );
}

// ── [128-4] hooks.json 引用不存在腳本 → P1 ──────────────────────────────────
{
  const hooksJsonContent = JSON.stringify(
    {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/real-hook-a.mjs"' },
              { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/ghost-hook.mjs"' },
            ],
          },
        ],
      },
    },
    null,
    2,
  );
  const hookFiles = ['hooks/real-hook-a.mjs']; // ghost-hook.mjs 刻意不在清單內
  const findings = hooksWiringCheck && hooksWiringCheck(hooksJsonContent, hookFiles);
  const f = (findings || []).find(
    (x) => x.check === 'hooks-wiring' && x.severity === 'P1' && JSON.stringify(x).includes('ghost-hook.mjs'),
  );
  assert(
    !!f,
    `hooksWiringCheck：hooks.json 引用不存在的 ghost-hook.mjs → P1 finding（實際：${JSON.stringify(findings)}）[128-4]`,
  );
  assert(
    !(findings || []).some((x) => JSON.stringify(x).includes('real-hook-a.mjs')),
    'hooksWiringCheck：正常掛載的 real-hook-a.mjs 不誤報 [128-4]',
  );
}

// ── [128-5] multi-name cell（`/` 併列三全名、共用「開」）→ 綠 ────────────────
{
  const evalFlags = [
    { name: 'LOOPS_EVAL_ALPHA', defaultOn: true },
    { name: 'LOOPS_EVAL_BETA', defaultOn: true },
    { name: 'LOOPS_EVAL_GAMMA', defaultOn: true },
  ];
  const hookFlagsContent = makeHookFlagsContent({ flags: evalFlags, totalClaim: 3, defaultOnClaim: 3, optInClaim: 0 });
  const settingsContent = makeSettingsContent({
    defaultOnSection: ['LOOPS_EVAL_ALPHA', 'LOOPS_EVAL_BETA', 'LOOPS_EVAL_GAMMA'],
    optInSection: [],
  });
  const journalingContent = makeJournalingContent([
    {
      cell: '`LOOPS_EVAL_ALPHA`/`LOOPS_EVAL_BETA`/`LOOPS_EVAL_GAMMA`',
      classification: '開',
      reason: '三合一評測旗標，仿真實 journaling.md 的 `LOOPS_EVAL_GATE`/`TAGS`/`POLL` 併列寫法',
    },
  ]);
  const findings = flagSyncCheck && flagSyncCheck({ hookFlagsContent, settingsContent, journalingContent });
  assert(
    Array.isArray(findings) && findings.length === 0,
    `flagSyncCheck：journaling multi-name cell 併列三全名、分類與實際一致 → 無 finding（實際：${JSON.stringify(findings)}）[128-5]`,
  );
}

// ── [128-6]「無法解析」（FLAG_DEFAULTS 結構被改壞）→ P1，絕不靜默綠 ─────────
{
  const brokenContent = [
    '// hook-flags.mjs 測試 fixture —— 結構已損壞（模擬 GUARD 情境）。',
    '// FLAG_DEFAULTS object literal 被改壞成非預期形狀，parseFlagDefaults 應回傳可辨識的解析失敗。',
    'export const FLAG_DEFAULTS_RENAMED = "not an object literal any more";',
    '',
  ].join('\n');

  const parsed = parseFlagDefaults && parseFlagDefaults(brokenContent);
  assert(
    parsed && parsed.error,
    `parseFlagDefaults：FLAG_DEFAULTS 結構抽不到 → 回傳可辨識的 {error}（實際：${JSON.stringify(parsed)}）[128-6]`,
  );

  const findings = flagSyncCheck && flagSyncCheck({
    hookFlagsContent: brokenContent,
    settingsContent: baselineSettingsContent(),
    journalingContent: baselineJournalingContent(),
  });
  const f = (findings || []).find((x) => x.check === 'flag-sync' && x.severity === 'P1');
  assert(
    !!f,
    `flagSyncCheck：hook-flags.mjs 無法解析時上層仍出 P1、不靜默綠（實際：${JSON.stringify(findings)}）[128-6]`,
  );
  assert(
    !!f && /解析|parse|FLAG_DEFAULTS/i.test(JSON.stringify(f)),
    `flagSyncCheck：無法解析的 P1 finding 內容可辨識出是解析失敗（含「解析」/parse/FLAG_DEFAULTS 字樣）（實際：${JSON.stringify(f)}）[128-6]`,
  );
}

// ── [128-7] 未知 LOOPS_*（拼錯名，不在 FLAG_DEFAULTS 也不在 allowlist）→ P2 note ──
{
  const settingsContent = makeSettingsContent({
    defaultOnSection: ['LOOPS_ALPHA_GUARD', 'LOOPS_BETA_TRACKER'],
    // 額外一行拼錯名：LOOPS_ALPHA_GRUAD（非 FLAG_DEFAULTS 亦非 allowlist）
    optInSection: ['LOOPS_GAMMA_GATE', 'LOOPS_DELTA_HINT', 'LOOPS_ALPHA_GRUAD'],
  });
  const findings = flagSyncCheck && flagSyncCheck({
    hookFlagsContent: baselineHookFlagsContent(),
    settingsContent,
    journalingContent: baselineJournalingContent(),
  });
  const p2 = (findings || []).find(
    (x) => x.severity === 'P2' && JSON.stringify(x).includes('LOOPS_ALPHA_GRUAD'),
  );
  assert(
    !!p2,
    `flagSyncCheck：未知 LOOPS_ALPHA_GRUAD（拼錯名）→ P2 finding（實際：${JSON.stringify(findings)}）[128-7]`,
  );
  assert(
    !(findings || []).some((x) => x.severity === 'P1' && JSON.stringify(x).includes('LOOPS_ALPHA_GRUAD')),
    'flagSyncCheck：未知旗標拼錯名不升級為 P1（僅 P2 note）[128-7]',
  );
}

// ── [128-7b] allowlist（LOOPS_AUTO 等）不誤報 ────────────────────────────────
{
  const settingsContent = makeSettingsContent({
    defaultOnSection: ['LOOPS_ALPHA_GUARD', 'LOOPS_BETA_TRACKER'],
    // LOOPS_AUTO 是 allowlist 成員（skill 層 env、非 hook-flags.mjs 管的 flag）
    optInSection: ['LOOPS_GAMMA_GATE', 'LOOPS_DELTA_HINT', 'LOOPS_AUTO'],
  });
  const findings = flagSyncCheck && flagSyncCheck({
    hookFlagsContent: baselineHookFlagsContent(),
    settingsContent,
    journalingContent: baselineJournalingContent(),
  });
  assert(
    !(findings || []).some((x) => JSON.stringify(x).includes('LOOPS_AUTO')),
    `flagSyncCheck：allowlist 成員 LOOPS_AUTO 出現在文件中不誤報（P1 或 P2 皆不應提及）（實際：${JSON.stringify(findings)}）[128-7b]`,
  );
}

// ── [128-8] 乾淨 fixture → 全綠（flagSyncCheck 與 hooksWiringCheck 各自）────
{
  const findings = flagSyncCheck && flagSyncCheck({
    hookFlagsContent: baselineHookFlagsContent(),
    settingsContent: baselineSettingsContent(),
    journalingContent: baselineJournalingContent(),
  });
  assert(
    Array.isArray(findings) && findings.length === 0,
    `flagSyncCheck：乾淨 fixture（4 旗標、settings/journaling 皆一致）→ 無 finding（實際：${JSON.stringify(findings)}）[128-8]`,
  );
}
{
  const hooksJsonContent = JSON.stringify(
    {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/real-hook-a.mjs"' },
              { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/real-hook-b.mjs"' },
            ],
          },
        ],
      },
    },
    null,
    2,
  );
  const hookFiles = ['hooks/real-hook-a.mjs', 'hooks/real-hook-b.mjs'];
  const findings = hooksWiringCheck && hooksWiringCheck(hooksJsonContent, hookFiles);
  assert(
    Array.isArray(findings) && findings.length === 0,
    `hooksWiringCheck：乾淨 fixture（引用 vs 清單完全對齊）→ 無 finding（實際：${JSON.stringify(findings)}）[128-8]`,
  );
}

// ── [128-9] fixtures／test-*／hook-flags.mjs 路徑不報 P2（未掛載排除規則）───
{
  const hooksJsonContent = JSON.stringify(
    {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/real-hook-a.mjs"' }] },
        ],
      },
    },
    null,
    2,
  );
  const hookFiles = [
    'hooks/real-hook-a.mjs', // 掛載，對齊 → 無 finding
    'hooks/real-b-unmounted.mjs', // 控制組：未掛載且非排除路徑 → 應報 P2（證明偵測本身有效）
    'hooks/fixtures/loop-driver/gate-malformed/fake-gate.mjs', // fixtures 段 → 應被排除
    'hooks/test-something.mjs', // test-*.mjs → 應被排除
    'hooks/hook-flags.mjs', // 檔名 hook-flags.mjs → 應被排除
  ];
  const findings = hooksWiringCheck && hooksWiringCheck(hooksJsonContent, hookFiles);
  const controlP2 = (findings || []).find(
    (x) => x.severity === 'P2' && JSON.stringify(x).includes('real-b-unmounted.mjs'),
  );
  assert(
    !!controlP2,
    `hooksWiringCheck：控制組 real-b-unmounted.mjs（未掛載、非排除路徑）→ P2 finding（實際：${JSON.stringify(findings)}）[128-9]`,
  );
  assert(
    !(findings || []).some((x) => JSON.stringify(x).includes('fake-gate.mjs')),
    'hooksWiringCheck：hooks/fixtures/.../fake-gate.mjs 不被報 P2（fixtures 段排除）[128-9]',
  );
  assert(
    !(findings || []).some((x) => JSON.stringify(x).includes('test-something.mjs')),
    'hooksWiringCheck：hooks/test-something.mjs 不被報 P2（test-*.mjs 排除）[128-9]',
  );
  assert(
    !(findings || []).some((x) => JSON.stringify(x).includes('hook-flags.mjs')),
    'hooksWiringCheck：hooks/hook-flags.mjs 不被報 P2（檔名排除）[128-9]',
  );
}

// ══════════════════════════════════════════════════════════════════════════
// IO/CLI 整合（spawnSync 真跑 skill-lint.mjs --root <repo根>）
// ══════════════════════════════════════════════════════════════════════════
function writeFiles(root, filesObj) {
  for (const [rel, content] of Object.entries(filesObj)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
}

function baselineFiles() {
  return {
    'README.md': '# Test Repo\n\n見 references/r1.md 與 references/r2.md。\n',
    'AGENTS.md': '# AGENTS\n\n維護說明。\n',
    'plugins/loops-workflow/skills/foo/SKILL.md':
      '---\nname: foo\ndescription: Foo skill for testing.\nuser-invocable: true\n---\n\n# Foo\n',
    'plugins/loops-workflow/agents/a1.md': '見 references/r1.md 與 references/r2.md 取得細節。\n',
    'plugins/loops-workflow/references/r1.md': '# R1\n內容。\n',
    'plugins/loops-workflow/references/r2.md': '# R2\n內容。\n',
    'plugins/loops-workflow/docs/d1.md': '# D1\n見 references/r1.md。\n',
    'plugins/loops-workflow/hooks/hooks.json':
      JSON.stringify(
        {
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: 'node a.mjs' }] }],
            Stop: [{ hooks: [{ type: 'command', command: 'node b.mjs' }, { type: 'command', command: 'node c.mjs' }] }],
          },
        },
        null,
        2,
      ),
    'plugins/loops-workflow/scripts/dummy.mjs': '// clean placeholder\n',
  };
}

function makeRepo(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'skl-'));
  writeFiles(dir, { ...baselineFiles(), ...extra });
  return dir;
}

function runCli(root, args = ['--json']) {
  const res = spawnSync('node', [SCRIPT, '--root', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  let json = null;
  if (args.includes('--json')) {
    try {
      json = JSON.parse(res.stdout);
    } catch {
      json = null;
    }
  }
  return { res, json };
}

// IO-1：健康 fixture → 綠（exit 0, ok:true, findings:[]），且非 --json 輸出為含 ✓ 的單行
{
  const dir = makeRepo();
  try {
    const { res, json } = runCli(dir, ['--json']);
    assert(res.error == null, 'IO-1：node 啟動成功（spawn 無 error）[IO-1]');
    assert(res.status === 0, 'IO-1：健康 fixture → exit code===0 [IO-1]');
    assert(json && json.ok === true, 'IO-1：--json ok===true [IO-1]');
    assert(json && Array.isArray(json.findings) && json.findings.length === 0, 'IO-1：--json findings===[] [IO-1]');

    const plain = spawnSync('node', [SCRIPT, '--root', dir], { encoding: 'utf8' });
    assert(plain.status === 0, 'IO-1：非 --json 模式 exit code===0 [IO-1]');
    const lines = plain.stdout.trim().split('\n').filter(Boolean);
    assert(lines.length === 1, 'IO-1：非 --json 全綠輸出為單行 [IO-1]');
    assert(lines[0] && lines[0].includes('✓'), 'IO-1：單行輸出含 ✓ [IO-1]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-2：斷鏈 → 紅（exit 1，findings 含 broken-ref）
{
  const dir = makeRepo({
    'plugins/loops-workflow/docs/bad.md': '見 references/does-not-exist.md 的說明。\n',
  });
  try {
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 1, 'IO-2：斷鏈 → exit code===1 [IO-2]');
    assert(
      json &&
        Array.isArray(json.findings) &&
        json.findings.some((f) => f.check === 'broken-ref' && JSON.stringify(f).includes('does-not-exist.md')),
      'IO-2：--json findings 含 broken-ref（does-not-exist.md）[IO-2]',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-3：孤兒 reference → 紅（orphan-ref）
{
  const dir = makeRepo({
    'plugins/loops-workflow/references/orphan2.md': '# Orphan2\n沒有人引用。\n',
  });
  try {
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 1, 'IO-3：孤兒 reference → exit code===1 [IO-3]');
    assert(
      json &&
        Array.isArray(json.findings) &&
        json.findings.some((f) => f.check === 'orphan-ref' && JSON.stringify(f).includes('orphan2.md')),
      'IO-3：--json findings 含 orphan-ref（orphan2.md）[IO-3]',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-4：.loops/.claude/.git/evals 被排除於 walk 之外（放死指令 token 不應被掃到；控制組要能被抓到）
{
  const dir = makeRepo({
    '.loops/dead-note.md': '請改用 loops-workflow:loop 繼續。\n',
    'plugins/loops-workflow/docs/dead-control.md': '請改用 loops-workflow:loop 繼續。\n',
  });
  try {
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 1, 'IO-4：控制組 dead-command → exit code===1 [IO-4]');
    assert(
      json &&
        Array.isArray(json.findings) &&
        json.findings.some((f) => f.check === 'dead-command' && JSON.stringify(f).includes('dead-control.md')),
      'IO-4：控制組（plugin docs 內）dead-command 被抓到 [IO-4]',
    );
    assert(
      json &&
        Array.isArray(json.findings) &&
        !json.findings.some((f) => JSON.stringify(f).includes('dead-note.md')),
      'IO-4：.loops/ 內同樣 token 不被掃到（walk 排除 .loops/）[IO-4]',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-5：deadCommand/countLint 另排除自身兩檔（skill-lint.mjs / test-skill-lint.mjs 形狀）與全部 test-*.mjs（M1/M2）
{
  const dir = makeRepo({
    'plugins/loops-workflow/scripts/skill-lint.mjs': '// contains dead token loops-workflow:resume\n',
    'plugins/loops-workflow/scripts/test-something.mjs': '// contains dead token loops-workflow:resume\n',
    'plugins/loops-workflow/hooks/test-something.mjs': '// contains dead token loops-workflow:resume\n',
    'plugins/loops-workflow/scripts/other.mjs': '// contains dead token loops-workflow:resume\n',
  });
  try {
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 1, 'IO-5：控制組（other.mjs）dead-command → exit code===1 [IO-5/M1/M2]');
    assert(
      json &&
        Array.isArray(json.findings) &&
        json.findings.some((f) => f.check === 'dead-command' && JSON.stringify(f).includes('other.mjs')),
      'IO-5：控制組 other.mjs 的 dead-command 被抓到 [IO-5]',
    );
    const findingsStr = JSON.stringify(json && json.findings);
    assert(
      !findingsStr.includes('scripts/skill-lint.mjs') && !findingsStr.match(/scripts[\\/]skill-lint\.mjs/),
      'IO-5：scripts/skill-lint.mjs（自身）不被 deadCommand 掃到 [IO-5/M1]',
    );
    assert(
      !findingsStr.includes('scripts/test-something.mjs'),
      'IO-5：scripts/test-*.mjs 不被 deadCommand 掃到 [IO-5/M2]',
    );
    assert(
      !findingsStr.includes('hooks/test-something.mjs'),
      'IO-5：hooks/test-*.mjs 不被 deadCommand 掃到 [IO-5/M2]',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-6：docs/ 下任何檔的寫死計數都在 countLint 掃描面內（#95 起無逐檔排除；原 odw-ecc 特例已隨該檔刪除）
{
  const dir = makeRepo({
    'plugins/loops-workflow/docs/count-control.md': '目前有 999 份 reference，顯著偏離事實。\n',
  });
  try {
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 1, 'IO-6：docs/ 檔 count-drift → exit code===1 [IO-6]');
    assert(
      json &&
        Array.isArray(json.findings) &&
        json.findings.some((f) => f.check === 'count-drift' && JSON.stringify(f).includes('count-control.md')),
      'IO-6：docs/count-control.md 的 count-drift 被抓到（docs 無逐檔排除）[IO-6]',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-7：--json 含維護提示欄位（summary.hint 含 "actualCounts" 或 "allowlist" 字樣）
{
  const dir = makeRepo();
  try {
    const { json } = runCli(dir, ['--json']);
    assert(
      json && json.summary && typeof json.summary.hint === 'string',
      'IO-7：--json summary.hint 存在且為字串 [IO-7]',
    );
    assert(
      json &&
        json.summary &&
        typeof json.summary.hint === 'string' &&
        /actualCounts|allowlist/.test(json.summary.hint),
      'IO-7：summary.hint 含 "actualCounts" 或 "allowlist" 字樣（維護提示）[IO-7]',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-8（GUARD 增強）：整合 smoke（對真 repo）—— --root 指到本 worktree。
// footprint 掃描範圍須含 skills/（不可退回只掃 agents/）：真實 scaffold-fullstack 的
// description 明顯超出一般預算，且 user-invocable:false，正確行為是降級為 notes（而非
// P2 finding，故整體仍 ok:true/exit 0），但 notes 必須恰好記錄這一筆、且 plain 輸出要可見。
// mutation 實證：若實作「退回只掃 agents/*.md」，notes 會變空、這裡會紅。
{
  const { res, json } = runCli(REAL_REPO_ROOT, ['--json']);
  assert(res.error == null, 'IO-8：node 啟動成功（真 repo smoke）[IO-8]');
  assert(res.status === 0, 'IO-8：真 repo smoke → exit code===0 [IO-8]');
  assert(json && json.ok === true, 'IO-8：真 repo smoke --json ok===true [IO-8]');
  assert(
    json && Array.isArray(json.findings) && json.findings.length === 0,
    `IO-8：真 repo smoke --json findings===[]（實際：${JSON.stringify(json && json.findings)}）[IO-8]`,
  );
  assert(
    json && Array.isArray(json.notes) && json.notes.length === 1,
    `IO-8：真 repo smoke --json notes.length===1（鎖 footprint 掃描含 skills/；實際：${JSON.stringify(json && json.notes)}）[IO-8]`,
  );
  assert(
    json &&
      Array.isArray(json.notes) &&
      json.notes[0] &&
      typeof json.notes[0].file === 'string' &&
      json.notes[0].file.includes('scaffold-fullstack'),
    'IO-8：notes[0].file 含 "scaffold-fullstack"（鎖 footprint wiring 掃到 skills/ 目錄）[IO-8]',
  );

  const plain = spawnSync('node', [SCRIPT, '--root', REAL_REPO_ROOT], { encoding: 'utf8' });
  assert(plain.status === 0, 'IO-8：真 repo smoke 非 --json exit code===0 [IO-8]');
  const lines = plain.stdout.trim().split('\n').filter(Boolean);
  assert(
    lines.some((l) => l.includes('✓')),
    'IO-8：真 repo smoke 非 --json 輸出含 ✓ 綠行 [IO-8]',
  );
  assert(
    lines.some((l) => l.includes('scaffold-fullstack')),
    'IO-8：真 repo smoke 非 --json 輸出含 scaffold-fullstack 提醒行（notes 在 plain 模式可見）[IO-8]',
  );
}

// IO-9（#128 真 repo 整合煙測，對映契約案例⑩）：flagSyncCheck/hooksWiringCheck 對
// REAL_REPO_ROOT 的真實 hooks/hook-flags.mjs、docs/settings.md、references/journaling.md、
// hooks/hooks.json 直接跑，斷言零 P1；並動態 import buildReport 對 REAL_REPO_ROOT 跑一次
// （比照上面既有 IO-8 模式）確認不崩、若其彙總結果已含 flag-sync/hooks-wiring 項目也零 P1。
// 實作前紅：本檔開頭第 11 節動態 import 的 flagSyncCheck/hooksWiringCheck 為 undefined，
// 下面第一組 typeof===function 斷言即標紅；guard 住深層計算，不對 undefined 呼叫崩潰。
{
  assert(typeof flagSyncCheck === 'function', 'IO-9：flagSyncCheck 已作為具名 export 存在 [IO-9-pre]');
  assert(typeof hooksWiringCheck === 'function', 'IO-9：hooksWiringCheck 已作為具名 export 存在 [IO-9-pre]');
  assert(typeof walk === 'function', 'IO-9：walk 可從 skill-lint.mjs import（既有 export）[IO-9-pre]');

  if (typeof flagSyncCheck === 'function' && typeof hooksWiringCheck === 'function' && typeof walk === 'function') {
    const PLUGIN_PREFIX = 'plugins/loops-workflow/';
    const fullMap = walk(REAL_REPO_ROOT);
    const hookFlagsContent = fullMap[`${PLUGIN_PREFIX}hooks/hook-flags.mjs`];
    const settingsContent = fullMap[`${PLUGIN_PREFIX}docs/settings.md`];
    const journalingContent = fullMap[`${PLUGIN_PREFIX}references/journaling.md`];
    assert(
      typeof hookFlagsContent === 'string' && hookFlagsContent.length > 0,
      'IO-9：真 repo hooks/hook-flags.mjs 讀得到內容 [IO-9-pre]',
    );
    assert(
      typeof settingsContent === 'string' && settingsContent.length > 0,
      'IO-9：真 repo docs/settings.md 讀得到內容 [IO-9-pre]',
    );
    assert(
      typeof journalingContent === 'string' && journalingContent.length > 0,
      'IO-9：真 repo references/journaling.md 讀得到內容 [IO-9-pre]',
    );

    const flagFindings = flagSyncCheck({ hookFlagsContent, settingsContent, journalingContent });
    const flagP1 = Array.isArray(flagFindings) ? flagFindings.filter((f) => f.severity === 'P1') : flagFindings;
    assert(
      Array.isArray(flagFindings) && flagP1.length === 0,
      `IO-9：真 repo flagSyncCheck 零 P1（實際 P1：${JSON.stringify(flagP1)}；全部：${JSON.stringify(flagFindings)}）[IO-9]`,
    );

    const { readFileSync } = await import('node:fs');
    const hooksJsonContent = readFileSync(join(REAL_REPO_ROOT, `${PLUGIN_PREFIX}hooks/hooks.json`), 'utf8');
    const hookFiles = Object.keys(fullMap)
      .filter((f) => f.startsWith(`${PLUGIN_PREFIX}hooks/`) && f.endsWith('.mjs'))
      .map((f) => f.slice(PLUGIN_PREFIX.length));
    assert(hookFiles.length > 0, 'IO-9：真 repo hooks/*.mjs 檔清單非空 [IO-9-pre]');

    const wiringFindings = hooksWiringCheck(hooksJsonContent, hookFiles);
    const wiringP1 = Array.isArray(wiringFindings) ? wiringFindings.filter((f) => f.severity === 'P1') : wiringFindings;
    assert(
      Array.isArray(wiringFindings) && wiringP1.length === 0,
      `IO-9：真 repo hooksWiringCheck 零 P1（實際 P1：${JSON.stringify(wiringP1)}；全部：${JSON.stringify(wiringFindings)}）[IO-9]`,
    );
  }

  if (typeof buildReport === 'function') {
    const result = buildReport(REAL_REPO_ROOT);
    const combined = [
      ...(Array.isArray(result?.findings) ? result.findings : []),
      ...(Array.isArray(result?.notes) ? result.notes : []),
    ];
    const relatedP1 = combined.filter(
      (x) => (x.check === 'flag-sync' || x.check === 'hooks-wiring') && x.severity === 'P1',
    );
    assert(
      relatedP1.length === 0,
      `IO-9：真 repo buildReport 彙總結果中 flag-sync/hooks-wiring 零 P1（實際：${JSON.stringify(relatedP1)}）[IO-9-buildReport]`,
    );
  }
}

// ── 摘要 + exit code ─────────────────────────────────────────────────────────
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
