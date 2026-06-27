---
name: distill
description: 跨 loop 自我學習——掃歷史 .loops/ 的 ★outcome/Journal，提煉可復用的方法論 instinct（YAML），供 SessionStart 注入。手動側用工具。
---

# distill — 跨 loop 萃取 instinct（自我學習）

## Overview

`distill` 是**閉環外的手動側用工具**：掃過歷史 `.loops/*/loop.md` 的 Journal 與 `★[outcome]` 度量行，由 **Claude 歸納 3–5 條跨 loop 的「方法論模式」**（不是專案內容），寫成 instinct YAML 存 `.loops/.instincts/`。下次 `hooks/session-start.mjs` 在 opt-in（`LOOPS_INSTINCT_INJECT=1`）時把高信心 instinct 注入新 session —— 讓 loops-workflow 從「孤立可接續迴圈」升級成**有跨 loop 記憶、會自我改進**的工具。

> **簡化版（無 daemon）**：ECC 的 instinct 用 Pre/PostToolUse 逐 tool-call 觀察 + background Haiku observer 萃取。我們**刻意不做** background 基建（plugin 形態 + 成本/複雜度取捨），改用**已有的結構化素材**——loop.md 的 Journal（E1..En）+ `★[outcome]` 行（token 級距 / 回環圈數 / findings 數 / 推進模式 / 交付）——做 **on-demand** 萃取。萃取是**判斷**、不是確定性腳本，所以由 Claude（這隻 skill）做，不是 node。

## When to Use

**Use when**：累積了數條完工 loop、想把「哪類任務易回環 / 哪類 verify findings 最常出現 / 哪種推進模式最省 token / 哪種改動面 verify 派幾軸」這些跨 loop 經驗固化下來，讓未來 session 自動帶入。直接喊 `/loops-workflow:distill`。

**NOT for**：
- 單一 loop 內的進度追蹤 —— 那是 loop.md Journal 的事。
- 想自動、持續觀察每個 tool call —— 本票**刻意不做**（見 Overview 的 daemon 取捨）。
- 把 instinct 升級成強制規則 —— instinct 只是**注入的行為提示**，不改 skill / 規則。

## Process

### 1. 掃素材
讀所有 `.loops/*/loop.md`（**完工的優先**），抽每條 loop 的：類型 / operation 性質 / `★[outcome]` 行（token 級距、sub-agent 數、回環圈數、findings validated→剩餘、交付）、Journal 裡的回環與 escalate 軌跡。

### 2. 歸納跨 loop 方法論模式（3–5 條）
找**跨多條 loop 重複出現**的方法論訊號，例如：
- 「docs-only / 純 markdown 改動 → verify 派 product-contract + docs-devex 2 軸即可」（多條 docs loop 都這樣）。
- 「impl-author / test-author 自報的綠不可採信 → 主線必複跑」（多條 loop 都揪到自報不實）。
- 「reference / 文件數字一律以實際 `ls` 為準、別信算術」。
- 「Stop hook 每回應觸發 → 重 gate 要 accumulator 閘」。
每條配一個 **confidence（0–1，啟發式人工判斷）**：被幾條 loop 佐證、有無反例。

### 3. 寫 instinct YAML（同 id 更新、不重複建）
每條模式寫一個 `.loops/.instincts/<id>.yaml`（schema 見 `references/instinct-schema.md`）。**同 id 已存在 → 更新**那個檔（依新證據調 confidence + 補 evidence slug），**不要再建一個**。`<id>` 用穩定的 kebab-case 主題名（如 `docs-only-verify-rightsizing`）。

### 4. 輸出摘要給人審
列出本次**新增 / 更新**了哪些 instinct（id + confidence + 一句 summary + evidence 指向哪幾條 loop），讓使用者過目——instinct 會被注入未來 session，必須人可審、可刪。

## 隱私與誠實（硬規範）

- **只存方法論層級的模式**，不存專案內容 / 業務字眼 / 程式碼片段。evidence 欄**只放 loop slug**（如 `8-verify-reviewer-rightsizing`），不貼原文。
- **Metric-Honesty**：`confidence` 是「被幾條 loop 佐證」的**啟發式人工判斷、非統計**；schema 與注入措辭都標明「僅供參考」。不杜撰沒佐證的 instinct。
- instinct 是**本機學習產物**：`.loops/.instincts/` 不入庫（`.loops/*` 已 gitignore）。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「順手把專案細節也記進 instinct 比較有用」 | instinct 會注入未來**任何** session、且是方法論記憶；存專案內容會洩漏又沒跨 loop 價值。只存方法論。 |
| 「這條模式只在一條 loop 出現，先記著」 | 一條不成模式。confidence 要反映佐證數；單例頂多低 confidence、會被注入門檻濾掉。 |
| 「同主題再建一個新檔比較快」 | 會重複、互相矛盾。同 id 一律更新既有檔。 |

## Red Flags

- instinct 夾帶專案內容 / 程式碼 / 業務字眼（該只有方法論）。
- confidence 沒有佐證依據（憑感覺給高分）。
- 同主題建了多個檔（該更新既有）。
- 產出沒列給人審就寫檔。

## Verification

- [ ] 掃了 `.loops/*/loop.md`（完工優先）的 Journal + `★[outcome]`。
- [ ] 產出 instinct YAML：schema 欄齊（`references/instinct-schema.md`）、`evidence` 指 loop slug、`summary` ≤1 行、`confidence` 有佐證。
- [ ] 同 id 已存在則更新、未重複建。
- [ ] 只含方法論層級模式、無專案敏感內容。
- [ ] 列出本次新增 / 更新給人審。
