#!/usr/bin/env node
// test-eval-tags.mjs —— eval-tags.mjs 的紅綠斷言（自帶 harness）。
// 用法（cwd = plugins/loops-workflow）：node scripts/test-eval-tags.mjs

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { groupByTag, summarizeByTag, crossLink } from './eval-tags.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'eval-tags.mjs');

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed.push(msg); console.error(`  ✗ ${msg}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── T1 groupByTag + summarizeByTag ──────────────────────────────────────────────
{
  const items = [
    { id: 'a', tags: ['x', 'y'] },
    { id: 'b', tags: ['x'] },
    { id: 'c', tags: [] },
    { id: 'd' },
  ];
  const g = groupByTag(items);
  assert(g.x.length === 2 && g.y.length === 1, 'groupByTag：多 tag item 各入組（x:2 y:1）[T1]');
  assert(g.z === undefined, 'groupByTag：無此 tag → undefined [T1]');
  assert(!('(untagged)' in g) && Object.keys(g).length === 2, 'groupByTag：無 tags 的 item 不入任何組 [T1]');
  // __proto__ 安全（Object.create(null)）
  const gp = groupByTag([{ id: 'p', tags: ['__proto__'] }]);
  assert(gp['__proto__'] && gp['__proto__'].length === 1, 'groupByTag：__proto__ 當一般 tag 安全 [T1]');

  const results = [
    { id: 'a', pass: true, tags: ['x', 'sec'] },
    { id: 'b', pass: false, tags: ['x'] },
    { id: 'c', pass: true, tags: ['sec'] },
  ];
  const s = summarizeByTag(results);
  assert(eq(s.map((t) => t.tag), ['sec', 'x']), 'summarizeByTag：依 tag 字典序 [T1]');
  assert(eq(s.find((t) => t.tag === 'x'), { tag: 'x', total: 2, passed: 1, failed: 1 }),
    'summarizeByTag：x total2 passed1 failed1 [T1]');
  assert(eq(s.find((t) => t.tag === 'sec'), { tag: 'sec', total: 2, passed: 2, failed: 0 }),
    'summarizeByTag：sec total2 passed2 failed0 [T1]');
}

// ── T2 crossLink（tag/axis 交集雙向 + onlyFailures）──────────────────────────────
{
  const evalResults = [
    { id: 'e1', pass: false, tags: ['security'], verifyAxes: ['security'] },
    { id: 'e2', pass: false, tags: ['perf'] },
    { id: 'e3', pass: true, tags: ['security'] },
  ];
  const findings = [
    { id: 'f1', axis: 'security' },
    { id: 'f2', axis: 'tests', tags: ['perf'] },
  ];
  const link = crossLink(evalResults, findings, {});
  assert(link.evalToVerify.length === 2, 'crossLink：onlyFailures 預設排除 pass 的 e3 [T2]');
  assert(eq(link.evalToVerify.find((e) => e.evalId === 'e1').findings, ['f1']),
    'crossLink：e1(security) ↔ f1 [T2]');
  assert(eq(link.evalToVerify.find((e) => e.evalId === 'e2').findings, ['f2']),
    'crossLink：e2(perf) ↔ f2(axis tests + tag perf) [T2]');
  assert(eq(link.verifyToEval.find((f) => f.findingId === 'f1').evals, ['e1'])
    && eq(link.verifyToEval.find((f) => f.findingId === 'f2').evals, ['e2']),
    'crossLink：verifyToEval 反向 f1→e1 f2→e2 [T2]');
  // onlyFailures:false → e3(security, pass) 也連 f1
  const all = crossLink(evalResults, findings, { onlyFailures: false });
  assert(all.evalToVerify.length === 3 && eq(all.evalToVerify.find((e) => e.evalId === 'e3').findings, ['f1']),
    'crossLink：onlyFailures false → 含 pass 的 e3↔f1 [T2]');
  // 無交集不連
  const none = crossLink([{ id: 'z', pass: false, tags: ['unrelated'] }], findings, {});
  assert(none.evalToVerify[0].findings.length === 0, 'crossLink：無交集 tag → 不連 [T2]');
}

// ── T3 CLI spawn smoke ──────────────────────────────────────────────────────────
function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}
{
  const dir = mkdtempSync(join(tmpdir(), 'evaltags-'));
  const report = join(dir, 'report.json');
  writeFileSync(report, JSON.stringify({
    total: 3, passed: 2, failed: 1,
    tasks: [
      { id: 'a', pass: true, tags: ['x', 'sec'] },
      { id: 'b', pass: false, tags: ['x'] },
      { id: 'c', pass: true, tags: ['sec'] },
    ],
  }));
  const findingsFile = join(dir, 'findings.json');
  writeFileSync(findingsFile, JSON.stringify([{ id: 'f1', axis: 'sec' }]));

  const byTag = run(['by-tag', '--results', report]);
  assert(byTag.status === 0 && /sec/.test(byTag.stdout), 'CLI by-tag：exit 0 + 印 per-tag [T3]');
  assert(run(['link', '--eval', report, '--findings', findingsFile]).status === 0, 'CLI link：exit 0 [T3]');
  assert(run(['by-tag']).status === 2, 'CLI by-tag：缺 --results → exit 2 [T3]');
  assert(run(['bogus']).status === 2, 'CLI：未知命令 → exit 2 [T3]');
  assert(run(['by-tag', '--results', join(dir, 'nope.json')]).status === 3, 'CLI by-tag：讀檔失敗 → exit 3 [T3]');
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.error('FAILED:\n' + failed.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
