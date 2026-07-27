---
name: plan
user-invocable: false
description: Locks design decisions and breaks work into independently verifiable tasks before any code. Use when starting the plan stage of a loops-workflow run, or when an explored approach needs to become a concrete, task-by-task implementation plan.
---

# plan — 規劃（拍板方案 + 可驗證任務拆解）

## Overview

`plan` 在動任何 code 之前，把設計決策**拍板留痕**，把工作拆成「每一個都能獨立 verify」的 **vertical behavior slice**，並為每個 `behavior_id` **指定一份主證據**。產出 `stages/02-plan.md` —— 一份施工圖：決策紀錄 + 機制圖 + slice 清單（每個帶驗證指令與 change budget）+ **evidence portfolio**。

> `stages/02-plan.md` 文件本體的**完整 §0–§9 施工圖骨架**（系統全貌 + **檔案落點與職責表** + 機制圖 + 名詞說明 + 決策含**具名 OSS 背書** + 三角驗證附錄 + 成果展示）見 `references/stages/design-plan-schema.md` —— 下面 Process 各步驟的產出即歸位到該骨架（決策留痕→§6、機制圖→§2、品質維度→§4）。

做法：先把設計決策留痕、為每個關鍵機制畫圖、對新套件做選型評估，再把工作拆成每個都能獨立 verify 的 slice，並指定每個行為要拿什麼證明。

> **這一階段是實作與驗收成本的閘門**：evidence portfolio 決定「哪些行為要新增測試、哪些沿用既有證據」，change budget 決定「這次改動該多大」。兩者都在 code 之前定案，之後由 `validate-plan.mjs` 與 footprint 對帳機械核。

## When to Use

**Use when**：explore 已選定方法、要把它變成 slice-by-slice 的施工計畫；或需求清楚、直接要拆可驗證 slice。

**NOT for**：
- 方法還沒定 —— 回 explore。
- 已有拍板計畫、要開始寫 code —— 直接 build。

## Process

### 1. 決策留痕（decision record，欄位集＝design-plan-schema §6）

每個設計決策記一筆，欄位集以 `references/stages/design-plan-schema.md` §6 為正本：**選擇 / 為什麼 / 背書 / 未採用 / 拍板人**（背書絕不可空）。涉及取捨的開一個決策點給使用者拍板（表述形狀與各平台互動能力的映射見 `references/shared/delivery/interaction-adapter.md`），每選項標推薦 + 理由。要另出**獨立 ADR 檔**時才用 `references/shared/docs/adr-template.md`（Context / Decision / Alternatives / Consequences 四段式）——plan 內嵌的決策留痕表用 §6 欄位集，兩者用途不同。

### 2. 套件評估（若要引入新套件）

任何新依賴走：掃現有 deps → 列 **≥3 候選** → 比較表 → 開一個決策點拍板。不接受「直接用最熱門」。

### 3. 機制圖（每機制：白話 + 兩張圖）

對每個關鍵機制，寫「一段白話 + 兩張 mermaid」：一張**運作流程圖**（資料 / 控制怎麼跑）、一張**注入 / 接線圖**（誰被注入到誰、怎麼接線）（只有文字敘述不算數）。寫進 `stages/02-plan.md`，**而且第 6 步拍板 gate 一定要把這些圖直接渲染給使用者看** —— 圖是給使用者審「怎麼跑 + 怎麼接線」用的，不能只躺在 `stages/02-plan.md`、也不能只塞進精煉版 alignment comment。

### 3.5 契約規格（`external_or_cross_module_contract=true` 才寫）

**由 explore 的 risk map predicate 決定，不憑感覺加**（判準正本見 `references/stages/risk-map.md`）：`external_or_cross_module_contract=true` → 在 `stages/02-plan.md` 拉一段**契約規格**（依 `references/shared/quality/contract-spec.md`）：API request / response / 錯誤形狀、資料 schema + 約束 + migration 可逆性、事件 payload + 保證。契約是 **build 的輸入、verify 的驗收基準**。

- **契約的證據是「最小 contract test」**：對外形狀一條、錯誤形狀一條，**不逐分支鋪**；它就是該 behavior 的一份 evidence（或第二層證據，要填 `distinct_risk`）。
- **predicate 未命中就不寫這一段**，也不因此新建 port / adapter（純內部重構、不動對外形狀者屬此類）。

### 3.6 領域建模（`domain_complexity=true` 才做）

同樣由 risk map predicate 決定：`domain_complexity=true` → 才寫 ubiquitous language glossary、invariant 清單與 aggregate 邊界（依 `references/shared/quality/clean-architecture.md`）。**未命中就不建 glossary / aggregate / bounded context 圖** —— 多數落在既有領域內的功能改動不需要這一層。

