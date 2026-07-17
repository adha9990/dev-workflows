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
import { spawnSync } from 'node:child_process';

import {
  resolveConfig,
  parseConfig,
  parseVitest,
  parseEslint,
  parseTsc,
  dedupeFailures,
  formatSummary,
  appendToolFlags,
  runCommand,
  classifyGate,
  buildResult,
} from './loops-quality-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'quality-gate');
// 端到端 smoke 真跑的腳本絕對路徑（與本檔同目錄的待實作腳本）
const SCRIPT = fileURLToPath(new URL('./loops-quality-gate.mjs', import.meta.url));

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

// ── T3/C10 parseEslint：error+warning 分流、乾淨檔（messages:[]）不入列 ─────────
{
  const out = parseEslint(readFileSync(join(FIX, 'eslint.json'), 'utf8'));
  // util.ts 有 1 error + 1 warning 入列；clean.ts（messages:[]）不貢獻 → 共 2
  assert(
    Array.isArray(out) && out.length === 2,
    'parseEslint：error+warning 各一、乾淨檔不入列（共 2）[T3/C10]',
  );
  const err = out.find((f) => f.severity === 'error') || {};
  assert(err.kind === 'lint', 'parseEslint：error kind=lint [T3]');
  assert(err.file === 'C:/repo/src/util.ts', 'parseEslint：error file=filePath [T3]');
  assert(err.ruleId === 'no-unused-vars', 'parseEslint：error ruleId 對 [T3]');
  assert(err.line === 12 && err.column === 7, 'parseEslint：error line/column 對 [T3]');
  assert(
    typeof err.message === 'string' && err.message.includes("'foo' is defined but never used."),
    'parseEslint：error message 對 [T3]',
  );
  const warn = out.find((f) => f.severity === 'warning') || {};
  assert(warn.severity === 'warning', 'parseEslint：severity 1 → warning [T3/C10]');
  assert(warn.ruleId === 'eqeqeq', 'parseEslint：warning ruleId 對 [T3/C10]');
}

// ── T4/C10 parseTsc：多筆 error + warning 分流，noise 行濾掉 ──────────────────
{
  const out = parseTsc(readFileSync(join(FIX, 'tsc.txt'), 'utf8'));
  // 2 個 error TS + 1 個 warning TS；preamble / "Found 2 errors." 等 noise 被濾掉 → 共 3
  assert(
    Array.isArray(out) && out.length === 3,
    'parseTsc：2 error + 1 warning（noise 濾掉、共 3）[T4/C10]',
  );
  const e = out.find((f) => f.code === 'TS2322') || {};
  assert(e.kind === 'type', 'parseTsc：kind=type [T4]');
  assert(e.severity === 'error', 'parseTsc：error severity=error [T4]');
  assert(e.file === 'src/app.ts', 'parseTsc：file 對 [T4]');
  assert(e.line === 23 && e.column === 9, 'parseTsc：line/column 對 [T4]');
  assert(
    typeof e.message === 'string' && e.message.includes('not assignable'),
    'parseTsc：message 對 [T4]',
  );
  const w = out.find((f) => f.code === 'TS6133') || {};
  assert(w.severity === 'warning', 'parseTsc：warning TS → severity=warning [T4/C10]');
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
  // F5：三條 file:line 都要在清單裡（不再用 || 放水，逐筆驗）
  assert(typeof s === 'string' && s.includes('src/math.test.ts:9'), 'formatSummary：清單含 test 的 file:line [T6②/F5]');
  assert(typeof s === 'string' && s.includes('src/util.ts:12'), 'formatSummary：清單含 lint 的 file:line [T6②/F5]');
  assert(typeof s === 'string' && s.includes('src/app.ts:23'), 'formatSummary：清單含 type 的 file:line [T6②/F5]');
}

