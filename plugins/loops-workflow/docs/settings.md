# settings.md — 可以在 settings.json 設定哪些參數

loops-workflow 的每個開關都是**環境變數**，設在 Claude Code `settings.json`（專案 `.claude/settings.json` 或全域 `~/.claude/settings.json`）的 `env` 區塊。

## 推薦：多數人一個參數都不用設

每個參數都有**合理預設** —— 防護 / 觀測類裝好就生效、自動化 / 偏好類預設關。**大多數人不用動任何設定**，直接用預設跑：

```json
{
  "env": {}
}
```

只有「**想改某個預設行為**」時，才把對應那**一條**加進 `env`。下面總表以「**預設**」為主軸：每個參數預設是什麼、想改成非預設時怎麼設。

> **值一定要用引號包成字串**（`"1"` 不是 `1`）：除 `LOOPS_AUTO`／`LOOPS_EXPLAIN` 外的參數由 hook 程式碼（`hook-flags.mjs`）強制只認字面字串 `'0'`/`'1'`；布林 `true`/`false` 會變字串 `"true"`/`"false"` 被當「怪值」落回預設（看起來像「設了沒生效」）。改完 settings.json 要**開新 session** 才載入。

## 全部參數一覽（以「預設」為主軸）

### 防護 / 觀測（**預設開**，裝好就生效；想改成不生效才設 `"0"`）

安全防護與純觀測類，**多數人不用碰**。

| 參數 | 預設 | 幫你做什麼 | 想改成非預設 |
|---|---|---|---|
| `LOOPS_PATH_CONTAINMENT` | **開** | 擋「loop 記錄被誤寫進 worktree」（會被清掉、毀掉歷程）—— 寫錯位置直接拒絕並指路 | 設 `"0"` |
| `LOOPS_CONFIG_PROTECTION` | **開** | 擋「為了讓 lint 過而弱化 eslint/prettier 等設定檔」；預設只在有 `.loops/` 的 repo 生效、日常編輯不受影響（顯式 `"1"`＝擴大為全域） | 設 `"0"` |
| `LOOPS_COST_TRACKER` | **開** | 每回合把 token 成本記到 `.loops/.metrics/costs.jsonl`（by-stage ＋ 子代理歸戶；純觀測、只在有 `.loops/` 的 repo 寫） | 設 `"0"` |
| `LOOPS_EVAL_GATE`／`LOOPS_EVAL_TAGS_GATE`／`LOOPS_EVAL_POLL_GATE` | **開** | 改檔回合檢查 eval 成績退化 / 哪類 eval 失敗 / judge 共識 —— **沒有 eval 資料就完全沉默**（跑 eval harness 的人才感受得到） | 各設 `"0"` |

### 自動化 / 執行（**預設關**；想用才設 `"1"`）

⚠ **這三個會自動執行 repo 定義的命令 —— 只在你信任的 repo 開**（等同自動跑 repo 控制的 code，完整風險說明見 `references/journaling.md`）。

| 參數 | 預設 | 幫你做什麼 | 想改成非預設 | ⚠ 授權範圍 |
|---|---|---|---|---|
| `LOOPS_STOP_GATE` | **關** | 改檔回合自動跑 lint/type、紅燈才提醒 | 設 `"1"` | 自動執行 repo `gate.config.json` 的 lint/type 命令 |
| `LOOPS_LOOP_DRIVER` | **關** | build 階段機械續跑（state.json 外置、Stop 自動接下一任務） | 設 `"1"` | 自動執行 test/lint/type（比 stop-gate 寬，含 test） |
| `LOOPS_AUTO` | **關** | 核准計畫一次後、決策點自動帶推薦選項連跑（危險 / 失敗仍硬停） | 設 `"1"` | 也會讓 loop-driver 覆蓋 closed 模式（見 `references/auto-mode.md`） |

### 個人偏好（**預設關**；想要才設 `"1"`）

| 參數 | 預設 | 幫你做什麼 | 想改成非預設 |
|---|---|---|---|
| `LOOPS_EXPLAIN` | **關** | 完整迴圈完工時自動產「工程師理解包」（`EXPLAIN.md`）；沒開＝不產、Journal 留一行 | 設 `"1"` |
| `LOOPS_COMPACT_HINT` | **關** | context 快滿時提醒你可以 `/compact`（不阻擋、只提示） | 設 `"1"` |

> **不吃旗標、一律產的收尾產物**：完整迴圈完工還會**一律產 `CHECKLIST.md`**（驗收清單，人類 / AI 共用，見 `references/acceptance-review.md §六`）—— 它**不受任何參數控制**，`LOOPS_EXPLAIN` 沒開也有。

## 怎麼自己驗證有沒有生效

1. **確認 env 有傳進來**：在 Claude Code 裡跑 `node -e "console.log(process.env.LOOPS_EXPLAIN)"`（換成你設的參數名）—— 印出你設的值＝有生效；印 `undefined`＝settings.json 位置或格式錯了。
2. **行為驗證**：設 `"LOOPS_EXPLAIN": "1"` 後跑完一條完整 loop，收尾應自動產 `EXPLAIN.md`；或設 `"LOOPS_COST_TRACKER": "0"` 後確認 `.loops/.metrics/costs.jsonl` 不再新增行。
3. 改完 settings.json 要**開新 session** 才會載入。

## 進階 / 內部（一般使用者不用管）

- `LOOPS_SANDBOX_RUNNER`（`docker`/`podman`/`none`）：eval sandbox 用哪個容器執行器 —— 跑 eval harness 的人才需要，詳 `references/eval-harness.md`。
- `LOOPS_LOOP_DRIVER_GATE_SCRIPT`：loop-driver 測試注入用的內部參數，正常使用不要設。
- `LOOPS_ROOT` 是「主 repo 根目錄」的**代稱**（文檔與錯誤訊息用語），不是環境變數；`CLAUDE_CODE_SESSION_ID` 由 Claude Code 自動帶入，不用手設。

> 本檔管「**怎麼用**」；每個參數**為什麼是這個預設**（決策理由與完整行為細節）＝`references/journaling.md` 的 flag 決策表與逐條說明，兩邊互為索引。
