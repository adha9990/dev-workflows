#!/usr/bin/env node
// test-loop-graph.mjs —— work graph 投影 + SQLite read model 的斷言（#172 T3/T4）。
// 對應驗收標準：AC-1（只靠 events.jsonl 重建相同 state/graph）、AC-3（replay 測試）、
// AC-5（FTS 故障不影響 exact state 與 blocking 判定）。
// 用法：node test-loop-graph.mjs [--filter <case-prefix>] [--min-cases <n>]

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendEvent, readEvents } from './loop-ledger.mjs';
import {
  NODE_KINDS, EDGE_KINDS, BLOCKING_SEVERITIES, PROJECTED_TYPES,
  projectEvents, selectBlocking, toGraph, projectLoopDir,
  openIndex, rebuildLoop, queryNodes, queryEdges, searchNodes, listLedgerLoops, rebuildAll,
} from './loop-graph.mjs';

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
async function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-graph-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** 一條走完整流程的 loop 事件序列（含回環、finding、gate、PR）。 */
const FULL_RUN = [
  { type: 'loop-create', payload: { type: 'feature', operation: 'add', mode: 'closed', session: 'S1', stopCondition: 'AC 全綠' } },
  { type: 'issue', payload: { number: 172 } },
  { type: 'stage-enter', payload: { stage: 'goal' } },
  { type: 'decision', payload: { decisionId: 'D1', question: '真相源放哪', choice: 'JSONL', status: 'decided' } },
  { type: 'stage-exit', payload: { stage: 'goal' } },
  { type: 'stage-enter', payload: { stage: 'plan' } },
  { type: 'task', payload: { taskId: 'T1', title: 'ledger', status: 'open' } },
  { type: 'task', payload: { taskId: 'T2', title: 'graph', status: 'open', dependsOn: ['T1'] } },
  { type: 'stage-exit', payload: { stage: 'plan' } },
  { type: 'stage-enter', payload: { stage: 'build' } },
  { type: 'artifact', payload: { path: 'scripts/loop-ledger.mjs', kind: 'code', summary: 'ledger 核心' } },
  { type: 'commit', payload: { sha: 'aaaa1111', subject: 'feat: ledger', implements: 'T1' } },
  { type: 'task', payload: { taskId: 'T1', title: 'ledger', status: 'done' } },
  { type: 'stage-exit', payload: { stage: 'build' } },
  { type: 'stage-enter', payload: { stage: 'verify' } },
  { type: 'finding', payload: { findingId: 'F1', severity: 'P1', title: '投影未依行序', axis: 'code-quality', status: 'open' } },
  { type: 'finding', payload: { findingId: 'F2', severity: 'P2', title: '命名可再清楚', axis: 'code-quality', status: 'open' } },
  { type: 'gate', payload: { gate: 'tests', status: 'fail', detail: '2 紅' } },
  { type: 'stage-enter', payload: { stage: 'iterate' } },
  { type: 'round', payload: { round: 1 } },
  { type: 'finding', payload: { findingId: 'F1', severity: 'P1', title: '投影未依行序', axis: 'code-quality', status: 'resolved', resolution: '改用檔案行序' } },
  { type: 'gate', payload: { gate: 'tests', status: 'pass' } },
  { type: 'task', payload: { taskId: 'T2', title: 'graph', status: 'done' } },
  { type: 'pr', payload: { number: 999, title: 'feat: loop memory' } },
];

/** 直接組事件物件（不碰檔案）；`seq` 刻意連號，但投影不得依賴它。 */
const build = (specs) => specs.map((s, i) => ({ v: 1, id: `e${i + 1}`, seq: i + 1, type: s.type, payload: s.payload }));

/** 把事件真的寫進一份 ledger（走唯一寫入路徑）。 */
function seedLedger(dir, specs) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'events.jsonl');
  for (const s of specs) appendEvent(file, s);
  return file;
}

