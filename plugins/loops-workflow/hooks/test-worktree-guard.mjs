#!/usr/bin/env node
// test-worktree-guard.mjs —— worktree-guard.mjs（PreToolUse Bash deny hook）紅綠斷言
// （自帶極簡 harness，仿同目錄 test-path-guard.mjs，不引測試框架）。
//
// 用法（cwd = plugins/loops-workflow）：node hooks/test-worktree-guard.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1。
//
// 被測物契約：
//   parseLoopBranchCreation(command) → branch 名或 null：抓 `git checkout -b/-B/--branch <name>`
//     與 `git switch -c/-C/--create <name>`（會切入 branch 的建立動作）；不抓 `git branch`、`git checkout`（無 -b）。
//   isInsideWorktree(cwd) → boolean：cwd 解析後是否落在 .claude/worktrees/ 之下（段完全相等）。
//   main()（node worktree-guard.mjs，stdin 餵 {tool_input:{command},cwd}）：
//     - 主 checkout 對「已建 loop（cwd 祖先存在 .loops/<slug>/loop.md）」的 checkout -b/switch -c → deny
//       （reason 含 "git worktree add" 與 "LOOPS_WORKTREE_GUARD"），exit 0
//     - 非 loop branch / 已在 worktree / 非建立指令 → stdout 空、exit 0
//     - LOOPS_WORKTREE_GUARD='0' → 關閉、放行；'' / 未設 / 'false' → 維持啟用
//     - fail-open：stdin 非 JSON / 缺 command → 放行

import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { parseLoopBranchCreation, isInsideWorktree } from './worktree-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = join(HERE, 'worktree-guard.mjs');

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

// =============================================================================
// A) parseLoopBranchCreation(command) —— 純函式層
// =============================================================================

assert(parseLoopBranchCreation('git checkout -b 206-foo') === '206-foo',
  '[A1] git checkout -b 206-foo → "206-foo"');
assert(parseLoopBranchCreation('git checkout -b "206-foo" master') === '206-foo',
  '[A2] 帶引號 + base：git checkout -b "206-foo" master → "206-foo"');
assert(parseLoopBranchCreation('git switch -c 206-foo') === '206-foo',
  '[A3] git switch -c 206-foo → "206-foo"');
assert(parseLoopBranchCreation('git switch -C 206-foo') === '206-foo',
  '[A4] git switch -C 206-foo → "206-foo"');
assert(parseLoopBranchCreation('git -C /some/path checkout -b 206-foo') === '206-foo',
  '[A5] git -C <path> checkout -b 206-foo → "206-foo"（中間夾 flag 仍抓到）');
assert(parseLoopBranchCreation('git checkout -b 137-trash-delete-permanent origin/master') === '137-trash-delete-permanent',
  '[A6] 長 slug + 遠端 base → 抓 slug');
assert(parseLoopBranchCreation('git checkout 206-foo') === null,
  '[A7] git checkout 206-foo（無 -b）→ null（非建立）');
assert(parseLoopBranchCreation('git branch 206-foo') === null,
  '[A8] git branch 206-foo（不切入）→ null');
assert(parseLoopBranchCreation('git commit -m "feat"') === null,
  '[A9] git commit → null');
assert(parseLoopBranchCreation('echo hi && git checkout -b 206-foo') === '206-foo',
  '[A10] 複合指令 echo && git checkout -b 206-foo → 抓到（& 邊界不擋在 git 之後）');
assert(parseLoopBranchCreation('git checkout -b a; rm -rf /') === 'a',
  '[A11] git checkout -b a; ... → "a"（; 邊界後不吃進 branch 名）');
assert(parseLoopBranchCreation(null) === null, '[A12] 非字串 → null');
assert(parseLoopBranchCreation('ls -la') === null, '[A13] 非 git 指令 → null');

// isInsideWorktree
assert(isInsideWorktree('C:/r/.claude/worktrees/x') === true,
  '[A14] .claude/worktrees/x → true（在 worktree）');
assert(isInsideWorktree('C:/r/.claude/worktrees/x/client/src') === true,
  '[A15] worktree 深層 → true');
assert(isInsideWorktree('C:/r') === false, '[A16] 主 repo 根 → false');
assert(isInsideWorktree('C:/r/.claude/agents') === false,
  '[A17] .claude/agents（非 worktrees）→ false');

// =============================================================================
// B) main() —— IO 層（真 spawn，需真實 .loops/<slug>/loop.md）
// =============================================================================

