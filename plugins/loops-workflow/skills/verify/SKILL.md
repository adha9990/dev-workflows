---
name: verify
description: Fans out reviewers right-sized to change risk (4-tier ladder SKIP/LIGHT/STANDARD/DEEP, see §1.4 — STANDARD code keeps all six core axes, DEEP keeps all six plus a holistic cross-cutting pass, LIGHT shrinks to three, guarded trivial changes skip), then validates findings in a second pass; if any review confirms the work fundamentally misses the issue, the whole change bounces back to build. Use when starting the verify stage of a loops-workflow run, or when built work needs merge-readiness review before iterate.
---

# verify — 驗證（多 reviewer fan-out + validator 二輪）

## Overview

`verify` 的引擎是多 reviewer fan-out：主線**在同一回合一次發出一組 reviewer**（並行、fresh context、不巢狀），各審一軸 —— **派幾軸由 §1.4「改動風險 4 級梯」決定**（一般 code＝STANDARD 核心 6 軸；高風險＝DEEP 加碼；小孤立 code＝LIGHT 縮 3 軸；受護欄保護的瑣碎面＝SKIP 不派）；再派 `finding-validator` 對每個 blocking finding 做二輪確認；最後 merge 成 **Ready / Not ready**。

> 用多個 fresh-context reviewer 各審一軸，而非主線自己掃一遍 —— 寫 code 時的假設不會帶進 review，獨立性換來覆蓋廣度。

> **verify 是獨立安全網、不是第一道品質關**：品質標準在 build 寫的當下就該套用（shift-left，見 `AGENTS.md` 規則 11）；verify 用 fresh-context 獨立**複查同一套標準 + 抓 build 的盲點**。build 寫到位 → verify 找到的少、跑得快；但這**不代表能省略 verify** —— 寫的人有盲點，獨立複查才補得到。

> **右尺寸化 ≠ 放寬**：4 級梯只**依風險浮動「核心軸的下界」** —— 低風險縮、一般維持、**高風險反而加碼**（多一道 holistic 全局交叉檢查）。它精準化規則 10 carve-out 的「可省 / 不可省邊界」，**不是給 code 開後門**：任何疑慮一律向上升級（fail-safe 向嚴）。
>
> **名詞白話**：「**fan-out**」＝同一回合一次派出多個審查員、各審一軸、並行跑；「**holistic 全局交叉檢查**」＝再派一個審查員看所有 finding 的全集，專抓單一審查員看不到的跨維度問題；「**波及面（blast-radius）**」＝這次改動會影響到多少別處（誰 import / 呼叫被改的東西）；「**shift-left**」＝品質在 build 邊寫邊做到位、不留給 verify 才補。

> **回環再驗（delta re-verify）**：iterate 修完回來時，verify 聚焦「這輪改了什麼 + 它的**波及面**（誰用到被改的程式碼）」派 fresh reviewer 再驗 —— 不是只重跑 diff、更不是只看測試綠；共用元件 / 跨切面改動要把 consumer 一起納入。修完一律再驗一輪，這是 closed-loop 的預設，不是選項。

## When to Use

**Use when**：build 完成、要做 merge 前驗收。

**NOT for**：
- 還在寫 code —— 回 build。
- 驗收報告已出、要決定回環或完工 —— 去 iterate。

## Process

### 1. 同一回合並行派 reviewer（各審一軸）

下表是**核心 6 軸 reviewer 的清單（menu）**；**實際派哪幾軸由 §1.4 的 4 級梯依改動風險決定**。

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

