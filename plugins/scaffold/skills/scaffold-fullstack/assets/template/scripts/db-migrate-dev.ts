// 將 SQL migration 套用到 dev 資料庫。
//   pnpm db:migrate:dev [path-to-db]
import { migrateDatabase } from '../src/adapters/db/migrator';

const target = process.argv[2] ?? './data/app.db';
migrateDatabase(target);
console.log(`Migrations applied to ${target}`);
