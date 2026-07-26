#!/usr/bin/env node
// test-docs-lint.mjs —— 人類文件一致性閘的斷言（#180）。
// 對應驗收標準：links／public commands／integration catalog／env 名稱與 registry 一致；
// 文件不得拿具體 issue／PR／某條 loop 當永久說明；真 repo 現況全綠。
// 用法：node test-docs-lint.mjs [--filter <case-prefix>] [--min-cases <n>]

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HUMAN_DOC_ROOTS, DOC_SCAN_EXCLUDES, HISTORY_SKIP,
  collectHumanDocs, loadFacts, checkLinks, checkCommands, checkCatalog, checkEnvNames, checkNoHistory,
  stripCodeAndLinks, buildReport, formatSummary,
} from './docs-lint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

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
  const dir = mkdtempSync(join(tmpdir(), 'docs-lint-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const doc = (rel, text, root) => ({ rel, abs: join(root ?? '/x', rel), text });
const FACTS = {
  publicCommands: new Set(['dispatch', 'setup']),
  catalog: { entries: [{ id: 'code-graph', qualification: null }, { id: 'token-optimizer-alternate', qualification: ['還缺實測'] }] },
  envNames: new Set(['LOOPS_AUTO', 'LOOPS_PR_GATE']),
};

// ══════════════════════════════════════════════════════════════════════════
testCase('D1', '掃描面：只掃人類文件，AGENTS.md 與歷史設計文件不在內', () => {
  assert(!HUMAN_DOC_ROOTS.includes('AGENTS.md'), 'AGENTS.md 不在掃描面（它是 AI 執行契約，不是人的教學）');
  assert(HUMAN_DOC_ROOTS.includes('README.md') && HUMAN_DOC_ROOTS.includes('docs'), 'README 與 docs 在掃描面');
  assert(DOC_SCAN_EXCLUDES.some((x) => x.prefix === 'docs/specs/' && x.reason), '歷史設計文件被排除且附理由');
  assert(HISTORY_SKIP.length >= 2 && HISTORY_SKIP.every((x) => x.file && x.reason), '不套 no-history 的檔逐項附理由（紀錄型文件本來就在記某一次的事）');
  withTmp((root) => {
    mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# x', 'utf8');
    writeFileSync(join(root, 'docs', 'a.md'), '# a', 'utf8');
    writeFileSync(join(root, 'docs', 'specs', 'old.md'), '# old', 'utf8');
    const files = collectHumanDocs(root).map((f) => f.rel);
    assert(files.includes('README.md') && files.includes('docs/a.md'), '掃到 README 與 docs 下的檔');
    assert(!files.some((f) => f.startsWith('docs/specs/')), 'specs 不掃');
  });
});

testCase('D2', 'checkLinks：死連結被抓出來，外部與錨點連結跳過', () => {
  withTmp((root) => {
    writeFileSync(join(root, 'real.md'), '# real', 'utf8');
    const files = [doc('a.md', '[在](real.md) [不在](missing.md) [外部](https://example.com) [錨](#x) [帶錨](real.md#s)', root)];
    const out = checkLinks(files, root);
    assert(out.length === 1 && out[0].detail.includes('missing.md'), '只有指不到的那個被抓出來（外部／錨點／帶錨的相對連結都不誤報）');
    assert(out[0].check === 'doc-link', 'check 名稱正確');
  });
});

testCase('D3', 'checkCommands：文件不得宣傳非公開入口', () => {
  const bad = checkCommands([doc('a.md', '請跑 /loops-workflow:build')], FACTS);
  assert(bad.length === 1 && bad[0].detail.includes('build'), '宣傳內部 skill → 紅並指名');
  assert(bad[0].detail.includes('dispatch') && bad[0].detail.includes('setup'), '訊息告訴你公開的有哪些');
  const good = checkCommands([doc('a.md', '`/loops-workflow:dispatch` 與 `/loops-workflow:setup`')], FACTS);
  assert(good.length === 0, '反向：兩個公開入口都不紅（殺掉「凡是 slash 指令都擋」的實作）');
  assert(checkCommands([doc('a.md', '/loops-workflow:build')], { publicCommands: new Set() }).length === 0, '讀不到事實時不製造假紅');
});

testCase('D4', 'checkCatalog：文件提到的來源要存在，能進選單的來源要被寫進教學', () => {
  const guide = doc('docs/SETUP-GUIDE.md', '我們有 `code-graph`。');
  assert(checkCatalog([guide], FACTS).length === 0, '提到存在的來源、且能進選單的都寫到了 → 綠');

  const ghost = doc('docs/SETUP-GUIDE.md', '我們有 `code-graph` 與 `code-graph-ghost`。');
  const out = checkCatalog([ghost], FACTS);
  assert(out.some((f) => f.detail.includes('code-graph-ghost')), '安裝教學提到不存在的來源 → 紅');

  // GUARD：驗收報告裡的 `skill-optimizer-run` 之類是**衍生名稱**，不是在宣稱有這個來源。
  // 用前綴啟發式去全 repo 抓會製造偽陽性，然後大家學會忽略這道閘。
  const derived = [guide, doc('docs/ACCEPTANCE.md', '`skill-optimizer-run` 與 `prompt-eval-full` 未量測')];
  assert(checkCatalog(derived, FACTS).length === 0, '別處的衍生名稱不誤報（只在安裝教學裡查來源 id）');

  const missing = doc('docs/SETUP-GUIDE.md', '（什麼都沒寫）');
  const out2 = checkCatalog([missing], FACTS);
  assert(out2.some((f) => f.detail.includes('code-graph') && f.detail.includes('沒提到')), '能進選單卻沒寫進教學 → 紅');
  assert(!out2.some((f) => f.detail.includes('token-optimizer-alternate') && f.detail.includes('沒提到')), '資格未過、不會進選單的不強制寫進教學');
});

testCase('D5', 'checkEnvNames：文件提到的參數必須真的存在', () => {
  assert(checkEnvNames([doc('a.md', '設 `LOOPS_AUTO=1`')], FACTS).length === 0, '存在的參數 → 綠');
  const out = checkEnvNames([doc('a.md', '設 `LOOPS_REMOVED_FLAG=1`')], FACTS);
  assert(out.length === 1 && out[0].detail.includes('LOOPS_REMOVED_FLAG'), '不存在的參數 → 紅並指名');
  assert(out[0].detail.includes('比沒寫還糟'), '理由講明為什麼這件事重要');
  assert(checkEnvNames([doc('a.md', 'LOOPS_X')], { envNames: new Set() }).length === 0, '讀不到事實時不製造假紅');
});

testCase('D6', 'checkNoHistory：具體單號與具體 loop 目錄不得當永久說明', () => {
  const out = checkNoHistory([doc('a.md', '這是為了修 issue #123 加的，細節見 .loops/123-something/loop.md')]);
  assert(out.some((f) => f.detail.includes('ticket-history')), '具體 issue 編號 → 紅');
  assert(out.some((f) => f.detail.includes('loops-history')), '具體 loop 目錄 → 紅');
  const generic = checkNoHistory([doc('a.md', '進度看 `.loops/<slug>/PROGRESS.md`')]);
  assert(generic.length === 0, '反向：通用型樣不紅（殺掉「凡是提到 .loops 就擋」的實作）');
  const inCode = checkNoHistory([doc('a.md', '```\n.loops/123-x/loop.md\n```')]);
  assert(inCode.length === 0, 'code fence 內的路徑是範例，不是散文主張 → 不紅');
  assert(checkNoHistory([doc('docs/CODEX-SMOKE.md', 'PR #1')], { skip: ['docs/CODEX-SMOKE.md'] }).length === 0, 'skip 清單有效（驗證證據紀錄本質就是歷史）');
  assert(stripCodeAndLinks('`x` ```y``` [t](u)').trim() === '[]()' || !stripCodeAndLinks('`x` ```y``` [t](u)').includes('y'), 'stripCodeAndLinks 去掉 code 與連結目標');
});

testCase('D7', '真 repo：人類文件全綠，且新寫的指南都在索引裡', () => {
  const report = buildReport(REPO_ROOT, { skipHistory: HISTORY_SKIP.map((x) => x.file) });
  assert(report.ok, `真 repo 人類文件全綠（實際：${JSON.stringify(report.findings)}）`);
  assert(report.scanned >= 12, `掃到 ${report.scanned} 份文件`);
  assert(formatSummary(report).includes('✓'), '全綠摘要有 ✓');
  assert(formatSummary({ ok: false, scanned: 1, findings: [{ check: 'x', file: 'y', detail: 'z' }] }).includes('✗'), '有 finding 的摘要有 ✗');

  const index = readFileSync(join(REPO_ROOT, 'docs', 'README.md'), 'utf8');
  for (const guide of ['ARCHITECTURE.md', 'SETUP-GUIDE.md', 'WORKFLOW-GUIDE.md', 'POLICY-GUIDE.md', 'MEMORY-GUIDE.md']) {
    assert(existsSync(join(REPO_ROOT, 'docs', guide)), `${guide} 存在`);
    assert(index.includes(guide), `${guide} 在索引裡（新增文件卻沒進索引＝沒人找得到）`);
  }
  const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
  assert(readme.includes('/loops-workflow:setup') && readme.includes('/loops-workflow:dispatch'), 'README 兩個公開入口都寫了');
  assert(readme.includes('docs/WORKFLOW-GUIDE.md') && readme.includes('docs/SETUP-GUIDE.md'), 'README 指得到指南');
});

testCase('D8', '真 repo：facts 真的讀得到（不是靠 fail-open 才綠）', () => {
  const facts = loadFacts(REPO_ROOT);
  assert(facts.publicCommands.size === 2 && facts.publicCommands.has('dispatch') && facts.publicCommands.has('setup'), '公開指令讀得到、恰為兩個');
  assert((facts.catalog?.entries ?? []).length > 0, 'setup catalog 讀得到');
  assert(facts.envNames.size > 10, `環境變數讀得到（${facts.envNames.size} 個）`);
  assert(facts.envNames.has('LOOPS_AUTO'), '讀到已知存在的參數');
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
