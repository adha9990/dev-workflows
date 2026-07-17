# 跨 session resume / journaling

> `.loops/<slug>/loop.md` 不只是儀表板，還是**可續跑的事件日誌**。把每個重要動作 append 進去，新 session 只要讀它就能重建狀態、接著跑 —— 不靠對話記憶。

## `.loops/<slug>/` 資料夾佈局（單一來源）

一條 loop 的所有產物**都放 `.loops/<slug>/` 底下、分兩層資料夾整理**（不要全平放）：

```
.loops/<slug>/
├── loop.md                 # 索引 + 事件日誌（Journal）——留在根、進出各階段都讀/寫它
├── stages/                 # 各階段的過程檔（帶編號、依流程順序）
│   ├── 00-goal.md
│   ├── 01-explore.md
│   ├── 02-plan.md
│   ├── 03-build.md
│   └── 04-verify.md
└── deliverables/           # loop 結束的收尾產出（無編號、完工才產）
    ├── explain.md          # 理解包（實作導讀 + ownership 自測 + 設計 recap）
    ├── checklist.md        # 合併前手動驗證 + 已知取捨確認清單
    └── cost.md             # 成本 / 規模輪廓（展開 outcome 度量）
```

- **`loop.md` 留在 loop 根**（不進子資料夾）——它是 resume 的唯一入口。
- **`stages/`**：goal/explore/plan/build/verify 各寫自己那份 `NN-<stage>.md`（帶編號＝流程順序、可排序）。
- **`deliverables/`**：iterate 完工才產、**無編號**（它們是最終交付、不是流程步驟）。完整迴圈**一律三份齊全**（見 `skills/iterate` §6）；修正型不產。
- **所有 loop 暫存與產出一律留 `.loops/`**，不塞進 PR/issue comment、不入庫（`.loops/` 應被 gitignore）。對外 comment 是另外先寫 tmp 草稿 post 的東西、不放 `.loops/`。

## loop.md 的 journal 區段

在 `loop.md` 末尾維護一個 **append-only** 的事件日誌（只加不改、保留順序）：

```markdown
## Journal（append-only）

- [E1] 進入 explore：讀 stages/00-goal.md，派 Explore 掃 codebase
- [E2] gate：explore→plan，使用者選「方案 B（擴充既有 SearchService）」
- [E3] 進入 plan：拆 4 任務，ADR-1 記選型
- [E4] gate：plan→build 拍板
- [E5] 進入 build：任務 1 Red→Green→commit a1b2c3d
- [E6] 回環 #1：verify 報 P1（缺 owner 過濾）→ 回 build
- ...
```

事件用**序號**（E1, E2…）排序，不用時間戳（跨工具 / 跨 session 時間不可靠）。每筆一行：**動作 + 結果 / 產物（commit SHA、選擇、回環）**。

## 完工 outcome 度量（完工 / 中止收尾時 append 一行）

loop **完工（或中止）收尾時**，在 Journal 末尾 append **一行** outcome 度量 —— 給每條 loop 留下可回顧、可比較的**成本 / 規模輪廓**，把 `AGENTS.md` 規則 10「成本意識」從**只有意識**落實成**可觀測**。一行、pipe 分隔、緊接最後一筆 E：

> 這行是 `loop.md` 索引裡的**一眼摘要**；完整迴圈完工另產 `deliverables/cost.md` 把它**展開**（各 stage token 粗估拆解、sub-agent 逐個、回環軌跡、findings 處置、交付物明細）。一行版與 `cost.md` 內容互補、同一組數字。

```text
- ★[outcome] <結果> ｜ token≈<粗估>(<級距>)est ｜ sub-agent <n> ｜ 回環 <n> 圈 ｜ findings <validated>→<剩餘> ｜ 交付：<交付物>
```

