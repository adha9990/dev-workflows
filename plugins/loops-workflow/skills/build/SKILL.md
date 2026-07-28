---
name: build
user-invocable: false
description: Implements each planned task into working, test-protected code. Use when starting the build stage of a loops-workflow run, or when a confirmed plan is ready to be coded task by task.
---

# build — 執行（依證據選路徑；風險命中才紅綠分離）

## Overview

`build` **逐 vertical behavior slice** 施工。第一件事不是寫測試，而是**讀 plan 指定的 primary evidence 決定這個 slice 怎麼做**（步驟 A）：低風險的接線 / 設定 / 沿用既有證據 → 一個 implementation agent 做完就跑既有證據；**風險命中（bug / 核心不變式 / 演算法 / 安全 / 並行 / 資料一致性）、或要立對外契約 / 使用者 journey 代表路徑** → 才走完整 **紅 → 綠 → 重構**，用**兩個分離的 agent** 防止測試遷就實作：`test-author` 只看需求寫 failing test、看不到實作（**`operation=refactor` 例外**：寫的是釘現狀的全綠 characterization test、無紅燈相，見步驟 1–2）；`impl-author` 只負責轉綠、不准改 test。主線當編排者，不自己下海寫 test 或 impl，只接收紅綠結果。

> 為何不偏：feedback（test）與被測對象（impl）由不同 agent、在不同 context 產出 —— 寫測試的沒看過實作，就不會把測試寫成遷就實作；寫實作的不能改測試，就不能讓測試將就自己。

> **寫到合併標準（shift-left）**：impl-author 寫的當下就照 verify 會查的同一套品質標準寫（clean code / clean architecture / 安全 / 重用 / 設計模式）—— 標準在 build 與 verify 是**同一份 reference、兩處套用**，build 主動寫到位、verify 獨立複查抓盲點（見 `AGENTS.md` 規則 11）。寫對的成本遠低於寫錯被 verify 退回重修。

## When to Use

**Use when**：`stages/02-plan.md` 已拍板（含 evidence portfolio 與 change budget、`validate-plan.mjs` 已通過）、要逐 slice 實作。

**NOT for**：
- 計畫還沒拍板 —— 回 plan。
- 改完要驗收 —— 去 verify。

> **Step 0（硬性 gate，派任何 test-author/impl-author 之前先做，不是可選前言）——確認在 worktree 裡**：會動 code 的 loop（issue/fix）**必須**在獨立 git worktree（自帶 branch）寫，**不在使用者主 checkout 直接改／`checkout -b`**。先驗證：`git rev-parse --show-toplevel` 應指向 `.claude/worktrees/<slug>`；不是 → **先開再往下**（`git worktree add .claude/worktrees/<slug> -b <slug> <base>`，branch/worktree 名 = slug、不加 type 前綴；dispatch 對 issue/fix 可能已開）。
> - ⚠️ **不得用 session／harness 的「work in place」「略過自動進 worktree」等設定當藉口跳過本 gate**：那些管「整個 session 是否隔離進 worktree」，與「為 loop 的 code 開 worktree、session 仍留主 repo」是**不同層且相容**——session 留主 repo、worktree 只放 code，正是要的樣子。把它讀成「不用 worktree」= 繞過 `AGENTS.md` 規則 9（已踩過：在主 checkout `checkout -b` 做了一輪才被使用者抓）。
> - 機械擋：`hooks/worktree-guard.mjs`（在 shell 指令〔Bash / PowerShell〕真正執行**之前**攔截、可直接 deny，預設開）偵測到對已建 loop 的 `checkout -b`／`switch -c` 在主 checkout 執行即擋、導向 `git worktree add`。逃生口 `LOOPS_WORKTREE_GUARD=0`。
> - **worktree 需自己的依賴**（node_modules 不隨 worktree 共享）→ 開完先在 worktree 跑一次安裝（如 `pnpm -C <worktree> install`）才能跑測試。之後測試/commit 一律 `pnpm -C <worktree>` / `git -C <worktree>`。**`.loops/` 續留主 repo 絕對路徑、不寫進 worktree**。見 `AGENTS.md` 規則 9。

