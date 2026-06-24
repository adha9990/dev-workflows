# 測試的設計方向

這份文件說明本專案的測試**為什麼**這樣分,以及各層該測什麼 —— 是「邊建邊留設計方向文件」的範例。

## 三套測試,三個目的

| 套件 | 指令 | 設定檔 | 環境 | 測什麼 |
| --- | --- | --- | --- | --- |
| 單元 | `pnpm test` | `vitest.config.ts` | server: node / client: jsdom | 純函數與單一單元(domain 邏輯、`cn` 之類的工具) |
| e2e | `pnpm test:e2e` | `vitest.e2e.config.ts` | node(序列執行) | 啟動真正的 Fastify app,用 `app.inject()` 打整條垂直切片 |
| benchmark | `pnpm test:benchmark` | `vitest.benchmark.config.ts` | node(序列執行) | 對效能敏感的熱路徑 |

**為什麼分三套**:三者的時間預算與隔離需求不同。單元測試要快且高度平行;e2e 共用 process 層級狀態
(真資料庫、真路由),必須序列執行;benchmark 的計時不能被並行的 CPU 壓力干擾。混在一起會互相拖累。

## 用真的 SQLite,不要 mock

e2e 測試開一個 `tmpdir` 裡的真 SQLite 檔(見 `e2e/notes.e2e.test.ts`),跑真的 migration、真的 Kysely
查詢,而不是 mock 掉資料庫。

**為什麼**:mock 掉的資料庫只會驗證「你以為 SQL 怎麼跑」,真資料庫才會驗證 constraint、index、型別轉換
與實際 SQL 行為。測試的價值在於「過了就代表 production 也會過」—— mocking 容易把真 bug 藏起來。

## 各層各測各的

- **domain**:純函數,直接斷言輸入/輸出與不變式(例:`createNote` 拒絕空標題)。最快、最該密集覆蓋。
- **repositories / services**:可用真 store 做整合測試(開 tmpdir SQLite、注入 real store)。
- **http**:透過 e2e 的 `app.inject()` 驗證狀態碼、回應格式、schema 驗證(例:空標題回 400)。
- **client**:在 jsdom 下測元件與工具函數。

## teardown 的眉角(Windows)

關閉資料庫連線**要在刪檔之前**(見 e2e 的 `afterAll`:先 `store.close()` 再 `rmSync`)。在 Windows 上
未釋放的檔案 handle 會讓刪除以 `EPERM` 失敗 —— 這類跨平台陷阱值得在測試裡示範正確做法。

## 原則

**測試永遠不要遮蓋業務邏輯。** 如果測試過了但 production 爆了,那是測試寫錯了,要修測試的設計,
而不是把斷言放寬。
