#!/usr/bin/env node
// emit-report.mjs —— baseline-corpus e2e 用的可控假 vitest reporter（測試 fixture，非實作）。
// 仿 scripts/fixtures/eval-oracle/emit-vitest.mjs 同一套「canned 結果重播」手法：本 workspace
// 的 package.json scripts.test 指向本檔；loops-quality-gate 跑 test gate 時以
//   npm test -- --reporter=json --outputFile="<暫存>"
// 呼叫（cwd＝本 workspace），本檔把同層的 canned-vitest.json 寫進該輸出檔，確定性重播。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const FLAGS = ['--output-file', '--outputFile'];
const stripQuotes = (v) => (typeof v === 'string' ? v.replace(/^["']/, '').replace(/["']$/, '') : v);

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
