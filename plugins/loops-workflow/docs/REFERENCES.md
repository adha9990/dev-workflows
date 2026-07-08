# references 目錄（幫你找到「該讀哪份規範」）

> `references/` 是 loops-workflow 的「知識模組」：同一條規範只寫一份放這裡，各階段 skill / agent 用到時引用、不重抄。這頁把 **53 份 reference 依功能分 6 類**——每份一句「它管什麼、什麼時候會用到你」。
>
> 想看**流程全貌**（每階段怎麼跑）→ [`FLOW.md`](FLOW.md)；想看**可設定的參數** → [`settings.md`](settings.md)；這份是「規範字典」。（技術註：subagent 讀不到相對路徑，orchestrator 會把絕對路徑塞進 prompt——見 `AGENTS.md`〈參考檔路徑解析〉。）

---

## 1. 寫碼品質標準（寫的當下就要照做、審的時候拿同一份查）

> **同一份 reference、兩處套用**：build 寫 code 時就照著寫（impl-author）、verify 時 reviewer 拿同一份獨立複查——不是先寫爛再等人抓。見 `AGENTS.md` 規則 11。

| reference | 它管什麼 | 主要用在 |
|---|---|---|
| `clean-code` | 一行一函式怎麼寫才乾淨：命名要讓人看懂意圖、函式小而只做一件事、先擋錯誤（guard clause）、錯誤要顯式、型別當契約、不寫魔法數字 | build（impl-author）· verify（code-quality） |
| `clean-architecture` | 模組跟模組怎麼擺才不打結：依賴只指向內層、分層有邊界、外部能力走 port + 注入、新 code 放對位置；含 SOLID 與 DDD（Ubiquitous Language / Aggregate / BC）對齊 | plan（設計）· build（寫）· verify（architecture） |
| `design-patterns` | 什麼時候該用（跟不該用）GoF 設計模式——對症才引入，防「pattern 上癮」過度設計 | plan（選型）· build（refactor 引入）· verify（architecture） |
| `refactoring` | 看到什麼壞味道（code smell）→ 用哪個具名手法整理——Fowler 分類目錄 | build（Refactor step）· verify（code-quality） |
| `code-simplification` | 怎麼簡化才不會簡出 bug：改之前先懂為什麼這樣寫（Chesterton's Fence）、過度簡化四陷阱、清晰優先於精巧 | build（Refactor）· verify（code-quality） |
| `reuse-check` | 寫新方法前先確認沒有現成的：同詞根系列收斂成參數化、「稍微不同」不等於要另造一個 | plan（拆任務前）· build（寫前）· verify（code-quality） |
| `minimalism-ladder` | 動手加新東西前的最小主義階梯：需要做嗎 → 複用 → 標準庫 → 框架原生 → 已裝依賴 → 一行 → 最少代碼（author-time 防 over-build） | build（impl-author 動手前）· verify（code-quality / architecture 勾稽） |
| `security-checklist` | 不寫出漏洞的檢查表：威脅建模、STRIDE、OWASP / LLM Top 10、認證授權 / 輸入驗證 / 資料保護 | build（寫安全）· verify（security） |
| `test-rubric` | 測試怎麼寫才算好：四層測試怎麼分、能用真的就別 mock（Real > Fake > Stub > Mock）、金字塔 80/15/5、DAMP > DRY、data-layer 覆蓋清單 | build（test-author）· verify（tests） |
| `contract-spec` | 跨介面（API / 資料 / 事件）的契約怎麼寫、對到哪層測試；含 Hyrum's Law 提醒 | plan（跨介面才寫）· verify（product-contract） |

## 2. 各階段產出格式（schema）

