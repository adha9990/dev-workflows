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

**Use when**：`stages/04-verify.md` 出爐、或 PR 有 reviewer 回饋要處理。

**NOT for**：
- 還沒驗收 —— 去 verify。
- 全新需求 —— 回 goal 開新迴圈。

## Process

### 1. 收集三來源回饋

verify 報告 / PR reviewer comment / CI 失敗。彙整成一張清單。

**`type=fix`（PR reviewer 回饋）時**，依 `references/pr-feedback-sources.md` 蒐齊 PR 上**所有**回饋來源（總評 / **inline 行內** / 討論串 / CI）—— inline comment 必走 `gh api repos/{owner}/{repo}/pulls/<N>/comments`（`--json reviews` **拿不到**，最常見的 silent miss），再用 GraphQL `reviewThreads` 過濾 resolved / outdated 後去重。其餘 gh／git 呼叫比照 `references/context-diet.md` §B 通則（此段即通則的一個實例）。

### 2. RECONCILE 四分類

每條回饋分類：
- **contract misread**：reviewer 誤讀了契約 → 婉拒，只陳述技術理由。
- **actionable**：真問題 → **一律自動修（全部，不論 P0–P3），不問使用者「修多少 / 要不要修」**。severity 只決定要不要停下 escalate（P0 停），**不決定修不修**。
- **trade-off**：取捨選擇 → 記 decision record，回覆說明選擇。
- **noise**：純風格 / 無關 → 過濾。

**AC-衝突檢查（用戶回饋驅動的 actionable，實作前必做）**：把「這條回饋要求的改動」對照**原始 issue 的書面 AC**——若它會**反轉 / 抵觸某條已寫定的 AC**（例：回饋要求移掉某 AC 要的欄位、或改成 AC 明文排除的行為），**在實作前停下用 `AskUserQuestion` 讓使用者知情拍板**（選項：「確認 descope 該 AC 第 X 條」/「保留該 AC、改用不衝突的做法」，標推薦 + 一句理由），**不默默照做**。這防的正是這類規格漂移：進 PR 後的用戶回饋一輪輪反轉先前決定、和 issue 書面 AC 衝突，iterate 只照當下說的做、沒人回頭比對 AC，規格默默漂移到外部 reviewer 才點名「偏離規格」。

- **使用者仍有權 descope**——本閘是「知情 + 留痕」，不是攔阻 / 婉拒。確認 descope 後：**把「descope 哪條 AC + 理由」同步進 issue / PR（reviewer 看得到的權威留痕）**，`loop.md` Journal 也記一筆（內部稽核副本、**不單獨足以**，見 `references/acceptance-review.md §二`），好讓後續 verify acceptance 閘把該條讀成「明確 descoped」而非「缺失」。
- **只在真撞書面 AC 時觸發**：不反轉任何書面 AC 的回饋，照常當一般 actionable 自動全修，**不冒多餘的 AskUserQuestion**（避免 prompt 疲勞）。
- **auto 模式也停**：AC 反轉是「規格清楚卻被推翻」的 scope 決策，對應 `references/auto-mode.md` 硬煞車 #6，即使 auto 也 surface、不自動帶過。
- 這**不改**「所有 actionable 一律自動全修、不問修多少」的紀律——本閘只針對「撞書面 AC 的反轉」這一子集，問的是「**知不知情 descope**」，不是「修不修」。

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

**再驗一律走 `verify` step-1 選軸、不臨場手挑 reviewer**：回環再驗**不是**「orchestrator 憑印象派兩三個 reviewer」，而是**照 verify 步驟 1 依改動領域定軸 + 加派 conditional reviewer**（並發／同步→`multi-user-concurrency`、bug fix→`root-cause`、queue／背景→`processing-reliability`、migration→`migration`…，見 verify §1）。手挑子集的風險是**把改動所在領域最該派的那個 lens 系統性跳過**——例如修同步 / 併發競態卻只派 `code-quality`＋`tests`，那個「唯一工作就是窮舉事件順序 / 亂序 / lost-update」的 `multi-user-concurrency-reviewer` 就每輪缺席，於是 sibling 競態一輪一輪被外部 reviewer 才抓到、而不是內部一次收斂。**改動命中哪個領域，該領域的 conditional lens 就按規則被派，不靠當下記得。** 反向失效模式同樣要防：**手挑了「領域匹配」的 reviewer、反而把 CORE 軸略掉**——例如修一個 UI 顯示 bug 只派 `frontend-ui`（領域對了），卻跳過核心 `code-quality`（簡潔 / code smell / 重用 lens），於是「這段 chained `.replace()` 本可收斂成查表」這類簡化到外部 reviewer 才被指出。走 step-1 選軸 = **核心軸（含 `code-quality`）＋ 領域 conditional lens 一起派**，不是「挑到對的領域 lens 就夠了」的二選一。

