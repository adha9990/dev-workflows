# vertical behavior slice 模板 + 該再拆訊號

> plan 階段拆施工單位用。**單位是 vertical behavior slice**：一個 slice 交付 ≥1 個 `behavior_id` 的**端到端可跑**改動（做完系統還是 runnable），且**能獨立 verify** —— 所以 Verification 欄必須是能實際跑的指令。

## slice 模板

```markdown
### Slice <Sn>：<簡短標題，不含 "and">

- **Behaviors**：<這個 slice 交付哪幾個 behavior_id（至少一個）>
- **Description**：<做什麼，一兩句>
- **Evidence**：<每個 behavior 的 primary evidence（型別 + 落點），見 `references/stages/evidence-portfolio.md`>
- **Verification**：<能複製貼上去跑的具體指令 + 預期結果>
  - 例：`npm test -- src/foo.test.ts` → 全綠
  - 例：`curl -s localhost:3000/api/x | jq .total` → 回 42
- **Dependencies**：<依賴哪些前置 slice / 外部條件>
- **Files**：<會建 / 改哪些檔（精確路徑）；同一檔不得跨兩個 slice>
- **Budget**：<production files/lines ＋ test files/lines 的可稽核預估>
- **Scope**：<明確不碰什麼，避免越界>
```

> **追溯線（SDD traceability）**：`behavior_id → slice → primary evidence → verify 逐 behavior 回核`。有 GWT 場景的 behavior，測試名可帶場景 ID（`test_S1_…`）讓線更好讀（見 `references/stages/bdd-scenarios.md`）。**「一個 behavior 一份主證據」是硬規則，「一條 AC 一條測試」不是。**

## 「該再拆」訊號（命中任一就切小）

| 訊號 | 為什麼要拆 |
|------|------|
| 預估 **> 2 小時** | 太大，回饋循環拉太長、難回頭 |
| 交付 **> 2 個 behavior** | 一個 slice 扛太多承諾，沒法乾淨驗收也沒法乾淨退回 |
| 跨 **2+ 子系統** | reviewer 沒法獨立接受 / 退回單一 slice |
| 標題裡有 **"and"** | 「做 A and B」就是兩個 slice |

> **舊的「Acceptance > 3 條」訊號已移除**：那條把「驗收條件數」當成拆分依據，會誘導把一個行為拆成多個小 task、再各補一份測試——正是要消除的放大鏈。改看**承諾了幾個 behavior**。

## 尺寸與依賴

- 理想 slice = 一個 behavior 從入口到可觀察結果的最小端到端改動。
- **垂直切片、不橫切**：別「全 DB → 全 API → 全 UI」橫著做；每個 slice 切成**端到端能跑的薄垂直切片**，做完系統還是 runnable —— 這樣每 2–3 個 slice 的 checkpoint 才真的驗得到。
- **排序 risk-first**：相依允許下，**最高不確定性 / 最可能卡住的切片先做**（`risk=high` 或 `risk_triggers` 非空者優先），早點撞 blocker，別等沉沒成本堆高才發現（對齊 `AGENTS.md` 規則 10 fail-fast）。
- **尺寸階梯**：XS（1 檔 / 單一函式）· S（1–2 檔）· M（3–5 檔 / 單一子系統）· L（5–8 檔 / 多元件）· **XL（8+ 檔 / 跨子系統）= 一定要拆**。配上面的訊號一起用。
- 畫**依賴圖**：標出哪些 slice 可並行、哪些有先後。
- 每 **2–3 個 slice** 插一個 checkpoint（停下對齊，避免一路偏移）。

## legacy `task` 形

沒有行為要承諾的純內部改動（死碼清理、設定調整、純結構重構）沿用舊的 task 敘述即可（Description / Verification / Dependencies / Files / Scope），免 Behaviors / Evidence / Budget 欄 —— 對應 `references/stages/machine-plan-schema.md` 的 legacy `tasks` 形。