> **step-0 迴圈外置（#99，opt-in）**：`LOOPS_LOOP_DRIVER=1` 且 auto 語意成立（loop.md `推進模式：auto` 或 `LOOPS_AUTO=1`）時，進 build 先把 `stages/02-plan.md` 任務拆解一次性解析寫入 `$LOOPS_ROOT/.loops/<slug>/state.json`（schema/欄位語意見 `references/shared/runtime/journaling.md` loop-driver 條目；**既有 state 不歸零**——`session` 更新為當前、`tasks[].status` 依 03-build 軌跡/quality-gate 推導保留、iteration 歸 1）。之後每任務完成（step 7 Save Point 後）把該任務 `status` 翻 `done`（atomic、單欄——cursor 由 hook 推導、不另記 index）；**build 全完進 verify 前主線刪 state.json**（正常收攤；loop-driver 完工路徑的刪除＝同 session crash 兜底）。closed 且未設 LOOPS_AUTO＝不建 state、行為完全不變。跨 session 孤兒 state 惰性無害（永不匹配），同 slug 重跑接管或手刪。

> **平行 build 一律 worktree 隔離**：build 預設**逐任務序列**跑紅綠（同一時間只有一個 writer，在 loop worktree 裡）。若為加速**平行派多個會寫檔的 agent**（跨獨立任務 / DAG 同層），**每個平行 writer 必須各自一個隔離 worktree**（`isolation: 'worktree'`）—— 共用同一工作目錄會競態，且各 agent 自報的「綠」是不同時間點的半成品態、**不可採信**（已踩過）。平行完成後合併回主 worktree，**由主線在合併態跑 quality-gate（見下方〈quality-gate 整合〉、只讀精簡摘要，確認預期 gate 皆 `passed`、非 `not-run`）才算數** —— 不採信各 agent 自報。見 `AGENTS.md` 規則 9。