// ══════════════════════════════════════════════════════════════════════════
testCase('G1', 'projectEvents：基本 state 與型別覆蓋', () => {
  const st = projectEvents(build(FULL_RUN), { slug: 'demo' });
  assert(st.loop.type === 'feature' && st.loop.mode === 'closed' && st.loop.session === 'S1', 'loop-create 的欄位進了 state');
  assert(st.issue === 172, 'issue 事件 → state.issue');
  assert(st.currentStage === 'iterate', '最後一次 stage-enter 決定 currentStage');
  assert(st.round === 1, 'round 事件更新回環數');
  assert(st.tasks.length === 2 && st.tasks.every((t) => t.status === 'done'), '同 taskId 的後續事件覆蓋前一筆（last-wins）');
  assert(st.findings.length === 2, '兩筆 finding 都在（同 findingId 不重複建節點）');
  assert(st.findings.find((f) => f.id === 'F1').status === 'resolved', 'F1 被後續事件改成 resolved');
  assert(st.commits.length === 1 && st.commits[0].implements === 'T1', 'commit 記到 implements');
  assert(st.prs.length === 1 && st.prs[0].number === 999, 'PR 記到 state');
  assert(st.eventCount === FULL_RUN.length, 'eventCount＝事件數');
});

testCase('G2', 'projectEvents：階段重入與離開（stage transition replay）', () => {
  const st = projectEvents(build([
    { type: 'stage-enter', payload: { stage: 'verify' } },
    { type: 'stage-exit', payload: { stage: 'verify' } },
    { type: 'stage-enter', payload: { stage: 'iterate' } },
    { type: 'stage-enter', payload: { stage: 'verify' } },
  ]), { slug: 'demo' });
  const verifies = st.stages.filter((s) => s.name === 'verify');
  assert(verifies.length === 2, '同一階段重入 → 兩個各自獨立的 Stage node');
  assert(verifies[0].index === 0 && verifies[1].index === 1, '重入的 index 遞增（node id 不會撞）');
  assert(verifies[0].exitedAt !== null && verifies[1].exitedAt === null, 'exit 只關掉「最近一個還開著的同名階段」');
  assert(st.currentStage === 'verify', 'currentStage 是最後進入的那個');
});

testCase('G3', '排序權威是檔案行序、不是 seq（承 ledger 契約 E6）', () => {
  // 併發寫者會寫出重複 / 亂序的 seq；投影必須照行序，不得自行 sort
  const events = [
    { v: 1, id: 'a', seq: 1, type: 'stage-enter', payload: { stage: 'goal' } },
    { v: 1, id: 'b', seq: 7, type: 'stage-enter', payload: { stage: 'plan' } },
    { v: 1, id: 'c', seq: 7, type: 'stage-enter', payload: { stage: 'build' } },
    { v: 1, id: 'd', seq: 3, type: 'stage-enter', payload: { stage: 'verify' } },
  ];
  const st = projectEvents(events, { slug: 'demo' });
  assert(st.currentStage === 'verify', 'seq 較小但排在最後的那筆才是當前階段（沒有偷偷依 seq 排序）');
  assert(st.stages.map((s) => s.name).join('→') === 'goal→plan→build→verify', '階段序列＝檔案行序');
});

testCase('G4', 'selectBlocking：只有未解決的 P0/P1、fail 的閘、pending 的決策才算 blocking', () => {
  const st = projectEvents(build(FULL_RUN), { slug: 'demo' });
  const b = selectBlocking(st);
  assert(b.findings.length === 0, 'F1 已修、F2 是 P2 → 沒有 blocking finding');
  assert(b.gates.length === 0, 'tests 閘最近一次是 pass → 不 blocking（同名閘 last-wins）');

  const mid = projectEvents(build(FULL_RUN.slice(0, 18)), { slug: 'demo' });
  const bm = selectBlocking(mid);
  assert(bm.findings.length === 1 && bm.findings[0].id === 'F1', '未修的 P1 是 blocking');
  assert(bm.gates.length === 1 && bm.gates[0].gate === 'tests', 'fail 的閘是 blocking');
  assert(bm.count === 2, 'blocking 計數 = findings + gates + pending 決策');

  const pending = projectEvents(build([{ type: 'decision', payload: { decisionId: 'D9', question: '要不要換方案', status: 'pending' } }]), { slug: 'demo' });
  assert(selectBlocking(pending).decisions.length === 1, 'pending 決策算 blocking');
  assert(BLOCKING_SEVERITIES.join(',') === 'P0,P1', 'blocking 嚴重度下限釘在 P0/P1');
});

