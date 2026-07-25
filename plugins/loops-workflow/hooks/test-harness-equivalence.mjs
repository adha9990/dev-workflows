#!/usr/bin/env node
// test-harness-equivalence.mjs —— T32（issue #183）：兩平台等價判定 contract test。
// 同一件事用 Claude／Codex 兩種平台形狀的 payload 表達，經 hook-input-normalize.mjs 正規化後，
// merge-guard.mjs 與 pr-gate.mjs 是否產生相同的 decision（deny/allow）與同類的 reason；並用一組
// 語意真的不同的 payload 反向驗證本檔真的有鑑別力（不是正反都同判定的假綠測試）。
// 自帶極簡 harness（`let passed=0; const failed=[]`），仿同目錄 test-merge-guard.mjs / test-pr-gate.mjs
// 的 tmp sandbox 模式，不引測試框架。
//
// 用法（cwd = plugins/loops-workflow）：node hooks/test-harness-equivalence.mjs
// 全綠 → exit 0；任一斷言失敗 → exit 1。
//
// ============================================================================
// 誠實標記（必讀——本檔混用兩種不同確定性的斷言，讀者需要能分清，不得混為一談）：
// ============================================================================
//   ①「normalizer 對這個形狀有實測」＝真：hooks/hook-input-normalize.mjs 的 normalize() 是靜態
//      import、直接呼叫（白箱）；merge-guard.mjs／pr-gate.mjs 兩支 hook 本體是用 spawnSync 真跑
//      （黑箱，真的過 stdin → stdout 這條 IO 邊界）。兩者都不是 mock、不是猜測。
//   ②「這個形狀忠於真機」＝**未量測**：本檔用來代表 Codex 的 payload 形狀（shell 的
//      `{tool_name:'Bash', tool_input:{command}}`、檔案編輯的 apply_patch patch 文字）取自官方文件
//      （learn.chatgpt.com/docs/hooks）與 issue #183 baseline 已彙整的證據——見
//      `plugins/loops-workflow/evals/baseline/codex/gaps.json` 的 `codex.guard.shell_apply_patch`
//      條目（status=not_measured, measurability=needs_auth，note 明寫「guard 讀特定 payload 欄位是否
//      對得上 Codex apply_patch payload 未知」）——**未經真機 Codex agent turn capture 校驗**。若真機
//      實際送出的欄位形狀與此不同，本檔的「等價」結論不成立；這是使用者已拍板「本輪不供認證」下
//      目前唯一能做的誠實邊界，不得回頭美化成「已驗證」。

import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { normalize } from './hook-input-normalize.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MERGE_GUARD_SCRIPT = join(HERE, 'merge-guard.mjs');
const PR_GATE_SCRIPT = join(HERE, 'pr-gate.mjs');

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

// ============================================================================
// 平台形狀建構子（正向對照的地基——同一件事，兩種形狀）
// ============================================================================

// Claude：一般 shell 指令走 tool_input.command（官方原生形狀）。
function claudeShellPayload(command, cwd) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd };
}

// Codex：官方文件載 shell canonical tool_name 為 "Bash"、payload 落在同一個 tool_input.command
// 欄位（見檔頭誠實標記②引用來源）——額外夾帶一個 Codex 專屬信封欄位（call_id）確認 normalize()／
// 下游 guard 對未知欄位保持穩健、不因多出的欄位改變判定（這正是「同一件事、兩種平台形狀」要驗的：
// 形狀上的差異不該讓判定分岔）。
function codexShellPayload(command, cwd) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd, call_id: 'codex-call-abc123' };
}

// Claude：檔案編輯走 tool_input.file_path（單一字串）。
function claudeEditPayload(filePath, cwd) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: filePath }, cwd };
}

// Codex：檔案編輯走 apply_patch，整份 patch 文字夾在 tool_input.command 裡（非一般 shell 指令）。
function codexApplyPatchPayload(patchText, cwd) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: patchText }, cwd };
}

const APPLY_PATCH_TEXT = [
  '*** Begin Patch',
  '*** Update File: src/foo.js',
  '@@',
  '-old line',
  '+new line',
  '*** End Patch',
].join('\n');

