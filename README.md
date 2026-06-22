# loops-workflow plugin

> 7 階段閉環開發工作流，呼叫帶 `loops-workflow:` 命名空間前綴。把開發拆成 `dispatch → goal → explore → plan → build → verify → iterate`，**階段之間有 human gate**，`.loops/<slug>/` 的 markdown 當階段間記憶體。預設逐段停下等人，也支援 opt-in 自動連跑。

## 工作流程

```
dispatch → goal → explore → plan → build → verify → iterate
                                                        │
                  回 goal / explore / plan / build ◀────┤（≤ 3 圈）
                                                        └──▶ 完工（交 PR / 收尾）
```

**每兩階段之間都有 human gate（Closed Loop）** —— 階段做完就停下等使用者拍板，不自動串接。`.loops/<slug>/` 的 markdown 當階段間記憶體（已 `.gitignore`）。需要時可開 opt-in `auto` 模式（核准計畫一次後連跑，危險 / 失敗 / P0 / 規格模糊仍硬停）。

## Skill 清單（7 階段，各自可獨立呼叫）

| Skill | 起點 gate | 做什麼 |
|---|---|---|
| `loops-workflow:dispatch` | 僅模糊時停 | 決策樹分流（issue→goal / 設計→explore / PR→iterate）+ 建 `loop.md` + 交棒 |
| `loops-workflow:goal` | 確認完工定義 | 一次一問訪談 → restate 六欄完工定義 + 可驗證停止條件 |
| `loops-workflow:explore` | 選方法 | 內部找可重用 → 外部找做法 → 攤開比較推薦；deep-research 升級要 gate；框架 API 查官方文件 |
| `loops-workflow:plan` | 拍板方案 | decision record + 機制圖 + ≥3 套件評估 + 拆成可獨立 verify 的任務 |
| `loops-workflow:build` | 確認完成 | 逐任務**紅綠分離**（test-author 看不到 impl / impl-author 不准改 test）+ Refactor + 分段 commit |
| `loops-workflow:verify` | 看驗收報告 | **同回合派 6 reviewer** fan-out + finding-validator 二輪 + P0–P3 分級 |
| `loops-workflow:iterate` | 完工 or 回環 | 回饋四分類 + Stop-the-Line 根因修 + **3 圈上限** + 收尾 |

## 兩個引擎

- **build 紅綠分離**（`agents/`）：`test-author`（只看需求、看不到 impl）→ `impl-author`（只轉綠、不准改 test）→ Refactor → 衝突派 `referee` 裁決。讓測試不會遷就實作。
- **verify fan-out**（`agents/`）：主線同回合派 6 reviewer（`product-contract` / `architecture` / `security` / `performance` / `code-quality` / `tests`）各審一軸 + `finding-validator` 二輪確認，輸出 Ready / Not ready。

## 進階（opt-in）

| 能力 | 入口 |
|---|---|
| 自動連跑（核准一次、危險才停） | `dispatch auto <…>`，見 `references/auto-mode.md` |
| 競賽 / 投票式編隊（N 方案→評審） | plan / explore 說「用 Fleet」，見 `references/fleet.md` |
| 跨 session 接續 | `/loops-workflow:resume <slug>`，loop.md 事件日誌，見 `references/journaling.md` |
| 機器可驗證計畫 + eval | `scripts/validate-plan.mjs` / `scripts/run-eval.mjs` |
| 列出 active 迴圈 | `/loops-workflow:status`（SessionStart hook 也會自動浮出） |

## 安裝

```
/plugin marketplace add ~/.claude/plugins/marketplaces/loops-workflow
/plugin install loops-workflow@loops-workflow
/reload-plugins
```

裝好後 `/loops-workflow:dispatch <一句話>` 或 `/loops-workflow:loop <一句話>` 開跑，也可直接喊任一階段。intent→command 對照見 [AGENTS.md](./AGENTS.md)。

## 結構

```
plugins/loops-workflow/
├── skills/       dispatch goal explore plan build verify iterate（7）
├── agents/       test-author impl-author referee（build 3）
│                 ＋ 6 reviewer ＋ finding-validator（verify 7）
├── commands/     loop resume status
├── hooks/        SessionStart：浮出 active .loops/ 迴圈
├── scripts/      validate-plan.mjs / run-eval.mjs
└── references/   security-checklist code-simplification reviewer-severity
                  finding-validation auto-mode fleet journaling plan-schema
                  eval-harness goal-restate-schema task-template
                  change-summaries adr-template
```