> **參考檔路徑（必做）**：subagent 的 CWD 是使用者 repo、且 `${CLAUDE_PLUGIN_ROOT}` 在 markdown 不展開，所以相對路徑 `references/xxx.md` 它們讀不到。派 reviewer 前，**從本 skill 的 base directory 推出 plugin root**（base 上兩層 = `…/plugins/loops-workflow/`），組出絕對路徑塞進各 reviewer 的 prompt：全部 reviewer ← `references/reviewer-severity.md` + `references/review-dispositions.md`（每軸盯點 + 出手前共用誤報底線）+ `references/preflight.md` §(c)「作者已留痕的決定不算 finding」硬規則原文；triage 判級主線另讀 `references/verify-triage.md`；`product-contract-reviewer` 另加 `references/acceptance-review.md`；`code-quality-reviewer` 另加 `references/correctness-review.md`、`references/clean-code.md`、`references/refactoring.md`、`references/code-simplification.md` 與 `references/reuse-check.md`；`architecture-reviewer` 另加 `references/architecture-review.md`、`references/clean-architecture.md` 與 `references/design-patterns.md`；`security-reviewer` 另加 `references/security-checklist.md`；`performance-reviewer` 另加 `references/performance-review.md`；`tests-reviewer` 另加 `references/test-rubric.md`；`holistic-reviewer` ← `references/reviewer-severity.md`（看 findings 全集，§2.5）；條件式 `frontend-ui-reviewer` ← `references/ui-interaction-review.md`、`root-cause-reviewer` ← `references/root-cause-review.md`、`docs-devex-reviewer` ← `references/docs-devex-review.md`；`finding-validator` ← `references/finding-validation.md`。詳見 AGENTS.md〈參考檔路徑解析〉。

### 1.4 改動風險 → reviewer 集（4 級風險梯）

主線（orchestrator）依 `references/verify-triage.md` 的明文 rubric 看 build 的 Change Summaries + 改動檔案，把這次改動歸到一級，決定**核心 reviewer 的下界**（領域 reviewer 由 §1.5 觸及才加派、去重疊加）：

| 級別 | 觸發（rubric 判定，判準見 `verify-triage.md`） | 最小**核心**軸下界 |
|---|---|---|
| **SKIP** | docs / 註解 / 純格式 / test-only / 死碼移除 / SemVer patch 升版 —— **且 SKIP 護欄全成立**（CI 綠 + 單一領域 + 不碰高風險路徑 + 無夾帶）。**含執行語意的 code（含 <5 行邏輯改動）一律 ≥ LIGHT、不進 SKIP** | 0 **核心**軸；§1.5 條件式仍正交（碰對外契約/CLI/setup 文件 → 帶 docs-devex；純內部 typo/格式/test-only 則真 0） |
| **LIGHT** | 小、孤立、低 blast-radius 的 code（少 caller、易回滾、已有測試覆蓋、單一領域；LIGHT 判準全成立） | `code-quality`(correctness) + `product-contract` + `tests`＝**3 軸**，全並行 |
| **STANDARD** | 一般 code 改動（**預設**） | 核心 **6 軸**，全並行 |
| **DEEP** | **高風險硬閘**（見 `verify-triage.md` 清單：auth/authz、加密/密鑰/機敏、金流、DB schema/migration、對外 API/契約、並發/非同步、IaC）或大波及面 或大量 AI 生成 code | 核心 **6 軸** + **對應領域條件式**（§1.5 觸及才加；auth/加密/金流等無對應條件式者由核心 security 軸承接）+ **§2.5 holistic 全局交叉檢查**，**全並行、一次跑完**（不再先拆一輪前置閘）。跑完若有人確證「根本做錯」→ §1.6 整個退回 |

> **這 4 級梯以 code 風險為主軸。非 code 改動（純 docs / 設定）**：受護欄保護的瑣碎面（typo / 格式 / test-only / 死碼 / SemVer patch）→ SKIP（0 核心）；**有驗收契約的實質文件 / 設定** → `product-contract`（驗收）+ §1.5 領域（docs-devex 等），即 #8 既有的文件右尺寸化（不套 LIGHT/STANDARD/DEEP）。

