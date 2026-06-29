# BDD 行為情境（Given-When-Then）

> loops 用輕量 **Given-When-Then（GWT）場景**把「規格（SDD）」接到「測試（TDD）」與「驗收（verify）」。場景是 acceptance criterion 的可執行表達——**純 markdown 文字，不引 Gherkin / Cucumber / `.feature` 工具**（成本意識，AGENTS 規則 10）。

## 在方法論鏈的位置

```
領域語言(DDD) → 規格(SDD) → 行為情境 GWT(BDD) → 紅燈測試(TDD) → 實作 → 驗收回核(BDD+SDD)
```

GWT 是 SDD 與 TDD 之間的**連接組織**：`define`/`goal` 寫出場景 → `build` 的 test-author 從場景推紅燈測試 → `verify` 逐條核場景。

## 格式

每條場景一個 ID（`S1`、`S2`…，issue 內唯一即可、純序號不加前綴），三段：

```
S1（標題）
  Given <前置狀態 / 脈絡>
  When  <觸發的行為>
  Then  <可觀察、可斷言的預期結果>
```

- 用 ubiquitous language（DDD）的名詞寫，與 issue / DoD / code identifier / PR comment 同名（見 `clean-architecture.md` 的 Ubiquitous Language）。
- **一條場景一個行為**；多分支拆多條（happy / edge / failure 各一條）。
- Then 必須是**可觀察的結果**（回應/狀態/持久化），不是實作細節。

## 兩條映射

1. **→ 測試（TDD）**：`Given→Arrange、When→Act、Then→Assert`；測試名帶場景 ID（例 `test_S1_owner_can_delete`）。test-author 拿到場景就能推測試、不必猜需求。
2. **→ 驗收（verify）**：acceptance 閘逐條核「每個場景 ID 是否被滿足」，沿用五態（已滿足（有證據）/ 部分 / 缺失 / 證據不足 / 被反證）。

## 右尺寸（隨 operation × size 縮放，規則 10）

| 情境 | 場景數 |
|---|---|
| 瑣碎 / 純 refactor（不動行為） | 0（refactor 用 characterization test 釘現狀，見 `operation-first-move.md`） |
| bug-fix | **重現 bug 的那一條就是場景**（修前 Then 失敗、修後通過） |
| 一般 new-feature / change-behavior | happy + 關鍵 edge |
| 高風險 / 動到核心領域 | 完整場景集（含失敗模式 / 邊界） |

**小任務免 ceremony**：不要為一行修改硬寫三條場景。

## 與既有規範的關係（互補、不重複）

- `contract-spec.md`：contract 管**形狀**（API/資料/事件的結構、錯誤形狀、不變式）；場景管**行為**（什麼情境下發生什麼）。
- `test-rubric.md`：場景是 test-author 的**需求輸入**；test-rubric 管測試怎麼寫（四層 / Real>Fake>Stub>Mock / AAA）。
- `goal-restate-schema.md`：DoD 的 Success / 停止條件用場景表達（帶 ID），成為可逐條回核的完工核心。

## 範例（一般 new-feature）

```
S1 永久刪除：擁有者刪自己的 trash item
  Given 使用者 A 的 trash 內有 item X
  When  A 對 X 發 DELETE /api/trash/X
  Then  X 從儲存被永久移除，回 204，後續 GET 查不到

S2 不可刪他人（授權邊界）
  Given item X 屬於使用者 B
  When  使用者 A 對 X 發 DELETE /api/trash/X
  Then  回 403/404，X 仍在 B 的 trash（不被刪）
```

對應測試 `test_S1_owner_can_permanently_delete` / `test_S2_cannot_delete_others`；verify 閘逐條核 S1/S2。
