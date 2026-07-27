#!/usr/bin/env node
// test-cost-report.mjs —— deterministic cost.md renderer 的契約斷言（#217 增量 3）。
// 用法：node test-cost-report.mjs [--filter <case-id>] [--min-cases <n>]
//
// 覆蓋：
//   H-*  harness 自檢。
//   S-*  固定骨架：11 個 section 齊全、順序固定、產物通過 artifact-contract 驗證。
//   D-*  determinism：同一份 ledger 重複 render 必須逐位元組相同（#217 S6）。
//   W-*  workflow 維度：iterate 不出現在 phase 表、control node 另計、iteration 分得開。
//   A-*  agent／task 歸因：真實 role／task 逐列可見，unattributed 誠實列出，永不出現 other-subagent。
//   M-*  誠實：沒量到就是 not_measured，不補 0 也不推估；tool bytes 不冒充 token。
//   T-*  hotspot：六類訊號都要能被指出來，且每條都追得到 ledger 證據。

import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = join(HERE, 'cost-report.mjs');
const PLUGIN_ROOT = join(HERE, '..');

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
let AC = null;
let TL = null;
let TMP = '';

const SECTIONS = [
  'Measurement Status', 'Executive Summary', 'By Phase', 'Control Overhead',
  'By Iteration', 'By Activity', 'Agent & Task Detail', 'Tool / Context Footprint',
  'Quality Yield', 'Artifact & Delivery Footprint', 'Hotspots and Recommendations',
];

/** 造一筆 usage.turn 事件（ledger 讀回來的形狀：{id, type, payload}）。 */
function turn(payload) {
  return {
    id: `e-${payload.turn_id}`,
    type: 'usage.turn',
    payload: {
      event_type: 'usage.turn',
      occurred_at: '2026-07-27T10:00:00.000Z',
      harness: 'claude',
      loop_slug: 'demo',
      session_id: 's',
      iteration: 0,
      plane: 'main',
      workflow_node: 'build',
      phase: 'build',
      activity: 'implement',
      agent_id: 'main',
      parent_agent_id: null,
      agent_role: 'orchestrator',
      task_id: null,
      task_summary: null,
      model: 'claude-opus-5',
      effort: null,
      measurement_status: 'exact',
      usage: { input_tokens: 100, output_tokens: 200, cache_creation_tokens: 10, cache_read_tokens: 20 },
      evidence: { source: 'main-transcript', attribution: 'timestamped' },
      ...payload,
    },
  };
}

function ev(type, payload) {
  return { id: `e-${type}-${payload.id ?? Math.abs(JSON.stringify(payload).length)}`, type, payload: { event_type: type, harness: 'claude', loop_slug: 'demo', ...payload } };
}

/** 一份涵蓋各維度的代表性 ledger。 */
function sampleEvents() {
  return [
    turn({ turn_id: 't1' }),
    turn({ turn_id: 't2', phase: 'verify', workflow_node: 'verify', activity: 'review' }),
    // 回環：iteration 1 的 remediate 與 reverify
    turn({ turn_id: 't3', iteration: 1, phase: 'build', workflow_node: 'build', activity: 'remediate' }),
    turn({ turn_id: 't4', iteration: 1, phase: 'verify', workflow_node: 'verify', activity: 'reverify' }),
    // 控制節點：iteration-controller 的成本不是一個 phase
    turn({ turn_id: 't5', iteration: 1, phase: 'verify', workflow_node: 'iteration-controller', activity: 'route' }),
    // 兩個不同 reviewer（各自有真實身分）
    turn({
      turn_id: 'r1#1', plane: 'subagent', phase: 'verify', workflow_node: 'verify', activity: 'review',
      agent_id: 'agent-aaa', agent_role: 'code-quality-reviewer', task_id: 'T1', task_summary: '審查正確性',
    }),
    turn({
      turn_id: 'r2#1', plane: 'subagent', phase: 'verify', workflow_node: 'verify', activity: 'review',
      agent_id: 'agent-bbb', agent_role: 'security-reviewer', task_id: 'T2', task_summary: '審查安全性',
    }),
    // 歸不了戶的一個：必須誠實列出，不得混進別人的桶
    turn({
      turn_id: 'r3#1', plane: 'subagent', phase: 'verify', workflow_node: 'verify', activity: 'review',
      agent_id: 'unattributed:agent-ccc', agent_role: 'unattributed', measurement_status: 'not_measured',
      usage: null, evidence: { source: 'subagent-transcript', reason: '沒有 trace envelope' },
    }),
    ev('tool.completed', { id: 'tool1', tool: { name: 'Read', input_bytes: 50, output_bytes: 8000, duration_ms: 12, context_tokens_measurement: 'estimated' }, measurement_status: 'estimated', phase: 'build', activity: 'implement', iteration: 0 }),
    ev('quality.finding-emitted', { id: 'f1', finding_id: 'F1', severity: 'P1', phase: 'verify', iteration: 0 }),
    ev('quality.finding-emitted', { id: 'f2', finding_id: 'F2', severity: 'P2', phase: 'verify', iteration: 0 }),
    ev('quality.finding-validated', { id: 'f1v', finding_id: 'F1', phase: 'verify', iteration: 0 }),
    ev('quality.finding-resolved', { id: 'f1r', finding_id: 'F1', phase: 'verify', iteration: 1 }),
    ev('artifact.created', { id: 'a1', artifact_id: 'cost-report', template_version: 1, phase: 'finalize' }),
    ev('artifact.validated', { id: 'a2', artifact_id: 'cost-report', template_version: 1, phase: 'finalize' }),
  ];
}

