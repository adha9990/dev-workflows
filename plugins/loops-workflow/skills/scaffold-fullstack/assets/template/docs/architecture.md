# 架構與設計方向

這份文件給新人一個系統全景,並解釋**為什麼**這樣設計。動程式碼前先讀這裡。

## 全景:一個 package、兩半、一道牆

```
src/      Fastify 後端(Node runtime)
client/   React SPA(瀏覽器)
```

兩半住在同一個整合包裡,但**永遠不互相 import** —— 只透過 HTTP 溝通。ESLint 的
`import/no-restricted-paths` 會在任一側越界時讓 build 失敗。

**為什麼這樣設計**:這道牆讓後端能獨立部署(standalone、Docker、或嵌入 Electron host),而前端維持
為純 client。一旦允許 client 直接讀資料庫、或後端 import 前端的型別,這個彈性就會永久消失。

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

**為什麼用 ports + adapters**:內層依賴*介面*而非實作。要把 SQLite 換成 Postgres,只要寫一個新
adapter,repositories 與 services 完全不動;測試時注入假的 store。唯一知道真實接線的地方是
`src/bin/server.ts`。

## schema 是真實來源

`sql/migrations/` 是 schema 的唯一真實來源,且**只增不改**(修正用新的 migration 檔)。
改完跑 `pnpm db:migrate:dev`,再 `pnpm db:codegen` 從資料庫反推產生
`src/adapters/db/types.generated.ts`,讓 Kysely 查詢保持型別安全。

**為什麼**:確保 dev / CI / production 的 schema 完全一致;型別一旦與 schema 失同步,TypeScript
會立刻報錯,而不是等到 runtime。

## 跟著 `Note` 垂直切片學

專案內含一條貫穿所有層的範例:`Note` 實體。新增功能時照著它在各層複製,讓 ESLint 替你把關:

`sql/migrations/` → `domain/note/` → `repositories/note-repo.ts` → `services/note/` →
`http/schemas/note.ts` + `http/routes/notes.ts` → 在 `bin/server.ts` 接線 → `client/src/api/notes.ts` + route。

## 延伸閱讀

- 測試的設計方向:[`testing.md`](./testing.md)
- 動手前的規則與完工定義:根目錄 `AGENTS.md`