### 4. 品質維度過一遍

- **專案跨切面約定當設計輸入**（見 `references/shared/docs/project-conventions.md`）：goal 折進 DoD 的專案約定（i18n / logging / a11y…）在此當**設計輸入**、不事後補 —— 例：label 要 i18n → 設計就要決定 labelKey / t() 接線；新服務要 logging → 設計就含 logger 注入。命中約定的機制在任務裡明確帶出。
- **設計品質六維度**（簡潔 / 可維護 / 可靠 / 可擴展 / 安全 / 高併發高流量效能）+ **clean architecture 結構標準**（依賴向內 / 分層邊界 / port + 注入 / 落點對齊，見 `references/shared/quality/clean-architecture.md`）：in-scope 實作不以 MVP 設計，對可預見的規模退化預先用對的演算法**與結構**。
- **設計模式對症選型**（見 `references/shared/quality/design-patterns.md`）：設計某機制時，若問題本來就是某模式的經典形狀（多變體 / 可替換演算法 / 解耦通知…）就用對的模式 —— **對症才用、不為套而套**（YAGNI）。
- **重用檢查**（判準見 `references/shared/quality/reuse-check.md`）：拆任務前先確認沒有重複造輪子（含跨入口 / 跨 session 的隱蔽重複；稍異 ≠ 另造，優先參數化既有方法）。
- **設計品質審查（plan 前先 verify）—— 一律必派，但強度依風險分級**：**每一次 plan 都必派 read-only agent 審 `stages/02-plan.md`**（跳過設計審查、憑未查證的假設就拍板，正是過去反覆出包的根因；**必派這件事沒有例外**）。審查對設計做「六維度 + 落點對齊（對照實檔 file:line）+ 契約」，出「方向可行 / 要修 / 資訊不足」判定 —— 把方向 / 落點錯擋在 code 之前，別等 build 完才在 verify 發現方向就錯。
  - **強度依 risk map 分級（改的是「多深、審幾輪」，不是「派不派」）**：
    - **高風險**（任一 behavior `risk=high`、或 `domain_complexity` / `external_or_cross_module_contract` 命中、或新基建 / 新架構接縫 / 跨切面影響 / 動到資料模型）→ **更徹底的審查（更強的 model·effort）＋ 折回後一律再審一輪**，循環到某圈乾淨無必修才進 gate，**圈數硬上限 3**、到頂不收斂 escalate。
    - **一般 / 低風險**（無 high behavior、兩個 predicate 皆未命中）→ **一輪審查**即可；判「要修」→ 折回後**由主線逐條核對必修項是否落實**（附 file:line）即可進 gate，**不強制再派一輪複審**。但只要折回**動到方向、落點或契約**（不只是措辭 / 數值），就升級成高風險路徑再審一輪。
  - **判定「要修」→ 必修項一律折回 `stages/02-plan.md`**（逐條核對、非盲收，附 file:line 證據）。
  - 高風險路徑的複審用 **fresh context**（避免原 reviewer 為自己前一輪背書）、聚焦「必修項是否正確折回 + 有無新問題」，不必重審全案。**圈數語意**：plan 這裡是**硬上限**（到頂即 escalate，設計還沒定案、繼續複審的邊際效益低）；`iterate` 的回環圈數是**軟上限**（到頂只觸發回報，**未修的 P0 不得因圈數收圈**，見 `iterate` §5）。

### 5. 拆成 vertical behavior slice ＋ 指定 evidence portfolio

**施工單位是 vertical behavior slice，不是 task**：一個 slice 交付 ≥1 個 `behavior_id` 的**端到端可跑**改動（做完系統還是 runnable），帶自己的檔案清單與 change budget。欄位與「該再拆」訊號見 `references/stages/task-template.md`。

**同時為每個 behavior 指定一份主證據 —— 這是本階段最重要的產出**（規則正本見 `references/stages/evidence-portfolio.md`，此處不重抄）：

