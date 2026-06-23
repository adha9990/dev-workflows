// 從 dev 資料庫的 schema 重新產生 src/adapters/db/types.generated.ts。
// 請先執行 `pnpm db:migrate:dev`,讓資料庫反映最新的 migration。
//   pnpm db:codegen
import { execSync } from 'node:child_process';

const dbPath = process.env.DATABASE_URL ?? './data/app.db';
const url = dbPath.startsWith('sqlite:') ? dbPath : dbPath;

execSync(
  `pnpm exec kysely-codegen --dialect sqlite --url ${url} --out-file src/adapters/db/types.generated.ts`,
  { stdio: 'inherit' },
);
console.log('Regenerated src/adapters/db/types.generated.ts');