| 欄 | 寫法 | 說明 |
|----|------|------|
| 結果 | `完工` / `中止(descoped)` / `中止(aborted)` | 對應 loop.md「當前階段＝完工」 |
| token≈ | 估算：`≈120K(中)est` / `≈?(低)est`；實測：`≈127K(measured) ｜ $0.38` | **兩種來源、單一欄**：①**無 hook 實測** → 粗估或級距、必帶 `est`（級距：低 <100K／中 100–500K／高 >500K；無從估寫 `≈?(<級距>)est`）。②**有 cost-tracker 實測**（`.loops/.metrics/costs.jsonl` 有本 session 末行，見下）→ 改寫 `≈<總>K(measured) ｜ $<usd>`，總＝input+output+cache_creation+cache_read。**注意 `measured` 仍是「依 API 回報 usage 的估算」、非帳單權威**，且有兩個**方向相反**的偏差：寫死 rate table 無法表達 Opus >200K／1h-cache 2× 級距 → 偏**低估**；跨 `--resume` 對整份 transcript 重複加總 → 偏**高估**。Claude Code 不保證對 agent 暴露 per-turn token，故兩種來源都標明非精準（規則 5 Metric-Honesty）。 |
| sub-agent | `11` / `3(verify 2+validator 1)` | 本 loop 派出的 subagent 總數（test-author／impl-author／referee／verify reviewer／finding-validator／explore fan-out…），從 Journal 回推；純文件／主線直編 loop 可能為 `0`。 |
| 回環 | `0 圈` / `2 圈` | iterate 回環圈數（`0`＝一次過）。 |
| findings | `6→0` / `1→0` / `—` | verify validated blocking findings 數 → 收尾剩餘（理想 →0）；無 verify 標 `—`。 |
| 交付 | `PR #6 merged` / `descoped` / `issue backlog #7-9` / `文件 only` | 實際產物。 |

**鐵則**：不適用欄一律標 `—`，**不留空、不編造**；token 估算分支必帶 `≈`／級距／`est`，實測分支必帶 `measured`＋`$`、**兩種都不得宣稱精準值**（規則 5）。需要程式化彙總時日後再加 `--json`（不在預設）。

