// @ts-check
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// ────────────────────────────────────────────────────────────────────────────
// 前端架構強制執行(MVVM)。比照後端 clean architecture 的精神:分層是「被檢查」的,
// 而不只是「但願如此」。違反依賴方向時 lint 直接失敗,層界不會隨程式碼成長而腐化。
//
// (前後端牆 —— client 不可 import server —— 另由 pnpm workspace 的 package 邊界保證:
//  frontend 是獨立套件,看不到 backend 的相對路徑,只能透過 HTTP 溝通。這裡的規則只管
//  frontend 內部的 MVVM 層界。)
//
// 三層(箭頭 = 「允許 import」):
//
//     model  ←  viewmodels  ←  View(routes + components)
//
// - model/      :資料 + 純前端領域(api / 型別 / taxonomy / 純邏輯)。最內層,不可向外伸手
//                 (禁 import viewmodels / routes / components)。
// - viewmodels/ :每畫面一個自訂 hook,持狀態 + 呈現邏輯 + 編排 React Query,對外回
//                 { data, status, actions }。可 import model + lib;禁 import 任何
//                 JSX —— routes / components。
// - View        :routes/ + components/,純呈現。吃 viewmodel hook 渲染、接事件。
//                 禁直接 import model/(含 api)—— 一律經 viewmodels。可 import
//                 viewmodels / components / lib。
//
// lib/ 是跨層共用的無狀態工具(cn / 常數),任何層都可 import。
//
// 註:用核心規則 `no-restricted-imports` 的 patterns 來畫界(不需額外的
// eslint-plugin-import 依賴)。patterns 同時擋兩種寫法:`@/<layer>` 別名與相對路徑
// (../model、./model…),避免有人繞別名偷渡。
//
// ★ 新增層或改 layer 命名時只需動下方常數,規則本體不必改。
// ────────────────────────────────────────────────────────────────────────────

// 別名(@/x)+ 相對路徑(*/x/*、*/x)兩種寫法都擋,讓某一層真的碰不到被禁的層。
const deny = (layer, message) => [
  { group: [`@/${layer}`, `@/${layer}/**`], message },
  { group: [`**/${layer}`, `**/${layer}/**`], message },
];

// View(routes + components):禁 import model/(一律經 viewmodels)。
const VIEW_FORBIDDEN = [
  ...deny('model', 'View(routes/components)不可直接 import model/ —— 請改用 viewmodels 暴露的資料與 actions。'),
];

// viewmodels:禁 import 任何 JSX(routes / components)。
const VIEWMODEL_FORBIDDEN = [
  ...deny('routes', 'viewmodels 不可 import routes/(viewmodel 是純邏輯,不認得畫面)。'),
  ...deny('components', 'viewmodels 不可 import components/(viewmodel 是純邏輯,不認得元件)。'),
];

// model:最內層,禁 import 任何外層。
const MODEL_FORBIDDEN = [
  ...deny('viewmodels', 'model 不可 import viewmodels/(model 是最內層,不可向外依賴)。'),
  ...deny('routes', 'model 不可 import routes/(model 是最內層,不可向外依賴)。'),
  ...deny('components', 'model 不可 import components/(model 是最內層,不可向外依賴)。'),
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src/routeTree.gen.ts',
    ],
  },

  ...tseslint.configs.recommended,

  // React 規則(全 src)。
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // ── MVVM 層界 ──
  // View 層:routes/ + components/。
  {
    files: ['src/routes/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: VIEW_FORBIDDEN }],
    },
  },
  // viewmodels 層。
  {
    files: ['src/viewmodels/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: VIEWMODEL_FORBIDDEN }],
    },
  },
  // model 層。
  {
    files: ['src/model/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: MODEL_FORBIDDEN }],
    },
  },

  // 測試豁免層界:View 測試會 mock model/api、直接組裝 DTO 來驗呈現,屬合理跨界
  //(與後端 __tests__ 豁免 layering 同理 —— 測的是行為,不是生產層該守的依賴方向)。
  {
    files: ['src/**/*.test.{ts,tsx}', 'src/**/__tests__/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
);
