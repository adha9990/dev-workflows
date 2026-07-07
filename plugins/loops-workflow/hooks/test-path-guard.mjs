#!/usr/bin/env node
// test-path-guard.mjs —— loops-path-guard.mjs（PreToolUse deny hook，#85）紅綠斷言
// （自帶極簡 harness，仿同目錄 test-session-start.mjs，不引測試框架）。
//
// 用法（cwd = plugins/loops-workflow）：node hooks/test-path-guard.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1（主線用此 exit code 判紅綠）。
//
// 預期 Red：本票要新增 loops-path-guard.mjs（純函式 isWorktreeLoopsPath + IO main()）。
// 該檔目前不存在 —— 下方具名 import 會在「連結期」就因找不到模組拋例外，整個測試檔載入
// 失敗 → node 非 0 退出，這就是 TDD 的紅燈起點。實作補齊後，下方純函式斷言 + IO spawn
// 斷言才有機會逐條轉綠。
//
// 被測物契約摘要（見 issue #85 / loops-path-guard.mjs 設計）：
//   isWorktreeLoopsPath(filePath, cwd) → boolean：
//     ① 一律 path.resolve(cwd, filePath)（收合 .. / . / 重複分隔符）
//     ② 比對用字串 normalize：\ → / 且 lowercase（NTFS 大小寫不敏感）
//     ③ 以 / split 成段、每段 === 完全相等比對
//     ④ 違規 = 存在一段 === '.claude' 緊接下一段 === 'worktrees'，其後（隔 0 或多段皆可）
//        出現任一段 === '.loops'
//   main()（node loops-path-guard.mjs，stdin 餵 JSON {"tool_input":{"file_path":...},"cwd":...}）：
//     - 違規且未關閉 → stdout 一行 JSON {hookSpecificOutput:{hookEventName:"PreToolUse",
//       permissionDecision:"deny", permissionDecisionReason:"<含 $LOOPS_ROOT 與
//       LOOPS_PATH_CONTAINMENT 子串>"}}，exit 0
//     - 合法路徑 → stdout 空、exit 0
//     - env LOOPS_PATH_CONTAINMENT：只有字面 '0' 關閉；'false' / '' / 未設 → 維持啟用
//     - fail-open：stdin 非 JSON 或缺 file_path → stdout 空、exit 0
//     - cwd 來源：main 用 payload.cwd（fallback process.cwd()），不是子行程實際 cwd

import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { isWorktreeLoopsPath } from './loops-path-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = join(HERE, 'loops-path-guard.mjs'); // 真跑的 hook（IO 層 smoke）

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
// A) isWorktreeLoopsPath(filePath, cwd) —— 純函式層
// =============================================================================

// ── deny：所有應被判為違規（true）的路徑形狀 ────────────────────────────────

// D1：絕對路徑、正斜線 —— 標準違規形狀。
assert(
  isWorktreeLoopsPath('C:/x/.claude/worktrees/a/.loops/b/loop.md', 'C:/ignored') === true,
  '[A-D1] 絕對路徑（正斜線）.claude/worktrees/a/.loops/... → true（違規）',
);

// D2：反斜線路徑 —— normalize 後仍需判違規。
assert(
  isWorktreeLoopsPath('C:\\x\\.claude\\worktrees\\a\\.loops\\y.md', 'C:/ignored') === true,
  '[A-D2] 反斜線路徑 .claude\\worktrees\\a\\.loops\\y.md → true（\\ 正規化為 / 後仍違規）',
);

// D3：混合分隔符 —— 正反斜線混用仍需判違規。
assert(
  isWorktreeLoopsPath('C:/x\\.claude/worktrees\\a/.loops\\z.md', 'C:/ignored') === true,
  '[A-D3] 混合分隔符 → true（違規，分隔符混用不影響判斷）',
);

// D4：巢狀深 —— worktrees 與 .loops 之間隔多段仍違規。
assert(
  isWorktreeLoopsPath('C:/x/.claude/worktrees/a/sub/deep/.loops/z', 'C:/ignored') === true,
  '[A-D4] worktrees 與 .loops 間隔多段（sub/deep）→ true（違規，隔多段仍算）',
);

