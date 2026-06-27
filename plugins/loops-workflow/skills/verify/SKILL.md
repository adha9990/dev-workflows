---
name: verify
description: Fans out the core reviewers (product/architecture/security/performance/code-quality/tests — all six for any code change; right-sized to a minimal set for docs/config-only changes, see §1.4) then validates findings in a second pass. Use when starting the verify stage of a loops-workflow run, or when built work needs merge-readiness review before iterate.
---

# verify — 驗證（多 reviewer fan-out + validator 二輪）

## Overview

`verify` 的引擎是多 reviewer fan-out：主線**在同一回合一次發出一組核心 reviewer**（並行、fresh context、不巢狀），各審一軸 —— **含 code 改動是核心 6 軸全派**、純文件 / 純設定類依 §1.4 **右尺寸化**到最小集；再派 `finding-validator` 對每個 blocking finding 做二輪確認；最後 merge 成 **Ready / Not ready**。

> 用多個 fresh-context reviewer 各審一軸，而非主線自己掃一遍 —— 寫 code 時的假設不會帶進 review，獨立性換來覆蓋廣度。

> **verify 是獨立安全網、不是第一道品質關**：品質標準在 build 寫的當下就該套用（shift-left，見 `AGENTS.md` 規則 11）；verify 用 fresh-context 獨立**複查同一套標準 + 抓 build 的盲點**。build 寫到位 → verify 找到的少、跑得快；但這**不代表能省略 verify** —— 寫的人有盲點，獨立複查才補得到。

> **回環再驗（delta re-verify）**：iterate 修完回來時，verify 聚焦「這輪改了什麼 + 它的**波及面**（誰用到被改的程式碼）」派 fresh reviewer 再驗 —— 不是只重跑 diff、更不是只看測試綠；共用元件 / 跨切面改動要把 consumer 一起納入。修完一律再驗一輪，這是 closed-loop 的預設，不是選項。

## When to Use

**Use when**：build 完成、要做 merge 前驗收。

**NOT for**：
- 還在寫 code —— 回 build。
- 驗收報告已出、要決定回環或完工 —— 去 iterate。

## Process

### 1. 同一回合並行派核心 reviewer（各審一軸）

下表是**核心 6 軸 reviewer 的清單（menu）**；**實際派幾軸由 §1.4 依改動面決定**（含 code＝6 軸全派；純文件 / 設定＝最小集）。

| reviewer | 審什麼 | 補強 |
|------|------|------|
| `product-contract-reviewer` | issue 驗收 / 範圍 / 非目標 | 逐句對照完工定義驗收 |
| `architecture-reviewer` | 分層邊界 / import 方向 / 契約 / 內聚 / 設計模式適切性 | clean-architecture + design-patterns 標準 |
| `security-reviewer` | auth/authz / 注入 / 敏感資料 | **補威脅建模 / STRIDE / OWASP+LLM Top 10**，讀 `references/security-checklist.md` |
| `performance-reviewer` | query / N+1 / index / transaction | — |
| `code-quality-reviewer` | **正確性與狀態流（先於風格）** / 錯誤處理 / typing / 可讀性與簡潔 / code smells / 重用 | correctness-review（狀態流 / 部分失敗 / 冪等 / txn）+ clean-code + refactoring + code-simplification + reuse-check |
| `tests-reviewer` | 測試覆蓋 / 邊界 / migration | **反偏見：不給它「作者說已通過」的結論** |

> 必須在**同一個 assistant 回合**一次發出（§1.4 定的那組）reviewer 的 Agent call 才會真的並行。subagent 不能再派 subagent。

> **派 reviewer 只給 artifact + 契約**（issue / `02-plan.md` 契約 / diff），**不給作者的理由 / 辯護** —— `03-build.md` 的 POTENTIAL CONCERNS 是給人看的、**不轉發**給 reviewer。餵作者 rationale 會讓 reviewer 偏向同意（反偏見的正面規則，同 tests-reviewer「不告知作者說已過」）。

