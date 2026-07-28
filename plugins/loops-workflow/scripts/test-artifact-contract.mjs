#!/usr/bin/env node
// test-artifact-contract.mjs —— artifact-contract.mjs 與兩份新 registry 的契約斷言（#217 增量 1）。
// 用法：node test-artifact-contract.mjs [--filter <case-id>] [--min-cases <n>]
//
// 覆蓋：
//   H-*  harness 自檢：受測模組不存在時仍必須全綠——把「模組還沒寫」跟「測試自己壞了」分開。
//   M-*  marker 契約：`<!-- loops-artifact: <id>@<v> -->` 只認第一行、格式嚴格、前後空白容忍。
//   P-*  path_pattern 比對：`<slug>` 佔位與 `**` 遞迴，且不得跨目錄誤中。
//   R-*  registry 自身形狀：id 唯一／kebab-case、值域、deterministic 必須有 renderer、
//        template 指到真的存在的檔、空清單要紅（空陣列會讓逐筆檢查恆真＝假綠）。
//   V-*  文件驗證：required_sections 前綴比對、版本不符、未登記 id、無 marker。
//   W-*  workflow vocabulary：iterate 不得是 phase、iteration-controller 要在 control node、
//        activity 涵蓋 #217 明列的那些、attribution 明文禁用 other-subagent。
//
// 落點紀律：暫存檔一律開在 os.tmpdir()，絕不在 worktree／repo 內建立 .loops/。

import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = join(HERE, 'artifact-contract.mjs');
const PLUGIN_ROOT = join(HERE, '..');

// ── 極簡 harness（沿用 test-loop-ledger.mjs 的形狀）──────────────────────────
let passed = 0;
const failed = [];
const cases = [];

function testCase(id, name, fn) {
  cases.push({ id, name, fn });
}

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function parseArgs(argv) {
  const opts = { filter: '', minCases: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--filter') opts.filter = argv[++i] ?? '';
    else if (argv[i] === '--min-cases') opts.minCases = Number(argv[++i] ?? 0);
  }
  return opts;
}

// 精確 id 或「id + 連字號」前綴——用 startsWith 會讓 --filter V1 撈到 V10-*。
function matchesFilter(id, filter) {
  return !filter || id === filter || id.startsWith(`${filter}-`);
}

let M = null; // 受測模組（載不到就留 null，H-* 仍要綠）

// ── H-*：harness 自檢 ────────────────────────────────────────────────────────

testCase('H-1', 'harness 自身可運作', () => {
  assert(true, 'assert 能通過');
  assert(typeof testCase === 'function', 'testCase 已定義');
});

testCase('H-2', '受測模組路徑固定且可判斷存在與否', () => {
  assert(MODULE_PATH.endsWith('artifact-contract.mjs'), '受測模組路徑指向 artifact-contract.mjs');
  assert(typeof existsSync(MODULE_PATH) === 'boolean', '模組存在與否可判斷（不存在也不該讓 harness 爆掉）');
});

// ── M-*：marker 契約 ─────────────────────────────────────────────────────────

testCase('M-1', 'parseMarker 解析合法 marker', () => {
  const r = M.parseMarker('<!-- loops-artifact: cost-report@1 -->');
  assert(r?.artifactId === 'cost-report', 'artifactId 解析為 cost-report');
  assert(r?.version === 1, 'version 解析為數字 1');
});

testCase('M-2', 'parseMarker 拒絕格式不合的 marker', () => {
  assert(M.parseMarker('<!-- loops-artifact: cost-report -->') === null, '缺 @version 不算');
  assert(M.parseMarker('<!-- loops-artifact: Cost-Report@1 -->') === null, '大寫 id 不算（一律 kebab-case）');
  assert(M.parseMarker('<!-- loops-artifact: cost-report@v1 -->') === null, 'version 必須是純數字');
  assert(M.parseMarker('# cost-report@1') === null, '不是 HTML 註解不算');
  assert(M.parseMarker('') === null, '空字串不算');
  assert(M.parseMarker(null) === null, 'null 不炸、回 null');
});

