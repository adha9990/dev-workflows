#!/usr/bin/env node
// test-diff-footprint.mjs —— diff footprint 對帳器的斷言（#215）。
// 對應驗收標準：PR 閘擋得住「未說明的 footprint drift」，但**不以固定 test:production ratio 阻擋
// 正當的測試**；範圍外施工、缺理由的新測試、重複證據各自成 blocking；量不到的項目據實標無從判定。
// 用法：node test-diff-footprint.mjs [--filter <case-prefix>] [--min-cases <n>]

import {
  TEST_PATH_PATTERNS, classifyPath, renameTarget, parseNumstat, summarizeChange, planBudget,
  auditFootprint, renderMarker, renderReport,
} from './diff-footprint.mjs';

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
const checks = (report) => report.blocking.map((b) => b.check);

// ── fixtures ────────────────────────────────────────────────────────────────

const row = (path, added = 10, deleted = 0) => ({ path, added, deleted, binary: false });

/** 一份「計畫說要改 src/a.ts、不新增測試」的 plan。 */
const planNoNewTest = () => ({
  behaviors: [{ id: 'B1', statement: '行為', risk: 'low', risk_triggers: [] }],
  slices: [{
    id: 'S1', title: '切片', behaviors: ['B1'], verification: 'v', files: ['src/a.ts'],
    production_change_budget: { files: 1, lines: 100 },
    test_change_budget: { files: 0, lines: 0 },
  }],
  evidence_portfolio: [{
    behavior_id: 'B1', existing_guard: 'tests/a.test.ts', primary_evidence: 'existing-test',
    evidence_layer: 'unit', new_test: false, new_test_reason: null, distinct_risk: null,
  }],
});

/** 同上，但計畫明說要新增測試且寫了理由。 */
function planWithNewTest() {
  const p = planNoNewTest();
  p.slices[0].test_change_budget = { files: 1, lines: 120 };
  p.evidence_portfolio = [{
    behavior_id: 'B1', existing_guard: null, primary_evidence: 'unit-test', evidence_layer: 'unit',
    new_test: true, new_test_reason: '既有測試沒有涵蓋 0 筆時的顯示', distinct_risk: null,
  }];
  return p;
}

// ══════════════════════════════════════════════════════════════════════════
testCase('F1', 'classifyPath：測試 / benchmark / fixture / 測試支援同一桶', () => {
  assert(TEST_PATH_PATTERNS.length >= 8, '測試面樣式集不只認一種命名慣例');
  for (const p of [
    'src/__tests__/a.test.ts', 'tests/a.ts', 'test/a.ts', 'e2e/flow.ts',
    'benchmark/x.bench.ts', 'src/fixtures/data.json', 'a/test-support/helper.ts',
    'client/src/a.spec.tsx', 'plugins/loops-workflow/scripts/test-foo.mjs', 'src/foo-test.ts',
  ]) {
    assert(classifyPath(p) === 'test', `${p} → test`);
  }
  for (const p of ['src/a.ts', 'client/src/components/FolderRow.tsx', 'docs/x.md', 'src/latest/index.ts']) {
    assert(classifyPath(p) === 'production', `${p} → production`);
  }
  assert(classifyPath('src\\__tests__\\a.test.ts') === 'test', 'Windows 反斜線路徑也判得出來');
});

testCase('F2', 'parseNumstat：一般行 / 二進位 / rename', () => {
  const rows = parseNumstat('12\t3\tsrc/a.ts\n-\t-\tassets/logo.png\n5\t0\tsrc/{old => new}/b.ts\n\n雜訊行');
  assert(rows.length === 3, '三個改動檔（雜訊行忽略）');
  assert(rows[0].added === 12 && rows[0].deleted === 3, '一般行取到增刪行數');
  assert(rows[1].binary === true && rows[1].added === 0, '二進位檔計 0 行但仍算一個改動檔');
  assert(rows[2].path === 'src/new/b.ts', 'rename 取箭頭右側當落點');
  assert(renameTarget('old/a.ts => new/a.ts') === 'new/a.ts', 'rename 整段形');
  assert(renameTarget('src/{ => nested}/a.ts') === 'src/nested/a.ts', 'rename 空 old 段不留下雙斜線');
  assert(renameTarget('src/{nested => }/a.ts') === 'src/a.ts', 'rename 空 new 段收乾淨');
  assert(renameTarget('src/plain.ts') === 'src/plain.ts', '非 rename 原樣回傳');
});

