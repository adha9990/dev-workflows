#!/usr/bin/env node
// test-baseline-corpus.mjs —— baseline-corpus.mjs 的紅綠斷言（自帶極簡 harness，不引測試框架）。
// 用法：node test-baseline-corpus.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1（主線用此 exit code 判紅綠）。
//
// 預期 Red：baseline-corpus.mjs 尚未實作，下面的 import 會 ERR_MODULE_NOT_FOUND，
// 整個檔在載入期就丟例外 → node 以非 0 退出。這就是 TDD 的紅燈起點。
// smoke corpus 子集：scripts/fixtures/baseline/corpus-sample/（quality-integrator 自製最小樣本，
// 涵蓋三 oracle.type；不是 T1 產的真實 9 類語料——CI glob 自動涵蓋＝S5）。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  validateFixtureSchema,
  normalizeExpectedOutcome,
  scoreRouteDecision,
  normalizeTrajectoryResult,
  scoreOracle,
  buildFixtureResult,
  buildCorpusReport,
  resolveObservedStages,
  evaluateFixture,
  loadCorpusFixtures,
} from './baseline-corpus.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../scripts
const ROOT = dirname(HERE); // plugin root
const SAMPLE_DIR = join(HERE, 'fixtures', 'baseline', 'corpus-sample');

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