| reference | 它管什麼 | 主要用在 |
|---|---|---|
| `goal-restate-schema` | 完工定義六欄格式（Outcome / User / Why now / Success / Constraint / Out of scope）；可附 BDD 場景 ID（S1…）綁 acceptance criterion | goal（`stages/00-goal.md`） |
| `bdd-scenarios` | 用 Given-When-Then 把需求寫成可驗證的行為情境（連接 SDD↔TDD）、場景 ID 慣例、依風險縮放（小事免寫·高風險才完整） | define · goal（寫場景）· build（test-author）· verify（product-contract · acceptance） |
| `design-plan-schema` | 設計書 §0–§9 骨架：系統全貌 / 檔案職責表 / 機制圖 / 具名背書 / 三角驗證 / 成果展示；§3 含 glossary | plan（`stages/02-plan.md`）· iterate（提煉 PR body） |
| `machine-plan-schema` | 機器可驗證的 `loops-plan` JSON 塊格式（每任務可執行 verification、acceptance ≤3、依賴無環） | plan（可選）+ `validate-plan.mjs` |
| `change-summaries` | build 產出的 Change Summaries 三段式格式 | build（`stages/03-build.md`） |
| `operation-first-move` | 依任務性質（new-feature/change-behavior/bug-fix/refactor）決定「紅燈第一步」怎麼起手＋fail-safe（單一來源） | dispatch（寫 `operation` 欄）· build（讀欄派 test-author） |
| `quality-gate-schema` | quality-gate 腳本輸出 / failures 結構化契約（`file:line [code\|ruleId] message`） | build（派 fixer 帶 failures）· verify（gate 摘要） |

## 3. 驗證與審查機制（verify 怎麼把關）

| reference | 它管什麼 | 主要用在 |
|---|---|---|
| `code-retrieval` | 查 code 的統一方法：graph 工具查穩定的周邊、剛改過的檔一律讀實檔不信快照（staleness 鐵則）、分支複用 base 索引 | explore · verify（所有 reviewer） |
| `context-diet` | 讓輸出從源頭就省 token：測試綠燈只留摘要、紅燈保 failure 全文＋skipped 必列、截斷必附落盤路徑、gh/git 先篩欄位、改過的檔重讀 | build · verify · explore · iterate · test-author · impl-author |
| `reviewer-severity` | 審查發現（finding）怎麼分級：P0–P3 嚴重度 + Confidence（50/75/100）+ 該路由給誰 | verify（全 reviewer） |
| `finding-validation` | 抓到的問題先過二輪四問（是真的嗎/這次引入的嗎/已有防護嗎/修法對症嗎）再算數——結論三態 validated / rejected / degraded，防誤報 | verify（finding-validator） |
| `preflight` | 送審前作者自檢：可送審 / 建議先修 / 資訊不足三態判定＋硬規則「作者已留痕的決定不算 finding」 | verify（送審自檢 + 全 reviewer） |
| `optional-reviewers` | 哪種改動要加派哪個領域 reviewer（前端 / a11y / 可觀測性 / CI-CD / migration / bug-fix / docs…）＋專案宣告條件（宣告多人使用→併發審查） | verify（1.5 加派） |
| `project-conventions` | **專案 CLAUDE.md/AGENTS.md 宣告的跨切面約定**（i18n / logging / a11y / 錯誤處理 / 安全…）是每條 loop 的隱含 DoD + verify 檢查項（issue 沒寫也要做）；通過機械 gate ≠ 滿足約定；完工交付列出「除 issue 外依約定額外做的事」 | goal（折 DoD）· plan（設計輸入）· verify（逐條核）· iterate（交付列出） |
| `verify-triage` | 這次改動風險多大、該派幾軸審查（0~6）：高風險硬閘清單 / 小事從簡的判準 / 夾帶無關改動就否決從簡（tangling veto）/ 「做錯東西就整個退回」判準 | verify（步驟 1 選軸判級） |
| `cross-model-review` | 卡關時換一個不同的模型當對手 reviewer（opt-in 對抗審查） | iterate（卡關）· verify（可選） |
| `model-effort-policy` | 成本控管：每個 agent 依角色配多大的模型／多深的思考，高風險任務才升級（表末附每個 agent 各配哪個 model 的逐一對照） | 全 agent（frontmatter）· verify · build |

