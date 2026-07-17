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
| 研究／提案 EDD（explore／iterate）| `## 📐 Engineering Design Document — <題目>`（修訂版加 `（修訂版 vN）`）|

每則 comment 結尾附一句來源：`> loops-workflow <stage> 留痕`。**不在這句（或任何 GitHub 內容）指 `.loops/` 路徑** —— 見下方鐵律。

## 每型對外訊息 → 樣板

| # | 對外訊息 | 何時 / 哪個 skill | 樣板（canonical source） |
|---|---------|------------------|--------------------------|
| 1 | **issue 建立** | `define`（所有無票工作唯一入口）| repo `.github/ISSUE_TEMPLATE/*.yml`（輸出契約）→ 無則 `define` 的 generic fallback。對齊 repo house-style exemplar；UI 票附 ASCII 線框 |
| 2 | **plan 對齊 comment** | `plan` gate（issue-driven）| **`plan-comment-template.md`**（位於 `skills/plan/references/`，plan skill 私有、非本共用目錄；系統全貌 + 套件清單含版本 + ADR + 機制圖 mermaid + 施工圖 + 契約 + out-of-scope；living as-built）|
| 3 | **verify 驗收報告 comment** | `verify` 合併安全結論對外 | **`comment-policy.md §7`**（方向總評 → 按維度分組 → 每點四小節：情境/為何問題/怎麼修/補測試 → 結尾 CI 提醒）|
| 4 | **iterate 修正回覆 comment** | `iterate` 修完 PR 回饋 / verify 缺口 | **`comment-policy.md §8`**（每點雙視角：工程角度 根因/怎麼修/怎麼驗 + 客戶角度 修正前→後；不 @reviewer；結尾據實驗證行）|
| 5 | **PR body** | `iterate` 完整迴圈收尾 | **`pr-spec.md`**（as-built 提煉；含 `Closes #<issue>` 關閉關鍵字）|
| 6 | **AskUserQuestion**（端給使用者的問題）| 各階段決策點 | **`comment-policy.md §4`**（每選項列優缺 + 必標 `(Recommended)` + 一句理由；重大且選非推薦項要主動提異見）|
| 7 | **研究／提案 EDD comment** | `explore`/`clarify` 研究報告的決策摘要、design 型 loop 的工程提案交付、`iterate` 回應審查的提案修訂版（vN）| **`edd-comment-template.md`**（📐 EDD header + blockquote 定位〔引研究來源＋「審核同意前不進入實作」聲明〕+ 固定區塊：研究摘要含證據紀律 / 推薦方案含 mermaid / 領域清單表 / 取捨分析含留債明標 / 架構方向含組裝 vs 照抄誠實聲明 / 入口一致性 / 風險與限制含可否證假設 / 拆票表含相依 / 驗收標準對照；與 §7/§8 文體分界見該檔）|

## 先辨文體，再選樣板

§7 / §8 只給**審查結論 / 修正回覆**兩種文體；**工程提案、研究結論、設計說明是另一種文體**——套第 7 型 **EDD 版型**（`edd-comment-template.md`）寫成一份自足的設計文件，不硬套雙視角 list。這類內容型交付的**載體**（發哪裡、什麼形式）在 goal 訪談就該問定（見 `goal` skill 步驟 1），本檔只管選對樣板。

## 鐵律

- **絕不引用 `.loops/` 路徑**（`stages/02-plan.md`/`stages/03-build.md`/`stages/04-verify.md`/`stages/00-goal.md`/`stages/01-explore.md`）—— `.loops/` 是本地暫存、不上 GitHub、PR merge/close 後清除，在 GitHub 內容指它＝死連結。內容 **self-contained**（設計決策/機制圖/驗收 inline），要指更細只指 PR/commit/`file:line`/issue（見 `comment-policy.md §0`）。
- **每則對外訊息必對到上表一型**——沒有「即興格式」。找不到對應型 → 先補一型樣板再發，不臨時自創、**也不塞最接近的近似型**（例：把工程提案硬套 §8 修正回覆的雙視角格式＝實證踩過的錯型）。
- **先 tmp 草稿 → 使用者確認 → 送出 → 刪 tmp**（§5），全型適用。
- **plan / verify / iterate comment 都是 living**：as-built 偏離時回來同步更新已 post 的版本（`gh api --method PATCH repos/<owner>/<repo>/issues/comments/<id> -F body=@<tmp>`）。**不含研究／提案 EDD**——其修訂發 vN 新 comment、不原地 PATCH（保留與審查意見的時間軸對話，見 `edd-comment-template.md`〈修訂慣例〉）。
