#!/usr/bin/env node
// progress-render.mjs —— loops-workflow Stop hook（恆跑）。
// 每回合結束跑 scripts/progress.mjs --write-only，對本 session active loop 重生 PROGRESS.md。
// 不注入任何 context（只做檔案 side-effect）、無 .loops/ → no-op、永不擋路 exit 0。
// stdin 的 hook payload 讀掉即丟（不需要）。

import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../hooks
const PROGRESS = join(HERE, '..', 'scripts', 'progress.mjs');

try {
  // 同步 spawn renderer（--write-only：只寫 PROGRESS.md、不印 stdout）。
  // CLAUDE_CODE_SESSION_ID 由 progress.mjs 自 env 讀，挑本 session active loop。
  spawnSync(process.execPath, [PROGRESS, '--write-only'], {
    cwd: process.cwd(),
    stdio: 'ignore',
    env: process.env,
  });
} catch {
  // 永不擋路
}
process.exit(0);
