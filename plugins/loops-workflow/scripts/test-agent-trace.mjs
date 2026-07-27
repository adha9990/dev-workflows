#!/usr/bin/env node
// test-agent-trace.mjs —— agent trace envelope 與 phase trace history 的契約斷言（#217 增量 2）。
// 用法：node test-agent-trace.mjs [--filter <case-id>] [--min-cases <n>]
//
// 覆蓋：
//   H-*  harness 自檢。
//   E-*  envelope：建構／解析往返、必填欄位、值域、含空白的 summary、多行 prompt 中找得到。
//   G-*  guard 判定：缺 envelope 的派工必須被擋（否則只能事後靠關鍵字猜 role／phase／task）。
//   T-*  phase trace history：timestamped、可把較早的 turn 接回當時有效的 phase。
//   R-*  runtime id 接回：從子代理 transcript 的第一則訊息還原 envelope；還原不出時只能 unattributed。

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = join(HERE, 'agent-trace.mjs');

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

const ENVELOPE_INPUT = {
  loopSlug: '217-demo',
  iteration: 1,
  workflowNode: 'verify',
  phase: 'verify',
  activity: 'review',
  agentRole: 'code-quality-reviewer',
  taskId: 'T3',
  taskSummary: '審查 telemetry ledger 的正確性與狀態流',
  dispatchId: 'd-001',
  parentAgentId: 'main',
};

// ── H-* ─────────────────────────────────────────────────────────────────────

testCase('H-1', 'harness 自身可運作', () => {
  assert(true, 'assert 能通過');
  assert(typeof existsSync(MODULE_PATH) === 'boolean', '模組存在與否可判斷');
});

// ── E-*：envelope ───────────────────────────────────────────────────────────

testCase('E-1', 'envelope 建構→解析往返不失真', () => {
  const line = M.buildTraceEnvelope(ENVELOPE_INPUT);
  const parsed = M.parseTraceEnvelope(line);
  assert(parsed !== null, 'envelope 解析得出來');
  assert(parsed.loopSlug === '217-demo', 'loopSlug 往返');
  assert(parsed.iteration === 1, 'iteration 往返為數字');
  assert(parsed.workflowNode === 'verify' && parsed.phase === 'verify', 'workflowNode／phase 往返');
  assert(parsed.activity === 'review', 'activity 往返');
  assert(parsed.agentRole === 'code-quality-reviewer', 'agentRole 往返');
  assert(parsed.taskId === 'T3', 'taskId 往返');
  assert(parsed.dispatchId === 'd-001', 'dispatchId 往返');
  assert(parsed.parentAgentId === 'main', 'parentAgentId 往返');
});

testCase('E-2', '含空白與中文的 task summary 不被截斷', () => {
  const parsed = M.parseTraceEnvelope(M.buildTraceEnvelope(ENVELOPE_INPUT));
  assert(parsed.taskSummary === ENVELOPE_INPUT.taskSummary,
    `summary 完整往返（實際：${parsed.taskSummary}）`);
});

testCase('E-3', 'envelope 埋在多行 prompt 裡仍找得到', () => {
  const prompt = ['你是 code-quality reviewer。', '', M.buildTraceEnvelope(ENVELOPE_INPUT), '', '請審查以下改動……'].join('\n');
  const parsed = M.extractTraceEnvelope(prompt);
  assert(parsed?.taskId === 'T3', '從多行 prompt 抽得出 envelope');
});

testCase('E-4', '缺必填欄位的 envelope 一律解析失敗', () => {
  const line = M.buildTraceEnvelope(ENVELOPE_INPUT).replace(/ role="[^"]*"/, '');
  assert(M.parseTraceEnvelope(line) === null, '缺 role → 不算合法 envelope');
  assert(M.parseTraceEnvelope('<!-- loops-trace -->') === null, '空 envelope 不算');
  assert(M.parseTraceEnvelope('隨便一行字') === null, '非 envelope 一律 null');
  assert(M.parseTraceEnvelope(null) === null, 'null 不炸');
});

testCase('E-5', 'buildTraceEnvelope 對缺必填欄位直接拋出', () => {
  let threw = false;
  try { M.buildTraceEnvelope({ ...ENVELOPE_INPUT, agentRole: '' }); } catch { threw = true; }
  assert(threw, '缺 role 時在組字串前就拋出（不寫出一個必然解析失敗的 envelope）');
});