testCase('G5', 'projectEvents：完工狀態', () => {
  const st = projectEvents(build([...FULL_RUN, { type: 'loop-close', payload: { outcome: '已合併 PR #999' } }]), { slug: 'demo' });
  assert(st.loop.done === true && st.loop.outcome.includes('#999'), 'loop-close → done + outcome');
  assert(st.currentStage === null, '完工後沒有「當前階段」');
});

testCase('G6', 'replay determinism：任意前綴投影兩次結果逐欄位相同（resume 基礎）', () => {
  const all = build(FULL_RUN);
  for (const k of [1, 5, 12, FULL_RUN.length]) {
    const a = projectEvents(all.slice(0, k), { slug: 'demo' });
    const b = projectEvents(all.slice(0, k), { slug: 'demo' });
    assert(JSON.stringify(a) === JSON.stringify(b), `前 ${k} 筆：投影兩次結果逐欄位相同（純函式）`);
  }
  const prefix = projectEvents(all.slice(0, 12), { slug: 'demo' });
  const full = projectEvents(all, { slug: 'demo' });
  assert(prefix.stages.length <= full.stages.length, '前綴狀態是完整狀態的前綴（階段只增不減）');
});

testCase('G7', 'toGraph：node/edge 種類都在模型內、關係方向正確', () => {
  // 用「完整流程 ＋ 共享記憶」兩段合起來當素材：下面那條 `for (const k of EDGE_KINDS)` 是在守
  // 「宣告了卻沒有人產生的 edge 種類」——素材少一段，那道守門就會退化成永遠通過。
  const st = projectEvents(build([...FULL_RUN, ...KNOWLEDGE_RUN,
    { type: 'decision', payload: { decisionId: 'D2', question: '真相源放哪', choice: 'JSONL+SQLite', status: 'decided', supersedes: 'D1' } },
  ]), { slug: 'demo' });
  const { nodes, edges } = toGraph(st);
  assert(nodes.every((n) => NODE_KINDS.includes(n.kind)), '所有 node 種類都在 NODE_KINDS 內');
  assert(edges.every((e) => EDGE_KINDS.includes(e.kind)), '所有 edge 種類都在 EDGE_KINDS 內');
  const kinds = new Set(edges.map((e) => e.kind));
  for (const k of EDGE_KINDS) assert(kinds.has(k), `這條 loop 產生了 ${k} 邊`);
  const dep = edges.find((e) => e.kind === 'DEPENDS_ON');
  assert(dep.from.endsWith(':T2') && dep.to.endsWith(':T1'), 'DEPENDS_ON 方向是 T2 → T1');
  const sup = edges.find((e) => e.kind === 'SUPERSEDES');
  assert(sup.from.endsWith(':D2') && sup.to.endsWith(':D1'), 'SUPERSEDES 方向是新決策 → 舊決策');
  assert(st.decisions.find((d) => d.id === 'D1').supersededBy === 'D2', '被取代的決策標了 supersededBy');
  assert(nodes.filter((n) => n.kind === 'Loop').length === 1, '剛好一個 Loop node');
  assert(new Set(nodes.map((n) => n.id)).size === nodes.length, 'node id 無重複');
  assert(Object.keys(PROJECTED_TYPES).includes('stage-enter'), '投影白名單涵蓋 stage-enter');
});

