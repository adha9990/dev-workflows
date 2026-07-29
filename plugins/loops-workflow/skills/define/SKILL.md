---
name: define
user-invocable: false
description: Turns any new work that has no GitHub issue yet into a structured, template-ready issue plus a Goal Contract — exploring the repo before asking anything, and asking one blocking decision at a time. The single entry for creating ANY issue (never ad-hoc gh create). Routed to by dispatch for all no-issue work, including vague one-liners. NOT for an existing issue (→ plan).
---

# define — 把問題具體化成 issue ＋ Goal Contract

## Overview

`define` 是 phase 1：把使用者丟來的點子 / 粗略需求 / 對話筆記 / 截圖，整理成一張**工程師、reviewer、QA、（必要時）AI agent 都看得懂、能實作 / 驗證**的 GitHub issue，並同時寫出這條工作的 **Goal Contract**。

產出**不是 PRD、不是工程計畫、不是長 prompt** —— 是一張可直接貼進 issue tracker 的 ticket，加上一份任何入口都解析得出來的工作契約。

**#219 起 define 也吃模糊的一句話**（原本獨立的釐清階段退場）。差別在做法：**先探索現況，再一次問一個 blocking 決策**。尚未理解現有實作就訪談，只會把問題越問越偏——而且很容易問出「查 code 就有答案」的題目，把 agent 該做的事推回給人。

> **投入檔位在這裡調的是 issue 的下筆深度**（`AGENTS.md` 規則 25，逐項對照表在 `references/stages/effort-profile.md` §C，此處不重抄）：`direct` 用 repo template 但只填**問題 / 期望行為 / 驗收**三段、Unknowns Register 只列 blocking（通常是空的）；`standard` 完整 template；`deep` 再加 `decision-interview` 訪談與 blind-spot pass。**建 issue 本身是地板，任何檔位都不省**（規則 12）。define 期間**只要冒出一條 blocking unknown 就 `R-unknown` 升檔一級**——那正是「這件事沒有想像中清楚」的訊號。define 建 loop.md 時（§7）也一併寫「投入檔位」欄。

## When to Use

**Use when**：要開始**任何還沒有 GitHub issue 的工作**（功能 / 修正 / 研究），不論需求是清楚還是只有一句話。define 是**所有 issue card 的唯一入口：一律經 define + repo template，不 ad-hoc 直接 `gh issue create`**（AGENTS 規則 12）。（`user-invocable: false`：由 dispatch 對無-issue 工作內部驅動。）

**NOT for**：
- 已有 GitHub issue —— 直接 `plan`（define 是「建 issue」，不是精煉既有）。
- 已核准的 plan / 要修 PR 回饋 —— `build`。

**ticket 一律用 repo `.github/ISSUE_TEMPLATE` 寫**。issue 分兩型，**都是 issue、都走同一條路**：

- **implementation** —— 要改 code 的功能 / 修正。做法不確定時在「詳細說明 / 注意事項」標明**實作方式待研究**，該 issue 的 `plan` 會先探索再設計。
- **research** —— 交付物是研究結論本身（需要長時間、多來源、外部成本、會產正式決策、或要跨 session 交接時）。它走 `plan(research)`，停在 `research-finalized`；產生實作需求時再 define 一張 implementation issue，**不是直接無票開工**。

## Process

### 1. 先探索，再開口（Explore-before-question）

**在提出第一個問題之前**，先用 Explore capability 取得足以理解現況的 context（見 `references/shared/capability/explore.md`）：現在怎麼運作、有什麼可重用、有什麼限制、既有行為長什麼樣、這個 repo 的 issue 慣例是什麼。

查到的事實寫成共享記憶 claim（`references/shared/runtime/shared-memory.md`）——它們是 `plan` 接著要用的同一批事實，寫一次就不必再查一遍。這些事件同時就是 **exploration receipt**：機械閘讀的是它們，**不要求你另外生一份長篇探索報告**。

> issue 還沒開、還沒有正式 slug 時先在暫存 loop 目錄記，建 loop 後把已驗證的結果接回 canonical loop（**不另建一套追不回來的暫存資料庫**）。

### 2. Readiness Model（先分級再下筆）

