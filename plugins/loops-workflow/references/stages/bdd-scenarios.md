# BDD 行為情境（Given-When-Then）

> loops 用輕量 **Given-When-Then（GWT）場景**把「規格（SDD）」接到「證據」與「驗收（verify）」。場景是把一個行為講清楚的可執行表達——**純 markdown 文字，不引 Gherkin / Cucumber / `.feature` 工具**（成本意識，AGENTS 規則 10）。
>
> **GWT 是選用的加強說明，不是每個行為的義務**：只有**重要、非直觀、跨角色、或有重要例外**的行為才值得寫場景；直觀行為一句 behavior 敘述就夠（見 `references/stages/evidence-portfolio.md`）。
>
> **一條場景 ≠ 一條新測試。** 場景對到的是**該 behavior 的一份主證據**，那份可以是既有測試、static 檢查或 smoke——由 `plan` 的 evidence portfolio 指定。把「有場景」讀成「要新增測試」，正是實作與驗收成本被放大的第一環。

## 在方法論鏈的位置

```
領域語言(DDD) → 規格(SDD) → 行為情境 GWT(BDD) → 紅燈測試(TDD) → 實作 → 驗收回核(BDD+SDD)
```

GWT 是 SDD 與證據之間的**連接組織**：`goal` 收斂出 behavior、必要時寫場景 → `plan` 為該 behavior 指定主證據（**風險命中才是 test-first**，見 `references/stages/risk-map.md`）→ `verify` 逐 behavior 回核。

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

1. **→ 證據**：場景先對到它所屬 behavior 的 **primary evidence**。若那份證據是要新寫的測試（風險命中 test-first，或 plan 判既有證據不足），`Given→Arrange、When→Act、Then→Assert`、測試名帶場景 ID（例 `test_S1_owner_can_delete`），test-author 拿到場景就能推測試、不必猜需求。**若主證據是既有測試 / static / smoke，就不為場景另開新測試。**
2. **→ 驗收（verify）**：acceptance 閘逐 **behavior** 核「主證據是否成立」，有場景的用場景 ID 當標籤；沿用五態（已滿足（有證據）/ 部分 / 缺失 / 證據不足 / 被反證）。

## 右尺寸（隨 operation × size 縮放，規則 10）

| 情境 | 場景數 |
|---|---|
| 瑣碎 / 純 refactor（不動行為） | 0（refactor 用 characterization test 釘現狀，見 `references/stages/operation-first-move.md`） |
| 接線 / 設定 / metadata / 文件 | 0（行為直觀，behavior 敘述一句就夠） |
| 直觀的 new-feature / change-behavior | 0–1（只有非直觀處才寫） |
| bug-fix | **重現 bug 的那一條就是場景**（修前 Then 失敗、修後通過） |
| 跨角色 / 有重要例外 / 高風險 / 動到核心領域 | happy + 關鍵 edge（必要時含失敗模式 / 邊界） |

**小任務免 ceremony**：不要為一行修改硬寫三條場景。**場景數也不該跟 issue 的句子數等比長** —— 它跟著「非直觀的行為有幾個」走。

## 與既有規範的關係（互補、不重複）

- `contract-spec.md`：contract 管**形狀**（API/資料/事件的結構、錯誤形狀、不變式）；場景管**行為**（什麼情境下發生什麼）。
- `evidence-portfolio.md`：場景表達**行為**，evidence portfolio 決定那個行為**用哪一份證據**證明。場景不決定證據型別。
- `test-rubric.md`：真要寫測試時，場景是 test-author 的**需求輸入**；test-rubric 管測試怎麼寫（四層 / Real>Fake>Stub>Mock / AAA）。
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

這兩條都命中 `security` 風險（授權邊界）→ 主證據走 test-first：`test_S1_owner_can_permanently_delete` / `test_S2_cannot_delete_others`；verify 閘逐 behavior 回核。**若同一張 issue 還有一條「刪除後顯示提示訊息」的直觀行為，它不必寫場景、也不必為它新增測試** —— 既有的 UI 測試或 smoke 就是它的主證據。
