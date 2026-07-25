#!/usr/bin/env node
// test-check-legacy-paths.mjs —— check-legacy-paths.mjs 的紅綠單元 + IO/CLI 整合斷言。
// 用法：node test-check-legacy-paths.mjs
// 全綠 → exit 0；任一斷言失敗 → exit 1（主線用此 exit code 判紅綠）。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  LEGACY_PATH_ALLOWLIST,
  scanLegacyLiterals,
  isStructurallyExempt,
  checkLegacyPaths,
  formatSummary,
  buildReport,
} from './check-legacy-paths.mjs';

const SCRIPT = fileURLToPath(new URL('./check-legacy-paths.mjs', import.meta.url));
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
// 1. scanLegacyLiterals：認扁平舊路徑（無子目錄）、不認巢狀路徑、不認 glob
// ══════════════════════════════════════════════════════════════════════════
{
  const hits = scanLegacyLiterals('見 `references/clean-code.md` 與 `agents/impl-author.md`');
  assert(
    hits.includes('references/clean-code.md') && hits.includes('agents/impl-author.md'),
    `scanLegacyLiterals：扁平字面兩種根都要抓到（實際：${JSON.stringify(hits)}）[unit-flat]`,
  );
}
{
  const hits = scanLegacyLiterals('見 `references/shared/quality/clean-code.md` 與 `agents/build/impl-author.md`');
  assert(hits.length === 0, `scanLegacyLiterals：巢狀路徑（已分類子目錄）不算殘留（實際：${JSON.stringify(hits)}）[unit-nested]`);
}
{
  const hits = scanLegacyLiterals('見 `references/*.md` 這批規範');
  assert(hits.length === 0, `scanLegacyLiterals：glob 字面不算殘留（實際：${JSON.stringify(hits)}）[unit-glob]`);
}

// ══════════════════════════════════════════════════════════════════════════
// 2. isStructurallyExempt：佔位符與 skill-local 兩種結構性豁免
// ══════════════════════════════════════════════════════════════════════════
{
  const exempt = isStructurallyExempt('AGENTS.md', 'references/xxx.md');
  assert(exempt === true, `isStructurallyExempt：xxx.md 佔位符豁免（實際：${exempt}）[unit-placeholder]`);
}
{
  const exempt = isStructurallyExempt(
    'plugins/loops-workflow/skills/plan/SKILL.md',
    'references/plan-comment-template.md',
    { skillLocalExists: (rel) => rel === 'plugins/loops-workflow/skills/plan/references/plan-comment-template.md' },
  );
  assert(exempt === true, `isStructurallyExempt：skill-local 正確解析到自己的 references/ → 豁免（實際：${exempt}）[unit-skill-local]`);
}
{
  const exempt = isStructurallyExempt(
    'plugins/loops-workflow/skills/plan/SKILL.md',
    'references/does-not-exist.md',
    { skillLocalExists: () => false },
  );
  assert(exempt === false, `isStructurallyExempt：skill 底下但檔案不存在 → 不豁免（實際：${exempt}）[unit-skill-local-miss]`);
}

