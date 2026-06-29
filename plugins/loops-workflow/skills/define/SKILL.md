---
name: define
user-invocable: false
description: Turns any new work without a GitHub issue into a structured, template-ready feature issue — the single entry for creating ANY issue (never ad-hoc gh create), using a Readiness Model, the repo's issue template, one-question-at-a-time intake, scope sizing, and a flow-diagram policy. There is no standalone research issue: when how-to is unclear, the feature issue flags it and explore researches it during the issue's loop; or research precedes define. Routed to by dispatch for all no-issue work. NOT for an existing issue (→ goal/iterate).
---

# define — 把模糊問題具體化成 issue（再進 goal）

## Overview

`define` 是迴圈最前面的 **DEFINE 階段**：把使用者丟來的點子 / 粗略需求 / 對話筆記 / 截圖，整理成一張**工程師、reviewer、QA、（必要時）AI agent 都看得懂、能實作 / 驗證**的 GitHub issue，讓問題**被追蹤**、後續對齊 comment 有地方 post，再進 `goal` 釘完工定義。

產出**不是 PRD、不是工程計畫、不是長 prompt** —— 是一張可直接貼進 issue tracker 的 ticket。讀者：①一般技術力但不熟領域的全端工程師、②要驗正確性的 reviewer / QA、③（必要時）協助的 AI coding agent。

## When to Use

**Use when**：要開始**任何還沒有 GitHub issue 的工作**（功能 / 修正）。define 是**所有 issue card 的唯一入口：一律經 define + repo template，不 ad-hoc 直接 `gh issue create`**（AGENTS 規則 12）。也可獨立呼叫：把想法變成 ticket、或審 / 重寫既有 ticket。**研究不是獨立 issue**：見下——研究是某功能 issue 的 explore 階段、或先研究再來 define 開功能 issue。

**NOT for**：
- 已有 GitHub issue —— 直接 `goal` / `iterate`（define 是「建 issue」，不是精煉既有）。
- 分不清「要實作 vs 只研究」→ 交給 `clarify` 釐清（它判方向後再回到 define / explore）。

**ticket 一律用 repo `.github/ISSUE_TEMPLATE` 寫**（功能名稱與概述 / 介面設計 / 功能點 / 詳細說明 / 驗收標準 / 注意事項）。**沒有獨立的「研究 issue」** —— 研究永遠服務某個功能，兩種情形最後都是一張**功能 issue**：

- **要做某功能、但不知怎麼做最好** → `define` 一張**功能 issue**，在「詳細說明 / 注意事項」標明**實作方式待研究**；該 issue 的迴圈在 plan 前先跑 `explore` 研究怎麼做（研究是這張功能 issue 的 explore 階段，不另開 issue）。
- **已先研究 / 討論定案** → 直接 `define` 功能 issue，把定案做法寫進去（research 在 define 之前發生）。
- **intake 深度自適應**：需求毛 → 完整 Readiness + 一次一問 intake；已釐清（從 `clarify` 進來、`00-clarify.md` 有確認過理解+方向）→ 不重訪談、直接套 template（只在 issue-specific 缺口才補問）。
- **backlog 模式**（發散式 `explore` 的 `explore → define` gate）：explore 盤出的開放問題逐條經 define 成**功能 issue**（依基礎/獨立分層設相依、別開長相依鏈），仍用 template、不重跑單題 intake。仍守 Input hygiene / 語言 / 品質 Red Flags。

> **路線定案 ≠ 全部定案（「已研究定案」/ backlog 捷徑最容易在此翻車）**：即使研究 / 討論已鎖定**技術路線**（用哪個 library / 架構），會改變本票 **scope / 驗收 / UX / 本票邊界**的**產品決策**（例：偏好的 scope、某 UI 要不要納本票、gate 要不要納 + severity、資料格式取捨…）仍**必須在 `gh issue create` 前逐項跟使用者確認**，別因捷徑把它們當假設吸收進草稿。

## Process

### 1. Readiness Model（先分級再下筆）

| Level | 名稱 | 意思 | 工程師能開工？ |
|---|---|---|---|
| 0 | Idea | 只有粗略概念 | 否 |
| 1 | PM-readable | PM 懂、別人未必 | 否 |
| 2 | Engineer-readable | 熟的工程師能實作 | 也許 |
| 3 | New-engineer-ready | 不熟領域的工程師也懂 scope / 脈絡 / 限制 / 預期行為 | 能 |
| 4 | AI-agent-ready | 再加 repo-aware 邊界 + 驗證指引，給 AI agent 協作 | 能 |

