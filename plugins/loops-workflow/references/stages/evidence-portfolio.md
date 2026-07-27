# evidence-portfolio —— 每個行為恰一份主證據（單一正本）

> **品質標準＝「每個承諾的行為是否有足夠且不重複的證據」，不是「寫了多少測試、派了多少 reviewer」。**
>
> 這份是 evidence portfolio 的唯一定義處：`skills/goal`（收斂 behavior）、`skills/plan`（產出 portfolio）、`skills/build`（照 primary evidence 執行）、`skills/verify`（逐 behavior 驗收）、`scripts/validate-plan.mjs` 與 `scripts/diff-footprint.mjs`（機械核）都**引用本檔、不各自重述**。

## 為什麼要有這張表

沒有它時，需求數量會被 GWT → task → 測試層 → review finding → 回歸測試**連續放大**：一句需求展開成一條驗收標準、一條 GWT、一個 task、一個紅燈測試、一條 contract 測試、一條回歸測試——每一層各自都「有道理」，加起來就是實作與驗收成本失控。

evidence portfolio 把放大鏈**收在一個地方**：先把功能收斂成少量 `behavior_id`，每個 behavior **指定一份**足以證明它的證據，其餘層級要加碼必須寫出它守的是**別的風險**。

## 名詞

| 名詞 | 意思 |
|---|---|
| `behavior_id`（`B1`…） | `goal` 收斂出的**可觀察行為**單位。一張 issue 通常 **1–5 個**；不是逐句需求，是「使用者眼中不同的一件事」 |
| **primary evidence** | 能證明這個 behavior 成立的**那一份**證據。每個 behavior **恰一份** |
| `existing_guard` | 既有已經守住這個 behavior 的測試 / 檢查（指名檔案 + 案例）。有就不新增 |
| `distinct_risk` | 同一 behavior 要**第二份跨層證據**時，必須寫出「第二份守的是第一份守不到的**哪個**風險」。寫不出＝重複證據，刪掉 |
| **vertical behavior slice** | plan 的施工單位：一個 slice 交付 ≥1 個 behavior 的**端到端可跑**改動，帶自己的檔案清單與 change budget |

## 證據型別階梯（挑**最低有效**的一階）

由上往下成本遞增。**能用上面那階證明的就別用下面的**——高層證據又慢又脆，且多守不到任何行為。

| `primary_evidence` | 什麼時候用 | 這份證據長什麼樣 |
|---|---|---|
| `existing-test` | 既有測試已涵蓋此行為的觀察點 | 指名 `檔案:案例名`，build 後跑它確認仍綠 |
| `static` | 型別 / lint / schema / 編譯期即可證 | typecheck、schema 驗證、註冊表 lint |
| `smoke` | 接線 / 啟動 / 註冊生效與否 | 起一次真實流程打一次，確認接上了 |
| `unit-test` | 純邏輯、可枚舉輸入輸出 | 一條代表路徑 + 邊界，不鋪排列組合 |
| `contract-test` | API / event / 持久化 schema 的**對外形狀** | 形狀與錯誤形狀各一條，不逐分支鋪 |
| `integration-test` | 跨邊界（真實 DB / FS / HTTP）行為 | 走真實依賴，見 `references/shared/quality/test-rubric.md` |
| `acceptance-test` | 一條使用者 journey | **一條代表路徑**，不是每個分支一條 |
| `manual-evidence` | 視覺 / 手感 / OS 整合這類只能人眼判的 | **必須可重跑**：環境 + 步驟 + 預期 + 實際 + 前後對照 |

**低風險類別的預設**：wiring、config、metadata、docs、低風險 refactor → 預設 `existing-test` / `static` / `smoke` / 可重跑 `manual-evidence`，**不新增測試**。

## 硬規則（validate-plan 機械核）

