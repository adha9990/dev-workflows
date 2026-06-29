# outbound-templates — 對外訊息統一樣板索引

> **單一入口**：loops-workflow **每一則對外發出的訊息**（issue 建立 / 各種 comment / PR body / 端給使用者的問題）都走固定樣板，確保每次發出去的訊息格式一致、可預期。
> 任何 skill 要 post / create / 呈現對外內容前，先來這裡找對應樣板。

## 通用 house-style（每型都套）

對齊 `comment-policy.md`：
- **語言**（§1）：敘述繁體中文；identifier / 路徑 / 指令 / 技術術語保留英文。
- **白話 register**（§2）：先講「會出什麼包 / 怎麼修 / 怎麼驗」再帶 identifier；一句 ≥2 個非-identifier 行話就重寫。
- **雙視角**（§3）：問題紀錄固定「工程視角（根因/怎麼修/怎麼驗）+ 使用者視角（觸發情形/修正前→後）」。
- **不客套**（§6）：去感謝 / 開場 / 結尾客套；婉拒只陳述技術理由；comment 不 `@` 點名 reviewer。
- **草稿流程**（§5）：對外內容**先寫 tmp 草稿**（不進專案 / 不進版控）→ **使用者確認** → `--body-file` / `gh api PATCH` 逐字送出 → **送出後刪 tmp**。**未經確認不自動 post。**
- **證據優先**：寫驗證證據（`typecheck`/`lint`/測試結果、`<file:line>`），沒實測的數字標 `not measured`。

## 統一 comment header 慣例

所有 loops-workflow post 的 comment **第一行**用可辨識的 emoji + 階段標題，讓 issue/PR 時間軸一眼看出來自哪個階段：

| 階段 | header 第一行 |
|------|------|
| plan 對齊 | `## 📐 實作對齊（plan 階段）— <feature>` |
| verify 驗收 | `## 🔎 驗收報告（verify 階段）— <feature>` |
| iterate 修正回覆 | `## 🔧 修正回覆（iterate 階段）— <feature>` |
| PR 收尾 | `## ✅ 成果與驗證（PR 收尾）— <feature>` |

每則 comment 結尾附一句來源指向：`> loops-workflow <stage> 留痕；細節見 .loops/<slug>/<doc>.md`。

## 每型對外訊息 → 樣板

| # | 對外訊息 | 何時 / 哪個 skill | 樣板（canonical source） |
|---|---------|------------------|--------------------------|
| 1 | **issue 建立** | `define`（所有無票工作唯一入口）| repo `.github/ISSUE_TEMPLATE/*.yml`（輸出契約）→ 無則 `define` 的 generic fallback。對齊 repo house-style exemplar；UI 票附 ASCII 線框 |
| 2 | **plan 對齊 comment** | `plan` gate（issue-driven）| **`plan-comment-template.md`**（系統全貌 + 套件清單含版本 + ADR + 機制圖 mermaid + 施工圖 + 契約 + out-of-scope；living as-built）|
| 3 | **verify 驗收報告 comment** | `verify` 合併安全結論對外 | **`comment-policy.md §7`**（方向總評 → 按維度分組 → 每點四小節：情境/為何問題/怎麼修/補測試 → 結尾 CI 提醒）|
| 4 | **iterate 修正回覆 comment** | `iterate` 修完 PR 回饋 / verify 缺口 | **`comment-policy.md §8`**（每點雙視角：工程角度 根因/怎麼修/怎麼驗 + 客戶角度 修正前→後；不 @reviewer；結尾據實驗證行）|
| 5 | **PR body** | `iterate` 完整迴圈收尾 | **`pr-spec.md`**（as-built 提煉；含 `Closes #<issue>` 關閉關鍵字）|
| 6 | **AskUserQuestion**（端給使用者的問題）| 各階段決策點 | **`comment-policy.md §4`**（每選項列優缺 + 必標 `(Recommended)` + 一句理由；重大且選非推薦項要主動提異見）|

## 鐵律

- **每則對外訊息必對到上表一型**——沒有「即興格式」。找不到對應型 → 先補一型樣板再發，不臨時自創。
- **先 tmp 草稿 → 使用者確認 → 送出 → 刪 tmp**（§5），全型適用。
- **plan / verify / iterate comment 都是 living**：as-built 偏離時回來同步更新已 post 的版本（`gh api --method PATCH repos/<owner>/<repo>/issues/comments/<id> -F body=@<tmp>`）。
