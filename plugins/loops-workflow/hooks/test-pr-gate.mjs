#!/usr/bin/env node
// test-pr-gate.mjs —— pr-gate.mjs（PreToolUse Bash|PowerShell deny hook，#132）紅綠斷言
// （自帶極簡 harness，仿同目錄 test-worktree-guard.mjs 的 tmp sandbox 模式，不引測試框架）。
//
// 用法（cwd = plugins/loops-workflow）：node hooks/test-pr-gate.mjs
// 全綠 → exit 0；任一斷言失敗 → exit 1。
//
// （紅綠軌跡：T1 期 pr-gate.mjs 尚未存在、本檔全紅；T2 實作後 P1–P8／EXTRA 轉綠；verify 修正輪
// 再加 Q1–Q8。）不對 pr-gate.mjs 做「靜態具名 import」（家族其他檔案對已存在的 hook 會這樣
// 做，見 test-worktree-guard.mjs 頂部）——靜態 import 一個不存在的檔案會在模組載入期就
// ERR_MODULE_NOT_FOUND、讓整個測試檔連一條斷言都跑不完就崩潰，連不依賴 pr-gate.mjs 是否存在
// 的 P1（hooks.json 接線檢查）都會被悶掉。改用 spawnSync 真跑（IO 黑箱）＋唯一一處動態
// `await import()`（見下方「動態 import 安全探測」，try/catch 包住）——兩者都確保檔案不存在
// 時本檔仍完整跑完、印出逐條紅燈，而不是一次性崩潰。
//
// 被測物契約摘要（見 issue #132 / .loops/132-pr-gate/stages/02-plan.md）：
//   payload：{session_id?, cwd, tool_input:{command}}（PreToolUse Bash|PowerShell 同形）。
//   旗標 LOOPS_PR_GATE（defaultOn；僅字面 '0' 關閉）。
//   判定流程：
//     1) 非 `gh pr create` 指令 → 放行。
//     2) loop branch 判定：①cwd 路徑含 .claude/worktrees/<slug> 段 → slug；②否則讀 cwd 上溯的
//        .git（檔案形 `gitdir: <path>` → 讀該 gitdir/HEAD；目錄形 → 讀 .git/HEAD）取
//        `ref: refs/heads/<branch>` → branch=slug。判不出（含 detached HEAD 裸 SHA）→ 放行。
//     3) slug 反查：向上找 .loops/<slug>/loop.md（worktree cwd 剝 .claude/worktrees/<slug> 後綴
//        取主根捷徑；≤12 層）——不存在 → 放行（非 loop branch）。
//     4) 三閘（依序、命中即 deny）：
//        ①stages/04-verify.md 不存在 → deny 含「verify」語意
//        ②cmd 缺 --draft 或缺 --assignee @me → deny 附補救指令（含完整旗標寫法）
//        ③slug 匹配 ^(\d+)- 時：body（--body/--body-file，經 stripCode 去 code span 後）無
//          行首 Closes #<該號> → deny 含「Closes」
//     5) LOOPS_PR_GATE='0' → 完全放行；壞 payload / 任何讀檔失敗 → 放行（fail-open）。
//   重用件（不在本檔測——見供應方各自 test 檔）：extractCommentBody/stripCode/
//   makeHardenedReadFileSafe（outbound-comment-guard.mjs）、findLoopRoot/extractWorktreeSlug
//   （worktree-guard.mjs）、flagEnabled（hook-flags.mjs）。

import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = join(HERE, 'pr-gate.mjs'); // 真跑的 hook（目前不存在——見檔頭說明）

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
// 動態 import 安全探測（案例清單「新 export 動態 import 隔離」）
// =============================================================================
// pr-gate.mjs 現在不存在：existsSync 斷言現況預期紅、實作補齊後轉綠（方向正確的紅燈）。
// 動態 import 除了示範「即使嘗試把它當 ES module 載入也不會讓本檔崩潰」，也把 module 物件存進
// prGateModule，供後面 Q5–Q8（純函式特徵化直測，#132 verify 回饋批）用；P1–P8/EXTRA/WIN 一律
// 仍走 spawnSync 黑箱驗證（三閘的可觀察契約在 payload→輸出的行為層級，不因為 module 可 import
// 就改直測）。
let prGateModule = null;
try {
  prGateModule = await import('./pr-gate.mjs');
} catch (e) {
  console.error(`  (pr-gate.mjs 動態 import 失敗——預期中，檔案尚未建立：${e && e.message})`);
}
assert(existsSync(HOOK_SCRIPT), 'hooks/pr-gate.mjs 檔案存在（下面所有 IO 層案例的前提）[exist]');