**預設目標 Level 3**；使用者明說「要 agent-ready / 列可能檔案與測試」才衝 Level 4（但內文仍對齊 template、不攤一堆檔案路徑）。

### 2. Operating Contract（下筆前先 intake）

1. 解析需求 + inspect repo 脈絡（`rg` / 附近 `AGENTS.md` / `README` / `docs/` / issue template / 既有測試 / route / service / migration / 既有 spec）。
2. 先看使用者指定的 target template，再看鄰近範例。
3. 把「產品內容」和「寫作指示」分開（見〈Input hygiene〉）。
4. 找出 **blocking 的產品決策**。
5. **只在還有 blocking 決策時、一次問一個釐清問題**（決策樹，不是問卷轟炸；每題 4 選項 A–D、有把握標推薦）。
6. blocking 產品決策**逐項跟使用者確認過**才草擬 ticket —— 該由使用者拍板的決策**不可只在自己腦中「轉成假設」就下筆**（那是規避確認的後門）；只有 non-blocking 細節能標假設帶過。

材料已夠就別問儀式性問題；non-blocking 缺漏寫進對應欄位、標假設 / 風險。

### 3. Judgment framing（下筆前釐清三件事）

- **問題定義**：誰 / 什麼受影響、今天的限制、造成什麼可觀察的傷害 / 摩擦 / 卡住的流程。
- **成功準則**：要「算解決」需哪些變成真，再翻成 pass/fail 驗收。
- **替代方案**（方向不明顯、或會動到架構 / API / 資料 / 權限 / 相容 / UX / 拆票時才要）：選的方向 + 至少一個合理替代 + 為何不選 + 哪些要人類拍板。

### 4. Template-first（target template 就是輸出契約）

選用順序：① 使用者指名的 template → ② repo 的 `.github/ISSUE_TEMPLATE/*.yml` → ③ 使用者給的既有 issue / spec → ④ 末尾 generic fallback。有 template 時用它的欄位當頂層 section、保留順序、不亂加；non-goals / 風險 / 依賴 / 未決問題塞「注意事項」類欄位；實作提示預設不進內文。

**House-style 對齊（讓同 repo 的 issue 長得一致）**：選定 template 後，先抓 1–2 張 repo 內**用同一 template 開、且寫得好**的既有 issue 當 exemplar，比對並沿用它的**具體呈現慣例**——section header 階層（H1 `#` vs H2 `##`…）、是否把標題那欄（如「功能名稱」）也當 body 第一段重述、UI 段用文字還是 ASCII 線框、語氣與顆粒度。**template 決定「有哪些欄位」，exemplar 決定「這些欄位長什麼樣」**；兩者都對齊才算統一（同一 template 在不同人手上可長得很不一樣，光套 template 不夠）。

### 5. Flow diagram & UI mockup policy

多 actor / 非同步 / 背景工作 / 狀態轉移 / 多分支 / 超過三步才到結果 → 在「詳細說明」放 mermaid `flowchart`，節點標籤自然繁中。圖講產品 / 系統行為，不攤實作瑣節。

**UI mockup policy**：UI-bearing 的票（新畫面 / 對話框 / 控制項 / 狀態變化）在「UI 設計」段放 **ASCII 線框圖**（` ```text ` 區塊），把**主畫面 + 關鍵狀態各畫一張**（展開 / 空 / 載入 / 錯誤），而非只用文字描述；線框只示意結構與內容、不規範像素。沿用 repo exemplar 的 ASCII 風格（box-drawing 與標註慣例）。

### 6. Scope sizing（太大先拆）

太大訊號：多個不相關畫面 / 大架構改動 / 新資料模型+UI+migration+背景工作 / 業務規則不清 / 太多未知。太大 → 下筆前提拆票，每票「目的 / 包含 / 不包含 / 可驗收結果」。能各自獨立 ship → **vertical slice**；要先有資料模型 / 基建 → **foundation-first**。

### 7. 建 issue → 交 goal

**開 issue 前先跟使用者確認清楚**——下筆前所有 blocking 產品決策必須已逐項跟使用者確認（非自行轉假設，見 Operating Contract step 6 與「路線定案 ≠ 全部定案」）。草稿（依選定 template）寫**暫存 tmp 檔**給使用者逐字校稿（依 `references/comment-policy.md`）→ 草稿與決策**兩者都確認後**才 `gh issue create --title "<繁中標題>" --body-file <tmp> --assignee @me` → 拿到新 issue#、**送出後刪 tmp** → 進 `goal`。slug 用 `<新 issue#>-<kebab>`、loop.md 類型 = issue、**並依 issue 性質寫入 `operation` 欄**（`new-feature` / `change-behavior` / `bug-fix` / `refactor`，見 `references/operation-first-move.md`；拿不準向嚴 `new-feature`）——因 define 是無 issue 工作建 loop.md 的入口（非 dispatch），operation 由 define 寫；漏寫時 goal 會兜底補。
intake 已釐清 + 結構化，**goal 多半能直接從這張 issue 抽出六欄 DoD、不必重複訪談**。

