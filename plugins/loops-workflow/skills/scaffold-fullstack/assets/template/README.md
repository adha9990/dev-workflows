# __PROJECT_NAME__

一個前後端分離、分層架構的全端 TypeScript 應用:一個 pnpm workspace,內含 Fastify 後端
(`backend/`)與 React 19 + TanStack SPA 前端(`frontend/`),後端嚴格分層,兩半各自是獨立
package、只透過 HTTP 溝通 —— 後端分層由 ESLint 強制執行,前後端牆由 package 邊界保證。

## 先決條件

- Node `>=20.19`
- pnpm(`corepack enable` 會隨 Node 提供它,並遵循鎖定的 `packageManager`)

## 開始

```bash
pnpm install
pnpm -r typecheck && pnpm -r lint && pnpm -r test   # 全部應該是綠的
```

### 啟動(兩個終端)

```bash
cd backend && cp dev.json.example dev.json && pnpm dev   # Fastify API 在 http://127.0.0.1:51599
pnpm --filter frontend dev                               # Vite SPA 在 http://localhost:5173(把 /api proxy 到 server)
```

### 單一程序 / production 模式

```bash
pnpm -r build                  # backend: tsc → dist/server,frontend: vite → frontend/dist
# backend/dev.json 的 "client_dir" 預設已指向 "../frontend/dist",所以:
cd backend && pnpm dev         # server 在同一個 port 同時提供 SPA 與 API
```

## 目錄結構

| 路徑 | 角色 |
| --- | --- |
| `backend/` | Fastify 後端 package(`@__PROJECT_NAME__/backend`) |
| `backend/src/domain/` | 純業務邏輯,零 I/O(核心) |
| `backend/src/ports/` | 介面 —— 依賴反轉的接縫 |
| `backend/src/adapters/` | 具體 I/O:SQLite+Kysely、pino logging |
| `backend/src/repositories/` | 透過 `MetadataStore` port 存取資料 |
| `backend/src/services/` | 業務編排 |
| `backend/src/http/` | Fastify adapter:server、routes、TypeBox schemas |
| `backend/src/bin/server.ts` | composition root + CLI 入口 |
| `backend/sql/migrations/` | schema 的真實來源 |
| `frontend/` | React SPA package(`@__PROJECT_NAME__/frontend`;TanStack Router/Query、Zustand、Tailwind v4) |

## 架構規則

- 依賴向內流動(由 `backend` 的 `pnpm lint` 強制):`domain ← ports ← {services, repositories, http}`;
  只有 `adapters` 與 composition root 接觸基礎設施(better-sqlite3、fs、path、pino)。
- `backend/` 與 `frontend/` 是兩個獨立 package,**不在彼此的相對路徑內**,只透過 HTTP 溝通 ——
  這道前後端牆由 workspace 的 package 邊界保證。

完整的理由,以及照著 `Note` 切片新增實體的食譜,請見技能的 `references/architecture.md`。

## 資料庫流程

```bash
pnpm --filter backend db:migrate:dev    # 對 backend/data/app.db 套用 sql/migrations/
pnpm --filter backend db:codegen        # 從 schema 重新產生 src/adapters/db/types.generated.ts
```
