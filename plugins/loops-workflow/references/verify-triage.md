# verify triage — 改動風險分級 rubric（定 0~6 核心軸）

> verify 步驟 1（選軸）用的明文判準：orchestrator 看 build 的 Change Summaries + 改動檔案清單，定**核心 reviewer 的下界（0~6 軸）**。**判準可逐條核對，存疑一律向上升級**（fail-safe 向嚴）。這份只定「核心軸下界」；領域 reviewer（conditional）由 `optional-reviewers.md` 觸及才加派、去重疊加。

## 判定順序（命中即定級）

```
1. 碰「高風險硬閘清單」任一？             → 高風險（6 核心，一律滿、不論行數）
2. 否則 大 blast-radius / 大量 AI 生成？    → 高風險（6 核心）
3. 否則 非 code 的實質文件 / 設定（有驗收契約）？ → product-contract + 領域 docs-devex（不入 code 級梯）
4. 否則 瑣碎（純文件/格式/test-only/死碼/SemVer patch、無驗收契約、不碰高風險、無夾帶）？ → 0 核心
5. 否則 符合「小孤立 code」全成立？          → 3 核心（correctness + product-contract + tests）
6. 否則（含任何 code 的一般改動）           → 6 核心（預設）
```

> **任一步驟存疑 → 取較嚴的級**。含 code 至少 3 軸；混 code+文件 / 混多領域 → 當 code 並至少 6 軸。

## 高風險硬閘清單（→ 6 核心，一律滿、不論行數）

改動**觸及**下列任一即高風險（用檔案 path / 改動語意判，寧可誤判為高風險）：

- **auth / authz**：登入、session、token、權限判斷、middleware guard、ownership 檢查。
- **加密 / 密鑰 / 機敏資料**：crypto、簽章、密鑰 / secret 處理、PII / PHI / PCI、敏感資料進 log / 回應。
- **金流 / billing**：付款、計費、額度、退款。
- **DB schema / migration**：schema 變更、migration、資料 backfill、索引變更。
- **對外 API / 契約**：public endpoint、跨服務 / 前後端共用介面、CLI 對外行為、事件 payload 契約。
- **並發 / 非同步 / 背景流程**：queue、background job、鎖、交易邊界、重試 / 冪等路徑。
- **IaC / 部署設定**：CI/CD 發布、基礎設施、權限 / 網路設定。

> 命中高風險：完整 **6 核心** + **對應領域條件式**（觸及才加；auth/加密/金流等無對應條件式者由核心 security 軸承接），**全並行、一次跑完**。「小 ≠ 安全」—— 不論行數多小都 6 軸、不准縮。跑完若確證根本做錯 → 整個退回（見下）。

## 大 blast-radius / 大量 AI 生成（→ 6 核心）

> 門檻是**啟發式代理、非精準**（拿不準一律向嚴升）。

- **大 blast-radius**：改到**被廣泛 import 的共用元件 / 核心型別 / 跨多模組的契約**（改一處波及面大）。代理：**fan-in ≥ ~5（import / caller 站點）**、或在 **public barrel / index 匯出**、或屬**核心型別 / 共用 schema**。
- **大量 AI 生成**：單次大批 AI 生成的 code（缺人類審的大批生成缺陷率較高）。代理：單次 **> ~100 行** AI 生成。

## 瑣碎 → 0 核心（無驗收契約的瑣碎面）

**改動類別**屬下列之一，**且**不碰高風險硬閘、無夾帶（tangling）、CI 綠：

- 純 docs / 註解（瑣碎文字、**無驗收契約**）。
- 純格式 / 排版（無語意改動）。
- test-only（只加 / 改測試，不動被測 code）。
- 死碼 / 未用 import / 未用方法移除。
- 依賴 **SemVer patch** 升版（非 minor / major）。

> **含執行語意的 code 不進 0 核心**（含 <5 行邏輯改動，如改常數 / 補 guard → 走 3 核心便宜審，不是 0）。**有驗收契約的實質文件 / 設定**（一張 docs issue 的內容、對外契約文件）→ 不算瑣碎，派 `product-contract`（驗收）+ 領域 `docs-devex`。