**機械化（不留給「記得」）**：這輪的選軸推導**寫成表落進 `stages/04-verify.md`**（`本輪改動領域 / 簽名 → 核心軸下界 → 觸發的 conditional lens`），且**這輪實際派出的 reviewer 集合須等於表推導出的集合**。格式與**單一真相源在 `verify` skill 步驟 5〈re-verify 選軸推導表〉**——本階段照它做、**不另立第二份表**。（延後回呼 / debounce / timer 捕捉會過期的可變 target 的 stale-capture，由恆派的 `code-quality`〔`correctness-review §六`〕承接，不必另派 conditional lens——所以任何碰去抖 / timer 的 fix，時序 lens 天然在再驗的核心軸裡、不會被漏派。）

**完工只在「最近一輪 verify 已無 actionable findings」時才可達** —— 即「跑完 verify → iterate 這輪沒東西要修」。修完直接跳完工 = 抄捷徑。

### 5. 回環上限：3 圈 + 收斂感知（escalate 是檢查點，不是放棄）

回環**預設上限 3 圈**，但停止條件**看收斂、不只看次數**：

- **收斂中才值得再繞**：每輪 verify 的 actionable findings 要**比上輪嚴格變少**、或是**不同的新問題**（代表在推進）。
- **沒收斂就當下 escalate、不等第 3 圈**：若這輪 findings **沒比上輪少**、或**同一條 finding 又冒出來**（修了又破 / 根因沒搆到）→ 立刻停下 escalate，別把剩下的圈數浪費在原地打轉。
- **碰到 3 圈上限 = 檢查點、不是硬牆**：停下用 `AskUserQuestion` 問怎麼走 —— **回頭重想**（方向有更深問題：DoD 模糊 / 方法選錯 / 設計缺陷 → 回 goal / explore / plan）/ **換跨模型二審**（opt-in，抓同模型結構盲點，見 `references/cross-model-review.md`）/ **授權再繞**（使用者帶新判斷說繼續 → **計數重置**、再走幾圈）。3 不是放棄點，是「這沒在收斂，你要鑽下去還是換路」的人類檢查點。

每次回環在 `loop.md` 記一筆（第幾圈、回哪、為什麼、**這輪 findings 數 vs 上輪**）—— 收斂軌跡是判斷「該不該再繞」的依據。

### 6. 完工收尾

**前提：最近一輪 verify 無 actionable findings**（修完有再驗過，不是測試綠就收）。對照 `stages/00-goal.md` 停止條件全部達成 → **先做收尾裁測 pass（見下）** → 過 `references/docs-policy.md`（補 `docs/<topic>.md` + `docs/README.md` 索引、慣例 / 規則有變更才同步 `AGENTS.md` / `CLAUDE.md`）。

**收尾裁測 pass（交 PR 前唯一的「減」點；純文檔迴圈無測試增量免此步）**：build 與回環期間 TDD 放量是設計如此，收斂只做這一次、且做在「不再有測試進來」的最晚點。派 `test-author` 執行 consolidation（prompt 帶 `references/test-rubric.md` 的**絕對路徑**＋本 PR 對 base 的 diff 範圍；留 / 砍判準與量級門檻**正本在其 §10、此處不重抄**；in-loop bug 迴歸的分流見其 §7）。主線收 `TESTS_PRUNED` 回報後：① 跑 quality-gate 確認**全綠**；② `git diff --numstat <base>..HEAD` 分測試檔 / 功能檔加總，確認增量比例過 §10 量級門檻——超標 → 按判多餘六型回 test-author 再裁（numstat 是量化上限、reviewer 判內容，衝突時 finding 優先）；③ **裁測是一次修，修完必再驗**：觸發 delta re-verify，選軸走 `verify` §5 推導表的**裁測 override**（強制核心軸＋tests、fresh——勿因「只動測試檔」套瑣碎 0 軸）。**完工 gate 讀的是「裁後那輪」re-verify**（它就是新的「最近一輪 verify」）：乾淨才往下走 docs-policy / 交 PR；報 finding（裁過頭）→ 恢復該測試 → 再驗。

