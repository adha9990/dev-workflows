---
name: verify
description: Fans out six independent reviewers (product/architecture/security/performance/code-quality/tests) then validates findings in a second pass. Use when starting the verify stage of a loops-workflow run, or when built work needs merge-readiness review before iterate.
---

# verify — 驗證（六 reviewer fan-out + validator 二輪）

## Overview

`verify` 的引擎是多 reviewer fan-out：主線**在同一回合一次發 6 個 reviewer**（並行、fresh context、不巢狀），各審一軸；再派 `finding-validator` 對每個 blocking finding 做二輪確認；最後 merge 成 **Ready / Not ready**。

> 用多個 fresh-context reviewer 各審一軸，而非主線自己掃一遍 —— 寫 code 時的假設不會帶進 review，獨立性換來覆蓋廣度。

> **回環再驗（delta re-verify）**：iterate 修完回來時，verify 聚焦「這輪改了什麼 + 它的**波及面**（誰用到被改的程式碼）」派 fresh reviewer 再驗 —— 不是只重跑 diff、更不是只看測試綠；共用元件 / 跨切面改動要把 consumer 一起納入。修完一律再驗一輪，這是 closed-loop 的預設，不是選項。

## When to Use

**Use when**：build 完成、要做 merge 前驗收。

**NOT for**：
- 還在寫 code —— 回 build。
- 驗收報告已出、要決定回環或完工 —— 去 iterate。

## Process

### 1. 同一回合派 6 個 reviewer（並行、各一軸）

| reviewer | 審什麼 | 補強 |
|------|------|------|
| `product-contract-reviewer` | issue 驗收 / 範圍 / 非目標 | 逐句對照完工定義驗收 |
| `architecture-reviewer` | 分層邊界 / import 方向 / 契約 / 內聚 | clean-architecture 標準 |
| `security-reviewer` | auth/authz / 注入 / 敏感資料 | **補威脅建模 / STRIDE / OWASP+LLM Top 10**，讀 `references/security-checklist.md` |
| `performance-reviewer` | query / N+1 / index / transaction | — |
| `code-quality-reviewer` | 錯誤處理 / typing / **可讀性與簡潔 / code smells / 重用** | clean-code 標準 + refactoring（異味→手法）+ code-simplification 反例 + reuse-check |
| `tests-reviewer` | 測試覆蓋 / 邊界 / migration | **反偏見：不給它「作者說已通過」的結論** |

> 必須在**同一個 assistant 回合**一次發出 6 個 Agent call 才會真的並行。subagent 不能再派 subagent。

> **派 reviewer 只給 artifact + 契約**（issue / `02-plan.md` 契約 / diff），**不給作者的理由 / 辯護** —— `03-build.md` 的 POTENTIAL CONCERNS 是給人看的、**不轉發**給 reviewer。餵作者 rationale 會讓 reviewer 偏向同意（反偏見的正面規則，同 tests-reviewer「不告知作者說已過」）。

> **參考檔路徑（必做）**：subagent 的 CWD 是使用者 repo、且 `${CLAUDE_PLUGIN_ROOT}` 在 markdown 不展開，所以相對路徑 `references/xxx.md` 它們讀不到。派 reviewer 前，**從本 skill 的 base directory 推出 plugin root**（base 上兩層 = `…/plugins/loops-workflow/`），組出絕對路徑塞進各 reviewer 的 prompt：全部 reviewer ← `references/reviewer-severity.md` + `references/preflight.md` §(c)「作者已留痕的決定不算 finding」硬規則原文；`security-reviewer` 另加 `references/security-checklist.md`；`architecture-reviewer` 另加 `references/clean-architecture.md`；`code-quality-reviewer` 另加 `references/clean-code.md`、`references/refactoring.md`、`references/code-simplification.md` 與 `references/reuse-check.md`；`tests-reviewer` 另加 `references/test-rubric.md`；`finding-validator` ← `references/finding-validation.md`。詳見 AGENTS.md〈參考檔路徑解析〉。

### 1.5 條件式 reviewer（選用，視改動領域加派）

看 build 的 Change Summaries + 改動檔案：碰到特定領域就把對應的領域 reviewer **加進同一回合的 fan-out**（並行）。沒碰到就不派，避免無關維度造成噪音。對照見 `references/optional-reviewers.md`：

