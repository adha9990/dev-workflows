-- SQL migration 是 schema 的單一真實來源。
-- 編輯後,請執行 `pnpm db:migrate:dev` 再執行 `pnpm db:codegen` 以重新產生
-- src/adapters/db/types.generated.ts,讓 Kysely 查詢保持型別安全。
--
-- 陳述式使用 IF NOT EXISTS,因此 dev migrator 具有冪等性。

CREATE TABLE IF NOT EXISTS note (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_created_at ON note (created_at);
