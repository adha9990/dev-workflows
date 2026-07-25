#!/usr/bin/env node
// test-component-resolver.mjs —— component-resolver.mjs 的紅綠斷言（#171 T2）。
// 用法：node test-component-resolver.mjs [--filter <case-prefix>] [--min-cases <n>]
//   --min-cases 6  斷言實際跑到的 case 數不得少於 6（沒有這個地板，一個沒寫測試的任務也會 exit 0）
// 全綠且達到 case 地板 → exit 0；任一斷言失敗 / case 數不足 / import 失敗 → exit 1。
//
// 覆蓋 R1（找不到 id 丟例外並指名）、R2（一律絕對路徑）、R3（不猜同名檔）三條硬規則，
// 外加 resolveMany 的 fail-fast 與 listByOwner 的「不靜默回空」。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { resolveComponent, resolveMany, listByOwner, loadRegistry } from './component-resolver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const REGISTRY_REL = 'plugins/loops-workflow/references/component-registry.json';

// ── 極簡 harness ──────────────────────────────────────────────────────────────
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
    const flag = argv[i];
    if (flag === '--filter') opts.filter = argv[++i] ?? '';
    else if (flag === '--min-cases') opts.minCases = Number(argv[++i] ?? 0);
  }
  return opts;
}

function throwsWith(fn, needle) {
  try {
    fn();
    return { threw: false, message: '(沒有丟例外)' };
  } catch (err) {
    return { threw: true, message: String(err.message), matched: String(err.message).includes(needle) };
  }
}

// ── 合成樹：registry 與磁碟落點都由測試自己擺，跟真實 repo 現況解耦 ─────────────
function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
}

function syntheticRegistry(components) {
  return JSON.stringify({ schema_version: '1', notes: '合成 fixture', components }, null, 2);
}

function makeRepo(components, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cres-'));
  writeFiles(dir, { [REGISTRY_REL]: syntheticRegistry(components), ...files });
  return dir;
}

// ══════════════════════════════════════════════════════════════════════════
testCase('R1', '找不到 id → 丟例外並指名該 id（不回 null）', () => {
  const r = throwsWith(() => resolveComponent('no-such-component', { root: REPO_ROOT }), 'no-such-component');
  assert(r.threw, `未知 id 必須丟例外（實際：${r.message}）`);
  assert(r.matched, `例外訊息要指名該 id（實際：${r.message}）`);
});

testCase('R2', '已知單一檔案元件 → 回絕對路徑', () => {
  const abs = resolveComponent('ref-clean-code', { root: REPO_ROOT });
  assert(isAbsolute(abs), `resolveComponent 必須回絕對路徑（實際：${abs}）`);
  assert(abs.endsWith('clean-code.md'), `解出的路徑要指向該元件的檔案（實際：${abs}）`);
});

