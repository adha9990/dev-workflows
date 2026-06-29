# references 目錄（各規範在處理什麼）

> `references/` 是 loops-workflow 的「知識模組」—— 各階段 skill / agent 不重述共用規範，而是引用這裡。本檔把 **46 份 reference 依功能分類**，一眼看出「哪份在管什麼、誰在用」。
>
> 機制全貌（每階段怎麼跑）見 [`FLOW.md`](FLOW.md)；這份是「規範字典」。subagent 讀不到相對路徑 → orchestrator 把絕對路徑塞進 prompt（見 `AGENTS.md`〈參考檔路徑解析〉）。

---

## 1. 寫碼品質標準（build 寫 + verify 查，shift-left 共用）

> **同一份 reference、兩處套用**：build 寫的當下就照著寫（impl-author）、verify 獨立複查（reviewer）。見 `AGENTS.md` 規則 11。

| reference | 處理什麼 | 主要用在 |
|---|---|---|
| `clean-code` | line / 函式級寫碼標準：命名揭意圖、小函式單一職責、guard clause、顯式錯誤、型別契約、無魔法值 | build（impl-author）· verify（code-quality） |
| `clean-architecture` | 模組 / 依賴級結構標準：依賴規則向內、分層邊界、port + 注入、內聚 > 耦合、落點對齊、SOLID | plan（設計）· build（寫）· verify（architecture） |
| `design-patterns` | GoF 三大類設計模式的對症時機 + pattern 上癮 / 過度設計反面 | plan（設計時選型）· build（refactor 引入）· verify（architecture） |
| `refactoring` | code smells 目錄（Fowler 分類）→ 具名重構手法 → 設計模式引入時機 | build（Refactor step）· verify（code-quality） |
| `code-simplification` | 安全簡化紀律：Chesterton's Fence、過度簡化四陷阱、清晰優先於精巧 | build（Refactor）· verify（code-quality） |
| `reuse-check` | 重用優先判準：同方法不同入口、同詞根系列收斂成參數化、稍異 ≠ 另造 | plan（拆任務前）· build（寫前）· verify（code-quality） |
| `security-checklist` | 威脅建模 + STRIDE + OWASP / LLM Top 10 + auth / 輸入 / 資料保護檢查表 | build（寫安全）· verify（security） |
| `test-rubric` | 四層測試、Real > Fake > Stub > Mock、pyramid 80/15/5、DAMP > DRY、data-layer 清單 | build（test-author）· verify（tests） |
| `contract-spec` | 跨介面契約規格（API / 資料 / 事件）+ 對到哪層測試 + Hyrum's Law | plan（跨介面才寫）· verify（product-contract） |

## 2. 各階段產出格式（schema）

| reference | 處理什麼 | 主要用在 |
|---|---|---|
| `goal-restate-schema` | 完工定義六欄格式（Outcome / User / Why now / Success / Constraint / Out of scope） | goal（`00-goal.md`） |
| `design-plan-schema` | §0–§9 設計書骨架：系統全貌 / 檔案職責表 / 機制圖 / 具名背書 / 三角驗證 / 成果展示 | plan（`02-plan.md`）· iterate（提煉 PR body） |
| `machine-plan-schema` | 機器可驗證的 `loops-plan` JSON 塊格式（每任務可執行 verification、acceptance ≤3、依賴無環） | plan（可選）+ `validate-plan.mjs` |
| `change-summaries` | build 產出的 Change Summaries 三段式格式 | build（`03-build.md`） |
| `operation-first-move` | 4 operation 性質（new-feature/change-behavior/bug-fix/refactor）× test-author 紅燈第一步規則 + fail-safe（單一來源） | dispatch（寫 `operation` 欄）· build（讀欄派 test-author） |
| `quality-gate-schema` | quality-gate 腳本輸出 / failures 結構化契約（`file:line [code\|ruleId] message`） | build（派 fixer 帶 failures）· verify（gate 摘要） |
| `instinct-schema` | 跨 loop 學習的 instinct YAML 格式（id/trigger/action/confidence/scope/evidence/summary）+ 隱私/Honesty 規範 | distill（寫 instinct）· session-start（讀注入） |

## 3. 驗證與審查機制

