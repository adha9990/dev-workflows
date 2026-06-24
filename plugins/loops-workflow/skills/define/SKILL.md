---
name: define
description: Turns a vague idea / uncertain problem / rough requirement into a structured, template-ready GitHub issue before the goal stage — using a Readiness Model, the repo's issue template, one-question-at-a-time intake, scope sizing, and a flow-diagram policy. Use when the user raises a to-solve problem or idea that has no GitHub issue yet, or wants to define / scope / rewrite a feature into a concrete ticket. Routed to by dispatch for no-issue to-solve work. NOT for an existing issue (→ goal) or pure research with no intent to ship (→ explore).
---

# define — 把模糊問題具體化成 issue（再進 goal）

## Overview

`define` 是迴圈最前面的 **DEFINE 階段**：把使用者丟來的點子 / 粗略需求 / 對話筆記 / 截圖，整理成一張**工程師、reviewer、QA、（必要時）AI agent 都看得懂、能實作 / 驗證**的 GitHub issue，讓問題**被追蹤**、後續對齊 comment 有地方 post，再進 `goal` 釘完工定義。

產出**不是 PRD、不是工程計畫、不是長 prompt** —— 是一張可直接貼進 issue tracker 的 ticket。讀者：①一般技術力但不熟領域的全端工程師、②要驗正確性的 reviewer / QA、③（必要時）協助的 AI coding agent。

## When to Use

**Use when**：使用者**想解決 / 實作、但還沒有 GitHub issue** 的問題 / 點子（dispatch 對「無 issue 的待解決問題」會路由到這）。也可獨立呼叫：把一個想法變成結構化 ticket、或審 / 重寫既有 ticket。

**NOT for**：
- 已有 GitHub issue —— 直接 `goal`（define 是「建 issue」，不是「精煉既有 issue」）。
- 純研究 / 探索、未必要落地 —— `explore`（不建 issue）。
- 分不清「要實作 vs 只研究」→ 用 `AskUserQuestion` 問。

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
6. blocking 決策答完（或明確轉成假設）才草擬 ticket。

材料已夠就別問儀式性問題；non-blocking 缺漏寫進對應欄位、標假設 / 風險。

### 3. Judgment framing（下筆前釐清三件事）

- **問題定義**：誰 / 什麼受影響、今天的限制、造成什麼可觀察的傷害 / 摩擦 / 卡住的流程。
- **成功準則**：要「算解決」需哪些變成真，再翻成 pass/fail 驗收。
- **替代方案**（方向不明顯、或會動到架構 / API / 資料 / 權限 / 相容 / UX / 拆票時才要）：選的方向 + 至少一個合理替代 + 為何不選 + 哪些要人類拍板。

### 4. Template-first（target template 就是輸出契約）

選用順序：① 使用者指名的 template → ② repo 的 `.github/ISSUE_TEMPLATE/*.yml` → ③ 使用者給的既有 issue / spec → ④ 末尾 generic fallback。有 template 時用它的欄位當頂層 section、保留順序、不亂加；non-goals / 風險 / 依賴 / 未決問題塞「注意事項」類欄位；實作提示預設不進內文。

### 5. Flow diagram policy

多 actor / 非同步 / 背景工作 / 狀態轉移 / 多分支 / 超過三步才到結果 → 在「詳細說明」放 mermaid `flowchart`，節點標籤自然繁中。圖講產品 / 系統行為，不攤實作瑣節。

### 6. Scope sizing（太大先拆）

太大訊號：多個不相關畫面 / 大架構改動 / 新資料模型+UI+migration+背景工作 / 業務規則不清 / 太多未知。太大 → 下筆前提拆票，每票「目的 / 包含 / 不包含 / 可驗收結果」。能各自獨立 ship → **vertical slice**；要先有資料模型 / 基建 → **foundation-first**。

### 7. 建 issue → 交 goal

草稿（依選定 template）寫**暫存 tmp 檔**給使用者逐字校稿（依 `references/comment-policy.md`）→ 確認後 `gh issue create --title "<繁中標題>" --body-file <tmp> --assignee @me` → 拿到新 issue#、**送出後刪 tmp** → 進 `goal`。slug 用 `<新 issue#>-<kebab>`、loop.md 類型 = issue。
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
| 「一次把問題全問完比較快」 | 一次多問會跳答 / 漏答；一次一問才能用前一答收斂後一問。 |
| 「使用者沒指定 template，我自由發揮」 | 先找 repo `.github/ISSUE_TEMPLATE/`，那是輸出契約；沒有才用 generic fallback。 |
| 「把使用者『請用繁中』也寫進 issue」 | 那是寫作約束、不是 ticket 內容。默默照做、別寫進內文。 |

## Red Flags

- 只寫「加 X 支援 / 改善 Y / 讓 Z 更聰明 / 處理 edge case / 優化效能」= 沒內容。
- 忽略 repo 的 issue template、自創結構。
- 該有 flowchart（多步流程）卻沒有。
- 驗收條件無法 pass/fail 驗證。
- 該是產品決策的，卻留成「未決問題」丟回工程師。
- 把 prompt / 寫作指示複製進 ticket 內文。

## Verification

- [ ] ticket 達 **Level 3**（不熟領域的工程師也懂 scope / 脈絡 / 預期行為），用了 repo 的 issue template 欄位與順序。
- [ ] 問題定義 + 成功準則清楚，驗收 pass/fail 可觀察。
- [ ] 多步流程有 flowchart；寫作指示沒洩進內文；繁中自然、英文只剩 identifier。
- [ ] 草稿經使用者校稿 → `gh issue create --assignee @me` → 刪 tmp → 進 goal。

## Generic fallback（沒任何 template 才用，別硬塞每欄）

`背景/動機 · 目標 · 非目標 · 需求範圍 · 使用者/系統流程 · 行為規格 · UI/互動狀態 · API/資料模型/權限 · 錯誤處理與邊界 · 相容/遷移/回滾 · 可能相關模組與檔案 · 實作方向(非強制) · 測試與驗收 · 未決問題`
