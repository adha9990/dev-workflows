import { describe, it, expect } from 'vitest';
import { createNote } from '../src/domain/note/note';

// 一個佔位用的 benchmark,讓 `pnpm test:benchmark` 有東西可以執行。
// 隨著專案成長,請以真正對效能敏感的路徑取代它。
describe('createNote throughput', () => {
  it('constructs 100k notes well under the budget', () => {
    const start = performance.now();
    for (let i = 0; i < 100_000; i += 1) {
      createNote({ id: String(i), title: `note ${i}`, body: '', now: '2026-01-01T00:00:00.000Z' });
    }
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(5_000);
  });
});
