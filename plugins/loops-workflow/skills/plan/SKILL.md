---
name: plan
description: Locks design decisions and breaks work into independently verifiable tasks before any code. Use when starting the plan stage of a loops-workflow run, or when an explored approach needs to become a concrete, task-by-task implementation plan.
---

# plan — 規劃（拍板方案 + 可驗證任務拆解）

## Overview

`plan` 在動任何 code 之前，把設計決策**拍板留痕**，並把工作拆成「每一個都能獨立 verify」的任務。產出 `02-plan.md` —— 一份施工圖：決策紀錄 + 機制圖 + 任務清單（每任務帶驗證指令）。

> `02-plan.md` 文件本體的**完整 §0–§9 施工圖骨架**（系統全貌 + **檔案落點與職責表** + 機制圖 + 名詞說明 + 決策含**具名 OSS 背書** + 三角驗證附錄 + 成果展示）見 `references/design-plan-schema.md` —— 下面 Process 各步驟的產出即歸位到該骨架（決策留痕→§6、機制圖→§2、品質維度→§4）。

做法：先把設計決策留痕、為每個關鍵機制畫圖、對新套件做選型評估，再把工作拆成每個都能獨立 verify 的任務。

## When to Use

**Use when**：explore 已選定方法、要把它變成 task-by-task 的施工計畫；或需求清楚、直接要拆可驗證任務。

**NOT for**：
- 方法還沒定 —— 回 explore。
- 已有拍板計畫、要開始寫 code —— 直接 build。

## Process

### 1. 決策留痕（decision record 五欄）

每個設計決策記一筆：**情境 / 選項 / 決定 / 理由 / 後果（Consequences）**。涉及取捨的用 `AskUserQuestion` 給使用者拍板，每選項標推薦 + 理由。ADR 模板見 `references/adr-template.md`。

### 2. 套件評估（若要引入新套件）

任何新依賴走：掃現有 deps → 列 **≥3 候選** → 比較表 → `AskUserQuestion` 拍板。不接受「直接用最熱門」。

### 3. 機制圖（每機制：白話 + 兩張圖）

對每個關鍵機制，寫「一段白話 + 兩張 mermaid」：一張**運作流程圖**（資料 / 控制怎麼跑）、一張**注入 / 接線圖**（誰被注入到誰、怎麼接線）（只有文字敘述不算數）。寫進 `02-plan.md`，**而且第 6 步拍板 gate 一定要把這些圖直接渲染給使用者看** —— 圖是給使用者審「怎麼跑 + 怎麼接線」用的，不能只躺在 `02-plan.md`、也不能只塞進精煉版 alignment comment。

### 3.5 契約規格（跨介面才寫）

feature 一旦動到 **API / 資料模型 / 事件 / 跨模組或前後端共用介面** → 在 `02-plan.md` 拉一段**契約規格**（依 `references/contract-spec.md`）：API request / response / 錯誤形狀、資料 schema + 約束 + migration 可逆性、事件 payload + 保證，以及**每條契約對到哪一層測試**（對齊 `references/test-rubric.md`）。契約是 **build 的輸入、verify 的驗收基準**。純內部重構（不動對外形狀）免寫。

### 4. 品質維度過一遍

- **設計品質六維度**（簡潔 / 可維護 / 可靠 / 可擴展 / 安全 / 高併發高流量效能）+ **clean architecture 結構標準**（依賴向內 / 分層邊界 / port + 注入 / 落點對齊，見 `references/clean-architecture.md`）：in-scope 實作不以 MVP 設計，對可預見的規模退化預先用對的演算法**與結構**。
- **設計模式對症選型**（見 `references/design-patterns.md`）：設計某機制時，若問題本來就是某模式的經典形狀（多變體 / 可替換演算法 / 解耦通知…）就用對的模式 —— **對症才用、不為套而套**（YAGNI）。
- **重用檢查**（判準見 `references/reuse-check.md`）：拆任務前先確認沒有重複造輪子（含跨入口 / 跨 session 的隱蔽重複；稍異 ≠ 另造，優先參數化既有方法）。
- **（風險大 / 不顯而易見的設計）派設計品質審查**：設計影響面大或方向沒把握時，**派 read-only agent 對 `02-plan.md` 的設計做「六維度 + 落點對齊 + 契約」品質審查**（像 verify 的寫 code 前縮小版），出「方向可行 / 要修 / 資訊不足」判定 —— 別等 build 完才在 verify 發現方向就錯。微小 / 一目了然的設計免派。

### 5. 拆成可驗證任務

每個任務用模板（見 `references/task-template.md`）：**Description / Acceptance / Verification（具體指令）/ Dependencies / Files / Scope**。其中 **Verification 欄必須是能實際跑的指令**（不是「測一下」）。

「**該再拆**」四訊號 —— 命中任一就再切小：
- 預估 > 2 小時
- Acceptance 條件 > 3 條
- 跨 2+ 子系統
- 標題裡有 "and"

畫依賴圖；每 2–3 個任務插一個 checkpoint。

**（可選）機器可驗證計畫塊**：要讓進 build 前能自動把關，可在 `02-plan.md` 內嵌一塊 `loops-plan` JSON（見 `references/machine-plan-schema.md`），跑 `node scripts/validate-plan.mjs <02-plan.md>` 檢查（每任務有可執行 verification、acceptance ≤3、依賴無環）。預設不開。

