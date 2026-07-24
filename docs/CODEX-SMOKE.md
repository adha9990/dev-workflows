# Codex Preview — Smoke Test 紀錄

> 日期：2026-07-24。在隔離 `CODEX_HOME` 下實際執行真的 Codex CLI，對 dev-workflows 本身的 canonical 內容（`plugins/loops-workflow/.codex-plugin/plugin.json`＋`.agents/plugins/marketplace.json`）驗證安裝生命週期與環境隔離完整性。需要已認證 Codex session 才能繼續的步驟不在本篇驗證範圍內，一律標 `not measured`——本篇不借用真實 auth、不登入隔離環境去補測這批步驟；同時保留這幾步「日後有認證環境時」的可重跑指令，供之後真的量測時直接照抄，不必重新設計。

## 環境

- Codex 執行檔絕對路徑：`C:\Users\Eagle\AppData\Local\OpenAI\Codex\bin\69066b736e1e17a4\codex.exe`（**不在 PATH**，需以絕對路徑呼叫）。
- 版本：`codex-cli 0.146.0-alpha.3.1`（alpha；本篇每筆證據皆對應此版本，日後版本更新須重跑）。
- 隔離規則：全程 `CODEX_HOME=$(mktemp -d)`，絕不讀寫使用者真實 `~/.codex`（含其中的 auth、session、以及已知壞掉的 `eagle-project` marketplace 登記）。每個 Test 各自用一份全新的隔離 `CODEX_HOME`，不共用。
- 測試標的：`plugins/loops-workflow/.codex-plugin/plugin.json`（commit `9e937a0`）＋`.agents/plugins/marketplace.json`（commit `a9df45a`），已合併進本 worktree（merge commit `f7a4335`）。**commit SHA provenance 註記**：本篇引用的 SHA 皆為整合前各 subtask worktree 的本地 commit；本 PR 若經 squash/rebase 合併，最終 PR 歷史的 SHA 會不同——這些 SHA 是撰寫證據當下用來標示「測的是哪個版本內容」的參照，不保證合併後仍查得到同一個雜湊值。要核對本篇證據對應的實際內容，請比對 manifest／marketplace.json 檔案本身（name/version 是否等值、skills 路徑是否為 `./skills/` 等），不要只依賴 SHA 字串比對。
- **安裝路徑 provenance 註記（兩個階段，證據來源不同）**：`docs/CODEX-QUICKSTART.md` 教使用者用的是 GitHub owner/repo 簡寫（`codex plugin marketplace add adha9990/dev-workflows`，走 GitHub remote 解析）；Test 2／Test 4 用的是本機檔案系統絕對路徑（worktree 的本地路徑，因為撰寫證據當下 T1 的兩個新檔尚未推上真實 GitHub remote）；owner/repo 簡寫這條路徑另外由 Test 6 直接對真實 remote 實測過，兩個階段的證據狀態如下：
  - **pre-merge（已實測，見 Test 6）**：owner/repo 簡寫指令**真的用 Codex CLI 執行成功過**（隔離 CODEX_HOME、免登入，exit 0）——不是「Claude Code 讀文件字面確認寫得通」這種弱證據，是 Codex 實際對 GitHub remote 做了 clone/fetch，靠既有的 Claude 相容解析層讀到 `.claude-plugin/marketplace.json` 完成整條安裝生命週期。細節見 Test 6。
  - **post-merge（尚未驗證，留給下一輪）**：PR 合併推上 GitHub、remote 上同時存在兩份 marketplace manifest 之後，同一條 owner/repo 簡寫指令預期會依 Test 4a 的結論改採 `.agents/plugins/marketplace.json`（Codex-native）——但這是**推論**，不是本篇任何一個 Test 直接驗證過的結果；合併後應該用同一條指令重跑一次 Test 2／Test 4／Test 6，把「post-merge 改採 Codex-native」這個推論換成真實證據。

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

