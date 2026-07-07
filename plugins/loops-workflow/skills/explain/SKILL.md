---
name: explain
user-invocable: false
description: Produces an engineer understanding pack for a change — implementation walkthrough, ownership self-check questions, and a design-direction recap — to help an engineer grasp how built work, a PR, a branch, or a diff connects. Use when an engineer needs to understand an implementation, take over existing code, or confirm they truly understand what was built. For engineer understanding, not for reviewers. Read-only, not part of the build loop.
---

# explain — 工程師理解包（側用，不在迴圈裡）

## Overview

`explain` 產生一份「工程師理解包」，幫人**快速看懂一份改動怎麼接起來**、並**自測是否真的懂**。它是 read-only 的**側用工具**，不在 7 階段迴圈裡、不改 code、沒有 gate —— 隨時可對「built work / PR / branch / diff」呼叫。

> **這隻是 comprehension debt（理解債）的對策**：loop 跑得快、容易產出沒人讀懂的 code，理解落差會累積；`explain` 就是讓人補上理解、把債還掉的工具（見 `AGENTS.md` 規則 12 後的失敗模式註）。完整迴圈完工且 **`LOOPS_EXPLAIN=1`** 時由 iterate 觸發自動產出；未開＝不產（觸發語意的單一真相源在 iterate skill）。

> **對象是工程師，不是 reviewer。** 用途：接手 / 維護一段 code 想快速理解；看懂 Claude 剛建好的東西；自己確認真的懂自己做了什麼。（reviewer 要的是 verify 報告與 PR comment，不是這份。）

> **與 `CHECKLIST.md` 分工（別重疊）**：explain 問「**懂了沒**」（實作導讀 + 5 題自測，opt-in `LOOPS_EXPLAIN`）；verify 步驟 4 產的 `CHECKLIST.md` 問「**做到了沒**」（GWT/AC 逐條驗收，一律產、不吃旗標，見 `references/acceptance-review.md §六`）。兩者互補 —— explain **不重述** acceptance 逐條，收尾兩份各給一次。

## When to Use

**Use when**：工程師要理解一份既有實作 / PR / diff、接手別人的 code、或確認自己真的懂剛建好的東西。

**NOT for**：
- 跑開發（那走 `dispatch` / 各階段）。
- 改 code（這隻只讀、只產說明）。

## 標的

`explain <target>`：target 可以是當前 build 成果（讀 `.loops/03-build.md` + working tree diff）、PR 號、branch、或一段 diff。先確定要解釋哪一份改動。

## 產出（三段，markdown）

### 1. 實作導讀（walkthrough）

追這份改動「從頭到尾怎麼接」：
- **進入點**：從哪裡被呼叫 / 觸發。
- **責任盒**：經過哪些模組 / 函式，各自負責什麼。
- **介面邊**：跨層 / 跨服務的邊界與契約。
- **payload 流動**：資料怎麼流、被誰轉換。
- **狀態更新 + 錯誤回流**：在哪改狀態、出錯怎麼往回傳。

附 **一張精簡 mermaid 流程圖** + 每步的**證據錨點 `file:line`** + **建議閱讀順序**（先看哪個檔最好懂）。

### 2. Ownership 自測題（5 題）

出 5 題「高層次但與這份改動相關」的問題，每題附**參考解答**，讓人自測是否真的懂：
1. **需求**：這個改動要解決的問題是什麼？怎麼判斷算解決？
2. **設計取捨**：為什麼這樣設計？有什麼別的走法、為什麼沒選？
3. **實作流程**：一個典型請求 / 操作從進入到完成，經過哪些步驟？
4. **API / 介面用法**：用了哪些關鍵 API / 契約？邊界條件是什麼？
5. **防呆與驗證**：怎麼防錯？怎麼驗證它真的對（測試 / 實跑）？

> 答不出來的題，就是還沒真懂的地方 —— 指出該回去看哪段。

### 3. 設計方向 recap（可選升級為設計閘）

一句話講這份改動的**工程方向**，並指出**有沒有偏離原始需求 / issue 契約**（方向錯比細節錯更該先抓）。

**Opt-in 設計閘**：要「先判一份既有 diff / PR 的方向對不對、還不想跑完整 verify」時，把 recap 升級成三態判定（**不是預設、明確要求才做**）：

- `方向可行`：設計方向對得上需求、無重大結構疑慮。
- `要修`：方向或結構有該先解決的問題 —— 逐點列「哪個視角（issue-fit / 系統一致 / 邊界 / 契約 / 失敗回復 / 工作量 / 可維護）+ 為什麼 + 建議方向」。
- `資訊不足`：缺關鍵脈絡無法判定（列出要補什麼）。

這是輕量設計篩，**不取代** verify 的 reviewer fan-out；只幫在動更多 code / 跑完整審查前先攔住方向問題。

## Red Flags

- 開始改 code —— 這隻只讀、只產說明。
- 導讀只列檔名沒有 `file:line` 證據錨點。
- Ownership 題問得太細碎（變成 code quiz），失去「確認真的理解」的高層次性。

## Verification

- [ ] 三段齊全：實作導讀（含圖 + 證據錨點 + 閱讀順序）、5 題自測（含參考解答）、設計方向 recap（若被要求設計閘則出三態判定）。
- [ ] 全程未改任何檔案。
- [ ] 證據錨點 `file:line` 對得上實際 code。