| Level | 名稱 | 意思 | 工程師能開工？ |
|---|---|---|---|
| 0 | Idea | 只有粗略概念 | 否 |
| 1 | PM-readable | PM 懂、別人未必 | 否 |
| 2 | Engineer-readable | 熟的工程師能實作 | 也許 |
| 3 | New-engineer-ready | 不熟領域的工程師也懂 scope / 脈絡 / 限制 / 預期行為 | 能 |
| 4 | AI-agent-ready | 再加 repo-aware 邊界 + 驗證指引，給 AI agent 協作 | 能 |

**預設目標 Level 3**；使用者明說「要 agent-ready / 列可能檔案與測試」才衝 Level 4（但內文仍對齊 template、不攤一堆檔案路徑）。

### 3. Decision Queue（一次一個 blocking 決策）

依 `references/shared/capability/decision-queue.md` 跑：

1. 取用步驟 1 的 evidence 與已決 decisions；
2. 找出仍 blocking 的最高優先決策（**會改變 scope／行為／驗收／架構**的才算）；
3. **一次只問一個** `decision_id`，開一個決策點給 2–4 選項、有把握標推薦（表述形狀與平台映射見 `references/shared/delivery/interaction-adapter.md`）；
4. 寫入答案與 provenance（誰決定的、依據什麼）；
5. **重算**剩餘問題——被這個答案消除的不得照舊再問，性質改變的要改寫再問；必要時回步驟 1 做**局部**補探索（不是重新熟悉整個 repo）。

材料已夠就別問儀式性問題；non-blocking 缺漏寫進對應欄位、標假設 / 風險。

**blocking 產品決策逐項跟使用者確認過才草擬 ticket** —— 該由使用者拍板的決策**不可只在自己腦中「轉成假設」就下筆**（那是規避確認的後門）。

> **問題本身就找不齊時走完整訪談**：連「該問什麼」都不確定（acceptance 講不清、疑似有沒寫下的隱性規則）→ 用 `skills/decision-interview` 把 tacit knowledge 與盲點挖成四象限 Unknowns Register；已確認的轉 `known-known` 寫進 AC，未決的標 owner 與 blocking（見 `AGENTS.md` 規則 18）。

> **路線定案 ≠ 全部定案**：即使研究 / 討論已鎖定**技術路線**（用哪個 library / 架構），會改變本票 **scope / 驗收 / UX / 邊界**的**產品決策**（例：某 UI 要不要納本票、gate 要不要納 + severity、資料格式取捨…）仍必須在 `gh issue create` 前逐項跟使用者確認。

### 4. Judgment framing（下筆前釐清三件事）

- **問題定義**：誰 / 什麼受影響、今天的限制、造成什麼可觀察的傷害 / 摩擦 / 卡住的流程。
- **成功準則**：要「算解決」需哪些變成真，再翻成 pass/fail 驗收。驗收標準用 **Given-When-Then 場景**寫（見 `references/stages/bdd-scenarios.md`），每條給 ID（`S1`、`S2`…）；**右尺寸**：瑣碎 / bug-fix 從簡（bug-fix 一條重現場景即可），高風險才寫完整場景集。這些場景之後是 test-author 的輸入、verify acceptance 閘的核對項。
- **替代方案**（方向不明顯、或會動到架構 / API / 資料 / 權限 / 相容 / UX / 拆票時才要）：選的方向 + 至少一個合理替代 + 為何不選 + 哪些要人類拍板。

### 5. Template-first（target template 就是輸出契約）

選用順序：① 使用者指名的 template → ② repo 的 `.github/ISSUE_TEMPLATE/*.yml` → ③ 使用者給的既有 issue / spec → ④ 末尾 generic fallback。有 template 時用它的欄位當頂層 section、保留順序、不亂加；non-goals / 風險 / 依賴 / 未決問題塞「注意事項」類欄位；實作提示預設不進內文。

**House-style 對齊（讓同 repo 的 issue 長得一致）**：選定 template 後，先抓 1–2 張 repo 內**用同一 template 開、且寫得好**的既有 issue 當 exemplar，比對並沿用它的**具體呈現慣例**——section header 階層（H1 `#` vs H2 `##`…）、是否把標題那欄也當 body 第一段重述、UI 段用文字還是 ASCII 線框、語氣與顆粒度。**template 決定「有哪些欄位」，exemplar 決定「這些欄位長什麼樣」**。

