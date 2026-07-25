#!/usr/bin/env node
// test-context-pack.mjs —— context pack 的預算與受保護區段斷言（#172 AC-4）。
// 核心兩條：① 非受保護內容**絕不**超出硬預算；② blocking（未修 P0/P1・沒過的閘・未決決策）
// **永不**因預算被丟掉——後者是 #162/#188 反覆踩到的失效模式，這裡用機械斷言釘死。
// 用法：node test-context-pack.mjs [--filter <case-prefix>] [--min-cases <n>]

import { projectEvents } from './loop-graph.mjs';
import { estimateTokens, truncateToTokens, buildSections, packSections, buildContextPack, renderPack, STAGE_FOCUS, DEFAULT_BUDGET } from './context-pack.mjs';

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
const build = (specs) => specs.map((s, i) => ({ v: 1, id: `e${i + 1}`, seq: i + 1, type: s.type, payload: s.payload }));

/** 一條卡在 verify、仍有多條未修 P0/P1 與未過閘的 loop（context pack 最需要正確的情境）。 */
function blockedState(findingCount = 6) {
  const specs = [
    { type: 'loop-create', payload: { type: 'feature', operation: 'add', mode: 'closed', stopCondition: '把所有 P0/P1 清零' } },
    { type: 'issue', payload: { number: 172 } },
    { type: 'stage-enter', payload: { stage: 'verify' } },
    { type: 'gate', payload: { gate: 'tests', status: 'fail', detail: '3 條紅燈' } },
    { type: 'decision', payload: { decisionId: 'D1', question: '要不要改契約', status: 'pending' } },
  ];
  for (let i = 1; i <= findingCount; i += 1) {
    specs.push({ type: 'finding', payload: { findingId: `F${i}`, severity: i % 2 ? 'P0' : 'P1', title: `第 ${i} 條未修的嚴重問題，敘述刻意寫長一點以佔用 token 預算`, axis: 'code-quality', round: 1, status: 'open' } });
  }
  for (let i = 0; i < 40; i += 1) specs.push({ type: 'note', payload: { text: `流水帳第 ${i} 筆，這段文字純粹用來把非受保護區段撐大` } });
  const events = build(specs);
  return { state: projectEvents(events, { slug: 'demo' }), events };
}

// ══════════════════════════════════════════════════════════════════════════
testCase('P1', 'estimateTokens：CJK 與 ASCII 的估法（估算值，非實測）', () => {
  assert(estimateTokens('') === 0, '空字串 → 0');
  assert(estimateTokens('繁體中文五個字') === 7, 'CJK 約 1 token/字');
  assert(estimateTokens('abcdefgh') === 2, 'ASCII 約 4 字元/token');
  assert(estimateTokens('中文abcd') === 3, '混合字串兩種算法各算各的');
  assert(estimateTokens(null) === 0, 'null 不丟例外');
});

testCase('P2', 'truncateToTokens：截到預算內、並留下截斷標記', () => {
  const long = '很長的中文內容'.repeat(50);
  const cut = truncateToTokens(long, 40);
  assert(estimateTokens(cut) <= 40, '截斷後不超過上限');
  assert(cut.includes('依 context pack 預算截斷'), '截斷處有明確標記（不是靜默切掉）');
  assert(truncateToTokens('短', 100) === '短', '本來就在預算內 → 原文不動');
  assert(truncateToTokens('任何內容', 0) === '', '上限 0 → 空字串');
});

testCase('P3', '硬預算：非受保護區段的總量不超過 budget', () => {
  const { state, events } = blockedState(1);
  for (const budget of [80, 200, 800, 4000]) {
    const pack = buildContextPack({ state, events, stage: 'verify', budget });
    const unprotected = pack.sections.filter((s) => !s.protected).reduce((n, s) => n + s.tokens, 0);
    const protectedTokens = pack.sections.filter((s) => s.protected).reduce((n, s) => n + s.tokens, 0);
    assert(unprotected + protectedTokens <= budget || pack.overBudget, `budget=${budget}：總量在預算內，或已明確標 overBudget`);
    assert(pack.tokensUsed === unprotected + protectedTokens, `budget=${budget}：tokensUsed 與各區段加總一致`);
  }
});

testCase('P4', 'AC-4：預算極小時 blocking 仍完整保留、並誠實標 overBudget', () => {
  const { state, events } = blockedState(6);
  const pack = buildContextPack({ state, events, stage: 'verify', budget: 1 });
  const blocking = pack.sections.find((s) => s.id === 'blocking');
  assert(blocking, 'budget=1 時 blocking 區段仍在（受保護、不得丟）');
  assert(blocking.truncated === false, 'blocking 區段沒有被截斷');
  for (let i = 1; i <= 6; i += 1) assert(blocking.text.includes(`F${i}`), `未修的 F${i} 完整留在 pack 裡`);
  assert(blocking.text.includes('tests'), '沒過的閘留在 pack 裡');
  assert(blocking.text.includes('D1'), '未決決策留在 pack 裡');
  assert(pack.overBudget === true, '受保護區段撐爆預算 → overBudget=true（誠實揭露，不靜默）');
  assert(pack.sections.filter((s) => !s.protected).length === 0, '預算被受保護區段吃光 → 其餘區段一律不放');
  assert(pack.dropped.length > 0 && pack.dropped.every((d) => d.reason && d.droppedTokens >= 0), '丟掉的東西逐條列出（含原因與 token 量）');
});

