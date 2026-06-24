import type { Kysely } from 'kysely';
// 唯一允許從 adapters/ 匯入到 ports/ 的情況:產生的 schema 型別
// 只是型別宣告(沒有 runtime),所以這不會破壞接縫。
import type { DB } from '../adapters/db/types.generated';

// Port:持久化接縫。Repository 以 `db` 建構型別安全的查詢,
// 完全不直接接觸 better-sqlite3。替換這個 adapter(例如改用
// Postgres),其上層的 repository 不需更動。
export interface MetadataStore {
  readonly db: Kysely<DB>;
  close(): void;
}
