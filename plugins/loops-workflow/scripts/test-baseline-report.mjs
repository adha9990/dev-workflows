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
  buildPlatformDiffFromGaps,
  unmappedPlatformDimensions,
  PLATFORM_DIFF_GAP_ID,
} from './baseline-report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../scripts
const ROOT = dirname(HERE); // plugin root
const CORPUS_SAMPLE_DIR = join(HERE, 'fixtures', 'baseline', 'corpus-sample');
const TRACE_SAMPLE_DIR = join(HERE, 'fixtures', 'baseline', 'trace-sample');
const GAPS_SAMPLE_DIR = join(HERE, 'fixtures', 'baseline', 'gaps-sample');
const REAL_GAPS_PATH = join(ROOT, 'evals', 'baseline', 'codex', 'gaps.json');

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
//  buildPlatformDiffFromGaps —— R12 八面向對映 gaps.json（T5 抽查抓到的缺口）
// ════════════════════════════════════════════════════════════════════════════

{
  const noGaps = buildPlatformDiffFromGaps([]);
  assert(noGaps.length === 8 && noGaps.every((d) => d.status === 'not_measured'), 'buildPlatformDiffFromGaps：空 gaps → 8 面向全 not_measured 骨架');

  const gaps = [
    minimalValidGapEntry({ capability_id: 'codex.manifest', status: 'supported', evidence: { source: 'smoke test', note: 'x' } }),
    minimalValidGapEntry({ capability_id: 'codex.transcript_metrics_stability', status: 'degraded' }),
    minimalValidGapEntry({ capability_id: 'codex.replay.deterministic', status: 'not_supported' }), // 不在 8 面向對映表內，不應污染任何維度
  ];
  const mapped = buildPlatformDiffFromGaps(gaps);
  const byDim = Object.fromEntries(mapped.map((d) => [d.dimension, d]));
  assert(byDim.manifest.status === 'supported', 'buildPlatformDiffFromGaps：manifest 面向吃到 gaps.json 的 supported（T5 回報的缺口）');
  assert(byDim.manifest.evidence?.source === 'smoke test', 'buildPlatformDiffFromGaps：manifest 面向帶上 evidence.source');
  assert(byDim.transcript_metrics.status === 'degraded', 'buildPlatformDiffFromGaps：transcript_metrics 面向吃到 degraded');
  assert(byDim.skill_invocation.status === 'not_measured', 'buildPlatformDiffFromGaps：無對應 capability_id 的面向維持 not_measured（不硬湊）');
  assert(mapped.length === 8, 'buildPlatformDiffFromGaps：codex.replay.deterministic 不在 8 面向對映表內，不多長出第 9 筆');

  // buildBaselineReport 接線：給 gaps（未顯式給 platformDiff）→ 自動走 buildPlatformDiffFromGaps。
  const reportWithGaps = buildBaselineReport({ repoSha: 'x', date: '20260101', corpusReport, traces: [], gapsPresent: true, gaps });
  const reportManifest = reportWithGaps.platform_diff.find((d) => d.dimension === 'manifest');
  assert(reportManifest.status === 'supported', 'buildBaselineReport：gaps 參數接線正確，platform_diff 反映真實 status（不再固定 not_measured）');

  // caveats 不得與 rerun.recapture_note 逐字重複（T5 順手抓到的問題）。
  assert(
    !reportWithGaps.caveats.includes(reportWithGaps.rerun.recapture_note),
    'buildBaselineReport：caveats 不逐字重複 rerun.recapture_note（改成短引用）',
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  F3：unmappedPlatformDimensions（對映漂移偵測）＋ buildBaselineReport 的 caveats 提示
// ════════════════════════════════════════════════════════════════════════════

{
  assert(unmappedPlatformDimensions([]).length === 0, 'unmappedPlatformDimensions：gaps 空陣列 → 空清單（不算漂移，本來就沒給 --gaps）');
  assert(unmappedPlatformDimensions(null).length === 0, 'unmappedPlatformDimensions：gaps 非陣列 → 空清單');

  const fullyMapped = Object.values(PLATFORM_DIFF_GAP_ID).map((id) => minimalValidGapEntry({ capability_id: id }));
  assert(unmappedPlatformDimensions(fullyMapped).length === 0, 'unmappedPlatformDimensions：8 面向皆有對應 id → 空清單');

  // 只給 1 筆（manifest），其餘 7 個面向在這份 gaps 裡都找不到對應 id → 應列為漂移。
  const partiallyMapped = [minimalValidGapEntry({ capability_id: PLATFORM_DIFF_GAP_ID.manifest, status: 'supported' })];
  const unmapped = unmappedPlatformDimensions(partiallyMapped);
  assert(unmapped.length === 7 && !unmapped.includes('manifest'), 'unmappedPlatformDimensions：只給 manifest → 其餘 7 面向列為未對映，manifest 不在清單內');

  const reportWithGap = buildBaselineReport({ repoSha: 'x', date: '20260101', corpusReport, traces: [], gapsPresent: true, gaps: partiallyMapped });
  assert(
    reportWithGap.caveats.some((c) => c.includes('R12 對映缺口') && c.includes('skill_invocation')),
    'buildBaselineReport：gaps 給了但部分面向對映落空 → caveats 出現「R12 對映缺口」提示（含至少一個面向名）',
  );

  const reportFullyMapped = buildBaselineReport({ repoSha: 'x', date: '20260101', corpusReport, traces: [], gapsPresent: true, gaps: fullyMapped });
  assert(
    !reportFullyMapped.caveats.some((c) => c.includes('R12 對映缺口')),
    'buildBaselineReport：8 面向全對映到 → caveats 不出現對映缺口提示（沒有漂移不誤報）',
  );

  const reportNoGaps = buildBaselineReport({ repoSha: 'x', date: '20260101', corpusReport, traces: [], gapsPresent: false, gaps: null });
  assert(
    !reportNoGaps.caveats.some((c) => c.includes('R12 對映缺口')),
    'buildBaselineReport：根本沒給 gaps → 不誤判成對映缺口（本來就是 not_measured 骨架，非漂移）',
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  F3：真實 gaps.json round-trip——PLATFORM_DIFF_GAP_ID 每個 id 都要在真實 gaps.json 裡找得到
//  （id 若被改名，這條斷言會轉紅，顯式偵測對映表與真實資料脫鉤，不會悄悄退化成全 not_measured）
// ════════════════════════════════════════════════════════════════════════════

{
  let realGaps = null;
  try {
    realGaps = JSON.parse(readFileSync(REAL_GAPS_PATH, 'utf8'));
  } catch (err) {
    // 讀不到／解不出真實 gaps.json 本身就是要抓的一種漂移（檔案消失、被移走、格式壞掉）——
    // 記一筆失敗讓整體 exit 非零，不能只印警告就悄悄跳過（那等於這個守衛形同虛設）。
    assert(false, `真實 gaps.json round-trip：讀取/解析 ${REAL_GAPS_PATH} 失敗（${err?.message ?? err}）—— 這本身就是要偵測的漂移，不可靜默略過`);
  }
  if (realGaps) {
    const realIds = new Set(realGaps.map((g) => g?.capability_id));
    for (const [dimension, gapId] of Object.entries(PLATFORM_DIFF_GAP_ID)) {
      assert(
        realIds.has(gapId),
        `真實 gaps.json round-trip：面向 ${dimension} 對映的 capability_id "${gapId}" 存在於 evals/baseline/codex/gaps.json（id 改名時本斷言應轉紅）`,
      );
    }
  }
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

  // F9：cost 區白話講清楚 precise 與 est 樣本數不對等，避免讀者把兩組數字並列比較。
  // trace-sample 已知組成＝1 precise + 1 est + 1 完全未量到 → precise 1/3。
  assert(md.includes('precise 涵蓋 1/3 筆 trace'), 'buildMarkdownReport：cost 區含 precise/total 樣本數白話句');
  assert(md.includes('不得並列比較'), 'buildMarkdownReport：cost 區白話句明講兩組量級與信度不同、不得並列比較');
  assert(md.includes('1 筆完全未量到'), 'buildMarkdownReport：白話句同時點出完全未量到的筆數（非只講 est）');
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
    const manifestDim = reportWithGaps?.platform_diff?.find((d) => d.dimension === 'manifest');
    assert(
      manifestDim?.status === 'supported',
      'CLI：真跑 --gaps 後 R12 的 manifest 面向吃到 gaps-sample 裡的 supported（非固定 not_measured 骨架）',
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

    // F5：真語法壞（截斷）的 gaps.json——JSON.parse 本身就丟例外，不是 schema 驗證那條路徑；
    // 兩種壞法都要被擋，且要能從錯誤訊息分辨是「JSON 語法壞」而非「schema 欄位壞」。
    const withMalformedGaps = spawnSync(
      'node',
      [...baseArgs, '--date', '20260303', '--out-dir', tmpDir, '--gaps', join(GAPS_SAMPLE_DIR, 'malformed-gaps.json')],
      { cwd: ROOT, encoding: 'utf8' },
    );
    assert(withMalformedGaps.status !== 0, 'CLI：語法壞（截斷）的 gaps.json → 非零退出');
    assert(
      /不是合法 JSON/.test(withMalformedGaps.stderr),
      'CLI：語法壞的 gaps.json 走 JSON.parse 診斷分支（訊息含「不是合法 JSON」，非 schema 驗證錯誤訊息）',
    );
    assert(
      !existsSync(join(tmpDir, 'baseline-20260303-gapstest.json')),
      'CLI：語法壞的 gaps.json 同樣不落地任何 report 檔',
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
