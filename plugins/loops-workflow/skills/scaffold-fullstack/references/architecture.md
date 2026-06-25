# 分層全端架構參考(layered full-stack)

擴充 scaffold 出來的專案前請先讀這份文件。它說明每一層存在的理由,並給出在不破壞被強制執行的
結構下新增功能的精確步驟。

## 整體形狀

一個 pnpm workspace 裡有兩個 package,被一道硬牆隔開:

```
backend/    Fastify 後端(Node runtime)— package @<project>/backend
frontend/   React SPA(瀏覽器)        — package @<project>/frontend
```

兩者**永遠不互相 import**。所有溝通都走 HTTP。這道牆由 **workspace 的 package 邊界** 保證 ——
`backend/` 與 `frontend/` 不在彼此的相對路徑內,根本沒有跨界 import 的途徑(不再需要 ESLint 的
`no-restricted-paths` 去擋 server↔client)。這正是讓 server 能 standalone、在容器裡、或嵌入 Electron
host 運行,同時讓 SPA 維持為純 client 的關鍵。

以下談「後端分層」時,路徑都相對於 `backend/`(例如 `src/domain/` 指 `backend/src/domain/`);
「前端結構」的路徑都相對於 `frontend/`。後端分層仍由 `backend/eslint.config.mjs` 的
`import/no-restricted-paths` 強制執行。

## 後端分層

依賴向內流動。箭頭 `A → B` 代表「A 可以 import B」。

```
http ─┐
services ─┤
repositories ─┼─→ ports ──→ domain
              │
adapters ─────┘ (實作 ports;唯一接觸基礎設施的地方)
```

| 層 | 可 import | 不可 import | 用途 |
| --- | --- | --- | --- |
| `domain/` | (不 import 任何內部層) | 其他所有層 | 純邏輯 + 不變式,零 I/O。可獨立測試。 |
| `ports/` | `domain`、產生的 db types | `adapters`*、`services`、`repositories`、`http` | 反轉依賴的介面。 |
| `adapters/` | `domain`、`ports` | `services`、`repositories`、`http` | 具體 I/O:SQLite+Kysely、pino。唯一允許用 `better-sqlite3`/`fs`/`path` 的地方。 |
| `repositories/` | `domain`、`ports` | `adapters`*、`services`、`http` | 透過 `MetadataStore` port 存取資料。負責 row ↔ domain 的轉換。 |
| `services/` | `domain`、`ports`、`repositories` | `adapters`*、`http` | 業務編排;持有不純的部分(clock、uuid)。 |
| `http/` | 以下所有層 | (frontend 自然不可達) | Fastify adapter:routes、TypeBox schemas、錯誤外殼。 |
| `bin/` | 全部 | (frontend 自然不可達) | composition root:讀設定、把 adapters 接到 services、啟動 server。 |

\* 唯一允許的例外是 `src/adapters/db/types.generated.ts` —— 它只含 Kysely 的型別宣告(無 runtime),
所以 import 它不會破壞接縫。

### 為什麼要 ports + adapters?

內層依賴的是*介面*(`MetadataStore`、`Logger`),而非具體實作。要把 SQLite 換成 Postgres,只要寫
一個新的 adapter —— repositories 與 services 都不用改。測試時則注入一個假的 store。composition root
(`backend/src/bin/server.ts`)是唯一知道真實接線方式的地方。

## 前端分層(MVVM)

前端與後端對稱:結構是**被強制執行的,而非僅供參考**。三層,依賴向內流動(箭頭 `A → B` =
「A 可以 import B」):

```
View(routes + components) ──→ viewmodels ──→ model
```

(路徑相對於 `frontend/`。)