**範疇澄清（修正先前版本的誤植）**：本測試驗證的是「plugin 本身能不能被 Codex 發現並安裝」這件事，屬於 capability matrix 的 **skill discovery / `dispatch`** 列的前置條件證據（安裝完成後 `installedPath` 顯示整個 plugin 目錄——含 `skills/`——確實被複製進 Codex 的 plugin cache，代表 skill 檔案在檔案層級是可被發現的；但「新 task 中是否真的被辨識為可呼叫的 skill」仍是 Test 3a 的未量測範圍，兩者不是同一件事）。**不是** capability matrix 裡的 **`setup`** 列——那一列指的是 `/loops-workflow:setup`（issue #168 規劃中的正式安裝來源管理 skill：問答選擇來源、idempotent 安裝/切換/更新/健康檢查/rollback），這個 skill 在本 repo 的 `plugins/loops-workflow/skills/` 底下**目前還不存在**（現有 11 個 skill 是 build/clarify/define/dispatch/explain/explore/goal/iterate/plan/scaffold-fullstack/verify，沒有 setup；repo 內也搜不到任何 `loops-workflow:setup` 引用）——這是兩邊 harness 都尚未建置的功能，不是任一 harness 的能力落差，矩陣的 `setup` 列因此不該引用本測試的證據。

## Test 4 — 雙 marketplace 並存優先權 + Remove 生命週期（PASS）

補測，隔離 `CODEX_HOME`（非 OS 暫存目錄、非使用者 `~/.codex`，測完整個刪除），標的是 integration worktree（`.claude/worktrees/182-codex-bootstrap`，HEAD `fdb8463`），該 worktree 此時**同時含** `.claude-plugin/marketplace.json` 與 `.agents/plugins/marketplace.json` 兩份 marketplace manifest（單一 canonical 內容樹＋雙薄 entry-point 的設計本來就是這樣，不算複製違規——複製違規指的是 `skills/`／`references/` 這類內容樹被複製第二份，不是入口 manifest 本身）。

### 4a. 兩份 marketplace 並存時，Codex 讀哪一份

| 步驟 | 指令 | 結果 |
|---|---|---|
| 1. 註冊 | `codex plugin marketplace add "<integration worktree 路徑>"` | ✅ `Added marketplace \`dev-workflows\` from ...182-codex-bootstrap.`，exit 0 |
| 2. 列出 marketplace | `codex plugin marketplace list --json` | ✅ `{"marketplaces":[{"name":"dev-workflows","root":"...182-codex-bootstrap"}]}` |
| 3. 列出可安裝 plugin | `codex plugin list --available --json` | ✅ 一筆：`pluginId=loops-workflow@dev-workflows, version=0.56.4, source={local,...\plugins\loops-workflow}, marketplaceSource={local,...182-codex-bootstrap}, installPolicy=AVAILABLE, authPolicy=ON_INSTALL` |
| 4. 安裝 | `codex plugin add loops-workflow@dev-workflows` | ✅ `Added plugin \`loops-workflow\`...`，installedPath `...\plugins\cache\dev-workflows\loops-workflow\0.56.4` |
| 5. 確認 | `codex plugin list --json` | ✅ installed 一筆（installed:true, enabled:true） |
| 6. **判定關鍵** | `codex plugin list`（**非** `--json`，人讀輸出） | 逐字印出：<br>`Marketplace \`dev-workflows\``<br>`C:\...\182-codex-bootstrap\.agents\plugins\marketplace.json`<br>`PLUGIN ... STATUS ... VERSION ... PATH`<br>`loops-workflow@dev-workflows  installed, enabled  0.56.4  ...\plugins\loops-workflow` |

