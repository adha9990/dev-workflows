#!/usr/bin/env node
// test-baseline-trace.mjs —— baseline-trace.mjs 的紅綠斷言（自帶極簡 harness，不引測試框架）。
// 用法：node test-baseline-trace.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1（主線用此 exit code 判紅綠）。
//
// 預期 Red：baseline-trace.mjs 尚未實作，下面的 import 會 ERR_MODULE_NOT_FOUND，
// 整個檔在載入期就丟例外 → node 以非 0 退出。這就是 TDD 的紅燈起點。
// e2e smoke 另需 scripts/fixtures/baseline/fake-loops-root/ 下的假 .loops 樹（已由 quality-integrator 建）。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

import {
  parseSessionId,
  extractOutcomeLine,
  parseTokenRange,
  parseSubagentCount,
  parseCostsLines,
  filterSessionRows,
  buildPreciseTrace,
  buildDegradedTrace,
  resolveRepoName,
  traceSingleLoop,
  scanOutcomeLoops,
} from './baseline-trace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../scripts
const ROOT = dirname(HERE); // plugin root
const FIXTURE_ROOT = join(HERE, 'fixtures', 'baseline', 'fake-loops-root');

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

// ════════════════════════════════════════════════════════════════════════════
//  parseSessionId —— 兩種冒號寫法（半形/全形）
// ════════════════════════════════════════════════════════════════════════════

{
  const fullwidth = '- **session**：aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  assert(
    parseSessionId(fullwidth) === 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'parseSessionId：全形冒號（無空格）可解析',
  );
  const ascii = '- **session**: bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  assert(
    parseSessionId(ascii) === 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'parseSessionId：半形冒號（帶空格）可解析',
  );
  assert(parseSessionId('沒有 session 這行') === null, 'parseSessionId：無 session 行 → null');
  assert(parseSessionId('') === null, 'parseSessionId：空字串 → null');
}

// ════════════════════════════════════════════════════════════════════════════
//  extractOutcomeLine / parseTokenRange / parseSubagentCount
// ════════════════════════════════════════════════════════════════════════════

{
  const journal = '- [E1] dispatch：foo\n- ★[outcome] 完工 ｜ token≈200k-400k(級距)est ｜ sub-agent 10 ｜ 回環 1 圈';
  const line = extractOutcomeLine(journal);
  assert(typeof line === 'string' && line.includes('★[outcome]'), 'extractOutcomeLine：抓到含 ★[outcome] 的整行');
  assert(extractOutcomeLine('無此標記的文字') === null, 'extractOutcomeLine：無標記 → null');

  assert(
    JSON.stringify(parseTokenRange('token≈200k-400k(級距)est')) === JSON.stringify([200000, 400000]),
    'parseTokenRange：k 單位、連字號 dash',
  );
  assert(
    JSON.stringify(parseTokenRange('token≈2M–3M est（備註）')) === JSON.stringify([2000000, 3000000]),
    'parseTokenRange：M 單位、en-dash、無空格',
  );
  assert(parseTokenRange('沒有 token 級距') === null, 'parseTokenRange：解不出 → null');

  assert(parseSubagentCount('sub-agent 10 ｜ 回環') === 10, 'parseSubagentCount：純數字');
  assert(
    parseSubagentCount('sub-agent 6（plan 審 2、其餘見說明）｜ 回環') === 6,
    'parseSubagentCount：數字後有括號註記，仍只取數字',
  );
  assert(parseSubagentCount('沒有這個欄位') === null, 'parseSubagentCount：解不出 → null');
}

// ════════════════════════════════════════════════════════════════════════════
//  parseCostsLines —— 壞行容錯
// ════════════════════════════════════════════════════════════════════════════

