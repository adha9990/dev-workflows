# __PROJECT_NAME__

一個前後端分離、分層架構的全端 TypeScript 應用:單一整合包,內含 Fastify 後端與
React 19 + TanStack SPA 前端,後端嚴格分層,兩半之間只透過 HTTP 溝通 —— 全部由 ESLint 強制執行。
(架構參考自 `eagle-app-core`。)

## 先決條件

- Node `>=20.19`
- pnpm(`corepack enable` 會隨 Node 提供它,並遵循鎖定的 `packageManager`)

## 開始

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # 全部應該是綠的
```

### 啟動(兩個終端)

```bash
cp dev.json.example dev.json
pnpm dev          # Fastify API 在 http://127.0.0.1:51599
pnpm dev:client   # Vite SPA 在 http://localhost:5173(把 /api proxy 到 server)
```

### 單一程序 / production 模式

```bash
pnpm build                     # tsc server → dist/server,vite client → dist/client
# 在 dev.json 設定 "client_dir": "./dist/client",然後:
pnpm dev                       # server 在同一個 port 同時提供 SPA 與 API
```

## 目錄結構

| 路徑 | 角色 |
| --- | --- |
| `src/domain/` | 純業務邏輯,零 I/O(核心) |
| `src/ports/` | 介面 —— 依賴反轉的接縫 |
| `src/adapters/` | 具體 I/O:SQLite+Kysely、pino logging |
| `src/repositories/` | 透過 `MetadataStore` port 存取資料 |
| `src/services/` | 業務編排 |
| `src/http/` | Fastify adapter:server、routes、TypeBox schemas |
| `src/bin/server.ts` | composition root + CLI 入口 |
| `client/` | React SPA(TanStack Router/Query、Zustand、Tailwind v4) |
| `sql/migrations/` | schema 的真實來源 |

## 架構規則(由 `pnpm lint` 強制執行)

- 依賴向內流動:`domain ← ports ← {services, repositories, http}`;只有 `adapters` 與
  composition root 接觸基礎設施(better-sqlite3、fs、path、pino)。
- `src/` 與 `client/` 永不互相 import —— 它們只透過 HTTP 溝通。

完整的理由,以及照著 `Note` 切片新增實體的食譜,請見技能的 `references/architecture.md`。

## 資料庫流程

```bash
pnpm db:migrate:dev    # 對 ./data/app.db 套用 sql/migrations/
pnpm db:codegen        # 從 schema 重新產生 src/adapters/db/types.generated.ts
```
