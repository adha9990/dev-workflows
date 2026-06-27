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

---

# oracle-based runner（E1，可執行 oracle，零 judge）

> 上面的 scenario-checklist 是**人工/agent 勾**的雛形；這一節是**確定性**的 oracle 路線（issue #27）。兩者平行：scenario 適合「沒有可執行 ground truth、得人判」的階段；oracle runner 適合「能用測試轉綠/exit 0 判」的成果。**oracle-first, judge-last**——能 oracle 就不用 judge。
>
> `scripts/eval-oracle.mjs` 是**確定性評分引擎**：它**不呼叫 Claude**（候選產出由外部步驟/agent 提供），而是把「一個候選 workspace」透過既有 `scripts/loops-quality-gate.mjs`（不重造 oracle）取得結構化 gate 結果，比對 task 的 `failToPass`/`passToPass` test 清單 → 算 pass/fail。SWE-bench 式：FAIL_TO_PASS（改後該綠）+ PASS_TO_PASS（既有綠不准轉紅）。

## task 檔格式（`evals/<stage>/<id>.json`）

```jsonc
{
  "id": "build-add-function",                     // 唯一
  "stage": "build",                                // 階段（供分類）
  "description": "實作 add() 使既有失敗測試轉綠",
  "workspace": "../fixtures/build-add-function",   // 相對本檔的候選 workspace（fixture）
  "oracle": {
    "failToPass": ["add returns sum"],             // 改後該綠的 test 名（改前應 fail）
    "passToPass": ["sub returns diff"]             // 既有綠、不准轉紅的 test 名
  },
  "tags": ["regression", "build"]
}
```

## result（runner 輸出，per task）

```jsonc
{
  "id": "build-add-function", "stage": "build", "pass": true,
  "failToPass": { "required": ["add returns sum"], "passed": ["add returns sum"], "missing": [] },
  "passToPass": { "required": ["sub returns diff"], "passed": ["sub returns diff"], "missing": [] },
  "gateStatus": "passed",            // 取自 quality-gate（passed/failed/not-run/errored）
  "reason": "all required tests passed"
}
```

aggregate：`{ total, passed, failed, tasks: [...] }`；`failed > 0` → **exit 1**（當 gate）。

## 判定規則（不變量）

- test「pass」＝該 test 名**不在** quality-gate 回報的 failures 內，**且** gate 真的跑了該 suite。
- gate `not-run` / 缺某個 required test → task 標 **`errored`（非 pass）**——永不把「沒驗到」誤判為通過。
- 安全：runner **不收 task 自帶 shell 命令**，oracle 一律走 `loops-quality-gate.mjs`（避免注入面）。
- 與 `references/quality-gate-schema.md` 的 `Failure[]` / `classifyGate` 對齊。

## 跑

```bash
node plugins/loops-workflow/scripts/eval-oracle.mjs --dir plugins/loops-workflow/evals/build [--task <id>] [--json]
```

> 本票（E1）只出 **per-run 報告**；跨 run 聚合 + pass@1/pass^k + 回歸 gate 是 #28（E2）。