const SANDBOX = join(tmpdir(), `wtg-${process.pid}`);
const MAIN_ROOT = join(SANDBOX, 'repo');       // 假主 checkout 根（含 .loops/206-foo/loop.md）
const NESTED = join(MAIN_ROOT, 'client', 'src'); // 主 checkout 深層（測 findLoopRoot 走訪祖先）
mkdirSync(join(MAIN_ROOT, '.loops', '206-foo'), { recursive: true });
writeFileSync(join(MAIN_ROOT, '.loops', '206-foo', 'loop.md'), '# Loop: 206-foo\n');
mkdirSync(NESTED, { recursive: true });

function runHook({ command, cwd, env = {}, rawInput } = {}) {
  const input = rawInput !== undefined
    ? rawInput
    : JSON.stringify({ tool_input: { command }, cwd });
  return spawnSync(process.execPath, [HOOK_SCRIPT], {
    input,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}
const stdoutOf = (res) => (typeof res.stdout === 'string' ? res.stdout : '');
const parseOut = (res) => { try { return JSON.parse(stdoutOf(res).trim()); } catch { return null; } };

try {
  // ── B1：主 checkout 對已建 loop 的 checkout -b → deny，reason 含關鍵子串 ──────────
  {
    const res = runHook({ command: 'git checkout -b 206-foo master', cwd: MAIN_ROOT, env: { LOOPS_WORKTREE_GUARD: undefined } });
    assert(res.error == null && res.status === 0, '[B1] spawn 無 error、exit 0');
    const p = parseOut(res);
    assert(p?.hookSpecificOutput?.hookEventName === 'PreToolUse', '[B1] hookEventName === "PreToolUse"');
    assert(p?.hookSpecificOutput?.permissionDecision === 'deny', '[B1] permissionDecision === "deny"');
    const reason = p?.hookSpecificOutput?.permissionDecisionReason ?? '';
    assert(reason.includes('git worktree add'), '[B1] reason 含 "git worktree add"（導向正確作法）');
    assert(reason.includes('LOOPS_WORKTREE_GUARD'), '[B1] reason 含 "LOOPS_WORKTREE_GUARD"（逃生口）');
    assert(reason.includes('206-foo'), '[B1] reason 含 slug "206-foo"');
  }

  // ── B2：findLoopRoot 走訪祖先 —— cwd 在主 checkout 深層仍 deny ──────────────────
  {
    const res = runHook({ command: 'git switch -c 206-foo', cwd: NESTED });
    assert(res.status === 0, '[B2] exit 0');
    assert(parseOut(res)?.hookSpecificOutput?.permissionDecision === 'deny',
      '[B2] cwd=主 checkout 深層（client/src）→ 走訪祖先找到 .loops/206-foo/loop.md → deny');
  }

  // ── B3：非已建 loop 的 branch → 放行 ─────────────────────────────────────────
  {
    const res = runHook({ command: 'git checkout -b some-random-branch', cwd: MAIN_ROOT });
    assert(res.status === 0, '[B3] exit 0');
    assert(stdoutOf(res).trim() === '', '[B3] branch 名無對應 .loops/<slug>/loop.md → 放行（stdout 空）');
  }

  // ── B4：已在 worktree → 放行（即使 branch 名是 loop slug）──────────────────────
  {
    const res = runHook({ command: 'git checkout -b 206-foo', cwd: 'C:/r/.claude/worktrees/206-foo' });
    assert(res.status === 0, '[B4] exit 0');
    assert(stdoutOf(res).trim() === '', '[B4] cwd 在 .claude/worktrees/ 下 → 放行（非主 checkout 違規）');
  }

  // ── B5：非 branch 建立指令 → 放行 ───────────────────────────────────────────
  {
    const res = runHook({ command: 'git status', cwd: MAIN_ROOT });
    assert(res.status === 0 && stdoutOf(res).trim() === '', '[B5] git status → 放行');
  }

  // ── B6：opt-out LOOPS_WORKTREE_GUARD='0' → 違規也放行 ────────────────────────
  {
    const res = runHook({ command: 'git checkout -b 206-foo', cwd: MAIN_ROOT, env: { LOOPS_WORKTREE_GUARD: '0' } });
    assert(res.status === 0 && stdoutOf(res).trim() === '', "[B6] LOOPS_WORKTREE_GUARD='0' → 放行");
  }

  // ── B7：'false'（非字面 '0'）→ 仍啟用 → deny ────────────────────────────────
  {
    const res = runHook({ command: 'git checkout -b 206-foo', cwd: MAIN_ROOT, env: { LOOPS_WORKTREE_GUARD: 'false' } });
    assert(parseOut(res)?.hookSpecificOutput?.permissionDecision === 'deny',
      "[B7] LOOPS_WORKTREE_GUARD='false'（非 '0'）→ 仍啟用 → deny");
  }

  // ── B8：未設 flag → 仍啟用（defaultOn）→ deny ──────────────────────────────
  {
    const env = { ...process.env };
    delete env.LOOPS_WORKTREE_GUARD;
    const res = spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: JSON.stringify({ tool_input: { command: 'git checkout -b 206-foo' }, cwd: MAIN_ROOT }),
      env, encoding: 'utf8',
    });
    assert(parseOut(res)?.hookSpecificOutput?.permissionDecision === 'deny',
      '[B8] flag 未設 → defaultOn → deny');
  }

  // ── B9：fail-open —— stdin 非 JSON → 放行 ──────────────────────────────────
  {
    const res = runHook({ rawInput: 'not { json' });
    assert(res.error == null && res.status === 0 && stdoutOf(res).trim() === '',
      '[B9] stdin 非 JSON → exit 0、stdout 空（fail-open）');
  }

  // ── B10：fail-open —— 缺 command → 放行 ────────────────────────────────────
  {
    const res = runHook({ rawInput: JSON.stringify({ tool_input: {}, cwd: MAIN_ROOT }) });
    assert(res.status === 0 && stdoutOf(res).trim() === '', '[B10] 缺 command → 放行（fail-open）');
  }

  // ── B11：opt-out ＋大 payload（256KB）→ 無 EPIPE、放行（先讀滿 stdin）─────────
  {
    const big = JSON.stringify({ tool_input: { command: 'git checkout -b 206-foo', content: 'A'.repeat(256 * 1024) }, cwd: MAIN_ROOT });
    const res = spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: big, env: { ...process.env, LOOPS_WORKTREE_GUARD: '0' }, encoding: 'utf8',
    });
    assert(res.error == null && res.status === 0 && stdoutOf(res).trim() === '',
      '[B11] opt-out＋256KB payload → 無 spawn error、放行（stdin 已讀滿）');
  }

  // =============================================================================
  // C) #130 PowerShell matcher —— hooks.json 的 PreToolUse matcher 要同時涵蓋 Bash 與 PowerShell
  // =============================================================================

  // ── C1-C3：matcher regex 斷言（紅燈載體）—— PowerShell 呼叫此 hook 目前會被 matcher 擋在門外 ──
  {
    const hooksConfig = JSON.parse(readFileSync(new URL('./hooks.json', import.meta.url), 'utf8'));
    const entry = (hooksConfig.hooks.PreToolUse || []).find((e) =>
      (e.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes('worktree-guard.mjs')));
    const matcher = entry?.matcher;
    assert(typeof matcher === 'string', '[C1] hooks.json 的 PreToolUse 找得到 worktree-guard.mjs 所在 entry 的 matcher');
    assert(new RegExp(matcher).test('Bash') === true, '[C2] matcher 對 "Bash" 仍 match（現有行為不退化）');
    assert(new RegExp(matcher).test('PowerShell') === true, '[C3] matcher 對 "PowerShell" 要 match（#130：現況必紅——matcher 目前僅 "Bash"）');
  }

  // ── C4：PowerShell payload —— 主 checkout 對已建 loop 的 checkout -b → deny ──────────────
  //        （characterization：guard 腳本本身不讀 tool_name，只要 payload 送得到就會判；
  //         #130 要修的是讓 matcher 在真實 PowerShell 呼叫時把 payload 送到這裡——見上面 C3）
  {
    const res = runHook({
      rawInput: JSON.stringify({ tool_name: 'PowerShell', tool_input: { command: 'git checkout -b 206-foo master' }, cwd: MAIN_ROOT }),
    });
    assert(res.error == null && res.status === 0, '[C4] spawn 無 error、exit 0');
    assert(parseOut(res)?.hookSpecificOutput?.permissionDecision === 'deny',
      '[C4] tool_name="PowerShell" + 主 checkout 對已建 loop 的 checkout -b → deny（現況已綠）');
  }

  // ── C5：PowerShell payload —— 乾淨指令 git status → 放行（零誤擋）────────────────────────
  {
    const res = runHook({
      rawInput: JSON.stringify({ tool_name: 'PowerShell', tool_input: { command: 'git status' }, cwd: MAIN_ROOT }),
    });
    assert(res.status === 0 && stdoutOf(res).trim() === '',
      '[C5] tool_name="PowerShell" + git status（非建立指令）→ 放行（stdout 空，零誤擋）');
  }
} finally {
  rmSync(SANDBOX, { recursive: true, force: true });
}

console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
