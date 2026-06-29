# loops-workflow — 操作規則與指令對照

> 7 階段閉環開發工作流：`dispatch → goal → explore → plan → build → verify → iterate`（dispatch 視情況先走前置 `clarify` 釐清 / `scaffold` 骨架 / `define` 開 issue），階段間 human gate，`.loops/<slug>/` markdown 當階段記憶體。
>
> 這份檔案是 plugin 的「憲法層」：以下 Operating Rules 是**全程不變的共用紀律**，七個階段 skill 預設遵守、不各自重述。任一 skill 與這裡衝突時，以這裡為準。

---

## 1. 設計取向（一句話）

把一次開發當成一個**閉環**：每階段做一件事、寫進 `.loops/` 交給下一階段，**只在真正要選的決策點停下讓人把關**（見規則 2，routine 轉場不問）。發散工作（探索、驗證）派多個 subagent 各做不同子任務、收斂工作回單一主線；build 用紅綠分離防測試遷就實作、verify 用多 reviewer fan-out 擴大覆蓋。

這個閉環的座標（明寫，免得只是「跑階段」）：

- **類型 = Closed Loop（預設）**：人類在框架內把關、隔離環境（worktree）、清晰標準、持續驗證 —— 適合大多數實際產品工作；opt-in `auto` 收斂成 Open Loop（核准一次後連跑，只剩安全停）。
- **規模 = 單一迴圈（預設）**：一個主線跑完整條；解法空間寬 / 長任務時 opt-in **Fleet 編隊**（plan·explore·verify 派多 subagent 並行各做子任務再收斂，見 `references/fleet.md`）。
- **目標的脈絡 = VISION / ARCHITECTURE / RULES**：VISION＝issue / `00-goal.md` 完工定義；ARCHITECTURE＝`02-plan.md` 設計書（§0–§9）+ repo 既有架構（onboarding 文檔優先讀）；RULES＝本檔 + 專案 `AGENTS.md` / `CLAUDE.md`。三者就是每個 subagent 該拿到、且只拿到的脈絡。
- **方法論鏈（DDD/BDD/TDD/SDD 各擁一個轉換、不重複，見對應 reference）**：loops 是一條 **Spec-Driven（SDD）** 的閉環——詞彙與結構由 **Domain-Driven（DDD，`references/clean-architecture.md` 的 Ubiquitous Language / entity·VO·aggregate / bounded context）** 塑形、驗收以 **Behavior-Driven（BDD，`references/bdd-scenarios.md` 的 Given-When-Then 場景）** 表達、實作由 **Test-Driven（TDD，build 紅綠 + `references/test-rubric.md`）** 保證。一條產物鏈：`領域語言(DDD) → 規格(SDD) → 行為情境 GWT(BDD) → 紅燈測試(TDD) → 實作 → 驗收回核(BDD+SDD)`；`.loops/` 的產物本身就是逐階提高解析度的規格（issue → `00-goal.md` → `02-plan.md` → tasks）。
  - **右尺寸鐵則**：方法論嚴格度隨 **operation（`references/operation-first-move.md`）× size（XS–XL）** 縮放——瑣碎 / 純 refactor 免建模免場景、bug-fix 的重現測試即場景、高風險 / 動到核心領域才完整 glossary + 場景集。**小任務不加 ceremony**（呼應規則 10 carve-out：砍非必要 ceremony、不砍 mandatory gate）。各階段 skill 依此框定、各不重複框定細節、以一句指回本節。

---

## 2. Operating Rules（全程不變的紀律）

1. **對外敘述一律繁體中文**；code identifier、檔案路徑、指令、skill 名保留英文。
2. **推進：階段間不問「要不要進下一階段」**。階段做完把產出寫進 `.loops/` + chat 摘要，**直接往下**，**不要**每進一個階段就停下問使用者「要不要繼續」。使用者隨時可插話喊停 / 改方向。
   - **只在「真正要使用者選」時停 + 用 `AskUserQuestion`**（選項標推薦，依 `references/comment-policy.md`）：explore 選方法 / plan 拍板方案（含套件選型）/ iterate 完工 or 回哪階段；以及 goal / plan 冒出的**具體 scope / 取捨決策**（有真選擇才問，沒有就往下）。
   - **安全停（一定停 + 問）**：dispatch 分類模糊 / 危險不可逆操作 / verify 出 P0 / 規格講不清。
   - **絕不**用純文字「請回覆 yes / 要我接著進 X 嗎」要使用者打字 —— 要嘛 `AskUserQuestion`，要嘛直接往下。
   - **auto 模式**：連上面的決策也用推薦選項自動帶過，只剩安全停（見 `references/auto-mode.md`）。
