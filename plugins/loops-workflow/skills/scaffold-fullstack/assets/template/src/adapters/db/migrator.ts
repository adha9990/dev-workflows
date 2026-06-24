import Database from 'better-sqlite3';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

// Adapter:依序套用 SQL migration 檔案。因為 migration 使用
// IF NOT EXISTS,所以每次啟動執行都是安全的。陳述式透過
// better-sqlite3 的多陳述式 .exec() 執行,這是 Kysely 的查詢 API 做不到的。
export function migrateDatabase(filename: string): void {
  if (filename !== ':memory:') {
    mkdirSync(dirname(resolve(filename)), { recursive: true });
  }
  const db = new Database(filename);
  try {
    const dir = resolve(process.cwd(), 'sql/migrations');
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const file of files) {
      db.exec(readFileSync(join(dir, file), 'utf8'));
    }
  } finally {
    db.close();
  }
}
