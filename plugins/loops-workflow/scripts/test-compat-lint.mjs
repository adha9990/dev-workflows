#!/usr/bin/env node
// test-compat-lint.mjs —— compat-lint.mjs（C3）的紅綠單元 + IO/CLI 整合斷言（自帶極簡 harness，
// 仿 test-codex-plugin-lint.mjs）。
// 用法：node test-compat-lint.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1。
//
// 場景 ID 對照任務規格：S1=平台工具名、S2=vendor model id、S3=inline code span 但不緊貼訊號詞
// （負向，backtick 本身不豁免）、S3b=同一行訊號詞緊貼第一個 span、第二個 span 不緊貼仍須命中
// （span 級豁免的關鍵反例，鎖住「行級一刀切」這個錯誤實作）、S4=未標平台邊界的機制細節、
// S5=adapter-projection 區塊豁免、S6=runtime scoped span 豁免。
//
// 只對 scripts/fixtures/compat-lint/ 底下的 fixture 跑；本次任務刻意不對真實 repo 全掃
// （--root . 現況還有大量未清理的命中，那是 T21–T24 的工作，不在本次驗證範圍）。
//
// T18 新增 C2（capability-registry ↔ gaps.json 對帳）：S4=I7（孤兒／懸空／歸屬不明二擇一）、
// S5=I10（status/measurability 保守序一致性 + override_rationale 逃生門）、
// S18=rationale_if_no_gaps_ref（gaps_refs 為空的 facet 須有理由）。C2 是資料對帳、不是文字掃描，
// 純函式測試直接用 inline JS 物件（比照本檔既有 normalizeScopes/formatSummary 的作法，不另開
// JSON fixture 檔——minimalism：純資料結構用字面量就夠，不需要 IO）；C2 的 IO 邊界
// （buildC2Report）與真實 repo 資料的整合測試才用檔案（temp dir / 真實 root）。
//
// T19 新增 C4（agent tier/effort/model 對帳）：S19=model 漂移（負向，鎖住 model_tier.claude.model
// 與 frontmatter model: 不符）、S20=effort 漂移（負向，補 I8 只驗鍵集合這個歷史說法的洞——實測
// I8 其實已驗值，這裡是對稱寫一份，理由見 compat-lint.mjs 檔頭 C4 分工註解）、S21=兩者皆一致的
// 正向 fixture。純函式測試一樣用 inline 物件；buildC4Report 的 IO 整合測試用 temp dir 假 repo
// （不直接竄改真實 agents/*.md，竄改真實檔案風險留給下面「真實 repo 零 finding」那組整合測試）。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  scanPlatformToolNames,
  scanVendorModelIds,
  scanMechanismDetails,
  scanViolations,
  findAdapterProjectionRanges,
  findRuntimeScopeRanges,
  findInlineCodeSpans,
  isAdjacentToSignal,
  classifyExemption,
  lintFileText,
  isExcludedPath,
  normalizeScopes,
  formatSummary,
  listScopeFiles,
  buildReport,
  checkGapsFacetReconciliation,
  checkFacetStatusConsistency,
  checkRationaleForEmptyGapsRefs,
  checkCapabilityRegistryReconciliation,
  parseGapsArrayJson,
  buildC2Report,
  checkAgentTierEffortModelReconciliation,
  buildC4Report,
  checkRuntimeOverrideCorrespondence,
  buildC5Report,
  aliasMatcherTokens,
  deepEqualJson,
  projectHooksToCodex,
  checkHooksCodexProjectionDrift,
  buildC6Report,
} from './compat-lint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = fileURLToPath(new URL('./compat-lint.mjs', import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures', 'compat-lint');

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

