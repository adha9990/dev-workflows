#!/usr/bin/env node
// loops-scan.mjs —— 共用 .loops/ 掃描 + loop.md 欄位/Journal 解析。
// scripts/progress.mjs 與 hooks/progress-render.mjs 共用（自舊的進度狀態列腳本抽出共用）。
// 純函式無 IO（測試直接 import）；IO 邊界容錯不丟。僅 node 內建。

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 階段值域一律從 canonical vocabulary 取（#219）——這裡曾經寫死一份六階段清單，
 * 於是 registry 一改它就落後，而落後的那份看起來跟正確的一模一樣。
 * 讀不到就給空清單：**不退回一份寫死的備份**，那等於在 registry 之外留第二份真相源。
 * 空清單只會讓進度列少顯示「下一步」，不會讓 hook 掛掉（呼叫端一律容錯）。
 */
function loadPhaseOrder() {
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'references', 'workflow-vocabulary.json');
    const vocabulary = JSON.parse(readFileSync(path, 'utf8'));
    const phases = [...(vocabulary.phases ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const retired = (vocabulary.retired_phases ?? []).map((r) => r.id);
    return { order: phases.map((p) => p.id), retired };
  } catch {
    return { order: [], retired: [] };
  }
}

const VOCABULARY = loadPhaseOrder();

/** canonical phase 的順序（define → plan → build → verify → finalize）。 */
export const STAGE_ORDER = VOCABULARY.order;

/**
 * 不在 phase 表、但仍可能出現在 `loop.md` 的「當前階段」欄位的名字：
 * `scaffold` 是 dispatch 的前置動作（建骨架，不是工作階段），其餘是**舊 loop 的退場 phase**——
 * 讀得懂它們是 #219 承諾的「舊 loop 維持讀取相容」，不是把它們當成還活著的階段。
 */
export const PRE_STAGES = ['scaffold', ...VOCABULARY.retired];
export const MAX_ROUNDS = 3;
const FALLBACK_WINDOW_MS = 4 * 60 * 60 * 1000; // 無 session id 時的「近期活躍」窗

/** loop.md 欄位：先試 markdown 表格列「label … | value |」，再試「label：value」行；無 → ''。 */
export function pickLoopField(md, label) {
  const text = String(md || '');
  const esc = String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // escape label 的 regex 特殊字元（防禦）
  const tableRow = text.match(new RegExp(`${esc}[^\\n|]*\\|\\s*([^|\\n]+?)\\s*\\|`));
  if (tableRow) return tableRow[1].trim();
  const inlineLine = text.match(new RegExp(`${esc}[：:]\\s*([^\\n]+)`));
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

/** 掃所有根目錄下含 loop.md 的子目錄 → [{slug, dir, main, mdPath, md, mtime}]。 */
export function collectLoopEntries(cwd) {
  const entries = [];
  const mainRoot = join(cwd, '.loops');
  for (const root of collectLoopRoots(cwd)) {
    const main = root === mainRoot; // 主 repo 的 .loops（true）vs worktree 掃來的（false）
    for (const slug of safeReaddir(root)) {
      try {
        const dir = join(root, slug);
        const mdPath = join(dir, 'loop.md');
        if (statSync(dir).isDirectory() && existsSync(mdPath)) {
          entries.push({ slug, dir, main, mdPath, md: safeReadFile(mdPath), mtime: statSync(mdPath).mtimeMs });
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