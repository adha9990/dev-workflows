#!/usr/bin/env node
// test-context-gate.mjs —— Context Pack Gate ＋ Invalidation Gate 的斷言（#218）。
// 釘死三件事：① 只有**能證明**的違規才擋（缺 pack／pack 不存在／引用已失效的事實）；
// ② **判不出來 ≠ 通過**——擋不了的時候要留下「我沒驗到什麼」；③ 作用範圍窄到不會誤傷
// （沒用共享記憶的 loop、非 repo-aware 的派工，一律完全不管）。
// 用法：node test-context-gate.mjs [--filter <case-prefix>] [--min-cases <n>]

import { NOT_MEASURED, projectKnowledge, digestOf } from './knowledge-ledger.mjs';
import { classifyActivity, checkPackFreshness, evaluateDispatch } from './context-gate.mjs';

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

const claimEvent = (id, validity = 'valid') => ({
  type: 'knowledge.claimed',
  payload: {
    claimId: id,
    claim: {
      claim_id: id, kind: 'architecture', statement: `事實 ${id}`,
      scope: { files: ['src/**'], symbols: [] },
      sources: [{ type: 'repo-file', locator: `${id}.md`, digest: digestOf(id) }],
      confidence: 'verified', validity,
      created_by: { phase: 'explore', agent_role: 'explore' }, created_at_revision: 'sha1',
    },
  },
});
const packEvent = (packId, claimIds, sourceRevision = 'sha1') => ({
  type: 'context-pack.built',
  payload: { packId, role: 'impl-author', phase: 'build', taskId: 'T1', claimIds, sourceRevision },
});

const trace = (activity = 'implement') =>
  `<!-- loops-trace loop="218-demo" iteration="0" node="build" phase="build" activity="${activity}" role="impl-author" task="T1" summary="做 T1" parent="main" dispatch="d1" -->`;
const marker = (packId = 'p1', loop = '218-demo') =>
  `<!-- loops-pack id="${packId}" loop="${loop}" role="impl-author" task="T1" revision="sha1" independence="none" -->`;

const knowledgeWith = (...events) => projectKnowledge(events);

// ══════════════════════════════════════════════════════════════════════════
testCase('CG1', '這條 loop 沒用過共享記憶 → 完全不管（舊 loop 不受影響）', () => {
  const decision = evaluateDispatch({ prompt: trace(), knowledge: projectKnowledge([]), revision: 'sha1', loopSlug: '218-demo' });
  assert(decision.allowed === true && decision.skipped, '一律放行並說明為什麼不管');
});

testCase('CG2', '非 repo-aware 的派工不需要 pack', () => {
  const knowledge = knowledgeWith(claimEvent('A'), packEvent('p1', ['A']));
  for (const activity of ['publish', 'document', 'author-issue', 'cleanup']) {
    const d = evaluateDispatch({ prompt: trace(activity), knowledge, revision: 'sha1', loopSlug: '218-demo' });
    assert(d.allowed === true && d.skipped?.includes(activity), `${activity} 不是 repo-aware → 放行`);
  }
});

testCase('CG3', 'repo-aware 卻沒帶 pack → 擋，且訊息給得出下一步', () => {
  const knowledge = knowledgeWith(claimEvent('A'), packEvent('p1', ['A']));
  for (const activity of ['implement', 'review', 'research', 'remediate']) {
    const d = evaluateDispatch({ prompt: trace(activity), knowledge, revision: 'sha1', loopSlug: '218-demo' });
    assert(d.allowed === false, `${activity} 缺 pack → 擋`);
  }
  const d = evaluateDispatch({ prompt: trace(), knowledge, revision: 'sha1', loopSlug: '218-demo' });
  assert(d.reason.includes('loops-pack'), '訊息附上 marker 的正確形狀');
  assert(d.reason.includes('context-pack.mjs'), '訊息指出要用哪支工具產 pack（不是要人自己拼）');
});

testCase('CG4', 'pack 屬於別條 loop → 擋（不得跨 loop 重用 context）', () => {
  const knowledge = knowledgeWith(claimEvent('A'), packEvent('p1', ['A']));
  const d = evaluateDispatch({ prompt: `${marker('p1', '999-other')}\n${trace()}`, knowledge, revision: 'sha1', loopSlug: '218-demo' });
  assert(d.allowed === false && d.reason.includes('999-other'), '指名它是哪條 loop 的 pack');
});

testCase('CG5', '事件流裡沒登記過的 pack → 擋（手打的 marker 不算數）', () => {
  const knowledge = knowledgeWith(claimEvent('A'), packEvent('p1', ['A']));
  const d = evaluateDispatch({ prompt: `${marker('p-手打')}\n${trace()}`, knowledge, revision: 'sha1', loopSlug: '218-demo' });
  assert(d.allowed === false && d.reason.includes('context-pack.built'), '訊息指出缺的是登記事件');
});