1. **每個 behavior 恰有一個 primary evidence**——portfolio 裡該 behavior 只能有一筆沒填 `distinct_risk` 的條目。
2. **`existing_guard` 足夠時 `new_test=false`**，不得新增測試。
3. **`new_test=true` 必填 `new_test_reason`**：指名既有證據**缺哪個觀察點**（不是「加強覆蓋」這種空話）。
4. **同一 behavior 的第二層證據必填 `distinct_risk`**；寫不出就是重複證據，不准進 build。
5. **每個 slice 必須有 production 與 test 兩份 change budget**（`files` / `lines`），缺少可驗證的 budget 不准進 build。
6. **每個 planned changed file 恰屬於一個 slice**（同一檔出現在兩個 slice ＝ 切片沒切乾淨）。
7. **取消三條舊耦合**：不再「一個 GWT 對應一個新測試」、不再「每個 task 必須有新測試」、不再硬性「Acceptance ≤3 條」。

## 形狀（`stages/02-plan.md` 內嵌 `loops-plan` 區塊，正本見 `machine-plan-schema.md`）

```yaml
behaviors:
  - id: B1
    statement: 使用者在資料夾清單看得到子資料夾的內容數
    risk: medium
    risk_triggers: []

slices:
  - id: S1
    title: 資料夾清單顯示子資料夾內容數
    behaviors: [B1]
    files: [src/services/item-count/folder-count.ts, client/src/components/FolderRow.tsx]
    verification: pnpm test -- folder-count
    production_change_budget: { files: 5, lines: 350 }
    test_change_budget: { files: 1, lines: 120 }

evidence_portfolio:
  - behavior_id: B1
    risk: medium
    existing_guard: tests/folders/navigation.test.ts
    primary_evidence: integration-test
    evidence_layer: service-ui-boundary
    new_test: false
    new_test_reason: null
    distinct_risk: null
```

## 誰消費這張表

| 階段 | 用它做什麼 |
|---|---|
| `goal` | 產 `behavior_id` 與（必要時）關鍵 GWT 場景 |
| `explore` | 產 risk map（見 `risk-map.md`），決定每個 behavior 的 `risk` 與 `risk_triggers` |
| `plan` | 產 portfolio ＋ slices ＋ budget；`scripts/validate-plan.mjs` 擋缺失 / 重複 / 無預算 |
| `build` | 依 `primary_evidence` 決定這個 slice 怎麼做：test-first / contract-first / 跑既有證據 / static·smoke |
| `verify` | acceptance 閘**逐 behavior** 核「這份 primary evidence 真的成立嗎」，不逐句 AC 展開 |
| `iterate` | finding 只有**暴露新的獨立風險**時才加新證據（填 `distinct_risk`），否則沿用既有 |
| PR 閘 | `scripts/diff-footprint.mjs` 對 budget / slice 歸屬 / `new_test_reason` / `distinct_risk` 機械核 |

## 常見藉口

| 藉口 | 反駁 |
|---|---|
| 「多一層測試比較保險」 | 保險的是**守到不同風險**，不是多一份。守同一件事的第二份證據不增加安全度，只增加維護面與跑套時間——要加就寫得出 `distinct_risk`。 |
| 「這條 GWT 沒有對應測試，看起來像漏做」 | GWT 表達行為、不是測試的訂單。它對到的是**一份主證據**，那份可以是既有測試。 |
| 「先寫測試比較快，反正之後裁」 | 裁測是最後一次收斂、不是唯一控制點。寫之前先問「既有證據為什麼不夠」，比寫完再刪便宜。 |
| 「這個 slice 沒抓 budget，反正不會超」 | 沒有 budget 就沒有 drift 可判，footprint 閘等於關閉。budget 是**可稽核的預估**，超了補理由即可，不是禁止超。 |

## 與既有規範的關係（互補、不重複）

- `risk-map.md`：決定 `risk` / `risk_triggers` / 方法論鏡片 / reviewer 選擇；本檔決定**證據**。
- `bdd-scenarios.md`：GWT 只用於**重要、非直觀或跨角色**的行為；一條場景對到一個 behavior 的主證據，**不是**對到一條新測試。
- `test-rubric.md`：管**測試怎麼寫**（分層 / real-not-mock / 判必要與判多餘）；本檔管**要不要寫**。§10 的量級門檻是收尾裁測的下界，本檔的 budget 是 plan 期的上界，兩者同向、不衝突。
- `task-template.md`：slice 的欄位與「該再拆」訊號。
- `machine-plan-schema.md`：`loops-plan` 區塊的欄位正本與驗證指令。
