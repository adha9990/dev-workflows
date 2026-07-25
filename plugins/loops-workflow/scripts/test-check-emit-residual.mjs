#!/usr/bin/env node
// test-check-emit-residual.mjs —— check-emit-residual.mjs（#183 T13 殘留 lint）的紅綠斷言。
// 自帶極簡 harness（仿同目錄 test-codex-plugin-lint.mjs），不引測試框架。
//
// 用法（cwd 任意）：node scripts/test-check-emit-residual.mjs
// 全綠 → exit 0；任一斷言失敗 → exit 1。
//
// 要驗的不變式：
//   N1｜負向 fixture 一定被抓到：故意留三種殘留（hookSpecificOutput 字面／頂層 {decision:'…'}／
//       console.log(JSON.stringify(…))）的假 hook，必須各自產出 finding、CLI exit 1。
//       —— 這條是本 lint 的存在意義：抓不到殘留的殘留檢查是零價值的綠燈。
//   N2｜掃描範圍不得外溢：同一個 fixture 目錄裡的 test-*.mjs、hook-decision-emit.mjs、fixtures/
//       子目錄即使含 hookSpecificOutput 字面也不得被報成 finding。真實 hooks/ 底下的測試檔有大量
//       這種字面（那是零回歸位元鎖的斷言現場），掃進來的話最省事的「修法」會是拆掉那些斷言。
//   N3｜已接線的正常寫法零誤報：emitDecision(...) + console.log(decision) 的形狀不得被判違規，
//       整行註解引用舊信封字面也不得被判違規。
//   N4｜真實 hooks/ 目前全綠：CLI 對 plugins/loops-workflow/hooks 跑出 exit 0。
//   N5｜輸出契約：--json 印出可解析的 { ok, findings, summary } 且 exit code = ok ? 0 : 1。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { scanSource, shouldScanFile, buildReport } from './check-emit-residual.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const LINT_SCRIPT = join(SCRIPTS_DIR, 'check-emit-residual.mjs');
const REAL_HOOKS_DIR = join(SCRIPTS_DIR, '..', 'hooks');

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

const checksOf = (findings) => findings.map((f) => f.check);

// =============================================================================
// N1 —— 三種殘留形狀，逐一必須被抓到（純函式層）
// =============================================================================
{
  const residualEnvelope = [
    'function denyWith(reason) {',
    '  console.log(JSON.stringify({',
    "    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },",
    '  }));',
    '}',
  ].join('\n');
  const findings = scanSource('bad-deny.mjs', residualEnvelope);
  assert(checksOf(findings).includes('hook-specific-output-literal'), '[N1-1] hookSpecificOutput 手工組裝 → 報 hook-specific-output-literal');
  assert(checksOf(findings).includes('bare-console-decision'), '[N1-2] console.log(JSON.stringify(…)) → 報 bare-console-decision');
}
{
  const findings = scanSource('bad-block.mjs', "console.log(JSON.stringify({ decision: 'block', reason: String(reason) }));");
  assert(checksOf(findings).includes('top-level-decision-literal'), "[N1-3] 頂層 { decision: 'block', … } 手工組裝 → 報 top-level-decision-literal");
}
{
  const findings = scanSource('bad-multiline.mjs', ['const payload = {', "  decision: 'block',", '  reason,', '};'].join('\n'));
  assert(findings.length === 1 && findings[0].file === 'bad-multiline.mjs:2', '[N1-4] finding 指到實際出事的行號（bad-multiline.mjs:2）');
}

// =============================================================================
// N3 —— 已接線的正常寫法 / 註解說明：零誤報
// =============================================================================
{
  const wired = [
    "import { emitDecision, ACTIVE_HARNESS } from './hook-decision-emit.mjs';",
    '',
    '// 檔頭說明：本 hook 以 stdout JSON `{ "decision":"block", "reason":… }` 攔下停止。',
    '// 舊寫法是 hookSpecificOutput 手工組裝，已於 #183 T13 收斂。',
    'function denyWith(reason) {',
    "  const decision = emitDecision({ kind: 'deny', reason }, ACTIVE_HARNESS, 'PreToolUse');",
    '  if (decision !== null) console.log(decision);',
    '}',
  ].join('\n');
  assert(scanSource('good.mjs', wired).length === 0, '[N3-1] emitDecision + console.log(decision) 的已接線寫法 → 零 finding（含整行註解引用舊信封字面也不誤報）');
}
{
  assert(scanSource('good2.mjs', 'const decision = shouldContinue(state);').length === 0, '[N3-2] `const decision = …` 賦值不是物件欄位 → 不誤命中 top-level-decision-literal');
  assert(scanSource('good3.mjs', "if (decision.action === 'pass') return;").length === 0, '[N3-3] `decision.action === …` 屬性存取 → 不誤命中');
}

