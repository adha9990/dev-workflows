# 分層全端架構參考(layered full-stack)

擴充 scaffold 出來的專案前請先讀這份文件。它說明每一層存在的理由,並給出在不破壞被強制執行的
結構下新增功能的精確步驟。(本架構參考自 `eagle-app-core`。)

## 整體形狀

一個 package 裡有兩半,被一道硬牆隔開:

```
src/      Fastify 後端(Node runtime)
client/   React SPA(瀏覽器)
```

兩者**永遠不互相 import**。所有溝通都走 HTTP。ESLint 的 `import/no-restricted-paths` 會在任一側
越界時讓 build 失敗。這正是讓 server 能 standalone、在容器裡、或嵌入 Electron host 運行,同時讓
SPA 維持為純 client 的關鍵。

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
| `http/` | 以下所有層 | `client` | Fastify adapter:routes、TypeBox schemas、錯誤外殼。 |
| `bin/` | 全部 | `client` | composition root:讀設定、把 adapters 接到 services、啟動 server。 |

\* 唯一允許的例外是 `src/adapters/db/types.generated.ts` —— 它只含 Kysely 的型別宣告(無 runtime),
所以 import 它不會破壞接縫。

### 為什麼要 ports + adapters?

內層依賴的是*介面*(`MetadataStore`、`Logger`),而非具體實作。要把 SQLite 換成 Postgres,只要寫
一個新的 adapter —— repositories 與 services 都不用改。測試時則注入一個假的 store。composition root
(`src/bin/server.ts`)是唯一知道真實接線方式的地方。

## 前端結構

| 路徑 | 角色 |
| --- | --- |
| `client/src/routes/` | 檔案式路由(TanStack Router 產生 `routeTree.gen.ts`)。 |
| `client/src/api/` | HTTP client(`http.ts`)+ 各資源的 fetcher。唯一知道 server 契約的地方。 |
| `client/src/stores/` | Zustand stores —— 小而專一的 UI 狀態。Server 狀態放在 TanStack Query,不放這裡。 |
| `client/src/lib/` | 與框架無關的工具(例如 `cn`)。 |
| `client/src/components/` | UI,依功能組織。 |

## 食譜:新增一個實體(例如 `tag`)

照著 `Note` 切片在各層依樣畫葫蘆。讓 ESLint 抓出錯誤。

1. **Migration** —— 新增 `sql/migrations/00N_tags.sql`(`CREATE TABLE IF NOT EXISTS tag ...`)。
2. **重新產生型別** —— `pnpm db:migrate:dev && pnpm db:codegen`(更新 `db/types.generated.ts`)。
3. **Domain** —— `src/domain/tag/tag.ts`,含實體型別 + 強制不變式的 `createTag` 建構式。在 `__tests__/` 加單元測試。
4. **Repository** —— `src/repositories/tag-repo.ts`:透過 `MetadataStore` 的 Kysely 查詢、row↔domain 轉換。
5. **Service** —— `src/services/tag/tag-service.ts`:編排、產生 id/clock。
6. **HTTP** —— `src/http/schemas/tag.ts`(TypeBox)+ `src/http/routes/tags.ts`;在 `create-server.ts` 註冊它。
7. **接線** —— 在 `src/bin/server.ts` 建立該 service,並透過 `ServerDeps` 傳入。
8. **前端** —— `client/src/api/tags.ts`(fetchers)+ 一個用 TanStack Query 的 route/component。
9. **驗證** —— `pnpm typecheck && pnpm lint && pnpm test`。

## 實戰補充:把這套架構用在「整合密集」的專案

下列模式在一個以本 scaffold 理念重構的真實專案(`auto-scoring-system` —— 一個 API 自動評分器,
會連考生 DB、用 Newman 打考生 API)中驗證過,可直接沿用:

1. **Ports 不只用於持久化 —— 任何「會碰外部世界」的能力都值得一個 port。**
   除了 `MetadataStore` 這類儲存 port,凡是外部能力都可定義成 port:例如「重置考生資料庫」
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

| 指令 | 作用 |
| --- | --- |
| `pnpm dev` | 執行 Fastify API(tsx,免 build 步驟)。 |
| `pnpm dev:client` | 執行 SPA 的 Vite dev server。 |
| `pnpm build` | `tsc` server → `dist/server`,`vite` client → `dist/client`。 |
| `pnpm typecheck` | 型別檢查 server 與 client 兩個專案。 |
| `pnpm lint` | ESLint,包含分層 + 牆的強制檢查。 |
| `pnpm test` | Vitest 單元套件(server 在 node、client 在 jsdom)。 |
| `pnpm test:e2e` | 啟動真正的 app 並用 `app.inject()` 驅動它。 |
| `pnpm db:migrate:dev` | 對 dev 資料庫套用 SQL migration。 |
| `pnpm db:codegen` | 從 schema 重新產生 Kysely 型別。 |
