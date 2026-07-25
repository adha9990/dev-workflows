# loops-workflow — 操作規則與指令對照（負向 fixture：已移除「安全停不得被 auto 略過」規則）

> 本檔是 AGENTS.md 規則 2 區塊的節錄變體，唯一差異：拿掉「安全停」這條硬煞車的所有明文，
> 用來驗證 test-safe-stop-assertion.mjs 在規則消失時必須變紅。其餘措辭盡量貼近原文，
> 避免測試只是碰巧靠別的字面撿到綠。

## 2. Operating Rules（全程不變的紀律）

1. **對外敘述一律繁體中文**；code identifier、檔案路徑、指令、skill 名保留英文。
2. **推進：階段間不問「要不要進下一階段」**。階段做完把產出寫進 `.loops/` + chat 摘要，**直接往下**。
   - **只在「真正要使用者選」時停、開一個決策點**：explore 選方法 / plan 拍板方案 / iterate 完工 or 回哪階段。
   - **絕不**用純文字「請回覆 yes」要使用者打字 —— 要嘛開一個決策點，要嘛直接往下。
   - **auto 模式**（環境變數 `LOOPS_AUTO=1` 開啟）：全部決策一律用推薦選項自動帶過，一路跑完不停下（見 `references/auto-mode.md`）。
3. **`.loops/<slug>/` 是階段間記憶體**。每階段把結論寫成對應 markdown，下一階段只讀精煉版。

- **類型 = Closed Loop（預設）**：人類在框架內把關、隔離環境（worktree）、清晰標準、持續驗證；opt-in `auto` 收斂成 Open Loop（核准一次後連跑到底）。
