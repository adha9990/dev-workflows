#!/usr/bin/env node
// test-knowledge-invalidation.mjs —— 失效判定的斷言（#218 S3：只失效受波及的，不整包重建）。
// 兩條紅線：① **判不出來一律降級、不當 clean**；② **不相關的事實保持 valid**——
// 前者堵 stale fact 混進下一階段，後者才是「跨階段不重複探索」真正省下來的部分。
// 用法：node test-knowledge-invalidation.mjs [--filter <case-prefix>] [--min-cases <n>]

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { digestOf, appendClaim, readKnowledge, NOT_MEASURED } from './knowledge-ledger.mjs';
import { computeInvalidation, probeSources, applyInvalidation, sourceFilePath } from './knowledge-invalidation.mjs';

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
  const dir = mkdtempSync(join(tmpdir(), 'kinval-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** 投影後的 claim 記錄形狀（computeInvalidation 吃的就是這個）。 */
function claimRecord(id, overrides = {}) {
  return {
    claimId: id,
    validity: 'valid',
    sources: [{ type: 'repo-file', locator: `${id}.md`, digest: digestOf(id) }],
    derivedFrom: [],
    graphProject: null,
    graphRevision: null,
    createdAtRevision: 'sha1',
    ...overrides,
  };
}
const verdictOf = (result, id) => result.transitions.find((t) => t.claimId === id) ?? null;

// ══════════════════════════════════════════════════════════════════════════
testCase('V1', '來源內容改了 → invalid；沒改的保持 valid（只失效受波及的）', () => {
  const claims = [claimRecord('A'), claimRecord('B')];
  const probes = new Map([['A.md', digestOf('改過了')], ['B.md', digestOf('B')]]);
  const result = computeInvalidation({ claims, probes, revision: 'sha1' });
  assert(verdictOf(result, 'A')?.to === 'invalid', 'digest 對不上 → invalid');
  assert(verdictOf(result, 'A').changedSources.join() === 'A.md', '指名是哪個來源動的');
  assert(verdictOf(result, 'B') === null && result.unaffected.includes('B'), '沒被碰到的事實保持 valid（這才是省下來的部分）');
});

testCase('V2', '來源不見了 → invalid（讀不到是正面證據，不是未知）', () => {
  const result = computeInvalidation({ claims: [claimRecord('A')], probes: new Map([['A.md', null]]), revision: 'sha1' });
  assert(verdictOf(result, 'A')?.to === 'invalid', '來源已不存在 → invalid');
  assert(verdictOf(result, 'A').reason.includes('不存在'), '理由寫清楚是不見了、不是內容變了');
});

testCase('V3', '本該查得到卻沒查到 → uncertain（不把檢查失敗當 clean）', () => {
  const result = computeInvalidation({ claims: [claimRecord('A')], probes: new Map(), revision: 'sha1' });
  assert(verdictOf(result, 'A')?.to === 'uncertain', '沒有探測結果 → uncertain');
  const noDigest = claimRecord('C', { sources: [{ type: 'repo-file', locator: 'C.md' }] });
  const r2 = computeInvalidation({ claims: [noDigest], probes: new Map([['C.md', digestOf('C')]]), revision: 'sha1' });
  assert(verdictOf(r2, 'C')?.to === 'uncertain', '當初沒記 digest ⇒ 無從比對 ⇒ uncertain');
});

testCase('V4', 'code graph snapshot 換版／取不到 revision → uncertain', () => {
  const base = claimRecord('G', { sources: [{ type: 'code-graph', locator: 'search_graph:useLibrary' }], graphProject: 'demo', graphRevision: 'rev-1' });
  assert(verdictOf(computeInvalidation({ claims: [base], graphRevisions: { demo: 'rev-2' }, revision: 'sha1' }), 'G')?.to === 'uncertain', '換版 → uncertain');
  assert(verdictOf(computeInvalidation({ claims: [base], graphRevisions: {}, revision: 'sha1' }), 'G')?.to === 'uncertain', '取不到 revision → uncertain');
  assert(verdictOf(computeInvalidation({ claims: [base], graphRevisions: { demo: 'rev-1' }, revision: 'sha1' }), 'G') === null, '同一份 snapshot → 不動');
  const noRev = claimRecord('G2', { sources: [{ type: 'code-graph', locator: 'x' }], graphProject: 'demo', graphRevision: NOT_MEASURED });
  assert(verdictOf(computeInvalidation({ claims: [noRev], graphRevisions: { demo: 'rev-1' }, revision: 'sha1' }), 'G2')?.to === 'uncertain', '當初沒記 revision → uncertain');
});

testCase('V5', '執行證據只對它跑過的那個 revision 成立', () => {
  const evidence = claimRecord('E', { sources: [{ type: 'command-output', locator: 'pnpm test' }], createdAtRevision: 'sha1' });
  assert(verdictOf(computeInvalidation({ claims: [evidence], revision: 'sha2' }), 'E')?.to === 'uncertain', 'revision 移動 → 證據不再對應同一份程式碼');
  assert(verdictOf(computeInvalidation({ claims: [evidence], revision: 'sha1' }), 'E') === null, '同一個 revision → 證據仍成立');
  assert(verdictOf(computeInvalidation({ claims: [evidence], revision: NOT_MEASURED }), 'E')?.to === 'uncertain', '取不到目前 revision → uncertain（不當通過）');
});

testCase('V6', 'downstream 只降到 uncertain、且會傳到底（多層依賴）', () => {
  const claims = [
    claimRecord('P'),
    claimRecord('C1', { derivedFrom: ['P'] }),
    claimRecord('C2', { derivedFrom: ['C1'] }),
    claimRecord('X'),
  ];
  const probes = new Map([['P.md', digestOf('改過了')], ['C1.md', digestOf('C1')], ['C2.md', digestOf('C2')], ['X.md', digestOf('X')]]);
  const result = computeInvalidation({ claims, probes, revision: 'sha1' });
  assert(verdictOf(result, 'P')?.to === 'invalid', '來源真的變了的那條 → invalid');
  assert(verdictOf(result, 'C1')?.to === 'uncertain' && verdictOf(result, 'C1').cause === 'derived', '下游只降到 uncertain，且標明是被上游帶動的');
  assert(verdictOf(result, 'C2')?.to === 'uncertain', '傳播跑到底（不是只降一層）');
  assert(result.unaffected.includes('X'), '不相干的那條完全不受影響');
});

testCase('V7', '已經終態的不重複判定（invalid／superseded 不再產生 transition）', () => {
  const claims = [claimRecord('A', { validity: 'invalid' }), claimRecord('B', { validity: 'superseded' })];
  const result = computeInvalidation({ claims, probes: new Map([['A.md', null], ['B.md', null]]), revision: 'sha1' });
  assert(result.transitions.length === 0, '終態不再被判一次');
  assert(result.coverage.checked === 0, '也不算進這輪檢查的數量');
});

testCase('V8', '本檔查不到的遠端來源誠實列進 coverage（不假裝驗過、也不無故降級）', () => {
  const claims = [claimRecord('I', { sources: [{ type: 'issue', locator: 'issue#218', digest: digestOf('body') }] })];
  const result = computeInvalidation({ claims, probes: new Map(), revision: 'sha1' });
  assert(result.transitions.length === 0, '遠端來源不因為「本檔查不到」就被判失效');
  assert(result.coverage.unprobed.includes('issue#218'), '但它明確出現在 coverage.unprobed 裡（呼叫端要知道有東西沒驗到）');
});

testCase('V9', 'probeSources：讀得到算 digest、讀不到記 null、遠端來源不放進 map', () => {
  const claims = [
    claimRecord('A', { sources: [{ type: 'repo-file', locator: 'a.md', digest: digestOf('x') }] }),
    claimRecord('S', { sources: [{ type: 'code-symbol', locator: 'src/x.ts#useThing', digest: digestOf('x') }] }),
    claimRecord('I', { sources: [{ type: 'issue', locator: 'issue#1' }] }),
  ];
  const probes = probeSources('/root', claims, {
    readFile: (p) => {
      if (p.endsWith('a.md')) return 'A 的內容';
      throw new Error('ENOENT');
    },
  });
  assert(probes.get('a.md') === digestOf('A 的內容'), '讀得到 → 算出現在的 digest');
  assert(probes.get('src/x.ts#useThing') === null, '讀不到 → null（正面證據）');
  assert(!probes.has('issue#1'), '遠端來源不放進 map');
  assert(sourceFilePath({ type: 'code-symbol', locator: 'src/x.ts#useThing' }) === 'src/x.ts', 'symbol 的 digest 基準是整個檔案');
});

testCase('V10', 'applyInvalidation：判定寫回事件流，狀態隨之改變（含 cause）', () => {
  withTmp((dir) => {
    const base = {
      claim_id: 'A1', kind: 'architecture', statement: 'routes 只透過 viewmodel 取資料',
      scope: { files: ['client/**'], symbols: [] },
      sources: [{ type: 'repo-file', locator: 'client/AGENTS.md', digest: digestOf('原內容') }],
      graph_project: null, graph_revision: null, confidence: 'verified', validity: 'valid',
      created_by: { phase: 'explore', agent_role: 'explore' }, created_at_revision: 'sha1',
    };
    appendClaim(dir, base);
    appendClaim(dir, { ...base, claim_id: 'A2', derived_from: ['A1'], sources: [{ type: 'repo-file', locator: 'client/b.md', digest: digestOf('b') }] });

    const state = readKnowledge(dir).state;
    const probes = new Map([['client/AGENTS.md', digestOf('改過了')], ['client/b.md', digestOf('b')]]);
    const result = computeInvalidation({ claims: state.claims, probes, revision: 'sha1' });
    const written = applyInvalidation(dir, result.transitions);
    assert(written.length === 2, '兩條 transition 各寫一筆事件');

    const after = readKnowledge(dir).state;
    assert(after.claims.find((c) => c.claimId === 'A1').validity === 'invalid', '來源變了的 → invalid');
    assert(after.claims.find((c) => c.claimId === 'A2').validity === 'uncertain', '下游 → uncertain');
    assert(after.claims.find((c) => c.claimId === 'A2').invalidationCause === 'derived', 'cause 留在狀態裡（失效怎麼傳開的查得出來）');
  });
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
