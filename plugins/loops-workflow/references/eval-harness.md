# eval harness（階段行為評估）

> 進階：用一組**情境（scenario）+ baseline** 評估某個階段 skill 是否如預期運作。`scripts/run-eval.mjs` 驗證情境集結構（≥3 + baseline）並印出可逐條跑的 checklist。**選用**。

## scenario 檔格式（JSON）

```json
{
  "stage": "dispatch",
  "baseline": "使用者直接喊對應階段（不經 dispatch），結果應與 dispatch 路由一致",
  "scenarios": [
    { "name": "issue 號", "input": "做 issue #5", "expect": "判 issue → 從 goal 起、建 loop.md、停在 gate" },
    { "name": "設計問題", "input": "設計一個範例功能 X", "expect": "判 design → 從 explore 起" },
    { "name": "PR 修正", "input": "PR #12 reviewer 給回饋了", "expect": "判 fix → 從 iterate 起" },
    { "name": "模糊", "input": "幫我看一下這個", "expect": "停下來問使用者（不亂猜）" }
  ]
}
```

每個 scenario：`name` / `input`（餵給階段的輸入）/ `expect`（可觀察的預期結果）。至少 **3 個 scenario + 1 個 baseline**（baseline = 對照組，沒有它無法判斷「對的原因」）。

## 跑

```bash
node plugins/loops-workflow/scripts/run-eval.mjs <path-to-scenarios.json>
```

它**不會自動呼叫 Claude**（那要在 Claude Code 裡實跑），而是：驗證情境集結構合格 → 印出一張逐條 checklist（input / 預期 / 待填實際 / pass?），讓你或 agent 實跑後勾。套 Metric-Honesty：沒實跑的格子標 `not run`，不要假裝跑過。

## 用途

- 改了某階段 skill 後，跑同一組 scenario 確認沒退化（regression）。
- 比較兩版 skill：同情境集、看哪版 expect 命中率高。

---

# oracle-based runner（E1，可執行 oracle，零 judge）

> 上面的 scenario-checklist 是**人工/agent 勾**的雛形；這一節是**確定性**的 oracle 路線（issue #27）。兩者平行：scenario 適合「沒有可執行 ground truth、得人判」的階段；oracle runner 適合「能用測試轉綠/exit 0 判」的成果。**oracle-first, judge-last**——能 oracle 就不用 judge。
>
> `scripts/eval-oracle.mjs` 是**確定性評分引擎**：它**不呼叫 Claude**（候選產出由外部步驟/agent 提供），而是把「一個候選 workspace」透過既有 `scripts/loops-quality-gate.mjs`（不重造 oracle）取得結構化 gate 結果，比對 task 的 `failToPass`/`passToPass` test 清單 → 算 pass/fail。SWE-bench 式：FAIL_TO_PASS（改後該綠）+ PASS_TO_PASS（既有綠不准轉紅）。

## task 檔格式（`evals/<stage>/<id>.json`）

```jsonc
{
  "id": "build-add-function",                     // 唯一
  "stage": "build",                                // 階段（供分類）
  "description": "實作 add() 使既有失敗測試轉綠",
  "workspace": "../fixtures/build-add-function",   // 相對本檔的候選 workspace（fixture）
  "oracle": {
    "failToPass": ["add returns sum"],             // 改後該綠的 test 名（改前應 fail）
    "passToPass": ["sub returns diff"]             // 既有綠、不准轉紅的 test 名
  },
  "version": "1.0",                                // E6：scenario 版本，改了能追溯舊 run
  "tags": ["regression", "build"],                 // E6：聚合分組鍵 + eval↔verify 連結脊椎
  "verifyAxes": ["tests"]                          // E6：此 eval 關聯的 verify 軸（crossLink 用；省略則僅靠 tags）
}
```

## result（runner 輸出，per task）

```jsonc
{
  "id": "build-add-function", "stage": "build", "pass": true,
  "errored": false,                  // gate 沒跑該 suite、或某 required test 沒被觀察到 → errored:true, pass:false
  "failToPass": { "required": ["add returns sum"], "passed": ["add returns sum"], "missing": [], "unobserved": [] },
  "passToPass": { "required": ["sub returns diff"], "passed": ["sub returns diff"], "missing": [], "unobserved": [] },
  "gateStatus": "passed",            // 取自 quality-gate（passed/failed/not-run/errored）；取不到時為 null
  "reason": "all required tests passed"
}
```

