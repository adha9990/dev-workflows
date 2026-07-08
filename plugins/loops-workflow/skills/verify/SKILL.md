---
name: verify
user-invocable: false
description: Independently reviews built work for merge readiness — including whether the issue was actually done — and returns a Ready / Not ready verdict. Use when starting the verify stage of a loops-workflow run, or when completed work needs an independent review before iterate.
---

# verify — 驗證（5 步）

## 一句話

**選軸 → 並行審 → 驗 findings → acceptance 閘 → Ready/退回。** 派幾個 fresh-context 審查員、各審一軸、同一回合並行跑 → 去重 + 二輪確認 findings → 一道「有沒有做到 issue」的閘 → 判 Ready 或退回。用獨立複查抓 build 的盲點（寫 code 的假設不會帶進 review）。

> **verify 是安全網、不是第一道品質關**：品質在 build 就該邊寫邊做到位（shift-left）；build 寫到位 → verify 找得少、跑得快，但不能省（寫的人有盲點，獨立複查才補得到）。

## When to Use

build 完成、要 merge 前驗收。**不是**：還在寫 code（回 build）/ 報告已出要決定回環（去 iterate）。

## Process

### 1. 選軸 — 依改動風險定派幾個審查員

看 build 的 Change Summaries + 改動檔，照 `references/verify-triage.md` 的明文 rubric 定**核心軸下界**（**拿不準 / 混 code / 碰高風險一律向上升級**，fail-safe；右尺寸化只浮動下界、不是給 code 開後門）：

| 改動風險 | 核心軸（0~6） |
|---|---|
| **瑣碎**（純文件 / 格式 / test-only / 死碼 / SemVer patch） | **0**（有對外契約的文件才帶 `docs-devex`） |
| **小孤立 code**（少 caller、易回滾、有測試、單一領域） | **3**：`product-contract` + `code-quality`(correctness) + `tests` |
| **一般 code**（**預設**） | 核心 **6** |
| **高風險**（auth/加密/金流/DB migration/對外 API/並發/IaC，或波及面大、或大批 AI 生成 code） | 核心 **6**，**一律滿、不准縮**（碰高風險一律向上、不論行數多小） |

**再依領域加派 N 個 conditional**（與上表正交、碰到才加，清單見 `references/optional-reviewers.md`）：前端/UI→`frontend-ui`/`accessibility`/`web-performance`、bug fix→`root-cause`、docs/對外契約/CLI/config→`docs-devex`、schema migration→`migration`、queue/背景/長流程→`processing-reliability`、CI/CD→`ci-cd`、關鍵後端流程→`observability`。

**另外讀「專案宣告條件」= 枚舉專案憲章的所有跨切面約定、逐條核（以專案為主，必做，見 `references/project-conventions.md`）**：選軸時**除了看改動領域，也讀目標專案的 root + 就近 `AGENTS.md` / `CLAUDE.md`，枚舉其宣告的每一條跨切面約定**（i18n / logging / a11y / 錯誤處理 / 安全 / 分層 / 命名…），對**每個新 user-facing / 功能面逐條核是否遵守**——**且不得以「通過了某 lint/gate」當作滿足**（gate 常有掃描死角，如 i18n gate 只掃 JSX、不掃 `.ts` 常數；看**約定的精神**不只看綠燈）。命中領域派對應 conditional reviewer（i18n/文案→`frontend-ui`/`docs-devex`；logging→`observability`；a11y→`accessibility`；多人/併發→`multi-user-concurrency-reviewer`〔lost update / 跨帳號授權隔離 / 交易競態 / oplog 排序 / 冪等 / read-your-writes〕…），把「違反專案約定」當**可行 finding**（severity 依影響，**不因 issue 沒要求而降級或忽略**）。**專案沒宣告的約定就不觸發**（單人 / 本機專案不加無關噪音）；判準與擴充方式見 `references/optional-reviewers.md`〈專案宣告條件〉+ `references/project-conventions.md`。

> **名詞**：**波及面（blast-radius）**＝改動影響到多少別處（誰 import / 呼叫被改的）。非 code 的實質文件 / 設定（有驗收契約）走 `product-contract` + `docs-devex`，不套這張 code 級梯。

