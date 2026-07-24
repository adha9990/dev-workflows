# Codex Preview — 平台差異表、post-auth 取數 runbook 與 replay 方法（#169 baseline）

> 本篇是 #169 baseline 的 Codex 組資料，配 `gaps.json`（機械可讀缺口清單，#183 capability registry 輸入）一起看。誠實原則：只有 `docs/CODEX-SMOKE.md` 免登入實測過的 `manifest` 一列標 `supported`；其餘皆 `not_measured` / `degraded` / `not_supported`，證據逐列標明出處（SMOKE Test 段或一手 CLI `--help` 查證）。使用者已拍板本輪不供認證，Codex agent-turn 類一律 `not measured`——本篇把「有認證時怎麼取數」文件化成可照抄 runbook，不實跑。
>
> 版本釘死：一手 CLI 證據皆對應 `codex-cli 0.146.0-alpha.3.1`（alpha，日後版本更新須重驗）。

## 1. 平台差異表（R12 八面向）

| # | 面向 | Claude Code | Codex Preview | 狀態 | 證據出處 |
|---|---|---|---|---|---|
| 1 | manifest | `.claude-plugin/plugin.json` + marketplace（`source` 為字串） | `.codex-plugin/plugin.json` + `.agents/plugins/marketplace.json`（`source` 為物件 + `policy` + `category`）；兩份並存時 **Codex-native 勝出** | **supported**（免登入實測） | SMOKE Test 2 / 4a / 6；issue #182 issuecomment-5072363260（post-merge 實測） |
| 2 | skill invocation | `/loops-workflow:dispatch`（slash）或 skill picker | skill picker 或 `$`；**不假設**語法與 Claude 相同 | not_measured | SMOKE Test 2 範疇澄清（cache 檔案層級已確認）+ Test 3a（可呼叫性需 agent turn） |
| 3 | questions | `AskUserQuestion` 工具 | `request_user_input`（Codex 自有）；exec 非互動下是否 surface 穩定 question 事件未驗證 | not_measured（no_stable_interface） | SMOKE matrix（AskUserQuestion 列）+ #183 §3 |
| 4 | agents | `agents/*.md` 子代理（sonnet/opus 名） | Codex 子代理 / model profile（`.codex/agents/*.toml` 或動態）；tier↔model 映射未定 | not_measured | SMOKE matrix（subagent 列）+ #183 §4 |
| 5 | hooks | SessionStart/Stop/Pre/PostToolUse，matcher 綁 Claude 工具名，`${CLAUDE_PLUGIN_ROOT}` | 慣例自動發現 `hooks/hooks.json` + 需 `/hooks` trust；官方給 `Bash` tool_name + `Edit/Write` matcher 別名 + `CLAUDE_PLUGIN_ROOT` 相容 env；**guard 觸發**兩軸未量測（見下） | not_measured | SMOKE Test 3b–3h；learn.chatgpt.com/docs/hooks；gh:openai/codex#16732 |
| 6 | worktree | `EnterWorktree` / git worktree | 原生 git worktree（Codex 在 git repo 內執行）；loops worktree 不變式在 Codex 未驗證 | not_measured | SMOKE matrix（worktree 列）+ #183 §6 |
| 7 | resume | `.loops/<slug>/` markdown state resume + loop-driver | Codex **session 級** resume/fork（`codex exec resume [id\|--last]`、`codex resume/fork`、`session_index.jsonl`）≠ loops **state 級** resume | not_measured | CLI:`codex --help` / `codex exec resume --help`@0.146.0-alpha.3.1；SMOKE Test 3i |
| 8 | transcript / metrics | `LOOPS_COST_TRACKER` hook + transcript token 帳 | `codex exec --json` JSONL（`token_count` / `turn.completed.Usage`）+ `--output-last-message` / `--output-schema` | degraded（介面在、穩定/等價未定） | CLI:`codex exec --help`@0.146.0-alpha.3.1；gh:openai/codex#17539, #29272 |

**面向 5 補充——`shell` / `apply_patch` guard 為何 not_measured（兩條獨立軸）**：官方文件載 shell 的 canonical `tool_name` 為 `"Bash"`、`apply_patch` 支援 `Edit`/`Write` matcher 別名（代表 loops-workflow 既有 matcher **很可能命中**），但：①**版本軸**——`openai/codex#16732`（PR #18391 修，2026-04-22 close）記載 apply_patch 的 hook 呼叫路徑曾整個不觸發、`tool_name` 曾寫死 `"Bash"`；`0.146.0-alpha.3.1` 是否含修復未知。②**payload 軸**——matcher 命中 ≠ guard 正確：guard 讀特定欄位（`worktree-guard.mjs:129` 讀 `tool_input.command`、`loops-path-guard.mjs:73` / `config-protection.mjs:84` 讀 `tool_input.file_path`，皆 fail-open），是否對得上 Codex `apply_patch` payload 未知。兩軸都要 agent turn 才能定論。詳見 `gaps.json` 的 `codex.guard.shell_apply_patch`。

## 2. post-auth 取數 runbook（需認證前置——本輪不執行）

> 以下所有指令都需要一個**已認證**的隔離 `CODEX_HOME`（本輪使用者拍板不供認證，故未執行；此處僅文件化為「日後有認證環境時可照抄」的取數路徑）。`<codex>` = `C:\Users\Eagle\AppData\Local\OpenAI\Codex\bin\...\codex.exe`（不在 PATH，需絕對路徑，見 SMOKE「已知限制」）。

### 2.1 官方 metrics 介面：`codex exec --json` 事件流

`codex exec --json` 把逐輪事件以 JSONL 印到 stdout。與 metrics 相關的事件（CITE：CLI `codex exec --help`@0.146.0-alpha.3.1；事件形狀 CITE gh:openai/codex#17539, #29272）：

