#!/usr/bin/env node
// test-check-baseline-whitelist.mjs —— check-baseline-whitelist.mjs 的紅綠單元 + IO/CLI 整合斷言。
// 用法：node test-check-baseline-whitelist.mjs
// 全綠 → exit 0；任一斷言失敗 → exit 1（主線用此 exit code 判紅綠）。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { BASELINE_TEST_FILES, checkBaseline, formatSummary, buildReport } from './check-baseline-whitelist.mjs';

const SCRIPT = fileURLToPath(new URL('./check-baseline-whitelist.mjs', import.meta.url));
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..'); // scripts -> loops-workflow -> plugins -> repo root

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

// ══════════════════════════════════════════════════════════════════════════
// 0. 基線清單本身：恰好 31 支，13 hooks + 18 scripts
// ══════════════════════════════════════════════════════════════════════════
{
  assert(BASELINE_TEST_FILES.length === 31, `基線清單恰有 31 支測試檔（實際：${BASELINE_TEST_FILES.length}）[baseline-count]`);
  const hooksCount = BASELINE_TEST_FILES.filter((f) => f.includes('/hooks/')).length;
  const scriptsCount = BASELINE_TEST_FILES.filter((f) => f.includes('/scripts/')).length;
  assert(hooksCount === 13, `hooks/ 基線恰 13 支（實際：${hooksCount}）[baseline-hooks-count]`);
  assert(scriptsCount === 18, `scripts/ 基線恰 18 支（實際：${scriptsCount}）[baseline-scripts-count]`);
}

