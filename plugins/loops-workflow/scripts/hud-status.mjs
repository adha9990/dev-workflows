#!/usr/bin/env node
// loops-workflow HUD status —— 給 claude-hud 的 `--extra-cmd` 用。
// 只顯示「**當下 session 正在跑**」的那一個 loop：用 CLAUDE_CODE_SESSION_ID 比對 loop.md 的 session 欄。
// 已完工 / 別的 session / 別的時間留下的 loop 都不顯示，也不堆 +N。
// 輸出格式（claude-hud 要求）：{"label": "⟳ <slug> · <stage>"}；無則 label 空字串。絕不丟錯。
// 依賴：無。

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FALLBACK_WINDOW_MS = 4 * 60 * 60 * 1000; // 沒 session id 時退化用的「近期活躍」窗

function out(label) {
  process.stdout.write(JSON.stringify({ label: label || '' }));
  process.exit(0);
}

// 解析 loop.md 的「| 欄 | 值 |」表格列 或「欄：值」
function field(txt, name) {
  const row = txt.match(new RegExp(`${name}[^\\n|]*\\|\\s*([^|\\n]+?)\\s*\\|`));
  const line = txt.match(new RegExp(`${name}[：:]\\s*([^\\n]+)`));
  return (((row && row[1]) || (line && line[1])) || '').trim();
}

try {
  const root = join(process.cwd(), '.loops');
  if (!existsSync(root)) out('');

  const sid = (process.env.CLAUDE_CODE_SESSION_ID || '').trim();

  const loops = readdirSync(root)
    .map((s) => {
      try {
        const md = join(root, s, 'loop.md');
        if (!statSync(join(root, s)).isDirectory() || !existsSync(md)) return null;
        const txt = readFileSync(md, 'utf8');
        const stage = (field(txt, '當前階段') || '?').split(/[（(]/)[0].trim() || '?';
        return { slug: s, mtime: statSync(md).mtimeMs, session: field(txt, 'session'), stage };
      } catch { return null; }
    })
    .filter(Boolean)
    // 完工 / done 的不算「正在跑」
    .filter((l) => !/完工|done|✅/i.test(l.stage));

  let pick = null;
  if (sid) {
    // 只取「本 session 建 / 認領」的 loop（精準）
    pick = loops.filter((l) => l.session && l.session === sid).sort((a, b) => b.mtime - a.mtime)[0] || null;
  } else {
    // statusline 環境拿不到 session id → 退化成「近期活躍最近一筆」
    pick = loops.filter((l) => Date.now() - l.mtime < FALLBACK_WINDOW_MS).sort((a, b) => b.mtime - a.mtime)[0] || null;
  }

  out(pick ? `⟳ ${pick.slug} · ${pick.stage}` : '');
} catch {
  out('');
}
