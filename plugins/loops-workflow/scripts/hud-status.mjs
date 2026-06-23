#!/usr/bin/env node
// loops-workflow HUD status —— 給 claude-hud 的 `--extra-cmd` 用。
// 讀當前工作目錄的 .loops/，印出最近 active loop 的「slug · 當前階段」當一個 HUD segment。
// 輸出格式（claude-hud 要求）：{"label": "<字串>"}；無 active loop 則 label 空字串。
// 絕不丟錯（statusline 高頻呼叫）。依賴：無。

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

function out(label) {
  process.stdout.write(JSON.stringify({ label: label || '' }));
  process.exit(0);
}

try {
  const root = join(process.cwd(), '.loops');
  if (!existsSync(root)) out('');

  const loops = readdirSync(root)
    .map((s) => {
      try {
        const md = join(root, s, 'loop.md');
        if (!statSync(join(root, s)).isDirectory() || !existsSync(md)) return null;
        return { slug: s, mtime: statSync(md).mtimeMs, md };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);

  if (!loops.length) out('');

  const top = loops[0];
  let stage = '?';
  try {
    const txt = readFileSync(top.md, 'utf8');
    // 支援「| 當前階段 | xxx |」表格 或「當前階段：xxx」
    const row = txt.match(/當前階段[^\n|]*\|\s*([^|\n]+?)\s*\|/);
    const line = txt.match(/當前階段[：:]\s*([^\n]+)/);
    const raw = (row && row[1]) || (line && line[1]) || '';
    stage = raw.trim().split(/[（(]/)[0].trim() || '?';
  } catch {}

  const more = loops.length > 1 ? ` +${loops.length - 1}` : '';
  out(`⟳ ${top.slug} · ${stage}${more}`);
} catch {
  out('');
}
