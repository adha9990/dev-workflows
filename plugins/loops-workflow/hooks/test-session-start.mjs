#!/usr/bin/env node
// test-session-start.mjs —— session-start.mjs（active-loop 浮出 hook）特徵斷言
// （自帶極簡 harness，仿同目錄 test-cost-hooks.mjs / test-stop-gate.mjs，不引測試框架）。
//
// 用法（cwd = plugins/loops-workflow）：node hooks/test-session-start.mjs
// 全綠 → exit 0；任一斷言失敗 → exit 1（主線用此 exit code 判紅綠）。
//
// 覆蓋：S1 active-loop 提醒逐字特徵＋#84 死指令錨定（單一入口 dispatch）；
// S5 worktree 掃描分支；S6 markdown 表格欄位解析分支；
// S7～S9（#135 T2）lastJournalLine cap：恰 200 字元不截斷／201 字元截斷／超長（>1,000）仍只截前 200。
// （原 instinct 注入相關案例已隨 instinct 功能鏈於 #95 整條移除。）

import {
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION_START_SCRIPT = join(HERE, 'session-start.mjs'); // 真跑的 hook（smoke）

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

// =============================================================================
// SMOKE：真 spawn session-start.mjs 子行程（real-not-mock：真讀 .loops/、驗 stdout 最終輸出）
// session-start 讀 process.cwd() 掃 .loops/，故 spawn 以 cwd=暫存目錄。每 smoke mkdtemp+rmSync 冪等。
// =============================================================================

// ── active-loop 逐字格式的已知值（DAMP：測試自帶規格，逐字斷言才釘得住 formatLoopLine 契約）──
// inline（「label：value」行）格式的欄位值——各 smoke 共用這份預設，數值不可變。
const LOOP_STAGE = 'goal'; // 當前階段
const LOOP_MODE = 'closed'; // 推進模式
const LOOP_JOURNAL = '- [E1] 初始化迴圈目標'; // 最後一條 Journal（無前後空白 → trim 後不變）
// markdown 表格格式（pickLoopField 的 table-row 分支）專用欄位值——刻意與 inline 不同，
// 以證明「值確實由表格列抽出」而非沿用 inline 預設。
const TABLE_STAGE = 'verify';
const TABLE_MODE = 'open';
const TABLE_JOURNAL = '- [E1] table 格式初始化迴圈';
// worktree 迴圈的 Journal（與主 repo 迴圈不同，便於逐字辨識來源）。
const WORKTREE_JOURNAL = '- [E2] worktree 迴圈進度';

// loop.md 內容組裝：inline =「label：value」行；table = markdown 表格列。
function inlineLoopMd(slug, journal = LOOP_JOURNAL) {
  return [
    `# ${slug}`,
    '',
    `當前階段：${LOOP_STAGE}`,
    `推進模式：${LOOP_MODE}`,
    '',
    '## Journal',
    journal,
    '',
  ].join('\n');
}
function tableLoopMd(slug) {
  return [
    `# ${slug}`,
    '',
    '| 欄位 | 內容 |',
    '| --- | --- |',
    `| 當前階段 | ${TABLE_STAGE} |`,
    `| 推進模式 | ${TABLE_MODE} |`,
    '',
    '## Journal',
    TABLE_JOURNAL,
    '',
  ].join('\n');
}

// 預期的 per-loop 提醒行（逐字鏡射 session-start.mjs::formatLoopLine，分隔符為全形｜與：）。
function expectedInlineLine(slug, journal = LOOP_JOURNAL) {
  return `  - ${slug}｜階段：${LOOP_STAGE}｜模式：${LOOP_MODE}｜最後：${journal}`;
}
function expectedTableLine(slug) {
  return `  - ${slug}｜階段：${TABLE_STAGE}｜模式：${TABLE_MODE}｜最後：${TABLE_JOURNAL}`;
}
// 預期的 active-loop 區塊標頭（逐字鏡射 formatActiveLoopsHeader，含偵測到的 count）。
function expectedActiveHeader(count) {
  return `[loops-workflow] 偵測到 ${count} 個 active 迴圈（.loops/ 含 worktree）。可用 /loops-workflow:dispatch <slug> 接續、或直接讀 .loops/<slug>/PROGRESS.md 看詳情：`;
}

function makeLoopCwd({
  withLoop = true,
  slug = 'demo-feature',
  format = 'inline', // 'inline' |「label：value」行；'table' | markdown 表格列
  journal = LOOP_JOURNAL, // inline 格式專用：覆寫 Journal 內容（table 格式固定用 TABLE_JOURNAL，不受此影響）
  worktreeLoop = null, // {wt, slug}：額外在 .claude/worktrees/<wt>/.loops/<slug>/ 建迴圈
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'session-start-smoke-'));
  if (withLoop) {
    const loopDir = join(dir, '.loops', slug);
    mkdirSync(loopDir, { recursive: true });
    // 重構特徵測試的已知 active-loop 形狀：當前階段 + 推進模式 + 一行 Journal。
    writeFileSync(
      join(loopDir, 'loop.md'),
      format === 'table' ? tableLoopMd(slug) : inlineLoopMd(slug, journal),
    );
  }
  if (worktreeLoop) {
    // 主 repo 開的 session 也要看得到 worktree 底下在跑的迴圈（collectLoopRoots 的 worktree 分支）。
    const wtLoopDir = join(dir, '.claude', 'worktrees', worktreeLoop.wt, '.loops', worktreeLoop.slug);
    mkdirSync(wtLoopDir, { recursive: true });
    writeFileSync(join(wtLoopDir, 'loop.md'), inlineLoopMd(worktreeLoop.slug, WORKTREE_JOURNAL));
  }
  return { dir, slug };
}

