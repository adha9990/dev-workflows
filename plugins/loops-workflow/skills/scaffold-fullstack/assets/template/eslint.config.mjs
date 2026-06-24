// @ts-check
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import reactHooks from 'eslint-plugin-react-hooks';

// ────────────────────────────────────────────────────────────────────────────
// 架構強制執行。
//
// 這套技術棧的價值在於分層是「被檢查」的,而不只是「但願如此」。
// `import/no-restricted-paths` 會在某一層 import 了不該 import 的東西時讓 lint 失敗,
// 因此依賴方向不會隨著程式碼成長而悄悄腐化。
//
// 後端依賴方向(箭頭 = 「允許 import」):
//
//     domain  ←  ports  ←  { services, repositories, http }
//                  ↑
//               adapters   (唯一存放具體基礎設施的地方)
//
// - domain 不 import 其他層的任何東西(它是純核心)。
// - services / repositories / http 依賴 ports,絕不直接依賴 adapters
//   (唯一例外:自動產生的 db/types.generated.ts,它只是型別)。
// - composition root(src/bin)與 adapters 才是接線發生的地方。
// ────────────────────────────────────────────────────────────────────────────
const layerZones = [
  // domain 是最內層 —— 它不可向外伸手。
  { target: './src/domain', from: './src/ports', message: 'domain/ must not import from ports/' },
  { target: './src/domain', from: './src/adapters', message: 'domain/ must not import from adapters/' },
  { target: './src/domain', from: './src/services', message: 'domain/ must not import from services/' },
  { target: './src/domain', from: './src/repositories', message: 'domain/ must not import from repositories/' },
  { target: './src/domain', from: './src/http', message: 'domain/ must not import from http/' },

  // ports 定義接縫 —— 它不可依賴任何下層。
  { target: './src/ports', from: './src/adapters', except: ['./db/types.generated.ts'], message: 'ports/ must not import from adapters/ (except the generated db types).' },
  { target: './src/ports', from: './src/services', message: 'ports/ must not import from services/' },
  { target: './src/ports', from: './src/repositories', message: 'ports/ must not import from repositories/' },
  { target: './src/ports', from: './src/http', message: 'ports/ must not import from http/' },

  // services 與 repositories 透過 ports 接觸基礎設施,而非 adapters。
  { target: './src/services', from: './src/adapters', except: ['./db/types.generated.ts'], message: 'services/ must depend on ports/, not adapters/ directly.' },
  { target: './src/repositories', from: './src/adapters', except: ['./db/types.generated.ts'], message: 'repositories/ must depend on ports/, not adapters/ directly.' },
  { target: './src/repositories', from: './src/services', message: 'repositories/ must not import from services/ (data access stays below business logic).' },

  // 除了 composition root(src/bin)以外,沒有東西可以伸進 http adapter。
  { target: './src/!(bin|http)/**/*', from: './src/http/**/*', message: 'Only the composition root may import from http/.' },

  // ★ 前後端牆:src 與 client 只透過 HTTP 溝通。
  { target: './src', from: './client', message: 'src/ (server) must not import from client/. They communicate over HTTP only.' },
  { target: './client', from: './src', message: 'client/ (SPA) must not import from src/. They communicate over HTTP only.' },
];

// 內層不可直接伸手拿基礎設施 —— 那是 ports 與 adapters 的職責。
//(adapters 與 composition root 因 scope 設定而豁免。)
const restrictedInfraImports = [
  { name: 'better-sqlite3', message: 'Use the MetadataStore port instead of better-sqlite3 directly.' },
  { name: 'fs', message: 'Inner layers must not touch the filesystem — go through a port/adapter.' },
  { name: 'node:fs', message: 'Inner layers must not touch the filesystem — go through a port/adapter.' },
  { name: 'fs/promises', message: 'Inner layers must not touch the filesystem — go through a port/adapter.' },
  { name: 'node:fs/promises', message: 'Inner layers must not touch the filesystem — go through a port/adapter.' },
  { name: 'path', message: 'Path logic belongs in an adapter, not in domain/ports/services/repositories.' },
  { name: 'node:path', message: 'Path logic belongs in an adapter, not in domain/ports/services/repositories.' },
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'client/src/routeTree.gen.ts',
      'src/adapters/db/types.generated.ts',
    ],
  },

  ...tseslint.configs.recommended,

  // 對專案的兩半都套用分層 + 牆的強制檢查。
  {
    files: ['src/**/*.ts', 'client/**/*.{ts,tsx}'],
    plugins: { import: importPlugin },
    settings: {
      'import/resolver': {
        typescript: { project: ['tsconfig.json', 'tsconfig.client.json'] },
      },
    },
    rules: {
      'import/no-restricted-paths': ['error', { zones: layerZones }],
    },
  },

  // 基礎設施只能由 adapters 與 composition root import。
  {
    files: [
      'src/domain/**/*.ts',
      'src/ports/**/*.ts',
      'src/services/**/*.ts',
      'src/repositories/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', { paths: restrictedInfraImports }],
    },
  },

  // client 的 React 規則。
  {
    files: ['client/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
