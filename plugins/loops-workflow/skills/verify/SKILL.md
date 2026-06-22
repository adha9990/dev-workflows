---
name: verify
description: Fans out six independent reviewers (product/architecture/security/performance/code-quality/tests) then validates findings in a second pass. Use when starting the verify stage of a loops-workflow run, or when built work needs merge-readiness review before iterate.
---

# verify — 驗證（六 reviewer fan-out + validator 二輪）

## Overview

`verify` 的引擎是多 reviewer fan-out：主線**在同一回合一次發 6 個 reviewer**（並行、fresh context、不巢狀），各審一軸；再派 `finding-validator` 對每個 blocking finding 做二輪確認；最後 merge 成 **Ready / Not ready**。

> 用多個 fresh-context reviewer 各審一軸，而非主線自己掃一遍 —— 寫 code 時的假設不會帶進 review，獨立性換來覆蓋廣度。

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
| `architecture-reviewer` | 分層邊界 / import 方向 / 契約 | — |
| `security-reviewer` | auth/authz / 注入 / 敏感資料 | **補威脅建模 / STRIDE / OWASP+LLM Top 10**，讀 `references/security-checklist.md` |
| `performance-reviewer` | query / N+1 / index / transaction | — |
| `code-quality-reviewer` | 錯誤處理 / typing / **可讀性與簡潔** | code-simplification 反例當 readability checklist |
| `tests-reviewer` | 測試覆蓋 / 邊界 / migration | **反偏見：不給它「作者說已通過」的結論** |

> 必須在**同一個 assistant 回合**一次發出 6 個 Agent call 才會真的並行。subagent 不能再派 subagent。

> **參考檔路徑（必做）**：subagent 的 CWD 是使用者 repo、且 `${CLAUDE_PLUGIN_ROOT}` 在 markdown 不展開，所以相對路徑 `references/xxx.md` 它們讀不到。派 reviewer 前，**從本 skill 的 base directory 推出 plugin root**（base 上兩層 = `…/plugins/loops-workflow/`），組出絕對路徑塞進各 reviewer 的 prompt：全部 reviewer ← `references/reviewer-severity.md`；`security-reviewer` 另加 `references/security-checklist.md`；`code-quality-reviewer` 另加 `references/code-simplification.md`；`finding-validator` ← `references/finding-validation.md`。詳見 AGENTS.md〈參考檔路徑解析〉。

### 1.5 條件式 reviewer（選用，視改動領域加派）

看 build 的 Change Summaries + 改動檔案：碰到特定領域就把對應的領域 reviewer **加進同一回合的 fan-out**（並行）。沒碰到就不派，避免無關維度造成噪音。對照見 `references/optional-reviewers.md`：

- 前端 / UI → `frontend-ui-reviewer`、`accessibility-reviewer`、`web-performance-reviewer`
- 後端服務 / 關鍵流程 → `observability-reviewer`
- CI/CD 設定 → `ci-cd-reviewer`
- schema migration / 介面汰換 → `migration-reviewer`

### 2. coordinator（主線）

去重、過濾純 style / 低信心雜訊。

### 3. finding-validator 二輪

派 `finding-validator` 對每個候選 blocking finding 確認：是否真實 / 是否本次引入 / 是否已被 caller·middleware·framework·既有防護處理 / 修正方向是否對症 → `validated` / `rejected` / `degraded`（判準見 `references/finding-validation.md`）。

### 4. 分級 + 輸出

每個 finding 標 **P0–P3 + Confidence 50/75/100 + Route**（見 `references/reviewer-severity.md`）。所有 reviewer 套 **Metric-Honesty**（沒實跑就標 `not measured`）。主線 merge 成 **Ready / Not ready** 寫 `04-verify.md`，停 `verify → iterate` gate。

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

## Verification

- [ ] 6 個 reviewer 在同一回合並行派出，各一軸。
- [ ] security-reviewer 有跑威脅建模 / OWASP 補強。
- [ ] 每個 blocking finding 有 finding-validator 的 `validated/rejected/degraded`。
- [ ] 每條 finding 有 P0–P3 + Confidence + Route，且套 Metric-Honesty。
- [ ] `04-verify.md` 結論是 Ready / Not ready，停在 `verify → iterate` gate。