function runSessionStart(cwd, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  return spawnSync(process.execPath, [SESSION_START_SCRIPT], {
    cwd,
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd }),
    env,
    encoding: 'utf8',
  });
}

const out = (res) => (typeof res.stdout === 'string' ? res.stdout : '');

// ── S1（重構特徵測試）：有 active loop → stdout 仍含「active 迴圈」+ slug（既有行為不可消失）──
{
  const { dir, slug } = makeLoopCwd({ withLoop: true, slug: 'feat-active' });
  try {
    const res = runSessionStart(dir);
    assert(res.error == null, 'S1：node 啟動成功（spawn 無 error）[S1]');
    assert(res.status === 0, 'S1：exit 0 [S1]');
    assert(out(res).includes('active 迴圈'),
      'S1：重構後 stdout 仍含「active 迴圈」（既有 active-loop 提醒不可因重構消失）[S1]');
    assert(out(res).includes(slug), 'S1：stdout 含該 active loop 的 slug（feat-active）[S1]');
    // F2-a 逐字特徵：per-loop 行整行逐字釘死（slug｜階段｜模式｜最後 Journal）。
    assert(out(res).includes(expectedInlineLine(slug)),
      'S1：stdout 含完整 per-loop 行「  - feat-active｜階段：goal｜模式：closed｜最後：- [E1] 初始化迴圈目標」（formatLoopLine 逐字）[S1]');
    // F2-a 標頭含偵測到的 count（單一迴圈 → 偵測到 1 個）+ 整行逐字。
    assert(out(res).includes('偵測到 1 個'),
      'S1：active-loop 標頭含「偵測到 1 個」（count 正確）[S1]');
    assert(out(res).includes(expectedActiveHeader(1)),
      'S1：active-loop 標頭整行逐字（formatActiveLoopsHeader(1)）[S1]');
    // 錨定外部事實（非鏡射）：標頭不得引用已刪除的 command（#84 指令面收斂後 dispatch 是唯一入口）——
    // 防「來源與鏡射字串同時改成同一個錯值」的雙綠假陽性。
    for (const dead of ['loops-workflow:resume', 'loops-workflow:status', 'loops-workflow:progress', 'loops-workflow:loop ']) {
      assert(!out(res).includes(dead),
        `S1：active-loop 提示不含已刪除指令「${dead.trim()}」（單一入口錨定）[S1]`);
    }
    assert(out(res).includes('loops-workflow:dispatch'),
      'S1：active-loop 提示指向唯一入口 dispatch（錨定）[S1]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── S5（worktree 掃描）：主 repo 迴圈 + .claude/worktrees/<wt>/.loops/<slug>/ 迴圈都要被偵測 + 計數 ──
//    守 collectLoopRoots 的 worktree 分支：若該分支不存在，worktree 迴圈消失、count 退回 1 → 紅。
{
  const mainSlug = 'feat-main';
  const wtSlug = 'feat-wt';
  const { dir } = makeLoopCwd({
    withLoop: true,
    slug: mainSlug,
    worktreeLoop: { wt: 'wt-alpha', slug: wtSlug },
  });
  try {
    const res = runSessionStart(dir); // 純看 active-loop 掃描
    assert(res.error == null, 'S5：spawn 無 error [S5]');
    assert(res.status === 0, 'S5：exit 0 [S5]');
    assert(out(res).includes(mainSlug),
      'S5：stdout 含主 repo 迴圈 slug（feat-main）[S5]');
    assert(out(res).includes(wtSlug),
      'S5：stdout 含 worktree 迴圈 slug（feat-wt，來自 .claude/worktrees/wt-alpha/.loops）[S5]');
    assert(out(res).includes(expectedInlineLine(wtSlug, WORKTREE_JOURNAL)),
      'S5：worktree 迴圈整行逐字（含其專屬 Journal「- [E2] worktree 迴圈進度」）[S5]');
    assert(out(res).includes('偵測到 2 個'),
      'S5：主 repo + worktree 兩迴圈皆計入 count（標頭「偵測到 2 個」）[S5]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── S6（markdown 表格分支）：欄位以表格列寫 → pickLoopField 的 table-row 正則要抽得出值 ──
//    守 pickLoopField 的 table 分支（既有測試零覆蓋）：loop.md 只用表格列、無「label：value」行，
//    若 table 分支壞掉，inline 正則因無冒號而落空 → 階段值變 '?' → 逐字斷言紅。
{
  const slug = 'feat-table';
  const { dir } = makeLoopCwd({ withLoop: true, slug, format: 'table' });
  try {
    const res = runSessionStart(dir);
    assert(res.error == null, 'S6：spawn 無 error [S6]');
    assert(res.status === 0, 'S6：exit 0 [S6]');
    assert(out(res).includes('階段：verify'),
      'S6：表格列「| 當前階段 | verify |」→ 階段值由 table 分支抽出為 verify（非 "?"）[S6]');
    assert(out(res).includes(expectedTableLine(slug)),
      'S6：表格格式 loop.md 的整行逐字（階段：verify｜模式：open，table 分支）[S6]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// =============================================================================
// S7～S9（#135 T2：lastJournalLine cap）：journal 內容（loop.md 最後一條 `- [E\d+] …`
// 行、trim 後）字元數 > 200 才截斷；截斷輸出＝前 200 字元 + 截斷記號（記號本身不占 200
// 預算）；行格式前綴（slug｜階段｜模式｜最後：）不變，cap 只作用於 journal 子字串。
// 短行回歸（LOOP_JOURNAL／TABLE_JOURNAL 均遠短於 200 字元、原樣輸出無記號）已由既有
// S1／S5／S6 斷言覆蓋（expectedInlineLine／expectedTableLine 皆逐字比對、無截斷記號），
// 此處不重複建案例。
// =============================================================================

const CAP_LIMIT = 200;
const CAP_MARKER = '…（截斷；完整 Journal 見該 loop.md）'; // 記號本身不計入 200 字元預算
const CAP_FILLER = 'あ'; // 全形字元、非代理對（surrogate pair）；UTF-16 code unit 與 code point 計數一致，避免計數方式歧義
const CAP_PREFIX = '- [E1] '; // 7 字元；contract 明定構造時把此前綴算進 200 字元預算

// 恰 200 字元（含 CAP_PREFIX）＝ 7 + 193 個填充字元。
const CAP_JOURNAL_200 = CAP_PREFIX + CAP_FILLER.repeat(193);
// 201 字元＝ CAP_JOURNAL_200 多一個填充字元；其前 200 字元與 CAP_JOURNAL_200 逐字相同。
const CAP_JOURNAL_201 = CAP_JOURNAL_200 + CAP_FILLER;
// 超長（>1,000 字）＝ CAP_JOURNAL_200 重複 10 次（2,000 字元）；其前 200 字元仍與 CAP_JOURNAL_200 逐字相同。
const CAP_JOURNAL_LONG = CAP_JOURNAL_200.repeat(10);

// 預期的「截斷後」per-loop 行：前綴不變 + journal 前 200 字元 + 截斷記號（逐字鏡射 S1 的 expectedInlineLine 慣例）。
function expectedTruncatedInlineLine(slug, fullJournal) {
  return `  - ${slug}｜階段：${LOOP_STAGE}｜模式：${LOOP_MODE}｜最後：${fullJournal.slice(0, CAP_LIMIT)}${CAP_MARKER}`;
}
// per-loop 行的固定前綴（不含 journal 內容）——單獨驗「cap 只作用於 journal 子字串」（契約項 5）。
function expectedLinePrefix(slug) {
  return `  - ${slug}｜階段：${LOOP_STAGE}｜模式：${LOOP_MODE}｜最後：`;
}

// ── S7（邊界＝恰 200 字元）：journal 長度＝CAP_LIMIT → 原樣輸出、無截斷記號 ──
//    注意：cap 未實作前，目前行為（原樣輸出不截斷任何長度）在此邊界本就會通過——
//    這不是「意外變綠」，而是此邊界的本質（未截斷 vs 尚未實作截斷在此重合）；
//    S7 鎖的是「未來實作不可用 >= 200 誤判、把恰 200 也截掉」的迴歸，非本輪紅燈來源。
{
  const slug = 'feat-cap-200';
  const { dir } = makeLoopCwd({ withLoop: true, slug, journal: CAP_JOURNAL_200 });
  try {
    const res = runSessionStart(dir);
    assert(res.error == null, 'S7：spawn 無 error [S7]');
    assert(res.status === 0, 'S7：exit 0 [S7]');
    assert(CAP_JOURNAL_200.length === CAP_LIMIT,
      'S7：fixture 前提——CAP_JOURNAL_200 本身確為 200 字元（含 CAP_PREFIX 7 字元）[S7]');
    assert(out(res).includes(expectedInlineLine(slug, CAP_JOURNAL_200)),
      'S7：恰 200 字元 journal → 原樣輸出、無截斷記號（邊界，cap 條件為 >200 非 >=200）[S7]');
    assert(!out(res).includes(CAP_MARKER),
      'S7：恰 200 字元不觸發截斷記號（stdout 全文不含截斷記號）[S7]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── S8（邊界＝201 字元）：journal 長度＝CAP_LIMIT+1 → 前 200 字元＋截斷記號 ──
{
  const slug = 'feat-cap-201';
  const { dir } = makeLoopCwd({ withLoop: true, slug, journal: CAP_JOURNAL_201 });
  try {
    const res = runSessionStart(dir);
    assert(res.error == null, 'S8：spawn 無 error [S8]');
    assert(res.status === 0, 'S8：exit 0 [S8]');
    assert(CAP_JOURNAL_201.length === CAP_LIMIT + 1,
      'S8：fixture 前提——CAP_JOURNAL_201 本身確為 201 字元 [S8]');
    assert(out(res).includes(expectedTruncatedInlineLine(slug, CAP_JOURNAL_201)),
      'S8：201 字元 journal → 前 200 字元＋截斷記號（記號不計入 200 預算，剛好越界 1 字元即觸發）[S8]');
    assert(out(res).includes(expectedLinePrefix(slug)),
      'S8：截斷後行格式前綴（slug｜階段｜模式｜最後：）不變，cap 只作用於 journal 子字串 [S8]');
    assert(!out(res).includes(CAP_JOURNAL_201),
      'S8：stdout 不含未截斷的完整 201 字元 journal（確實被截短，非原樣輸出）[S8]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── S9（超長 >1,000 字）：journal 長度 2,000 字元 → 仍只截前 200 字元＋截斷記號（非等比例截法）──
{
  const slug = 'feat-cap-long';
  const { dir } = makeLoopCwd({ withLoop: true, slug, journal: CAP_JOURNAL_LONG });
  try {
    const res = runSessionStart(dir);
    assert(res.error == null, 'S9：spawn 無 error [S9]');
    assert(res.status === 0, 'S9：exit 0 [S9]');
    assert(CAP_JOURNAL_LONG.length > 1000,
      'S9：fixture 前提——CAP_JOURNAL_LONG 本身超過 1,000 字元 [S9]');
    assert(out(res).includes(expectedTruncatedInlineLine(slug, CAP_JOURNAL_LONG)),
      'S9：超長（2,000 字元）journal → 仍只取前 200 字元＋截斷記號（固定 cap，非依全長比例截斷）[S9]');
    assert(out(res).includes(expectedLinePrefix(slug)),
      'S9：截斷後行格式前綴不變 [S9]');
    assert(!out(res).includes(CAP_JOURNAL_LONG),
      'S9：stdout 不含未截斷的完整超長 journal [S9]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 摘要 + exit code ─────────────────────────────────────────────────────────
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
