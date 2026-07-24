# Codex Preview — Smoke Test 紀錄（#182）

> 日期：2026-07-24。在隔離 `CODEX_HOME` 下實際執行真的 Codex CLI，對 dev-workflows 本身的 canonical 內容（`plugins/loops-workflow/.codex-plugin/plugin.json`＋`.agents/plugins/marketplace.json`）驗證安裝生命週期與環境隔離完整性。需要已認證 Codex session 才能繼續的步驟，經決策者（使用者）拍板收斂為 `not measured`——不借用真實 auth、不登入隔離環境去補測；本篇同時保留這幾步「日後有認證環境時」的可重跑指令，供之後真的量測時直接照抄，不必重新設計。

## 環境

- Codex 執行檔絕對路徑：`C:\Users\Eagle\AppData\Local\OpenAI\Codex\bin\69066b736e1e17a4\codex.exe`（**不在 PATH**，需以絕對路徑呼叫）。
- 版本：`codex-cli 0.146.0-alpha.3.1`（alpha；本篇每筆證據皆對應此版本，日後版本更新須重跑）。
- 隔離規則：全程 `CODEX_HOME=$(mktemp -d)`，絕不讀寫使用者真實 `~/.codex`（含其中的 auth、session、以及已知壞掉的 `eagle-project` marketplace 登記）。每個 Test 各自用一份全新的隔離 `CODEX_HOME`，不共用。
- 測試標的：`plugins/loops-workflow/.codex-plugin/plugin.json`（commit `9e937a0`）＋`.agents/plugins/marketplace.json`（commit `a9df45a`），已合併進本 worktree（merge commit `f7a4335`）。

## Test 1 — CODEX_HOME 隔離完整性驗證（PASS）

| 驗證 | 結果 |
|---|---|
| `codex --version` 在全新隔離 `CODEX_HOME` 下可執行、不需先初始化 | ✅ 印出 `codex-cli 0.146.0-alpha.3.1`，exit 0 |
| `codex login status` 在隔離 `CODEX_HOME` 下回報「Not logged in」（未沾染真實使用者的登入狀態） | ✅ 輸出 `Not logged in`，exit 1（正確——隔離環境本就不該是已登入狀態） |
| `codex doctor --summary` 在隔離 `CODEX_HOME` 下的 `auth` 檢查回報「no Codex credentials were found」 | ✅ 確認隔離環境是乾淨的全新身分，不是意外繼承了使用者憑證 |