testCase('G8', 'SQLite：rebuild 冪等、exact 查詢正確', async () => {
  await withTmp(async (dir) => {
    const st = projectEvents(build(FULL_RUN), { slug: 'demo' });
    const handle = await openIndex(join(dir, '.index', 'loops.sqlite'));
    const first = rebuildLoop(handle, st);
    const second = rebuildLoop(handle, st);
    assert(first.nodes === second.nodes && first.edges === second.edges, 'rebuild 兩次 node/edge 數相同');
    assert(queryNodes(handle.db, { loop: 'demo' }).length === first.nodes, '重跑後沒有重複列（先刪後寫＝冪等）');
    const tasks = queryNodes(handle.db, { loop: 'demo', kind: 'Task' });
    assert(tasks.length === 2 && tasks[0].data.title === 'ledger', 'kind 過濾 + data JSON 還原');
    assert(queryEdges(handle.db, { loop: 'demo', kind: 'DEPENDS_ON' }).length === 1, 'edge 依 kind 查得到');
    const loops = handle.db.prepare('SELECT * FROM loops').all();
    assert(loops.length === 1 && loops[0].round === 1 && loops[0].done === 0 && loops[0].blocking === 0, 'loops 摘要列正確（含 blocking 計數）');
    handle.db.close();
  });
});

testCase('G9', 'AC-1：刪掉整個 index，只靠 events.jsonl 重建 → 得到相同的 state 與 graph', async () => {
  await withTmp(async (dir) => {
    const loopsRoot = join(dir, '.loops');
    seedLedger(join(loopsRoot, 'demo'), FULL_RUN);

    const { state: inMemory } = projectLoopDir(join(loopsRoot, 'demo'), { slug: 'demo' });
    const expected = toGraph(inMemory);

    const first = await rebuildAll(loopsRoot);
    const nodesA = queryNodes(first.handle.db, { loop: 'demo' });
    const edgesA = queryEdges(first.handle.db, { loop: 'demo' });
    first.handle.db.close();
    rmSync(join(loopsRoot, '.index'), { recursive: true, force: true });

    const second = await rebuildAll(loopsRoot);
    const nodesB = queryNodes(second.handle.db, { loop: 'demo' });
    const edgesB = queryEdges(second.handle.db, { loop: 'demo' });
    second.handle.db.close();

    assert(JSON.stringify(nodesA) === JSON.stringify(nodesB), '刪掉 index 重建 → nodes 逐欄位相同');
    assert(JSON.stringify(edgesA) === JSON.stringify(edgesB), '刪掉 index 重建 → edges 逐欄位相同');
    assert(nodesB.length === expected.nodes.length && edgesB.length === expected.edges.length, 'index 內容與 in-memory graph 條數一致');
    assert(listLedgerLoops(loopsRoot).map((l) => l.slug).join(',') === 'demo', 'listLedgerLoops 不把 .index 當成 loop');
  });
});

testCase('G10', 'AC-5：FTS 壞掉只降級搜尋，exact 查詢 / blocking 判定 / audit trail 不受影響', async () => {
  await withTmp(async (dir) => {
    const loopDir = join(dir, '.loops', 'demo');
    seedLedger(loopDir, FULL_RUN.slice(0, 18)); // 停在仍有 blocking 的點
    const { state: st } = projectLoopDir(loopDir, { slug: 'demo' });
    const handle = await openIndex(join(dir, '.index', 'loops.sqlite'));
    rebuildLoop(handle, st);
    const before = searchNodes(handle, 'ledger', { loop: 'demo' });
    assert(before.rows.length > 0 && before.degraded === false, 'FTS 正常時搜得到、未降級');

    handle.db.exec('DROP TABLE nodes_fts;'); // 模擬 FTS sidecar 損毀
    const after = searchNodes(handle, 'ledger', { loop: 'demo' });
    assert(after.degraded === true, 'FTS 壞掉 → 誠實回報 degraded');
    assert(after.rows.length > 0, 'FTS 壞掉仍搜得到（LIKE fallback）');
    assert(queryNodes(handle.db, { loop: 'demo', kind: 'Finding' }).length === 2, 'exact 查詢不受 FTS 影響');
    assert(selectBlocking(st).count === 2, 'blocking 判定完全不碰 index（純由事件流推導）');
    const ledgerAfter = readEvents(join(loopDir, 'events.jsonl'));
    assert(ledgerAfter.events.length === 18 && ledgerAfter.warnings.length === 0, 'audit trail（events.jsonl）在 index 損毀後完好無缺');
    assert(JSON.stringify(projectEvents(ledgerAfter.events, { slug: 'demo' })) === JSON.stringify(st), 'index 壞掉後仍能只靠 ledger 重建出同一份 state');
    handle.db.close();
  });
});