// ── H-* ─────────────────────────────────────────────────────────────────────

testCase('H-1', 'harness 自身可運作', () => {
  assert(true, 'assert 能通過');
  assert(typeof existsSync(MODULE_PATH) === 'boolean', '模組存在與否可判斷');
});

// ── S-*：固定骨架 ───────────────────────────────────────────────────────────

testCase('S-1', '11 個 section 齊全且順序固定', () => {
  const md = M.renderCostReport(sampleEvents(), { slug: 'demo' });
  const found = SECTIONS.map((s) => md.indexOf(`## ${s}`));
  const missing = SECTIONS.filter((s, i) => found[i] === -1);
  assert(missing.length === 0, `全部 section 都在（缺：${missing.join('、') || '無'}）`);
  const ordered = found.every((pos, i) => i === 0 || pos > found[i - 1]);
  assert(ordered, 'section 依固定順序出現');
});

testCase('S-2', '第一行是 artifact marker', () => {
  const md = M.renderCostReport(sampleEvents(), { slug: 'demo' });
  assert(md.split('\n')[0] === '<!-- loops-artifact: cost-report@1 -->', `第一行為 cost-report marker（實際：${md.split('\n')[0]}）`);
});

testCase('S-3', '產出的文件通過 artifact-contract 驗證', () => {
  const md = M.renderCostReport(sampleEvents(), { slug: 'demo' });
  const { registry } = AC.loadArtifactRegistry(PLUGIN_ROOT);
  const r = AC.validateArtifactDocument(registry, { path: '.loops/demo/deliverables/cost.md', text: md });
  if (!r.ok) for (const f of r.findings) console.error(`     · ${f.check}｜${f.detail}`);
  assert(r.ok, 'renderer 的輸出符合自己登記的契約（契約與實作不得各說各話）');
});

testCase('S-4', '空 ledger 也 render 得出完整骨架', () => {
  const md = M.renderCostReport([], { slug: 'demo' });
  const missing = SECTIONS.filter((s) => !md.includes(`## ${s}`));
  assert(missing.length === 0, '沒有資料時 section 一樣齊全（缺骨架比缺數字更難察覺）');
  assert(md.includes('not_measured'), '沒有資料時明講 not_measured，不留空白讓人以為是 0');
});

// ── D-*：determinism ────────────────────────────────────────────────────────

testCase('D-1', '同一份 ledger 重複 render 逐位元組相同', () => {
  const a = M.renderCostReport(sampleEvents(), { slug: 'demo' });
  const b = M.renderCostReport(sampleEvents(), { slug: 'demo' });
  assert(a === b, 'byte-for-byte 相同（#217 S6）');
});

testCase('D-2', '事件順序被打亂也 render 出相同結果', () => {
  const a = M.renderCostReport(sampleEvents(), { slug: 'demo' });
  const shuffled = sampleEvents().reverse();
  const b = M.renderCostReport(shuffled, { slug: 'demo' });
  assert(a === b, '輸出不依賴事件的到達順序（併發 hook 的落盤順序不保證）');
});

testCase('D-3', '重複 event_id 只算一次', () => {
  const base = sampleEvents();
  const withDup = [...base, base[0]];
  assert(M.renderCostReport(base, { slug: 'demo' }) === M.renderCostReport(withDup, { slug: 'demo' }),
    '重複的一筆不改變任何數字（併發寫者會寫出同一 logical event）');
});