**per-axis 審查判準**（每個 reviewer 出手前讀的「這軸要盯什麼」）：

| reference | 它管什麼 | 主要用在 |
|---|---|---|
| `review-dispositions` | 每軸 reviewer 的盯點清單＋共用的「這些不算問題」誤報底線 | verify（全 reviewer） |
| `acceptance-review` | 驗收怎麼驗才算數：先抓「做錯題」（P0 級）/ 每條驗收標準逐項給五態結論 / 完整性 gate（tier-independent、餵 verify 步驟 4 acceptance 閘）/ 端到端＋持久化 / 證據要多強 | verify（product-contract） |
| `correctness-review` | 正確性盯點：狀態流不變量 / 跨儲存部分失敗 / 冪等與 stale 覆寫 / transaction 正確性 | verify（code-quality） |
| `architecture-review` | 架構怎麼審：追契約同步 / import 方向 / 接線圖＋何時可降級從簡 | verify（architecture） |
| `performance-review` | 效能怎麼審：主張要附四件式證據 / 查詢計畫退化 / index / 分頁 / I/O 放大 | verify（performance） |
| `ui-interaction-review` | UI 交互閉環盯點：真的寫進去了嗎 / 假成功要回滾 / 快取同步 / 亂序 / 編輯 flush | verify（frontend-ui） |
| `root-cause-review` | bug 修得夠根本嗎：症狀 vs 病根 / 因果鏈 / 同類入口一起查 / 撤掉 fix 測試必須紅 | verify（root-cause，條件式） |
| `docs-devex-review` | 文件跟上了嗎＋PR body 的驗證證據夠不夠誠實 | verify（docs-devex，條件式） |
| `multi-user-review` | 多人同時用會不會壞：lost update / 跨帳號授權隔離 / 交易競態 / 排序 / 冪等 / read-your-writes | verify（multi-user-concurrency，**專案宣告多人才派**） |

## 4. 對外溝通與產出

| reference | 它管什麼 | 主要用在 |
|---|---|---|
| `outbound-templates` | 每型對外訊息（issue / plan 對齊 / 驗收 / 修正回覆 / PR body / 提問）對到哪個樣板＋共用 house-style | 經 `comment-policy` 委派（各階段先讀 comment-policy、由它指到本檔） |
| `comment-policy` | 對外書面總綱：繁中白話、雙視角、標推薦選項、tmp 草稿送出後刪、去客套；§7 驗收報告版型 / §8 修正回覆版型 | 所有面向人的書面 |
| `commit-spec` | commit 怎麼寫：繁中 title / body、主動分段、type / scope / footer 留英文 | build · iterate（commit） |
| `pr-spec` | PR body 怎麼寫：as-built 設計書、`Closes #issue`、指派 `@me`、自動併 master 進 branch 防落後、edit-first | iterate（開 / 改 PR） |
| `pr-feedback-sources` | 收 PR 回饋別漏掉：inline comment 要走 `gh api`、resolved 的要過濾 | iterate（type=fix） |
| `docs-policy` | 什麼時候該寫文檔、寫在哪、怎麼寫（含 AGENTS.md 的維護時機與寫作守門）；Diátaxis 四型範本 | build · iterate（收尾） |

## 5. 編排與進階模式（opt-in）

| reference | 它管什麼 | 主要用在 |
|---|---|---|
| `auto-mode` | 自動連跑：核准一次後決策用推薦帶過，危險 / 失敗 / 模糊仍硬停（開關見 `settings.md`） | dispatch（`auto`） |
| `fleet` | 編隊模式：多 agent 各用不同策略並行 → 投票 / judge panel 綜合 | explore · plan · verify（可選） |
| `automations` | `/loop` + `/schedule` 整合（背景連跑 / 排程觸發） | 進階自動化 |
| `journaling` | `loop.md` 事件日誌格式＋斷線後怎麼接回（resume 協定）＋**全部 hook flag 的決策表** | 全程（進階段 append）· resume |

