#!/usr/bin/env node
// test-merge-guard.mjs —— merge-guard.mjs（PreToolUse Bash|PowerShell deny hook，#133）紅綠斷言
// （自帶極簡 harness，仿同目錄 test-pr-gate.mjs 的 tmp sandbox 模式，不引測試框架）。
//
// 用法（cwd = plugins/loops-workflow）：node hooks/test-merge-guard.mjs
// 全綠 → exit 0；任一斷言失敗 → exit 1。
//
// （紅綠軌跡：T1 期 merge-guard.mjs 尚未存在——spawnSync 對不存在的檔案路徑會得到非 0 exit code
// （node 找不到模組），而 isAllow() 要求 status===0，故本檔幾乎全紅，包含「應放行」的案例也一併
// 顯紅，不是「判定成放行」意義上的綠；T2 impl 建檔後才會依真實判定結果分流成紅/綠。）不對
// merge-guard.mjs 做「靜態具名 import」——理由同 test-pr-gate.mjs 頂部：靜態 import 一個不存在的
// 檔案會在模組載入期就 ERR_MODULE_NOT_FOUND、讓整個測試檔連一條斷言都跑不完就崩潰，連不依賴
// merge-guard.mjs 是否存在的 M1（hooks.json 接線檢查）都會被悶掉。改用 spawnSync 真跑（IO 黑箱）＋
// 唯一一處動態 `await import()`（try/catch 包住，見下方「動態 import 安全探測」）——兩者都確保
// 檔案不存在時本檔仍完整跑完、印出逐條紅燈，而不是一次性崩潰。
//
// 被測物契約摘要（見 issue #133 / .loops/133-merge-guard/stages/02-plan.md）：
//   payload：{cwd, tool_input:{command}}（PreToolUse Bash|PowerShell 同形，家族慣例）。
//   旗標 LOOPS_MERGE_GUARD（defaultOn；僅字面 '0' 關閉）。
//   四型 deny（視圖分工——子指令詞用 stripQuotedValues 剝殼視圖判，目的地/路徑對原始未剝殼字串判，
//   #132 Q1 同課＋審查實測「剝殼會把引號包住的高風險值一併消掉」兩缺口，D1）：
//     ① `gh pr merge`（任意 flag 組合）→ deny。
//     ② cwd 所在分支＝main/master（讀 .git 目錄/檔形 HEAD、祖先上溯，重用 pr-gate.mjs 的
//        readGitBranch）時的 `git merge <ref>` → deny；feature 分支上 `git merge other` → 放行；
//        detached（裸 SHA HEAD）→ 放行（D2）。
//     ③ `git push <remote> <dest>`，destination ∈ {master, main, refs/heads/master, refs/heads/main}
//        （bare positional 形／refspec 冒號右側形，含引號包住整個 refspec／`--delete master|main`
//        不豁免）→ deny；push 到 feature 分支（含 `--delete feature`）→ 放行。
//     ④ `gh api`＋PUT（`-X PUT`/`--method PUT`）＋路徑含 `/pulls/` 且含 `/merge`（AND，不要求鄰接，
//        含路徑被引號包住形）→ deny；非 PUT（GET 查狀態）或路徑非 `/merge` → 放行。
//   deny 輸出家族同形：hookSpecificOutput.permissionDecision='deny'，reason 含 human gate 語意
//   （issue 原文與 02-plan.md 明用「human gate」一詞；見下方 HUMAN_GATE_RE 放寬比對）＋
//   LOOPS_MERGE_GUARD=0 逃生口。
//   fail-open：payload 壞 / 缺 command / 判不出分支（含無 .git、含 detached HEAD）一律放行。
//   重用件（不在本檔測——見供應方 test-pr-gate.mjs）：stripQuotedValues／readGitBranch（#133 plan
//   §1：pr-gate.mjs 僅加 export、零行為變更）、flagEnabled（hook-flags.mjs）。

import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = join(HERE, 'merge-guard.mjs'); // 真跑的 hook（目前不存在——見檔頭說明）

// human gate 語意偵測：issue #133 原文與 02-plan.md 明確用「human gate」一詞（英文原詞嵌在中文句中：
// 「合併回主幹＝human gate」）；pr-gate.mjs 同家族的姊妹閘（--draft/--assignee 補救訊息）曾用「人核可」
// 表達同一概念——兩者擇一即算語意到位，不鎖死 impl 的確切措辭（比照 test-pr-gate.mjs 對 'verify'/
// 'Closes' 的字面子字串挑法，但這裡的概念本身有多種合理措辭，故放寬成 OR）。
const HUMAN_GATE_RE = /human gate|人核可|人工核可/i;

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
// 動態 import 安全探測（案例清單「新 export 動態 import 隔離」，仿 test-pr-gate.mjs）
// =============================================================================
let mergeGuardModule = null;
try {
  mergeGuardModule = await import('./merge-guard.mjs');
} catch (e) {
  console.error(`  (merge-guard.mjs 動態 import 失敗——預期中，檔案尚未建立：${e && e.message})`);
}
assert(existsSync(HOOK_SCRIPT), 'hooks/merge-guard.mjs 檔案存在（下面所有 IO 層案例的前提）[exist]');