> **quality-gate 整合（跑測試只讀摘要，省 token）**：build 的三個「主線跑測試」確認點（step 2 確認 Red / step 4 確認 Green / 平行合併 re-run）**不收完整 `pnpm typecheck && lint && test` 輸出**（中大型套件單次可灌 >100k token），改跑 quality-gate 腳本只讀**精簡摘要**：
> - 調用：`node {loops-workflow-plugin-root}/scripts/loops-quality-gate.mjs --cwd <被驗的目標專案>` —— plugin root 從本 skill 的 base directory 解析（同 reference 絕對路徑機制）；`--cwd` 是**目標專案、不是 plugin**。綠燈＝單行 `✓`、紅燈＝counts + 結構化 failures 清單。**但 `✓`（`ok:true`）也涵蓋 gate 被 graceful skip** —— 摘要會逐 gate 標 `passed`/`not-run`/`failed`/`errored`。**Green 成立的條件是「預期要跑的 gate 顯示 `passed`」，不是只看 `✓`**：某預期 gate 落 `not-run`/`status=partial` = 該 gate **未驗證、非綠**（見下 fallback）。
> - **派 fixer（impl-author / test-author）修紅燈時，prompt 只帶 quality-gate 的結構化 failures（`file:line [code|ruleId] message`，契約見 `references/stages/quality-gate-schema.md`），不附原始 stdout**（要逐欄程式化才加 `--json`）。
> - **純 lint / 型別 false-positive（在 test 檔、不動任何斷言 / 測試邏輯）主線可直接收，不必回退 test-author**：test-author / impl-author 是 subagent、**無 shell**——改完自己跑不了 gate，只能盲改回報。若 gate 紅是**測試檔的純 lint / 型別 false-positive**（例：`vi.fn()` 未帶型別 → `mockImplementation` 觸發 `no-misused-promises`；`any` 需收斂成 union）且修正**只碰型別註記 / cast / import、不動任何斷言或 mock 行為**，**主線直接改即可**——它沒注入 implementation 知識、沒改斷言，不破壞紅綠誠實性，比「盲改 → 主線跑 gate → 又紅 → 再盲改」來回數輪省很多（已踩過：一個 mock 型別 false-positive 退回 test-author 3 次都盲改沒中）。**界線（守住）**：一旦要動**斷言、mock 行為、測試邏輯 / 覆蓋**，仍回 test-author —— 「主線下海改 test 遷就 impl」正是紅綠分離要防的事，此例外只放行「不改測什麼、只讓它編得過」的機械修正。
> - **fallback / 漏偵測**：gate **全** `not-run`（無 `.loops/gate.config.json` 又偵測不到任何工具）→ 回退到該專案既有的驗證指令並建議補 config。**任一預期 gate 落 `not-run`**（如缺 `tsconfig.json` / lint script 沒被偵測到、但 test 綠）→ **不可當綠**，提示在 `.loops/gate.config.json` 指明該 gate 指令（見 schema）。
> - **務實邊界**：目標是把確認點輸出**從 ~100k 壓到 ~2k**，不是「消除 agent 看輸出」（Claude Code `Workflow` 沙箱不能 spawn 測試 → 由主線 Bash 跑腳本讀摘要）。
> - **quality-gate 以外的原始輸出**（手跑單套測試、建置、除錯命令）依 `references/shared/runtime/context-diet.md`（紅綠不對稱＋截斷必附落盤路徑＋skipped 必列）——quality-gate 契約不變、context-diet 補它未覆蓋的路徑。
> - **多個完整 test / quality-gate 不併發跑**（共用 port / cache / DB 檔會競態出 spurious failures）——完整 gate 一律**序跑**。並行 agent 作業期間要判單檔乾淨，用 targeted 測試＋typecheck＋per-file lint 對基線，別各自起完整 gate。

## Process

### 步驟 A（每個 slice 先做）：依 primary evidence 選路徑

**不是每個 slice 都跑完整 TDD。** 進一個 vertical behavior slice 之前，先讀 `stages/02-plan.md` 的 evidence portfolio（規則正本見 `references/stages/evidence-portfolio.md`），依它為這個 slice 的 behavior 指定的 `primary_evidence` 選路徑：

| plan 指定的 | 這個 slice 怎麼做 | 派幾個 agent |
|---|---|---|
| **`risk_triggers` 非空**（bug / core-invariant / algorithm / security / concurrency / data-consistency，見 `references/stages/risk-map.md`） | **選擇性 TDD**：走下面步驟 1–7 的完整紅綠分離 | 2（test-author → impl-author） |
| **`contract-test`**（Contract-First 命中） | 先把契約定死 → test-author 寫**最小 contract test**（對外形狀一條 + 錯誤形狀一條，不逐分支鋪）→ Red → impl → Green | 2 |
| **`acceptance-test` / `integration-test` 且 `new_test=true`** | test-author 寫**一條代表路徑**（不是每個分支一條）→ Red → impl → Green | 2 |
| **`existing-test`**（`new_test=false`） | **只派 impl-author** 實作 → 主線跑 `existing_guard` 指名的既有證據確認仍綠。**不新增測試** | 1 |
| **`static` / `smoke`** | **只派 impl-author** → 主線跑 quality-gate（型別 / lint / schema）或一次真實 smoke | 1 |
| **`manual-evidence`** | **只派 impl-author** → 產出**可重跑**的手動證據（環境 / 步驟 / 預期 / 實際 / 前後對照），落進 `deliverables/` | 1 |

