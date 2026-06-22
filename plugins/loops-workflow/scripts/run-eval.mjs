#!/usr/bin/env node
// run-eval.mjs —— 驗證階段評估情境集（≥3 scenario + baseline）並印出可逐條跑的 checklist。
// 用法：node run-eval.mjs <path-to-scenarios.json>
// 結構合格 → 印 checklist + exit 0；結構不合 → 列問題 + exit 1。依賴：無。
//
// 注意：本腳本不自動呼叫 Claude。實跑要在 Claude Code 裡觸發對應階段，
// 再把觀察到的「實際結果」填回 checklist。沒實跑的標 not run（Metric-Honesty）。

import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('用法：node run-eval.mjs <path-to-scenarios.json>'); process.exit(2); }

let spec;
try { spec = JSON.parse(readFileSync(file, 'utf8')); }
catch (e) { console.error(`讀不到或非合法 JSON：${e.message}`); process.exit(2); }

const problems = [];
if (!spec.stage || typeof spec.stage !== 'string') problems.push('缺 stage（要評估哪個階段）。');
if (!spec.baseline || typeof spec.baseline !== 'string') problems.push('缺 baseline（對照組，沒它無法判斷對的原因）。');
const scs = Array.isArray(spec.scenarios) ? spec.scenarios : null;
if (!scs || scs.length < 3) problems.push('scenarios 至少要 3 個。');
for (const [i, s] of (scs || []).entries()) {
  const w = `scenario #${i + 1}${s && s.name ? `（${s.name}）` : ''}`;
  if (!s || typeof s !== 'object') { problems.push(`${w}：不是物件。`); continue; }
  if (!s.name) problems.push(`${w}：缺 name。`);
  if (!s.input) problems.push(`${w}：缺 input。`);
  if (!s.expect) problems.push(`${w}：缺 expect。`);
}

if (problems.length) {
  console.error(`✗ 情境集結構不合（${problems.length} 個問題）：`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

console.log(`# eval checklist —— stage: ${spec.stage}`);
console.log(`baseline（對照組）：${spec.baseline}`);
console.log(`\n逐條在 Claude Code 裡實跑，填「實際」+ 勾 pass（沒跑標 not run）：\n`);
for (const [i, s] of scs.entries()) {
  console.log(`[${i + 1}] ${s.name}`);
  console.log(`    input  : ${s.input}`);
  console.log(`    expect : ${s.expect}`);
  console.log(`    實際   : (not run)`);
  console.log(`    pass?  : [ ]\n`);
}
console.log(`共 ${scs.length} 個 scenario + 1 baseline。結構合格 ✓（行為對錯需實跑後人工 / agent 判定）。`);
process.exit(0);