## 小孤立 code → 3 核心（correctness + product-contract + tests）

**全部成立**才走 3 核心，任一存疑 → 6 核心：

1. **單一領域** —— diff confined 在一個模組 / 關注點。
2. **低 blast-radius** —— 動到的 symbol fan-in 低（代理：**fan-in < ~5**、非 public barrel / index 匯出、非核心型別 / 跨切面）。
3. **有測試覆蓋** —— 被改的 code 已有既有測試守。
4. **不碰高風險硬閘路徑**。
5. **無夾帶（tangling）**。
6. **規模小** —— 單一 concern、約 **≤ 數十行**。

## tangling 判準（夾帶偵測，veto 0核心 / 3核心）

「瑣碎外觀」下夾帶了**真正的邏輯 / 行為改動**就算 tangling —— bug-fix commit 典型只 ~17–32% 行是真修正，其餘是夾帶的重構 / 文案 / 空白。判定：

- diff 是否**只**屬單一宣稱類別（純 docs？純格式？純 test？），還是其中混了**會改變執行行為**的 code？
- 一個「小重構」是否其實改了行為（不是純結構搬移）？
- 命中任一 → **不得 0 核心 / 3 核心，打回 6 核心**（含 code 一律重驗）。

## 做錯東西就整個退回（catastrophic miss 判準，所有級通用）

審查（fan-out）一次跑完後，若 `product-contract` / 正確性 **任一回確證的 P0/P1**（reviewer 直接證明 / coordinator 當場驗證，**非** §3 finding-validator 的 `validated` 專稱）＝根本性做錯 → **整個退回、不對其他軸 finding 逐條修**，由 **iterate 依錯在哪路由回對的階段**（解錯問題 / 方向錯 → goal / explore；設計或拆解缺陷 → plan；單純實作 bug → build）。典型：

- **解錯問題** —— 做的根本不是 issue 要的（product-contract）。
- **partial 當完成** —— 核心驗收標準未達卻當完工（product-contract）。
- **核心契約落空** —— 對外形狀 / DoD 契約破壞（product-contract）。
- **happy-path 崩壞** —— 核心正確流程跑不起來 / 明顯狀態流錯誤（correctness）。

> **「整個退回」≠「逐項 acceptance ledger」（兩者都所有級通用、互補）**：
> - **本段「做錯東西就整個退回」**處理**根本性 miss**（做了別的東西 / 核心沒做到 / 最基本流程崩壞）—— 一旦確證，**整個退回（iterate 依錯在哪路由 goal/explore/plan/build）、別逐條修**。
> - **`acceptance-review.md` §二的逐項完整性 gate**處理**每條 acceptance criterion 有沒有收斂**（五態列完、無未處理項才准 Ready，餵 verify 步驟 4 acceptance 閘）。
> - 兩者同源（契約面的 P0 同時觸發兩者）、都**所有級適用**。

## 範例

| 改動 | 判定 | 核心軸 |
|---|---|---|
| README 改錯字（純文字、無驗收契約） | 瑣碎（不碰高風險、無夾帶） | 0（領域視內容帶 docs-devex） |
| 一張 docs issue 的實質文件內容 | 有驗收契約 → 非瑣碎 | product-contract + 領域 docs-devex |
| 某 util 函式加一個邊界 guard、有測試、單檔、非高風險 | 小孤立 code 全成立 | 3 |
| 新增一個一般 service 方法 + 前端呼叫 | 一般 code、混前後端 → 向嚴 | 6 |
| 改 2 行 auth middleware 的權限判斷 | 碰 auth 高風險硬閘 | 6（一律滿） |
| 加一條 DB migration | 碰 schema/migration 硬閘 | 6（一律滿） |
| 「改個錯字」但 diff 裡夾帶改了一段條件邏輯 | tangling veto | 6 |
