# 架構與設計方向

這份文件給新人一個系統全景,並解釋**為什麼**這樣設計。動程式碼前先讀這裡。

## 全景:一個 workspace、兩個 package、一道牆

```
backend/    Fastify 後端(Node runtime)
frontend/   React SPA(瀏覽器)
```

兩個 package 住在同一個 pnpm workspace 裡,但**永遠不互相 import** —— 只透過 HTTP 溝通。

**為什麼這樣設計**:這道牆讓後端能獨立部署(standalone、Docker、或嵌入 Electron host),而前端維持
為純 client。一旦允許 client 直接讀資料庫、或後端 import 前端的型別,這個彈性就會永久消失。把兩半拆成
獨立 package 後,這道牆由 **workspace 的 package 邊界** 保證 —— `backend/` 與 `frontend/` 不在彼此的
相對路徑內,根本沒有跨界 import 的途徑,不需要靠 ESLint 規則去擋。

## 後端分層:依賴向內流動

箭頭 `A → B` = 「A 可以 import B」。

```
http ─┐
services ─┤
repositories ─┼─→ ports ──→ domain
              │
adapters ─────┘ (實作 ports;唯一接觸基礎設施的地方)
```

| 層 | 職責 | 不該做 |
| --- | --- | --- |
| `domain/` | 純邏輯、不變式,零 I/O | import 任何外層 |
| `ports/` | 介面(依賴反轉的接縫) | 依賴下層(除了產生的 db types) |
| `adapters/` | 具體 I/O:SQLite+Kysely、pino | 業務邏輯 |
| `repositories/` | 透過 `MetadataStore` port 存取資料、row↔domain 轉換 | 跨 entity 流程、業務規則 |
| `services/` | 業務編排;持有不純的部分(clock、uuid) | 單一 entity 的 CRUD(那是 repo 的事) |
| `http/` | Fastify adapter:routes、TypeBox schema、錯誤外殼 | 業務決策 |
| `bin/` | composition root:讀設定、接線、啟動 | —— |

(路徑都相對於 `backend/`,例如 `backend/src/domain/`。)後端分層由 `backend/eslint.config.mjs` 的
`import/no-restricted-paths` 強制執行,任一層越界就讓 `pnpm lint` 失敗。

**為什麼用 ports + adapters**:內層依賴*介面*而非實作。要把 SQLite 換成 Postgres,只要寫一個新
adapter,repositories 與 services 完全不動;測試時注入假的 store。唯一知道真實接線的地方是
`backend/src/bin/server.ts`。

## 前端分層:MVVM(與後端對稱)

前端同樣分層,依賴向內流動。箭頭 `A → B` = 「A 可以 import B」。

```
View(routes + components) ──→ viewmodels ──→ model
```

| 層 | 職責 | 不該做 |
| --- | --- | --- |
| `frontend/src/model/` | 最內層:`api/`(`http.ts` + 端點)、`types.ts`(DTO)、純前端邏輯 | import 任何外層(viewmodels / routes / components) |
| `frontend/src/viewmodels/` | 每畫面一個 hook:持狀態 + 編排 TanStack Query,回 `{ data, status, actions }` | import 任何 JSX(routes / components) |
| `frontend/src/routes/` | View:檔案式路由,薄;吃 viewmodel 渲染 | 直接 import `model/`(含 api) |
| `frontend/src/components/` | View:純呈現元件,只吃 props / 回呼 | 直接 import `model/`(含 api) |
| `frontend/src/lib/` | 跨層無狀態工具(`cn`…) | —— |

這套 MVVM 層界由 `frontend/eslint.config.mjs` 的 `no-restricted-imports` 強制執行(同時擋 `@/model`
別名與相對 `../model`),任一 view 直接 import `model/` 就讓 `pnpm lint` 失敗。

**為什麼**:View 只認得 viewmodel 暴露的 `{ data, status, actions }`,碰不到 fetch / DTO 細節 ——
換資料來源或調呈現邏輯只動 viewmodel。這與後端 ports/adapters 是同一種精神:把不穩定的細節關在內層。

## schema 是真實來源

`backend/sql/migrations/` 是 schema 的唯一真實來源,且**只增不改**(修正用新的 migration 檔)。
改完跑 `pnpm --filter backend db:migrate:dev`,再 `pnpm --filter backend db:codegen` 從資料庫反推產生
`backend/src/adapters/db/types.generated.ts`,讓 Kysely 查詢保持型別安全。

**為什麼**:確保 dev / CI / production 的 schema 完全一致;型別一旦與 schema 失同步,TypeScript
會立刻報錯,而不是等到 runtime。

## 跟著 `Note` 垂直切片學

專案內含一條貫穿所有層的範例:`Note` 實體。新增功能時照著它在各層複製,讓 ESLint 替你把關:

`backend/sql/migrations/` → `backend/src/domain/note/` → `backend/src/repositories/note-repo.ts` →
`backend/src/services/note/` → `backend/src/http/schemas/note.ts` + `backend/src/http/routes/notes.ts` →
在 `backend/src/bin/server.ts` 接線 → 前端 MVVM 三層:`frontend/src/model/api/notes.ts` + `model/types.ts`
→ `frontend/src/viewmodels/useNotes.ts` → View(`frontend/src/routes/index.tsx` + `frontend/src/components/`)。

## 延伸閱讀

- 測試的設計方向:[`testing.md`](./testing.md)
- 動手前的規則與完工定義:根目錄 `AGENTS.md`
