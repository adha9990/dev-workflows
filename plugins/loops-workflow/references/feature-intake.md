# feature-intake —— 把點子 / 不確定問題變成「template-ready GitHub issue」

> dispatch 的「無 issue 的待解決問題」分支用：在進 goal 之前，先把使用者丟來的點子 / 粗略需求 / 對話筆記 / 截圖，整理成一張**工程師、reviewer、QA、（必要時）AI agent 都看得懂、能實作 / 驗證**的 issue。
>
> 產出**不是 PRD、不是工程計畫、不是長 prompt** —— 是一張可直接貼進 repo issue tracker 的 ticket。讀者：①一般技術力但不熟領域的全端工程師、②要驗正確性的 reviewer / QA、③（必要時）協助的 AI coding agent。

## Readiness Model（先分級再下筆）

| Level | 名稱 | 意思 | 工程師能開工？ |
|---|---|---|---|
| 0 | Idea | 只有粗略概念 | 否 |
| 1 | PM-readable | PM 懂、別人未必 | 否 |
| 2 | Engineer-readable | 熟的工程師能實作 | 也許 |
| 3 | New-engineer-ready | 不熟領域的工程師也懂 scope / 脈絡 / 限制 / 預期行為 | 能 |
| 4 | AI-agent-ready | 再加 repo-aware 邊界 + 驗證指引，給 AI agent 協作 | 能 |

**預設目標 Level 3**；使用者明說「工程師會用 AI agent / 要 agent-ready / 要列可能檔案與測試」才衝 Level 4。Level 4 ≠ 把每條檔案路徑 / 內部服務 / 測試型別都攤在內文 —— 用 repo inspection 讓 ticket 準確，但內文仍對齊 template 與讀者。

## Operating Contract（下筆前先 intake）

1. 解析需求 + inspect 相關 repo 脈絡（`rg` / 附近 `AGENTS.md` / `README` / `docs/` / issue template / 既有測試 / route / service / migration / 既有 spec）。
2. 先看使用者明確指定的 target template，再看鄰近範例。
3. 把「產品內容」和「寫作指示」分開（見〈Input hygiene〉）。
4. 找出 **blocking 的產品決策**。
5. **只在還有 blocking 決策時、一次問一個釐清問題**。
6. blocking 決策答完（或明確轉成假設）才草擬 ticket。

材料已夠就別問儀式性問題；non-blocking 缺漏直接寫進對應欄位、標成假設 / 風險。使用者要「快速 best-effort 草稿」→ 帶假設草擬、標 draft、未決問題留可見。

## Judgment framing（下筆前釐清三件事）

- **問題定義**：誰 / 什麼受影響、今天的限制是什麼、造成什麼可觀察的傷害 / 摩擦 / 卡住的流程。
- **成功準則**：產品問題要「算解決」需哪些變成真，再翻成 pass/fail 驗收。
- **替代方案**（方向不明顯時才要）：選的方向 + 至少一個合理替代 + 為何不選 + 哪些要人類拍板。

替代方案選擇性使用 —— 只有需求會動到架構 / API 行為 / 資料模型 / 權限 / 相容性 / 非同步流程 / UX 方向 / 拆票，或「使用者提的 feature 聽起來只是其中一種解法、不是底層需求」時才要。釐清時先問**最高槓桿的缺口**（問題邊界 / 成功門檻 / 選哪條路），不要先糾結用字。

## Template-first（target template 就是輸出契約）

選用順序：① 使用者指名的 template / 欄位 / 範例 → ② repo 的 issue template（`.github/ISSUE_TEMPLATE/*.yml`）→ ③ 使用者給的既有 issue / spec → ④ 本檔末的 generic fallback。

有 template 時：用它的欄位當頂層 section、保留順序、不亂加頂層 section；non-goals / 風險 / 依賴 / 未決問題塞進「注意事項 / notes」類欄位；實作提示預設不進內文（除非 template 要 / 使用者要 agent-ready）。