**已知副作用**（不影響結論，但值得記錄以免後續使用者誤解為錯誤）：`CODEX_HOME` 若字面落在 OS 暫存資料夾（`mktemp -d` 在本機解析到 `C:\Users\Eagle\AppData\Local\Temp\`）下，每次呼叫都會印一行警告：
```
WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "..."
```
這不影響指令本身的執行結果（exit code 與輸出皆正常），純粹是 Codex 拒絕在暫存目錄下安裝 PATH 別名輔助執行檔的保護行為。

**結論**：隔離完整性成立——`CODEX_HOME` 覆寫確實讓 Codex 使用全新、未登入、與使用者真實設定無關的身分運作。後續所有真機呼叫皆可安全在此隔離環境下進行，不會誤讀或誤寫使用者真實 `~/.codex`。

## Test 2 — Marketplace／Plugin 安裝生命週期，對 dev-workflows 真實內容（PASS）

T1（`plugins/loops-workflow/.codex-plugin/plugin.json`＋`.agents/plugins/marketplace.json`）已合併進本 worktree，本測試直接對 **dev-workflows 本身**執行，不是合成內容。

| 步驟 | 指令 | 結果 |
|---|---|---|
| 1. 註冊本 repo 為 marketplace | `codex plugin marketplace add "<repo worktree 絕對路徑>" --json` | ✅ `{"marketplaceName":"dev-workflows","installedRoot":"...182-evidence","alreadyAdded":false}`，exit 0，不需要登入 |
| 2. 列出可安裝但未安裝的 plugin | `codex plugin list --available --json` | ✅ `available: [{"pluginId":"loops-workflow@dev-workflows","name":"loops-workflow","version":"0.56.4","installed":false,"enabled":false,"source":{"source":"local","path":"...\\plugins\\loops-workflow"},"installPolicy":"AVAILABLE","authPolicy":"ON_INSTALL"}]`，不需要登入 |
| 3. 安裝 plugin | `codex plugin add loops-workflow@dev-workflows --json` | ✅ `{"pluginId":"loops-workflow@dev-workflows","name":"loops-workflow","version":"0.56.4","installedPath":"...\\plugins\\cache\\dev-workflows\\loops-workflow\\0.56.4","authPolicy":"ON_INSTALL"}`，exit 0，不需要登入 |
| 4. 確認已安裝狀態 | `codex plugin list --json` | ✅ `installed: [{"pluginId":"loops-workflow@dev-workflows",...,"installed":true,"enabled":true,...}]` |

**這就是「官方 validator」的實際運作**：manifest／marketplace 的結構驗證，是 `codex plugin marketplace add` 與 `codex plugin list` 解析時自然發生的步驟——本機唯讀探測階段已用使用者真實環境裡一個壞掉的 marketplace 登記證實過這個報錯機制（見 explore 階段記錄）；本測試進一步證實：**對 dev-workflows 真實內容跑這整條路徑（marketplace 註冊→列出→安裝→確認），在此 CLI 版本上完全不需要登入即可成功完成，`@dev-workflows` 正確解析到本 repo、版本號 `0.56.4` 與 `.claude-plugin/plugin.json` 一致**（呼應 Tier A lint 的 name/version 同步斷言，這裡是 Codex CLI 自己也認同這個值，不只是我方 lint 自己說了算）。

**結論**：plugin 發現與安裝機制對本 repo 真實內容確認可行、無需認證。`policy.authentication: "ON_INSTALL"` 目前看來不代表「安裝當下就要求登入」，而更可能代表「該 plugin 的能力在實際被呼叫時才會要求認證」——這點未被本測試直接證實，見 Test 3。

## Test 3 — 認證邊界（決策者已拍板收斂為 not measured）

嘗試繼續往下驗證「新 task 是否能發現並呼叫 `dispatch` skill」「hooks 信任流程」「guard 觸發探測」「跑一個不改產品 code 的迷你 smoke 任務並留下 `.loops` 記錄」時，發現這些步驟都需要**啟動一個真的 agent turn**（`codex exec` 或互動式 session），而這一定需要認證。隔離 `CODEX_HOME` 下 `codex doctor` 明確回報 `✗ auth no Codex credentials were found`——這是一個全新、未登入的乾淨身分，符合隔離設計的預期，但也代表它結構性地無法執行任何需要呼叫模型的步驟。

依照硬規則：**不得複製使用者真實 `~/.codex` 的 auth 檔案到隔離環境，也不得嘗試以本機真實登入狀態去跑這些步驟**。安全停下、回報決策者三個選項後，**決策者拍板：選「標 not measured 收票」**——不提供認證、不借 auth、不登入。此裁定同時框定後續同一 program（#169、#181）內 Codex 側 agent-turn 類量測的預設處理方式，不再重複詢問。

下列每項皆為**收斂後的最終狀態**（非暫時性缺口），並附上「日後有認證環境時」的可重跑指令，供直接照抄執行：

### 3a. Skill discovery / `dispatch`（not measured）

```
CODEX_HOME=<已認證的隔離 CODEX_HOME> "<codex 執行檔絕對路徑>" exec --json \
  -C "<repo worktree 路徑>" \
  "列出你目前能用的 skill，確認裡面有沒有一個叫 dispatch 的 skill 可以呼叫"
```
預期觀察：`--json` 輸出的事件流裡是否出現 skill 呼叫／可用清單，內含 `dispatch`。

### 3b. Hooks 信任流程（not measured）

```
# 第一次對已安裝 plugin 跑任何 session，觀察是否出現 hook 信任提示
CODEX_HOME=<已認證的隔離 CODEX_HOME> "<codex 執行檔絕對路徑>"
# 之後查看該 CODEX_HOME 下 config.toml 的 [hooks.state] 是否新增本 plugin 的 hooks.json 條目
```

### 3c–3h. Guard 觸發探測（六條，not measured）

背景：官方 hooks 文件記載 Codex shell 工具的 canonical `tool_name` 是 `"Bash"`，`apply_patch`（檔案編輯）支援 `Edit`／`Write` 當 matcher 別名——這代表 loops-workflow 既有 `hooks.json` 的 `Bash|PowerShell`／`Write|Edit|MultiEdit` matcher **很可能會命中**；但官方 repo 有一張已修復的 issue（`openai/codex#16732`，2026-04-22 close）記載這整套機制過去曾經：①`apply_patch` 的 hook 呼叫路徑整個不觸發、②`tool_name` 曾被寫死成 `"Bash"`。**這個 CLI 版本（`0.146.0-alpha.3.1`）是否已含修復未知，而且即使 matcher 命中，我們的 guard script 讀的是特定 payload 欄位**（`worktree-guard.mjs:129` 讀 `tool_input.command`；`loops-path-guard.mjs:73`／`config-protection.mjs:84` 讀 `tool_input.file_path`，兩者皆 fail-open——讀不到就靜默放行），**這兩軸都需要實測才能定論，文件本身回答不了**。以下六條指令一次測掉：