// ── C2 classifyGate：gate 狀態判定（工具掛了不可報綠）──────────────────────────
{
  const errFail = { kind: 'test', severity: 'error', file: 'a', line: 1, message: 'boom' };
  const warnOnly = { kind: 'lint', severity: 'warning', file: 'b', line: 2, message: 'meh' };
  assert(
    classifyGate({ ran: false, code: 0, failures: [] }) === 'not-run',
    'classifyGate：ran=false → not-run [C2]',
  );
  assert(
    classifyGate({ ran: true, code: 1, failures: [errFail] }) === 'failed',
    'classifyGate：ran + error failure → failed [C2]',
  );
  assert(
    classifyGate({ ran: true, code: 1, failures: [] }) === 'errored',
    'classifyGate：ran + code=1 + 空 failures → errored（工具掛了不報綠）[C2]',
  );
  assert(
    classifyGate({ ran: true, code: 0, failures: [] }) === 'passed',
    'classifyGate：ran + code=0 → passed [C2]',
  );
  assert(
    classifyGate({ ran: true, code: 1, failures: [warnOnly] }) === 'errored',
    'classifyGate：ran + code=1 + 只有 warning → errored（非0就不綠）[C2]',
  );
  assert(
    classifyGate({ ran: true, code: 0, failures: [warnOnly] }) === 'passed',
    'classifyGate：ran + code=0 + 只有 warning → passed [C2]',
  );
}

// ── C1 buildResult：結果組裝（gates.* 吐狀態值，不得漂回 "ok"）─────────────────
{
  const VALID = new Set(['passed', 'failed', 'not-run', 'errored']);
  const gatesValid = (r) =>
    VALID.has(r.gates.test) && VALID.has(r.gates.lint) && VALID.has(r.gates.type);

  // 三 gate 全 passed
  {
    const r = buildResult({
      test: { status: 'passed', failures: [] },
      lint: { status: 'passed', failures: [] },
      type: { status: 'passed', failures: [] },
    });
    assert(r.status === 'passed' && r.ok === true, 'buildResult：全 passed → status=passed/ok=true [C1]');
    assert(
      r.gates.test === 'passed' && r.gates.lint === 'passed' && r.gates.type === 'passed',
      'buildResult：全 passed → gates 值皆 "passed" [C1]',
    );
    assert(
      r.counts.test === 0 && r.counts.lint === 0 && r.counts.type === 0 && r.counts.total === 0,
      'buildResult：全 passed → counts 全 0 [C1]',
    );
    assert(gatesValid(r), 'buildResult：gates.* ∈ {passed,failed,not-run,errored}（不得出現 "ok"）[C1]');
  }
  // 一 gate failed → status=failed/ok=false
  {
    const r = buildResult({
      test: { status: 'failed', failures: [{ kind: 'test', severity: 'error', file: 'a', line: 1, message: 'm' }] },
      lint: { status: 'passed', failures: [] },
      type: { status: 'passed', failures: [] },
    });
    assert(r.status === 'failed' && r.ok === false, 'buildResult：一 gate failed → status=failed/ok=false [C1]');
    assert(r.gates.test === 'failed', 'buildResult：failed gate → gates.test="failed" [C1]');
    assert(r.counts.test === 1, 'buildResult：failed gate → counts.test=1 [C1]');
    assert(gatesValid(r), 'buildResult：gates.* 值合法（failed 情境）[C1]');
  }
  // 一 gate not-run 其餘 passed → status=partial 但仍 ok
  {
    const r = buildResult({
      test: { status: 'not-run', failures: [] },
      lint: { status: 'passed', failures: [] },
      type: { status: 'passed', failures: [] },
    });
    assert(r.status === 'partial' && r.ok === true, 'buildResult：一 not-run 其餘 passed → status=partial/ok=true [C1]');
    assert(r.gates.test === 'not-run', 'buildResult：not-run gate → gates.test="not-run" [C1]');
    assert(gatesValid(r), 'buildResult：gates.* 值合法（not-run 情境）[C1]');
  }
  // 一 gate errored → ok=false/status=failed
  {
    const r = buildResult({
      test: { status: 'passed', failures: [] },
      lint: { status: 'errored', failures: [] },
      type: { status: 'passed', failures: [] },
    });
    assert(r.ok === false && r.status === 'failed', 'buildResult：一 gate errored → ok=false/status=failed [C1]');
    assert(r.gates.lint === 'errored', 'buildResult：errored gate → gates.lint="errored" [C1]');
    assert(gatesValid(r), 'buildResult：gates.* 值合法（errored 情境）[C1]');
  }
}