testCase('CG6', 'Invalidation Gate：pack 引用已失效的事實 → 擋', () => {
  const knowledge = knowledgeWith(
    claimEvent('A'), claimEvent('B'), packEvent('p1', ['A', 'B']),
    { type: 'knowledge.invalidated', payload: { claimId: 'B', validity: 'invalid', reason: '來源改了' } },
  );
  const d = evaluateDispatch({ prompt: `${marker()}\n${trace()}`, knowledge, revision: 'sha1', loopSlug: '218-demo' });
  assert(d.allowed === false && d.reason.includes('B[invalid]'), '指名是哪一條事實失效了');

  const uncertain = knowledgeWith(
    claimEvent('A'), packEvent('p1', ['A']),
    { type: 'knowledge.invalidated', payload: { claimId: 'A', validity: 'uncertain', reason: '證明不了' } },
  );
  const d2 = evaluateDispatch({ prompt: `${marker()}\n${trace()}`, knowledge: uncertain, revision: 'sha1', loopSlug: '218-demo' });
  assert(d2.allowed === false, 'uncertain 同樣擋（不得當 valid 偷渡）');
});

testCase('CG7', 'pack 建在別的 revision → 擋；revision 取不到 → 放行但誠實標未驗到', () => {
  const knowledge = knowledgeWith(claimEvent('A'), packEvent('p1', ['A'], 'sha1'));
  const stale = evaluateDispatch({ prompt: `${marker()}\n${trace()}`, knowledge, revision: 'sha2', loopSlug: '218-demo' });
  assert(stale.allowed === false && stale.reason.includes('sha1'), 'revision 對不上 → 擋並指名兩邊');

  const unknown = evaluateDispatch({ prompt: `${marker()}\n${trace()}`, knowledge, revision: NOT_MEASURED, loopSlug: '218-demo' });
  assert(unknown.allowed === true, '判不出 revision 不擋路（hook 家族的 fail-open 慣例）');
  assert(unknown.degraded.some((d) => d.includes('not_measured')), '但明確記下「這項沒驗到」——不當成 clean');
});

testCase('CG8', '一切齊全 → 放行，且帶回 marker 與 pack 供後續留痕', () => {
  const knowledge = knowledgeWith(claimEvent('A'), packEvent('p1', ['A']));
  const d = evaluateDispatch({ prompt: `${marker()}\n${trace()}`, knowledge, revision: 'sha1', loopSlug: '218-demo' });
  assert(d.allowed === true && d.marker.packId === 'p1', '放行並解得出 pack 身分');
  assert(d.pack.claimIds.join() === 'A', '對得到那份 pack 帶了哪些事實');
  assert(d.degraded.length === 0, 'revision 對得上 ⇒ 沒有未驗到的項目');
});

testCase('CG9', 'classifyActivity 三態：repo-aware／明確不是／認不得', () => {
  assert(classifyActivity('implement') === true, 'implement 是 repo-aware');
  assert(classifyActivity('publish') === false, 'publish 明確不是');
  assert(classifyActivity('虛構動作') === null, '認不得 → null（不是「不用管」）');
  assert(classifyActivity('') === null && classifyActivity(undefined) === null, '空值 → null');
});

testCase('CG10', 'fail-open：抽不到 prompt、或 envelope 認不得，都不擋路但留下記錄', () => {
  const knowledge = knowledgeWith(claimEvent('A'), packEvent('p1', ['A']));
  assert(evaluateDispatch({ prompt: '', knowledge }).allowed === true, '沒有 prompt → 放行');
  assert(evaluateDispatch({ prompt: '一段沒有任何標記的說明', knowledge }).allowed === true, '沒有 trace envelope → 放行（那是另一道閘的職責）');
  const d = evaluateDispatch({ prompt: '一段沒有任何標記的說明', knowledge });
  assert(d.degraded.length > 0, '但記下「無法判定是否 repo-aware」');
});

testCase('CG11', 'checkPackFreshness 是純函式，pack 引用不存在的 claim 同樣擋', () => {
  const knowledge = knowledgeWith(claimEvent('A'));
  const result = checkPackFreshness({ packId: 'p1', claimIds: ['A', '幽靈'], sourceRevision: 'sha1' }, knowledge, 'sha1');
  assert(result.ok === false && result.reason.includes('不存在於事件流'), '引用了事件流裡沒有的 claim → 擋');
  const noRev = checkPackFreshness({ packId: 'p1', claimIds: ['A'], sourceRevision: NOT_MEASURED }, knowledge, 'sha1');
  assert(noRev.ok === true && noRev.degraded.length === 1, 'pack 沒記 revision → 放行但標未驗到');
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