- **預設是一個 implementation agent 完成一個 slice**；紅綠分離（兩個 agent）只在上表前三列啟用。
- **派工前先產 context pack**（`references/shared/runtime/shared-memory.md`）：每個 slice 依角色各產一份——`test-author` 拿 behavior／契約／既有證據與範圍內的檔案清單，**拿不到檔案內容與實作事實**（隔離規則不因共享而放寬）；`impl-author` 拿架構、契約、reuse、約定與這輪要修的 finding。**架構事實不必每個 slice 重查一次**，來源沒變就直接重用。
- **偏離 plan 的證據型別要回去改 plan**（living plan）—— 例如做到一半發現既有證據其實蓋不到，要回 `stages/02-plan.md` 把該條改成 `new_test=true` **並補 `new_test_reason`**，再往下。**不可以在 build 現場自行加測試而不更新計畫**：footprint 對帳（`scripts/diff-footprint.mjs`）會抓到「新測試沒有理由」。
- **每個 slice 收尾比對 change budget**：實際改動明顯超出 plan 抓的 budget → 回 plan 補 `budget_overrun_reason`（超出不是禁止，沒說明才是）。

### 步驟 B（TDD / contract / acceptance 路徑）：紅 → 綠 → 重構 7 步

1. **派 `test-author`**：只給它需求 / 契約 + TDD 品質判準，**它的 context 不含 implementation**；把 `references/shared/quality/test-rubric.md` 的**絕對路徑**寫進其 prompt（分層測試 unit/integration/smoke/e2e、real-not-mock、async 等真完成、data-layer 覆蓋清單；subagent 用相對路徑讀不到）。**派之前先讀 `loop.md` 的 `operation` 性質，依 `references/stages/operation-first-move.md` 把對應該性質的「紅燈第一步規則」併入 test-author 的 prompt**（精確措辭以該檔為準、**不在此重抄**——避免漂移）；**`loop.md` 無 `operation` 欄（升級前的舊 loop / 直接 `/goal` 起未補寫 / fix 型未經 goal）→ 套 fail-safe 視為 `new-feature`（標準 TDD）**。此規則只影響紅燈起手式，不改紅綠分離、不破壞「test-author 不見 impl」。另把 `references/shared/runtime/context-diet.md` 的**絕對路徑**一併寫進 prompt（讀既有測試檔守 stale-Read／大檔範圍讀）；issue / DoD 有 GWT 場景時，`references/stages/bdd-scenarios.md` 的**絕對路徑**也一併帶上（test-author 依場景寫測試、測試名帶場景 ID）。**另把該 behavior 的 evidence portfolio 條目原文帶進 prompt**（`primary_evidence` / `existing_guard` / `new_test_reason` / `distinct_risk`）＋ `references/stages/evidence-portfolio.md` 的**絕對路徑** —— 它要知道「這條測試被指定要守什麼、既有證據為什麼不夠」，才不會順手把既有測試再測一遍。它依其〈輸出協定〉回報（`TESTS_READY` sentinel＋檔案路徑＋案例↔需求對映；**測試 code 不貼回**——寫進檔案、主線跑 gate 讀檔；`operation=refactor` 例外時 `expect_red`＝N/A 變體，見步驟 2）；
   - **`NO_NEW_TEST_REQUIRED` 是合法回報**：test-author 判定「`existing_guard` 已經守住這個觀察點、不需要新測試」時回它（帶指名的既有案例）。主線的處置：**跑那條既有證據確認它真的紅得起來 / 綠得對**，然後**回 plan 把該條 evidence 改成 `new_test=false`**（living plan），直接進步驟 3 派 impl-author。**不要為了「有東西可以跑紅燈」而硬寫一條**。
   - 回報 `BLOCKED`（reason：需求矛盾/缺前置）→ **走規則 2 安全停問使用者或回 goal/plan，非 referee**（referee 只裁 test-vs-impl 爭議）。
