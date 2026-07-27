#!/usr/bin/env node
// test-telemetry-hooks.mjs —— agent-trace-guard 與 telemetry-recorder 的端到端斷言（#217 增量 2）。
// 用法（cwd = plugins/loops-workflow）：node hooks/test-telemetry-hooks.mjs
//
// 這兩支 hook 的價值全在「在對的時候擋、在對的時候完全不擋」，所以一律用 spawnSync 真的跑起來、
// 餵真的 payload、看真的 stdout 與真的落盤結果——不是 import 純函式看回傳值（那證明不了掛上去會怎樣）。
//
// 覆蓋：
//   G-*  Agent Gate：舊制 loop 完全 no-op、新制缺 envelope 才擋、帶 envelope 放行並記事件、flag 可關。
//   R-*  Recorder：主線 turn 落盤、watermark 冪等（Stop 每回合都跑，不得每次重記一遍）、
//        只處理新增量、沒有 phase trace 時寫 defect 而不是硬塞一個 phase。
//   S-*  子代理：身分取自 trace envelope；沒有 envelope 一律 unattributed，不用關鍵字猜。

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTraceEnvelope, appendPhaseTrace } from '../scripts/agent-trace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, 'agent-trace-guard.mjs');
const RECORDER = join(HERE, 'telemetry-recorder.mjs');

let passed = 0;
const failed = [];
const assert = (cond, msg) => {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed.push(msg); console.error(`  ✗ ${msg}`); }
};

const TMP = mkdtempSync(join(tmpdir(), 'loops-telemetry-hooks-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失敗不影響結果 */ } });

const SLUG = '217-demo';

/**
 * 造一個看起來像真的 repo：`.git/HEAD` 指向 loop 分支（loop-context 靠它判 slug），
 * `.loops/<slug>/loop.md` 代表這是一條已建的 loop。`newProtocol` 決定要不要建 `telemetry/`。
 */
function makeRepo(name, { newProtocol = true } = {}) {
  const root = join(TMP, name);
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), `ref: refs/heads/${SLUG}\n`);
  const loopDir = join(root, '.loops', SLUG);
  mkdirSync(loopDir, { recursive: true });
  writeFileSync(join(loopDir, 'loop.md'), '# loop\n');
  if (newProtocol) mkdirSync(join(loopDir, 'telemetry'), { recursive: true });
  return { root, loopDir };
}

const ENVELOPE = buildTraceEnvelope({
  loopSlug: SLUG,
  iteration: 0,
  workflowNode: 'verify',
  phase: 'verify',
  activity: 'review',
  agentRole: 'code-quality-reviewer',
  taskId: 'T1',
  taskSummary: '審查改動',
  dispatchId: 'd-001',
  parentAgentId: 'main',
});

