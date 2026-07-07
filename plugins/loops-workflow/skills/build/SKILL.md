---
name: build
user-invocable: false
description: Implements each planned task into working, test-protected code. Use when starting the build stage of a loops-workflow run, or when a confirmed plan is ready to be coded task by task.
---

# build — 執行（紅綠分離 + Refactor）

## Overview

`build` 逐任務跑 **紅 → 綠 → 重構**，並用**兩個分離的 agent** 防止測試遷就實作：`test-author` 只看需求寫 failing test、看不到實作（**`operation=refactor` 例外**：寫的是釘現狀的全綠 characterization test、無紅燈相，見步驟 1–2）；`impl-author` 只負責轉綠、不准改 test。主線當編排者，不自己下海寫 test 或 impl，只接收紅綠結果。

> 為何不偏：feedback（test）與被測對象（impl）由不同 agent、在不同 context 產出 —— 寫測試的沒看過實作，就不會把測試寫成遷就實作；寫實作的不能改測試，就不能讓測試將就自己。

> **寫到合併標準（shift-left）**：impl-author 寫的當下就照 verify 會查的同一套品質標準寫（clean code / clean architecture / 安全 / 重用 / 設計模式）—— 標準在 build 與 verify 是**同一份 reference、兩處套用**，build 主動寫到位、verify 獨立複查抓盲點（見 `AGENTS.md` 規則 11）。寫對的成本遠低於寫錯被 verify 退回重修。

## When to Use

**Use when**：`02-plan.md` 已拍板、要逐任務實作。

**NOT for**：
- 計畫還沒拍板 —— 回 plan。
- 改完要驗收 —— 去 verify。

> **動 code 前先確認在 worktree 裡**：在獨立 git worktree（自帶 branch）寫，不在使用者主 checkout 直接改（dispatch 對 issue/fix 已開；純設計迴圈走到這裡才開 —— `git worktree add .claude/worktrees/<slug> -b <slug> <base>`，branch / worktree 名 = slug，不加 type 前綴）。見 `AGENTS.md` 規則 9。

> **step-0 迴圈外置（#99，opt-in）**：`LOOPS_LOOP_DRIVER=1` 且 auto 語意成立（loop.md `推進模式：auto` 或 `LOOPS_AUTO=1`）時，進 build 先把 `02-plan.md` 任務拆解一次性解析寫入 `$LOOPS_ROOT/.loops/<slug>/state.json`（schema/欄位語意見 `references/journaling.md` loop-driver 條目；**既有 state 不歸零**——`session` 更新為當前、`tasks[].status` 依 03-build 軌跡/quality-gate 推導保留、iteration 歸 1）。之後每任務完成（step 7 Save Point 後）把該任務 `status` 翻 `done`（atomic、單欄——cursor 由 hook 推導、不另記 index）；**build 全完進 verify 前主線刪 state.json**（正常收攤；loop-driver 完工路徑的刪除＝同 session crash 兜底）。closed 且未設 LOOPS_AUTO＝不建 state、行為完全不變。跨 session 孤兒 state 惰性無害（永不匹配），同 slug 重跑接管或手刪。

> **平行 build 一律 worktree 隔離**：build 預設**逐任務序列**跑紅綠（同一時間只有一個 writer，在 loop worktree 裡）。若為加速**平行派多個會寫檔的 agent**（跨獨立任務 / DAG 同層），**每個平行 writer 必須各自一個隔離 worktree**（`isolation: 'worktree'`）—— 共用同一工作目錄會競態，且各 agent 自報的「綠」是不同時間點的半成品態、**不可採信**（已踩過）。平行完成後合併回主 worktree，**由主線在合併態跑 quality-gate（見下方〈quality-gate 整合〉、只讀精簡摘要，確認預期 gate 皆 `passed`、非 `not-run`）才算數** —— 不採信各 agent 自報。見 `AGENTS.md` 規則 9。