> **flag 預設值決策表（#87 逐 flag 明文拍板；語意單一真相源＝`hooks/hook-flags.mjs`：defaultOn＝僅字面 `'0'` 關、optIn＝僅字面 `'1'` 開，顯式設值一律向後相容。本表管「為什麼是這個預設」；使用者導向的「怎麼設定」見 `docs/settings.md`）**：
>
> | flag | 預設 | 一句理由 |
> |---|---|---|
> | `LOOPS_PATH_CONTAINMENT` | 開（#85） | 「嚴禁」級硬規範、已踩過坑 |
> | `LOOPS_COST_TRACKER` | 開（#87） | 零風險觀測、僅 `.loops/` repo 動作 |
> | `LOOPS_EVAL_GATE`/`LOOPS_EVAL_TAGS_GATE`/`LOOPS_EVAL_POLL_GATE` | 開（#87） | 無 artifact 即 no-op；不執行 repo 定義命令 |
> | `LOOPS_CONFIG_PROTECTION` | 開（#87，loops-scoped） | 防 AI 弱化 linter；`.loops/` 存在才生效、日常編輯零外溢 |
> | `LOOPS_WORKTREE_GUARD` | 開 | AGENTS 規則 9「主 checkout 不 checkout -b」機械化、已踩過坑 |
> | `LOOPS_COMMENT_GUARD` | 開 | comment-policy §6/§8（@點名/客套）機械化、對外 P0 面已出過包 |
> | `LOOPS_PR_GATE` | 開（#132） | loop 分支上「build 完先 verify／--draft+--assignee @me／Closes #issue」三閘機械化，換取合併前品質底線一致 |
> | `LOOPS_MERGE_GUARD` | 開（#133） | 「合併回主幹是 human gate」機械化，不限 loop 分支，四型合併類指令一律擋 |
> | `LOOPS_STOP_GATE` | **opt-in**（#87 評估後維持） | 開＝自動執行 repo 的 gate.config 命令（#17 RCE 面）；補發現性提示消滅資訊差 |
> | `LOOPS_LOOP_DRIVER` | **opt-in**（#99） | 家族首支 block hook——殺手鍵獨立性（要 auto 推進未必要機械續跑）；三層 opt-in（flag∧state∧auto 語意）為輔 |
> | `LOOPS_COMPACT_HINT` | **opt-in**（#87 評估後維持） | 非已踩過坑對治、價值中性 |
> | edit-accumulator（非 flag） | 隨消費端＋`.loops/` 存在前置（#87） | 非 loops repo 零 tmp 寫入 |
> | read-accumulator（非 flag，#131） | 隨 `LOOPS_COMMENT_GUARD`（其唯一消費端＝outbound-comment-guard read-gate） | 不做 `.loops/` 前置——讀規範檔這動作跟目標 repo 是否 loops 專案無關，任何 repo 都該記 |
> | `LOOPS_EXPLAIN`（skill 層 env、非 hook） | **已淘汰（無作用）** | explain 現為完整迴圈完工**一律產**的三份 deliverable 之一（`deliverables/explain.md`），不再由此旗標 gate（見 `skills/iterate` §6） |
> | `LOOPS_AUTO`（skill 層 env；loop-driver hook 亦直讀 `=== '1'`） | **opt-in** | 連跑推進是使用者意願、不預設替人決定——詳 `auto-mode.md` |
>
> **觀測 hook（#15；出錯一律 no-op exit 0、永不擋路；預設值逐列標示——#87 起 cost-tracker 預設開、compact-hint 維持 opt-in）**：
> - **`LOOPS_COST_TRACKER`**（cost-tracker，Stop hook；**預設開（#87）——僅字面 `'0'` 關**，顯式 `'1'` 向後相容；僅 cwd 可解析出含 `.loops/` 的主 repo 才寫入、與是否正在跑 loop 無關）：每個 assistant 回應結束把該 session 累計 usage append 一行到 **主 repo** `.loops/.metrics/costs.jsonl`（per-session **取該 session_id 最後一行**）。**落點錨定（P2）**：不看 cwd 有無 `.loops/`，而是把 cwd 解析成主 repo 根（worktree cwd 也寫回主 repo，對齊 §規則 9 的 `.loops` 錨定）——修好「worktree session 成本寫進 worktree `.loops`、會被清 / 分裂」。每行含 session 累計 **＋ `by_stage` 逐 loop-stage 拆解**（goal/explore/plan/build/verify/iterate…各自 token + `cost_usd`）。**子代理歸戶（P1，schema 3）**：額外掃 `<transcript>/<session>/subagents/agent-*.jsonl`，依角色（reviewer→verify / test·impl-author→build / design→plan / exploring→explore / 其餘→other-subagent）歸到對應 stage，掛在 `by_stage[].subagent`＋頂層 `subagents` 聚合＋`total_cost_usd`（主線+子代理）——**補上 verify / iterate 等幾乎全是 fan-out 子代理的階段成本**（主 transcript 本來看不到，故舊版 verify 常顯示接近 0）。無子代理則維持 schema 2。收尾若該檔有本 session 行→實測分支，否則（未開 flag／無此檔）→估算分支。footprint：主 repo `.loops/.metrics/costs.jsonl`（已被 `.loops/*` gitignore）。**限制**：① `by_stage` 主線部分按 Skill 邊界切，最後一個 stage 之後的收尾雜項會續記在該 stage 名下；② 子代理歸角色靠 prompt 關鍵字，無法辨識者落 `other-subagent`（不遺失、只是未細分）；③ per-turn 加總 `cache_read` 會高估絕對值（分佈 / output tokens 較可信）。
> - **`LOOPS_COMPACT_HINT=1`**（suggest-compact，PreToolUse matcher `Edit|Write`；**維持 opt-in（#87 決策：非已踩過坑對治、注入有輕噪音、價值中性）**）：估算真實 context 大小（transcript 最新 usage）跨門檻（~250k、之後每 +60k）時，在 Edit/Write 前注入一句「可考慮 `/compact`」**估算**提醒（**不阻擋**工具）；防洗版 state 落 `os.tmpdir()/loops-compact-<session>.json`、14 天 TTL。footprint：tmp state 檔。
> - **read-accumulator**（PostToolUse matcher `Read`；**非 flag——隨 `LOOPS_COMMENT_GUARD`〔其唯一消費端＝outbound-comment-guard 的 read-gate〕開關，#131**）：純記錄，不做任何 `.loops/` 前置判斷（讀規範檔這件事跟目標 repo 是不是 loops 專案無關）。命中兩份受管規範檔之一（`comment-policy.md` / `outbound-templates.md`，basename **精確**比對、大小寫不敏感、`/` 與 `\` 皆視為分隔符）→ 去重累積進本 session 的 state 檔；其餘檔案不記、不建檔。footprint：`os.tmpdir()/loops-reads-<session>.json`。**已知限制**：Read 落盤與後續 Bash 對外指令之間沒有跨行程的嚴格排序保證——理論上兩者「幾乎同時」發生時有極短暫時序落差的可能，但 Claude 的操作序一律是先讀檔才照著寫 comment，實務上落盤必然先於後續呼叫；即便真的踩到，read-gate 頂多多擋一次（要求重讀一次）而不會誤放行——**最壞情況是惱人，不是有害**。
>
> **outcome 度量格式以此為單一來源**，各 skill（iterate §6）引用此處、不另定義。

