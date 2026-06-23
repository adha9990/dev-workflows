#!/usr/bin/env node
// loops-workflow SessionStart hook。
// 掃 CWD 的 .loops/ **以及 .claude/worktrees/*/.loops/** —— 在主 repo 開的 session 也看得到
// 底下 worktree 在跑的迴圈。有 active 迴圈就印一段提醒當 session context，輔助 resume。
// 沒有就靜默退出（不製造噪音）。唯讀、不改任何檔。依賴：無。

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const safeReaddir = (p) => { try { return readdirSync(p); } catch { return []; } };

try {
  const cwd = process.cwd();

  // 要掃的 .loops/ 根目錄：cwd/.loops + cwd/.claude/worktrees/*/.loops
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

  const entries = [];
  for (const root of roots) {
    for (const s of safeReaddir(root)) {
      try {
        const md = join(root, s, 'loop.md');
        if (statSync(join(root, s)).isDirectory() && existsSync(md)) entries.push({ slug: s, md });
      } catch {}
    }
  }
  if (entries.length === 0) process.exit(0);

  const pick = (md, label) => {
    const row = md.match(new RegExp(`${label}[^\\n|]*\\|\\s*([^|\\n]+?)\\s*\\|`));
    if (row) return row[1].trim();
    const line = md.match(new RegExp(`${label}[：:]\\s*([^\\n]+)`));
    return line ? line[1].trim() : '?';
  };
  const lastJournal = (md) => {
    const lines = md.split('\n').filter((l) => /^\s*-\s*\[E\d+\]/.test(l));
    return lines.length ? lines[lines.length - 1].trim() : '(無 Journal)';
  };

  const items = entries.map(({ slug, md: mdPath }) => {
    let md = '';
    try { md = readFileSync(mdPath, 'utf8'); } catch {}
    return `  - ${slug}｜階段：${pick(md, '當前階段')}｜模式：${pick(md, '推進模式')}｜最後：${lastJournal(md)}`;
  });

  console.log(`[loops-workflow] 偵測到 ${entries.length} 個 active 迴圈（.loops/ 含 worktree）。可用 /loops-workflow:resume <slug> 接續、或 /loops-workflow:status 看詳情：`);
  console.log(items.join('\n'));
} catch {
  // hook 絕不可因錯誤擋住 session 啟動
  process.exit(0);
}
process.exit(0);