function loadFixture(name) {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

// ══════════════════════════════════════════════════════════════════════════
// 1. scanPlatformToolNames / scanVendorModelIds / scanMechanismDetails / scanViolations
// ══════════════════════════════════════════════════════════════════════════
{
  const hits = scanPlatformToolNames('呼叫 AskUserQuestion 與 EnterWorktree');
  assert(hits.length === 2 && hits[0].match === 'AskUserQuestion' && hits[1].match === 'EnterWorktree',
    `scanPlatformToolNames：兩個工具名各命中一筆（實際：${JSON.stringify(hits)}）[1a]`);
}
{
  const hits = scanPlatformToolNames('這裡只是普通說明文字');
  assert(hits.length === 0, 'scanPlatformToolNames：無工具名 → 0 筆命中 [1b]');
}
{
  const hits = scanVendorModelIds('派給 Opus 執行，備援用 haiku');
  assert(hits.length === 2, `scanVendorModelIds：大小寫不分且各命中一筆（實際：${JSON.stringify(hits)}）[1c]`);
}
{
  const hits = scanVendorModelIds('鎖定 claude-opus-4-1-20250805 版本');
  assert(hits.length === 1 && hits[0].match === 'claude-opus-4-1-20250805',
    `scanVendorModelIds：claude- 開頭 model id 整段吃掉、不與內含的 opus 重複命中（實際：${JSON.stringify(hits)}）[1d]`);
}
{
  const hits = scanMechanismDetails('讀取 PreToolUse 與 costs.jsonl');
  assert(hits.length === 2, `scanMechanismDetails：兩個機制詞各命中一筆（實際：${JSON.stringify(hits)}）[1e]`);
}
{
  const hits = scanViolations('AskUserQuestion 派給 opus，讀 PreToolUse');
  assert(hits.length === 3 && hits.every((h, i) => i === 0 || h.index >= hits[i - 1].index),
    `scanViolations：三合一合併＋依 index 排序（實際：${JSON.stringify(hits)}）[1f]`);
}

// ══════════════════════════════════════════════════════════════════════════
// 2. findAdapterProjectionRanges / findRuntimeScopeRanges / findInlineCodeSpans
// ══════════════════════════════════════════════════════════════════════════
{
  const text = '前段\n<!-- adapter-projection -->\n內容\n<!-- /adapter-projection -->\n後段';
  const ranges = findAdapterProjectionRanges(text);
  assert(ranges.length === 1, `findAdapterProjectionRanges：一組 marker → 一個區段（實際：${JSON.stringify(ranges)}）[2a]`);
  assert(ranges[0].start === text.indexOf('<!-- adapter-projection'), 'findAdapterProjectionRanges：區段起點對齊開始 marker [2a]');
}
{
  const text = '<!-- runtime: claude -->x<!-- /runtime -->\n<!-- runtime: codex -->y<!-- /runtime -->';
  const ranges = findRuntimeScopeRanges(text);
  assert(ranges.length === 2 && ranges[0].runtime === 'claude' && ranges[1].runtime === 'codex',
    `findRuntimeScopeRanges：claude/codex 各一段、runtime 標記正確（實際：${JSON.stringify(ranges)}）[2b]`);
}
{
  const spans = findInlineCodeSpans('這裡有 `opus` 和 `sonnet` 兩個 span');
  assert(spans.length === 2, `findInlineCodeSpans：兩個 backtick 對 → 兩個 span（實際：${JSON.stringify(spans)}）[2c]`);
}

// ══════════════════════════════════════════════════════════════════════════
// 3. isAdjacentToSignal（緊貼判定：≤12 字元、不含換行）
// ══════════════════════════════════════════════════════════════════════════
{
  const text = '例如 `opus`';
  const spanStart = text.indexOf('`');
  assert(isAdjacentToSignal(text, spanStart), `isAdjacentToSignal：訊號詞緊接 span、間隔 1 字元 → 緊貼（文字："${text}"）[3a]`);
}
{
  const text = '設定值固定為 `opus`';
  const spanStart = text.indexOf('`');
  assert(!isAdjacentToSignal(text, spanStart), `isAdjacentToSignal：無任何訊號詞 → 不緊貼（文字："${text}"）[3b]`);
}
{
  // 邊界值：剛好 12 字元的間隔仍算緊貼（規格：不超過 12 個字元）
  const gap = 'x'.repeat(12);
  const text = `例如${gap}\`opus\``;
  const spanStart = text.indexOf('`');
  assert(isAdjacentToSignal(text, spanStart), `isAdjacentToSignal：間隔恰好 12 字元 → 仍緊貼（邊界值）[3c]`);
}
{
  // 超過 12 字元（13）→ 不緊貼
  const gap = 'x'.repeat(13);
  const text = `例如${gap}\`opus\``;
  const spanStart = text.indexOf('`');
  assert(!isAdjacentToSignal(text, spanStart), `isAdjacentToSignal：間隔 13 字元 → 不緊貼（超出邊界）[3d]`);
}

// ══════════════════════════════════════════════════════════════════════════
// 4. classifyExemption（三種豁免各自的分類標籤）
// ══════════════════════════════════════════════════════════════════════════
{
  const text = '<!-- adapter-projection -->AskUserQuestion<!-- /adapter-projection -->';
  const violation = { index: text.indexOf('AskUserQuestion'), length: 'AskUserQuestion'.length, match: 'AskUserQuestion' };
  const result = classifyExemption({
    text, violation,
    adapterRanges: findAdapterProjectionRanges(text),
    runtimeRanges: findRuntimeScopeRanges(text),
    spans: findInlineCodeSpans(text),
  });
  assert(result && result.label.includes('adapter-projection'), `classifyExemption：落在 adapter-projection 區段 → 標籤含 adapter-projection（實際：${JSON.stringify(result)}）[4a]`);
}
{
  const text = 'AskUserQuestion 沒有被任何 marker 包住';
  const violation = { index: 0, length: 'AskUserQuestion'.length, match: 'AskUserQuestion' };
  const result = classifyExemption({
    text, violation,
    adapterRanges: findAdapterProjectionRanges(text),
    runtimeRanges: findRuntimeScopeRanges(text),
    spans: findInlineCodeSpans(text),
  });
  assert(result === null, `classifyExemption：不落在任何豁免區段 → null（實際：${JSON.stringify(result)}）[4b]`);
}

// ══════════════════════════════════════════════════════════════════════════
// 5. lintFileText —— 逐類違規正向／負向 fixture
// ══════════════════════════════════════════════════════════════════════════

// S1：平台工具名
{
  const { findings, notes } = lintFileText(loadFixture('tool-name-violation.md'), 'f.md');
  assert(findings.length === 1 && findings[0].check === 'platform-tool-name' && findings[0].line === 3,
    `lintFileText [S1 正向]：工具名 fixture → 1 筆 platform-tool-name finding、第 3 行（實際：${JSON.stringify(findings)}）`);
  assert(notes.length === 0, 'lintFileText [S1 正向]：無豁免 → notes 為空');
  assert(findings[0].severity === 'P1', 'lintFileText [S1 正向]：severity=P1');
}
{
  const { findings } = lintFileText(loadFixture('tool-name-clean.md'), 'f.md');
  assert(findings.length === 0, `lintFileText [S1 負向]：無工具名字面的乾淨 fixture → 0 筆 finding（實際：${JSON.stringify(findings)}）`);
}

// S2：vendor model id
{
  const { findings } = lintFileText(loadFixture('vendor-model-violation.md'), 'f.md');
  assert(findings.length === 1 && findings[0].check === 'vendor-model-id',
    `lintFileText [S2 正向]：opus 裸字 → 1 筆 vendor-model-id finding（實際：${JSON.stringify(findings)}）`);
}
{
  const { findings } = lintFileText(loadFixture('vendor-model-clean.md'), 'f.md');
  assert(findings.length === 0, `lintFileText [S2 負向]：無 model 名的乾淨 fixture → 0 筆 finding（實際：${JSON.stringify(findings)}）`);
}
{
  const { findings } = lintFileText(loadFixture('vendor-model-claude-prefix-violation.md'), 'f.md');
  assert(
    findings.length === 1 && findings[0].check === 'vendor-model-id' && findings[0].detail.includes('claude-opus-4-1-20250805'),
    `lintFileText [S2 變體]：claude- 開頭完整 model id 整段命中一筆（實際：${JSON.stringify(findings)}）`,
  );
}

// S4：未標平台邊界的機制細節
{
  const { findings } = lintFileText(loadFixture('mechanism-detail-violation.md'), 'f.md');
  assert(findings.length === 1 && findings[0].check === 'mechanism-detail',
    `lintFileText [S4 正向]：PreToolUse 裸字 → 1 筆 mechanism-detail finding（實際：${JSON.stringify(findings)}）`);
}
{
  const { findings } = lintFileText(loadFixture('mechanism-detail-clean.md'), 'f.md');
  assert(findings.length === 0, `lintFileText [S4 負向]：無機制詞的乾淨 fixture → 0 筆 finding（實際：${JSON.stringify(findings)}）`);
}

// ══════════════════════════════════════════════════════════════════════════
// 6. lintFileText —— 三種豁免正向／負向 fixture（含 notes 逐筆輸出）
// ══════════════════════════════════════════════════════════════════════════

// S5：adapter-projection 區塊豁免
{
  const { findings, notes } = lintFileText(loadFixture('exempt-adapter-projection-positive.md'), 'f.md');
  assert(findings.length === 0, `lintFileText [S5 正向]：marker 內的違規 → 0 筆 finding（實際：${JSON.stringify(findings)}）`);
  assert(notes.length === 1 && notes[0].includes('f.md:') && notes[0].includes('adapter-projection') && notes[0].includes('AskUserQuestion'),
    `lintFileText [S5 正向]：豁免命中逐筆記進 notes，含 file:line、豁免種類、原文片段（實際：${JSON.stringify(notes)}）`);
}
{
  const { findings, notes } = lintFileText(loadFixture('exempt-adapter-projection-negative.md'), 'f.md');
  assert(findings.length === 1 && findings[0].check === 'platform-tool-name',
    `lintFileText [S5 負向]：marker 範圍外的違規（雖然檔案別處有 marker）→ 仍命中（實際：${JSON.stringify(findings)}）`);
  assert(notes.length === 0, 'lintFileText [S5 負向]：marker 內本身無違規字面 → notes 為空');
}

// S3 / S3b：inline code span 緊貼訊號詞豁免
{
  const { findings, notes } = lintFileText(loadFixture('exempt-signal-word-positive.md'), 'f.md');
  assert(findings.length === 0, `lintFileText [S3 正向]：緊貼「例如」的 span → 0 筆 finding（實際：${JSON.stringify(findings)}）`);
  assert(notes.length === 1 && notes[0].includes('訊號詞') && notes[0].includes('opus'),
    `lintFileText [S3 正向]：豁免記進 notes（實際：${JSON.stringify(notes)}）`);
}
{
  // S3 反例：opus 雖然在 inline code span 裡，但整份文件沒有任何訊號詞 → backtick 本身不豁免，仍命中
  const { findings, notes } = lintFileText(loadFixture('exempt-signal-word-negative.md'), 'f.md');
  assert(findings.length === 1 && findings[0].check === 'vendor-model-id',
    `lintFileText [S3 負向]：code span 內但無訊號詞緊貼 → 仍命中，backtick 本身不是豁免條件（實際：${JSON.stringify(findings)}）`);
  assert(notes.length === 0, 'lintFileText [S3 負向]：沒有任何豁免發生 → notes 為空');
}
{
  // S3b（關鍵反例）：同一行「討論」緊貼第一個 span（opus，豁免），但第二個 span（sonnet）離訊號詞
  // 太遠（規格算出間隔 14 字元 > 12）→ 仍須命中。這條專門鎖住「豁免整行」這種行級一刀切的錯誤實作
  // ——若實作誤判成整行豁免，sonnet 也會被吃掉、下面第一條斷言就會失敗。
  const text = loadFixture('exempt-signal-word-s3b.md');
  const { findings, notes } = lintFileText(text, 'f.md');
  assert(
    findings.length === 1 && findings[0].check === 'vendor-model-id' && findings[0].detail.includes('sonnet'),
    `lintFileText [S3b]：sonnet 不緊貼「討論」（間隔 14 字元 > 12）→ 仍須命中，證明豁免是 span 級不是行級（實際：${JSON.stringify(findings)}）`,
  );
  assert(
    notes.length === 1 && notes[0].includes('opus') && notes[0].includes('訊號詞'),
    `lintFileText [S3b]：opus 緊貼「討論」（間隔 4 字元 ≤ 12）→ 豁免並記進 notes，且不是 sonnet 也一起被吃掉（實際：${JSON.stringify(notes)}）`,
  );
  assert(
    !notes.some((n) => n.includes('sonnet')) && !findings.some((f) => f.detail.includes('opus') && !f.detail.includes('sonnet')),
    `lintFileText [S3b]：sonnet 沒有被誤記進 notes（沒有被誤豁免）（實際 notes：${JSON.stringify(notes)}，findings：${JSON.stringify(findings)}）`,
  );
}

// S6：runtime scoped span 豁免
{
  const { findings, notes } = lintFileText(loadFixture('exempt-runtime-scope-positive.md'), 'f.md');
  assert(findings.length === 0, `lintFileText [S6 正向]：runtime: claude / runtime: codex 範圍內的違規 → 0 筆 finding（實際：${JSON.stringify(findings)}）`);
  assert(
    notes.length === 2 && notes.some((n) => n.includes('claude')) && notes.some((n) => n.includes('codex')),
    `lintFileText [S6 正向]：兩個 runtime 範圍各自豁免並記進 notes、標明是哪個 runtime（實際：${JSON.stringify(notes)}）`,
  );
}
{
  const { findings, notes } = lintFileText(loadFixture('exempt-runtime-scope-negative.md'), 'f.md');
  assert(findings.length === 1 && findings[0].check === 'platform-tool-name',
    `lintFileText [S6 負向]：runtime 範圍外的違規（雖然檔案別處有 runtime 標記）→ 仍命中（實際：${JSON.stringify(findings)}）`);
  assert(notes.length === 0, 'lintFileText [S6 負向]：runtime 範圍內本身無違規字面 → notes 為空');
}

// 全綠 fixture
{
  const { findings, notes } = lintFileText(loadFixture('clean-doc.md'), 'f.md');
  assert(findings.length === 0 && notes.length === 0, `lintFileText：全綠 fixture → findings 與 notes 皆空（實際：${JSON.stringify({ findings, notes })}）`);
}

// ══════════════════════════════════════════════════════════════════════════
// 7. isExcludedPath / normalizeScopes
// ══════════════════════════════════════════════════════════════════════════
{
  assert(isExcludedPath('plugins/loops-workflow/references/reviewers/foo-reviewer.md'), 'isExcludedPath：reviewers/** 排除 [7a]');
  assert(isExcludedPath('plugins/loops-workflow/references/reviewer-shared.md'), 'isExcludedPath：reviewer-shared.md 精確排除 [7a]');
  assert(isExcludedPath('plugins/loops-workflow/agents/impl-author.md'), 'isExcludedPath：agents/** 排除 [7a]');
  assert(isExcludedPath('plugins/loops-workflow/skills/scaffold-fullstack/assets/README.md'), 'isExcludedPath：scaffold-fullstack/assets/** 排除 [7a]');
  assert(isExcludedPath('plugins/loops-workflow/skills/plan/fixtures/foo.md'), 'isExcludedPath：任一路徑段為 fixtures → 排除 [7a]');
  assert(!isExcludedPath('plugins/loops-workflow/references/journaling.md'), 'isExcludedPath：一般 references 檔不誤排除 [7a]');
}
{
  assert(JSON.stringify(normalizeScopes(null)) === JSON.stringify(['skills', 'references', 'plugin-docs', 'repo-root', 'root-docs']),
    'normalizeScopes：省略 → 全部 5 個 scope [7b]');
  assert(JSON.stringify(normalizeScopes('skills,references')) === JSON.stringify(['skills', 'references']),
    'normalizeScopes：逗號分隔 → 對應子集 [7c]');
  assert(JSON.stringify(normalizeScopes('bogus,also-bogus')) === JSON.stringify([]),
    'normalizeScopes：全部不合法 → 空陣列（不 fallback 回全掃）[7d]');
  assert(JSON.stringify(normalizeScopes('skills, bogus , references ')) === JSON.stringify(['skills', 'references']),
    'normalizeScopes：合法與不合法混合 → 只留合法子集、trim 空白 [7e]');
}

// ══════════════════════════════════════════════════════════════════════════
// 8. formatSummary
// ══════════════════════════════════════════════════════════════════════════
{
  const summary = formatSummary({ findings: [], notes: [], summary: { filesScanned: 3 } });
  assert(typeof summary === 'string' && summary.includes('✓'), 'formatSummary：無 finding → 含 ✓ [8a]');
}
{
  const summary = formatSummary({
    findings: [{ check: 'platform-tool-name', severity: 'P1', file: 'f.md', line: 3, detail: 'd' }],
    notes: [],
    summary: { filesScanned: 3 },
  });
  assert(typeof summary === 'string' && summary.includes('✗') && summary.includes('platform-tool-name'), 'formatSummary：有 finding → 含 ✗ 與 check 名 [8b]');
}
{
  const summary = formatSummary({ findings: [], notes: ['f.md:1 — x — y'], summary: { filesScanned: 1 } });
  assert(summary.includes('1') && summary.includes('notes'), 'formatSummary：有 notes → 摘要提及筆數與 notes [8c]');
}

// ══════════════════════════════════════════════════════════════════════════
// IO：listScopeFiles / buildReport 在暫存假 repo 上跑 scope 篩選＋排除規則
// ══════════════════════════════════════════════════════════════════════════
function writeFiles(root, filesObj) {
  for (const [rel, content] of Object.entries(filesObj)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
}

function makeFakeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'compat-lint-'));
  writeFiles(dir, {
    'plugins/loops-workflow/skills/foo/SKILL.md': '呼叫 AskUserQuestion。',
    'plugins/loops-workflow/skills/foo/fixtures/should-be-skipped.md': '呼叫 AskUserQuestion。',
    'plugins/loops-workflow/skills/scaffold-fullstack/assets/should-be-skipped2.md': '呼叫 AskUserQuestion。',
    'plugins/loops-workflow/references/top-level.md': '派給 opus。',
    'plugins/loops-workflow/references/nested/should-scan.md': '派給 opus。',
    'plugins/loops-workflow/references/reviewer-shared.md': '派給 opus。',
    'plugins/loops-workflow/docs/topic/nested.md': '讀取 PreToolUse。',
    'docs/spec/nested.md': '讀取 PreToolUse。',
    'AGENTS.md': '呼叫 TodoWrite。',
    'README.md': '# 全綠\n\n這份文件乾淨。',
  });
  return dir;
}

