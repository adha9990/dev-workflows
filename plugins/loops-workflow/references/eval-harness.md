# eval harness（階段行為評估）

> 進階：用一組**情境（scenario）+ baseline** 評估某個階段 skill 是否如預期運作。`scripts/run-eval.mjs` 驗證情境集結構（≥3 + baseline）並印出可逐條跑的 checklist。**選用**。

## scenario 檔格式（JSON）

```json
{
  "stage": "dispatch",
  "baseline": "使用者直接喊對應階段（不經 dispatch），結果應與 dispatch 路由一致",
  "scenarios": [
    { "name": "issue 號", "input": "做 issue #5", "expect": "判 issue → 從 goal 起、建 loop.md、停在 gate" },
    { "name": "設計問題", "input": "設計一個範例功能 X", "expect": "判 design → 從 explore 起" },
    { "name": "PR 修正", "input": "PR #12 reviewer 給回饋了", "expect": "判 fix → 從 iterate 起" },
    { "name": "模糊", "input": "幫我看一下這個", "expect": "停下來問使用者（不亂猜）" }
  ]
}
```

每個 scenario：`name` / `input`（餵給階段的輸入）/ `expect`（可觀察的預期結果）。至少 **3 個 scenario + 1 個 baseline**（baseline = 對照組，沒有它無法判斷「對的原因」）。

## 跑

```bash
node plugins/loops-workflow/scripts/run-eval.mjs <path-to-scenarios.json>
```

它**不會自動呼叫 Claude**（那要在 Claude Code 裡實跑），而是：驗證情境集結構合格 → 印出一張逐條 checklist（input / 預期 / 待填實際 / pass?），讓你或 agent 實跑後勾。套 Metric-Honesty：沒實跑的格子標 `not run`，不要假裝跑過。

## 用途

- 改了某階段 skill 後，跑同一組 scenario 確認沒退化（regression）。
- 比較兩版 skill：同情境集、看哪版 expect 命中率高。