| 要決定的事 | 怎麼決定 |
|---|---|
| 這個 behavior 已經有東西守著嗎？ | 先找 `existing_guard`（指名 `檔案:案例`）。**有就 `new_test=false`，不新增。** |
| 沒有的話，最低有效證據是哪一階？ | 依證據階梯挑：`existing-test` → `static` → `smoke` → `unit-test` → `contract-test` → `integration-test` → `acceptance-test` → `manual-evidence`。**能用上面那階就別用下面的。** |
| 要走 test-first 嗎？ | 看 risk map：該 behavior 的 `risk_triggers` 非空（bug / core-invariant / algorithm / security / concurrency / data-consistency）→ **是**；全未命中 → 否。 |
| 要不要第二層證據？ | 只有寫得出 `distinct_risk`（第二份守的是第一份守不到的**哪個**風險）才加。寫不出＝重複證據，不加。 |
| 這個 slice 要多大？ | 抓 `production_change_budget` 與 `test_change_budget`（各 `files` / `lines`）。**這是可稽核的預估，不是禁止超出**——超了在 living plan 補 `budget_overrun_reason` 即可。 |

**低風險類別預設不新增測試**：wiring、config、metadata、docs、低風險 refactor → `existing-test` / `static` / `smoke` / 可重跑的 `manual-evidence`。

畫依賴圖；每 2–3 個 slice 插一個 checkpoint。

**機器可驗證計畫塊（machine-plan）—— 有 behavior 的功能工作一律開**（不再只在有跨介面契約時才開）：在 `stages/02-plan.md` 內嵌一塊 `loops-plan` JSON（欄位正本見 `references/stages/machine-plan-schema.md`），跑

```bash
node {loops-workflow-plugin-root}/scripts/validate-plan.mjs <stages/02-plan.md>
```

**通過才進 build**。它機械擋下：behavior 沒有 primary evidence / 有兩份 primary 卻沒填 `distinct_risk` / `new_test=true` 沒寫 `new_test_reason` / slice 缺 change budget / 同一檔跨兩個 slice / deps 成環 / verification 不可執行。純內部、無 behavior 的瑣碎改動可用 legacy `tasks` 形（免 behaviors 與 budget）。

### 5.5 （可選）Fleet 方案發想

解法空間寬、單一方案難取捨時，可 opt-in **Fleet**：派 N 個 agent 各從不同角度（MVP-first / risk-first / user-first）出方案 → judge panel 評分 → 綜合最高分 + 嫁接次高的好點子（見 `references/shared/runtime/fleet.md`）。預設不開，使用者說「這題用 Fleet 出幾個方案評審」才啟動。

### 5.9 Unknowns gate（拍板前）

拍板前確認**四象限 Unknowns Register 沒有未解決的 blocking 項**（影響 scope／UX／data／security／architecture／acceptance 任一面向者為 blocking）。還有就回去解——必要時走 `skills/decision-interview` 補訪談或做 blind-spot pass；**帶著未解決的 blocking unknown 進 build 是違規**（`AGENTS.md` 規則 18，policy `unknowns-before-build` 為 tier-2 機械閘）。

### 6. 送出計畫 + 拍板 gate

**在 plan 階段就把計畫草稿送出**（不是等 loop 結束）：issue-driven → 依 **`skills/plan/references/plan-comment-template.md`（本 skill 目錄下；完整版：系統全貌 + 套件清單含版本 + ADR + 機制圖 + 施工圖 + 契約 + out-of-scope）** 寫暫存 tmp 草稿校稿後 post 成 issue 對齊 comment（留 audit trail，**post 後刪 tmp**；更新既有 comment 用 `gh api --method PATCH repos/<owner>/<repo>/issues/comments/<id> -F body=@<tmp>`）；非 issue → 呈現給使用者。**這則 comment 是 living as-built 摘要**，build 偏離時回來同步更新（含已 post 的版本）。

> **這個 post 是 plan 階段的無條件既定步驟（audit trail），不是 `plan → build` gate 的條件選項**：先**無條件** post 對齊 comment（issue-driven；非 issue 則呈現給使用者），**再獨立**走下面的拍板 gate —— 是兩個步驟，不可混成同一個問題問（別把「核可進 build **且** post comment」vs「進 build 但不 post」擺成 gate 選項）。post 對齊 comment 到**你正在處理的該 issue**（使用者交辦 / 自己 assign 的當前 issue）屬 plan 階段的工作流程授權範圍：**「要不要 post 這件事」不需再當成需逐次向使用者確認的『對外動作』**（有別於 dispatch 建 issue 那種需確認的 outward action；草稿校稿本身仍守 `references/shared/delivery/comment-policy.md` §5 的 tmp 草稿校稿 / 送出後刪 tmp 紀律；除非使用者另有指示）。