// IO-1：skills scope 只掃 skills/**/*.md，排除 fixtures/ 與 scaffold-fullstack/assets/
{
  const dir = makeFakeRepo();
  try {
    const files = listScopeFiles(dir, 'skills');
    assert(files.includes('plugins/loops-workflow/skills/foo/SKILL.md'), 'listScopeFiles [IO-1]：skills 掃到一般 SKILL.md');
    assert(!files.some((f) => f.includes('/fixtures/')), 'listScopeFiles [IO-1]：skills 排除 fixtures/ 子目錄');
    assert(!files.some((f) => f.includes('scaffold-fullstack/assets/')), 'listScopeFiles [IO-1]：skills 排除 scaffold-fullstack/assets/**');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-2：references scope 遞迴掃全樹 .md，reviewer-shared.md 仍精確排除
// 【行為變更】原本這條鎖的是「references 不遞迴進 nested/」。reference 樹改為巢狀分類後，
// 非遞迴會讓子目錄裡的 reference 整批脫離 C3/C5 掃描面、且是「掃描面塌陷但仍回報全綠」的
// 靜默失效（lint-mutation 的 compat-lint-files-scanned 探針就是為這個而設）。當初設非遞迴的
// 唯一理由是避開生成物 references/reviewers/**，而那批已由 EXCLUDED_PATH_PREFIXES 精確排除，
// 「不遞迴」這道粗篩已無存在理由 —— 故本條改鎖相反方向：巢狀 .md 必須掃得到。
// 排除規則（reviewer-shared.md 精確排除、reviewers/ 前綴排除）不變，嚴格度沒有放寬。
{
  const dir = makeFakeRepo();
  try {
    const files = listScopeFiles(dir, 'references');
    assert(files.includes('plugins/loops-workflow/references/top-level.md'), 'listScopeFiles [IO-2]：references 掃到頂層 .md');
    assert(files.includes('plugins/loops-workflow/references/nested/should-scan.md'), 'listScopeFiles [IO-2]：references 遞迴掃到巢狀 .md');
    assert(!files.includes('plugins/loops-workflow/references/reviewer-shared.md'), 'listScopeFiles [IO-2]：reviewer-shared.md 精確排除');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-3：plugin-docs / repo-root 各自遞迴掃自己的 docs 樹，互不混淆
{
  const dir = makeFakeRepo();
  try {
    const pluginDocs = listScopeFiles(dir, 'plugin-docs');
    const repoRootDocs = listScopeFiles(dir, 'repo-root');
    assert(pluginDocs.includes('plugins/loops-workflow/docs/topic/nested.md'), 'listScopeFiles [IO-3]：plugin-docs 遞迴掃到巢狀 .md');
    assert(repoRootDocs.includes('docs/spec/nested.md'), 'listScopeFiles [IO-3]：repo-root 遞迴掃到巢狀 .md');
    assert(!pluginDocs.includes('docs/spec/nested.md'), 'listScopeFiles [IO-3]：plugin-docs 不誤含 repo-root 的檔案');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-4：root-docs 是明確兩檔（AGENTS.md、README.md），不是目錄掃描
{
  const dir = makeFakeRepo();
  try {
    const files = listScopeFiles(dir, 'root-docs');
    assert(JSON.stringify([...files].sort()) === JSON.stringify(['AGENTS.md', 'README.md']),
      `listScopeFiles [IO-4]：root-docs 恰好是 AGENTS.md + README.md（實際：${JSON.stringify(files)}）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-5：buildReport 依 --scope 篩選面，跨面違規互不干擾；預設（省略 scope）全掃合併
{
  const dir = makeFakeRepo();
  try {
    const skillsOnly = buildReport(dir, { scope: 'skills' });
    assert(skillsOnly.ok === false && skillsOnly.findings.every((f) => f.file.startsWith('plugins/loops-workflow/skills/')),
      `buildReport [IO-5]：scope=skills → 只回 skills 底下的 finding（實際：${JSON.stringify(skillsOnly.findings)}）`);

    const full = buildReport(dir, {});
    const checks = new Set(full.findings.map((f) => f.check));
    assert(full.ok === false, 'buildReport [IO-5]：全掃（省略 scope）→ ok=false（假 repo 本來就有違規）');
    assert(checks.has('platform-tool-name') && checks.has('vendor-model-id') && checks.has('mechanism-detail'),
      `buildReport [IO-5]：全掃合併涵蓋三類違規（實際 checks：${JSON.stringify([...checks])}）`);
    assert(full.summary.filesScanned > skillsOnly.summary.filesScanned, 'buildReport [IO-5]：全掃掃到的檔案數多於單一 scope');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// IO/CLI 整合（spawnSync 真跑 compat-lint.mjs --root <假 repo> --scope <scope>）
// ══════════════════════════════════════════════════════════════════════════
function runCli(root, args = ['--json']) {
  const res = spawnSync('node', [SCRIPT, '--root', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
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

// CLI-1：假 repo 全掃 → exit 1，findings 非空
{
  const dir = makeFakeRepo();
  try {
    const { res, json } = runCli(dir, ['--json']);
    assert(res.error == null, 'CLI-1：node 啟動成功（spawn 無 error）');
    assert(res.status === 1, `CLI-1：假 repo 有違規 → exit code===1（實際 stdout：${res.stdout}）`);
    assert(json && json.ok === false && json.findings.length > 0, `CLI-1：--json ok===false、findings 非空（實際：${JSON.stringify(json)}）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// CLI-2：只給乾淨的 root-docs（README.md）、scope 限定 root-docs 且只掃到乾淨檔 → exit 0
{
  const dir = mkdtempSync(join(tmpdir(), 'compat-lint-'));
  try {
    writeFiles(dir, { 'README.md': '# 全綠\n\n這份文件乾淨，不含任何禁令字面。' });
    const { res, json } = runCli(dir, ['--scope', 'root-docs', '--json']);
    assert(res.status === 0, `CLI-2：只有乾淨 README.md、scope=root-docs → exit code===0（實際 stdout：${res.stdout}）`);
    assert(json && json.ok === true && json.findings.length === 0, `CLI-2：--json ok===true（實際：${JSON.stringify(json)}）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// CLI-3：--scope 篩選生效——只給 skills 違規時，scope=references 應該掃不到（因為 references 目錄不存在／無檔）
{
  const dir = mkdtempSync(join(tmpdir(), 'compat-lint-'));
  try {
    writeFiles(dir, { 'plugins/loops-workflow/skills/foo/SKILL.md': '呼叫 AskUserQuestion。' });
    const { res, json } = runCli(dir, ['--scope', 'references', '--json']);
    assert(res.status === 0, `CLI-3：scope=references 掃不到 skills 底下的違規 → exit code===0（實際：${JSON.stringify(json)}）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// C2：checkGapsFacetReconciliation（I7，S4）——孤兒／懸空／歸屬不明二擇一
// ══════════════════════════════════════════════════════════════════════════

// S4 正向：capability_id 恰好被一個 facet 引用、不在 deferred → 0 筆 finding
{
  const registry = { facets: { foo: { gaps_refs: ['codex.a'] } }, deferred: [] };
  const gaps = [{ capability_id: 'codex.a' }];
  const findings = checkGapsFacetReconciliation(registry, gaps);
  assert(findings.length === 0, `checkGapsFacetReconciliation [S4 正向]：唯一歸屬（引用）→ 0 筆 finding（實際：${JSON.stringify(findings)}）`);
}
// S4 正向：capability_id 只在 deferred[]、未被任何 facet 引用 → 0 筆 finding（deferred 也是合法歸屬）
{
  const registry = { facets: { foo: { gaps_refs: [] } }, deferred: [{ capability_id: 'codex.b' }] };
  const gaps = [{ capability_id: 'codex.b' }];
  const findings = checkGapsFacetReconciliation(registry, gaps);
  assert(findings.length === 0, `checkGapsFacetReconciliation [S4 正向]：唯一歸屬（deferred）→ 0 筆 finding（實際：${JSON.stringify(findings)}）`);
}
// S4 負向：孤兒——兩者皆無
{
  const registry = { facets: { foo: { gaps_refs: [] } }, deferred: [] };
  const gaps = [{ capability_id: 'codex.orphan' }];
  const findings = checkGapsFacetReconciliation(registry, gaps);
  assert(findings.length === 1 && findings[0].check === 'C2' && findings[0].detail.includes('孤兒'),
    `checkGapsFacetReconciliation [S4 負向-孤兒]：既未被引用也不在 deferred → 1 筆 finding 標「孤兒」（實際：${JSON.stringify(findings)}）`);
}
// S4 負向：懸空——gaps_refs 引用 gaps.json 沒有的 id
{
  const registry = { facets: { foo: { gaps_refs: ['codex.does-not-exist'] } }, deferred: [] };
  const gaps = [{ capability_id: 'codex.real' }];
  const findings = checkGapsFacetReconciliation(registry, gaps);
  assert(
    findings.some((f) => f.detail.includes('懸空') && f.detail.includes('codex.does-not-exist'))
      && findings.some((f) => f.detail.includes('孤兒') && f.detail.includes('codex.real')),
    `checkGapsFacetReconciliation [S4 負向-懸空]：懸空引用（1 筆）+ codex.real 因而孤兒（另 1 筆）（實際：${JSON.stringify(findings)}）`,
  );
}
// S4 負向：歸屬不明——同一 capability_id 同時被 facet 引用又在 deferred[]
{
  const registry = { facets: { foo: { gaps_refs: ['codex.c'] } }, deferred: [{ capability_id: 'codex.c' }] };
  const gaps = [{ capability_id: 'codex.c' }];
  const findings = checkGapsFacetReconciliation(registry, gaps);
  assert(findings.length === 1 && findings[0].detail.includes('歸屬不明') && findings[0].detail.includes('foo'),
    `checkGapsFacetReconciliation [S4 負向-歸屬不明]：同時被引用又 deferred → 1 筆 finding 標「歸屬不明」（實際：${JSON.stringify(findings)}）`);
}

// ══════════════════════════════════════════════════════════════════════════
// C2：checkFacetStatusConsistency（I10，S5）——保守序一致性 + override_rationale 逃生門
// ══════════════════════════════════════════════════════════════════════════

// S5 正向：單一 ref，facet 自身 status/measurability 與 ref 一致 → 0 筆 finding
{
  const registry = { facets: { foo: { gaps_refs: ['codex.a'], platforms: { codex: { status: 'not_measured', measurability: 'needs_auth' } } } } };
  const gaps = [{ capability_id: 'codex.a', status: 'not_measured', measurability: 'needs_auth' }];
  const findings = checkFacetStatusConsistency(registry, gaps);
  assert(findings.length === 0, `checkFacetStatusConsistency [S5 正向-單筆一致]：0 筆 finding（實際：${JSON.stringify(findings)}）`);
}
// S5 正向：多筆 ref 狀態互異，facet 自身取最保守者（degraded 比 not_measured 保守）→ 0 筆 finding
{
  const registry = { facets: { foo: { gaps_refs: ['codex.a', 'codex.b'], platforms: { codex: { status: 'degraded', measurability: 'needs_auth' } } } } };
  const gaps = [
    { capability_id: 'codex.a', status: 'not_measured', measurability: 'needs_auth' },
    { capability_id: 'codex.b', status: 'degraded', measurability: 'needs_auth' },
  ];
  const findings = checkFacetStatusConsistency(registry, gaps);
  assert(findings.length === 0, `checkFacetStatusConsistency [S5 正向-保守序]：取最保守者 degraded 與 facet 自身相符 → 0 筆 finding（實際：${JSON.stringify(findings)}）`);
}
// S5 負向：status 偏離保守序推導值、無 override_rationale → 1 筆 finding
{
  const registry = { facets: { foo: { gaps_refs: ['codex.a', 'codex.b'], platforms: { codex: { status: 'not_measured', measurability: 'needs_auth' } } } } };
  const gaps = [
    { capability_id: 'codex.a', status: 'not_measured', measurability: 'needs_auth' },
    { capability_id: 'codex.b', status: 'degraded', measurability: 'needs_auth' },
  ];
  const findings = checkFacetStatusConsistency(registry, gaps);
  assert(findings.length === 1 && findings[0].check === 'C2' && findings[0].detail.includes('I10'),
    `checkFacetStatusConsistency [S5 負向-status]：facet 自身 not_measured 但保守序應取 degraded、無 override → 1 筆 finding（實際：${JSON.stringify(findings)}）`);
}
// S5 正向：status 偏離保守序推導值，但有 override_rationale → 逃生門生效，0 筆 finding
{
  const registry = {
    facets: {
      foo: {
        gaps_refs: ['codex.a', 'codex.b'],
        override_rationale: '語意越界，故意不沿用保守序',
        platforms: { codex: { status: 'not_measured', measurability: 'needs_auth' } },
      },
    },
  };
  const gaps = [
    { capability_id: 'codex.a', status: 'not_measured', measurability: 'needs_auth' },
    { capability_id: 'codex.b', status: 'degraded', measurability: 'needs_auth' },
  ];
  const findings = checkFacetStatusConsistency(registry, gaps);
  assert(findings.length === 0, `checkFacetStatusConsistency [S5 正向-override]：有 override_rationale → 逃生門生效，0 筆 finding（實際：${JSON.stringify(findings)}）`);
}
// S5 負向：measurability 偏離一致值、無 override_rationale → 1 筆 finding
{
  const registry = { facets: { foo: { gaps_refs: ['codex.a'], platforms: { codex: { status: 'not_measured', measurability: 'login_free' } } } } };
  const gaps = [{ capability_id: 'codex.a', status: 'not_measured', measurability: 'needs_auth' }];
  const findings = checkFacetStatusConsistency(registry, gaps);
  assert(findings.length === 1 && findings[0].detail.includes('measurability'),
    `checkFacetStatusConsistency [S5 負向-measurability]：facet 自身 login_free 但 ref 一致值是 needs_auth、無 override → 1 筆 finding（實際：${JSON.stringify(findings)}）`);
}

// ══════════════════════════════════════════════════════════════════════════
// C2：checkRationaleForEmptyGapsRefs（S18）——gaps_refs 為空須有 rationale_if_no_gaps_ref
// ══════════════════════════════════════════════════════════════════════════

// S18 正向：gaps_refs 為空但有 rationale_if_no_gaps_ref → 0 筆 finding
{
  const registry = { facets: { hook_concurrency: { gaps_refs: [], rationale_if_no_gaps_ref: '未涵蓋此面向' } } };
  const findings = checkRationaleForEmptyGapsRefs(registry);
  assert(findings.length === 0, `checkRationaleForEmptyGapsRefs [S18 正向]：有理由 → 0 筆 finding（實際：${JSON.stringify(findings)}）`);
}
// S18 負向：gaps_refs 為空且沒有 rationale_if_no_gaps_ref → 1 筆 finding
{
  const registry = { facets: { hook_concurrency: { gaps_refs: [] } } };
  const findings = checkRationaleForEmptyGapsRefs(registry);
  assert(findings.length === 1 && findings[0].check === 'C2' && findings[0].detail.includes('rationale_if_no_gaps_ref'),
    `checkRationaleForEmptyGapsRefs [S18 負向]：無理由 → 1 筆 finding（實際：${JSON.stringify(findings)}）`);
}
// 對照組：gaps_refs 非空時完全不受此檢查影響，無論有無 rationale 都不誤報
{
  const findings = checkRationaleForEmptyGapsRefs({ facets: { foo: { gaps_refs: ['codex.a'] } } });
  assert(findings.length === 0, 'checkRationaleForEmptyGapsRefs：gaps_refs 非空 → 不受此檢查限制，0 筆 finding');
}

// ══════════════════════════════════════════════════════════════════════════
// C2：checkCapabilityRegistryReconciliation（彙整器）+ parseGapsArrayJson
// ══════════════════════════════════════════════════════════════════════════
{
  const registry = {
    facets: {
      a: { gaps_refs: [], rationale_if_no_gaps_ref: 'ok' },
      b: { gaps_refs: ['codex.orphan-check'] },
    },
    deferred: [],
  };
  const gaps = [{ capability_id: 'codex.orphan-check', status: 'not_measured', measurability: 'needs_auth' }];
  // b 未填 platforms.codex，狀態不比對（無 gapEntries 情境已在 S5 測過）；這裡只驗三批合併不漏也不重複。
  const findings = checkCapabilityRegistryReconciliation(registry, gaps);
  assert(Array.isArray(findings) && findings.every((f) => f.check === 'C2'),
    `checkCapabilityRegistryReconciliation：彙整三批 findings，皆標 check='C2'（實際：${JSON.stringify(findings)}）`);
}
{
  const parsed = parseGapsArrayJson('[{"capability_id":"x"}]');
  assert(Array.isArray(parsed.gapsArray) && parsed.gapsArray.length === 1, 'parseGapsArrayJson：合法陣列 JSON → 解析成功');
}
{
  const parsed = parseGapsArrayJson('{"not":"an array"}');
  assert(typeof parsed.error === 'string', 'parseGapsArrayJson：非陣列（物件）→ error');
}
{
  const parsed = parseGapsArrayJson('not json at all {');
  assert(typeof parsed.error === 'string', 'parseGapsArrayJson：JSON 解析失敗 → error');
}

// ══════════════════════════════════════════════════════════════════════════
// C2 IO：buildC2Report——缺檔靜默略過、真實 repo 資料須零 finding
// ══════════════════════════════════════════════════════════════════════════

// 缺檔（假 repo 沒有 capability-registry.json / gaps.json）→ 靜默回傳空 findings，不報錯
{
  const dir = mkdtempSync(join(tmpdir(), 'compat-lint-c2-'));
  try {
    const { findings } = buildC2Report(dir);
    assert(Array.isArray(findings) && findings.length === 0, 'buildC2Report：兩份資料源皆缺 → 靜默略過，0 筆 finding（不是報錯）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 真實 repo 資料（--root 指向本 repo）：C2 對帳必須零 finding（任務要求：先跑過確認現況綠燈）
const REPO_ROOT = join(HERE, '..', '..', '..');
{
  const { findings } = buildC2Report(REPO_ROOT);
  assert(findings.length === 0, `buildC2Report [真實資料]：capability-registry.json ↔ gaps.json 對帳零 finding（實際：${JSON.stringify(findings)}）`);
}
{
  // 透過 buildReport 的整合路徑（真正被 CLI --root . 使用的那條路徑）也驗一次，確保 C2 真的被掛進主報告
  const report = buildReport(REPO_ROOT, {});
  const c2Findings = report.findings.filter((f) => f.check === 'C2');
  assert(c2Findings.length === 0, `buildReport [真實資料整合]：篩 check==='C2' 之後為 0 筆（實際：${JSON.stringify(c2Findings)}）`);
}

// ══════════════════════════════════════════════════════════════════════════
// C4：checkAgentTierEffortModelReconciliation——model/effort 兩維對帳（純函式）
// ══════════════════════════════════════════════════════════════════════════

// S21 正向：model 與 effort 皆與 registry 一致 → 0 筆 finding
{
  const registry = {
    agent_tiers: { referee: 'referee' },
    agent_effort: { referee: 'high' },
    model_tier: { referee: { claude: { model: 'opus' } } },
  };
  const findings = checkAgentTierEffortModelReconciliation(registry, {
    agentNames: ['referee'],
    effortByAgent: { referee: 'high' },
    modelByAgent: { referee: 'opus' },
  });
  assert(findings.length === 0, `checkAgentTierEffortModelReconciliation [S21 正向]：model/effort 皆一致 → 0 筆 finding（實際：${JSON.stringify(findings)}）`);
}
// S19 負向：model 漂移——frontmatter model 與 model_tier.claude.model 展開值不符
{
  const registry = {
    agent_tiers: { referee: 'referee' },
    agent_effort: { referee: 'high' },
    model_tier: { referee: { claude: { model: 'opus' } } },
  };
  const findings = checkAgentTierEffortModelReconciliation(registry, {
    agentNames: ['referee'],
    effortByAgent: { referee: 'high' },
    modelByAgent: { referee: 'sonnet' },
  });
  assert(
    findings.length === 1 && findings[0].check === 'C4' && findings[0].detail.includes('referee') && findings[0].detail.includes('sonnet') && findings[0].detail.includes('opus'),
    `checkAgentTierEffortModelReconciliation [S19 負向-model]：model 漂移 → 1 筆 finding 指名 agent 與雙方值（實際：${JSON.stringify(findings)}）`,
  );
}
// S20 負向：effort 漂移——frontmatter effort 與 registry agent_effort 不符
{
  const registry = {
    agent_tiers: { 'eval-judge': 'fast-readonly' },
    agent_effort: { 'eval-judge': 'low' },
    model_tier: { 'fast-readonly': { claude: { model: 'sonnet' } } },
  };
  const findings = checkAgentTierEffortModelReconciliation(registry, {
    agentNames: ['eval-judge'],
    effortByAgent: { 'eval-judge': 'medium' },
    modelByAgent: { 'eval-judge': 'sonnet' },
  });
  assert(
    findings.length === 1 && findings[0].check === 'C4' && findings[0].detail.includes('eval-judge') && findings[0].detail.includes('medium') && findings[0].detail.includes('low'),
    `checkAgentTierEffortModelReconciliation [S20 負向-effort]：effort 漂移 → 1 筆 finding 指名 agent 與雙方值（實際：${JSON.stringify(findings)}）`,
  );
}
// 對照組：agent_tiers 沒有這個 agent（鍵集合缺失）→ 略過，不誤報（該由 I8 回報）
{
  const findings = checkAgentTierEffortModelReconciliation({ agent_tiers: {}, agent_effort: {}, model_tier: {} }, {
    agentNames: ['unknown-agent'],
    effortByAgent: { 'unknown-agent': 'high' },
    modelByAgent: { 'unknown-agent': 'opus' },
  });
  assert(findings.length === 0, 'checkAgentTierEffortModelReconciliation：agent_tiers 缺鍵 → 略過不誤報（鍵集合缺失由 I8 負責）');
}

// ══════════════════════════════════════════════════════════════════════════
// C4 IO：buildC4Report——缺檔靜默略過、temp fake repo 正負向、真實 repo 須零 finding
// ══════════════════════════════════════════════════════════════════════════

function makeC4FakeRepo({ model = 'opus', effort = 'high' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'compat-lint-c4-'));
  const registry = {
    agent_tiers: { referee: 'referee' },
    agent_effort: { referee: 'high' },
    model_tier: { referee: { claude: { model: 'opus' } } },
  };
  writeFiles(dir, {
    'plugins/loops-workflow/references/capability-registry.json': JSON.stringify(registry, null, 2),
    'plugins/loops-workflow/agents/referee.md': `---\nname: referee\nmodel: ${model}\neffort: ${effort}\n---\n\n本文。`,
  });
  return dir;
}

// 缺檔（假 repo 沒有 capability-registry.json / agents/）→ 靜默回傳空 findings，不報錯
{
  const dir = mkdtempSync(join(tmpdir(), 'compat-lint-c4-empty-'));
  try {
    const { findings } = buildC4Report(dir);
    assert(Array.isArray(findings) && findings.length === 0, 'buildC4Report：兩份資料源皆缺 → 靜默略過，0 筆 finding（不是報錯）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 正向：假 repo 的 referee.md model/effort 皆與 registry 一致 → 0 筆 finding
{
  const dir = makeC4FakeRepo({});
  try {
    const { findings } = buildC4Report(dir);
    assert(findings.length === 0, `buildC4Report [正向]：假 repo model/effort 皆一致 → 0 筆 finding（實際：${JSON.stringify(findings)}）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// S19 負向（IO 整合）：手寫 agent 的 model: 值被改動 → C4 須紅並指名該 agent
{
  const dir = makeC4FakeRepo({ model: 'sonnet' });
  try {
    const { findings } = buildC4Report(dir);
    assert(
      findings.length === 1 && findings[0].check === 'C4' && findings[0].file.includes('referee.md') && findings[0].detail.includes('referee'),
      `buildC4Report [S19 負向-IO]：referee.md model 被改成 sonnet → 1 筆 C4 finding 指名 referee（實際：${JSON.stringify(findings)}）`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// S20 負向（IO 整合）：手寫 agent 的 effort: 值被改動 → C4 須紅並指名該 agent
{
  const dir = makeC4FakeRepo({ effort: 'medium' });
  try {
    const { findings } = buildC4Report(dir);
    assert(
      findings.length === 1 && findings[0].check === 'C4' && findings[0].file.includes('referee.md') && findings[0].detail.includes('referee'),
      `buildC4Report [S20 負向-IO]：referee.md effort 被改成 medium → 1 筆 C4 finding 指名 referee（實際：${JSON.stringify(findings)}）`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 真實 repo 資料：C4 對帳必須零 finding（25 支 agents，21 支生成恆真、4 支手寫現況一致）
{
  const { findings } = buildC4Report(REPO_ROOT);
  assert(findings.length === 0, `buildC4Report [真實資料]：capability-registry.json ↔ agents/*.md 對帳零 finding（實際：${JSON.stringify(findings)}）`);
}
{
  // 透過 buildReport 的整合路徑再驗一次，確保 C4 真的被掛進主報告
  const report = buildReport(REPO_ROOT, {});
  const c4Findings = report.findings.filter((f) => f.check === 'C4');
  assert(c4Findings.length === 0, `buildReport [真實資料整合]：篩 check==='C4' 之後為 0 筆（實際：${JSON.stringify(c4Findings)}）`);
}

// ══════════════════════════════════════════════════════════════════════════
// C5：checkRuntimeOverrideCorrespondence（純函式）——scoped span ↔ overrides[] 雙向對帳
// ══════════════════════════════════════════════════════════════════════════

// 正向：span 有 id 且對應到某筆 override → 0 筆 finding
{
  const spans = [{ file: 'references/x.md', line: 3, runtime: 'codex', id: 'foo' }];
  const overrides = [{ id: 'foo', owner: 'o', rationale: 'r', test_ref: 't' }];
  const findings = checkRuntimeOverrideCorrespondence(spans, overrides);
  assert(findings.length === 0, `checkRuntimeOverrideCorrespondence [C5 正向]：span/override id 對得上 → 0 筆 finding（實際：${JSON.stringify(findings)}）`);
}
// 負向①：span 缺 id → 孤兒（無法對應任何 override）。overrides 刻意留空，隔離「缺 id」這個
// 現象本身，不讓另一筆 override 的懸空 finding 混進來干擾這條斷言。
{
  const spans = [{ file: 'references/x.md', line: 5, runtime: 'codex', id: null }];
  const findings = checkRuntimeOverrideCorrespondence(spans, []);
  assert(
    findings.length === 1 && findings[0].check === 'C5' && findings[0].file === 'references/x.md' && findings[0].detail.includes('缺少 id'),
    `checkRuntimeOverrideCorrespondence [C5 負向①-缺id]：span 無 id → 1 筆 finding 標「缺少 id」（實際：${JSON.stringify(findings)}）`,
  );
}
// 負向②：span 有 id，但 registry overrides 找不到對應筆（overrides 為空，或 id 不存在）→ 孤兒
{
  const spans = [{ file: 'references/x.md', line: 7, runtime: 'codex', id: 'orphan-id' }];
  const findings = checkRuntimeOverrideCorrespondence(spans, []);
  assert(
    findings.length === 1 && findings[0].check === 'C5' && findings[0].detail.includes('orphan-id') && findings[0].detail.includes('孤兒'),
    `checkRuntimeOverrideCorrespondence [C5 負向②-overrides為空]：span 有 id 但 overrides[] 空 → 1 筆孤兒 finding（實際：${JSON.stringify(findings)}）`,
  );
}
// 負向③：override 有 id，但沒有任何 span 使用過 → 懸空
{
  const overrides = [{ id: 'unused-id', owner: 'o', rationale: 'r', test_ref: 't' }];
  const findings = checkRuntimeOverrideCorrespondence([], overrides);
  assert(
    findings.length === 1 && findings[0].check === 'C5' && findings[0].detail.includes('unused-id') && findings[0].detail.includes('懸空'),
    `checkRuntimeOverrideCorrespondence [C5 負向③-懸空]：override 無任何 span 使用 → 1 筆懸空 finding（實際：${JSON.stringify(findings)}）`,
  );
}
// 對照組：override 無 id（欄位缺失）→ C5 略過不誤報，那是 check-registry-shape.mjs I15 的職責
{
  const overrides = [{ owner: 'o', rationale: 'r', test_ref: 't' }];
  const findings = checkRuntimeOverrideCorrespondence([], overrides);
  assert(findings.length === 0, 'checkRuntimeOverrideCorrespondence：override 缺 id → C5 不誤報（欄位完整性由 I15 負責）');
}

// ══════════════════════════════════════════════════════════════════════════
// C5 IO：buildC5Report——缺 registry 靜默略過、temp fake repo 正負向、真實 repo 須零 finding
// ══════════════════════════════════════════════════════════════════════════

function makeC5FakeRepo({ overrides, docText }) {
  const dir = mkdtempSync(join(tmpdir(), 'compat-lint-c5-'));
  const registry = { facets: {}, overrides };
  writeFiles(dir, {
    'plugins/loops-workflow/references/capability-registry.json': JSON.stringify(registry, null, 2),
    'plugins/loops-workflow/references/doc.md': docText,
  });
  return dir;
}

// 缺 registry（假 repo 沒有 capability-registry.json）→ 靜默回傳空 findings，不報錯
{
  const dir = mkdtempSync(join(tmpdir(), 'compat-lint-c5-empty-'));
  try {
    const { findings } = buildC5Report(dir);
    assert(Array.isArray(findings) && findings.length === 0, 'buildC5Report：registry 缺檔 → 靜默略過，0 筆 finding（不是報錯）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 正向：散文的 scoped span id 與 registry override id 對得上 → 0 筆 finding
{
  const dir = makeC5FakeRepo({
    overrides: [{ id: 'demo-override', owner: 'o', rationale: 'r', test_ref: 't' }],
    docText: '前文\n<!-- runtime: codex id=demo-override -->\n平台專屬敘述。\n<!-- /runtime -->\n後文',
  });
  try {
    const { findings } = buildC5Report(dir);
    assert(findings.length === 0, `buildC5Report [正向]：span/override id 對得上 → 0 筆 finding（實際：${JSON.stringify(findings)}）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 負向 fixture①：overrides[] 清空 → 散文裡的 scoped span 變孤兒 → C5 須紅
{
  const dir = makeC5FakeRepo({
    overrides: [],
    docText: '<!-- runtime: codex id=demo-override -->\n平台專屬敘述。\n<!-- /runtime -->',
  });
  try {
    const { findings } = buildC5Report(dir);
    assert(
      findings.length === 1 && findings[0].check === 'C5' && findings[0].detail.includes('孤兒'),
      `buildC5Report [負向①-overrides清空]：overrides 為空、散文仍有 scoped span → 1 筆孤兒 finding（實際：${JSON.stringify(findings)}）`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 負向 fixture②：散文裡放一個沒有對應 override 的 scoped span（id 對不上既有 override）→ C5 須紅
{
  const dir = makeC5FakeRepo({
    overrides: [{ id: 'some-other-override', owner: 'o', rationale: 'r', test_ref: 't' }],
    docText: '<!-- runtime: codex id=no-such-override -->\n平台專屬敘述。\n<!-- /runtime -->',
  });
  try {
    const { findings } = buildC5Report(dir);
    assert(
      findings.some((f) => f.check === 'C5' && f.detail.includes('no-such-override') && f.detail.includes('孤兒'))
        && findings.some((f) => f.check === 'C5' && f.detail.includes('some-other-override') && f.detail.includes('懸空')),
      `buildC5Report [負向②-span無對應override]：span 的 id 找不到對應 override（孤兒）且該 override 本身也懸空（實際：${JSON.stringify(findings)}）`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 負向 fixture③：overrides 有一筆，但散文完全找不到使用 → 懸空 → C5 須紅
{
  const dir = makeC5FakeRepo({
    overrides: [{ id: 'never-used', owner: 'o', rationale: 'r', test_ref: 't' }],
    docText: '這份文件完全沒有任何 runtime scoped span。',
  });
  try {
    const { findings } = buildC5Report(dir);
    assert(
      findings.length === 1 && findings[0].check === 'C5' && findings[0].detail.includes('never-used') && findings[0].detail.includes('懸空'),
      `buildC5Report [負向③-懸空override]：registry 有 override 但散文無使用處 → 1 筆懸空 finding（實際：${JSON.stringify(findings)}）`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 真實 repo 資料：C5 對帳必須零 finding（interaction-adapter.md 的 codex-request-user-input-shape
// 是本次 T30 補的第一個真實 scoped override 使用，見 plan T30 §2）
{
  const { findings } = buildC5Report(REPO_ROOT);
  assert(findings.length === 0, `buildC5Report [真實資料]：canonical 散文 ↔ capability-registry.json overrides[] 對帳零 finding（實際：${JSON.stringify(findings)}）`);
}
{
  const report = buildReport(REPO_ROOT, {});
  const c5Findings = report.findings.filter((f) => f.check === 'C5');
  assert(c5Findings.length === 0, `buildReport [真實資料整合]：篩 check==='C5' 之後為 0 筆（實際：${JSON.stringify(c5Findings)}）`);
}

// ══════════════════════════════════════════════════════════════════════════
// C6：aliasMatcherTokens / deepEqualJson / projectHooksToCodex / checkHooksCodexProjectionDrift
// （純函式）——hooks-codex.json 投影漂移檢查（#183 T25）
// ══════════════════════════════════════════════════════════════════════════

{
  assert(aliasMatcherTokens('Write|Edit|MultiEdit', { Edit: 'apply_patch', Write: 'apply_patch' }) === 'apply_patch|MultiEdit',
    'aliasMatcherTokens：Write/Edit 別名成 apply_patch 並去重，MultiEdit 無別名原樣保留 [C6-1a]');
  assert(aliasMatcherTokens('Edit|Write', { Edit: 'apply_patch', Write: 'apply_patch' }) === 'apply_patch',
    'aliasMatcherTokens：兩個 token 皆別名成同一目標 → 去重成單一 token [C6-1b]');
  assert(aliasMatcherTokens('Bash|PowerShell', { Edit: 'apply_patch', Write: 'apply_patch' }) === 'Bash|PowerShell',
    'aliasMatcherTokens：不在別名表的 token 原樣保留 [C6-1c]');
  const regexMatcher = '.*(update_pull_request|request_copilot_review).*';
  assert(aliasMatcherTokens(regexMatcher, { Edit: 'apply_patch' }) === regexMatcher,
    'aliasMatcherTokens：含正則特殊字元的 matcher 視為非工具名 pipe-list，原樣保留 [C6-1d]');
}
{
  assert(deepEqualJson({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }) === true, 'deepEqualJson：鍵順序不敏感的結構相等 → true [C6-2a]');
  assert(deepEqualJson({ a: 1 }, { a: 2 }) === false, 'deepEqualJson：值不同 → false [C6-2b]');
  assert(deepEqualJson({ a: [1, 2] }, { a: [1, 2, 3] }) === false, 'deepEqualJson：陣列長度不同 → false [C6-2c]');
}
{
  const hooksJson = {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'node a.mjs' }] }],
      PreToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: 'node b.mjs' }] }],
    },
  };
  const mappingRules = { matcher_tool_alias: { Edit: 'apply_patch', Write: 'apply_patch' } };
  const projected = projectHooksToCodex(hooksJson, mappingRules);
  assert(
    projected.PreToolUse[0].matcher === 'apply_patch|MultiEdit' && projected.SessionStart[0].hooks[0].command === 'node a.mjs',
    `projectHooksToCodex：matcher 依別名表投影、無 matcher 的區塊與 command 原樣保留（實際：${JSON.stringify(projected)}）[C6-3a]`,
  );
}
// 正向：actual 與 expectedHooks 結構相等、_meta 三欄位齊全 → 0 筆 finding
{
  const expectedHooks = { SessionStart: [{ hooks: [{ type: 'command', command: 'x' }] }] };
  const actual = { _meta: { generated: true, warning: 'w', verification_status: 'v' }, hooks: expectedHooks };
  const findings = checkHooksCodexProjectionDrift(actual, expectedHooks);
  assert(findings.length === 0, `checkHooksCodexProjectionDrift [C6 正向]：結構相等且 _meta 齊全 → 0 筆 finding（實際：${JSON.stringify(findings)}）`);
}
// 負向①：hooks 結構被手改（matcher 不同）→ 1 筆 finding
{
  const expectedHooks = { PreToolUse: [{ matcher: 'apply_patch', hooks: [] }] };
  const actual = { _meta: { generated: true, warning: 'w', verification_status: 'v' }, hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [] }] } };
  const findings = checkHooksCodexProjectionDrift(actual, expectedHooks);
  assert(findings.length === 1 && findings[0].check === 'C6' && findings[0].detail.includes('drift'),
    `checkHooksCodexProjectionDrift [C6 負向①-hooks漂移]：matcher 被手改 → 1 筆 finding（實際：${JSON.stringify(findings)}）`);
}
// 負向②：_meta 誠實標記被拿掉（generated 缺失）→ 1 筆 finding
{
  const expectedHooks = { SessionStart: [] };
  const actual = { _meta: { warning: 'w', verification_status: 'v' }, hooks: expectedHooks };
  const findings = checkHooksCodexProjectionDrift(actual, expectedHooks);
  assert(findings.length === 1 && findings[0].check === 'C6' && findings[0].detail.includes('_meta'),
    `checkHooksCodexProjectionDrift [C6 負向②-meta缺失]：generated 欄位被拿掉 → 1 筆 finding（實際：${JSON.stringify(findings)}）`);
}

// ══════════════════════════════════════════════════════════════════════════
// C6 IO：buildC6Report——缺檔靜默略過、temp fake repo 正負向、真實 repo 須零 finding
// ══════════════════════════════════════════════════════════════════════════

function makeC6FakeRepo({ hooksJson, hooksCodexJson, registry }) {
  const dir = mkdtempSync(join(tmpdir(), 'compat-lint-c6-'));
  writeFiles(dir, {
    'plugins/loops-workflow/hooks/hooks.json': JSON.stringify(hooksJson, null, 2),
    'plugins/loops-workflow/hooks/hooks-codex.json': JSON.stringify(hooksCodexJson, null, 2),
    'plugins/loops-workflow/references/capability-registry.json': JSON.stringify(registry, null, 2),
  });
  return dir;
}

const C6_HOOKS_JSON = {
  hooks: {
    PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'node guard.mjs' }] }],
  },
};
const C6_REGISTRY = {
  facets: {
    hook_events: {
      gaps_refs: [],
      rationale_if_no_gaps_ref: 'C6 fixture 用途，不對帳真實 gaps',
      platforms: { codex: { status: 'not_measured', measurability: 'needs_auth', projection_mapping: { matcher_tool_alias: { Edit: 'apply_patch', Write: 'apply_patch' } } } },
    },
  },
};
const C6_META = { generated: true, warning: 'w', verification_status: 'v' };
function c6ExpectedProjection() {
  return { PreToolUse: [{ matcher: 'apply_patch', hooks: [{ type: 'command', command: 'node guard.mjs' }] }] };
}

// 缺檔（假 repo 沒有 hooks-codex.json）→ 靜默回傳空 findings，不報錯
{
  const dir = mkdtempSync(join(tmpdir(), 'compat-lint-c6-empty-'));
  try {
    const { findings } = buildC6Report(dir);
    assert(Array.isArray(findings) && findings.length === 0, 'buildC6Report：資料源缺檔 → 靜默略過，0 筆 finding（不是報錯）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 正向：投影檔與正本+registry 推導結果一致 → 0 筆 finding
{
  const dir = makeC6FakeRepo({ hooksJson: C6_HOOKS_JSON, hooksCodexJson: { _meta: C6_META, hooks: c6ExpectedProjection() }, registry: C6_REGISTRY });
  try {
    const { findings } = buildC6Report(dir);
    assert(findings.length === 0, `buildC6Report [正向]：投影與推導結果一致 → 0 筆 finding（實際：${JSON.stringify(findings)}）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 負向：手改投影檔的 matcher 欄位 → C6 須紅
{
  const tampered = { _meta: C6_META, hooks: { PreToolUse: [{ matcher: 'apply_patch|SomethingElse', hooks: [{ type: 'command', command: 'node guard.mjs' }] }] } };
  const dir = makeC6FakeRepo({ hooksJson: C6_HOOKS_JSON, hooksCodexJson: tampered, registry: C6_REGISTRY });
  try {
    const { findings } = buildC6Report(dir);
    assert(
      findings.length === 1 && findings[0].check === 'C6' && findings[0].detail.includes('drift'),
      `buildC6Report [負向-手改matcher]：投影檔 matcher 被手改 → 1 筆 C6 finding（實際：${JSON.stringify(findings)}）`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 真實 repo 資料：C6 對帳必須零 finding
{
  const { findings } = buildC6Report(REPO_ROOT);
  assert(findings.length === 0, `buildC6Report [真實資料]：hooks-codex.json ↔ hooks.json+registry 投影對帳零 finding（實際：${JSON.stringify(findings)}）`);
}
{
  const report = buildReport(REPO_ROOT, {});
  const c6Findings = report.findings.filter((f) => f.check === 'C6');
  assert(c6Findings.length === 0, `buildReport [真實資料整合]：篩 check==='C6' 之後為 0 筆（實際：${JSON.stringify(c6Findings)}）`);
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.error('\n失敗清單：');
  for (const msg of failed) console.error(`  - ${msg}`);
  process.exit(1);
}
process.exit(0);
