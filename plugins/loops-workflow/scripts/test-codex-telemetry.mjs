#!/usr/bin/env node
// test-codex-telemetry.mjs —— Codex telemetry adapter 與 capability probe 的契約斷言（#217 增量 4）。
// 用法：node test-codex-telemetry.mjs [--filter <case-id>] [--min-cases <n>]
//
// 覆蓋：
//   H-*  harness 自檢。
//   C-*  capability probe：五種能力**分別**量測（不用 token 能力推論其他能力）、
//        report 帶版本／evidence 欄位／來源行號／unavailable reason。
//   M-*  adapter mode：per-turn usage → exact；只有累計值 → estimated/cumulative-delta；
//        沒有 usage evidence → not_measured。**絕不用比例或猜測補成 exact。**
//   N-*  normalization：Codex 的原始形狀 → canonical 事件，四種 token 分開、缺的標 null。
//   P-*  parity：Claude 與 Codex 對同一份 canonical fixture 產生**相同的 schema**，
//        差異只反映在 capability evidence 與 measurement status，不出現第二套 taxonomy。

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = join(HERE, 'codex-telemetry.mjs');

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
let TL = null;
let TMP = '';

// ── H-* ─────────────────────────────────────────────────────────────────────

testCase('H-1', 'harness 自身可運作', () => {
  assert(true, 'assert 能通過');
  assert(typeof existsSync(MODULE_PATH) === 'boolean', '模組存在與否可判斷');
});

// ── C-*：capability probe ───────────────────────────────────────────────────

testCase('C-1', 'probe 是 non-mutating 的：沒有 runtime 也不會失敗、不改任何狀態', () => {
  const report = M.probeCapabilities({ runtime: null });
  assert(report.available === false, '沒有 Codex runtime → available:false');
  assert(report.mode === 'not_measured', 'adapter mode 為 not_measured');
  assert(typeof report.unavailable_reason === 'string' && report.unavailable_reason.length > 0,
    '說明為什麼量不到（不是留空讓人以為量過了）');
});

testCase('C-2', '五種能力分別量測，不互相推論', () => {
  // 只提供 per-turn usage：不得因此推論出 agent identity 或 tool fields 也可用。
  const report = M.probeCapabilities({
    runtime: { version: 'codex-x.y', sample: { usage: { input_tokens: 1, output_tokens: 2, cache_creation_tokens: 0, cache_read_tokens: 0 } } },
  });
  assert(report.capabilities.per_turn_usage.status === 'supported', 'per-turn usage 量到 → supported');
  for (const facet of ['agent_identity', 'parent_identity', 'tool_fields', 'transcript_locator']) {
    assert(report.capabilities[facet].status === 'not_measured',
      `${facet} 沒有證據 → not_measured（不得用 token 能力推論其他能力）`);
    assert(typeof report.capabilities[facet].unavailable_reason === 'string' && report.capabilities[facet].unavailable_reason.length > 0,
      `${facet} 附上量不到的原因`);
  }
});

testCase('C-3', 'report 記錄版本、evidence 欄位與來源行號', () => {
  const report = M.probeCapabilities({
    runtime: {
      version: 'codex-1.2.3',
      sample: {
        usage: { input_tokens: 1, output_tokens: 2, cache_creation_tokens: 0, cache_read_tokens: 0 },
        agent_id: 'a-1',
        source_line: 42,
      },
    },
  });
  assert(report.runtime_version === 'codex-1.2.3', '記錄 runtime 版本');
  const ev = report.capabilities.per_turn_usage.evidence;
  assert(Array.isArray(ev.fields) && ev.fields.includes('input_tokens'), 'evidence 列出實際看到的欄位');
  assert(ev.source_line === 42, '記錄來源行號（事後可回頭核對）');
});

// ── M-*：adapter mode ───────────────────────────────────────────────────────

testCase('M-1', '直接提供 per-turn usage → exact', () => {
  const r = M.decideMode({ perTurnUsage: true, cumulativeCounters: false });
  assert(r.mode === 'exact', 'exact');
});