aggregate：`{ total, passed, failed, tasks: [...] }`；`failed > 0` → **exit 1**（當 gate）。`errored` 計入 `failed`（非 passed）。

## 判定規則（不變量）—— positive-presence，永不把「沒驗到」當通過

- 一個 required test 名分三態（對照 quality-gate 的 `passedTests` 與 `failures`，皆用 titlePath「完全相等 或 ` > <名>` 結尾」比對）：
  - **inPassed**（出現在 `passedTests`）→ 算通過。
  - **inFailed**（命中某 `kind==='test'` failure）→ 算失敗（failToPass＝沒轉綠 / passToPass＝回歸），入該組 `missing`、`pass:false`、但 `errored:false`（合法失敗）。
  - **unobserved**（既不在 passedTests 也不在 failures）→ 該 test **沒被驗到** → task `errored:true、pass:false`。**這就是「永不把沒驗到誤判為通過」的實作**——只靠「不在 failures」反推會把打錯字/被改名/不存在的 test 名當成綠，故改為要求**正面出現在 passedTests** 才算 pass。
- gate `not-run` / `errored` / 取不到 JSON → 整 task `errored`。`truncated` 時 unobserved 一律保守判 errored。
- `pass`＝gate 有跑 且 無 unobserved required 且每個 required 皆 inPassed。
- 安全：runner **不收 task 自帶 shell 命令**，oracle 固定走 `loops-quality-gate.mjs`（無注入面）；`task.workspace` 解析後須落在 **plugin 專案根**內，越界（`../` 逃逸 / 絕對路徑）→ errored、不 spawn。
- ⚠️ **信任邊界（執行）**：跑語料庫＝以當前權限執行各 workspace 的 `scripts.test`（任意程式碼）。**只在信任來源的 corpus 上跑**，勿對外來/未審的 corpus 直接 eval。
- ⚠️ **oracle 完整性（候選不可改 test）**：positive-presence 把 `passedTests` 當「該 test 真的通過」的證據，但那是跑**候選 workspace 自己的 test** 產生的。若候選能改 test 檔，它可塞一個必過的同名 test 偽造 `failToPass` titlePath → 假綠。**corpus 必須自擁/釘死 failToPass/passToPass 的 test 定義、候選只能改實作**（如 SWE-bench 在候選碼上套信任的 test patch）；否則 oracle 結果可被 game、不可當 ground truth。
- 註：`task.workspace` containment 用詞法 `resolve` 比對（非 `realpath`）——對「信任 corpus 內一筆惡意 workspace 字串」的威脅模型足夠；symlink 逃逸需對信任 repo 有寫入權（已等同可執行 `scripts.test`），故 E1 不另做 realpath，為刻意取捨。
- 與 `references/quality-gate-schema.md` 的 `Failure[]` / `passedTests` / `classifyGate` 對齊。

## 跑

```bash
node plugins/loops-workflow/scripts/eval-oracle.mjs --dir plugins/loops-workflow/evals/build [--task <id>] [--json]
```

> E1 只出 **per-run 報告**；跨 run 聚合 + pass@1/pass^k + 回歸 gate 是下節（E2）。

---

# E2 — 跨 run 聚合 + 回歸 gate（`eval-metrics.mjs`）

> 把 E1 的單次 corpus pass/fail 變成**跨 run 可比較 + 退化偵測**。複用 `hooks/cost-tracker.mjs` 的 append-JSONL 模式（純函式 buildRow + 薄 IO append）；**不重碰 eval-oracle**（spawn 它 `--json` 取數）。

## eval-results.jsonl（一行 = 一次 record）

```jsonc
{ "ts": "<ISO>", "corpus": "evals/build", "schema": 2,
  "runs": 1, "total": 5, "passed": 5, "failed": 0, "errored": 0,
  "passRate": 1.0,    // pass@1 = passed/total
  "passK": 1.0,       // 見下「pass^k 誠實邊界」
  "versions": ["1.0"] }  // E6/#51：該 run 各 task scenario version 去重排序摘要（無→[]）
```

落點 `<cwd>/.loops/.metrics/eval-results.jsonl`（沿用 #15 的 `.loops/.metrics/`，已 gitignore）。`errored ⊆ failed`（errored task 已計入 `failed`；`passed + failed === total`，errored 是 failed 的子集計數）。

