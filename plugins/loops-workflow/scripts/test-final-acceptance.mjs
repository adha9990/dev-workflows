#!/usr/bin/env node
// test-final-acceptance.mjs —— 最終驗收器本身的斷言（#181）。
// 重點：**未跑的項目一律 `not measured`，絕不寫成 passed**；報告不得把未量測的項目藏起來。
// 用法：node test-final-acceptance.mjs [--filter <case-prefix>] [--min-cases <n>]

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GATES, GATE_RESULTS, NOT_MEASURED, runGate, runAll, summarize, renderReport,
} from './final-acceptance.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

let passed = 0;
const failed = [];
const cases = [];
const testCase = (id, name, fn) => cases.push({ id, name, fn });
function assert(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); } else { failed.push(msg); console.error(`  ✗ ${msg}`); }
}
function parseArgs(argv) {
  const opts = { filter: '', minCases: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--filter') opts.filter = argv[++i] ?? '';
    else if (argv[i] === '--min-cases') opts.minCases = Number(argv[++i] ?? 0);
  }
  return opts;
}

// ══════════════════════════════════════════════════════════════════════════
testCase('F1', '閘清單：每一項都寫明查什麼；外部依賴項標明來源', () => {
  assert(GATES.length >= 15, `至少 ${GATES.length} 項驗收`);
  for (const g of GATES) {
    assert(g.id && g.why, `${g.id} 寫明查什麼`);
    assert(['script', 'suite', 'external'].includes(g.kind), `${g.id} 的 kind 合法`);
    if (g.kind === 'external') assert(typeof g.source === 'string' && g.source, `${g.id} 標明依賴哪個外部來源`);
  }
  assert(GATE_RESULTS.join(',') === `passed,failed,${NOT_MEASURED}`, '結果值域固定三種');
  const ids = GATES.map((g) => g.id);
  assert(new Set(ids).size === ids.length, '項目 id 無重複');
});

testCase('F2', '外部來源沒裝 → not measured，絕不是 passed', () => {
  const ext = GATES.find((g) => g.kind === 'external');
  const noPort = runGate(ext, { root: REPO_ROOT });
  assert(noPort.result === NOT_MEASURED, '沒注入可用性 port → not measured');
  assert(noPort.detail.includes('不寫成 passed'), '理由明講不寫成 passed');
  const unavailable = runGate(ext, { root: REPO_ROOT, available: () => false });
  assert(unavailable.result === NOT_MEASURED, '明確回報不可用 → not measured');
  const available = runGate(ext, { root: REPO_ROOT, available: () => true });
  assert(available.result === NOT_MEASURED, '就算來源可用，本檔也不代跑外部工具 → 仍 not measured（不宣稱沒做的事）');
  assert(available.detail.includes('回填'), '指路：安裝後另跑並回填實測');
});

testCase('F3', 'summarize：not measured 不算通過，也不算失敗', () => {
  const s = summarize([
    { id: 'a', result: 'passed' }, { id: 'b', result: 'passed' },
    { id: 'c', result: NOT_MEASURED }, { id: 'd', result: 'failed' },
  ]);
  assert(s.counts.passed === 2 && s.counts.failed === 1 && s.counts[NOT_MEASURED] === 1, '逐類計數正確');
  assert(s.ok === false, '有失敗 → 不 ok');
  assert(s.failed.join(',') === 'd' && s.notMeasured.join(',') === 'c', '逐項列出失敗與未量測');

  const noFail = summarize([{ id: 'a', result: 'passed' }, { id: 'c', result: NOT_MEASURED }]);
  assert(noFail.ok === true, '沒有失敗 → ok');
  assert(noFail.complete === false, '但有未量測 → 不算 complete（未量測不等於通過）');
  const all = summarize([{ id: 'a', result: 'passed' }]);
  assert(all.ok && all.complete, '全部跑過且通過 → complete');
});

testCase('F4', '報告：未量測的項目一定被列出來，不藏', () => {
  const results = [
    { id: 'a', result: 'passed', why: '查 A', detail: '全綠' },
    { id: 'b', result: NOT_MEASURED, why: '查 B', detail: '來源未安裝' },
  ];
  const md = renderReport(results, { at: '1970-01-01T00:00:00.000Z' });
  assert(md.includes('# 最終驗收報告'), '有標題');
  assert(md.includes('`a`') && md.includes('`b`'), '逐項都在表裡');
  assert(md.includes('未量測的項目（誠實揭露）'), '另有一節專門列未量測');
  assert(md.includes('未量測不等於通過'), '明講未量測不等於通過');
  assert(md.includes('1970-01-01'), '帶產出時間（時間由呼叫端注入，測試可決定）');

  const clean = renderReport([{ id: 'a', result: 'passed', why: 'x', detail: 'y' }]);
  assert(clean.includes('全部項目都跑過且通過'), '全綠時說得明確');
  assert(!clean.includes('未量測的項目（誠實揭露）'), '沒有未量測時不冒出空區塊');
  const broken = renderReport([{ id: 'a', result: 'failed', why: 'x', detail: 'y' }]);
  assert(broken.includes('需處理後才可接受'), '有失敗時不說「可以接受」');
});

testCase('F5', '真 repo：跑得起來的閘全部通過（本 case 就是最終驗收本身）', () => {
  // 只跑幾支便宜且確定的，避免這支測試本身變成十幾分鐘的重跑；完整驗收由 CLI 執行。
  const results = runAll({ root: REPO_ROOT, only: ['registry-compiler', 'policy-runtime', 'docs-lint', 'setup-plan', 'check-registry-shape'] });
  assert(results.length === 5, '選定的五項都跑到');
  for (const r of results) assert(r.result === 'passed', `${r.id} 通過（實際：${r.result}／${r.detail}）`);
  const s = summarize(results);
  assert(s.ok && s.complete, '這五項全部跑過且通過');
});

// ══════════════════════════════════════════════════════════════════════════
const opts = parseArgs(process.argv.slice(2));
const selected = cases.filter((c) => c.id === opts.filter || c.id.startsWith(opts.filter));
for (const c of selected) { console.log(`\n[${c.id}] ${c.name}`); c.fn(); }
console.log(`\n${selected.length} cases run, ${passed} passed, ${failed.length} failed`);
if (opts.minCases > 0 && selected.length < opts.minCases) {
  console.error(`\n✗ case 數地板未達成：--min-cases ${opts.minCases}，實際 ${selected.length}`);
  process.exit(1);
}
if (failed.length) { console.error('\n失敗清單：'); for (const m of failed) console.error(`  - ${m}`); process.exit(1); }
process.exit(0);