testCase('G11', 'rebuildLoop：只影響該 loop，不動到別的 loop', async () => {
  await withTmp(async (dir) => {
    const handle = await openIndex(join(dir, '.index', 'loops.sqlite'));
    rebuildLoop(handle, projectEvents(build(FULL_RUN), { slug: 'a' }));
    rebuildLoop(handle, projectEvents(build(FULL_RUN), { slug: 'b' }));
    const aBefore = queryNodes(handle.db, { loop: 'a' }).length;
    rebuildLoop(handle, projectEvents(build(FULL_RUN.slice(0, 5)), { slug: 'b' }));
    assert(queryNodes(handle.db, { loop: 'a' }).length === aBefore, '重建 b 不影響 a 的列');
    assert(queryNodes(handle.db, { loop: 'b' }).length < aBefore, 'b 的列已換成新的（較短的事件流）');
    handle.db.close();
  });
});

testCase('G12', 'projectEvents：壞資料防禦（未知型別、孤兒事件、缺欄位）不丟例外', () => {
  const st = projectEvents([
    { v: 1, id: 'a', seq: 1, type: 'loop-create', payload: {} },
    { v: 1, id: 'b', seq: 2, type: 'stage-exit', payload: { stage: '沒進去過' } },
    { v: 1, id: 'c', seq: 3, type: 'stage-enter', payload: {} },
    { v: 1, id: 'd', seq: 4, type: 'unknown.future', payload: {} },
    { v: 1, id: 'e', seq: 5, type: 'issue', payload: { number: 'NaN' } },
  ], { slug: 'x' });
  assert(st.eventCount === 5, '未知型別被忽略但事件仍計數');
  assert(st.stages.length === 0 && st.currentStage === null, '孤兒 exit / 缺 stage 名不會造出幽靈節點');
  assert(st.issue === null, '非數字的 issue number 不進 state');
});

testCase('G13', 'projectLoopDir：把 ledger 的健康度警告一起帶出來（不靜默）', async () => {
  await withTmp(async (dir) => {
    const loopDir = join(dir, '.loops', 'demo');
    seedLedger(loopDir, FULL_RUN.slice(0, 3));
    const clean = projectLoopDir(loopDir, { slug: 'demo' });
    assert(clean.warnings.length === 0 && clean.truncatedTail === false, '健康的 ledger → 無警告');
    const { appendFileSync } = await import('node:fs');
    appendFileSync(join(loopDir, 'events.jsonl'), '{"v":1,"id":"x","seq":9,"type":"stage-en'); // 中斷的 append
    const dirty = projectLoopDir(loopDir, { slug: 'demo' });
    assert(dirty.truncatedTail === true && dirty.warnings.some((w) => /尾行/.test(w)), '殘骸尾行被回報出來');
    assert(dirty.state.stages.length === clean.state.stages.length, '殘骸不影響投影出來的狀態');
  });
});