**AGENTS.md 同步（條件式，不問）**：docs-policy 檢查若判定**本迴圈確實改變了慣例 / 規則**（AGENTS.md 維護時機命中）→ **主線直接依 `references/docs-policy.md`（時機＋〈怎麼寫〉守門同檔）編輯根 `AGENTS.md` 對應段落**（一次一 scope、documentation-only）；**不命中就不動、不問**——絕大多數功能迴圈不觸發，只有動到規則 / 慣例 / 新子系統的迴圈才會。

**交接物依迴圈類型而定 —— 都先寫暫存 tmp 草稿（不進專案）→ 使用者確認 → `--body-file` post → 刪 tmp，不自動 post**：

- **修正型（`type=fix`，從 PR reviewer 回饋進來、PR 已存在）→ 只產一份：修正回覆 comment**，**固定套 `references/comment-policy.md` §8「修正回覆 comment 版型」**：開場「這輪 N 個 blocking 點都修了」→ 每點「**工程角度**（根因 / 怎麼修 `<file:line>` / 怎麼驗）＋**客戶角度**（修正前 → 後）」→ 結尾 gate 綠。**不 `@` 點名 reviewer、不寫客套**；婉拒項（contract misread）只陳述技術理由。**不另寫 PR body as-built 條目、不另發 issue comment**（除非使用者明確要）。
- **完整迴圈（`type=issue/design`，交新 PR）→ PR 收尾 comment**（`references/pr-spec.md` + `references/comment-policy.md`：成果 + 驗證證據 + 回覆）**＋固定產三份 loop 收尾檔到 `.loops/<slug>/deliverables/`（無編號檔名）**：
  - **`explain.md`** — 理解包（跑 `explain` skill、或主線直接寫等效內容：實作導讀 + ownership 自測題 + 設計方向 recap）。
  - **`checklist.md`** — 合併前手動驗證 + 已知取捨確認清單（尤其**只有手動守、非 CI 常駐**的點：互動行為、a11y 取捨、像素/版面等 jsdom 測不到的）。
  - **`cost.md`** — 成本 / 規模輪廓（展開 `loop.md` Journal 的 outcome 度量：sub-agent 數 + 各 stage token 粗估 + 回環圈數 + findings + 交付物）。
  三份**一律產、不再由 `LOOPS_EXPLAIN` gate**（旗標舊行為只 gate explain 一份；現三份都是完工標準交接物、皆放 `deliverables/`）。PR 收尾 comment 仍先 tmp 草稿→確認→post（不進 `.loops/`）。**修正型（`type=fix`）維持分類排除：不產這三份**（只產一份修正回覆 comment；要理解包時以自然語言請 Claude 跑 `explain` skill）。

**follow-up：能當圈做完的一律當圈做完，不留在 PR 上當延後項**。發現的後續項分兩種、處置不同：

- **actionable（本迴圈能收的真問題 / 清理）→ 當圈做完，不寫成「PR 上的 follow-up」延後**。它就是個 actionable，服從 §2–3「所有 actionable 一律自動全修」——把它列成 PR/issue 的 follow-up 註記＝把該修的 actionable 偷渡成不修，正是要防的事。**交出去的 PR 原則上不帶「待辦 follow-up」清單**：reviewer 撞到的問題要在內部先解到最少（本 skill 核心原則），留一串 follow-up 給人＝把內部沒收乾淨的工作外包給 reviewer。改到共用元件 / 跨切面的清理也一樣當圈補測試做掉、再 verify。
- **genuinely out-of-scope（需獨立拍板 / 等外部輸入 / 屬另一張 issue 的範圍，本迴圈收不了）→ 才記成 follow-up**，且**記在當前 issue / PR thread、不 spin off 新 issue**（除非使用者明確要另開）。這種註記要**帶留痕理由**（為什麼是 out-of-scope、需要誰之後拍板），不是拿來堆放「懶得做的 actionable」。