testCase('R3a', '候選路徑都不存在 → 丟例外並列出候選，不猜同名檔', () => {
  const root = makeRepo(
    [{ id: 'ghost-ref', paths: ['plugins/loops-workflow/references/ghost.md'], target_path: null, owner_class: 'shared-runtime' }],
    // 同名檔刻意擺在別的目錄：會「猜」的實作在這裡就會撿到它並回一條沒人宣告過的路徑
    { 'plugins/loops-workflow/docs/ghost.md': '# 同名誘餌\n' },
  );
  try {
    const r = throwsWith(() => resolveComponent('ghost-ref', { root }), 'ghost.md');
    assert(r.threw, `候選都不存在時必須丟例外（實際：${r.message}）`);
    assert(r.matched && r.message.includes('references/ghost.md'), `例外要列出試過的候選（實際：${r.message}）`);
    assert(!r.message.includes('docs/ghost.md'), `不得把別處的同名檔當 fallback（實際：${r.message}）`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

testCase('R3b', '多路徑元件沒有單一落點 → 丟例外說明，不亂挑第一條', () => {
  const r = throwsWith(() => resolveComponent('hook-shared-runtime', { root: REPO_ROOT }), 'hook-shared-runtime');
  assert(r.threw && r.matched, `多路徑元件要丟例外並指名（實際：${r.message}）`);
  assert(r.message.includes('單一檔案'), `例外要說明原因是「非單一檔案元件」（實際：${r.message}）`);
});

testCase('R3c', '搬到 target_path 的樹也解得到（候選只來自 registry 宣告）', () => {
  const root = makeRepo(
    [{
      id: 'ref-moved',
      paths: ['plugins/loops-workflow/references/moved.md'],
      target_path: 'plugins/loops-workflow/references/shared/runtime/moved.md',
      owner_class: 'shared-runtime',
    }],
    { 'plugins/loops-workflow/references/shared/runtime/moved.md': '# 已搬遷\n' },
  );
  try {
    const abs = resolveComponent('ref-moved', { root });
    assert(isAbsolute(abs) && abs.replace(/\\/g, '/').endsWith('references/shared/runtime/moved.md'), `舊路徑已不存在時要解到 registry 宣告的 target_path（實際：${abs}）`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

testCase('M1', 'resolveMany → { id: 絕對路徑 }，任一 id 壞掉即丟例外並指名', () => {
  const map = resolveMany(['ref-clean-code', 'ref-minimalism-ladder'], { root: REPO_ROOT });
  assert(Object.keys(map).length === 2, `兩個 id 要回兩筆（實際：${JSON.stringify(map)}）`);
  assert(Object.values(map).every(isAbsolute), `每一筆都要是絕對路徑（實際：${JSON.stringify(map)}）`);

  const r = throwsWith(() => resolveMany(['ref-clean-code', 'bogus-id'], { root: REPO_ROOT }), 'bogus-id');
  assert(r.threw && r.matched, `批次解析遇到壞 id 要 fail-fast 並指名（實際：${r.message}）`);
});

testCase('L1', 'listByOwner 回該類全部元件；未知 owner_class 丟例外而非靜默回空', () => {
  const shared = listByOwner('shared-runtime', { root: REPO_ROOT });
  assert(shared.length > 0, `shared-runtime 應有成員（實際：${shared.length}）`);
  assert(shared.every((c) => c.owner_class === 'shared-runtime'), 'listByOwner 回傳的每一筆 owner_class 都要相符');
  assert(shared.every((c) => typeof c.target_path === 'string'), 'reference 元件都帶 target_path（搬遷落點）');

  const registry = loadRegistry(REPO_ROOT);
  const total = ['stage', 'persona', 'shared-runtime', 'shared-quality', 'shared-delivery', 'shared-docs']
    .reduce((sum, cls) => sum + listByOwner(cls, { root: REPO_ROOT }).length, 0);
  assert(total > 0 && total <= registry.components.length, `各 owner_class 成員數合計不得超過元件總數（${total} / ${registry.components.length}）`);

  const r = throwsWith(() => listByOwner('sharedruntime', { root: REPO_ROOT }), 'sharedruntime');
  assert(r.threw && r.matched, `拼錯的 owner_class 要丟例外並指名（實際：${r.message}）`);
});

testCase('CLI1', 'CLI 逐行印出絕對路徑；壞 id 非零退出並指名（markdown orchestrator 的取路徑入口）', () => {
  const script = join(HERE, 'component-resolver.mjs');
  const ok = spawnSync(process.execPath, [script, 'ref-clean-code', 'ref-minimalism-ladder'], { encoding: 'utf8' });
  const lines = ok.stdout.trim().split('\n');
  assert(ok.status === 0, `合法 id → exit 0（實際：${ok.status}，stderr：${ok.stderr}）`);
  assert(lines.length === 2 && lines.every((l) => isAbsolute(l)), `每個 id 印一行絕對路徑（實際：${JSON.stringify(lines)}）`);
  assert(lines[0].replace(/\\/g, '/').endsWith('references/shared/quality/clean-code.md'), `路徑要指向 registry 現況落點（實際：${lines[0]}）`);

  const bad = spawnSync(process.execPath, [script, 'bogus-id'], { encoding: 'utf8' });
  assert(bad.status === 1, `壞 id → 非零退出（實際：${bad.status}）`);
  assert(bad.stderr.includes('bogus-id'), `壞 id 的錯誤訊息要指名該 id（實際：${bad.stderr.trim()}）`);
  assert(bad.stdout.trim() === '', `壞 id 不得印出任何路徑（實際：${JSON.stringify(bad.stdout)}）`);

  const noArgs = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert(noArgs.status === 2, `沒帶 id → exit 2 並印用法（實際：${noArgs.status}）`);
});

// ══════════════════════════════════════════════════════════════════════════
const opts = parseArgs(process.argv.slice(2));
const selected = cases.filter((c) => c.id.startsWith(opts.filter));

for (const c of selected) {
  console.log(`\n[${c.id}] ${c.name}`);
  c.fn();
}

console.log(`\n${selected.length} cases run, ${passed} passed, ${failed.length} failed`);

if (opts.minCases > 0 && selected.length < opts.minCases) {
  console.error(`\n✗ case 數地板未達成：--min-cases ${opts.minCases}，實際跑到 ${selected.length}（filter="${opts.filter}"）`);
  process.exit(1);
}

if (failed.length > 0) {
  console.error('\n失敗清單：');
  for (const msg of failed) console.error(`  - ${msg}`);
  process.exit(1);
}
process.exit(0);
