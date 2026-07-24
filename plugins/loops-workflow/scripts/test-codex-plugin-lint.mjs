#!/usr/bin/env node
// test-codex-plugin-lint.mjs —— codex-plugin-lint.mjs 的紅綠單元 + IO/CLI 整合斷言（自帶極簡 harness，仿 test-skill-lint.mjs）。
// 用法：node test-codex-plugin-lint.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1（主線用此 exit code 判紅綠）。
//
// 預期 Red：codex-plugin-lint.mjs 尚未實作，下面的 import 會 ERR_MODULE_NOT_FOUND，
// 整個檔在載入期就丟例外 → node 以非 0 退出。這就是 TDD 的紅燈起點。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  parsePluginManifest,
  codexPluginRequiredFieldsCheck,
  manifestEqualityCheck,
  marketplaceNameCheck,
  sourcePathCheck,
  duplicateTreeCheck,
  formatSummary,
} from './codex-plugin-lint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = fileURLToPath(new URL('./codex-plugin-lint.mjs', import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures', 'codex-bootstrap');

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

function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'));
}

// ══════════════════════════════════════════════════════════════════════════
// 1. parsePluginManifest
// ══════════════════════════════════════════════════════════════════════════
{
  const r = parsePluginManifest('{"name":"x","version":"1.0.0"}');
  assert(r && r.manifest && r.manifest.name === 'x', 'parsePluginManifest：合法 JSON → manifest 物件 [1a]');
  assert(!r.error, 'parsePluginManifest：合法 JSON → 無 error [1a]');
}
{
  const r = parsePluginManifest('{not valid json');
  assert(r && typeof r.error === 'string', 'parsePluginManifest：壞 JSON → 回傳 {error} [1b]');
}
{
  const r = parsePluginManifest('[1,2,3]');
  assert(r && typeof r.error === 'string', 'parsePluginManifest：陣列非物件 → 回傳 {error} [1c]');
}