- `thread.started` — 帶 thread/session id。
- `token_count`（`payload.type === "token_count"`）— **cumulative** token 總帳，欄位含 `input` / `cached-input` / `output` / `reasoning-output` / `total`。**per-turn 用量 = 本筆 cumulative 減前一筆 cumulative**。
- `turn.completed` — 帶 `Usage`（cumulative session 總帳）。

> 注意（gh#17539 / #29272）：per-API-call 的 `last` 用量、以及 exec 結束時的 token 明細，granularity 仍在演進中；alpha 版事件 schema 可能變動——取數前先 pin 版本、以當下實際輸出為準。

### 2.2 可照抄指令（逐指標）

前置（一次）：認證的隔離 home + 安裝好 plugin（安裝步驟見 SMOKE Test 2/6，免登入）：
```
export CODEX_HOME=<已認證的隔離目錄（Windows 路徑）>
CODEX="C:\\Users\\Eagle\\AppData\\Local\\OpenAI\\Codex\\bin\\<hash>\\codex.exe"
```

- **tokens / tool-agent calls / repeated reads**（一次 exec 同時涵蓋）：
  ```
  "$CODEX" exec --json -C <repo> "<fixture prompt>" > run.jsonl
  # tokens：抓最後一筆 token_count（cumulative total）；per-turn 逐筆相減
  # tool/agent calls：計數 tool-use / subagent 事件
  # repeated reads：對 file-read 事件的目標路徑去重後計重複次數
  ```
- **duration**：
  ```
  time ( "$CODEX" exec -C <repo> "<fixture prompt>" )
  # 或讀 run.jsonl 首尾事件時間戳差；口徑對齊 Claude Stop-to-Stop 下界
  ```
- **verify findings / iterate rounds / unresolved unknowns**（工作產物，需跑到對應階段）：
  ```
  "$CODEX" exec -C <repo> "dispatch 一條任務並跑到 verify/iterate"
  # 跑完後數 <repo>/.loops/<slug>/ 內的 findings / iterate 迴圈 / 殘留 unknowns
  ```
- **questions**（no_stable_interface，需先確認事件是否存在）：
  ```
  "$CODEX" exec --json -C <repo> "<會觸發決策點的 prompt>" | grep -i "question\|user.input"
  # 先驗證 exec 非互動下 request_user_input 是否 surface 穩定事件，再談計數
  ```
- **hooks 觸發 / guard 探測**（面向 5 兩軸）：
  ```
  # 信任：首次跑 session → /hooks trust → 查 $CODEX_HOME/config.toml 的 [hooks.state]
  "$CODEX" exec --json -C <repo> "跑 echo hello，然後編輯一個測試檔加一行" > hook.jsonl
  # 讀 hook.jsonl 事件的 tool_name（預期 Bash / apply_patch）與 payload 欄位（command / file_path）
  # pipe alternation：暫改某 matcher 為 "Bash|NotARealTool" 跑一次 Bash，確認未知 token 不拖累
  ```

每筆量測都要記：`codex --version`、日期、逐指令、隔離 `CODEX_HOME`、raw 輸出。缺任何一欄的指標一律標 `not_measured`，不得因「應該可以」而標 supported。

## 3. 無確定性 replay — before/after 對照方法

一手 `--help` 查證（`codex --help` / `codex exec resume --help`@0.146.0-alpha.3.1）：

- **有**：session 持久化（`session_index.jsonl`）、`codex exec resume [SESSION_ID|--last]`、top-level `codex resume` / `fork` / `archive` / `delete` / `unarchive`、`--ephemeral`（不持久化）、`codex exec --json` / `--output-last-message` / `--output-schema`、`codex review`（非互動 review）。
- **無**：**確定性 replay**（重放錄下的 session、重現同一 trajectory 供逐項 diff）。`resume` / `fork` 是「續跑」（resume 後送新 prompt），不是 re-execution；`--help` 無 `--replay` 旗標。`codex cloud` 存在但標 `EXPERIMENTAL`，非本地 replay 介面。

**結論（餵 #183 / #181 eval，配 C3 report 的 `recapture_note`、C1 fixture 的 `nondeterminism`）**：
- Codex 的 before/after **不能**靠確定性重放。做法＝**同一 fixture 重跑 `codex exec` + 依 fixture 的 `nondeterminism` 宣告允許的非決定性 + 擷取 `--json`**，再與釘死的 baseline 逐欄比。
- 這與 Claude 側 oracle 重跑是「恆等式重播」不同——Codex 側每次重跑都是新的非決定性 agent turn，要偵測漂移必須**重新 capture**，不是重播錄音。
- 可評估用 Promptfoo 官方 Codex provider（`OpenAI Codex SDK` / `OpenAI Codex App Server`，CITE promptfoo.dev）作為驅動 + 收指標的層——但安裝/納管歸 #176/#177，本票不裝。

## 4. 方法論註記

- **隔離鐵則**：任何真機取數一律用拋棄式 `CODEX_HOME`（全新目錄，測完刪除），絕不讀寫使用者真實 `~/.codex`（含 auth/session 與已知壞掉的 `eagle-project` marketplace 登記）。見 SMOKE「方法論」。
- **not_measured 的收斂性質**：本篇 Codex agent-turn 類的 `not_measured` 不是「還沒空測」，是使用者 2026-07-24 拍板「不借 auth、不登入隔離環境」後的範疇邊界；已附可重跑 runbook，供日後有認證環境時直接執行。
- **證據對應內容而非 SHA**：引用的 commit/版本用來標示「測的是哪個版本」；核對請比對檔案內容本身。