## 6. 工具 / 模板 / 上手

| reference | 它管什麼 | 主要用在 |
|---|---|---|
| `onboarding` | 動手前先讀 repo 自己的上手文檔 | explore（第 0 步摸架構） |
| `adr-template` | 決策留痕 ADR 五欄模板：情境 / 選項 / 決定 / 理由 / 後果 | plan（決策留痕） |
| `task-template` | 可驗證的任務怎麼拆：Description / Acceptance / Verification / Deps / Files / Scope＋「該再拆」四訊號＋XS–XL 尺寸 | plan（拆任務） |
| `eval-harness` | 評測 harness 五路：scenario-checklist（`run-eval.mjs`，人工勾）＋ 確定性 oracle runner（`eval-oracle.mjs`，走 quality-gate 比對 failToPass/passToPass、positive-presence 永不假綠）＋ 跨 run 聚合/回歸 gate（`eval-metrics.mjs` record/check，含 `versions` 子命令依 scenario 版本分組追溯）＋ trajectory/process 規則比對（`eval-trajectory.mjs`，superset/subset/unordered/order，零 judge）＋ rubric judge（`eval-judge.mjs`，只評無 oracle 維度、judge-estimate 分軌不污染回歸曲線、不 spawn agent；**其校準/投票延伸** `eval-poll.mjs`＝Cohen κ 對人工金標 + PoLL 多 judge 投票聚合，純函式、不 spawn）。**橫切**：`eval-tags.mjs`＝tag 分組聚合 + eval↔verify 雙向互指（tags 為連結脊椎、task 加 version/verifyAxes、純函式）；`eval-passk.mjs`＝live-candidate 真 pass^k（無偏估計 C(c,k)/C(N,k)、候選重生留上層、純函式不 spawn、附協定 + 成本/沙箱邊界文件 `evals/live/README-protocol.md`）。**活流程**：`eval-panel.mjs`＝judge panel 組合膠水（import 組合 eval-judge+eval-poll，N verdict→PoLL 共識+金標 agreement、不 spawn）；`eval-runs.mjs`＝live-candidate spawn-oracle 膠水（spawn eval-oracle 評當前候選→append 一行 run，候選重生留上層、不 spawn workflow）；`eval-sandbox.mjs`＝live-candidate 容器化沙箱（第一層詞法 containment + 第二層容器隔離 policy/指令建構器〔network none/read-only/資源上限/cap-drop/no-new-privileges〕，CLI check/plan 建構+驗證不執行容器、真跑容器留 CI runtime、純函式不 spawn） | plugin 自評 |
| `eval-judge-rubric` | eval-judge 的鎖死評分卡（G-Eval 式）：無 oracle 維度的 1–5 刻度 / threshold / 鎖死步驟＋反偏誤紀律＋verdict 輸出格式 | eval-judge agent（無 oracle 維度評分） |
| `eval-judge-panel` | judge panel 怎麼編排：同回合派 N 個異質 judge（反偏誤）→ 共識；累積後 `eval-poll kappa` 校準。派 judge 留上層、膠水不 spawn | eval Phase 3 活流程 |
| `eval-live-candidate` | live-candidate 怎麼編排：每 task 重生 N 候選 → `eval-runs.mjs record`（spawn oracle 收 run）→ 真 pass^k。候選重生留上層、膠水不重生不 spawn workflow；成本/沙箱邊界引 `evals/live/README-protocol.md` | eval Phase 3 活流程 |

---

> **維護**：新增 / 改 reference 就更新本檔對應列；分類有變一併調整。與各 `SKILL.md` 的引用保持一致 —— 正本機制以 SKILL / reference 本身為準，這份是導覽。