| reference | 處理什麼 | 主要用在 |
|---|---|---|
| `reviewer-severity` | finding 分級格式：P0–P3 + Confidence（50/75/100）+ Route | verify（全 reviewer） |
| `finding-validation` | finding-validator 二輪四問：真實 / 本次引入 / 已防護 / 對症 → validated / rejected / degraded | verify（finding-validator） |
| `preflight` | 送審單一判定（可送審 / 建議先修 / 資訊不足）+ 硬規則「作者已留痕的決定不算 finding」 | verify（送審自檢 + 全 reviewer） |
| `optional-reviewers` | 條件式領域 reviewer 對照（哪種改動加派哪個：前端 / a11y / 可觀測性 / CI-CD / migration / bug-fix / docs…） | verify（1.5 加派） |
| `verify-triage` | verify 改動風險判準（定 0~6 核心軸）：高風險硬閘清單 / 小孤立·瑣碎判準 / tangling veto / 「做錯東西就整個退回」catastrophic-miss 判準（所有級、審查後 triage） | verify（步驟 1 選軸判級） |
| `cross-model-review` | opt-in 換不同模型當對手 reviewer（卡關時升級對抗審查） | iterate（卡關）· verify（可選） |

**per-axis 審查判準**（reviewer 出手前注入的判準 / 方法論，薄 agent 不重述）：

| reference | 處理什麼 | 主要用在 |
|---|---|---|
| `review-dispositions` | 每軸 reviewer 盯點（hunting disposition）+ 出手前共用誤報底線清單 | verify（全 reviewer） |
| `acceptance-review` | 驗收深度：錯題偵測 P0 / 完成度五態（逐項強制完整 + descoped 處置）/ **完整性 gate（tier-independent、餵 verify 步驟 4 acceptance 閘）** / 端到端 + 持久化 / 證據強弱 | verify（product-contract） |
| `correctness-review` | 正確性：狀態流不變量 / 跨儲存部分失敗 / 冪等·stale 覆寫 / transaction 正確性 | verify（code-quality） |
| `architecture-review` | 架構審查方法論：追 contract sync / import graph / wiring graph + 降級清單 | verify（architecture） |
| `performance-review` | 效能審查：四件式證據門檻 / 查詢計畫退化 / index / 分頁 / I/O 放大 | verify（performance） |
| `ui-interaction-review` | 交互閉環：真實寫入 / 假成功回滾 / 快取同步 / 亂序 / 編輯 flush | verify（frontend-ui） |
| `root-cause-review` | 根治性：症狀 vs 病根 / 因果鏈 / 同類入口 / 回歸測試撤 fix 必紅 | verify（root-cause，條件式） |
| `docs-devex-review` | 文件同步 + PR body 驗證證據品質 | verify（docs-devex，條件式） |

## 4. 對外溝通與產出

| reference | 處理什麼 | 主要用在 |
|---|---|---|
| `comment-policy` | 對外書面總綱：繁中白話、雙視角紀錄、AskUserQuestion 標推薦、tmp 草稿送出後刪、去客套；**§7 驗收報告版型 / §8 修正回覆版型（不@reviewer）** | 所有面向人的書面（verify post 驗收 → §7、iterate 修正回覆 → §8） |
| `commit-spec` | commit 規範：繁中 title / body、主動分段、type / scope / footer 留英文 | build · iterate（commit） |
| `pr-spec` | PR body 規範：as-built 設計書、`Closes #issue`、指派 `@me`、自動 merge master、edit-first | iterate（開 / 改 PR） |
| `pr-feedback-sources` | 收 PR reviewer 回饋的來源：inline comment 要 `gh api`、reviewThreads resolution filter | iterate（type=fix） |
| `docs-policy` | 何時寫 `docs/<topic>.md` + 維護索引 + 何時更新 AGENTS / CLAUDE（docs = 教學非決策）+ Diátaxis 四型格式範本（家規＝減 Explanation、單一 feature 一份檔顯性分節） | build · iterate（收尾） |

## 5. 編排與進階模式（opt-in）

