# dev-workflows

> 個人開發工作流 plugin marketplace（測試性）。目前 **2 個 plugin**：

| Plugin | 用途 | 怎麼用 |
|---|---|---|
| **loops-workflow** | 7 階段閉環開發工作流（**既有專案**內加功能 / 設計 / 修問題） | `/loops-workflow:dispatch <一句話>` |
| **scaffold** | greenfield 從零建全端 TS 專案骨架（分層 Fastify + React SPA + Kysely + Vitest） | `/scaffold:scaffold-fullstack` |

## 安裝

```
/plugin marketplace add adha9990/dev-workflows  # 從 GitHub 加入 marketplace（owner/repo 簡寫）
/plugin install loops-workflow@dev-workflows    # 閉環開發（既有專案）
/plugin install scaffold@dev-workflows          # greenfield scaffold（空資料夾從零建）
/reload-plugins
```

**怎麼選**：既有專案內開發 → `loops-workflow`；空資料夾從零建乾淨架構 → `scaffold`。

---

# loops-workflow（plugin）

7 階段閉環開發工作流，呼叫帶 `loops-workflow:` 前綴。把開發拆成 `dispatch → goal → explore → plan → build → verify → iterate`，`.loops/<slug>/` 的 markdown 當階段間記憶體。**只在真正要你選的決策點停（用 `AskUserQuestion`）**，routine 轉場直接往下；也支援 opt-in 自動連跑。

> **設計座標**：**Closed Loop**（人類在框架內把關）· **單一迴圈**預設、opt-in **Fleet** 編隊 · 目標脈絡＝**VISION**（goal）/ **ARCHITECTURE**（設計書 §0–§9）/ **RULES**（AGENTS）· **成本意識**（迴圈很貴 → 高上下文效率、便宜的先·貴的 gate、不重複勞動、fail-fast；見 `AGENTS.md` 規則 10）。

## 工作流程

```
dispatch → goal → explore → plan → build → verify → iterate
                                                        │
                  回 goal / explore / plan / build ◀────┤（≤ 3 圈，修完一定再 verify）
                                                        └──▶ 完工（交 PR / 收尾）
```

> **修完一定再過一輪 verify**（fix delta + 波及面派 fresh reviewer；「測試綠 / typecheck 0」不算數）。**完工只在 verify 乾淨那輪才可達** —— 交給其他 reviewer 前先在內部把問題解到最少。

**只在真正要你做選擇的決策點停下用 `AskUserQuestion` 問**（explore 選方法 / plan 拍板 / iterate 完工或回環 / 真正的 scope 取捨 / 安全停：分類模糊·危險操作·P0·規格不清）。**routine 轉場（進入下一階段）不問、直接往下**，產出寫進 `.loops/` + 摘要，你隨時可插話喊停 / 改。需要時可開 opt-in `auto` 模式（連決策也用推薦選項自動帶過，只剩安全停）。

## Skill 清單（7 階段，各自可獨立呼叫）

> 「停下問你？」欄：✋ = 真決策、一定停下用 `AskUserQuestion`；其餘只在列出的條件下才停，否則 routine 直接往下。

| Skill | 停下問你？ | 做什麼 |
|---|---|---|
| `loops-workflow:dispatch` | 僅分類模糊 / scaffold 才停 | 決策樹分流（**乾淨空專案→scaffold 骨架** / issue→goal / 無 issue 待解決→define / 設計→explore / PR→iterate）+ 建 `loop.md` + 進起點階段 |
| `loops-workflow:define` | 有 blocking 決策才停 | **前置**：模糊問題 / 點子 → Readiness Model + repo issue template + **一次一問 intake** + scope sizing + flowchart → 建 template-ready issue（草稿確認 → `gh issue create --assignee @me`）→ 再 goal |
| `loops-workflow:goal` | 有 scope 取捨才停 | **逐句掃 issue 抽 requirement**（不只 AC 段）→ 一次一問訪談 → restate 六欄完工定義 + 可驗證停止條件 |
| `loops-workflow:explore` | ✋ 選方法 | 內部找可重用 → **不夠才**搜外部（內部+需求已釘死就不搜、省資源）→ 攤開推薦；deep-research 升級要 gate；框架 API 查官方文件 |
| `loops-workflow:plan` | ✋ 拍板方案 | decision record + 機制圖（**拍板 gate 渲染運作流程圖＋注入接線圖給你看**）+ ≥3 套件評估 + 拆成可獨立 verify 的任務；**計畫草稿在 plan 階段就送出**（living plan，實作偏離回去改） |
| `loops-workflow:build` | 危險 / 卡關才停 | 逐任務**紅綠分離**（test-author 看不到 impl / impl-author 不准改 test）+ Refactor + 分段 commit |
| `loops-workflow:verify` | 出 P0 才停 | **同回合派 6 reviewer** fan-out（+ 視領域加派條件式 reviewer）+ 跑真 app + 本機 /code-review + finding-validator 二輪 + P0–P3 分級 |
| `loops-workflow:iterate` | ✋ 完工（回環自動） | 回饋四分類 + **actionable 一律自動全修（不論 P2/P3、不問「修多少」）** + Stop-the-Line 根因修 + **3 圈上限**；收尾交接物**依類型**（修正型只一份回覆 reviewer／完整迴圈才產 PR 收尾 comment + explain），草稿確認才送；**follow-up 留當前 issue、不另開** |

另有側用 `loops-workflow:explain <target>` —— 產工程師理解包（實作導讀 + 自測題 + 設計方向），唯讀、不在迴圈裡。

