#!/usr/bin/env node
// test-context-pack-guard.mjs —— Context Pack Gate 掛上去之後的端到端斷言（#218）。
// 用法（cwd = plugins/loops-workflow）：node hooks/test-context-pack-guard.mjs
//
// 這支 hook 的價值全在「在對的時候擋、在對的時候完全不擋」，所以一律用 spawnSync 真的跑起來、
// 餵真的 payload、看真的 stdout 與真的落盤結果——import 純函式看回傳值證明不了掛上去會怎樣
// （沿用 test-telemetry-hooks.mjs 的做法）。
//
// 覆蓋：
//   N-*  完全不管的情形：非派工、舊制 loop、沒用過共享記憶的 loop、flag 關掉。
//   D-*  該擋的情形：repo-aware 卻沒 pack、pack 沒登記過、pack 引用已失效的事實。
//   A-*  該放行的情形：pack 齊全 → 放行並記下「這份 pack 被誰用掉了」。

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTraceEnvelope } from '../scripts/agent-trace.mjs';
import { digestOf, appendClaim, appendPackBuilt, appendInvalidated, buildPackMarker, readKnowledge } from '../scripts/knowledge-ledger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, 'context-pack-guard.mjs');

let passed = 0;
const failed = [];
const assert = (cond, msg) => {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed.push(msg); console.error(`  ✗ ${msg}`); }
};

const TMP = mkdtempSync(join(tmpdir(), 'loops-context-gate-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失敗不影響結果 */ } });

const SLUG = '218-demo';
const REVISION = 'a'.repeat(40);
const PACK_ID = 'pack0000000000000000000000000001';

/** 造一個看起來像真的 repo：`.git/HEAD` 指向 loop 分支、`.loops/<slug>/loop.md` 代表已建的 loop。 */
function makeRepo(name, { newProtocol = true, withKnowledge = true, staleClaim = false } = {}) {
  const root = join(TMP, name);
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), `ref: refs/heads/${SLUG}\n`);
  writeFileSync(join(root, '.git', 'refs', 'heads', SLUG), `${REVISION}\n`);
  const loopDir = join(root, '.loops', SLUG);
  mkdirSync(loopDir, { recursive: true });
  writeFileSync(join(loopDir, 'loop.md'), '# loop\n');
  if (newProtocol) mkdirSync(join(loopDir, 'telemetry'), { recursive: true });

  if (withKnowledge) {
    appendClaim(loopDir, {
      claim_id: 'K1', kind: 'architecture', statement: 'route 只透過 viewmodel 取資料',
      scope: { files: ['client/**'], symbols: [] },
      sources: [{ type: 'repo-file', locator: 'client/AGENTS.md', digest: digestOf('內容') }],
      confidence: 'verified', validity: 'valid',
      created_by: { phase: 'explore', agent_role: 'explore' }, created_at_revision: REVISION,
    });
    appendPackBuilt(loopDir, {
      packId: PACK_ID, role: 'impl-author', phase: 'build', taskId: 'T1',
      claimIds: ['K1'], tokensEstimated: 100, budget: 4000, overBudget: false,
      sourceRevision: REVISION, independence: 'quality-conclusion',
    });
    if (staleClaim) appendInvalidated(loopDir, { claimId: 'K1', validity: 'invalid', reason: '來源改了' });
  }
  return { root, loopDir };
}

const envelope = (activity = 'implement') => buildTraceEnvelope({
  loopSlug: SLUG, iteration: 0, workflowNode: 'build', phase: 'build', activity,
  agentRole: 'impl-author', taskId: 'T1', taskSummary: '做 T1', dispatchId: 'd-001', parentAgentId: 'main',
});
const marker = (packId = PACK_ID) => buildPackMarker({
  packId, loopSlug: SLUG, role: 'impl-author', taskId: 'T1', sourceRevision: REVISION, independence: 'quality-conclusion',
});

function run(root, prompt, { toolName = 'Task', env = {} } = {}) {
  return spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: toolName, cwd: root, session_id: 'S1', tool_input: { prompt, subagent_type: 'impl-author' } }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}
const denied = (res) => res.stdout.includes('deny') || res.stdout.includes('Deny') || res.stdout.includes('permissionDecision');