### version 維度（跨 run 追溯，#51）
`buildEvalRow` 把 corpus 各 task 的 `version`（#34 起 oracle per-task passthrough）**去重排序**摘要成 `versions` 陣列寫進每筆 row（schema **v2** 起）。純函式 `summarizeVersions(tasks)`（無 version → `[]`）+ `groupRowsByVersion(rows)`（依 version 分組，一筆 row 含多 version → 進多桶；缺/空 versions 的舊 row 歸 `'(none)'` 桶、**不丟棄**）。CLI：`node eval-metrics.mjs versions [--metrics-file <path>]` 印各 version 的 `runs / avgPassRate`。**version 是附加維度，不進 `computeRegression`**——回歸主判準仍是 `passRate`，逐位元不受 versions 影響；舊 `eval-results.jsonl`（schema 1 無 `versions`）讀取/分組相容不炸。

## 回歸 gate

- `computeRegression(rows, { baseline, tolerance })` → `{ regressed, currentRate, baselineRate, delta, reason }`；`regressed = currentRate < baselineRate − max(0, tolerance)`（負 tolerance clamp 到 0）。
- **corpus-aware**：只在「最後一行的 corpus」的歷史子集內比（跨 corpus 不混比；同檔多語料庫安全）。
- baseline 預設 = 該 corpus 子集第一行（可 `--baseline <n>`）；tolerance 預設 0（任何下降即退化）。
- CLI `check` → 退化 exit 1、無退化 exit 0；**資料錯（讀不到 / 空 / 壞行）→ exit 0**（永不擋路）；**CLI 誤用（未知命令 / `record` 缺 `--dir`）→ exit 2**。record/check 遇基礎設施錯（spawn 失敗 / 寫檔失敗）仍 exit 0 但**印 stderr 診斷**（永不擋路 ≠ 永不出聲）。

## ⚠️ pass^k 誠實邊界

`pass^k`（同 task 跑 N 次連 k 次全綠率）量的是**隨機性下的可靠度**，只在「候選每次重新生成」時有意義。E1 runner 對**固定候選**跑確定性 oracle → 同 task N 跑必相同 → pass^k 退化成 = pass@1。故 MVP 記 `runs:1、passK=passRate`，schema 保留 `passK` 欄為日後「候選由 Claude 每次重生」預留。**回歸 gate 以 `passRate`（pass@1）為主判準**；勿把確定性 corpus 的 passK 當可靠度指標解讀。
> **真 pass^k 計算引擎已落地（見下 E7 / `eval-passk.mjs`）**：候選每次重生時用無偏估計 `C(passed,k)/C(N,k)` 算真 pass^k；把它接成 `eval-metrics` 的 `passK` 真值＝上層協定（本票給引擎 + 協定，不改 buildEvalRow）。

## 跑

```bash
# 跑一輪 corpus 並記一行（--metrics-file 可改輸出檔，預設 .loops/.metrics/eval-results.jsonl）
# 副作用（#49）：record 另把 per-task eval-report.json 落在 metrics 檔同目錄，供 LOOPS_EVAL_TAGS_GATE 的 by-tag 閘讀
node plugins/loops-workflow/scripts/eval-metrics.mjs record --dir plugins/loops-workflow/evals/build [--metrics-file <path>]
# 回歸判定（相對 baseline 退化 → exit≠0）
node plugins/loops-workflow/scripts/eval-metrics.mjs check [--metrics-file <path>] [--baseline <n>] [--tolerance <Δ>]
# 依 scenario 版本分組追溯（read-only，印各 version 的 records / avgPassRate；#51）
node plugins/loops-workflow/scripts/eval-metrics.mjs versions [--metrics-file <path>]
```

