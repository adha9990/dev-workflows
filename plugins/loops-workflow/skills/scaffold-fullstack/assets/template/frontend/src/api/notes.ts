import { apiFetch } from './http';

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export async function fetchNotes(): Promise<Note[]> {
  const data = await apiFetch<{ items: Note[] }>('/api/v1/notes');
  return data.items;
}

export function createNote(input: { title: string; body: string }): Promise<Note> {
  return apiFetch<Note>('/api/v1/notes', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
