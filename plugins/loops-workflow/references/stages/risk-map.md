# risk-map —— 方法論鏡片與驗收強度的機械觸發表（單一正本）

> **使用者不選方法論。** `explore` 固定產出三張表——**reuse map**（可重用的既有實作）、**impact surface**（這次會動到誰）、**risk map**（本檔定義的機械可讀 predicate）。DDD、Contract-First、test-first（TDD）與額外 reviewer **只在 predicate 命中時啟用**；未命中就不做那層 ceremony（不建 glossary / aggregate / port / adapter / 完整 contract 規格，也不固定派滿 reviewer）。
>
> 這份是 **predicate 的唯一定義處**：`skills/explore`（產出）、`skills/plan`（決定要不要開 DDD / Contract-First 段落）、`skills/build`（決定哪些 behavior 走 test-first）、`skills/verify`（選 reviewer）都**引用本檔、不各自重述**。

## 產出落點與形狀

`stages/01-explore.md` 內嵌一塊 `loops-risk-map` JSON（`behavior_id` 沿用 `goal` 收斂出的編號，見 `evidence-portfolio.md`）：

````
```loops-risk-map
{
  "domain_complexity": false,
  "external_or_cross_module_contract": true,
  "behaviors": [
    { "id": "B1", "risk": "low", "risk_triggers": [] },
    { "id": "B2", "risk": "high", "risk_triggers": ["data-consistency", "concurrency"] }
  ],
  "impact_surface": ["src/http/routes/orders.ts", "src/services/order/"],
  "reuse": ["src/services/order/order-query.ts 已有分頁參數化，擴充而非另造"]
}
```
````

| 欄位 | 規則 |
|---|---|
| `domain_complexity` | boolean，判準見下表 A |
| `external_or_cross_module_contract` | boolean，判準見下表 A |
| `behaviors[].id` | 對應 `stages/00-goal.md` 的 `behavior_id` |
| `behaviors[].risk` | `low` / `medium` / `high`（`risk_triggers` 非空 ⇒ 至少 `medium`） |
| `behaviors[].risk_triggers` | 表 B 的觸發字串陣列；無則空陣列 |
| `impact_surface` | 這次預期會動到 / 波及的路徑（給 plan 切 slice、給 verify 定波及面） |
| `reuse` | 找到的可重用實作與「為什麼擴充而非另造」（一條一行） |

## A. 方法論鏡片（loop 級，兩個 predicate）

| predicate | 判 true 的條件（命中任一） | 命中 → 啟用 | 未命中 → **不做** |
|---|---|---|---|
| `domain_complexity` | ① 這次要維持的規則牽涉 **≥3 個彼此有不變式關聯的領域名詞**；② issue / DoD 明文要求「跨多個實體維持一致」的業務規則；③ 改動落在既有 bounded context 的**邊界**上（跨 context 讀寫） | **DDD 鏡片**：ubiquitous language glossary、invariant 清單、aggregate 邊界（見 `references/shared/quality/clean-architecture.md`） | 不建 glossary / aggregate / bounded context 圖 |
| `external_or_cross_module_contract` | 改動觸及 **public API endpoint**／**對外事件 payload**／**持久化 schema**／**跨模組（跨 package·跨層）共用介面**／**CLI 對外行為** 任一 | **Contract-First**：先定契約（`references/shared/quality/contract-spec.md`）再實作 ＋ **最小 contract test**（對外形狀一條，不逐分支鋪） | 不寫 contract 規格段、不建新 port / adapter |

> 兩個 predicate 各自獨立，可同時 true、可同時 false。**同時 false 是常態**（多數功能改動落在既有領域與既有契約之內）。

## B. behavior 級 test-first（TDD）觸發

**TDD 是高風險邏輯的實作手法，不是所有 behavior 的固定控制面。** 下列任一 trigger 命中該 behavior → 它的主證據**必須是 test-first 產出的自動化測試**（build 走紅→綠）；全未命中 → 依 `evidence-portfolio.md` 的證據階梯挑**最低有效**證據，可以不新增測試。

| trigger | 什麼時候命中 |
|---|---|
| `bug` | `loop.md` 的 `operation=bug-fix`，或此 behavior 是修一個已回報的錯誤行為（重現測試就是它的主證據） |
| `core-invariant` | 破壞它會讓資料 / 狀態進入不合法態（餘額為負、孤兒外鍵、狀態機非法轉移） |
| `algorithm` | 有明確輸入→輸出對應且邊界條件多（排序 / 解析 / 計算 / 比對 / 格式轉換） |
| `security` | authn / authz、輸入信任邊界、密鑰、敏感資料流向 |
| `concurrency` | 並發、競態、鎖、非同步排序、重試 / 冪等路徑 |
| `data-consistency` | 交易邊界、schema migration、backfill、跨表 / 跨服務一致性 |

> **不觸發 TDD 的典型**：接線（wiring）、設定（config）、metadata / 註冊表、文件、純結構 refactor、UI 版面調整、把既有能力接到新入口。這些走 existing-test / static / smoke / 可重跑 manual 證據。

## C. verify reviewer 選擇（風險式，取代「一般 code 固定六軸」）

**固定必派（所有功能改動）**：`product-contract`（做到了沒）＋ `code-quality`（正確性與狀態流）。

其餘依 risk map 觸發，**與領域 conditional reviewer（`optional-reviewers.md`）正交、可疊加**：

| 加派 | 觸發條件 |
|---|---|
| `tests` | 任一 behavior `new_test=true`，或任一 `risk_triggers` 非空，或本輪是收尾裁測 pass |
| `security` | 任一 behavior 帶 `security` trigger，或命中 `verify-triage.md` 的高風險硬閘 |
| `architecture` | `domain_complexity=true` 或 `external_or_cross_module_contract=true`，或這次新增了架構接縫（新服務 / 新 port / 新跨層機制） |
| `performance` | 改動落在查詢 / 迴圈 / 大量資料 / 熱路徑（`impact_surface` 命中資料存取或批次處理） |

## D. fail-safe（三條，不可讓右尺寸化變成後門）

1. **高風險硬閘不被本表縮小**：命中 `references/stages/verify-triage.md` 的高風險硬閘清單（auth / 加密 / 金流 / schema migration / 對外 API / 並發 / IaC）→ **一律六核心軸滿派**，不論 risk map 怎麼寫、不論行數多小。
2. **predicate 拿不準一律判 `true`**、`risk` 拿不準一律往上一級。向嚴是預設方向。
3. **risk map 缺失 = 沒有右尺寸依據**：`stages/01-explore.md` 沒有 `loops-risk-map` 區塊時，verify **退回 `verify-triage.md` 的既有風險梯**（一般 code 六軸）決定派誰，**不得因「沒有 risk map」而少派**。

## 與既有規範的關係

- `verify-triage.md`：定**核心軸下界**與高風險硬閘（fail-safe 上界）。本檔在其之上做**風險式縮放**——縮放結果不得低於硬閘要求。
- `optional-reviewers.md`：領域 conditional reviewer 的觸發對照（前端 / a11y / migration / root-cause…）不變，與本表 C 疊加。
- `operation-first-move.md`：管 `operation` 性質 × **紅燈第一步怎麼寫**；本檔管 **這個 behavior 要不要走紅燈**。兩者作用點不同、不重疊。
- `evidence-portfolio.md`：本檔決定「風險等級與 TDD 觸發」，那份決定「這個 behavior 用哪一份證據」。risk map 是它的輸入。