testCase('M-3', 'extractMarker 只認第一行', () => {
  const withMarker = '<!-- loops-artifact: cost-report@1 -->\n# cost\n';
  assert(M.extractMarker(withMarker)?.artifactId === 'cost-report', '第一行有 marker → 取得');

  // 第二行才出現的 marker 不算：否則文件內文引用一個 marker 就會讓整份檔改變身分。
  const secondLine = '# cost\n<!-- loops-artifact: cost-report@1 -->\n';
  assert(M.extractMarker(secondLine) === null, '第二行的 marker 不算數');
});

testCase('M-4', 'extractMarker 容忍前後空白與 BOM／CRLF', () => {
  assert(M.extractMarker('  <!-- loops-artifact: cost-report@1 -->  \n')?.version === 1, '前後空白容忍');
  assert(M.extractMarker('<!-- loops-artifact: cost-report@1 -->\r\n')?.version === 1, 'CRLF 容忍');
  assert(M.extractMarker('﻿<!-- loops-artifact: cost-report@1 -->\n')?.version === 1, 'BOM 容忍');
});

// ── P-*：path_pattern 比對 ───────────────────────────────────────────────────

testCase('P-1', 'matchPathPattern 展開 <slug> 佔位', () => {
  assert(M.matchPathPattern('.loops/<slug>/deliverables/cost.md', '.loops/217-foo/deliverables/cost.md'), '<slug> 對到單一路徑段');
  assert(!M.matchPathPattern('.loops/<slug>/deliverables/cost.md', '.loops/a/b/deliverables/cost.md'), '<slug> 不得跨目錄分隔符');
});

testCase('P-2', 'matchPathPattern 展開 ** 遞迴', () => {
  assert(M.matchPathPattern('docs/**', 'docs/a.md'), '** 對到單層');
  assert(M.matchPathPattern('docs/**', 'docs/a/b/c.md'), '** 對到多層');
  assert(!M.matchPathPattern('docs/**', 'README.md'), '** 不得溢出到別的目錄');
});

testCase('P-3', 'matchPathPattern 對 Windows 分隔符正規化', () => {
  assert(M.matchPathPattern('.loops/<slug>/deliverables/cost.md', '.loops\\217-foo\\deliverables\\cost.md'), '反斜線路徑同樣對得到');
});

testCase('P-4', 'resolveArtifactForPath 找得到對應契約', () => {
  const { registry } = M.loadArtifactRegistry(PLUGIN_ROOT);
  const hit = M.resolveArtifactForPath(registry, '.loops/217-foo/deliverables/cost.md');
  assert(hit?.artifact_id === 'cost-report', 'cost.md → cost-report 契約');

  const unmanaged = M.resolveArtifactForPath(registry, 'AGENTS.md');
  assert(unmanaged === null, 'AGENTS.md 在 unmanaged 名單內 → 不納管');
});

// ── R-*：registry 自身形狀 ───────────────────────────────────────────────────

testCase('R-1', '倉庫裡的 artifact-registry.json 通過形狀檢查', () => {
  const report = M.buildRegistryReport(PLUGIN_ROOT);
  if (!report.ok) for (const f of report.findings) console.error(`     · ${f.check}｜${f.id ?? '-'}｜${f.detail}`);
  assert(report.ok, `artifact-registry.json 形狀全綠（實際 ${report.findings.length} 個 finding）`);
});

testCase('R-2', 'artifact_id 必須唯一且 kebab-case', () => {
  const dup = {
    schema_version: '1',
    marker: { regex: '^x$' },
    artifacts: [
      { artifact_id: 'a-b', render_mode: 'hybrid', validator: 'required-sections', gate: 'phase', template: null, path_pattern: 'x', template_version: 1, required_sections: [] },
      { artifact_id: 'a-b', render_mode: 'hybrid', validator: 'required-sections', gate: 'phase', template: null, path_pattern: 'y', template_version: 1, required_sections: [] },
    ],
  };
  assert(M.checkArtifactRegistry(dup).some((f) => f.check === 'artifact-id-unique'), '重複 id 被抓出');

  const bad = { ...dup, artifacts: [{ ...dup.artifacts[0], artifact_id: 'Cost_Report' }] };
  assert(M.checkArtifactRegistry(bad).some((f) => f.check === 'artifact-id-format'), '非 kebab-case id 被抓出');
});