> **參考檔路徑（必做）**：subagent 的 CWD 是使用者 repo、且 `${CLAUDE_PLUGIN_ROOT}` 在 markdown 不展開，所以相對路徑 `references/xxx.md` 它們讀不到。派 reviewer 前，**從本 skill 的 base directory 推出 plugin root**（base 上兩層 = `…/plugins/loops-workflow/`），組出絕對路徑塞進各 reviewer 的 prompt：全部 reviewer ← `references/reviewer-severity.md` + `references/review-dispositions.md`（每軸盯點 + 出手前共用誤報底線）+ `references/preflight.md` §(c)「作者已留痕的決定不算 finding」硬規則原文；`product-contract-reviewer` 另加 `references/acceptance-review.md`；`code-quality-reviewer` 另加 `references/correctness-review.md`、`references/clean-code.md`、`references/refactoring.md`、`references/code-simplification.md` 與 `references/reuse-check.md`；`architecture-reviewer` 另加 `references/architecture-review.md`、`references/clean-architecture.md` 與 `references/design-patterns.md`；`security-reviewer` 另加 `references/security-checklist.md`；`performance-reviewer` 另加 `references/performance-review.md`；`tests-reviewer` 另加 `references/test-rubric.md`；條件式 `frontend-ui-reviewer` ← `references/ui-interaction-review.md`、`root-cause-reviewer` ← `references/root-cause-review.md`、`docs-devex-reviewer` ← `references/docs-devex-review.md`；`finding-validator` ← `references/finding-validation.md`。詳見 AGENTS.md〈參考檔路徑解析〉。

### 1.4 改動面 → 最小核心 reviewer 集（右尺寸化）

§1 的核心 6 軸是**含 code 改動的下界、不可縮**。但對**客觀窄面**（純文件 / 純 markdown 敘述 / 純非執行設定）——`performance` / `security` / `tests` 等核心軸**對該改動無可審之物**——全派只是起一堆空轉 agent（規則 10 carve-out 想砍的「非必要貴動作」）。依改動面定**核心 reviewer 的下界**（下表只列**核心軸**；領域 reviewer 如 `docs-devex` 由 §1.5 因觸及該領域自動帶入、去重後一起派）：

| 改動面 | 最小**核心**軸下界 | 領域帶入（§1.5）/ 為什麼 |
|---|---|---|
| **含任何 code**（`.ts`/`.js`/`.mjs`… 邏輯、schema、CLI、migration、**設定即程式行為**） | **核心 6 軸全派、不得縮** | 規則 10「verify 獨立複查」不可省 |
| **純文件 / 純 markdown 敘述**（docs、SKILL.md 文案、README、純註解） | `product-contract`（涉跨檔契約 / 一致性再加 `code-quality`） | 無 DB / API / 效能 / 攻擊面可審；動到 docs → `docs-devex` 由 §1.5 帶入（淨集常＝product-contract + docs-devex） |
| **純非執行設定 / 資料**（純 fixtures、純文案設定、無程式語意） | `product-contract`（涉密鑰 / 權限 / 認證設定 → 加 `security`） | 動到 config → 相應 §1.5 reviewer 帶入；視內容微調，不得低於「能驗收範圍」 |

> **fail-safe（向嚴）**：拿不準改動面是不是「純文件 / 純設定」、或一份 diff **混了 code 與文件** → **當作含 code、核心 6 軸全派**。縮錯 = 漏審，寧可多派、不可漏審。

這是**精準化規則 10 carve-out 的「可省 / 不可省邊界」**，**不是放寬 mandatory 的 verify 獨立複查**：code 永遠核心 6 軸，縮的只是「對該改動無可審之物」的核心軸。與 §1.5 **正交** —— §1.4 定**核心軸的下界**、§1.5 **按領域加派**領域 reviewer（純文件 / 設定動到 docs/config → `docs-devex` 等由 §1.5 帶入）；兩者去重疊加 = 該次 verify 的實際 reviewer 集。

### 1.5 條件式 reviewer（選用，視改動領域加派）

看 build 的 Change Summaries + 改動檔案：碰到特定領域就把對應的領域 reviewer **加進同一回合的 fan-out**（並行）。沒碰到就不派，避免無關維度造成噪音。對照見 `references/optional-reviewers.md`：

