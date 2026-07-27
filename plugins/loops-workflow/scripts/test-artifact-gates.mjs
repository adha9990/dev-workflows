#!/usr/bin/env node
// test-artifact-gates.mjs —— Phase Gate 與 Docs Gate 的契約斷言（#217 增量 3）。
// 用法：node test-artifact-gates.mjs [--filter <case-id>] [--min-cases <n>]
//
// 覆蓋：
//   H-*  harness 自檢。
//   P-*  Phase Gate：缺產出／缺必填區塊要擋；控制節點不當 phase 查；舊制 loop 一律略過。
//   D-*  Docs Gate：repo 現況全綠（migration 真的做完了）、plugin 內的 docs 也納管、
//        未登記的 marker 要被抓出來、不納管的路徑不誤擋。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PHASE_GATE = join(HERE, 'artifact-phase-gate.mjs');
const DOCS_GATE = join(HERE, 'artifact-docs-gate.mjs');
const REPO_ROOT = join(HERE, '..', '..', '..');

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

let PG = null;
let DG = null;
let TMP = '';

/** 造一條 loop 目錄；`newProtocol` 決定是不是新制（有 telemetry/）。 */
function makeLoop(name, { newProtocol = true } = {}) {
  const dir = join(TMP, name, '.loops', '217-demo');
  mkdirSync(join(dir, 'stages'), { recursive: true });
  mkdirSync(join(dir, 'deliverables'), { recursive: true });
  if (newProtocol) mkdirSync(join(dir, 'telemetry'), { recursive: true });
  return dir;
}

const VERIFY_DOC = [
  '<!-- loops-artifact: stage-verify@1 -->',
  '# verify', '',
  '## 判定', '', 'Ready', '',
  '## findings', '', '（無）', '',
  '## 逐 behavior 回核', '', 'B1 ✓', '',
].join('\n');

// ── H-* ─────────────────────────────────────────────────────────────────────

testCase('H-1', 'harness 自身可運作', () => {
  assert(true, 'assert 能通過');
  assert(existsSync(PHASE_GATE) || true, 'phase gate 路徑可判斷');
});

// ── P-*：Phase Gate ─────────────────────────────────────────────────────────

testCase('P-1', '齊全的 phase 產出通過', () => {
  const dir = makeLoop('p1');
  writeFileSync(join(dir, 'stages', '04-verify.md'), VERIFY_DOC);
  const r = PG.checkPhase(dir, 'verify');
  if (!r.ok) for (const f of r.findings) console.error(`     · ${f.check}｜${f.detail}`);
  assert(r.ok && !r.skipped, `verify 產出齊全 → 通過（checked ${r.checked}）`);
});

testCase('P-2', '缺產出被擋', () => {
  const dir = makeLoop('p2');
  const r = PG.checkPhase(dir, 'verify');
  assert(!r.ok, '沒有 04-verify.md → 不通過');
  assert(r.findings.some((f) => f.check === 'missing-artifact'), 'finding 指出缺的是哪一份');
});

testCase('P-3', '缺必填區塊被擋', () => {
  const dir = makeLoop('p3');
  writeFileSync(join(dir, 'stages', '04-verify.md'),
    '<!-- loops-artifact: stage-verify@1 -->\n# verify\n\n## 判定\n\nReady\n');
  const r = PG.checkPhase(dir, 'verify');
  assert(!r.ok && r.findings.some((f) => f.check === 'required-section'), '少了 findings／逐 behavior 回核 → 抓出');
});

testCase('P-4', '缺 marker 被擋', () => {
  const dir = makeLoop('p4');
  writeFileSync(join(dir, 'stages', '04-verify.md'), '# verify\n\n## 判定\n\n## findings\n\n## 逐 behavior 回核\n');
  const r = PG.checkPhase(dir, 'verify');
  assert(!r.ok && r.findings.some((f) => f.check === 'missing-marker'), '沒有 artifact marker → 抓出');
});

testCase('P-5', '控制節點不當 phase 查', () => {
  const dir = makeLoop('p5');
  const r = PG.checkPhase(dir, 'iteration-controller');
  assert(r.skipped && r.ok, 'iteration-controller → 略過（它不擁有 artifact）');
  assert(String(r.reason).includes('不是工作階段'), '說明為什麼略過');
  const d = PG.checkPhase(dir, 'dispatch');
  assert(d.skipped && d.ok, 'dispatch 同樣略過');
});

