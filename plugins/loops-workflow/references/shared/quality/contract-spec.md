# contract-spec —— 動 code 前先把契約釘死

> plan 階段用：feature 一旦跨介面（API / 資料模型 / 事件 / 跨模組契約），就在 `stages/02-plan.md` 拉一段**契約規格**，把「對外承諾的形狀」在寫 code 前定死。build 照它實作、verify 照它驗收、test 照它鎖。
>
> 為什麼獨立一段：機制圖講「怎麼跑」、決策講「為什麼這樣選」，但都不等於「**對外那一面長什麼樣、誰依賴它、改了會弄壞誰**」。契約沒先釘死，前後端 / 上下游各寫各的，整合才發現對不上。

## 何時要寫（命中任一就寫）

- 新增 / 改 **API endpoint**（request / response / 錯誤形狀變了）。
- 新增 / 改 **資料模型 / schema / migration**。
- 新增 / 改 **事件 / 訊息 / SSE / webhook** 的 payload。
- 改了**跨模組 / 跨前後端**的共用介面、序列化格式、共用型別。

純內部重構（不動對外形狀）、純樣式微調 → 免寫，機制圖夠了。

## 1. API 契約

每個 endpoint 一筆：

- **方法 + 路徑**：`POST /api/v1/<...>`。
- **request**：path / query / body 參數，各自型別、必填與否、約束（範圍 / 格式 / enum）。
- **response（成功）**：狀態碼 + body 形狀（欄位 + 型別）。
- **response（失敗）**：錯誤信封形狀 + 各錯誤狀態碼對應什麼情境（驗證失敗 / 找不到 / 權限 / 衝突）。
- **auth / 權限**：誰能呼叫、要什麼權限。
- **idempotency / 版本 / 分頁**：重送會怎樣、有沒有版本欄、list 怎麼分頁排序。

## 2. 資料模型 / schema

- **entity / table**：欄位 + 型別 + 約束（unique / not-null / FK / check）+ 預設值。
- **index**：查詢熱路徑要的索引。
- **migration 方向**：怎麼上、**怎麼退**（可逆性）、既有資料怎麼 backfill。
- **不變式（invariant）**：這份資料永遠要成立的規則（例：某欄非負、兩欄互斥）。

## 3. 事件 / 訊息 schema

- **事件名 + 觸發時機**。
- **payload 形狀**（欄位 + 型別）+ 版本。
- **保證**：排序 / 去重（at-least-once？去重鍵？）/ 順序敏不敏感。
- **consumer**：誰訂閱、漏一個會怎樣。

## 4. 測試策略（對齊 `test-rubric.md`）

把上面每條契約對到「哪一層測、用什麼證明」：

- 每個 API 契約 → 至少一條 contract / integration test（真打 endpoint，驗成功 + 至少一個錯誤路徑）。
- 每個資料約束 → 一條 data-layer test（違反時如預期拒絕，見 `test-rubric.md` §4）。
- 每個事件保證 → 驗 payload 形狀 + 去重 / 排序行為。
- 寫明**哪些契約用哪層**（unit / integration / smoke / e2e），別混層。

## 紀律

- **契約是 build 的輸入、verify 的驗收基準**：build 照契約實作、test-author 照契約寫 failing test、product-contract-reviewer 逐條對契約驗收。
- **契約變更要回寫**（living）：實作期若契約改了，回來更新本段並同步已 post 的對齊 comment —— 不讓 code 與契約各走各的。
- **外部承諾不可單方面破壞**：改既有契約要標「破壞性與否」、誰會受影響（對齊 `migration-reviewer` / 向後相容）。
- **Hyrum's Law —— 什麼算破壞性**：介面一旦有 consumer，**所有可觀察行為**（錯誤訊息 / 排序 / 時序 / 未文件化的 quirk）都變成 de-facto 契約。判破壞性看的是「**可觀察行為有沒有變**」，不是「文件有沒有寫」。預設走**加法演進**（加新的 optional 欄，**絕不**改既有欄型別 / 刪欄 / 改錯誤語意）；非破壞不可就標明、對齊 migration-reviewer 的相容檢查。
