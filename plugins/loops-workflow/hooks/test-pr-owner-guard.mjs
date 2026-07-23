#!/usr/bin/env node
// test-pr-owner-guard.mjs —— pr-owner-guard.mjs（PreToolUse Bash|PowerShell + MCP deny hook，#164）
// 紅綠斷言（自帶極簡 harness，仿同目錄 test-merge-guard.mjs 的 tmp-less spawnSync 黑箱模式，不引
// 測試框架）。
//
// 用法（cwd = plugins/loops-workflow）：node hooks/test-pr-owner-guard.mjs
// 全綠 → exit 0；任一斷言失敗 → exit 1。
//
// （紅綠軌跡：T1 期 pr-owner-guard.mjs 尚未存在——spawnSync 對不存在的檔案路徑會得到非 0 exit code
// （node 找不到模組），故本檔幾乎全紅，包含「應放行」的案例也一併顯紅，不是「判定成放行」意義上
// 的綠；hooks.json 的 M1 接線斷言現況也是紅——尚未掛載。impl-author 建檔＋掛線後才會依真實判定
// 結果分流成紅/綠。）不對 pr-owner-guard.mjs 做「靜態具名 import」——理由同 test-merge-guard.mjs
// 頂部：靜態 import 一個不存在的檔案會在模組載入期就 ERR_MODULE_NOT_FOUND、讓整個測試檔連一條
// 斷言都跑不完就崩潰，連不依賴 pr-owner-guard.mjs 是否存在的 M1（hooks.json 接線檢查）都會被悶
// 掉。改用 spawnSync 真跑（IO 黑箱）＋唯一一處動態 `await import()`（try/catch 包住，見下方「動態
// import 安全探測」）——兩者都確保檔案不存在時本檔仍完整跑完、印出逐條紅燈，而不是一次性崩潰。
//
// 被測物契約摘要（見 issue #164；逐條照抄，唯一真相——test-author 未讀任何 implementation）：
//   目的：draft→ready、request review 是 PR owner 的驗收動作，agent 不得自動執行；reviewer
//   comment 的流程指示不構成授權。
//   輸入：stdin JSON {tool_name?, tool_input, cwd?}。分流：typeof tool_input.command === 'string'
//     → shell 判定；否則 tool_name 精確比對 MCP 工具 → 欄位判定；兩者皆非 → 放行（hook 不讀
//     tool_name 判 shell——Bash 與 PowerShell payload 同形，家族慣例）。
//   輸出：deny＝stdout 一行 JSON
//     {hookSpecificOutput:{hookEventName:'PreToolUse', permissionDecision:'deny',
//      permissionDecisionReason:<string>}}；放行＝無輸出。一律 exit 0。
//   flag：LOOPS_PR_OWNER_GUARD（defaultOn；env 字面 '0' 才關閉→全放行）。
//   fail-open：payload 非 JSON／缺 tool_input／判不出→放行。
//
//   shell 判定（五型，視圖分工：子指令詞用「剝掉引號內值」的視圖判、路徑與 GraphQL mutation 名看
//   原始字串）：
//     ① `gh pr ready`（任意位置 PR 號／url／-R 都算）→ deny；帶 --undo（位置不限）→ 放行。
//     ② `gh pr edit … --add-reviewer <x>`（空白或 = 接值）→ deny；--remove-reviewer → 放行。
//        `gh pr create … --reviewer <x>`（含 = 形）→ deny；`gh pr create` 的短旗標 -r **token
//        化判定**：只認 `gh pr create` 序列之後的未引號 -r／-r=value token → deny（`cp -r a b &&
//        gh pr create --draft --assignee @me` 不得誤擋）。
//     ③ `gh api …/pulls/…/requested_reviewers`（路徑判原始字串，右邊界=引號/空白/?/字串尾；
//        /pulls/ 與 /requested_reviewers 都要在）＋ method 是 POST → deny。POST 判定：顯式
//        -X POST／--method POST／--method=POST／黏合 -XPOST（大小寫不敏感）；或無顯式 method 但
//        帶欄位旗標（-f／-F／--field／--raw-field／--input）＝gh 隱式 POST。顯式 --method DELETE
//        （撤回，優先於欄位旗標）→ 放行；無 method 無欄位旗標（GET 查詢）→ 放行。
//     ④ `gh api` ∧ 剝殼視圖含裸 token graphql（不要求與 api 鄰接）∧ 原始字串含
//        markPullRequestReadyForReview 或 requestReviews（word boundary）→ deny；
//        convertPullRequestToDraft（無前兩者）→ 放行。
//   誤判防護：字樣只出現在引號內文不得誤擋（git commit -m "...gh pr ready..."、gh issue comment
//   --body "請跑 gh pr ready" 皆須放行）。
//
//   MCP 判定（tool_name 精確比對，(^|__)<name>$ 邊界）：
//     …__update_pull_request：draft === false（strict，非 truthiness）→ deny；draft === true →
//       放行；reviewers 非空陣列 → deny；reviewers: [] → 放行；只帶 {title:"x"}（無 draft／
//       reviewers 欄）→ 放行。
//     …__request_copilot_review → 一律 deny。
//     …__update_pull_request_branch → 放行（尾綴不同、精確比對不中）。
//
//   deny 理由（三要素都要驗到）：含 owner 語意（字串含 "owner" 或「驗收動作」）＋「不構成授權」＋
//   逃生口字樣 LOOPS_PR_OWNER_GUARD=0。
//
//   hooks.json 接線（M1）：(i) PreToolUse 的 Bash|PowerShell matcher 群組包含 pr-owner-guard.mjs
//   （在 merge-guard 之後、恰第 5 支）；(ii) 存在另一個 PreToolUse 群組，其 matcher 用
//   `new RegExp(matcher).test(name)` 對 mcp__plugin_github_github__update_pull_request 與
//   mcp__plugin_github_github__request_copilot_review 都為 true，且該群組 hooks 含
//   pr-owner-guard.mjs（不釘 matcher 字面，用 regex 行為驗）。現況：兩條都紅（尚未掛載）。
//
//   characterization（拍板留的已知限制，測試釘住「現況」非「目標」，不預期修）：
//     (e1) `echo --undo; gh pr ready 343` → 放行（--undo 檢查 command-wide 的假放行，拍板接受）。
//     (e2) `gh api graphql --input query.graphql -X POST`（mutation 名不在字串上）→ 放行（lexical
//       邊界，拍板接受）。

import { readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT_PATH = fileURLToPath(new URL('./pr-owner-guard.mjs', import.meta.url));

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

// owner 語意 + 不構成授權 + 逃生口 三要素比對正則
const OWNER_RE = /owner|驗收動作/i;
const NOT_AUTH_RE = /不構成授權/;
const ESCAPE_STR = 'LOOPS_PR_OWNER_GUARD=0';

// =============================================================================
// 動態 import 安全探測（案例清單「新 export 動態 import 隔離」，仿 test-merge-guard.mjs）
// =============================================================================
try {
  await import('./pr-owner-guard.mjs');
} catch (e) {
  console.error(`  (pr-owner-guard.mjs 動態 import 失敗——預期中，檔案尚未建立：${e && e.message})`);
}
assert(existsSync(HOOK_SCRIPT_PATH), 'hooks/pr-owner-guard.mjs 檔案存在（下面所有 IO 層案例的前提）[exist]');

// =============================================================================
// M1 —— hooks.json 接線斷言（家族慣例；現況紅：尚未掛載）
// =============================================================================
{
  const hooksConfig = JSON.parse(readFileSync(new URL('./hooks.json', import.meta.url), 'utf8'));
  const preToolUse = hooksConfig.hooks.PreToolUse || [];

  // (i) Bash|PowerShell 群組：pr-owner-guard.mjs 在 merge-guard 之後、恰第 5 支
  const shellEntry = preToolUse.find((e) =>
    (e.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes('pr-owner-guard.mjs')));
  const shellCommands = (shellEntry?.hooks || [])
    .map((h) => (typeof h.command === 'string' ? h.command : ''))
    .filter(Boolean);
  const idxComment = shellCommands.findIndex((c) => c.includes('outbound-comment-guard.mjs'));
  const idxWorktree = shellCommands.findIndex((c) => c.includes('worktree-guard.mjs'));
  const idxPrGate = shellCommands.findIndex((c) => c.includes('pr-gate.mjs'));
  const idxMergeGuard = shellCommands.findIndex((c) => c.includes('merge-guard.mjs'));
  const idxPrOwnerGuard = shellCommands.findIndex((c) => c.includes('pr-owner-guard.mjs'));

  assert(shellEntry?.matcher === 'Bash|PowerShell',
    '[M1-1] hooks.json 找得到 pr-owner-guard.mjs 所在 entry，且其 matcher==="Bash|PowerShell"（現況預期紅——尚未掛載）');
  assert(idxPrOwnerGuard !== -1, '[M1-2] 同 entry 內找得到 pr-owner-guard.mjs 的 command');
  assert(
    idxComment !== -1 && idxWorktree !== -1 && idxPrGate !== -1 && idxMergeGuard !== -1 &&
    idxComment < idxWorktree && idxWorktree < idxPrGate && idxPrGate < idxMergeGuard && idxMergeGuard < idxPrOwnerGuard,
    '[M1-3] 同 entry 內順序：outbound-comment-guard → worktree-guard → pr-gate → merge-guard → pr-owner-guard（第五支、排最後）',
  );
  assert(shellCommands.length === 5, '[M1-4] 該 entry 恰好 5 支 hook（不是掛到另開的新 entry）');

  // (ii) MCP 群組：matcher 用 new RegExp(matcher).test(name) 對兩個 MCP 工具名都為 true，
  // 且該群組 hooks 含 pr-owner-guard.mjs（不釘死 matcher 字面）。
  const safeTest = (re, s) => typeof re === 'string' && new RegExp(re).test(s);
  const mcpEntry = preToolUse.find((e) => {
    if (typeof e.matcher !== 'string') return false;
    const hasHook = (e.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes('pr-owner-guard.mjs'));
    return hasHook &&
      safeTest(e.matcher, 'mcp__plugin_github_github__update_pull_request') &&
      safeTest(e.matcher, 'mcp__plugin_github_github__request_copilot_review');
  });
  assert(mcpEntry !== undefined,
    '[M1-5] 存在 PreToolUse 群組：matcher 對兩個 MCP 工具名皆 match，且 hooks 含 pr-owner-guard.mjs（現況預期紅——尚未掛載）');
}

// =============================================================================
// Harness：runHook + 判讀 helper（仿 test-merge-guard.mjs）
// =============================================================================
function runHook({ command, toolName, toolInput, cwd, env = {}, rawInput } = {}) {
  let input;
  if (rawInput !== undefined) {
    input = rawInput;
  } else if (command !== undefined) {
    input = JSON.stringify({ cwd, tool_input: { command } });
  } else {
    input = JSON.stringify({ cwd, tool_name: toolName, tool_input: toolInput });
  }
  const mergedEnv = { ...process.env, ...env };
  if (!('LOOPS_PR_OWNER_GUARD' in env)) delete mergedEnv.LOOPS_PR_OWNER_GUARD;
  return spawnSync(process.execPath, [HOOK_SCRIPT_PATH], {
    input,
    cwd: HERE,
    env: mergedEnv,
    encoding: 'utf8',
  });
}
const stdoutOf = (res) => (typeof res.stdout === 'string' ? res.stdout : '');
const parseOut = (res) => { try { return JSON.parse(stdoutOf(res).trim()); } catch { return null; } };
const isDeny = (res) => parseOut(res)?.hookSpecificOutput?.permissionDecision === 'deny';
const reasonOf = (res) => parseOut(res)?.hookSpecificOutput?.permissionDecisionReason ?? '';
const isAllow = (res) => res.status === 0 && stdoutOf(res).trim() === '';

function assertDenyWithReason(res, label) {
  assert(isDeny(res), `${label} → deny`);
  assert(OWNER_RE.test(reasonOf(res)), `${label} reason 含 owner 語意（"owner" 或「驗收動作」）`);
  assert(NOT_AUTH_RE.test(reasonOf(res)), `${label} reason 含「不構成授權」`);
  assert(reasonOf(res).includes(ESCAPE_STR), `${label} reason 含逃生口字面 "${ESCAPE_STR}"`);
}

// =============================================================================
// S1 —— gh pr ready → deny；--undo → 放行；shell-agnostic（tool_name='PowerShell' 同形）
// =============================================================================
{
  const res = runHook({ command: 'gh pr ready 123' });
  assert(res.error == null && res.status === 0, '[S1-0] spawn 無 error、exit 0');
  const p = parseOut(res);
  assert(p?.hookSpecificOutput?.hookEventName === 'PreToolUse', '[S1-1] hookEventName === "PreToolUse"（信封形狀，首例代表全體）');
  assertDenyWithReason(res, '[S1-2] "gh pr ready 123"');
}
{
  const res = runHook({ command: 'gh pr ready --repo owner/repo 123' });
  assert(isDeny(res), '[S1-3] "gh pr ready --repo owner/repo 123"（帶 --repo，PR 號在後）→ deny');
}
{
  const res = runHook({ command: 'gh pr ready -R owner/repo https://github.com/owner/repo/pull/9' });
  assert(isDeny(res), '[S1-4] "gh pr ready -R owner/repo <url>"（-R + url 形）→ deny');
}
{
  const res = runHook({ rawInput: JSON.stringify({ tool_name: 'PowerShell', cwd: HERE, tool_input: { command: 'gh pr ready 7' } }) });
  assert(isDeny(res), '[S1-5] tool_name="PowerShell" 形 payload ＋ "gh pr ready 7" → deny（shell-agnostic，家族慣例）');
}
{
  const res = runHook({ command: 'gh pr ready 343 --undo' });
  assert(isAllow(res), '[S2-1] "gh pr ready 343 --undo"（--undo 在後）→ 放行');
}
{
  const res = runHook({ command: 'gh pr ready --undo 343' });
  assert(isAllow(res), '[S2-2] "gh pr ready --undo 343"（--undo 在前）→ 放行');
}

// =============================================================================
// S3 —— gh pr edit --add-reviewer / --remove-reviewer；gh pr create --reviewer / -r（token 化）
// =============================================================================
{
  const res = runHook({ command: 'gh pr edit 5 --add-reviewer alice' });
  assertDenyWithReason(res, '[S3-1] "gh pr edit 5 --add-reviewer alice"（空白接值）');
}
{
  const res = runHook({ command: 'gh pr edit 5 --add-reviewer=alice' });
  assert(isDeny(res), '[S3-2] "gh pr edit 5 --add-reviewer=alice"（= 接值）→ deny');
}
{
  const res = runHook({ command: 'gh pr edit 5 --remove-reviewer alice' });
  assert(isAllow(res), '[S3-3] "gh pr edit 5 --remove-reviewer alice" → 放行');
}
{
  const res = runHook({ command: 'gh pr create --title x --reviewer alice' });
  assertDenyWithReason(res, '[S3-4] "gh pr create --title x --reviewer alice"（空白接值）');
}
{
  const res = runHook({ command: 'gh pr create --title x --reviewer=alice' });
  assert(isDeny(res), '[S3-5] "gh pr create --title x --reviewer=alice"（= 形）→ deny');
}
{
  const res = runHook({ command: 'gh pr create --draft -r alice' });
  assert(isDeny(res), '[S3-6] "gh pr create --draft -r alice"（create 序列後未引號 -r）→ deny');
}
{
  const res = runHook({ command: 'gh pr create --draft -r=alice' });
  assert(isDeny(res), '[S3-7] "gh pr create --draft -r=alice"（= 形短旗標）→ deny');
}
{
  const res = runHook({ command: 'cp -r a b && gh pr create --draft --assignee @me' });
  assert(isAllow(res), '[S3-8] "cp -r a b && gh pr create --draft --assignee @me"（-r 在別段、create 後無 reviewer 旗標）→ 放行（不得誤擋）');
}
{
  const res = runHook({ command: 'gh pr create --draft --title "cp -r not a reviewer flag"' });
  assert(isAllow(res), '[S3-9] "gh pr create --draft --title \\"cp -r not a reviewer flag\\""（-r 只出現在引號內文）→ 放行');
}

// =============================================================================
// S4 —— gh api …/pulls/…/requested_reviewers ＋ POST 判定（顯式/隱式/黏合/DELETE/GET）
// =============================================================================
{
  const res = runHook({ command: 'gh api repos/x/y/pulls/42/requested_reviewers -X POST -f reviewers[]=alice' });
  assertDenyWithReason(res, '[S4-1] 顯式 "-X POST"（附欄位旗標）');
}
{
  const res = runHook({ command: 'gh api --method POST repos/x/y/pulls/42/requested_reviewers' });
  assert(isDeny(res), '[S4-2] 顯式 "--method POST"（空白形）→ deny');
}
{
  const res = runHook({ command: 'gh api --method=POST repos/x/y/pulls/42/requested_reviewers' });
  assert(isDeny(res), '[S4-3] 顯式 "--method=POST"（= 形）→ deny');
}
{
  const res = runHook({ command: 'gh api repos/x/y/pulls/42/requested_reviewers -XPOST' });
  assert(isDeny(res), '[S4-4] 顯式黏合 "-XPOST" → deny');
}
{
  const res = runHook({ command: 'gh api repos/x/y/pulls/42/requested_reviewers -xpost' });
  assert(isDeny(res), '[S4-5] "-xpost"（大小寫不敏感）→ deny');
}
{
  const res = runHook({ command: 'gh api repos/x/y/pulls/42/requested_reviewers -f reviewers[]=alice' });
  assert(isDeny(res), '[S4-6] 無顯式 method、帶 -f 欄位旗標（gh 隱式 POST）→ deny');
}
{
  const res = runHook({ command: 'gh api repos/x/y/pulls/42/requested_reviewers -F reviewers[]=alice' });
  assert(isDeny(res), '[S4-7] 帶 -F 欄位旗標（隱式 POST）→ deny');
}
{
  const res = runHook({ command: 'gh api repos/x/y/pulls/42/requested_reviewers --field reviewers[]=alice' });
  assert(isDeny(res), '[S4-8] 帶 --field 欄位旗標（隱式 POST）→ deny');
}
{
  const res = runHook({ command: 'gh api repos/x/y/pulls/42/requested_reviewers --raw-field reviewers[]=alice' });
  assert(isDeny(res), '[S4-9] 帶 --raw-field 欄位旗標（隱式 POST）→ deny');
}
{
  const res = runHook({ command: 'gh api repos/x/y/pulls/42/requested_reviewers --input body.json' });
  assert(isDeny(res), '[S4-10] 帶 --input 欄位旗標（隱式 POST）→ deny');
}
{
  const res = runHook({ command: 'gh api "repos/x/y/pulls/42/requested_reviewers?foo=bar" -X POST' });
  assert(isDeny(res), '[S4-11] 路徑被引號包住、後接 query string（右邊界=? ）→ deny');
}
{
  const res = runHook({ command: 'gh api repos/x/y/pulls/42/requested_reviewers -X DELETE' });
  assert(isAllow(res), '[S4-12] 顯式 "--method"/-X DELETE（撤回）→ 放行');
}
{
  const res = runHook({ command: 'gh api repos/x/y/pulls/42/requested_reviewers -X DELETE -f x=y' });
  assert(isAllow(res), '[S4-13] 顯式 DELETE ＋ 附欄位旗標（顯式 method 優先於隱式欄位規則）→ 放行');
}
{
  const res = runHook({ command: 'gh api repos/x/y/pulls/42/requested_reviewers' });
  assert(isAllow(res), '[S4-14] 無 method、無欄位旗標（GET 查詢）→ 放行');
}
{
  const res = runHook({ command: 'gh api repos/x/y/reviews/42/requested_reviewers -X POST' });
  assert(isAllow(res), '[S4-15] 路徑缺 "/pulls/" 段（僅 requested_reviewers）→ 放行（AND 條件不成立）');
}

// =============================================================================
// S5 —— gh api graphql ＋ mutation 名（word boundary）
// =============================================================================
{
  const res = runHook({ command: "gh api graphql -f query=mutation{markPullRequestReadyForReview(input:{pullRequestId:\"PR_1\"}){clientMutationId}}" });
  assertDenyWithReason(res, '[S5-1] graphql + markPullRequestReadyForReview mutation');
}
{
  const res = runHook({ command: "gh api -X POST graphql -f query=mutation{requestReviews(input:{pullRequestId:\"PR_1\"}){clientMutationId}}" });
  assert(isDeny(res), '[S5-2] "gh api -X POST graphql"（flag 前置、api 與 graphql 不鄰接）+ requestReviews mutation → deny');
}
{
  const res = runHook({ command: "gh api graphql -f query=mutation{convertPullRequestToDraft(input:{pullRequestId:\"PR_1\"}){clientMutationId}}" });
  assert(isAllow(res), '[S5-3] graphql + convertPullRequestToDraft（無前兩個 mutation 名）→ 放行');
}
{
  const res = runHook({ command: "gh api graphql -f query=mutation{requestReviewsForSomethingElse(input:{}){ok}}" });
  assert(isAllow(res), '[S5-4] "requestReviewsForSomethingElse"（requestReviews 後緊接字母，word boundary 不成立）→ 放行（防子字串誤中）');
}

// =============================================================================
// S8 —— 引號內文不誤擋
// =============================================================================
{
  const res = runHook({ command: 'git commit -m "docs: 說明 gh pr ready 流程"' });
  assert(isAllow(res), '[S8-1] commit message 引號內文含 "gh pr ready" 字樣（非真的執行）→ 放行');
}
{
  const res = runHook({ command: 'gh issue comment 5 --body "請跑 gh pr ready"' });
  assert(isAllow(res), '[S8-2] issue comment body 引號內文含 "gh pr ready"（reviewer 流程指示，非真的執行）→ 放行');
}

// =============================================================================
// S6 —— MCP 判定（tool_name 精確比對，五案 + request_copilot_review）
// =============================================================================
{
  const res = runHook({ toolName: 'mcp__plugin_github_github__update_pull_request', toolInput: { draft: false } });
  assertDenyWithReason(res, '[S6-1] update_pull_request ＋ draft===false（strict）');
}
{
  const res = runHook({ toolName: 'mcp__plugin_github_github__update_pull_request', toolInput: { draft: true } });
  assert(isAllow(res), '[S6-2] update_pull_request ＋ draft===true → 放行');
}
{
  const res = runHook({ toolName: 'mcp__plugin_github_github__update_pull_request', toolInput: { draft: 0 } });
  assert(isAllow(res), '[S6-3] update_pull_request ＋ draft===0（falsy 但非 strict false）→ 放行（strict 比對，防 truthiness 誤判）');
}
{
  const res = runHook({ toolName: 'mcp__plugin_github_github__update_pull_request', toolInput: { reviewers: ['alice'] } });
  assertDenyWithReason(res, '[S6-4] update_pull_request ＋ reviewers 非空陣列');
}
{
  const res = runHook({ toolName: 'mcp__plugin_github_github__update_pull_request', toolInput: { reviewers: [] } });
  assert(isAllow(res), '[S6-5] update_pull_request ＋ reviewers: [] → 放行');
}
{
  const res = runHook({ toolName: 'mcp__plugin_github_github__update_pull_request', toolInput: { title: 'x' } });
  assert(isAllow(res), '[S6-6] update_pull_request ＋ 只帶 {title:"x"}（無 draft／reviewers 欄）→ 放行');
}
{
  const res = runHook({ toolName: 'mcp__plugin_github_github__update_pull_request_branch', toolInput: { draft: false } });
  assert(isAllow(res), '[S6-7] update_pull_request_branch（尾綴不同、精確比對不中）＋ draft:false → 放行');
}
{
  const res = runHook({ toolName: 'mcp__plugin_github_github__request_copilot_review', toolInput: {} });
  assertDenyWithReason(res, '[S6-8] request_copilot_review（空 tool_input）');
}
{
  const res = runHook({ toolName: 'mcp__plugin_github_github__request_copilot_review', toolInput: { anything: 'x' } });
  assert(isDeny(res), '[S6-9] request_copilot_review（任意 tool_input）→ 一律 deny');
}

// =============================================================================
// S7 —— 逃生口 LOOPS_PR_OWNER_GUARD='0'；flag 語意（僅字面 '0' 關、defaultOn）
// =============================================================================
{
  const res = runHook({ command: 'gh pr ready 1', env: { LOOPS_PR_OWNER_GUARD: '0' } });
  assert(isAllow(res), "[S7-1] LOOPS_PR_OWNER_GUARD='0' ＋ gh pr ready → 即使違規也放行");
}
{
  const res = runHook({ toolName: 'mcp__plugin_github_github__request_copilot_review', toolInput: {}, env: { LOOPS_PR_OWNER_GUARD: '0' } });
  assert(isAllow(res), "[S7-2] LOOPS_PR_OWNER_GUARD='0' ＋ MCP request_copilot_review → 放行（逃生口對 shell/MCP 皆生效）");
}
{
  const res = runHook({ command: 'gh pr ready 1', env: { LOOPS_PR_OWNER_GUARD: 'false' } });
  assert(isDeny(res), "[S7-3] LOOPS_PR_OWNER_GUARD='false'（非字面 '0'）→ 仍啟用 → deny");
}
{
  const env = { ...process.env };
  delete env.LOOPS_PR_OWNER_GUARD;
  const res = spawnSync(process.execPath, [HOOK_SCRIPT_PATH], {
    input: JSON.stringify({ cwd: HERE, tool_input: { command: 'gh pr ready 1' } }),
    cwd: HERE,
    env,
    encoding: 'utf8',
  });
  assert(isDeny(res), '[S7-4] LOOPS_PR_OWNER_GUARD 未設 → defaultOn → deny');
}

// =============================================================================
// e1/e2 —— characterization：拍板留的已知限制（釘現況，非目標；不預期修）
// =============================================================================
{
  const res = runHook({ command: 'echo --undo; gh pr ready 343' });
  assert(isAllow(res), '[e1] "echo --undo; gh pr ready 343"（--undo 檢查 command-wide 的假放行）→ 放行（現況預期即此，拍板接受，非 bug）');
}
{
  const res = runHook({ command: 'gh api graphql --input query.graphql -X POST' });
  assert(isAllow(res), '[e2] "gh api graphql --input query.graphql -X POST"（mutation 名不在字串上）→ 放行（lexical 邊界，拍板接受，非 bug）');
}

// =============================================================================
// fail-open —— 壞 payload／缺 tool_input／command 缺失且 tool_name 非受管
// =============================================================================
{
  const res = runHook({ rawInput: 'not { json' });
  assert(res.error == null && res.status === 0 && stdoutOf(res).trim() === '',
    '[fail-open-1] stdin 非 JSON → exit 0、stdout 空（fail-open）');
}
{
  const res = runHook({ rawInput: JSON.stringify({ tool_input: {}, cwd: HERE }) });
  assert(res.status === 0 && stdoutOf(res).trim() === '',
    '[fail-open-2] tool_input:{} 無 command 欄，tool_name 缺（非受管）→ 放行（fail-open）');
}
{
  const res = runHook({ rawInput: JSON.stringify({ cwd: HERE }) });
  assert(res.status === 0 && stdoutOf(res).trim() === '',
    '[fail-open-3] 完全缺 tool_input 欄 → 放行（fail-open）');
}

const total = passed + failed.length;
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
console.log(`(共 ${total} 條斷言：M1=接線／S1-S2=ready+undo／S3=edit+create reviewer／S4=api requested_reviewers／S5=graphql／S6=MCP／S7=escape+flag語意／S8=引號防誤擋／e1-e2=characterization／fail-open)`);
process.exit(failed.length > 0 ? 1 : 0);