testCase('P-6', '舊制 loop 一律略過、不回填也不阻擋', () => {
  const dir = makeLoop('p6', { newProtocol: false });
  const r = PG.checkPhase(dir, 'verify');
  assert(r.skipped && r.ok, '沒有 telemetry/ → 略過');
  assert(String(r.reason).includes('新制'), '說明它是舊制 loop');
});

testCase('P-8', '條件式產物不存在不算失敗', () => {
  const dir = makeLoop('p8');
  writeFileSync(join(dir, 'stages', '04-verify.md'), VERIFY_DOC);
  const r = PG.checkPhase(dir, 'verify');
  assert(r.ok, 'no-ui.md 這種「沒畫面可截才寫」的替代證據不存在，不得判 verify 失敗');
  assert(!r.findings.some((f) => String(f.artifact) === 'no-ui-evidence'), '不對條件式產物報 missing');
});

testCase('P-7', 'GitHub 型產物不在本地檔案面被查', () => {
  const dir = makeLoop('p7');
  // define 的產出是 issue body（channel=github），本地沒有檔案可查——不得因此判失敗。
  const r = PG.checkPhase(dir, 'define');
  assert(r.ok, 'define 沒有本地產物 → 不因「找不到檔案」而失敗');
});

// ── D-*：Docs Gate ──────────────────────────────────────────────────────────

testCase('D-1', 'repo 現況全綠（migration 真的做完了）', () => {
  const report = DG.buildReport(REPO_ROOT);
  if (!report.ok) for (const f of report.findings.slice(0, 8)) console.error(`     · ${f.check}｜${f.file}｜${f.detail}`);
  assert(report.ok, `所有受管文件都有登記過的契約（${report.managed}/${report.scanned} 受管，${report.findings.length} findings）`);
  assert(report.managed > 0, '真的有掃到受管文件（全部不納管＝這道閘等於沒開）');
});

testCase('D-2', 'plugin 內的 docs 也納管', () => {
  assert(DG.normalizeDocPath('plugins/loops-workflow/docs/settings.md') === 'docs/settings.md',
    'plugin docs 正規化成 repo docs 的形狀（registry 不必為每個 plugin 各寫一條）');
  assert(DG.normalizeDocPath('docs/README.md') === 'docs/README.md', '非 plugin 路徑原樣');
  assert(DG.normalizeDocPath('README.md') === 'README.md', 'repo 根 README 原樣');

  const report = DG.buildReport(REPO_ROOT);
  assert(report.managed >= 20, `plugin docs 與 repo docs 都被算進受管（實際 ${report.managed}）`);
});

testCase('D-3', '未登記的 marker 會被抓出來', () => {
  const root = join(TMP, 'd3');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'x.md'), '<!-- loops-artifact: not-a-real-thing@1 -->\n# x\n');
  const report = DG.buildReport(root);
  assert(!report.ok && report.findings.some((f) => f.check === 'unregistered-artifact'),
    '宣稱一個沒登記的 id → 抓出（否則新增產物時漏補 registry 沒人會發現）');
});

testCase('D-4', '不納管的路徑不誤擋', () => {
  const root = join(TMP, 'd4');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '<!-- loops-artifact: readme@1 -->\n# r\n');
  // AGENTS.md 是 agent-facing 契約，registry 明列 unmanaged——不得要求它帶 marker。
  writeFileSync(join(root, 'AGENTS.md'), '# AGENTS\n');
  const report = DG.buildReport(root);
  assert(report.ok, 'unmanaged 檔案不需要 marker');
});

// ── 執行 ────────────────────────────────────────────────────────────────────

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  TMP = mkdtempSync(join(tmpdir(), 'loops-gates-'));
  process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失敗不影響結果 */ } });

  try {
    PG = await import(pathToFileURL(PHASE_GATE).href);
    DG = await import(pathToFileURL(DOCS_GATE).href);
  } catch (err) {
    PG = null; DG = null;
    console.log(`（受測模組尚未存在或載入失敗：${err?.message ?? err}）\n`);
  }

  let ran = 0;
  for (const c of cases) {
    if (!matchesFilter(c.id, opts.filter)) continue;
    if ((!PG || !DG) && !c.id.startsWith('H-')) {
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

  console.log(`\n${failed.length ? '✗' : '✓'} artifact-gates：${passed} 個斷言通過、${failed.length} 個失敗（${ran} cases）`);
  if (failed.length) {
    for (const f of failed) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

run();