2. **主線跑 quality-gate → 確認 Red**（讀精簡摘要：摘要應顯示目標測試失敗、且失敗原因正確；**不收完整 test 輸出**。見上〈quality-gate 整合〉）。**例外 `operation=refactor`**：refactor 的 characterization test 釘現狀行為、**本來就全綠、無紅燈相**——此時不期待 Red，改確認「既有測試 + 新補的 characterization test **全綠**」才往下（refactor 的紅綠分離是「行為不變仍綠」，以全綠取代紅→綠，其餘三性質仍走標準 Red→Green）。
3. **派 `impl-author`**：給它 test + plan，寫**最小範圍**實作轉綠、**不准改 test**；把 `references/shared/quality/minimalism-ladder.md`（**每次派工都注入、由 orchestrator 確定性帶上，不靠 impl-author 自己記得爬階梯**）、`references/shared/quality/clean-code.md`、`references/shared/quality/clean-architecture.md`、`references/shared/quality/security-checklist.md`、`references/shared/quality/reuse-check.md`、`references/shared/runtime/context-diet.md`（自跑測試／除錯的輸出瘦身＋stale-Read）的**絕對路徑**寫進其 prompt —— 要求**綠燈當下就照合併標準寫**：clean code（命名 / 小函式 / guard clause / 顯式錯誤 / 型別契約）+ clean architecture（依賴向內 / port + 注入 / 落點對齊）+ **安全**（輸入邊界驗證 / authn-authz + ownership / SQL 參數化 / 敏感資料不進回應·log / 不藏密鑰）+ **重用**（寫前先確認沒有既有的）—— 不是先寫爛 / 寫不安全再靠 verify 抓（shift-left，見 AGENTS.md 規則 11）。**修紅燈時 prompt 只帶 quality-gate 的結構化 failures（不附原始 stdout，見上〈quality-gate 整合〉）。** 它依其〈輸出協定〉回報（`IMPL_COMPLETE` sentinel；code 不貼回；`deviation` 欄非 none → 主線同步 living plan，規則 10）。 **model 動態（成本，見 `references/shared/runtime/model-effort-policy.md`）**：impl-author 預設用其 frontmatter 宣告的 `implementation` tier（tier ↔ 各平台實際 model 的對照在 `references/capability-registry.json` 的 `model_tier`）。**遇 L / XL 尺寸、跨子系統、或新架構接縫的任務**（見 `references/stages/task-template.md` 尺寸階梯；XL 照理應在 plan 拆掉、此為兜底）時，該次 Task 派工改用最強的 `referee` tier 覆寫；一般任務維持 `implementation` tier。referee 本來就是 `referee` tier，不需覆寫。effort 無法 per-dispatch。
4. **主線跑 quality-gate → 確認 Green**（讀綠燈單行摘要、**不收完整輸出**；Green 成立＝**預期要跑的 gate 顯示 `passed`**，不是只看 `✓` —— 某預期 gate 落 `not-run`/`status=partial` 是「未驗證」不是綠，按〈quality-gate 整合〉的 fallback / 漏偵測處理）。
5. **Refactor（條件式：對得到一個具名 code smell 才做，不是每個 slice 的固定步驟）**：綠燈後先問「這個 slice 動到的 code 有沒有對得上名字的異味（長函式 / 重複 / 條件分支爆炸 / 資料泥團…）？」——**答不出名字就跳過，直接進步驟 7 Save Point**。有的話才派 impl-author，把 `references/shared/quality/refactoring.md` 與 `references/shared/quality/code-simplification.md` 的**絕對路徑**寫進其 prompt（subagent 用相對路徑讀不到，見 AGENTS.md〈參考檔路徑解析〉）—— **`refactoring`：先對到一個具名 code smell 才動、用具名手法（Extract Function / Replace Conditional with Polymorphism…）小步改、設計模式對症才引入**；**`code-simplification`：Chesterton's Fence、過度簡化四陷阱、紅旗「簡化若需要改 test 才能過 = 你改的是行為不是結構，停下」**。**Refactor 的範圍限於這個 slice 動到的 code**，不順手擴張到週邊（那是另一條 loop 的事）。
6. **衝突仲裁**：若 impl-author 主張 test 與需求不符（其〈輸出協定〉的 `BLOCKED`＋`dispute: <test 檔:行> — <理由>`）→ 回報主線，主線依 `stages/00-goal.md` 完工定義裁決；必要時派 `referee` 判是 test 錯還是 impl 錯。
7. **Save Point**：測試綠 → 分段 commit（繁中、每個邏輯單位一筆，規範見 `references/shared/delivery/commit-spec.md`）；測試紅且修不動 → revert 到上個 Save Point。寫 `stages/03-build.md`（Change Summaries 三段式，見 `references/stages/change-summaries.md`）。

