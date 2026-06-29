#!/usr/bin/env node
// loops-scan.mjs —— 共用 .loops/ 掃描 + loop.md 欄位/Journal 解析。
// scripts/progress.mjs 與 hooks/progress-render.mjs 共用（自舊的進度狀態列腳本抽出共用）。
// 純函式無 IO（測試直接 import）；IO 邊界容錯不丟。僅 node 內建。

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const STAGE_ORDER = ['goal', 'explore', 'plan', 'build', 'verify', 'iterate'];
export const PRE_STAGES = ['clarify', 'scaffold', 'define'];
export const MAX_ROUNDS = 3;
const FALLBACK_WINDOW_MS = 4 * 60 * 60 * 1000; // 無 session id 時的「近期活躍」窗

/** loop.md 欄位：先試 markdown 表格列「label … | value |」，再試「label：value」行；無 → ''。 */
export function pickLoopField(md, label) {
  const text = String(md || '');
  const tableRow = text.match(new RegExp(`${label}[^\\n|]*\\|\\s*([^|\\n]+?)\\s*\\|`));
  if (tableRow) return tableRow[1].trim();
  const inlineLine = text.match(new RegExp(`${label}[：:]\\s*([^\\n]+)`));
  return inlineLine ? inlineLine[1].trim() : '';
}

/** Journal 行（- [E\\d+] …）陣列（trim 後）；無 → []。 */
export function journalEntries(md) {
  return String(md || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^-\s*\[E\d+\]/.test(l));
}

/** 最後一條 Journal 行；無 → '(無 Journal)'。 */
export function lastJournalLine(md) {
  const lines = journalEntries(md);
  return lines.length ? lines[lines.length - 1] : '(無 Journal)';
}

/** 當前階段（去括號註解）；無 → '?'。 */
export function currentStage(md) {
  return (pickLoopField(md, '當前階段') || '?').split(/[（(]/)[0].trim() || '?';
}

/** 是否完工。 */
export function isDone(stage) {
  return /完工|done|✅/i.test(String(stage || ''));
}

const safeReaddir = (dir) => { try { return readdirSync(dir); } catch { return []; } };
const safeReadFile = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };

/** 要掃的 .loops 根目錄：cwd 下 .loops 和 worktree 下 .loops */
export function collectLoopRoots(cwd) {
  const roots = [];
  const main = join(cwd, '.loops');
  if (existsSync(main)) roots.push(main);
  const wtBase = join(cwd, '.claude', 'worktrees');
  if (existsSync(wtBase)) {
    for (const wt of safeReaddir(wtBase)) {
      const l = join(wtBase, wt, '.loops');
      if (existsSync(l)) roots.push(l);
    }
  }
  return roots;
}

/** 掃所有根目錄下含 loop.md 的子目錄 → [{slug, dir, mdPath, md, mtime}]。 */
export function collectLoopEntries(cwd) {
  const entries = [];
  for (const root of collectLoopRoots(cwd)) {
    for (const slug of safeReaddir(root)) {
      try {
        const dir = join(root, slug);
        const mdPath = join(dir, 'loop.md');
        if (statSync(dir).isDirectory() && existsSync(mdPath)) {
          entries.push({ slug, dir, mdPath, md: safeReadFile(mdPath), mtime: statSync(mdPath).mtimeMs });
        }
      } catch { /* 單一子目錄失敗 → 跳過、續掃其餘 */ }
    }
  }
  return entries;
}

/**
 * 從 entries 挑「本 session active」一筆：排除完工；有 sid → 比對 session 欄、取 mtime 最新；
 * 無 sid → 近期活躍窗內取 mtime 最新。now 注入以利測試（省略視為 0、等同不設窗下限）。
 */
export function pickActiveLoop(entries, sid, now) {
  const t = typeof now === 'number' ? now : 0;
  const active = (entries || []).filter((e) => !isDone(currentStage(e.md)));
  if (sid) {
    return active.filter((e) => pickLoopField(e.md, 'session') === sid).sort((a, b) => b.mtime - a.mtime)[0] || null;
  }
  return active.filter((e) => t - e.mtime < FALLBACK_WINDOW_MS).sort((a, b) => b.mtime - a.mtime)[0] || null;
}