3. **`.loops/<slug>/` 是階段間記憶體**。每階段把結論寫成對應 markdown（`00-goal.md` / `01-explore.md` … 每階段一個），下一階段只讀精煉版、不重讀原始素材。任一階段被獨立呼叫時，**先讀 `loop.md`** 認領狀態。**進入一個階段時更新 `loop.md` 的「當前階段」+ append 一筆 Journal**（供 statusline / resume）；**完工時把「當前階段」設為「完工」**。每份檔保持 **< 2000 行**（context window ≠ attention budget）。
4. **模糊就 surface，不要猜**。需求 / 分類 / 方案不清楚時停下來問，不自行假設往下做。
5. **Metric-Honesty**：任何「效能 / 覆蓋率 / 通過」宣稱，沒有實際跑出來就標 `not measured`，不得憑感覺寫數字。
6. **重用優先、不以 MVP、照 clean code / clean architecture 寫**：動手前先搜既有實作、避免重複造輪子（稍異 ≠ 另造，優先參數化既有方法，見 `references/reuse-check.md`）；in-scope 實作不以 MVP，照最高標準做（對可預見的規模退化預先用對演算法與結構）；**寫的當下就照 clean code（`references/clean-code.md`：命名 / 小函式 / guard clause / 顯式錯誤 / 型別契約）+ clean architecture（`references/clean-architecture.md`：依賴向內 / port + 注入 / 落點對齊）標準**，不是先寫爛再靠 refactor 救（refactor 精修見 `references/code-simplification.md`；異味 → 具名手法 → 設計模式時機見 `references/refactoring.md`）。
7. **文件紀律**：完工前依 `references/docs-policy.md` 判斷 —— 新子系統 / 跨切面 / 不直觀設計寫 `docs/<topic>.md`（+ 維護 `docs/README.md` 索引）；慣例 / 規則改變才更新 `AGENTS.md` · `CLAUDE.md`；小功能不塞 docs。
8. **對外溝通**：所有面向人的書面（AskUserQuestion / issue · PR 回覆 / 驗收報告 / 端決策）依 `references/comment-policy.md` —— 繁中白話、雙視角紀錄、AskUserQuestion 標推薦、對外內容先寫**暫存 tmp 草稿**校稿（不進專案 / 不進版控）+ **送出後刪 tmp**、不寫客套。
9. **code 變更在 git worktree 裡做**（隔離工作目錄、不擾動使用者主 checkout）：會動 code 的迴圈（issue / fix）在 loop 啟動時開一個**獨立 worktree（自帶 branch）**、整條 loop 在裡面跑 —— **不在主 checkout 直接 `checkout -b`**。用環境的 worktree 能力（`EnterWorktree`）或 `git worktree add .claude/worktrees/<slug> -b <slug> <base>`。**branch / worktree 名 = loop slug `<issue#>-<slug>`（例 `137-trash-delete-permanent`），不加 `fix/`/`feat/` 等 type 前綴**；修正型（PR 已存在）把該 PR branch checkout 進 worktree。純設計 / 研究（不動 code）免開、走到 build 再開。完工 merge 後 `git worktree remove` 清掉。**`.loops/<slug>/` 留在主 repo（session 起點 / 主 checkout）、不放進 worktree** —— worktree 只放 code。原因：未追蹤的 `.loops/` 若放 worktree，會在 worktree 被 `git clean` / refresh（`baseRef: fresh`）/ `remove` 時被**一起刪掉、毀掉 audit trail**（已踩過）；放主 repo 才不被 worktree 操作波及，主 repo 的 session 也直接讀得到。statusline / `status` / hook 仍會掃 `.claude/worktrees/*/.loops/` 當保險。
   - **平行寫檔一律隔離 worktree**：若同一階段（尤其 build）**同時派多個會寫檔的 subagent**（跨任務 / 跨 DAG 層平行 fan-out），**每個平行 writer 各跑在自己的隔離 worktree**（`isolation: 'worktree'`，或各自 `git worktree add`），**不可共用同一工作目錄** —— 共用會讓它們的 `pnpm` / 檔案寫入交錯競態，且各自自報的「綠」反映的是不同時間點的半成品態、**不可採信**（已踩過）。平行子任務完成後**合併回 loop 主 worktree，由主線在合併態上重跑完整 gate（`typecheck`/`lint`/`test`）才算數**，不採信任一 subagent 的自報結果。read-only subagent（verify reviewer / explore 掃描）不寫檔，無此限制。