> **fail-safe（向嚴）**：風險級拿不準、或一份 diff **混了 code 與文件 / 混多領域**、或 SKIP/LIGHT 護欄有一條不確定 → **升一級**（縮錯＝漏審，漏審成本 >> 多派成本）。**含 code 至少 LIGHT、預設 STANDARD；碰高風險硬閘清單一律 DEEP，不論行數多小**（「小 ≠ 安全」）。

> **維度不順序化**：LIGHT/STANDARD/DEEP 內選定的那組軸**一律同一回合並行**，**不**把品質維度排成「先正確性過了再跑安全」的序列 —— 順序化會造成交叉軸漏審 + 後者錨定前者偏誤。唯一的「先後」只剩 build/§1.4 之前那道便宜的確定性 pre-gate（quality-gate：型別 / lint / 測試）；審查本身不分先後、一次並行跑完。

這與 §1.5 **正交**：§1.4 定**核心軸的下界**、§1.5 **按領域加派**領域 reviewer；兩者去重疊加 = 該次 verify 的實際 reviewer 集。

### 1.5 條件式 reviewer（選用，視改動領域加派）

看 build 的 Change Summaries + 改動檔案：碰到特定領域就把對應的領域 reviewer **加進同一回合的 fan-out**（並行）。沒碰到就不派，避免無關維度造成噪音。對照見 `references/optional-reviewers.md`：

- 前端 / UI → `frontend-ui-reviewer`、`accessibility-reviewer`、`web-performance-reviewer`
- 後端服務 / 關鍵流程 → `observability-reviewer`
- 非同步處理 / queue / 背景 job / 長流程 → `processing-reliability-reviewer`
- CI/CD 設定 → `ci-cd-reviewer`
- schema migration / 介面汰換 → `migration-reviewer`
- **bug fix**（issue 標 bug / 標題含 fix·修·regression）→ `root-cause-reviewer`
- **docs / README / 對外契約 / CLI / setup / migration / config 改動，或 PR body 聲稱免改文件** → `docs-devex-reviewer`（純內部 typo / 格式且無對外契約者除外，視內容）

### 1.6 做錯東西就整個退回（所有級通用）

審查（fan-out）一次跑完後，**若有 reviewer 確證**（直接證明 / coordinator 當場驗證，不必等 §3 validator 二輪）這次是**根本性做錯** —— 任一種：

- **做的不是 issue 要的**（解錯問題、做了別的東西）；
- **核心驗收沒做到卻當完工**（partial 當完成、核心契約落空）；
- **最基本的流程跑不起來**（happy-path 崩壞、明顯狀態流錯誤）。

→ 就**把整個改動退回 build 重做，不要對其他軸的 finding 逐條 iterate**。在註定要大改的東西上修一堆小問題是白工。

- **所有級適用（不限高風險）**：「做錯東西」在 LIGHT/STANDARD/DEEP 都該整個退回。這條與 §4.5 acceptance-completeness 出口 gate **同源**：契約面的「做錯 / partial 當完成」本就是 §4.5 的 P0（§4.5 擋 Ready、本條多一步「整個退回、別逐條修」）；正確性面的「最基本流程崩壞」＝code-quality 的 P0 finding，一樣觸發整個退回。
- **不另拆前置輪**：以前 DEEP 會先單跑「契約 + 正確性」兩軸當早退閘（舊作法），跑完才放完整審查。**已移除** —— 因為 build 階段本就邊寫邊把品質做到位（shift-left），「根本做錯」其實很少發生，先拆一輪只是多跑一次、多等一輪、常態下零省（保費每次付、理賠罕見）。現在 DEEP 跟其他級一樣**一次跑完整審查**，跑完才整個退回，省掉那道前置輪。

### 1.7 跑真 app + 本機 /code-review（把 `not measured` 變實測）

靜態 review 之外，**Claude 親自代跑**、不推託「需使用者 / 瀏覽器」：