```
# ①（背景基準）確認隔離環境自身的 feature flags
CODEX_HOME=<已認證的隔離 CODEX_HOME> "<codex 執行檔絕對路徑>" features list | grep unified_exec

# ②③ 真實觸發一次 Bash 呼叫與一次檔案編輯，從 --json 事件流讀 hook 收到的 tool_name 實際值
CODEX_HOME=<已認證的隔離 CODEX_HOME> "<codex 執行檔絕對路徑>" exec --json \
  -C "<repo worktree 路徑>" "跑 echo hello，然後編輯一個測試檔加一行文字"
# 檢查事件流裡 PreToolUse/PostToolUse 對應的 tool_name 是否為 Bash（shell）／apply_patch（編輯）

# ④ 檢查上一步檔案編輯事件的 payload 是否含 file_path；Bash 呼叫事件是否含 command
# （直接讀 ②③ 輸出的 JSON 節點，不需要另外下指令）

# ⑤ pipe alternation：故意用一個「一定活+一定死」的 matcher 掛一條 hook，觸發一次 Bash
#   （例：把 hooks.json 某條 matcher 暫時改成 "Bash|NotARealTool"，跑一次 Bash 呼叫，
#    確認 hook 依然觸發、未知 token 沒有拖累整條 matcher）

# ⑥ Read 與 SessionStart/Stop 類是否真的觸發、payload 有無炸掉
CODEX_HOME=<已認證的隔離 CODEX_HOME> "<codex 執行檔絕對路徑>" exec --json \
  -C "<repo worktree 路徑>" "讀一個檔案的內容"
# 檢查 read-accumulator 對應的 PostToolUse 是否觸發；並觀察 session 開始/結束時
# session-start.mjs／cost-tracker.mjs／progress-render.mjs／loop-driver.mjs 是否正常跑、無例外
```

### 3i. 迷你 smoke 任務 + `.loops` 記錄（not measured）

```
CODEX_HOME=<已認證的隔離 CODEX_HOME> "<codex 執行檔絕對路徑>" exec --json \
  -C "<repo worktree 路徑>" \
  "loops-workflow:dispatch 說明一下這個 repo 的用途（唯讀、不要改任何檔案）"
# 之後檢查 <repo>/.loops/ 底下是否出現新的 loop 目錄、loop.md 是否正確產生
```

## Capability Matrix 狀態（8 列為決策者拍板後的最終狀態；setup 已對真實內容驗證完畢）

| 能力 | 狀態 | 依據 |
|---|---|---|
| setup（plugin 發現／安裝機制本身） | `degraded`（機制對 dev-workflows 真實內容確認可行、免登入；`authPolicy` 實際觸發時機未證實，故不到 `supported`） | Test 2 |
| skill discovery / `dispatch` | `not measured`（決策者裁定收斂，非暫時性） | Test 3a |
| `AskUserQuestion` 類互動 | `not measured`（決策者裁定收斂，非暫時性） | Test 3 |
| subagent / model profile | `not measured`（決策者裁定收斂，非暫時性） | Test 3 |
| hooks 與 hook 信任 | `not measured`（決策者裁定收斂，非暫時性；官方文件載相容別名，但版本修復史與 payload 欄位兩軸未實測） | Test 3b–3h |
| shell / `apply_patch` guard | `not measured`（決策者裁定收斂，非暫時性；官方文件載相容別名，但版本修復史與 payload 欄位兩軸未實測） | Test 3c–3h |
| worktree | `not measured`（決策者裁定收斂，非暫時性） | Test 3 |
| `.loops/` resume / progress | `not measured`（決策者裁定收斂，非暫時性） | Test 3i |
| transcript / token metrics | `not measured`（決策者裁定收斂，非暫時性） | Test 3 |

## 方法論

- **隔離鐵則**：全程 `CODEX_HOME=$(mktemp -d)`，每個 Test 各自一份全新目錄，絕不讀寫使用者真實 `~/.codex`（含真實 auth/session、以及已知壞掉的 `eagle-project` marketplace 登記——那是使用者資料，只做觀察紀錄，不修改）。
- **版本釘死**：本篇每一筆證據皆對應 `codex-cli 0.146.0-alpha.3.1`（alpha channel）。alpha 版本變動快，日後若 Codex 版本更新，本篇結論需要重新驗證，不能假設歷史結果仍然成立。
- **合成內容 vs 真實內容**：Test 2 最初以合成 marketplace（因 T1 尚未合併）驗證機制本身是否可行；T1 合併後已改對 dev-workflows 真實內容重跑一次，取代先前的合成內容證據作為主結論依據。
- **not measured 的收斂性質**：Test 3 所列 8 個矩陣列的 `not measured` 不是「還沒空測」的暫時狀態，而是決策者在權衡「借用真實 auth／要求使用者親自登入隔離環境／收斂為 not measured」三個選項後的最終決定——收在這張 issue 裡，不留給下一輪重新拍板；已附上可重跑指令，供日後真的有認證環境時直接執行，不必重新設計測試步驟。

## 已知限制

- 本篇未驗證任何需要真的 agent turn（呼叫模型）的能力；這是本輪 Codex Preview 的範疇邊界，非缺陷。
- `codex` 執行檔不在系統 PATH 上，所有指令皆需以絕對路徑呼叫——這點也需要寫進 `docs/CODEX-QUICKSTART.md`，避免新使用者以為 `codex` 是可以直接打的裸指令。
- `CODEX_HOME` 若字面落在 OS 暫存資料夾下會印出一則無害的 PATH 別名警告（見 Test 1），不影響功能，但使用者可能誤以為是錯誤。
