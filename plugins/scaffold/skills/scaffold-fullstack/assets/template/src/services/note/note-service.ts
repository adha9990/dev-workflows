import { randomUUID } from 'node:crypto';
import { createNote, type Note } from '../../domain/note/note';
import type { NoteRepo } from '../../repositories/note-repo';

// Service:商業邏輯 / 流程協調。它把 domain(createNote)
// 與 repository(persistence)組合起來,並負責 domain 拒絕碰觸的
// 不純部分 — 產生 id 與讀取時鐘。
export class NoteService {
  constructor(private readonly notes: NoteRepo) {}

  list(): Promise<Note[]> {
    return this.notes.list();
  }

  async create(input: { title: string; body: string }): Promise<Note> {
    const note = createNote({
      id: randomUUID(),
      title: input.title,
      body: input.body,
      now: new Date().toISOString(),
    });
    await this.notes.insert(note);
    return note;
  }
}
