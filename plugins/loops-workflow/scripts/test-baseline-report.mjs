#!/usr/bin/env node
// test-baseline-report.mjs —— baseline-report.mjs 的紅綠斷言（自帶極簡 harness，不引測試框架）。
// 用法：node test-baseline-report.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1（主線用此 exit code 判紅綠）。
//
// 預期 Red：baseline-report.mjs 尚未實作，下面的 import 會 ERR_MODULE_NOT_FOUND，
// 整個檔在載入期就丟例外 → node 以非 0 退出。這就是 TDD 的紅燈起點。
// smoke corpus/traces 子集：分別借用 corpus-sample/（test-baseline-corpus.mjs 同一份）與
// trace-sample/（本檔新增，quality-integrator 自製最小樣本，非 T2 實產的真實 trace）。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { loadCorpusFixtures, evaluateFixture, buildCorpusReport } from './baseline-corpus.mjs';
import {
  computeUnexpectedFailRate,
  collectExpectedFailRefs,
  buildRouteSection,
  buildQualitySection,
  buildCostSection,
  formatDateYYYYMMDD,
  reportFilenames,
  buildBaselineReport,
  buildMarkdownReport,
  loadTraces,
  writeReportFiles,
  validateGapEntry,
  validateGapsSchema,
} from './baseline-report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../scripts
const ROOT = dirname(HERE); // plugin root
const CORPUS_SAMPLE_DIR = join(HERE, 'fixtures', 'baseline', 'corpus-sample');
const TRACE_SAMPLE_DIR = join(HERE, 'fixtures', 'baseline', 'trace-sample');
const GAPS_SAMPLE_DIR = join(HERE, 'fixtures', 'baseline', 'gaps-sample');

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

// 真跑 corpus-sample（同 test-baseline-corpus.mjs 用的樣本），拿真實 corpusReport 供本檔測試用
// （非手造假資料——與 runner 的實際輸出形狀保證一致）。
const corpusEntries = loadCorpusFixtures(CORPUS_SAMPLE_DIR);
const corpusResults = corpusEntries.map((e) => evaluateFixture(e.fixture, CORPUS_SAMPLE_DIR));
const corpusReport = buildCorpusReport(corpusResults);

// ════════════════════════════════════════════════════════════════════════════
//  computeUnexpectedFailRate / collectExpectedFailRefs / buildRouteSection —— M4
// ════════════════════════════════════════════════════════════════════════════