testCase('G14', 'GUARD：後續事件只覆蓋自己帶到的欄位，不得把前一筆宣告的欄位抹掉', () => {
  // 實測踩到：T2 收工那筆 `task` 事件沒帶 dependsOn，整筆取代式的 upsert 把依賴邊抹掉，
  // 於是 DEPENDS_ON 邊憑空消失。這條把「部分更新」的語意釘死。
  const st = projectEvents(build([
    { type: 'task', payload: { taskId: 'T1', title: 'ledger', status: 'open' } },
    { type: 'task', payload: { taskId: 'T2', title: 'graph', status: 'open', dependsOn: ['T1'] } },
    { type: 'task', payload: { taskId: 'T2', status: 'done' } },
  ]), { slug: 'demo' });
  const t2 = st.tasks.find((t) => t.id === 'T2');
  assert(t2.status === 'done', '這次帶到的欄位有被覆蓋');
  assert(t2.dependsOn.join(',') === 'T1', '這次沒帶到的 dependsOn 保留（不被抹掉）');
  assert(t2.title === 'graph', '這次沒帶到的 title 保留');
  assert(toGraph(st).edges.some((e) => e.kind === 'DEPENDS_ON'), '依賴邊仍在');

  const f = projectEvents(build([
    { type: 'finding', payload: { findingId: 'F1', severity: 'P0', title: '嚴重問題', axis: 'security' } },
    { type: 'finding', payload: { findingId: 'F1', status: 'resolved' } },
  ]), { slug: 'demo' }).findings[0];
  assert(f.severity === 'P0' && f.title === '嚴重問題' && f.axis === 'security', 'finding 的部分更新同樣不抹掉既有欄位');
  assert(f.status === 'resolved', 'finding 狀態被更新');
});

// ── #218 共享記憶：claim／source／pack 的投影與重建 ──────────────────────────

/** 一段帶共享記憶的事件序列（claim 依 kind 投影成不同節點、含失效與取代、含一份 pack）。 */
const KNOWLEDGE_RUN = [
  { type: 'loop-create', payload: { type: 'feature', operation: 'add', mode: 'closed' } },
  { type: 'stage-enter', payload: { stage: 'explore' } },
  { type: 'knowledge.claimed', payload: { claimId: 'K-ARCH', claim: { claim_id: 'K-ARCH', kind: 'architecture', statement: 'route 只透過 viewmodel 取資料', scope: { files: ['client/**'], symbols: [] }, sources: [{ type: 'repo-file', locator: 'client/AGENTS.md', digest: 'sha256:aa' }], confidence: 'verified', validity: 'valid', created_by: { phase: 'explore', agent_role: 'explore' }, created_at_revision: 'sha1' } } },
  { type: 'knowledge.claimed', payload: { claimId: 'K-CONV', claim: { claim_id: 'K-CONV', kind: 'convention', statement: '對外敘述一律繁體中文', scope: { files: ['**'], symbols: [] }, sources: [{ type: 'repo-file', locator: 'AGENTS.md', digest: 'sha256:bb' }], confidence: 'verified', validity: 'valid', created_by: { phase: 'explore', agent_role: 'explore' }, created_at_revision: 'sha1' } } },
  { type: 'knowledge.claimed', payload: { claimId: 'K-CONTRACT', claim: { claim_id: 'K-CONTRACT', kind: 'contract', statement: 'DELETE /items/:id 回 204', scope: { files: ['server/**'], symbols: [] }, sources: [{ type: 'repo-file', locator: 'server/http.ts', digest: 'sha256:cc' }], derived_from: ['K-ARCH'], confidence: 'verified', validity: 'valid', created_by: { phase: 'explore', agent_role: 'explore' }, created_at_revision: 'sha1' } } },
  { type: 'knowledge.claimed', payload: { claimId: 'K-INV', claim: { claim_id: 'K-INV', kind: 'invariant', statement: '刪除後不得留下孤兒列', scope: { files: ['server/**'], symbols: [] }, sources: [{ type: 'command-output', locator: 'pnpm test', digest: 'sha256:dd' }], confidence: 'verified', validity: 'valid', created_by: { phase: 'explore', agent_role: 'explore' }, created_at_revision: 'sha1' } } },
  { type: 'knowledge.claimed', payload: { claimId: 'K-EVID', claim: { claim_id: 'K-EVID', kind: 'evidence', statement: 'pnpm test 全綠（sha1）', scope: { files: ['**'], symbols: [] }, sources: [{ type: 'command-output', locator: 'pnpm test', digest: 'sha256:dd' }], confidence: 'verified', validity: 'valid', created_by: { phase: 'explore', agent_role: 'explore' }, created_at_revision: 'sha1' } } },
  { type: 'stage-enter', payload: { stage: 'build' } },
  { type: 'context-pack.built', payload: { packId: 'pack-1', role: 'impl-author', phase: 'build', taskId: 'T1', claimIds: ['K-ARCH', 'K-CONTRACT'], tokensEstimated: 120, budget: 4000, sourceRevision: 'sha1' } },
  { type: 'context-pack.consumed', payload: { packId: 'pack-1', agentRole: 'impl-author', agentId: 'A1', dispatchId: 'd1' } },
  { type: 'knowledge.consumed', payload: { claimId: 'K-ARCH', packId: 'pack-1', agentRole: 'impl-author', agentId: 'A1', phase: 'build' } },
  { type: 'knowledge.invalidated', payload: { claimId: 'K-CONV', validity: 'invalid', reason: '來源改了', changedSources: ['AGENTS.md'], cause: 'source' } },
  { type: 'knowledge.refreshed', payload: { claimId: 'K-EVID', reason: '同一個 revision 上重跑一次', claim: { claim_id: 'K-EVID', kind: 'evidence', statement: 'pnpm test 全綠（sha1，重跑）', scope: { files: ['**'], symbols: [] }, sources: [{ type: 'command-output', locator: 'pnpm test', digest: 'sha256:dd' }], confidence: 'verified', validity: 'valid', created_by: { phase: 'build', agent_role: 'impl-author' }, created_at_revision: 'sha1' } } },
  { type: 'knowledge.claimed', payload: { claimId: 'K-ARCH2', claim: { claim_id: 'K-ARCH2', kind: 'architecture', statement: 'route 改走 loader', scope: { files: ['client/**'], symbols: [] }, sources: [{ type: 'repo-file', locator: 'client/AGENTS.md', digest: 'sha256:ee' }], supersedes: 'K-ARCH', confidence: 'verified', validity: 'valid', created_by: { phase: 'build', agent_role: 'impl-author' }, created_at_revision: 'sha2' } } },
];

