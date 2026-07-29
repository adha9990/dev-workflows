# loops-workflow — 操作規則與指令對照

> 五階段閉環開發工作流：`define → plan → build → verify → finalize`，每個階段後面接一個**可停可交接的 checkpoint**（H1–H5）。`dispatch` 判入口與 `stop_after`（不是階段）；`Goal Contract`／`Explore`／`Decision Queue` 是**跨階段能力**（不是階段）。階段間 human gate，`.loops/<slug>/` 當記憶體。
>
> 這份檔案是 plugin 的「憲法層」：以下 Operating Rules 是**全程不變的共用紀律**，七個階段 skill 預設遵守、不各自重述。任一 skill 與這裡衝突時，以這裡為準。

---

## 1. 設計取向（一句話）

把一次開發當成一個**閉環**：每階段做一件事、寫進 `.loops/` 交給下一階段，**只在真正要選的決策點停下讓人把關**（見規則 2，routine 轉場不問）。發散工作（探索、驗證）派多個 subagent 各做不同子任務、收斂工作回單一主線；build 用紅綠分離防測試遷就實作、verify 用多 reviewer fan-out 擴大覆蓋。

這個閉環的座標（明寫，免得只是「跑階段」）：

- **類型 = Closed Loop（預設）**：人類在框架內把關、隔離環境（worktree）、清晰標準、持續驗證 —— 適合大多數實際產品工作；opt-in `auto` 收斂成 Open Loop（核准一次後連跑，只剩安全停）。
- **規模 = 單一迴圈（預設）**：一個主線跑完整條；解法空間寬 / 長任務時 opt-in **Fleet 編隊**（plan·explore·verify 派多 subagent 並行各做子任務再收斂，見 `references/shared/runtime/fleet.md`）。
- **目標的脈絡 = VISION / ARCHITECTURE / RULES**：VISION＝issue / `00-goal.md` 完工定義；ARCHITECTURE＝`02-plan.md` 設計書（§0–§9）+ repo 既有架構（onboarding 文檔優先讀）；RULES＝本檔 + 專案 `AGENTS.md` / `CLAUDE.md`。三者就是每個 subagent 該拿到、且只拿到的脈絡。
- **方法論分工（各擁一個責任、不重複；使用者不選方法論，由 predicate 自動套）**：canonical 流程是 **Feature-oriented SDD 主幹 ＋ ATDD evidence portfolio ＋ 風險式選擇性 TDD**。每張 issue 是一個功能；流程先把它收斂成少量 `behavior_id`，再為每個 behavior 指定**一份**足以證明它的主證據。其餘方法論只在**機械可判的 predicate 命中**時啟用：

  | 方法 | 唯一責任 | 啟用條件 |
  |---|---|---|
  | **SDD** | 主幹：功能、行為、scope、設計、證據與完成條件 | 所有功能工作 |
  | **BDD** | 表達重要且可觀察的行為（`references/stages/bdd-scenarios.md`） | 行為非直觀、跨角色或有重要例外 |
  | **ATDD** | 為每個 behavior 指定 primary evidence（`references/stages/evidence-portfolio.md`） | 所有功能工作 |
  | **TDD** | 高風險邏輯的 test-first 實作（build 紅綠 + `references/shared/quality/test-rubric.md`） | bug / 核心 invariant / 演算法 / 安全 / 並行 / 資料一致性 |
  | **DDD** | 領域語言、invariant、aggregate、bounded context（`references/shared/quality/clean-architecture.md`） | `domain_complexity=true` |
  | **Contract-First** | API、event、schema、跨模組 boundary（`references/shared/quality/contract-spec.md`） | `external_or_cross_module_contract=true` |

  predicate 的唯一定義處是 **`references/stages/risk-map.md`**（explore 固定產出 reuse map / impact surface / risk map 三張表）。**FDD 不另加一層 ceremony** —— issue 已是 feature 單位，plan 用 **vertical behavior slice**。產物鏈：`issue → behavior 收斂(goal) → risk map(explore) → 設計 + evidence portfolio + change budget(plan) → 依證據型別施工(build) → 逐 behavior 回核(verify)`。
  - **右尺寸鐵則**：嚴格度由 **predicate ＋ operation（`references/stages/operation-first-move.md`）× size（XS–XL）** 決定，不由感覺決定——predicate 未命中就**不建** glossary / aggregate / port / adapter / 完整 contract 規格，也不固定派滿 reviewer。**小任務不加 ceremony**（呼應規則 10 carve-out：砍非必要 ceremony、不砍 mandatory gate）。**上面這幾個 predicate 縮的都是「要不要加派」；每條 loop 都要付的固定 ceremony 由規則 25 的投入檔位（`references/stages/effort-profile.md`）縮**——兩層正交、各管各的。各階段 skill 依此框定、各不重複框定細節、以一句指回本節。

---

## 2. Operating Rules（全程不變的紀律）

1. **對外敘述一律繁體中文**；code identifier、檔案路徑、指令、skill 名保留英文。
2. **推進：階段間不問「要不要進下一階段」**。階段做完把產出寫進 `.loops/` + chat 摘要，**直接往下**，**不要**每進一個階段就停下問使用者「要不要繼續」。使用者隨時可插話喊停 / 改方向。
   - **只在「真正要使用者選」時停、開一個決策點**（選項標推薦，依 `references/shared/delivery/comment-policy.md`；決策點的表述形狀與平台映射依 `references/shared/delivery/interaction-adapter.md`）：explore 選方法 / plan 拍板方案（含套件選型）/ iterate 完工 or 回哪階段；以及 goal（含**內容型交付的載體**）/ plan 冒出的**具體 scope / 取捨決策**（有真選擇才問，沒有就往下）。
   - **安全停（一定停 + 問）**：dispatch 分類模糊 / 危險不可逆操作 / verify 出 P0 / 規格講不清。
   - **絕不**用純文字「請回覆 yes / 要我接著進 X 嗎」要使用者打字 —— 要嘛開一個決策點（依 `references/shared/delivery/interaction-adapter.md`），要嘛直接往下。
   - **auto 模式**（環境變數 `LOOPS_AUTO=1` 開啟）：連上面的決策也用推薦選項自動帶過，只剩安全停（見 `references/shared/runtime/auto-mode.md`）。
