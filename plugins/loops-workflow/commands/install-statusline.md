---
description: 一鍵把 loops-workflow 的 statusline（HUD）接到 settings.json：自動解析絕對路徑、冪等、覆寫前確認。
---

把 loops-workflow 的 statusline wrapper（`scripts/statusline.sh`）接進使用者的 `settings.json`，讓 session 底下顯示「目前跑到哪個 loop / 哪個階段」。**照下列步驟做，過程只在「會覆寫既有 statusLine」時停下來問，其餘自動完成**：

1. **定位 wrapper 絕對路徑**
   - 設 `CFG = ${CLAUDE_CONFIG_DIR:-$HOME/.claude}`。
   - 在 `CFG/plugins/` 底下搜尋檔名 `statusline.sh` 且路徑含 `loops-workflow/scripts/` 的檔（marketplaces 與 cache 兩處都找）。
   - 若有多個，優先取 `plugins/marketplaces/` 下那個；都沒有 → 回報「找不到 loops-workflow，請先 `/plugin install loops-workflow@dev-workflows`」並停止。
   - 把路徑正規化成**正斜線絕對路徑**（Windows 例：`C:/Users/<你>/.claude/...`）。記為 `WRAPPER`。

2. **讀 settings.json**
   - 目標檔 `SETTINGS = CFG/settings.json`。不存在就當作 `{}`（稍後建立）。
   - 解析現有 JSON；保留所有既有 key。

3. **冪等 / 安全覆寫**
   - 期望值：`{ "type": "command", "command": "bash \"<WRAPPER>\"" }`。
   - 若 `statusLine` 已等於期望值 → 回報「✅ 已安裝，無需變更」，結束。
   - 若 `statusLine` 存在但**不同**（例如純 claude-hud 或別的指令）→ **先把現值原樣印給使用者看**，用 `AskUserQuestion` 問是否覆寫（JSON 不能存註解，無法自動備份，所以請使用者自行記下舊值以便還原）。使用者拒絕 → 不動、結束。
   - 若沒有 `statusLine` → 直接進下一步。

4. **寫回**
   - 設 `statusLine = { "type": "command", "command": "bash \"<WRAPPER>\"" }`，其餘 key 原封不動，pretty-print（2 空格）寫回 `SETTINGS`。

5. **回報**
   - 印出最終 `statusLine` 值。
   - 提醒：(a) claude-hud 為**選配** —— 沒裝也能用，會退化成只印 loops 進度（`⟳ <slug> · <stage>`）；裝了則接在 claude-hud 後面當 extra segment。(b) **需新開一個 session** 才會看到 statusline 生效。