// D5：大小寫變體 1 —— .Claude / Worktrees / .Loops 大寫混入仍違規（NTFS 大小寫不敏感）。
assert(
  isWorktreeLoopsPath('C:/x/.Claude/Worktrees/X/.Loops/n.md', 'C:/ignored') === true,
  '[A-D5] 大小寫變體 .Claude/Worktrees/X/.Loops/n.md → true（lowercase 正規化後違規）',
);

// D6：大小寫變體 2 —— WORKTREES 全大寫。
assert(
  isWorktreeLoopsPath('C:/x/.claude/WORKTREES/x/.loops/y', 'C:/ignored') === true,
  '[A-D6] 大小寫變體 .claude/WORKTREES/x/.loops/y → true（違規）',
);

// D7：worktrees 後緊接 .loops，無中間段（隔 0 段）。
assert(
  isWorktreeLoopsPath('C:/x/.claude/worktrees/.loops/n', 'C:/ignored') === true,
  '[A-D7] .claude/worktrees/.loops/n（worktrees 後緊接 .loops、無中間段）→ true（隔 0 段仍違規）',
);

// D8：.loops 為路徑最終段。
assert(
  isWorktreeLoopsPath('C:/x/.claude/worktrees/x/.loops', 'C:/ignored') === true,
  '[A-D8] .../worktrees/x/.loops（.loops 為最終段）→ true（違規）',
);

// D9：重複分隔符 —— // /// // 等連續分隔符仍需正確 split 判違規。
assert(
  isWorktreeLoopsPath('C:/r/.claude//worktrees///x//.loops//n', 'C:/ignored') === true,
  '[A-D9] 重複分隔符 .claude//worktrees///x//.loops//n → true（違規，重複分隔符不影響判斷）',
);

// D10：絕對路徑內 .. 收合後仍落在 worktrees 之下。
assert(
  isWorktreeLoopsPath('C:/r/.claude/worktrees/x/../y/.loops/n', 'C:/ignored') === true,
  '[A-D10] worktrees/x/../y/.loops/n（.. 收合後＝worktrees/y/.loops/n）→ true（收合後仍違規）',
);

// D11：相對路徑 —— 以傳入的 cwd 解析後落在 worktrees/.loops 之下才違規（證明 cwd 有被用來 resolve）。
assert(
  isWorktreeLoopsPath('sub/.loops/n', 'C:/r/.claude/worktrees/x') === true,
  '[A-D11] 相對路徑 sub/.loops/n + cwd=.../worktrees/x → true（以 cwd resolve 後違規）',
);

// ── allow：所有應放行（false）的路徑形狀 ────────────────────────────────────

// A1：主 repo 的 .loops（無 .claude/worktrees 前綴）。
assert(
  isWorktreeLoopsPath('C:/repo/.loops/s/loop.md', 'C:/ignored') === false,
  '[A-A1] 主 repo .loops（無 worktrees 前綴）C:/repo/.loops/s/loop.md → false（放行）',
);

// A2：worktree 內、但不是 .loops 路徑。
assert(
  isWorktreeLoopsPath('C:/r/.claude/worktrees/x/src/a.ts', 'C:/ignored') === false,
  '[A-A2] worktree 內非 .loops（.../worktrees/x/src/a.ts）→ false（放行）',
);

// A3：.loops 存在，但不在 .claude/worktrees 底下。
assert(
  isWorktreeLoopsPath('C:/r/somewhere/.loops/x', 'C:/ignored') === false,
  '[A-A3] 非 worktrees 底下的 .loops（.../somewhere/.loops/x）→ false（放行）',
);

// A4：檔名字串含 "worktrees" / ".loops" 但非完整段（=== 完全相等比對，非 substring）。
assert(
  isWorktreeLoopsPath('C:/r/.claude/worktrees/x/my.loops.md', 'C:/ignored') === false,
  '[A-A4] 檔名 my.loops.md 含字串 ".loops" 但非完整段 → false（=== 完全相等比對，非 substring）',
);

// A5：目錄名前綴相同但非完全相等（.loopsBackup ≠ .loops）。
assert(
  isWorktreeLoopsPath('C:/r/.claude/worktrees/x/.loopsBackup/n', 'C:/ignored') === false,
  '[A-A5] 目錄名 .loopsBackup（前綴相同、非完全相等）→ false（放行）',
);

