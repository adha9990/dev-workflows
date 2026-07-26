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
// #152 擴充：新增閘④（真機截圖 receipt，create+ready）＋閘⑤（合併衝突，create+ready+comment）；
//   新增 `gh pr ready`/`gh pr comment` 偵測；三獨立 flag（LOOPS_PR_GATE=①②③、
//   LOOPS_PR_REALRUN_GATE=④、LOOPS_PR_CONFLICT_GATE=⑤）。新斷言：R1–R8（閘④）、C1–C9（閘⑤，
//   stub 注入 gh 會印的 raw JSON、共用同一段 parse；C6 唯一真 gh spawn fail-open）、N1–N8（新純函式
//   直測）。runHook 預設把 LOOPS_PR_CONFLICT_GATE='0' 維持①②③④案例 hermeticity（不 spawn 真 gh）。
//
// 被測物契約摘要（見 issue #132、#152 / .loops/152-pr-gate-realrun-conflict/stages/02-plan.md）：
//   payload：{session_id?, cwd, tool_input:{command}}（PreToolUse Bash|PowerShell 同形）。
//   旗標 LOOPS_PR_GATE / LOOPS_PR_REALRUN_GATE / LOOPS_PR_CONFLICT_GATE（皆 defaultOn；僅字面 '0' 關）。
//   判定流程：
//     1) 非受管 gh pr 指令（create/ready/comment）→ 放行。
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
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync } from 'node:fs';
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

  // 小工具：給某個 loop 補一張真機截圖 receipt（閘④ 通過）。#152 起「全合規 create → 放行」
  // 的完整 loop 定義包含真機驗證截圖，既有 fixture 一併補上，讓既有斷言在閘④ 加入後仍成立。
  const addRealRunShot = (root, slug) => {
    mkdirSync(join(root, '.loops', slug, 'deliverables', 'real-run'), { recursive: true });
    writeFileSync(join(root, '.loops', slug, 'deliverables', 'real-run', 'shot.png'), 'PNGDATA');
  };

  // Fixture 1：worktree 形、slug=210-foo、完整（04-verify + real-run 截圖）—— gate②③⑤ 綠案例／各閘隔離用底。
  const WT_ROOT = join(SANDBOX, 'wt-repo-full');
  const WT_CWD_FULL = join(WT_ROOT, '.claude', 'worktrees', '210-foo');
  mkdirSync(join(WT_ROOT, '.loops', '210-foo', 'stages'), { recursive: true });
  writeFileSync(join(WT_ROOT, '.loops', '210-foo', 'loop.md'), '# Loop: 210-foo\n');
  writeFileSync(join(WT_ROOT, '.loops', '210-foo', 'stages', '04-verify.md'), '# verify\n');
  addRealRunShot(WT_ROOT, '210-foo');
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
  addRealRunShot(WT_ROOT_DESIGN, 'design-foo');
  mkdirSync(WT_CWD_DESIGN, { recursive: true });

  // Fixture 4：主 checkout 形（.git 目錄形），HEAD → refs/heads/210-foo，完整。
  const MAIN_ROOT = join(SANDBOX, 'main-repo-210');
  mkdirSync(join(MAIN_ROOT, '.git'), { recursive: true });
  writeFileSync(join(MAIN_ROOT, '.git', 'HEAD'), 'ref: refs/heads/210-foo\n');
  mkdirSync(join(MAIN_ROOT, '.loops', '210-foo', 'stages'), { recursive: true });
  writeFileSync(join(MAIN_ROOT, '.loops', '210-foo', 'loop.md'), '# Loop\n');
  writeFileSync(join(MAIN_ROOT, '.loops', '210-foo', 'stages', '04-verify.md'), '# verify\n');
  addRealRunShot(MAIN_ROOT, '210-foo');

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
  addRealRunShot(FILEFORM_MAIN, '210-foo');
  const FILEFORM_WT_CWD = join(FILEFORM_MAIN, 'external-wt');
  mkdirSync(FILEFORM_WT_CWD, { recursive: true });
  writeFileSync(join(FILEFORM_WT_CWD, '.git'), `gitdir: ${FILEFORM_GITDIR}\n`);

  // Fixture 9（Q3 用）：複用 Fixture 4 的 MAIN_ROOT（.git 目錄形、HEAD → refs/heads/210-foo、
  // .loops 齊備），cwd 改指到 root 底下一個實際建立的子目錄（非 root 本身）——驗 readGitBranch
  // 是否會往上找 .git，不能只查 cwd 自身這一層。
  const MAIN_ROOT_SUBDIR_CWD = join(MAIN_ROOT, 'some', 'subdir');
  mkdirSync(MAIN_ROOT_SUBDIR_CWD, { recursive: true });

  // ── #152 閘④ real-run receipt fixtures（非數字前綴 slug → gate③ 停用，create 只需 --draft
  //     --assignee @me 即過①②③，把閘④ 隔離成決定者）。都備 04-verify.md（過閘①）。──────────────
  const mkGate4Fixture = (name, slug, setup) => {
    const root = join(SANDBOX, name);
    const cwd = join(root, '.claude', 'worktrees', slug);
    mkdirSync(join(root, '.loops', slug, 'stages'), { recursive: true });
    writeFileSync(join(root, '.loops', slug, 'loop.md'), '# Loop\n');
    writeFileSync(join(root, '.loops', slug, 'stages', '04-verify.md'), '# verify\n');
    mkdirSync(cwd, { recursive: true });
    if (setup) setup(root, slug);
    return cwd;
  };
  const realRunDir = (root, slug) => join(root, '.loops', slug, 'deliverables', 'real-run');
  // 無 real-run 目錄 → 閘④ deny（S1）。
  const WT_CWD_NORUN = mkGate4Fixture('wt-realrun-norun', 'realrun-norun');
  // real-run 目錄存在但全空 → 閘④ deny（S2）。
  const WT_CWD_EMPTYRUN = mkGate4Fixture('wt-realrun-empty', 'realrun-empty', (r, s) => mkdirSync(realRunDir(r, s), { recursive: true }));
  // real-run 內有 .jpeg 截圖 → 閘④ allow（S3 的 jpeg 變體）。
  const WT_CWD_JPG = mkGate4Fixture('wt-realrun-jpg', 'realrun-jpg', (r, s) => { const d = realRunDir(r, s); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'photo.JPEG'), 'JPGDATA'); });
  // real-run 內有非空 no-ui.md → 閘④ allow（S4）。
  const WT_CWD_NOUI = mkGate4Fixture('wt-realrun-noui', 'realrun-noui', (r, s) => { const d = realRunDir(r, s); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'no-ui.md'), '純 hook 改動、無可見畫面；已跑 hook 單元測試驗證。'); });
  // real-run 內只有「空」no-ui.md（0 bytes）→ 閘④ deny（P2-5：純 touch 不算 receipt）。
  const WT_CWD_EMPTYNOUI = mkGate4Fixture('wt-realrun-emptynoui', 'realrun-emptynoui', (r, s) => { const d = realRunDir(r, s); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'no-ui.md'), ''); });
  // real-run 內只有「空」shot.png（0 bytes，等同 touch）→ 閘④ deny（verify F1：截圖與 no-ui 一致擋純 touch）。
  const WT_CWD_EMPTYPNG = mkGate4Fixture('wt-realrun-emptypng', 'realrun-emptypng', (r, s) => { const d = realRunDir(r, s); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'shot.png'), ''); });
  // real-run 內只有「同名子目錄」shot.png（mkdir 而非檔案）→ 閘④ deny（isFile 守衛，verify F1）。
  const WT_CWD_DIRPNG = mkGate4Fixture('wt-realrun-dirpng', 'realrun-dirpng', (r, s) => { mkdirSync(join(realRunDir(r, s), 'shot.png'), { recursive: true }); });

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
    // 防 ambient shell 環境殘留 LOOPS_PR_* 汙染斷言——預設不繼承呼叫本檔那個 shell 的既有值，
    // 僅呼叫端在 env 明確傳入時才保留（P7-1/P7-4 走這條）。P7-5 測「完全未設旗標」語意另有專屬
    // 手刻 spawnSync（不經過本函式），不受此變動影響。
    if (!('LOOPS_PR_GATE' in env)) delete mergedEnv.LOOPS_PR_GATE;
    if (!('LOOPS_PR_REALRUN_GATE' in env)) delete mergedEnv.LOOPS_PR_REALRUN_GATE;
    // 閘⑥（#188）與 auto 偵測：預設不繼承 ambient（刪除 → LOOPS_PR_BLOCKING_GATE defaultOn 生效、
    // LOOPS_AUTO 判為 attended）；閘⑥ 專屬案例才顯式傳入。
    if (!('LOOPS_PR_BLOCKING_GATE' in env)) delete mergedEnv.LOOPS_PR_BLOCKING_GATE;
    if (!('LOOPS_AUTO' in env)) delete mergedEnv.LOOPS_AUTO;
    // 閘⑤（會 spawn 真 gh）預設關掉，維持閘①②③④ 案例的 hermeticity（不 spawn、不依賴 ambient
    // gh/auth 狀態）——閘⑤ 專屬案例才顯式 LOOPS_PR_CONFLICT_GATE='1' + 注入 LOOPS_PR_CONFLICT_STUB。
    if (!('LOOPS_PR_CONFLICT_GATE' in env)) mergedEnv.LOOPS_PR_CONFLICT_GATE = '0';
    if (!('LOOPS_PR_CONFLICT_STUB' in env)) delete mergedEnv.LOOPS_PR_CONFLICT_STUB;
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
    // #152：閘④ 移到獨立 flag LOOPS_PR_REALRUN_GATE 後，要讓「違規 create 也放行」需把兩個檔案閘
    // flag 都關（LOOPS_PR_GATE 關①②③、LOOPS_PR_REALRUN_GATE 關④）；閘⑤ 由 runHook 預設關。
    const cmd = 'gh pr create --title t --body "x"'; // 違規：缺 draft/assignee/verify/real-run
    const res = runHook({ command: cmd, cwd: WT_CWD_NV, env: { LOOPS_PR_GATE: '0', LOOPS_PR_REALRUN_GATE: '0' } });
    assert(isAllow(res), "[P7-1] LOOPS_PR_GATE='0' + LOOPS_PR_REALRUN_GATE='0' → 即使違規也放行");
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
  // ===========================================================================
  // R —— #152 閘④ 真機截圖 receipt（create + ready）
  // ===========================================================================
  const DRAFT_FULL = 'gh pr create --draft --assignee @me --title t --body "x"'; // 非數字 slug → 過①②③
  {
    const res = runHook({ command: DRAFT_FULL, cwd: WT_CWD_NORUN });
    assert(isDeny(res), '[R1] create：real-run 目錄不存在（無截圖）→ 閘④ deny');
    assert(reasonOf(res).includes('real-run') && reasonOf(res).includes('截圖'), '[R1-2] reason 含「real-run／截圖」通用指引');
    assert(!/run-eagle-app-core|client\//.test(reasonOf(res)), '[R1-3] reason 不 hardcode 任何專案路徑／skill 名（通用）');
    assert(reasonOf(res).includes('LOOPS_PR_REALRUN_GATE'), '[R1-4] reason 附閘④ 專屬逃生口 LOOPS_PR_REALRUN_GATE');
  }
  {
    const res = runHook({ command: DRAFT_FULL, cwd: WT_CWD_EMPTYRUN });
    assert(isDeny(res), '[R2] create：real-run 目錄存在但全空 → 閘④ deny');
  }
  {
    const res = runHook({ command: DRAFT_FULL, cwd: WT_CWD_JPG });
    assert(isAllow(res), '[R3] create：real-run 內有 .JPEG 截圖 → 閘④ allow（副檔名大小寫不敏感、jpeg 變體）');
  }
  {
    const res = runHook({ command: DRAFT_FULL, cwd: WT_CWD_NOUI });
    assert(isAllow(res), '[R4] create：real-run 內有非空 no-ui.md → 閘④ allow（非視覺 loop 宣告出口）');
  }
  {
    const res = runHook({ command: DRAFT_FULL, cwd: WT_CWD_EMPTYNOUI });
    assert(isDeny(res), '[R5] create：real-run 內只有「空」no-ui.md（0 bytes）→ 閘④ deny（純 touch 不算 receipt）');
  }
  {
    const res = runHook({ command: DRAFT_FULL, cwd: WT_CWD_EMPTYPNG });
    assert(isDeny(res), '[R5b] create：real-run 內只有「空」shot.png（0 bytes，touch）→ 閘④ deny（截圖與 no-ui 一致擋純 touch，verify F1）');
  }
  {
    const res = runHook({ command: DRAFT_FULL, cwd: WT_CWD_DIRPNG });
    assert(isDeny(res), '[R5c] create：real-run 內只有「同名子目錄」shot.png（mkdir 非檔案）→ 閘④ deny（isFile 守衛，verify F1）');
  }
  {
    const res = runHook({ command: 'gh pr ready', cwd: WT_CWD_NORUN });
    assert(isDeny(res), '[R6] ready：無 real-run receipt → 閘④ 在 ready 也生效 deny');
    assert(reasonOf(res).includes('real-run'), '[R6-2] reason 含 real-run 語意');
  }
  {
    // ready 不套①②③：對「有 receipt、但缺 --draft、且 body 無 Closes」的 loop 分支下 ready → allow。
    const res = runHook({ command: 'gh pr ready', cwd: WT_CWD_FULL });
    assert(isAllow(res), '[R7] ready：有 receipt（過閘④）、閘⑤ 預設關 → allow（證明 ready 不套閘①②③——缺 draft/Closes 不擋 ready）');
  }
  {
    const res = runHook({ command: DRAFT_FULL, cwd: WT_CWD_NORUN, env: { LOOPS_PR_REALRUN_GATE: '0' } });
    assert(isAllow(res), '[R8] create：LOOPS_PR_REALRUN_GATE=0 → 閘④ 關、無 receipt 也放行');
  }

  // ===========================================================================
  // C —— #152 閘⑤ 合併衝突（create + ready + comment；stub 注入 gh 會印的原始 JSON）
  // ===========================================================================
  const CONFLICT_ON = (stub) => ({ LOOPS_PR_CONFLICT_GATE: '1', ...(stub !== undefined ? { LOOPS_PR_CONFLICT_STUB: stub } : {}) });
  {
    const res = runHook({ command: 'gh pr comment --body "近況更新"', cwd: WT_CWD_FULL, env: CONFLICT_ON('{"mergeable":"CONFLICTING","mergeStateStatus":"CLEAN"}') });
    assert(isDeny(res), '[C1] comment：mergeable=CONFLICTING → 閘⑤ deny');
    assert(reasonOf(res).includes('衝突') && reasonOf(res).includes('LOOPS_PR_CONFLICT_GATE'), '[C1-2] reason 含「衝突」＋閘⑤ 逃生口');
  }
  {
    // create 過①②③④（210-foo full+receipt、OK_BODY 有 Closes #210）後才到⑤；DIRTY → deny。
    const res = runHook({ command: `gh pr create --draft --assignee @me --title t --body "${OK_BODY}"`, cwd: WT_CWD_FULL, env: CONFLICT_ON('{"mergeable":"MERGEABLE","mergeStateStatus":"DIRTY"}') });
    assert(isDeny(res), '[C2] create：①②③④皆過、mergeStateStatus=DIRTY → 閘⑤ deny（證明 create 殿後到⑤）');
    assert(reasonOf(res).includes('衝突'), '[C2-2] reason 含「衝突」語意');
  }
  {
    const res = runHook({ command: 'gh pr comment --body "近況"', cwd: WT_CWD_FULL, env: CONFLICT_ON('{"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}') });
    assert(isAllow(res), '[C3] comment：mergeable=MERGEABLE + CLEAN → 閘⑤ allow');
  }
  {
    const res = runHook({ command: 'gh pr comment --body "近況"', cwd: WT_CWD_FULL, env: CONFLICT_ON('{"mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN"}') });
    assert(isAllow(res), '[C4] comment：UNKNOWN → 閘⑤ 放行（fail-open，只擋明確 CONFLICTING/DIRTY）');
  }
  {
    const res = runHook({ command: 'gh pr comment --body "近況"', cwd: WT_CWD_FULL, env: CONFLICT_ON('not json at all') });
    assert(isAllow(res), '[C5] comment：stub 非 JSON（解析失敗）→ null → 閘⑤ 放行（fail-open；證明 stub 與真 gh 共用同一段 JSON.parse）');
  }
  {
    // 唯一「真 gh spawn」案例：不注入 stub，cwd 是 sandbox 非 git 目錄 → 真 gh throw → null → 放行。
    // CI 無 gh → ENOENT → 同樣 null → 放行。兩種環境都綠，不依賴 ambient gh/auth 狀態。
    const res = runHook({ command: 'gh pr comment --body "近況"', cwd: WT_CWD_FULL, env: { LOOPS_PR_CONFLICT_GATE: '1' } });
    assert(isAllow(res), '[C6] comment：閘⑤ 開、無 stub、cwd 非 git repo → 真 gh 失敗 → fail-open 放行（真 spawn 路徑）');
  }
  {
    // 顯式 PR 號 → 針對的未必是當前分支的 PR → 跳過閘⑤（即使 stub 是 CONFLICTING 也放行）。
    const res = runHook({ command: 'gh pr comment 999 --body "近況"', cwd: WT_CWD_FULL, env: CONFLICT_ON('{"mergeable":"CONFLICTING","mergeStateStatus":"DIRTY"}') });
    assert(isAllow(res), '[C7] comment 999（顯式 PR 號）→ 跳過閘⑤、放行（避免對非當前分支 PR 誤擋）');
  }
  {
    // comment 只跑閘⑤：對「無 04-verify、無 real-run」的 loop 分支 comment（clean）→ allow，
    // 證明 comment 不套閘①（verify）與閘④（receipt）。
    const res = runHook({ command: 'gh pr comment --body "近況"', cwd: WT_CWD_NV, env: CONFLICT_ON('{"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}') });
    assert(isAllow(res), '[C8] comment：對缺 verify.md/real-run 的 loop 分支（衝突 clean）→ allow（證明 comment 只跑閘⑤、不套①④）');
  }
  {
    // 非 loop 分支：comment 在 HEAD=master（無對應 .loops）→ 即使閘⑤ 開也放行。
    const res = runHook({ command: 'gh pr comment --body "x"', cwd: MAIN_ROOT_MASTER, env: CONFLICT_ON('{"mergeable":"CONFLICTING"}') });
    assert(isAllow(res), '[C9] comment：非 loop 分支（HEAD=master）→ 閘⑤ 不生效、放行');
  }
  {
    // ready + 衝突端到端（S6–S9 明列 ready 支，補齊）：有 receipt 過閘④、CONFLICTING → 閘⑤ deny。
    const res = runHook({ command: 'gh pr ready', cwd: WT_CWD_FULL, env: CONFLICT_ON('{"mergeable":"CONFLICTING","mergeStateStatus":"CLEAN"}') });
    assert(isDeny(res), '[C10] ready：過閘④後、mergeable=CONFLICTING → 閘⑤ deny（ready 支端到端）');
    assert(reasonOf(res).includes('衝突'), '[C10-2] reason 含「衝突」語意');
  }
  {
    // 顯式跨 repo 目標（--repo o/r）→ 針對別 repo 的 PR → 跳過閘⑤（即使 stub CONFLICTING 也放行，verify F4）。
    const res = runHook({ command: 'gh pr comment --repo owner/other 42 --body "x"', cwd: WT_CWD_FULL, env: CONFLICT_ON('{"mergeable":"CONFLICTING","mergeStateStatus":"DIRTY"}') });
    assert(isAllow(res), '[C11] comment --repo owner/other 42（跨 repo）→ 跳過閘⑤、放行（避免對非當前分支/repo 的 PR 誤擋）');
  }

  // ===========================================================================
  // N —— #152 新純函式直測（動態 import，仿 Q5–Q8；紅照實回報）
  // ===========================================================================
  {
    const m = prGateModule;
    const safe = (fn, ...a) => { try { return fn(...a); } catch { return '__throw__'; } };
    assert(safe(m?.classifyPrCommand, 'gh pr create --draft') === 'create'
      && safe(m?.classifyPrCommand, 'gh pr ready 5') === 'ready'
      && safe(m?.classifyPrCommand, 'gh pr comment --body x') === 'comment'
      && safe(m?.classifyPrCommand, 'gh pr view 1') === null,
      '[N1] classifyPrCommand 四路（create/ready/comment/null）');
    assert(safe(m?.classifyPrCommand, 'gh pr comment --body "提醒：先 gh pr ready 再 gh pr create"') === 'comment',
      '[N2] classify 用剝殼視圖：body 內文的 gh pr ready/create 不誤判子指令，落到 comment');
    assert(safe(m?.isScreenshotFile, 'a.png') === true && safe(m?.isScreenshotFile, 'a.JPG') === true
      && safe(m?.isScreenshotFile, 'a.jpeg') === true && safe(m?.isScreenshotFile, 'a.gif') === false
      && safe(m?.isScreenshotFile, 'nopng') === false,
      '[N3] isScreenshotFile：png/jpg/jpeg（大小寫不敏感）真、gif/無副檔名假');
    assert(safe(m?.isNoUiMarker, 'no-ui.md') === true && safe(m?.isNoUiMarker, 'NO-UI.txt') === true
      && safe(m?.isNoUiMarker, 'no-ui-reason.md') === true && safe(m?.isNoUiMarker, 'nouix.md') === false
      && safe(m?.isNoUiMarker, 'ui-notes.md') === false,
      '[N4] isNoUiMarker：no-ui 起頭（\\b 邊界）真、nouix/其他假');
    assert(safe(m?.isMergeConflict, { mergeable: 'CONFLICTING', mergeStateStatus: 'CLEAN' }) === true
      && safe(m?.isMergeConflict, { mergeable: 'MERGEABLE', mergeStateStatus: 'DIRTY' }) === true
      && safe(m?.isMergeConflict, { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }) === false
      && safe(m?.isMergeConflict, null) === false
      && safe(m?.isMergeConflict, { mergeable: null, mergeStateStatus: null }) === false
      && safe(m?.isMergeConflict, {}) === false,
      '[N5] isMergeConflict：CONFLICTING/DIRTY 真；clean/null/空欄位/空物件假（fail-open）');
    assert(safe(m?.hasExplicitPrTarget, 'gh pr comment 123 --body x', 'comment') === true
      && safe(m?.hasExplicitPrTarget, 'gh pr comment --body x', 'comment') === false
      && safe(m?.hasExplicitPrTarget, 'gh pr ready 7', 'ready') === true
      && safe(m?.hasExplicitPrTarget, 'gh pr ready', 'ready') === false
      && safe(m?.hasExplicitPrTarget, 'gh pr create', 'create') === false
      && safe(m?.hasExplicitPrTarget, 'gh pr comment --body "see gh pr comment 5"', 'comment') === false,
      '[N6] hasExplicitPrTarget：顯式 PR 號真、隱式/create/body 內文假');
    assert(JSON.stringify(safe(m?.readMergeability, 'x', { LOOPS_PR_CONFLICT_STUB: '{"mergeable":"CONFLICTING","mergeStateStatus":"DIRTY"}' })) === '{"mergeable":"CONFLICTING","mergeStateStatus":"DIRTY"}',
      '[N7] readMergeability：stub 注入 raw JSON → 走真 JSON.parse 回物件（解析路徑受測、非注入已解析結果）');
    assert(safe(m?.readMergeability, 'x', { LOOPS_PR_CONFLICT_STUB: 'garbage{' }) === null,
      '[N8] readMergeability：stub 壞 JSON → null（fail-open；與真 gh 路徑共用同一段 parse）');
    // N9（verify F2）：釘死真 gh 的 argv——欄名／子指令拼錯（stub 短路 spawn、不 pin 就無斷言守住）。
    assert(JSON.stringify(m?.GH_MERGEABILITY_ARGS) === JSON.stringify(['pr', 'view', '--json', 'mergeable,mergeStateStatus']),
      '[N9] GH_MERGEABILITY_ARGS 精確 = [pr,view,--json,mergeable,mergeStateStatus]（防欄名/子指令拼錯 stub 測試照樣綠）');
    // N10（verify F3）：命令段開頭錨定——heredoc/-F 本文行中提到子指令詞不誤判、真指令（含 && 串接、$()）仍判到。
    assert(safe(m?.classifyPrCommand, 'git commit -F - <<EOF\ndocs: 說明 gh pr comment 流程\nEOF') === null
      && safe(m?.classifyPrCommand, 'echo 先跑 gh pr create 再說') === null
      && safe(m?.classifyPrCommand, 'cd repo && gh pr create --draft') === 'create'
      && safe(m?.classifyPrCommand, '(gh pr ready)') === 'ready'
      && safe(m?.classifyPrCommand, 'gh pr comment --body x') === 'comment',
      '[N10] classifyPrCommand 錨定命令段開頭：本文行中的子指令詞不誤判成受管指令、&&/() 串接的真指令仍判到（verify F3）');
    // N11（verify F4）：跨 repo / 夾在 flag 後的顯式目標——閘⑤ 該跳過。
    assert(safe(m?.hasExplicitPrTarget, 'gh pr comment --repo owner/other 42 --body x', 'comment') === true
      && safe(m?.hasExplicitPrTarget, 'gh pr ready -R owner/other', 'ready') === true
      && safe(m?.hasExplicitPrTarget, 'gh pr comment --repo=owner/other --body x', 'comment') === true,
      '[N11] hasExplicitPrTarget：-R/--repo/--repo=（跨 repo 目標，即使夾在 flag 後）→ true（verify F4）');
  }
  // ===========================================================================
  // F5（verify）—— 三 flag 各自獨立、互不牽連（釘死實作真實行為，非 goal S13 舊字面）
  // ===========================================================================
  {
    // LOOPS_PR_GATE=0 單獨關①②③，閘④（LOOPS_PR_REALRUN_GATE 仍 defaultOn）對無 receipt 的 create 仍 deny。
    const res = runHook({ command: DRAFT_FULL, cwd: WT_CWD_NORUN, env: { LOOPS_PR_GATE: '0' } });
    assert(isDeny(res) && reasonOf(res).includes('real-run'),
      '[F5-1] LOOPS_PR_GATE=0 只關①②③；閘④ 獨立 flag 仍 defaultOn → 無 receipt 的 create 仍在閘④ deny');
  }
  {
    // 反向：LOOPS_PR_REALRUN_GATE=0 單獨關④，①②③（LOOPS_PR_GATE defaultOn）對缺 verify 的 create 仍 deny。
    const res = runHook({ command: DRAFT_FULL, cwd: WT_CWD_NV, env: { LOOPS_PR_REALRUN_GATE: '0' } });
    assert(isDeny(res) && reasonOf(res).includes('verify'),
      '[F5-2] LOOPS_PR_REALRUN_GATE=0 只關④；①②③ 仍 defaultOn → 缺 04-verify 的 create 仍在閘① deny（證明兩 flag 互不牽連）');
  }

  // ===========================================================================
  // G —— 閘⑤ 真 spawn 端到端（假 gh binary，非 stub）：釘死 execFileSync 真的接進 main() 的 deny
  //     路徑、且傳給 gh 的 argv 精確。stub 短路 spawn，C 系列證不到「execFileSync 真跑 + argv 正確 +
  //     解析真 subprocess 輸出」；本組放一個真的可執行 `gh`（印 canned JSON、把收到的 argv 落檔）到
  //     PATH 前綴，逼 readMergeability 走 execFileSync 真路徑。POSIX 專屬（Windows 的 shell:false
  //     execFileSync 只認 gh.exe、假 sh 腳本無法當 gh，故該平台跳過——CI ubuntu 會跑到，是權威訊號）。
  // ===========================================================================
  if (process.platform !== 'win32') {
    const binDir = join(SANDBOX, 'fakebin');
    mkdirSync(binDir, { recursive: true });
    const ghPath = join(binDir, 'gh');
    // 假 gh：把收到的所有 argv（$*）落檔供斷言，再把 env FAKE_GH_JSON 原樣印到 stdout 供 hook 解析。
    writeFileSync(ghPath, ['#!/bin/sh', 'printf "%s" "$*" >> "$FAKE_GH_ARGS_OUT"', 'printf "%s" "$FAKE_GH_JSON"', ''].join('\n'));
    chmodSync(ghPath, 0o755);
    const argsOut = join(SANDBOX, 'fake-gh-argv.txt');
    const runRealSpawn = (json) => {
      rmSync(argsOut, { force: true });
      // 不注入 LOOPS_PR_CONFLICT_STUB → readMergeability 走真 execFileSync 分支（非 stub 短路）。
      // 本測試「父」行程的 process.env 本就不含它——C 系列的 stub 是塞給「子」行程 env、非父行程，
      // 故 `...process.env` 自然無 stub、不必再 delete。走的是不是真 spawn 由 G2 的 argv 落檔獨立
      // 把關：若誤走 stub，假 gh 不會被 spawn、argv 檔為空 → G2 紅，不會假綠。
      const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, LOOPS_PR_CONFLICT_GATE: '1', FAKE_GH_JSON: json, FAKE_GH_ARGS_OUT: argsOut };
      return spawnSync(process.execPath, [HOOK_SCRIPT], {
        input: JSON.stringify({ cwd: WT_CWD_FULL, tool_input: { command: 'gh pr comment --body x' } }),
        cwd: NEUTRAL_CWD, env, encoding: 'utf8',
      });
    };
    {
      const res = runRealSpawn('{"mergeable":"CONFLICTING","mergeStateStatus":"CLEAN"}');
      assert(isDeny(res) && reasonOf(res).includes('衝突'),
        '[G1] 真 execFileSync spawn 假 gh 回 CONFLICTING → 閘⑤ deny（證明 spawn+解析真 subprocess 輸出+判定確實接進 main()，非只走 stub）');
      const argv = existsSync(argsOut) ? readFileSync(argsOut, 'utf8') : '';
      assert(argv === 'pr view --json mergeable,mergeStateStatus',
        `[G2] execFileSync 傳給 gh 的 argv 精確 = "pr view --json mergeable,mergeStateStatus"（實收："${argv}"）——證明 GH_MERGEABILITY_ARGS 真的送到 gh，欄名拼錯此條會紅`);
    }
    {
      const res = runRealSpawn('{"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}');
      assert(isAllow(res), '[G3] 真 spawn 假 gh 回 MERGEABLE+CLEAN → 閘⑤ allow（解析真輸出的非衝突路徑）');
    }
  }
  // ===========================================================================
  // B —— #188 閘⑥「P0/P1 未清不准收圈」（create + ready；verify marker 契約 + 知情豁免 + auto 不繞過）
  // ===========================================================================
  // marker 契約：`<!-- loops-verify verdict=ready|not-ready p0=<n> p1=<n> round=<n> -->`；閘⑥ 取
  // stripCode 後最後一個 marker。fixture slug 皆非數字前綴（跳過閘③）、備 04-verify + real-run 截圖
  // （過①②④），把閘⑥ 隔離成決定者。
  const MK_NOT_READY = '# verify\n\n判定：Not ready\n<!-- loops-verify verdict=not-ready p0=0 p1=1 round=1 -->\n';
  const MK_READY = '# verify\n\n判定：Ready\n<!-- loops-verify verdict=ready p0=0 p1=0 round=2 -->\n';
  const MK_CONTRADICT = '# verify\n<!-- loops-verify verdict=ready p0=0 p1=1 round=1 -->\n';
  const MK_NONE = '# verify\n\n判定：Ready（此報告刻意無 marker）\n';
  const MK_MULTI_NR = '# verify\n<!-- loops-verify verdict=not-ready p0=0 p1=2 round=1 -->\n修完再驗\n<!-- loops-verify verdict=ready p0=0 p1=0 round=2 -->\n';
  const MK_MULTI_RN = '# verify\n<!-- loops-verify verdict=ready p0=0 p1=0 round=1 -->\n又發現新問題\n<!-- loops-verify verdict=not-ready p0=1 p1=0 round=2 -->\n';
  const MK_FENCE = '# verify\n判定：Not ready\n<!-- loops-verify verdict=not-ready p0=1 p1=0 round=1 -->\n\nmarker 格式範例：\n```text\n<!-- loops-verify verdict=ready p0=0 p1=0 round=9 -->\n```\n';
  const MK_CRLF = '# verify\r\n判定\r\n<!-- loops-verify verdict=not-ready p0=0 p1=1 round=1 -->\r\n';
  const MK_TWO_ONE_LINE = '# verify\n<!-- loops-verify verdict=ready p0=0 p1=0 round=1 --> <!-- loops-verify verdict=not-ready p0=1 p1=0 round=2 -->\n';
  const LOOP_CLOSED = '# Loop\n- 推進模式：closed\n';
  const LOOP_AUTO = '# Loop\n- 推進模式：auto（LOOPS_AUTO 未設、task 授權）\n';
  const LOOP_AUTO_CAP = '# Loop\n- 推進模式：Auto（大寫）\n'; // verify P3-1：大小寫不敏感
  // verify P2：未閉合 fence（少一個結尾 ```）—— stripCode 成對去 fence 會漏、讓示範 ready marker 存活
  // 被選在 allow 方向；fence-robust 逐行掃把未閉合 fence 後到 EOF 全丟 → 真 not-ready 存活 → deny。
  const MK_FENCE_UNBALANCED = '# verify\n判定：Not ready\n<!-- loops-verify verdict=not-ready p0=1 p1=0 round=1 -->\n\n格式範例：\n```text\n<!-- loops-verify verdict=ready p0=0 p1=0 round=9 -->\n';
  // verify P2：跨行 inline span 若用舊 stripCode 會把真 marker 一起吞掉 → null → allow；逐行去 span
  // （不跨行）→ 真 marker 存活 → deny。
  const MK_INLINE_STRADDLE = '# verify\n這是 `code 開始\n<!-- loops-verify verdict=not-ready p0=0 p1=1 round=1 -->\ncode 結束` 收尾\n';
  // verify 修正輪（Finding 1）：**未閉合 fence 在真 marker 之前**——只靠 stripped 視圖會把真 marker 藏進
  // fence 內漏讀 → 誤放行；raw 視圖擋住（真 marker 一定在 raw）。
  const MK_FENCE_WRAP = '# verify\n```text\n貼上的一段 code（忘了閉合）\n<!-- loops-verify verdict=not-ready p0=2 p1=0 round=1 -->\n';
  // verify 修正輪（Finding 1，最現實）：一個**閉合且 CommonMark 合法**的 ```text 區塊、內含一行 ~~~，
  // 之後才是真 marker——``` 開→~~~ 關→``` 開＝奇數 toggle，stripped 視圖把真 marker 當 fence 內漏讀；
  // raw 視圖擋住。無任何 markdown 錯誤。
  const MK_TILDE_MIX = '# verify\n```text\n範例輸出\n~~~ 分隔線 ~~~\n更多輸出\n```\n判定：Not ready\n<!-- loops-verify verdict=not-ready p0=1 p1=0 round=2 -->\n';

  const mkG6 = (name, slug, verify, opts = {}) => {
    const root = join(SANDBOX, name);
    const cwd = join(root, '.claude', 'worktrees', slug);
    mkdirSync(join(root, '.loops', slug, 'stages'), { recursive: true });
    writeFileSync(join(root, '.loops', slug, 'loop.md'), opts.loopMd ?? LOOP_CLOSED);
    writeFileSync(join(root, '.loops', slug, 'stages', '04-verify.md'), verify);
    addRealRunShot(root, slug); // 過閘④
    if (opts.waiver !== undefined) writeFileSync(join(root, '.loops', slug, 'blocking-waiver.md'), opts.waiver);
    mkdirSync(cwd, { recursive: true });
    return cwd;
  };

  {
    const res = runHook({ command: DRAFT_FULL, cwd: mkG6('g6-nr', 'block-nr', MK_NOT_READY) });
    assert(isDeny(res), '[B1] create：verify not-ready + 無 waiver + 非 auto → 閘⑥ deny（S5）');
    assert(reasonOf(res).includes('P0/P1') && reasonOf(res).includes('LOOPS_PR_BLOCKING_GATE'), '[B1-2] reason 含硬條件語意 + 閘⑥ 逃生口');
    assert(reasonOf(res).includes('blocking-waiver'), '[B1-3] 非 auto reason 指引知情豁免 waiver 出口');
  }
  assert(isAllow(runHook({ command: DRAFT_FULL, cwd: mkG6('g6-ready', 'block-ready', MK_READY) })),
    '[B2] create：verify ready（p0=0 p1=0）→ 閘⑥ allow（S6）');
  assert(isDeny(runHook({ command: DRAFT_FULL, cwd: mkG6('g6-contra', 'block-contra', MK_CONTRADICT) })),
    '[B3] create：verdict=ready 但 p1=1（自相矛盾）→ blocking-first → deny');
  assert(isAllow(runHook({ command: DRAFT_FULL, cwd: mkG6('g6-none', 'block-none', MK_NONE) })),
    '[B4] create：verify 無 marker → fail-open allow（S9）');
  assert(isAllow(runHook({ command: DRAFT_FULL, cwd: mkG6('g6-mnr', 'block-multinr', MK_MULTI_NR) })),
    '[B5] create：多 marker 最後一個 ready（舊 not-ready → 新 ready）→ allow（最近一輪 wins）');
  assert(isDeny(runHook({ command: DRAFT_FULL, cwd: mkG6('g6-mrn', 'block-multirn', MK_MULTI_RN) })),
    '[B6] create：多 marker 最後一個 not-ready（舊 ready → 新 not-ready）→ deny');
  assert(isDeny(runHook({ command: DRAFT_FULL, cwd: mkG6('g6-fence', 'block-fence', MK_FENCE) })),
    '[B7] create：真 verdict not-ready + 尾段 fenced 示範 ready marker → stripCode 去 fence → 仍 deny（示範 marker 不被誤選）');
  assert(isDeny(runHook({ command: DRAFT_FULL, cwd: mkG6('g6-crlf', 'block-crlf', MK_CRLF) })),
    '[B8] create：CRLF 行尾的 not-ready marker → deny（無行錨、CRLF 安全）');
  assert(isDeny(runHook({ command: DRAFT_FULL, cwd: mkG6('g6-two', 'block-twoline', MK_TWO_ONE_LINE) })),
    '[B9] create：同一行兩個 marker、最後一個 not-ready → deny（matchAll 取最後）');
  assert(isAllow(runHook({ command: DRAFT_FULL, cwd: mkG6('g6-waiver', 'block-waiver', MK_NOT_READY, { waiver: '知情豁免：P1-#3 屬既有、獨立處理；使用者拍板先進 PR。' }) })),
    '[B10] create：not-ready + 非空 waiver + 非 auto → allow（知情豁免，S7）');
  {
    const res = runHook({ command: DRAFT_FULL, cwd: mkG6('g6-wa', 'block-waiver-auto', MK_NOT_READY, { waiver: '豁免說明' }), env: { LOOPS_AUTO: '1' } });
    assert(isDeny(res), '[B11] create：not-ready + waiver + LOOPS_AUTO=1（env auto）→ 仍 deny（auto 不認 waiver，S8）');
    assert(reasonOf(res).includes('硬煞車') && !reasonOf(res).includes('blocking-waiver'), '[B11-2] auto reason 說明硬煞車 #4、不指 waiver 出口');
  }
  assert(isDeny(runHook({ command: DRAFT_FULL, cwd: mkG6('g6-wla', 'block-waiver-loopauto', MK_NOT_READY, { waiver: '豁免', loopMd: LOOP_AUTO }) })),
    '[B12] create：not-ready + waiver + loop.md 推進模式：auto（env 未設）→ 仍 deny（loop.md auto 偵測，S8）');
  assert(isAllow(runHook({ command: DRAFT_FULL, cwd: mkG6('g6-off', 'block-flagoff', MK_NOT_READY), env: { LOOPS_PR_BLOCKING_GATE: '0' } })),
    '[B13] create：LOOPS_PR_BLOCKING_GATE=0 → 閘⑥ 關、not-ready 也放行（S10 逃生口）');
  assert(isDeny(runHook({ command: 'gh pr ready', cwd: mkG6('g6-rnr', 'block-ready-nr', MK_NOT_READY) })),
    '[B14] ready：verify not-ready → 閘⑥ 在 ready 也 deny（縱深；pr-owner-guard 關時）');
  assert(isAllow(runHook({ command: 'gh pr ready', cwd: mkG6('g6-rok', 'block-ready-ok', MK_READY) })),
    '[B15] ready：verify ready → 閘⑥ allow');
  assert(isDeny(runHook({ command: DRAFT_FULL, cwd: mkG6('g6-ew', 'block-emptywaiver', MK_NOT_READY, { waiver: '' }) })),
    '[B16] create：not-ready + 空 waiver（0 bytes）+ 非 auto → deny（空檔不算知情豁免）');
  assert(isAllow(runHook({ command: 'gh pr comment --body "近況"', cwd: mkG6('g6-cm', 'block-comment', MK_NOT_READY) })),
    '[B17] comment：verify not-ready → 閘⑥ 不套 comment → allow（作用範圍 = create + ready）');
  assert(isDeny(runHook({ command: 'gh pr create', cwd: mkG6('g6-indep', 'block-indep', MK_NOT_READY), env: { LOOPS_PR_GATE: '0' } })),
    '[B18] create：LOOPS_PR_GATE=0 關①②③、閘⑥ 獨立 flag 仍 defaultOn → not-ready 仍 deny（互不牽連）');
  // verify 修正輪 GUARD：
  assert(isDeny(runHook({ command: DRAFT_FULL, cwd: mkG6('g6-unbal', 'block-unbal', MK_FENCE_UNBALANCED) })),
    '[B19] create：**未閉合** fence 內的示範 ready marker（少結尾 ```）→ fence-robust 掃丟到 EOF → 真 not-ready 存活 → 仍 deny（verify P2）');
  assert(isDeny(runHook({ command: DRAFT_FULL, cwd: mkG6('g6-straddle', 'block-straddle', MK_INLINE_STRADDLE) })),
    '[B20] create：跨行 inline backtick 夾住真 marker → 逐行去 span（不跨行）真 marker 存活 → deny（verify P2 inline 變體）');
  assert(isDeny(runHook({ command: DRAFT_FULL, cwd: mkG6('g6-capauto', 'block-capauto', MK_NOT_READY, { waiver: '豁免', loopMd: LOOP_AUTO_CAP }) })),
    '[B21] create：not-ready + waiver + loop.md 推進模式：Auto（大寫）→ 大小寫不敏感偵測 auto → 仍 deny（verify P3-1）');
  assert(isDeny(runHook({ command: DRAFT_FULL, cwd: mkG6('g6-wrap', 'block-wrap', MK_FENCE_WRAP) })),
    '[B22] create：**未閉合 fence 在真 marker 之前**（危險排序）→ raw 視圖擋住真 not-ready → deny（Finding 1：不把真 marker 藏掉誤放行）');
  assert(isDeny(runHook({ command: DRAFT_FULL, cwd: mkG6('g6-tilde', 'block-tilde', MK_TILDE_MIX) })),
    '[B23] create：合法閉合 ```區塊內含 ~~~ 行（奇數 toggle）+ 之後真 not-ready → raw 視圖擋住 → deny（Finding 1 最現實案例，無 markdown 錯誤）');

  // ── BN 純函式直測（動態 import，仿 N/Q 系列）──────────────────────────────────────
  {
    const m = prGateModule;
    const safe = (fn, ...a) => { try { return fn(...a); } catch { return '__throw__'; } };
    const p1 = safe(m?.parseLatestVerifyVerdict, '<!-- loops-verify verdict=not-ready p0=1 p1=2 round=3 -->');
    assert(p1 && p1.verdict === 'not-ready' && p1.p0 === 1 && p1.p1 === 2 && p1.round === 3, '[BN1] parseLatestVerifyVerdict 解出 verdict/p0/p1/round');
    const p2 = safe(m?.parseLatestVerifyVerdict, 'x\n<!-- loops-verify verdict=not-ready p0=0 p1=1 round=1 -->\ny\n<!-- loops-verify verdict=ready p0=0 p1=0 round=2 -->');
    assert(p2 && p2.verdict === 'ready' && p2.round === 2, '[BN2] parse 取最後一個 marker（round=2 ready）');
    const p3 = safe(m?.parseLatestVerifyVerdict, 'not ready\n<!-- loops-verify verdict=not-ready p0=1 p1=0 round=1 -->\n```\n<!-- loops-verify verdict=ready p0=0 p1=0 round=9 -->\n```');
    assert(p3 && p3.verdict === 'not-ready' && p3.round === 1, '[BN3] parse 先 stripCode：fenced 示範 marker 不被選、取真 not-ready');
    assert(safe(m?.parseLatestVerifyVerdict, '完全沒有任何 marker') === null, '[BN4] parse 無 marker → null');
    assert(safe(m?.parseLatestVerifyVerdict, 42) === null, '[BN4b] parse 非字串 → null');
    assert(safe(m?.hasBlockingFindings, { verdict: 'not-ready' }) === true, '[BN5] hasBlocking：not-ready → true');
    assert(safe(m?.hasBlockingFindings, { verdict: 'ready', p0: 0, p1: 0 }) === false, '[BN6] hasBlocking：ready+0/0 → false');
    assert(safe(m?.hasBlockingFindings, { verdict: 'ready', p0: 0, p1: 1 }) === true, '[BN7] hasBlocking：ready 但 p1=1（矛盾）→ true（blocking-first）');
    assert(safe(m?.hasBlockingFindings, null) === false, '[BN8] hasBlocking：null → false（fail-open）');
    assert(safe(m?.hasBlockingFindings, { p1: 2 }) === true, '[BN9] hasBlocking：verdict 缺但 p1=2 → true');
    assert(safe(m?.hasBlockingFindings, { verdict: 'notready' }) === false, '[BN9b] hasBlocking：verdict 嚴格全等——"notready"（非 "not-ready"）不算 blocking');
    assert(safe(m?.isAutoMode, { LOOPS_AUTO: '1' }, '') === true, '[BN10] isAutoMode：env LOOPS_AUTO=1 → true');
    assert(safe(m?.isAutoMode, {}, '- 推進模式：auto（x）') === true, '[BN11] isAutoMode：loop.md 全形冒號 auto → true');
    assert(safe(m?.isAutoMode, {}, '- **推進模式**：auto') === true, '[BN12] isAutoMode：loop.md 粗體+全形冒號 auto → true');
    assert(safe(m?.isAutoMode, {}, '- **推進模式**: auto（x）') === true, '[BN13] isAutoMode：loop.md 粗體+半形冒號+空格 auto → true');
    assert(safe(m?.isAutoMode, {}, '# Loop\n- 推進模式：closed\n\n- E5：把推進模式：auto 改回 closed') === false, '[BN14] isAutoMode：closed 欄位 + Journal 提到 auto → false（field-anchored，不誤中 Journal 敘述）');
    assert(safe(m?.isAutoMode, { LOOPS_AUTO: '0' }, '- 推進模式：closed') === false, '[BN15] isAutoMode：env=0 + loop.md closed → false');
    const wroot = join(SANDBOX, 'g6-waiver-fn');
    mkdirSync(join(wroot, '.loops', 'w-slug'), { recursive: true });
    writeFileSync(join(wroot, '.loops', 'w-slug', 'blocking-waiver.md'), '非空豁免說明');
    assert(safe(m?.waiverExists, wroot, 'w-slug') === true, '[BN16] waiverExists：非空 waiver → true');
    const wroot2 = join(SANDBOX, 'g6-waiver-fn2');
    mkdirSync(join(wroot2, '.loops', 'w2'), { recursive: true });
    writeFileSync(join(wroot2, '.loops', 'w2', 'blocking-waiver.md'), '');
    assert(safe(m?.waiverExists, wroot2, 'w2') === false, '[BN17] waiverExists：空 waiver（0 bytes）→ false');
    assert(safe(m?.waiverExists, wroot2, 'nope') === false, '[BN18] waiverExists：不存在 → false');
    // verify 修正輪 GUARD（純函式層）：
    const pu = safe(m?.parseLatestVerifyVerdict, '判定 Not ready\n<!-- loops-verify verdict=not-ready p0=1 p1=0 round=1 -->\n```text\n<!-- loops-verify verdict=ready p0=0 p1=0 round=9 -->\n');
    assert(pu && pu.verdict === 'not-ready' && pu.round === 1, '[BN19] parse 對**未閉合** fence 穩健：示範 ready marker 在未閉合 fence 內 → 不被選、取真 not-ready（verify P2）');
    const ps = safe(m?.stripCodeForMarker, 'a\n```\n<!-- x -->\n```\nb `inline` c');
    assert(typeof ps === 'string' && !ps.includes('<!-- x -->') && !ps.includes('inline'), '[BN20] stripCodeForMarker：去成對 fence 內容 + 同行 inline span');
    assert(safe(m?.stripCodeForMarker, 42) === '', '[BN20b] stripCodeForMarker：非字串 → ""');
    assert(safe(m?.isAutoMode, {}, '- 推進模式：Auto（大寫）') === true, '[BN21] isAutoMode：loop.md 推進模式：Auto（大寫）→ true（大小寫不敏感，verify P3-1）');
    assert(safe(m?.isAutoMode, {}, '- 推進模式：CLOSED') === false, '[BN22] isAutoMode：推進模式：CLOSED → false（大小寫不敏感不誤中）');
    // verify 修正輪（Finding 1）— verifyReportBlocks / extractLatestMarker 純函式層：
    assert(safe(m?.extractLatestMarker, '```\nx\n<!-- loops-verify verdict=not-ready p0=2 p1=0 round=1 -->')?.verdict === 'not-ready',
      '[BN23] extractLatestMarker（raw、不去 fence）：未閉合 fence 內的真 marker 仍讀得到（藏不掉）');
    assert(safe(m?.verifyReportBlocks, '```\nx\n<!-- loops-verify verdict=not-ready p0=2 p1=0 round=1 -->') === true,
      '[BN24] verifyReportBlocks：未閉合 fence 在真 not-ready 前（stripped 漏讀）→ raw 視圖擋住 → true（Finding 1）');
    assert(safe(m?.verifyReportBlocks, MK_TILDE_MIX) === true,
      '[BN25] verifyReportBlocks：```區塊含 ~~~（奇數 toggle）+ 之後真 not-ready → true（Finding 1 最現實）');
    assert(safe(m?.verifyReportBlocks, '判定 Not ready\n<!-- loops-verify verdict=not-ready p0=1 p1=0 round=1 -->\n```text\n<!-- loops-verify verdict=ready p0=0 p1=0 round=9 -->\n```') === true,
      '[BN26] verifyReportBlocks：真 not-ready + fenced 示範 ready（原 P2）→ stripped 視圖擋住 → true');
    assert(safe(m?.verifyReportBlocks, 'x\n<!-- loops-verify verdict=not-ready p0=0 p1=1 round=1 -->\ny\n<!-- loops-verify verdict=ready p0=0 p1=0 round=2 -->') === false,
      '[BN27] verifyReportBlocks：多輪最後一輪 ready（無 fence）→ false（不因歷史 not-ready 誤擋、無 false-deny）');
    assert(safe(m?.verifyReportBlocks, '完全沒有 marker') === false, '[BN28] verifyReportBlocks：無 marker → false（fail-open，S9）');
    assert(safe(m?.verifyReportBlocks, 42) === false, '[BN28b] verifyReportBlocks：非字串 → false');
  }

  // ── V 系列：閘⑦ 第二輪確認沒跑（#209）────────────────────────────────────────────
  // 核心不對稱：**放行是預設、deny 是例外**。只擋「自報有候選 blocking finding、卻自報 0 條確認」。
  // 每一條 deny 都配一條反向 allow，殺掉「凡有 findings 欄位就擋」這種過寬實作。
  {
    const MK_SKIPPED = '# verify\n判定：Ready\n<!-- loops-verify verdict=ready p0=0 p1=0 round=1 findings=4 validated=0 -->\n';
    const MK_VALIDATED = '# verify\n判定：Ready\n<!-- loops-verify verdict=ready p0=0 p1=0 round=1 findings=4 validated=4 -->\n';
    const MK_ZERO_FINDINGS = '# verify\n判定：Ready\n<!-- loops-verify verdict=ready p0=0 p1=0 round=1 findings=0 validated=0 -->\n';
    const MK_HALF_CONTRACT = '# verify\n判定：Ready\n<!-- loops-verify verdict=ready p0=0 p1=0 round=1 findings=3 -->\n';
    const MK_PARTIAL = '# verify\n判定：Ready\n<!-- loops-verify verdict=ready p0=0 p1=0 round=1 findings=4 validated=1 -->\n';

    {
      const res = runHook({ command: DRAFT_FULL, cwd: mkG6('g7-skip', 'v-skipped', MK_SKIPPED) });
      assert(isDeny(res), '[V1] create：findings=4 validated=0 → 閘⑦ deny（第二輪被整段跳過）');
      assert(reasonOf(res).includes('finding-validator'), '[V1-2] reason 指名該派什麼（finding-validator），不是含糊說「請補驗證」');
      assert(reasonOf(res).includes('LOOPS_PR_VALIDATION_GATE'), '[V1-3] reason 附閘⑦ 專屬逃生口');
      // 訊息**要**提到 waiver，但必須是「這裡不吃這一招」而不是「拿它當出口」——知道閘⑥ 有 waiver 的
      // 人一定會先去試，訊息沉默只會讓他多繞一圈。所以釘的是「不認」這個否定，不是關鍵字缺席。
      assert(/不認\s*`?blocking-waiver/.test(reasonOf(res)),
        '[V1-4] reason 明講**不認** blocking-waiver（二輪沒跑時風險未經評估，沒有東西可以知情接受）');
      assert(!/寫明豁免哪幾條|再重試（此知情豁免/.test(reasonOf(res)),
        '[V1-5] reason **不**把 waiver 寫成可行出口（不複製閘⑥ 的補救指引）');
    }
    // 反向三連：三種「不該擋」的情形都要真的放行，否則這道閘會變成「有 findings 就擋」。
    assert(isAllow(runHook({ command: DRAFT_FULL, cwd: mkG6('g7-ok', 'v-validated', MK_VALIDATED) })),
      '[V2] create：findings=4 validated=4 → allow（第二輪跑過了）');
    assert(isAllow(runHook({ command: DRAFT_FULL, cwd: mkG6('g7-zero', 'v-zero', MK_ZERO_FINDINGS) })),
      '[V3] create：findings=0 → allow（零候選本來就不必派 validator，不是違規）');
    assert(isAllow(runHook({ command: DRAFT_FULL, cwd: mkG6('g7-old', 'v-oldreport', MK_READY) })),
      '[V4] create：**舊報告無 findings/validated 欄位** → allow（缺席 ≠ 沒派；不擋既有 loop）');
    assert(isAllow(runHook({ command: DRAFT_FULL, cwd: mkG6('g7-partial', 'v-partial', MK_PARTIAL) })),
      '[V5] create：findings=4 validated=1（只確認了一部分）→ allow（閘⑦ 只擋「一條都沒確認」，不當覆蓋率閘）');

    {
      const res = runHook({ command: DRAFT_FULL, cwd: mkG6('g7-half', 'v-half', MK_HALF_CONTRACT) });
      assert(isDeny(res), '[V6] create：宣告 findings=3 卻沒宣告 validated= → deny（半套契約，fail-safe）');
      assert(reasonOf(res).includes('validated'), '[V6-2] reason 指名缺的是哪個欄位');
    }

    assert(isDeny(runHook({ command: 'gh pr ready', cwd: mkG6('g7-ready', 'v-ready', MK_SKIPPED) })),
      '[V7] ready：閘⑦ 在 ready 也 deny（作用範圍同閘⑥）');
    assert(isAllow(runHook({ command: 'gh pr comment --body "近況"', cwd: mkG6('g7-cm', 'v-comment', MK_SKIPPED) })),
      '[V8] comment：閘⑦ 不套 comment → allow');
    assert(isAllow(runHook({ command: DRAFT_FULL, cwd: mkG6('g7-off', 'v-flagoff', MK_SKIPPED), env: { LOOPS_PR_VALIDATION_GATE: '0' } })),
      '[V9] create：LOOPS_PR_VALIDATION_GATE=0 → 閘⑦ 關（逃生口）');
    assert(isDeny(runHook({ command: DRAFT_FULL, cwd: mkG6('g7-indep', 'v-indep', MK_SKIPPED), env: { LOOPS_PR_BLOCKING_GATE: '0' } })),
      '[V10] create：關掉閘⑥ 不影響閘⑦（獨立 flag、互不牽連）');
    assert(isAllow(runHook({ command: DRAFT_FULL, cwd: mkG6('g7-b6off', 'v-b6off', MK_VALIDATED), env: { LOOPS_PR_VALIDATION_GATE: '0' } })),
      '[V10b] create：關掉閘⑦ 不影響其餘閘（乾淨報告仍放行、無副作用）');

    // waiver **不被認可**——這是閘⑦ 與閘⑥ 最大的行為差異，正反都釘。
    assert(isDeny(runHook({ command: DRAFT_FULL, cwd: mkG6('g7-wv', 'v-waiver', MK_SKIPPED, { waiver: '使用者知情，先進 PR' }) })),
      '[V11] create：findings>0 validated=0 + 非空 waiver + 非 auto → **仍 deny**（閘⑦ 不認 waiver）');
    assert(isDeny(runHook({ command: DRAFT_FULL, cwd: mkG6('g7-wvauto', 'v-waiverauto', MK_SKIPPED, { waiver: '豁免' }), env: { LOOPS_AUTO: '1' } })),
      '[V12] create：同上 + auto → 仍 deny（auto/attended 一視同仁，閘⑦ 不分模式）');

    // 閘⑥ 優先：兩個問題同時存在時，先講更根本的那個（還有未修 P0/P1）。
    {
      const both = '# verify\n判定：Not ready\n<!-- loops-verify verdict=not-ready p0=1 p1=0 round=1 findings=4 validated=0 -->\n';
      const res = runHook({ command: DRAFT_FULL, cwd: mkG6('g7-both', 'v-both', both) });
      assert(isDeny(res), '[V13] create：同時 not-ready 與第二輪沒跑 → deny');
      assert(reasonOf(res).includes('P0/P1'), '[V13-2] 先報閘⑥ 的理由（P0/P1 未清更根本），不是兩條訊息混在一起');
    }

    // 純函式層直測（含 fence-robust 兩視圖）。
    {
      const m = prGateModule;
      const safe = (fn, ...a) => { try { return fn(...a); } catch { return '__throw__'; } };
      assert(safe(m?.validationSkipped, { findings: 2, validated: 0 }) === true, '[VN1] validationSkipped：findings>0 validated=0 → true');
      assert(safe(m?.validationSkipped, { findings: 2, validated: 2 }) === false, '[VN2] validationSkipped：已確認 → false');
      assert(safe(m?.validationSkipped, { findings: 0, validated: 0 }) === false, '[VN3] validationSkipped：findings=0 → false（零候選不必派）');
      assert(safe(m?.validationSkipped, { p0: 0, p1: 0 }) === false, '[VN4] validationSkipped：兩欄位皆缺 → false（缺席 ≠ 沒派）');
      assert(safe(m?.validationSkipped, { findings: 2 }) === true, '[VN5] validationSkipped：宣告 findings 卻缺 validated → true（半套契約 fail-safe）');
      assert(safe(m?.validationSkipped, null) === false, '[VN6] validationSkipped：null → false');
      assert(safe(m?.extractLatestMarker, '<!-- loops-verify verdict=ready p0=0 p1=0 round=1 findings=5 validated=3 -->')?.findings === 5,
        '[VN7] extractLatestMarker 解得出後加的 findings 欄位');
      assert(safe(m?.extractLatestMarker, '<!-- loops-verify verdict=ready p0=0 p1=0 round=1 -->')?.findings === undefined,
        '[VN8] extractLatestMarker：舊 marker 的 findings → undefined（**不補 0**）');
      assert(safe(m?.verifyReportSkipsValidation,
        'x\n```\n<!-- loops-verify verdict=ready p0=0 p1=0 round=9 findings=0 validated=0 -->\n```\n<!-- loops-verify verdict=ready p0=0 p1=0 round=1 findings=2 validated=0 -->') === true,
        '[VN9] verifyReportSkipsValidation：fenced 示範 marker（findings=0）蓋不掉真的（findings=2 validated=0）→ true');
      assert(safe(m?.verifyReportSkipsValidation, '```\nx\n<!-- loops-verify verdict=ready p0=0 p1=0 round=1 findings=2 validated=0 -->') === true,
        '[VN10] verifyReportSkipsValidation：未閉合 fence 藏住真 marker → raw 視圖仍擋住 → true');
      assert(safe(m?.verifyReportSkipsValidation, '完全沒有 marker') === false, '[VN11] verifyReportSkipsValidation：無 marker → false（fail-open）');
      assert(safe(m?.verifyReportSkipsValidation, 42) === false, '[VN11b] verifyReportSkipsValidation：非字串 → false');
    }
  }
} finally {
  rmSync(SANDBOX, { recursive: true, force: true });
}

const total = passed + failed.length;
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
console.log(`(共 ${total} 條斷言：P1–P8／EXTRA／WIN＝#132 三閘與接線、Q1–Q8＝#132 verify 修正輪邊界、`
  + `R＝#152 閘④ real-run receipt、C＝#152 閘⑤ 合併衝突、N＝#152 新純函式直測、`
  + `F5＝三 flag 互不牽連、G＝閘⑤ 真 gh spawn 端到端（假 gh，POSIX/CI）、`
  + `B／BN＝#188 閘⑥ P0/P1 未清不准收圈（marker 契約 + 知情豁免 + auto 不繞過 + 純函式）、`
  + `V／VN＝#209 閘⑦ 第二輪確認沒跑不准收圈（findings/validated 欄位 + 缺席 fail-open + 不認 waiver + 純函式）；`
  + `R5b/c·N9–N11·C10/11·F5·G＝#152 verify/wiring 修正輪)`);
process.exit(failed.length > 0 ? 1 : 0);
