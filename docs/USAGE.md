# 使用指南

loops-workflow 把一次開發拆成 7 個階段，階段之間停下讓你把關。這份是上手走一遍。

## 最短路徑

```
/loops-workflow:dispatch 做 issue #42
```

dispatch 判類型、建 `.loops/<slug>/loop.md`、建議從哪個階段起，然後**停下**等你。之後每個階段做完也會停，你看過 `.loops/` 的產出、說「繼續」才往下。

## 三種入口

| 你手上是 | 喊 | 從哪起 |
|---|---|---|
| issue 號 / 一個要做的需求 | `dispatch 做 issue #42` 或 `goal` | goal（完整迴圈） |
| 一個設計 / 研究問題（無 issue） | `dispatch 設計一個 X` 或 `explore` | explore |
| PR 收到 reviewer 回饋 | `dispatch PR #12 的回饋` 或 `iterate` | iterate |

也可以直接喊中間任一階段（`plan` / `build` / `verify`），它會先讀 `.loops/loop.md` 認領狀態。

## 走一遍（issue 完整迴圈）

1. **goal** — 一次一問把需求逼成「完工定義 + 可驗證停止條件」，寫 `00-goal.md`。→ 停，你確認。
2. **explore** — 先掃內部可重用、再查外部做法，攤開比較給推薦，寫 `01-explore.md`。→ 停，你選方法。
3. **plan** — 留決策痕跡、畫機制圖、拆成可獨立 verify 的任務，寫 `02-plan.md`。→ 停，你拍板。
4. **build** — 逐任務紅綠分離（`test-author` 寫測試→`impl-author` 轉綠→重構）、分段 commit，寫 `03-build.md`。→ 停。
5. **verify** — 同回合派 6 reviewer 各審一軸 + validator 二輪，出 Ready / Not ready，寫 `04-verify.md`。→ 停，你看報告。
6. **iterate** — 把缺口分類、修根因、決定回哪階段或完工。最多回環 3 圈。

## 想一路跑完？開 auto

```
/loops-workflow:dispatch auto 做 issue #42
```

核准計畫一次後自動連跑，但**危險操作 / 測試弄不綠 / P0 / 規格模糊仍會停**。詳見 `references/auto-mode.md`。

## 跨 session 接續

迴圈狀態都在 `.loops/<slug>/loop.md`（含 append-only 事件日誌）。新 session：

```
/loops-workflow:status          # 列出所有 active 迴圈
/loops-workflow:resume <slug>   # 接續某個迴圈
```

開新 session 時 hook 也會自動提醒有哪些 active 迴圈。

## 進階

- **Fleet**（方案發想派 N 個 agent 評審）：plan / explore 說「用 Fleet 出幾個方案」。見 `references/fleet.md`。
- **機器可驗證計畫**：`02-plan.md` 內嵌 `loops-plan` JSON，跑 `node scripts/validate-plan.mjs`。見 `references/plan-schema.md`。
- **eval**：`node scripts/run-eval.mjs <scenarios.json>` 驗證情境集 + 出 checklist。見 `references/eval-harness.md`。
- **排程 / 連續跑**：見 `references/automations.md`。