// ══════════════════════════════════════════════════════════════════════════
// 1. checkBaseline（純函式：pathExists 全真 → 綠；缺一支 → 紅並指名）
// ══════════════════════════════════════════════════════════════════════════
{
  const result = checkBaseline(['a.mjs', 'b.mjs'], () => true);
  assert(result.ok === true, `checkBaseline：全部存在 → ok===true（實際：${JSON.stringify(result)}）[unit-a]`);
  assert(result.findings.length === 0, 'checkBaseline：全部存在 → findings===[] [unit-a]');
}
{
  // 負向 fixture：假裝少一支（b.mjs 不存在）→ 必須紅且指名 b.mjs
  const result = checkBaseline(['a.mjs', 'b.mjs'], (rel) => rel !== 'b.mjs');
  assert(result.ok === false, `checkBaseline：缺 b.mjs → ok===false（實際：${JSON.stringify(result)}）[unit-negative-b]`);
  assert(
    result.findings.some((f) => f.check === 'baseline-file-missing' && f.file === 'b.mjs'),
    `checkBaseline：缺 b.mjs → 命中 baseline-file-missing 且指名 b.mjs（實際：${JSON.stringify(result.findings)}）[unit-negative-b]`,
  );
}
{
  // 負向 fixture：假裝所有 31 支基線都少了其中一支（每支輪流試，確保清單裡每個路徑都真的被檢查到）
  const missing = BASELINE_TEST_FILES[BASELINE_TEST_FILES.length - 1];
  const result = checkBaseline(BASELINE_TEST_FILES, (rel) => rel !== missing);
  assert(
    result.ok === false && result.findings.some((f) => f.file === missing),
    `checkBaseline：31 支基線裡假裝少最後一支（${missing}）→ 命中並指名（實際：${JSON.stringify(result.findings)}）[unit-negative-last]`,
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 2. formatSummary
// ══════════════════════════════════════════════════════════════════════════
{
  const summary = formatSummary({ ok: true, findings: [] });
  assert(typeof summary === 'string' && summary.includes('✓'), 'formatSummary：ok===true → 含 ✓ [summary-a]');
}
{
  const summary = formatSummary({ ok: false, findings: [{ check: 'baseline-file-missing', severity: 'P1', file: 'x.mjs', detail: 'x 缺失' }] });
  assert(typeof summary === 'string' && summary.includes('✗') && summary.includes('x.mjs'), 'formatSummary：ok===false → 含 ✗ 且指名（實際：' + summary + '）[summary-b]');
}

// ══════════════════════════════════════════════════════════════════════════
// 3. buildReport 對真實 repo root → 綠（本 repo 現況必須含滿 31 支基線）
// ══════════════════════════════════════════════════════════════════════════
{
  const result = buildReport(REPO_ROOT);
  assert(result.ok === true, `buildReport：對真實 repo root → ok===true（實際：${JSON.stringify(result)}）[real-repo]`);
}

// ══════════════════════════════════════════════════════════════════════════
// IO/CLI 整合（spawnSync 真跑 check-baseline-whitelist.mjs --root <合成/真實 repo>）
// ══════════════════════════════════════════════════════════════════════════
function writeFiles(root, filesObj) {
  for (const [rel, content] of Object.entries(filesObj)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
}

function runCli(root, args = ['--json']) {
  const res = spawnSync('node', [SCRIPT, '--root', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  let json = null;
  if (args.includes('--json')) {
    try {
      json = JSON.parse(res.stdout);
    } catch {
      json = null;
    }
  }
  return { res, json };
}

// IO-1：合成 repo，31 支基線全放好 → 綠
{
  const dir = mkdtempSync(join(tmpdir(), 'cbw-'));
  try {
    const files = {};
    for (const rel of BASELINE_TEST_FILES) files[rel] = '// placeholder\n';
    writeFiles(dir, files);
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 0, `IO-1：31 支基線全在 → exit code===0（實際 stdout：${res.stdout}；stderr：${res.stderr}）[IO-1]`);
    assert(json && json.ok === true, `IO-1：--json ok===true（實際：${JSON.stringify(json)}）[IO-1]`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-2（負向 fixture，本任務核心紅燈）：合成 repo 假裝少一支 → CLI 必須紅並指名
{
  const dir = mkdtempSync(join(tmpdir(), 'cbw-'));
  try {
    const missing = 'plugins/loops-workflow/hooks/test-worktree-guard.mjs';
    const files = {};
    for (const rel of BASELINE_TEST_FILES) {
      if (rel === missing) continue; // 故意不寫這支，模擬「有人刪掉既有測試檔」
      files[rel] = '// placeholder\n';
    }
    writeFiles(dir, files);
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 1, `IO-2：假裝少一支基線測試檔 → exit code===1（實際 stdout：${res.stdout}）[IO-2-negative]`);
    assert(
      json && json.findings.some((f) => f.file === missing),
      `IO-2：--json findings 指名缺失的 ${missing}（實際：${JSON.stringify(json)}）[IO-2-negative]`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-3：不帶 --root，對本 repo 真實預設路徑跑 → 綠（本 repo 現況必須含滿 31 支基線）
{
  const res = spawnSync('node', [SCRIPT, '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    json = null;
  }
  assert(res.status === 0, `IO-3：預設 --root 對真實 repo 跑 → exit code===0（實際 status：${res.status}；stdout：${res.stdout}）[IO-3]`);
  assert(json && json.ok === true, `IO-3：真實 repo 31 支基線全過 → ok===true（實際：${JSON.stringify(json)}）[IO-3]`);
}

// IO-4：非 --json 模式，健康合成 repo 印出繁體中文成功摘要，exit 0
{
  const dir = mkdtempSync(join(tmpdir(), 'cbw-'));
  try {
    const files = {};
    for (const rel of BASELINE_TEST_FILES) files[rel] = '// placeholder\n';
    writeFiles(dir, files);
    const { res } = runCli(dir, []);
    assert(res.status === 0, `IO-4：健康合成 repo（非 --json）→ exit code===0（實際 stdout：${res.stdout}）[IO-4]`);
    assert(res.stdout.includes('✓'), 'IO-4：非 --json 模式印出 ✓ 摘要 [IO-4]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.error('\n失敗清單：');
  for (const msg of failed) console.error(`  - ${msg}`);
  process.exit(1);
}
process.exit(0);