{
  // corpus-sample 已知組成：5 fixture，1 筆 expected-fail（route-mismatch-sample，仍如預期失敗），
  // 1 筆非預期紅（trajectory-missing-provenance-sample，schema 不合法）。
  const unexpected = computeUnexpectedFailRate(corpusReport.tasks);
  assert(unexpected.total_count === 4, 'computeUnexpectedFailRate：分母排除 1 筆 expected-fail → 4');
  assert(unexpected.fail_count === 1, 'computeUnexpectedFailRate：4 筆中 1 筆非預期失敗（缺欄 fixture）');
  assert(unexpected.rate === 0.25, 'computeUnexpectedFailRate：0.25（裸百分比不含預期紅）');

  const zero = computeUnexpectedFailRate([]);
  assert(zero.rate === null, 'computeUnexpectedFailRate：空陣列 → rate=null（不偽裝 0% 或除以零）');

  const refs = collectExpectedFailRefs(corpusReport.tasks);
  assert(refs.length === 1 && refs[0].id === 'route-mismatch-sample', 'collectExpectedFailRefs：只收 1 筆，id 正確');
  assert(refs[0].still_failing === true, 'collectExpectedFailRefs：route-mismatch-sample 現況仍如預期失敗');

  const route = buildRouteSection(corpusReport.tasks);
  assert(Object.keys(route).length === 2, 'buildRouteSection：只收 route-decision 型 2 筆');
  assert(route['route-ok-sample']?.outcome === 'pass', 'buildRouteSection：route-ok-sample outcome=pass');
  assert(
    route['route-mismatch-sample']?.outcome === 'fail' && route['route-mismatch-sample']?.expected_outcome === 'expected-fail',
    'buildRouteSection：route-mismatch-sample outcome=fail 且 expected_outcome=expected-fail',
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  buildQualitySection
// ════════════════════════════════════════════════════════════════════════════

{
  const q = buildQualitySection(corpusReport);
  assert(q.total_fixtures === 5, 'buildQualitySection：total_fixtures=5');
  assert(q.expected_fail_count === 1, 'buildQualitySection：expected_fail_count=1');
  assert(q.unexpected_fail_rate === 0.25, 'buildQualitySection：unexpected_fail_rate=0.25');
  assert(Object.keys(q.route).length === 2, 'buildQualitySection：route 子物件含 2 筆 route-decision');
}

// ════════════════════════════════════════════════════════════════════════════
//  buildCostSection —— traces 精確/est/not_measured 三態分開加總
// ════════════════════════════════════════════════════════════════════════════

{
  const traces = loadTraces(TRACE_SAMPLE_DIR);
  assert(traces.length === 3, 'loadTraces：precise-trace.json（單物件）+ mixed-traces.json（陣列展開 2 筆）= 3');

  const cost = buildCostSection(traces);
  assert(
    cost.tokens.precise.main === 3 && cost.tokens.precise.total_incl_subagents === 3 && cost.tokens.precise.traces_count === 1,
    'buildCostSection：精確 tokens 只加總精確筆（1 筆）',
  );
  assert(
    cost.tokens.est_range.lo === 100 && cost.tokens.est_range.hi === 200 && cost.tokens.est_range.traces_count === 1,
    'buildCostSection：est_range 逐界相加、不與精確筆混算',
  );
  assert(cost.tokens.traces_not_measured === 1, 'buildCostSection：完全 not_measured 的 trace 另計數');
  assert(
    cost.duration_ms.sum_ms === 1000 && cost.duration_ms.traces_measured === 1 && cost.duration_ms.traces_not_measured === 2,
    'buildCostSection：duration 只加總有量到的筆（1 筆），其餘 2 筆計入 not_measured',
  );
  assert(
    cost.tool_or_agent_calls.subagent_count_sum === 7 && cost.tool_or_agent_calls.traces_measured === 2,
    'buildCostSection：subagent_count 加總（2+5=7），跳過 not_measured 那筆',
  );
  assert(cost.questions === 'not_measured' && cost.verify_findings === 'not_measured', 'buildCostSection：R4 無資料來源維度固定 not_measured');

  const empty = buildCostSection([]);
  assert(empty.tokens.precise === 'not_measured' && empty.tokens.est_range === 'not_measured', 'buildCostSection：空 traces → 全 not_measured（不偽裝 0）');
}

// ════════════════════════════════════════════════════════════════════════════
//  validateGapEntry / validateGapsSchema —— C4（T4 gaps.json 消費端）
// ════════════════════════════════════════════════════════════════════════════

function minimalValidGapEntry(overrides = {}) {
  return {
    capability_id: 'codex.x',
    harness: 'codex',
    status: 'not_measured',
    measurability: 'needs_auth',
    gates_metrics: [],
    codex_interface: 'x',
    evidence: { source: 'x', note: 'x' },
    blocker: 'x',
    repro: 'x',
    x183_action: 'x',
    ...overrides,
  };
}

{
  assert(validateGapEntry(minimalValidGapEntry()).valid === true, 'validateGapEntry：合法條目 → valid');
  assert(validateGapEntry(minimalValidGapEntry({ capability_id: '' })).valid === false, 'validateGapEntry：缺 capability_id → invalid');
  assert(validateGapEntry(minimalValidGapEntry({ status: 'bogus' })).valid === false, 'validateGapEntry：status 不在枚舉 → invalid');
  assert(validateGapEntry(minimalValidGapEntry({ measurability: 'bogus' })).valid === false, 'validateGapEntry：measurability 不在枚舉 → invalid');
  assert(validateGapEntry(minimalValidGapEntry({ gates_metrics: 'not-array' })).valid === false, 'validateGapEntry：gates_metrics 非陣列 → invalid');
  assert(validateGapEntry(minimalValidGapEntry({ evidence: {} })).valid === false, 'validateGapEntry：evidence.source 缺少 → invalid');
  for (const status of ['supported', 'degraded', 'not_supported', 'not_measured']) {
    assert(validateGapEntry(minimalValidGapEntry({ status })).valid === true, `validateGapEntry：status=${status} 合法`);
  }

  const validAll = validateGapsSchema([minimalValidGapEntry(), minimalValidGapEntry({ capability_id: 'codex.y' })]);
  assert(validAll.valid === true && validAll.count === 2, 'validateGapsSchema：全合法陣列 → valid，count 正確');

  const withOneBad = validateGapsSchema([minimalValidGapEntry(), minimalValidGapEntry({ status: 'bogus' })]);
  assert(withOneBad.valid === false && withOneBad.errors.length === 1 && withOneBad.errors[0].index === 1, 'validateGapsSchema：定位到壞的那一筆的 index');

  assert(validateGapsSchema({}).valid === false, 'validateGapsSchema：根層非陣列 → invalid');
  assert(validateGapsSchema([]).valid === true, 'validateGapsSchema：空陣列 → valid（沒有東西可驗，不算錯）');
}

// ════════════════════════════════════════════════════════════════════════════
//  formatDateYYYYMMDD / reportFilenames
// ════════════════════════════════════════════════════════════════════════════

{
  assert(formatDateYYYYMMDD(new Date(Date.UTC(2026, 6, 25))) === '20260725', 'formatDateYYYYMMDD：UTC 8 碼格式');
  const names = reportFilenames('20260725', 'abcdef1234567890');
  assert(names.json === 'baseline-20260725-abcdef12.json', 'reportFilenames：json 檔名＝baseline-<date>-<sha8>.json');
  assert(names.md === 'baseline-20260725-abcdef12.md', 'reportFilenames：md 檔名＝baseline-<date>-<sha8>.md');
}

// ════════════════════════════════════════════════════════════════════════════
//  buildBaselineReport —— C3 骨架（雙 harness 分組、無合併平均欄、R12 八面向骨架）
// ════════════════════════════════════════════════════════════════════════════

{
  const traces = loadTraces(TRACE_SAMPLE_DIR);
  const report = buildBaselineReport({
    repoSha: 'deadbeef1234',
    date: '20260725',
    corpusReport,
    traces,
    gapsPresent: false,
    corpusCmd: 'node baseline-corpus.mjs --dir x --json',
    traceCmds: ['node baseline-trace.mjs --scan-outcomes --loops-root x --json'],
  });

  assert(report.meta.repo_sha === 'deadbeef1234' && report.meta.date === '20260725', 'buildBaselineReport：meta 正確透傳');
  assert(report.groups['claude-code'].quality.total_fixtures === 5, 'buildBaselineReport：claude-code.quality 正確接上 corpusReport');
  assert(report.groups.codex.quality === 'not_measured' && report.groups.codex.cost === 'not_measured', 'buildBaselineReport：codex 組全欄 not_measured（不推論）');
  assert(report.groups.codex.gaps_ref === null, 'buildBaselineReport：gapsPresent=false → gaps_ref=null');
  assert(!('claude_code_avg' in report.groups) && !('merged' in report.groups), 'buildBaselineReport：schema 層面無合併平均欄');
  assert(Array.isArray(report.platform_diff) && report.platform_diff.length === 8, 'buildBaselineReport：platform_diff 固定 8 面向骨架');
  assert(typeof report.rerun.recapture_note === 'string' && report.rerun.recapture_note.length > 0, 'buildBaselineReport：rerun.recapture_note 必填');
  assert(report.rerun.corpus_cmd.includes('baseline-corpus.mjs'), 'buildBaselineReport：rerun.corpus_cmd 透傳');

  const md = buildMarkdownReport(report);
  assert(typeof md === 'string' && md.includes('claude-code') && md.includes('codex'), 'buildMarkdownReport：雙組皆現身於輸出');
}

// ════════════════════════════════════════════════════════════════════════════
//  writeReportFiles —— 不可變（已存在拒絕覆寫）
// ════════════════════════════════════════════════════════════════════════════

{
  const tmpDir = mkdtempSync(join(tmpdir(), 'baseline-report-test-'));
  try {
    const report = buildBaselineReport({ repoSha: 'cafebabe', date: '20260101', corpusReport, traces: [] });
    const first = writeReportFiles({ report, outDir: tmpDir, date: '20260101', repoSha: 'cafebabe' });
    assert(first.written === true, 'writeReportFiles：目標檔不存在 → 成功寫入');
    assert(existsSync(first.jsonPath) && existsSync(first.mdPath), 'writeReportFiles：json 與 md 兩檔皆落地');

    const second = writeReportFiles({ report, outDir: tmpDir, date: '20260101', repoSha: 'cafebabe' });
    assert(second.written === false, 'writeReportFiles：同 date+sha 再寫一次 → 拒絕（不可變）');
    assert(typeof second.reason === 'string' && second.reason.length > 0, 'writeReportFiles：拒絕時附理由');

    const original = readFileSync(first.jsonPath, 'utf8');
    assert(original.includes('"repo_sha": "cafebabe"'), 'writeReportFiles：拒絕覆寫後原檔內容未被更動');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  CLI e2e —— 產出 + 第二次執行拒絕覆寫
// ════════════════════════════════════════════════════════════════════════════

{
  const tmpDir = mkdtempSync(join(tmpdir(), 'baseline-report-cli-test-'));
  try {
    const args = [
      join(HERE, 'baseline-report.mjs'),
      '--corpus', CORPUS_SAMPLE_DIR,
      '--traces-dir', TRACE_SAMPLE_DIR,
      '--repo-sha', 'feedface00',
      '--date', '20260202',
      '--out-dir', tmpDir,
      '--json',
    ];
    const first = spawnSync('node', args, { cwd: ROOT, encoding: 'utf8' });
    assert(first.status === 0, `CLI：首次產出 exit 0（stderr: ${first.stderr}）`);
    assert(existsSync(join(tmpDir, 'baseline-20260202-feedface.json')), 'CLI：json 檔落地在指定 out-dir');
    assert(existsSync(join(tmpDir, 'baseline-20260202-feedface.md')), 'CLI：md 檔落地在指定 out-dir');

    const second = spawnSync('node', args, { cwd: ROOT, encoding: 'utf8' });
    assert(second.status !== 0, 'CLI：第二次同參數執行 → 非零退出（不可變拒覆寫）');

    const usage = spawnSync('node', [join(HERE, 'baseline-report.mjs')], { cwd: ROOT, encoding: 'utf8' });
    assert(usage.status === 2, 'CLI：缺必要旗標（誤用）→ exit 2');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  CLI e2e —— --gaps 真驗證（C4），非只檢查檔案存在
// ════════════════════════════════════════════════════════════════════════════

{
  const tmpDir = mkdtempSync(join(tmpdir(), 'baseline-report-gaps-test-'));
  try {
    const baseArgs = [
      join(HERE, 'baseline-report.mjs'),
      '--corpus', CORPUS_SAMPLE_DIR,
      '--traces-dir', TRACE_SAMPLE_DIR,
      '--repo-sha', 'gapstest01',
      '--json',
    ];

    const withValidGaps = spawnSync(
      'node',
      [...baseArgs, '--date', '20260301', '--out-dir', tmpDir, '--gaps', join(GAPS_SAMPLE_DIR, 'valid-gaps.json')],
      { cwd: ROOT, encoding: 'utf8' },
    );
    assert(withValidGaps.status === 0, `CLI：合法 gaps.json → exit 0（stderr: ${withValidGaps.stderr}）`);
    let reportWithGaps = null;
    try { reportWithGaps = JSON.parse(withValidGaps.stdout).report; } catch { /* 下面斷言報壞 */ }
    assert(
      reportWithGaps?.groups?.codex?.gaps_ref === 'evals/baseline/codex/gaps.json',
      'CLI：合法 gaps.json 通過驗證 → report 的 codex.gaps_ref 才會填上',
    );

    const withInvalidGaps = spawnSync(
      'node',
      [...baseArgs, '--date', '20260302', '--out-dir', tmpDir, '--gaps', join(GAPS_SAMPLE_DIR, 'invalid-gaps.json')],
      { cwd: ROOT, encoding: 'utf8' },
    );
    assert(withInvalidGaps.status !== 0, 'CLI：不合法 gaps.json（缺 capability_id/status 非法/gates_metrics 非陣列）→ 非零退出，不放行');
    assert(
      !existsSync(join(tmpDir, 'baseline-20260302-gapstest.json')),
      'CLI：gaps 驗證失敗時不落地任何 report 檔（不可假裝驗證通過）',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.error('\n失敗清單：');
  for (const f of failed) console.error(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