3. **`.loops/<slug>/` 是階段間記憶體**。每階段把結論寫成對應 markdown（`00-goal.md` / `01-explore.md` … 每階段一個），下一階段只讀精煉版、不重讀原始素材。任一階段被獨立呼叫時，**先讀 `loop.md`** 認領狀態。**進入一個階段時更新 `loop.md` 的「當前階段」+ append 一筆 Journal**（供 progress / resume）；**完工時把「當前階段」設為「完工」**。每份檔保持 **< 2000 行**（context window ≠ attention budget）。
4. **模糊就 surface，不要猜**。需求 / 分類 / 方案不清楚時停下來問，不自行假設往下做。
5. **Metric-Honesty**：任何「效能 / 覆蓋率 / 通過」宣稱，沒有實際跑出來就標 `not measured`，不得憑感覺寫數字。狀態類操作結果（merge SHA / CI 結論 / mergeable / 測試數）同樣適用：只能引用**實際跑過的單一乾淨指令**回傳的值，工具沒回傳就不得敘述。寧可回報『查不到 / 卡住』並請人介入，不可補一個看起來合理的值。
6. **重用優先、不以 MVP、照 clean code / clean architecture 寫**：動手前先搜既有實作、避免重複造輪子（稍異 ≠ 另造，優先參數化既有方法，見 `references/shared/quality/reuse-check.md`）；in-scope 實作不以 MVP，照最高標準做（對可預見的規模退化預先用對演算法與結構）；**寫的當下就照 clean code（`references/shared/quality/clean-code.md`：命名 / 小函式 / guard clause / 顯式錯誤 / 型別契約）+ clean architecture（`references/shared/quality/clean-architecture.md`：依賴向內 / port + 注入 / 落點對齊）標準**，不是先寫爛再靠 refactor 救（refactor 精修見 `references/shared/quality/code-simplification.md`；異味 → 具名手法 → 設計模式時機見 `references/shared/quality/refactoring.md`）。
7. **文件紀律**：完工前依 `references/shared/docs/docs-policy.md` 判斷 —— 新子系統 / 跨切面 / 不直觀設計寫 `docs/<topic>.md`（+ 維護 `docs/README.md` 索引）；慣例 / 規則改變才更新 `AGENTS.md` · `CLAUDE.md`；小功能不塞 docs。
8. **對外溝通**：所有面向人的書面（決策點提問〔依 `references/shared/delivery/interaction-adapter.md`〕/ issue · PR 回覆 / 驗收報告 / 端決策）依 `references/shared/delivery/comment-policy.md` —— 繁中白話、雙視角紀錄、決策點選項標推薦、對外內容先寫**暫存 tmp 草稿**校稿（不進專案 / 不進版控）+ **送出後刪 tmp**、不寫客套。
9. **code 變更在 git worktree 裡做**（隔離工作目錄、不擾動使用者主 checkout）：會動 code 的迴圈（issue / fix）在 loop 啟動時開一個**獨立 worktree（自帶 branch）**、整條 loop 在裡面跑 —— **不在主 checkout 直接 `checkout -b`**。⚠️ **session／harness 層的「work in place」「skip 環境自動進 worktree」等設定不豁免本條**：那些管的是「整個 session 要不要隔離進 worktree」，跟本條「為 loop 的 code 開一個獨立 worktree、session 仍留主 repo」是**不同層、而且相容**（session 留主 repo ＋ worktree 只放 code，正是本條要的樣子）；把它們當成「這條可以不做」的藉口 = 繞過本規則（已踩過）。**這條「主 checkout 不 `checkout -b` loop branch」已由 `hooks/worktree-guard.mjs` 機械化**（deny 型攔截、預設開，偵測到對已建 loop 的 `checkout -b`／`switch -c` 在主 checkout 執行即擋、導向 `git worktree add`；逃生口 `LOOPS_WORKTREE_GUARD=0`）。用環境提供的 worktree 進入能力，或 `git worktree add .claude/worktrees/<slug> -b <slug> <base>`。**branch / worktree 名 = loop slug `<issue#>-<slug>`（例 `137-trash-delete-permanent`），不加 `fix/`/`feat/` 等 type 前綴**；修正型（PR 已存在）把該 PR branch checkout 進 worktree。純設計 / 研究（不動 code）免開、走到 build 再開。完工 merge / close 後 `git worktree remove` 清掉。**`.loops/<slug>/` 一律留在主 repo（session 起點 / 主 checkout）、絕不放進 worktree** —— worktree 只放 code。**落點必須確定性錨定，不靠「記得用絕對路徑」**：任何階段（dispatch 建立 / resume 接續 / build·verify 寫檔 / 任何 append `loop.md`）在動 `.loops/` 前，先算出主 worktree 根 —— `LOOPS_ROOT="$(git worktree list --porcelain | sed -n 's/^worktree //p' | head -1)"`（第一筆恆為主 worktree、不隨 cwd 改變），**一律讀寫 `$LOOPS_ROOT/.loops/<slug>/` 的絕對路徑**；**即使 cwd 已被環境的 worktree 進入能力切進 worktree，也用這個絕對路徑寫回主 repo，嚴禁在 `.claude/worktrees/*/` 底下建立或寫入任何 `.loops/`**（違反就是分裂 loop 記憶體、正是「有些 .loops 在 worktree、有些在 master」的根因）。原因：未追蹤的 `.loops/` 若放 worktree，會在 worktree 被 `git clean` / refresh（`baseRef: fresh`）/ `remove` 時被**一起刪掉、毀掉 audit trail**（已踩過）；放主 repo 才不被 worktree 操作波及，主 repo 的 session 也直接讀得到。progress renderer（`scripts/loops-scan.mjs`）／SessionStart hook 仍會掃 `.claude/worktrees/*/.loops/` —— 那只是**向後相容的保險網（撿舊的漂移殘留）、不是支援的落點**，新迴圈一律錨定主 repo。本條「嚴禁寫入」已由 `hooks/loops-path-guard.mjs` 機械化（deny 型攔截、預設開，見 `references/shared/runtime/journaling.md`〈介入 hook〉）。
   - **平行寫檔一律隔離 worktree**：若同一階段（尤其 build）**同時派多個會寫檔的 subagent**（跨任務 / 跨 DAG 層平行 fan-out），**每個平行 writer 各跑在自己的隔離 worktree**（`isolation: 'worktree'`，或各自 `git worktree add`），**不可共用同一工作目錄** —— 共用會讓它們的 `pnpm` / 檔案寫入交錯競態，且各自自報的「綠」反映的是不同時間點的半成品態、**不可採信**（已踩過）。平行子任務完成後**合併回 loop 主 worktree，由主線在合併態上重跑完整 gate（`typecheck`/`lint`/`test`）才算數**，不採信任一 subagent 的自報結果。read-only subagent（verify reviewer / explore 掃描）不寫檔，無此限制。
