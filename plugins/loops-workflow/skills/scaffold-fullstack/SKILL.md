---
name: scaffold-fullstack
user-invocable: false
description: >-
  Scaffold a brand-new, front/back-separated full-stack TypeScript project skeleton with a clean
  layered architecture: a pnpm workspace with a separate Fastify backend package
  (domain ← ports ← adapters/services/repositories/http) and a React 19 + TanStack SPA frontend
  package, an HTTP-only front/back wall enforced by the workspace package boundary, ESLint-enforced
  backend layering, SQLite + Kysely persistence, and Vitest (unit/e2e/benchmark). Use this whenever
  the user wants to start, bootstrap, generate, or scaffold a NEW full-stack TypeScript app with
  enforced clean-architecture layering and a strict frontend/backend separation — whether they
  describe the shape (Fastify backend + React SPA + ports/adapters + Kysely + Vitest) or ask for a
  "layered Fastify + React starter". Do NOT use it for working inside an existing project (adding a
  route, entity, migration, or feature; fixing a layering/lint error), or for scaffolding a different
  stack (e.g. FastAPI, Next.js, or a frontend-only SPA) — it creates a new project from a template,
  it does not edit existing code. The template seeds an AGENTS.md + docs/ Definition-of-Done skeleton
  for the new project to carry on as it grows.
---

# Scaffold Layered Full-stack

產生一個前後端分離、分層架構的全端 TypeScript 新專案:一個 pnpm workspace,內含切分成
clean-architecture 各層的 Fastify 後端 package、採 MVVM 分層的 React + TanStack SPA 前端 package,
以及兩者之間只透過 HTTP 溝通的硬牆 —— 後端分層與前端 MVVM 層界皆由 ESLint 強制執行,前後端牆由
workspace 的 package 邊界保證,讓結構不會悄悄腐化。

## 你會得到什麼

一個開箱即可運行的專案(可直接 install、typecheck、lint、test、serve),內含一條貫穿所有分層的
**垂直切片** —— 一個 `Note` 實體被串過每一層,作為日後新增功能時的範本。後端是 clean architecture
(domain ← ports ← adapters/services/repositories/http),前端對稱地採 **MVVM**(model ← viewmodels
← View),兩邊的層界都由各自的 ESLint config 強制執行:違反依賴方向時 `pnpm lint` 直接失敗。

```
<project>/
├── package.json            # workspace 根:packageManager、engines + pnpm -r 便利 scripts
├── pnpm-workspace.yaml      # packages: [backend, frontend];為原生依賴(better-sqlite3)設 allowBuilds
├── AGENTS.md                # ★ 給人與 AI agent 的工作指南 + 文件慣例
├── docs/                    # ★ 設計方向文件(邊建邊寫):README 索引 + architecture + testing
├── backend/                 # Fastify 後端 package(@<project>/backend)
│   ├── package.json         # 後端 deps(fastify、better-sqlite3、kysely、typebox、pino…)
│   ├── tsconfig.json        # server(Node)編譯設定;include src/scripts/e2e/benchmark
│   ├── eslint.config.mjs    # ★ 強制執行後端分層的 import 規則
│   ├── vitest.config.ts     # server 單元測試(node)
│   ├── vitest.e2e.config.ts / vitest.benchmark.config.ts
│   ├── dev.json.example     # client_dir 預設指向 ../frontend/dist
│   ├── sql/migrations/      # SQL 是 schema 的單一真實來源
│   ├── scripts/             # 以 tsx 執行的開發工具(db migrate / codegen)
│   ├── e2e/  benchmark/      # 透過 app.inject() 啟動真正的 server
│   └── src/
│       ├── bin/server.ts    # composition root + CLI 入口(`serve`)
│       ├── domain/          # 純邏輯,零 I/O
│       ├── ports/           # 介面(依賴反轉的接縫)
│       ├── adapters/        # 具體 I/O:db(sqlite+kysely)、logging(pino)
│       ├── repositories/    # 透過 MetadataStore port 存取資料
│       ├── services/        # 業務邏輯,編排 repositories
│       └── http/            # Fastify adapter:create-server、routes、schemas(TypeBox)
└── frontend/                # React 19 SPA package(@<project>/frontend)
    ├── package.json         # 前端 deps(react、tanstack router/query、tailwind…)
    ├── tsconfig.json        # client(DOM + JSX)設定;@/* → src/*
    ├── eslint.config.mjs    # ★ React 規則 + 強制執行 MVVM 層界的 import 規則(前後端牆由 package 邊界保證)
    ├── vite.config.ts       # TanStack Router plugin + react + tailwind v4;build → dist;/api proxy
    ├── vitest.config.ts     # client 單元測試(jsdom)
    ├── index.html
    └── src/                 # MVVM:model ← viewmodels ← View(routes + components)
        ├── model/           # 最內層:api(http + 端點)、型別、純前端邏輯。不可 import 外層
        ├── viewmodels/      # 每畫面一個 hook:持狀態 + 編排 React Query,回 { data, status, actions }
        ├── routes/          # View:檔案式路由,薄;吃 viewmodel 渲染
        ├── components/      # View:純呈現元件(吃 props / 回呼)
        └── lib/             # 跨層無狀態工具(cn…)
```

