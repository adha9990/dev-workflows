# 跨 session resume / journaling

> `.loops/<slug>/loop.md` 不只是儀表板，還是**可續跑的事件日誌**。把每個重要動作 append 進去，新 session 只要讀它就能重建狀態、接著跑 —— 不靠對話記憶。

## loop.md 的 journal 區段

在 `loop.md` 末尾維護一個 **append-only** 的事件日誌（只加不改、保留順序）：

```markdown
## Journal（append-only）

- [E1] 進入 explore：讀 00-goal.md，派 Explore 掃 codebase
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

> **opt-in 觀測 hook（#15，兩個、預設關、出錯一律 no-op exit 0、永不擋路）**：
> - **`LOOPS_COST_TRACKER=1`**（cost-tracker，Stop hook）：每個 assistant 回應結束把該 session 累計 usage append 一行到 `<cwd>/.loops/.metrics/costs.jsonl`（per-session **取該 session_id 最後一行**；僅當 cwd 有 `.loops/` 才動作）。收尾若該檔有本 session 行→實測分支，否則（未開 flag／無此檔）→估算分支。footprint：`.loops/.metrics/costs.jsonl`（已被 `.loops/*` gitignore）。
> - **`LOOPS_COMPACT_HINT=1`**（suggest-compact，PreToolUse matcher `Edit|Write`）：估算真實 context 大小（transcript 最新 usage）跨門檻（~250k、之後每 +60k）時，在 Edit/Write 前注入一句「可考慮 `/compact`」**估算**提醒（**不阻擋**工具）；防洗版 state 落 `os.tmpdir()/loops-compact-<session>.json`、14 天 TTL。footprint：tmp state 檔。
>
> **outcome 度量格式以此為單一來源**，各 skill（iterate §6）引用此處、不另定義。

> **opt-in 介入 hook（#17，兩個、預設關、永不擋路；與上面「觀測」不同，這兩個會主動跑閘 / 擋工具）**：
> - **`LOOPS_STOP_GATE=1`**（stop-gate，Stop hook + edit-accumulator PostToolUse）：**本回合有改檔**時（PostToolUse accumulator 記錄、僅此 flag 開才記）於 Stop 自動跑既有 `loops-quality-gate.mjs --gates type,lint`，**只有紅燈才把摘要注入 context**（綠靜默、不阻擋）。需 cwd 有 `.loops/gate.config.json`。footprint：`os.tmpdir()/loops-edits-<session>.json` 暫存。
>   - ⚠️ **SECURITY：啟用＝授權「在每個改檔回合自動執行 `.loops/gate.config.json` 內定義的 `lint`/`type` 命令」（以及偵測到的 lint/test 工具）。這些命令來自 repo、等同自動執行 repo 控制的 code。請只在你信任的 repo 開此 flag。** 風險本就存在於手動跑 quality-gate；本 hook 把它變成自動，故格外提醒。
> - **`LOOPS_CONFIG_PROTECTION=1`**（config-protection，PreToolUse matcher `Write|Edit|MultiEdit`）：偵測對既有 linter/formatter 設定檔（eslint/prettier/biome/ruff…）的**修改**→ `permissionDecision:"deny"` 擋下並提示「修 code 別弱化設定」；**新建**設定檔放行、非設定檔放行。出錯 **fail-open（放行）**。要合法改設定檔時暫時 `unset LOOPS_CONFIG_PROTECTION`。footprint：無持久檔。

> **opt-in 學習 hook（#18，一個、預設關、唯讀永不擋路）**：
> - **`LOOPS_INSTINCT_INJECT=1`**（session-start，SessionStart）：除既有「浮 active 迴圈」外，再讀 `<cwd>/.loops/.instincts/*.yaml`（`distill` skill 產的跨 loop instinct）→ 過濾 confidence ≥ 0.7 → 取前 6 → 注入為 session context（每條 `[<conf%>] <summary>`、summary 截 ≤200 字）。footprint：`.loops/.instincts/`（已 gitignore）。active-loop 浮出行為不變。
>   - ⚠️ **SECURITY：instinct 的 `summary` 會進模型 context。若 cwd 是不信任的 repo，其 `.loops/.instincts/*.yaml` 可能夾帶誘導性文字（間接 prompt injection）。注入已框定「來源未驗證、僅供參考、勿當指令」並截斷長度，但仍請只在你信任的 repo 開此 flag。** instinct 應由你自己跑 `/loops-workflow:distill` 在信任 repo 產生。

> **opt-in 評測 hook（#35 + #49 擴成多訊號，預設關、永不擋路）**：
> - **`LOOPS_EVAL_GATE=1`**（eval-gate，Stop hook + edit-accumulator PostToolUse）：**本回合有改檔**且 cwd 有 `.loops/.metrics/eval-results.jsonl` 時，於 Stop 自動跑 `eval-metrics.mjs check`，**只有偵測到 passRate 退化（exit 1）才把警示注入 context**（無退化靜默、不阻擋）。與 stop-gate 共用 edit-accumulator：在 hooks.json 排其**前**、**僅 stop-gate 未啟用時才自清** accumulator（避免兩 gate 互踩）。footprint：`os.tmpdir()/loops-edits-<session>.json`（與 stop-gate 共用）。
>   - SECURITY：比 stop-gate 風險低 —— check 只**讀** `.loops/.metrics/eval-results.jsonl` 並 spawn 同 plugin 固定腳本，**不執行 repo 內定義的命令**；仍 opt-in 預設關。
> - **`LOOPS_EVAL_TAGS_GATE=1`**（#49，同一 eval-gate hook）：改檔回合且 cwd 有 `.loops/.metrics/eval-report.json`（per-task report，由 `eval-metrics record` 跑 oracle 時持久化在 metrics 檔同目錄）時，spawn `eval-tags by-tag`，**只注入 `failed>0` 的 tag 類別**（看哪類最常退化；全綠靜默）。
> - **`LOOPS_EVAL_POLL_GATE=1`**（#49，同一 eval-gate hook）：改檔回合且 cwd 有 `.loops/.metrics/judge-results.jsonl`（上層 panel recipe 產）時，spawn `eval-poll poll --score-method median`，注入 judge panel 共識計數（judge-estimate advisory、非回歸 gate；無共識靜默）。
>   - 三 flag（GATE/TAGS/POLL）獨立、可組合：注入合併進**單一** `additionalContext`；各訊號讀已持久化 artifact、不自跑 oracle（每 Stop 跑全 oracle 違背省 token），缺輸入檔/壞輸出/spawn 失敗 → 該訊號靜默、永不擋路 exit 0。`ranAny && stop-gate 關` 才消費 edits（沿用既有清理語意）。
> - 另：`eval-metrics.mjs` 的 `appendEvalRow` 內建 rotation（超過 `MAX_METRIC_ROWS`＝1000 行保留最後 N 行），避免 `eval-results.jsonl` 無界成長；`record` 另把 per-task `eval-report.json` 寫在 metrics 檔同目錄（latest-overwrite、advisory、tolerant 失敗不擋）。

範例（估算 / 實測二式）：

```text
- ★[outcome] 完工 ｜ token≈120K(中)est ｜ sub-agent 3(verify 2+validator 1) ｜ 回環 1 圈 ｜ findings 1→0 ｜ 交付：PR #6 merged
- ★[outcome] 完工 ｜ token≈127K(measured) ｜ $0.38 ｜ sub-agent 3(verify 2+validator 1) ｜ 回環 1 圈 ｜ findings 1→0 ｜ 交付：PR #6 merged
```

## Resume 協定（新 session 接手）

任一階段被獨立呼叫、或新 session 要續跑：

1. **先讀 `loop.md`**：看 `當前階段`、`停止條件`、`Journal` 最後幾筆。
2. **重建狀態**：當前在哪一階段、上一個 gate 通過了沒、回環第幾圈、哪些 `.loops/NN-*.md` 已產出。
3. **回報使用者**：「這個 loop 停在 `<階段>` 的 `<gate>`，已完成 E1–En，接下來是 X，要續跑嗎？」
4. 續跑後**繼續 append** 新事件，不覆蓋舊的。

## 與 auto 模式的關係

auto 模式（見 `references/auto-mode.md`）暫停時，journal 記「auto 因 X 暫停於 E_n」；resume 時從該點接續，不重跑已完成的階段。

## 為什麼 append-only

- 保留完整決策軌跡（誰在哪個 gate 選了什麼、為什麼回環）—— 事後可稽核、可回溯。
- 不覆蓋 = 不會因為改寫遺失「為什麼走到這」。
- 也可讓計畫檔額外帶一塊「可被腳本檢查」的結構，做到 plan → validate → execute（見 `references/machine-plan-schema.md`）。