**偏離 plan 就回去改**：實作若發現需偏離 `stages/02-plan.md`（某決策要變、某任務要重拆）→ **先回去更新 `stages/02-plan.md`（living plan）並同步已 post 的版本**，再續做；偏離大到動搖方案就回 `plan` gate 重新拍板。不要讓 code 與 plan 各走各的、留到最後才對。

**內部紅綠不每單位停**；整個 build 做完寫 `stages/03-build.md` + 摘要，**直接進 verify**（routine 轉場不問）。只有碰到危險 / 不可逆操作、或測試怎樣都弄不綠時才停下**開一個決策點**問（給選項、逐項列優缺、標一個推薦；表述形狀與各平台互動能力的映射見 `references/shared/delivery/interaction-adapter.md`）。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「我直接自己寫 test 和 impl 比較快」 | 同一個腦袋寫兩邊，test 會不自覺遷就 impl，錯的東西會一路綠燈。分離才有真 feedback。 |
| 「test 跟我實作對不上，改一下 test 就過了」 | 改 test 遷就 impl 正是要防的事。除非 referee 裁定 test 錯，否則改 impl。 |
| 「Refactor 改一改，順手調個 test」 | 簡化需要改 test = 你改了行為，不是重構。停下，這要走衝突仲裁或回 plan。 |
| 「全部寫完一次 commit」 | 分段 commit 才有 Save Point；一次大 commit 失敗時無處可 revert。 |
| 「每個 slice 都先寫個紅燈測試比較保險」 | 紅燈是**高風險邏輯**的實作手法，不是所有 slice 的固定控制面。plan 指定 `existing-test` / `static` / `smoke` 就照著做——硬補一條紅燈，守的是既有測試已經守住的東西。 |
| 「既有測試好像不太夠，我順手加一條」 | 「不太夠」要具體：缺哪個觀察點？寫得出來就回 plan 補 `new_test_reason` 再加（living plan）；寫不出來就是不需要。現場偷加會被 footprint 對帳擋在 PR 前。 |
| 「順手把週邊也重構乾淨」 | Refactor 的範圍是**這個 slice 動到的 code**、且要對得上一個具名異味。順手擴張會讓 diff 超出 budget、也讓 reviewer 分不清哪些是這次的行為改動。 |

## Red Flags

- **在主 checkout（非 worktree）直接 `checkout -b` 或改 code**，或拿 session／harness 的「work in place」「略過自動進 worktree」設定當藉口跳過 Step 0 worktree gate（違反規則 9；已踩過——做了一輪才被使用者抓）。
- 主線自己寫 test 或 impl（沒派 agent）。
- **沒讀 evidence portfolio 就開工**，或所有 slice 一律套完整 TDD（`primary_evidence` 是 `existing-test` / `static` / `smoke` 的也硬派 test-author 寫紅燈）。
- **test-author 回 `NO_NEW_TEST_REQUIRED`，主線卻硬要它「再想想、寫一條」** —— 那個回報是合法出口，處置是跑既有證據 + 回 plan 標 `new_test=false`。
- **build 現場加測試卻沒回 plan 補 `new_test_reason`**（living plan 沒同步，footprint 對帳會在 PR 前擋下）。
- **Refactor 對不到任何具名 code smell 卻照做**，或範圍擴張到這個 slice 沒動到的 code。
- test-author 的 context 裡出現了 implementation。
- impl-author 改了 test 來轉綠。
- Refactor 階段測試行為被改動。
- build 做到一半沒紅綠軌跡就 commit。
- **平行派多個寫檔 agent 卻共用同一工作目錄**（競態）；或**採信 subagent 自報的綠**而沒在合併態重跑 gate。