testCase('M-2', '只有累計值 → estimated/cumulative-delta', () => {
  const r = M.decideMode({ perTurnUsage: false, cumulativeCounters: true });
  assert(r.mode === 'estimated', 'measurement_status 為 estimated');
  assert(r.strategy === 'cumulative-delta', '策略明寫為 cumulative-delta（讀的人要知道數字怎麼來的）');
});

testCase('M-3', '沒有任何 usage evidence → not_measured', () => {
  const r = M.decideMode({ perTurnUsage: false, cumulativeCounters: false });
  assert(r.mode === 'not_measured', 'not_measured');
  assert(r.strategy === null, '沒有可用策略時不編一個出來');
});

testCase('M-4', 'cumulative-delta 由相鄰兩次快照相減，首筆不猜', () => {
  const deltas = M.cumulativeDeltas([
    { input_tokens: 10, output_tokens: 5, cache_creation_tokens: 0, cache_read_tokens: 0 },
    { input_tokens: 25, output_tokens: 12, cache_creation_tokens: 0, cache_read_tokens: 0 },
    { input_tokens: 30, output_tokens: 20, cache_creation_tokens: 0, cache_read_tokens: 0 },
  ]);
  assert(deltas.length === 2, `n 個累計快照只能推出 n-1 個 delta（實際 ${deltas.length}）——首筆之前沒有基準，不得把它當成一個 turn`);
  assert(deltas[0].input_tokens === 15 && deltas[0].output_tokens === 7, '第一個 delta 正確');
  assert(deltas[1].input_tokens === 5 && deltas[1].output_tokens === 8, '第二個 delta 正確');
  assert(deltas.every((d) => d.measurement_status === 'estimated'), '每筆都標 estimated，不冒充 exact');
});

testCase('M-5', '累計值倒退（重置／換 session）不產生負數', () => {
  const deltas = M.cumulativeDeltas([
    { input_tokens: 100, output_tokens: 50, cache_creation_tokens: 0, cache_read_tokens: 0 },
    { input_tokens: 10, output_tokens: 5, cache_creation_tokens: 0, cache_read_tokens: 0 },
  ]);
  assert(deltas.length === 1, '仍產出一筆');
  assert(deltas[0].input_tokens === null && deltas[0].measurement_status === 'not_measured',
    '倒退代表基準換了，這一段量不到——標 not_measured，不是記成負數也不是當成 0');
  assert(typeof deltas[0].reason === 'string' && deltas[0].reason.length > 0, '附上原因');
});

// ── N-*：normalization ──────────────────────────────────────────────────────

testCase('N-1', 'Codex 原始 usage → canonical 四欄', () => {
  const u = M.normalizeCodexUsage({ input_tokens: 3, output_tokens: 4, cached_input_tokens: 5 });
  assert(u.usage.input_tokens === 3 && u.usage.output_tokens === 4, 'input／output 對應');
  assert(u.usage.cache_read_tokens === 5, 'Codex 的 cached_input_tokens 對應到 cache_read_tokens');
  assert(u.usage.cache_creation_tokens === null, '沒有的欄位是 null，不補 0');
  assert(u.measurement_status === 'estimated', '有缺欄 → estimated（不是 exact）');
});

testCase('N-2', '完全沒有 usage → not_measured 且不編數字', () => {
  const u = M.normalizeCodexUsage(null);
  assert(u.measurement_status === 'not_measured' && u.usage === null, '不編一組 0 假裝量到了');
});

testCase('N-3', '產出的事件通過 canonical ledger 的形狀檢查', () => {
  const event = M.toCanonicalEvent({
    runtimeTurn: { turn_id: 't1', usage: { input_tokens: 1, output_tokens: 2, cache_creation_tokens: 0, cache_read_tokens: 0 } },
    context: {
      loop_slug: 'demo', session_id: 's', iteration: 0, plane: 'main',
      workflow_node: 'build', phase: 'build', activity: 'implement',
      agent_id: 'main', agent_role: 'orchestrator',
    },
    occurredAt: '2026-07-27T00:00:00.000Z',
  });
  const problem = TL.checkTelemetryEvent(event);
  if (problem) console.error(`     · ${problem.reason}`);
  assert(problem === null, 'Codex 產的事件與 Claude 產的走同一套 schema 檢查');
  assert(event.harness === 'codex', 'harness 欄位標明來源');
});

