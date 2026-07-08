# 機器可驗證計畫檔（machine-plan-schema）

> 進階：讓 `stages/02-plan.md` 除了給人看的任務敘述，再附一塊**機器可驗證**的結構，由 `scripts/validate-plan.mjs` 在進 build 前自動檢查（plan → validate → execute）。**選用** —— 不開時 plan 仍純 markdown 給人看。

## 在 stages/02-plan.md 內嵌一塊 `loops-plan` JSON

```loops-plan
{
  "tasks": [
    {
      "id": "T1",
      "title": "搜尋端點加 owner 過濾",
      "acceptance": ["只回傳當前使用者訂單", "未登入回 401"],
      "verification": "npm test -- orders.search.test.ts",
      "deps": [],
      "files": ["src/routes/orders.ts"]
    },
    {
      "id": "T2",
      "title": "搜尋結果分頁",
      "acceptance": ["回傳含 limit/offset", "預設上限 50"],
      "verification": "npm test -- orders.pagination.test.ts",
      "deps": ["T1"],
      "files": ["src/routes/orders.ts"]
    }
  ]
}
```

## 欄位

| 欄位 | 規則 |
|------|------|
| `id` | 唯一、非空（如 `T1`） |
| `title` | 非空、不含 " and "（命中＝該再拆，見 `references/task-template.md`） |
| `acceptance` | 非空陣列，**≤ 3 條**（超過＝該再拆） |
| `verification` | **非空、可執行的指令**（不是「測一下」） |
| `deps` | 陣列，每個值都要對應到存在的 `id`；**不可成環** |
| `files` | 陣列（會建 / 改的精確路徑） |

## 驗證

```bash
node plugins/loops-workflow/scripts/validate-plan.mjs <path-to-stages/02-plan.md>
```

通過才進 build。檢查項：每任務有可執行 verification、acceptance ≤3 且非空、id 唯一、deps 都存在、依賴無環、title 無 " and "。任一不過 → 非零退出 + 列出問題。