## Verification

- [ ] **Step 0 worktree gate 過**：code 在 `.claude/worktrees/<slug>` worktree 裡改（`git rev-parse --show-toplevel` 指向該 worktree），**不在主 checkout `checkout -b`**；worktree 已裝依賴；沒拿 session「work in place」設定當藉口跳過（規則 9）。
- [ ] **每個 slice 都先讀 evidence portfolio 選路徑**（步驟 A），路徑選擇與 `primary_evidence` 一致；低風險 slice 沒有被硬套完整 TDD。
- [ ] 走 TDD / contract / acceptance 路徑的 slice 有「Red 確認 → Green 確認」軌跡記在 `stages/03-build.md`；走既有證據 / static / smoke 路徑的有「跑了哪一份既有證據、結果如何」的軌跡。
- [ ] `NO_NEW_TEST_REQUIRED` 若出現，已跑指名的既有證據確認它守得住，並回 `stages/02-plan.md` 標 `new_test=false`（living plan）。
- [ ] build 期間新增的測試**都有 plan 裡的 `new_test_reason`**；實際 footprint 明顯超出 budget 的 slice 已補 `budget_overrun_reason`。
- [ ] Red/Green 確認點是跑 quality-gate 讀**精簡摘要**（不收完整 `pnpm typecheck && lint && test` 輸出）；派 fixer 只帶結構化 failures（見〈quality-gate 整合〉）。
- [ ] test-author / impl-author prompt 已含 `references/shared/runtime/context-diet.md` 絕對路徑；quality-gate 以外的原始輸出守其紀律（紅綠不對稱／截斷附落盤路徑）。
- [ ] impl-author 寫的 code 達到**合併標準**（clean code / clean architecture / 安全 / 重用），不是留給 verify 才抓（shift-left）；每次派工都注入了 `minimalism-ladder.md` 的絕對路徑（orchestrator 確定性帶上）。
- [ ] test 由 test-author 在無 impl context 下產出；impl 由 impl-author 產出且未改 test。
- [ ] author 回報符合其〈輸出協定〉（sentinel 起頭、key:value、無 code 全文）；`deviation` 非 none 已同步 living plan；`BLOCKED` 依來源路由（test-author→安全停、impl-author→仲裁）。
- [ ] 若有平行 fan-out 寫檔 agent：各自隔離 worktree，且合併後**主線在合併態跑 quality-gate（讀精簡摘要、確認預期 gate 皆 `passed` 非 `not-run`）確認綠**（沒採信各 agent 自報）。
- [ ] Refactor **只在對得到具名 code smell 時才做**、範圍限於該 slice 動到的 code，且做完測試行為未變（仍綠）。
- [ ] 分段 commit（繁中）對應各 Save Point。
- [ ] `stages/03-build.md` 有 Change Summaries 三段式。
- [ ] 實作若偏離 plan，`stages/02-plan.md` 已回去同步更新（as-built），未留到最後。
- [ ] 依 `references/shared/docs/docs-policy.md` 判斷是否需補 `docs/<topic>.md`（+ `docs/README.md` 索引）；命中就寫。
- [ ] build 做完寫 `stages/03-build.md` 並進 verify（無危險 / 卡關才停），沒用純文字問「要不要進 verify」。
