# settings.md — 可以在 settings.json 設定哪些參數

loops-workflow 的所有開關都是**環境變數**，設在 Claude Code `settings.json`（專案 `.claude/settings.json` 或全域 `~/.claude/settings.json`）的 `env` 區塊。例如：

```json
{
  "env": {
    "LOOPS_STOP_GATE": "1",
    "LOOPS_COST_TRACKER": "0"
  }
}
```

> **值一定要用引號包成字串**（`"1"` 不是 `1`）——上表除 `LOOPS_AUTO` 外的參數由 hook 程式碼（`hook-flags.mjs`）強制只認字面字串 `'0'`/`'1'`；布林 `true`/`false` 會變成字串 `"true"`/`"false"` 被當「怪值」落回預設，看起來像「設了沒生效」。`LOOPS_AUTO` 主要是 skill 層慣例（agent 讀指令判斷），但另被 loop-driver hook 程式碼直讀（同樣僅認字面 `'1'`）——語意相同但保證強度不同，一律照本檔寫法設字串最保險。（`LOOPS_EXPLAIN` 已淘汰、無作用，見下表。）

> 本檔管「**怎麼用**」；每個參數**為什麼是這個預設**（決策理由與完整行為細節）＝`references/journaling.md` 的 flag 決策表與逐條說明，兩邊互為索引。

## 預設開（想關才需要設，值填 `"0"`）

這 9 個是安全防護／觀測類，裝好 plugin 就生效，**只有字面 `"0"` 能關**：

| 參數 | 幫你做什麼 | 想關掉 |
|---|---|---|
| `LOOPS_PATH_CONTAINMENT` | 擋住「loop 記錄被誤寫進 worktree」（會被清掉、毀掉歷程）——寫錯位置時直接拒絕並指路 | `"LOOPS_PATH_CONTAINMENT": "0"` |
| `LOOPS_COST_TRACKER` | 每回合把 token 成本記到 `.loops/.metrics/costs.jsonl`（只在有 `.loops/` 的 repo 寫、純觀測） | `"LOOPS_COST_TRACKER": "0"` |
| `LOOPS_EVAL_GATE` | 改檔回合自動檢查 eval 成績有沒有退化，退化才提醒（沒有 eval 資料＝完全沉默） | `"LOOPS_EVAL_GATE": "0"` |
| `LOOPS_EVAL_TAGS_GATE` | 同上，提醒「哪一類 eval 在失敗」 | `"LOOPS_EVAL_TAGS_GATE": "0"` |
| `LOOPS_EVAL_POLL_GATE` | 同上，顯示 judge panel 共識計數 | `"LOOPS_EVAL_POLL_GATE": "0"` |
| `LOOPS_CONFIG_PROTECTION` | 擋住「為了讓 lint 過而弱化 eslint/prettier 等設定檔」——預設只在有 `.loops/` 的 repo 生效，日常編輯不受影響；顯式設 `"1"`＝擴大為全域生效（不限 `.loops/` repo） | `"LOOPS_CONFIG_PROTECTION": "0"` |
| `LOOPS_WORKTREE_GUARD` | 擋住「在主 checkout 直接 `git checkout -b`／`switch -c` 開 loop 分支」（loop 的 code 應在隔離 worktree 做）——擋下時指路 `git worktree add` | `"LOOPS_WORKTREE_GUARD": "0"` |
| `LOOPS_COMMENT_GUARD` | 擋住對外訊息（comment／issue／PR 的建立與編輯）沒先讀過規範就送出，外加 @點名真人、客套開場、`.loops/` 路徑外洩、亂碼、整段技術英文未轉譯成中文（comment-policy 機械化，#131 v2） | `"LOOPS_COMMENT_GUARD": "0"` |
| `LOOPS_PR_GATE` | 在 loop 分支上擋住「還沒過三閘就 `gh pr create`」——①build 完沒先跑 verify ②沒帶 `--draft`／`--assignee @me` ③issue 編號 slug 的 PR body 沒行首寫 `Closes #issue`；非 loop 分支不管（#132） | `"LOOPS_PR_GATE": "0"` |

## 預設關（想用才需要設，值填 `"1"`）

這 5 個涉及自動執行、注入或個人偏好，**只有字面 `"1"` 能開**：

| 參數 | 幫你做什麼 | 想開 | ⚠ SECURITY |
|---|---|---|---|
| `LOOPS_AUTO` | 自動連跑：核准計畫一次後，決策點用推薦選項自動帶過（危險／失敗仍硬停） | `"LOOPS_AUTO": "1"` | —（詳 `references/auto-mode.md`；注意它也會讓 loop-driver 覆蓋 closed 模式） |
| `LOOPS_EXPLAIN` | **已淘汰（無作用）**——explain 現為完整迴圈完工**一律產**的三份 deliverable 之一（`deliverables/explain.md`），不再由旗標 gate（見 `skills/iterate` §6）。此列僅為向後相容保留、設不設都不影響 | —（不需設） | — |
| `LOOPS_STOP_GATE` | 改檔回合自動跑 lint/type 檢查、紅燈才提醒 | `"LOOPS_STOP_GATE": "1"` | 啟用＝授權「在每個改檔回合自動執行 `.loops/gate.config.json` 內定義的 `lint`/`type` 命令」（以及偵測到的 lint/test 工具）。這些命令來自 repo、等同自動執行 repo 控制的 code。**請只在你信任的 repo 開此 flag。**——全文見 `references/journaling.md` |
| `LOOPS_LOOP_DRIVER` | build 階段機械續跑（任務外置 state.json、Stop 自動接下一個任務） | `"LOOPS_LOOP_DRIVER": "1"` | 啟用＝授權「build 完工判定時自動執行 `.loops/gate.config.json` 定義（或自動偵測）的 test/lint/type 命令」——執行面比 stop-gate（僅 type,lint）更寬（含 test）；且 block reason 會把 state.json 的任務文字注入 context（已消毒＋框定，防護是降低而非消除）。**請只在你信任的 repo 開此 flag。**——全文見 `references/journaling.md` |
| `LOOPS_COMPACT_HINT` | context 快滿時提醒你可以 `/compact` | `"LOOPS_COMPACT_HINT": "1"` | — |

## 怎麼自己驗證有沒有生效

1. **確認 env 有傳進來**：在 Claude Code 裡跑 `node -e "console.log(process.env.LOOPS_STOP_GATE)"`（換成你設的參數名）——印出你設的值＝有生效；印 `undefined`＝settings.json 位置或格式錯了。
2. **行為驗證（挑一個便宜的）**：設 `"LOOPS_COST_TRACKER": "0"` 後確認 `.loops/.metrics/costs.jsonl` 不再新增行；或跑完一條完整 loop，收尾應在 `.loops/<slug>/deliverables/` 產出 `explain.md`＋`checklist.md`＋`cost.md` 三份。
3. 改完 settings.json 要**開新 session** 才會載入。

## 進階／內部（一般使用者不用管）

- `LOOPS_SANDBOX_RUNNER`（`docker`/`podman`/`none`）：eval sandbox 用哪個容器執行器——跑 eval harness 的人才需要，詳 `references/eval-harness.md`。
- `LOOPS_LOOP_DRIVER_GATE_SCRIPT`：loop-driver 測試注入用的內部參數，不要在正常使用設定。
- 你可能在文檔看到的 `LOOPS_ROOT`：那是「主 repo 根目錄」的**代稱**（文檔與錯誤訊息用語），不是環境變數；`CLAUDE_CODE_SESSION_ID` 由 Claude Code 自動帶入，不用手設。
