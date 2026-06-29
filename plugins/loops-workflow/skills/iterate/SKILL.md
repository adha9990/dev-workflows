---
name: iterate
user-invocable: false
description: Triages verify findings or PR feedback, decides which stage to loop back to (max 3 rounds), and finishes when the stop condition is met. Use when starting the iterate stage of a loops-workflow run, or when a PR has reviewer feedback to act on.
---

# iterate — 迭代（triage + 回環決策 + 收尾）

## Overview

`iterate` 把 verify 的缺口 / PR reviewer 的回饋做 triage，決定**回哪個階段重來**（最多 3 圈），或**完工收尾交 PR**。它是閉環的收口 —— 確保「錯的東西被修正、修正有回歸測試守住、**修完再驗一輪**」，而不是無限繞圈。

**核心原則：交給其他（人類 / 外部）reviewer 前，先在內部 `verify ⇄ iterate` 迴圈把問題解到最少** —— 降低外部 reviewer 撞到問題的機率。所以**修完一定再跑一輪 verify**，不能用「測試綠」打發。

做法：彙整三來源回饋 → 分四類 → 對真問題走 Stop-the-Line 修根因（每修加回歸測試）→ 決定回哪個階段或完工收尾。

## When to Use

**Use when**：`04-verify.md` 出爐、或 PR 有 reviewer 回饋要處理。

**NOT for**：
- 還沒驗收 —— 去 verify。
- 全新需求 —— 回 goal 開新迴圈。

## Process

### 1. 收集三來源回饋

verify 報告 / PR reviewer comment / CI 失敗。彙整成一張清單。

**`type=fix`（PR reviewer 回饋）時**，依 `references/pr-feedback-sources.md` 蒐齊 PR 上**所有**回饋來源（總評 / **inline 行內** / 討論串 / CI）—— inline comment 必走 `gh api repos/{owner}/{repo}/pulls/<N>/comments`（`--json reviews` **拿不到**，最常見的 silent miss），再用 GraphQL `reviewThreads` 過濾 resolved / outdated 後去重。

### 2. RECONCILE 四分類

每條回饋分類：
- **contract misread**：reviewer 誤讀了契約 → 婉拒，只陳述技術理由。
- **actionable**：真問題 → **一律自動修（全部，不論 P0–P3），不問使用者「修多少 / 要不要修」**。severity 只決定要不要停下 escalate（P0 停），**不決定修不修**。
- **trade-off**：取捨選擇 → 記 decision record，回覆說明選擇。
- **noise**：純風格 / 無關 → 過濾。

### 3. Stop-the-Line 修（針對 actionable）

**所有 actionable 都修，不挑、不問**（P2/P3 一樣修）—— 「交給其他 reviewer 前把問題在內部解到最少」就是把 actionable 全清掉，不是讓使用者挑幾條修。每個要修的問題走 **STOP → PRESERVE → DIAGNOSE → FIX → GUARD → RESUME**：
- **DIAGNOSE 先定位失敗層**（UI / API / DB / build / 外部 / 或 test 本身），有回歸就用 `git bisect` 釘出引入的 commit —— 不盲目追症狀。
- 修**根因**而非症狀。
- 每修一個 bug **加一條回歸測試**守住（GUARD）。

### 4. 決定回環目標（修完一定再 verify）

依問題性質決定回哪個階段：
- 需求理解錯 → 回 `goal`
- 方法選錯 → 回 `explore`
- 拆解 / 設計缺陷 → 回 `plan`
- 實作 bug → 回 `build`

**修了任何 actionable（含 step 3 自己 Stop-the-Line 修的）→ 一定再過一輪 `verify`**。「測試綠 / typecheck 0 / lint 0」**不能取代 verify** —— 綠燈只證明沒打破現有測試，證不了「修正 + 其波及面」對其他軸（契約 / 安全 / 既有 consumer 行為）安全。**改到共用元件 / 跨切面時，再 verify 要涵蓋波及面**（誰在用被改的東西），不是只看改的那幾行。