- 前端 / UI → `frontend-ui-reviewer`、`accessibility-reviewer`、`web-performance-reviewer`
- 後端服務 / 關鍵流程 → `observability-reviewer`
- CI/CD 設定 → `ci-cd-reviewer`
- schema migration / 介面汰換 → `migration-reviewer`

### 1.8 跑真 app + 本機 /code-review（把 `not measured` 變實測）

靜態 review 之外，**Claude 親自代跑**、不推託「需使用者 / 瀏覽器」：

- **跑真 app 驗行為**：用環境的 run 能力（`/run` 起服務 / driver 打真 endpoint）+ `/verify` 逐條玩 `00-goal.md` 的需求，確認行為真的成立；效能 / 行為宣稱盡量從 `not measured` 變成實測證據。
- **本機 `/code-review`**：跑本機版（**不跑 ultra 雲端計費變體**），把它的 findings 併進 coordinator 一起去重。

> `/run` `/verify` `/code-review` 是環境內建能力，非外部 plugin。專案沒有可跑的 app（純 lib）時跳過實跑、據實標 `not measured`。

### 2. coordinator（主線）

去重、過濾純 style / 低信心雜訊。

### 3. finding-validator 二輪

派 `finding-validator` 對每個候選 blocking finding 確認：是否真實 / 是否本次引入 / 是否已被 caller·middleware·framework·既有防護處理 / 修正方向是否對症 → `validated` / `rejected` / `degraded`（判準見 `references/finding-validation.md`）。

### 4. 分級 + 輸出

每個 finding 標 **P0–P3 + Confidence 50/75/100 + Route**（見 `references/reviewer-severity.md`）。所有 reviewer 套 **Metric-Honesty**（沒實跑就標 `not measured`）。主線 merge 成 **Ready / Not ready** 寫 `04-verify.md` + 摘要，**直接進 iterate**（routine 轉場不問）。**只有出 P0** 才停下用 `AskUserQuestion` 問怎麼處理（先修 / 接受風險 / 看細節）。

> **送審前自檢（作者視角）**：把 verify 的合併安全結論 + explain 的方向 recap 收成**單一送審判定**（`可送審` / `建議先修` / `資訊不足`）、跨關去重、以及硬規則「**作者已留痕的決定（alignment comment / `02-plan.md` / PR body）不算 finding**，除非它本身也是獨立 bug」—— 見 `references/preflight.md`。派 reviewer 時把這條硬規則原文也塞進每個 reviewer 的 prompt。

### 雙視角記錄

每條 finding 固定「先工程視角（原因：哪檔哪行 + 機制 / 修法 / 驗證），再使用者視角（什麼操作會踩到 + 看到什麼）」。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「我自己掃一遍就好，不用派 6 個」 | 單一 context 會被你寫 code 時的假設帶偏。6 個 fresh reviewer 各審一軸才有獨立性。 |
| 「reviewer 逐個派，省得一次發太多」 | 逐個派就不是並行，還會互相污染 context。要同一回合一次發 6 個。 |
| 「finding 看起來真，直接記 P0」 | 沒過 validator 二輪，可能是既有防護已處理 / 非本次引入的誤報。 |
| 「效能我覺得沒問題」 | 沒實跑就是 `not measured`，不能寫「沒問題」。 |

## Red Flags

- 6 個 reviewer 不是同一回合派出（變成序列、互相污染）。
- tests-reviewer 被餵了「作者說測試已過」。
- blocking finding 沒過 finding-validator 就進報告。
- 出現未實測的效能 / 覆蓋率數字。
- 把作者的理由 / 辯護餵給 reviewer 當框架（只給 artifact + 契約）。
- 連 2+ 輪 reviewer 都出 substantive finding 卻 **0 條被判 actionable** = 在背書不是審查（rubber-stamp / doubt theater），停下重看 validator 是不是把該修的都 rationalize 掉了。

## Verification

- [ ] 6 個 reviewer 在同一回合並行派出，各一軸。
- [ ] security-reviewer 有跑威脅建模 / OWASP 補強。
- [ ] 已跑真 app（`/run`·`/verify`）+ 本機 `/code-review`，或純 lib 無 app 據實標 `not measured`。
- [ ] 每個 blocking finding 有 finding-validator 的 `validated/rejected/degraded`。
- [ ] 每條 finding 有 P0–P3 + Confidence + Route，且套 Metric-Honesty。
- [ ] `04-verify.md` 結論是 Ready / Not ready 並進 iterate（只有出 P0 才停下用 `AskUserQuestion` 問）。
