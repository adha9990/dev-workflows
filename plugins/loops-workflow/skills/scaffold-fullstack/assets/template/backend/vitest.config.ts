import { defineConfig } from 'vitest/config';

// 後端單元測試:在 Node 環境執行 domain / service / repository / script 的單元與
// 整合測試。前端(client)測試由 frontend/ 套件自有的 vitest 設定負責 —— 這呼應了
// front/back 的切分,測試同樣不會模糊這條邊界。
export default defineConfig({
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
});