// =============================================================================
// P1 —— hooks.json 接線斷言（#130/#131 慣例；現況紅：尚未掛載）
// =============================================================================
{
  const hooksConfig = JSON.parse(readFileSync(new URL('./hooks.json', import.meta.url), 'utf8'));
  const preToolUse = hooksConfig.hooks.PreToolUse || [];
  const entry = preToolUse.find((e) =>
    (e.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes('pr-gate.mjs')));
  const matcher = entry?.matcher;
  const safeTest = (re, s) => typeof re === 'string' && new RegExp(re).test(s); // 防 matcher undefined 時
    // new RegExp(undefined) 被當成空字串 pattern、對任何字串都 match 造成假綠

  assert(typeof matcher === 'string', '[P1-1] hooks.json 的 PreToolUse 找得到 pr-gate.mjs 所在 entry（現況預期紅——尚未掛載）');
  assert(matcher === 'Bash|PowerShell', '[P1-2] matcher 精確等於 "Bash|PowerShell"（防截斷值假綠）');
  assert(safeTest(matcher, 'Bash') === true, '[P1-3] matcher 對 "Bash" match');
  assert(safeTest(matcher, 'PowerShell') === true, '[P1-4] matcher 對 "PowerShell" match（#130 慣例：主 shell 不留守衛盲區）');

  const commands = (entry?.hooks || [])
    .map((h) => (typeof h.command === 'string' ? h.command : ''))
    .filter(Boolean);
  const idxComment = commands.findIndex((c) => c.includes('outbound-comment-guard.mjs'));
  const idxWorktree = commands.findIndex((c) => c.includes('worktree-guard.mjs'));
  const idxPrGate = commands.findIndex((c) => c.includes('pr-gate.mjs'));
  assert(idxPrGate !== -1, '[P1-5] 同 entry 內找得到 pr-gate.mjs 的 command');
  assert(
    idxComment !== -1 && idxWorktree !== -1 && idxComment < idxWorktree && idxWorktree < idxPrGate,
    '[P1-6] 同 entry 內順序：outbound-comment-guard → worktree-guard → pr-gate（plan §2 拍板順序）',
  );
}

// =============================================================================
// Fixture 佈局（tmp sandbox，try/finally 清理，仿 test-worktree-guard.mjs）
// =============================================================================
const SANDBOX = join(tmpdir(), `prg-${process.pid}`);

