// loop-context.mjs —— 「這次 hook 呼叫屬於哪一條 loop」的單一判定處（#217 增量 2）。
//
// telemetry 是 **per-loop** 的（`.loops/<slug>/telemetry/events.jsonl`），所以每支 telemetry hook
// 都得先回答同一個問題：現在這個 cwd 對應到哪條 loop？既有 hook 各自解了一半——`cost-tracker`
// 只解主 repo 根（它寫的是全域檔、不需要 slug），`pr-gate` 只在自己的閘裡解 slug。把兩邊的做法
// 收斂到這裡，避免第三支、第四支 hook 又各抄一份。
//
// 判定順序（沿用 pr-gate 已驗證的兩段式，零 spawn `git`、全部詞法讀檔）：
//   ① cwd 路徑含 `.claude/worktrees/<slug>` → 取該 slug；
//   ② 否則讀 cwd 的 `.git`（檔案形 `gitdir:` 指標或目錄形）取 `refs/heads/<branch>` → 當 slug。
//   兩者都判不出（detached HEAD、非 git 目錄）→ null，呼叫端一律當「不在 loop 裡」處理。
//
// 落點錨定（AGENTS 規則 9）：`.loops/` 一律在**主 repo**，即使 cwd 已經在 worktree 裡。
// 這裡重用 `cost-tracker.mjs` 的 `resolveLoopsRoot`，不再自己推導一次。
//
// **新制判定**（`hasTelemetry`）：只有 `.loops/<slug>/telemetry/` 已存在的 loop 才算新制。
// 這是 #217「舊 loop 不受影響」的機械邊界——舊 loop 沒有這個資料夾，所有新 gate 對它一律 no-op，
// 不必靠日期、版本號或人工名單去區分。
//
// 依賴：僅 node 內建 ＋ 既有 hook。純函式 ＋ 薄 IO，任何錯誤一律回 null（hook 永不因此擋路）。

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { resolveLoopsRoot } from './cost-tracker.mjs';
import { extractWorktreeSlug } from './worktree-guard.mjs';
import { readGitBranch } from './pr-gate.mjs';

/**
 * 解出這次呼叫所屬的 loop → `{ loopsRoot, slug, loopDir, hasTelemetry }` 或 null。
 * 判不出 slug、或該 slug 底下沒有 `loop.md`（不是一條已建的 loop）一律 null。
 */
export function resolveLoopContext(cwd) {
  try {
    const loopsRoot = resolveLoopsRoot(cwd);
    if (!loopsRoot) return null;

    const slug = extractWorktreeSlug(cwd) ?? readGitBranch(cwd);
    if (!slug) return null;

    const loopDir = join(loopsRoot, '.loops', slug);
    if (!existsSync(join(loopDir, 'loop.md'))) return null;

    return { loopsRoot, slug, loopDir, hasTelemetry: existsSync(join(loopDir, 'telemetry')) };
  } catch {
    return null; // 判不出來就是判不出來——hook 不因為解析失敗而擋路
  }
}