### 2. 並行審 — 同一回合派出、各審一軸、反偏見

**核心 6 軸 menu**（實際派哪幾個由步驟 1 定）：

| 審查員 | 審什麼 |
|---|---|
| `product-contract-reviewer` | issue 驗收 / 範圍 / 非目標（逐句對完工定義） |
| `code-quality-reviewer` | 正確性與狀態流（先於風格）/ 錯誤處理 / typing / 可讀與簡潔 / code smells / 重用 |
| `tests-reviewer` | 測試覆蓋 / 邊界 / 假綠（migration 歸條件式 `migration-reviewer`；**反偏見：不告知「作者說已過」**） |
| `architecture-reviewer` | 分層邊界 / import 方向 / 契約 / 內聚 / 設計模式適切性 |
| `security-reviewer` | auth/authz / 注入 / 敏感資料 ＋ 威脅建模（STRIDE / OWASP+LLM Top 10） |
| `performance-reviewer` | query / N+1 / index / transaction |

- **同一回合一次發出**所有 Agent call 才真並行；subagent 不能再派 subagent；維度**不排成序列**（順序化會交叉漏審 + 後者錨定前者偏誤；唯一的「先後」只剩 build 前那道便宜的 quality-gate：型別/lint/測試）。
- **反偏見**：只給 reviewer **artifact + 契約**（issue / `stages/02-plan.md` 契約 / diff），**不給作者的理由/辯護**（`stages/03-build.md` 的 concerns 不轉發）。
- **防 stale**：reviewer 審的是 build 剛寫、常在 worktree / 未提交的 code —— graph 對這塊最不可信。依 `references/code-retrieval.md`：graph 只查穩定周邊，改動檔一律讀實檔。（graph staleness 見該檔；**session 內 Read 快取 staleness**——改動過的檔不得拿舊讀推理、重讀該範圍——見 `references/context-diet.md` §C，兩者是不同 axis。）
- **跑真 app**：**先查目標專案的 `AGENTS.md`/`CLAUDE.md` 有沒有宣告專用的 run / verify / smoke skill 或啟動方式**（很多專案自帶「啟動並驅動這個 app」的 skill）—— 有就**優先用它實跑**，把宣稱從 `not measured` 變實測，別跳過；沒有才退到通用 `/run` 起服務 + `/verify` 逐條玩 `stages/00-goal.md` 需求 + 本機 `/code-review`（**不跑 ultra 計費版**）。純 lib 無 app 才據實標 `not measured`；宿主環境連這類 skill 都沒有時，以手動啟動指令替代或據實標 `not measured`。**有可跑的 app 卻直接標 `not measured` 是偷懶**——專案宣告了怎麼跑就要跑。跑測試／app 的輸出收斂依 `references/context-diet.md` §A（紅綠不對稱、截斷附落盤路徑）。
- **參考檔路徑（必做）**：subagent 讀不到相對路徑 → 從本 skill base 上兩層推出 plugin root，組**絕對路徑**塞進各 reviewer prompt：全 reviewer ← `reviewer-severity.md` + `review-dispositions.md` + `context-diet.md`（gh/git 篩欄、大檔範圍讀）+ `preflight.md`「作者已留痕的決定不算 finding」原文；`product-contract` ← `acceptance-review.md`；`code-quality` ← `correctness-review.md`/`clean-code.md`/`refactoring.md`/`code-simplification.md`/`reuse-check.md`；`architecture` ← `architecture-review.md`/`clean-architecture.md`/`design-patterns.md`；`security` ← `security-checklist.md`；`performance` ← `performance-review.md`；`tests` ← `test-rubric.md`；條件式各 ← 對應 review 檔（`ui-interaction-review.md`/`root-cause-review.md`/`docs-devex-review.md`/`multi-user-review.md`…）；`finding-validator` ← `finding-validation.md`。詳見 AGENTS.md〈參考檔路徑解析〉。
- **檢索接線**：派每個 reviewer 時，prompt 額外提供：①`references/code-retrieval.md` 的絕對路徑（orchestrator 從自己的 base directory 推出 plugin root 組絕對路徑，同既有 per-axis reference 做法；code-retrieval 管「要不要信 graph」、context-diet §C 管「讀後新鮮度與大檔範圍讀」，改動檔清單同時服務兩者）；②**本次改動檔清單**（reviewer 對這些一律讀實檔）；③ 若 repo 已索引，graph project id + 提醒「`detect_changes` 顯示這些 stale」。reviewer 依此用 graph 查穩定周邊、diff 讀實檔。
- **model / effort 動態（成本，見 `references/model-effort-policy.md`）**：reviewer 預設用各自 frontmatter tier（多為 `sonnet`）。**當步驟 1 判為高風險**：`security` / `architecture` / `code-quality`(correctness) 軸**改派其 `-deep` 變體**（`security-reviewer-deep` / `architecture-reviewer-deep` / `code-quality-reviewer-deep`，frontmatter 已 `opus`·`high`，做更深威脅建模 / 分層契約推敲 / 正確性與狀態流推敲；派 -deep 時注入與 base 相同的 per-axis reference）；**步驟 3 的 `finding-validator`（驗證者、非審查軸）亦改派 `finding-validator-deep` 做更嚴格二輪確認**；其餘高風險軸維持 base、以 `model: opus` per-dispatch 覆寫。瑣碎 / 一般維持 frontmatter 預設。effort 無法 per-dispatch，故高 effort 只能透過 -deep 變體達成。

