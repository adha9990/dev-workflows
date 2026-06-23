import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import type { DB } from './types.generated';
import type { MetadataStore } from '../../ports/metadata-store';

// Adapter:具體的 MetadataStore。這是少數允許直接匯入
// better-sqlite3 的地方 — 基礎設施被隔離在此。
export function createSqliteMetadataStore(filename: string): MetadataStore {
  const sqlite = new Database(filename);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = new Kysely<DB>({
    dialect: new SqliteDialect({ database: sqlite }),
  });

  return {
    db,
    close() {
      sqlite.close();
    },
  };
}
