# Reviewer 嚴重度 / 信心 / Route

> verify 各 reviewer 與 coordinator 共用的分級語彙（P0–P3 / Confidence / Route），讓每個 reviewer 的輸出格式一致、可彙整。

## Finding 形狀

每個候選 finding 用這個形狀回傳（要有具體證據，不接受空泛主張）：

```markdown
- Severity: P0 | P1 | P2
  Confidence: 50 | 75 | 100
  Validation needed: yes | no
  Route: product-contract | engineering-safety
  檔案/區域：
  問題：
  發生什麼事：
  影響：
  建議修正：
  建議補測試：
```

只要該問題能用 regression test 守住，就要填「建議補測試」。精確行號有幫助但非必要。

## 嚴重度（Severity）

- **P0**：致命損壞、可被利用的漏洞、資料遺失 / 毀損，或完工定義落空到「做錯了問題」。
- **P1**：一般使用很可能踩到的高影響缺陷、缺少核心驗收標準、auth / API / DB 契約破壞，或核心行為缺測試。
- **P2**：有意義的缺點、狹窄的邊界狀況、效能 / 可靠性疑慮，或單獨不至於擋合併的可維護性陷阱。
- **P3**：低影響觀察；本身永遠不是 blocker，不放進候選 finding（有用就放 Non-blocking notes，否則省略）。

## 信心（Confidence）

- **100**：可直接從 code 或明確的專案規則驗證。
- **75**：reviewer 讀了改動與周邊 code，確認了對使用者 / caller / runtime 的具體後果。
- **50**：合理、或驗證了但範圍窄 / 主觀 / 仍偏判斷；**除非是 P0 風險，不要當 blocker**。

## Route（分流去向）

- **product-contract**：與完工定義（`00-goal.md`）/ 產品行為 / UI/UX / 範圍 / 非目標 / 驗收標準有關。
- **engineering-safety**：與正確性 / 架構 / 安全 / 效能 / 測試 / 發布風險有關。

## Coordinator 依嚴重度的合併關卡

- **P0**：經驗證或直接證明後，一律擋，最終 `Not ready`。
- **P1**：經驗證或直接證明後，擋；除非明確在完工定義契約之外且可安全延後（延後要說明）。
- **P2**：預設不擋；只有違反核心驗收標準、必要驗證證據、auth / API / DB / 資料安全等高風險邊界時才升級為 blocker。
- **P3**：永遠不擋。

## 彙整鐵律

- 任一 reviewer 回報**有依據且經驗證**的 blocking finding → 整體 `Not ready`。
- coordinator 去重，並**拒絕**模糊 / 純偏好 / 低信心 / 既有且無關 / 純 linter / 缺依據的主張當 blocker。
- Confidence `50` 通常降為 Non-blocking note 或未驗證區域；只有影響會是 P0 且不確定性講清楚時才可擋。
- 單一 reviewer 的 finding 是原始輸入，不是最終決定 —— 進 Blocking 前要嘛 coordinator 直接從 code 驗證，要嘛走 `finding-validation.md` 跑一輪 finding-validator。
- **核心行為缺測試 / 缺明確驗證證據，本身就是有效 blocker**，即使沒找到 code bug。
- `holistic-reviewer`（verify §2.5 交叉軸 pass）的 finding 走**同一套**形狀與分級、併入一起進 finding-validator，不特權。
- 套 **Metric-Honesty**：沒實跑的效能 / 覆蓋宣稱一律標 `not measured`。