- **跑真 app 驗行為**：用環境的 run 能力（`/run` 起服務 / driver 打真 endpoint）+ `/verify` 逐條玩 `00-goal.md` 的需求，確認行為真的成立；效能 / 行為宣稱盡量從 `not measured` 變成實測證據。
- **本機 `/code-review`**：跑本機版（**不跑 ultra 雲端計費變體**），把它的 findings 併進 coordinator 一起去重。

> `/run` `/verify` `/code-review` 是環境內建能力，非外部 plugin。專案沒有可跑的 app（純 lib）時跳過實跑、據實標 `not measured`。

### 2. coordinator（主線）

去重、過濾純 style / 低信心雜訊。

### 2.5 holistic 交叉軸 pass（安全網，DEEP 必 / STANDARD 可選 / LIGHT·SKIP 不跑）

coordinator 去重後，派 `holistic-reviewer`（fresh context）看 **findings 全集 + 契約**，專抓「**沒有單一 reviewer 看得到的跨維度 / 架構級衝突 / 級聯效應**」——例如一個同時是 correctness 又是 security 的問題、或數條 finding 合起來才暴露的設計缺陷。它是「敢縮 reviewer」的對價安全網（補右尺寸化後可能的交叉軸漏審）。

- **DEEP 必跑**（軸多、交叉面大）；**STANDARD 可選** —— 改到**局部共用元件**（中等 fan-in、未達 `verify-triage.md` 的「廣泛 import」DEEP 門檻）/ 跨切面才值得；**LIGHT / SKIP 不跑**（面窄、無交叉軸可漏，跑了是噪音）。
- holistic 產出的 finding 走**同一套** P0–P3 + Confidence + Route + 雙視角，併入 coordinator 一起進 §3 finding-validator 二輪（不特權、一樣要被驗）。

### 3. finding-validator 二輪

派 `finding-validator` 對每個候選 blocking finding 確認：是否真實 / 是否本次引入 / 是否已被 caller·middleware·framework·既有防護處理 / 修正方向是否對症 → `validated` / `rejected` / `degraded`（判準見 `references/finding-validation.md`）。

### 4. 分級 + 輸出

每個 finding 標 **P0–P3 + Confidence 50/75/100 + Route**（見 `references/reviewer-severity.md`）。所有 reviewer 套 **Metric-Honesty**（沒實跑就標 `not measured`）。主線 merge 成 **Ready / Not ready** 寫 `04-verify.md` + 摘要，**直接進 iterate**（routine 轉場不問）。**只有出 P0** 才停下用 `AskUserQuestion` 問怎麼處理（先修 / 接受風險 / 看細節）。

> **判 Ready 前必過〈§4.5 acceptance-completeness 出口 gate〉** —— findings 全清不等於「做到 issue 要的每一件事」，後者由下方 gate 獨立把關。

> **若把驗收結論 post 成 issue / PR comment**（給人審 / 留 audit）：固定套 `references/comment-policy.md` §7「驗收報告 comment 版型」——方向總評 → 按維度分組 → 每點「會發生什麼情境 / 為什麼是問題 / 建議怎麼修 / 建議補測試」→ 結尾 merge 風險。先寫 tmp 草稿、送出後刪（§5）。

> **送審前自檢（作者視角）**：把 verify 的合併安全結論 + explain 的方向 recap 收成**單一送審判定**（`可送審` / `建議先修` / `資訊不足`）、跨關去重、以及硬規則「**作者已留痕的決定（alignment comment / `02-plan.md` / PR body）不算 finding**，除非它本身也是獨立 bug」—— 見 `references/preflight.md`。派 reviewer 時把這條硬規則原文也塞進每個 reviewer 的 prompt。

### 4.5 acceptance-completeness 出口 gate（tier-independent，**所有級通用**）

**「findings 全清」≠「做到 issue 要的每一件事」**。前者是「有沒有引入問題」，後者是「該交付的有沒有交付」—— 兩者正交。所以 verify 的 **Ready 判定多一道與級別無關的硬閘**：