> **介入 hook（會主動跑閘 / 擋工具，與上面「觀測」不同；預設值逐列標示——#87 起 stop-gate 維持 opt-in（SECURITY）、#99 loop-driver opt-in（首支 block hook），#85 loops-path-guard 與 #87 config-protection 預設開）**：
> **命令類 guard（攔 shell 指令的 PreToolUse）matcher 一律 `Bash|PowerShell`**——Windows 主 shell 是 PowerShell、只掛 Bash 等於半失效（#130）。
> - **`LOOPS_STOP_GATE=1`**（stop-gate，Stop hook + edit-accumulator PostToolUse；**維持 opt-in（#87 決策：預設開＝自動執行任意 repo 的 gate.config.json 命令，#17 security review 明點 RCE 面、信任不可機械判定）**）：**本回合有改檔**時（PostToolUse accumulator 記錄）於 Stop 自動跑既有 `loops-quality-gate.mjs --gates type,lint`，**只有紅燈才把摘要注入 context**（綠靜默、不阻擋）。需 cwd 有 `.loops/gate.config.json`。**發現性提示（#87）**：flag 未開但偵測到 gate.config.json 存在 → per-session 一次注入一行提示（含 `LOOPS_STOP_GATE=1` 與「信任 repo 才開」語；state 檔 `os.tmpdir()/loops-stop-gate-hint-<session>.json`）。footprint：`os.tmpdir()/loops-edits-<session>.json` 暫存＋提示 state 檔。
>   - ⚠️ **SECURITY：啟用＝授權「在每個改檔回合自動執行 `.loops/gate.config.json` 內定義的 `lint`/`type` 命令」（以及偵測到的 lint/test 工具）。這些命令來自 repo、等同自動執行 repo 控制的 code。請只在你信任的 repo 開此 flag。** 風險本就存在於手動跑 quality-gate；本 hook 把它變成自動，故格外提醒。
> - **`LOOPS_CONFIG_PROTECTION`**（config-protection，PreToolUse matcher `Write|Edit|MultiEdit`；**預設開（#87）且 loops-scoped**——未設 env 時僅 `payload.cwd` 下存在 `.loops/` 才生效（作弊風險集中於 loops 執行、日常編輯零外溢）；顯式 `'1'`＝全域生效（既有行為）；僅字面 `'0'` 關）：偵測對既有 linter/formatter 設定檔（eslint/prettier/biome/ruff…）的**修改**→ `permissionDecision:"deny"` 擋下並提示「修 code 別弱化設定；設 `LOOPS_CONFIG_PROTECTION=0` 可關」；**新建**設定檔放行、非設定檔放行。出錯 **fail-open（放行）**。footprint：無持久檔。
> - **`LOOPS_LOOP_DRIVER=1`**（loop-driver，Stop hook 家族**末位**；**opt-in（#99）——家族首支會 block 的 hook**）：build 執行迴圈外置——`$LOOPS_ROOT/.loops/<slug>/state.json`（tasks[] 任務複本＋status 單欄真相源）存在、session/stage 匹配、auto 語意成立（`progressionMode:auto` 或 `LOOPS_AUTO=1`）且未完工時，Stop 回 `{"decision":"block","reason":<下一任務塊+git status 半成品前置+推進契約>}` 機械續跑。四道防護：`stop_hook_active` 防重入／iteration 保險絲（雙路 +1、觸發後冪等放行）／`awaitingApproval` 使用者閘／atomic 寫+updatedAt 寫前複查（單 writer 前提；非真 CAS）。完工雙帳本：all-done ∧ quality-gate 結構化判定（**test not-run 一律降級「弱帳本」**、已跑紅→block、綠→刪 state 收攤；timeout 300s fail-open）。孤兒 state（跨 session）＝惰性無害、同 slug 重跑接管、可手刪。footprint：state.json（gitignored `.loops/*`）。
>   - ⚠️ **SECURITY：啟用＝授權「build 完工判定時自動執行 `.loops/gate.config.json` 定義（或自動偵測）的 test/lint/type 命令」——執行面比 stop-gate（僅 type,lint）更寬（含 test）。這些命令來自 repo、等同自動執行 repo 控制的 code；且 block reason 會把 state.json 的任務文字注入 context（已消毒＋框定，防護是降低而非消除）。請只在你信任的 repo 開此 flag。**
> - **`LOOPS_PATH_CONTAINMENT`**（loops-path-guard，PreToolUse matcher `Write|Edit|MultiEdit`；**預設開（#85，plugin 唯一 opt-out 介入 hook）——只有字面 `'0'` 會關**，`false`/空字串/未設一律維持啟用）：Write/Edit/MultiEdit 目標路徑落在 `.claude/worktrees/**/.loops/**`（詞法判定：resolve 收合 `..`、大小寫折疊、段完全相等比對）→ `permissionDecision:"deny"`＋指引正確落點 `$LOOPS_ROOT/.loops/<slug>/`——把 AGENTS 規則 9「.loops 嚴禁寫進 worktree」（已踩過、毀 audit trail）機械化。出錯 **fail-open（放行）**。已知限制：不解析 symlink（熱路徑零 I/O 取捨）。footprint：無持久檔。
>   - ⚠️ **SECURITY／繞過**：deny 訊息附逃生口——確需在 worktree 寫 `.loops`（不應發生）時設 `LOOPS_PATH_CONTAINMENT=0` 暫時關閉；此 hook 只攔 Claude 的寫檔工具呼叫，不攔 shell/node 直接 fs 寫入（已核對：現行無任何 hook 寫 worktree .loops）。
> - **`LOOPS_WORKTREE_GUARD`**（worktree-guard，PreToolUse matcher `Bash|PowerShell`；**預設開——僅字面 `'0'` 關**；loops-path-guard 的姊妹規則，那管 `.loops` 落點、本 hook 管 code 落點）：Bash 指令是對**已建 loop**（cwd 祖先存在 `.loops/<slug>/loop.md`，往上最多 12 層）的 branch 做 `git checkout -b <slug>` / `git switch -c <slug>`，且 cwd **不在** worktree（`.claude/worktrees/` 段完全相等比對）→ `permissionDecision:"deny"`，導向 `git worktree add .claude/worktrees/<slug> -b <slug> <base>`，並註明 session／harness 的「work in place」設定不豁免本條。已在 worktree／非 loop branch／`git branch <name>`（只建不切）一律放行；確需繞過設 `LOOPS_WORKTREE_GUARD=0`。出錯 **fail-open（放行）**。把 AGENTS 規則 9「主 checkout 不 `checkout -b` loop branch」（已踩過坑：文字擋不住合理化）機械化。footprint：無持久檔。已知限制：只攔 Bash/PowerShell 工具呼叫的 git 指令（正則解析、不跨 `; & |` 邊界），不攔其他路徑建立 branch 的方式。
> - **`LOOPS_COMMENT_GUARD`**（outbound-comment-guard，PreToolUse matcher `Bash|PowerShell`；**預設開——僅字面 `'0'` 關**；**#131 v2**）：**覆蓋面**從「只管貼 comment」擴成五型對外發訊息指令——`classifyOutboundCommand` 分類成 `comment`（`gh pr/issue comment` 或帶 body 的 `gh api .../comments`）／`issue-create`／`pr-create`／`issue-edit`／`pr-edit`（後四型皆要求帶 body 參數才算，純改 label 等不受管）；非受管指令一律放行。命中受管指令依序過兩關：① **read-gate**——`payload.session_id` 存在時，查 `hooks/read-accumulator.mjs` 記錄的本 session 已讀 state：`comment` 型要讀過 `comment-policy.md`、其餘四型要讀過 `outbound-templates.md`，沒讀過 → `permissionDecision:"deny"`、指路去讀對應規範檔（絕對路徑、`import.meta.url` 推導）；**缺 `session_id`（舊呼叫形態／smoke）一律 fail-open 放行此關**，不影響下面的機械規則。② **機械規則**——抽出 body（inline `--body`/`-b`/`-F body=`，或檔案形式 `--body-file`/`-F body=@file` 讀檔）後跑 `findOutboundViolations`（**@ 點名人**排除 `@me`／scoped-package／email、**開頭客套**感謝／謝謝／多謝／thank you／thanks／thx——現在對全部五型都管，不只 comment）＋ `findFormatViolations`（**#131 新增三條**：去 code 後 prose 引用 `.loops/` 路徑或裸 `stages/0N-*.md` 檔名；raw body 含 U+FFFD 亂碼字元；去 code＋去 URL 後 prose ≥120 字元且 CJK 字數 <10〔疑似整段技術英文未轉譯，CJK≥10 一律放行不誤擋〕），任一命中 → deny 逐條列出違規原因。乾淨／抽不到 body 一律放行；確需繞過設 `LOOPS_COMMENT_GUARD=0`（同時關掉 read-accumulator 的記錄）。出錯 **fail-open（放行）**。把 comment-policy §0「不外洩 `.loops/` 路徑」／§6「不寫客套」／§8「不 @ 點名 reviewer」、以及「送出前先讀規範」（已出過包：手貼 comment 沒走 outbound 流程就沒載規則、整條漏掉）機械化。footprint：本身無持久檔——讀（不寫）read-accumulator 的 state 檔 `os.tmpdir()/loops-reads-<session>.json`。已知限制：只認得 `gh pr/issue comment`、`gh api .../comments`、`gh issue/pr create`、`gh issue/pr edit`（皆帶 body 參數）這幾種指令形態；@ 點名偵測靠正則（GitHub handle 英數+連字號、1–39 字），非涵蓋所有 edge case；body 若以 shell 變數／指令替換（`"$VAR"`／`"$(cmd)"`）組成，guard 檢查的是替換前的字面文字、不是展開後的實際內容；read-gate 與 read-accumulator 的落盤時序見上方 read-accumulator 條目——**最壞情況是惱人（多擋一次要求重讀），不是有害（不會誤放行）**。
> - **`LOOPS_PR_GATE`**（pr-gate，PreToolUse matcher `Bash|PowerShell`；**預設開——僅字面 `'0'` 關**；**#132**）：只在偵測到 `gh pr create` 且**當前處於某個已建 loop 的分支**時生效。**分支判定**兩段式、零 spawn `git`（皆詞法讀檔）：①cwd 路徑含 `.claude/worktrees/<slug>` 段 → slug（重用 worktree-guard 的 `extractWorktreeSlug`）；②否則讀 cwd 的 `.git`（檔案形 `gitdir: <path>` 指標、改讀該路徑下 `HEAD`，或目錄形直接讀 `.git/HEAD`）取 `ref: refs/heads/<branch>` → slug；裸 SHA（detached HEAD，無 `ref:` 前綴）判不出、放行。取得 slug 候選後反查 `.loops/<slug>/loop.md` 是否存在（重用 `findLoopRoot`，祖先上溯 ≤12 層——worktree cwd 剝 `.claude/worktrees/<slug>` 後綴到主根只需 3 層，天然在界內，不必另維護捷徑）確認「是已建 loop」，否則放行。命中後依序過**三閘**、任一不過即 deny、不聚合、後面的閘不再檢查：①`stages/04-verify.md` 不存在 → deny（build 完必先過 verify）；②指令缺 `--draft` 或缺 `--assignee @me`（值須字面 `@me`，指派別人不算）→ deny 附完整補救指令；③slug 匹配 `^(\d+)-`（issue 編號開頭）時，PR body（`--body`/`--body-file`，重用 `extractCommentBody`＋`makeHardenedReadFileSafe`，經 `stripCode` 去 code span/fence 後）沒有獨立一行、行首純文字 `Closes #<issue#>` → deny（**刻意比 GitHub 實際解析更嚴**的 house rule：換版型一致＋零解析歧義；design slug 無數字前綴則跳過此閘、①②仍照常）；抽不到 body（無 body 參數／讀檔失敗）此閘 fail-open 放行，同 outbound-comment-guard 慣例。非 `gh pr create`／非 loop 分支／判不出分支一律放行；確需繞過設 `LOOPS_PR_GATE=0`。出錯 **fail-open（放行）**。footprint：無持久檔（純讀 `.git`／`.loops`，不寫任何檔案）。**已知限制**：① 與 outbound-comment-guard 同攔 `gh pr create --body` 時的多 hook 依序 deny 合併顯示行為 UNVERIFIED（Claude Code 無公開文檔；已拍板接受序列 deny——最壞情況是修一項再撞下一項、訊息各自清楚，見 issue #132 plan D3）；② 只認字面 `gh pr create`（正則解析、不跨 `; & |` 邊界），其他開 PR 途徑（web UI／API 直呼）不受管；③ 讀 `.git` 只看 cwd 本身、不像 `findLoopRoot` 那樣上溯祖先——payload.cwd 就是 Bash 呼叫當下的實際目錄，此假設成立；④ detached HEAD（裸 SHA，如 rebase 中）一律判不出分支、安全放行。
> - **`LOOPS_MERGE_GUARD`**（merge-guard，PreToolUse matcher `Bash|PowerShell`；**預設開——僅字面 `'0'` 關**；**#133**）：與 pr-gate 是姊妹規則（那管「開 PR 前要過的閘」、本 hook 管「合併這個動作本身要人核可」）——**不限 loop 分支**，任何 cwd 偵測到以下四型「合併回主幹」指令一律 deny（依序判定，命中即擋，不聚合）：①`gh pr merge`（任意 flag 組合）；②cwd 目前所在分支是 main/master 時的 `git merge <ref>`（讀 `.git`，重用 pr-gate.mjs 匯出的 `readGitBranch`——檔案形/目錄形 HEAD 皆生效；detached HEAD 或判不出分支一律放行，非主幹分支上的 `git merge`〔互併 feature 分支〕合法不擋）；③`git push` 的目的地是 main/master（bare positional／refspec 冒號右側／`--delete` 皆算，**`--delete` 不豁免**；push 到 feature 分支放行）；④`gh api` 用 `-X PUT`／`--method PUT` 打 `/pulls/.../merge` 路徑（GET 或非 `/merge` 路徑放行）。**視圖分工**（同 #132 Q1 課＋審查實測補強兩缺口）：子指令詞判定（是不是 `gh pr merge`／`git merge`／`gh api`+PUT）用 `stripQuotedValues` 剝殼視圖判，避免字樣只出現在別的指令的引號值裡（如 comment body）被誤判；但 push 目的地與 api 路徑改判**原始未剝殼字串**——剝殼視圖會把引號包住的目的地/路徑一併消掉（`git push origin "HEAD:master"` 整段 refspec 被引號包住、`gh api -X PUT "repos/x/y/pulls/1/merge"` 路徑被引號包住這兩形），對剝殼視圖判會造成偽陰性、漏放真正的高風險指令。非四型指令、四型指令的目的地/路徑不中一律放行；確需繞過設 `LOOPS_MERGE_GUARD=0`。出錯 **fail-open（放行）**。footprint：無持久檔（純讀 `.git`，不寫任何檔案）。**已知限制**：① 只攔字面型指令（正則解析 `gh pr merge`／`git merge`／`git push`／`gh api` 四種固定形態），`git rebase`／`git cherry-pick` 等其他能把 commit 帶進主幹的途徑不在此列（暫不擴大範圍）；② 與 outbound-comment-guard／pr-gate 同攔同一條指令時的多 hook 依序 deny 合併顯示行為 UNVERIFIED（同 #132 已拍板接受序列 deny——最壞情況是修一項再撞下一項）；③ 只認得這四種指令形態，其他合併途徑（web UI／未列出的 API 端點）不受管；④ push 目的地判定（#133 verify 二次仲裁後改 token 化 positional 解析、丟棄 flag token，取代舊版「只看字串最後一個 token」）已大幅收斂 refspec／選項值誤判（如 `--push-option="note:master"` 這種值裡湊巧含冒號+分支名圖樣不再誤中），殘餘面：以空白分隔、被引號包住的 positional 一律視為目的地候選、不論其實際語意是不是某個 flag 的值，仍可能被保守誤判為目的地；⑤ `git push`（無任何位置引數，依賴 tracking 分支設定推）不解析 `remote.origin.*`／`branch.*.merge` 等 git config 判斷實際目的地，一律放行（fail-open 精神延伸：判不出目的地就不擋）。**與使用者層既有規則的關係**：本 hook 與使用者層（如 `settings.json` 自訂）既有的「`gh pr merge` 需人核可」deny 規則並存＝**雙保險、不衝突**——兩者攔的動作有重疊但層級不同（一個是 plugin 內建 hook、一個是使用者自訂規則），是否移除使用者層那條交由各專案自行決定，本 hook 不強制取代它。