function minimalValidFixture(overrides = {}) {
  return {
    id: 'x',
    category: 'docs-only',
    harness: ['claude-code'],
    provenance: { source_type: 'real-loop', ref: 'r', captured_at: '2026-07-25', method: 'm' },
    oracle: { type: 'route-decision', config: { expected_route: 'a', recorded_actual: 'a' } },
    nondeterminism: 'none',
    replay_cmd: 'node x.mjs',
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  validateFixtureSchema —— C1 必填欄逐一斷言
// ════════════════════════════════════════════════════════════════════════════

{
  assert(validateFixtureSchema(minimalValidFixture()).valid === true, 'validateFixtureSchema：合法 fixture → valid');
  assert(validateFixtureSchema(minimalValidFixture({ id: '' })).valid === false, 'validateFixtureSchema：id 空字串 → invalid');
  assert(validateFixtureSchema(minimalValidFixture({ category: 'not-a-category' })).valid === false, 'validateFixtureSchema：category 不在枚舉 → invalid');
  assert(validateFixtureSchema(minimalValidFixture({ harness: [] })).valid === false, 'validateFixtureSchema：harness 空陣列 → invalid');
  assert(validateFixtureSchema(minimalValidFixture({ harness: ['gpt'] })).valid === false, 'validateFixtureSchema：harness 含不合法值 → invalid');
  assert(validateFixtureSchema(minimalValidFixture({ provenance: undefined })).valid === false, 'validateFixtureSchema：缺 provenance → invalid');
  assert(
    validateFixtureSchema(minimalValidFixture({ provenance: { source_type: 'bad', ref: 'r', captured_at: 'c', method: 'm' } })).valid === false,
    'validateFixtureSchema：provenance.source_type 不在枚舉 → invalid',
  );
  assert(validateFixtureSchema(minimalValidFixture({ oracle: undefined })).valid === false, 'validateFixtureSchema：缺 oracle → invalid');
  assert(
    validateFixtureSchema(minimalValidFixture({ oracle: { type: 'not-a-type', config: {} } })).valid === false,
    'validateFixtureSchema：oracle.type 不在枚舉 → invalid',
  );
  assert(validateFixtureSchema(minimalValidFixture({ nondeterminism: undefined })).valid === false, 'validateFixtureSchema：缺 nondeterminism → invalid');
  assert(validateFixtureSchema(minimalValidFixture({ replay_cmd: '' })).valid === false, 'validateFixtureSchema：replay_cmd 空字串 → invalid');
  assert(
    validateFixtureSchema(minimalValidFixture({ expected_outcome: 'maybe' })).valid === false,
    'validateFixtureSchema：expected_outcome 非法值 → invalid',
  );
  assert(
    validateFixtureSchema(minimalValidFixture({ expected_outcome: 'expected-fail' })).valid === true,
    'validateFixtureSchema：expected_outcome=expected-fail 合法',
  );

  // 逐型 oracle.config 定形
  assert(
    validateFixtureSchema(minimalValidFixture({ oracle: { type: 'quality-gate', config: {} } })).valid === false,
    'validateFixtureSchema：quality-gate 缺 workspace/failToPass/passToPass → invalid',
  );
  assert(
    validateFixtureSchema(
      minimalValidFixture({ oracle: { type: 'quality-gate', config: { workspace: 'ws', failToPass: ['a'] } } }),
    ).valid === true,
    'validateFixtureSchema：quality-gate 有 workspace + 至少一個 xToPass 陣列 → valid',
  );
  assert(
    validateFixtureSchema(minimalValidFixture({ oracle: { type: 'trajectory-rules', config: {} } })).valid === false,
    'validateFixtureSchema：trajectory-rules 缺 reference/observed_journal → invalid',
  );
  assert(
    validateFixtureSchema(
      minimalValidFixture({ oracle: { type: 'trajectory-rules', config: { reference: { required: [] }, observed_journal: 'x' } } }),
    ).valid === true,
    'validateFixtureSchema：trajectory-rules 有 reference + observed_journal → valid',
  );
  assert(
    validateFixtureSchema(minimalValidFixture({ oracle: { type: 'route-decision', config: {} } })).valid === false,
    'validateFixtureSchema：route-decision 缺 expected_route/recorded_actual → invalid',
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  normalizeExpectedOutcome
// ════════════════════════════════════════════════════════════════════════════

{
  assert(normalizeExpectedOutcome({}) === 'pass', 'normalizeExpectedOutcome：未指定 → 缺省 pass');
  assert(normalizeExpectedOutcome({ expected_outcome: 'expected-fail' }) === 'expected-fail', 'normalizeExpectedOutcome：顯式 expected-fail 保留');
  assert(normalizeExpectedOutcome({ expected_outcome: 'garbage' }) === 'pass', 'normalizeExpectedOutcome：非法值退回 pass（schema 驗證另擋）');
}

// ════════════════════════════════════════════════════════════════════════════
//  scoreRouteDecision
// ════════════════════════════════════════════════════════════════════════════

{
  const ok = scoreRouteDecision({ expected_route: 'build', recorded_actual: 'build' });
  assert(ok.pass === true && ok.errored === false, 'scoreRouteDecision：相符 → pass');

  const mismatch = scoreRouteDecision({ expected_route: 'maintainer', recorded_actual: 'iterate' });
  assert(mismatch.pass === false && mismatch.errored === false, 'scoreRouteDecision：不符 → fail（非 errored，現況如實記紅）');
  assert(mismatch.reason.includes('maintainer') && mismatch.reason.includes('iterate'), 'scoreRouteDecision：reason 帶雙方路由值');

  const missing = scoreRouteDecision({});
  assert(missing.errored === true, 'scoreRouteDecision：缺欄 → errored');
}

// ════════════════════════════════════════════════════════════════════════════
//  normalizeTrajectoryResult
// ════════════════════════════════════════════════════════════════════════════

{
  const okResult = normalizeTrajectoryResult({ ok: true, missing: [], extra: [], forbidden: [], orderViolations: [] });
  assert(okResult.pass === true, 'normalizeTrajectoryResult：ok=true → pass');

  const badResult = normalizeTrajectoryResult({ ok: false, missing: ['build'], extra: [], forbidden: ['verify'], orderViolations: [['a', 'b']] });
  assert(badResult.pass === false, 'normalizeTrajectoryResult：ok=false → pass=false');
  assert(badResult.reason.includes('build') && badResult.reason.includes('verify'), 'normalizeTrajectoryResult：reason 併漏階段與禁止階段');
}

// ════════════════════════════════════════════════════════════════════════════
//  scoreOracle —— 三軌分派
// ════════════════════════════════════════════════════════════════════════════

{
  const gate = {
    ok: true,
    status: 'passed',
    gates: { test: 'passed' },
    failures: [],
    passedTests: ['math > add returns sum'],
  };
  const qgResult = scoreOracle('quality-gate', { failToPass: ['add returns sum'], passToPass: [] }, { gateResult: gate });
  assert(typeof qgResult.pass === 'boolean', 'scoreOracle(quality-gate)：委派 scoreTask，回傳含 pass 欄');

  const trResult = scoreOracle('trajectory-rules', { reference: { required: ['goal'] } }, { observedStages: ['goal'] });
  assert(trResult.pass === true, 'scoreOracle(trajectory-rules)：observedStages 命中 required → pass');

  const trNoStages = scoreOracle('trajectory-rules', { reference: { required: ['goal'] } }, {});
  assert(trNoStages.errored === true, 'scoreOracle(trajectory-rules)：無 observedStages 陣列 → errored');

  const rdResult = scoreOracle('route-decision', { expected_route: 'a', recorded_actual: 'a' }, {});
  assert(rdResult.pass === true, 'scoreOracle(route-decision)：委派 scoreRouteDecision');

  const unknown = scoreOracle('not-a-real-type', {}, {});
  assert(unknown.errored === true, 'scoreOracle：未知 oracle.type → errored');
}

// ════════════════════════════════════════════════════════════════════════════
//  buildFixtureResult / buildCorpusReport
// ════════════════════════════════════════════════════════════════════════════

{
  const fx = minimalValidFixture({ id: 'r1', expected_outcome: 'expected-fail' });
  const result = buildFixtureResult(fx, { pass: false, errored: false, reason: 'nope' });
  assert(result.id === 'r1' && result.expectedOutcome === 'expected-fail' && result.pass === false, 'buildFixtureResult：passthrough 欄位齊全');

  const report = buildCorpusReport([{ pass: true }, { pass: false }, { pass: true }]);
  assert(report.total === 3 && report.passed === 2 && report.failed === 1, 'buildCorpusReport：聚合正確');
}

// ════════════════════════════════════════════════════════════════════════════
//  resolveObservedStages
// ════════════════════════════════════════════════════════════════════════════

{
  assert(
    JSON.stringify(resolveObservedStages({ observed_journal: ['goal', 'build'] }, SAMPLE_DIR)) === JSON.stringify(['goal', 'build']),
    'resolveObservedStages：已解析陣列直接使用',
  );
  assert(
    JSON.stringify(resolveObservedStages({ observed_journal: '- [goal] x\n- [build] y\n' }, SAMPLE_DIR)) === JSON.stringify(['goal', 'build']),
    'resolveObservedStages：內嵌 Journal 文字經 parseStages 解析',
  );
  assert(resolveObservedStages({}, SAMPLE_DIR) === null, 'resolveObservedStages：無 observed_journal/_file → null');
  assert(
    resolveObservedStages({ observed_journal_file: 'does-not-exist.md' }, SAMPLE_DIR) === null,
    'resolveObservedStages：隨附檔讀不到 → null（不丟例外）',
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  resolveObservedStages —— 真實 T1 fixture 撞出的兩個迴歸（觀察摘錄檔路徑＋方法論說明文字污染）
// ════════════════════════════════════════════════════════════════════════════

{
  const tmpDir = mkdtempSync(join(tmpdir(), 'baseline-corpus-journal-test-'));
  try {
    // 迴歸 1：observed_journal 欄位裝的是「隨附檔路徑」（T1 真實 fixture 寫法），
    // 不是內嵌 Journal 文字本身——必須先試著當路徑讀檔，而非把路徑字串誤當文字去 parseStages。
    writeFileSync(join(tmpDir, 'observed-journal.md'), '## Journal\n\n- E1 [goal] 摘要\n- E2 [build] 摘要\n', 'utf8');
    const viaPath = resolveObservedStages({ observed_journal: 'observed-journal.md' }, tmpDir);
    assert(
      JSON.stringify(viaPath) === JSON.stringify(['goal', 'build']),
      'resolveObservedStages：observed_journal 是隨附檔相對路徑時，讀檔內容而非誤當內嵌文字（T1 真實寫法）',
    );

    // 迴歸 2：摘錄檔上半部的方法論說明文字若含示範用方括號（如反引號包住的 `[stagename]`），
    // 只掃 `## Journal` 區段才不會把這些示範文字誤抽成階段（沿用 eval-trajectory 既有策略）。
    writeFileSync(
      join(tmpDir, 'observed-journal-with-preamble.md'),
      '# 摘要\n\n> 格式說明：真實寫法是 `- E# [stagename] ...`，範例 `[E1]` 僅供示意。\n\n## Journal\n\n- E1 [goal] 摘要\n',
      'utf8',
    );
    const withPreamble = resolveObservedStages({ observed_journal: 'observed-journal-with-preamble.md' }, tmpDir);
    assert(
      JSON.stringify(withPreamble) === JSON.stringify(['goal']),
      'resolveObservedStages：只掃 ## Journal 區段，不被上半部說明文字的示範方括號污染（真實 T1 fixture 撞出的迴歸）',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  evaluateFixture —— containment 守門（quality-gate workspace 逃逸拒絕）
// ════════════════════════════════════════════════════════════════════════════

{
  const escaped = evaluateFixture(
    minimalValidFixture({ oracle: { type: 'quality-gate', config: { workspace: '../../../../etc', failToPass: ['a'] } } }),
    SAMPLE_DIR,
  );
  assert(escaped.errored === true && escaped.pass === false, 'evaluateFixture：workspace 路徑逃逸 plugin 根 → errored（不 spawn）');

  const absWs = evaluateFixture(
    minimalValidFixture({ oracle: { type: 'quality-gate', config: { workspace: 'C:/Windows', failToPass: ['a'] } } }),
    SAMPLE_DIR,
  );
  assert(absWs.errored === true, 'evaluateFixture：絕對路徑 workspace → errored（不 spawn）');

  const invalidSchema = evaluateFixture({ id: 'broken' }, SAMPLE_DIR);
  assert(invalidSchema.errored === true && invalidSchema.pass === false, 'evaluateFixture：schema 不合法 fixture → errored/非通過');
}

// ════════════════════════════════════════════════════════════════════════════
//  smoke corpus 子集實跑（scripts/fixtures/baseline/corpus-sample/）
// ════════════════════════════════════════════════════════════════════════════

{
  const entries = loadCorpusFixtures(SAMPLE_DIR);
  assert(entries.length === 5, 'loadCorpusFixtures：讀到 5 個樣本 fixture');

  const byId = Object.fromEntries(entries.map((e) => [e.fixture.id, evaluateFixture(e.fixture, SAMPLE_DIR)]));

  assert(byId['route-ok-sample']?.pass === true, 'smoke：route-ok-sample → pass');
  assert(
    byId['route-mismatch-sample']?.pass === false && byId['route-mismatch-sample']?.expectedOutcome === 'expected-fail',
    'smoke：route-mismatch-sample → fail 且標 expected-fail',
  );
  assert(byId['trajectory-ok-sample']?.pass === true, 'smoke：trajectory-ok-sample → pass');
  assert(
    byId['trajectory-missing-provenance-sample']?.errored === true,
    'smoke：trajectory-missing-provenance-sample 缺 provenance → errored（非零退出訊號）',
  );
  assert(byId['quality-gate-sample']?.pass === true, 'smoke：quality-gate-sample 真跑 canned reporter → pass');
}

// ════════════════════════════════════════════════════════════════════════════
//  CLI e2e —— exit code 與 --json 輸出
// ════════════════════════════════════════════════════════════════════════════

{
  const res = spawnSync('node', [join(HERE, 'baseline-corpus.mjs'), '--dir', SAMPLE_DIR, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert(res.status === 1, 'CLI：sample corpus 含誠實紅 + 缺欄 fixture → exit 1（failed>0）');
  let report = null;
  try {
    report = JSON.parse(res.stdout);
  } catch {
    /* 交給下面斷言報壞 */
  }
  assert(report && report.total === 5, 'CLI --json：total=5');

  const single = spawnSync(
    'node',
    [join(HERE, 'baseline-corpus.mjs'), '--dir', SAMPLE_DIR, '--fixture', 'route-ok-sample', '--json'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert(single.status === 0, 'CLI：單一 --fixture 全過 → exit 0');

  // --corpus/--task 別名（T1 的 10 個真實 fixture 的 replay_cmd 一致採用這套拼法，非 --dir/--fixture）。
  const aliasFlags = spawnSync(
    'node',
    [join(HERE, 'baseline-corpus.mjs'), '--corpus', SAMPLE_DIR, '--task', 'route-ok-sample', '--json'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert(aliasFlags.status === 0, 'CLI：--corpus/--task 別名旗標行為與 --dir/--fixture 一致（T1 replay_cmd 實際拼法）');

  const noMatch = spawnSync(
    'node',
    [join(HERE, 'baseline-corpus.mjs'), '--dir', SAMPLE_DIR, '--fixture', 'no-such-id', '--json'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert(noMatch.status === 2, 'CLI：--fixture 命不中任何 id → exit 2（不可假成功）');

  const noDir = spawnSync('node', [join(HERE, 'baseline-corpus.mjs'), '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert(noDir.status === 1, 'CLI：缺 --dir（誤用）→ exit 1');
}

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.error('\n失敗清單：');
  for (const f of failed) console.error(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
