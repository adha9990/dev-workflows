# dev-workflows

> 個人開發工作流 plugin marketplace（測試性）。目前 **1 個 plugin**：

| Plugin | 用途 | 怎麼用 |
|---|---|---|
| **loops-workflow** | 7 階段閉環開發工作流（**既有專案**內加功能 / 設計 / 修問題）+ 內建 greenfield 專案 scaffold | `/loops-workflow:dispatch <一句話>` |

## 安裝

```
/plugin marketplace add adha9990/dev-workflows  # 從 GitHub 加入 marketplace（owner/repo 簡寫）
/plugin install loops-workflow@dev-workflows    # 閉環開發 + 內建 greenfield scaffold（單一 plugin）
/reload-plugins
```

**怎麼用**：一律 `/loops-workflow:dispatch <想做的事>` —— 既有專案內開發直接分流到對的階段；空資料夾則由 dispatch 偵測到乾淨專案、確認後自動走內建 scaffold 建骨架。

---

# loops-workflow（plugin）

## 一句話

你打**一個**指令 `/loops-workflow:dispatch <想做的事>`，它就把這件事跑完一條「開發產線」：判斷你要做什麼 → 探索做法 → 拍板規劃 → 寫 code（測試先行）→ 獨立審查 → 修到好 → 開 PR。**全程只在真正該你拍板的地方停下問你**（選做法 / 拍板方案 / 完工），其餘自己往下；你隨時能插話喊停或改。各階段產出寫進 `.loops/<slug>/` 的 markdown 當「階段間記憶」，中斷了也接得回來。

> 📊 想看每階段用哪些 agent / 機制的**完整流程圖**（含 mermaid）→ [`docs/FLOW.md`](plugins/loops-workflow/docs/FLOW.md)；**共用規範目錄** → [`docs/REFERENCES.md`](plugins/loops-workflow/docs/REFERENCES.md)。

## 只有一個指令

**`/loops-workflow:dispatch <一句話 / issue# / PR# / slug>`** —— 唯一入口。判類型、開一條 loop、自動往下跑；**輸入既有 loop 的 slug 就自動接續**（resume）。其餘能力都不是指令：

| 你想要 | 怎麼做 |
|---|---|
| 接續中途的 loop | `dispatch <slug>`（自動偵測 `.loops/<slug>/loop.md`） |
| 看某條 loop 跑到哪 | 直接開 `.loops/<slug>/PROGRESS.md`（恆開 hook 每回合自動重生；開場也會自動浮出 active 迴圈） |
| 空資料夾建全端 TS 骨架 | `dispatch` 偵測到乾淨專案、確認後自動走內建 scaffold |
| 工程師理解包 | `LOOPS_EXPLAIN=1` 時完整迴圈完工**自動產**；其他情境用自然語言請 Claude 跑 `explain` skill |
| 維護 repo 的 `AGENTS.md` | iterate 完工命中維護時機由主線依 docs-policy 直接編輯；或自然語言請求 |
| 自動連跑（auto） | 環境變數 `LOOPS_AUTO=1`（見 `references/auto-mode.md`） |

## 內部怎麼跑（下面 7 個階段你不用打、dispatch 自動驅動）

這些階段全標了 **`user-invocable: false`——不會出現在 `/` 選單、你也不能直接 `/loops-workflow:<階段>` 呼叫**，一律由 dispatch 內部用 Skill tool 驅動：

```
前置（dispatch 視情況先走）：clarify 釐清模糊需求｜scaffold 建骨架｜define 開 issue
        │
dispatch → goal → explore → plan → build → verify → iterate
                                                        │
                  回 goal / explore / plan / build ◀────┤（≤ 3 圈，修完一定再 verify）
                                                        └──▶ 完工（交 PR / 收尾）
```

> **只在真正該你選的決策點才停**（用 `AskUserQuestion`）：explore 選做法 / plan 拍板 / iterate 完工或回環 / 真正的 scope 取捨 / 安全停（分類模糊·危險操作·P0·規格不清）。**其餘 routine 轉場直接往下**，產出寫進 `.loops/`。**修完一定再過一輪 verify**（不是「測試綠」就算完）。需要時設 `LOOPS_AUTO=1` 開 opt-in 自動連跑。

### 每個階段在做什麼

「停下問你？」欄：✋ = 一定停下用 `AskUserQuestion` 的真決策點；其餘只在列出的條件才停。**下表是階段名、不是指令**——你打的永遠是 `dispatch`，它才是唯一入口。

| 階段 | 停下問你？ | 做什麼 |
|---|---|---|
| **dispatch**（入口） | 僅分類模糊 / 要 scaffold 才停 | 判類型分流：乾淨空專案→scaffold / issue→goal / 沒 issue 的待辦→define / 純研究→explore / PR 回饋→iterate。建 `loop.md`、進起點階段 |
| **define**（前置） | 有 blocking 決策才停 | 模糊點子 → 一次一問釐清 → 用 repo 的 issue 模板開一張 template-ready issue → 再進 goal |
| **goal** | 有 scope 取捨才停 | 逐句掃 issue 抽出需求（不只 AC 段）→ 訪談 → 寫成「六欄完工定義」+ 可驗證的停止條件 |
| **explore** | ✋ 選做法 | 先找內部可重用的 → 不夠才搜外部（省資源）→ 攤開比較 + 推薦讓你選；框架 API 查官方文件 |
| **plan** | ✋ 拍板方案 | 決策留痕 + 畫機制圖（拍板時渲染給你看）+ 新套件 ≥3 候選評估 + 拆成能各自驗證的任務 |
| **build** | 危險 / 卡關才停 | 逐任務**紅綠分離**：test-author 只看需求寫測試（看不到實作）、impl-author 只負責轉綠（不准改測試）→ 重構 → 分段 commit |
| **verify** | 出 P0 才停 | 同一回合派**多個獨立 reviewer** 各審一面（正確性 / 契約 / 安全 / 效能 / 測試…）+ 跑真 app + 二輪驗證 findings → 判 Ready / 退回 |
| **iterate** | ✋ 完工 / 回環 | 把 verify 或 PR 回饋分類 → **真問題一律自動全修**（修根因 + 加回歸測試）→ 修完再驗一輪 → 乾淨才收尾開 PR。回環最多 3 圈 |

