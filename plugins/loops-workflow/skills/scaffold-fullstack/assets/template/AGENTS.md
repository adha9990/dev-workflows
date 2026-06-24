# AGENTS.md — __PROJECT_NAME__

本檔給「在這個 repo 工作的人與 AI agent」看 —— 目的是讓你在動手前就理解專案的**架構與設計方向**。
(若你用 Claude Code,可在 `CLAUDE.md` 只寫一行 `AGENTS.md` 指向本檔,讓人與 agent 讀同一份來源。)

## 這是什麼專案

- 前後端分離的全端 TypeScript 應用:Fastify 後端(`src/`)+ React SPA(`client/`),兩者**只透過 HTTP 溝通**。
- 後端採 clean-architecture 分層,結構由 ESLint 強制執行,不會隨成長而腐化。

## 最重要的慣例:邊建邊留「設計方向」文件

這是本專案的核心工作習慣,也是讓新人能快速接手的關鍵:

> **每當你建立或改變一個「環境、功能、或概念」,就在 `docs/` 留下一份說明「設計方向」的文件 ——
> 記錄「為什麼這樣設計、有哪些取捨與邊界」,而不只是「怎麼用」。**

- 例:設定好測試環境 → 寫 `docs/testing.md`(為什麼用真 SQLite 而非 mock、各層各測什麼)。
- 例:設計了一條匯入流程 → 寫 `docs/import.md`(流程、邊界、取捨、失敗模式)。
- 分工:**`docs/` 講「why + 高層 how」;程式碼註解講「這一行在做什麼」。**
- 寫完記得在 `docs/README.md` 的索引加一行。

為什麼要這樣:ESLint 鎖住*程式碼*分層不腐化;`docs/` 與本檔鎖住*設計意圖*不流失。程式碼會告訴你
「怎麼做」,但只有文件能告訴你「當初為什麼這樣決定」—— 這正是新人與 AI agent 最快卡住的地方。

新人 / agent 動手前的閱讀順序:
`docs/README.md` → `docs/architecture.md` → 你要動的領域對應的 `docs/<topic>.md` → 程式碼。

## 目錄結構

```
src/        Fastify 後端(分層:domain / ports / adapters / repositories / services / http;bin 為 composition root)
client/     React SPA(routes / api / stores / lib / components)
sql/        schema 的單一真實來源(migrations)
docs/       設計方向文件 —— 邊建邊寫(見上)
AGENTS.md   本檔:給人與 agent 的工作指南
```

## 動手前的規則

- **遵守分層依賴方向**(ESLint `no-restricted-paths` 會擋):`domain ← ports ← {services, repositories, http}`;
  只有 `adapters` 與 `src/bin`(composition root)可以碰基礎設施(better-sqlite3、fs、path、pino)。
- **`src/` 與 `client/` 不可互相 import**,只透過 HTTP 溝通。
- **schema 的真實來源是 `sql/migrations/`**:改 schema → `pnpm db:migrate:dev` → `pnpm db:codegen` 重新產生型別。
- 依賴用工廠函數**注入**,不要在內層直接 `new` 基礎設施。
- 新增功能時照著既有的 `Note` 垂直切片在各層依樣畫葫蘆,讓 ESLint 抓出跨層錯誤。

## 常用指令

| 指令 | 作用 |
| --- | --- |
| `pnpm dev` / `pnpm dev:client` | 啟動後端 API / 前端 Vite dev server |
| `pnpm typecheck` | 型別檢查 server 與 client |
| `pnpm lint` | ESLint(含分層 + 前後端牆強制) |
| `pnpm test` / `test:e2e` / `test:benchmark` | 單元 / e2e / benchmark 測試 |
| `pnpm db:migrate:dev` / `db:codegen` | 套用 migration / 重新產生 Kysely 型別 |

## 完工定義(Definition of Done)

- **程式碼**:`pnpm typecheck && pnpm lint && pnpm test` 全綠。
- **文件**:若你建立或改變了一個環境/功能/概念,`docs/` 有對應的設計方向文件且已更新,`docs/README.md` 索引同步。
- **回報**:說明改了哪些檔、行為有何變化、有哪些風險。