> **quality-gate 整合（跑測試只讀摘要，省 token）**：build 的三個「主線跑測試」確認點（step 2 確認 Red / step 4 確認 Green / 平行合併 re-run）**不收完整 `pnpm typecheck && lint && test` 輸出**（中大型套件單次可灌 >100k token），改跑 quality-gate 腳本只讀**精簡摘要**：
> - 調用：`node {loops-workflow-plugin-root}/scripts/loops-quality-gate.mjs --cwd <被驗的目標專案>` —— plugin root 從本 skill 的 base directory 解析（同 reference 絕對路徑機制）；`--cwd` 是**目標專案、不是 plugin**。綠燈＝單行 `✓`、紅燈＝counts + 結構化 failures 清單。**但 `✓`（`ok:true`）也涵蓋 gate 被 graceful skip** —— 摘要會逐 gate 標 `passed`/`not-run`/`failed`/`errored`。**Green 成立的條件是「預期要跑的 gate 顯示 `passed`」，不是只看 `✓`**：某預期 gate 落 `not-run`/`status=partial` = 該 gate **未驗證、非綠**（見下 fallback）。
> - **派 fixer（impl-author / test-author）修紅燈時，prompt 只帶 quality-gate 的結構化 failures（`file:line [code|ruleId] message`，契約見 `references/quality-gate-schema.md`），不附原始 stdout**（要逐欄程式化才加 `--json`）。
> - **fallback / 漏偵測**：gate **全** `not-run`（無 `.loops/gate.config.json` 又偵測不到任何工具）→ 回退到該專案既有的驗證指令並建議補 config。**任一預期 gate 落 `not-run`**（如缺 `tsconfig.json` / lint script 沒被偵測到、但 test 綠）→ **不可當綠**，提示在 `.loops/gate.config.json` 指明該 gate 指令（見 schema）。
> - **務實邊界**：目標是把確認點輸出**從 ~100k 壓到 ~2k**，不是「消除 agent 看輸出」（Claude Code `Workflow` 沙箱不能 spawn 測試 → 由主線 Bash 跑腳本讀摘要）。
> - **quality-gate 以外的原始輸出**（手跑單套測試、建置、除錯命令）依 `references/context-diet.md`（紅綠不對稱＋截斷必附落盤路徑＋skipped 必列）——quality-gate 契約不變、context-diet 補它未覆蓋的路徑。
> - **per-task scoped、完工全量一次（成本，規則 10「便宜的先·貴的後」）**：逐任務的 Red/Green 確認點**只 scope 到本任務剛改動的 test/impl 檔** —— 跑 `loops-quality-gate.mjs ... --scope <本任務改動的 test 檔,impl 檔>`（**test 與 lint 只跑這些路徑；typecheck 一律全專案跑、不吃 scope**）。省的是每任務都重跑整包測試的浪費。**但全部任務做完、進 verify 前，主線務必再跑一次不帶 `--scope` 的全量 gate**（typecheck+lint+test 全跑）、確認全綠才進 verify —— **scoped 只證「剛寫的這塊過」，全量才證「沒打破別處（波及面）」**。**完工前這趟全量不可省**（省了＝回歸漏到 verify / merge，違規則 10「偷工減料重做最貴」與 iterate「綠燈證不了波及面安全」）。**平行 fan-out 合併態的 re-run 一律全量、不 scope**。`operation=refactor` 的 characterization 全綠確認同樣可 scoped（釘的是本次動到的現狀），完工全量不變。

## Process（每個任務跑一遍紅 → 綠 → 重構 7 步）

