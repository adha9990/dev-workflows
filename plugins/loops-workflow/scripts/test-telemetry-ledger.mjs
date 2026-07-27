#!/usr/bin/env node
// test-telemetry-ledger.mjs —— telemetry-ledger.mjs 的契約斷言（#217 增量 2）。
// 用法：node test-telemetry-ledger.mjs [--filter <case-id>] [--min-cases <n>]
//
// 覆蓋：
//   H-*  harness 自檢（模組不存在時仍全綠）。
//   L-*  落點：telemetry/events.jsonl 是獨立的一份檔，與既有 events.jsonl 互不污染。
//   S-*  事件形狀：共用欄位齊全、值域、禁止 other-subagent、四種 token 不得混成一個。
//   I-*  身分與冪等：event_id 由穩定 identity + nonce deterministic 產生；hook retry 不重複追加。
//   U-*  誠實邊界：沒有 usage 就是 not_measured，不用比例或關鍵字補成 exact；tool bytes ≠ token。
//   A-*  歸因：還原不出身分時只能 unattributed:<runtime-id> 且必須附 reason 與 evidence。
//
// 落點紀律：暫存檔一律開在 os.tmpdir()，絕不在 worktree／repo 內建立 .loops/。

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = join(HERE, 'telemetry-ledger.mjs');

// ── 極簡 harness ─────────────────────────────────────────────────────────────
let passed = 0;
const failed = [];
const cases = [];
const testCase = (id, name, fn) => cases.push({ id, name, fn });

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed.push(msg); console.error(`  ✗ ${msg}`); }
}

function parseArgs(argv) {
  const opts = { filter: '', minCases: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--filter') opts.filter = argv[++i] ?? '';
    else if (argv[i] === '--min-cases') opts.minCases = Number(argv[++i] ?? 0);
  }
  return opts;
}
const matchesFilter = (id, f) => !f || id === f || id.startsWith(`${f}-`);

let M = null;
let TMP = '';

