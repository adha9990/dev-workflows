// 產生風格的檔案 — schema 變更後請以 `pnpm db:codegen` 重新產生。
//
// 這個手寫的 stub 反映了 kysely-codegen 從 SQLite schema 產生的內容。
// 它是唯一允許 ports/ 從 adapters/ 匯入的地方
//(它只包含型別,沒有 runtime 程式碼)。

import type { ColumnType } from 'kysely';

export type Generated<T> =
  T extends ColumnType<infer S, infer I, infer U>
    ? ColumnType<S, I | undefined, U>
    : ColumnType<T, T | undefined, T>;

export interface Note {
  id: string;
  title: string;
  body: Generated<string>;
  created_at: string;
  updated_at: string;
}

export interface DB {
  note: Note;
}
