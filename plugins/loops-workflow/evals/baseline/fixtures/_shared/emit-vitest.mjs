#!/usr/bin/env node
// emit-vitest.mjs —— baseline corpus 用的可控假 vitest reporter（測試 fixture，非實作）。
// 仿 scripts/fixtures/eval-oracle/emit-vitest.mjs 的通用假 vitest reporter；本目錄自成一份
// （evals/baseline/ 自足，不跨目錄依賴 eval-oracle 的私有 fixture）。
// 每個 workspace 的 package.json scripts.test 指向本檔；loops-quality-gate 跑 test gate 時會以
//   npm test -- --reporter=json --outputFile="<暫存>"
// 呼叫它（cwd＝該 workspace）。本檔把**同 workspace 的 canned-vitest.json**（烤死的真實歷史
// 紅／綠態錄存，非合成）寫進 quality-gate 要求的 outputFile。
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
