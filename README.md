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

**怎麼選**：既有專案內開發 → `/loops-workflow:dispatch`；空資料夾從零建乾淨架構 → `/loops-workflow:scaffold-fullstack`（或 dispatch 偵測到乾淨專案會引導你用）。

---

# loops-workflow（plugin）

## 一句話

你打**一個**指令 `/loops-workflow:dispatch <想做的事>`，它就把這件事跑完一條「開發產線」：判斷你要做什麼 → 探索做法 → 拍板規劃 → 寫 code（測試先行）→ 獨立審查 → 修到好 → 開 PR。**全程只在真正該你拍板的地方停下問你**（選做法 / 拍板方案 / 完工），其餘自己往下；你隨時能插話喊停或改。各階段產出寫進 `.loops/<slug>/` 的 markdown 當「階段間記憶」，中斷了也接得回來。

> 📊 想看每階段用哪些 agent / 機制的**完整流程圖**（含 mermaid）→ [`docs/FLOW.md`](plugins/loops-workflow/docs/FLOW.md)；**共用規範目錄** → [`docs/REFERENCES.md`](plugins/loops-workflow/docs/REFERENCES.md)。

## 你只會用到這幾個指令

**能直接打的就這些**（其餘全是 dispatch 內部自動跑的，見下節）：

| 指令 | 什麼時候用 |
|---|---|
| **`/loops-workflow:dispatch <一句話 / issue# / PR#>`** | **唯一入口**——任何開發都從這起：判類型、開一條 loop、自動往下跑（別名 `/loops-workflow:loop`） |
| `/loops-workflow:resume <slug>` | 接續一條中途停下的 loop |
| `/loops-workflow:status` | 列出目前所有在跑的 loop |
| `/loops-workflow:progress [slug]` | 看某條 loop 詳細跑到哪（階段 / 圈數 / findings / 下一步） |
| `/loops-workflow:scaffold-fullstack` | 空資料夾從零建全端 TS 專案骨架 |
| `/loops-workflow:explain <target>` | （側用、唯讀）把一塊 code 產成工程師理解包 |
| `/loops-workflow:agents-md-maintainer` | （側用）維護 repo 的 `AGENTS.md` |

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

> **只在真正該你選的決策點才停**（用 `AskUserQuestion`）：explore 選做法 / plan 拍板 / iterate 完工或回環 / 真正的 scope 取捨 / 安全停（分類模糊·危險操作·P0·規格不清）。**其餘 routine 轉場直接往下**，產出寫進 `.loops/`。**修完一定再過一輪 verify**（不是「測試綠」就算完）。需要時可開 opt-in `auto` 連跑。

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
- **verify fan-out**：主線同回合派 6 reviewer（product-contract / architecture / security / performance / code-quality / tests）各審一軸 + 條件式領域 reviewer + `finding-validator` 二輪，輸出 Ready / Not ready。

## 看進度（`/progress` + `PROGRESS.md`）

迴圈進度全寫在 `.loops/<slug>/` 的 `loop.md`（儀表板 + Journal 事件日誌）。要看「目前跑到哪、第幾圈、findings、下一步」，有三條路、**全部免安裝、零 token、跨平台**：

| 看法 | 怎麼用 | 看到什麼 |
|---|---|---|
| **完整儀表板（chat）** | `/loops-workflow:progress [slug]` | 一條 loop 的階段管線（`plan ✓ build ● verify ○`）+ 圈數 + 當前任務 + findings + 最近 Journal + 下一步 |
| **常駐預覽（編輯器）** | 開 `.loops/<slug>/PROGRESS.md` 的 **markdown preview** | 同一份儀表板的 markdown 版（mermaid 階段圖 + checkbox + Journal 時間軸）；由 Stop hook **每回合自動重生**、永遠最新 |
| **列出全部 active loop** | `/loops-workflow:status` | 每條 loop 一行摘要（slug / 類型 / 當前階段 / 模式 / 最後一筆 Journal） |

