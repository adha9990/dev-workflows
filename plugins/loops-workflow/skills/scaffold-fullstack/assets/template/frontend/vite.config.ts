import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: clientRoot,
  plugins: [
    // 必須排在 react() 之前:它會從 src/routes/ 內的檔案產生
    // src/routeTree.gen.ts,並啟用 per-route 的 code splitting。
    TanStackRouterVite({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': resolve(clientRoot, 'src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  build: {
    // 前端建置產物落在 frontend/dist;後端的 client_dir 預設指向 ../frontend/dist,
    // 由 Fastify 在單一程序模式下一併提供 SPA。
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    // 在 dev 環境,SPA 透過這個 proxy 與 Fastify API 溝通,所以
    // front/back 之間的牆即使在本機也成立(沒有共用匯入,只有 HTTP)。
    proxy: {
      '/api': 'http://127.0.0.1:51599',
    },
  },
});
