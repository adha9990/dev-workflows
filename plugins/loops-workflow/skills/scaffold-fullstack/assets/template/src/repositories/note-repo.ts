import type { MetadataStore } from '../ports/metadata-store';
import type { Note } from '../domain/note/note';

// Repository:Note entity 的資料存取。它透過 MetadataStore port 建構型別安全的
// Kysely 查詢,並把 DB 資料列(snake_case)對應到 domain 的形狀
//(camelCase)。它完全不知道 HTTP 或商業規則。
interface NoteRow {
  id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

function toDomain(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class NoteRepo {
  constructor(private readonly store: MetadataStore) {}

  async list(): Promise<Note[]> {
    const rows = await this.store.db
      .selectFrom('note')
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toDomain);
  }

  async getById(id: string): Promise<Note | null> {
    const row = await this.store.db
      .selectFrom('note')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toDomain(row) : null;
  }

  async insert(note: Note): Promise<void> {
    await this.store.db
      .insertInto('note')
      .values({
        id: note.id,
        title: note.title,
        body: note.body,
        created_at: note.createdAt,
        updated_at: note.updatedAt,
      })
      .execute();
  }
}
