// M14 fixture 專用假 lint：吞掉 quality-gate append 的 reporter flags（-f json --output-file "X"），
// 把合法空 eslint JSON 寫進 --output-file 指定路徑後 exit 0 —— 呈現「lint 真 passed、test not-run」。
import { writeFileSync } from 'node:fs';
const i = process.argv.indexOf('--output-file');
if (i !== -1 && process.argv[i + 1]) writeFileSync(process.argv[i + 1].replace(/^"|"$/g, ''), '[]');
process.exit(0);
