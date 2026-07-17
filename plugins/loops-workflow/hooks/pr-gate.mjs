#!/usr/bin/env node
// pr-gate.mjs —— loops-workflow PreToolUse(Bash|PowerShell) deny hook：機械化「loop 分支上開 PR
// 要先過三道閘」（issue #132）。只在偵測到 `gh pr create` 且**當前處於某個已建 loop 的分支**
// （worktree 路徑段或 `.git/HEAD` 反查 `.loops/<slug>/loop.md` 存在）時生效，依序三閘、命中即擋：
//   ① `stages/04-verify.md` 不存在 → deny（build 完必先過 verify，不能跳過直接送審）
//   ② 指令缺 `--draft` 或缺 `--assignee @me` → deny 附補救指令（house rule：先開 draft、指派自己）
//   ③ slug 以 `<issue#>-` 開頭時，PR body（stripCode 去 code span/fence 後）沒有行首純文字
//     `Closes #<issue#>` → deny（比 GitHub 解析更嚴的 house rule：換取版型一致＋零解析歧義）
// 非 loop 分支／非 `gh pr create`／任何判不出的情況（含 detached HEAD）一律放行——這是提醒型
// 守衛，不能因為自己判斷不出來就卡住人。
//
// 判「現在是不是在 loop 分支上」全靠讀檔案（路徑段比對 + 讀 `.git/HEAD` 文字），不 spawn `git`
// 指令（hook 熱路徑、零 process 開銷）：
//   ①cwd 路徑含 `.claude/worktrees/<slug>` 段 → slug（worktree 慣例主路徑）；
//   ②否則從 cwd 起向上最多 12 層找第一個存在的 `.git`（檔案形 `gitdir: <path>` 指標 → 讀該
//     gitdir/HEAD；目錄形 → 讀 `.git/HEAD`）取 `ref: refs/heads/<branch>` → branch=slug（主
//     checkout 兜底：有人手動 `checkout` 到 loop 分支，且 cwd 可能是 root 底下的子目錄）；裸
//     SHA（detached HEAD，無 `ref:` 前綴）→ 判不出、放行。
// 兩種情況都只是「slug 候選」，還要向上找 `.loops/<slug>/loop.md` 反查存在才算「已建 loop」
// （重用 worktree-guard.mjs 的 findLoopRoot——它的祖先上溯天然涵蓋 worktree cwd 剝
// `.claude/worktrees/<slug>` 後綴的那幾層，不必另外維護一條「捷徑」路徑）。
//
// 預設啟用（defaultOn）；env LOOPS_PR_GATE='0'（字面 '0'）可關。
// fail-open：payload 壞 / 讀檔失敗 / 判不出分支一律放行 exit 0，永不因 hook 故障卡住使用者。
//
// 分層（仿同目錄 outbound-comment-guard.mjs / worktree-guard.mjs）：
//   1) 純函式（無 IO）：isPrCreateCommand / hasDraftFlag / hasAssigneeMe / issueNumberFromSlug /
//      hasClosesLine / 三閘的 deny 理由組字函式。
//   2) IO 薄邊界：readGitBranch（讀 cwd 的 .git）、main()（讀 stdin、印 deny）——import 時不執行。
// 依賴：node 內建（fs / path / url）+ 同目錄 hook-flags、outbound-comment-guard（stripCode /
// extractCommentBody / makeHardenedReadFileSafe）、worktree-guard（findLoopRoot /
// extractWorktreeSlug）——三閘與分支判定不重抄兄弟 hook 已寫好、已測過的邏輯。
// stripQuotedValues／readGitBranch 對外 export：供 merge-guard.mjs 重用（#133）——同一套「剝殼視圖
// 判子指令詞」「讀 .git 判分支」邏輯，不重抄。

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { flagEnabled } from './hook-flags.mjs';
import { stripCode, extractCommentBody, makeHardenedReadFileSafe } from './outbound-comment-guard.mjs';
import { findLoopRoot, extractWorktreeSlug } from './worktree-guard.mjs';

// ── 純函式層（無 IO）──────────────────────────────────────────────────────────────

/**
 * 把指令字串中被引號包住的參數值（單引號或雙引號各自成對的整段）置換成空白——只給
 * isPrCreateCommand 的「這是不是 gh pr create 子指令」偵測使用（仿 outbound-comment-guard.mjs
 * 的 stripCode 思路：那邊去 code span/fence、這裡去引號值，用途都是把「不該被當成指令本體」的
 * 內文濾掉再判定）。不處理巢狀或跳脫引號（shell 指令本就不支援），對本 hook 的判定用途已足夠。
 */
export function stripQuotedValues(cmd) {
  return cmd.replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ');
}

