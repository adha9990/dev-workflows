#!/usr/bin/env node
// loops-workflow SDD-CACHE hook（SessionStart）。
// 掃描 CWD 的 .loops/，若有 active 迴圈就印一段提醒當作 session context，輔助 resume。
// 沒有就靜默退出（不製造噪音）。唯讀、不改任何檔。依賴：無。

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

try {
  const root = join(process.cwd(), '.loops');
  if (!existsSync(root)) process.exit(0);

  const slugs = readdirSync(root).filter((d) => {
    try { return statSync(join(root, d)).isDirectory() && existsSync(join(root, d, 'loop.md')); }
    catch { return false; }
  });
  if (slugs.length === 0) process.exit(0);

  const pick = (md, label) => {
    // 抓「| 當前階段 | xxx |」或「當前階段：xxx」這類欄位
    const row = md.match(new RegExp(`${label}[^\\n|]*\\|\\s*([^|\\n]+?)\\s*\\|`));
    if (row) return row[1].trim();
    const line = md.match(new RegExp(`${label}[：:]\\s*([^\\n]+)`));
    return line ? line[1].trim() : '?';
  };
  const lastJournal = (md) => {
    const lines = md.split('\n').filter((l) => /^\s*-\s*\[E\d+\]/.test(l));
    return lines.length ? lines[lines.length - 1].trim() : '(無 Journal)';
  };

  const items = slugs.map((s) => {
    let md = '';
    try { md = readFileSync(join(root, s, 'loop.md'), 'utf8'); } catch {}
    return `  - ${s}｜階段：${pick(md, '當前階段')}｜模式：${pick(md, '推進模式')}｜最後：${lastJournal(md)}`;
  });

  console.log(`[loops-workflow] 偵測到 ${slugs.length} 個 active 迴圈（.loops/）。可用 /loops-workflow:resume <slug> 接續、或 /loops-workflow:status 看詳情：`);
  console.log(items.join('\n'));
} catch {
  // hook 絕不可因錯誤擋住 session 啟動
  process.exit(0);
}
process.exit(0);