/** 造一個乾淨的 loop 目錄（含 .loops/<slug>/），回絕對路徑。 */
function makeLoopDir(name) {
  const dir = join(TMP, name, '.loops', 'demo-loop');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 一筆最小合法事件（共用欄位齊全）。 */
function baseEvent(patch = {}) {
  return {
    event_type: 'usage.turn',
    occurred_at: '2026-07-27T00:00:00.000Z',
    harness: 'claude',
    loop_slug: 'demo-loop',
    session_id: 'sess-1',
    iteration: 0,
    plane: 'main',
    workflow_node: 'build',
    phase: 'build',
    activity: 'implement',
    agent_id: 'main',
    parent_agent_id: null,
    agent_role: 'orchestrator',
    task_id: 'T1',
    task_summary: '實作 telemetry ledger',
    model: 'claude-opus-5',
    effort: 'medium',
    turn_id: 'turn-1',
    measurement_status: 'exact',
    evidence: { source: 'transcript', locator: 'line:42' },
    usage: { input_tokens: 10, output_tokens: 20, cache_creation_tokens: 5, cache_read_tokens: 1, duration_ms: 1200, usd: 0.01 },
    ...patch,
  };
}

// ── H-* ─────────────────────────────────────────────────────────────────────

testCase('H-1', 'harness 自身可運作', () => {
  assert(true, 'assert 能通過');
  assert(typeof existsSync(MODULE_PATH) === 'boolean', '模組存在與否可判斷');
});

// ── L-*：落點 ────────────────────────────────────────────────────────────────

testCase('L-1', 'telemetryPath 固定為 telemetry/events.jsonl', () => {
  const p = M.telemetryPath('/x/.loops/demo');
  assert(p.replace(/\\/g, '/').endsWith('.loops/demo/telemetry/events.jsonl'), `落點為 telemetry/events.jsonl（實際 ${p}）`);
});

testCase('L-2', 'append 會自建 telemetry/ 目錄並寫得回來', () => {
  const dir = makeLoopDir('l2');
  const written = M.appendTelemetryEvent(dir, baseEvent());
  assert(existsSync(M.telemetryPath(dir)), 'telemetry/events.jsonl 已建立');
  const { events } = M.readTelemetryEvents(dir);
  assert(events.length === 1, '讀得回一筆');
  assert(events[0].payload.phase === 'build', 'phase 欄位保存');
  assert(events[0].payload.usage.output_tokens === 20, 'output_tokens 保存');
  assert(written.id === events[0].id, 'append 回傳的就是實際寫出去的那筆');
});

testCase('L-3', '與既有 events.jsonl 互不污染', () => {
  const dir = makeLoopDir('l3');
  // 既有的 workflow 事件流：telemetry 不得寫進去，也不得讀它當自己的資料。
  writeFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({ v: 1, id: 'w1', seq: 1, type: 'stage-enter', payload: { stage: 'build' } })}\n`);
  M.appendTelemetryEvent(dir, baseEvent());

  const workflow = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
  assert(workflow.length === 1, 'workflow 事件流沒有被 telemetry 追加（仍是 1 行）');
  const { events } = M.readTelemetryEvents(dir);
  assert(events.length === 1 && events[0].type === 'usage.turn', 'telemetry 只讀到自己的事件');
});

// ── S-*：事件形狀 ────────────────────────────────────────────────────────────

testCase('S-1', '共用欄位齊全的事件通過檢查', () => {
  const problem = M.checkTelemetryEvent(baseEvent());
  if (problem) console.error(`     · ${problem.reason}`);
  assert(problem === null, '最小合法事件通過');
});

testCase('S-2', '缺共用欄位被指名', () => {
  for (const field of ['event_type', 'occurred_at', 'harness', 'loop_slug', 'phase', 'activity', 'measurement_status']) {
    const e = baseEvent();
    delete e[field];
    const problem = M.checkTelemetryEvent(e);
    assert(problem !== null && String(problem.reason).includes(field), `缺 ${field} → 被指名`);
  }
});

testCase('S-3', 'measurement_status 只能是三個值', () => {
  assert(M.checkTelemetryEvent(baseEvent({ measurement_status: 'exact' })) === null, 'exact 合法');
  assert(M.checkTelemetryEvent(baseEvent({ measurement_status: 'estimated' })) === null, 'estimated 合法');
  assert(M.checkTelemetryEvent(baseEvent({ measurement_status: 'not_measured', usage: null })) === null, 'not_measured 合法');
  assert(M.checkTelemetryEvent(baseEvent({ measurement_status: 'probably' })) !== null, '值域外一律拒絕');
});

testCase('S-4', 'event_type 必須是登記過的型別', () => {
  assert(M.checkTelemetryEvent(baseEvent({ event_type: 'agent.dispatched' })) === null, 'agent.dispatched 合法');
  assert(M.checkTelemetryEvent(baseEvent({ event_type: 'quality.finding-emitted' })) === null, 'quality.finding-emitted 合法');
  assert(M.checkTelemetryEvent(baseEvent({ event_type: 'made.up' })) !== null, '沒登記的型別拒絕（否則 cost 報表會靜默漏掉一整類）');
});

testCase('S-5', 'other-subagent 一律拒絕', () => {
  assert(M.checkTelemetryEvent(baseEvent({ agent_id: 'other-subagent' })) !== null, 'agent_id 不得是 other-subagent');
  assert(M.checkTelemetryEvent(baseEvent({ agent_role: 'other-subagent' })) !== null, 'agent_role 不得是 other-subagent');
});

testCase('S-6', '四種 token 分開記錄、不得混成一個沒有語意的總和', () => {
  const merged = baseEvent({ usage: { total_tokens: 36, duration_ms: 1 } });
  const problem = M.checkTelemetryEvent(merged);
  assert(problem !== null && /total_tokens|四種|分開/.test(String(problem.reason)),
    '只給 total_tokens → 拒絕（混合總和無法回答錢花在哪）');

  const partial = baseEvent({ usage: { input_tokens: 1, output_tokens: 2 } });
  assert(M.checkTelemetryEvent(partial) !== null, 'exact 卻缺 cache 兩欄 → 拒絕（缺的欄位要自己標 not_measured，不是省略）');
});

// ── I-*：身分與冪等 ─────────────────────────────────────────────────────────

testCase('I-1', 'event_id 由穩定 identity + nonce deterministic 產生', () => {
  const a = M.makeEventId({ eventType: 'usage.turn', loopSlug: 'x', sessionId: 's', identity: 'turn-1', nonce: 'n1' });
  const b = M.makeEventId({ eventType: 'usage.turn', loopSlug: 'x', sessionId: 's', identity: 'turn-1', nonce: 'n1' });
  assert(a === b && typeof a === 'string' && a.length >= 16, '同輸入 → 同 id（可重跑、可比對）');
});

testCase('I-2', '不同 identity 或 nonce → 不同 id', () => {
  const base = { eventType: 'usage.turn', loopSlug: 'x', sessionId: 's', identity: 'turn-1', nonce: 'n1' };
  assert(M.makeEventId(base) !== M.makeEventId({ ...base, identity: 'turn-2' }), 'identity 不同 → id 不同');
  assert(M.makeEventId(base) !== M.makeEventId({ ...base, nonce: 'n2' }), 'nonce 不同 → id 不同');
  assert(M.makeEventId(base) !== M.makeEventId({ ...base, eventType: 'agent.started' }), 'event_type 不同 → id 不同');
});

testCase('I-3', 'hook retry 不重複追加同一 logical event', () => {
  const dir = makeLoopDir('i3');
  const e = baseEvent({ event_nonce: 'fixed-nonce' });
  const first = M.appendTelemetryEvent(dir, e);
  const second = M.appendTelemetryEvent(dir, e); // 完全相同的一筆：模擬 hook 被重試

  const lines = readFileSync(M.telemetryPath(dir), 'utf8').trim().split('\n');
  assert(lines.length === 1, `重試不追加第二行（實際 ${lines.length} 行）`);
  assert(second?.duplicate === true, '第二次呼叫明確回報這是重複，不是靜默吞掉');
  assert(first.id === second.id, '兩次的 event_id 相同');
});

testCase('I-4', '確實不同的兩筆事件都會寫入', () => {
  const dir = makeLoopDir('i4');
  M.appendTelemetryEvent(dir, baseEvent({ turn_id: 'turn-1', event_nonce: 'a' }));
  M.appendTelemetryEvent(dir, baseEvent({ turn_id: 'turn-2', event_nonce: 'b' }));
  const { events } = M.readTelemetryEvents(dir);
  assert(events.length === 2, '兩筆都在（去重不得誤殺真正不同的事件）');
});

testCase('I-5', 'replay 對重複 id 冪等', () => {
  const dir = makeLoopDir('i5');
  const written = M.appendTelemetryEvent(dir, baseEvent({ event_nonce: 'z' }));
  // 繞過 append 的去重、直接手工塞一行重複的（模擬併發寫者各自寫出同一 logical event）
  const raw = readFileSync(M.telemetryPath(dir), 'utf8');
  writeFileSync(M.telemetryPath(dir), raw + raw);

  const { events, duplicates } = M.readTelemetryEvents(dir);
  assert(duplicates.length === 1, '重複被回報，不是靜默吞掉');
  const summary = M.summarizeUsage(events);
  assert(summary.output_tokens === 20, `重複的那筆不得被算兩次（實際 ${summary.output_tokens}）`);
  assert(written.id === events[0].id, 'id 一致');
});

// ── U-*：誠實邊界 ───────────────────────────────────────────────────────────

testCase('U-1', 'normalizeUsage 把四種 token 分開帶出', () => {
  const u = M.normalizeUsage({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 });
  assert(u.measurement_status === 'exact', '有完整 usage → exact');
  assert(u.usage.input_tokens === 1 && u.usage.output_tokens === 2, 'input／output 保留');
  assert(u.usage.cache_creation_tokens === 3 && u.usage.cache_read_tokens === 4, 'cache 兩欄各自保留');
});

testCase('U-2', '沒有 usage 一律 not_measured、不猜數字', () => {
  const u = M.normalizeUsage(null);
  assert(u.measurement_status === 'not_measured', '沒有 usage → not_measured');
  assert(u.usage === null, '不編一組 0 或比例推估值假裝量到了');
  assert(typeof u.reason === 'string' && u.reason.length > 0, '附上為什麼量不到');
});

testCase('U-3', 'tool 的 bytes 不得冒充精確 token', () => {
  const t = M.normalizeToolFootprint({ name: 'Read', input_bytes: 100, output_bytes: 4000, duration_ms: 12 });
  assert(t.input_bytes === 100 && t.output_bytes === 4000, 'bytes 原樣保留');
  assert(t.context_tokens_measurement === 'estimated', 'context token 一律標 estimated');
  assert(t.measurement_status !== 'exact', 'tool footprint 整體不得宣稱 exact');
});

// ── A-*：歸因 ───────────────────────────────────────────────────────────────

testCase('A-1', 'unattributed 必須帶 runtime id、reason 與 evidence', () => {
  const ok = M.makeUnattributedAgent({ runtimeId: 'agent-9f', reason: 'SubagentStop 沒有帶 identity', evidence: { transcript: 'agent-9f.jsonl' } });
  assert(ok.agent_id === 'unattributed:agent-9f', 'agent_id 形狀為 unattributed:<runtime-id>');
  assert(M.checkTelemetryEvent(baseEvent({ ...ok, measurement_status: 'not_measured', usage: null })) === null, '合法的 unattributed 事件可以寫入');
});

testCase('A-2', '缺 reason 或 evidence 的 unattributed 一律拒絕', () => {
  assert(M.checkTelemetryEvent(baseEvent({ agent_id: 'unattributed:x', measurement_status: 'not_measured', usage: null, evidence: null })) !== null,
    '沒有 evidence 就不准寫成 unattributed（那等於把「不知道」偽裝成一筆有內容的紀錄）');
});

testCase('A-3', '連 loop context 都沒有時不得捏造 loop attribution', () => {
  const d = M.makeTelemetryDefect({ reason: '沒有 active loop context', evidence: { session: 's-1' } });
  assert(d.event_type === 'telemetry.defect', '改寫成 telemetry defect diagnostic');
  assert(d.loop_slug === null, 'loop_slug 保持 null，不硬塞一條 loop');
});

testCase('A-4', 'telemetry.defect 不被共用必填欄位擋住，但必須說明原因', () => {
  const d = { ...M.makeTelemetryDefect({ reason: '沒有 phase trace，無法歸因' }), occurred_at: '2026-07-27T00:00:00.000Z', harness: 'claude' };
  assert(M.checkTelemetryEvent(d) === null, '缺 phase／agent 等欄位仍可寫入（那正是它要記的事）');

  const noReason = { ...d, evidence: {} };
  assert(M.checkTelemetryEvent(noReason) !== null, '沒有 evidence.reason 的 defect 一律拒絕（自己也不可追查）');
});

testCase('A-5', 'defect 可寫入 ledger 且與一般事件並存', () => {
  const dir = makeLoopDir('a5');
  M.appendTelemetryEvent(dir, baseEvent());
  M.appendTelemetryEvent(dir, {
    ...M.makeTelemetryDefect({ reason: '主線 turn 沒有 timestamp，無法接回當時的 phase' }),
    occurred_at: '2026-07-27T00:00:01.000Z',
    harness: 'claude',
    event_nonce: 'defect-1',
  });
  const { events } = M.readTelemetryEvents(dir);
  assert(events.length === 2, '兩筆並存');
  assert(M.summarizeUsage(events).output_tokens === 20, 'defect 不影響 usage 加總');
});

// ── 執行 ────────────────────────────────────────────────────────────────────

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  TMP = mkdtempSync(join(tmpdir(), 'loops-telemetry-'));
  process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失敗不影響結果 */ } });

  try {
    M = await import(pathToFileURL(MODULE_PATH).href);
  } catch (err) {
    M = null;
    console.log(`（受測模組尚未存在或載入失敗：${err?.message ?? err}）\n`);
  }

  let ran = 0;
  for (const c of cases) {
    if (!matchesFilter(c.id, opts.filter)) continue;
    if (!M && !c.id.startsWith('H-')) {
      failed.push(`${c.id} ${c.name}：受測模組載入失敗`);
      console.error(`✗ ${c.id} ${c.name}：受測模組載入失敗`);
      ran += 1;
      continue;
    }
    console.log(`▸ ${c.id} ${c.name}`);
    try { c.fn(); } catch (err) {
      failed.push(`${c.id} ${c.name}：拋出例外 ${err?.message ?? err}`);
      console.error(`  ✗ 拋出例外：${err?.stack ?? err}`);
    }
    ran += 1;
  }

  if (opts.minCases && ran < opts.minCases) {
    console.error(`\n✗ 只跑到 ${ran} 個 case，少於下限 ${opts.minCases}`);
    process.exit(1);
  }

  console.log(`\n${failed.length ? '✗' : '✓'} telemetry-ledger：${passed} 個斷言通過、${failed.length} 個失敗（${ran} cases）`);
  if (failed.length) {
    for (const f of failed) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

run();
