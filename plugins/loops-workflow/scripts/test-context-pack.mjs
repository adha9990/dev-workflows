#!/usr/bin/env node
// test-context-pack.mjs —— context pack 的預算、受保護區段與**角色切片**斷言（#172 AC-4、#218 S2/S4/S5）。
// 核心四條：① 非受保護內容**絕不**超出硬預算；② blocking（未修 P0/P1・沒過的閘・未決決策）
// **永不**因預算被丟掉（#162/#188 反覆踩到的失效模式）；③ 獨立性邊界擋掉的東西與預算丟掉的東西
// **分開列**；④ 共享事實只放 valid 的、且每條都是一行錨點（不是敘事）。
// 用法：node test-context-pack.mjs [--filter <case-prefix>] [--min-cases <n>]

import { projectEvents } from './loop-graph.mjs';
import { digestOf, STATEMENT_MAX_CHARS } from './knowledge-ledger.mjs';
import { estimateTokens, truncateToTokens, buildSections, packSections, buildContextPack, renderPack, selectClaims, computePackId, excludedChannels, STAGE_FOCUS, DEFAULT_BUDGET } from './context-pack.mjs';

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
  const all = buildSections({ state, events, stage: 'verify' }).sections.map((s) => s.id);
  for (const id of all) assert(kept.has(id) || pack.dropped.some((d) => d.id === id), `${id} 不是被留下就是被列進 dropped（沒有第三種：靜默消失）`);
  assert(renderPack(pack).includes('誠實揭露'), '渲染出的 pack 明寫哪些內容因預算沒放進來');
});

testCase('P6', 'stage focus：不同階段挑不同節點', () => {
  const { state, events } = blockedState(2);
  const verify = buildSections({ state, events, stage: 'verify' }).sections.find((s) => s.id === 'stage-focus');
  const build2 = buildSections({ state, events, stage: 'build' }).sections.find((s) => s.id === 'stage-focus');
  assert(verify && verify.text.includes('finding'), 'verify 階段的 focus 帶 finding');
  assert(!build2 || !build2.text.includes('finding'), 'build 階段的 focus 不塞 finding（不同階段看不同東西）');
  assert(Object.keys(STAGE_FOCUS).join(',') === 'goal,explore,plan,build,verify,iterate', 'STAGE_FOCUS 覆蓋六個主階段');
  const none = buildSections({ state, events, stage: null });
  assert(!none.sections.some((s) => s.id === 'stage-focus'), '沒指定階段 → 不產 stage-focus 區段');
});