// A6：段名 loops（無點）不等於 .loops。
assert(
  isWorktreeLoopsPath('C:/r/.claude/worktrees/x/loops/n', 'C:/ignored') === false,
  '[A-A6] 段名 loops（無前導點）→ false（放行，非 .loops）',
);

// A7：絕對路徑內 .. 收合後脫離 worktrees 前綴。
assert(
  isWorktreeLoopsPath('C:/r/.claude/worktrees/x/../../legit/.loops/n', 'C:/ignored') === false,
  '[A-A7] worktrees/x/../../legit/.loops/n（.. 收合後脫離 .claude/worktrees 相鄰段）→ false（放行）',
);

// A8：鎖住「緊鄰」判準——.claude 存在但下一段不是 worktrees（verify P2 補遺；
// 不依賴 .. 收合機制、比 A7 隔離度更高的顯式守衛）。
assert(
  isWorktreeLoopsPath('C:/r/.claude/agents/.loops/n', 'C:/ignored') === false,
  '[A-A8] .claude/agents/.loops/n（.claude 下一段非 worktrees、緊鄰不成立）→ false（放行）',
);

// A9：鎖住緊鄰的另一半——worktrees 存在但不緊接在 .claude 之後（delta re-verify 補遺：
// 「.claude 之後某處出現 worktrees」的放寬 mutant 可通過 A1–A8 全部斷言，此 case 專殺它）。
assert(
  isWorktreeLoopsPath('C:/r/.claude/x/worktrees/y/.loops/n', 'C:/ignored') === false,
  '[A-A9] .claude/x/worktrees/y/.loops/n（worktrees 未緊接 .claude）→ false（放行）',
);

// =============================================================================
// B) main() —— IO 層（真 spawn node loops-path-guard.mjs，stdin 餵 JSON payload）
// =============================================================================

function runHook({ filePath, cwd = 'C:/ignored', env = {}, rawInput } = {}) {
  const input = rawInput !== undefined
    ? rawInput
    : JSON.stringify({ tool_input: { file_path: filePath }, cwd });
  const mergedEnv = { ...process.env, ...env };
  return spawnSync(process.execPath, [HOOK_SCRIPT], {
    input,
    env: mergedEnv,
    encoding: 'utf8',
  });
}

const stdoutOf = (res) => (typeof res.stdout === 'string' ? res.stdout : '');

// ── B1：違規路徑、未關閉 containment → deny JSON，reason 含關鍵子串，exit 0 ─────
{
  const res = runHook({
    filePath: 'C:/x/.claude/worktrees/a/.loops/b/loop.md',
    cwd: 'C:/ignored',
    env: { LOOPS_PATH_CONTAINMENT: undefined },
  });
  assert(res.error == null, '[B1] spawn 無 error（node 啟動成功）');
  assert(res.status === 0, '[B1] exit 0');
  let parsed = null;
  try { parsed = JSON.parse(stdoutOf(res).trim()); } catch { /* leave null */ }
  assert(parsed !== null, '[B1] stdout 可解析為 JSON');
  assert(
    parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.hookEventName === 'PreToolUse',
    '[B1] hookSpecificOutput.hookEventName === "PreToolUse"',
  );
  assert(
    parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision === 'deny',
    '[B1] hookSpecificOutput.permissionDecision === "deny"',
  );
  const reason = parsed && parsed.hookSpecificOutput ? parsed.hookSpecificOutput.permissionDecisionReason : '';
  assert(typeof reason === 'string' && reason.includes('$LOOPS_ROOT'),
    '[B1] permissionDecisionReason 含子串 "$LOOPS_ROOT"');
  assert(typeof reason === 'string' && reason.includes('LOOPS_PATH_CONTAINMENT'),
    '[B1] permissionDecisionReason 含子串 "LOOPS_PATH_CONTAINMENT"');
}

// ── B2：合法路徑 → stdout 空、exit 0 ──────────────────────────────────────────
{
  const res = runHook({ filePath: 'C:/repo/.loops/s/loop.md', cwd: 'C:/ignored' });
  assert(res.error == null, '[B2] spawn 無 error');
  assert(res.status === 0, '[B2] exit 0');
  assert(stdoutOf(res).trim() === '', '[B2] 合法路徑 → stdout 空（不 deny）');
}