> MVP 交付為 CLI；自動掛回歸檢查已由 **#35 的 `eval-gate` Stop hook**（opt-in `LOOPS_EVAL_GATE`、改檔回合自動跑 `check`、退化注入）落地；`eval-results.jsonl` 由 `appendEvalRow` 內建 rotation（上限 1000 行）防無界成長。
>
> **多訊號 eval-gate（#49）**：同一個 Stop hook 另含兩條獨立 opt-in 訊號，共用「改檔回合（edit-accumulator）」前置、各讀已持久化 artifact、注入合併進單一 `additionalContext`、皆永不擋路（缺輸入檔/壞輸出/spawn 失敗 → 該訊號不注入、exit 0）：
> - **`LOOPS_EVAL_TAGS_GATE=1`** → 讀 `.loops/.metrics/eval-report.json`（per-task report，**由 `eval-metrics record` 持久化**：record 跑 oracle 時順手把 report 寫在 metrics 檔同目錄）→ `eval-tags by-tag` → 只注入**本次** `failed>0` 的 tag 類別（看哪類有 eval 失敗；讀 latest-overwrite 單份快照、非跨 run 頻率；全綠靜默）。
> - **`LOOPS_EVAL_POLL_GATE=1`** 且有 `.loops/.metrics/judge-results.jsonl`（上層 panel recipe 產）→ `eval-poll poll --score-method median` → 注入 judge panel 共識計數（judge-estimate advisory、非回歸 gate；無共識靜默）。
> 三 flag（GATE/TAGS/POLL）獨立、可組合；注入精簡（讀摘要非全量：tags 只列失敗類別、poll 只列計數）。

---

# E3 — trajectory / process 檢查（`eval-trajectory.mjs`，純規則、零 judge）

> 對 lifecycle 的**階段序列**做規則比對，抓「最終看似對、但流程走錯 / 漏階段」的退化（judge 維度走 E4）。observed 由 loop.md Journal 的 `[stage]` 標記抽出（箭頭展開、濾 `outcome`），對 committed reference 做四種比對。

## reference 格式（`evals/trajectories/<name>.json`）

`{ name, required[], optional[], allowed?[], order[], forbidden[] }` —— `required`＝不可跳的核心關卡；`allowed` 未給時退回 `required ∪ optional`；`order`＝核心關卡相對先後；`forbidden`＝不該出現的階段。committed：`evals/trajectories/issue-lifecycle.json`。

## 四種比對 + 判定

- **superset**（required ⊆ observed？）：漏關鍵階段（跳關卡）→ `missing` → **fail**。
- **subset**（observed ⊆ allowed？）：多餘步 / step efficiency → `extra` → **警示（不擋）**。
- **unordered**：集合等價（順序無關）。
- **order**：`reference.order` 的相對先後被破壞 → `orderViolations` → **fail**。
- **forbidden**：不該出現的階段出現 → **fail**。
- `ok` = 無 `missing` ＆ 無 `forbidden` ＆ 無 `orderViolations`（`extra` 不影響 ok —— subset 抓低效非錯誤）。

## 跑

```bash
node plugins/loops-workflow/scripts/eval-trajectory.mjs check --observed <loop.md> --reference plugins/loops-workflow/evals/trajectories/issue-lifecycle.json [--json]
```

exit code：**ok exit 0**（多餘步仍 0）、**漏/禁止/順序 exit 1**、**誤用（缺旗標）exit 2**、**reference/observed 讀取失敗或壞 JSON exit 3**（設定錯不偽裝成 eval 結果）。observed 解析只掃 `## Journal` 區段、且排除 markdown 連結 `[text](url)`（避免敘述行連結被誤抽成階段而遮蔽漏階段）。`allowed: []`（顯式空陣列）＝不判多餘步（要禁所有額外步請列具體 `allowed`）。`unorderedEqual` 為獨立 comparator（order-agnostic），checkTrajectory 本身用更嚴的 `order`。零 LLM judge、純 node。

---

# E4 — eval-judge（`eval-judge.mjs` + `agents/eval-judge.md` + `references/eval-judge-rubric.md`）

> E1–E3 都**零 judge**（oracle / 規則）。E4 補唯一缺口：**沒有可執行 ground truth 的維度**（解釋/溝通品質）。原則仍是 **oracle-first, judge-last**——能用測試轉綠 / exit 0 / 檔案存在判的**一律不用 judge**；judge 只評「人類讀者能不能看懂/據以驗證」這種無 ground truth 的東西。
>
> **混合架構**：`eval-judge.mjs` **不 spawn judge agent**（plugin script 無此能力）。LLM judge 的調用由**主迴圈 / Workflow** 在 eval/verify 流程**opt-in** 派 `agents/eval-judge.md`（像 verify 的 reviewer，複用反偏誤）；script 只做**離線可確定性測**的部分——驗 rubric、解析 judge verdict、門檻為準推導 pass、分軌、落檔。