// ── W-*：workflow 維度 ──────────────────────────────────────────────────────

testCase('W-1', 'iterate 不出現在 By Phase', () => {
  const phase = M.sectionOf(M.renderCostReport(sampleEvents(), { slug: 'demo' }), 'By Phase');
  assert(!/\biterate\b/.test(phase), 'phase 表沒有 iterate（它是 iteration-controller，不是階段）');
  assert(phase.includes('build') && phase.includes('verify'), '真正的 phase 都在');
});

testCase('W-2', 'control node 的成本記在 Control Overhead 而不是 phase', () => {
  const md = M.renderCostReport(sampleEvents(), { slug: 'demo' });
  const control = M.sectionOf(md, 'Control Overhead');
  assert(control.includes('iteration-controller'), 'iteration-controller 出現在 Control Overhead');
  const phase = M.sectionOf(md, 'By Phase');
  assert(!phase.includes('iteration-controller'), '不重複計進 phase 表');
});

testCase('W-3', 'iteration 0 與後續分得開', () => {
  const iter = M.sectionOf(M.renderCostReport(sampleEvents(), { slug: 'demo' }), 'By Iteration');
  assert(/\|\s*0\s*\|/.test(iter), 'iteration 0（初次實作）獨立一列');
  assert(/\|\s*1\s*\|/.test(iter), 'iteration 1（回環）獨立一列');
});

testCase('W-4', 'activity 分得出 remediate 與 reverify', () => {
  const act = M.sectionOf(M.renderCostReport(sampleEvents(), { slug: 'demo' }), 'By Activity');
  assert(act.includes('remediate'), 'remediate 可見');
  assert(act.includes('reverify'), 'reverify 可見');
  assert(act.includes('review'), 'review 可見（與 reverify 是兩回事）');
});

// ── A-*：agent／task 歸因 ───────────────────────────────────────────────────

testCase('A-1', '每個 agent 逐列帶真實 role 與 task', () => {
  const detail = M.sectionOf(M.renderCostReport(sampleEvents(), { slug: 'demo' }), 'Agent & Task Detail');
  assert(detail.includes('code-quality-reviewer') && detail.includes('security-reviewer'),
    '兩個 reviewer 各自可見（不是混成一桶）');
  assert(detail.includes('T1') && detail.includes('T2'), 'task id 可見');
  assert(detail.includes('審查安全性'), 'task summary 可見');
});

testCase('A-4', '跨階段的 agent 逐階段分列，不把後面的回合算到第一個階段名下', () => {
  // 主線 agent 一定會跨階段。只用 agent 分組的話，Phase／Activity 欄會停在它第一次出現的地方，
  // 把「3 個回合分散在 build 與 verify」顯示成「3 個回合都在 build」——數字對、歸屬錯。
  const events = [
    turn({ turn_id: 'm1', phase: 'build', workflow_node: 'build', activity: 'implement' }),
    turn({ turn_id: 'm2', phase: 'verify', workflow_node: 'verify', activity: 'review' }),
    turn({ turn_id: 'm3', phase: 'verify', workflow_node: 'verify', activity: 'review' }),
  ];
  const detail = M.sectionOf(M.renderCostReport(events, { slug: 'demo' }), 'Agent & Task Detail');
  const rows = detail.split('\n').filter((l) => l.startsWith('| main '));
  assert(rows.length === 2, `main 分成兩列（build 一列、verify 一列；實際 ${rows.length} 列）`);
  assert(rows.some((r) => r.includes('build / implement') && /\|\s*1\s*\|/.test(r)), 'build 那列是 1 個回合');
  assert(rows.some((r) => r.includes('verify / review') && /\|\s*2\s*\|/.test(r)), 'verify 那列是 2 個回合');
});

testCase('A-2', '永遠不出現 other-subagent', () => {
  const md = M.renderCostReport(sampleEvents(), { slug: 'demo' });
  assert(!md.includes('other-subagent'), '整份報告不含 other-subagent');
});

testCase('A-3', 'unattributed 誠實列出並附原因', () => {
  const detail = M.sectionOf(M.renderCostReport(sampleEvents(), { slug: 'demo' }), 'Agent & Task Detail');
  assert(detail.includes('unattributed:agent-ccc'), 'unattributed 逐列可見、不被吸收進別人的數字');
  assert(detail.includes('沒有 trace envelope'), '附上為什麼歸不了戶');
});

