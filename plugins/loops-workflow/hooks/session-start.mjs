#!/usr/bin/env node
// loops-workflow SessionStart hook。
// 掃 CWD 的 .loops/ **以及 .claude/worktrees/*/.loops/** —— 在主 repo 開的 session 也看得到
// 底下 worktree 在跑的迴圈。有 active 迴圈就印一段提醒當 session context，輔助 resume。
// 沒有就靜默退出（不製造噪音）。唯讀、不改任何檔。
//
// 分層（仿 cost-tracker.mjs / scripts/loops-quality-gate.mjs）：
//   1) 純 helper（無 IO）：active-loop 文案組裝（pickLoopField / formatLoopLine / …）。
//   2) IO 薄邊界：main()（掃 .loops/、讀檔、輸出 context）——被 import 時不執行
//      （import.meta.url 守門），任何錯誤一律吞掉 exit 0，永不擋住 session 啟動。
// 依賴：僅 node 內建（fs / path / url），零外部套件。

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── active-loop 文案組裝（純 helper，輸出字串逐字不變）──────────────────────────────

/** loop.md 內抽某欄位：先試 markdown 表格列、再試「label：value」行，皆無 → '?'。 */
function pickLoopField(md, label) {
  const tableRow = md.match(new RegExp(`${label}[^\\n|]*\\|\\s*([^|\\n]+?)\\s*\\|`));
  if (tableRow) return tableRow[1].trim();
  const inlineLine = md.match(new RegExp(`${label}[：:]\\s*([^\\n]+)`));
  return inlineLine ? inlineLine[1].trim() : '?';
}

/** journal 內容 cap（#135）：>200 字元才截斷（恰 200 原樣）；截斷記號不計入預算。 */
const MAX_JOURNAL_LINE_CHARS = 200;
const JOURNAL_TRUNCATION_MARKER = '…（截斷；完整 Journal 見該 loop.md）';

/** loop.md 內最後一條 Journal 行（- [E\d+] …）；無 → '(無 Journal)'；超過 cap 截前 200 字元＋記號。 */
function lastJournalLine(md) {
  const journalLines = md.split('\n').filter((line) => /^\s*-\s*\[E\d+\]/.test(line));
  if (!journalLines.length) return '(無 Journal)';
  const last = journalLines[journalLines.length - 1].trim();
  return last.length > MAX_JOURNAL_LINE_CHARS
    ? last.slice(0, MAX_JOURNAL_LINE_CHARS) + JOURNAL_TRUNCATION_MARKER
    : last;
}

/** 單一 active loop 的提醒行（字串格式為既有特徵測試所釘，不可變）。 */
function formatLoopLine(slug, md) {
  return `  - ${slug}｜階段：${pickLoopField(md, '當前階段')}｜模式：${pickLoopField(md, '推進模式')}｜最後：${lastJournalLine(md)}`;
}

/** active loop 區塊的標頭行（含偵測到的迴圈數）。 */
function formatActiveLoopsHeader(count) {
  return `[loops-workflow] 偵測到 ${count} 個 active 迴圈（.loops/ 含 worktree）。可用 /loops-workflow:dispatch <slug> 接續、或直接讀 .loops/<slug>/PROGRESS.md 看詳情：`;
}

// ── IO 薄邊界：掃描 + 讀檔（被 main 編排）─────────────────────────────────────────

const safeReaddir = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return []; // 目錄不存在 / 讀不到 → 視為空，不崩
  }
};

const safeReadFile = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return ''; // 單檔讀不到 → 視為空，不影響其他檔
  }
};

/** 要掃的 .loops/ 根目錄：cwd/.loops ＋ cwd/.claude/worktrees/* /.loops。 */
function collectLoopRoots(cwd) {
  const roots = [];
  const mainRoot = join(cwd, '.loops');
  if (existsSync(mainRoot)) roots.push(mainRoot);

  const worktreeBase = join(cwd, '.claude', 'worktrees');
  if (existsSync(worktreeBase)) {
    for (const worktree of safeReaddir(worktreeBase)) {
      const worktreeRoot = join(worktreeBase, worktree, '.loops');
      if (existsSync(worktreeRoot)) roots.push(worktreeRoot);
    }
  }
  return roots;
}

/** 掃所有根目錄下含 loop.md 的子目錄 → [{slug, mdPath}]。 */
function collectLoopEntries(cwd) {
  const entries = [];
  for (const root of collectLoopRoots(cwd)) {
    for (const slug of safeReaddir(root)) {
      try {
        const mdPath = join(root, slug, 'loop.md');
        if (statSync(join(root, slug)).isDirectory() && existsSync(mdPath)) {
          entries.push({ slug, mdPath });
        }
      } catch {
        // 單一子目錄 stat 失敗 → 跳過，續掃其餘
      }
    }
  }
  return entries;
}

/** 印出 active-loop 提醒（無 active loop → 靜默不印）。字串為既有特徵測試所釘、逐字不變。 */
function printActiveLoops(cwd) {
  const entries = collectLoopEntries(cwd);
  if (entries.length === 0) return;

  const lines = entries.map(({ slug, mdPath }) => formatLoopLine(slug, safeReadFile(mdPath)));
  console.log(formatActiveLoopsHeader(entries.length));
  console.log(lines.join('\n'));
}

/** SessionStart hook 入口：印 active-loop 提醒（無 active loop → 靜默）。 */
function main() {
  printActiveLoops(process.cwd());
}

// ── 進入點守衛：被 import（單元測試）時不執行 main，只有直接被 node 執行時才跑 ──────────
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch {
    // hook 絕不可因錯誤擋住 session 啟動：吞掉所有例外
  }
  process.exit(0);
}