## Input hygiene（把寫作指示濾掉）

「用繁中 / 別混英文 / 照 template / 加流程圖」這類是**寫作約束**、不是 ticket 內容 —— 默默拿來塑形輸出，**不可**寫進 ticket 任何欄位。下筆前掃掉外洩的 prompt 文字（「請參考 template」「as an AI」…）。

## 語言

issue 內文用自然繁中；英文只留**真正的 identifier / 路徑 / API / 指令 / enum / 型別 / 套件名 / 內部專名**。別為了顯技術硬留英文 jargon、別用 `Modified Flow` 這種英文 section 標題。

## Ticket 品質審查模式（審 / 重寫既有 ticket）

使用者丟一張**既有 ticket** 要 review / 批評 / 清理 / 重寫時用。回固定結構：**目前等級**（Level 0–4 + 理由）/ **主要問題**（1–3）/ **會害工程師回頭問的缺資訊** / **範圍風險** / **建議重寫策略** / **改寫後草稿**（資訊夠才寫，不夠就改成問釐清問題）。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「點子大致懂了，直接開 issue」 | 「大致」= Level 0–1，工程師開不了工。先 intake 到 Level 3。 |
| 「研究已把路線定案，產品決策我直接代填就好」 | 路線定案 ≠ scope/UX/邊界定案。會改變本票的產品決策一律 `gh issue create` 前跟使用者確認，別當假設吸收。 |
| 「先把 issue 開了，body 之後再 `gh issue edit` 補」 | 開 issue 是 outward 動作。該確認的決策要 create 前問清，不是先 post 再補救。 |
| 「一次把問題全問完比較快」 | 一次多問會跳答 / 漏答；一次一問才能用前一答收斂後一問。 |
| 「使用者沒指定 template，我自由發揮」 | 先找 repo `.github/ISSUE_TEMPLATE/`，那是輸出契約；沒有才用 generic fallback。 |
| 「把使用者『請用繁中』也寫進 issue」 | 那是寫作約束、不是 ticket 內容。默默照做、別寫進內文。 |

## Red Flags

- 只寫「加 X 支援 / 改善 Y / 讓 Z 更聰明 / 處理 edge case / 優化效能」= 沒內容。
- 忽略 repo 的 issue template、自創結構。
- 該有 flowchart（多步流程）卻沒有。
- UI-bearing 票該有 ASCII 線框卻只用文字描述；或 header 階層 / 結構與 repo 既有同-template issue 不一致（沒對齊 house-style exemplar）。
- 驗收條件無法 pass/fail 驗證。
- 該是產品決策的，卻留成「未決問題」丟回工程師。
- **把該由使用者拍板的產品決策當假設、沒確認就 `gh issue create`**（最常見於「已研究定案」/ backlog 捷徑下偷渡）。
- 把 prompt / 寫作指示複製進 ticket 內文。

## Verification

- [ ] ticket 達 **Level 3**（不熟領域的工程師也懂 scope / 脈絡 / 預期行為），用了 repo 的 issue template 欄位與順序。
- [ ] 問題定義 + 成功準則清楚，驗收 pass/fail 可觀察。
- [ ] 多步流程有 flowchart；寫作指示沒洩進內文；繁中自然、英文只剩 identifier。
- [ ] 對齊 repo house-style exemplar（header 階層 / section 集合 / 重述標題段與否 / 語氣一致）；UI-bearing 票的「UI 設計」段有 ASCII 線框（主畫面 + 關鍵狀態）。
- [ ] **開 issue 前**所有 blocking 產品決策已逐項跟使用者確認（非自行轉假設；「已研究定案」捷徑也不例外）。
- [ ] 草稿經使用者校稿 → `gh issue create --assignee @me` → 刪 tmp → 進 goal。

## Generic fallback（沒任何 template 才用，別硬塞每欄）

`背景/動機 · 目標 · 非目標 · 需求範圍 · 使用者/系統流程 · 行為規格 · UI/互動狀態 · API/資料模型/權限 · 錯誤處理與邊界 · 相容/遷移/回滾 · 可能相關模組與檔案 · 實作方向(非強制) · 測試與驗收 · 未決問題`