**拍板前一定把第 3 步的機制圖直接渲染給使用者看** —— 每機制「一段白話 + 運作流程圖（mermaid）+ 注入 / 接線圖（mermaid）」。**機制圖直接放進對齊 comment**（GitHub 原生渲染 mermaid，所以圖就在 comment 裡，不再只躺 `stages/02-plan.md`）。**對齊 comment 必須 self-contained：絕不引用 `.loops/` 路徑**（`stages/02-plan.md` 等是本地暫存、不上 GitHub、PR merge/close 後清除＝死連結）；要指更細只指 PR/commit/`file:line`/issue（見 `references/shared/delivery/comment-policy.md §0`）。

**同時攤一份「我做的假設 → 現在糾正我」清單**：把技術 / 架構 / 範圍 / 平台層面那些**沒問、但默默假設**的事編號列出給使用者看。這跟內部的 HYPOTHESIS+CONFIDENCE 不同 —— 是把藏在決策底下的假設**顯式**攤出來，趁拍板前糾正；比 build 到一半才發現假設錯便宜得多（對齊規則 10 成本意識）。

然後**一定停在 `plan → build` 拍板 gate**（開一個決策點；表述形狀與各平台互動能力的映射見 `references/shared/delivery/interaction-adapter.md`）—— **進 build 前務必先問使用者、不可自行跨入 build**（即使 routine 也要在此 gate 停）。gate 要把使用者要拍板的點顯式列出並**標推薦**：方案 + 任務拆解、**所有新增套件（逐一列出名稱+版本+用途，附推薦，使用者核可後才裝）**、以及任何需要使用者定奪的決策。**新套件 / 新決策一律先問 + 推薦，不先斬後奏**；build 中途若冒出計畫外的新套件或新決策，也停下回此 gate 問。**gate 只拍板上述這些（方案／任務／新套件／新決策），不把『要不要 post 對齊 comment』當成 gate 的選項** —— 對齊 comment 已在上一步無條件處理完（issue → 已 post；非 issue → 已呈現）。

> **`stages/02-plan.md` 是 living source of truth**：實作階段若偏離（決策變、任務拆法變），**回去更新它**（並同步已 post 的版本），保持 as-built —— 不是放到 loop 結束才補。完工時這份 as-built plan 提煉成 PR body（見 `references/shared/delivery/pr-spec.md`）。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「決策理由我記得，不用寫」 | 不留痕，build / verify / 之後的你都得重新推一遍，還可能推出不同結論。 |
| 「直接用最多人用的套件就好」 | 沒評估就引入，等於把選型風險留給未來。≥3 候選比較是硬規矩。 |
| 「Verification 欄寫『跑測試』就好」 | 「跑測試」不可執行。要寫到能複製貼上去跑的指令，否則 build 沒法自證。 |
| 「任務有點大但還好」 | 命中訊號就是該拆。大 slice 沒法獨立 verify，reviewer 也沒法乾淨地接受或退回。 |
| 「每個 slice 都補一條新測試比較安全」 | 安全的是**守到不同風險**，不是多一份。既有證據夠就 `new_test=false`；要新增就寫得出「既有證據缺哪個觀察點」。寫不出＝這條測試不守任何新東西。 |
| 「多一層測試（unit + integration + e2e）比較保險」 | 同一件事守三次不會更安全，只會讓維護面、跑套時間、審查負擔一起漲。第二層以上要填 `distinct_risk`，寫不出就刪。 |
| 「budget 抓不準，先空著」 | 空著就沒有 drift 可判，footprint 閘等於關閉、validate-plan 也會擋。抓一個**可稽核的預估**即可，超了補理由，不是禁止超。 |
| 「這題不複雜，risk map 我心裡有數」 | DDD / Contract-First / test-first 由 predicate 觸發，不由感覺觸發。沒有 risk map 就回 explore 補，不要在 plan 憑印象決定要不要加那幾層。 |
| 「審查抓到的問題完整處理太貴，推薦只修最糟的那半」 | 「只修一半、剩下的接受」會讓某個原本正常的行為壞著出廠＝行為債（AGENTS 規則 10 客觀判準）。推薦以根本解決為先；治標選項把回歸明標在代價面、不得預設標推薦，讓使用者知情拍板。 |

## Red Flags