判準：問「這條現在做得完嗎？」——做得完就是 actionable、當圈做；只有「現在做不完、需要別人先決定」才是可延後的 follow-up。**PR 帶 follow-up 清單前，先自問每一條是不是其實當圈就能做完**（多半是）。

> 這些只在「完工」這條分支產；回環途中不產。

完工後把 `loop.md` 的「當前階段」設為「**完工**」（progress / hook 即不再顯示此 loop），**並在 Journal 末尾 append 一行 outcome 度量** —— 依 `references/journaling.md`〈完工 outcome 度量〉的格式（`★[outcome] 結果 ｜ token≈估算(級距)est ｜ sub-agent 數 ｜ 回環 圈 ｜ findings validated→剩餘 ｜ 交付：交付物`），從本 loop Journal 回推各欄、**token 標粗估（規則 5）**，給這條 loop 留下可回顧的成本 / 規模輪廓（落實規則 10 成本意識可觀測）。中止（descoped / aborted）收尾同樣 append 一行。格式定義以 `journaling.md` 為**單一來源**，這裡只引用、不另立第二份。

**收尾清理 —— loop 結束的標準環節，不是選項。分兩個時機：**

1. **iterate 結束本 loop 時（完工或中止）→ 清掉 loop 期間產生的臨時 scratch**：刪掉草稿 tmp（應已 post 後刪）、散落的 screenshot / gif、scratch 檔等**本機臨時產物**。**這步在 loop 收尾就做，不等 PR**。**例外：`.loops/<slug>/deliverables/real-run/` 下的真機驗證截圖 / `no-ui.md` 不清**——那是驗證證據（pr-gate 閘④ receipt）、非臨時 scratch，隨 `.loops/` 留到 worktree/loop 一起清（見 `references/journaling.md` 資料夾佈局）。
   - **但 worktree 不在這步清（有開著的 PR 時保留到 §②）**：交了 PR、等人工驗收 / merge 這段期間，**使用者可能還要從該隔離 worktree 跑 / 檢視**（例如 `pnpm dev` 在獨立 portless 子網域驗證 PR 的改動、不擾主 checkout）—— loop 一結束就砍掉 worktree 會**破壞這段期間的驗收能力**。所以**有開著的 PR 時，該 loop 的 worktree 保留到 PR merge / close 才連同分支一起清（§②）**。
   - **只有「本 loop 沒交 PR」（純中止 / 無 PR 產出）→ 沒有要保留 worktree 的理由，loop 結束即可一併移除**（`git worktree remove --force .claude/worktrees/<slug>` → `git worktree prune`；被鎖刪不掉至少 prune）。
2. **PR merge / close 後 → 清掉分支 + worktree**：正常流程是 reviewer 審核後才由 reviewer 合併；**本專案是 solo（作者自己合併）→ 合併後也由你自己刪分支 + 清 worktree**（**使用者核可後**用 `gh pr merge <PR#> --squash --delete-branch` —— merge 仍 human-gated、**一律 squash、單一 commit 回 master**，完整 merge 策略見 `references/pr-spec.md`〈merge 策略〉；或事後 `git push origin --delete <slug>` + `git branch -D <slug>`）。**worktree 也在這時才 `git worktree remove --force .claude/worktrees/<slug>` → `git worktree prune`**（被鎖刪不掉至少 prune；殘留目錄未被 git 追蹤（untracked）、無害，詳見 `references/pr-spec.md`〈worktree / 分支清理時機〉）。**PR 被 close 未 merge 也是同一時機**——不再需要那個 worktree，同樣刪分支 + 清 worktree。遠端 / 本機**只留 `main` + 仍在處理中的 loop 分支**，不囤積已合併分支。

**loop 暫存一律不入庫**：worktree、草稿、截圖、`.loops/`、`data/`、`dev.json` 等都不該被 commit / push。repo `.gitignore` 要涵蓋 `.loops/`、`.claude/worktrees/`、`data/`、`dev.json`、截圖（缺就補）；`git ls-files` 掃一遍確認沒有暫存被追蹤。