| reference | 處理什麼 | 主要用在 |
|---|---|---|
| `auto-mode` | opt-in 自動連跑：核准一次後連決策也用推薦帶過，危險 / 失敗 / P0 / 模糊仍硬停 | dispatch（`auto`） |
| `fleet` | opt-in 編隊：多 agent 各用不同策略 / 角度 → 投票 / judge panel 綜合 | explore · plan · verify（可選） |
| `automations` | `/loop` + `/schedule` 整合（背景連跑 / 排程觸發） | 進階自動化 |
| `journaling` | `loop.md` append-only 事件日誌格式 + resume 重建狀態協定 | 全程（進階段 append）· resume |

## 6. 工具 / 模板 / 上手

| reference | 處理什麼 | 主要用在 |
|---|---|---|
| `onboarding` | 文檔優先上手：先讀 repo 既有 onboarding 文檔再動手 | explore（第 0 步摸架構） |
| `adr-template` | 決策留痕 ADR 五欄模板：情境 / 選項 / 決定 / 理由 / 後果 | plan（決策留痕） |
| `task-template` | 可驗證任務模板：Description / Acceptance / Verification / Deps / Files / Scope + 「該再拆」四訊號 + 垂直切片 / risk-first / XS–XL | plan（拆任務） |
| `eval-harness` | 評測 harness 五路：scenario-checklist（`run-eval.mjs`，人工勾）＋ 確定性 oracle runner（`eval-oracle.mjs`，走 quality-gate 比對 failToPass/passToPass、positive-presence 永不假綠）＋ 跨 run 聚合/回歸 gate（`eval-metrics.mjs` record/check，含 `versions` 子命令依 scenario 版本分組追溯）＋ trajectory/process 規則比對（`eval-trajectory.mjs`，superset/subset/unordered/order，零 judge）＋ rubric judge（`eval-judge.mjs`，只評無 oracle 維度、judge-estimate 分軌不污染回歸曲線、不 spawn agent；**其校準/投票延伸** `eval-poll.mjs`＝Cohen κ 對人工金標 + PoLL 多 judge 投票聚合，純函式、不 spawn）。**橫切**：`eval-tags.mjs`＝tag 分組聚合 + eval↔verify 雙向互指（tags 為連結脊椎、task 加 version/verifyAxes、純函式）；`eval-passk.mjs`＝live-candidate 真 pass^k（無偏估計 C(c,k)/C(N,k)、候選重生留上層、純函式不 spawn、附協定 + 成本/沙箱邊界文件 `evals/live/README-protocol.md`）。**活流程**：`eval-panel.mjs`＝judge panel 組合膠水（import 組合 eval-judge+eval-poll，N verdict→PoLL 共識+金標 agreement、不 spawn）；`eval-runs.mjs`＝live-candidate spawn-oracle 膠水（spawn eval-oracle 評當前候選→append 一行 run，候選重生留上層、不 spawn workflow）；`eval-sandbox.mjs`＝live-candidate 容器化沙箱（第一層詞法 containment + 第二層容器隔離 policy/指令建構器〔network none/read-only/資源上限/cap-drop/no-new-privileges〕，CLI check/plan 建構+驗證不執行容器、真跑容器留 CI runtime、純函式不 spawn） | plugin 自評 |
| `eval-judge-rubric` | eval-judge 的鎖死評分卡（G-Eval 式）：無 oracle 維度（解釋/溝通品質）的 dimension / 1–5 刻度 / threshold / 鎖死 evaluation steps + 反偏誤紀律 + verdict 輸出格式 | eval-judge agent（無 oracle 維度評分） |
| `eval-judge-panel` | judge panel orchestration recipe：主迴圈同回合派 N 異質 judge（反偏誤）→ verdicts.jsonl → `eval-panel.mjs` 共識；累積後 `eval-poll kappa` 校準。**派 judge 留上層、膠水不 spawn** | eval Phase 3 活流程 |
| `eval-live-candidate` | live-candidate orchestration recipe：每 task 獨立重生 N 候選 → 覆寫進 task workspace → `eval-runs.mjs record`（spawn oracle 收 run）→ `eval-passk` 真 pass^k。**候選重生留上層、膠水不重生不 spawn workflow**；成本/沙箱邊界引 `evals/live/README-protocol.md` | eval Phase 3 活流程 |

---

> **維護**：新增 / 改 reference 就更新本檔對應列；分類有變一併調整。與各 `SKILL.md` 的引用保持一致 —— 正本機制以 SKILL / reference 本身為準，這份是導覽。