{
  const content = '{"a":1}\nnot json at all\n{"b":2}\n\n';
  const rows = parseCostsLines(content);
  assert(rows.length === 2, 'parseCostsLines：壞行被跳過、只留合法 JSON 物件');
  assert(rows[0].a === 1 && rows[1].b === 2, 'parseCostsLines：保留原順序');
  assert(parseCostsLines('').length === 0, 'parseCostsLines：空字串 → 空陣列');
  assert(parseCostsLines(undefined).length === 0, 'parseCostsLines：undefined → 空陣列（不丟例外）');
}

// ════════════════════════════════════════════════════════════════════════════
//  filterSessionRows —— 嚴格全等（假陽性防護）＋依 ts 排序
// ════════════════════════════════════════════════════════════════════════════

{
  const rows = [
    { ts: 5000, session_id: 'aaaa' },
    { ts: 1000, session_id: 'aaaa' },
    { ts: 3000, session_id: 'aaaa-extra' }, // 前綴命中但非全等 —— 不得誤配
    { ts: 2000, session_id: 'bbbb' },
  ];
  const out = filterSessionRows(rows, 'aaaa');
  assert(out.length === 2, 'filterSessionRows：只命中全等 session_id（假陽性行被排除）');
  assert(out[0].ts === 1000 && out[1].ts === 5000, 'filterSessionRows：依 ts 升冪排序');
  assert(filterSessionRows(rows, 'no-such-session').length === 0, 'filterSessionRows：無命中 → 空陣列');
}

// ════════════════════════════════════════════════════════════════════════════
//  buildPreciseTrace —— main/total 雙欄（schema2 無 subagents／schema3 含 subagents）
// ════════════════════════════════════════════════════════════════════════════

