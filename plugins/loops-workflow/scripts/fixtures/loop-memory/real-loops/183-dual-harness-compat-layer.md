# loop：183-dual-harness-compat-layer

> feat(runtime)：建立 Claude Code/Codex 雙 harness compatibility layer

| 欄位 | 值 |
|---|---|
| **類型** | issue |
| **issue** | [#183](https://github.com/adha9990/dev-workflows/issues/183)（parent: #168；depends on: #182 ✅merged、#169 ✅merged） |
| **operation 性質** | `new-feature`（拿不準向嚴取；詳見下方註記） |
| **起點階段** | goal |
| **當前階段** | 完工 |
| **session** | 14b1162e-fb0a-4878-b9d3-4cd7a344ee0c |
| **推進模式** | auto |
| **base** | master @ bdb67dbee760c81d8d294bc825efc2ed151f84e8 |
| **worktree** | `.claude/worktrees/183-dual-harness-compat-layer`（branch 同名） |

## operation 性質註記

本 issue 混合三種動作，依「拿不準向嚴」取 `new-feature`（標準 TDD 紅綠分離）：

1. **新增**（→ new-feature 主軸）：hook 輸入正規化純函式 leaf、capability-registry、compat-lint drift gate、contract tests。
2. **重構**（既有行為不得變）：canonical 散文抽象化、25 支 agent tier 化、guard 改吃 normalized 輸入。
   → 這部分的紅燈起手式是 **characterization test 先鎖住既有輸出位元**，再動 code。
3. **bug-fix**（explore 實測確認）：`git -C` 兩層盲點（spawn 實測證實）、**Codex payload 下 guard 全面 fail-open**。
   → ⚠ **原寫「apply_patch 只抽首檔」已被實測推翻**：`grep apply_patch plugins/loops-workflow/hooks/*.mjs` **零命中**——repo 內**沒有任何 apply_patch 處理**。`config-protection` 只讀 `tool_input.file_path`，Codex payload 下走「無檔路徑 → 放行」＝全面 fail-open。真實缺陷比「只抽首檔」更大。
   → 這部分必須在**引入修復的同一個任務**補端到端 spawn 斷言＋反向 case，不得推給測試任務。

## 推進模式依據

- `LOOPS_AUTO` 環境變數**未設**（`echo "${LOOPS_AUTO:-}"` → 空）。
- 但使用者在本 session 開場**明示全權授權**：routine 轉場 / 開 PR / squash merge / close PR 一律自行推進，只有「重大變更需人類下決策」才用 `AskUserQuestion` 停（判準：交付標準偏離 plan 承諾、scope 邊界決策、方向取捨、P0、危險不可逆操作）。
- 故本 loop 推進模式記 `auto`，依據＝**使用者對話內明示授權**（非 env flag）。
- `LOOPS_LOOP_DRIVER` 亦未設 → `loop-driver` Stop hook 不會機械續跑 build，推進節奏由主線掌握。

## 停止條件雛形（goal 階段精煉）

`#183` 的 11 條驗收條件全部收斂到「已滿足」或「明確 descoped 且經使用者拍板」，且：

- 既有 Claude Code 行為**零回歸**（guards 的 Claude payload 路徑位元級不變，由 characterization test 鎖）。
- `.claude-plugin` 零 diff。
- compat-lint drift gate 進 CI 且在 master 基線上綠。
- 未量測面（Codex live agent-turn、生成 `.toml` persona）明標 `not_measured` 並附 runbook，**不冒充已驗證**。
- PR 開出（`--draft --assignee @me`、body 首行 `Closes #183`）並 squash merge 回 master。

## 環境前提查核（本 session 開跑前，§1）

| 前提 | 結果 |
|---|---|
| repo clean / master == origin/master | ✅ `bdb67db` |
| `gh` 認證（adha9990，repo scope） | ✅ |
| loops-workflow plugin 可用 | ✅ 0.56.4，cache 與 repo source `diff -rq` 零差異 |
| Agent Teams | ✅ `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` |
| codebase-memory-mcp | ✅ 已索引 @ `bdb67db`（3735 nodes / 6238 edges） |
| codex CLI | ❌ **未安裝**（git-bash + PowerShell PATH 皆無） |
| `LOOPS_MERGE_GUARD=0` / `LOOPS_PR_OWNER_GUARD=0` | ✅ `.claude/settings.local.json`（program 完成後移除） |

**codex CLI 缺席的影響**：不阻擋本 issue。可本地實測的面是 **hook payload normalization**——normalized guard 對 Codex 形狀 payload 可用本地 spawn 全面實測。Codex agent-turn 類（真互動 session、persona 載入、認證）依既有拍板框架標 `not_measured` ＋ runbook。

## Agent Team

| teammate | 車道 | 檔案領地 |
|---|---|---|
| `platform-engineer` | hooks / 正規化 / registry / adapter 契約 / 安全 guard | `plugins/loops-workflow/hooks/**`、`scripts/**` |
| `workflow-engineer` | canonical 散文 / skills / references / persona / tier | `skills/**`、`references/**`、`agents/**`、`docs/**` |
| `quality-integrator` | contract test / E2E / drift lint / 零回歸網 / CI | `evals/**`、`test-*.mjs`、`.github/workflows/**` |

## Journal（append-only）

- [E1] dispatch：輸入 `183`，`.loops/` 不存在 → 非 resume。判類型＝issue 號、意圖明確 → 跳過 clarify、起點 goal。專案非空 → 不 scaffold。
- [E2] dispatch：環境前提查核完成（見上表）；唯一缺口＝codex CLI 未安裝，依既有拍板框架不阻擋、Codex live 面標 not_measured。
- [E3] dispatch：建 `.loops/183-dual-harness-compat-layer/loop.md`（主 repo `$LOOPS_ROOT` 錨定）、推進模式 auto（依據＝使用者對話內明示授權，非 env flag）。
- [E4] dispatch：建 Agent Team 三 teammate（platform-engineer / workflow-engineer / quality-integrator），各派車道唯讀偵查。
- [E5] 進入 goal：逐句掃 #183（問題／決策／架構範圍 1–7／測試 7+7／不在本 issue 4／AC 11）抽 requirement；讀 `AGENTS.md` 憲章折入 10 條跨切面約定（C-B1–B10）進 Constraint。
- [E6] goal：查得 #182 已交付 `codex-plugin-lint.mjs`（430 行＋647 行測試）、`docs/CODEX-QUICKSTART.md` 9 列能力矩陣、`docs/CODEX-SMOKE.md` —— 前者是 drift lint 重用對象、後者是 capability registry 前身（規則 6 重用優先）。
- [E7] goal：**未向使用者提問**（6 個候選 blocking 點全部由素材推得，軌跡見 `stages/00-goal.md`）。關鍵推得：Codex 側 E2E ①②⑤⑦ 落在 #182 已 merged 拍板的 `not_measured` 框架內（`docs/CODEX-QUICKSTART.md:43`）；Claude 側 ①②⑦ 因**本 session 即真互動 session** 可 live-capture，標 not_measured 反而失實。
- [E8a] operation 註記（依 `operation-first-move.md`「標主性質、Journal 註明次要面」）：主性質＝`new-feature`；**次要面**＝①refactor（canonical 散文抽象化／25 支 persona tier 化／guard 改吃 normalized 輸入）紅燈起手式為 **characterization test 先釘現狀全綠**；②bug-fix（`git -C` 兩層盲點、apply_patch 只抽首檔）紅燈起手式為**先寫能複現的紅**、且須在引入修復的同一任務補端到端 spawn 斷言＋反向 case。
- [E8] goal：產 `stages/00-goal.md` —— 六欄齊全、GWT 場景 S1–S21（＋S3b 反例）、隱含驗收 D1–D4、環境硬限制 C-C1–C4 前置聲明。轉場 explore（routine，不問）。
- [E9] 進入 explore（收斂式）：teammate 三人**全程無回應**，五項量測改由主線親跑。M1 master 基線＝測試 31/31、三道 lint 全綠 @ bdb67db。M3 spawn 實測證實 `git -C` 盲點（B 放行、C 目前正確不得退化）。M4 發現 `evals/baseline/codex/gaps.json` 17 筆帶 **`x183_action`** 欄＝#169 已把本 issue 規格化。
- [E10] explore gate：四個架構分岔點 D1–D4 收斂，決定因素皆為適配度／重用度（沿用 repo 既有前例）。判定非「重大取捨」→ 依 §0 routine 自行推進，未停下發問。
- [E11] 進入 plan：產 §0–§9 施工圖 ＋ 20 任務 ＋ machine-plan JSON（validate 通過）。
- [E12] 設計審查第 1 輪：派 2 個 opus fresh reviewer，**皆判「要修」**，必修 22 條。關鍵：只做輸入正規化、輸出側全是 Claude 形狀（Codex 上判對卻靜默失效）；`stripQuotedValues` 實測為破壞性剝殼、取不到 `-C` 值；「apply_patch 只抽首檔」的舊實作**根本不存在**（實際是全面 fail-open）。
- [E13] **使用者拍板**（`AskUserQuestion`）：guard 遇 degraded 時「只讓降級可見，不改擋不擋」，fail-closed 整包交 #173。`00-goal.md` 的 S16 措辭與 C-A7 列同步收斂並留痕。
- [E14] 設計審查第 2 輪：2 個 fresh reviewer **仍判「要修」**，必修 23 條。關鍵：`runtime: claude|codex` scoped override **零實作**（AC4）；`GuardDecision` 涵蓋不了 11 支中的 5 支（實際 4 種不同構輸出）；拆 canonical 工具名而無 interaction adapter ＝行為債。任務 20→33（新增 T29 adapter／T30 scoped override／T31 格式契約／T32 等價 fixture）。
- [E15] 設計審查第 3 輪（硬上限）：各只剩 3 條必修，**皆明確表示方向站得住**。收斂軌跡 22→23→6。關鍵：T26 的 verification 在現況 master 上就是 exit 0（零工作量打勾 S7）；9 個任務跑全掃 lint 但依賴閉包缺 T21–T24 ⇒ 必紅 ⇒ 誘使削弱 gate。折回後自檢：跑全掃但閉包缺 T21–T24 的任務＝0。
- [E16] 判定不觸發 escalate——規範條件為「第 3 圈仍出必修**且仍動核心設計**」須同時成立，這 6 條無一動核心設計。折回完成，plan 定稿 33 任務 963 行。
- [E17] plan：對齊 comment 無條件 post 到 issue #183（設計決策一則 issuecomment-5078312702、不做的事一則 issuecomment-5078314605；依 comment-policy §0 拆兩則、機制圖 inline、不引用 .loops 路徑）。讀回驗證繁中無亂碼、tmp 草稿已刪。
- [E17a] post 過程被 repo 自身 hook 正確擋下三次：①本 session 未讀 comment-policy；②用 Bash+sed 讀不算（read-gate 只認 Read 工具事件）；③禁止把多個對外發訊複合在同一指令。三次皆為 guard 正確運作，②列為 E2E 第③步 Claude 側真實證據。
- [E18] **plan→build gate：使用者拍板「照 33 任務完整做」**（選項 B 先做機械層因含行為債未標推薦、選項 C 與 A 實質等價）。無新增套件。進 build。
- [E19] **使用者指示（mid-turn）：每張 issue 跳過 verify 階段，SkillOpt（#179）留到最後跑。** 已告知取捨——verify 是獨立的假綠檢查，本輪它在 plan 設計審查中抓過多次「測試綠但其實沒驗到」；跳過等於把該層安全網換成使用者在 PR 上的人工驗收。依使用者決定執行，留痕於此。
- [E20] build 完成：33/33 任務，145 檔 +10931/-395。合併態主線親跑 gate：47 支測試 0 fail、CI 的 8 個 step 本機逐一 exit 0、compat-lint 全庫由 152 筆清到 0、`.claude-plugin` 相對 master 零 diff（`--quiet` 斷言）。
- [E21] PR #190 開出（draft ＋ assignee ＋ body 首行 `Closes #183`）。pr-gate 依規擋下（要求 `stages/04-verify.md`），依使用者「跳過 verify」指示用 `LOOPS_PR_GATE=0` 逃生口，僅對該次指令生效、未寫進設定檔。
- [E22] **CI 第一輪 windows-latest 紅、ubuntu 綠**——`test-stop-concurrency` 的 C1a「8 個併發 writer 皆 exit 0」失敗。根因：Windows 無 POSIX 的 rename 覆蓋原子語意，多行程同時 rename 到同一目標撞暫時性鎖定錯誤。注意壞的不是 hook 層（C3b 已證明寫檔失敗時 hook 仍 exit 0），是底層 writer 在競爭下失敗。修法＝對 EPERM/EACCES/EBUSY 有界重試（上限 5 次、線性退避、worst case 100ms），非暫時性錯誤第一次即拋。本機無法重現（40+ 次皆 0 失敗），改以注入假 rename 的可決定性測試作紅綠證據。
- [E23] CI 第二輪**雙平台全綠**（ubuntu 51s／windows 1m32s）。
- [E24] PR #190 squash merged（`6a6c26a2`），issue #183 自動關閉。worktree 已清。
- ★[outcome] 完工 ｜ token≈?(高)est ｜ sub-agent 27 ｜ 回環 0 圈（verify 依使用者指示跳過）｜ findings — ｜ 交付：PR #190 merged