function run(script, payload, env = {}) {
  return spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

/** 讀出某條 loop 的 telemetry 事件（逐行 JSON）。 */
function readEvents(loopDir) {
  const file = join(loopDir, 'telemetry', 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** 造一份主線 transcript：n 個帶 usage 的 assistant 回合。 */
function writeTranscript(path, n, { startAt = 1 } = {}) {
  const lines = [];
  for (let i = startAt; i < startAt + n; i += 1) {
    lines.push(JSON.stringify({
      type: 'assistant',
      uuid: `turn-${i}`,
      timestamp: `2026-07-27T1${i}:00:00.000Z`,
      message: {
        model: 'claude-opus-5',
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 },
      },
    }));
  }
  writeFileSync(path, `${lines.join('\n')}\n`);
}

// ── G-*：Agent Gate ─────────────────────────────────────────────────────────

console.log('▸ G-1 舊制 loop 完全不受管');
{
  const { root, loopDir } = makeRepo('g1', { newProtocol: false });
  const res = run(GUARD, { tool_name: 'Agent', tool_input: { prompt: '沒有 envelope' }, cwd: root, session_id: 's' });
  assert(res.stdout.trim() === '', '沒有 telemetry/ 的舊 loop：缺 envelope 也不擋');
  assert(!existsSync(join(loopDir, 'telemetry', 'events.jsonl')), '也不會憑空建出 telemetry ledger');
}

console.log('▸ G-2 新制 loop 缺 envelope 要擋');
{
  const { root } = makeRepo('g2');
  const res = run(GUARD, { tool_name: 'Agent', tool_input: { prompt: '請審查這份改動' }, cwd: root, session_id: 's' });
  let out = null;
  try { out = JSON.parse(res.stdout); } catch { /* 下面的斷言會報 */ }
  assert(out?.hookSpecificOutput?.permissionDecision === 'deny', 'deny 信封正確');
  assert(String(out?.hookSpecificOutput?.permissionDecisionReason ?? '').includes('loops-trace'),
    'deny 訊息告訴你要補哪一行');
}

console.log('▸ G-3 帶 envelope 放行並記下派工');
{
  const { root, loopDir } = makeRepo('g3');
  const res = run(GUARD, {
    tool_name: 'Agent',
    tool_input: { prompt: `${ENVELOPE}\n請審查……` },
    cwd: root,
    session_id: 's',
  });
  assert(res.stdout.trim() === '', '不擋');
  const events = readEvents(loopDir);
  assert(events.length === 1 && events[0].type === 'agent.dispatched', '寫下一筆 agent.dispatched');
  assert(events[0].payload.agent_role === 'code-quality-reviewer', 'role 來自 envelope');
  assert(events[0].payload.task_id === 'T1', 'task id 來自 envelope');
  assert(events[0].payload.measurement_status === 'not_measured', '派工當下沒有 usage 可言 → not_measured');
}

console.log('▸ G-4 派工重試不會記成兩筆');
{
  const { root, loopDir } = makeRepo('g4');
  const payload = { tool_name: 'Agent', tool_input: { prompt: `${ENVELOPE}\n請審查……` }, cwd: root, session_id: 's' };
  run(GUARD, payload);
  run(GUARD, payload);
  assert(readEvents(loopDir).length === 1, '同一個 dispatch id 只記一次');
}

console.log('▸ G-5 flag 關掉就完全不作用');
{
  const { root } = makeRepo('g5');
  const res = run(GUARD, { tool_name: 'Agent', tool_input: { prompt: '沒有 envelope' }, cwd: root }, { LOOPS_AGENT_TRACE_GATE: '0' });
  assert(res.stdout.trim() === '', 'LOOPS_AGENT_TRACE_GATE=0 → 不擋');
}

console.log('▸ G-6 非派工工具不受影響');
{
  const { root } = makeRepo('g6');
  const res = run(GUARD, { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: root });
  assert(res.stdout.trim() === '', '非 Agent／Task 呼叫一律放行');
}

// ── R-*：Recorder（主線）────────────────────────────────────────────────────

console.log('▸ R-1 主線回合寫進 ledger 並歸到當時的 phase');
{
  const { root, loopDir } = makeRepo('r1');
  appendPhaseTrace(loopDir, { at: '2026-07-27T10:00:00.000Z', workflowNode: 'build', phase: 'build', activity: 'implement', iteration: 0 });
  const transcript = join(TMP, 'r1-transcript.jsonl');
  writeTranscript(transcript, 2);

  run(RECORDER, { cwd: root, session_id: 's', transcript_path: transcript });
  const turns = readEvents(loopDir).filter((e) => e.type === 'usage.turn');
  assert(turns.length === 2, `兩個回合都記下（實際 ${turns.length}）`);
  assert(turns[0].payload.phase === 'build', '歸到 build');
  assert(turns[0].payload.plane === 'main', 'plane=main');
  assert(turns[0].payload.usage.output_tokens === 20, '四種 token 分開帶');
  assert(turns[0].payload.measurement_status === 'exact', '有完整 usage → exact');
}

console.log('▸ R-2 Stop 每回合都跑，但不重複記');
{
  const { root, loopDir } = makeRepo('r2');
  appendPhaseTrace(loopDir, { at: '2026-07-27T10:00:00.000Z', workflowNode: 'build', phase: 'build', activity: 'implement', iteration: 0 });
  const transcript = join(TMP, 'r2-transcript.jsonl');
  writeTranscript(transcript, 3);

  const payload = { cwd: root, session_id: 's', transcript_path: transcript };
  run(RECORDER, payload);
  run(RECORDER, payload);
  run(RECORDER, payload);
  const turns = readEvents(loopDir).filter((e) => e.type === 'usage.turn');
  assert(turns.length === 3, `跑三次仍只有 3 筆（實際 ${turns.length}）——watermark 有效`);
}

console.log('▸ R-3 只處理新增的回合');
{
  const { root, loopDir } = makeRepo('r3');
  appendPhaseTrace(loopDir, { at: '2026-07-27T10:00:00.000Z', workflowNode: 'build', phase: 'build', activity: 'implement', iteration: 0 });
  const transcript = join(TMP, 'r3-transcript.jsonl');
  writeTranscript(transcript, 2);
  const payload = { cwd: root, session_id: 's', transcript_path: transcript };
  run(RECORDER, payload);

  writeTranscript(transcript, 4); // transcript 長大了（前 2 筆內容不變）
  run(RECORDER, payload);
  const turns = readEvents(loopDir).filter((e) => e.type === 'usage.turn');
  assert(turns.length === 4, `總共 4 筆、沒有重覆前兩筆（實際 ${turns.length}）`);
}

console.log('▸ R-4 沒有 phase trace 時寫診斷、不硬塞 phase');
{
  const { root, loopDir } = makeRepo('r4');
  const transcript = join(TMP, 'r4-transcript.jsonl');
  writeTranscript(transcript, 1);
  run(RECORDER, { cwd: root, session_id: 's', transcript_path: transcript });

  const events = readEvents(loopDir);
  assert(events.length === 1 && events[0].type === 'telemetry.defect', '寫一筆 telemetry.defect');
  assert(String(events[0].payload.evidence?.reason ?? '').includes('phase trace'), '說明歸不了戶的原因');
  assert(!events.some((e) => e.type === 'usage.turn'), '不編一個 phase 把 turn 硬塞進去');
}

console.log('▸ R-5 舊制 loop 完全不受管');
{
  const { root, loopDir } = makeRepo('r5', { newProtocol: false });
  const transcript = join(TMP, 'r5-transcript.jsonl');
  writeTranscript(transcript, 2);
  run(RECORDER, { cwd: root, session_id: 's', transcript_path: transcript });
  assert(!existsSync(join(loopDir, 'telemetry', 'events.jsonl')), '不對舊 loop 產生任何檔案');
}

// ── S-*：子代理歸因 ─────────────────────────────────────────────────────────

console.log('▸ S-1 子代理身分取自 envelope、沒有就 unattributed');
{
  const { root, loopDir } = makeRepo('s1');
  appendPhaseTrace(loopDir, { at: '2026-07-27T10:00:00.000Z', workflowNode: 'verify', phase: 'verify', activity: 'review', iteration: 0 });

  const transcript = join(TMP, 's1-transcript.jsonl');
  writeTranscript(transcript, 1);
  const subDir = join(TMP, 's1-transcript', 'subagents');
  mkdirSync(subDir, { recursive: true });

  const turnLine = JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-opus-5', usage: { input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  });
  writeFileSync(join(subDir, 'agent-known.jsonl'),
    `${JSON.stringify({ type: 'user', message: { content: ENVELOPE } })}\n${turnLine}\n`);
  // 刻意含 "reviewer" 字樣：舊做法會用關鍵字把它猜成 verify reviewer。
  writeFileSync(join(subDir, 'agent-mystery.jsonl'),
    `${JSON.stringify({ type: 'user', message: { content: '你是 reviewer，請 review the diff' } })}\n${turnLine}\n`);

  run(RECORDER, { cwd: root, session_id: 's', transcript_path: transcript });

  const sub = readEvents(loopDir).filter((e) => e.payload.plane === 'subagent');
  assert(sub.length === 2, `兩個子代理各記一筆（實際 ${sub.length}）`);

  const known = sub.find((e) => e.payload.agent_id === 'agent-known');
  assert(known?.payload.agent_role === 'code-quality-reviewer', '有 envelope → 真實 role');
  assert(known?.payload.task_id === 'T1', '有 envelope → 真實 task id');

  const mystery = sub.find((e) => String(e.payload.agent_id).startsWith('unattributed:'));
  assert(mystery?.payload.agent_id === 'unattributed:agent-mystery', '沒有 envelope → unattributed:<runtime-id>');
  assert(mystery?.payload.agent_role !== 'code-quality-reviewer', '不用關鍵字猜出一個角色');
  assert(!readEvents(loopDir).some((e) => JSON.stringify(e).includes('other-subagent')), '整份 ledger 不出現 other-subagent');
}

// ── 收尾 ────────────────────────────────────────────────────────────────────

console.log(`\n${failed.length ? '✗' : '✓'} telemetry-hooks：${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.error(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