**完工只在「最近一輪 verify 已無 actionable findings」時才可達** —— 即「跑完 verify → iterate 這輪沒東西要修」。修完直接跳完工 = 抄捷徑。

### 5. 回環上限：3 圈 + 收斂感知（escalate 是檢查點，不是放棄）

回環**預設上限 3 圈**，但停止條件**看收斂、不只看次數**：

- **收斂中才值得再繞**：每輪 verify 的 actionable findings 要**比上輪嚴格變少**、或是**不同的新問題**（代表在推進）。
- **沒收斂就當下 escalate、不等第 3 圈**：若這輪 findings **沒比上輪少**、或**同一條 finding 又冒出來**（修了又破 / 根因沒搆到）→ 立刻停下 escalate，別把剩下的圈數浪費在原地打轉。
- **碰到 3 圈上限 = 檢查點、不是硬牆**：停下用 `AskUserQuestion` 問怎麼走 —— **回頭重想**（方向有更深問題：DoD 模糊 / 方法選錯 / 設計缺陷 → 回 goal / explore / plan）/ **換跨模型二審**（opt-in，抓同模型結構盲點，見 `references/cross-model-review.md`）/ **授權再繞**（使用者帶新判斷說繼續 → **計數重置**、再走幾圈）。3 不是放棄點，是「這沒在收斂，你要鑽下去還是換路」的人類檢查點。

每次回環在 `loop.md` 記一筆（第幾圈、回哪、為什麼、**這輪 findings 數 vs 上輪**）—— 收斂軌跡是判斷「該不該再繞」的依據。

### 6. 完工收尾

**前提：最近一輪 verify 無 actionable findings**（修完有再驗過，不是測試綠就收）。對照 `00-goal.md` 停止條件全部達成 → 跑 Pre-Launch checklist 骨架（砍掉 infra 項）→ 收尾前過 `references/docs-policy.md`（補 `docs/<topic>.md` + `docs/README.md` 索引、慣例 / 規則有變更才同步 `AGENTS.md` / `CLAUDE.md`）。

**交接物依迴圈類型而定 —— 都先寫暫存 tmp 草稿（不進專案）→ 使用者確認 → `--body-file` post → 刪 tmp，不自動 post**：

- **修正型（`type=fix`，從 PR reviewer 回饋進來、PR 已存在）→ 只產一份：修正回覆 comment**，**固定套 `references/comment-policy.md` §8「修正回覆 comment 版型」**：開場「這輪 N 個 blocking 點都修了」→ 每點「**工程角度**（根因 / 怎麼修 `<file:line>` / 怎麼驗）＋**客戶角度**（修正前 → 後）」→ 結尾 gate 綠。**不 `@` 點名 reviewer、不寫客套**；婉拒項（contract misread）只陳述技術理由。**不另寫 PR body as-built 條目、不另發 issue comment**（除非使用者明確要）。
- **完整迴圈（`type=issue/design`，交新 PR）→ PR 收尾 comment**（`references/pr-spec.md` + `references/comment-policy.md`：成果 + 驗證證據 + 回覆）+ **自動產 explain 理解包**（跑 `explain` skill，給工程師理解）。**完整迴圈完工一律自動產 explain，不問「要不要產」** —— 它是完整迴圈的標準交接物。修正型才**不自動產 explain**（opt-in，用 `/loops-workflow:explain`）。

**follow-up 在當前 issue 內處理、不另開 issue**：發現的後續項 / 既有非本次引入的退化，預設記在當前 issue / PR thread 並在本次或本 issue 內處理，**不 spin off 新 issue**（除非使用者明確要另開）。

> 這些只在「完工」這條分支產；回環途中不產。