testCase('F3', 'summarizeChange：兩桶行數與比例', () => {
  const s = summarizeChange([row('src/a.ts', 100), row('src/__tests__/a.test.ts', 250)]);
  assert(s.production.lines === 100 && s.production.files === 1, '功能面 1 檔 100 行');
  assert(s.test.lines === 250 && s.test.files === 1, '測試面 1 檔 250 行');
  assert(Math.abs(s.ratio - 2.5) < 1e-9, '比例＝測試／功能');
  assert(summarizeChange([row('src/__tests__/a.test.ts', 5)]).ratio === null, '功能面 0 行時比例無定義（不除以零）');
});

testCase('F4', 'planBudget：逐 slice 加總；沒宣告回 null', () => {
  const total = planBudget({
    slices: [
      { production_change_budget: { files: 1, lines: 100 }, test_change_budget: { files: 1, lines: 50 } },
      { production_change_budget: { files: 2, lines: 200 }, test_change_budget: { files: 0, lines: 0 } },
    ],
  });
  assert(total.production.lines === 300 && total.production.files === 3, '功能 budget 加總');
  assert(total.test.lines === 50 && total.test.files === 1, '測試 budget 加總');
  assert(planBudget({ slices: [{ id: 'S1' }] }) === null, '沒宣告 budget → null（不假裝有預算）');
  assert(planBudget({ tasks: [{ production_change_budget: { files: 1, lines: 9 }, test_change_budget: { files: 0, lines: 0 } }] }).production.lines === 9,
    'legacy tasks 鍵也讀得到');
});

testCase('F5', '一切照計畫 → status=ok', () => {
  const r = auditFootprint([row('src/a.ts', 80)], planNoNewTest());
  assert(r.status === 'ok', `照計畫走 → ok（實際 blocking：${checks(r).join(',')}）`);
  assert(r.blocking.length === 0 && r.warnings.length === 0, '沒有 blocking 也沒有 warning');
});

testCase('F6', '範圍外施工（改動檔不屬於任何核准 slice）→ 擋', () => {
  const r = auditFootprint([row('src/a.ts', 10), row('src/sneaky.ts', 40)], planNoNewTest());
  assert(r.status === 'blocked' && checks(r).includes('unslotted-change'), '不在 slice files 內的功能檔 → blocked');
  assert(r.blocking.find((b) => b.check === 'unslotted-change').detail.includes('src/sneaky.ts'), '訊息指名是哪個檔');
  assert(r.unslotted.length === 1, 'unslotted 只算功能面');
});

testCase('F7', '新測試沒有理由 → 擋；寫了理由 → 放行', () => {
  const noReason = auditFootprint([row('src/a.ts', 10), row('src/__tests__/a.test.ts', 120)], planNoNewTest());
  assert(noReason.status === 'blocked' && checks(noReason).includes('new-test-without-reason'),
    '計畫沒宣告要新增測試、diff 卻有測試改動 → blocked');

  const withReason = auditFootprint([row('src/a.ts', 10), row('src/__tests__/a.test.ts', 120)], planWithNewTest());
  assert(withReason.status !== 'blocked', `寫了 new_test_reason → 不擋（實際 blocking：${checks(withReason).join(',')}）`);

  const declaredButEmpty = planWithNewTest();
  declaredButEmpty.evidence_portfolio[0].new_test_reason = '  ';
  const empty = auditFootprint([row('src/a.ts', 10), row('src/__tests__/a.test.ts', 120)], declaredButEmpty);
  assert(empty.status === 'blocked' && checks(empty).includes('new-test-without-reason'), 'new_test=true 但理由只填空白 → 擋');
});

testCase('F8', '重複證據沒填 distinct_risk → 擋', () => {
  const plan = planNoNewTest();
  plan.evidence_portfolio.push({
    behavior_id: 'B1', existing_guard: 'tests/b.test.ts', primary_evidence: 'integration-test',
    evidence_layer: 'http', new_test: false, new_test_reason: null, distinct_risk: null,
  });
  const r = auditFootprint([row('src/a.ts', 10)], plan);
  assert(r.status === 'blocked' && checks(r).includes('duplicate-evidence'), '同一 behavior 兩份 primary → blocked');

  plan.evidence_portfolio[1].distinct_risk = 'HTTP 形狀改變不會被 unit 測試看見';
  const fixed = auditFootprint([row('src/a.ts', 10)], plan);
  assert(!checks(fixed).includes('duplicate-evidence'), '填了 distinct_risk 就不算重複');
});