// =============================================================================
// M1 —— hooks.json 接線斷言（#130/#132 慣例；現況紅：尚未掛載）
// =============================================================================
{
  const hooksConfig = JSON.parse(readFileSync(new URL('./hooks.json', import.meta.url), 'utf8'));
  const preToolUse = hooksConfig.hooks.PreToolUse || [];
  const entry = preToolUse.find((e) =>
    (e.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes('merge-guard.mjs')));
  const matcher = entry?.matcher;
  const safeTest = (re, s) => typeof re === 'string' && new RegExp(re).test(s); // 防 matcher undefined 時
    // new RegExp(undefined) 被當成空字串 pattern、對任何字串都 match 造成假綠

  assert(typeof matcher === 'string', '[M1-1] hooks.json 的 PreToolUse 找得到 merge-guard.mjs 所在 entry（現況預期紅——尚未掛載）');
  assert(matcher === 'Bash|PowerShell', '[M1-2] matcher 精確等於 "Bash|PowerShell"（防截斷值假綠）');
  assert(safeTest(matcher, 'Bash') === true, '[M1-3] matcher 對 "Bash" match');
  assert(safeTest(matcher, 'PowerShell') === true, '[M1-4] matcher 對 "PowerShell" match（#130 慣例：主 shell 不留守衛盲區）');

  const commands = (entry?.hooks || [])
    .map((h) => (typeof h.command === 'string' ? h.command : ''))
    .filter(Boolean);
  const idxComment = commands.findIndex((c) => c.includes('outbound-comment-guard.mjs'));
  const idxWorktree = commands.findIndex((c) => c.includes('worktree-guard.mjs'));
  const idxPrGate = commands.findIndex((c) => c.includes('pr-gate.mjs'));
  const idxMergeGuard = commands.findIndex((c) => c.includes('merge-guard.mjs'));
  assert(idxMergeGuard !== -1, '[M1-5] 同 entry 內找得到 merge-guard.mjs 的 command');
  assert(
    idxComment !== -1 && idxWorktree !== -1 && idxPrGate !== -1 &&
    idxComment < idxWorktree && idxWorktree < idxPrGate && idxPrGate < idxMergeGuard,
    '[M1-6] 同 entry 內順序：outbound-comment-guard → worktree-guard → pr-gate → merge-guard（第四支、排最後，02-plan §1 拍板）',
  );
  assert(commands.length === 4, '[M1-7] 該 entry 恰好 4 支 hook（不是掛到另開的新 entry）');
}

// =============================================================================
// Fixture 佈局（tmp sandbox，try/finally 清理，仿 test-pr-gate.mjs）
// =============================================================================
const SANDBOX = join(tmpdir(), `mg-${process.pid}`);