> **評測 hook（#35 + #49 擴成多訊號，永不擋路；#87 起三 flag 皆預設開——僅字面 `'0'` 關、無 artifact 即 no-op 零噪音、不執行 repo 定義命令）**：
> - **`LOOPS_EVAL_GATE`**（eval-gate，Stop hook + edit-accumulator PostToolUse；預設開）：**本回合有改檔**且 cwd 有 `.loops/.metrics/eval-results.jsonl` 時，於 Stop 自動跑 `eval-metrics.mjs check`，**只有偵測到 passRate 退化（exit 1）才把警示注入 context**（無退化靜默、不阻擋）。與 stop-gate 共用 edit-accumulator：在 hooks.json 排其**前**、**僅 stop-gate 未啟用時才自清** accumulator（避免兩 gate 互踩）。footprint：`os.tmpdir()/loops-edits-<session>.json`（與 stop-gate 共用）。
>   - SECURITY：比 stop-gate 風險低 —— check 只**讀** `.loops/.metrics/eval-results.jsonl` 並 spawn 同 plugin 固定腳本，**不執行 repo 內定義的命令**——此差異正是 #87 三 flag 可轉預設開、stop-gate 不可的分界。
> - **`LOOPS_EVAL_TAGS_GATE`**（#49，同一 eval-gate hook；預設開）：改檔回合且 cwd 有 `.loops/.metrics/eval-report.json`（per-task report，由 `eval-metrics record` 跑 oracle 時持久化在 metrics 檔同目錄）時，spawn `eval-tags by-tag`，**只注入本次 `failed>0` 的 tag 類別**（看哪類有 eval 失敗；單份快照、非跨 run 頻率；全綠靜默）。
> - **`LOOPS_EVAL_POLL_GATE`**（#49，同一 eval-gate hook；預設開）：改檔回合且 cwd 有 `.loops/.metrics/judge-results.jsonl`（上層 panel recipe 產）時，spawn `eval-poll poll --score-method median`，注入 judge panel 共識計數（judge-estimate advisory、非回歸 gate；無共識靜默）。
>   - 三 flag（GATE/TAGS/POLL）獨立、可組合：注入合併進**單一** `additionalContext`；各訊號讀已持久化 artifact、不自跑 oracle（每 Stop 跑全 oracle 違背省 token），缺輸入檔/壞輸出/spawn 失敗 → 該訊號靜默、永不擋路 exit 0。`ranAny && stop-gate 關` 才消費 edits（沿用既有清理語意；stop-gate flag 開但缺 gate.config.json 時同樣自清）。
> - 另：`eval-metrics.mjs` 的 `appendEvalRow` 內建 rotation（超過 `MAX_METRIC_ROWS`＝1000 行保留最後 N 行），避免 `eval-results.jsonl` 無界成長；`record` 另把 per-task `eval-report.json` 寫在 metrics 檔同目錄（latest-overwrite、advisory、tolerant 失敗不擋）。

