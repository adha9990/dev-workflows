import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// 一個 runner 中有兩個 test project:server 套件在 Node 環境執行,
// client 套件則在 jsdom。這呼應了 front/back 的切分 — 測試同樣
// 不會模糊這條邊界。
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          include: [
            'src/**/__tests__/**/*.test.ts',
            'scripts/**/__tests__/**/*.test.ts',
          ],
          globals: true,
          testTimeout: 10_000,
        },
      },
      {
        plugins: [react()],
        resolve: {
          alias: {
            '@': resolve(import.meta.dirname, 'client/src'),
          },
        },
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['client/**/*.test.{ts,tsx}'],
          setupFiles: ['client/vitest.setup.ts'],
          globals: true,
        },
      },
    ],
  },
});