// ══════════════════════════════════════════════════════════════════════════
// 3. checkLegacyPaths（純函式）：allowlist 全豁免、非 allowlist 逐條判紅
// ══════════════════════════════════════════════════════════════════════════
{
  const fileMap = { 'docs/foo.md': '見 `references/clean-code.md`' };
  const result = checkLegacyPaths(fileMap, { allowlist: [{ file: 'docs/foo.md', category: 'x', reason: 'test' }] });
  assert(result.ok === true, `checkLegacyPaths：在 allowlist 上的檔全豁免（實際：${JSON.stringify(result)}）[unit-allowlisted]`);
}
{
  // 負向 fixture（本任務核心紅燈）：非 allowlist 的檔留一處舊路徑 → 必須命中並指名
  const fileMap = { 'docs/bar.md': '這裡不該再寫 `references/clean-code.md` 這種扁平字面' };
  const result = checkLegacyPaths(fileMap, { allowlist: [] });
  assert(result.ok === false, `checkLegacyPaths：非 allowlist 檔留舊路徑 → ok===false（實際：${JSON.stringify(result)}）[unit-negative]`);
  assert(
    result.findings.some((f) => f.check === 'legacy-flat-path' && f.file === 'docs/bar.md' && f.detail.includes('references/clean-code.md')),
    `checkLegacyPaths：findings 指名 docs/bar.md 與該字面（實際：${JSON.stringify(result.findings)}）[unit-negative]`,
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 4. formatSummary
// ══════════════════════════════════════════════════════════════════════════
{
  const summary = formatSummary({ ok: true, findings: [] });
  assert(typeof summary === 'string' && summary.includes('✓'), 'formatSummary：ok===true → 含 ✓ [summary-a]');
}
{
  const summary = formatSummary({ ok: false, findings: [{ check: 'legacy-flat-path', severity: 'P1', file: 'x.md', detail: '殘留' }] });
  assert(summary.includes('✗') && summary.includes('x.md'), `formatSummary：ok===false → 含 ✗ 且指名（實際：${summary}）[summary-b]`);
}

// ══════════════════════════════════════════════════════════════════════════
// 5. buildReport 對真實 repo root → 綠（allowlist 已涵蓋現況全部已知刻意保留字面）
// ══════════════════════════════════════════════════════════════════════════
{
  const result = buildReport(REPO_ROOT);
  assert(
    result.ok === true,
    `buildReport：對真實 repo root → ok===true（實際 findings：${JSON.stringify(result.findings)}）[real-repo]`,
  );
}

// ══════════════════════════════════════════════════════════════════════════
// IO/CLI 整合（spawnSync 真跑 check-legacy-paths.mjs --root <合成 repo>）
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

// IO-1：合成 repo 全乾淨（只有巢狀路徑）→ 綠
{
  const dir = mkdtempSync(join(tmpdir(), 'clp-'));
  try {
    writeFiles(dir, { 'docs/ok.md': '見 `references/shared/quality/clean-code.md`' });
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 0, `IO-1：全乾淨合成 repo → exit code===0（實際 stdout：${res.stdout}；stderr：${res.stderr}）[IO-1]`);
    assert(json && json.ok === true, `IO-1：--json ok===true（實際：${JSON.stringify(json)}）[IO-1]`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-2（負向 fixture，本任務核心紅燈）：合成 repo 故意留一處非 allowlist 的舊路徑 → CLI 必須紅並指名
{
  const dir = mkdtempSync(join(tmpdir(), 'clp-'));
  try {
    writeFiles(dir, { 'docs/regression.md': '故意殘留一處舊路徑：`agents/impl-author.md`（應為 agents/build/impl-author.md）' });
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 1, `IO-2：合成 repo 故意留舊路徑 → exit code===1（實際 stdout：${res.stdout}）[IO-2-negative]`);
    assert(
      json && json.findings.some((f) => f.file === 'docs/regression.md' && f.detail.includes('agents/impl-author.md')),
      `IO-2：--json findings 指名 docs/regression.md 與該字面（實際：${JSON.stringify(json)}）[IO-2-negative]`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-3：不帶 --root，對本 repo 真實預設路徑跑 → 綠
{
  const res = spawnSync('node', [SCRIPT, '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    json = null;
  }
  assert(res.status === 0, `IO-3：預設 --root 對真實 repo 跑 → exit code===0（實際 status：${res.status}；stdout：${res.stdout}）[IO-3]`);
  assert(json && json.ok === true, `IO-3：真實 repo 現況全過 → ok===true（實際：${JSON.stringify(json)}）[IO-3]`);
}

// IO-4（真實負向驗證）：對「本 repo 真實副本」故意在一個非 allowlist 檔案注入舊路徑字面 → CLI 必須紅，
// 驗完立刻還原——這是負向 fixture 的最強版本：不是合成的最小 repo，是真實整棵樹上動一處。
{
  const targetRel = 'plugins/loops-workflow/references/shared/quality/clean-code.md';
  const targetAbs = join(REPO_ROOT, ...targetRel.split('/'));
  const original = readFileSync(targetAbs, 'utf8');
  try {
    writeFileSync(targetAbs, `${original}\n\n<!-- 負向驗證注入：故意殘留舊路徑 references/reuse-check.md -->\n`, 'utf8');
    const res = spawnSync('node', [SCRIPT, '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    let json = null;
    try {
      json = JSON.parse(res.stdout);
    } catch {
      json = null;
    }
    assert(res.status === 1, `IO-4：真實樹注入舊路徑 → exit code===1（實際 status：${res.status}；stdout：${res.stdout}）[IO-4-negative-live]`);
    assert(
      json && json.findings.some((f) => f.file === targetRel && f.detail.includes('references/reuse-check.md')),
      `IO-4：findings 指名注入處與字面（實際：${JSON.stringify(json)}）[IO-4-negative-live]`,
    );
  } finally {
    writeFileSync(targetAbs, original, 'utf8');
    const restored = readFileSync(targetAbs, 'utf8');
    assert(restored === original, 'IO-4：注入檔已還原成原始內容 [IO-4-restore]');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 6. allowlist 分類統計（三大類：historical-design-doc／frozen-eval-corpus／negative-fixture）
// ══════════════════════════════════════════════════════════════════════════
{
  const validCategories = new Set(['historical-design-doc', 'frozen-eval-corpus', 'negative-fixture', 'self-reference']);
  const allValid = LEGACY_PATH_ALLOWLIST.every((e) => validCategories.has(e.category) && typeof e.reason === 'string' && e.reason.length > 0);
  assert(allValid, `allowlist：每條都屬三大類之一且附非空理由（實際：${JSON.stringify(LEGACY_PATH_ALLOWLIST.map((e) => e.category))}）[allowlist-shape]`);
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.error('\n失敗清單：');
  for (const msg of failed) console.error(`  - ${msg}`);
  process.exit(1);
}
process.exit(0);