testCase('F9', '超出 budget：沒理由 → 擋；補了 budget_overrun_reason → 只記 drift', () => {
  const over = auditFootprint([row('src/a.ts', 400)], planNoNewTest());
  assert(over.status === 'blocked' && checks(over).includes('unexplained-overrun'), '超出 budget 又沒理由 → blocked');
  assert(over.drift.production.lines === 300, 'drift 算得出超出多少行');

  const plan = planNoNewTest();
  plan.slices[0].budget_overrun_reason = '既有 count 服務要一併改簽名，plan 已同步';
  const explained = auditFootprint([row('src/a.ts', 400)], plan);
  assert(explained.status !== 'blocked', '補了可稽核理由 → 不擋');
  assert(explained.notes.some((n) => n.includes('budget_overrun_reason')), '仍在 notes 留痕（超出不是沒發生）');
});

testCase('F10', '比例只是 warning，永遠不擋（不以固定 ratio 當品質標準）', () => {
  const r = auditFootprint([row('src/a.ts', 100), row('src/__tests__/a.test.ts', 400)], planWithNewTest());
  assert(r.warnings.some((w) => w.includes(':1')), '測試多於功能 → 出 warning');
  assert(!checks(r).some((c) => c.includes('ratio')), '比例本身不產生 blocking check');
  assert(r.status === 'warn' || r.status === 'blocked', 'warn 會反映在 status（但不是因為比例才 blocked）');

  const onlyRatio = auditFootprint([row('src/a.ts', 100), row('src/__tests__/a.test.ts', 120)], (() => {
    const p = planWithNewTest();
    p.slices[0].production_change_budget = { files: 1, lines: 500 };
    p.slices[0].test_change_budget = { files: 1, lines: 500 };
    return p;
  })());
  assert(onlyRatio.status === 'warn', '只有比例超標、其餘都合規 → warn 而非 blocked');
});

testCase('F11', '沒有計畫 / 沒有 budget / 沒有 portfolio → 據實標無從判定，不假裝驗過', () => {
  const none = auditFootprint([row('src/a.ts', 10)], null);
  assert(none.status !== 'blocked', '沒計畫時不亂擋');
  assert(none.notes.length >= 3, '三項無從判定各留一條 note');
  assert(none.notes.some((n) => n.includes('slice')), '範圍外施工無從判定有留痕');
  assert(none.notes.some((n) => n.includes('evidence portfolio')), '證據對帳無從判定有留痕');
  assert(none.notes.some((n) => n.includes('budget')), 'drift 無從判定有留痕');
  assert(none.drift === null && none.budget === null, '沒有 budget 就不編一個 drift 數字');
  assert(none.status === 'warn', '無從判定 → status=warn，**不是 ok**（沒判過就不宣稱通過；warn 不影響閘⑧ 放行）');

  const noPortfolio = auditFootprint([row('src/a.ts', 10)], { slices: [{ id: 'S1', files: ['src/a.ts'], production_change_budget: { files: 1, lines: 100 }, test_change_budget: { files: 0, lines: 0 } }] });
  assert(noPortfolio.status === 'warn', '有 slice 與 budget、但沒 evidence portfolio → 仍是 warn（證據面沒判過）');
});

testCase('F12', 'marker 是 pr-gate 閘⑧ 的唯一契約（單行、HTML 註解、欄位齊全）', () => {
  const r = auditFootprint([row('src/a.ts', 10), row('src/sneaky.ts', 40)], planNoNewTest());
  const marker = renderMarker(r);
  assert(!marker.includes('\n'), 'marker 是單獨一行');
  assert(marker.startsWith('<!-- loops-footprint ') && marker.endsWith(' -->'), 'HTML 註解形（rendered 不可見）');
  for (const k of ['status=', 'prod=', 'test=', 'newtests=', 'unslotted=', 'unexplained=']) {
    assert(marker.includes(k), `marker 帶 ${k} 欄`);
  }
  assert(marker.includes('status=blocked') && marker.includes('unslotted=1'), '欄位值反映實際判定');
  assert(renderReport(r).includes(marker), '人讀報告最後一行就是同一份 marker');
});

// ══════════════════════════════════════════════════════════════════════════
const opts = parseArgs(process.argv.slice(2));
const selected = cases.filter((c) => c.id === opts.filter || c.id.startsWith(opts.filter));
for (const c of selected) { console.log(`\n[${c.id}] ${c.name}`); c.fn(); }
console.log(`\n${selected.length} cases run, ${passed} passed, ${failed.length} failed`);
if (opts.minCases > 0 && selected.length < opts.minCases) {
  console.error(`\n✗ case 數地板未達成：--min-cases ${opts.minCases}，實際 ${selected.length}`);
  process.exit(1);
}
if (failed.length) { console.error('\n失敗清單：'); for (const m of failed) console.error(`  - ${m}`); process.exit(1); }
process.exit(0);
