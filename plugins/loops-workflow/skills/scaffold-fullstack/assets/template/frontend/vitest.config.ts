import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// 前端單元測試:在 jsdom 環境下測 React 元件與工具函數。後端測試由 backend/ 套件
// 自有的 vitest 設定負責 —— 這呼應了 front/back 的切分,測試同樣不會模糊這條邊界。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    name: 'client',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
  },
});