> 機制：`scripts/progress.mjs`（共用 renderer，吃 `loop.md` + `0N-*.md`）渲染兩種出口；恆跑的 Stop hook `hooks/progress-render.mjs` 每回合對「本 session 正在跑」的 loop 重生 `PROGRESS.md`（靠 `CLAUDE_CODE_SESSION_ID` 比對，已完工 / 別 session 不顯示）。`PROGRESS.md` 寫在主 repo 的 `.loops/`、被 `.loops` 規則 gitignore 涵蓋、不入庫。SessionStart hook 另會在開場浮出 active 迴圈。

## 進階（opt-in）

| 能力 | 入口 |
|---|---|
| 自動連跑（核准一次、危險才停） | `dispatch auto <…>`，見 `references/auto-mode.md` |
| 競賽 / 投票式編隊（N 方案→評審） | plan / explore 說「用 Fleet」，見 `references/fleet.md` |
| 跨 session 接續 | `/loops-workflow:resume <slug>`，見 `references/journaling.md` |
| 機器可驗證計畫 + eval | 計畫塊 `scripts/validate-plan.mjs`（見 `references/machine-plan-schema.md`）/ dispatch 場景評測 `scripts/run-eval.mjs`（見 `references/eval-harness.md`） |
| 看單條 loop 完整進度 | `/loops-workflow:progress <slug>`（chat 儀表板 + 重生 `PROGRESS.md`） |
| 列出 active 迴圈 | `/loops-workflow:status`（SessionStart hook 也會自動浮出） |
| 工程師理解包 | `/loops-workflow:explain <target>`（唯讀側用） |
| code 工作隔離 | 會動 code 的迴圈（issue / fix）在 **git worktree**（自帶 branch）裡做，不擾動主 checkout；`EnterWorktree` 或 `.claude/worktrees/<issue#>-<slug>`（例 `137-trash-delete-permanent`，**不加 `fix/` 前綴**） |

intent→command 對照與全程操作規則見 plugin 內的 `AGENTS.md`（marketplace 根）。

## 結構

```
plugins/loops-workflow/
├── skills/       define（前置：模糊問題→issue）+ 7 階段 + explain（側用）
│                 + scaffold-fullstack（前置：greenfield 骨架，自帶整棵模板樹）
│                 + agents-md-maintainer（側用：AGENTS.md 文檔維運）
├── agents/       build 紅綠分離 3（test-author / impl-author / referee）
│                 + verify 6 核心 reviewer + finding-validator + 9 條件式領域 reviewer（含 root-cause / docs-devex）
├── commands/     loop / resume / status / explain / progress
├── hooks/        SessionStart：浮出 active .loops/ 迴圈；Stop：progress-render 重生 PROGRESS.md（恆跑）+ opt-in 觀測/閘
├── scripts/      validate-plan / run-eval / loops-scan / progress
└── references/   各階段規範 + 模板（clean-code / clean-architecture / design-patterns / refactoring / code-simplification /
                  security-checklist / reuse-check / docs-policy /
                  commit-spec / pr-spec / comment-policy / onboarding / reviewer-severity /
                  finding-validation / preflight / cross-model-review / optional-reviewers /
                  〔per-axis 審查判準〕review-dispositions / acceptance-review / correctness-review / architecture-review /
                  performance-review / ui-interaction-review / root-cause-review / docs-devex-review /
                  auto-mode / fleet /
                  journaling / plan-schema / design-plan-schema / contract-spec / eval-harness /
                  automations / test-rubric / pr-feedback-sources / goal-restate-schema /
                  task-template / change-summaries / adr-template）
```

> 全程操作規則（決策點停、繁中、重用優先、文件紀律、對外溝通、參考檔路徑解析）見 `AGENTS.md`。

---

# scaffold-fullstack（loops-workflow 內建 skill：greenfield 骨架）

greenfield 從零建全端 TypeScript 專案骨架：分層 Fastify 後端（`domain ← ports ← adapters/services/repositories/http`）+ React 19 + TanStack SPA、ESLint 強制分層與前後端牆、SQLite + Kysely、Vitest（unit/e2e/benchmark），含一條貫穿各層的範例垂直切片。自帶整棵模板樹 + scaffold 腳本，無外部依賴。

用 `/loops-workflow:scaffold-fullstack` —— 在空資料夾從模板生出整個分層專案骨架；或 `dispatch` 偵測到完全乾淨的空專案時會引導你用（確認後才跑）。**只建新專案、不改既有 code**（既有專案內開發走 loops 迴圈）。
