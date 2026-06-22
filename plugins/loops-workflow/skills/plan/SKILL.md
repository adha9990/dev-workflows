---
name: plan
description: Locks design decisions and breaks work into independently verifiable tasks before any code. Use when starting the plan stage of a loops-workflow run, or when an explored approach needs to become a concrete, task-by-task implementation plan.
---

# plan — 規劃（拍板方案 + 可驗證任務拆解）

## Overview

`plan` 在動任何 code 之前，把設計決策**拍板留痕**，並把工作拆成「每一個都能獨立 verify」的任務。產出 `02-plan.md` —— 一份施工圖：決策紀錄 + 機制圖 + 任務清單（每任務帶驗證指令）。

主體借鑑 work-plugins 的 `plan-from-issue` + 設計計畫書 §0–§9；任務拆解的螺絲借鑑 agent-skills 的 `planning-and-task-breakdown`。

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

對每個關鍵機制，寫「一段白話 + 兩張 mermaid」：一張**運作流程圖**、一張**注入 / 接線圖**（只有文字敘述不算數）。

### 4. 品質維度過一遍

- **clean-architecture 六維度**（簡潔 / 可維護 / 可靠 / 可擴展 / 安全 / 高併發高流量效能）：in-scope 實作不以 MVP 設計，對可預見的規模退化預先用對演算法。
- **reuse**：拆任務前先確認沒有重複造輪子（含跨入口 / 跨 session 的隱蔽重複）。

### 5. 拆成可驗證任務

每個任務用模板（見 `references/task-template.md`）：**Description / Acceptance / Verification（具體指令）/ Dependencies / Files / Scope**。其中 **Verification 欄必須是能實際跑的指令**（不是「測一下」）。

「**該再拆**」四訊號 —— 命中任一就再切小：
- 預估 > 2 小時
- Acceptance 條件 > 3 條
- 跨 2+ 子系統
- 標題裡有 "and"

畫依賴圖；每 2–3 個任務插一個 checkpoint。

### 5.5 （可選）Fleet 方案發想

解法空間寬、單一方案難取捨時，可 opt-in **Fleet**：派 N 個 agent 各從不同角度（MVP-first / risk-first / user-first）出方案 → judge panel 評分 → 綜合最高分 + 嫁接次高的好點子（見 `references/fleet.md`）。預設不開，使用者說「這題用 Fleet 出幾個方案評審」才啟動。

### 6. 拍板 gate

`02-plan.md` 給使用者，停在 `plan → build` 拍板 gate（`AskUserQuestion` 確認方案 + 任務拆解）。

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
- 沒拍板就往 build 跑。

## Verification

- [ ] `02-plan.md` 有 decision record（含 Consequences）+ 機制圖（白話 + 兩圖）。
- [ ] 新套件（若有）附 ≥3 候選比較 + 拍板結論。
- [ ] 每個任務有可執行的 Verification 指令。
- [ ] 沒有任務命中「該再拆」四訊號還未拆。
- [ ] 使用者已拍板，停在 `plan → build` gate。