{
  // schema2、單筆 → duration not_measured、main === total_incl_subagents
  const single = buildPreciseTrace({
    loopSlug: 'x', repo: 'r', sessionId: 's',
    rows: [{ ts: 2000, session_id: 's', schema: 2, input_tokens: 50, output_tokens: 60, cache_creation_input_tokens: 5, cache_read_input_tokens: 70, cost_usd: 0.12 }],
  });
  assert(single.duration_ms === 'not_measured', 'buildPreciseTrace：單筆快照 → duration_ms=not_measured');
  assert(single.main.total === 50 + 60 + 5 + 70, 'buildPreciseTrace：main.total 為四欄加總');
  assert(
    JSON.stringify(single.main) === JSON.stringify(single.total_incl_subagents),
    'buildPreciseTrace：schema2 無 subagents → main 與 total_incl_subagents 相等',
  );
  assert(single.cost_usd.main === 0.12 && single.cost_usd.total === 0.12, 'buildPreciseTrace：schema2 cost_usd.total 退回 main');
  assert(single.subagent_count === 0, 'buildPreciseTrace：schema2 無 subagents → subagent_count=0');
  assert(JSON.stringify(single.schema_versions_seen) === JSON.stringify([2]), 'buildPreciseTrace：schema_versions_seen=[2]');

  // schema2+3 混雜、多筆 → duration 為首尾差、total_incl_subagents 含子代理欄
  const mixed = buildPreciseTrace({
    loopSlug: 'y', repo: 'r', sessionId: 's2',
    rows: [
      { ts: 1000, session_id: 's2', schema: 2, input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, cost_usd: 0.05 },
      {
        ts: 5000, session_id: 's2', schema: 3, input_tokens: 400, output_tokens: 800, cache_creation_input_tokens: 50, cache_read_input_tokens: 900, cost_usd: 1.23,
        subagents: { count: 2, input_tokens: 40, output_tokens: 80, cache_creation_input_tokens: 5, cache_read_input_tokens: 90, cost_usd: 0.45 },
        total_cost_usd: 1.68,
        by_stage: [{ stage: 'build', turns: 3 }],
      },
    ],
  });
  assert(mixed.duration_ms === 4000, 'buildPreciseTrace：多筆 → duration_ms=首尾 ts 差');
  assert(mixed.first_ts === 1000 && mixed.last_ts === 5000, 'buildPreciseTrace：first_ts/last_ts 取自排序後首尾');
  assert(mixed.main.input === 400 && mixed.main.total === 400 + 800 + 50 + 900, 'buildPreciseTrace：main 取最後一筆（累計帳），非加總所有筆');
  assert(
    mixed.total_incl_subagents.input === 440 && mixed.total_incl_subagents.total === (400 + 40) + (800 + 80) + (50 + 5) + (900 + 90),
    'buildPreciseTrace：total_incl_subagents = main + subagents 同名欄',
  );
  assert(mixed.cost_usd.main === 1.23 && mixed.cost_usd.total === 1.68, 'buildPreciseTrace：schema3 cost_usd.total 取 total_cost_usd');
  assert(mixed.subagent_count === 2, 'buildPreciseTrace：subagent_count 取自最後一筆 subagents.count');
  assert(JSON.stringify(mixed.schema_versions_seen) === JSON.stringify([2, 3]), 'buildPreciseTrace：schema_versions_seen 混雜去重排序');
  assert(Array.isArray(mixed.by_stage) && mixed.by_stage.length === 1, 'buildPreciseTrace：by_stage 透傳最後一筆');
  assert(
    mixed.caveats.some((c) => c.includes('Stop-to-Stop')),
    'buildPreciseTrace：caveats 固定帶 duration 口徑聲明',
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  buildDegradedTrace —— 無帳降級（est_range 或完全 not_measured）
// ════════════════════════════════════════════════════════════════════════════

{
  const withOutcome = buildDegradedTrace({
    loopSlug: 'z', repo: 'r', sessionId: 's3',
    outcomeLine: '★[outcome] 完工 ｜ token≈120k-260k(級距)est ｜ sub-agent 6（備註）｜ 回環 1 圈',
  });
  assert(
    JSON.stringify(withOutcome.main) === JSON.stringify({ est_range: [120000, 260000], source: 'outcome-line' }),
    'buildDegradedTrace：有 outcome 行 → main 為 est_range',
  );
  assert(
    JSON.stringify(withOutcome.main) === JSON.stringify(withOutcome.total_incl_subagents),
    'buildDegradedTrace：降級態 main 與 total_incl_subagents 同形',
  );
  assert(withOutcome.subagent_count === 6, 'buildDegradedTrace：subagent_count 解自 outcome 行');
  assert(withOutcome.duration_ms === 'not_measured', 'buildDegradedTrace：duration_ms 恆為 not_measured');
  assert(withOutcome.cost_usd.main === 'not_measured', 'buildDegradedTrace：cost_usd 不假裝精確');

  const noOutcome = buildDegradedTrace({ loopSlug: 'w', repo: 'r', sessionId: 's4', outcomeLine: null });
  assert(noOutcome.main === 'not_measured', 'buildDegradedTrace：無 outcome 行 → main 完全 not_measured');
  assert(noOutcome.subagent_count === 'not_measured', 'buildDegradedTrace：無 outcome 行 → subagent_count not_measured');
}

// ════════════════════════════════════════════════════════════════════════════
//  resolveRepoName
// ════════════════════════════════════════════════════════════════════════════

{
  assert(resolveRepoName('C:/foo/bar/eagle-app-core') === 'eagle-app-core', 'resolveRepoName：取路徑最後一段');
  assert(resolveRepoName('C:/foo/bar/eagle-app-core/') === 'eagle-app-core', 'resolveRepoName：容忍尾端斜線');
}

// ════════════════════════════════════════════════════════════════════════════
//  traceSingleLoop —— IO 整合（讀假 .loops 樹）
// ════════════════════════════════════════════════════════════════════════════

{
  const precise = traceSingleLoop({ loopSlug: 'precise-loop', loopsRoot: FIXTURE_ROOT });
  assert(precise.session_id === 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'traceSingleLoop(precise-loop)：session 解析正確');
  assert(precise.duration_ms === 4000, 'traceSingleLoop(precise-loop)：精確 costs.jsonl 存在時優先精確路徑（即使也有 outcome 行）');
  assert(JSON.stringify(precise.schema_versions_seen) === JSON.stringify([2, 3]), 'traceSingleLoop(precise-loop)：schema 2/3 混雜皆收（假陽性 session 排除）');
  assert(precise.subagent_count === 2, 'traceSingleLoop(precise-loop)：subagent_count 精確值＝2（非假陽性行的 999999 級數字）');

  const single = traceSingleLoop({ loopSlug: 'single-snapshot-loop', loopsRoot: FIXTURE_ROOT });
  assert(single.session_id === 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'traceSingleLoop(single-snapshot-loop)：session 解析正確（半形冒號）');
  assert(single.duration_ms === 'not_measured', 'traceSingleLoop(single-snapshot-loop)：單筆 → not_measured');

  const degraded = traceSingleLoop({ loopSlug: 'degraded-loop', loopsRoot: FIXTURE_ROOT });
  assert(degraded.session_id === 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'traceSingleLoop(degraded-loop)：session 有解析到，但 costs.jsonl 無命中');
  assert(
    JSON.stringify(degraded.main) === JSON.stringify({ est_range: [120000, 260000], source: 'outcome-line' }),
    'traceSingleLoop(degraded-loop)：降級為 outcome 行 est_range',
  );
  assert(degraded.subagent_count === 6, 'traceSingleLoop(degraded-loop)：subagent_count 解自 outcome 行');

  const noOutcome = traceSingleLoop({ loopSlug: 'no-outcome-loop', loopsRoot: FIXTURE_ROOT });
  assert(noOutcome.main === 'not_measured', 'traceSingleLoop(no-outcome-loop)：無帳無 outcome 行 → 完全 not_measured');

  const missing = traceSingleLoop({ loopSlug: 'does-not-exist', loopsRoot: FIXTURE_ROOT });
  assert(typeof missing.error === 'string', 'traceSingleLoop：loop.md 不存在 → 回傳 {error}（非拋例外）');
}

// ════════════════════════════════════════════════════════════════════════════
//  scanOutcomeLoops —— 只收有 ★[outcome] 的 loop
// ════════════════════════════════════════════════════════════════════════════

{
  const traces = scanOutcomeLoops({ loopsRoot: FIXTURE_ROOT });
  const slugs = traces.map((t) => t.loop_slug).sort();
  assert(
    JSON.stringify(slugs) === JSON.stringify(['degraded-loop', 'precise-loop', 'single-snapshot-loop']),
    'scanOutcomeLoops：只收有 outcome 行的 3 個 loop，排除 no-outcome-loop',
  );
  assert(traces.every((t) => t.loop_slug !== 'no-outcome-loop'), 'scanOutcomeLoops：no-outcome-loop 確實被排除');
}

// ════════════════════════════════════════════════════════════════════════════
//  F6：traceSingleLoop 接受可選 rows（跳過自己讀 costs.jsonl）＋ scanOutcomeLoops 只讀一次
// ════════════════════════════════════════════════════════════════════════════

{
  // 顯式給 rows（即使與磁碟上 costs.jsonl 內容不同）時，直接採信給定值、不理會磁碟——
  // 證明「providedRows !== undefined 就跳過自讀」這條分支真的生效，不是巧合同值。
  const givenRows = [
    { ts: 1, session_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', schema: 2, input_tokens: 7, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost_usd: 0 },
  ];
  const withGivenRows = traceSingleLoop({ loopSlug: 'precise-loop', loopsRoot: FIXTURE_ROOT, rows: givenRows });
  assert(withGivenRows.main.input === 7, 'traceSingleLoop：顯式給 rows 時直接採信（不重讀磁碟上的 costs.jsonl）');
  assert(withGivenRows.duration_ms === 'not_measured', 'traceSingleLoop：顯式 rows 只有 1 筆 → duration_ms=not_measured（與磁碟版〔4000〕不同，證明真的用了給定值）');

  const withEmptyRows = traceSingleLoop({ loopSlug: 'precise-loop', loopsRoot: FIXTURE_ROOT, rows: [] });
  assert(
    JSON.stringify(withEmptyRows.main) !== JSON.stringify({ input: 400, output: 800, cache_creation: 50, cache_read: 900, total: 2150 }),
    'traceSingleLoop：顯式給空陣列 rows（非 undefined）→ 視為「查過、零命中」，走降級路徑而非自己讀磁碟',
  );

  // costs.jsonl 只被讀一次：monkeypatch fs.readFileSync 計數，用 module.syncBuiltinESMExports()
  // 把 patch 同步進 baseline-trace.mjs 內已綁定的具名 import（Node 官方建議的 builtin mock 手法）。
  let costsReadCount = 0;
  const realReadFileSync = fs.readFileSync;
  fs.readFileSync = function counting(...args) {
    if (String(args[0]).endsWith('costs.jsonl')) costsReadCount += 1;
    return realReadFileSync.apply(fs, args);
  };
  syncBuiltinESMExports();
  let scanned;
  try {
    scanned = scanOutcomeLoops({ loopsRoot: FIXTURE_ROOT });
  } finally {
    fs.readFileSync = realReadFileSync;
    syncBuiltinESMExports();
  }
  assert(scanned.length === 3, 'scanOutcomeLoops：修正後仍正確收到 3 個 outcome loop（行為不變）');
  assert(costsReadCount === 1, `scanOutcomeLoops：costs.jsonl 只被讀一次（實際 ${costsReadCount} 次）——F6 效能修正`);
}

// ════════════════════════════════════════════════════════════════════════════
//  F4：CLI e2e（--loop 成功／--scan-outcomes 成功／缺 --loops-root exit 2／loops-root 不存在 exit 3）
// ════════════════════════════════════════════════════════════════════════════

{
  const loopOk = spawnSync(
    'node',
    [join(HERE, 'baseline-trace.mjs'), '--loop', 'precise-loop', '--loops-root', FIXTURE_ROOT, '--json'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert(loopOk.status === 0, `CLI：--loop + --loops-root + --json → exit 0（stderr: ${loopOk.stderr}）`);
  let loopReport = null;
  try { loopReport = JSON.parse(loopOk.stdout); } catch { /* 下面斷言報壞 */ }
  assert(loopReport?.loop_slug === 'precise-loop', 'CLI：--loop --json 輸出正確的 loop_slug');

  const scanOk = spawnSync(
    'node',
    [join(HERE, 'baseline-trace.mjs'), '--scan-outcomes', '--loops-root', FIXTURE_ROOT, '--json'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert(scanOk.status === 0, `CLI：--scan-outcomes → exit 0（stderr: ${scanOk.stderr}）`);
  let scanReport = null;
  try { scanReport = JSON.parse(scanOk.stdout); } catch { /* 下面斷言報壞 */ }
  assert(Array.isArray(scanReport) && scanReport.length === 3, 'CLI：--scan-outcomes --json 輸出陣列，3 筆 outcome loop');

  const missingRoot = spawnSync('node', [join(HERE, 'baseline-trace.mjs'), '--loop', 'precise-loop'], { cwd: ROOT, encoding: 'utf8' });
  assert(missingRoot.status === 2, 'CLI：缺 --loops-root（誤用）→ exit 2');

  const nonExistentRoot = spawnSync(
    'node',
    [join(HERE, 'baseline-trace.mjs'), '--loop', 'precise-loop', '--loops-root', join(FIXTURE_ROOT, 'does-not-exist-root'), '--json'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert(nonExistentRoot.status === 3, 'CLI：--loops-root 指向不存在的路徑 → exit 3');
}

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.error('\n失敗清單：');
  for (const f of failed) console.error(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