## 如何 scaffold

1. **確認目標。** 若使用者沒給,先問清楚目錄與專案名稱。package 名稱預設取目標資料夾的 basename。

2. **執行 scaffold 腳本。** 它會複製打包好的模板、重新命名 dotfile(`dot-gitignore` → `.gitignore`),
   並替換專案名稱:

   ```bash
   node "<skill-dir>/scripts/scaffold.mjs" <target-dir> [project-name]
   ```

   把 `<skill-dir>` 解析為本技能自身的目錄。在 Windows 上 Bash 工具與 `node` 都可用;這支腳本是
   純 Node ESM,沒有任何依賴。

3. **安裝依賴。** 在新專案目錄下:

   ```bash
   pnpm install
   ```

   若 `pnpm` 不在 PATH 上但有 Node,改用 `corepack pnpm install`(corepack 隨 Node 附帶,會依
   `packageManager` 欄位選版本)。`pnpm install` 在 workspace 根執行一次,就會把 backend 與 frontend
   兩個 package 的依賴一起裝好。`better-sqlite3` 是原生依賴 —— 它附帶預編譯的 binary,而
   `pnpm-workspace.yaml` 的 `allowBuilds` 已預先核可它的 build script。

4. **驗證可運行**(務必執行 —— 不要只是宣稱成功):

   ```bash
   pnpm -r typecheck && pnpm -r lint && pnpm -r test
   ```

   輸出收斂依 `references/context-diet.md` §A（測試輸出紅綠不對稱＋截斷落盤）。

   (`-r` 會對 backend 與 frontend 兩個 package 各跑一次;根 `package.json` 也提供了
   `pnpm typecheck` / `pnpm lint` / `pnpm test` 作為等價捷徑。)

5. **告訴使用者如何啟動。** 開發時開兩個終端:
   - 在 `backend/`:`cp dev.json.example dev.json` 後 `pnpm dev` —— 在 port 51599 啟動 Fastify API。
   - `pnpm --filter frontend dev` —— 在 5173 啟動 Vite,並把 `/api` proxy 到 server。

   若要單一程序的 production 模式:`pnpm -r build`,frontend 會建到 `frontend/dist`;backend 的
   `dev.json` 之 `client_dir` 預設已指向 `../frontend/dist`,所以 `cd backend && pnpm dev` 就會由
   Fastify 一併提供 SPA 與 API。

## 架構說明(讓你能正確地擴充)

這套技術棧的重點在於結構是**被強制執行的,而非僅供參考**。新增功能前請先讀本 skill 目錄下的
`skills/scaffold-fullstack/references/architecture.md` —— 它說明了每一層、import 規則,以及照著 `Note` 切片新增實體的精確
步驟。簡短版:

- **依賴向內流動。** `domain` 是核心,不 import 其他層的任何東西。`ports` 定義介面;`services`、
  `repositories`、`http` 依賴 `ports`,絕不直接依賴 `adapters`(唯一允許的例外是自動產生的
  `db/types.generated.ts`)。`adapters` 是唯一接觸具體基礎設施(better-sqlite3、fs、path、pino)
  的地方。這套後端分層由 `backend/eslint.config.mjs` 強制執行。
- **前端對稱地分層(MVVM)。** `model`(api / 型別 / 純邏輯)是最內層,不可向外伸手;`viewmodels`
  (每畫面一個 hook,持狀態 + 編排 React Query)可 import `model` 但不認得 JSX;**View**(`routes`
  + `components`)純呈現,吃 viewmodel 渲染、**不直接 import `model/`(含 api)** —— 一律經 viewmodel。
  這套前端 MVVM 層界由 `frontend/eslint.config.mjs` 的 `no-restricted-imports` 強制執行(同時擋
  `@/model` 別名與相對 `../model` 兩種寫法)。
