#!/usr/bin/env node
// test-eval-tags.mjs —— eval-tags.mjs 的紅綠斷言（自帶 harness）。
// 用法（cwd = plugins/loops-workflow）：node scripts/test-eval-tags.mjs

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { groupByTag, summarizeByTag, crossLink } from './eval-tags.mjs';
// #87 修復輪 P2（sec）：readJson 新增可選 maxBytes 參數，現尚未 export（僅 CLI 內部用）。
// 用 namespace import 取用：未 export 時呼叫 undefined → TypeError → callSafe 捕捉，逐條轉紅
// （不連坐既有 T1-T3 斷言，比照 test-eval-gate.mjs 的 namespace-import 慣例）。
import * as ET from './eval-tags.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'eval-tags.mjs');

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed.push(msg); console.error(`  ✗ ${msg}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function callSafe(fn) {
  try { return { threw: false, val: fn() }; }
  catch (e) { return { threw: true, err: e }; }
}
// tasksOf 的測試端等價複製（純取值，非 impl 真相源）：容受 {tasks:[...]} 或裸陣列，其餘 → []。
function tasksOfLocal(report) {
  if (Array.isArray(report?.tasks)) return report.tasks;
  return Array.isArray(report) ? report : [];
}

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
  // 同 item 重複 tag 去重（與 crossLink Set 一致，不灌大計數）
  assert(groupByTag([{ id: 'd', tags: ['x', 'x'] }]).x.length === 1, 'groupByTag：同 item 重複 tag 去重 [T1]');
  // 非字串 tag 跳過
  const gmix = groupByTag([{ id: 'm', tags: ['x', 1, null, {}] }]);
  assert(gmix.x.length === 1 && Object.keys(gmix).length === 1, 'groupByTag：非字串 tag 跳過 [T1]');

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

// ── RJ readJson(path, maxBytes) —— #87 修復輪 P2（sec）：新增可選 maxBytes 讀檔上限（預設 16MB 級）。
//    極小 maxBytes → 安全空值（不拋錯、不讀入超限內容；by-tag 語意上「無訊號」→ summarizeByTag 回 []）；
//    正常小檔 + 不帶 maxBytes（沿用預設）→ 正常解析（函式簽名相容）。readJson 現未 export → callSafe
//    捕捉 TypeError，兩條斷言皆先紅（新 export + maxBytes 尚未實作）。
{
  const dir = mkdtempSync(join(tmpdir(), 'et-maxbytes-'));
  try {
    const file = join(dir, 'report.json');
    writeFileSync(file, JSON.stringify({ total: 1, passed: 1, failed: 0, tasks: [{ id: 'a', pass: true, tags: ['x'] }] }));

    const r = callSafe(() => ET.readJson(file, 10)); // 極小 maxBytes(10)，內容遠超此值
    assert(!r.threw, 'readJson(file, 10)：極小 maxBytes 不拋錯（安全空值，非拋錯）[RJ-maxbytes-cap]');
    const byTag = summarizeByTag(tasksOfLocal(r.val));
    assert(Array.isArray(byTag) && byTag.length === 0,
      'readJson(file, 10) 接 by-tag 語意：超限 → 安全空值 → summarizeByTag 無訊號（[]）[RJ-maxbytes-cap]');

    const r2 = callSafe(() => ET.readJson(file)); // 原呼叫方式：不帶第二參數
    assert(!r2.threw, 'readJson(file)：不帶 maxBytes 不拋錯（簽名相容）[RJ-maxbytes-default]');
    const tasks2 = tasksOfLocal(r2.val);
    assert(tasks2.length === 1 && tasks2[0].id === 'a',
      'readJson(file)：小檔 + 預設上限 → 正常解析（行為不變）[RJ-maxbytes-default]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  // finding f1 axis 'x' → 與失敗 task b（tags['x']）交集，link 才驗得到雙向 wiring（非空）。
  const findingsFile = join(dir, 'findings.json');
  writeFileSync(findingsFile, JSON.stringify([{ id: 'f1', axis: 'x' }]));

  const byTag = run(['by-tag', '--results', report]);
  assert(byTag.status === 0 && /sec/.test(byTag.stdout), 'CLI by-tag：exit 0 + 印 per-tag [T3]');

  // link 端到端：失敗 b(tags x) ↔ f1(axis x)，雙向輸出非假綠
  const linkRes = run(['link', '--eval', report, '--findings', findingsFile]);
  let linkOut = null; try { linkOut = JSON.parse(linkRes.stdout); } catch { /* leave null */ }
  assert(linkRes.status === 0 && linkOut
    && linkOut.evalToVerify.find((e) => e.evalId === 'b').findings.includes('f1')
    && linkOut.verifyToEval.find((f) => f.findingId === 'f1').evals.includes('b'),
    'CLI link：失敗 b ↔ f1 雙向 wiring（非假綠）[T3]');

  assert(run(['by-tag']).status === 2, 'CLI by-tag：缺 --results → exit 2 [T3]');
  assert(run(['bogus']).status === 2, 'CLI：未知命令 → exit 2 [T3]');
  assert(run(['by-tag', '--results', join(dir, 'nope.json')]).status === 3, 'CLI by-tag：讀檔失敗 → exit 3 [T3]');

  // by-tag 容受裸陣列 report（tasksOf fallback）
  const bareArr = join(dir, 'bare.json');
  writeFileSync(bareArr, JSON.stringify([{ id: 'z', pass: true, tags: ['only'] }]));
  assert(/only/.test(run(['by-tag', '--results', bareArr]).stdout), 'CLI by-tag：裸陣列 report → tasksOf fallback [T3]');

  // link 錯誤路徑：缺 --findings exit 2、eval/findings 讀檔失敗 exit 3、錯形狀 findings exit 2
  assert(run(['link', '--eval', report]).status === 2, 'CLI link：缺 --findings → exit 2 [T3]');
  assert(run(['link', '--eval', join(dir, 'nope.json'), '--findings', findingsFile]).status === 3,
    'CLI link：eval 讀檔失敗 → exit 3 [T3]');
  assert(run(['link', '--eval', report, '--findings', join(dir, 'nope.json')]).status === 3,
    'CLI link：findings 讀檔失敗 → exit 3 [T3]');
  assert(run(['link', '--eval', report, '--findings', report]).status === 2,
    'CLI link：findings 非陣列（傳成 report 物件）→ exit 2 [T3]');
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.error('FAILED:\n' + failed.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