10. **成本意識：迴圈很貴，要設計成「負擔得起」**。一條迴圈動輒 50–200K token、回環三輪 500K–2M —— Loop Engineering 的成敗在**負擔得起**，不是能不能跑。所以全程貫徹：
    - **高上下文效率**：下一階段只讀**精煉版**（`.loops/` 的 `0N-*.md`）、不重讀原始素材；每份 < 2000 行；subagent 只塞它**需要的那段**脈絡（VISION/ARCHITECTURE/RULES 對應段 + 該軸的絕對路徑 reference），不倒整包。
    - **便宜的先、貴的後且要 gate**：explore 內部夠就不外搜、外搜先便宜 `WebSearch` 再 gate 升級 deep-research；verify 條件式 reviewer 只在觸及領域 / 專案宣告該條件時才加派；Fleet / deep-research / 真機驗證這些貴動作預設不開、要才開。**這條只管「資訊蒐集與驗證動作」的執行順序，不是方案取捨準則**（方案怎麼選見下方「成本意識不外溢到方案 / 架構取捨」）。
    - **model / effort 分層（見 `references/shared/runtime/model-effort-policy.md`，tier 定義見 `references/capability-registry.json`）**：subagent 依角色靜態選 tier + effort（多為 `broad-review`／`implementation` tier·medium；窄任務 `fast-readonly` tier·low；`referee` tier·high）——不跟 session 跑 xhigh；高風險時 verify/build 派工才 per-dispatch 拉高到 `referee` tier 的 model（effort 無法 per-dispatch）。
    - **不重複勞動**：reuse 優先（不重造輪子）、living plan（偏離回去改、不留到最後重做）、修完一定再 verify（一次驗到位、不靠人來回）。
    - **fail-fast 不空轉**：停止條件**看收斂**（同條 finding 復現 / 修出新問題就 escalate 換手法；findings 沒變少先歸因「驗證手段變深」還是「修壞了」）、回環圈數是**軟上限＝回報檢查點**（**未修的 P0 不得因圈數收圈**〔機械下界〕，已無 P0、只剩 P1/P2/P3 才當停損點交使用者拍板——**P1 不再機械擋收圈，但仍照 actionable 全修的紀律修，帶著它收圈要使用者拍板 + 留痕**；auto 無人監管另設**硬性總圈數天花板** `LOOPS_AUTO_MAX_ROUNDS` 預設 6，撞頂 escalate 停下交人、attended 不受影響——見 `references/shared/runtime/auto-mode.md`；「未清 P0 不准收圈」另由 pr-gate 閘⑥ 機械化）、**不過早放棄也不無限繞**。
    - **成本意識不外溢到方案 / 架構取捨**：推薦與拍板以**長期正確性與風險消除**為先，不以實作代價最小為預設傾向；「代價小」只能在**同等正確**的方案之間當 tie-breaker，不能是取捨主軸。「便宜但留債」的選項（退回本該完成的遷移、保留新舊雙路徑、暫留 shim）必須明標它埋的債，**不得預設標推薦（除非使用者已明示接受該債）**。留債的判定**不靠自我歸類——用客觀判準逐選項過（事實問題，不是「我覺得算不算留債」的歸類題）**：選項只要「**採納後，某個改動前正常運作的行為會失效或變差（且不是 issue / 驗收標準本來就要求改變的），而該選項不打算修復它**」，就是留債選項（**行為債**）——不論被說成「務實」「先擋住最糟的」「小步前進」、不論改動多小；把留債包裝成止血（「至少擋掉最糟的 bug」＝部分處理＝剩下的不修）正是踩過的失敗形狀。「之後再修／開 follow-up」不算已修復——判準看**這次改動**是否真的處理，不看是否承諾未來處理。此判準**新增**行為債一類觸發，前列遷移 / 雙路徑 / shim 的**結構債**列舉不變。例外邊界（防判準被誤用成「什麼都不能推薦」）：issue / 驗收標準本來就要求改變或移除的行為不算回歸；使用者已明示接受的債照前述可推薦。實例：稽核發現半途的遷移（新舊雙路徑並存）——「撤回」與「完成遷移」都能消除雙路徑，錯不在終態、在用「哪邊省工」決定走哪個方向；遷移方向本身正確時，正確解是完成遷移，即使工程量大得多。另一實例：改動會讓某個既有功能靜默失效，「只擋更糟的 bug、功能失效就接受」的選項被包裝成務實——它就是行為債，不得標推薦；該推薦的是完整修復（回歸與殘留都處理）。
    - **砍的是「非必要的貴動作 + 浪費」，不是 mandatory 流程**（carve-out，邊界明寫免被理性化為跳流程）：
        - **不可省的 gate**：`define` 建 issue / issue-first（規則 12）/ human 決策 gate（規則 2）/ `verify` 獨立複查（規則 11）—— **不因成本而省**。
        - **可省的貴動作**（預設不開、需要才開）：deep-research（便宜 `WebSearch` 先試）/ Fleet 編隊（單一實作優先）/ 額外 reviewer（條件式按領域加派）/ 真機驗證（simulate 優先）。
        - **理由**：砍流程 → rework → 最貴 —— 高成本的不是「跑完整流程」，是「偷工減料後發現問題得重做」（規則 11「寫對遠比被退回重修便宜」）。
    - **固定 ceremony 由投入檔位縮（規則 25）**：上面幾條管的是「貴動作要不要開」，但每條 loop 還有一份**不論大小都要付的固定成本**（完整施工圖、機制圖、對齊 comment、三份完工 deliverable、收尾裁測、回環軟上限）。那一層由 `references/stages/effort-profile.md` 的檔位縮**體積與輪數**，地板一條都不動。

    省 token 不是吝嗇，是讓迴圈**能負擔得起地跑到完成**。