### 5.5 （可選）Fleet 方案發想

解法空間寬、單一方案難取捨時，可 opt-in **Fleet**：派 N 個 agent 各從不同角度（MVP-first / risk-first / user-first）出方案 → judge panel 評分 → 綜合最高分 + 嫁接次高的好點子（見 `references/fleet.md`）。預設不開，使用者說「這題用 Fleet 出幾個方案評審」才啟動。

### 6. 送出計畫 + 拍板 gate

**在 plan 階段就把計畫草稿送出**（不是等 loop 結束）：issue-driven → 依 **`references/plan-comment-template.md`（完整版：系統全貌 + 套件清單含版本 + ADR + 機制圖 + 施工圖 + 契約 + out-of-scope）** 寫暫存 tmp 草稿校稿後 post 成 issue 對齊 comment（留 audit trail，**post 後刪 tmp**；更新既有 comment 用 `gh api --method PATCH repos/<owner>/<repo>/issues/comments/<id> -F body=@<tmp>`）；非 issue → 呈現給使用者。**這則 comment 是 living as-built 摘要**，build 偏離時回來同步更新（含已 post 的版本）。

**拍板前一定把第 3 步的機制圖直接渲染給使用者看** —— 每機制「一段白話 + 運作流程圖（mermaid）+ 注入 / 接線圖（mermaid）」。**機制圖直接放進對齊 comment**（GitHub 原生渲染 mermaid，所以圖就在 comment 裡，不再只躺 `02-plan.md`）；更深的逐 cycle 細節才指到 `02-plan.md`。

**同時攤一份「我做的假設 → 現在糾正我」清單**：把技術 / 架構 / 範圍 / 平台層面那些**沒問、但默默假設**的事編號列出給使用者看。這跟內部的 HYPOTHESIS+CONFIDENCE 不同 —— 是把藏在決策底下的假設**顯式**攤出來，趁拍板前糾正；比 build 到一半才發現假設錯便宜得多（對齊規則 10 成本意識）。

然後**一定停在 `plan → build` 拍板 gate**（`AskUserQuestion`）—— **進 build 前務必先問使用者、不可自行跨入 build**（即使 routine 也要在此 gate 停）。gate 要把使用者要拍板的點顯式列出並**標推薦**：方案 + 任務拆解、**所有新增套件（逐一列出名稱+版本+用途，附推薦，使用者核可後才裝）**、以及任何需要使用者定奪的決策。**新套件 / 新決策一律先問 + 推薦，不先斬後奏**；build 中途若冒出計畫外的新套件或新決策，也停下回此 gate 問。

> **`02-plan.md` 是 living source of truth**：實作階段若偏離（決策變、任務拆法變），**回去更新它**（並同步已 post 的版本），保持 as-built —— 不是放到 loop 結束才補。完工時這份 as-built plan 提煉成 PR body（見 `references/pr-spec.md`）。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「決策理由我記得，不用寫」 | 不留痕，build / verify / 之後的你都得重新推一遍，還可能推出不同結論。 |
| 「直接用最多人用的套件就好」 | 沒評估就引入，等於把選型風險留給未來。≥3 候選比較是硬規矩。 |
| 「Verification 欄寫『跑測試』就好」 | 「跑測試」不可執行。要寫到能複製貼上去跑的指令，否則 build 沒法自證。 |
| 「任務有點大但還好」 | 命中四訊號就是該拆。大任務沒法獨立 verify，reviewer 也沒法乾淨地接受或退回。 |

## Red Flags

- 有設計決策沒記 decision record。
- 引入新套件沒有 ≥3 候選比較表。
- 任務的 Verification 欄不是可執行指令。
- 任務命中「該再拆」訊號卻沒拆。
- 對齊 comment **沒用完整版樣板**（缺套件清單 / ADR / 機制圖 / 施工圖）、或機制圖沒放進 comment —— 等於要使用者盲拍設計。
- **沒在 `plan → build` gate 問使用者就自行跨入 build**（即使 routine 轉場也要在此停下問）。
- **新增套件沒逐一列出（名稱+版本+用途）+ 標推薦 + 等使用者核可就先裝**；或 build 中途冒出計畫外套件/決策卻沒停下回 gate 問。

## Verification

- [ ] `02-plan.md` 有 decision record（含 Consequences）+ 機制圖（白話 + 兩圖）。
- [ ] 拍板 gate 已把每機制的**運作流程圖 + 注入 / 接線圖渲染在 chat 給使用者看**（不只躺在 `02-plan.md` / 不只給精煉 comment）。
- [ ] 新套件（若有）附 ≥3 候選比較 + 拍板結論。
- [ ] 每個任務有可執行的 Verification 指令。
- [ ] 沒有任務命中「該再拆」四訊號還未拆。
- [ ] 計畫草稿已在 **plan 階段送出**（issue→post 對齊 comment / 否則呈現），不是留到 loop 結束。
- [ ] 對齊 comment 用**完整版樣板**（`references/plan-comment-template.md`：系統全貌+套件清單+ADR+機制圖+施工圖+契約+out-of-scope），機制圖直接放進 comment。
- [ ] **進 build 前在 gate 問了使用者**（沒自行跨入），且**所有新增套件已逐一列出+推薦+取得核可**，新決策已先問+推薦。
- [ ] 使用者已拍板，停在 `plan → build` gate。
