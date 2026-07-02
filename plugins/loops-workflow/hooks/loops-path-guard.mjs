#!/usr/bin/env node
// loops-path-guard.mjs —— loops-workflow PreToolUse deny hook（#85）：擋下「在 worktree 底下寫
// .loops/」這個 loops 錨定規則的違規動作 —— .loops/ 一律該錨定主 repo（$LOOPS_ROOT/.loops/<slug>/），
// worktree 只放 code。預設啟用（本專案第一個 opt-out 而非 opt-in 的 deny hook）；
// env LOOPS_PATH_CONTAINMENT='0'（字面 '0'）可關閉。
// fail-open：任何例外 / payload 壞掉一律放行 exit 0，永不因 hook 故障卡住使用者。
//
// 已知限制：純字串路徑正規化（path.resolve + 分隔符/大小寫統一），不解析 symlink ——
// 熱路徑（每次 Write/Edit 都跑）零 I/O 是刻意的設計取捨，換取判斷速度與零副作用。
// 若日後需要「real path 落地是否真的在 root 之下」這種強保證，見 scripts/path-containment.mjs
// 的 containment-in-root 原語（語意不同：那個做的是「解析後路徑」的 containment 檢查，
// 這裡是「字面路徑段」的 pattern 比對，故不直接 import 共用）。
//
// 分層（仿同目錄 config-protection.mjs）：
//   1) 純函式（無 IO，測試直接 import）：isWorktreeLoopsPath。
//   2) IO 薄邊界：main()（讀 stdin、印 deny JSON）——被 import 時不執行（import.meta.url 守門）。
// 依賴：僅 node 內建（path / fs / url），零外部套件；除 stdin 外零 I/O。

import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DENY_REASON =
  '.loops/ 一律錨定主 repo —— 請寫入 $LOOPS_ROOT/.loops/<slug>/' +
  '（LOOPS_ROOT = git worktree list --porcelain 第一筆 worktree 根）；worktree 只放 code。' +
  '確需繞過：設 LOOPS_PATH_CONTAINMENT=0。';

// ── 純函式層（無 IO，測試直接 import）─────────────────────────────────────────────

/**
 * 判斷 filePath（相對於 cwd 解析後）是否落在「worktree 內的 .loops/」——即違反
 * loops 錨定主 repo 的規則。純字串比對：resolve 收合 . / .. / 重複分隔符 →
 * 統一分隔符與大小寫（NTFS 不分大小寫）→ 依段完全相等比對，不做 substring 判斷。
 */
export function isWorktreeLoopsPath(filePath, cwd) {
  const resolved = resolve(cwd, filePath);
  const normalized = resolved.replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/').filter((segment) => segment.length > 0);

  const worktreesIndex = segments.findIndex(
    (segment, i) => segment === '.claude' && segments[i + 1] === 'worktrees',
  );
  if (worktreesIndex === -1) return false;

  return segments.slice(worktreesIndex + 2).includes('.loops');
}

// ── IO 薄邊界：main()（被 import 時不執行）────────────────────────────────────────

function readStdin() {
  return readFileSync(0, 'utf8'); // fd 0 = stdin（hook payload 由父行程以 pipe 餵入）
}

/**
 * PreToolUse(Write|Edit|MultiEdit) hook 入口：違規路徑（worktree 內 .loops/）→ 回 deny 阻擋；
 * 其餘一律放行（無輸出）。fail-open：payload 壞掉 / 缺欄位一律放行，永不擋路。
 */
function main() {
  if (process.env.LOOPS_PATH_CONTAINMENT === '0') return; // 明確 opt-out（僅字面 '0'）→ 放行

  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return; // payload 壞 → 放行（無輸出）
  }

  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== 'string') return; // 無檔路徑 → 無從判定，放行

  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : process.cwd();
  if (!isWorktreeLoopsPath(filePath, cwd)) return; // 未違規 → 放行

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: DENY_REASON,
      },
    }),
  );
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch {
    // fail-open：hook 絕不可因錯誤擋路 → 吞掉所有例外、放行
  }
  process.exit(0);
}
