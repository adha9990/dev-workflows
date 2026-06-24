// @ts-check
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// 前端 ESLint:React 規則。前後端牆(client 不可 import server)現在由 pnpm
// workspace 的 package 邊界保證 —— frontend 是獨立套件,看不到 backend 的相對路徑,
// 只能透過 HTTP 溝通。因此這裡不再需要 server ↔ client 的 no-restricted-paths 規則。
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src/routeTree.gen.ts',
    ],
  },

  ...tseslint.configs.recommended,

  // client 的 React 規則。
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