## 兩個引擎

- **build 紅綠分離**：`test-author`（只看需求、看不到 impl）→ `impl-author`（只轉綠、不准改 test）→ Refactor → 衝突派 `referee` 裁決。讓測試不會遷就實作。
- **verify fan-out**：主線同回合派最多 6 個核心 reviewer（依風險 0~6；product-contract / architecture / security / performance / code-quality / tests）各審一軸 + 條件式領域 reviewer + `finding-validator` 二輪，輸出 Ready / Not ready。

## 看進度（直接讀 `.loops/`）

迴圈進度全寫在 `.loops/<slug>/`：`loop.md`（狀態 + Journal 事件日誌）與 **`PROGRESS.md`**（可讀儀表板：mermaid 階段圖 + checkbox + Journal 時間軸）。**免安裝、零 token、跨平台**——開 `.loops/<slug>/PROGRESS.md` 的 markdown preview 即可，由恆跑的 Stop hook **每回合自動重生**、永遠最新；SessionStart hook 也會在開場自動浮出所有 active 迴圈（slug / 階段 / 模式 / 最後一筆 Journal）。

> 機制：`scripts/progress.mjs`（renderer，吃 `loop.md` + `0N-*.md`）由恆跑 Stop hook `hooks/progress-render.mjs` 驅動，每回合對「本 session 正在跑」的 loop 重生 `PROGRESS.md`（靠 `CLAUDE_CODE_SESSION_ID` 比對，已完工 / 別 session 不顯示）。`PROGRESS.md` 寫在主 repo 的 `.loops/`、被 gitignore 涵蓋、不入庫。

## 進階（opt-in）

| 能力 | 入口 |
|---|---|
| 自動連跑（核准一次、危險才停） | 環境變數 `LOOPS_AUTO=1`，見 `references/auto-mode.md` |
| 競賽 / 投票式編隊（N 方案→評審） | plan / explore 說「用 Fleet」，見 `references/fleet.md` |
| 跨 session 接續 | `/loops-workflow:dispatch <slug>`（自動偵測既有 loop.md），見 `references/journaling.md` |
| 機器可驗證計畫 + eval | 計畫塊 `scripts/validate-plan.mjs`（見 `references/machine-plan-schema.md`）/ dispatch 場景評測 `scripts/run-eval.mjs`（見 `references/eval-harness.md`） |
| 全部開關總覽 | `docs/settings.md` —— settings.json `env` 可設的全部 `LOOPS_*` 參數一頁看完 |
| 工程師理解包 | `LOOPS_EXPLAIN=1` 時完整迴圈完工自動產；其他情境自然語言請 Claude 跑 `explain` skill（唯讀側用） |
| code 工作隔離 | 會動 code 的迴圈（issue / fix）在 **git worktree**（自帶 branch）裡做，不擾動主 checkout；`EnterWorktree` 或 `.claude/worktrees/<issue#>-<slug>`（例 `137-trash-delete-permanent`，**不加 `fix/` 前綴**） |

intent→入口對照與全程操作規則見 `AGENTS.md`（marketplace 根）。

## 結構

```
plugins/loops-workflow/
├── skills/       dispatch（唯一入口）+ 前置 clarify / define / scaffold-fullstack + goal→iterate 六個迴圈階段
│                 + 側用 explain（完整迴圈完工且 LOOPS_EXPLAIN=1 才自動產）
│                 —— 除 dispatch 外全部 user-invocable: false，全量見 docs/FLOW.md 規模表
├── agents/       build 紅綠分離（test-author / impl-author / referee）+ verify 核心 reviewer
│                 + finding-validator + 條件式領域 reviewer + 高風險 -deep 變體 + eval-judge
│                 —— 全量與計數見 docs/FLOW.md 規模表
├── hooks/        SessionStart：浮出 active .loops/ 迴圈；Stop：progress-render 重生 PROGRESS.md（恆跑）
│                 + 把關/觀測（預設值逐 flag 拍板——見 references/journaling.md 決策表；安全把關預設開、SECURITY 類 opt-in）
├── scripts/      validate-plan / run-eval / loops-scan / progress 等 17 支（含 eval-* 家族 / skill-lint / loops-quality-gate，全量見目錄）
├── docs/         FLOW（完整流程圖）/ settings（可設參數總覽）/ REFERENCES（規範目錄）—— 索引見 docs/README.md
└── references/   共用規範 + 模板（全量與分類見 docs/REFERENCES.md）
```

> 全程操作規則（決策點停、繁中、重用優先、文件紀律、對外溝通、參考檔路徑解析）見 `AGENTS.md`。