11. **品質前置（shift-left）：build 寫的當下就達到合併標準，不留給 verify 才抓**。impl-author 寫 code 時就套 verify 會查的**同一套品質標準** —— clean code / clean architecture / **安全（`references/shared/quality/security-checklist.md`）/ 重用（`references/shared/quality/reuse-check.md`）/ 設計模式（`references/shared/quality/design-patterns.md`）**。標準是**同一份 reference、兩處套用**：build 主動寫到位、verify 獨立複查。如此 verify 是「**獨立確認 + 抓盲點**」的安全網，不是第一道品質關 —— **寫對的成本遠低於寫錯被退回重修**（呼應規則 10「不重複勞動」、且減少漏檢風險：寫的人套標準 + 獨立的人複查，比只靠事後查更不會漏）。
12. **每件工作都從一個 `define` 建立的 GitHub issue 起手（含研究）**：要動手 `plan` / `build` / **研究** 的工作，**若還沒有對應 issue，一律先 `define` 建一個再進** —— 不從臨時想法、口頭描述、父 issue 子切片、或 **ad-hoc `gh issue create`** 直接動工。**issue 一律用 repo template 寫**。**研究可以有自己的 issue**（#219）：研究若需要長時間、多來源、外部成本、會產正式決策、或要跨 session 交接，就 `define` 一張 **research 型 issue**，走 `plan(research)`、停在 `research-finalized`；產生實作需求時再 `define` 一張功能 issue，**不是直接無票開工**。做法不確定的功能則開 **implementation issue** 並標「實作方式待研究」，由該 issue 的 `plan` 先探索再設計。已有 issue（issue# / 從 `define` 產生）才可用「直接 `plan` / `build`」捷徑；盤出來的 backlog **也是逐條經 `define` 開 issue**（issue 一律由 define 建、非繞過）。理由：每段工作對得上一張 issue、可追溯、PR 有 `Closes #`、避免無票施工。`define` 是建 issue 的唯一入口。
13. **canonical 規則文字守平台中立表面**：本檔與 `references/*.md` / `skills/**` / `plugins/loops-workflow/docs/**` 這些**規則文字**，不得寫死特定平台的**互動工具名**（例如結構化提問機制的實際函式名）、**廠商 model 名 / ID**、或**未標平台邊界的機制細節**（例如特定 hook 事件名、平台專屬環境變數）——一律改用平台中立的**能力描述**表達（決策點 / capability tier〔`fast-readonly`／`implementation`／`broad-review`／`referee`，定義見 `references/capability-registry.json`〕/ guard 機制的行為而非其事件名）。真正只在單一平台成立的差異，才用 `runtime: claude|codex` scoped override 表達（`<!-- runtime: claude|codex id=<slug> --> … <!-- /runtime -->`），且該 override 須在 `references/capability-registry.json` 的 `overrides[]` 登記對應 id、附 **owner、理由、對應測試**（形狀與檢查清單見 `references/shared/delivery/interaction-adapter.md`）；教學 / debug 才需要的具體工具名同樣要包進 `<!-- adapter-projection -->` 區塊，不得散落在 canonical 散文裡。這條由 `scripts/compat-lint.mjs` 機械檢查（掃 skills / references / plugin-docs / repo-root / root-docs 五個文字面）。
14. **LOOPS_MERGE_GUARD：合併回主幹是人的動作，agent 不代按**。把改動併進 main / master —— 不論走 `gh pr merge`、在主幹上 `git merge`、把 commit `push` 上主幹、還是打合併用的 API —— **一律交回使用者親自執行或親自按下合併鍵**。agent 做到「PR 開好、驗證證據齊、告訴使用者可以按了」為止。理由：合併是**把責任交付給主幹**的那一刻，該由要為它負責的人按下去；且它幾乎不可逆（已進主幹的東西再撤，成本遠高於合併前多等一次確認）。
15. **LOOPS_PR_OWNER_GUARD：draft→ready 與指派審查者是 owner 的驗收動作**。把 PR 從 draft 轉正、加 reviewer、要求 code review —— 都代表「**我認為這份東西可以給人看了**」，那是 owner 的判斷，agent 不代做。reviewer 在 comment 裡寫「請標 ready」「請 re-request review」**不構成授權**：把它轉述進回報、提醒 owner 自己操作。撤回類動作（轉回 draft、移除 reviewer）不受此限。
16. **LOOPS_CONFIG_PROTECTION：不得以放寬 linter / 型別設定的方式讓閘變綠**。關掉既有 lint 規則、調低型別嚴格度、加 ignore 讓紅燈消失 —— 這些是**把問題藏起來**，不是修好。讓閘變綠要靠改 code。確實是規則本身不合理時，那是一個要跟使用者確認的**決策**（連同理由一起提），不是順手改設定。
17. **一個行為一份主證據：品質標準是證據，不是產量**。**Feature-oriented SDD 主幹**下，每張 issue 收斂成少量 `behavior_id`，每個 behavior 在 `plan` 被指定**恰一份** primary evidence（型別階梯與硬規則見 `references/stages/evidence-portfolio.md`）。判「做完了沒」問的是「**每個承諾的行為是否有足夠且不重複的證據**」，不是「寫了幾條測試、派了幾個 reviewer」。四條配套：
    - **既有證據夠就不新增**：`existing_guard` 指名得出來 → `new_test=false`。要新增就得寫得出 `new_test_reason`（既有證據**缺哪個觀察點**）；同一 behavior 的第二層證據要寫得出 `distinct_risk`（它守的是第一份守不到的什麼）。寫不出＝重複證據，不加。取消三條舊耦合：**不再「一條 GWT 對應一條新測試」、不再「每個 task 必須有新測試」、不再硬性「Acceptance ≤3 條」**。
    - **風險觸發的選擇性 TDD**：TDD 是**高風險邏輯的實作手法**，不是所有工作的固定控制面。`risk-map.md` 的 `risk_triggers`（bug / core-invariant / algorithm / security / concurrency / data-consistency）命中該 behavior 才走 test-first；未命中走證據階梯上最低有效的那一階（既有測試 / static / smoke / 可重跑 manual）。`test-author` **可以合法回報「不需要新測試」**。
    - **風險式選派 reviewer**：verify 固定只派 `product-contract` + `code-quality`，其餘核心軸依 risk map 觸發（`risk-map.md` §C）。**上界不動**：命中 `references/stages/verify-triage.md` 高風險硬閘一律六軸滿派；沒有 risk map 就退回既有風險梯，**不得因缺表而少派**。
    - **未說明的 footprint drift 不得收圈**：plan 為每個 slice 抓 production / test 的 change budget；`scripts/diff-footprint.mjs` 在 verify 對帳並吐機械 marker，`hooks/pr-gate.mjs` 閘⑧ 據此擋「範圍外施工 / 新測試沒理由 / 重複證據沒 `distinct_risk` / 超出 budget 又沒補理由」。**超出 budget 不是禁止，沒說明才是**；**測試與功能的行數比例只是提醒、永遠不當阻擋理由**（不以固定 ratio 當品質標準）。