**結論**：兩份 marketplace manifest 同時存在時，**Codex 明確採用 `.agents/plugins/marketplace.json`（Codex-native 格式），不是 `.claude-plugin/marketplace.json`**——這是好消息，代表不需要擔心兩份入口互相打架或行為不確定；Codex 會忽略 Claude 專用格式、只認自己的格式。**方法論註記**：`--json` 系列輸出（`marketplace list`／`plugin list`）不會回吐 manifest 路徑或 `category`／`interface.*` 等 Codex-only 欄位，這個判定只能從**非 `--json` 的人讀輸出**裡讀到，日後重跑或設計自動化檢查時要注意這點，不能只看 `--json`。另外，安裝後 plugin cache 目錄（`...\0.56.4\`）底下同時含 `.claude-plugin` 與 `.codex-plugin`——因為 Codex 是把整個 plugin 目錄複製進 cache，不是只取 Codex 需要的子集，這點不是複製違規（cache 是 Codex 自己的安裝副本，不是 repo 裡的第二份內容樹）。

### 4b. Remove 生命週期（PASS）

| 步驟 | 指令 | 結果 |
|---|---|---|
| 1. 移除 plugin | `codex plugin remove loops-workflow@dev-workflows` | ✅ `Removed plugin \`loops-workflow\` from marketplace \`dev-workflows\`.`，exit 0 |
| 2. 確認已移除 | `codex plugin list --json` | ✅ `{"installed":[],"available":[]}` |
| 3. 移除 marketplace | `codex plugin marketplace remove dev-workflows` | ✅ `Removed marketplace \`dev-workflows\`.`，exit 0 |
| 4. 確認已移除 | `codex plugin marketplace list --json` | ✅ `{"marketplaces":[]}` |

**結論**：停用／移除的確切指令是「先 `codex plugin remove loops-workflow@dev-workflows`，再 `codex plugin marketplace remove dev-workflows`」，兩步皆無需認證、皆可重跑驗證乾淨移除。這組指令可直接供 `docs/CODEX-QUICKSTART.md` 的「常見問題、停用／移除方式」一節引用。

## Test 5 — 輔證據：官方 scaffold `validate_plugin.py`（離線，PASS）

- 來源：`openai/codex` repo `codex-rs/skills/src/assets/samples/plugin-creator/scripts/validate_plugin.py`（commit `7c71783135b020e8f4db3fa26dc4319901c260b5`，2026-07-24 抓取；唯讀 `gh api` fetch 到暫存目錄，未動本 repo 其他內容）。
- 執行：`python "<temp>/validate_plugin.py" plugins/loops-workflow`（`python` 3.13.12，非 `python3`——本機只有 `python` 別名可用）。
- **第一次跑**（manifest 當時缺 `interface.defaultPrompt`）：
  ```
  Plugin validation failed:
  - plugin.json field `interface.defaultPrompt` or `interface.default_prompt` is required
  ```
  exit 1。
- manifest owner 補上 `interface.defaultPrompt`（3 條範例提示，皆指向 dispatch）後，**本篇獨立重跑同一支腳本、同一個 commit SHA** 確認：
  ```
  Plugin validation passed: <plugins/loops-workflow 絕對路徑>
  ```
  exit 0（**PASS**）。

**一致性註記**：`interface.defaultPrompt` 是這支離線 scaffold validator 的必填欄位，但 Test 2／Test 4／Test 6 已經證實**真的 Codex CLI** 在**缺少**這個欄位的舊版 manifest 上一樣能完整跑完整條安裝生命週期，沒有因為缺這個欄位拒收——代表這是 scaffold 建議的較完整寫法，不是 runtime 解析器實際強制的必要欄位集合（呼應規劃階段就預期的「`validate_plugin.py` 與實際 runtime 一致性不保證」）。補上這個欄位讓 manifest 同時對齊官方三份真實範例（superpowers／latex／browser 皆有此欄位）與這支離線 validator，是額外的完整性提升，不代表先前的 manifest 有導致真實安裝失敗的 bug。

## Test 6 — GitHub owner/repo 簡寫安裝生命週期（真遠端，PASS，補齊 provenance 第一手證據）

先前 Test 2/Test 4 只驗過本機檔案系統絕對路徑；`docs/CODEX-QUICKSTART.md` 教使用者用的是 GitHub owner/repo 簡寫（`codex plugin marketplace add adha9990/dev-workflows`）。本測試在隔離 `CODEX_HOME` 下**親自對真實 GitHub remote** 跑一次這個確切指令，補上這條路徑的第一手落地證據（免登入，走 git clone/fetch，不是 Codex 模型呼叫）。