testCase('N-4', '身分還原不出來時只能 unattributed，不猜', () => {
  const event = M.toCanonicalEvent({
    runtimeTurn: { turn_id: 't1', usage: null, runtime_id: 'proc-9' },
    context: {
      loop_slug: 'demo', session_id: 's', iteration: 0, plane: 'subagent',
      workflow_node: 'verify', phase: 'verify', activity: 'review',
      agent_id: null, agent_role: null,
    },
    occurredAt: '2026-07-27T00:00:00.000Z',
  });
  assert(String(event.agent_id).startsWith('unattributed:'), 'agent_id 降級成 unattributed:<runtime-id>');
  assert(event.measurement_status === 'not_measured', '沒有 usage → not_measured');
  assert(TL.checkTelemetryEvent(event) === null, '仍是一筆合法事件（帶了 reason 與 evidence）');
});

// ── P-*：parity ─────────────────────────────────────────────────────────────

testCase('P-1', '兩個 harness 對同一份 fixture 產出相同的欄位集合', () => {
  const fixture = {
    turn_id: 't1',
    usage: { input_tokens: 10, output_tokens: 20, cache_creation_tokens: 1, cache_read_tokens: 2 },
  };
  const context = {
    loop_slug: 'demo', session_id: 's', iteration: 0, plane: 'main',
    workflow_node: 'build', phase: 'build', activity: 'implement',
    agent_id: 'main', agent_role: 'orchestrator',
  };
  const codex = M.toCanonicalEvent({ runtimeTurn: fixture, context, occurredAt: '2026-07-27T00:00:00.000Z' });
  const claude = M.toCanonicalEvent({ runtimeTurn: fixture, context, occurredAt: '2026-07-27T00:00:00.000Z', harness: 'claude' });

  const keys = (o) => Object.keys(o).sort().join(',');
  assert(keys(codex) === keys(claude), '欄位集合完全相同（不出現第二套 schema）');
  assert(codex.harness !== claude.harness, '差異只在 harness 欄位');
  assert(keys(codex.usage) === keys(claude.usage), 'usage 的欄位集合也相同');
});

testCase('P-2', 'workflow taxonomy 只有一份（取自 canonical vocabulary）', () => {
  const v = M.vocabularyFacts();
  assert(v.phases.includes('build') && v.phases.includes('finalize'), 'phase 來自 canonical vocabulary');
  assert(!v.phases.includes('iterate'), 'Codex 端同樣不把 iterate 當 phase');
  assert(v.controlNodes.includes('iteration-controller'), 'control node 一致');
});

testCase('P-3', 'capability 差異不改變 schema、只改變 measurement status', () => {
  const context = {
    loop_slug: 'demo', session_id: 's', iteration: 0, plane: 'main',
    workflow_node: 'build', phase: 'build', activity: 'implement',
    agent_id: 'main', agent_role: 'orchestrator',
  };
  const exact = M.toCanonicalEvent({ runtimeTurn: { turn_id: 't1', usage: { input_tokens: 1, output_tokens: 1, cache_creation_tokens: 1, cache_read_tokens: 1 } }, context, occurredAt: '2026-07-27T00:00:00.000Z' });
  const degraded = M.toCanonicalEvent({ runtimeTurn: { turn_id: 't1', usage: null }, context, occurredAt: '2026-07-27T00:00:00.000Z' });
  const keys = (o) => Object.keys(o).sort().join(',');
  assert(keys(exact) === keys(degraded), '降級不減少欄位（少欄位＝下游要寫兩套讀法）');
  assert(exact.measurement_status === 'exact' && degraded.measurement_status === 'not_measured', '差異只在 measurement_status');
});

// ── 執行 ────────────────────────────────────────────────────────────────────

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  TMP = mkdtempSync(join(tmpdir(), 'loops-codex-'));
  process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失敗不影響結果 */ } });

  try {
    M = await import(pathToFileURL(MODULE_PATH).href);
    TL = await import(pathToFileURL(join(HERE, 'telemetry-ledger.mjs')).href);
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

  console.log(`\n${failed.length ? '✗' : '✓'} codex-telemetry：${passed} 個斷言通過、${failed.length} 個失敗（${ran} cases）`);
  if (failed.length) {
    for (const f of failed) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

run();