完工後把 `loop.md` 的「當前階段」設為「**完工**」（progress / hook 即不再顯示此 loop），**並在 Journal 末尾 append 一行 outcome 度量** —— 依 `references/journaling.md`〈完工 outcome 度量〉的格式（`★[outcome] 結果 ｜ token≈估算(級距)est ｜ sub-agent 數 ｜ 回環 圈 ｜ findings validated→剩餘 ｜ 交付：交付物`），從本 loop Journal 回推各欄、**token 標粗估（規則 5）**，給這條 loop 留下可回顧的成本 / 規模輪廓（落實規則 10 成本意識可觀測）。中止（descoped / aborted）收尾同樣 append 一行。格式定義以 `journaling.md` 為**單一來源**，這裡只引用、不另立第二份。

**收尾清理 —— loop 結束的標準環節，不是選項。分兩個時機：**

1. **iterate 結束本 loop 時（完工或中止，不論有沒有交 PR）→ 清掉 loop 期間產生的所有暫存**：移除該 loop 的 worktree（`git worktree remove --force .claude/worktrees/<slug>` → `git worktree prune`；被鎖刪不掉至少 prune）、刪掉草稿 tmp（應已 post 後刪）、screenshot / gif、scratch 檔等**本機產物**。**這步在 loop 收尾就做，不等 PR**。
2. **PR 合併後 → 清掉分支**：正常流程是 reviewer 審核後才由 reviewer 合併；**本專案是 solo（作者自己合併）→ 合併後也由你自己刪分支 + 清 worktree**（**使用者核可後**用 `gh pr merge <PR#> --squash --delete-branch` —— merge 仍 human-gated、**一律 squash、單一 commit 回 master**，完整 merge 策略見 `references/pr-spec.md`〈merge 策略〉；或事後 `git push origin --delete <slug>` + `git branch -D <slug>`）。遠端 / 本機**只留 `main` + 仍在處理中的 loop 分支**，不囤積已合併分支。

**loop 暫存一律不入庫**：worktree、草稿、截圖、`.loops/`、`data/`、`dev.json` 等都不該被 commit / push。repo `.gitignore` 要涵蓋 `.loops/`、`.claude/worktrees/`、`data/`、`dev.json`、截圖（缺就補）；`git ls-files` 掃一遍確認沒有暫存被追蹤。

**有 actionable findings → 自動全修（不論 P2/P3）→ re-verify，這是 routine、不停下問使用者「修多少 / 要不要修 / 要不要再 verify」**。只有在「最近一輪 verify 已乾淨（無 actionable）」時，才停在**完工 gate**：用 `AskUserQuestion` 確認**交 PR**（outward action 要你點頭）/ 或還要再打磨。另外只有 **回環沒收斂 / 碰 3 圈上限 escalate（檢查點，見 §5）、真正的 trade-off（修法與 `00-goal.md` 衝突）、分類模糊** 才停下問。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「症狀壓掉就好，根因之後再說」 | 症狀修會復發。debugging 的鐵律是修根因，且每修加回歸測試。 |
| 「reviewer 講的我覺得不對，直接忽略」 | 不對的也要分類成 contract misread 並陳述理由婉拒，不是默默忽略。 |
| 「再繞一圈應該就好了」 | 看**收斂**不看感覺：findings 沒比上輪少 / 同條 finding 復現 = 原地打轉，當下就 escalate，不是再賭一圈。 |
| 「還沒到 3 圈，繼續繞」（但 findings 沒變少） | 上限是看收斂、不是用滿次數。沒收斂就 escalate 當檢查點、不必等第 3 圈；碰 3 圈也是停下問你（回頭重想 / 換跨模型 / 授權再繞重置計數），不是放棄。 |
| 「修完不用加測試，這次很簡單」 | 沒有回歸測試守住，同一個 bug 會再回來。GUARD 不可省。 |
| 「測試全綠 + typecheck 0，等於 verify 過了」 | 綠燈只證明沒打破現有測試，證不了修正對其他軸 / 既有 consumer 安全。verify 是 fresh reviewer 各審一軸，綠燈取代不了。 |
| 「改一行而已，不用再 verify」 | 改到共用元件一行的 blast radius 可能比大改還大。波及面要 fresh-verify。 |
| 「這些是 P2/P3 非 blocking，問使用者要不要修」 | actionable = 真問題，一律自動全修（交 reviewer 前把問題解到最少）。severity 只決定要不要停下 escalate（P0），不決定修不修。「修多少」不是使用者決策。 |