| 層 / 路徑 | 可 import | 不可 import | 角色 |
| --- | --- | --- | --- |
| `src/model/` | (不 import 任何外層) | `viewmodels`、`routes`、`components` | 最內層:`api/`(`http.ts` + 各資源 fetcher,唯一知道 server 契約的地方)、`types.ts`(DTO)、純前端邏輯。 |
| `src/viewmodels/` | `model`、`lib` | 任何 JSX:`routes`、`components` | 每畫面一個自訂 hook:持狀態 + 呈現邏輯 + 編排 TanStack Query,對外回 `{ data, status, actions }`。 |
| `src/routes/` | `viewmodels`、`components`、`lib` | `model`(含 api) | View:檔案式路由(TanStack Router 產生 `routeTree.gen.ts`),薄;吃 viewmodel hook 渲染、接事件。 |
| `src/components/` | `viewmodels`、`components`、`lib` | `model`(含 api) | View:純呈現元件,只吃 props / 回呼。 |
| `src/lib/` | (跨層工具) | —— | 與框架無關的無狀態工具(例如 `cn`)。任何層都可 import。 |

這套 MVVM 層界由 `frontend/eslint.config.mjs` 的 `no-restricted-imports` 強制執行 —— patterns 同時擋
`@/model` 別名與相對 `../model` 兩種寫法,測試檔豁免。zone 清單集中在 config 頂部常數,改 layer 命名
或新增層時只動常數。**驗證方式:在某個 view(routes/components)故意加一條 `import … from '@/model'`,
跑 `pnpm --filter frontend lint`,確認它會報錯** —— 別只相信「lint 通過」就以為層被鎖住了。

**為什麼**:View 只認得 viewmodel 暴露的 `{ data, status, actions }`,碰不到 fetch / DTO 細節;
要換資料來源或調整呈現邏輯只動 viewmodel,View 不動。這與後端 ports/adapters 是同一種精神 ——
把「不穩定的細節」關在內層,外層只依賴穩定的契約。

## 食譜:新增一個實體(例如 `tag`)

照著 `Note` 切片在各層依樣畫葫蘆。讓 ESLint 抓出錯誤。(步驟 1–7 在 `backend/`,步驟 8 在 `frontend/`。)

1. **Migration** —— 新增 `backend/sql/migrations/00N_tags.sql`(`CREATE TABLE IF NOT EXISTS tag ...`)。
2. **重新產生型別** —— `pnpm --filter backend db:migrate:dev && pnpm --filter backend db:codegen`(更新 `db/types.generated.ts`)。
3. **Domain** —— `backend/src/domain/tag/tag.ts`,含實體型別 + 強制不變式的 `createTag` 建構式。在 `__tests__/` 加單元測試。
4. **Repository** —— `backend/src/repositories/tag-repo.ts`:透過 `MetadataStore` 的 Kysely 查詢、row↔domain 轉換。
5. **Service** —— `backend/src/services/tag/tag-service.ts`:編排、產生 id/clock。
6. **HTTP** —— `backend/src/http/schemas/tag.ts`(TypeBox)+ `backend/src/http/routes/tags.ts`;在 `create-server.ts` 註冊它。
7. **接線** —— 在 `backend/src/bin/server.ts` 建立該 service,並透過 `ServerDeps` 傳入。
8. **前端(MVVM 三層)** —— 照 `Note` 切片在前端各層依樣畫葫蘆,讓 ESLint 抓出跨層錯誤:
   - **model** —— `frontend/src/model/api/tags.ts`(端點函式,用 `http.ts`)+ 在 `model/types.ts` 加 `Tag` DTO;更新 `model/api/index.ts` 與 `model/index.ts` 兩個 barrel。
   - **viewmodel** —— `frontend/src/viewmodels/useTags.ts`:自訂 hook,持列表 / 表單狀態 + 編排 `useQuery`/`useMutation`,回 `{ data, status, actions }`。可 import `@/model`,不可 import 任何 JSX。
   - **View** —— `frontend/src/routes/` 加薄頁(吃 `useTags` 渲染)+ `frontend/src/components/`(如 `TagList`/`TagForm`)放純呈現元件,經 `components/index.ts` 出口。View **不可直接 import `model/`** —— 一律經 viewmodel。
