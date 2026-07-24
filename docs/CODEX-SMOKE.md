# Codex Preview — Smoke Test 紀錄（#182）

> 日期：2026-07-24。在隔離 `CODEX_HOME` 下實際執行真的 Codex CLI，驗證 marketplace／plugin 安裝生命週期與環境隔離完整性。認證邊界（Test 3）已由決策者拍板收斂為 `not measured`（見該節）；T1 合併後需對 dev-workflows 真實內容重跑 Test 2 才能把結論套用到本 repo（見 Test 2 範疇說明）。

## 環境

- Codex 執行檔絕對路徑：`C:\Users\Eagle\AppData\Local\OpenAI\Codex\bin\69066b736e1e17a4\codex.exe`（**不在 PATH**，需以絕對路徑呼叫）。
- 版本：`codex-cli 0.146.0-alpha.3.1`（alpha；本篇每筆證據皆對應此版本，日後版本更新須重跑）。
- 隔離規則：全程 `CODEX_HOME=$(mktemp -d)`，絕不讀寫使用者真實 `~/.codex`（含其中的 auth、session、以及已知壞掉的 `eagle-project` marketplace 登記）。

## Test 1 — CODEX_HOME 隔離完整性驗證（PASS）

| 驗證 | 結果 |
|---|---|
| `codex --version` 在全新隔離 `CODEX_HOME` 下可執行、不需先初始化 | ✅ 印出 `codex-cli 0.146.0-alpha.3.1`，exit 0 |
| `codex login status` 在隔離 `CODEX_HOME` 下回報「Not logged in」（未沾染真實使用者的登入狀態） | ✅ 輸出 `Not logged in`，exit 1（正確──隔離環境本就不該是已登入狀態） |
| `codex doctor --summary` 在隔離 `CODEX_HOME` 下的 `auth` 檢查回報「no Codex credentials were found」 | ✅ 確認隔離環境是乾淨的全新身分，不是意外繼承了使用者憑證 |