- 有設計決策沒記 decision record。
- 引入新套件沒有 ≥3 候選比較表。
- slice 的 Verification 欄不是可執行指令。
- slice 命中「該再拆」訊號卻沒拆。
- **有 behavior 卻沒有 evidence portfolio**，或某個 behavior 沒有主證據 / 有兩份主證據（`validate-plan.mjs` 會擋）。
- **`new_test=true` 卻寫不出 `new_test_reason`**（既有證據缺哪個觀察點）；或第二層證據寫不出 `distinct_risk` 還留著。
- **slice 沒抓 change budget** 就進 build（缺少可驗證的 budget＝footprint 閘無從判定）。
- **predicate 未命中卻照樣寫契約規格 / 建 glossary / aggregate**（那兩段由 risk map 觸發，見 §3.5／§3.6）。
- 一般 / 低風險的 plan **硬跑三輪設計複審**（強度依風險分級；必派沒有例外，但輪數不是）。
- 對齊 comment **沒用完整版樣板**（缺套件清單 / ADR / 機制圖 / 施工圖）、或機制圖沒放進 comment —— 等於要使用者盲拍設計。
- **沒在 `plan → build` gate 問使用者就自行跨入 build**（即使 routine 轉場也要在此停下問）。
- **新增套件沒逐一列出（名稱+版本+用途）+ 標推薦 + 等使用者核可就先裝**；或 build 中途冒出計畫外套件/決策卻沒停下回 gate 問。
- **沒派設計審查就進 gate**（一律必派、不論風險高低，沒有「這題簡單」的免派例外 —— plan 前先 verify 設計）；或審查判「要修」卻沒把必修項折回計畫；或**折回後沒再審一輪就進 gate**（不管折回多機械都要再 verify 一圈確認、圈數上限 3、到頂不收斂就 escalate）—— 等於把方向 / 落點錯留到 build 後才在 verify 撞到（最貴）。
- **把 post 對齊 comment 當成 `plan → build` gate 的條件選項問**（例：「核可進 build＋post」vs「進 build 但不 post」）—— 對齊 comment 是 plan 階段**無條件既定步驟**，應**先無條件 post、再獨立走 gate**；gate 只問方案／任務／新套件／新決策。處理使用者交辦 / 自己 assign 的當前 issue、post 對齊 comment 屬工作流程授權，不是需逐次確認的對外動作。

## Verification

- [ ] `stages/02-plan.md` 有 decision record（§6 欄位集：選擇 / 為什麼 / 背書 / 未採用 / 拍板人，背書不可空）+ 機制圖（白話 + 兩圖）。
- [ ] 拍板 gate 已把每機制的**運作流程圖 + 注入 / 接線圖渲染在 chat 給使用者看**（不只躺在 `stages/02-plan.md` / 不只給精煉 comment）。
- [ ] 新套件（若有）附 ≥3 候選比較 + 拍板結論。
- [ ] 每個 slice 有可執行的 Verification 指令、明確 `files`，且**同一檔不跨兩個 slice**。
- [ ] 沒有 slice 命中「該再拆」訊號還未拆。
- [ ] **每個 `behavior_id` 恰有一份 primary evidence**；`new_test=true` 都寫得出 `new_test_reason`；第二層證據都寫得出 `distinct_risk`（規則見 `references/stages/evidence-portfolio.md`）。
- [ ] **每個 slice 有 production 與 test 兩份 change budget**。
- [ ] 有 behavior 的計畫已內嵌 `loops-plan` 區塊，且 `node {loops-workflow-plugin-root}/scripts/validate-plan.mjs <stages/02-plan.md>` **通過**才進 build。
- [ ] 契約規格 / 領域建模這兩段**只在對應 predicate 命中時**才寫（`external_or_cross_module_contract` / `domain_complexity`，見 `references/stages/risk-map.md`）。
- [ ] **設計審查已派**（plan 前先 verify —— 必派沒有例外），判定『要修』的**必修項已折回 `stages/02-plan.md`**；**高風險路徑**（有 `risk=high` behavior／predicate 命中／新架構接縫／折回動到方向·落點·契約）已再審一輪（fresh context），循環到某圈乾淨無必修才進 gate、圈數上限 3、到頂不收斂則 escalate；一般 / 低風險一輪審查 + 主線逐條核對必修項即可。
- [ ] 計畫草稿已在 **plan 階段送出**（issue→post 對齊 comment / 否則呈現），不是留到 loop 結束。
- [ ] 對齊 comment 是**無條件先 post**（issue→post／非 issue→呈現；送出前仍走 `references/shared/delivery/comment-policy.md` §5 tmp 草稿校稿）、**沒有**被當成 `plan → build` gate 的條件選項；gate 只問方案／任務／新套件／新決策。
- [ ] 對齊 comment 用**完整版樣板**（`skills/plan/references/plan-comment-template.md`：系統全貌+套件清單+ADR+機制圖+施工圖+契約+out-of-scope），機制圖直接放進 comment。
- [ ] **進 build 前在 gate 問了使用者**（沒自行跨入），且**所有新增套件已逐一列出+推薦+取得核可**，新決策已先問+推薦。
- [ ] 使用者已拍板，停在 `plan → build` gate。