testCase('R-3', 'deterministic 產物必須指定 renderer', () => {
  const reg = {
    schema_version: '1',
    artifacts: [{
      artifact_id: 'x-y', render_mode: 'deterministic', renderer: null,
      validator: 'deterministic-sections', gate: 'finalize', template: null,
      path_pattern: 'x', template_version: 1, required_sections: [],
    }],
  };
  assert(M.checkArtifactRegistry(reg).some((f) => f.check === 'deterministic-renderer'),
    'deterministic 但 renderer 為 null → 抓出（沒有 renderer 就不可能 byte-for-byte 可重現）');
});

testCase('R-4', '值域外的 render_mode / validator / gate 被抓出', () => {
  const mk = (patch) => ({
    schema_version: '1',
    artifacts: [{
      artifact_id: 'x-y', render_mode: 'hybrid', renderer: null,
      validator: 'required-sections', gate: 'phase', template: null,
      path_pattern: 'x', template_version: 1, required_sections: [], ...patch,
    }],
  });
  assert(M.checkArtifactRegistry(mk({ render_mode: 'freestyle' })).some((f) => f.check === 'render-mode'), 'render_mode 值域');
  assert(M.checkArtifactRegistry(mk({ validator: 'vibes' })).some((f) => f.check === 'validator'), 'validator 值域');
  assert(M.checkArtifactRegistry(mk({ gate: 'whenever' })).some((f) => f.check === 'gate'), 'gate 值域');
});

testCase('R-5', '空的 artifacts 清單必須紅', () => {
  const findings = M.checkArtifactRegistry({ schema_version: '1', artifacts: [] });
  assert(findings.some((f) => f.check === 'registry-envelope'),
    '空陣列讓逐筆檢查恆真＝沒有內容的假綠，必須擋');
});

testCase('R-6', 'template 指到不存在的檔要被抓出', () => {
  const report = M.buildRegistryReport(PLUGIN_ROOT, {
    registry: {
      schema_version: '1',
      artifacts: [{
        artifact_id: 'x-y', render_mode: 'hybrid', renderer: null,
        validator: 'required-sections', gate: 'phase',
        template: 'artifacts/templates/does-not-exist.md',
        path_pattern: 'x', template_version: 1, required_sections: [],
      }],
    },
  });
  assert(report.findings.some((f) => f.check === 'template-exists'), 'dangling template 路徑被抓出');
});

// ── V-*：文件驗證 ────────────────────────────────────────────────────────────

const COST_SECTIONS = [
  'Measurement Status', 'Executive Summary', 'By Phase', 'Control Overhead',
  'By Iteration', 'By Activity', 'Agent & Task Detail', 'Tool / Context Footprint',
  'Quality Yield', 'Artifact & Delivery Footprint', 'Hotspots and Recommendations',
];

function costDoc(sections = COST_SECTIONS) {
  return ['<!-- loops-artifact: cost-report@1 -->', '# cost', '', ...sections.map((s) => `## ${s}\n`)].join('\n');
}

testCase('V-1', '齊全的受管文件通過驗證', () => {
  const { registry } = M.loadArtifactRegistry(PLUGIN_ROOT);
  const r = M.validateArtifactDocument(registry, { path: '.loops/x/deliverables/cost.md', text: costDoc() });
  if (!r.ok) for (const f of r.findings) console.error(`     · ${f.check}｜${f.detail}`);
  assert(r.ok, '11 個必填 section 齊全 → 通過');
});

testCase('V-2', '缺必填 section 被抓出', () => {
  const { registry } = M.loadArtifactRegistry(PLUGIN_ROOT);
  const text = costDoc(COST_SECTIONS.filter((s) => s !== 'Quality Yield'));
  const r = M.validateArtifactDocument(registry, { path: '.loops/x/deliverables/cost.md', text });
  assert(!r.ok && r.findings.some((f) => f.check === 'required-section'), '少一個 section → 不通過並指名');
  assert(r.findings.some((f) => String(f.detail).includes('Quality Yield')), 'finding 訊息指名缺的是哪一個');
});

testCase('V-3', 'required_sections 走前綴比對（標題可帶動態尾綴）', () => {
  const { registry } = M.loadArtifactRegistry(PLUGIN_ROOT);
  // loop.md 的「最近事件」標題實際上是「## 最近事件（最多 12 筆，非完整 Journal）」——
  // 契約若用全等比對，renderer 一改上限數字就整批假紅。
  const text = [
    '<!-- loops-artifact: loop-snapshot@1 -->',
    '# loop：x', '',
    '## 仍擋著完工的', '',
    '## 最近事件（最多 12 筆，非完整 Journal）', '',
  ].join('\n');
  const r = M.validateArtifactDocument(registry, { path: '.loops/x/loop.md', text });
  if (!r.ok) for (const f of r.findings) console.error(`     · ${f.check}｜${f.detail}`);
  assert(r.ok, '帶動態尾綴的標題仍滿足契約');
});