// ── B3：LOOPS_PATH_CONTAINMENT='0' → 關閉，違規路徑也放行（stdout 空、exit 0）───
{
  const res = runHook({
    filePath: 'C:/x/.claude/worktrees/a/.loops/b/loop.md',
    cwd: 'C:/ignored',
    env: { LOOPS_PATH_CONTAINMENT: '0' },
  });
  assert(res.error == null, "[B3] spawn 無 error（containment='0'）");
  assert(res.status === 0, "[B3] exit 0（containment='0'）");
  assert(stdoutOf(res).trim() === '', "[B3] LOOPS_PATH_CONTAINMENT='0' → 違規路徑也放行（stdout 空）");
}

// ── B4：LOOPS_PATH_CONTAINMENT='false' → 仍視為啟用 → 違規路徑照樣 deny ────────
{
  const res = runHook({
    filePath: 'C:/x/.claude/worktrees/a/.loops/b/loop.md',
    cwd: 'C:/ignored',
    env: { LOOPS_PATH_CONTAINMENT: 'false' },
  });
  assert(res.status === 0, "[B4] exit 0（containment='false'）");
  let parsed = null;
  try { parsed = JSON.parse(stdoutOf(res).trim()); } catch { /* leave null */ }
  assert(
    parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision === 'deny',
    "[B4] LOOPS_PATH_CONTAINMENT='false'（非字面 '0'）→ 仍啟用 → 違規照樣 deny",
  );
}

// ── B5：LOOPS_PATH_CONTAINMENT='' → 仍視為啟用 → 違規路徑照樣 deny ─────────────
{
  const res = runHook({
    filePath: 'C:/x/.claude/worktrees/a/.loops/b/loop.md',
    cwd: 'C:/ignored',
    env: { LOOPS_PATH_CONTAINMENT: '' },
  });
  assert(res.status === 0, "[B5] exit 0（containment=''）");
  let parsed = null;
  try { parsed = JSON.parse(stdoutOf(res).trim()); } catch { /* leave null */ }
  assert(
    parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision === 'deny',
    "[B5] LOOPS_PATH_CONTAINMENT=''（空字串，非字面 '0'）→ 仍啟用 → 違規照樣 deny",
  );
}

// ── B6：LOOPS_PATH_CONTAINMENT 未設 → 仍視為啟用 → 違規路徑照樣 deny ──────────
{
  const env = { ...process.env };
  delete env.LOOPS_PATH_CONTAINMENT;
  const res = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify({
      tool_input: { file_path: 'C:/x/.claude/worktrees/a/.loops/b/loop.md' },
      cwd: 'C:/ignored',
    }),
    env,
    encoding: 'utf8',
  });
  assert(res.status === 0, '[B6] exit 0（containment 未設）');
  let parsed = null;
  try { parsed = JSON.parse(stdoutOf(res).trim()); } catch { /* leave null */ }
  assert(
    parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision === 'deny',
    '[B6] LOOPS_PATH_CONTAINMENT 未設（環境變數完全不存在）→ 仍啟用 → 違規照樣 deny',
  );
}

// ── B7：fail-open —— stdin 非 JSON → stdout 空、exit 0（不拋、不 deny）────────
{
  const res = runHook({ rawInput: 'this is not { json' });
  assert(res.error == null, '[B7] spawn 無 error（壞 JSON 不崩子行程）');
  assert(res.status === 0, '[B7] stdin 非 JSON → exit 0（fail-open）');
  assert(stdoutOf(res).trim() === '', '[B7] stdin 非 JSON → stdout 空（fail-open，不 deny）');
}

// ── B8：fail-open —— payload 缺 tool_input.file_path → stdout 空、exit 0 ──────
{
  const res = runHook({ rawInput: JSON.stringify({ tool_input: {}, cwd: 'C:/x' }) });
  assert(res.error == null, '[B8] spawn 無 error（缺 file_path 不崩子行程）');
  assert(res.status === 0, '[B8] payload 缺 file_path → exit 0（fail-open）');
  assert(stdoutOf(res).trim() === '', '[B8] payload 缺 file_path → stdout 空（fail-open，不 deny）');
}