testCase('G15', '#218：claim 依 kind 投影成不同節點，關係邊齊全', () => {
  const st = projectEvents(build(KNOWLEDGE_RUN), { slug: 'demo' });
  assert(st.knowledge.enabled === true && st.knowledge.claims.length === 6, '六條 claim 進了知識狀態');
  assert(st.knowledge.claims.find((c) => c.claimId === 'K-CONV').validity === 'invalid', '失效事件生效');
  assert(st.knowledge.claims.find((c) => c.claimId === 'K-ARCH').validity === 'superseded', '被取代的自動終態');

  const { nodes, edges } = toGraph(st);
  const kindsOf = (id) => nodes.find((n) => n.id.endsWith(`:${id}`))?.kind;
  assert(kindsOf('K-ARCH') === 'ArchitectureSlice', 'architecture → ArchitectureSlice');
  assert(kindsOf('K-CONV') === 'Convention', 'convention → Convention');
  assert(kindsOf('K-CONTRACT') === 'Contract', 'contract → Contract');
  assert(kindsOf('K-INV') === 'Invariant', 'invariant → Invariant');
  assert(kindsOf('K-EVID') === 'KnowledgeClaim', '其餘 kind → KnowledgeClaim（新增 kind 不會消失）');
  assert(nodes.some((n) => n.kind === 'Source' && n.label === 'client/AGENTS.md'), 'Source 節點成立');
  assert(nodes.some((n) => n.kind === 'ContextPack'), 'ContextPack 節點成立');
  assert(nodes.every((n) => NODE_KINDS.includes(n.kind)), '沒有模型外的 node 種類');
  assert(edges.every((e) => EDGE_KINDS.includes(e.kind)), '沒有模型外的 edge 種類');

  const has = (kind) => edges.some((e) => e.kind === kind);
  for (const kind of ['DERIVED_FROM', 'APPLIES_TO', 'CONSUMED_BY', 'INVALIDATED_BY', 'SUPERSEDES', 'VERIFIED_BY']) {
    assert(has(kind), `${kind} 邊有被建出來`);
  }
  const derived = edges.filter((e) => e.kind === 'DERIVED_FROM');
  assert(derived.some((e) => e.from.includes('K-CONTRACT') && e.from.includes('Contract') && e.to.includes('K-ARCH')), 'claim → 上游 claim 的依賴邊在（失效傳播靠它）');
  assert(edges.some((e) => e.kind === 'INVALIDATED_BY' && e.to.endsWith('repo-file:AGENTS.md')), '失效指得出是哪個來源動的');
});

