import { defineConfig } from 'vitest/config';

// benchmark 套件:較長的 timeout、序列執行,使計時不會因為
// 並行的 CPU 壓力而失真。
export default defineConfig({
  test: {
    root: '.',
    include: ['benchmark/**/*.bench.test.ts'],
    globals: true,
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    pool: 'threads',
  },
});
