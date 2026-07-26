---
name: agents-md-maintainer
user-invocable: false
description: Turns a natural-language request to add or change a workflow rule into a traceable rule-change loop — analysing duplicates, coverage and conflicts against the policy registry first, classifying the rule into one of five architecture layers, deciding how it will actually be enforced, and only then opening a proposal issue. Routed to by dispatch on policy-change intent; never a public entry point.
---

# agents-md-maintainer — 規則變更閉環（內部能力）

## Overview

使用者在對話中說「**幫我把這條規則加進 plugin**」時，過去的做法偏向**只改 `AGENTS.md`** —— 於是規則有寫、卻沒有任何東西在執行它；而且沒人先查「這條是不是已經有了、會不會跟既有規則打架」。

本能力把規則變更做成一條**可追溯的閉環**：先分析、再分層、再決定怎麼執行，最後才開票走完整 loop。

```
dispatch → maintainer 讀 policy/component registry → duplicate/coverage/conflict 分析
        → 五層歸屬 → enforcement/eval 決策 → proposal issue → define → 完整 loop
        → 受影響來源 → PR
```

> **不新增公開入口**：由 `dispatch` 判定 policy-change intent 後內部驅動。

## When to Use

**Use when**：使用者的請求是**改工作流程規則本身**——「以後都要…」「把這條加進 plugin」「規則改成…」「這個以後不准…」。

**NOT for**：
- 一般功能 / bug（走正常 `define` → loop）。
- 只改某個 skill 的措辭而不涉及規則語意（那是 prompt 層的編輯，不需要閉環）。
- 使用者只是在陳述偏好、沒要求落成規則——**先確認再開票**。

## Process

### 1. 先分析，不要先寫

讀 `references/policy-registry.json` 與 `references/component-registry.json`，用 `scripts/policy-change.mjs` 的 `analyzeProposal()` 判定這條規則與既有規則的關係。**六種判定各有唯一動作**：

| 判定 | 意思 | 動作 |
|---|---|---|
| `duplicate` | scope 與要求都跟某條一樣 | **改既有那條**，不要再開一條 |
| `compatible-extension` | scope 有交集、要求不互斥 | **擴充既有那條** |
| `scoped-difference` | 要求互斥，但可由 forbid-wins／precedence 排序 | **在兩條上各寫明適用條件**，別留給讀者推理 |
| `true-contradiction` | 要求互斥、嚴格度相同、排不出順序 | **停下來問使用者一題**（見下） |
| `unknown` | scope 解析不出來 | **停**——補清楚再說，**不要猜 precedence** |
| `novel` | 與既有規則無交集 | 開新規則 |

### 2. 真衝突：只問一題，未拍板前不動手

真衝突要人決定的只有一件事：**哪一條贏**。開一個決策點問這一題（選項標推薦並附理由，見 `references/shared/delivery/comment-policy.md`）。

**未得到答案前：不建 issue、不寫規則、不改 registry。** 把兩條規則的 scope、要求與各自的理由攤給使用者看，讓對方能真的判斷。

### 3. 五層歸屬

每條規則歸屬 `harness` / `graph` / `loop` / `context` / `prompt` 其中一層（見 `AGENTS.md` 的架構邊界）。**歸不出層通常代表這其實是兩條規則**，或者它根本不是規則而是做法偏好——那就別把它寫成規則。

### 4. enforcement 決策：這條規則由誰執行

依可判定性選 tier（四級模型見 `docs/FLOW.md`〈規則怎麼被執行〉）：**能機械判定的就不要交給模型記憶**，需要語意判斷的就別硬寫成 regex deny。

| tier | 什麼時候選它 |
|---|---|
| `hard-invariant` | 完全機械、零語意 → 一支 hook 擋在工具呼叫前 |
| `workflow-invariant` | 機械讀狀態／掃樹 → 一支 lint／狀態閘 |
| `semantic` | 需要語意判斷 → bounded context ＋ eval（評不到標 degraded） |
| `advisory` | 只能靠模型遵循 → 寫進 skill／agent 正文，**不宣稱保證** |