testCase('G16', 'S6：刪掉整個 index，共享記憶只靠 events.jsonl 就重建得回來', async () => {
  await withTmp(async (dir) => {
    const loopsRoot = join(dir, '.loops');
    seedLedger(join(loopsRoot, 'demo'), KNOWLEDGE_RUN);

    const first = await rebuildAll(loopsRoot);
    const claimsA = queryNodes(first.handle.db, { loop: 'demo', kind: 'ArchitectureSlice' });
    const packsA = queryNodes(first.handle.db, { loop: 'demo', kind: 'ContextPack' });
    const edgesA = queryEdges(first.handle.db, { loop: 'demo' }).filter((e) => e.kind === 'CONSUMED_BY');
    first.handle.db.close();
    rmSync(join(loopsRoot, '.index'), { recursive: true, force: true });

    const second = await rebuildAll(loopsRoot);
    const claimsB = queryNodes(second.handle.db, { loop: 'demo', kind: 'ArchitectureSlice' });
    const packsB = queryNodes(second.handle.db, { loop: 'demo', kind: 'ContextPack' });
    const edgesB = queryEdges(second.handle.db, { loop: 'demo' }).filter((e) => e.kind === 'CONSUMED_BY');
    second.handle.db.close();

    assert(JSON.stringify(claimsA) === JSON.stringify(claimsB), 'claim 節點逐欄位相同');
    assert(JSON.stringify(packsA) === JSON.stringify(packsB), 'pack metadata 逐欄位相同');
    assert(JSON.stringify(edgesA) === JSON.stringify(edgesB), '取用關係逐欄位相同');
    assert(claimsB.some((n) => n.data.validity === 'superseded'), 'validity 也是重建出來的（不是另存一份狀態）');
    assert(packsB[0].data.claimIds.length === 2, 'pack 帶了哪些事實查得回來');
  });
});

testCase('G17', '#218：壞掉／殘缺的 knowledge 事件不丟例外（投影層一律降級不炸）', () => {
  const st = projectEvents(build([
    { type: 'knowledge.claimed', payload: {} },
    { type: 'knowledge.claimed', payload: { claim: { claim_id: 'K1' } } },
    { type: 'knowledge.invalidated', payload: { claimId: '不存在' } },
    { type: 'knowledge.consumed', payload: {} },
    { type: 'context-pack.consumed', payload: { packId: '不存在' } },
    { type: 'context-pack.built', payload: {} },
  ]), { slug: 'demo' });
  assert(st.knowledge.claims.length === 1, '沒有 id 的 claim 不進狀態，但也不炸');
  assert(st.knowledge.claims[0].sources.length === 0 && st.knowledge.claims[0].validity === 'uncertain', '缺來源的 claim 保守落到 uncertain（不預設 valid）');
  assert(st.knowledge.packs.length === 0, '沒有 packId 的 pack 事件不進狀態');
  assert(toGraph(st).nodes.every((n) => NODE_KINDS.includes(n.kind)), '殘缺資料照樣投影得出合法節點');
});

// ══════════════════════════════════════════════════════════════════════════
const opts = parseArgs(process.argv.slice(2));
const selected = cases.filter((c) => c.id === opts.filter || c.id.startsWith(opts.filter));
for (const c of selected) { console.log(`\n[${c.id}] ${c.name}`); await c.fn(); }
console.log(`\n${selected.length} cases run, ${passed} passed, ${failed.length} failed`);
if (opts.minCases > 0 && selected.length < opts.minCases) {
  console.error(`\n✗ case 數地板未達成：--min-cases ${opts.minCases}，實際 ${selected.length}`);
  process.exit(1);
}
if (failed.length) { console.error('\n失敗清單：'); for (const m of failed) console.error(`  - ${m}`); process.exit(1); }
process.exit(0);