testCase('V-4', '版本不符被抓出', () => {
  const { registry } = M.loadArtifactRegistry(PLUGIN_ROOT);
  const text = costDoc().replace('cost-report@1', 'cost-report@2');
  const r = M.validateArtifactDocument(registry, { path: '.loops/x/deliverables/cost.md', text });
  assert(!r.ok && r.findings.some((f) => f.check === 'template-version'), '文件宣稱 @2、registry 是 @1 → 抓出');
});

testCase('V-5', '未登記的 artifact id 被抓出', () => {
  const { registry } = M.loadArtifactRegistry(PLUGIN_ROOT);
  const text = '<!-- loops-artifact: made-up-thing@1 -->\n# x\n';
  const r = M.validateArtifactDocument(registry, { path: '.loops/x/deliverables/cost.md', text });
  assert(!r.ok && r.findings.some((f) => f.check === 'unregistered-artifact'), '未登記 id → 抓出');
});

testCase('V-6', '受管路徑缺 marker 被抓出', () => {
  const { registry } = M.loadArtifactRegistry(PLUGIN_ROOT);
  const r = M.validateArtifactDocument(registry, { path: '.loops/x/deliverables/cost.md', text: '# cost\n' });
  assert(!r.ok && r.findings.some((f) => f.check === 'missing-marker'), '沒有 marker → 抓出');
});

testCase('V-7', '不納管的路徑一律放行', () => {
  const { registry } = M.loadArtifactRegistry(PLUGIN_ROOT);
  const r = M.validateArtifactDocument(registry, { path: 'AGENTS.md', text: '# AGENTS\n' });
  assert(r.ok && r.managed === false, 'unmanaged 路徑不需要 marker、不判違規');
});

testCase('V-8', 'authored-docs 不要求 required_sections', () => {
  const { registry } = M.loadArtifactRegistry(PLUGIN_ROOT);
  const r = M.validateArtifactDocument(registry, {
    path: 'docs/anything.md',
    text: '<!-- loops-artifact: howto-guide@1 -->\n# 怎麼設定\n\n隨便什麼標題都行。\n',
  });
  if (!r.ok) for (const f of r.findings) console.error(`     · ${f.check}｜${f.detail}`);
  assert(r.ok, 'authored-docs 依文件目的選標題，不強迫長一樣');
});

// ── W-*：workflow vocabulary ─────────────────────────────────────────────────

testCase('W-1', 'phase 清單固定為五個、退場的名字都不在裡面', () => {
  const { vocabulary } = M.loadWorkflowVocabulary(PLUGIN_ROOT);
  const ids = vocabulary.phases.map((p) => p.id);
  assert(JSON.stringify(ids) === JSON.stringify(['define', 'plan', 'build', 'verify', 'finalize']),
    'phase 順序恰為 define→plan→build→verify→finalize（#219）');
  assert(!ids.includes('iterate'), 'iterate 不得是 phase（它是 iteration-controller）');
  assert(!ids.includes('dispatch'), 'dispatch 不得是 phase（它是 control node）');
  for (const retired of ['clarify', 'goal', 'explore']) {
    assert(!ids.includes(retired), `${retired} 不得是 phase（#219 起是 capability）`);
  }
});

testCase('W-2', 'control node 含 dispatch 與 iteration-controller', () => {
  const { vocabulary } = M.loadWorkflowVocabulary(PLUGIN_ROOT);
  const ids = vocabulary.control_nodes.map((c) => c.id);
  assert(ids.includes('dispatch'), 'dispatch 在 control node');
  assert(ids.includes('iteration-controller'), 'iteration-controller 在 control node');
  const ic = vocabulary.control_nodes.find((c) => c.id === 'iteration-controller');
  assert(ic?.compat_skill_name === 'iterate', 'iteration-controller 記錄相容 skill 名 iterate');
});