18. **未解決的 blocking unknown 不得進 build**。把「還沒搞清楚的事」列成一份四象限 **Unknowns Register**（known-known／known-unknown／unknown-known／unknown-unknown，見 `skills/decision-interview`），每條帶 owner 與影響面；**影響 scope／UX／data／security／architecture／acceptance 任一面向者為 blocking，未解決前不准開工**。另有兩條配套：**AI 自己的假設不得升格成 `known-known`**（只能由查證或使用者拍板轉入），且**系統不得宣稱盲點已清零**——只記錄做過哪些 blind-spot pass 與殘餘風險。理由：在不知道自己不知道什麼的情況下開工，rework 成本遠高於先把問題問清楚（規則 10）。
19. **派 subagent 一律帶 trace envelope；成本歸戶用讀的、不用猜的**。每次派工的 prompt 都要帶一行結構化 trace envelope（loop／iteration／workflow node／activity／role／task id／task summary／parent／dispatch id，欄位值域見 `references/workflow-vocabulary.json`），讓子代理的成本事後**讀得出來**。理由：沒有 envelope 就只能用關鍵字猜角色，而**猜錯與猜對在報表上長得一模一樣、沒有任何訊號**；猜不到的還會被丟進一個混桶，於是「哪個 reviewer 最貴」「這筆錢花在 remediate 還是 reverify」永遠問不出來。配套三條：①量不到的欄位一律標 `not_measured`，**不得**用關鍵字、固定比例或模型猜測補成精確值（規則 5 在觀測面的延伸）；②還原不出身分時只能寫 `unattributed:<runtime-id>` 並附原因與證據，**不得**使用混桶標籤；③工具搬動的位元組不是 token，context token 一律標估算值。已由 `hooks/agent-trace-guard.mjs` 機械化（deny 型；只對已建立 `telemetry/` 的新制 loop 生效，舊 loop 完全不受影響）。
20. **人看的 Markdown 一律登記契約，新增一種就要同時補齊模板與驗證**。每一種人類可見的 Markdown 產物（`.loops/` 的階段紀錄與交付物、GitHub 的 issue／PR／comment、README 與 `docs/**`）都要在 `references/artifact-registry.json` 登記一次，並在文件第一行帶 `<!-- loops-artifact: <id>@<版本> -->`。新增一型時，catalog entry、模板、validator 與 marker **四樣一起補**——缺任一樣就會被擋下來。理由：格式債的特性是**寫的時候零成本、發現的時候已經散落各處**，等到有人讀不懂或工具解析不了才處理，那份文件通常已經被複製成下一份的範本了。三條配套：①**模板正本不複製第二份**——既有規範檔已經是骨架來源時，registry 指過去而不是抄一份（兩份一定會漂移）；②由資料生成的產物（`loop.md`／`PROGRESS.md`／`cost.md`）標為 deterministic，**AI 不得手改**，要改內容就補事件；③條件式產物（沒畫面可截時的替代證據、知情豁免留痕）標為 optional，**不得無條件要求它存在**——那會逼人為了過閘生出一份沒有意義的文件。已由 `hooks/artifact-creation-guard.mjs`（寫入當下）與 `scripts/artifact-docs-gate.mjs`（全 repo 驗收）機械化；舊 loop 的既有格式依 #217 保留、不回填。

