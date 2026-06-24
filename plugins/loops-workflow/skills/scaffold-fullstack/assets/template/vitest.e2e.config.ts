import { defineConfig } from 'vitest/config';

// e2e 套件:啟動真正的 Fastify app,並透過 app.inject() 驅動它。
// 以序列方式執行(無檔案平行化),因為 e2e 測試共用 process 層級的狀態。
export default defineConfig({
  test: {
    root: '.',
    include: ['e2e/**/*.e2e.test.ts'],
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 15_000,
    fileParallelism: false,
    pool: 'threads',
  },
});
