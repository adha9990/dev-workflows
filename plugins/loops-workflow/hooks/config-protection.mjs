#!/usr/bin/env node
// config-protection.mjs —— loops-workflow PreToolUse(Write|Edit|MultiEdit) hook：擋下「修改既有 linter/formatter
// 設定檔」這個弱化品質閘的動作（應改程式碼，而非把 lint/format 規則調鬆）。只擋「受保護且已存在」的檔；
// 新建設定檔放行。LOOPS_CONFIG_PROTECTION defaultOn 但 loops-scoped（#87）：
//   - 未設：只在 payload.cwd 下存在 .loops/ 才生效（不擾非 loops 專案）。
//   - 顯式 '1'：全域生效，不查 .loops/。
//   - 顯式 '0'：關閉。
// fail-open：任何例外一律放行 exit 0，永不擋路（hook 故障不該卡住使用者）。
//
// 分層（仿 hooks/suggest-compact.mjs / scripts/loops-quality-gate.mjs）：
//   1) 純函式（無 IO，測試直接 import）：isProtectedConfig / shouldBlock。
//   2) IO 薄邊界：main()（讀 stdin、查 existsSync、印 deny JSON）——被 import 時不執行（import.meta.url 守門）。
// 依賴：僅 node 內建（fs / path / url / process），零外部套件。

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── 對外契約：受保護的 linter / formatter 設定檔 basename（值即契約，逐欄釘死）─────────
// 只收 lint/format 類設定；tsconfig.json / package.json 等「非 lint/format」刻意不納入（見測試 NOT_PROTECTED）。
const PROTECTED_CONFIGS = new Set([
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
  '.eslintrc',
  '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
  '.prettierrc',
  '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml',
  'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs',
  'biome.json', 'biome.jsonc',
  'ruff.toml', '.ruff.toml',
]);

const DENY_REASON =
  '請修正程式碼錯誤，而非弱化 linter/formatter 設定檔。若確需修改設定，請設 LOOPS_CONFIG_PROTECTION=0 暫時關閉' +
  '（僅字面 \'0\' 會關）。';

// ── 純函式層（無 IO，測試直接 import）─────────────────────────────────────────────

/** basename 命中受保護清單 → true（純比對，不碰檔案系統；入參即 basename，呼叫端自行取 basename）。 */
export function isProtectedConfig(name) {
  return PROTECTED_CONFIGS.has(String(name));
}

/**
 * 是否該擋下這次編輯：受保護設定檔「且已存在」才擋（弱化既有閘）；新建設定檔 / 非受保護一律放行。
 * existsFn 以 port 注入，讓判定純粹可測；以 basename 判斷，使深路徑下的設定檔同樣命中。
 */
export function shouldBlock(filePath, existsFn) {
  return isProtectedConfig(basename(String(filePath))) && Boolean(existsFn(filePath));
}

/**
 * loops-scoped defaultOn 判定（#87）：顯式 '0' 關；顯式 '1' 全域生效（不查 .loops/）；
 * 未設（含怪值）僅在 loops 工作區（hasLoopsDir）才生效——避免打擾非 loops 專案。
 */
export function isProtectionEnabled(envValue, hasLoopsDir) {
  if (envValue === '0') return false;
  if (envValue === '1') return true;
  return Boolean(hasLoopsDir);
}

// ── IO 薄邊界：main()（被 import 時不執行）────────────────────────────────────────

function readStdin() {
  return readFileSync(0, 'utf8'); // fd 0 = stdin（hook payload 由父行程以 pipe 餵入）
}

/**
 * PreToolUse(Edit|Write) hook 入口：受保護設定檔且已存在 → 回 deny 阻擋；其餘一律放行（無輸出）。
 * 安全 / 永不擋路：env 預設關、payload 壞掉放行、只讀 basename + existsSync（不執行任何外部字串）、
 * 任何例外（fail-open）放行 exit 0。
 */
function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return; // payload 壞 → 放行（無輸出）
  }

  const cwd = payload?.cwd;
  const hasLoopsDir = typeof cwd === 'string' && existsSync(join(cwd, '.loops'));
  if (!isProtectionEnabled(process.env.LOOPS_CONFIG_PROTECTION, hasLoopsDir)) return; // 未啟用 → 放行

  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== 'string') return; // 無檔路徑 → 無從判定，放行
  if (!shouldBlock(filePath, existsSync)) return; // 非受保護 / 新建 → 放行

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: DENY_REASON,
      },
    }),
  );
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch {
    // fail-open：hook 絕不可因錯誤擋路 → 吞掉所有例外、放行
  }
  process.exit(0);
}