1. **派 `test-author`**：只給它需求 / 契約 + TDD 品質判準，**它的 context 不含 implementation**；把 `references/test-rubric.md` 的**絕對路徑**寫進其 prompt（分層測試 unit/integration/smoke/e2e、real-not-mock、async 等真完成、data-layer 覆蓋清單；subagent 用相對路徑讀不到）。**派之前先讀 `loop.md` 的 `operation` 性質，依 `references/operation-first-move.md` 把對應該性質的「紅燈第一步規則」併入 test-author 的 prompt**（精確措辭以該檔為準、**不在此重抄**——避免漂移）；**`loop.md` 無 `operation` 欄（升級前的舊 loop / 直接 `/goal` 起未補寫 / fix 型未經 goal）→ 套 fail-safe 視為 `new-feature`（標準 TDD）**。此規則只影響紅燈起手式，不改紅綠分離、不破壞「test-author 不見 impl」。另把 `references/context-diet.md` 的**絕對路徑**一併寫進 prompt（讀既有測試檔守 stale-Read／大檔範圍讀）；issue / DoD 有 GWT 場景時，`references/bdd-scenarios.md` 的**絕對路徑**也一併帶上（test-author 依場景寫測試、測試名帶場景 ID）。它依其〈輸出協定〉回報（`TESTS_READY` sentinel＋檔案路徑＋案例↔需求對映；**測試 code 不貼回**——寫進檔案、主線跑 gate 讀檔；`operation=refactor` 例外時 `expect_red`＝N/A 變體，見步驟 2）；回報 `BLOCKED`（reason：需求矛盾/缺前置）→ **走規則 2 安全停問使用者或回 goal/plan，非 referee**（referee 只裁 test-vs-impl 爭議）。
2. **主線跑 quality-gate → 確認 Red**（讀精簡摘要：摘要應顯示目標測試失敗、且失敗原因正確；**不收完整 test 輸出**。見上〈quality-gate 整合〉）。**例外 `operation=refactor`**：refactor 的 characterization test 釘現狀行為、**本來就全綠、無紅燈相**——此時不期待 Red，改確認「既有測試 + 新補的 characterization test **全綠**」才往下（refactor 的紅綠分離是「行為不變仍綠」，以全綠取代紅→綠，其餘三性質仍走標準 Red→Green）。
3. **派 `impl-author`**：給它 test + plan，寫**最小範圍**實作轉綠、**不准改 test**；把 `references/clean-code.md`、`references/clean-architecture.md`、`references/security-checklist.md`、`references/reuse-check.md`、`references/context-diet.md`（自跑測試／除錯的輸出瘦身＋stale-Read）的**絕對路徑**寫進其 prompt —— 要求**綠燈當下就照合併標準寫**：clean code（命名 / 小函式 / guard clause / 顯式錯誤 / 型別契約）+ clean architecture（依賴向內 / port + 注入 / 落點對齊）+ **安全**（輸入邊界驗證 / authn-authz + ownership / SQL 參數化 / 敏感資料不進回應·log / 不藏密鑰）+ **重用**（寫前先確認沒有既有的）—— 不是先寫爛 / 寫不安全再靠 verify 抓（shift-left，見 AGENTS.md 規則 11）。**修紅燈時 prompt 只帶 quality-gate 的結構化 failures（不附原始 stdout，見上〈quality-gate 整合〉）。** 它依其〈輸出協定〉回報（`IMPL_COMPLETE` sentinel；code 不貼回；`deviation` 欄非 none → 主線同步 living plan，規則 10）。 **model 動態（成本，見 `references/model-effort-policy.md`）**：impl-author 預設 frontmatter `sonnet`。**遇 L / XL 尺寸、跨子系統、或新架構接縫的任務**（見 `references/task-template.md` 尺寸階梯；XL 照理應在 plan 拆掉、此為兜底）時，該次 Task 派工以 `model: opus` 覆寫；一般任務維持 sonnet。referee 已由 frontmatter opus，不需覆寫。effort 無法 per-dispatch。
4. **主線跑 quality-gate → 確認 Green**（讀綠燈單行摘要、**不收完整輸出**；Green 成立＝**預期要跑的 gate 顯示 `passed`**，不是只看 `✓` —— 某預期 gate 落 `not-run`/`status=partial` 是「未驗證」不是綠，按〈quality-gate 整合〉的 fallback / 漏偵測處理）。**per-task 帶 `--scope <本任務改動的 test,impl 檔>`（test+lint 只驗這些、typecheck 仍全跑）省掉每任務重跑整包；完工前另跑一次全量、見〈quality-gate 整合〉。**
5. **Refactor**（綠燈後、test 保護下整理結構不改行為）：派 impl-author 時把 `references/refactoring.md` 與 `references/code-simplification.md` 的**絕對路徑**寫進其 prompt（subagent 用相對路徑讀不到，見 AGENTS.md〈參考檔路徑解析〉）—— **`refactoring`：先對到一個具名 code smell 才動、用具名手法（Extract Function / Replace Conditional with Polymorphism…）小步改、設計模式對症才引入**；**`code-simplification`：Chesterton's Fence、過度簡化四陷阱、紅旗「簡化若需要改 test 才能過 = 你改的是行為不是結構，停下」**。
6. **衝突仲裁**：若 impl-author 主張 test 與需求不符（其〈輸出協定〉的 `BLOCKED`＋`dispute: <test 檔:行> — <理由>`）→ 回報主線，主線依 `00-goal.md` 完工定義裁決；必要時派 `referee` 判是 test 錯還是 impl 錯。
7. **Save Point**：測試綠 → 分段 commit（繁中、每個邏輯單位一筆，規範見 `references/commit-spec.md`）；測試紅且修不動 → revert 到上個 Save Point。寫 `03-build.md`（Change Summaries 三段式，見 `references/change-summaries.md`）。