> **凡 `product-contract` 有跑（即任何 issue —— code 改動從 LIGHT 起每級必跑、有驗收契約的實質文件 / 設定走 product-contract+docs-devex 軌也跑；只有無驗收契約的 SKIP 不適用），verify 不得判 Ready，直到 product-contract 對 issue 的「每一條」acceptance criterion 都逐項列出 `references/acceptance-review.md` 的完成度五態（已滿足 / 部分滿足 / 缺失 / 證據不足 / 被反證），且每條都收斂到「已滿足（有可信證據）」或「明確 descoped（作者留痕）」—— 任一條停在 部分滿足 / 缺失 / 證據不足 / 被反證 且未明確 descoped → Not ready，回 iterate（partial 當完成是 P0/P1）。**

- **與 §1.6「整個退回」的分工**：本 gate（§4.5）決定**「能不能判 Ready」** —— 每條 acceptance criterion 沒收斂就 Not ready，**所有級通用**；§1.6 則是當「做錯東西 / 核心沒做到 / 最基本流程崩壞」被確證時，決定**「整個退回 build、別逐條修」**。兩者同源（契約面的 P0 同時觸發兩者），都是 tier-independent —— 「沒做到 issue」在 LIGHT/STANDARD/DEEP 都不是「眾多 finding 之一、靠 reviewer 自律」，而是**判 Ready 的硬前提**。
- **怎麼落實**：product-contract reviewer 的輸出本就要逐項五態 ledger（見 `acceptance-review.md`）；主線 coordinator 在寫 `04-verify.md` 結論前，**對著 issue 的 acceptance 清單逐條勾稽** ledger 是否完整、有無未收斂項 —— 缺項 / 漏列即視同 Not ready，不得以「findings 都清了」打發。
- **descoped 要留痕**：某條 acceptance 經對齊決定不做（縮範圍）時，必須在 `02-plan.md` / issue / PR 有作者留痕（呼應 preflight「作者已留痕的決定不算 finding」），ledger 標 `descoped + 出處`；無留痕的「沒做」一律算未完成。

### 雙視角記錄

每條 finding 固定「先工程視角（原因：哪檔哪行 + 機制 / 修法 / 驗證），再使用者視角（什麼操作會踩到 + 看到什麼）」。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「我自己掃一遍就好，不用派 reviewer」 | 單一 context 會被你寫 code 時的假設帶偏。一組 fresh reviewer 各審一軸才有獨立性（該派幾軸依 §1.4 風險梯）。 |
| 「reviewer 逐個派，省得一次發太多」 | 逐個派就不是並行，還會互相污染 context。要同一回合一次發出（§1.4 定的那組）。 |
| 「解一個小 bug 也要全 6 軸」 | 反向也是浪費：小而孤立、低 blast-radius、有測試覆蓋的 code 依 §1.4 走 LIGHT（3 軸）；受護欄保護的瑣碎面走 SKIP。**但拿不準 / 混 code / 碰高風險 path 一律向上升級**（fail-safe）。 |
| 「先跑正確性，過了再跑安全，逐 level 省 token」 | 把品質維度排成序列會交叉軸漏審 + 錨定偏誤，且 shift-left 常態（verify 找不到東西）下順序化零省、只多延遲。維度一律並行；要省就用 §1.4 **選對軸集**，不是排序列。審查不分先後、一次跑完（連 DEEP 也不再先拆一輪前置閘）。 |
| 「先拆一輪『契約+正確性』擋一下、根本做錯就早退比較省」 | shift-left 常態下根本做錯很少，先拆一輪只是多跑一次、多等一輪、零省（保費每次付、理賠罕見）。一次跑完整審查，跑完發現根本做錯再整個退回（§1.6）即可。 |
| 「這改動碰 auth 但只有兩行，跑 LIGHT 就好」 | 「小 ≠ 安全」（2 行可釀數月漏洞）。碰高風險硬閘清單一律 DEEP，不論行數。 |
| 「finding 看起來真，直接記 P0」 | 沒過 validator 二輪，可能是既有防護已處理 / 非本次引入的誤報。 |
| 「效能我覺得沒問題」 | 沒實跑就是 `not measured`，不能寫「沒問題」。 |