- 前端 / UI → `frontend-ui-reviewer`、`accessibility-reviewer`、`web-performance-reviewer`
- 後端服務 / 關鍵流程 → `observability-reviewer`
- 非同步處理 / queue / 背景 job / 長流程 → `processing-reliability-reviewer`
- CI/CD 設定 → `ci-cd-reviewer`
- schema migration / 介面汰換 → `migration-reviewer`
- **bug fix**（issue 標 bug / 標題含 fix·修·regression）→ `root-cause-reviewer`
- **docs / README / 對外契約 / CLI / setup / migration / config 改動，或 PR body 聲稱免改文件** → `docs-devex-reviewer`

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

> **若把驗收結論 post 成 issue / PR comment**（給人審 / 留 audit）：固定套 `references/comment-policy.md` §7「驗收報告 comment 版型」——方向總評 → 按維度分組 → 每點「會發生什麼情境 / 為什麼是問題 / 建議怎麼修 / 建議補測試」→ 結尾 merge 風險。先寫 tmp 草稿、送出後刪（§5）。

> **送審前自檢（作者視角）**：把 verify 的合併安全結論 + explain 的方向 recap 收成**單一送審判定**（`可送審` / `建議先修` / `資訊不足`）、跨關去重、以及硬規則「**作者已留痕的決定（alignment comment / `02-plan.md` / PR body）不算 finding**，除非它本身也是獨立 bug」—— 見 `references/preflight.md`。派 reviewer 時把這條硬規則原文也塞進每個 reviewer 的 prompt。

### 雙視角記錄

每條 finding 固定「先工程視角（原因：哪檔哪行 + 機制 / 修法 / 驗證），再使用者視角（什麼操作會踩到 + 看到什麼）」。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「我自己掃一遍就好，不用派 reviewer」 | 單一 context 會被你寫 code 時的假設帶偏。一組 fresh reviewer 各審一軸才有獨立性（該派幾軸依 §1.4 改動面 —— code 全 6 軸）。 |
| 「reviewer 逐個派，省得一次發太多」 | 逐個派就不是並行，還會互相污染 context。要同一回合一次發出（§1.4 定的那組）。 |
| 「純文件小改也要全 6 軸」 | 反向也是浪費：純文件 / 純設定無 DB / 效能 / 攻擊面可審，依 §1.4 縮到最小集；但**拿不準 / 混 code 一律全派**（fail-safe 向嚴）。 |
| 「finding 看起來真，直接記 P0」 | 沒過 validator 二輪，可能是既有防護已處理 / 非本次引入的誤報。 |
| 「效能我覺得沒問題」 | 沒實跑就是 `not measured`，不能寫「沒問題」。 |

## Red Flags

- 該派的 reviewer（§1.4 定的那組）不是同一回合派出（變成序列、互相污染）。
- **對含 code 的改動縮減核心 6 軸**（右尺寸化只適用客觀窄面 —— 純文件 / 純設定；拿不準 / 混 code 一律全派，縮錯＝漏審）。
- tests-reviewer 被餵了「作者說測試已過」。
- blocking finding 沒過 finding-validator 就進報告。
- 出現未實測的效能 / 覆蓋率數字。
- 把作者的理由 / 辯護餵給 reviewer 當框架（只給 artifact + 契約）。
- 連 2+ 輪 reviewer 都出 substantive finding 卻 **0 條被判 actionable** = 在背書不是審查（rubber-stamp / doubt theater），停下重看 validator 是不是把該修的都 rationalize 掉了。

## Verification

- [ ] 依 §1.4 改動面定 reviewer 集（**含 code＝核心 6 軸全派**；純文件 / 純設定＝最小集；**拿不準 / 混 code 向嚴全派**），在同一回合並行派出、各一軸。
- [ ] security-reviewer 有跑威脅建模 / OWASP 補強。
- [ ] 已跑真 app（`/run`·`/verify`）+ 本機 `/code-review`，或純 lib 無 app 據實標 `not measured`。
- [ ] 每個 blocking finding 有 finding-validator 的 `validated/rejected/degraded`。
- [ ] 每條 finding 有 P0–P3 + Confidence + Route，且套 Metric-Honesty。
- [ ] `04-verify.md` 結論是 Ready / Not ready 並進 iterate（只有出 P0 才停下用 `AskUserQuestion` 問）。
