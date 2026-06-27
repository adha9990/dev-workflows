#!/usr/bin/env node
// emit-vitest.mjs —— eval-oracle e2e 用的可控假 vitest reporter（測試 fixture，非實作）。
// 每個 workspace 的 package.json scripts.test 指向本檔；loops-quality-gate 跑 test gate 時會以
//   npm test -- --reporter=json --outputFile="<暫存>"
// 呼叫它（cwd＝該 workspace）。本檔：
//   1) 從 argv 找 --output-file / --outputFile（兩種拼法、值可能帶引號 → strip）；
//   2) 把**同 workspace 的 canned-vitest.json**（烤死的 vitest --reporter=json 輸出）寫進該檔。
// canned 內容刻意烤進各 workspace 的 sibling json（不靠 env：quality-gate spawn 時不帶我們的 env）。
// 仿 scripts/fixtures/quality-gate/fake-reporter.mjs 的 flag 解析，但內容來源為 sibling 檔。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const FLAGS = ['--output-file', '--outputFile'];
const stripQuotes = (v) =>
  typeof v === 'string' ? v.replace(/^["']/, '').replace(/["']$/, '') : v;

function findOutputFile(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    for (const flag of FLAGS) {
      if (a === flag) return argv[i + 1];
      if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
    }
  }
  return null;
}

// canned 結果與本 workspace 同層（npm test 以該 workspace 為 cwd 執行本檔）。
const canned = readFileSync(join(process.cwd(), 'canned-vitest.json'), 'utf8');
const target = stripQuotes(findOutputFile(process.argv.slice(2)));
if (target) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, canned, 'utf8');
} else {
  process.stdout.write(canned);
}