## Red Flags

- 該派的 reviewer（§1.4 定的那組）不是同一回合派出（變成序列、互相污染）。
- **對含 code 的改動縮到該風險級以下**（右尺寸化只允許依風險浮動下界 —— 拿不準 / 混 code / 碰高風險 path 一律向上升級，縮錯＝漏審）。
- **把 LIGHT/STANDARD/DEEP 的品質維度排成順序 gate**（先 A 過再跑 B）—— 維度要並行，唯一的先後只剩 build 前那道便宜的 quality-gate pre-gate；審查本身一次跑完、不分先後。
- **DEEP 還先拆一輪「契約+正確性」前置閘**（已移除 —— DEEP 跟其他級一樣一次跑完整審查）；或**確證「根本做錯」卻還對其他軸 finding 逐條 iterate，而非整個退回 build**（§1.6）。
- **STANDARD/LIGHT 判 Ready 卻沒對 issue 逐條勾稽 acceptance ledger**（把「逐句驗收完整性」當成只有高風險才做 —— §4.5 出口 gate 是 tier-independent，partial 當完成在任何級都該擋）。
- **DEEP 跳過 §2.5 holistic**，或 LIGHT/SKIP 硬跑 holistic（噪音）。
- tests-reviewer 被餵了「作者說測試已過」。
- blocking finding 沒過 finding-validator 就進報告。
- 出現未實測的效能 / 覆蓋率數字。
- 把作者的理由 / 辯護餵給 reviewer 當框架（只給 artifact + 契約）。
- 連 2+ 輪 reviewer 都出 substantive finding 卻 **0 條被判 actionable** = 在背書不是審查（rubber-stamp / doubt theater），停下重看 validator 是不是把該修的都 rationalize 掉了。

## Verification

- [ ] 依 §1.4 改動風險定級（**SKIP/LIGHT/STANDARD/DEEP**）→ 定該級 reviewer 集，**拿不準 / 混 code / 碰高風險 path 向嚴升級**；在同一回合並行派出、各一軸。
- [ ] **§1.6「做錯東西就整個退回」**：審查跑完後，若有 reviewer 確證 做的不是 issue 要的 / 核心沒做到 / 最基本流程崩壞 → 整個退回 build（不逐條 iterate）；**所有級適用**，不再先拆一輪前置閘。
- [ ] LIGHT/STANDARD/DEEP 的品質維度**並行未被順序化**（唯一先後只剩 build 前的 quality-gate pre-gate）。
- [ ] DEEP 跑了 §2.5 holistic 交叉軸 pass（STANDARD 視波及面可選；LIGHT/SKIP 不跑）；holistic finding 一樣進 finding-validator。
- [ ] security-reviewer（STANDARD/DEEP）有跑威脅建模 / OWASP 補強。
- [ ] 已跑真 app（`/run`·`/verify`）+ 本機 `/code-review`，或純 lib 無 app 據實標 `not measured`。
- [ ] 每個 blocking finding 有 finding-validator 的 `validated/rejected/degraded`。
- [ ] 每條 finding 有 P0–P3 + Confidence + Route，且套 Metric-Honesty。
- [ ] **過了 §4.5 acceptance-completeness 出口 gate（tier-independent）**：product-contract 對 issue **每一條** acceptance criterion 都列了五態、且每條收斂到 已滿足（有證據）或 明確 descoped（留痕）才判 Ready —— **不分 LIGHT/STANDARD/DEEP，不是只有高風險才做**；任一條停在 部分滿足/缺失/證據不足/被反證 未 descoped → Not ready。
- [ ] `04-verify.md` 結論是 Ready / Not ready 並進 iterate（只有出 P0 才停下用 `AskUserQuestion` 問）。