testCase('P7', 'affected：變更範圍可注入來源內容、也可只列清單', () => {
  const { state, events } = blockedState(1);
  const withBody = buildSections({ state, events, stage: 'build', affected: ['a.mjs'], readSource: () => 'const x = 1;' })
    .sections.find((s) => s.id === 'affected');
  assert(withBody.text.includes('const x = 1;'), '有 readSource → 內容被帶進來');
  const listOnly = buildSections({ state, events, stage: 'build', affected: ['a.mjs'] }).sections.find((s) => s.id === 'affected');
  assert(listOnly.text.includes('a.mjs') && !listOnly.text.includes('const x'), '沒 readSource → 只列路徑（不假造內容）');
  assert(!buildSections({ state, events, stage: 'build' }).sections.some((s) => s.id === 'affected'), '沒有 affected → 不產該區段');
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

// ── #218 Context Broker：角色切片、獨立性邊界、pack 身分 ────────────────────

/** 一條已經累積了共享事實的 loop（涵蓋四種 kind，scope 分別落在不同模組）。 */
function knowledgeState(findingCount = 2) {
  const { state, events } = blockedState(findingCount);
  const claim = (id, kind, statement, files, validity = 'valid') => ({
    claimId: id, at: 0, kind, statement,
    scope: { files, symbols: [] },
    sources: [{ type: 'repo-file', locator: files[0].replace('/**', '/AGENTS.md'), digest: digestOf(id) }],
    derivedFrom: [], graphProject: null, graphRevision: null,
    confidence: 'verified', validity,
    createdBy: { phase: 'explore', agent_role: 'explore' }, createdAtRevision: 'sha1', refreshCount: 0,
  });
  state.knowledge = {
    enabled: true, contractVersion: 1, packs: [], consumption: [], gaps: [],
    claims: [
      claim('C-ARCH', 'architecture', 'route 只透過 viewmodel 取資料', ['client/src/**']),
      claim('C-IMPL', 'implementation-detail', 'useLibrary 以 useMemo 快取 rows', ['client/src/**']),
      claim('C-BEHAV', 'behavior', '刪除後清單立即少一列', ['client/src/**']),
      claim('C-OTHER', 'contract', 'DELETE /items/:id 回 204', ['server/src/**']),
      claim('C-STALE', 'architecture', '這條的來源已經改過了', ['client/src/**'], 'invalid'),
    ],
  };
  return { state, events };
}
const packFor = (role, extra = {}) => {
  const { state, events } = knowledgeState();
  return buildContextPack({
    state, events, stage: 'build', role, taskId: 'T1',
    affected: ['client/src/routes/library.tsx'], sourceRevision: 'sha1', budget: 4000,
    readSource: () => 'const 實作內容 = 1;', ...extra,
  });
};

testCase('P10', 'S2：同一個 behavior 的不同角色拿到不同 pack（隔離規則寫在資料裡）', () => {
  const testAuthor = packFor('test-author');
  assert(!testAuthor.claimIds.includes('C-IMPL'), 'test-author 拿不到 implementation-detail 事實');
  assert(testAuthor.excludedClaims.some((e) => e.claimId === 'C-IMPL' && e.reason === 'independence:implementation'), '而且說得出是被隔離規則擋的');
  const affected = testAuthor.sections.find((s) => s.id === 'affected');
  assert(affected.text.includes('client/src/routes/library.tsx'), 'test-author 仍知道範圍內有哪些檔');
  assert(!affected.text.includes('實作內容'), '但拿不到檔案內容（看得到實作就寫得出遷就實作的測試）');
  assert(testAuthor.excludedSections.some((e) => e.id === 'affected-bodies'), '內容被降級這件事有留痕');
  assert(testAuthor.claimIds.includes('C-BEHAV'), 'behavior 與契約照給——它要靠這個寫測試');

  const impl = packFor('impl-author');
  assert(impl.claimIds.includes('C-IMPL') && impl.sections.find((s) => s.id === 'affected').text.includes('實作內容'), 'impl-author 拿得到實作');
  assert(impl.sections.some((s) => s.id === 'blocking'), 'impl-author 看得到沒過的閘與要修的問題');

  for (const pack of [testAuthor, impl]) {
    assert(!pack.claimIds.includes('C-OTHER'), '不相干模組的事實不塞進來（沒有人收到整包 dump）');
  }
});

testCase('P11', 'S4：獨立審查的角色重用架構事實，但拿不到別人的判定', () => {
  for (const role of ['verify-reviewer', 'plan-reviewer', 'finding-validator', 'final-audit']) {
    const pack = packFor(role);
    assert(pack.claimIds.includes('C-ARCH'), `${role} 仍可重用有 provenance 的架構事實（不必重學架構）`);
    assert(!pack.sections.some((s) => s.id === 'blocking'), `${role} 拿不到前一輪的 finding／判定`);
    assert(pack.excludedSections.some((e) => e.id === 'blocking' && e.reason === 'independence:peer-verdict'), `${role} 的排除有明確理由`);
    const recent = pack.sections.find((s) => s.id === 'recent');
    assert(!recent || !recent.text.includes('finding'), `${role} 的最近事件也不夾帶 finding（否則等於從另一條路漏回去）`);
  }
  assert(excludedChannels('orchestrator').size === 0, '主線不受限');
  let threw = false;
  try { excludedChannels('test-authour'); } catch { threw = true; }
  assert(threw, '打錯字的 role 直接拋出——不回「什麼都不擋」，否則隔離規則會被一個 typo 靜默繞過');
});

testCase('P12', 'S3 消費面：只有 valid 進 pack，失效的只留提醒、不當事實', () => {
  const pack = packFor('impl-author');
  assert(!pack.claimIds.includes('C-STALE'), '失效的事實不進 pack');
  assert(pack.degradedClaims.some((d) => d.claimId === 'C-STALE' && d.validity === 'invalid'), '但它被列進 degraded（不是靜默消失）');
  const claims = pack.sections.find((s) => s.id === 'claims');
  assert(claims.text.includes('C-STALE') && claims.text.includes('不得當成仍然成立'), 'pack 內文明寫「這條要自己補查」');
  const { state } = knowledgeState();
  const selection = selectClaims({ claims: state.knowledge.claims, role: 'explore', affected: [] });
  assert(selection.included.every((c) => c.validity === 'valid'), 'selectClaims 只回 valid');
  assert(selection.degraded.length === 1 && selection.included.length + selection.excluded.length + selection.degraded.length === state.knowledge.claims.length,
    '每條事實不是被納入、就是被列進 excluded／degraded（沒有第三種：靜默消失）');
});

testCase('P13', '獨立性排除與預算丟棄是兩件事，各自列在自己的欄位', () => {
  const pack = packFor('verify-reviewer', { budget: 200 });
  assert(pack.dropped.every((d) => ['truncated', 'no-room', 'protected-section-consumed-budget'].includes(d.reason)), 'dropped 只講預算');
  assert(pack.excludedSections.every((e) => e.reason.startsWith('independence:')), 'excludedSections 只講獨立性');
  assert(!pack.dropped.some((d) => d.id === 'blocking'), '被獨立性擋掉的區段不會被誤記成「預算不夠」');
  const rendered = renderPack(pack);
  assert(rendered.includes('因獨立性邊界不提供的內容'), '渲染出的 pack 分兩節說明，讀的人不會以為多給預算就拿得到');
});

testCase('P14', 'pack 身分是 content address：同輸入同 id、任一輸入變就換 id', () => {
  const a = packFor('impl-author');
  const b = packFor('impl-author');
  assert(a.packId === b.packId, '同一組輸入 → 同一個 packId（deterministic）');
  assert(a.packId.length === 32, 'packId 是固定長度的雜湊');
  assert(packFor('verify-reviewer').packId !== a.packId, '換角色 → 換 id');
  assert(packFor('impl-author', { taskId: 'T2' }).packId !== a.packId, '換任務 → 換 id');
  assert(packFor('impl-author', { sourceRevision: 'sha2' }).packId !== a.packId, '換 revision → 換 id');
  const base = { loop: 'x', stage: 'build', role: 'plan', taskId: 'T1', affected: ['b', 'a'], claimIds: ['z', 'y'], budget: 10, sourceRevision: 'r' };
  assert(computePackId(base) === computePackId({ ...base, affected: ['a', 'b'], claimIds: ['y', 'z'] }), '順序不影響身分（排序後才算雜湊）');
  assert(a.marker.includes(a.packId), 'marker 帶的就是這個 id');
});

testCase('P15', 'S5：共享記憶不長成敘事——每條事實一行錨點，且不寫任何額外 Markdown 檔', () => {
  const pack = packFor('impl-author');
  const claims = pack.sections.find((s) => s.id === 'claims');
  const rows = claims.text.split('\n').filter((l) => l.startsWith('- '));
  assert(rows.length === pack.claimIds.length, '事實區段一條事實一行');
  for (const row of rows) {
    assert([...row].length <= STATEMENT_MAX_CHARS + 160, '每行都是錨點長度（statement 上限 ＋ id／kind／來源），不是一段敘事');
    assert(row.includes('來源：'), '每條都帶得回去查的來源');
  }
  assert(typeof pack.marker === 'string' && pack.marker.startsWith('<!-- loops-pack'), 'pack 的身分是一行註解，不是一份文件');
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
