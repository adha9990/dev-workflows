---
description: 顯示某條 loops-workflow 迴圈的完整進度儀表板（chat），並重生 .loops/<slug>/PROGRESS.md 供編輯器 markdown preview。
argument-hint: [slug]
---

顯示一條 loop 的完整進度（唯讀）。**唯讀進度、不改 loop 狀態。**

1. **定位 renderer**：在 `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/` 底下找路徑含 `loops-workflow/scripts/` 的 `progress.mjs`（marketplaces 與 cache 兩處都找，優先 `plugins/marketplaces/`）。找不到 → 回報「找不到 loops-workflow，請先 `/plugin install loops-workflow@dev-workflows`」並停止。
2. **跑它**：`node "<progress.mjs 絕對路徑>" $ARGUMENTS`（`$ARGUMENTS` 為使用者給的 slug；省略則自動挑本 session 正在跑的 loop）。
3. **relay 輸出**：把 stdout 的儀表板原樣呈現給使用者。若無輸出（沒有 active loop / 找不到該 slug）→ 回報「目前沒有正在跑的 loop（或查無此 slug）。可用 `/loops-workflow:status` 列出全部」。
4. **提示**：它同時已（重）寫 `.loops/<slug>/PROGRESS.md`，提醒使用者可在 VS Code 開該檔的 **markdown preview** 常駐看進度（免安裝、會被 Stop hook 每回合自動更新）。

> 與 `/loops-workflow:status` 的分工：`status` 列「全部 active loop」一行摘要；`progress` 深看「一條 loop」的完整儀表板 + 產 PROGRESS.md。
