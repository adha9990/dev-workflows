#!/usr/bin/env node
// test-quality-gate.mjs —— loops-quality-gate.mjs 的紅綠單元斷言（自帶極簡 harness，不引測試框架）。
// 用法：node test-quality-gate.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1（主線用此 exit code 判紅綠）。
//
// 預期 Red：loops-quality-gate.mjs 尚未實作，下面的 import 會 ERR_MODULE_NOT_FOUND，
// 整個檔在載入期就丟例外 → node 以非 0 退出。這就是 TDD 的紅燈起點。

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveConfig,
  parseVitest,
  parseEslint,
  parseTsc,
  dedupeFailures,
  formatSummary,
  runCommand,
} from './loops-quality-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'quality-gate');

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

// ── T1 resolveConfig：讀 <cwd>/.loops/gate.config.json ───────────────────────
{
  // T1①：有 gate.config.json → 回該檔的三個指令字串
  const dir = mkdtempSync(join(tmpdir(), 'qg-cfg-'));
  try {
    mkdirSync(join(dir, '.loops'), { recursive: true });
    const cfg = { test: 'vitest run', lint: 'eslint .', type: 'tsc --noEmit' };
    writeFileSync(join(dir, '.loops', 'gate.config.json'), JSON.stringify(cfg), 'utf8');
    const r = resolveConfig(dir);
    assert(r && r.test === 'vitest run', 'resolveConfig：有 config 回 test 指令 [T1①]');
    assert(r && r.lint === 'eslint .', 'resolveConfig：有 config 回 lint 指令 [T1①]');
    assert(r && r.type === 'tsc --noEmit', 'resolveConfig：有 config 回 type 指令 [T1①]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  // T1②：缺 config → 三鍵皆 null（代表走自動偵測）
  const dir = mkdtempSync(join(tmpdir(), 'qg-nocfg-'));
  try {
    const r = resolveConfig(dir);
    assert(
      r && r.test === null && r.lint === null && r.type === null,
      'resolveConfig：缺 config 三鍵皆 null [T1②]',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── T2 parseVitest：vitest --reporter=json，只挑 failed assertion ─────────────
{
  const out = parseVitest(readFileSync(join(FIX, 'vitest.json'), 'utf8'));
  assert(Array.isArray(out) && out.length === 1, 'parseVitest：只回 1 筆（passed 不入列）[T2]');
  const f = out[0] || {};
  assert(f.kind === 'test', 'parseVitest：kind=test [T2]');
  assert(f.severity === 'error', 'parseVitest：severity=error [T2]');
  assert(f.file === 'C:/repo/src/math.test.ts', 'parseVitest：file=testResults.name [T2]');
  assert(f.line === 9, 'parseVitest：line=失敗 assertion 的 location.line [T2]');
  assert(f.column === 3, 'parseVitest：column=失敗 assertion 的 location.column [T2]');
  assert(
    typeof f.message === 'string' && f.message.includes('expected -1 to be 1'),
    'parseVitest：message 含 failureMessages 內容 [T2]',
  );
}

// ── T3 parseEslint：eslint -f json，severity 2 → error ────────────────────────
{
  const out = parseEslint(readFileSync(join(FIX, 'eslint.json'), 'utf8'));
  assert(Array.isArray(out) && out.length === 1, 'parseEslint：回 1 筆 [T3]');
  const f = out[0] || {};
  assert(f.kind === 'lint', 'parseEslint：kind=lint [T3]');
  assert(f.severity === 'error', 'parseEslint：severity 2 → error [T3]');
  assert(f.file === 'C:/repo/src/util.ts', 'parseEslint：file=filePath [T3]');
  assert(f.ruleId === 'no-unused-vars', 'parseEslint：ruleId 對 [T3]');
  assert(f.line === 12 && f.column === 7, 'parseEslint：line/column 對 [T3]');
  assert(
    typeof f.message === 'string' && f.message.includes("'foo' is defined but never used."),
    'parseEslint：message 對 [T3]',
  );
}

// ── T4 parseTsc：tsc 診斷文字，只抓 error TS 行 ───────────────────────────────
{
  const out = parseTsc(readFileSync(join(FIX, 'tsc.txt'), 'utf8'));
  assert(Array.isArray(out) && out.length === 1, 'parseTsc：只回 1 筆（noise 行被濾掉）[T4]');
  const f = out[0] || {};
  assert(f.kind === 'type', 'parseTsc：kind=type [T4]');
  assert(f.severity === 'error', 'parseTsc：severity=error [T4]');
  assert(f.file === 'src/app.ts', 'parseTsc：file 對 [T4]');
  assert(f.code === 'TS2322', 'parseTsc：code=TSxxxx [T4]');
  assert(f.line === 23 && f.column === 9, 'parseTsc：line/column 對 [T4]');
  assert(
    typeof f.message === 'string' && f.message.includes('not assignable'),
    'parseTsc：message 對 [T4]',
  );
}

// ── T5 dedupeFailures：去重 + cap 截斷 ────────────────────────────────────────
{
  // T5①：file+line+code+kind 相同的兩筆 → 去重成 1
  const a = { kind: 'type', severity: 'error', file: 'src/app.ts', line: 23, code: 'TS2322', message: '第一次' };
  const b = { kind: 'type', severity: 'error', file: 'src/app.ts', line: 23, code: 'TS2322', message: '重複來源（不同 message）' };
  const r = dedupeFailures([a, b]);
  assert(
    r && Array.isArray(r.failures) && r.failures.length === 1,
    'dedupeFailures：file+line+code+kind 相同 → 去重成 1 [T5①]',
  );
  assert(r.truncated === false, 'dedupeFailures：未超 cap → truncated=false [T5①]');
}
{
  // T5②：超過 cap 的陣列 → 截到 cap 且 truncated=true（皆相異，不被去重吞掉）
  const many = Array.from({ length: 200 }, (_, i) => ({
    kind: 'lint', severity: 'error', file: `src/f${i}.ts`, line: i + 1, ruleId: 'r', message: 'm',
  }));
  const r = dedupeFailures(many, 160);
  assert(r && r.failures.length === 160, 'dedupeFailures：超過 cap → 截到 cap=160 [T5②]');
  assert(r.truncated === true, 'dedupeFailures：超過 cap → truncated=true [T5②]');
}

// ── T6 formatSummary：全綠單行 / 有 failures 的清單 ───────────────────────────
{
  // T6①：全綠 → 單行 + 綠燈語意（含 ✓）
  const green = {
    ok: true,
    status: 'passed',
    counts: { test: 0, lint: 0, type: 0, total: 0 },
    gates: { test: 'passed', lint: 'passed', type: 'passed' },
    failures: [],
    truncated: false,
  };
  const s = formatSummary(green);
  assert(
    typeof s === 'string' && s.trim().split('\n').length === 1,
    'formatSummary：全綠回單行 [T6①]',
  );
  assert(typeof s === 'string' && s.includes('✓'), 'formatSummary：全綠含 ✓ 綠燈語意 [T6①]');
}
{
  // T6②：有 failures → 含各 kind 計數 + 至少一筆 file:line 清單行
  const red = {
    ok: false,
    status: 'failed',
    counts: { test: 1, lint: 1, type: 1, total: 3 },
    gates: { test: 'failed', lint: 'failed', type: 'failed' },
    failures: [
      { kind: 'test', severity: 'error', file: 'src/math.test.ts', line: 9, message: 'x' },
      { kind: 'lint', severity: 'error', file: 'src/util.ts', line: 12, ruleId: 'no-unused-vars', message: 'y' },
      { kind: 'type', severity: 'error', file: 'src/app.ts', line: 23, code: 'TS2322', message: 'z' },
    ],
    truncated: false,
  };
  const s = formatSummary(red);
  assert(
    typeof s === 'string' && /test/i.test(s) && /lint/i.test(s) && /type/i.test(s),
    'formatSummary：含各 kind 計數標籤 [T6②]',
  );
  assert(
    typeof s === 'string' &&
      (s.includes('src/math.test.ts:9') || s.includes('src/util.ts:12') || s.includes('src/app.ts:23')),
    'formatSummary：含 file:line 樣式清單行 [T6②]',
  );
}

// ── T-win runCommand：跨平台 shell（Windows 不可對 .cmd shim 噴 EINVAL）────────
// regression：真實 smoke 發現 runCommand 在 Windows 對 .cmd shim（npm/npx/tsc/eslint）
// 會 spawn EINVAL。下面用真實子行程（非 mock）抓這條：修好前會 throw/非 0 → 紅。
await (async () => {
  // [T-win] npm 在 Windows 是 .cmd shim；pre-fix 的 runCommand 會 spawn EINVAL/throw
  let r1;
  try {
    r1 = await runCommand('npm --version', { cwd: process.cwd() });
  } catch (e) {
    r1 = { code: -1, output: `THREW: ${(e && e.message) || e}` };
  }
  assert(r1 && r1.code === 0, 'runCommand：npm --version code===0（.cmd shim 可跑、不丟例外）[T-win]');
  assert(
    r1 && typeof r1.output === 'string' && /\d+\.\d+\.\d+/.test(r1.output),
    'runCommand：output 配對 npm 版號 /\\d+\\.\\d+\\.\\d+/ [T-win]',
  );

  // [T-win] node 直跑：驗子行程 stdout 確實合併進 output
  let r2;
  try {
    r2 = await runCommand('node -e "process.stdout.write(\'rc-ok\')"', { cwd: process.cwd() });
  } catch (e) {
    r2 = { code: -1, output: `THREW: ${(e && e.message) || e}` };
  }
  assert(
    r2 && typeof r2.output === 'string' && r2.output.includes('rc-ok'),
    'runCommand：output 含子行程 stdout "rc-ok" [T-win]',
  );
})();

// ── 摘要 + exit code ─────────────────────────────────────────────────────────
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