// ── C11 dedupeFailures 反向：同 file:line 但不同 message 不可被去重 ────────────
{
  const x = { kind: 'test', severity: 'error', file: 'src/a.test.ts', line: 5, message: 'expected 1 to be 2' };
  const y = { kind: 'test', severity: 'error', file: 'src/a.test.ts', line: 5, message: 'expected 3 to be 4' };
  const r = dedupeFailures([x, y]);
  assert(
    r && Array.isArray(r.failures) && r.failures.length === 2,
    'dedupeFailures：同 file:line、無 code/ruleId、不同 message → 保留 2（identity 須含 message/column）[C11]',
  );
}

// ── C12 parser 邊界：空/非法輸入 graceful、severity 分流、全 pass → [] ──────────
{
  // 刻意 graceful：空字串 / 非 JSON 不丟例外，回 []
  assert(
    Array.isArray(parseEslint('')) && parseEslint('').length === 0,
    'parseEslint("") → []（刻意 graceful）[C12]',
  );
  assert(
    Array.isArray(parseEslint('not json {{{')) && parseEslint('not json {{{').length === 0,
    'parseEslint(非JSON) → []（刻意 graceful）[C12]',
  );
  // severity:1 → warning（自成一份規格，不靠 fixture）
  const oneWarn = JSON.stringify([
    { filePath: 'w.ts', messages: [{ ruleId: 'eqeqeq', severity: 1, message: 'use ===', line: 1, column: 1 }] },
  ]);
  const w = parseEslint(oneWarn);
  assert(w.length === 1 && w[0].severity === 'warning', 'parseEslint：severity 1 → warning [C12]');

  // tsc 空字串 → []；含 warning TS 行 → severity=warning
  assert(
    Array.isArray(parseTsc('')) && parseTsc('').length === 0,
    'parseTsc("") → []（刻意 graceful）[C12]',
  );
  const tw = parseTsc("foo.ts(2,2): warning TS6133: 'x' is declared but its value is never read.");
  assert(
    tw.length === 1 && tw[0].severity === 'warning',
    'parseTsc：warning TS 行 → severity=warning [C12]',
  );

  // vitest 全 pass → []
  const green = parseVitest(readFileSync(join(FIX, 'vitest-green.json'), 'utf8'));
  assert(Array.isArray(green) && green.length === 0, 'parseVitest(全 pass json) → [] [C10/C12]');
}

// ── C3 lint 不截斷假綠：合法但 > tail 上限（>80000 字）的 eslint JSON 仍解得出 error ──
{
  const msgs = [{ ruleId: 'no-debugger', severity: 2, message: 'Unexpected debugger statement.', line: 1, column: 1 }];
  for (let i = 0; i < 1500; i++) {
    msgs.push({
      ruleId: 'max-len',
      severity: 1,
      message: `This line exceeds the maximum allowed length budget at occurrence number ${i}.`,
      line: i + 2,
      column: 1,
    });
  }
  const bigRaw = JSON.stringify([{ filePath: 'src/huge.ts', messages: msgs, errorCount: 1, warningCount: 1500 }]);
  assert(bigRaw.length > 80000, '前置：eslint JSON > 80000 字（超 tail 上限）[C3]');
  const out = parseEslint(bigRaw);
  assert(
    Array.isArray(out) &&
      out.length > 0 &&
      out.some((f) => f.severity === 'error' && f.ruleId === 'no-debugger'),
    'parseEslint：大型 JSON 仍解得出 error（不可因長度回 []）[C3]',
  );
}