10. **成本意識：迴圈很貴，要設計成「負擔得起」**。一條迴圈動輒 50–200K token、回環三輪 500K–2M —— Loop Engineering 的成敗在**負擔得起**，不是能不能跑。所以全程貫徹：
    - **高上下文效率**：下一階段只讀**精煉版**（`.loops/` 的 `0N-*.md`）、不重讀原始素材；每份 < 2000 行；subagent 只塞它**需要的那段**脈絡（VISION/ARCHITECTURE/RULES 對應段 + 該軸的絕對路徑 reference），不倒整包。
    - **便宜的先、貴的後且要 gate**：explore 內部夠就不外搜、外搜先便宜 `WebSearch` 再 gate 升級 deep-research；verify 條件式 reviewer 只在觸及領域才加派；Fleet / deep-research / 真機驗證這些貴動作預設不開、要才開。
    - **不重複勞動**：reuse 優先（不重造輪子）、living plan（偏離回去改、不留到最後重做）、修完一定再 verify（一次驗到位、不靠人來回）。
    - **fail-fast 不空轉**：停止條件**看收斂**（findings 沒變少 / 同條 finding 復現就 escalate）、回環 3 圈上限當檢查點、**不過早放棄也不無限繞**。
    - **砍的是「非必要的貴動作 + 浪費」，不是 mandatory 流程**（carve-out，邊界明寫免被理性化為跳流程）：
        - **不可省的 gate**：`define` 建 issue / issue-first（規則 12）/ human 決策 gate（規則 2）/ `verify` 獨立複查（規則 11）—— **不因成本而省**。
        - **可省的貴動作**（預設不開、需要才開）：deep-research（便宜 `WebSearch` 先試）/ Fleet 編隊（單一實作優先）/ 額外 reviewer（條件式按領域加派）/ 真機驗證（simulate 優先）。
        - **理由**：砍流程 → rework → 最貴 —— 高成本的不是「跑完整流程」，是「偷工減料後發現問題得重做」（規則 11「寫對遠比被退回重修便宜」）。

    省 token 不是吝嗇，是讓迴圈**能負擔得起地跑到完成**。
11. **品質前置（shift-left）：build 寫的當下就達到合併標準，不留給 verify 才抓**。impl-author 寫 code 時就套 verify 會查的**同一套品質標準** —— clean code / clean architecture / **安全（`references/security-checklist.md`）/ 重用（`references/reuse-check.md`）/ 設計模式（`references/design-patterns.md`）**。標準是**同一份 reference、兩處套用**：build 主動寫到位、verify 獨立複查。如此 verify 是「**獨立確認 + 抓盲點**」的安全網，不是第一道品質關 —— **寫對的成本遠低於寫錯被退回重修**（呼應規則 10「不重複勞動」、且減少漏檢風險：寫的人套標準 + 獨立的人複查，比只靠事後查更不會漏）。
12. **每件工作都從一個 `define` 建立的 GitHub issue 起手（含研究）**：要動手 `plan` / `build` / **`explore` 研究** 的工作，**若還沒有對應 issue，一律先 `define` 建一個再進** —— 不從臨時想法、口頭描述、父 issue 子切片、或 **ad-hoc `gh issue create`** 直接動工。**issue 一律用 repo template 寫**。**沒有獨立的「研究 issue」** —— 研究永遠服務某功能：要嘛是某張**功能 issue 的 `explore` 階段**（功能 issue 標「實作待研究」，動工前先 explore 研究怎麼做），要嘛**先研究 / 討論定案再 `define` 開功能 issue**。已有 issue（issue# / 從 `define` 產生）才可用「直接 `plan` / `build` / `explore`」捷徑。發散式 `explore` 盤出的 backlog **也是逐條經 `define` 開功能 issue**（issue 一律由 define 建、非繞過）。理由：每段工作對得上一張 issue、可追溯、PR 有 `Closes #`、避免無票施工。`define` 是建 issue 的唯一入口。

> **兩個要顯式防的失敗模式（Loop Engineering 詞彙，即規則 10 援引的那套、命名既有實踐）**——這不是新規則，是替上面紀律點名它們在防什麼：
> - **comprehension debt（理解債）**：loop 跑得快、產出你沒讀懂的 code，理解落差會一圈圈累積。對策＝`explain`（完整迴圈完工**自動產**的工程師理解包：實作導讀 + ownership 自測 + 方向 recap，見 `skills/explain`）——它存在就是為了讓人補上理解、不被理解債吃掉。
> - **cognitive surrender（認知投降）**：被動讓 loop 跑、不再維持自己的判斷。對策＝規則 2 的 **human gate**（只在真正要選的決策點停下讓人把關）+ 規則 5 Metric-Honesty——逼人在關鍵點保持工程判斷。
>
> 命名這兩個失敗模式，是讓維護者知道 `explain` 與 human gate **不是冗餘流程、而是對應具名風險的設計**（呼應規則 10 已援引的 Loop Engineering：要當「打算繼續當工程師的人」、不是「只按 go 的人」）。

`references/*.md` 的讀取分兩種情境：