// =============================================================================
// N2 —— 掃描範圍：只掃 production hook
// =============================================================================
{
  assert(shouldScanFile('merge-guard.mjs') === true, '[N2-1] production hook（merge-guard.mjs）→ 掃');
  assert(shouldScanFile('test-merge-guard.mjs') === false, '[N2-2] test-*.mjs → 不掃（測試檔的 hookSpecificOutput 字面正是位元鎖的斷言現場）');
  assert(shouldScanFile('hook-decision-emit.mjs') === false, '[N2-3] hook-decision-emit.mjs 本身 → 不掃（唯一被授權組裝信封的葉節點）');
  assert(shouldScanFile('hooks.json') === false, '[N2-4] 非 .mjs → 不掃');
}

// =============================================================================
// N1/N2/N5 —— 負向 fixture 目錄：真的落檔、真的跑 CLI
// =============================================================================
const fixtureDir = mkdtempSync(join(tmpdir(), 'emit-residual-fixture-'));
try {
  const RESIDUAL_LINE =
    "  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } }));";
  writeFileSync(join(fixtureDir, 'bad-guard.mjs'), `function denyWith() {\n${RESIDUAL_LINE}\n}\n`, 'utf8');
  writeFileSync(
    join(fixtureDir, 'good-guard.mjs'),
    "import { emitDecision, ACTIVE_HARNESS } from './hook-decision-emit.mjs';\n"
      + "const decision = emitDecision({ kind: 'deny', reason: 'r' }, ACTIVE_HARNESS, 'PreToolUse');\n"
      + 'if (decision !== null) console.log(decision);\n',
    'utf8',
  );
  // 以下三者都含殘留字面，但都在掃描範圍外——任一被報成 finding 即代表範圍外溢（N2 紅旗）。
  writeFileSync(join(fixtureDir, 'test-bad-guard.mjs'), `assert(out.hookSpecificOutput.permissionDecision === 'deny');\n`, 'utf8');
  writeFileSync(join(fixtureDir, 'hook-decision-emit.mjs'), `export const shape = { hookSpecificOutput: {} };\n`, 'utf8');
  mkdirSync(join(fixtureDir, 'fixtures'));
  writeFileSync(join(fixtureDir, 'fixtures', 'sample.mjs'), `export const raw = { hookSpecificOutput: {} };\n`, 'utf8');

  const report = buildReport(fixtureDir);
  assert(report.ok === false, '[N1-5] 負向 fixture 目錄（bad-guard.mjs 留一處殘留）→ ok === false（抓得到）');
  assert(
    report.findings.length > 0 && report.findings.every((f) => f.file.startsWith('bad-guard.mjs:')),
    '[N2-5] 全部 finding 都只來自 bad-guard.mjs——test-*.mjs／hook-decision-emit.mjs／fixtures/ 皆未被掃入',
  );
  assert(report.summary.filesScanned === 2, '[N2-6] filesScanned === 2（bad-guard.mjs + good-guard.mjs，其餘排除）');

  const red = spawnSync(process.execPath, [LINT_SCRIPT, '--hooks-dir', fixtureDir, '--json'], { encoding: 'utf8' });
  assert(red.status === 1, '[N5-1] CLI 對負向 fixture → exit 1');
  let redJson = null;
  try {
    redJson = JSON.parse(red.stdout);
  } catch {
    redJson = null;
  }
  assert(redJson !== null && redJson.ok === false && Array.isArray(redJson.findings) && redJson.findings.length > 0,
    '[N5-2] --json 印出可解析的 { ok:false, findings:[…] }');
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}

// =============================================================================
// N4 —— 真實 hooks/ 目前全綠
// =============================================================================
{
  const green = spawnSync(process.execPath, [LINT_SCRIPT, '--hooks-dir', REAL_HOOKS_DIR], { encoding: 'utf8' });
  assert(green.status === 0, `[N4-1] CLI 對真實 hooks/ → exit 0（實得 ${green.status}）：${green.stdout.trim()}`);
}

const total = passed + failed.length;
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
console.log(`(共 ${total} 條斷言：N1=負向 fixture 抓得到／N2=只掃 production hook／N3=已接線寫法零誤報／N4=真實 hooks 全綠／N5=輸出契約)`);
process.exit(failed.length > 0 ? 1 : 0);