## Red Flags

- 修症狀沒修根因。
- 修了 bug 沒加回歸測試。
- 回環**沒在收斂**（findings 沒變少 / 同條復現）卻硬繞、沒 escalate；或繞滿 3 圈沒當檢查點停下問使用者。
- `loop.md` 沒記回環歷史。
- 修正回覆 comment 堆客套 / 沒給驗證證據 / `@` 點名 reviewer（§8 規定不點名）。
- **修完沒再跑 verify 就完工**（拿「測試綠 / typecheck 0」當 verify 替代品）。
- 改到共用元件 / 跨切面，只看綠燈、沒對**波及面**派 fresh reviewer 再驗。
- 把「再 verify」降級成 gate 選項讓使用者點掉。
- **verify 出 actionable findings（含 P2/P3）還問使用者「修多少 / 要不要修」** —— actionable 一律自動全修，不是使用者決策。
- 修正型（`type=fix`）收尾還產一堆草稿（PR body as-built / 另發 issue comment）—— 只該一份修正回覆 comment（§8）。
- **完整迴圈完工還問使用者「要不要產 explain」** —— 完整迴圈一律自動產（只有修正型才 opt-in）。
- 把本可在當前 issue 解決的 follow-up 擅自另開新 issue。
- issue-driven PR 的 body 沒放關閉關鍵字 `Closes #<issue>`（只寫標題 `(#issue)` / 內文提及 = 不連結、merge 不自動關 issue，見 `references/pr-spec.md`）。
- **合併後沒刪已合併分支 / 沒清 worktree**，囤積一堆 merged branch；或 **loop 暫存（草稿 / 截圖 / worktree / `.loops` / `data`）被 commit 推上去**。
- **完工 / 中止沒在 `loop.md` Journal append 一行 outcome 度量**（缺成本 / 規模輪廓，違規則 10 可觀測）；或 token 欄寫成精準值沒標 `est`（違規則 5）。

## Verification

- [ ] 每條回饋有 RECONCILE 分類。
- [ ] verify 出的 actionable findings（不論 P2/P3）**全部自動修了**，沒問使用者「修多少 / 要不要修」。
- [ ] 每個 actionable 修的是根因 + 有回歸測試（GUARD）。
- [ ] 回環**看收斂**（findings 嚴格變少才續繞）；沒收斂 / 碰 3 圈上限已 escalate 當**檢查點**（讓使用者選回頭重想 / 換跨模型 / 授權再繞〔計數重置〕）；`loop.md` 有回環歷史 + 每輪 findings 數。
- [ ] **修了 actionable 後有再過一輪 verify**（涵蓋 fix delta + 波及面、fresh reviewer），不是測試綠就完工。
- [ ] 完工前最近一輪 verify 無 actionable findings。
- [ ] 完工前對照 `00-goal.md` 停止條件全達成。
- [ ] **完工 / 中止已在 `loop.md` Journal append 一行 outcome 度量**（依 `references/journaling.md`〈完工 outcome 度量〉，欄位齊全、token 帶 `est`／級距標粗估）。
- [ ] 收尾交接物依迴圈類型：修正型只一份「修正回覆 comment（`comment-policy` §8、不@reviewer）」、完整迴圈產 PR 收尾 comment + **自動產 explain（沒問「要不要產」）**；對外那份經使用者確認才送、未自動 post、回環途中不產。
- [ ] follow-up 在當前 issue 內處理，沒有擅自另開新 issue。
- [ ] **收尾清理兩時機都做了**：① loop 結束時清掉 loop 期間所有暫存（worktree / 草稿 / 截圖 / scratch，不等 PR）；② PR 合併後刪分支（solo 自己合併自己清，只留 `main` + 進行中）。loop 暫存沒被推上去（`.gitignore` 有涵蓋）。
- [ ] 停在 `iterate` 決策 gate。