## 兩個引擎

- **build 紅綠分離**：`test-author`（只看需求、看不到 impl）→ `impl-author`（只轉綠、不准改 test）→ Refactor → 衝突派 `referee` 裁決。讓測試不會遷就實作。
- **verify fan-out**：主線同回合派 6 reviewer（product-contract / architecture / security / performance / code-quality / tests）各審一軸 + 條件式領域 reviewer + `finding-validator` 二輪，輸出 Ready / Not ready。

## 進階（opt-in）

| 能力 | 入口 |
|---|---|
| 自動連跑（核准一次、危險才停） | `dispatch auto <…>`，見 `references/auto-mode.md` |
| 競賽 / 投票式編隊（N 方案→評審） | plan / explore 說「用 Fleet」，見 `references/fleet.md` |
| 跨 session 接續 | `/loops-workflow:resume <slug>`，見 `references/journaling.md` |
| 機器可驗證計畫 + eval | 計畫塊 `scripts/validate-plan.mjs`（見 `references/plan-schema.md`）/ dispatch 場景評測 `scripts/run-eval.mjs`（見 `references/eval-harness.md`） |
| 列出 active 迴圈 | `/loops-workflow:status`（SessionStart hook 也會自動浮出） |
| 工程師理解包 | `/loops-workflow:explain <target>`（唯讀側用） |
| session statusline 顯示 loops 進度（`⟳ <slug> · <stage>`） | `scripts/statusline.sh`（包 claude-hud `--extra-cmd`）→ 設成 statusLine；無 claude-hud 則只印 loops 進度 |
| code 工作隔離 | 會動 code 的迴圈（issue / fix）在 **git worktree**（自帶 branch）裡做，不擾動主 checkout；`EnterWorktree` 或 `.claude/worktrees/<issue#>-<slug>`（例 `137-trash-delete-permanent`，**不加 `fix/` 前綴**） |

intent→command 對照與全程操作規則見 plugin 內的 `AGENTS.md`（marketplace 根）。

## statusline 進度（HUD）安裝

讓 session 底下的 statusline 顯示「目前跑到哪個 loop / 哪個階段」（`⟳ <slug> · <stage>`）。靠 [claude-hud](https://github.com/jarrodwatts/claude-hud) 的 `--extra-cmd` 接 `scripts/hud-status.mjs`，`scripts/statusline.sh` 把整段接線包好（沒裝 claude-hud 也能用，退化成只印 loops 進度）。

### 一鍵安裝（建議）

```
/loops-workflow:install-statusline
```

自動解析 `statusline.sh` 的絕對路徑、寫進 `settings.json`（冪等；若已有別的 `statusLine` 會先印出來、徵得同意才覆寫）。裝完**新開一個 session** 即生效。

### 手動安裝（fallback）

在 `~/.claude/settings.json` 把 `statusLine` 指向 wrapper（用**絕對路徑**最穩 —— `~` / `$HOME` 視執行 shell 不一定展開）：

```json
"statusLine": {
  "type": "command",
  "command": "bash \"<你的 .claude>/plugins/marketplaces/dev-workflows/plugins/loops-workflow/scripts/statusline.sh\""
}
```

Windows 例：`bash "C:/Users/<你>/.claude/plugins/marketplaces/dev-workflows/plugins/loops-workflow/scripts/statusline.sh"`。

設好後 statusline 每次 render 自動讀當前目錄的 `.loops/` **以及 `.claude/worktrees/*/.loops/`**（**在主 repo（master）開的 session 也看得到底下 worktree 在跑的 loop**），**只顯示「當下 session 正在跑」的那一個 loop**（靠 `CLAUDE_CODE_SESSION_ID` 比對 loop.md 的 `session` 欄；已完工 / 別 session / 歷史的 loop 都不顯示，也不堆疊）。要回退成只用 claude-hud，把 `statusLine.command` 改回 claude-hud 原本的指令即可。

## 結構

```
plugins/loops-workflow/
├── skills/       define（前置：模糊問題→issue）+ 7 階段 + explain（側用）
├── agents/       build 紅綠分離 3（test-author / impl-author / referee）
│                 + verify 6 核心 reviewer + finding-validator + 7 條件式領域 reviewer
├── commands/     loop / resume / status / explain / install-statusline
├── hooks/        SessionStart：浮出 active .loops/ 迴圈
├── scripts/      validate-plan / run-eval / hud-status / statusline
└── references/   各階段規範 + 模板（security-checklist / reuse-check / docs-policy /
                  commit-spec / pr-spec / comment-policy / onboarding / reviewer-severity /
                  finding-validation / preflight / cross-model-review / optional-reviewers / auto-mode / fleet /
                  journaling / plan-schema / design-plan-schema / contract-spec / eval-harness /
                  automations / test-rubric / pr-feedback-sources / goal-restate-schema /
                  task-template / change-summaries / adr-template）
```

> 全程操作規則（決策點停、繁中、重用優先、文件紀律、對外溝通、參考檔路徑解析）見 `AGENTS.md`。

---

# scaffold（plugin）

greenfield 從零建全端 TypeScript 專案骨架：分層 Fastify 後端（`domain ← ports ← adapters/services/repositories/http`）+ React 19 + TanStack SPA、ESLint 強制分層與前後端牆、SQLite + Kysely、Vitest（unit/e2e/benchmark），含一條貫穿各層的範例垂直切片。

用 `/scaffold:scaffold-fullstack` —— 在空資料夾從模板生出整個分層專案骨架。**只建新專案、不改既有 code**（既有專案內開發走 loops-workflow）。