testCase('W-3', 'activity 涵蓋 #217 明列的動作', () => {
  const { vocabulary } = M.loadWorkflowVocabulary(PLUGIN_ROOT);
  const ids = new Set(vocabulary.activities.map((a) => a.id));
  const required = ['route', 'clarify', 'author-issue', 'research', 'design', 'implement',
    'execute-test', 'review', 'validate-finding', 'remediate', 'reverify', 'document',
    'render-artifact', 'publish', 'cleanup'];
  const missing = required.filter((id) => !ids.has(id));
  assert(missing.length === 0, `activity 全數登記（缺：${missing.join('、') || '無'}）`);
});

testCase('W-4', '成本維度與 measurement status 固定', () => {
  const { vocabulary } = M.loadWorkflowVocabulary(PLUGIN_ROOT);
  assert(JSON.stringify(vocabulary.cost_dimensions) === JSON.stringify(
    ['loop', 'iteration', 'workflow_node', 'activity', 'agent', 'task', 'turn']),
  '成本維度順序固定');
  assert(JSON.stringify(vocabulary.measurement_statuses.map((s) => s.id)) === JSON.stringify(
    ['exact', 'estimated', 'not_measured']),
  'measurement_status 只有三個值');
});

testCase('W-5', 'attribution 明文禁用 other-subagent', () => {
  const { vocabulary } = M.loadWorkflowVocabulary(PLUGIN_ROOT);
  assert(vocabulary.attribution?.unattributed_prefix === 'unattributed:', '未歸戶前綴為 unattributed:');
  assert(String(vocabulary.attribution?.notes ?? '').includes('other-subagent'),
    'notes 明文寫出禁用 other-subagent（否則舊做法會被無聲沿用）');
});

testCase('W-6', 'registry 的 producer 只能是 vocabulary 認得的節點', () => {
  const { registry } = M.loadArtifactRegistry(PLUGIN_ROOT);
  const { vocabulary } = M.loadWorkflowVocabulary(PLUGIN_ROOT);
  const known = new Set([
    ...vocabulary.phases.map((p) => p.id),
    ...vocabulary.control_nodes.map((c) => c.id),
    ...vocabulary.activities.map((a) => a.id),
    'any-phase',
  ]);
  const bad = registry.artifacts.filter((a) => !known.has(a.producer));
  assert(bad.length === 0, `producer 全部對得上 vocabulary（不合的：${bad.map((a) => `${a.artifact_id}→${a.producer}`).join('、') || '無'}）`);
});

// ── 執行 ─────────────────────────────────────────────────────────────────────

async function run() {
  const opts = parseArgs(process.argv.slice(2));

  try {
    M = await import(pathToFileURL(MODULE_PATH).href);
  } catch (err) {
    M = null;
    console.log(`（受測模組尚未存在或載入失敗：${err?.message ?? err}）\n`);
  }

  let ran = 0;
  for (const c of cases) {
    if (!matchesFilter(c.id, opts.filter)) continue;
    // 模組載不到時只跑 H-*：其餘一律記為失敗（而不是靜默跳過——跳過會讓「還沒實作」看起來像綠燈）。
    if (!M && !c.id.startsWith('H-')) {
      failed.push(`${c.id} ${c.name}：受測模組載入失敗`);
      console.error(`✗ ${c.id} ${c.name}：受測模組載入失敗`);
      ran += 1;
      continue;
    }
    console.log(`▸ ${c.id} ${c.name}`);
    try {
      c.fn();
    } catch (err) {
      failed.push(`${c.id} ${c.name}：拋出例外 ${err?.message ?? err}`);
      console.error(`  ✗ 拋出例外：${err?.stack ?? err}`);
    }
    ran += 1;
  }

  if (opts.minCases && ran < opts.minCases) {
    console.error(`\n✗ 只跑到 ${ran} 個 case，少於下限 ${opts.minCases}`);
    process.exit(1);
  }

  console.log(`\n${failed.length ? '✗' : '✓'} artifact-contract：${passed} 個斷言通過、${failed.length} 個失敗（${ran} cases）`);
  if (failed.length) {
    for (const f of failed) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

// 暫存目錄清理（目前的 case 用不到磁碟，保留給後續需要 fixture 的 case）
const TMP = mkdtempSync(join(tmpdir(), 'loops-artifact-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失敗不影響結果 */ } });
void writeFileSync; // 保留 import，避免 lint 誤判未使用

run();
