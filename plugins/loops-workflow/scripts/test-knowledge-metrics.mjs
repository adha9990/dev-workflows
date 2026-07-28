#!/usr/bin/env node
// test-knowledge-metrics.mjs —— 共享記憶觀測面的誠實斷言（#218 S8）。
// 這支測試守的不是「數字算得對」，而是**不准把沒量到的東西寫成量到的**：
//   · 沒有 telemetry ⇒ 成本一律 not_measured（不補 0，補 0 會讓沒量到看起來像量到 0）；
//   · 節省量永遠 not_measured，除非兩邊都真的跑過（重用次數 × 係數 ＝ 捏造）。
// 用法：node test-knowledge-metrics.mjs [--filter <case-prefix>] [--min-cases <n>]

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NOT_MEASURED, digestOf, appendClaim, appendConsumed, appendPackBuilt, appendPackConsumed, readKnowledge } from './knowledge-ledger.mjs';
import { appendTelemetryEvent } from './telemetry-ledger.mjs';
import { summarizeKnowledge, summarizeCostByRole, buildReport, compareReports } from './knowledge-metrics.mjs';

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
  const dir = mkdtempSync(join(tmpdir(), 'kmetrics-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const claim = (id, role, locator) => ({
  claim_id: id, kind: 'architecture', statement: `事實 ${id}`,
  scope: { files: ['src/**'], symbols: [] },
  sources: [{ type: 'repo-file', locator, digest: digestOf(locator) }],
  confidence: 'verified', validity: 'valid',
  created_by: { phase: 'explore', agent_role: role }, created_at_revision: 'sha1',
});

/** 一條有兩個角色、其中一個把別人已經宣告過的來源又宣告一次的 loop。 */
function seedLoop(dir) {
  appendClaim(dir, claim('A', 'explore', 'src/a.ts'));
  appendClaim(dir, claim('B', 'explore', 'src/b.ts'));
  appendClaim(dir, claim('C', 'verify-reviewer', 'src/a.ts')); // 同一份來源、不同角色 → 重複探索的訊號
  appendPackBuilt(dir, { packId: 'p1', role: 'impl-author', phase: 'build', taskId: 'T1', claimIds: ['A', 'B'], tokensEstimated: 200, budget: 4000, sourceRevision: 'sha1' });
  appendPackConsumed(dir, { packId: 'p1', agentRole: 'impl-author', agentId: 'A1', dispatchId: 'd1' });
  appendConsumed(dir, { claimId: 'A', packId: 'p1', agentRole: 'impl-author', agentId: 'A1', phase: 'build' });
  appendConsumed(dir, { claimId: 'B', packId: 'p1', agentRole: 'impl-author', agentId: 'A1', phase: 'build' });
}

// ══════════════════════════════════════════════════════════════════════════
testCase('M1', '重用面：算得出誰用了幾條、哪幾條從沒被用過', () => {
  withTmp((dir) => {
    seedLoop(dir);
    const summary = summarizeKnowledge(readKnowledge(dir).state);
    assert(summary.claims.total === 3 && summary.claims.reusable === 3, '三條事實、全部可重用');
    assert(summary.reuse.consumptionEvents === 2 && summary.reuse.distinctClaimsConsumed === 2, '取用次數與涵蓋條數分開算');
    assert(summary.reuse.neverConsumed === 1, '從沒被取用的那條看得出來（不是每條事實都值得記）');
    assert(summary.reuse.byRole['impl-author'] === 2, '逐角色拆得開');
    assert(summary.packs.built === 1 && summary.packs.consumed === 1, 'pack 建了幾份／真的派出幾份分開算');
  });
});

testCase('M2', '重複探索只是觀測值，講清楚它不是「重複讀了幾次檔」', () => {
  withTmp((dir) => {
    seedLoop(dir);
    const summary = summarizeKnowledge(readKnowledge(dir).state);
    assert(summary.duplicateDiscovery.repeatedSourceClaims === 1, '同一份來源被兩個角色各自宣告 → 記一筆');
    assert(summary.duplicateDiscovery.detail[0].source.includes('src/a.ts'), '指名是哪份來源');
    assert(summary.duplicateDiscovery.note.includes('觀測值'), '註記寫明這是觀測、不是擋線依據');
  });
});

testCase('M3', '沒有 telemetry ⇒ 成本 not_measured（不補 0）', () => {
  withTmp((dir) => {
    seedLoop(dir);
    const report = buildReport(dir);
    assert(report.cost.measurement_status === NOT_MEASURED, '沒量到就標 not_measured');
    assert(Object.keys(report.cost.byRole).length === 0, '不編一組 0 出來');
    assert(report.cost.reason.length > 0, '說得出為什麼沒量到');
  });
});

testCase('M4', '有 telemetry ⇒ 逐角色攤開四種 token（不混成一個總和）', () => {
  withTmp((dir) => {
    seedLoop(dir);
    mkdirSync(join(dir, 'telemetry'), { recursive: true });
    appendTelemetryEvent(dir, {
      event_type: 'usage.turn', occurred_at: '2026-07-28T00:00:00Z', harness: 'claude-code',
      loop_slug: '218-demo', session_id: 'S1', iteration: 0, plane: 'subagent',
      workflow_node: 'build', phase: 'build', activity: 'implement',
      agent_id: 'A1', agent_role: 'impl-author', turn_id: 't1', measurement_status: 'exact',
      usage: { input_tokens: 100, output_tokens: 20, cache_creation_tokens: 5, cache_read_tokens: 300 },
    });
    const report = buildReport(dir);
    assert(report.cost.measurement_status === 'exact', '真的量到 → exact');
    assert(report.cost.byRole['impl-author'].cache_read_tokens === 300, 'cache read 獨立成欄（回答得了「錢花在 cache 還是 input」）');
    assert(report.cost.byRole['impl-author'].turns === 1, 'turn 是 token 的最小精確單位');
  });
});

testCase('M5', '節省量永遠不是算出來的：單邊報告一律 not_measured 並給出怎麼量', () => {
  withTmp((dir) => {
    seedLoop(dir);
    const report = buildReport(dir);
    assert(report.savings.value === NOT_MEASURED, '不把重用次數換算成省下的 token');
    assert(report.savings.why.includes('A/B'), '說明只能用同一組 corpus 的 A/B 比出來');
    assert(report.savings.how.includes('--baseline'), '給得出實際怎麼量');
  });
});

testCase('M6', 'A/B 比較：兩邊都量到才給差值，缺一邊就整項 not_measured', () => {
  withTmp((a) => withTmp((b) => {
    seedLoop(a);
    seedLoop(b);
    appendClaim(b, claim('D', 'plan', 'src/d.ts'));
    const compared = compareReports(buildReport(a), buildReport(b));
    assert(compared.knowledge.claims === 1, '事實數的差值算得出來（那是真的計數）');
    assert(compared.tokens.measurement_status === NOT_MEASURED, '兩邊都沒有 usage → token 差值 not_measured');
    assert(compared.tokens.reason.includes('缺一邊'), '說得出為什麼不給差值');
    assert(compared.caveat.includes('品質'), '提醒成本改善還要搭配品質不退步才算數');
  }));
});

testCase('M7', '沒有共享記憶的 loop：報告照樣產得出來，只是明說沒啟用', () => {
  withTmp((dir) => {
    const report = buildReport(dir);
    assert(report.enabled === false, '沒有 knowledge 事件 → enabled false');
    assert(report.knowledge.claims.total === 0 && report.warnings.length === 0, '空狀態不算錯誤');
    assert(summarizeCostByRole([]).measurement_status === NOT_MEASURED, '空 telemetry → not_measured');
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
