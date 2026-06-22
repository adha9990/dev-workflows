---
description: 接續一個既有的 loops-workflow 迴圈（讀 loop.md 事件日誌重建狀態）。
argument-hint: [slug]
---

接續既有迴圈。依 `references/journaling.md` 的 resume 協定：

1. 讀 `.loops/$ARGUMENTS/loop.md`（`$ARGUMENTS` 為空或找不到 → 列出 `.loops/` 下所有迴圈讓使用者選）。
2. 從 Journal 重建狀態：當前階段、上一個 gate、回環第幾圈、已完成哪些 `NN-*.md`。
3. 回報「停在 <階段> 的 <gate>，已完成 E1–En，下一步是 X」，問使用者是否續跑。
4. 續跑後繼續 append Journal，**不覆蓋**舊事件。