try {
  // NEUTRAL_CWD：子行程真實 OS cwd 固定在此中性空目錄（無 .git）——①③④三型判定與分支無關，
  // 一律用它跑；②（git merge）才需要下面各分支 fixture 的「邏輯 cwd」（經 payload.cwd 傳入，
  // 不是真實 OS cwd——同 test-pr-gate.mjs 的 NEUTRAL_CWD／payload.cwd 兩層分工）。
  const NEUTRAL_CWD = join(SANDBOX, 'neutral');
  mkdirSync(NEUTRAL_CWD, { recursive: true });

  // Fixture：主幹 checkout，HEAD → refs/heads/master（.git 目錄形）。
  const MASTER_ROOT = join(SANDBOX, 'repo-master');
  mkdirSync(join(MASTER_ROOT, '.git'), { recursive: true });
  writeFileSync(join(MASTER_ROOT, '.git', 'HEAD'), 'ref: refs/heads/master\n');

  // Fixture：主幹 checkout，HEAD → refs/heads/main（.git 目錄形；main/master 兩個常名都要判）。
  const MAIN_ROOT = join(SANDBOX, 'repo-main');
  mkdirSync(join(MAIN_ROOT, '.git'), { recursive: true });
  writeFileSync(join(MAIN_ROOT, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  // Fixture：feature 分支 checkout（.git 目錄形）——D2 放行案例用。
  const FEATURE_ROOT = join(SANDBOX, 'repo-feature');
  mkdirSync(join(FEATURE_ROOT, '.git'), { recursive: true });
  writeFileSync(join(FEATURE_ROOT, '.git', 'HEAD'), 'ref: refs/heads/220-some-feature\n');

  // Fixture：detached HEAD（裸 SHA，無 ref: 前綴，.git 目錄形）——判不出分支名，fail-open 放行用。
  const DETACHED_ROOT = join(SANDBOX, 'repo-detached');
  mkdirSync(join(DETACHED_ROOT, '.git'), { recursive: true });
  writeFileSync(join(DETACHED_ROOT, '.git', 'HEAD'), 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\n');

  // Fixture：完全找不到 .git（祖先上溯到底仍無）——判不出分支，fail-open 放行用。
  const NO_GIT_ROOT = join(SANDBOX, 'repo-no-git');
  mkdirSync(NO_GIT_ROOT, { recursive: true });

  // Fixture：檔案形 .git（worktree 常見形，gitdir 指標），HEAD → refs/heads/master——驗 readGitBranch
  // 讀「檔形」HEAD 的路徑也要在 merge-guard 生效（仿 test-pr-gate.mjs 的 EXTRA-1）。
  const FILEFORM_GITDIR = join(SANDBOX, 'fileform-gitdir', '.git', 'worktrees', 'wt1');
  mkdirSync(FILEFORM_GITDIR, { recursive: true });
  writeFileSync(join(FILEFORM_GITDIR, 'HEAD'), 'ref: refs/heads/master\n');
  const FILEFORM_ROOT = join(SANDBOX, 'fileform-wt');
  mkdirSync(FILEFORM_ROOT, { recursive: true });
  writeFileSync(join(FILEFORM_ROOT, '.git'), `gitdir: ${FILEFORM_GITDIR}\n`);

  function runHook({ command, cwd, env = {}, rawInput } = {}) {
    const input = rawInput !== undefined ? rawInput : JSON.stringify({ cwd, tool_input: { command } });
    const mergedEnv = { ...process.env, ...env };
    // 防 ambient shell 環境殘留 LOOPS_MERGE_GUARD 汙染斷言——預設不繼承呼叫本檔那個 shell 的既有值，
    // 僅呼叫端在 env 明確傳入 LOOPS_MERGE_GUARD 時才保留（#132 P7 教訓同款防護）。
    if (!('LOOPS_MERGE_GUARD' in env)) delete mergedEnv.LOOPS_MERGE_GUARD;
    return spawnSync(process.execPath, [HOOK_SCRIPT], {
      input,
      cwd: NEUTRAL_CWD,
      env: mergedEnv,
      encoding: 'utf8',
    });
  }
  const stdoutOf = (res) => (typeof res.stdout === 'string' ? res.stdout : '');
  const parseOut = (res) => { try { return JSON.parse(stdoutOf(res).trim()); } catch { return null; } };
  const isDeny = (res) => parseOut(res)?.hookSpecificOutput?.permissionDecision === 'deny';
  const reasonOf = (res) => parseOut(res)?.hookSpecificOutput?.permissionDecisionReason ?? '';
  const isAllow = (res) => res.status === 0 && stdoutOf(res).trim() === '';

  // ===========================================================================
  // M2① —— gh pr merge（任意 flag 組合）→ deny
  // ===========================================================================
  {
    const res = runHook({ command: 'gh pr merge 123 --squash', cwd: NEUTRAL_CWD });
    assert(res.error == null && res.status === 0, '[M2①-1] spawn 無 error、exit 0');
    const p = parseOut(res);
    assert(p?.hookSpecificOutput?.hookEventName === 'PreToolUse', '[M2①-2] hookEventName === "PreToolUse"（信封形狀，首例代表全體）');
    assert(isDeny(res), '[M2①-3] "gh pr merge 123 --squash" → deny');
    assert(reasonOf(res).includes('LOOPS_MERGE_GUARD'), '[M2①-4] reason 含逃生口字面 "LOOPS_MERGE_GUARD"');
    assert(HUMAN_GATE_RE.test(reasonOf(res)), '[M2①-5] reason 含 human gate 語意（"human gate" 或「人核可」等）');
  }
  {
    const res = runHook({ command: 'gh pr merge --auto --delete-branch', cwd: NEUTRAL_CWD });
    assert(isDeny(res), '[M2①-6] "gh pr merge --auto --delete-branch"（無 PR 編號、不同 flag 組合）→ deny');
  }
  {
    // PowerShell tool_name 形：hook 本身不讀 tool_name、只判 command 內容——matcher 是否放行由 M1 涵蓋
    // （仿 test-worktree-guard.mjs 的 C4 characterization）。
    const res = runHook({ rawInput: JSON.stringify({ tool_name: 'PowerShell', cwd: NEUTRAL_CWD, tool_input: { command: 'gh pr merge 5 --merge' } }) });
    assert(isDeny(res), '[M2①-7] tool_name="PowerShell" 形 payload ＋ "gh pr merge 5 --merge" → deny（hook 本身 shell-agnostic）');
  }

  // ===========================================================================
  // M2② —— 主幹（master/main）checkout 上的 git merge → deny（D2；目錄形／檔形 HEAD 皆生效）
  // ===========================================================================
  {
    const res = runHook({ command: 'git merge feature-x', cwd: MASTER_ROOT });
    assert(isDeny(res), '[M2②-1] cwd 所在分支=master（.git 目錄形）＋ "git merge feature-x" → deny');
    assert(reasonOf(res).includes('LOOPS_MERGE_GUARD'), '[M2②-2] reason 含逃生口字面 "LOOPS_MERGE_GUARD"');
    assert(HUMAN_GATE_RE.test(reasonOf(res)), '[M2②-3] reason 含 human gate 語意');
  }
  {
    const res = runHook({ command: 'git merge feature-y', cwd: MAIN_ROOT });
    assert(isDeny(res), '[M2②-4] cwd 所在分支=main（.git 目錄形）＋ "git merge feature-y" → deny');
  }
  {
    const res = runHook({ command: 'git merge feature-z', cwd: FILEFORM_ROOT });
    assert(isDeny(res), '[M2②-5] cwd 所在分支=master（.git 檔案形，gitdir 指標）＋ "git merge feature-z" → deny（讀檔形 HEAD 路徑也要生效）');
  }

  // ===========================================================================
  // M2③ —— git push 到主幹 destination（bare／refspec／引號／--delete 各形）→ deny
  // ===========================================================================
  {
    const res = runHook({ command: 'git push origin master', cwd: NEUTRAL_CWD });
    assert(isDeny(res), '[M2③-1] "git push origin master"（bare positional 形）→ deny');
    assert(reasonOf(res).includes('LOOPS_MERGE_GUARD'), '[M2③-2] reason 含逃生口字面 "LOOPS_MERGE_GUARD"');
    assert(HUMAN_GATE_RE.test(reasonOf(res)), '[M2③-3] reason 含 human gate 語意');
  }
  {
    const res = runHook({ command: 'git push origin main', cwd: NEUTRAL_CWD });
    assert(isDeny(res), '[M2③-4] "git push origin main"（bare positional 形）→ deny');
  }
  {
    const res = runHook({ command: 'git push origin any-branch:master', cwd: NEUTRAL_CWD });
    assert(isDeny(res), '[M2③-5] "git push origin any-branch:master"（通用 refspec 形，冒號右側=master，左側不論）→ deny');
  }
  {
    // 引號包住整個 refspec：若目的地判定誤用剝殼視圖，stripQuotedValues 會把整段消掉造成偽陰性——
    // 目的地判定須對原始未剝殼字串比對（D1 審查實測缺口之一，02-plan §6 明文）。
    const res = runHook({ command: 'git push origin "HEAD:master"', cwd: NEUTRAL_CWD });
    assert(isDeny(res), '[M2③-6] \'git push origin "HEAD:master"\'（引號包住整個 refspec）→ deny');
  }
  {
    const res = runHook({ command: 'git push origin --delete master', cwd: NEUTRAL_CWD });
    assert(isDeny(res), '[M2③-7] "git push origin --delete master"（刪主幹）→ deny——--delete 不豁免（02-plan D1）');
  }
  {
    const res = runHook({ command: 'git push origin --delete main', cwd: NEUTRAL_CWD });
    assert(isDeny(res), '[M2③-8] "git push origin --delete main" → deny');
  }
  {
    const res = runHook({ command: 'git push origin HEAD:refs/heads/master', cwd: NEUTRAL_CWD });
    assert(isDeny(res), '[M2③-9] "git push origin HEAD:refs/heads/master"（refspec 右側完整 refs/heads/ 形）→ deny');
  }
  {
    const res = runHook({ command: 'git push --force-with-lease origin master', cwd: NEUTRAL_CWD });
    assert(isDeny(res), '[M2③-10] "git push --force-with-lease origin master"（remote/destination 前夾其他 flag）→ deny');
  }

  // ===========================================================================
  // M2④ —— gh api PUT + /pulls/…/merge 路徑（AND、不鄰接、引號路徑）→ deny
  // ===========================================================================
  {
    const res = runHook({ command: 'gh api repos/x/y/pulls/42/merge -X PUT', cwd: NEUTRAL_CWD });
    assert(isDeny(res), '[M2④-1] "gh api repos/x/y/pulls/42/merge -X PUT" → deny');
    assert(reasonOf(res).includes('LOOPS_MERGE_GUARD'), '[M2④-2] reason 含逃生口字面 "LOOPS_MERGE_GUARD"');
    assert(HUMAN_GATE_RE.test(reasonOf(res)), '[M2④-3] reason 含 human gate 語意');
  }
  {
    const res = runHook({ command: 'gh api --method PUT repos/x/y/pulls/7/merge', cwd: NEUTRAL_CWD });
    assert(isDeny(res), '[M2④-4] "gh api --method PUT repos/x/y/pulls/7/merge"（--method 而非 -X）→ deny');
  }
  {
    const res = runHook({ command: 'gh api -X PUT repos/x/y/pulls/9/merge -f merge_method=squash', cwd: NEUTRAL_CWD });
    assert(isDeny(res), '[M2④-5] 路徑與 -X PUT 之間夾其他參數（AND 不要求鄰接）→ deny');
  }
  {
    // 路徑被引號包住：同 M2③-6 的 D1 缺口——路徑判定須對原始字串比對，剝殼視圖會把引號內路徑消掉。
    const res = runHook({ command: 'gh api -X PUT "repos/x/y/pulls/42/merge"', cwd: NEUTRAL_CWD });
    assert(isDeny(res), '[M2④-6] \'gh api -X PUT "repos/x/y/pulls/42/merge"\'（路徑被引號包住）→ deny');
  }

  // ===========================================================================
  // M3 —— 誤擋明單放行（D3；剝殼視圖防 comment 文字誤判、feature push、非主幹 merge）
  // ===========================================================================
  {
    const res = runHook({ command: 'git pull', cwd: NEUTRAL_CWD });
    assert(isAllow(res), '[M3-1] "git pull" → 放行（底層含 merge 但字面不含 "git merge" 片語）');
  }
  {
    const res = runHook({ command: 'git pull --no-rebase', cwd: NEUTRAL_CWD });
    assert(isAllow(res), '[M3-2] "git pull --no-rebase" → 放行');
  }
  {
    const res = runHook({ command: 'git fetch origin master', cwd: NEUTRAL_CWD });
    assert(isAllow(res), '[M3-3] "git fetch origin master" → 放行（fetch 非 push/merge）');
  }
  {
    const res = runHook({ command: 'git log master..HEAD', cwd: NEUTRAL_CWD });
    assert(isAllow(res), '[M3-4] "git log master..HEAD" → 放行');
  }
  {
    const res = runHook({ command: 'git diff master', cwd: NEUTRAL_CWD });
    assert(isAllow(res), '[M3-5] "git diff master" → 放行');
  }
  {
    const res = runHook({ command: 'git commit -m "merge fix"', cwd: NEUTRAL_CWD });
    assert(isAllow(res), '[M3-6] \'git commit -m "merge fix"\'（commit message 內文含 "merge" 字樣，非真的合併動作）→ 放行');
  }
  {
    const res = runHook({ command: 'gh issue comment 5 --body "流程提醒：主幹上不要 git merge，要走 PR"', cwd: NEUTRAL_CWD });
    assert(isAllow(res), '[M3-7] gh issue comment body 引號內文含 "git merge" 字樣（非真的執行）→ 放行（剝殼視圖防誤判，同 #132 Q1 課）');
  }
  {
    const res = runHook({ command: 'git push origin feature-x', cwd: NEUTRAL_CWD });
    assert(isAllow(res), '[M3-8] "git push origin feature-x"（push 到 feature 分支）→ 放行');
  }
  {
    const res = runHook({ command: 'git push origin --delete feature-x', cwd: NEUTRAL_CWD });
    assert(isAllow(res), '[M3-9] "git push origin --delete feature-x"（刪 feature 分支）→ 放行');
  }
  {
    const res = runHook({ command: 'git merge other-feature', cwd: FEATURE_ROOT });
    assert(isAllow(res), '[M3-10] cwd 所在分支=feature（非 main/master）＋ "git merge other-feature" → 放行（D2：非主幹互併合法）');
  }
  {
    const res = runHook({ command: 'gh api repos/x/y/pulls/1/reviews -X PUT', cwd: NEUTRAL_CWD });
    assert(isAllow(res), '[M3-11] "gh api repos/x/y/pulls/1/reviews -X PUT"（路徑非 /merge）→ 放行');
  }
  {
    const res = runHook({ command: 'gh api repos/x/y/pulls/1/merge', cwd: NEUTRAL_CWD });
    assert(isAllow(res), '[M3-12] "gh api repos/x/y/pulls/1/merge"（無 -X/--method，預設 GET，查狀態）→ 放行');
  }

  // ===========================================================================
  // M4 —— LOOPS_MERGE_GUARD='0' 逃生；flag 語意（僅字面 '0' 關、defaultOn）
  // ===========================================================================
  {
    const res = runHook({ command: 'gh pr merge 1 --squash', cwd: NEUTRAL_CWD, env: { LOOPS_MERGE_GUARD: '0' } });
    assert(isAllow(res), "[M4-1] LOOPS_MERGE_GUARD='0' ＋ gh pr merge → 即使違規也放行");
  }
  {
    const res = runHook({ command: 'git push origin master', cwd: NEUTRAL_CWD, env: { LOOPS_MERGE_GUARD: '0' } });
    assert(isAllow(res), "[M4-2] LOOPS_MERGE_GUARD='0' ＋ git push origin master → 放行（逃生口對四型皆生效，非僅型①）");
  }
  {
    // 'false'（非字面 '0'）→ 依 hook-flags.mjs 的 defaultOn 語意仍視為啟用 → 應仍 deny。
    const res = runHook({ command: 'gh pr merge 1 --squash', cwd: NEUTRAL_CWD, env: { LOOPS_MERGE_GUARD: 'false' } });
    assert(isDeny(res), "[M4-3] LOOPS_MERGE_GUARD='false'（非字面 '0'）→ 仍啟用 → deny");
  }
  {
    // 未設 flag → defaultOn → 仍啟用 → deny。
    const env = { ...process.env };
    delete env.LOOPS_MERGE_GUARD;
    const res = spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: JSON.stringify({ cwd: NEUTRAL_CWD, tool_input: { command: 'gh pr merge 1 --squash' } }),
      cwd: NEUTRAL_CWD,
      env,
      encoding: 'utf8',
    });
    assert(isDeny(res), '[M4-4] LOOPS_MERGE_GUARD 未設 → defaultOn → deny');
  }

  // ===========================================================================
  // M5 —— fail-open：壞 payload／缺 command／判不出分支（無 .git、detached HEAD）
  // ===========================================================================
  {
    const res = runHook({ rawInput: 'not { json' });
    assert(res.error == null && res.status === 0 && stdoutOf(res).trim() === '',
      '[M5-1] stdin 非 JSON → exit 0、stdout 空（fail-open）');
  }
  {
    const res = runHook({ rawInput: JSON.stringify({ tool_input: {}, cwd: NEUTRAL_CWD }) });
    assert(res.status === 0 && stdoutOf(res).trim() === '', '[M5-2] 缺 command 欄位 → 放行（fail-open）');
  }
  {
    const res = runHook({ command: 'git merge x', cwd: NO_GIT_ROOT });
    assert(isAllow(res), '[M5-3] cwd 判不出分支（祖先上溯到底找不到 .git）＋ "git merge x" → 放行（fail-open，判不出就不擋）');
  }
  {
    const res = runHook({ command: 'git merge x', cwd: DETACHED_ROOT });
    assert(isAllow(res), '[M5-4] detached HEAD（裸 SHA，判不出分支名）＋ "git merge x" → 放行');
  }

  // ===========================================================================
  // M6 —— 純函式直測（動態 import；#132 教訓：黑箱 spawnSync 之外也要直測邊界函式）
  // ===========================================================================
  // 契約（merge-guard.mjs 需 export 以下純函式；本檔先定、impl 照做——同 #132 T1 對 pr-gate.mjs 的
  // 純函式契約做法，見 test-pr-gate.mjs 的 Q5–Q8）：
  //
  //   classifyMergeCommand(cmd, branch) → 'pr-merge' | 'git-merge-main' | 'push-main' | 'api-put-merge' | null
  //     四型分類主入口，依序判定、命中即回對應型別字串，全不中回 null：
  //       ① isPrMergeCommand(cmd) → 'pr-merge'
  //       ② isGitMergeCommand(cmd) 且 isMainBranch(branch) → 'git-merge-main'
  //       ③ isPushToMainDestination(cmd) → 'push-main'
  //       ④ isApiPutMergeCommand(cmd) → 'api-put-merge'
  //     branch 由呼叫端（main()）算好傳入（沿用 pr-gate.mjs 匯出的 readGitBranch；本函式不做 IO，
  //     且僅②會用到 branch——③④與分支無關，即使傳入非主幹 branch 仍應命中）。
  //   isPrMergeCommand(cmd) → boolean：stripQuotedValues(cmd) 後比對 /\bgh\s+pr\s+merge\b/（仿
  //     pr-gate.mjs 的 isPrCreateCommand）。
  //   isGitMergeCommand(cmd) → boolean：stripQuotedValues(cmd) 後比對 /\bgit\s+merge\b/（不判斷
  //     branch，branch 判斷交給 classifyMergeCommand／呼叫端）。
  //   isMainBranch(branch) → boolean：branch === 'main' || branch === 'master'（非字串一律 false）。
  //   isPushToMainDestination(cmd) → boolean：對『原始未剝殼』cmd 判——確認是 git push 後抽
  //     destination（refspec 冒號右側／bare positional／--delete 值）比對
  //     master｜main｜refs/heads/master｜refs/heads/main。
  //   isApiPutMergeCommand(cmd) → boolean：對『原始未剝殼』cmd 判——gh api ＋ (-X PUT｜--method PUT)
  //     ＋路徑含 /pulls/ 且含 /merge（AND，不要求鄰接）。
  {
    let classifyPrMerge, classifyGitMergeMaster, classifyGitMergeFeature, classifyPush, classifyApi, classifyNone;
    try {
      classifyPrMerge = mergeGuardModule.classifyMergeCommand('gh pr merge 1 --squash', 'master');
      classifyGitMergeMaster = mergeGuardModule.classifyMergeCommand('git merge x', 'master');
      classifyGitMergeFeature = mergeGuardModule.classifyMergeCommand('git merge x', 'some-feature');
      classifyPush = mergeGuardModule.classifyMergeCommand('git push origin master', 'some-feature');
      classifyApi = mergeGuardModule.classifyMergeCommand('gh api repos/x/y/pulls/1/merge -X PUT', 'some-feature');
      classifyNone = mergeGuardModule.classifyMergeCommand('git status', 'master');
    } catch {
      classifyPrMerge = classifyGitMergeMaster = classifyGitMergeFeature = classifyPush = classifyApi = classifyNone = undefined;
    }
    assert(classifyPrMerge === 'pr-merge', "[M6-1] classifyMergeCommand('gh pr merge 1 --squash', 'master') === 'pr-merge'");
    assert(classifyGitMergeMaster === 'git-merge-main', "[M6-2] classifyMergeCommand('git merge x', 'master') === 'git-merge-main'");
    assert(classifyGitMergeFeature === null, "[M6-3] classifyMergeCommand('git merge x', 'some-feature') === null（非主幹分支，D2 放行）");
    assert(classifyPush === 'push-main', "[M6-4] classifyMergeCommand('git push origin master', 'some-feature') === 'push-main'（③與分支無關，即使 branch 非主幹仍命中）");
    assert(classifyApi === 'api-put-merge', "[M6-5] classifyMergeCommand('gh api repos/x/y/pulls/1/merge -X PUT', 'some-feature') === 'api-put-merge'");
    assert(classifyNone === null, "[M6-6] classifyMergeCommand('git status', 'master') === null（無型別命中）");
  }
  {
    let masterResult, mainResult, featureResult, nullResult;
    try {
      masterResult = mergeGuardModule.isMainBranch('master');
      mainResult = mergeGuardModule.isMainBranch('main');
      featureResult = mergeGuardModule.isMainBranch('some-feature');
      nullResult = mergeGuardModule.isMainBranch(null);
    } catch {
      masterResult = mainResult = featureResult = nullResult = undefined;
    }
    assert(masterResult === true, "[M6-7] isMainBranch('master') === true");
    assert(mainResult === true, "[M6-8] isMainBranch('main') === true");
    assert(featureResult === false, "[M6-9] isMainBranch('some-feature') === false");
    assert(nullResult === false, '[M6-10] isMainBranch(null) === false（非字串防呆）');
  }
  {
    let quotedResult, bareResult;
    try {
      quotedResult = mergeGuardModule.isPrMergeCommand('gh issue comment 5 --body "gh pr merge 前要過 review"');
      bareResult = mergeGuardModule.isPrMergeCommand('gh pr merge');
    } catch {
      quotedResult = bareResult = undefined;
    }
    assert(quotedResult === false,
      '[M6-11] isPrMergeCommand(\'gh issue comment ... --body "...gh pr merge..."\') === false'
      + '（引號內文，剝殼視圖防誤判，同 #132 Q1 課）');
    assert(bareResult === true, "[M6-12] isPrMergeCommand('gh pr merge')（裸指令）=== true");
  }
  {
    let quotedRefspec, deleteMaster;
    try {
      quotedRefspec = mergeGuardModule.isPushToMainDestination('git push origin "HEAD:master"');
      deleteMaster = mergeGuardModule.isPushToMainDestination('git push origin --delete master');
    } catch {
      quotedRefspec = deleteMaster = undefined;
    }
    assert(quotedRefspec === true,
      '[M6-13] isPushToMainDestination(\'git push origin "HEAD:master"\') === true（原始字串比對，引號不影響 destination 判定）');
    assert(deleteMaster === true, "[M6-14] isPushToMainDestination('git push origin --delete master') === true");
  }
  {
    let quotedPath, getPath;
    try {
      quotedPath = mergeGuardModule.isApiPutMergeCommand('gh api -X PUT "repos/x/y/pulls/1/merge"');
      getPath = mergeGuardModule.isApiPutMergeCommand('gh api repos/x/y/pulls/1/merge');
    } catch {
      quotedPath = getPath = undefined;
    }
    assert(quotedPath === true,
      '[M6-15] isApiPutMergeCommand(\'gh api -X PUT "repos/x/y/pulls/1/merge"\') === true（路徑被引號包住，原始字串比對仍抓到）');
    assert(getPath === false, "[M6-16] isApiPutMergeCommand('gh api repos/x/y/pulls/1/merge')（無 PUT）=== false");
  }

  // =============================================================================
  // N —— verify 二次仲裁回饋補充：#133 現況 bug 案例（等 impl 修，預期紅）＋ characterization/直測
  // 補齊（預期即綠）。N1–N4 記錄的是「現況行為」不是「目標行為」——impl 修好後才會轉綠；N5–N7 是
  // 覆蓋率補齊與既有正確行為的防退化釘住，本來就該綠。
  // =============================================================================

  // -----------------------------------------------------------------------------
  // N1/N1b/N1c —— isPushToMainDestination 的 fallback（isMainRefLike(lastShellToken(cmd))）只看
  // 字串「最後一個 token」；真正目的地 master/main 若後面還接尾隨 flag（--force-with-lease／-f／
  // --set-upstream），這條 fallback 就抓不到目的地（REFSPEC_MAIN_RE 無冒號不中、DELETE_MAIN_RE 無
  // --delete 不中）→ 現況誤放行（應 deny 卻 allow）＝紅。黑箱＋M6 純函式各補。
  // -----------------------------------------------------------------------------
  {
    const res = runHook({ command: 'git push origin master --force-with-lease', cwd: NEUTRAL_CWD });
    assert(isDeny(res), '[N1-1] "git push origin master --force-with-lease"（目的地後夾尾隨 flag）→ deny（現況預期紅：lastShellToken 被 --force-with-lease 打穿）');
  }
  {
    const res = runHook({ command: 'git push origin master -f', cwd: NEUTRAL_CWD });
    assert(isDeny(res), '[N1b-1] "git push origin master -f" → deny（現況預期紅：lastShellToken 被 -f 打穿）');
  }
  {
    const res = runHook({ command: 'git push origin main --set-upstream', cwd: NEUTRAL_CWD });
    assert(isDeny(res), '[N1c-1] "git push origin main --set-upstream" → deny（現況預期紅：lastShellToken 被 --set-upstream 打穿）');
  }
  {
    let r1, r2, r3;
    try {
      r1 = mergeGuardModule.isPushToMainDestination('git push origin master --force-with-lease');
      r2 = mergeGuardModule.isPushToMainDestination('git push origin master -f');
      r3 = mergeGuardModule.isPushToMainDestination('git push origin main --set-upstream');
    } catch {
      r1 = r2 = r3 = undefined;
    }
    assert(r1 === true, "[N1-2] isPushToMainDestination('git push origin master --force-with-lease') === true（現況預期紅）");
    assert(r2 === true, "[N1b-2] isPushToMainDestination('git push origin master -f') === true（現況預期紅）");
    assert(r3 === true, "[N1c-2] isPushToMainDestination('git push origin main --set-upstream') === true（現況預期紅）");
  }

  // -----------------------------------------------------------------------------
  // N2 —— 多 ref push（git push 支援一次推多個 ref），master 不是最後一個位置引數：同 N1 病根，
  // lastShellToken 只看字串尾端的 "gh-pages"，真正高風險的 master 目的地夾在中間被漏判 → 現況誤
  // 放行＝紅。
  // -----------------------------------------------------------------------------
  {
    const res = runHook({ command: 'git push origin master gh-pages', cwd: NEUTRAL_CWD });
    assert(isDeny(res), '[N2-1] "git push origin master gh-pages"（多 ref，master 非最後）→ deny（現況預期紅）');
  }
  {
    let r;
    try {
      r = mergeGuardModule.isPushToMainDestination('git push origin master gh-pages');
    } catch {
      r = undefined;
    }
    assert(r === true, "[N2-2] isPushToMainDestination('git push origin master gh-pages') === true（現況預期紅）");
  }

  // -----------------------------------------------------------------------------
  // N3 —— REFSPEC_MAIN_RE 對「原始未剝殼字串」做全字串冒號掃描，本意抓 refspec（如 `any:master`），
  // 但 --push-option="note:master" 這種選項值裡湊巧也有「冒號+master」圖樣、又緊接收尾引號（符合
  // lookahead），造成誤中；真正目的地其實是安全的 feature-x → 現況誤擋（應 allow 卻 deny）＝紅。
  // -----------------------------------------------------------------------------
  {
    const res = runHook({ command: 'git push origin feature-x --push-option="note:master"', cwd: NEUTRAL_CWD });
    assert(isAllow(res), '[N3-1] \'git push origin feature-x --push-option="note:master"\'（真正目的地安全，選項值誤含冒號+master 圖樣）→ 放行（現況預期紅：REFSPEC_MAIN_RE 全字串誤中）');
  }
  {
    let r;
    try {
      r = mergeGuardModule.isPushToMainDestination('git push origin feature-x --push-option="note:master"');
    } catch {
      r = undefined;
    }
    assert(r === false, '[N3-2] isPushToMainDestination(\'git push origin feature-x --push-option="note:master"\') === false（現況預期紅）');
  }

  // -----------------------------------------------------------------------------
  // N4 —— isApiPutMergeCommand 對路徑用裸 cmd.includes('/merge')；"/pulls/1/mergeable" 這個查詢
  // mergeable 狀態的合法端點字面上就以 "/merge" 開頭（mergeable = merge + able），被 includes 誤中
  // → 現況誤擋（應 allow 卻 deny）＝紅。
  // -----------------------------------------------------------------------------
  {
    const res = runHook({ command: 'gh api repos/x/y/pulls/1/mergeable -X PUT', cwd: NEUTRAL_CWD });
    assert(isAllow(res), '[N4-1] "gh api repos/x/y/pulls/1/mergeable -X PUT"（查 mergeable 狀態，非真正合併端點）→ 放行（現況預期紅：裸 includes("/merge") 誤中 "/mergeable"）');
  }
  {
    let r;
    try {
      r = mergeGuardModule.isApiPutMergeCommand('gh api repos/x/y/pulls/1/mergeable -X PUT');
    } catch {
      r = undefined;
    }
    assert(r === false, '[N4-2] isApiPutMergeCommand(\'gh api repos/x/y/pulls/1/mergeable -X PUT\') === false（現況預期紅）');
  }

  // -----------------------------------------------------------------------------
  // N5 —— isGitMergeCommand 直測補齊：五個 export 純函式中唯一只被 classifyMergeCommand 間接覆蓋、
  // 沒有獨立直測案例的一個（同 M6 對其餘四個純函式的直測規格）。行為現況已正確，非 bug——這裡只補
  // 測試覆蓋率，預期本來就綠。
  // -----------------------------------------------------------------------------
  {
    let quoted, bare;
    try {
      quoted = mergeGuardModule.isGitMergeCommand('gh issue comment 5 --body "...git merge..."');
      bare = mergeGuardModule.isGitMergeCommand('git merge x');
    } catch {
      quoted = bare = undefined;
    }
    assert(quoted === false,
      '[N5-1] isGitMergeCommand(\'gh issue comment 5 --body "...git merge..."\') === false（引號內文，剝殼視圖防誤判）');
    assert(bare === true, "[N5-2] isGitMergeCommand('git merge x') === true（裸指令）");
  }

  // -----------------------------------------------------------------------------
  // N6 —— 對照組釘住：這三條在現況（N1 修前）已經是 deny，理由是它們各自另外命中 REFSPEC_MAIN_RE／
  // DELETE_MAIN_RE 的全字串掃描（不依賴 lastShellToken），與 N1 的病根無關。修 N1 時若誤動了這兩條
  // 既有 regex 的比對範圍，這裡會先破——釘住現況、防退化。
  // -----------------------------------------------------------------------------
  {
    const res = runHook({ command: 'git push --force origin master', cwd: NEUTRAL_CWD });
    assert(isDeny(res), '[N6-1] "git push --force origin master"（master 仍是最後一個 token）→ deny（現況已綠，修 N1 後仍須維持）');
  }
  {
    const res = runHook({ command: 'git push origin any:master --force', cwd: NEUTRAL_CWD });
    assert(isDeny(res), '[N6-2] "git push origin any:master --force"（REFSPEC_MAIN_RE 命中，與 lastShellToken 無關）→ deny（現況已綠，修 N1 後仍須維持）');
  }
  {
    const res = runHook({ command: 'git push origin --delete master --force', cwd: NEUTRAL_CWD });
    assert(isDeny(res), '[N6-3] "git push origin --delete master --force"（DELETE_MAIN_RE 命中，與 lastShellToken 無關）→ deny（現況已綠，修 N1 後仍須維持）');
  }

  // -----------------------------------------------------------------------------
  // N7 —— git push（無參數）：已知設計取捨——不解析 remote.origin.*/branch.*.merge 等 git config
  // 判斷「無參數 push 實際會推到哪個分支」，一律放行（fail-open 精神的延伸：判不出目的地就不擋）。
  // 釘住現況、防修 N1 時被連帶改成誤擋。
  // -----------------------------------------------------------------------------
  {
    const res = runHook({ command: 'git push', cwd: NEUTRAL_CWD });
    assert(isAllow(res), '[N7-1] "git push"（無參數，目的地依賴 git config，不解析）→ 放行（已知設計取捨，釘住現況）');
  }

  // -----------------------------------------------------------------------------
  // N8/N8b —— contract 軸實跑重現的 P1：isGitMergeCommand 的 /\bgit\s+merge\b/ 邊界對 "-" 這種非
  // word 字元一樣成立（\b 只要求 word/非word 字元轉換，"e" 與 "-" 之間就有邊界），導致 `git merge-base`
  // /`git merge-tree`（真正的唯讀查詢類子指令，不是合併動作）被誤判成 `git merge`。cwd 在主幹時
  // 因而誤 deny → 現況預期紅。
  // -----------------------------------------------------------------------------
  {
    const res = runHook({ command: 'git merge-base HEAD origin/master', cwd: MASTER_ROOT });
    assert(isAllow(res), '[N8-1] cwd 所在分支=master ＋ "git merge-base HEAD origin/master"（查共同祖先，非真的合併）→ 放行（現況預期紅：\\bgit\\s+merge\\b 邊界誤中 merge-base）');
  }
  {
    let mergeBase, mergeTree;
    try {
      mergeBase = mergeGuardModule.isGitMergeCommand('git merge-base a b');
      mergeTree = mergeGuardModule.isGitMergeCommand('git merge-tree x');
    } catch {
      mergeBase = mergeTree = undefined;
    }
    assert(mergeBase === false, "[N8b-1] isGitMergeCommand('git merge-base a b') === false（現況預期紅：merge-base 被誤中）");
    assert(mergeTree === false, "[N8b-2] isGitMergeCommand('git merge-tree x') === false（現況預期紅：merge-tree 被誤中）");
  }
} finally {
  rmSync(SANDBOX, { recursive: true, force: true });
}

const total = passed + failed.length;
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
console.log(`(共 ${total} 條斷言：M1=接線／M2=四型deny／M3=誤擋明單／M4=escape+flag語意／M5=fail-open／M6=純函式直測)`);
process.exit(failed.length > 0 ? 1 : 0);