### 6. Flow diagram & UI mockup policy

多 actor / 非同步 / 背景工作 / 狀態轉移 / 多分支 / 超過三步才到結果 → 在「詳細說明」放 mermaid `flowchart`，節點標籤自然繁中。圖講產品 / 系統行為，不攤實作瑣節。

**UI mockup policy**：UI-bearing 的票（新畫面 / 對話框 / 控制項 / 狀態變化）在「UI 設計」段放 **ASCII 線框圖**（` ```text ` 區塊），把**主畫面 + 關鍵狀態各畫一張**（展開 / 空 / 載入 / 錯誤），而非只用文字描述；線框只示意結構與內容、不規範像素。沿用 repo exemplar 的 ASCII 風格。

### 7. Scope sizing（太大先拆）

太大訊號：多個不相關畫面 / 大架構改動 / 新資料模型+UI+migration+背景工作 / 業務規則不清 / 太多未知。太大 → 下筆前提拆票，每票「目的 / 包含 / 不包含 / 可驗收結果」。能各自獨立 ship → **vertical slice**；要先有資料模型 / 基建 → **foundation-first**。

### 8. 建 issue ＋ 寫 Goal Contract

草稿（依選定 template）寫**暫存 tmp 檔**給使用者逐字校稿（依 `references/shared/delivery/comment-policy.md`）→ 草稿與決策**兩者都確認後**才 `gh issue create --title "<繁中標題>" --body-file <tmp> --assignee @me` → 拿到新 issue#、**送出後刪 tmp**。

接著兩件事一起做完：

- **loop.md**：slug 用 `<新 issue#>-<kebab>`、類型 = issue / research、**並依性質寫入 `operation` 欄**（`new-feature` / `change-behavior` / `bug-fix` / `refactor`，見 `references/stages/operation-first-move.md`；拿不準向嚴 `new-feature`）——因 define 是無 issue 工作建 loop.md 的入口，operation 由 define 寫；漏寫時 `plan` 會兜底補。**同時寫「投入檔位」欄**（用 `scripts/effort-profile.mjs --classify` 算，見 `skills/dispatch` §1.3；define 這時已經探索過現況，判準比 dispatch 進場時更有依據——判出來比 dispatch 原本那格嚴就照嚴的寫，比較鬆則維持原值〔只升不降〕）。
- **Goal Contract**：寫 `.loops/<slug>/goal-contract.md`（骨架與規則見 `references/shared/capability/goal-contract.md`）。逐句抽出的 requirement **收斂成少量 `behavior_id`**（一般 1–5 個，**不是句子數**；behavior ＝ 使用者眼中不同的一件事）；同時讀專案 root ＋ 就近的 `AGENTS.md`/`CLAUDE.md`，把這次會觸及的**跨切面約定**（i18n / logging / a11y / 錯誤處理 / 安全 / 分層）折進 Constraint（見 `references/shared/docs/project-conventions.md`）——**issue 沒寫不代表不用做**。

### 9. H1 · Issue Ready（`stop_after=issue` 就停在這裡）

issue 建好、Goal Contract 寫好之後：

- `stop_after=issue` ⇒ **停**。依 `references/shared/capability/handoff.md` 產 handoff（`handoff.created` → `.loops/<slug>/handoff/issue.md` → `workflow.paused`），內容要交代 issue identity、Goal Contract、behaviors／驗收／限制／out-of-scope、已決 decisions 與 known unknowns 及其 owner、implementation 還是 research、下一個合法入口。**不得**因為 routine transition 就自動建 worktree、進 plan 或開始 build。
- 否則 ⇒ 直接進 `plan`（routine 轉場不問）。

## Input hygiene（把寫作指示濾掉）

「用繁中 / 別混英文 / 照 template / 加流程圖」這類是**寫作約束**、不是 ticket 內容 —— 默默拿來塑形輸出，**不可**寫進 ticket 任何欄位。下筆前掃掉外洩的 prompt 文字（「請參考 template」「as an AI」…）。

## 語言

issue 內文用自然繁中；英文只留**真正的 identifier / 路徑 / API / 指令 / enum / 型別 / 套件名 / 內部專名**。別為了顯技術硬留英文 jargon、別用英文 section 標題。