### 3. 驗 findings — 去重 + 二輪確認

- **coordinator（主線）**去重、濾純 style / 低信心雜訊；併入本機 `/code-review` 的 findings。
- **finding-validator 二輪**：每個 blocking finding 確認 是否真實 / 是否本次引入 / 是否已被 caller·middleware·既有防護處理 / 修法是否對症 → `validated` / `rejected` / `degraded`（判準見 `references/finding-validation.md`）。

### 4. acceptance 閘 — 有沒有做到 issue（所有級通用）

**findings 全清 ≠ 做到 issue 要的每一件事**：步驟 2-3 問「有沒有引入問題」，這道閘問「**該交付的交付了沒**」，兩者正交、都不能省。判 Ready 前必過（任何 issue 都適用，只有無驗收契約的瑣碎改動不適用）：

acceptance 閘的核對單位優先用 **GWT 場景 ID（`S1…`，見 `references/bdd-scenarios.md`）**：逐條場景列五態（已滿足（有證據）/ 部分 / 缺失 / 證據不足 / 被反證），並對到實作該場景的測試（測試名帶 ID）。無場景的 issue 退回逐句 AC（既有行為）。

- **逐條勾稽**：`product-contract` 對 issue **每一條** acceptance criterion 列 `references/acceptance-review.md` 的五態（已滿足 / 部分滿足 / 缺失 / 證據不足 / 被反證）；每條要收斂到「**已滿足（有可信證據）**」或「**明確 descoped（作者在 plan/issue/PR 留痕）**」。任一條還停在 部分滿足 / 缺失 / 證據不足 / 被反證 且沒 descoped → **Not ready**，回 iterate。
- **做錯就整個退回**：若確證「**做的不是 issue 要的** / **核心沒做到卻當完工** / **最基本流程跑不起來**」→ 判 Not ready、**整個退回、不對其他 finding 逐條修**；由 **iterate 依「錯在哪」路由回對的階段**：解錯問題 / 方向錯 → **goal / explore**、設計或拆解缺陷 → **plan**、單純實作 bug → **build**（別在註定要重想 / 重做的東西上修小問題）。

### 5. 判 Ready / 退回 — 分級輸出

- 每個 finding 標 **P0–P2（P3 落 Non-blocking notes）+ Confidence(50/75/100) + Route**（見 `references/reviewer-severity.md`），先工程視角（哪檔哪行 + 機制 + 驗證）再使用者視角（什麼操作會踩到 + 看到什麼）；沒實跑標 `not measured`（**Metric-Honesty**）。
- 主線 merge 成 **Ready / Not ready** 寫 `stages/04-verify.md` + 摘要，**直接進 iterate**（routine 不問）；**只有出 P0** 才停下用 `AskUserQuestion` 問（先修 / 接受風險 / 看細節）。
- **回環再驗（delta re-verify）**：iterate 修完回來，聚焦「改了什麼 + **波及面**（誰用到被改的）」再派 fresh reviewer 驗一輪 —— 不是只重跑 diff、更不是只看測試綠；改到共用元件要把 consumer 一起納入。修完一律再驗，是 closed-loop 預設、不是選項。