- **前後端牆是絕對的。** `backend/` 與 `frontend/` 是兩個獨立 package,**不在彼此的相對路徑內** ——
  根本沒有跨界 import 的途徑,只能透過 HTTP 溝通。這道牆由 workspace 的 package 邊界保證(不再需要
  ESLint 的 `no-restricted-paths` 去擋),這正是讓 SPA 與 server 能各自獨立部署的關鍵(也讓 server
  能 standalone、在 Docker 裡、或在 Electron 下運行)。
- **SQL migration 是真實來源。** 編輯 `backend/sql/migrations/`,執行
  `pnpm --filter backend db:migrate:dev`,再 `pnpm --filter backend db:codegen` 重新產生
  `backend/src/adapters/db/types.generated.ts`。Kysely 會依這份產生的 schema 提供型別安全的查詢。

當使用者要求新增功能(例如「加一個 tags 實體」),不要發明新結構 —— 照著 `Note` 的檔案在各層
依樣畫葫蘆,讓 ESLint 抓出任何跨層錯誤。前端同樣照 MVVM 三層補:`frontend/src/model/`(在 `api/`
加端點 + `types.ts` 加 DTO,更新 barrel)→ `frontend/src/viewmodels/`(加 `useTags` hook 編排 query/
mutation)→ View(`frontend/src/routes/` 薄頁吃 viewmodel + `frontend/src/components/` 加純呈現元件)。
View 不直接 import `model/`,一律經 viewmodel —— `pnpm lint` 會替你把關。

## 文件慣例:邊建邊留設計方向(請傳承給使用者,也請自己遵守)

模板內建了 `AGENTS.md` 與 `docs/`,它們承載這個專案最重要的工作慣例 —— 也是讓新人與 AI agent 能
快速接手的關鍵:

> **每當你建立或改變一個「環境、功能、或概念」,就在 `docs/` 留下一份說明「設計方向」的文件 ——
> 記錄「為什麼這樣設計、有哪些取捨與邊界」,而不只是「怎麼用」。**

- 分工:`docs/` 講「why + 高層 how」;程式碼註解講「這一行在做什麼」;`AGENTS.md` 講「動手前的規則」。
- 為什麼:ESLint 鎖住*程式碼*分層不腐化,`docs/` 與 `AGENTS.md` 則鎖住*設計意圖*不流失。
- 模板已先示範:`docs/architecture.md`(架構導覽)、`docs/testing.md`(測試設計方向)、`docs/README.md`(索引)。

**因此,當你(或使用者)在這個 scaffold 出來的專案裡新增一個環境/功能/概念時,除了寫程式碼,還要:**
1. 在 `docs/<topic>.md` 留下設計方向(為什麼、取捨、邊界、失敗模式);
2. 在 `docs/README.md` 索引加一行;
3. 若改變了動手規則或結構,更新 `AGENTS.md`。

這不是額外的負擔,而是這套基礎建設的一部分 —— 就像 typecheck/lint/test 屬於「完工定義」,留下設計方向
文件同樣屬於「完工定義」(見模板 `AGENTS.md` 的 Definition of Done)。

> **scaffold 後的文件分工**:本 skill 鋪好 `docs/` + `AGENTS.md` 的 Definition-of-Done 骨架;之後每個
> feature 往裡面補的 `docs/<topic>.md` 是**教學手冊**(只教學、怎麼用),而「為什麼這樣設計、取捨、邊界」
> 這類**決策紀錄**改放 PR body / 設計文件,不混進手冊。

## 範圍:刻意保持精簡

這是一個**精簡的架構骨架**,不是功能完整的應用。為了讓新專案保持輕量、好上手,刻意不含:
authentication、原生模組 / node-gyp addon、即時推送(SSE / WebSocket)、以及龐大的依賴面。**真正
被鋪好的是骨幹** —— 分層結構、build pipeline(`tsc` server + `vite` client + `tsx` scripts)、測試
設定(unit / e2e / benchmark)、以及 ESLint 強制的分層與前後端牆。任何重量級功能(auth、原生 addon、
背景任務、即時推送…)日後都是在這個穩固基底上的**加法**,不需要動到骨架。