testCase('E-6', 'workflowNode 必須是 vocabulary 認得的節點', () => {
  let threw = false;
  try { M.buildTraceEnvelope({ ...ENVELOPE_INPUT, workflowNode: 'made-up' }); } catch { threw = true; }
  assert(threw, '不認得的 workflow node 直接拒絕（否則成本會歸到一個不存在的維度）');

  const ok = M.buildTraceEnvelope({ ...ENVELOPE_INPUT, workflowNode: 'iteration-controller', phase: 'verify' });
  assert(M.parseTraceEnvelope(ok)?.workflowNode === 'iteration-controller', 'control node 也合法');
});

testCase('E-7', 'role 不得是 other-subagent', () => {
  let threw = false;
  try { M.buildTraceEnvelope({ ...ENVELOPE_INPUT, agentRole: 'other-subagent' }); } catch { threw = true; }
  assert(threw, 'other-subagent 從源頭就擋掉');
});

// ── G-*：guard 判定 ─────────────────────────────────────────────────────────

testCase('G-1', '缺 envelope 的 Agent 派工要被擋', () => {
  const d = M.evaluateAgentDispatch({ prompt: '請審查這份改動' });
  assert(d.allowed === false, '沒有 envelope → 不允許');
  assert(typeof d.reason === 'string' && d.reason.includes('loops-trace'), 'deny 訊息指出要補什麼');
});

testCase('G-2', '帶合法 envelope 的派工放行並帶出 trace', () => {
  const prompt = `${M.buildTraceEnvelope(ENVELOPE_INPUT)}\n請審查……`;
  const d = M.evaluateAgentDispatch({ prompt });
  assert(d.allowed === true, '有 envelope → 放行');
  assert(d.trace?.agentRole === 'code-quality-reviewer', '帶出解析後的 trace 供 recorder 使用');
});

testCase('G-3', '沒有 prompt 欄位時不誤擋', () => {
  // 判不出來就放行是這個家族的既有慣例（fail-open）——擋掉一個判不出的呼叫，
  // 代價是整個工具面失效，而它擋到的不一定是違規。
  assert(M.evaluateAgentDispatch({}).allowed === true, '抽不到 prompt → fail-open 放行');
  assert(M.evaluateAgentDispatch(null).allowed === true, 'payload 壞掉 → fail-open 放行');
});

// ── T-*：phase trace history ────────────────────────────────────────────────

testCase('T-1', 'phase trace 依時間排序、可把較早的 turn 接回當時的 phase', () => {
  const history = [
    { at: '2026-07-27T10:00:00.000Z', workflowNode: 'plan', phase: 'plan', activity: 'design', iteration: 0 },
    { at: '2026-07-27T11:00:00.000Z', workflowNode: 'build', phase: 'build', activity: 'implement', iteration: 0 },
    { at: '2026-07-27T12:00:00.000Z', workflowNode: 'verify', phase: 'verify', activity: 'review', iteration: 0 },
  ];
  assert(M.resolvePhaseAt(history, '2026-07-27T10:30:00.000Z')?.phase === 'plan', '10:30 的 turn 歸給 plan');
  assert(M.resolvePhaseAt(history, '2026-07-27T11:00:00.000Z')?.phase === 'build', '邊界時刻歸給新 phase');
  assert(M.resolvePhaseAt(history, '2026-07-27T23:59:00.000Z')?.phase === 'verify', '最後一段之後歸給最後的 phase');
});

testCase('T-2', '第一筆 phase 之前的 turn 不硬塞一個 phase', () => {
  const history = [{ at: '2026-07-27T11:00:00.000Z', workflowNode: 'build', phase: 'build', activity: 'implement', iteration: 0 }];
  const before = M.resolvePhaseAt(history, '2026-07-27T09:00:00.000Z');
  assert(before === null, '沒有有效 phase 就回 null（歸給最近的一個等於偽造歸因）');
});