| 步驟 | 指令 | 結果 |
|---|---|---|
| 1. 註冊（git remote 形式） | `codex plugin marketplace add adha9990/dev-workflows --json` | ✅ `{"marketplaceName":"dev-workflows","installedRoot":"...\.tmp\marketplaces\dev-workflows","alreadyAdded":false}`，exit 0，**不需要登入** |
| 2. 列出可安裝 plugin | `codex plugin list --available --json` | ✅ 一筆：`pluginId=loops-workflow@dev-workflows, version=0.56.4, marketplaceSource={sourceType:"git", source:"https://github.com/adha9990/dev-workflows.git"}` |
| 3. 安裝 | `codex plugin add loops-workflow@dev-workflows --json` | ✅ `installedPath=...\plugins\cache\dev-workflows\loops-workflow\0.56.4` |
| 4. 確認 | `codex plugin list --json` | ✅ installed 一筆（installed:true, enabled:true） |
| 5. **判定關鍵** | `codex plugin list`（非 `--json`，人讀輸出） | 逐字印出：`Marketplace \`dev-workflows\``<br>`...\.tmp\marketplaces\dev-workflows\.claude-plugin\marketplace.json` |

**Provenance 結論（呼應「環境」段的兩條路徑註記，這裡補上實測）**：步驟 5 證實——**在這個 PR 尚未合併推上 GitHub 的當下**，真實 remote `adha9990/dev-workflows` 的預設分支只有 `.claude-plugin/marketplace.json`（這是既有的 Claude 專用檔，本 PR 之前就存在），Codex 靠自己的 Claude 相容解析層讀到了這份檔案並成功完成整個安裝生命週期——這不是本 PR 新增的 `.agents/plugins/marketplace.json` 在起作用，因為那份檔案這個時間點根本還沒推上 GitHub。這條路徑印證了 issue #182 原文提到的「Codex 雖可相容讀取部分 Claude marketplace 資訊」是真的、且此刻正在被使用。**待這個 PR 真的合併推上 GitHub 之後**，remote 上會同時存在兩份 marketplace manifest，依 Test 4a 的結論，屆時 Codex 應該會改採用 `.agents/plugins/marketplace.json`（Codex-native）——但這是推論，PR 合併後應該用同一條指令（`codex plugin marketplace add adha9990/dev-workflows`）重跑一次本測試，把「合併後」的結果也補上真實證據，不能只靠推論收尾。兩個階段使用者打的指令完全相同，差別只在 Codex 內部解析到哪一份檔案。

## Test 3 — 認證邊界（範疇邊界：not measured）

嘗試繼續往下驗證「新 task 是否能發現並呼叫 `dispatch` skill」「hooks 信任流程」「guard 觸發探測」「跑一個不改產品 code 的迷你 smoke 任務並留下 `.loops` 記錄」時，發現這些步驟都需要**啟動一個真的 agent turn**（`codex exec` 或互動式 session），而這一定需要認證。隔離 `CODEX_HOME` 下 `codex doctor` 明確回報 `✗ auth no Codex credentials were found`——這是一個全新、未登入的乾淨身分，符合隔離設計的預期，但也代表它結構性地無法執行任何需要呼叫模型的步驟。

這是本篇刻意畫定的範疇邊界：**不提供認證、不借用使用者真實 `~/.codex` 的 auth 檔案、不登入隔離環境**去補測需要呼叫模型的步驟——這條邊界是穩定狀態，不是尚待補齊的暫時缺口。

下列每項皆為**這個邊界內的最終狀態**（非暫時性缺口），並附上「日後有認證環境時」的可重跑指令，供直接照抄執行：

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

## Capability Matrix 狀態