**有 actionable findings → 自動全修（不論 P2/P3）→ re-verify，這是 routine、不停下問使用者「修多少 / 要不要修 / 要不要再 verify」**。只有在「最近一輪 verify 已乾淨（無 actionable）」時，才停在**完工 gate**：用 `AskUserQuestion` 確認**交 PR**（outward action 要你點頭）—— 核可後**一律 `gh pr create --draft --assignee @me`**（開 draft + 指派作者自己，見 `references/pr-spec.md`〈開法〉；使用者要正式請 merge 時才 `gh pr ready <PR#>` 轉 Ready）/ 或還要再打磨。另外只有 **回環沒收斂 / 碰 3 圈上限 escalate（檢查點，見 §5）、真正的 trade-off（修法與 `stages/00-goal.md` 衝突）、分類模糊** 才停下問。

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
- **delta re-verify 用手挑的 reviewer 子集充當、沒走 `verify` step-1 選軸** —— 改動所在領域該派的 conditional lens（並發→`multi-user-concurrency`、bug fix→`root-cause`…）被系統性跳過，該類問題只能等外部 reviewer 抓。**機械化後**：沒把選軸推導寫成表落進 `stages/04-verify.md`、或派出的 reviewer 集合 ≠ 表推導集合（見 `verify` §5 單一真相源）。
- 把「再 verify」降級成 gate 選項讓使用者點掉。
- **verify 出 actionable findings（含 P2/P3）還問使用者「修多少 / 要不要修」** —— actionable 一律自動全修，不是使用者決策。
- **用戶回饋要求的改動反轉 / 抵觸某條書面 issue AC，卻默默實作、沒 surface 讓使用者知情 descope**（規格默默漂移、到外部 reviewer 才點名「偏離規格」）—— 撞書面 AC 的反轉要先 `AskUserQuestion` 知情拍板、確認 descope 後同步 issue/PR 留痕（見〈AC-衝突檢查〉）；但別把它擴大成「每條用戶回饋都問要不要修」（那違反 actionable 全修）。
- 修正型（`type=fix`）收尾還產一堆草稿（PR body as-built / 另發 issue comment）—— 只該一份修正回覆 comment（§8）。
- **完整迴圈完工沒產齊三份 deliverable**（`explain.md` + `checklist.md` + `cost.md`）到 `.loops/<slug>/deliverables/`；或**放錯位置**（平放 loop 根、或塞進 PR comment 而非 `deliverables/`）；或**修正型卻產這三份**（修正型只該一份修正回覆 comment）。
- **把當圈能做完的 actionable 寫成「PR 上的 follow-up 待辦」延後**（＝把該修的 actionable 偷渡成不修）；交出去的 PR 帶一串本可當圈做掉的 follow-up 清單。
- 把本可在當前 issue 解決的 follow-up 擅自另開新 issue。
- issue-driven PR 的 body 沒放關閉關鍵字 `Closes #<issue>`（只寫標題 `(#issue)` / 內文提及 = 不連結、merge 不自動關 issue，見 `references/pr-spec.md`）。
- **PR 還開著（等人工驗收 / merge）就在 loop 收尾砍掉該 loop 的 worktree** —— worktree 要保留到 PR merge / close（§②）才清；loop 結束（§①）只清臨時 scratch（tmp / 截圖 / gif / scratch）。只有「沒交 PR 的純中止」才在 loop 結束連 worktree 一起清。
- **交 PR 沒帶 `--draft` 或沒帶 `--assignee @me`**（直接開成 Ready 請 merge、或沒指派作者本人）—— 一律先 draft + 指派自己，使用者要 merge 才 `gh pr ready` 轉正（補救：`gh pr ready <PR#> --undo` 轉回 draft、`gh pr edit <PR#> --add-assignee @me` 補指派）。見 `references/pr-spec.md`〈開法〉。
- **合併後沒刪已合併分支 / 沒清 worktree**，囤積一堆 merged branch；或 **loop 暫存（草稿 / 截圖 / worktree / `.loops` / `data`）被 commit 推上去**。
- **完工 / 中止沒在 `loop.md` Journal append 一行 outcome 度量**（缺成本 / 規模輪廓，違規則 10 可觀測）；或 token 欄寫成精準值沒標 `est`（違規則 5）。
- 收尾敘述的 merge SHA / CI 狀態 / 測試數**不是剛用指令查回來的**——狀態類每步用單一乾淨指令驗證後才可寫進回報；查不到就說卡住，不編一個合理值（規則 5）。