testCase('P5', '不做靜默截斷：被截斷 / 被丟掉的區段都出現在 dropped', () => {
  const { state, events } = blockedState(1);
  const pack = buildContextPack({ state, events, stage: 'verify', budget: 150 });
  const truncated = pack.sections.filter((s) => s.truncated).map((s) => s.id);
  for (const id of truncated) assert(pack.dropped.some((d) => d.id === id && d.reason === 'truncated'), `被截斷的 ${id} 出現在 dropped`);
  const kept = new Set(pack.sections.map((s) => s.id));
  const all = buildSections({ state, events, stage: 'verify' }).map((s) => s.id);
  for (const id of all) assert(kept.has(id) || pack.dropped.some((d) => d.id === id), `${id} 不是被留下就是被列進 dropped（沒有第三種：靜默消失）`);
  assert(renderPack(pack).includes('誠實揭露'), '渲染出的 pack 明寫哪些內容因預算沒放進來');
});

testCase('P6', 'stage focus：不同階段挑不同節點', () => {
  const { state, events } = blockedState(2);
  const verify = buildSections({ state, events, stage: 'verify' }).find((s) => s.id === 'stage-focus');
  const build2 = buildSections({ state, events, stage: 'build' }).find((s) => s.id === 'stage-focus');
  assert(verify && verify.text.includes('finding'), 'verify 階段的 focus 帶 finding');
  assert(!build2 || !build2.text.includes('finding'), 'build 階段的 focus 不塞 finding（不同階段看不同東西）');
  assert(Object.keys(STAGE_FOCUS).join(',') === 'goal,explore,plan,build,verify,iterate', 'STAGE_FOCUS 覆蓋六個主階段');
  const none = buildSections({ state, events, stage: null });
  assert(!none.some((s) => s.id === 'stage-focus'), '沒指定階段 → 不產 stage-focus 區段');
});

testCase('P7', 'affected：變更範圍可注入來源內容、也可只列清單', () => {
  const { state, events } = blockedState(1);
  const withBody = buildSections({ state, events, stage: 'build', affected: ['a.mjs'], readSource: () => 'const x = 1;' })
    .find((s) => s.id === 'affected');
  assert(withBody.text.includes('const x = 1;'), '有 readSource → 內容被帶進來');
  const listOnly = buildSections({ state, events, stage: 'build', affected: ['a.mjs'] }).find((s) => s.id === 'affected');
  assert(listOnly.text.includes('a.mjs') && !listOnly.text.includes('const x'), '沒 readSource → 只列路徑（不假造內容）');
  assert(!buildSections({ state, events, stage: 'build' }).some((s) => s.id === 'affected'), '沒有 affected → 不產該區段');
});

testCase('P8', 'packSections：受保護區段永遠排在最前、優先序穩定', () => {
  const sections = [
    { id: 'c', title: 'C', priority: 3, protected: false, truncatable: true, text: '丙' },
    { id: 'blocking', title: 'B', priority: 0, protected: true, truncatable: false, text: '甲' },
    { id: 'a', title: 'A', priority: 1, protected: false, truncatable: true, text: '乙' },
  ];
  const packed = packSections(sections, 1000);
  assert(packed.sections[0].id === 'blocking', '受保護區段排最前');
  assert(packed.sections.map((s) => s.id).join(',') === 'blocking,a,c', '其餘依 priority 排');
  assert(packed.overBudget === false && packed.dropped.length === 0, '預算充足 → 不丟不截');
});

testCase('P9', '預設預算存在且為正數（呼叫端沒傳時仍有硬上限）', () => {
  assert(Number.isInteger(DEFAULT_BUDGET) && DEFAULT_BUDGET > 0, 'DEFAULT_BUDGET 是正整數');
  const { state, events } = blockedState(1);
  const pack = buildContextPack({ state, events });
  assert(pack.budget === DEFAULT_BUDGET, '沒傳 budget → 套預設值（不是無上限）');
  assert(pack.estimateMethod.includes('估算'), 'pack 自帶「這是估算值」的誠實標註（Metric-Honesty）');
});

// ══════════════════════════════════════════════════════════════════════════
const opts = parseArgs(process.argv.slice(2));
const selected = cases.filter((c) => c.id.startsWith(opts.filter));
for (const c of selected) { console.log(`\n[${c.id}] ${c.name}`); c.fn(); }
console.log(`\n${selected.length} cases run, ${passed} passed, ${failed.length} failed`);
if (opts.minCases > 0 && selected.length < opts.minCases) {
  console.error(`\n✗ case 數地板未達成：--min-cases ${opts.minCases}，實際 ${selected.length}`);
  process.exit(1);
}
if (failed.length) { console.error('\n失敗清單：'); for (const m of failed) console.error(`  - ${m}`); process.exit(1); }
process.exit(0);