| 能力 | 狀態 | 依據 |
|---|---|---|
| `setup`（`/loops-workflow:setup`，issue #168 規劃中的正式安裝來源管理 skill） | Claude Code／Codex Preview 皆 `not supported`——這個 skill 兩邊都還沒建置，不是任一 harness 的能力落差 | 逐檔搜尋 `plugins/loops-workflow/skills/`，確認不存在此 skill、repo 內無 `loops-workflow:setup` 引用 |
| skill discovery / `dispatch` | `not measured`（範疇邊界，非暫時性缺口；plugin 安裝完成後 skill 檔案已確認落在 Codex plugin cache 內，但新 task 中是否真的被辨識為可呼叫 skill 仍未量測，見 Test 2 範疇澄清） | Test 2（安裝前置）＋Test 3a（未量測部分） |
| `AskUserQuestion` 類互動 | `not measured`（範疇邊界，非暫時性缺口） | Test 3 |
| subagent / model profile | `not measured`（範疇邊界，非暫時性缺口） | Test 3 |
| hooks 與 hook 信任 | `not measured`（範疇邊界，非暫時性缺口；官方文件載相容別名，但版本修復史與 payload 欄位兩軸未實測） | Test 3b–3h |
| shell / `apply_patch` guard | `not measured`（範疇邊界，非暫時性缺口；官方文件載相容別名，但版本修復史與 payload 欄位兩軸未實測） | Test 3c–3h |
| worktree | `not measured`（範疇邊界，非暫時性缺口） | Test 3 |
| `.loops/` resume / progress | `not measured`（範疇邊界，非暫時性缺口） | Test 3i |
| transcript / token metrics | `not measured`（範疇邊界，非暫時性缺口） | Test 3 |

## 方法論

- **隔離鐵則**：全程 `CODEX_HOME=$(mktemp -d)`，每個 Test 各自一份全新目錄，絕不讀寫使用者真實 `~/.codex`（含真實 auth/session、以及已知壞掉的 `eagle-project` marketplace 登記——那是使用者資料，只做觀察紀錄，不修改）。
- **版本釘死**：本篇每一筆證據皆對應 `codex-cli 0.146.0-alpha.3.1`（alpha channel）。alpha 版本變動快，日後若 Codex 版本更新，本篇結論需要重新驗證，不能假設歷史結果仍然成立。
- **合成內容 vs 真實內容**：Test 2 最初以合成 marketplace（因 T1 尚未合併）驗證機制本身是否可行；T1 合併後已改對 dev-workflows 真實內容重跑一次，取代先前的合成內容證據作為主結論依據。
- **not measured 的範疇邊界性質**：Test 3 所列 8 個矩陣列的 `not measured` 不是「還沒空測」的暫時狀態，而是本篇畫定的範疇邊界——需要真的呼叫模型（agent turn）的能力不在本輪驗證範圍內，這條邊界是穩定狀態；已附上可重跑指令，供日後真的有認證環境時直接執行，不必重新設計測試步驟。

## 已知限制

- 本篇未驗證任何需要真的 agent turn（呼叫模型）的能力；這是本輪 Codex Preview 的範疇邊界，非缺陷。
- `codex` 執行檔不在系統 PATH 上，所有指令皆需以絕對路徑呼叫——這點也需要寫進 `docs/CODEX-QUICKSTART.md`，避免新使用者以為 `codex` 是可以直接打的裸指令。
- `CODEX_HOME` 若字面落在 OS 暫存資料夾下會印出一則無害的 PATH 別名警告（見 Test 1），不影響功能，但使用者可能誤以為是錯誤。
- **安裝路徑範疇邊界**：本篇所有安裝證據都是本機檔案系統絕對路徑，不是 README／QUICKSTART 教的 GitHub owner/repo 簡寫路徑（`adha9990/dev-workflows`）——後者要等本 PR 真的合併並推上 GitHub 之後才能重跑驗證，目前未被本篇任何 Test 覆蓋。
- **commit SHA 僅供撰寫當下參照**：本篇引用的 commit SHA 是整合前各 subtask worktree 的本地 commit，PR 若經 squash/rebase 合併，最終歷史的 SHA 會不同；核對證據對應內容請比對檔案本身，不要依賴 SHA 字串比對。