const stdoutOf = (res) => (typeof res.stdout === 'string' ? res.stdout : '');
const parseOut = (res) => { try { return JSON.parse(stdoutOf(res).trim()); } catch { return null; } };
const isDeny = (res) => parseOut(res)?.hookSpecificOutput?.permissionDecision === 'deny';
const reasonOf = (res) => parseOut(res)?.hookSpecificOutput?.permissionDecisionReason ?? '';
const isAllow = (res) => res.status === 0 && stdoutOf(res).trim() === '';

// ============================================================================
// Fixture 佈局（tmp sandbox，try/finally 清理，仿 test-pr-gate.mjs）
// ============================================================================
const SANDBOX = join(tmpdir(), `heq-${process.pid}`);

try {
  const NEUTRAL_CWD = join(SANDBOX, 'neutral');
  mkdirSync(NEUTRAL_CWD, { recursive: true });

  // pr-gate 用 loop fixture ①：slug=900-equiv-noverify，缺 stages/04-verify.md → 閘①必 deny。
  const NOVERIFY_ROOT = join(SANDBOX, 'pr-repo-noverify');
  const NOVERIFY_CWD = join(NOVERIFY_ROOT, '.claude', 'worktrees', '900-equiv-noverify');
  mkdirSync(join(NOVERIFY_ROOT, '.loops', '900-equiv-noverify'), { recursive: true });
  writeFileSync(join(NOVERIFY_ROOT, '.loops', '900-equiv-noverify', 'loop.md'), '# Loop\n');
  mkdirSync(NOVERIFY_CWD, { recursive: true });

  // pr-gate 用 loop fixture ②：slug=900-equiv-full，五閘全合規 → allow。
  const FULL_ROOT = join(SANDBOX, 'pr-repo-full');
  const FULL_CWD = join(FULL_ROOT, '.claude', 'worktrees', '900-equiv-full');
  mkdirSync(join(FULL_ROOT, '.loops', '900-equiv-full', 'stages'), { recursive: true });
  writeFileSync(join(FULL_ROOT, '.loops', '900-equiv-full', 'loop.md'), '# Loop\n');
  writeFileSync(join(FULL_ROOT, '.loops', '900-equiv-full', 'stages', '04-verify.md'), '# verify\n');
  mkdirSync(join(FULL_ROOT, '.loops', '900-equiv-full', 'deliverables', 'real-run'), { recursive: true });
  writeFileSync(join(FULL_ROOT, '.loops', '900-equiv-full', 'deliverables', 'real-run', 'shot.png'), 'PNGDATA');
  mkdirSync(FULL_CWD, { recursive: true });

  // spawn 邊界（黑箱真跑；env 明確控制——本機 ambient 帶 LOOPS_MERGE_GUARD=0／LOOPS_PR_OWNER_GUARD=0，
  // 不明確覆寫會讓 merge-guard 案例全部假綠成「放行」）。呼叫端一律明確傳入 cwd，不依賴模組層共用變數。
  function runGuardAt(scriptPath, payload, cwd, envOverrides = {}) {
    const mergedEnv = { ...process.env, ...envOverrides };
    if (!('LOOPS_MERGE_GUARD' in envOverrides)) mergedEnv.LOOPS_MERGE_GUARD = '1';
    if (!('LOOPS_PR_GATE' in envOverrides)) delete mergedEnv.LOOPS_PR_GATE;
    if (!('LOOPS_PR_REALRUN_GATE' in envOverrides)) delete mergedEnv.LOOPS_PR_REALRUN_GATE;
    if (!('LOOPS_PR_CONFLICT_GATE' in envOverrides)) mergedEnv.LOOPS_PR_CONFLICT_GATE = '0';
    return spawnSync(process.execPath, [scriptPath], {
      input: JSON.stringify(payload),
      cwd,
      env: mergedEnv,
      encoding: 'utf8',
    });
  }

  // ==========================================================================
  // 案例 1 —— shell 指令：Claude tool_input.command 形狀 vs Codex 形狀 → 同一判定
  // ==========================================================================

  // 1a：normalize() 白箱直測——兩種形狀正規化後 command／harness 判定各自正確（harness 本就該不同，
  // 但 command 抽出的值要一致，這是「正規化後兩邊看到同一件事」的地基）。
  {
    const cmd = 'gh pr merge 900 --squash';
    const nClaude = normalize(claudeShellPayload(cmd, NEUTRAL_CWD), {});
    const nCodex = normalize(codexShellPayload(cmd, NEUTRAL_CWD), {});
    assert(nClaude.command === cmd, '[1a-1] normalize() Claude shell 形狀：command 正確抽出');
    assert(nCodex.command === cmd, '[1a-2] normalize() Codex shell 形狀：command 正確抽出（含額外 call_id 欄位不干擾）');
    assert(nClaude.harness === 'claude', '[1a-3] normalize() 判 Claude shell 形狀 harness="claude"');
    assert(nCodex.harness === 'claude', '[1a-4] normalize() 判 Codex shell 形狀 harness="claude"（現況：shell 兩平台同形，非 apply_patch 就判 claude——見 hook-input-normalize.mjs detectHarness）');
  }

  // 1b：merge-guard 黑箱——同一條 "gh pr merge" 高風險指令，兩種形狀皆 deny、reason 同類。
  {
    const cmd = 'gh pr merge 900 --squash';
    const resClaude = runGuardAt(MERGE_GUARD_SCRIPT, claudeShellPayload(cmd, NEUTRAL_CWD), NEUTRAL_CWD);
    const resCodex = runGuardAt(MERGE_GUARD_SCRIPT, codexShellPayload(cmd, NEUTRAL_CWD), NEUTRAL_CWD);
    assert(isDeny(resClaude), '[1b-1] merge-guard：Claude shell 形狀 "gh pr merge" → deny');
    assert(isDeny(resCodex), '[1b-2] merge-guard：Codex shell 形狀 "gh pr merge" → deny（同一判定）');
    assert(reasonOf(resClaude).includes('LOOPS_MERGE_GUARD') && reasonOf(resCodex).includes('LOOPS_MERGE_GUARD'),
      '[1b-3] 兩形狀 reason 皆含逃生口字面 "LOOPS_MERGE_GUARD"（同類 reason）');
    assert(reasonOf(resClaude) === reasonOf(resCodex), '[1b-4] 兩形狀 reason 逐字相同（decision 與 reason 皆等價，非僅巧合同判定）');
  }

  // 1c：pr-gate 黑箱——同一條缺 04-verify.md 的 `gh pr create`，兩種形狀皆 deny（閘①）、reason 同類。
  {
    const cmd = 'gh pr create --draft --assignee @me --title t --body "Closes #900"';
    const resClaude = runGuardAt(PR_GATE_SCRIPT, claudeShellPayload(cmd, NOVERIFY_CWD), NOVERIFY_CWD);
    const resCodex = runGuardAt(PR_GATE_SCRIPT, codexShellPayload(cmd, NOVERIFY_CWD), NOVERIFY_CWD);
    assert(isDeny(resClaude), '[1c-1] pr-gate：Claude shell 形狀、缺 verify → deny');
    assert(isDeny(resCodex), '[1c-2] pr-gate：Codex shell 形狀、缺 verify → deny（同一判定）');
    assert(reasonOf(resClaude).includes('verify') && reasonOf(resCodex).includes('verify'),
      '[1c-3] 兩形狀 reason 皆含「verify」語意（同類 reason）');
  }

  // ==========================================================================
  // 案例 2 —— 檔案編輯：Claude tool_input.file_path vs Codex apply_patch → 同一判定
  // ==========================================================================

  // 2a：normalize() 白箱直測——兩種形狀正規化後抽出的目標檔案路徑一致（apply_patch 逐檔抽取
  // 與 file_path 單檔抽取殊途同歸），harness 判定正確分岔（file_path→claude／apply_patch→codex）。
  {
    const nClaude = normalize(claudeEditPayload('src/foo.js', NEUTRAL_CWD), {});
    const nCodex = normalize(codexApplyPatchPayload(APPLY_PATCH_TEXT, NEUTRAL_CWD), {});
    assert(JSON.stringify(nClaude.filePaths) === JSON.stringify(['src/foo.js']),
      '[2a-1] normalize() Claude file_path 形狀：filePaths=["src/foo.js"]');
    assert(JSON.stringify(nCodex.filePaths) === JSON.stringify(['src/foo.js']),
      '[2a-2] normalize() Codex apply_patch 形狀：filePaths=["src/foo.js"]（逐檔抽取與 Claude 單檔一致）');
    assert(nClaude.harness === 'claude', '[2a-3] normalize() 判 Claude file_path 形狀 harness="claude"');
    assert(nCodex.harness === 'codex', '[2a-4] normalize() 判 Codex apply_patch 形狀 harness="codex"（唯一真的分岔判定的欄位形狀）');
  }

  // 2b：merge-guard／pr-gate 黑箱——單純檔案編輯（不含任何合併／PR 相關字樣）在兩種形狀下皆放行，
  // 「同一判定」在這裡＝兩邊都不誤擋（merge-guard／pr-gate 本就只掛 Bash|PowerShell matcher，
  // 不處理檔案編輯，此案例驗證的是「兩種形狀都不會被誤判成危險指令」，非驗證 guard 有主動處理
  // 檔案編輯語意）。
  {
    const resMergeClaude = runGuardAt(MERGE_GUARD_SCRIPT, claudeEditPayload('src/foo.js', NEUTRAL_CWD), NEUTRAL_CWD);
    const resMergeCodex = runGuardAt(MERGE_GUARD_SCRIPT, codexApplyPatchPayload(APPLY_PATCH_TEXT, NEUTRAL_CWD), NEUTRAL_CWD);
    assert(isAllow(resMergeClaude), '[2b-1] merge-guard：Claude file_path 形狀（純檔案編輯）→ 放行');
    assert(isAllow(resMergeCodex), '[2b-2] merge-guard：Codex apply_patch 形狀（純檔案編輯，patch 內文無高風險字樣）→ 放行（同一判定）');

    const resPrClaude = runGuardAt(PR_GATE_SCRIPT, claudeEditPayload('src/foo.js', NEUTRAL_CWD), NEUTRAL_CWD);
    const resPrCodex = runGuardAt(PR_GATE_SCRIPT, codexApplyPatchPayload(APPLY_PATCH_TEXT, NEUTRAL_CWD), NEUTRAL_CWD);
    assert(isAllow(resPrClaude), '[2b-3] pr-gate：Claude file_path 形狀（純檔案編輯）→ 放行');
    assert(isAllow(resPrCodex), '[2b-4] pr-gate：Codex apply_patch 形狀（純檔案編輯）→ 放行（同一判定）');
  }

  // ==========================================================================
  // 案例 3 —— 反向 case：語意不同的兩個 payload → 不同判定（排假綠，證明本檔有鑑別力）
  // ==========================================================================

  // 3a：merge-guard——同為 Codex shell 形狀，"gh pr merge"（高風險） vs "gh pr view"（唯讀查狀態）
  //     必須判不同，否則代表 1b 的「同判定」只是「反正這支 guard 對什麼都同一種反應」的假訊號。
  {
    const denyRes = runGuardAt(MERGE_GUARD_SCRIPT, codexShellPayload('gh pr merge 900 --squash', NEUTRAL_CWD), NEUTRAL_CWD);
    const allowRes = runGuardAt(MERGE_GUARD_SCRIPT, codexShellPayload('gh pr view 900 --json state', NEUTRAL_CWD), NEUTRAL_CWD);
    assert(isDeny(denyRes), '[3a-1] merge-guard：Codex 形狀 "gh pr merge" → deny');
    assert(isAllow(allowRes), '[3a-2] merge-guard：Codex 形狀 "gh pr view"（唯讀查狀態）→ 放行（與 3a-1 判定不同，證明有鑑別力）');
  }

  // 3b：pr-gate——同一條指令、同為 Codex shell 形狀，缺 04-verify.md 的 loop（deny） vs
  //     五閘全合規的 loop（allow）必須判不同。
  {
    const cmd = 'gh pr create --draft --assignee @me --title t --body "Closes #900"';
    const denyRes = runGuardAt(PR_GATE_SCRIPT, codexShellPayload(cmd, NOVERIFY_CWD), NOVERIFY_CWD);
    const allowRes = runGuardAt(PR_GATE_SCRIPT, codexShellPayload(cmd, FULL_CWD), FULL_CWD);
    assert(isDeny(denyRes), '[3b-1] pr-gate：Codex 形狀、缺 verify 的 loop → deny');
    assert(isAllow(allowRes), '[3b-2] pr-gate：Codex 形狀、五閘全合規的 loop → 放行（與 3b-1 判定不同，證明有鑑別力）');
  }
} finally {
  rmSync(SANDBOX, { recursive: true, force: true });
}

const total = passed + failed.length;
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
console.log(`(共 ${total} 條斷言：案例1=shell 形狀等價/案例2=檔案編輯形狀等價/案例3=反向鑑別力)`);
process.exit(failed.length > 0 ? 1 : 0);