## 一次一問的釐清訪談（決策樹，不是問卷轟炸）

- blocking 決策還在時，**一回合只問一題**。
- 每題給 **4 個選項 A–D**、盡量互斥、有把握就標 `（建議）` + 一句後果 / 取捨。
- 能從 repo / 材料 / 截圖 / 前面答案推得的不要問。
- 使用者自由作答就 map 到最近的決策繼續。
- 不要倒出整串未來問題。

## Scope sizing（太大先拆）

太大訊號：多個不相關畫面 / 大架構改動 / 新資料模型+UI+migration+背景工作 / 業務規則不清 / 太多未知 / 跨多模組無明確整合點 / 無法用小驗收清單驗。
太大 → 下筆前提拆票，每票「目的 / 包含 / 不包含 / 可驗收結果」。能各自獨立 ship / 驗 → **vertical slice**；要先有資料模型 / 基建才能做 UI → **foundation-first**。

## Flow diagram policy

多 actor / 系統邊界、非同步 / 佇列 / 背景工作 / watcher / 輪詢 / 重試、會影響使用者可見結果的狀態轉移、成功 / 失敗 / 忽略 / 抑制 / 越界分支、超過三步才到最終結果 —— 任一就在「詳細說明」放一張 mermaid `flowchart`。節點標籤用自然繁中，英文只留 exact code / API identifier。圖是講產品 / 系統行為，不是攤實作瑣節。

## Input hygiene（把寫作指示濾掉）

「用繁中 / 別混英文 / 照 template / 加流程圖 / 你該怎麼想」這類是**寫作約束**、不是 ticket 內容 —— 默默拿來塑形輸出，**不可**寫進 ticket 的任何欄位 / 驗收 / 風險。下筆前掃掉外洩的 prompt 文字（「請參考 template」「請使用繁體中文」「as an AI」…）。

## 語言

issue 內文用自然繁中；英文只留**真正的 identifier / 路徑 / API / 指令 / enum / 型別 / 套件名 / 內部專名**，或翻了會失準的技術術語。別為了顯技術硬留英文 jargon；別用 `Modified Flow` 這種英文 section 標題（用「修改事件流程」）。

## 收尾：建 issue → 交 goal

草稿（依選定 template）寫**暫存 tmp 檔**給使用者逐字校稿（依 `comment-policy.md`）→ 確認後 `gh issue create --title "<繁中標題>" --body-file <tmp> --assignee @me` → 拿到新 issue#、**送出後刪 tmp** → 進 goal。
intake 已做過釐清訪談 + 結構化，**goal 多半能直接從這張 issue 抽出六欄 DoD、不必重複訪談**（goal 的「能推得的不要問」）。

## Quality gate（送出前自檢）

問題定義夠清楚讓工程師知道在解什麼？成功準則能翻成可觀察驗收？有意義的替代方向有寫明選哪條 + 未決的人類決策？內文用了 target template 的欄位與順序？寫作指示沒洩進內文？繁中自然、英文只剩 identifier？多步流程有 flowchart？驗收是 pass/fail 可觀察？

## Anti-patterns

只寫「加 X 支援 / 改善 Y / 讓 Z 更聰明 / 處理 edge case / 優化效能 / 重構」= 沒內容；忽略 repo issue template；該有 flowchart 卻沒有；無謂 `V1` 卻沒 `V2`；`0. 如何讀這張票`；長 AI prompt 塞進內文；英文標題滿天飛；驗收無法 pass/fail；該是產品決策的卻留成未決問題；prompt 文字複製進內文。

## Generic fallback（沒任何 template 才用，別硬塞每欄）

`背景/動機 · 目標 · 非目標 · 需求範圍 · 使用者/系統流程 · 行為規格 · UI/互動狀態 · API/資料模型/權限 · 錯誤處理與邊界 · 相容/遷移/回滾 · 可能相關模組與檔案 · 實作方向(非強制) · 測試與驗收 · 未決問題`