## Ticket 品質審查模式（審 / 重寫既有 ticket）

使用者丟一張**既有 ticket** 要 review / 批評 / 清理 / 重寫時用。回固定結構：**目前等級**（Level 0–4 + 理由）/ **主要問題**（1–3）/ **會害工程師回頭問的缺資訊** / **範圍風險** / **建議重寫策略** / **改寫後草稿**（資訊夠才寫，不夠就改成問釐清問題）。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「需求很模糊，先問清楚再說」 | 先探索。沒有 repo 脈絡的提問會越問越偏，而且常常問到 code 裡就有答案的事。 |
| 「一次把問題全問完比較快」 | 一次多問會跳答 / 漏答；一次一問才能用前一答收斂後一問。 |
| 「點子大致懂了，直接開 issue」 | 「大致」= Level 0–1，工程師開不了工。先 intake 到 Level 3。 |
| 「研究已把路線定案，產品決策我直接代填就好」 | 路線定案 ≠ scope/UX/邊界定案。會改變本票的產品決策一律 create 前跟使用者確認。 |
| 「先把 issue 開了，body 之後再 `gh issue edit` 補」 | 開 issue 是 outward 動作。該確認的決策要 create 前問清，不是先 post 再補救。 |
| 「使用者沒指定 template，我自由發揮」 | 先找 repo `.github/ISSUE_TEMPLATE/`，那是輸出契約；沒有才用 generic fallback。 |
| 「使用者說只要開 issue，但我順手規劃一下比較貼心」 | 那是跨過他要求的停點。H1 停就是停——他要續跑會自己說。 |

## Red Flags

- 還沒探索就問第一個問題（沒有 exploration receipt）。
- 一則訊息塞了好幾個問題；或前一題的答案已讓某題失去意義還照樣問。
- 只寫「加 X 支援 / 改善 Y / 讓 Z 更聰明 / 處理 edge case / 優化效能」= 沒內容。
- 忽略 repo 的 issue template、自創結構；該有 flowchart（多步流程）／ASCII 線框（UI-bearing）卻沒有。
- 驗收條件無法 pass/fail 驗證；該是產品決策的卻留成「未決問題」丟回工程師。
- **把該由使用者拍板的產品決策當假設、沒確認就 `gh issue create`**。
- behavior 清單照著 issue 的句子數線性長出來（沒收斂，成本會一路放大到 plan / build / verify）。
- 把 prompt / 寫作指示複製進 ticket 內文。
- `stop_after=issue` 卻繼續開 worktree / 進 plan。

## Verification

- [ ] **第一個問題之前已有 exploration receipt**（事件流裡有 `knowledge.claimed`／`context-pack.built`／`context-gap.detected`）。
- [ ] 訪談是**一次一個** blocking 決策，答案有寫回 decision（含 provenance），且重算過剩餘問題。
- [ ] ticket 達 **Level 3**（不熟領域的工程師也懂 scope / 脈絡 / 預期行為），用了 repo 的 issue template 欄位與順序，並對齊 house-style exemplar。
- [ ] 多步流程有 flowchart；UI-bearing 票的「UI 設計」段有 ASCII 線框（主畫面 + 關鍵狀態）；寫作指示沒洩進內文；繁中自然、英文只剩 identifier。
- [ ] **開 issue 前**所有 blocking 產品決策已逐項跟使用者確認（非自行轉假設；「已研究定案」捷徑也不例外）。
- [ ] 草稿經使用者校稿 → `gh issue create --assignee @me` → 刪 tmp。
- [ ] `loop.md` 有 `operation` 欄；`goal-contract.md` 已寫（含收斂後的 behavior 清單與跨切面 Constraint）。
- [ ] `stop_after=issue` ⇒ 已產 handoff（`handoff.created` → handoff note → `workflow.paused`）並**停住**；否則直接進 plan。

## Generic fallback（沒任何 template 才用，別硬塞每欄）

`背景/動機 · 目標 · 非目標 · 需求範圍 · 使用者/系統流程 · 行為規格 · UI/互動狀態 · API/資料模型/權限 · 錯誤處理與邊界 · 相容/遷移/回滾 · 可能相關模組與檔案 · 實作方向(非強制) · 測試與驗收 · 未決問題`
