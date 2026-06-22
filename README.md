# loops-workflow plugin

> **測試性 plugin。** 7 階段閉環開發工作流，呼叫帶 `loops-workflow:` 命名空間前綴。**以使用者自己的 work-plugins / cto-review 工作模式為重心**，用 **Loops Engineering** 的閉環哲學組織，再用 **agent-skills**（MIT）的成熟做法補填真缺口。完全自包含、可獨立實驗，不依賴其他 plugin。

## 三層融合定位

| 來源 | 角色 | 貢獻 |
|------|------|------|
| 🎯 **work-plugins + cto-review**（使用者的） | **重心 / 骨幹** | 每階段做什麼、繁中規範、gate 紀律、**cto-pr-reviewer 六 reviewer 引擎**、pm-feature-intake 訪談、issue→PR 工作模式 |
| 🔄 **Loops Engineering**（哲學） | **組織框架** | dispatch 分流、Closed Loop gate、`.loops/` 記憶體、iterate 回環、停止條件 |
| 🔧 **agent-skills**（成熟，MIT） | **方法基底（補缺口）** | 只補真缺口：簡化 / 威脅建模 / failure triage / source-driven / context 量化 |

## 工作流程

```
dispatch → goal → explore → plan → build → verify → iterate
                                                        │
                  回 goal / explore / plan / build ◀────┤（≤ 3 圈）
                                                        └──▶ 完工（交 PR / 收尾）
```

**每兩階段之間都有 human gate（Closed Loop）** —— 階段做完就停下等使用者拍板，不自動串接。`.loops/<slug>/` 的 markdown 當階段間記憶體（已 `.gitignore`）。

## Skill 清單（7 階段，各自可獨立呼叫）

| Skill | 起點 gate | 做什麼 |
|---|---|---|
| `loops-workflow:dispatch` | 僅模糊時停 | 決策樹分流（issue→goal / 設計→explore / PR→iterate）+ 建 `loop.md` + 交棒 |
| `loops-workflow:goal` | 確認完工定義 | 一次一問訪談 → restate 六欄完工定義 + 停止條件（borrow pm-feature-intake / interview-me） |
| `loops-workflow:explore` | 選方法 | 內部找可重用 → 外部找做法 → 攤開比較推薦；deep-research 升級要 gate；source-driven 查證 |
| `loops-workflow:plan` | 拍板方案 | decision record + 機制圖 + ≥3 套件評估 + 拆成可獨立 verify 的任務（borrow plan-from-issue + 設計計畫書） |
| `loops-workflow:build` | 確認完成 | 逐任務**紅綠分離**（test-author 看不到 impl / impl-author 不准改 test）+ Refactor + 分段 commit |
| `loops-workflow:verify` | 看驗收報告 | **同回合派 6 reviewer** + finding-validator 二輪 + P0–P3（以 cto-pr-reviewer 為藍本） |
| `loops-workflow:iterate` | 完工 or 回環 | RECONCILE 四分類 + Stop-the-Line 根因修 + **3 圈上限** + 收尾 |

## 兩個引擎

- **build 紅綠分離**（`agents/`）：`test-author`（只看需求、看不到 impl）→ `impl-author`（只轉綠、不准改 test）→ Refactor → 衝突派 `referee` 裁決。防測試遷就實作。
- **verify fan-out**（`agents/`）：主線同回合派 6 reviewer（`product-contract` / `architecture` / `security` / `performance` / `code-quality` / `tests`）+ `finding-validator` 二輪確認，輸出 Ready / Not ready。

## 安裝

```
/plugin marketplace add ~/.claude/plugins/marketplaces/loops-workflow
/plugin install loops-workflow@loops-workflow
/reload-plugins
```

裝好後就能 `/loops-workflow:dispatch <一句話>` 開跑，或直接喊任一階段。intent→command 對照見 [AGENTS.md](./AGENTS.md)。

## 結構

```
plugins/loops-workflow/
├── skills/       dispatch goal explore plan build verify iterate（7）
├── agents/       test-author impl-author referee（build 3）
│                 ＋ 6 reviewer ＋ finding-validator（verify 7）
└── references/   security-checklist code-simplification（MIT）
                  reviewer-severity finding-validation（對齊 cto-pr-reviewer）
                  goal-restate-schema task-template change-summaries adr-template（模板）
```

## 設計與紀錄

- [DESIGN.md](./DESIGN.md) — 完整設計（三層融合、流程圖、各階段職責、subagent 策略、採用總表）
- [AGENT-SKILLS-採用評估.md](./AGENT-SKILLS-採用評估.md) — agent-skills 35 資產逐項採用決策（work-plugins 校準後）
- [RESEARCH-agent-skills.md](./RESEARCH-agent-skills.md) — 借鑑研究
- [SMOKE.md](./SMOKE.md) — smoke test 紀錄

## 借鑑歸屬

借鑑自 [`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills)（MIT）。直接改寫其內容的檔案（`references/security-checklist.md`、`references/code-simplification.md`）頂部標 `<!-- adapted from addyosmani/agent-skills (MIT) -->`。