9. **驗證** —— `pnpm -r typecheck && pnpm -r lint && pnpm -r test`。

## 實戰補充:把這套架構用在「整合密集」的專案

當專案需要大量對外整合(連多個外部資料庫、呼叫外部 API、驅動外部工具)時,下列模式很實用,可直接沿用:

1. **Ports 不只用於持久化 —— 任何「會碰外部世界」的能力都值得一個 port。**
   除了 `MetadataStore` 這類儲存 port,凡是外部能力都可定義成 port:例如「重置外部資料庫」
   `DbResetter { reset(): Promise<void> }`、「對外部 API 跑一組測試」
   `CollectionRunner { run(cases, vars): Promise<CaseResult[]> }`。services 只認 port,完全不知道
   底層用的是 mysql2 還是 Newman。要換實作(換 DB 引擎、換測試執行器)只動 adapter,services/http 不變。

2. **Adapter 可以把多步驟的外部互動藏在單一 port method 後面。**
   例如 `CollectionRunner.run()` 內部其實做三件事:把 domain 的 cases 組成 Postman collection →
   用 Newman 執行 → 解析結果。對 service 而言只是「跑一組案例、拿回結果」。外部工具的格式
   (Postman/Newman)完全不外漏 —— 這是 port 接縫的價值。

3. **`lib/`:純工具層。** 無狀態、零 I/O 的小工具(雜湊、解析檔案)放 `src/lib/`,與 `domain`
   一樣保持純淨(ESLint 同樣禁止它 import ports/adapters/services/http)。

4. **小專案可把 `repositories/` 併入 `adapters/`。** 當資料存取夠單純時不必另立 repositories 層 ——
   直接「一個 `RunStore` port + 一個 `sqlite-run-store` adapter」即可。分層精神(介面與實作分離、
   方向受控)不變,只是少一個轉換層。實體多、需要 row↔domain 轉換時,再拆回獨立的 repositories 層。

5. **Composition root 可獨立成 `src/composition.ts`。** 除了在 `bin/server.ts` 接線,也可把
   「建 adapters → 注入 services」集中到一個 `composition.ts`,讓 `http/` 與 `bin/` 都向它要相依,
   藉此保持 `http/` 不直接 import `adapters/`(由 ESLint 強制)。

6. **⚠️ ESLint resolver 陷阱(務必確認分層規則「真的」生效)。**
   NodeNext 的 `.js` 副檔名 import,在預設 node resolver 下無法解析到 `.ts` 來源,會讓
   `import/no-restricted-paths` **靜默通過**(規則形同虛設)。必須加 `eslint-import-resolver-typescript`
   並在 flat config 設定 `settings: { 'import/resolver': { typescript: true } }`,zones 才會真的觸發。
   **驗證方式:故意寫一條跨層 import(例如 `domain` import `adapters`),跑 `pnpm lint`,確認它會報錯**
   —— 別只相信「lint 通過」就以為層被鎖住了。

## 指令

(在 workspace 根執行。)

| 指令 | 作用 |
| --- | --- |
| `cd backend && pnpm dev` | 執行 Fastify API(tsx,免 build 步驟)。 |
| `pnpm --filter frontend dev` | 執行 SPA 的 Vite dev server。 |
| `pnpm -r build` | backend:`tsc` → `dist/server`;frontend:`vite` → `frontend/dist`。 |
| `pnpm -r typecheck` | 型別檢查 backend 與 frontend 兩個 package。 |
| `pnpm -r lint` | ESLint(backend 含分層強制;前後端牆由 package 邊界保證)。 |
| `pnpm -r test` | Vitest 單元套件(backend 在 node、frontend 在 jsdom)。 |
| `pnpm --filter backend test:e2e` | 啟動真正的 app 並用 `app.inject()` 驅動它。 |
| `pnpm --filter backend db:migrate:dev` | 對 dev 資料庫套用 SQL migration。 |
| `pnpm --filter backend db:codegen` | 從 schema 重新產生 Kysely 型別。 |