testCase('T-3', 'trace history 可落盤並讀回', () => {
  const dir = join(TMP, 't3', '.loops', 'demo');
  mkdirSync(dir, { recursive: true });
  M.appendPhaseTrace(dir, { at: '2026-07-27T10:00:00.000Z', workflowNode: 'plan', phase: 'plan', activity: 'design', iteration: 0 });
  M.appendPhaseTrace(dir, { at: '2026-07-27T11:00:00.000Z', workflowNode: 'build', phase: 'build', activity: 'implement', iteration: 0 });
  const history = M.readPhaseTrace(dir);
  assert(history.length === 2, '兩筆都讀得回');
  assert(M.resolvePhaseAt(history, '2026-07-27T10:30:00.000Z')?.phase === 'plan', '跨 session 後仍接得回當時的 phase');
});

testCase('T-4', '亂序寫入的 trace 讀回時仍依時間排序', () => {
  const dir = join(TMP, 't4', '.loops', 'demo');
  mkdirSync(dir, { recursive: true });
  M.appendPhaseTrace(dir, { at: '2026-07-27T12:00:00.000Z', workflowNode: 'verify', phase: 'verify', activity: 'review', iteration: 0 });
  M.appendPhaseTrace(dir, { at: '2026-07-27T10:00:00.000Z', workflowNode: 'plan', phase: 'plan', activity: 'design', iteration: 0 });
  assert(M.resolvePhaseAt(M.readPhaseTrace(dir), '2026-07-27T10:30:00.000Z')?.phase === 'plan',
    '寫入順序不影響歸因（併發 hook 的落盤順序不保證）');
});

// ── R-*：從 transcript 還原 runtime id ──────────────────────────────────────

testCase('R-1', '從子代理 transcript 還原 envelope 與 runtime id', () => {
  const dir = join(TMP, 'r1');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'agent-9f3a.jsonl');
  const prompt = `${M.buildTraceEnvelope(ENVELOPE_INPUT)}\n請審查……`;
  writeFileSync(file, [
    JSON.stringify({ type: 'user', message: { content: prompt } }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: 7, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 } } }),
  ].join('\n') + '\n');

  const r = M.readSubagentTrace(file);
  assert(r.runtimeId === 'agent-9f3a', 'runtime id 取自 transcript 檔名');
  assert(r.trace?.agentRole === 'code-quality-reviewer', 'role 來自結構化 envelope，不是關鍵字猜測');
  assert(r.trace?.taskId === 'T3', 'task id 還原');
  assert(r.turns.length === 1 && r.turns[0].usage.output_tokens === 7, 'per-turn usage 逐筆帶出');
  assert(r.turns[0].measurement_status === 'exact', '有完整 usage → exact');
});

testCase('R-2', '沒有 envelope 的子代理只能 unattributed，不得猜 role', () => {
  const dir = join(TMP, 'r2');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'agent-dead.jsonl');
  // 刻意放一個含「reviewer」字樣的 prompt：舊做法會用關鍵字把它猜成 verify，
  // 那正是 other-subagent／錯誤歸因的來源。
  writeFileSync(file, `${JSON.stringify({ type: 'user', message: { content: '你是 reviewer，請 review the diff' } })}\n`);

  const r = M.readSubagentTrace(file);
  assert(r.trace === null, '沒有 envelope → 不還原出 trace');
  assert(r.agentId === 'unattributed:agent-dead', 'agent_id 降級為 unattributed:<runtime-id>');
  assert(typeof r.reason === 'string' && r.reason.length > 0, '附上為什麼歸不了戶');
});

testCase('R-3', '沒有 usage 的 turn 標 not_measured、不補 0', () => {
  const dir = join(TMP, 'r3');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'agent-nousage.jsonl');
  writeFileSync(file, [
    JSON.stringify({ type: 'user', message: { content: M.buildTraceEnvelope(ENVELOPE_INPUT) } }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5' } }),
  ].join('\n') + '\n');

  const r = M.readSubagentTrace(file);
  assert(r.turns.length === 0, '沒有 usage 的 assistant 行不算一個可計費 turn');
  assert(r.measurement_status === 'not_measured', '整份標 not_measured');
});

// ── 執行 ────────────────────────────────────────────────────────────────────

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  TMP = mkdtempSync(join(tmpdir(), 'loops-trace-'));
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

  console.log(`\n${failed.length ? '✗' : '✓'} agent-trace：${passed} 個斷言通過、${failed.length} 個失敗（${ran} cases）`);
  if (failed.length) {
    for (const f of failed) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

run();