**偏離 plan 就回去改**：實作若發現需偏離 `02-plan.md`（某決策要變、某任務要重拆）→ **先回去更新 `02-plan.md`（living plan）並同步已 post 的版本**，再續做；偏離大到動搖方案就回 `plan` gate 重新拍板。不要讓 code 與 plan 各走各的、留到最後才對。

**內部紅綠不每單位停**；整個 build 做完**先跑一次不帶 `--scope` 的全量 gate（typecheck+lint+test 全綠）**——這趟證「沒打破別處 / 波及面」，不可省——再寫 `03-build.md` + 摘要，**直接進 verify**（routine 轉場不問）。只有碰到危險 / 不可逆操作、或測試怎樣都弄不綠時才停下用 `AskUserQuestion` 問。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「我直接自己寫 test 和 impl 比較快」 | 同一個腦袋寫兩邊，test 會不自覺遷就 impl，錯的東西會一路綠燈。分離才有真 feedback。 |
| 「test 跟我實作對不上，改一下 test 就過了」 | 改 test 遷就 impl 正是要防的事。除非 referee 裁定 test 錯，否則改 impl。 |
| 「Refactor 改一改，順手調個 test」 | 簡化需要改 test = 你改了行為，不是重構。停下，這要走衝突仲裁或回 plan。 |
| 「全部寫完一次 commit」 | 分段 commit 才有 Save Point；一次大 commit 失敗時無處可 revert。 |

## Red Flags

- 主線自己寫 test 或 impl（沒派 agent）。
- test-author 的 context 裡出現了 implementation。
- impl-author 改了 test 來轉綠。
- Refactor 階段測試行為被改動。
- build 做到一半沒紅綠軌跡就 commit。
- **平行派多個寫檔 agent 卻共用同一工作目錄**（競態）；或**採信 subagent 自報的綠**而沒在合併態重跑 gate。
- **省掉完工前的全量 gate**（只靠 per-task `--scope` scoped 就進 verify）—— scoped 證不了波及面，回歸會漏到 verify / merge。

## Verification

- [ ] 每個任務都有「Red 確認 → Green 確認」軌跡記在 `03-build.md`。
- [ ] Red/Green 確認點是跑 quality-gate 讀**精簡摘要**（不收完整 `pnpm typecheck && lint && test` 輸出）；派 fixer 只帶結構化 failures（見〈quality-gate 整合〉）。
- [ ] **per-task 確認點帶 `--scope`**（test+lint 只驗本任務改動檔、typecheck 全跑）；且 **build 全部任務做完、進 verify 前已跑一次不帶 `--scope` 的全量 gate 確認全綠**（完工全量不可省、平行合併態 re-run 也全量）。
- [ ] test-author / impl-author prompt 已含 `references/context-diet.md` 絕對路徑；quality-gate 以外的原始輸出守其紀律（紅綠不對稱／截斷附落盤路徑）。
- [ ] impl-author 寫的 code 達到**合併標準**（clean code / clean architecture / 安全 / 重用），不是留給 verify 才抓（shift-left）。
- [ ] test 由 test-author 在無 impl context 下產出；impl 由 impl-author 產出且未改 test。
- [ ] author 回報符合其〈輸出協定〉（sentinel 起頭、key:value、無 code 全文）；`deviation` 非 none 已同步 living plan；`BLOCKED` 依來源路由（test-author→安全停、impl-author→仲裁）。
- [ ] 若有平行 fan-out 寫檔 agent：各自隔離 worktree，且合併後**主線在合併態跑 quality-gate（讀精簡摘要、確認預期 gate 皆 `passed` 非 `not-run`）確認綠**（沒採信各 agent 自報）。
- [ ] Refactor 後測試行為未變（仍綠）。
- [ ] 分段 commit（繁中）對應各 Save Point。
- [ ] `03-build.md` 有 Change Summaries 三段式。
- [ ] 實作若偏離 plan，`02-plan.md` 已回去同步更新（as-built），未留到最後。
- [ ] 依 `references/docs-policy.md` 判斷是否需補 `docs/<topic>.md`（+ `docs/README.md` 索引）；命中就寫。
- [ ] build 做完寫 `03-build.md` 並進 verify（無危險 / 卡關才停），沒用純文字問「要不要進 verify」。