// ── N：完全不管的情形 ────────────────────────────────────────────────────────
console.log('\n[N] 作用範圍：不該管的一律 no-op');
{
  const { root } = makeRepo('n1');
  const res = run(root, `${envelope()}\n沒有 pack`, { toolName: 'Read' });
  assert(res.status === 0 && res.stdout.trim() === '', '不是 agent 派工 → 完全沉默');
}
{
  const { root } = makeRepo('n2', { newProtocol: false });
  const res = run(root, `${envelope()}\n沒有 pack`);
  assert(res.stdout.trim() === '', '舊制 loop（沒有 telemetry/）→ 完全不受管');
}
{
  const { root } = makeRepo('n3', { withKnowledge: false });
  const res = run(root, `${envelope()}\n沒有 pack`);
  assert(res.stdout.trim() === '', '這條 loop 從沒用過共享記憶 → 不要求 pack');
}
{
  const { root } = makeRepo('n4');
  const res = run(root, `${envelope()}\n沒有 pack`, { env: { LOOPS_CONTEXT_PACK_GATE: '0' } });
  assert(res.stdout.trim() === '', 'flag 關掉 → 完全沉默（逃生口存在）');
}
{
  const { root } = makeRepo('n5');
  const res = run(root, `${envelope('publish')}\n沒有 pack`);
  assert(res.stdout.trim() === '', '非 repo-aware 的 activity（publish）→ 不要求 pack');
}
{
  const res = run(join(TMP, '不存在的目錄'), `${envelope()}\n沒有 pack`);
  assert(res.status === 0 && res.stdout.trim() === '', '解不出 loop → 放行（hook 不因判不出來而擋路）');
}

// ── D：該擋的情形 ───────────────────────────────────────────────────────────
console.log('\n[D] 可證明的違規才擋');
{
  const { root } = makeRepo('d1');
  const res = run(root, `${envelope()}\n這次派工沒有帶 pack`);
  assert(denied(res), 'repo-aware 卻沒帶 pack → 擋');
  assert(res.stdout.includes('loops-pack'), '訊息附上 marker 的正確形狀');
  assert(res.status === 0, 'hook 自己一律 exit 0（決策走輸出信封，不是 exit code）');
}
{
  const { root } = makeRepo('d2');
  const res = run(root, `${marker('pack-手打的-id')}\n${envelope()}`);
  assert(denied(res), '事件流裡沒登記過的 pack → 擋（手打的 marker 不算數）');
}
{
  const { root } = makeRepo('d3', { staleClaim: true });
  const res = run(root, `${marker()}\n${envelope()}`);
  assert(denied(res), 'pack 引用的事實已失效 → 擋（Invalidation Gate）');
  assert(res.stdout.includes('K1'), '指名是哪一條事實');
}

// ── A：該放行的情形 ─────────────────────────────────────────────────────────
console.log('\n[A] 齊全就放行，並留下「這份 pack 被誰用掉了」');
{
  const { root, loopDir } = makeRepo('a1');
  const res = run(root, `${marker()}\n${envelope()}`);
  assert(!denied(res), 'pack 齊全、revision 對得上 → 放行');
  const state = readKnowledge(loopDir).state;
  const pack = state.packs.find((p) => p.packId === PACK_ID);
  assert(pack.consumedBy.length === 1 && pack.consumedBy[0].agentRole === 'impl-author', 'pack 的實際取用有被記下來（重用率才量得出來）');
  assert(existsSync(join(loopDir, 'events.jsonl')), '記錄寫回同一份事件流，沒有第二套資料庫');
  const types = readFileSync(join(loopDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
  assert(types.includes('context-pack.consumed'), '記了「這份 pack 被派出去了」');
  assert(types.filter((t) => t === 'knowledge.consumed').length === 1, '逐條記了「哪幾條事實被這個 agent 用掉」（量到的是實際重用，不是理論上可重用）');
  assert(state.consumption[0].claimId === 'K1' && state.consumption[0].agentRole === 'impl-author', '哪個角色用了哪條事實查得出來');
}
{
  // 觀測失敗不得擋路：把事件流改成唯讀情境不好造，改用「pack 已被別人用過」確認重覆記錄不影響放行。
  const { root } = makeRepo('a2');
  const first = run(root, `${marker()}\n${envelope()}`);
  const second = run(root, `${marker()}\n${envelope()}`);
  assert(!denied(first) && !denied(second), '同一份 pack 再派一次仍放行（重用本來就是目的）');
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.error('\n失敗清單：'); for (const m of failed) console.error(`  - ${m}`); process.exit(1); }
process.exit(0);
