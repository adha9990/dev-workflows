# 機器可驗證計畫檔（machine-plan-schema）

> `stages/02-plan.md` 除了給人看的敘述，再附一塊**機器可驗證**的結構，由 `scripts/validate-plan.mjs` 在進 build 前檢查（plan → validate → execute）。
>
> **有 behaviors / evidence portfolio 的功能工作一律開**（那是 `references/stages/evidence-portfolio.md` 硬規則的機械落點）；純內部、無 behavior 的瑣碎改動可只寫 legacy `tasks` 形。

## 在 stages/02-plan.md 內嵌一塊 `loops-plan` JSON

```loops-plan
{
  "behaviors": [
    { "id": "B1", "statement": "使用者在資料夾清單看得到子資料夾的內容數", "risk": "medium", "risk_triggers": [] },
    { "id": "B2", "statement": "切換顯示子資料夾內容時清單即時更新", "risk": "low", "risk_triggers": [] }
  ],
  "slices": [
    {
      "id": "S1",
      "title": "資料夾內容數走既有 count 服務",
      "behaviors": ["B1"],
      "verification": "pnpm test -- folder-count",
      "deps": [],
      "files": ["src/services/item-count/folder-count.ts"],
      "production_change_budget": { "files": 3, "lines": 180 },
      "test_change_budget": { "files": 1, "lines": 60 }
    },
    {
      "id": "S2",
      "title": "清單切換即時更新",
      "behaviors": ["B2"],
      "verification": "pnpm test -- FolderRow",
      "deps": ["S1"],
      "files": ["client/src/components/FolderRow.tsx"],
      "production_change_budget": { "files": 2, "lines": 120 },
      "test_change_budget": { "files": 0, "lines": 0 }
    }
  ],
  "evidence_portfolio": [
    {
      "behavior_id": "B1",
      "risk": "medium",
      "existing_guard": "tests/folders/navigation.test.ts",
      "primary_evidence": "integration-test",
      "evidence_layer": "service-ui-boundary",
      "new_test": false,
      "new_test_reason": null,
      "distinct_risk": null
    },
    {
      "behavior_id": "B2",
      "risk": "low",
      "existing_guard": "client/src/components/__tests__/FolderRow.test.tsx",
      "primary_evidence": "existing-test",
      "evidence_layer": "component",
      "new_test": false,
      "new_test_reason": null,
      "distinct_risk": null
    }
  ]
}
```

## 欄位

### `behaviors[]`（有功能行為就必填）

| 欄位 | 規則 |
|------|------|
| `id` | 唯一、非空（如 `B1`），沿用 `stages/00-goal.md` 收斂出的編號 |
| `statement` | 非空，一句可觀察的行為敘述 |
| `risk` | `low` / `medium` / `high`（判準見 `references/stages/risk-map.md`） |
| `risk_triggers` | 陣列；非空時 `risk` 至少 `medium` |

### `slices[]`（施工單位；legacy 名稱 `tasks` 仍接受）

| 欄位 | 規則 |
|------|------|
| `id` | 唯一、非空（如 `S1`） |
| `title` | 非空、不含 " and "（命中＝該再拆，見 `references/stages/task-template.md`） |
| `behaviors` | 陣列，每個值都要對應到存在的 `behaviors[].id`（有 `behaviors` 時必填非空） |
| `verification` | **非空、可執行的指令**（不是「測一下」） |
| `deps` | 陣列，每個值都要對應到存在的 slice `id`；**不可成環** |
| `files` | 陣列（會建 / 改的精確路徑）；**同一檔不得出現在兩個 slice** |
| `production_change_budget` | `{ files, lines }`，皆為 **≥0 整數**（有 `behaviors` 時必填） |
| `test_change_budget` | `{ files, lines }`，皆為 **≥0 整數**（有 `behaviors` 時必填） |
| `budget_overrun_reason` | 選填。實際 footprint 超出 budget 時，把**可稽核理由**寫回這裡（living plan），`scripts/diff-footprint.mjs` 才不判 unexplained |
| `acceptance` | 選填。**沒有 ≤3 條的硬限制**（該限制已隨 evidence portfolio 移除）；「該再拆」看 `task-template.md` 的訊號 |

### `evidence_portfolio[]`（有 `behaviors` 時必填）

| 欄位 | 規則 |
|------|------|
| `behavior_id` | 必須對應到存在的 `behaviors[].id` |
| `risk` | 選填；填了要與 `behaviors[]` 一致 |
| `existing_guard` | 既有守著這個行為的測試 / 檢查；沒有寫 `null` |
| `primary_evidence` | 證據階梯之一：`existing-test` / `static` / `smoke` / `unit-test` / `contract-test` / `integration-test` / `acceptance-test` / `manual-evidence` |
| `evidence_layer` | 非空，這份證據落在哪一層（供第二層證據判重複） |
| `new_test` | boolean |
| `new_test_reason` | `new_test=true` 時**必填非空**：既有證據缺哪個觀察點 |
| `distinct_risk` | 同一 `behavior_id` 的**第二筆起**必填非空（它守的是第一份守不到的什麼風險）；第一筆（primary）填 `null` |

## 驗證

```bash
node plugins/loops-workflow/scripts/validate-plan.mjs <path-to-stages/02-plan.md>
```

通過才進 build。檢查項：

- slice：id 唯一、title 無 " and "、verification 非空可執行、deps 都存在且無環、`files` 無跨 slice 重複。
- behaviors：id 唯一、statement 非空、risk 值域正確、`risk_triggers` 非空時 risk 至少 medium。
- evidence portfolio：每個 behavior **恰一筆 primary**（未填 `distinct_risk` 者）、每個 behavior 都有條目、`new_test=true` 有 `new_test_reason`、第二筆起有 `distinct_risk`、`primary_evidence` 在值域內。
- budget：有 `behaviors` 時每個 slice 兩份 budget 齊全且為 ≥0 整數。
- 每個 slice 的 `behaviors` 都指向存在的 behavior；每個 behavior 至少被一個 slice 認領。

任一不過 → 非零退出 + 逐條列出問題。

## legacy `tasks` 形（無 behavior 的瑣碎改動）

沒有功能行為要承諾時（純內部重構 / 純設定），可只寫 `tasks`（欄位同 `slices`，但免 `behaviors` 與 budget）：

```loops-plan
{
  "tasks": [
    { "id": "T1", "title": "移除死碼", "verification": "pnpm lint", "deps": [], "files": ["src/legacy.ts"] }
  ]
}
```

**一旦出現 `behaviors`，evidence portfolio 與 budget 就是必填** —— 不能用 legacy 形繞過 evidence 規則。