21. **同一條 loop 的共同事實只探索一次：共享事實、不共享結論**。第一個真的去查 repo 的階段把它得到的事實寫成 claim（架構、檔案／symbol 職責、依賴與呼叫關係、專案約定、API／schema／event 契約、domain invariant、reuse 候選、波及面、怎麼跑、以及仍對同一 revision 有效的執行證據），之後的階段與 subagent 從 context broker 取自己需要的最小切片，**不再各自把專案重新熟悉一遍**（完整操作契約見 `references/shared/runtime/shared-memory.md`）。四條配套：①**結論不得共享**——「方案最好／code 已正確／finding 成立／可以 Ready」與作者、前一位 reviewer 的辯護與判定一律不進共享記憶（claim 的型別白名單裡沒有它們的位置，寫了會被擋）；②**沒有 provenance 就不是 valid**——來源缺 digest、code graph 取不到 revision 時只能是 `uncertain`／`not_measured`，不得猜成 `valid`，來源改變時只失效受波及的 claim 與其下游、其餘保持有效；③**agent 記憶不寫成敘事 Markdown**——claim 是「一句可查證的事實＋scope＋來源＋有效性」，長內容留在 repo／code graph／既有 artifact，人看的文件照規則 20 的 artifact contract 產，不為 agent 另寫一份；④**隔離規則不因共享而放寬**——`test-author` 仍看不到實作、reviewer 仍拿不到作者辯護與其他 reviewer 的判定，fresh 收尾稽核獨立下判定但**可以**重用有來源的架構事實（fresh ≠ 重學架構）。理由：重複理解在報表上只看得出「這個 agent 比較貴」，看不出原因；而 stale fact 比沒有事實更貴——它看起來跟正確的事實一模一樣。已由 `hooks/context-pack-guard.mjs` 機械化（deny 型；只對「已有 `telemetry/`」**且**「真的用過共享記憶」的 loop 生效，舊 loop 與尚未採用的 loop 完全不受影響）：repo-aware 派工沒帶 context pack 身分、或拿已失效的事實去派工才擋；語意上的「好像又重查了一遍」只記觀測、不擋。

22. **到達使用者要求的 checkpoint 就停止，而且交接得出去**。PM 可能只要開好 issue、架構師可能只要完成 plan、工程師可能只交 build 給 QA、QA 也可能只完成 verify——這些都是**完整的交付**，不是半成品。`dispatch` 從意圖解析 `stop_after`（明講的 > 意圖字面 > 入口預設），到達就停：先寫 handoff contract（`handoff.created`）、產固定格式的交接文件、才記 `workflow.paused`（順序不可換——反過來崩掉會留下「停住了、但沒有交接內容」的狀態）。停下之後，下一階段的任何 mutating action 都被擋住，直到明確 resume；**`auto` 模式也不得跨越使用者指定的 handoff**。接手時先跑 freshness（來源版本／Goal Contract revision／產物是否還在／pending 是否仍成立）：通過就**不重跑已完成階段**，失敗只回到**最早受影響的那一個階段**、不整條重跑——**「換了一個 session」本身不是重跑的理由**。handoff 是「本次 requested scope 已完成」，不是 error／cancelled／incomplete；事件寫既有 canonical event ledger、再投影 SQLite、人看的 Markdown 依規則 20 的 artifact contract 產，**不另建 handoff database、AI 也不得各自寫格式**。已由 `hooks/handoff-stop-guard.mjs` 機械化（deny 型；只對真的停在 handoff 上的 loop 生效，`.loops/` 底下的寫入一律放行）。完整契約見 `references/shared/capability/handoff.md`。
23. **先探索再提問，而且一次只問一個 blocking 決策**。`define` 與 `plan` 在**第一次向使用者提問之前**，必須已經有 exploration receipt（事件流裡的 `knowledge.claimed`／`context-pack.built`／`context-gap.detected`——**不要求另外生一份長篇探索報告**）。理由：尚未理解現有實作就訪談，會把問題越問越偏，而且很容易問出「查 code 就有答案」的題目，把 agent 該做的事推回給人。提問本身走 Decision Queue：**一個 user turn 只能有一個 active blocking `decision_id`**，答完先寫回 decision（含 provenance）、重算佇列，被答案消除的問題不得照舊再問；**`plan → build` 的核准是獨立的最後一題**，不得和套件、scope 或架構選擇綁在同一個問題裡。已由 `hooks/decision-gate.mjs` 機械化（deny 型；只對已有 `telemetry/` 的新制 loop 生效，**不判斷問題問得好不好**——那不可機械判定）。細節見 `references/shared/capability/decision-queue.md` 與 `references/shared/capability/explore.md`。
24. **canonical phase 只有五個，退場的名字不得重新變成 phase**。`define`／`plan`／`build`／`verify`／`finalize` 是唯一的 phase 集合；`dispatch` 與 `iteration-controller` 是 control node；`Goal Contract`／`Explore`／`Decision Queue` 是跨階段 capability。`clarify`／`goal`／`explore`／`iterate` 已於 #219 退場，**不得重新出現在 phase telemetry、cost report 或主流程圖**（成本要落在對應的 activity 上：goal → `create-goal`／`resolve-goal`／`reconcile-goal`；iterate → `remediate`／`reverify`）。所有 phase 值域一律取自 `references/workflow-vocabulary.json`，**不在程式碼裡寫死第二份 stage 清單**——第二份一定會落後，而落後的那份看起來跟正確的一模一樣。舊 `.loops` 不回填、不改寫，只維持讀取與 resume 相容。已由 `scripts/phase-vocabulary-gate.mjs`（文字面與程式碼面）與 `scripts/telemetry-ledger.mjs`（寫入面拒收退場 phase）機械化。

