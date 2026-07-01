---
description: 接續一個既有的 loops-workflow 迴圈（讀 loop.md 事件日誌重建狀態）。
argument-hint: [slug]
---

接續既有迴圈。依 `references/journaling.md` 的 resume 協定：

0. **先確定性錨定 `.loops/` 落點（主 repo 根，不是 cwd）**：`LOOPS_ROOT="$(git worktree list --porcelain | sed -n 's/^worktree //p' | head -1)"`（第一筆＝主 worktree 根、不隨 cwd 改變）。之後所有讀 / append `.loops/` 一律用 `$LOOPS_ROOT/.loops/` 絕對路徑 —— **即使這個 resume session 是在某個 worktree 裡開的，也讀寫主 repo 的 `.loops/`，不得在 worktree 內另建 / 續寫**（避免 loop 記憶體分裂；見 `AGENTS.md` 規則 9）。
1. 讀 `$LOOPS_ROOT/.loops/$ARGUMENTS/loop.md`（`$ARGUMENTS` 為空或找不到 → 列出 `$LOOPS_ROOT/.loops/` 下所有迴圈讓使用者選；若在 `.claude/worktrees/*/.loops/` 撿到舊漂移殘留，一併提醒可收攏回主 repo）。
2. 從 Journal 重建狀態：當前階段、上一個 gate、回環第幾圈、已完成哪些 `NN-*.md`。
3. 回報「停在 <階段> 的 <gate>，已完成 E1–En，下一步是 X」，問使用者是否續跑。
4. 續跑後繼續 append Journal，**不覆蓋**舊事件。