> 要把結論 post 成 PR/issue comment（給人審）→ 套 `references/comment-policy.md` §7 版型（tmp 草稿、送出後刪）。送審前自檢（單一送審判定 + 「作者已留痕的決定不算 finding」硬規則）見 `references/preflight.md`。

## Red Flags

- reviewer 不是同一回合並行派出（變序列、互相污染）。
- 含 code 的改動縮到該風險級以下（拿不準 / 混 code / 碰高風險一律向上升級，縮錯＝漏審）。
- 把品質維度排成順序 gate（先 A 過再跑 B）—— 維度要並行，唯一先後只剩 build 前的 quality-gate。
- 碰 auth / migration 等高風險硬閘卻按瑣碎 / 小孤立級縮軸（「小 ≠ 安全」，2 行可釀數月漏洞，一律高風險 6 核心滿派）。
- tests-reviewer 被餵「作者說已過」；或把作者辯護餵給 reviewer 當框架（只給 artifact + 契約）。
- blocking finding 沒過 finding-validator 就進報告；或出現未實測的效能 / 覆蓋率數字。
- 判 Ready 卻沒對 issue 逐條勾稽 acceptance（findings 清完 ≠ 做到 issue）。
- 確證「根本做錯」卻還對其他 finding 逐條修，而非整個退回（交 iterate 路由回 goal/explore/plan/build）。
- 連 2+ 輪 reviewer 都出 substantive finding 卻 **0 條 actionable** = 在背書不是審查（rubber-stamp），停下重看 validator 是不是把該修的都 rationalize 掉了。
- **改動新增 / 動到 `docs/<topic>.md` 卻沒派 `docs-devex`（用 mainline 自查頂替）** —— 教學文檔的**自足品質**（引用 issue/PR 號、塞「現狀與後續 / Phase X 已交付 / 後續 follow-up」狀態段、把限制寫成進度、不白話 / 寫給已懂的人）會整個漏審，拖到人類 reviewer 才抓（見 `references/docs-devex-review.md §四`）。**docs 有增/改 ＝ 必派 `docs-devex`，不 mainline 自查頂替。**

## Verification

- [ ] **步驟 1**：依風險定軸（瑣碎 / 小孤立 / 一般 / 高風險），拿不準 / 混 code / 碰高風險向嚴升級。
- [ ] **步驟 1（專案約定）**：已讀專案 root + 就近 `CLAUDE.md`/`AGENTS.md` 枚舉跨切面約定，對每個新 user-facing / 功能面逐條核（不以通過機械 gate 當滿足），違反者當可行 finding（見 `references/project-conventions.md`）。
- [ ] **步驟 2**：同一回合並行派出、各一軸；只給 artifact + 契約（不給作者辯護）、tests-reviewer 不被告知已過；跑真 app + 本機 `/code-review` 或據實標 `not measured`；參考檔絕對路徑（含 `context-diet.md`）+ `code-retrieval.md` 路徑 + **本次改動檔清單（含 stale 提醒）**已塞進 reviewer prompt。
- [ ] **步驟 3**：coordinator 去重後，每個 blocking finding 有 finding-validator 結果。
- [ ] **步驟 4**：acceptance 閘 —— 每條 criterion 收斂到 已滿足（有證據）/ 明確 descoped（留痕）才判 Ready；確證根本做錯 → 整個退回（交 iterate 依錯在哪路由 goal/explore/plan/build）。
- [ ] **步驟 5**：每條 finding 有 P0–P2（P3 落 Non-blocking notes）+ Confidence + Route + Metric-Honesty；結論 Ready / Not ready 進 iterate（只 P0 才停下問）；回環修完再驗一輪。