範例（估算 / 實測二式）：

```text
- ★[outcome] 完工 ｜ token≈120K(中)est ｜ sub-agent 3(verify 2+validator 1) ｜ 回環 1 圈 ｜ findings 1→0 ｜ 交付：PR #6 merged
- ★[outcome] 完工 ｜ token≈127K(measured) ｜ $0.38 ｜ sub-agent 3(verify 2+validator 1) ｜ 回環 1 圈 ｜ findings 1→0 ｜ 交付：PR #6 merged
```

## Resume 協定（新 session 接手）

任一階段被獨立呼叫、或新 session 要續跑：

1. **先讀 `loop.md`**：看 `當前階段`、`停止條件`、`Journal` 最後幾筆。
2. **重建狀態**：當前在哪一階段、上一個 gate 通過了沒、回環第幾圈、`stages/` 底下哪些 `NN-*.md` 已產出（完工的話 `deliverables/` 三份齊不齊）。
3. **回報使用者**：「這個 loop 停在 `<階段>` 的 `<gate>`，已完成 E1–En，接下來是 X，要續跑嗎？」
4. 續跑後**繼續 append** 新事件，不覆蓋舊的。

## 與 auto 模式的關係

auto 模式（見 `references/auto-mode.md`）暫停時，journal 記「auto 因 X 暫停於 E_n」；resume 時從該點接續，不重跑已完成的階段。

## 為什麼 append-only

- 保留完整決策軌跡（誰在哪個 gate 選了什麼、為什麼回環）—— 事後可稽核、可回溯。
- 不覆蓋 = 不會因為改寫遺失「為什麼走到這」。
- 也可讓計畫檔額外帶一塊「可被腳本檢查」的結構，做到 plan → validate → execute（見 `references/machine-plan-schema.md`）。
