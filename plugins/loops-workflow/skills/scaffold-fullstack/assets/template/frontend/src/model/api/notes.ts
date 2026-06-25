import { apiFetch } from './http';
import type { CreateNoteInput, Note } from '../types';

// GET /api/v1/notes → { items: Note[] }
export async function fetchNotes(): Promise<Note[]> {
  const data = await apiFetch<{ items: Note[] }>('/api/v1/notes');
  return data.items;
}

// POST /api/v1/notes → Note
export function createNote(input: CreateNoteInput): Promise<Note> {
  return apiFetch<Note>('/api/v1/notes', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
