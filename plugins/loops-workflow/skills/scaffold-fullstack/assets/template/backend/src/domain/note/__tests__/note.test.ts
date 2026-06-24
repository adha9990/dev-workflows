import { describe, it, expect } from 'vitest';
import { createNote } from '../note';

describe('createNote', () => {
  it('trims the title', () => {
    const note = createNote({ id: '1', title: '  hello  ', body: 'x', now: '2026-01-01T00:00:00.000Z' });
    expect(note.title).toBe('hello');
  });

  it('copies now into both timestamps', () => {
    const note = createNote({ id: '1', title: 'a', body: '', now: '2026-01-01T00:00:00.000Z' });
    expect(note.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(note.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rejects an empty title', () => {
    expect(() => createNote({ id: '1', title: '   ', body: '', now: '2026-01-01T00:00:00.000Z' })).toThrow();
  });
});
