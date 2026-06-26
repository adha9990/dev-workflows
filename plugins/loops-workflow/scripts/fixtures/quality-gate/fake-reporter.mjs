#!/usr/bin/env node
// fake-reporter.mjs —— smoke 用的可控假 reporter（測試 fixture，非實作）。
// 行為：
//   - 從自己的 argv 找 --output-file / --outputFile（兩種拼法；值可能帶引號 → strip）；
//   - 把環境變數 FAKE_OUT 的內容寫進該檔；若無 output-file 旗標則印到 stdout；
//   - 若有環境變數 FAKE_EXIT 則以該 code 退出。
// 用途：當各 gate 的 config 指令，精確控制 reporter 輸出與 exit code，
//       並順帶驗證 appendToolFlags 是否把 --output-file 正確轉發到工具。
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const FLAGS = ['--output-file', '--outputFile'];
const stripQuotes = (v) =>
  typeof v === 'string' ? v.replace(/^["']/, '').replace(/["']$/, '') : v;

function findOutputFile(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    for (const flag of FLAGS) {
      if (a === flag) return argv[i + 1];
      if (a.startsWith(flag + '=')) return a.slice(flag.length + 1);
    }
  }
  return null;
}

const content = process.env.FAKE_OUT ?? '';
const target = stripQuotes(findOutputFile(args));
if (target) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
} else {
  process.stdout.write(content);
}

if (process.env.FAKE_EXIT !== undefined) {
  process.exit(Number(process.env.FAKE_EXIT));
}