## Verification

- [ ] 每條回饋有 RECONCILE 分類。
- [ ] 交 PR 一律 **draft + `--assignee @me`**（`gh pr create --draft --assignee @me`；使用者要 merge 才 `gh pr ready` 轉 Ready，見 `references/pr-spec.md`〈開法〉）。
- [ ] verify 出的 actionable findings（不論 P2/P3）**全部自動修了**，沒問使用者「修多少 / 要不要修」。
- [ ] 每個 actionable 修的是根因 + 有回歸測試（GUARD）。
- [ ] 回環**看收斂**（findings 嚴格變少才續繞）；沒收斂 / 碰 3 圈上限已 escalate 當**檢查點**（讓使用者選回頭重想 / 換跨模型 / 授權再繞〔計數重置〕）；`loop.md` 有回環歷史 + 每輪 findings 數。
- [ ] **用戶回饋撞書面 AC 已知情拍板**：用戶回饋驅動的改動若反轉 / 抵觸某條書面 issue AC，實作前已 `AskUserQuestion`（informed descope、選項標推薦）；確認 descope 已同步 **issue/PR 權威留痕**（`loop.md` 僅內部稽核）；不撞任何書面 AC 的回饋照常當 actionable、沒冒多餘問句（見〈AC-衝突檢查〉、`references/auto-mode.md` 硬煞車 #6）。
- [ ] **修了 actionable 後有再過一輪 verify**（涵蓋 fix delta + 波及面、fresh reviewer），不是測試綠就完工；**且再驗走 `verify` step-1 選軸（依領域自動派 conditional reviewer），不是臨場手挑 reviewer 子集**；**選軸推導寫成表落進 `stages/04-verify.md`、派出集合＝推導集合（單一真相源在 `verify` §5）**。
- [ ] 完工前最近一輪 verify 無 actionable findings。
- [ ] **完工前已做收尾裁測 pass**（test-author `TESTS_PRUNED` → quality-gate 全綠 → numstat 過 `test-rubric.md` §10 量級門檻 → 裁後 delta re-verify〔`verify` §5 裁測 override 選軸〕乾淨，完工 gate 讀裁後那輪）；純文檔迴圈（無測試增量）免。
- [ ] 完工前對照 `stages/00-goal.md` 停止條件全達成。
- [ ] **完工 / 中止已在 `loop.md` Journal append 一行 outcome 度量**（依 `references/journaling.md`〈完工 outcome 度量〉，欄位齊全、token 帶 `est`／級距標粗估）。
- [ ] 收尾交接物依迴圈類型：修正型只一份「修正回覆 comment（`comment-policy` §8、不@reviewer）」；完整迴圈產 PR 收尾 comment **＋三份 loop 收尾檔 `deliverables/{explain,checklist,cost}.md`（無編號、一律產）**；對外的 comment 經使用者確認才送、未自動 post、回環途中不產。
- [ ] **AGENTS.md 同步已判**：docs-policy 檢查命中「慣例 / 規則改變」→ 主線已依 docs-policy（含〈怎麼寫〉守門）直接編輯對應段落；未命中 → 未動也未問（不對無關迴圈加噪音）。
- [ ] **actionable 的 follow-up 都當圈做完了**（沒把能做完的 actionable 寫成 PR 上的延後待辦）；只有 genuinely out-of-scope（需獨立拍板 / 等外部輸入）才記成帶留痕理由的 follow-up，且在當前 issue / PR thread、沒擅自另開新 issue。
- [ ] **收尾清理兩時機都做了**：① loop 結束時清掉臨時 scratch（草稿 / 截圖 / gif / scratch，不等 PR）—— **有開著的 PR 時 worktree 不在這步清**（只有沒交 PR 的純中止才連 worktree 一起清）；② PR merge / close 後刪分支 + 清 worktree（solo 自己合併自己清，只留 `main` + 進行中）。loop 暫存沒被推上去（未追蹤 / `.gitignore` 涵蓋，`git ls-files` 掃一遍確認）。
- [ ] 停在 `iterate` 決策 gate。