/**
 * 這條指令是不是 `gh pr create`（非此一律放行，判定排在最前——即使 cwd 本身三閘全違規也不管）。
 * 比對前先用 stripQuotedValues 剝掉引號包住的參數值，避免「gh pr create」字樣只是出現在別的指令
 * 的引號值裡（例如 `gh issue comment` 的 `--body` 內文提到這幾個字）被誤判成真的 gh pr create
 * 子指令。注意：只有這裡的偵測用剝殼視圖——後續 hasDraftFlag / hasAssigneeMe / extractCommentBody
 * 等仍作用於原始字串，不能連真正的旗標與 body 內容都被剝掉。
 */
export function isPrCreateCommand(cmd) {
  return typeof cmd === 'string' && /\bgh\s+pr\s+create\b/.test(stripQuotedValues(cmd));
}

/** 指令是否帶 `--draft`（獨立旗標，後面不接值）。 */
export function hasDraftFlag(cmd) {
  return typeof cmd === 'string' && /(^|\s)--draft(?=\s|$)/.test(cmd);
}

/**
 * 指令是否帶 `--assignee @me`（空白或 `=` 皆可，值須是字面 `@me`——可不加引號、也可用單或雙引號
 * 包住（`'@me'`/`"@me"`），仿 outbound-comment-guard.mjs 的 extractCommentBody 引號交替寫法；
 * 指派給別人不算）。
 */
export function hasAssigneeMe(cmd) {
  return typeof cmd === 'string' && /(^|\s)--assignee(?:\s+|=)(?:'@me'|"@me"|@me)(?=\s|$)/.test(cmd);
}

/** slug 是不是「issue 編號開頭」（`<數字>-...`），是的話回該編號字串，否則回 null（gate③ 停用）。 */
export function issueNumberFromSlug(slug) {
  const m = typeof slug === 'string' ? /^(\d+)-/.exec(slug) : null;
  return m ? m[1] : null;
}

/**
 * body（已 stripCode 去 code span/fence）是否有一行以純文字 `Closes #<issueNumber>` 開頭
 * （關鍵字大小寫不敏感，對齊 GitHub closing keyword 解析語意——`closes`/`Closes`/`CLOSES` 皆算）。
 * 行首要求刻意比 GitHub 解析更嚴（house rule）：獨立一行、不能是行中片段，也不能只在 code
 * span/fence 裡——呼叫端要自己先 stripCode 再傳進來（本函式不重做去 code，職責單一）。
 * `(?!\d)` 邊界避免 issue #21 誤配到「Closes #210」這種數字前綴相同的情況。
 */
export function hasClosesLine(strippedBody, issueNumber) {
  if (typeof strippedBody !== 'string') return false;
  const re = new RegExp(`^Closes #${issueNumber}(?!\\d)`, 'mi');
  return re.test(strippedBody);
}

function buildVerifyDenyReason(slug) {
  return (
    `這是 loop \`${slug}\` 的分支，開 PR 前必須先過 verify——找不到 ` +
    `\`.loops/${slug}/stages/04-verify.md\`。build 完必先過 verify（多視角 reviewer 驗收）才能` +
    `送審，不能跳過直接開 PR。請先完成 verify 階段（或確認它真的跑完、有落盤產物）再重新 ` +
    `\`gh pr create\`。確需繞過：設 LOOPS_PR_GATE=0。`
  );
}

function buildDraftAssigneeDenyReason(slug, missingDraft, missingAssignee) {
  const missingParts = [];
  if (missingDraft) missingParts.push('`--draft`');
  if (missingAssignee) missingParts.push('`--assignee @me`');
  return (
    `這是 loop \`${slug}\` 的分支，開 PR 要同時帶 \`--draft\` 且 \`--assignee @me\`` +
    `（house rule：先開成 draft、指派給自己，人核可後才轉正式）——目前指令缺 ${missingParts.join('、')}。` +
    `請補齊旗標後重送，例如：\n` +
    `  gh pr create --draft --assignee @me --title <title> --body <body>\n` +
    `確需繞過：設 LOOPS_PR_GATE=0。`
  );
}

function buildClosesDenyReason(issueNumber) {
  return (
    `這是 issue #${issueNumber} 的 loop 分支，PR body 要有獨立一行、行首純文字 ` +
    `\`Closes #${issueNumber}\`（不能包在 code span/fence 裡、也不能只出現在行中）才會被 ` +
    `GitHub 自動關聯、merge 時一併關閉該 issue。請在 body 加上這一行（自己獨立一行）後重送。` +
    `確需繞過：設 LOOPS_PR_GATE=0。`
  );
}

// ── IO 薄邊界（被 import 時不執行 main）──────────────────────────────────────────