// ── F1 端到端 smoke：真跑腳本，守住 main/executeGate/exit-code wiring ──────────
// 用 type gate（讀 stdout，避開 outputFile）；spawnSync 真起 node 跑 SCRIPT。
function smokeType(typeCmd) {
  const tmp = mkdtempSync(join(tmpdir(), 'qg-smoke-'));
  try {
    mkdirSync(join(tmp, '.loops'), { recursive: true });
    writeFileSync(join(tmp, '.loops', 'gate.config.json'), JSON.stringify({ type: typeCmd }), 'utf8');
    const res = spawnSync('node', [SCRIPT, '--cwd', tmp, '--gates', 'type', '--json'], { encoding: 'utf8' });
    let json = null;
    try { json = JSON.parse(res.stdout); } catch { json = null; }
    return { res, json };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
{
  // F1a：type 指令印一行 tsc 錯 → 腳本 exit 1、gates.type=failed、failures 含該筆
  const { res, json } = smokeType(`node -e "console.log('src/x.ts(1,1): error TS9999: boom')"`);
  assert(res.error == null, 'F1a：node 啟動成功（spawn 無 error）[F1]');
  assert(res.status === 1, 'F1a：type gate 失敗 → 腳本 exit code===1 [F1]');
  assert(json && json.gates && json.gates.type === 'failed', 'F1a：stdout JSON gates.type==="failed" [F1]');
  assert(
    json && Array.isArray(json.failures) &&
      json.failures.some((f) => f.code === 'TS9999' && typeof f.message === 'string' && f.message.includes('boom')),
    'F1a：failures 含該 TS9999 boom 筆 [F1]',
  );
}
{
  // F1b：type 全綠（無輸出 exit0）→ 腳本 exit 0、gates.type=passed、status=partial（只 type 跑）
  const { res, json } = smokeType('node -e ""');
  assert(res.error == null, 'F1b：node 啟動成功 [F1]');
  assert(res.status === 0, 'F1b：type gate 全綠 → 腳本 exit code===0 [F1]');
  assert(json && json.gates && json.gates.type === 'passed', 'F1b：gates.type==="passed" [F1]');
  assert(json && json.status === 'partial', 'F1b：只 type 跑（test/lint not-run）→ status==="partial" [F1]');
}
{
  // F1c：type 工具非 0 退出但解不出錯 → 腳本 exit 1、gates.type=errored、ok=false
  const { res, json } = smokeType('node -e "process.exit(2)"');
  assert(res.error == null, 'F1c：node 啟動成功 [F1]');
  assert(res.status === 1, 'F1c：type errored → 腳本 exit code===1 [F1]');
  assert(json && json.gates && json.gates.type === 'errored', 'F1c：gates.type==="errored" [F1]');
  assert(json && json.ok === false, 'F1c：errored → ok===false [F1]');
}

// ── F4 parseConfig 邊界：graceful 是刻意契約（壞輸入不丟例外）──────────────────
{
  const call = (fn) => {
    try { return { threw: false, val: fn() }; } catch (e) { return { threw: true, err: e }; }
  };
  const nullish = (v) => v === null || v === undefined;

  // 壞 JSON 字串 → 不丟例外、三鍵皆 null（或 {} → 取值 nullish）
  const bad = call(() => parseConfig('{ not valid json'));
  assert(!bad.threw, 'parseConfig(壞 JSON) 不丟例外（graceful 契約）[F4]');
  assert(
    !bad.threw && bad.val && nullish(bad.val.test) && nullish(bad.val.lint) && nullish(bad.val.type),
    'parseConfig(壞 JSON) → 三鍵皆 null [F4]',
  );

  // 非物件 JSON（如 123）→ 同
  const nonObj = call(() => parseConfig('123'));
  assert(!nonObj.threw, 'parseConfig(非物件 JSON) 不丟例外 [F4]');
  assert(
    !nonObj.threw && nonObj.val && nullish(nonObj.val.test) && nullish(nonObj.val.lint) && nullish(nonObj.val.type),
    'parseConfig(非物件 JSON 123) → 三鍵皆 null [F4]',
  );

  // 某鍵空字串 / 非字串 → 該鍵 null、其餘合法鍵保留
  const mixed = call(() => parseConfig(JSON.stringify({ test: 'vitest run', lint: '', type: 42 })));
  assert(!mixed.threw, 'parseConfig(部分鍵非法) 不丟例外 [F4]');
  assert(!mixed.threw && mixed.val && mixed.val.test === 'vitest run', 'parseConfig：合法鍵保留 [F4]');
  assert(!mixed.threw && mixed.val && nullish(mixed.val.lint), 'parseConfig：空字串鍵 → null [F4]');
  assert(!mixed.threw && mixed.val && nullish(mixed.val.type), 'parseConfig：非字串鍵 → null [F4]');
}

// ── F3 appendToolFlags：lint flag 轉發（npm script 放 -- 後、npx/binary 直接附加）─
{
  // npm/pnpm/yarn run script → flags 必須在 "--" 之後
  const out1 = appendToolFlags('npm run lint', ['-f', 'json']);
  assert(typeof out1 === 'string', 'appendToolFlags：npm 回字串 [F3]');
  const sep = typeof out1 === 'string' ? out1.indexOf(' -- ') : -1;
  assert(sep !== -1, 'appendToolFlags：npm run script 插入 "--" 分隔 [F3]');
  assert(
    sep !== -1 && out1.indexOf('-f', sep) > sep && out1.includes('json'),
    'appendToolFlags：npm run → -f json 在 "--" 之後 [F3]',
  );

  // npx / 直接 binary → 直接附加，無 "--"
  const out2 = appendToolFlags('npx eslint .', ['-f', 'json']);
  assert(typeof out2 === 'string' && out2.startsWith('npx eslint .'), 'appendToolFlags：npx 保留原指令 [F3]');
  assert(typeof out2 === 'string' && out2.includes('-f') && out2.includes('json'), 'appendToolFlags：npx 附加 -f json [F3]');
  assert(typeof out2 === 'string' && !out2.includes(' -- '), 'appendToolFlags：npx/binary 不插入 "--" [F3]');
}

// ── G helper：通用 e2e 跑法（tmp cwd + 可選 config/檔案 + 真跑腳本 + parse --json）─
const FAKE = fileURLToPath(new URL('./fixtures/quality-gate/fake-reporter.mjs', import.meta.url));
function runGate({ config = null, files = {}, gates, args = [], env = {} } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'qg-e2e-'));
  try {
    if (config) {
      mkdirSync(join(tmp, '.loops'), { recursive: true });
      writeFileSync(join(tmp, '.loops', 'gate.config.json'), JSON.stringify(config), 'utf8');
    }
    for (const [name, content] of Object.entries(files)) {
      const p = join(tmp, name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, 'utf8');
    }
    const res = spawnSync(
      'node',
      [SCRIPT, '--cwd', tmp, '--gates', gates, ...args, '--json'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env } },
    );
    let json = null;
    try { json = JSON.parse(res.stdout); } catch { json = null; }
    return { res, json };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
// 大型 eslint JSON（error 在最前、總長 > 80000 字）—— 給 G1
// 長度上限約束：內容經 FAKE_OUT 環境變數傳給子行程——Linux 單一 env 字串上限 MAX_ARG_STRLEN=131072，
// 超過會 execve E2BIG（spawn error）；Windows 無此限制，故本機綠、CI ubuntu 紅（#129 CI 首跑實抓）。
// 取 800 筆 ≈ 99K：仍超 tail 上限（>80000）、又安全低於 128KB。G1 有上下界雙斷言守住。
function bigEslintErrorFirst() {
  const msgs = [{ ruleId: 'no-debugger', severity: 2, message: 'Unexpected debugger statement.', line: 1, column: 1 }];
  for (let i = 0; i < 800; i++) {
    msgs.push({ ruleId: 'max-len', severity: 1, message: `This over-length line is occurrence number ${i} of many.`, line: i + 2, column: 1 });
  }
  return JSON.stringify([{ filePath: 'src/huge.ts', messages: msgs, errorCount: 1, warningCount: 800 }]);
}
// 含 1 失敗的 vitest JSON —— 給 G2/G3
function failingVitestJson() {
  return JSON.stringify({
    numTotalTests: 1,
    numFailedTests: 1,
    success: false,
    testResults: [
      {
        name: 'C:/repo/src/d.test.ts',
        status: 'failed',
        assertionResults: [
          { ancestorTitles: ['d'], title: '會壞', fullName: 'd 會壞', status: 'failed', failureMessages: ['AssertionError: nope-1234'], location: { line: 2, column: 1 } },
        ],
      },
    ],
  });
}

// ── G1 lint outFile 路徑端到端（守 P1）：大型 JSON 的開頭 error 不可被 tail 截掉 ──
{
  const big = bigEslintErrorFirst();
  assert(big.length > 80000, 'G1 前置：eslint JSON > 80000 字（超 tail 上限）[G1]');
  assert(big.length < 131072, 'G1 前置：eslint JSON < 131072 字（Linux env 單字串上限，防 E2BIG）[G1]');
  const { res, json } = runGate({
    config: { lint: `node "${FAKE}"` },
    gates: 'lint',
    env: { FAKE_OUT: big, FAKE_EXIT: '1' },
  });
  assert(res.error == null, 'G1：node 啟動成功（spawn 無 error）[G1]');
  assert(json && json.gates && json.gates.lint === 'failed', 'G1：gates.lint==="failed" [G1]');
  assert(
    json && Array.isArray(json.failures) &&
      json.failures.some((f) => f.kind === 'lint' && f.severity === 'error' && f.ruleId === 'no-debugger'),
    'G1：failures 含最前面的 error（走 outFile 讀完整、開頭沒被 tail 截掉）[G1]',
  );
}

// ── G2 自動偵測層端到端（守 P1）─────────────────────────────────────────────
{
  // 不寫 gate.config.json，靠 package.json scripts.test 被偵測
  const { res, json } = runGate({
    files: { 'package.json': JSON.stringify({ name: 'tmp-pkg', scripts: { test: `node "${FAKE}"` } }) },
    gates: 'test',
    env: { FAKE_OUT: failingVitestJson() },
  });
  assert(res.error == null, 'G2：node 啟動成功 [G2]');
  assert(json && json.gates && json.gates.test === 'failed', 'G2：偵測 package.json scripts.test → gates.test==="failed" [G2]');
  assert(
    json && Array.isArray(json.failures) &&
      json.failures.some((f) => f.kind === 'test' && typeof f.message === 'string' && f.message.includes('nope-1234')),
    'G2：failures 含該失敗筆 [G2]',
  );
}
{
  // 完全空 tmp（無 config、無 package.json/tsconfig）→ 三 gate 皆 not-run、status=partial
  const { res, json } = runGate({ gates: 'test,lint,type' });
  assert(res.error == null, 'G2-empty：node 啟動成功 [G2]');
  assert(
    json && json.gates && json.gates.test === 'not-run' && json.gates.lint === 'not-run' && json.gates.type === 'not-run',
    'G2-empty：無偵測目標 → 三 gate 皆 not-run [G2]',
  );
  assert(json && json.status === 'partial', 'G2-empty：全 not-run → status==="partial" [G2]');
}

// ── G3 多 gate + continue-on-failure（守 P2）─────────────────────────────────
{
  const cfg = {
    test: `node "${FAKE}"`,
    type: `node -e "console.log('a.ts(1,1): error TS1234: boom')"`,
  };
  // ① 不帶旗標：test 失敗即短路 → type not-run、exit 1
  {
    const { res, json } = runGate({ config: cfg, gates: 'test,type', env: { FAKE_OUT: failingVitestJson() } });
    assert(json && json.gates && json.gates.test === 'failed', 'G3①：gates.test==="failed" [G3]');
    assert(json && json.gates && json.gates.type === 'not-run', 'G3①：test 失敗即短路 → gates.type==="not-run" [G3]');
    assert(res.status === 1, 'G3①：exit code===1 [G3]');
  }
  // ② 帶 --continue-on-failure：type 仍跑，failures 同時含 test 與 type
  {
    const { res, json } = runGate({ config: cfg, gates: 'test,type', args: ['--continue-on-failure'], env: { FAKE_OUT: failingVitestJson() } });
    assert(
      json && json.gates && json.gates.test === 'failed' && json.gates.type === 'failed',
      'G3②：continue → type 也有跑且 failed [G3]',
    );
    assert(
      json && Array.isArray(json.failures) &&
        json.failures.some((f) => f.kind === 'test') && json.failures.some((f) => f.kind === 'type'),
      'G3②：failures 同時含 test 與 type 兩 kind [G3]',
    );
    assert(res.status === 1, 'G3②：exit code===1 [G3]');
  }
}

// ── G4 formatSummary 分支（守 P2，純函式）───────────────────────────────────
{
  // warning-only 的 passed result：含 ✓、含 "(1 warnings)"、不含 ✗
  const warnPass = {
    ok: true,
    status: 'passed',
    counts: { test: 0, lint: 1, type: 0, total: 1 },
    gates: { test: 'passed', lint: 'passed', type: 'passed' },
    failures: [{ kind: 'lint', severity: 'warning', file: 'a.ts', line: 1, message: 'w' }],
    truncated: false,
  };
  const s = formatSummary(warnPass);
  assert(typeof s === 'string' && s.includes('✓'), 'G4：warning-only passed 含 ✓ [G4]');
  assert(typeof s === 'string' && s.includes('(1 warnings)'), 'G4：含 "(1 warnings)" [G4]');
  assert(typeof s === 'string' && !s.includes('✗'), 'G4：warning-only passed 不含 ✗ [G4]');

  // truncated:true → 含截斷提示（且與 truncated:false 輸出不同）
  const truncBase = {
    ok: false,
    status: 'failed',
    counts: { test: 1, lint: 0, type: 0, total: 1 },
    gates: { test: 'failed', lint: 'passed', type: 'passed' },
    failures: [{ kind: 'test', severity: 'error', file: 'b.ts', line: 2, message: 'm' }],
  };
  const st = formatSummary({ ...truncBase, truncated: true });
  const sf = formatSummary({ ...truncBase, truncated: false });
  assert(typeof st === 'string' && st !== sf, 'G4：truncated 旗標改變輸出（截斷提示存在）[G4]');
  assert(
    typeof st === 'string' && /truncat|截斷|省略|更多|more|\.\.\./i.test(st),
    'G4：truncated 結果含截斷提示字串 [G4]',
  );
}

// ── PT passedTests：GateResult 加性輸出「通過的 test titlePath 清單」（守 verify P1）──────
// 契約：--json GateResult 新增 passedTests:string[]＝通過 assertion 的 titlePath
//       （ancestorTitles > … > title，以 " > " 連接）。只有 test gate 會填，無 test gate → []。
//       其餘欄位不變（向後相容）。用既有 vitest fixtures 餵入，驗 positive-presence 的來源信號。
{
  // PT1：vitest.json（1 passed + 1 failed）→ passedTests 含通過那筆的 titlePath、不含失敗那筆；failures 仍含失敗那筆
  const { res, json } = runGate({
    config: { test: `node "${FAKE}"` },
    gates: 'test',
    env: { FAKE_OUT: readFileSync(join(FIX, 'vitest.json'), 'utf8'), FAKE_EXIT: '1' },
  });
  assert(res.error == null, 'PT1：node 啟動成功（spawn 無 error）[PT]');
  assert(json && json.gates && json.gates.test === 'failed', 'PT1：含失敗 assertion → gates.test==="failed" [PT]');
  assert(
    json && Array.isArray(json.passedTests) && json.passedTests.includes('add > 回傳兩數之和'),
    'PT1：passedTests 含通過 assertion 的 titlePath "add > 回傳兩數之和" [PT]',
  );
  assert(
    json && Array.isArray(json.passedTests) && !json.passedTests.includes('add > 處理負數相加'),
    'PT1：passedTests 不含失敗 assertion 的 titlePath（只收通過）[PT]',
  );
  assert(
    json && Array.isArray(json.failures) &&
      json.failures.some((f) => f.kind === 'test' && typeof f.message === 'string' && f.message.includes('expected -1 to be 1')),
    'PT1：failures 仍含失敗 assertion（加性、不破壞既有）[PT]',
  );
}
{
  // PT2：vitest-green.json（全綠）→ passedTests 含兩筆通過 titlePath、failures 空
  const { res, json } = runGate({
    config: { test: `node "${FAKE}"` },
    gates: 'test',
    env: { FAKE_OUT: readFileSync(join(FIX, 'vitest-green.json'), 'utf8'), FAKE_EXIT: '0' },
  });
  assert(res.error == null, 'PT2：node 啟動成功 [PT]');
  assert(json && json.gates && json.gates.test === 'passed', 'PT2：全綠 → gates.test==="passed" [PT]');
  assert(
    json && Array.isArray(json.passedTests) &&
      json.passedTests.includes('sum > 相加得和') && json.passedTests.includes('sum > 相減得差'),
    'PT2：passedTests 含兩筆通過 titlePath [PT]',
  );
  assert(json && Array.isArray(json.failures) && json.failures.length === 0, 'PT2：全綠 → failures 空 [PT]');
}
{
  // PT3：無 test gate（只跑 type）→ passedTests 為 []（契約：只有 test gate 會填）
  const { res, json } = smokeType('node -e ""');
  assert(res.error == null, 'PT3：node 啟動成功 [PT]');
  assert(
    json && Array.isArray(json.passedTests) && json.passedTests.length === 0,
    'PT3：無 test gate → passedTests===[]（加性欄存在且為空）[PT]',
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
