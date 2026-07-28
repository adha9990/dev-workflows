#!/usr/bin/env node
// test-knowledge-ledger.mjs —— Knowledge Contract 的斷言（#218）。
// 釘死三條不可退讓的性質：
//   ① **只共享事實、不共享結論**——結論型 kind 一律被拒，且錯誤訊息要指名理由（S4 的前提）。
//   ② **沒有 provenance 就不是 valid**——缺 digest／缺 graph revision 一律自動降級並留痕（S3 的前提）。
//   ③ **claim 是錨點不是敘事**——statement 有硬性長度上限（S5：不產生額外的敘事 Markdown）。
// 用法：node test-knowledge-ledger.mjs [--filter <case-prefix>] [--min-cases <n>]

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  STATEMENT_MAX_CHARS, NOT_MEASURED,
  claimKinds, forbiddenClaimKinds, knownRoles, roleProfile, repoAwareActivities, knowledgeEventTypes,
  digestOf, assessProvenance, normalizeClaim, checkClaim,
  buildPackMarker, parsePackMarker,
  appendClaim, appendConsumed, appendInvalidated, appendRefreshed, appendSuperseded,
  appendPackBuilt, appendPackConsumed, appendGap, appendKnowledgeEvent,
  projectKnowledge, readKnowledge, validClaims, buildAgentState,
} from './knowledge-ledger.mjs';

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
function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** 一條形狀完整、provenance 齊全的 claim。 */
function goodClaim(overrides = {}) {
  return {
    claim_id: 'ARCH-014',
    kind: 'dependency-rule',
    statement: 'UI route 透過 viewmodel 呼叫 API，不直接存取 transport',
    scope: { files: ['client/src/routes/**', 'client/src/viewmodels/**'], symbols: [] },
    sources: [{ type: 'repo-file', locator: 'client/AGENTS.md', digest: digestOf('約定內容') }],
    graph_project: null,
    graph_revision: null,
    confidence: 'verified',
    validity: 'valid',
    created_by: { phase: 'explore', agent_role: 'explore' },
    created_at_revision: 'abc1234',
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════
testCase('K1', 'canonical 值域從 vocabulary 取得（不在程式碼裡寫第二份清單）', () => {
  assert(claimKinds().size >= 10, 'claim kinds 有實填內容');
  assert(claimKinds().has('architecture') && claimKinds().has('contract'), '架構與契約是可共享的事實型別');
  assert(!claimKinds().has('quality-verdict'), '品質結論在白名單裡沒有位置（結論不是事實）');
  assert(knownRoles().has('test-author') && knownRoles().has('verify-reviewer'), 'role profile 覆蓋隔離規則最嚴的兩個角色');
  assert(knowledgeEventTypes().size === 8, 'knowledge／context-pack 事件恰好八種');
  assert(repoAwareActivities().has('implement') && !repoAwareActivities().has('publish'), 'repo-aware 由 vocabulary 這一欄決定');
});

testCase('K2', '只共享事實：結論型 kind 一律拒絕，且訊息指名理由', () => {
  for (const [kind, reason] of forbiddenClaimKinds()) {
    const problem = checkClaim(goodClaim({ kind }));
    assert(problem !== null, `${kind} 被拒`);
    assert(problem.reason.includes(reason.slice(0, 8)), `${kind} 的錯誤訊息帶上為什麼它是結論不是事實`);
  }
  assert(checkClaim(goodClaim({ kind: 'not-a-real-kind' })) !== null, '不在白名單的 kind 也一律拒絕（不猜語意）');
});

testCase('K3', 'claim 是錨點不是敘事：statement 有硬性長度上限（S5）', () => {
  const long = '架'.repeat(STATEMENT_MAX_CHARS + 1);
  const problem = checkClaim(goodClaim({ statement: long }));
  assert(problem !== null && problem.reason.includes(String(STATEMENT_MAX_CHARS)), '超長 statement 被拒且指名上限');
  assert(checkClaim(goodClaim({ statement: '架'.repeat(STATEMENT_MAX_CHARS) })) === null, '剛好在上限內 → 通過');
  assert(checkClaim(goodClaim({ statement: '' })) !== null, '空 statement 被拒');
});

testCase('K4', '沒有 scope／sources 的 claim 進不來（追蹤不到就無從失效）', () => {
  assert(checkClaim(goodClaim({ scope: { files: [], symbols: [] } })) !== null, 'scope 全空 → 拒');
  assert(checkClaim(goodClaim({ sources: [] })) !== null, 'sources 空 → 拒');
  assert(checkClaim(goodClaim({ sources: [{ type: 'repo-file', locator: 'a.md', digest: 'sha256:xx' }] })) !== null, 'digest 形狀不合法 → 拒');
  assert(checkClaim(goodClaim({ sources: [{ type: '虛構型別', locator: 'a.md' }] })) !== null, '未登記的 source type → 拒');
  assert(checkClaim(goodClaim({ created_by: { phase: 'explore' } })) !== null, 'created_by 缺 agent_role → 拒');
  assert(checkClaim(goodClaim({ created_at_revision: '' })) !== null, 'created_at_revision 留空 → 拒');
});

testCase('K5', '誠實降級：缺 provenance 就不能是 verified／valid', () => {
  const noDigest = goodClaim({ sources: [{ type: 'repo-file', locator: 'a.md' }] });
  const assessment = assessProvenance(noDigest);
  assert(assessment.confidence === NOT_MEASURED, '一個 digest 都沒有 → not_measured');
  assert(assessment.maxValidity === 'uncertain', 'validity 上限被壓成 uncertain（不得猜成 valid）');

  const { claim, adjustments } = normalizeClaim(noDigest);
  assert(claim.validity === 'uncertain' && claim.confidence === NOT_MEASURED, 'normalize 自動降級');
  assert(adjustments.length === 2 && adjustments.every((a) => a.includes('→')), '降級留痕（不靜默改值）');
  assert(checkClaim(claim) === null, '降級後的 claim 形狀合格');

  const partial = goodClaim({
    sources: [{ type: 'repo-file', locator: 'a.md', digest: digestOf('a') }, { type: 'repo-file', locator: 'b.md' }],
  });
  assert(normalizeClaim(partial).claim.confidence === 'reported', '部分有 digest → reported（不是 verified，也不是完全沒量到）');

  const graphClaim = goodClaim({
    sources: [{ type: 'code-graph', locator: 'search_graph:useLibrary' }],
    graph_project: 'demo', graph_revision: NOT_MEASURED,
  });
  assert(normalizeClaim(graphClaim).claim.validity === 'uncertain', 'graph revision 取不到 → uncertain');
  const graphOk = goodClaim({
    sources: [{ type: 'code-graph', locator: 'search_graph:useLibrary' }],
    graph_project: 'demo', graph_revision: 'rev-9',
  });
  assert(normalizeClaim(graphOk).claim.validity === 'valid', 'graph revision 量得到 → 可以是 valid');
});

testCase('K6', '謊報一律被擋：宣稱的 confidence／validity 不得高於 provenance', () => {
  const lying = { ...goodClaim({ sources: [{ type: 'repo-file', locator: 'a.md' }] }), confidence: 'verified', validity: 'valid' };
  const problem = checkClaim(lying);
  assert(problem !== null && problem.reason.includes('confidence'), '手寫一條「沒有 digest 卻宣稱 verified」的 claim → 被拒');
});

testCase('K7', 'append → replay：事件流是唯一真相源，狀態長回來一模一樣', () => {
  withTmp((dir) => {
    const { claim, adjustments } = appendClaim(dir, goodClaim());
    assert(claim.claim_id === 'ARCH-014' && adjustments.length === 0, 'provenance 齊全 → 不需降級');
    const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
    assert(lines.length === 1 && JSON.parse(lines[0]).type === 'knowledge.claimed', '寫出去的是一筆 canonical 事件（不是第二套資料庫）');

    const state = readKnowledge(dir).state;
    assert(state.enabled === true, '有 knowledge 事件 ⇒ 這條 loop 已啟用共享記憶');
    assert(state.claims.length === 1 && state.claims[0].validity === 'valid', 'claim 從事件流重建');
    assert(validClaims(state).length === 1, 'validClaims 回得出可重用的那條');
  });
});

testCase('K8', 'lifecycle：失效／補查／取代都只往後追加，不改歷史', () => {
  withTmp((dir) => {
    appendClaim(dir, goodClaim());
    appendInvalidated(dir, { claimId: 'ARCH-014', validity: 'invalid', reason: '來源改了', changedSources: ['client/AGENTS.md'] });
    let state = readKnowledge(dir).state;
    assert(state.claims[0].validity === 'invalid', '失效後 validity 變 invalid');
    assert(validClaims(state).length === 0, 'invalid 不進可重用池');

    appendRefreshed(dir, { claimId: 'ARCH-014', claim: goodClaim({ statement: '改寫後的同一條約定' }), reason: '重讀來源' });
    state = readKnowledge(dir).state;
    assert(state.claims[0].validity === 'valid' && state.claims[0].refreshCount === 1, '補查後回到 valid 並記下補查次數');
    assert(state.claims[0].statement === '改寫後的同一條約定', 'refresh 會更新敘述');

    appendClaim(dir, goodClaim({ claim_id: 'ARCH-020', supersedes: 'ARCH-014' }));
    state = readKnowledge(dir).state;
    assert(state.claims.find((c) => c.claimId === 'ARCH-014').validity === 'superseded', '被取代的自動標 superseded');
    assert(state.claims.find((c) => c.claimId === 'ARCH-014').supersededBy === 'ARCH-020', '取代關係查得到');

    appendSuperseded(dir, { claimId: 'ARCH-020', supersededBy: 'ARCH-021' });
    state = readKnowledge(dir).state;
    assert(state.claims.find((c) => c.claimId === 'ARCH-020').validity === 'superseded', '顯式 superseded 事件同樣生效');

    const raw = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert(raw.length === 5 && raw[1].type === 'knowledge.invalidated', '五筆事件全部保留（append-only，歷史沒有被改寫）');
  });
});

testCase('K9', 'invalidation 事件不得用來把東西升回 valid', () => {
  const state = projectKnowledge([
    { type: 'knowledge.claimed', payload: { claim: goodClaim() } },
    { type: 'knowledge.invalidated', payload: { claimId: 'ARCH-014', validity: 'valid', reason: '想偷偷升回去' } },
  ]);
  assert(state.claims[0].validity === 'uncertain', '不認得的降級目標一律落到 uncertain（升級只能走 refresh）');
});

testCase('K10', 'pack marker：round-trip、缺欄位回 null、危險字元轉義', () => {
  const marker = buildPackMarker({ packId: 'abc123', loopSlug: '218-demo', role: 'impl-author', taskId: 'T1', sourceRevision: 'sha1', independence: 'none' });
  const parsed = parsePackMarker(`前言\n${marker}\n後話`);
  assert(parsed.packId === 'abc123' && parsed.role === 'impl-author', 'marker 解得回來');
  assert(parsePackMarker('沒有 marker 的一段話') === null, '沒有 marker → null');
  assert(parsePackMarker('<!-- loops-pack id="a" loop="b" -->') === null, '半套 marker → null（半套比沒有更危險）');
  let threw = false;
  try { buildPackMarker({ packId: 'a' }); } catch { threw = true; }
  assert(threw, '缺必填欄位在組裝當下就拋（不寫出必然解析失敗的 marker）');
  const escaped = buildPackMarker({ packId: 'a', loopSlug: 'b', role: 'c', taskId: 'x-->y', sourceRevision: 'e', independence: 'f' });
  assert(!escaped.replace('-->', '').includes('-->'), 'task 內的 --> 被轉義，不會提前關掉註解');
});

testCase('K11', '認不得的事件型別一律拒絕 append（否則投影會靜默少一整類）', () => {
  withTmp((dir) => {
    let threw = false;
    try { appendKnowledgeEvent(dir, 'knowledge.guessed', {}); } catch { threw = true; }
    assert(threw, '未登記的事件型別被拒');
  });
});

testCase('K12', 'context gap 必須指名缺什麼（不得以「先熟悉專案」重跑完整探索）', () => {
  withTmp((dir) => {
    let threw = false;
    try { appendGap(dir, { packId: 'p1', role: 'explore', gap: '' }); } catch { threw = true; }
    assert(threw, '沒寫缺什麼 → 拒絕');
    appendGap(dir, { packId: 'p1', role: 'explore', gap: '缺 server 端 DELETE 的錯誤碼', requestedScope: ['server/src/http/items.ts'] });
    const state = readKnowledge(dir).state;
    assert(state.gaps.length === 1 && state.gaps[0].requestedScope.length === 1, '缺口帶具體範圍');
  });
});

testCase('K13', 'agent state 是 compact 的：只留讀過什麼與哪些已失效，不留對話', () => {
  withTmp((dir) => {
    appendClaim(dir, goodClaim());
    appendClaim(dir, goodClaim({ claim_id: 'ARCH-015' }));
    appendPackBuilt(dir, { packId: 'p1', role: 'verify-reviewer', phase: 'verify', taskId: 'T1', claimIds: ['ARCH-014', 'ARCH-015'], sourceRevision: 'sha1' });
    appendPackConsumed(dir, { packId: 'p1', agentRole: 'verify-reviewer', agentId: 'A1', dispatchId: 'd1' });
    appendConsumed(dir, { claimId: 'ARCH-014', packId: 'p1', agentRole: 'verify-reviewer', agentId: 'A1', phase: 'verify' });
    appendConsumed(dir, { claimId: 'ARCH-015', packId: 'p1', agentRole: 'verify-reviewer', agentId: 'A1', phase: 'verify' });
    appendInvalidated(dir, { claimId: 'ARCH-015', validity: 'invalid', reason: '來源改了' });

    const state = readKnowledge(dir).state;
    const agent = buildAgentState(state, 'A1');
    assert(agent.consumedClaimIds.length === 2, '讀過哪兩條事實查得出來');
    assert(agent.invalidatedClaimIds.join() === 'ARCH-015', '讀過但已失效的那條被單獨標出（下一輪只補這一條）');
    assert(agent.reviewedRevisions.join() === 'sha1', '審過哪個 revision 查得出來');
    assert(JSON.stringify(agent).length < 600, 'agent state 是 compact 的（不是對話副本）');
    assert(state.packs[0].consumedBy.length === 1, 'pack 真的被誰用掉查得出來');
  });
});

testCase('K14', '同一份 reducer：projectKnowledge 與 readKnowledge 得到相同狀態', () => {
  withTmp((dir) => {
    appendClaim(dir, goodClaim());
    appendConsumed(dir, { claimId: 'ARCH-014', packId: 'p1', agentRole: 'plan', agentId: 'A2' });
    const viaFile = readKnowledge(dir);
    const viaEvents = projectKnowledge(viaFile.events);
    assert(JSON.stringify(viaFile.state) === JSON.stringify(viaEvents), '兩條路徑逐欄位相同（reducer 只有一份）');
  });
});

testCase('K15', 'role profile：隔離規則寫在資料裡，不靠自律', () => {
  assert(roleProfile('test-author').excludes.includes('implementation'), 'test-author 明文排除實作');
  assert(roleProfile('verify-reviewer').excludes.includes('author-defense'), 'reviewer 明文排除作者辯護');
  assert(roleProfile('verify-reviewer').excludes.includes('peer-verdict'), 'reviewer 明文排除其他 reviewer 的判定');
  assert(roleProfile('final-audit').excludes.includes('peer-verdict'), 'fresh final audit 同樣獨立判定');
  assert(!roleProfile('impl-author').excludes.includes('peer-verdict'), 'impl-author 要修的就是那些問題，不排除');
  assert(roleProfile('orchestrator').excludes.length === 0, '主線不受獨立性邊界限制（它必須看得到全貌）');
  assert(roleProfile('不存在的角色') === null, '認不得的角色回 null，由呼叫端決定，不猜一組限制');
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