// ══════════════════════════════════════════════════════════════════════════
// 2. codexPluginRequiredFieldsCheck（fixture：合法 / 缺欄位）
// ══════════════════════════════════════════════════════════════════════════
{
  const manifest = loadFixture('codex-plugin-valid.json');
  const findings = codexPluginRequiredFieldsCheck(manifest, '.codex-plugin/plugin.json');
  assert(
    Array.isArray(findings) && findings.length === 0,
    `codexPluginRequiredFieldsCheck：合法 fixture → 0 筆 finding（實際：${JSON.stringify(findings)}）[2a]`,
  );
}
{
  const manifest = loadFixture('codex-plugin-missing-field.json');
  const findings = codexPluginRequiredFieldsCheck(manifest, '.codex-plugin/plugin.json');
  assert(
    findings.some((f) => f.detail.includes('version')),
    `codexPluginRequiredFieldsCheck：缺 version fixture → 命中 version 缺失（實際：${JSON.stringify(findings)}）[2b]`,
  );
  assert(
    findings.some((f) => f.detail.includes('author.name')),
    `codexPluginRequiredFieldsCheck：缺 author fixture → 命中 author.name 缺失（實際：${JSON.stringify(findings)}）[2b]`,
  );
  assert(
    findings.every((f) => f.severity === 'P1'),
    'codexPluginRequiredFieldsCheck：所有缺欄位 finding 皆 P1 [2b]',
  );
}
{
  // skills 欄位不是 "./skills/" → 命中
  const manifest = { name: 'x', version: '1.0.0', description: 'd', author: { name: 'a' }, skills: 'skills' };
  const findings = codexPluginRequiredFieldsCheck(manifest, 'f.json');
  assert(
    findings.some((f) => f.detail.includes('skills')),
    `codexPluginRequiredFieldsCheck：skills 欄位非 "./skills/" → 命中（實際：${JSON.stringify(findings)}）[2c]`,
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 3. manifestEqualityCheck（fixture：name/version 等值 / 版本漂移）
// ══════════════════════════════════════════════════════════════════════════
{
  const codexManifest = loadFixture('codex-plugin-valid.json');
  const claudeManifest = loadFixture('claude-plugin-reference.json');
  const findings = manifestEqualityCheck(codexManifest, claudeManifest, ['a', 'b']);
  assert(
    Array.isArray(findings) && findings.length === 0,
    `manifestEqualityCheck：name/version 皆等值 fixture → 0 筆 finding（實際：${JSON.stringify(findings)}）[3a]`,
  );
}
{
  const codexManifest = loadFixture('codex-plugin-version-drift.json');
  const claudeManifest = loadFixture('claude-plugin-reference.json');
  const findings = manifestEqualityCheck(codexManifest, claudeManifest, ['a', 'b']);
  assert(
    findings.some((f) => f.check === 'manifest-version-equality'),
    `manifestEqualityCheck：版本漂移 fixture → 命中 version 不等值（實際：${JSON.stringify(findings)}）[3b]`,
  );
  assert(
    !findings.some((f) => f.check === 'manifest-name-equality'),
    'manifestEqualityCheck：版本漂移 fixture 的 name 仍相同 → 不誤報 name-equality [3b]',
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 4. marketplaceNameCheck（fixture：合法 / name mismatch）
// ══════════════════════════════════════════════════════════════════════════
{
  const codexMarketplace = loadFixture('codex-marketplace-valid.json');
  const claudeMarketplace = loadFixture('claude-marketplace-reference.json');
  const findings = marketplaceNameCheck({ codexMarketplace, claudeMarketplace, expectedName: 'dev-workflows' });
  assert(
    Array.isArray(findings) && findings.length === 0,
    `marketplaceNameCheck：合法 fixture → 0 筆 finding（實際：${JSON.stringify(findings)}）[4a]`,
  );
}
{
  const codexMarketplace = loadFixture('codex-marketplace-name-mismatch.json');
  const claudeMarketplace = loadFixture('claude-marketplace-reference.json');
  const findings = marketplaceNameCheck({ codexMarketplace, claudeMarketplace, expectedName: 'dev-workflows' });
  assert(
    findings.some((f) => f.file === '.agents/plugins/marketplace.json'),
    `marketplaceNameCheck：name mismatch fixture → 命中 codex marketplace name 落差（實際：${JSON.stringify(findings)}）[4b]`,
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 5. sourcePathCheck（fixture：合法 / bad path）
// ══════════════════════════════════════════════════════════════════════════
{
  const codexMarketplace = loadFixture('codex-marketplace-valid.json');
  const findings = sourcePathCheck(codexMarketplace, () => true);
  assert(
    Array.isArray(findings) && findings.length === 0,
    `sourcePathCheck：existsFn 全通過 → 0 筆 finding（實際：${JSON.stringify(findings)}）[5a]`,
  );
}
{
  const codexMarketplace = loadFixture('codex-marketplace-bad-path.json');
  const findings = sourcePathCheck(codexMarketplace, () => false);
  assert(
    findings.some((f) => f.check === 'marketplace-source-path'),
    `sourcePathCheck：existsFn 回 false → 命中 source-path finding（實際：${JSON.stringify(findings)}）[5b]`,
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 6. duplicateTreeCheck（fixture：clean / 複製樹）
// ══════════════════════════════════════════════════════════════════════════
{
  const fileList = loadFixture('clean-file-list.json');
  const findings = duplicateTreeCheck(fileList);
  assert(
    Array.isArray(findings) && findings.length === 0,
    `duplicateTreeCheck：clean fixture → 0 筆 finding（實際：${JSON.stringify(findings)}）[6a]`,
  );
}
{
  const fileList = loadFixture('duplicate-tree-file-list.json');
  const findings = duplicateTreeCheck(fileList);
  assert(
    findings.some((f) => f.check === 'duplicate-tree' && f.detail.includes('skills')),
    `duplicateTreeCheck：複製樹 fixture → 命中 skills 複製（實際：${JSON.stringify(findings)}）[6b]`,
  );
  assert(
    findings.some((f) => f.check === 'duplicate-tree' && f.detail.includes('references')),
    `duplicateTreeCheck：複製樹 fixture → 命中 references 複製（實際：${JSON.stringify(findings)}）[6b]`,
  );
}
{
  const findings = duplicateTreeCheck([]);
  assert(Array.isArray(findings) && findings.length === 0, 'duplicateTreeCheck：空清單 → 0 筆 finding [6c]');
}
{
  // skill-local references（.../skills/<name>/references/...）是既有合法慣例，不算跟 plugin 層
  // references/ 競爭的複製樹——回歸測試：先前設計曾誤判真實 repo 的 skills/plan/references、
  // skills/scaffold-fullstack/references 為複製樹（對真 repo 跑才發現，補這條鎖住修正）。
  const fileList = [
    'plugins/loops-workflow/references/journaling.md',
    'plugins/loops-workflow/skills/plan/references/foo.md',
    'plugins/loops-workflow/skills/scaffold-fullstack/references/bar.md',
    'plugins/loops-workflow/skills/dispatch/SKILL.md',
  ];
  const findings = duplicateTreeCheck(fileList);
  assert(
    Array.isArray(findings) && findings.length === 0,
    `duplicateTreeCheck：skill-local references 巢狀目錄不誤判為複製樹（實際：${JSON.stringify(findings)}）[6d]`,
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 7. formatSummary
// ══════════════════════════════════════════════════════════════════════════
{
  const summary = formatSummary({ findings: [], notes: [], summary: { filesScanned: 3 } });
  assert(typeof summary === 'string' && summary.includes('✓'), 'formatSummary：無 finding → 含 ✓ [7a]');
}
{
  const summary = formatSummary({
    findings: [{ check: 'x', severity: 'P1', file: 'f.json', detail: 'd' }],
    notes: [],
    summary: { filesScanned: 3 },
  });
  assert(typeof summary === 'string' && summary.includes('✗'), 'formatSummary：有 finding → 含 ✗ [7b]');
}

// ══════════════════════════════════════════════════════════════════════════
// IO/CLI 整合（spawnSync 真跑 codex-plugin-lint.mjs --root <repo根>）
// ══════════════════════════════════════════════════════════════════════════
function writeFiles(root, filesObj) {
  for (const [rel, content] of Object.entries(filesObj)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
}

function jsonFile(obj) {
  return JSON.stringify(obj, null, 2);
}

function baselineFiles() {
  return {
    'plugins/loops-workflow/.codex-plugin/plugin.json': jsonFile(loadFixture('codex-plugin-valid.json')),
    'plugins/loops-workflow/.claude-plugin/plugin.json': jsonFile(loadFixture('claude-plugin-reference.json')),
    '.agents/plugins/marketplace.json': jsonFile(loadFixture('codex-marketplace-valid.json')),
    '.claude-plugin/marketplace.json': jsonFile(loadFixture('claude-marketplace-reference.json')),
    'plugins/loops-workflow/skills/dispatch/SKILL.md': '# dispatch\n',
    'plugins/loops-workflow/references/journaling.md': '# journaling\n',
  };
}

function makeRepo(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cpl-'));
  writeFiles(dir, { ...baselineFiles(), ...extra });
  return dir;
}

function runCli(root, args = ['--json']) {
  const res = spawnSync('node', [SCRIPT, '--root', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
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

// IO-1：健康 fixture repo（含 canonical .agents/plugins/marketplace.json 的 source.path 真實存在）→ 綠
{
  const dir = makeRepo();
  try {
    const { res, json } = runCli(dir, ['--json']);
    assert(res.error == null, 'IO-1：node 啟動成功（spawn 無 error）[IO-1]');
    assert(res.status === 0, `IO-1：健康 fixture → exit code===0（實際 stdout：${res.stdout}）[IO-1]`);
    assert(json && json.ok === true, `IO-1：--json ok===true（實際：${JSON.stringify(json)}）[IO-1]`);
    assert(json && Array.isArray(json.findings) && json.findings.length === 0, 'IO-1：--json findings===[] [IO-1]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-2：缺 .codex-plugin/plugin.json → 紅（exit 1，findings 含 codex-plugin-manifest）
{
  const files = baselineFiles();
  delete files['plugins/loops-workflow/.codex-plugin/plugin.json'];
  const dir = mkdtempSync(join(tmpdir(), 'cpl-'));
  writeFiles(dir, files);
  try {
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 1, 'IO-2：缺 .codex-plugin/plugin.json → exit code===1 [IO-2]');
    assert(
      json && json.findings.some((f) => f.check === 'codex-plugin-manifest'),
      `IO-2：--json findings 含 codex-plugin-manifest（實際：${JSON.stringify(json)}）[IO-2]`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-3：name/version 漂移（.codex-plugin 用 version-drift fixture）→ 紅
{
  const files = baselineFiles();
  files['plugins/loops-workflow/.codex-plugin/plugin.json'] = jsonFile(loadFixture('codex-plugin-version-drift.json'));
  const dir = mkdtempSync(join(tmpdir(), 'cpl-'));
  writeFiles(dir, files);
  try {
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 1, 'IO-3：版本漂移 → exit code===1 [IO-3]');
    assert(
      json && json.findings.some((f) => f.check === 'manifest-version-equality'),
      `IO-3：--json findings 含 manifest-version-equality（實際：${JSON.stringify(json)}）[IO-3]`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-4：複製樹（額外放一份 .codex-plugin/skills/）→ 紅
{
  const files = baselineFiles();
  files['plugins/loops-workflow/.codex-plugin/skills/dispatch/SKILL.md'] = '# dispatch copy\n';
  const dir = mkdtempSync(join(tmpdir(), 'cpl-'));
  writeFiles(dir, files);
  try {
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 1, 'IO-4：複製 skills 樹 → exit code===1 [IO-4]');
    assert(
      json && json.findings.some((f) => f.check === 'duplicate-tree'),
      `IO-4：--json findings 含 duplicate-tree（實際：${JSON.stringify(json)}）[IO-4]`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// IO-5：scripts/fixtures/ 底下自己放的假 fixture 檔（本檔自己這批）不該被 duplicate-tree 誤判
// （fixtures 排除規則仿 skill-lint EXCLUDED_DIR_NAMES）
{
  const files = baselineFiles();
  // 模擬「lint 自己的 fixtures 目錄底下也剛好有一個 skills/ 字樣路徑」——真實情境是
  // scripts/fixtures/codex-bootstrap/ 下只有 .json，這裡刻意放一個更貼近會誤報的路徑
  // 來證明 fixtures 目錄真的被排除在複製樹掃描之外。
  files['plugins/loops-workflow/scripts/fixtures/codex-bootstrap/skills/fake/SKILL.md'] = '# fake\n';
  const dir = mkdtempSync(join(tmpdir(), 'cpl-'));
  writeFiles(dir, files);
  try {
    const { res, json } = runCli(dir, ['--json']);
    assert(res.status === 0, `IO-5：fixtures 底下的假 skills/ 路徑不誤判 duplicate-tree → exit code===0（實際：${JSON.stringify(json)}）[IO-5]`);
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