// ── M-*：誠實 ───────────────────────────────────────────────────────────────

testCase('M-1', '四種 token 各自成欄', () => {
  const phase = M.sectionOf(M.renderCostReport(sampleEvents(), { slug: 'demo' }), 'By Phase');
  for (const col of ['Input', 'Output', 'Cache write', 'Cache read']) {
    assert(phase.includes(col), `${col} 欄存在（混成一個總和就回答不了錢花在哪）`);
  }
});

testCase('M-2', '沒量到的 turn 不被算成 0', () => {
  const status = M.sectionOf(M.renderCostReport(sampleEvents(), { slug: 'demo' }), 'Measurement Status');
  assert(status.includes('not_measured'), 'Measurement Status 明列沒量到的部分');
  const summary = M.summarize(sampleEvents());
  assert(summary.notMeasuredTurns === 1, `沒量到的回合被數出來（實際 ${summary.notMeasuredTurns}）`);
  assert(summary.tokens.output_tokens === 200 * 7, `只加總量得到的（實際 ${summary.tokens.output_tokens}）`);
});

testCase('M-3', 'tool 的 bytes 不冒充 token', () => {
  const tool = M.sectionOf(M.renderCostReport(sampleEvents(), { slug: 'demo' }), 'Tool / Context Footprint');
  assert(tool.includes('8000'), 'bytes 原樣呈現');
  assert(/estimated/.test(tool), 'context token 標 estimated');
});

// ── T-*：hotspot ────────────────────────────────────────────────────────────

testCase('T-1', 'unattributed 會被列成 hotspot', () => {
  const hot = M.sectionOf(M.renderCostReport(sampleEvents(), { slug: 'demo' }), 'Hotspots and Recommendations');
  assert(/unattributed/.test(hot), '有歸不了戶的用量就要指出來');
});

testCase('T-2', 'finding 發很多但確認很少會被指出來', () => {
  const events = [
    ...sampleEvents(),
    ev('quality.finding-emitted', { id: 'f3', finding_id: 'F3', severity: 'P2', phase: 'verify', iteration: 0 }),
    ev('quality.finding-emitted', { id: 'f4', finding_id: 'F4', severity: 'P2', phase: 'verify', iteration: 0 }),
    ev('quality.finding-emitted', { id: 'f5', finding_id: 'F5', severity: 'P2', phase: 'verify', iteration: 0 }),
  ];
  const hot = M.sectionOf(M.renderCostReport(events, { slug: 'demo' }), 'Hotspots and Recommendations');
  assert(/finding/i.test(hot), '發出 5 條、只確認 1 條 → 指出驗證在空轉');
});

testCase('T-3', 'hotspot 每條都帶得出證據欄', () => {
  const hot = M.sectionOf(M.renderCostReport(sampleEvents(), { slug: 'demo' }), 'Hotspots and Recommendations');
  const rows = hot.split('\n').filter((l) => l.startsWith('|') && !/^\|\s*[-#]/.test(l) && !l.includes('現象'));
  assert(rows.length > 0, '至少有一條 hotspot');
  assert(rows.every((r) => r.split('|').length >= 5), '每條都有「現象／證據／建議」欄（沒有證據的建議不可追）');
});

testCase('T-4', '沒有 hotspot 時明說沒有，不留空表', () => {
  const quiet = [turn({ turn_id: 'q1' })];
  const hot = M.sectionOf(M.renderCostReport(quiet, { slug: 'demo' }), 'Hotspots and Recommendations');
  assert(/（無）|no hotspot|沒有/i.test(hot), '明講沒有異常，不留一張空表讓人猜是沒查還是沒問題');
});

// ── 執行 ────────────────────────────────────────────────────────────────────

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  TMP = mkdtempSync(join(tmpdir(), 'loops-cost-'));
  mkdirSync(TMP, { recursive: true });
  process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失敗不影響結果 */ } });

  try {
    M = await import(pathToFileURL(MODULE_PATH).href);
    AC = await import(pathToFileURL(join(HERE, 'artifact-contract.mjs')).href);
    TL = await import(pathToFileURL(join(HERE, 'telemetry-ledger.mjs')).href);
    void TL;
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

  console.log(`\n${failed.length ? '✗' : '✓'} cost-report：${passed} 個斷言通過、${failed.length} 個失敗（${ran} cases）`);
  if (failed.length) {
    for (const f of failed) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

run();