### 5. proposal issue（九個固定區塊）

用 `renderProposalIssue()` 的版型（缺一不可，由 `validateProposal()` 機械檢查）：

問題 · 規則目的 · 相關/衝突的既有規則（含分析判定）· 五層歸屬 · 影響到的 stages/agents/tools/files · 執行層級與怎麼擋 · 人要讀的文件怎麼改 · 受影響的來源 · 驗收與回歸

寫好後交 `define` 建 issue（**issue 一律由 define 建**），再走完整 loop。

### 6. PR 不得只改 `AGENTS.md`

一次**完整**的規則變更依 tier 至少要動到這幾面，由 `gateChangeSet()` 機械檢查：

| tier | 必動 |
|---|---|
| `hard-invariant` | registry ＋ 投影文件 ＋ 執行它的 hook ＋ 測試 |
| `workflow-invariant` | registry ＋ 投影文件 ＋ 執行它的 script ＋ 測試 |
| `semantic` | registry ＋ 投影文件 ＋ evals |
| `advisory` | registry ＋ 投影文件 ＋ skills／agents |

再用 component registry 的波及面查詢找出**受影響的來源**（哪些 hook／eval／文件／外部 optimizer 要跟著更新），逐項處理或明確記成 follow-up。

### 7. optimizer 的邊界

SkillOpt 等自動最佳化**不得**改 policy registry、hard hooks、approval contract、eval oracle 與 gold artifact（`gateOptimizerChange()` 機械擋）——讓自動最佳化去動規則本身與評分基準，等於讓被考的人改考卷。

### 8. 受影響來源怎麼跑（#179）

用 `scripts/optimization-pipeline.mjs` 的 `resolveActions()` 由**改到的檔**推出要跑哪些 action，並依固定順序執行——**便宜且確定的先跑**：

`compiler/schema → deterministic tests → code graph refresh → symbol consistency → replay/migration → lifecycle canary → docs/devex checks → skill candidate → prompt eval → token benchmark`

三件事由機械保證：

- **同一個 `optimization_run_id` 內每個來源最多跑一次**——擋掉「optimizer 產出的改動又觸發 optimizer」的無限迴圈。
- **optimizer 只產 candidate**：改動必須落在 candidate 目錄，不得直接覆寫正式 skill；碰到 policy registry／hard hooks／approval contract／eval oracle 一律拒。
- **品質關過了才比成本**：hard invariant adherence 與 held-out success／adherence 任一低於 baseline → 拒；**沒量到也拒**（沒量不等於沒退步）。
- **沒跑的 action 標 `not measured`**——「已安裝」不等於「已優化」。

## Verification

- [ ] 動筆前跑過 `analyzeProposal()`，判定與建議動作寫進 proposal issue。
- [ ] 真衝突**只問了一題**，且拿到答案後才建 issue／改 registry。
- [ ] `unknown` 時停下補清楚，**沒有猜 precedence**。
- [ ] proposal issue 九個區塊齊全、符合 repo house style。
- [ ] PR 過 `gateChangeSet()`：沒有只改文件的規則變更。
- [ ] 受影響來源逐項處理或明確記成 follow-up（沒有靜默略過）。

## Anti-patterns

- **只改 `AGENTS.md` 就說規則加好了**——規則有寫、沒有執行者，等於沒有。
- **沒查就開新規則**——結果是兩條講同一件事的規則互相漂移。
- **真衝突時自己選一邊**——那是使用者的取捨，不是實作細節。
- **`unknown` 時猜 precedence**——猜錯會讓兩條規則在不同情境下互相蓋掉，而且沒人知道。
- **把主觀設計品質硬寫成 regex deny**——擋錯的比擋對的多，最後大家學會關掉它。
- **讓環境變數變成無記錄的永久逃生口**——要例外就走有 scope、有到期、有留痕的 approval。