## rubric（`references/eval-judge-rubric.md`，G-Eval 式鎖死步驟）
扁平 YAML frontmatter（機讀，`eval-judge.mjs` 驗）：`dimension` / `scale_min` / `scale_max` / `threshold` / `schema`；body 的 `## Evaluation steps` ≥3 條編號步驟（**鎖死**、judge 逐步照走防分數漂移）。`validateRubric` 驗：dimension 非空 ＆ 整數 scaleMin<scaleMax ＆ scaleMin≤threshold≤scaleMax ＆ stepCount≥3。

## verdict 解析 + 驗證（純函式，永不擋路）
- `parseVerdict(raw)`：tolerant 三段降級（**fenced 線性掃描、優先 ```json 標籤** → 直接 parse → 首個平衡 `{...}`）→ `{score, pass, reasoning, dimension?, parseOk}`；壞到底 `parseOk:false`（不丟例外）。score 僅接受真數字（字串/缺 → null）。
- `validateVerdict(verdict, {scaleMin,scaleMax,threshold,dimension})`：加 `scoreInRange`、`pass`（**門檻推導且須先界內 `scoreInRange ＆ score≥threshold`，覆蓋 judge 自報**——越界分數不可能 pass，把分數→pass 變確定）、`passMismatch`（自報非 null 且 ≠ 推導，留痕供 #33 κ 校準）、`dimension`（**rubric 為權威**）+ `dimensionMismatch`（judge 自報 ≠ rubric——dimension 是 #33 聚合分組鍵）、`valid`（parseOk ＆ scoreInRange）。

## 分軌（Metric-Honesty，核心不變量）
`buildJudgeRecord` 產的 record **硬帶 `track:'judge-estimate'`**（永不採信外部塞的 track）+ `judgeId`/`model`/`caseId`（forward-compat：`caseId` 供 E5 PoLL 分組 / κ 配對金標、其餘給陣列聚合）。落**獨立** `<cwd>/.loops/.metrics/judge-results.jsonl`（`appendJudgeRecord` append-then-rotate、cap 1000）。`partitionByTrack` 把 measured/judge-estimate 分開。
> **judge-estimate 絕不進 `eval-metrics.mjs` 的 `passRate` 回歸 gate**——那只讀 `eval-results.jsonl` 的確定性 oracle 結果。獨立檔 + `track` 標記 ＝ 零耦合零污染，**禁止把 judge record 寫進 eval-results.jsonl**。

## 跑
```bash
# 驗 rubric（config 不合法 exit 1、讀檔失敗 exit 3）
node plugins/loops-workflow/scripts/eval-judge.mjs validate-rubric plugins/loops-workflow/references/eval-judge-rubric.md
# 離線解析一份 judge 已產出的 verdict → 印 record + append judge-results.jsonl（advisory 永不擋路 exit 0）
node plugins/loops-workflow/scripts/eval-judge.mjs parse --rubric <rubric.md> --output <judge-out.json|-> [--judge-file <path>] [--judge-id <id>] [--model <name>] [--case-id <id>]
```
exit code：`validate-rubric` valid 0 / invalid 1 / 讀檔失敗 3；`parse` 產出 record 0（**含 verdict invalid——advisory 永不擋路、record 自帶 `valid` 誠實標**）/ 缺旗標·未知命令 2 / 讀檔失敗 3。

## 範圍邊界
本支只 **single-answer rubric judge**。**多 judge 投票（PoLL）+ Cohen κ 校準＝E5（已落地，見下）**；scenario 版本/tag + eval↔verify 銜接＝**E6（已落地，見下）**（version 跨 run 追溯 consumer＝#51，見 E2）；live-candidate 真跑＝#36。

---

# E5 — judge 校準（Cohen κ）+ 多 judge 投票（PoLL）（`eval-poll.mjs` + `evals/gold/*.json`）

> E4 的 judge 是**單一**評分；E5 補兩個**確定性聚合**能力：① 對人工金標量 **Cohen κ**（judge 與人工多一致）② **PoLL 異質 panel 投票**（N 個不同模型 judge 投票 > 單一大 judge，抗偏誤、便宜 ~7×）。**混合架構**：κ/投票是純函式（可測）；**panel fan-out（派哪幾個 judge）留主迴圈/Workflow（opt-in、`eval-poll.mjs` 不 spawn）**。皆在 E4 的 `judge-results.jsonl` record 陣列上聚合（靠 `caseId` 串）。

## 純函式
- `cohenKappa(labelsA, labelsB)` → `{kappa, po, pe, n, reason?}`：`κ=(po−pe)/(1−pe)`。不等長/空 → null；**無變異（1−pe=0）→ null + reason，不假裝 1**。`interpretKappa` 粗分 strong(≥.8)/moderate(≥.6)/fair(≥.4)/weak。
- `pollVote(values, {method})`：`majority`（眾數，**平手→null** 誠實標歧義）/ `median`（偶數取兩中位平均）/ `max`/`min`。空→null。
- `aggregatePanel(records, {key:'caseId', scoreMethod})`：依 caseId 分組 → 每組 `{caseId, panelSize, pass:majority, passTie, score:method, judges}`，**只計 `track:'judge-estimate'`**。
- `pairJudgeVsGold(records, gold)`：依 caseId 配 `gold[].id`（gold 帶 boolean `goldPass`）→ pass label pairs 餵 cohenKappa；無配對 → `unmatched`。

## 金標集（`evals/gold/<dimension>.json`）
陣列，每筆 `{id, dimension, artifactRef, goldPass:boolean, goldScore, note, provenance}`（`id` 對 judge record 的 `caseId`、是唯一連結鍵；`artifactRef`＝指向被評 artifact 的機讀欄；`provenance`＝`synthetic-anchor`/`self-annotated-baseline`/`human`，標金標來源）。**#50 已養到 62 筆**（6 抽象錨 + 56 真實 commit 訊息 artifact，附 `artifacts/explanation-quality.json` 文字快照 + `judge-results-demo.jsonl` 獨立盲標軌）→ 跑 `eval-poll kappa` 得 **κ=0.845（strong）**。**⚠️ 但這是 `self-annotated-baseline`（LLM 套 rubric 標）非獨立人工金標**：κ 量的是 **inter-LLM 一致性**（gold-annotator vs 獨立 judge-fleet 兩組 LLM）、**非 judge-vs-人類校準**——證明 pipeline 端到端可跑 + rubric 跨 LLM 穩定，**不證明 judge 對齊人類**。真人工金標（`provenance:human`）＝唯一待人類步驟、operational 交接（見 `evals/gold/README.md`）。**Metric-Honesty**：κ 是**估算**、標來源，非確定性權威；judge-estimate 軌不污染 oracle 回歸曲線。

## 跑
```bash
# judge 對人工金標的 Cohen κ（校準）
node plugins/loops-workflow/scripts/eval-poll.mjs kappa --records <judge-results.jsonl> --gold plugins/loops-workflow/evals/gold/explanation-quality.json
# 多 judge panel 投票聚合（per-case 共識）
node plugins/loops-workflow/scripts/eval-poll.mjs poll --records <judge-results.jsonl> [--score-method median|max|min]
```
exit code：產出 0（advisory 永不擋路）/ 缺旗標·未知命令·**未知 `--score-method`** 2 / 讀檔失敗 3。輸出含 `loaded/skipped`（揭露跳過的壞行數）。**`poll` 需 record 帶 `caseId` 才有意義**——缺 caseId 的 record 會被併為單一 null 群、印 stderr 警示。panel fan-out（派 N judge、各帶 `--case-id` 落 record）由上層做；`eval-poll.mjs` 只聚合。

## 範圍邊界
單票只交付**確定性聚合 + 金標 schema**。**真派 judge panel 的活流程＝Phase 3 已落地**（`references/eval-judge-panel.md` recipe + `eval-panel.mjs` 組合膠水：主迴圈派 N 異質 judge → verdicts → 共識 + 金標 agreement，累積後 `eval-poll kappa` 校準；膠水不 spawn、派 judge 留 recipe）。金標已由 **#50 養到 62 筆**（self-annotated baseline + κ=0.845 demo；**真人工金標**＝唯一待人類 operational 交接，見 `evals/gold/README.md`）。scenario 版本 tag + eval↔verify 銜接＝**E6（已落地，見下）**；live-candidate 真跑＝#36。

---

# E6 — eval↔verify 銜接 + scenario 版本/tag（`eval-tags.mjs`）

> **tags 是統一連結脊椎**：同一組 tag 同時驅動「跨 run 結果分組」與「eval↔verify 互指」——不造兩套機制。task 加 `version`（隨 oracle 報告 per-task 透傳；**跨 run 追溯 consumer 已由 #51 落地**——`eval-metrics buildEvalRow` 把它摘要成 `eval-results.jsonl` 的 `versions` 欄、可 `eval-metrics versions` 分組查詢，見 E2「version 維度」）+ `verifyAxes`（該 eval 關聯的 verify 軸）。

## 純函式（`eval-tags.mjs`）
- `groupByTag(items, {field:'tags'})` → `{tag: items[]}`（一 item 多 tag 各入組；無 tags 不入；`Object.create(null)` → `__proto__` 等 tag 名安全）。
- `summarizeByTag(results)` → `[{tag, total, passed, failed}]`（字典序、用 `pass===true`）——依 tag 看哪類最常退化。
- `crossLink(evalResults, verifyFindings, {onlyFailures:true})` → 依**共享 tag/axis** 雙向索引：eval key＝`(tags ∪ verifyAxes)`、finding key＝`([axis] ∪ tags)`、交集非空即連。`onlyFailures` 只取 `pass!==true` 的 eval（呼應「eval 失敗情境 ↔ finding」）。回 `{evalToVerify, verifyToEval}`。

## passthrough
`eval-oracle.mjs` 的 per-task 結果現帶 `tags/version/verifyAxes`（來自 task），讓 `summarizeByTag(report.tasks)` / `crossLink` 能直接吃 oracle 報告。

## 互指是純函式 + 慣例
`crossLink` 是可測純函式；**「verify 把 findings 寫到哪供 eval 讀」＝上層慣例**，本 script 不硬接 verify 流程。與 `eval-metrics` 回歸 gate 分離——tag 分組是另一個 cut，不動回歸主判準。

**上層怎麼接（findings JSON 形狀）**：verify 的原生 finding 是 markdown（`Severity/Confidence/Route/…`、無 `axis/id`）。上層把它序列化成 crossLink 吃的陣列時：
```jsonc
[ { "id": "<穩定引用鍵，互指輸出用>",          // 必填——否則 evalToVerify.findings / verifyToEval.findingId 變 null
    "axis": "<reviewer 軸名>",                  // product-contract|architecture|security|performance|code-quality|tests…（≈ Route）
    "tags": ["<沿用 eval task tags>"] } ]        // 選填，與 axis 一起當交集鍵
```
（`--findings` 須為**陣列**——把 oracle report 物件誤傳會 exit 2。）

## 跑
```bash
# 依 tag 聚合 oracle 報告（先 eval-oracle --json 產報告；<report.json> 自取暫存路徑）
node plugins/loops-workflow/scripts/eval-oracle.mjs --dir plugins/loops-workflow/evals/build --json > <report.json>
node plugins/loops-workflow/scripts/eval-tags.mjs by-tag --results <report.json>
# eval 失敗 ↔ verify findings 雙向互指（findings 為上述形狀的 JSON 陣列）
node plugins/loops-workflow/scripts/eval-tags.mjs link --eval <report.json> --findings <findings.json>
```
exit code：產出 0 / 缺旗標·未知命令·**findings 非陣列** 2 / 讀檔失敗 3。

## 範圍邊界
單票交付 schema 擴充 + 分組/互指純函式。**真把 verify 流程的 findings 持久化成檔讓 eval 自動讀＝留上層慣例**；不動 eval-metrics 回歸主判準；live-candidate 真跑＝**E7（已落地，見下）**。

---

# E7 — live-candidate 真 pass^k（`eval-passk.mjs` + `evals/live/README-protocol.md`）

> 解開 E2 的 pass^k 退化（固定候選 → pass^k≡pass@1）。**混合 framing**：`eval-passk.mjs` 只做**確定性 pass^k 計算**；「真跑 workflow 重生候選」屬**上層**（主迴圈/Workflow，opt-in、協定見 `evals/live/README-protocol.md`、**script 不 spawn**）。

## 純函式（`eval-passk.mjs`）
- `combinations(n,k)` → C(n,k)（乘法式 + round、k<0/k>n→0）。
- `passAt1(passed,total)` → 平均成功率（守除零）。
- `passHatK(passed,total,k)` → `{value, reason?}`：**無偏估計 `C(passed,k)/C(total,k)`**（一隨機 k-子集全綠的機率）；**k>total → null+reason（誠實不假裝）**；passed<k → 0。
- `aggregateByTask(runs,{k})` → 依 taskId 分組 → per-task `{total, passed, passAt1, passHatK}` + 整體 `{tasks, k, overallPassAt1}`。

## 為何 pass^k（抓「平均沒退、其實變不穩」）
pass@1 看平均、pass^k 看**隨機性下連 k 次全綠的可靠度**：4/5 的 pass@1=0.8 但 pass^2=0.6——pass^k 才抓得到「變更不穩」。回歸 gate **若要**量可靠度應看 pass^k（**本票尚未把 pass^k 接進 `eval-metrics` 回歸 gate**——gate 現仍以 passRate 為主判準，見 E2；接成 passK 真值＝上層協定，下段）。

## 接線是上層協定（script 不 spawn）
候選重生＝上層每 task 重跑 N 次（**獨立重生**才有意義，否則退化）→ 各跑 eval-oracle → 寫 `runs.jsonl`（`{taskId, pass, errored?, runIndex?}`）→ `eval-passk.mjs` 算。完整協定 + 成本/沙箱邊界見 `evals/live/README-protocol.md`。把 pass^k 接成 `eval-metrics` `passK` 真值＝上層協定（本票不改 buildEvalRow）。
> **活流程已落地（Phase 3）**：`scripts/eval-runs.mjs record`＝spawn eval-oracle 評當前候選 → append 一行 run（exit 0 / 缺旗標·未知命令 2 / **oracle 取不到·task 不在語料·append 失敗 3**，infra 錯不偽裝成 fail run；errored 候選記 `pass:false/errored:true` 並出聲）；可跑 recipe（重生→覆寫 workspace→eval-runs record→eval-passk）見 `references/eval-live-candidate.md`。候選重生仍留上層、eval-runs 不重生不 spawn workflow。

## 跑
```bash
node plugins/loops-workflow/scripts/eval-passk.mjs passk --runs <runs.jsonl> --k <k>
```
exit code：產出 0（含 k>total 的 task 標 null/reason、advisory 永不擋路）/ 缺 --runs·k 非正整數·未知命令 2 / 讀檔失敗 3。輸出含 `loaded/skipped`。

## ⚠️ 成本/沙箱邊界（見 protocol 文件）
真跑很貴（task 數 × N 重生 × 多 agent）→ 建議小語料庫 + N=3–5、只在量可靠度時跑。跑候選＝執行任意碼 → 沿用 eval-oracle 信任邊界（只在信任語料庫跑）。容器化沙箱實作 out-of-scope（本票只給邊界文件）。pass^k 為估算（N 有限），標來源。

---

# 活流程 — judge panel（`eval-panel.mjs` + `references/eval-judge-panel.md`，Phase 3）

> 把 E4 eval-judge + E5 eval-poll 從 standalone 引擎接成**可跑的活流程**：主迴圈派 N 異質 judge 評一份 artifact → 組合膠水算共識。**派 N judge＝上層 recipe（主迴圈/Workflow）**；組合 N verdict→共識＝`eval-panel.mjs`（**不 spawn**）。完整 recipe（含反偏誤三點、verdicts.jsonl 形狀）見 `references/eval-judge-panel.md`。

## 純函式組合（`eval-panel.mjs`）
`runPanel(verdicts, {rubricMeta, caseId, gold, ts})`：對每個 verdict（`{judgeId, model, output}`，output＝raw 文字）跑 `parseVerdict→validateVerdict→buildJudgeRecord`（複用 E4）→ **只把 valid 的 record 投票**（棄權語意：壞 verdict 計入 panelSize/落檔但不投票）→ `aggregatePanel`（複用 E5）出共識 → `{consensus, validCount, panelSize, goldAgreement, records, calibrationNote}`。**跨 case Cohen κ 校準＝既有 `eval-poll kappa`**（累積 judge-results.jsonl 後跑，不在 panel 重造、避免單 case κ 退化）。

## 跑
```bash
node plugins/loops-workflow/scripts/eval-panel.mjs run --rubric plugins/loops-workflow/references/eval-judge-rubric.md \
  --verdicts <verdicts.jsonl> --case-id <artifact-id> [--gold plugins/loops-workflow/evals/gold/explanation-quality.json] [--judge-file .loops/.metrics/judge-results.jsonl]
```
exit code：產出 0（advisory；rubric 不合法只警示不擋、report 帶 `rubricValid`）/ 缺旗標·未知命令 2 / rubric·verdicts·gold 讀檔失敗 3。輸出含 `skipped/validCount`。
