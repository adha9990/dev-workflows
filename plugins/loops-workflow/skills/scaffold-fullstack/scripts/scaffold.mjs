#!/usr/bin/env node
// 從打包的模板 scaffold 出一個新的分層全端 TypeScript 專案。
//
//   node scaffold.mjs <target-dir> [project-name]
//
// - 把 assets/template/ 複製到 <target-dir>
// - 重新命名模板 dotfile:開頭的 "dot-" 變成 "."(例如 dot-gitignore -> .gitignore)。
//   用 "dot-" 這個標記(而非單純的 "_")是為了避免誤改 TanStack 的 __root.tsx
//   或 __tests__ 這類合法名稱。
// - 把每個文字檔裡的 __PROJECT_NAME__ token 替換成 [project-name]
//
// 純 Node ESM,零依賴 —— 在 Windows、macOS、Linux 上行為一致。

import {
  cpSync,
  readdirSync,
  renameSync,
  statSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const templateDir = join(scriptDir, '..', 'assets', 'template');

const [, , targetArg, nameArg] = process.argv;

if (!targetArg) {
  console.error('用法:node scaffold.mjs <target-dir> [project-name]');
  process.exit(1);
}

if (!existsSync(templateDir)) {
  console.error(`找不到模板:${templateDir}`);
  process.exit(1);
}

const targetDir = resolve(process.cwd(), targetArg);
const projectName = (nameArg ?? basename(targetDir)).trim();

if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
  console.error(`拒絕 scaffold:${targetDir} 已存在且不是空的。`);
  process.exit(1);
}

cpSync(templateDir, targetDir, { recursive: true });

/** 把前綴為 "dot-" 的檔案/目錄重新命名,讓前綴變成 ".". */
function renameDotfiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      renameDotfiles(full);
    }
    if (entry.startsWith('dot-')) {
      renameSync(full, join(dir, `.${entry.slice(4)}`));
    }
  }
}

/** 替換每個文字檔裡的專案名稱 token. */
function replaceTokens(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      replaceTokens(full);
      continue;
    }
    const content = readFileSync(full, 'utf8');
    if (content.includes('__PROJECT_NAME__')) {
      writeFileSync(full, content.split('__PROJECT_NAME__').join(projectName));
    }
  }
}

renameDotfiles(targetDir);
replaceTokens(targetDir);

console.log(`已將 "${projectName}" scaffold 到 ${targetDir}`);
console.log('');
console.log('接下來:');
console.log(`  cd ${targetArg}`);
console.log('  pnpm install        # 或:corepack pnpm install');
console.log('  pnpm typecheck && pnpm lint && pnpm test');
console.log('  cp dev.json.example dev.json && pnpm dev      # API 在 :51599');
console.log('  pnpm dev:client                                # Vite 在 :5173');