**已知副作用**（不影響結論，但值得記錄以免後續使用者誤解為錯誤）：`CODEX_HOME` 若字面落在 OS 暫存資料夾（`mktemp -d` 在本機解析到 `C:\Users\Eagle\AppData\Local\Temp\`）下，每次呼叫都會印一行警告：
```
WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "..."
```
這不影響指令本身的執行結果（exit code 與輸出皆正常），純粹是 Codex 拒絕在暫存目錄下安裝 PATH 別名輔助執行檔的保護行為。

**結論**：隔離完整性成立——`CODEX_HOME` 覆寫確實讓 Codex 使用全新、未登入、與使用者真實設定無關的身分運作。後續所有真機呼叫皆可安全在此隔離環境下進行，不會誤讀或誤寫使用者真實 `~/.codex`。

## Test 2 — Marketplace／Plugin 安裝生命週期（PASS，使用合成 marketplace，非本 repo 內容）

**重要範疇說明**：T1（本 repo 的 `plugins/loops-workflow/.codex-plugin/plugin.json` 與 `.agents/plugins/marketplace.json`）尚未合併進本 worktree，因此本測試**不是對 dev-workflows 本身**執行，而是用一個結構相同、內容合成的臨時 marketplace（`sample-plugin`，同樣具備 `.agents/plugins/marketplace.json` 根 manifest ＋ `.codex-plugin/plugin.json` plugin manifest ＋ `skills/hello/SKILL.md`）驗證「這整套機制本身在此 Codex 版本上是否運作」。T1 合併後需要用本 repo 真實內容重跑本測試一次，才能把結論套用到 dev-workflows 身上。

| 步驟 | 指令 | 結果 |
|---|---|---|
| 1. 註冊本機 marketplace | `codex plugin marketplace add <合成 marketplace 路徑> --json` | ✅ `{"marketplaceName":"synthetic-smoke-test","installedRoot":"...","alreadyAdded":false}`，exit 0，**不需要登入** |
| 2. 列出可安裝但未安裝的 plugin | `codex plugin list --available --json` | ✅ 回傳 `available: [{"pluginId":"sample-plugin@synthetic-smoke-test","installed":false,"enabled":false,...}]`，不需要登入 |
| 3. 安裝 plugin | `codex plugin add sample-plugin@synthetic-smoke-test --json` | ✅ `{"pluginId":"sample-plugin@synthetic-smoke-test","installedPath":"...","authPolicy":"ON_INSTALL"}`，exit 0，**不需要登入** |
| 4. 確認已安裝狀態 | `codex plugin list --json` | ✅ 回傳 `installed: [{"pluginId":"sample-plugin@synthetic-smoke-test","installed":true,"enabled":true,...}]` |

**這證實了「官方 validator」的實際運作方式**：`codex plugin marketplace add` 與 `codex plugin list` 對 manifest 做的解析／驗證，本身就是安裝路徑上會自然發生的步驟——manifest 結構錯誤會在這幾步當場報錯（本機唯讀探測階段已用使用者真實環境裡一個壞掉的 marketplace 登記證實過這個報錯機制，見 explore 階段記錄）；本測試進一步證實，**這整條路徑（marketplace 註冊→列出→安裝→確認）在此 CLI 版本上完全不需要登入即可完成**。

**結論**：plugin 發現與安裝機制本身確認可行、無需認證。`policy.authentication: "ON_INSTALL"` 這個欄位目前看來不代表「安裝當下就要求登入」，而更可能代表「該 plugin 的能力在實際被呼叫時才會要求認證」——這點未被本測試直接證實，留待 Test 3 的認證邊界確認。

## Test 3 — 認證邊界（安全停，決策者已拍板收斂）

嘗試繼續往下驗證「新 task 是否能發現並呼叫 `dispatch` skill」「hooks 信任流程」「跑一個不改產品 code 的迷你 smoke 任務並留下 `.loops` 記錄」時，發現這些步驟都需要**啟動一個真的 agent turn**（`codex exec` 或互動式 session），而這一定需要認證。隔離 `CODEX_HOME` 下 `codex doctor` 明確回報 `✗ auth no Codex credentials were found`——這是一個全新、未登入的乾淨身分，符合隔離設計的預期，但也代表它結構性地無法執行任何需要呼叫模型的步驟。

依照硬規則：**不得複製使用者真實 `~/.codex` 的 auth 檔案到隔離環境，也不得嘗試以本機真實登入狀態去跑這些步驟**（那會讓「隔離」名不符實，且違反「絕不碰使用者真實環境」的鐵律）。因此在此安全停下、回報決策者三個選項後，**決策者已拍板**：這批需要認證才能驗證的能力維持 `not measured` 收斂，不借用真實 auth、不登入隔離環境去補測。此裁定同時框定後續同一 program 內（#169、#181）Codex 側 agent-turn 類量測的預設處理方式，不再重複詢問。

- 已完成：CODEX_HOME 隔離完整性（Test 1）、marketplace/plugin 安裝生命週期在無認證下確認可行（Test 2，合成內容）。
- **依決策者裁定維持 `not measured`（非暫時性缺口，是收斂後的最終狀態）**：skill discovery（`dispatch` 在新 task 中是否被發現並可呼叫）、hooks 信任流程、guard 觸發探測（matcher 命中／payload 欄位／apply_patch hook 是否觸發）、迷你 smoke 任務與 `.loops` 記錄、transcript／token metrics。
- 獨立於認證邊界之外的前置依賴：T1（platform-engineer 的 `plugins/loops-workflow/.codex-plugin/plugin.json` ＋ `.agents/plugins/marketplace.json`）合併進本 worktree後，仍需對 **dev-workflows 本身**（而非本篇的合成 marketplace）重跑 Test 2，才能把「安裝生命週期無需認證即可行」這個結論套用到本 repo；但 Test 3 這批 `not measured` 列不會因為 T1 合併而改變，其未量測原因是認證邊界，不是內容邊界。

## Capability Matrix 狀態（8 列為決策者拍板後的最終狀態；setup 待 T1 合併＋真實內容重跑 Test 2 後更新）

| 能力 | 狀態 | 依據 |
|---|---|---|
| setup（plugin 發現／安裝機制本身） | `degraded`（機制成立但本篇僅以合成內容驗證，非本 repo 真實內容；且 authPolicy 實際觸發時機未證實——T1 合併後對真實內容重跑會更新此列） | Test 2 |
| skill discovery / `dispatch` | `not measured`（決策者裁定收斂，非暫時性） | Test 3 |
| `AskUserQuestion` 類互動 | `not measured`（決策者裁定收斂，非暫時性） | Test 3 |
| subagent / model profile | `not measured`（決策者裁定收斂，非暫時性） | Test 3 |
| hooks 與 hook 信任 | `not measured`（決策者裁定收斂，非暫時性；另見既有 matcher/tool_name 分析——非本篇範圍） | Test 3 |
| shell / `apply_patch` guard | `not measured`（決策者裁定收斂，非暫時性） | Test 3 |
| worktree | `not measured`（決策者裁定收斂，非暫時性） | Test 3 |
| `.loops/` resume / progress | `not measured`（決策者裁定收斂，非暫時性） | Test 3 |
| transcript / token metrics | `not measured`（決策者裁定收斂，非暫時性） | Test 3 |

## 結論

隔離環境本身可信（Test 1）、plugin 安裝生命週期機制在無認證下確認可行（Test 2，合成內容）；涉及實際呼叫模型的能力（skill discovery、hooks 信任、guard 觸發、smoke 任務、`.loops` 記錄）結構性需要認證才能驗證，已依硬規則安全停、回報決策者三個選項，**決策者已拍板收斂為 `not measured`**，不借用真實 auth、不登入隔離環境去補測——這 8 列是本輪 Codex Preview 的最終狀態，非等待中的缺口。待 T1 合併後，需對 dev-workflows 真實內容重跑 Test 2，把 setup 列的結論從「合成內容驗證」升級為「本 repo 真實內容驗證」；其餘 8 列不受 T1 影響。