/**
 * 從 cwd 起向上最多 12 層找第一個存在的 `.git`，藉此判斷目前 branch 名（cwd 未必就是 `.git` 所在
 * 那層——例如主 checkout 裡 Bash 呼叫當下的 cwd 是 repo 內某個子目錄；祖先上溯的界數與寫法比照
 * 同目錄 worktree-guard.mjs 的 findLoopRoot，兩者同樣「最多 12 層、到檔案系統根就停」）：找到的
 * `.git` 是檔案形（worktree，內容 `gitdir: <path>` 指標，改讀該 gitdir 下的 HEAD）或目錄形（主
 * checkout，直接讀 `<dir>/.git/HEAD`）。HEAD 內容 `ref: refs/heads/<branch>` → 回 branch；裸 SHA
 * （detached HEAD，無 `ref:` 前綴）、遍歷 12 層仍找不到 `.git`、或任何讀檔失敗 → null（判不出、
 * 由呼叫端決定放行）。
 */
export function readGitBranch(cwd) {
  let dir = resolve(cwd);
  let gitPath = null;
  let stat;
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, '.git');
    try {
      stat = statSync(candidate);
      gitPath = candidate;
      break;
    } catch {
      // 這層沒有 .git，往上一層找
    }
    const parent = dirname(dir);
    if (parent === dir) break; // 已到檔案系統根，無法再上溯
    dir = parent;
  }
  if (!gitPath) return null;

  let headPath;
  if (stat.isDirectory()) {
    headPath = join(gitPath, 'HEAD');
  } else {
    let pointer;
    try {
      pointer = readFileSync(gitPath, 'utf8');
    } catch {
      return null;
    }
    const gitdirMatch = pointer.match(/^gitdir:\s*(.+?)\s*$/m);
    if (!gitdirMatch) return null;
    headPath = join(resolve(dir, gitdirMatch[1]), 'HEAD');
  }

  let headContent;
  try {
    headContent = readFileSync(headPath, 'utf8');
  } catch {
    return null;
  }
  const refMatch = headContent.match(/^ref:\s*refs\/heads\/(.+?)\s*$/m);
  return refMatch ? refMatch[1] : null; // 裸 SHA（detached HEAD）→ null
}

function readStdin() {
  return readFileSync(0, 'utf8'); // fd 0 = stdin（hook payload 由父行程以 pipe 餵入）
}

function denyWith(reason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
}

/**
 * PreToolUse(Bash|PowerShell) hook 入口：loop 分支上的 `gh pr create` 依序過三閘，任一不過即
 * deny；非 loop 分支 / 非 gh pr create / 判不出分支一律放行。fail-open：payload 壞 / 缺欄位 /
 * 任何讀檔失敗一律放行。
 */
function main() {
  // 先無條件讀滿 stdin 再判（與家族 sibling 同序，避免大 payload EPIPE）。
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return; // payload 壞 → 放行
  }

  if (!flagEnabled('LOOPS_PR_GATE', process.env)) return; // 字面 '0' opt-out → 放行

  const command = payload?.tool_input?.command;
  if (!isPrCreateCommand(command)) return; // 非 gh pr create → 放行（指令型判定排在最前）

  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : process.cwd();

  // 分支判定兩段式：①worktree 路徑段 → slug；②否則讀 .git/HEAD 取 branch 名當 slug。
  const slug = extractWorktreeSlug(cwd) || readGitBranch(cwd);
  if (!slug) return; // 判不出分支（含 detached HEAD）→ 放行

  const loopRoot = findLoopRoot(cwd, slug);
  if (!loopRoot) return; // slug 不是已建 loop → 放行（非 loop 分支不管）

  // 閘①：build 完必先 verify。
  if (!existsSync(join(loopRoot, '.loops', slug, 'stages', '04-verify.md'))) {
    denyWith(buildVerifyDenyReason(slug));
    return;
  }

  // 閘②：--draft 且 --assignee @me 齊全。
  const missingDraft = !hasDraftFlag(command);
  const missingAssignee = !hasAssigneeMe(command);
  if (missingDraft || missingAssignee) {
    denyWith(buildDraftAssigneeDenyReason(slug, missingDraft, missingAssignee));
    return;
  }

  // 閘③：slug 帶 issue# 時，body 要有行首 Closes #<issue#>（抽不到 body 一律放行此閘——
  // 與 outbound-comment-guard 同一慣例：判不出就不擋）。
  const issueNumber = issueNumberFromSlug(slug);
  if (issueNumber) {
    const readFileSafe = makeHardenedReadFileSafe(cwd);
    const body = extractCommentBody(command, readFileSafe);
    if (body != null && !hasClosesLine(stripCode(body), issueNumber)) {
      denyWith(buildClosesDenyReason(issueNumber));
      return;
    }
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch {
    // fail-open：hook 絕不可因錯誤擋路
  }
  process.exit(0);
}