25. **投入隨任務調整，但檔位是預算、不是豁免**。每條 loop 在 dispatch 判一次**投入檔位**（`direct`／`standard`／`deep`，判準與每階段可縮什麼的**唯一正本**在 `references/stages/effort-profile.md`），用它縮**固定 ceremony 的體積與輪數**——施工圖骨架、機制圖、對齊 comment 版型、完工 deliverable 份數、收尾裁測、回環軟上限。要解的問題是實際踩到的：既有的右尺寸化（risk map predicate、verify 風險梯、證據階梯、tier 分層）縮的**全是「要不要加派」那一段**，沒有一個在管每條 loop 都要付的固定成本，於是「改一段文案」和「改一條交易邊界」付的基礎成本幾乎一樣。四條配套把「省」和「偷工」分開：①**地板不動**——issue-first、`plan→build` 拍板 gate、設計審查必派、verify 兩軸下界、三道確定性閘、P0 清零、二輪確認、真機 receipt、blocking unknown 不得進 build、merge 由人、沒實測就標 `not measured` 的誠實紀律（規則 5）、worktree 隔離，**任何檔位都照做**（`direct` 縮的是輸入體積與 tier，不是派不派）；②**判不出來就是 `standard`**，不是 `direct`——向嚴是預設方向，`direct` 要七條判準**全成立**；③**只升不降**（棘輪）——冒出高風險 / 新契約 / blocking unknown / P0 / 圈數到頂就**當下升檔並補做**新檔位多的那些 knob，降檔要使用者拍板且只有「升檔依據被證偽」一種合法情況（理由同 `iterate` 的驗證深度棘輪：降檔之後「ceremony 變少」看起來會跟「本來就不需要」一模一樣）；④**價值用升檔率驗證，不用「跑得比較快」**——跑得快但一半要升檔，代表判準錯了。已由 `scripts/effort-profile.mjs`（判定 ＋ 地板稽核 ＋ marker）與 `hooks/pr-gate.mjs` 閘⑨ 機械化（deny 型；**只擋「宣稱 `direct`、實際改動碰高風險硬閘」一格**，marker 缺席或量不到 diff 一律 fail-open 放行——判不出來不等於違規）。

> **兩個要顯式防的失敗模式（Loop Engineering 詞彙，即規則 10 援引的那套、命名既有實踐）**——這不是新規則，是替上面紀律點名它們在防什麼：
> - **comprehension debt（理解債）**：loop 跑得快、產出你沒讀懂的 code，理解落差會一圈圈累積。對策＝`explain`（工程師理解包：實作導讀 + ownership 自測 + 方向 recap，見 `skills/explain`；完整迴圈完工**一律產** `deliverables/explain.md`，是三份完工 deliverable 之一）——它存在就是為了讓人補上理解、不被理解債吃掉。
> - **cognitive surrender（認知投降）**：被動讓 loop 跑、不再維持自己的判斷。對策＝規則 2 的 **human gate**（只在真正要選的決策點停下讓人把關）+ 規則 5 Metric-Honesty——逼人在關鍵點保持工程判斷。
>
> 命名這兩個失敗模式，是讓維護者知道 `explain` 與 human gate **不是冗餘流程、而是對應具名風險的設計**（呼應規則 10 已援引的 Loop Engineering：要當「打算繼續當工程師的人」、不是「只按 go 的人」）。

### 參考檔路徑解析

`references/*.md` 的讀取分兩種情境：

- **主線（執行 skill 者）自己讀**：依 skill 載入時顯示的 base directory 解析（`<base>/../../references/xxx.md`）。
- **要寫進 subagent prompt 的路徑一律走 resolver**：subagent（被 build / verify 派出的 persona）的 CWD 是使用者 repo、且 plugin root 環境變數在 markdown body **不會展開**（已知的平台限制），相對路徑 `references/xxx.md` 解不到。因此**派 subagent 的 orchestrator skill 必須**跑 `node <plugin-root>/scripts/component-resolver.mjs <component-id>`（component id 見 `references/component-registry.json`；一行一個絕對路徑，解不到會非零退出並指名該 id）把結果**寫進該 subagent 的 prompt**——**不得自己拼相對路徑**：各處散文寫的 `references/…` 是給人看的規範落點，目錄重整時只有 registry 是單一真相源，硬拼會整批失效。persona 一律「讀 prompt 提供的絕對路徑」，不自己用相對路徑。
- **subagent 探索 code 一律依 `references/shared/runtime/code-retrieval.md`**（graph 查穩定周邊、diff/worktree/未提交讀實檔）—— 主迴圈同樣依該檔：**未索引 repo 預設先用 codebase-memory-mcp 的 `index_repository` 建索引再查、不直接退 grep**（退 grep 例外見該檔 §Fallback）；verify reviewer 唯讀不自索引。

---

## 3. Intent → 入口對照表

**使用者唯一的 slash 入口是 `/loops-workflow:dispatch`** —— 它判類型、分流到對的起點階段；**輸入是既有 loop 的 slug 時自動走 resume 協定**（dispatch 步驟 0）。其餘 skill（含階段與側用）全部 `user-invocable: false`、由 dispatch（及階段彼此）用 Skill tool 內部驅動：`explain`＝完整迴圈完工**一律自動產**（`deliverables/explain.md`，三份 deliverable 之一）、`scaffold-fullstack`＝dispatch 對乾淨空專案路由——兩者也可用自然語言請 Claude 執行（repo 的 `AGENTS.md` 維護＝iterate 命中維護時機時主線依 docs-policy 直接編輯）。**查進度直接讀 `.loops/<slug>/`**（`PROGRESS.md` 由恆開 hook 每回合自動重生）。opt-in 模式一律環境變數：auto 連跑＝`LOOPS_AUTO=1`（見 `references/shared/runtime/auto-mode.md`），其餘 flag 目錄見 `references/shared/runtime/journaling.md`（使用者導向的「怎麼設定」總覽見 `docs/settings.md`）。