- **主線（執行 skill 者）**：依 skill 載入時顯示的 base directory 解析（`<base>/../../references/xxx.md`）。
- **subagent（被 build / verify 派出的 persona）**：CWD 是使用者 repo、且 `${CLAUDE_PLUGIN_ROOT}` 在 markdown body **不會展開**（Claude Code 已知限制），相對路徑 `references/xxx.md` 解不到。因此**派 subagent 的 orchestrator skill 必須**從自己的 base directory 推出 plugin root，組出 reference 的**絕對路徑、寫進該 subagent 的 prompt**；persona 一律「讀 prompt 提供的絕對路徑」，不自己用相對路徑。

---

## 3. Intent → command 對照表

使用者可以走 `dispatch` 讓系統判類型，也可以**直接喊對應階段**跳過判斷。每個階段 skill 都能獨立呼叫。

| 你想做的事 | 進入點 | 起點階段 |
|------|------|------|
| 有 issue 號 / 「做這個 issue」（意圖明確，完整迴圈） | `/loops-workflow:dispatch <描述>` 或直接 `/loops-workflow:goal` | goal |
| 丟一個**模糊想法 / 含糊一句話**（還不確定要實作還是研究、範圍不清） | `/loops-workflow:dispatch <描述>`（判模糊 → `clarify` 釐清 → 再分流）或直接 `/loops-workflow:clarify` | clarify → define/goal · explore · iterate |
| 想解決 / 實作一個**還沒開 issue** 的問題 | `/loops-workflow:dispatch <描述>`（走 `define` 建 issue → 再 goal）或直接 `/loops-workflow:define` | define → goal |
| 把一個點子 / 模糊問題寫成結構化 issue / ticket | `/loops-workflow:define <描述>` | define（前置，可獨立用） |
| 從零開一個**全新空專案**（無 code / 空目錄） | `/loops-workflow:dispatch <描述>`（偵測乾淨 → 確認 → scaffold 骨架 → define → goal） | scaffold → define → goal |
| 純設計 / 研究 / 技術評估（無 issue） | `/loops-workflow:dispatch <描述>` 或直接 `/loops-workflow:explore` | explore |
| 收到 PR / reviewer 回饋要修正 | `/loops-workflow:dispatch <PR#>` 或直接 `/loops-workflow:iterate` | iterate |
| 需求已清楚、只想把方法拆成可驗證任務（**前提：已有對應 issue**；沒有先 `define`，見規則 12） | 直接 `/loops-workflow:plan` | plan |
| 計畫已拍板、要逐任務實作（**前提：已有對應 issue**） | 直接 `/loops-workflow:build` | build |
| 改完了、要做 merge 前驗收 | 直接 `/loops-workflow:verify` | verify |
| 不確定該從哪開始 | `/loops-workflow:dispatch <描述>`（會幫你判類型 + 建 loop.md） | dispatch 判斷 |
| 想看懂一份改動 / 交給人前產導讀 | `/loops-workflow:explain <target>` | 側用（唯讀，不進迴圈） |
| 維護 repo 的 agent-facing 文檔（`AGENTS.md`） | `/loops-workflow:agents-md-maintainer` | 側用（documentation-only，不被 dispatch 路由、不進迴圈） |
| 想裝 statusline（顯示當前 loop / 階段） | `/loops-workflow:install-statusline` | 側用（一次性設定，patch settings.json） |

> `dispatch` 很薄：只做「分類 + 建 `.loops/<slug>/loop.md`（+ 對 issue/fix 開 worktree）+ 進起點階段」，routine 轉場不問，但不替你把整條 loop 自動跑完。

---

## 4. 階段順序與回環

```
前置（dispatch 視情況路由）：clarify 釐清模糊需求｜scaffold 建骨架｜define 開 issue
        │
dispatch → goal → explore → plan → build → verify → iterate
                                                        │
                  回 goal / explore / plan / build ◀────┤（看收斂·≤3 圈）
                                                        └──▶ 完工（交 PR / 收尾）
```

> 起跑前的前置（dispatch 內、不在迴圈圈內）：**模糊想法 / 含糊一句話** → 先 `clarify` 釐清 + 確認理解 + 判方向（不確定要實作還是研究就在這裡定）；**完全乾淨的空專案** → 先 `scaffold-fullstack` 建骨架（loops-workflow 內建 skill，確認後才跑）；**已釐清的待解決問題** → 先 `define` 建 issue。都收斂到 `goal`（或 explore）進迴圈。dispatch 自己只分流、不做需求訪談。

只在真正要選的決策點停（見 §2 規則 2，routine 轉場不問）。`iterate` 回環**看收斂**（findings 嚴格變少才值得再繞）、預設 3 圈上限、且**修完一定再 verify**（完工只在 verify 乾淨那輪可達）；**沒收斂或碰上限就 escalate 當檢查點**（讓使用者選回頭重想 / 換跨模型 / 授權再繞〔計數重置〕，不是放棄）。每次回環在 `loop.md` 記一筆（含這輪 findings 數）。
