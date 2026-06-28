# verify triage — 改動風險分級 rubric（4 級梯）

> verify §1.4 用的明文判準：orchestrator 看 build 的 Change Summaries + 改動檔案清單，把這次改動歸到 **SKIP / LIGHT / STANDARD / DEEP**，決定核心 reviewer 的下界。**判準可逐條核對，存疑一律向上升級**（fail-safe 向嚴）。這份只定「核心軸下界」；領域 reviewer 由 `optional-reviewers.md`（§1.5）觸及才加派、去重疊加。

## 判定順序（由嚴到寬，命中即定級）

```
1. 碰「高風險硬閘清單」任一？           → DEEP（不論行數多小）
2. 否則 大 blast-radius / 大量 AI 生成？  → DEEP
3. 否則 符合「SKIP 條件」且「SKIP 護欄」全成立？ → SKIP
4. 否則 符合「LIGHT 判準」全成立？        → LIGHT
5. 否則（含任何 code 的一般改動）         → STANDARD（預設）
```

> **任一步驟存疑 → 取較嚴的級**。含 code 至少 LIGHT；混 code+文件 / 混多領域 → 當 code 並至少 STANDARD。

## 高風險硬閘清單（→ DEEP，不論行數）

改動**觸及**下列任一即 DEEP（用檔案 path / 改動語意判，寧可誤判為高風險）：

- **auth / authz**：登入、session、token、權限判斷、middleware guard、ownership 檢查。
- **加密 / 密鑰 / 機敏資料**：crypto、簽章、密鑰 / secret 處理、PII / PHI / PCI、敏感資料進 log / 回應。
- **金流 / billing**：付款、計費、額度、退款。
- **DB schema / migration**：schema 變更、migration、資料 backfill、索引變更。
- **對外 API / 契約**：public endpoint、跨服務 / 前後端共用介面、CLI 對外行為、事件 payload 契約。
- **並發 / 非同步 / 背景流程**：queue、background job、鎖、交易邊界、重試 / 冪等路徑。
- **IaC / 部署設定**：CI/CD 發布、基礎設施、權限 / 網路設定。

> 命中高風險硬閘的 DEEP 流程：先 §1.6 stage-0 tripwire（product-contract + correctness）→ 過了才放完整 6 軸 + 必帶條件式 + §2.5 holistic。

## 大 blast-radius / 大量 AI 生成（→ DEEP）

- **大 blast-radius**：改到**被廣泛 import 的共用元件 / 核心型別 / 跨多模組的契約**（改一處波及面大）。
- **大量 AI 生成**：單次大批 AI 生成的 code（業界資料：缺人類審的大批生成 code 缺陷率較高）。

## SKIP 條件（受護欄保護的瑣碎面 → 不派 reviewer）

**改動類別**屬下列之一：

- 純 docs / 註解 / 純 markdown 敘述。
- 純格式 / 排版（無語意改動）。
- test-only（只加 / 改測試，不動被測 code）。
- 死碼 / 未用 import / 未用方法移除。
- 依賴 **SemVer patch** 升版（非 minor / major）。
- **<5 行且語意明確**的邏輯改動（如改一個常數、補一個明顯 guard）。

### SKIP 護欄（**全成立**才可 SKIP，缺一即向上升級）

1. **quality-gate（CI）綠** —— 型別 / lint / 測試已過。
2. **單一領域** —— 改動 confined 在一個模組 / 關注點，未散落多處。
3. **不碰任何高風險硬閘路徑**（見上清單）。
4. **無夾帶（tangling）** —— 見下方 tangling 判準。

## LIGHT 判準（小孤立低風險 code → 3 軸：correctness + product-contract + tests）

**全部成立**才走 LIGHT，任一存疑 → STANDARD：

1. **單一領域** —— diff confined 在一個模組 / 關注點。
2. **低 blast-radius** —— 動到的 symbol fan-in 低（不是被廣泛 import 的共用元件 / 核心型別 / 跨切面）。
3. **有測試覆蓋** —— 被改的 code 已有既有測試守。
4. **不碰高風險硬閘路徑**。
5. **無夾帶（tangling）**。
6. **規模小** —— 單一 concern、約數十行內。

## tangling 判準（夾帶偵測，veto SKIP/LIGHT）

「瑣碎外觀」下夾帶了**真正的邏輯 / 行為改動**就算 tangling —— bug-fix commit 典型只 ~17–32% 行是真修正，其餘是夾帶的重構 / 文案 / 空白。判定：

- diff 是否**只**屬單一宣稱類別（純 docs？純格式？純 test？），還是其中混了**會改變執行行為**的 code？
- 一個「小重構」是否其實改了行為（不是純結構搬移）？
- 命中任一 → **不得 SKIP/LIGHT，打回 STANDARD**（含 code 一律重驗）。

## catastrophic miss 判準（DEEP §1.6 tripwire 的 bounce 門檻）

stage-0 tripwire（product-contract + correctness 兩軸）**任一回 validated P0/P1** 即 catastrophic miss → bounce 回 build、不啟動完整 fan-out。典型：

- **解錯問題** —— 做的根本不是 issue 要的（product-contract）。
- **partial 當完成** —— 核心驗收標準未達卻當完工（product-contract）。
- **核心契約落空** —— 對外形狀 / DoD 契約破壞（product-contract）。
- **happy-path 崩壞** —— 核心正確流程跑不起來 / 明顯狀態流錯誤（correctness）。

> 兩軸**皆無 validated P0/P1** → 放行，且**兩軸結果併入正式 fan-out、不重跑**（tripwire 不是額外一輪全 review，是把 6 軸裡的這 2 軸先跑當 gate）。

## 範例

| 改動 | 判定 | 級 |
|---|---|---|
| README 補一段、改錯字 | SKIP 條件 + 護欄全成立 | SKIP |
| 某 util 函式加一個邊界 guard、有測試、單檔、非高風險 | LIGHT 判準全成立 | LIGHT |
| 新增一個一般 service 方法 + 前端呼叫 | 一般 code、混前後端 → 向嚴 | STANDARD |
| 改 2 行 auth middleware 的權限判斷 | 碰 auth 高風險硬閘 | DEEP |
| 加一條 DB migration | 碰 schema/migration 硬閘 | DEEP |
| 「改個錯字」但 diff 裡夾帶改了一段條件邏輯 | tangling veto | STANDARD |