try {
  // NEUTRAL_CWD：子行程真實 OS cwd 固定在此中性空目錄——避免 payload.cwd 缺失/非字串時 main()
  // fallback 到 process.cwd() 意外撞到「本測試執行位置」真實環境的 .loops 祖先（本專案的
  // hooks/ 目錄本身常態就活在某個 loop worktree 底下）。
  const NEUTRAL_CWD = join(SANDBOX, 'neutral');
  mkdirSync(NEUTRAL_CWD, { recursive: true });

  // Fixture 1：worktree 形、slug=210-foo、完整（04-verify 有）—— gate②③ 綠案例／各閘隔離用底。
  const WT_ROOT = join(SANDBOX, 'wt-repo-full');
  const WT_CWD_FULL = join(WT_ROOT, '.claude', 'worktrees', '210-foo');
  mkdirSync(join(WT_ROOT, '.loops', '210-foo', 'stages'), { recursive: true });
  writeFileSync(join(WT_ROOT, '.loops', '210-foo', 'loop.md'), '# Loop: 210-foo\n');
  writeFileSync(join(WT_ROOT, '.loops', '210-foo', 'stages', '04-verify.md'), '# verify\n');
  mkdirSync(WT_CWD_FULL, { recursive: true });

  // Fixture 2：worktree 形、slug=211-noverify、缺 stages/04-verify.md —— gate① 紅案例。
  const WT_ROOT_NV = join(SANDBOX, 'wt-repo-noverify');
  const WT_CWD_NV = join(WT_ROOT_NV, '.claude', 'worktrees', '211-noverify');
  mkdirSync(join(WT_ROOT_NV, '.loops', '211-noverify'), { recursive: true });
  writeFileSync(join(WT_ROOT_NV, '.loops', '211-noverify', 'loop.md'), '# Loop\n');
  mkdirSync(WT_CWD_NV, { recursive: true });

  // Fixture 3：worktree 形、design slug（無數字前綴）、完整 —— gate③ 條件式停用驗證用。
  const WT_ROOT_DESIGN = join(SANDBOX, 'wt-repo-design');
  const WT_CWD_DESIGN = join(WT_ROOT_DESIGN, '.claude', 'worktrees', 'design-foo');
  mkdirSync(join(WT_ROOT_DESIGN, '.loops', 'design-foo', 'stages'), { recursive: true });
  writeFileSync(join(WT_ROOT_DESIGN, '.loops', 'design-foo', 'loop.md'), '# Loop\n');
  writeFileSync(join(WT_ROOT_DESIGN, '.loops', 'design-foo', 'stages', '04-verify.md'), '# verify\n');
  mkdirSync(WT_CWD_DESIGN, { recursive: true });

  // Fixture 4：主 checkout 形（.git 目錄形），HEAD → refs/heads/210-foo，完整。
  const MAIN_ROOT = join(SANDBOX, 'main-repo-210');
  mkdirSync(join(MAIN_ROOT, '.git'), { recursive: true });
  writeFileSync(join(MAIN_ROOT, '.git', 'HEAD'), 'ref: refs/heads/210-foo\n');
  mkdirSync(join(MAIN_ROOT, '.loops', '210-foo', 'stages'), { recursive: true });
  writeFileSync(join(MAIN_ROOT, '.loops', '210-foo', 'loop.md'), '# Loop\n');
  writeFileSync(join(MAIN_ROOT, '.loops', '210-foo', 'stages', '04-verify.md'), '# verify\n');

  // Fixture 5：主 checkout 形，HEAD → refs/heads/master（無對應 .loops/master/）。
  const MAIN_ROOT_MASTER = join(SANDBOX, 'main-repo-master');
  mkdirSync(join(MAIN_ROOT_MASTER, '.git'), { recursive: true });
  writeFileSync(join(MAIN_ROOT_MASTER, '.git', 'HEAD'), 'ref: refs/heads/master\n');

  // Fixture 6：主 checkout 形，detached HEAD（裸 SHA，無 ref: 前綴）。
  const MAIN_ROOT_DETACHED = join(SANDBOX, 'main-repo-detached');
  mkdirSync(join(MAIN_ROOT_DETACHED, '.git'), { recursive: true });
  writeFileSync(join(MAIN_ROOT_DETACHED, '.git', 'HEAD'), 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\n');

  // Fixture 7：主 checkout 形，HEAD 指向一個「無對應 .loops」的一般 branch（非 loop branch）。
  const MAIN_ROOT_OTHER = join(SANDBOX, 'main-repo-other-branch');
  mkdirSync(join(MAIN_ROOT_OTHER, '.git'), { recursive: true });
  writeFileSync(join(MAIN_ROOT_OTHER, '.git', 'HEAD'), 'ref: refs/heads/some-other-branch\n');

  // Fixture 8：檔案形 .git（cwd 不在 .claude/worktrees/ 慣例路徑下、需靠②讀 gitdir 兜底）。
  // 佈局：FILEFORM_MAIN 是「真主根」（.loops 在這）；external-wt 巢狀其下但不經過
  // .claude/worktrees/ 段——① path-segment 規則不 match，落到②讀 .git 檔案形。
  const FILEFORM_MAIN = join(SANDBOX, 'fileform-main');
  const FILEFORM_GITDIR = join(FILEFORM_MAIN, '.git', 'worktrees', 'wt1');
  mkdirSync(FILEFORM_GITDIR, { recursive: true });
  writeFileSync(join(FILEFORM_GITDIR, 'HEAD'), 'ref: refs/heads/210-foo\n');
  mkdirSync(join(FILEFORM_MAIN, '.loops', '210-foo', 'stages'), { recursive: true });
  writeFileSync(join(FILEFORM_MAIN, '.loops', '210-foo', 'loop.md'), '# Loop\n');
  writeFileSync(join(FILEFORM_MAIN, '.loops', '210-foo', 'stages', '04-verify.md'), '# verify\n');
  const FILEFORM_WT_CWD = join(FILEFORM_MAIN, 'external-wt');
  mkdirSync(FILEFORM_WT_CWD, { recursive: true });
  writeFileSync(join(FILEFORM_WT_CWD, '.git'), `gitdir: ${FILEFORM_GITDIR}\n`);

  // Fixture 9（Q3 用）：複用 Fixture 4 的 MAIN_ROOT（.git 目錄形、HEAD → refs/heads/210-foo、
  // .loops 齊備），cwd 改指到 root 底下一個實際建立的子目錄（非 root 本身）——驗 readGitBranch
  // 是否會往上找 .git，不能只查 cwd 自身這一層。
  const MAIN_ROOT_SUBDIR_CWD = join(MAIN_ROOT, 'some', 'subdir');
  mkdirSync(MAIN_ROOT_SUBDIR_CWD, { recursive: true });

  // Body 內容（多行，含/不含行首 Closes）＋ --body-file 用的 tmp 檔。
  const OK_BODY = '## 成果\n\nCloses #210\n\n修好了 A、B、C 三個問題。';
  const MIDLINE_CLOSES_BODY = '## 成果\n\n這個 PR 修好了 A/B/C，Closes #210 順便也修掉。';
  // 刻意用「fenced code block」而非 inline code span：若整行只包在單一反引號內（`Closes #210`），
  // 該行第一個字元是反引號、本來就不會被任何「行首純文字 Closes」規則誤判，無法真正驗到
  // 「有沒有做 stripCode」這件事（漏做 stripCode 的錯誤實作也會巧合地 deny，測不出差異）。
  // fenced block 內部這行「Closes #210」在原始字串裡才真的是行首（前一個字元是換行、不是反引號）
  // ——不做 stripCode 就會被誤判為有效關聯、錯誤放行；有做才會在去掉整個 fence 後正確 deny。
  const CODESPAN_CLOSES_BODY = '## 成果\n\n```text\nCloses #210\n```\n\n（上面是範例程式碼區塊，不是真的要關這個 issue）';
  const NO_CLOSES_AT_ALL_BODY = '詳見 ## 成果，closes 見文中';
  const bodyFilePath = join(SANDBOX, 'pr-body-ok.md');
  writeFileSync(bodyFilePath, OK_BODY);

  function runHook({ command, cwd, env = {}, rawInput } = {}) {
    const input = rawInput !== undefined ? rawInput : JSON.stringify({ cwd, tool_input: { command } });
    const mergedEnv = { ...process.env, ...env };
    // 防 ambient shell 環境殘留 LOOPS_PR_GATE 汙染斷言——預設不繼承呼叫本檔那個 shell 的既有值，
    // 僅呼叫端在 env 明確傳入 LOOPS_PR_GATE 時才保留（P7-1/P7-4 走這條）。P7-5 測「完全未設旗標」
    // 語意另有專屬手刻 spawnSync（不經過本函式），不受此變動影響。
    if (!('LOOPS_PR_GATE' in env)) delete mergedEnv.LOOPS_PR_GATE;
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
  // P2 —— 三閘紅案例（worktree 形 cwd）
  // ===========================================================================

  // ── P2① 無 04-verify.md → deny「verify」（otherwise 全合規，隔離出這一閘）───────
  {
    const cmd = `gh pr create --draft --assignee @me --title t --body "${OK_BODY}"`;
    const res = runHook({ command: cmd, cwd: WT_CWD_NV });
    assert(res.error == null && res.status === 0, '[P2①-1] spawn 無 error、exit 0');
    const p = parseOut(res);
    assert(p?.hookSpecificOutput?.hookEventName === 'PreToolUse', '[P2①-2] hookEventName === "PreToolUse"（信封形狀，首例代表全體）');
    assert(isDeny(res), '[P2①-3] 缺 stages/04-verify.md → deny');
    assert(reasonOf(res).includes('verify'), '[P2①-4] reason 含「verify」語意');
  }

  // ── P2② 有 04-verify 但缺 draft/assignee → deny 附補救（三種缺法各自隔離）──────
  {
    const noDraft = `gh pr create --assignee @me --title t --body "${OK_BODY}"`;
    const res = runHook({ command: noDraft, cwd: WT_CWD_FULL });
    assert(isDeny(res), '[P2②-1] 缺 --draft → deny');
    assert(reasonOf(res).includes('--draft') && reasonOf(res).includes('--assignee @me'),
      '[P2②-2] reason 附補救指令、含完整旗標寫法（--draft 與 --assignee @me 皆出現）');
  }
  {
    const noAssignee = `gh pr create --draft --title t --body "${OK_BODY}"`;
    const res = runHook({ command: noAssignee, cwd: WT_CWD_FULL });
    assert(isDeny(res), '[P2②-3] 缺 --assignee @me → deny');
    assert(reasonOf(res).includes('--draft') && reasonOf(res).includes('--assignee @me'),
      '[P2②-4] reason 附補救指令、含完整旗標寫法');
  }
  {
    const wrongAssignee = `gh pr create --draft --assignee someone-else --title t --body "${OK_BODY}"`;
    const res = runHook({ command: wrongAssignee, cwd: WT_CWD_FULL });
    assert(isDeny(res), '[P2②-5] --assignee 不是字面 "@me"（給了別人）→ deny');
  }

  // ── P2③ 全參數齊但 body 無行首 Closes（三種形狀各自 deny）────────────────────
  {
    const res = runHook({
      command: `gh pr create --draft --assignee @me --title t --body "${MIDLINE_CLOSES_BODY}"`,
      cwd: WT_CWD_FULL,
    });
    assert(isDeny(res), '[P2③-1] "Closes #210" 出現在行中（非行首）→ deny');
    assert(reasonOf(res).includes('Closes'), '[P2③-2] reason 含「Closes」語意');
  }
  {
    const res = runHook({
      command: `gh pr create --draft --assignee @me --title t --body "${CODESPAN_CLOSES_BODY}"`,
      cwd: WT_CWD_FULL,
    });
    assert(isDeny(res), '[P2③-3] "Closes #210" 只出現在 fenced code block 內（stripCode 去 fence 後消失）→ deny');
    assert(reasonOf(res).includes('Closes'), '[P2③-4] reason 含「Closes」語意');
  }
  {
    const res = runHook({
      command: `gh pr create --draft --assignee @me --title t --body "${NO_CLOSES_AT_ALL_BODY}"`,
      cwd: WT_CWD_FULL,
    });
    assert(isDeny(res), '[P2③-5]（team lead 範例）"詳見 ## 成果，closes 見文中" → deny');
    assert(reasonOf(res).includes('Closes'), '[P2③-6] reason 含「Closes」語意');
  }

  // ===========================================================================
  // P3 —— 綠案例：全合規（inline body ＋ --body-file 兩形）
  // ===========================================================================
  {
    const res = runHook({
      command: `gh pr create --draft --assignee @me --title t --body "${OK_BODY}"`,
      cwd: WT_CWD_FULL,
    });
    assert(isAllow(res), '[P3-1] 全合規（inline --body，行首 Closes #210）→ 放行（空 stdout、exit 0）');
  }
  {
    const res = runHook({
      command: `gh pr create --draft --assignee @me --title t --body-file ${bodyFilePath}`,
      cwd: WT_CWD_FULL,
    });
    assert(isAllow(res), '[P3-2] 全合規（--body-file 形）→ 放行');
  }

  // ===========================================================================
  // P4 —— 主 checkout 形（.git 目錄形）：三閘生效（抽 gate③ 驗）＋ HEAD=master 放行
  // ===========================================================================
  {
    const res = runHook({
      command: `gh pr create --draft --assignee @me --title t --body "${NO_CLOSES_AT_ALL_BODY}"`,
      cwd: MAIN_ROOT,
    });
    assert(isDeny(res), '[P4-1] 主 checkout 形（讀 .git/HEAD 判 branch）＋body 無行首 Closes → deny');
    assert(reasonOf(res).includes('Closes'), '[P4-2] reason 含「Closes」語意（gate③ 在主 checkout 形一樣生效）');
  }
  {
    const res = runHook({
      command: 'gh pr create --title t --body "no draft no assignee no closes"', // 若被判 loop branch 會多重違規
      cwd: MAIN_ROOT_MASTER,
    });
    assert(isAllow(res), '[P4-3] HEAD=master（無對應 .loops/master/）→ 放行，即使指令本身不合規');
  }

  // ===========================================================================
  // P5 —— detached HEAD（裸 SHA）→ 放行
  // ===========================================================================
  {
    const res = runHook({
      command: 'gh pr create --title t --body "x"', // 刻意不合規，證明放行不是巧合
      cwd: MAIN_ROOT_DETACHED,
    });
    assert(isAllow(res), '[P5-1] .git/HEAD 為裸 SHA（detached HEAD，判不出 branch）→ 放行（安全 fail-open）');
  }

  // ===========================================================================
  // P6 —— 非 loop branch 放行；非 gh pr create 放行
  // ===========================================================================
  {
    const res = runHook({
      command: 'gh pr create --title t --body "x"', // 刻意不合規
      cwd: MAIN_ROOT_OTHER,
    });
    assert(isAllow(res), '[P6-1] HEAD 指向 refs/heads/some-other-branch（無對應 .loops/）→ 放行');
  }
  {
    const res = runHook({ command: 'gh pr view 1', cwd: WT_CWD_NV }); // 底本身會三閘全違規
    assert(isAllow(res), '[P6-2] 非 "gh pr create"（gh pr view）→ 放行，即使 cwd 底本身違規（指令型判定排在最前）');
  }

  // ===========================================================================
  // P7 —— LOOPS_PR_GATE='0' 逃生；fail-open（壞 payload／缺欄位）；flag 語意（僅字面 '0' 關）
  // ===========================================================================
  {
    const cmd = 'gh pr create --title t --body "x"'; // 違規：缺 draft/assignee/verify
    const res = runHook({ command: cmd, cwd: WT_CWD_NV, env: { LOOPS_PR_GATE: '0' } });
    assert(isAllow(res), "[P7-1] LOOPS_PR_GATE='0' → 即使違規也放行");
  }
  {
    const res = runHook({ rawInput: 'not { json' });
    assert(res.error == null && res.status === 0 && stdoutOf(res).trim() === '',
      '[P7-2] stdin 非 JSON → exit 0、stdout 空（fail-open）');
  }
  {
    const res = runHook({ rawInput: JSON.stringify({ tool_input: {}, cwd: WT_CWD_NV }) });
    assert(res.status === 0 && stdoutOf(res).trim() === '', '[P7-3] 缺 command 欄位 → 放行（fail-open）');
  }
  {
    // 'false'（非字面 '0'）→ 依 hook-flags.mjs 的 defaultOn 語意仍視為啟用 → 應仍 deny。
    const cmd = 'gh pr create --title t --body "x"';
    const res = runHook({ command: cmd, cwd: WT_CWD_NV, env: { LOOPS_PR_GATE: 'false' } });
    assert(isDeny(res), "[P7-4] LOOPS_PR_GATE='false'（非字面 '0'）→ 仍啟用 → deny");
  }
  {
    // 未設 flag → defaultOn → 仍啟用 → deny。
    const env = { ...process.env };
    delete env.LOOPS_PR_GATE;
    const res = spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: JSON.stringify({ cwd: WT_CWD_NV, tool_input: { command: 'gh pr create --title t --body "x"' } }),
      cwd: NEUTRAL_CWD,
      env,
      encoding: 'utf8',
    });
    assert(isDeny(res), '[P7-5] LOOPS_PR_GATE 未設 → defaultOn → deny');
  }

  // ===========================================================================
  // P8 —— design slug（無數字前綴）：gate③ 不啟用，但 gate①②仍照常
  // ===========================================================================
  {
    const res = runHook({
      command: `gh pr create --draft --assignee @me --title t --body "${NO_CLOSES_AT_ALL_BODY}"`,
      cwd: WT_CWD_DESIGN,
    });
    assert(isAllow(res), '[P8-1] slug="design-foo"（不匹配 ^(\\d+)-）→ body 完全沒提 Closes 也放行（gate③ 停用）');
  }
  {
    const res = runHook({
      command: 'gh pr create --title t --body "沒有 draft"', // 缺 --draft/--assignee
      cwd: WT_CWD_DESIGN,
    });
    assert(isDeny(res), '[P8-2] design slug 下 gate②（draft/assignee）仍照常生效——gate③ 停用不是全體豁免');
  }

  // ===========================================================================
  // EXTRA-1 —— 檔案形 .git（cwd 不在 .claude/worktrees/ 慣例路徑下、走②讀 gitdir 兜底）
  // 見 02-plan.md 假設 1：「worktree 的 .git 是檔案…主 checkout 是目錄…T1 fixture 直接構造
  // 兩形釘住」；P4 已釘目錄形，這裡補檔案形。
  // ===========================================================================
  {
    const res = runHook({
      command: 'gh pr create --title t --body "x"', // 缺 draft/assignee
      cwd: FILEFORM_WT_CWD,
    });
    assert(isDeny(res),
      '[EXTRA-1] cwd 不在 .claude/worktrees/ 下、.git 為檔案形（gitdir: 指標）→ 仍正確讀出 branch=210-foo 並套用 gate②');
  }

  // ===========================================================================
  // EXTRA-2 —— 三閘依序、命中即 deny（同時違反多閘時，較前面的閘勝出）
  // ===========================================================================
  {
    // 同時違反①（無 04-verify）與②（無 draft）—— 應回①的訊息，不是②的。
    const res = runHook({ command: 'gh pr create --title t --body "x"', cwd: WT_CWD_NV });
    assert(isDeny(res), '[EXTRA-2a-1] 同時違反①② → deny');
    assert(reasonOf(res).includes('verify') && !reasonOf(res).includes('--draft'),
      '[EXTRA-2a-2] 訊息是①（verify）不是②（--draft 補救）——依序命中即 deny、不聚合');
  }
  {
    // 同時違反②（無 draft）與③（body 無 Closes）、①滿足 —— 應回②的訊息，不是③的。
    const res = runHook({
      command: `gh pr create --title t --body "${NO_CLOSES_AT_ALL_BODY}"`,
      cwd: WT_CWD_FULL,
    });
    assert(isDeny(res), '[EXTRA-2b-1] 同時違反②③ → deny');
    assert(reasonOf(res).includes('--draft') && !reasonOf(res).includes('Closes'),
      '[EXTRA-2b-2] 訊息是②（--draft 補救）不是③（Closes）——②排在③之前');
  }

  // ===========================================================================
  // Windows 路徑（反斜線／正斜線混用 cwd）—— 路徑分隔符正規化不因分隔符形狀誤判
  // ===========================================================================
  {
    // 用正斜線版本餵一個「原生應為反斜線」的路徑（本環境 join() 在 win32 上原生產生反斜線），
    // 驗證 cwd 路徑分隔符正規化在兩個方向都穩：無論 payload 送反斜線或正斜線都要能正確解析
    // .claude/worktrees/<slug> 段。
    const forwardSlashCwd = WT_CWD_FULL.split('\\').join('/');
    const res = runHook({
      command: `gh pr create --draft --assignee @me --title t --body "${OK_BODY}"`,
      cwd: forwardSlashCwd,
    });
    assert(isAllow(res), '[WIN-1] cwd 以正斜線傳入（即使本機原生路徑含反斜線）→ 正確解析、全合規放行');
  }

  // ===========================================================================
  // Q —— verify 三軸回饋批（#132 second-pass）：Q1–Q4 行為修正案例（現況應紅、等 impl 修）＋
  // Q5–Q8 純函式特徵化直測（動態 import 成功後直呼，預期即綠；紅照實回報）。
  // ===========================================================================

  // ── Q1 子字串誤判：isPrCreateCommand 不該對「quoted 內文剛好含 gh pr create 字樣」誤中 ──────
  {
    const cmd = 'gh issue comment 5 --body "流程提醒：先 gh pr create --draft --assignee @me 再等審"';
    const res = runHook({ command: cmd, cwd: WT_CWD_FULL });
    assert(isAllow(res),
      '[Q1] 這是 gh issue comment（非真的 gh pr create，"gh pr create" 只是被引號包住的內文片段）'
      + '→ 放行；現況 isPrCreateCommand 對整條指令字串做子字串比對會誤中、誤套三閘');
  }

  // ── Q2 --assignee 值加引號：hasAssigneeMe 應容忍 "@me" / '@me'，不能只認裸 @me ──────────────
  {
    const cmd = `gh pr create --draft --assignee "@me" --title t --body "${OK_BODY}"`;
    const res = runHook({ command: cmd, cwd: WT_CWD_FULL });
    assert(isAllow(res), '[Q2] --assignee "@me"（雙引號包住，其餘全合規）→ 放行');
  }
  {
    const cmd = `gh pr create --draft --assignee '@me' --title t --body "${OK_BODY}"`;
    const res = runHook({ command: cmd, cwd: WT_CWD_FULL });
    assert(isAllow(res), "[Q2b] --assignee '@me'（單引號包住，其餘全合規）→ 放行");
  }

  // ── Q3 cwd 為主 checkout root 底下的子目錄（非 root 本身）：readGitBranch 應上溯找 .git，───
  // ── 不能只查 cwd 自身這一層；否則判不出 branch、三閘整組被誤放行漏套用。────────────────────
  {
    const noDraft = `gh pr create --assignee @me --title t --body "${OK_BODY}"`;
    const res = runHook({ command: noDraft, cwd: MAIN_ROOT_SUBDIR_CWD });
    assert(isDeny(res),
      '[Q3] cwd=主 checkout root/some/subdir（非 root 本身，.git 不在這層）、缺 --draft → '
      + '仍應判出 branch=210-foo 並套用三閘、gate②deny；現況 readGitBranch 只查 cwd 自身這一層'
      + '（不上溯）→ 判不出分支 → 誤放行');
    assert(reasonOf(res).includes('--draft') && reasonOf(res).includes('--assignee @me'),
      '[Q3-2] deny 理由是 gate②（附補救指令），不是巧合命中其他閘');
  }

  // ── Q4 小寫 closes：GitHub 對 Closes 關鍵字大小寫不敏感，hasClosesLine 應對齊同一語意 ────────
  {
    const lowerClosesBody = '## 成果\n\ncloses #210\n\n修好了 A、B、C 三個問題。';
    const res = runHook({
      command: `gh pr create --draft --assignee @me --title t --body "${lowerClosesBody}"`,
      cwd: WT_CWD_FULL,
    });
    assert(isAllow(res),
      '[Q4] body 行首小寫 "closes #210"（非 "Closes"）→ 放行（拍板對齊 GitHub 大小寫不敏感語意）；'
      + '現況 hasClosesLine 大小寫敏感 → 誤 deny');
  }

  // ── Q5 issueNumberFromSlug／hasClosesLine 的 prefix collision 邊界（(?!\d) 前瞻）─────────────
  // 原 43 條斷言零覆蓋這條邊界；docstring 自述「避免 issue #21 誤配到 Closes #210」，這裡直接
  // 特徵化驗證該保護確實生效。
  {
    let slugNum;
    let closesMatch;
    try {
      slugNum = prGateModule.issueNumberFromSlug('21-foo');
      closesMatch = prGateModule.hasClosesLine('Closes #210 ...', slugNum);
    } catch {
      slugNum = undefined;
      closesMatch = undefined;
    }
    assert(slugNum === '21', '[Q5-1] issueNumberFromSlug("21-foo") === "21"');
    assert(closesMatch === false,
      '[Q5-2] hasClosesLine("Closes #210 ...", "21") === false——issue #21 不該誤配到 '
      + 'body 裡數字前綴相同的 "Closes #210"（(?!\\d) 前瞻邊界）');
  }

  // ── Q6 hasAssigneeMe 的 "=" 形（docstring 明載但原 43 條未驗證）───────────────────────────
  {
    let result;
    try {
      result = prGateModule.hasAssigneeMe('gh pr create --assignee=@me --title t --body x');
    } catch {
      result = undefined;
    }
    assert(result === true, '[Q6] hasAssigneeMe("gh pr create --assignee=@me ...") === true（"=" 形）');
  }

  // ── Q7 端到端：gate①②過＋--body-file 指向不存在路徑 → body 抽不到、跳過 gate③、放行 ────────
  // 02-plan T1「讀檔失敗 fail-open」字面驗收——這不是 bug，是既定設計，這裡釘住不讓未來改壞。
  {
    const missingBodyFile = join(SANDBOX, 'q7-does-not-exist.md'); // 刻意不建立
    const res = runHook({
      command: `gh pr create --draft --assignee @me --title t --body-file ${missingBodyFile}`,
      cwd: WT_CWD_FULL,
    });
    assert(isAllow(res),
      '[Q7] gate①②皆過、--body-file 指向不存在路徑（讀檔失敗）→ body 抽不到、跳過 gate③、放行');
  }

  // ── Q8 純函式邊界小組：isPrCreateCommand 兩極、hasDraftFlag、hasClosesLine 對 CRLF body ─────
  {
    let viewResult;
    let bareCreateResult;
    let draftResult;
    let crlfResult;
    try {
      viewResult = prGateModule.isPrCreateCommand('gh pr view 123');
      bareCreateResult = prGateModule.isPrCreateCommand('gh pr create');
      draftResult = prGateModule.hasDraftFlag('gh pr create --draft --assignee @me');
      crlfResult = prGateModule.hasClosesLine('## 成果\r\nCloses #210\r\n\r\n內文', '210');
    } catch {
      viewResult = bareCreateResult = draftResult = crlfResult = undefined;
    }
    assert(viewResult === false, '[Q8-1] isPrCreateCommand("gh pr view 123") === false（非 create 極）');
    assert(bareCreateResult === true, '[Q8-2] isPrCreateCommand("gh pr create")（裸指令、無其他參數）=== true（create 極）');
    assert(draftResult === true, '[Q8-3] hasDraftFlag("gh pr create --draft --assignee @me") === true');
    assert(crlfResult === true,
      '[Q8-4] hasClosesLine 對 CRLF body（\\r\\n 行首）仍正確比對到 "Closes #210"（^ 錨點只認 \\n，'
      + '\\r 留在前一行尾不影響下一行行首判定）');
  }
} finally {
  rmSync(SANDBOX, { recursive: true, force: true });
}

const total = passed + failed.length;
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
console.log(`(共 ${total} 條斷言：P1–P8／EXTRA／WIN＝三閘與接線契約、Q1–Q8＝verify 修正輪邊界)`);
process.exit(failed.length > 0 ? 1 : 0);
