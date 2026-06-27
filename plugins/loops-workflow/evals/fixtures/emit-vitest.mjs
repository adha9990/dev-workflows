#!/usr/bin/env node
// emit-vitest.mjs —— evals/ 語料庫 fixture 用的可控假 vitest reporter（fixture，非實作）。
// 各 corpus workspace 的 package.json scripts.test 指向本檔；loops-quality-gate 跑 test gate 時以
//   npm test -- --reporter=json --outputFile="<暫存>"
// 呼叫它（cwd＝該 workspace）。本檔把**同 workspace 的 canned-vitest.json**（烤死的全綠 vitest
// --reporter=json 輸出）寫進該 --outputFile，讓 oracle 取得確定性結果（不裝真 vitest、不靠 env）。
// 與 scripts/fixtures/eval-oracle/emit-vitest.mjs 同手法；兩份 fixture 樹各自獨立（不互相耦合路徑）。
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

const canned = readFileSync(join(process.cwd(), 'canned-vitest.json'), 'utf8');
const target = stripQuotes(findOutputFile(process.argv.slice(2)));
if (target) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, canned, 'utf8');
} else {
  process.stdout.write(canned);
}