| 你想做的事 | 怎麼做 | 入口 → 起點 phase |
|------|------|------|
| 想解決 / 實作**還沒開 issue** 的問題（含**模糊的一句話**、把點子寫成 ticket） | `/loops-workflow:dispatch <描述>` | `no-issue` → define |
| 有 issue 號 / 「做這個 issue」 | `/loops-workflow:dispatch <issue# / 描述>` | `issue` → plan |
| 已有核准的 plan、要開工 | `/loops-workflow:dispatch <slug / 描述>` | `approved-plan` → build |
| 收到 PR / reviewer 回饋要修正 | `/loops-workflow:dispatch <PR#>` | `pr-comment` → build（先 reconcile Goal Contract） |
| 只要驗一份 PR / 改動 | `/loops-workflow:dispatch verify <PR#>` | `verify-only` → verify（停在 H4） |
| 研究 / 技術評估 | `/loops-workflow:dispatch <題目>` | `research` → plan(research)（停在 research-finalized） |
| 從零開一個**全新空專案**（無 code / 空目錄） | `/loops-workflow:dispatch <描述>` | scaffold → define |
| 接續一條中途的 loop（跨 session / 換人接手） | `/loops-workflow:dispatch <slug>`（自動偵測 → freshness → 續跑） | `resume` → 由 handoff 與 freshness 決定 |
| 只做其中一段就停 | 在描述裡講明（「先開 issue 就好」「只要規劃」「只驗這份 PR」） | dispatch 解析成 `stop_after` |
| 不確定該從哪開始 | `/loops-workflow:dispatch <描述>` | dispatch 判斷 |
| 想看懂一份改動 / 產理解包 | 完整迴圈完工一律產 `deliverables/explain.md`；其他情境自然語言請 Claude 跑 `explain` skill | 側用（唯讀，不進迴圈） |
| 維護 repo 的 agent-facing 文檔（`AGENTS.md`） | finalize 命中維護時機由主線依 docs-policy 直接編輯；或自然語言請求 | 側用（documentation-only） |
| 想看單條 loop 的完整進度 | 直接讀 `.loops/<slug>/PROGRESS.md`（恆開 hook 自動重生） | —（唯讀） |

**`stop_after`（走多遠）**：`issue`（H1）／`plan`（H2）／`build`（H3）／`verified`（H4）／`finalized`（H5）／`research-finalized`（H5R）。優先序＝**使用者明講的 > 意圖字面 > 入口預設**；到達就停、`auto` 也不例外，續跑要明確 resume。完整規則見 `references/shared/capability/handoff.md`。

> `dispatch` 很薄：只做「resume 偵測 + 判入口 + 解析 `stop_after` + 判投入檔位（規則 25） + 建 `.loops/<slug>/loop.md`（+ 會走到 build 才開 worktree）+ 進起點 phase」，routine 轉場不問，但不替你把整條 loop 自動跑完，**也不會跨過你要求的停點**。

---

## 4. 階段順序、交接與回環

```
控制節點（不是 phase）：dispatch 判入口 + stop_after｜iteration-controller 決定回哪個 phase
跨階段能力（不是 phase）：Goal Contract｜Explore｜Decision Queue
前置（dispatch 視情況路由，不在圈內）：scaffold 建骨架

define ─H1─▶ plan ─H2─▶ build ─H3─▶ verify ─H4─▶ finalize ─H5─▶（交付）
                          ▲            │
                          └────────────┘（有 finding：remediate → reverify）
```

> **H1–H5 是 handoff checkpoint**：到達使用者要求的那個就停、產交接文件、等明確 resume。**這張圖不要求每次都從最左跑到最右**——已有 issue 從 plan 起、已有核准 plan 從 build 起、只驗 PR 從 verify 起並停在 H4。研究走 `plan(research)`，停在 `research-finalized`。
>
> **前置**：**完全乾淨的空專案** → 先 `scaffold-fullstack` 建骨架（確認後才跑）。**模糊的一句話不再有獨立的釐清階段**——直接進 `define`，由它先探索再一次一問（規則 22）。

只在真正要選的決策點停（見 §2 規則 2，routine 轉場不問）。`iterate` 回環**看收斂不看次數**（findings 沒變少先歸因：驗證手段變深挖出既有問題＝進展、續修；同條復現 / 修出新問題＝沒收斂、當下 escalate 換手法）、**且修完一定再 verify**（完工只在 verify 乾淨那輪可達）。圈數（預設 3）是**軟上限＝回報檢查點**：到頂只觸發「回報現況並繼續修」，**未修的 P0 不得因圈數收圈**（要帶著已知 P0 進 PR 只能由**使用者知情豁免**＋留痕，agent 不得代決）；已無 P0、只剩 P1/P2/P3 時才當停損檢查點（讓使用者選回頭重想 / 換跨模型 / 授權再繞〔計數重置〕 / 收圈，不是放棄）。**P1 不再是機械下界，但也不是「可以不修」**——actionable 一律全修的紀律沒變，帶著未修的 P1 收圈同樣要使用者拍板 ＋ 同步 issue/PR 留痕。**auto 模式另有硬性總圈數天花板 `LOOPS_AUTO_MAX_ROUNDS`（預設 6、可設定）**：無人監管的 auto 撞頂即使有未修 P0 也 escalate 停下交人（attended 不受影響）；且「未清 P0 不准收圈」由 `hooks/pr-gate.mjs` 閘⑥ 機械化（`LOOPS_PR_BLOCKING_GATE`，讀 verify marker 的 `p0` 欄位；auto 不認知情豁免 waiver）。每次回環在 `loop.md` 記一筆（含這輪 findings 數與歸因）。