// ── B9：cwd 來源 —— main 用 payload.cwd（非子行程實際 cwd）判斷違規 ───────────
//     子行程實際 cwd 設為系統暫存目錄（真實存在、不含 .claude/worktrees 前綴，故若誤用
//     子行程 cwd 會判為放行）；payload.cwd 另指向 .claude/worktrees/x（僅字串運算，
//     不需真實存在）。file_path 為相對路徑，若以 payload.cwd 解析則落在 .loops 之下 → deny；
//     若誤用子行程 cwd 解析則放行。斷言 deny，證明採用 payload.cwd。
{
  const spawnCwd = tmpdir(); // 真實存在的暫存目錄，不含 .claude/worktrees 前綴
  const payloadCwd = 'C:/r/.claude/worktrees/x'; // 僅供字串 resolve，不需真實存在
  const res = spawnSync(process.execPath, [HOOK_SCRIPT], {
    cwd: spawnCwd,
    input: JSON.stringify({ tool_input: { file_path: 'sub/.loops/n' }, cwd: payloadCwd }),
    env: { ...process.env, LOOPS_PATH_CONTAINMENT: undefined },
    encoding: 'utf8',
  });
  assert(res.error == null, '[B9] spawn 無 error（子行程 cwd 與 payload.cwd 不同）');
  assert(res.status === 0, '[B9] exit 0');
  let parsed = null;
  try { parsed = JSON.parse(stdoutOf(res).trim()); } catch { /* leave null */ }
  assert(
    parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision === 'deny',
    '[B9] main() 以 payload.cwd（.../worktrees/x）resolve 相對路徑 → deny（證明非採子行程實際 cwd，否則會放行）',
  );
}

// ── B10：cwd fallback —— payload 缺 cwd 鍵（或非字串）時 main 用子行程 process.cwd()
//     （verify P2 補遺：此 fallback 分支原本零覆蓋）。子行程實際 cwd 設為暫存目錄下的
//     假 worktree 結構（真實建立），file_path 為相對路徑 → 以 fallback cwd 解析後違規 → deny。──
{
  const fakeWtCwd = join(tmpdir(), `lpg-b10-${process.pid}`, '.claude', 'worktrees', 'w');
  mkdirSync(fakeWtCwd, { recursive: true });
  try {
    for (const badCwdPayload of [
      { tool_input: { file_path: '.loops/n' } },            // 無 cwd 鍵
      { tool_input: { file_path: '.loops/n' }, cwd: 123 },  // cwd 非字串
    ]) {
      const res = spawnSync(process.execPath, [HOOK_SCRIPT], {
        cwd: fakeWtCwd,
        input: JSON.stringify(badCwdPayload),
        env: { ...process.env, LOOPS_PATH_CONTAINMENT: undefined },
        encoding: 'utf8',
      });
      assert(res.status === 0, `[B10] exit 0（cwd=${JSON.stringify(badCwdPayload.cwd)}）`);
      let parsed = null;
      try { parsed = JSON.parse(stdoutOf(res).trim()); } catch { /* leave null */ }
      assert(
        parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision === 'deny',
        `[B10] payload cwd 缺/非字串 → fallback 子行程 cwd（假 worktree 下）resolve 相對路徑 → deny`,
      );
    }
  } finally {
    rmSync(join(tmpdir(), `lpg-b10-${process.pid}`), { recursive: true, force: true });
  }
}

// ── B11（GUARD，verify P1 回歸）：opt-out（env='0'）＋大 payload（256KB）——
//     main 須先讀滿 stdin 再 return，否則子行程提前關 pipe、父行程寫入 EPIPE/EOF
//     （原實作 env 檢查在 readStdin 前，≥64KB 必炸 res.error；此 case 鎖住修正後順序）。──
{
  const big = JSON.stringify({
    tool_input: { file_path: 'x/.claude/worktrees/a/.loops/y', content: 'A'.repeat(256 * 1024) },
    cwd: 'C:/ignored',
  });
  const res = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: big,
    env: { ...process.env, LOOPS_PATH_CONTAINMENT: '0' },
    encoding: 'utf8',
  });
  assert(res.error == null, '[B11] opt-out＋256KB payload → 無 spawn error（stdin 已讀滿、無 EPIPE/EOF）');
  assert(res.status === 0, '[B11] exit 0');
  assert(stdoutOf(res).trim() === '', '[B11] stdout 空（opt-out 放行）');
}

// ── 摘要 + exit code ─────────────────────────────────────────────────────────
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
