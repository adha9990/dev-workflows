#!/usr/bin/env node
// pr-gate.mjs —— loops-workflow PreToolUse(Bash|PowerShell) deny hook：機械化「loop 分支上開 PR /
// 轉正 / 留言前要先過的閘」（issue #132 三閘 + #152 兩閘）。只在**當前處於某個已建 loop 的分支**
// （worktree 路徑段或 `.git/HEAD` 反查 `.loops/<slug>/loop.md` 存在）時生效。
//
// 依指令型別分派各自適用的閘（`classifyPrCommand` → create / ready / comment），依序、命中即擋：
//   `gh pr create` → 閘①②③④⑤；`gh pr ready` → 閘④⑤；`gh pr comment` → 閘⑤。
//   （既有三閘①②③ 維持只作用於 `gh pr create`，不套到 ready/comment，避免誤擋。）
//
//   ① `stages/04-verify.md` 不存在 → deny（build 完必先過 verify，不能跳過直接送審）
//   ② 指令缺 `--draft` 或缺 `--assignee @me` → deny 附補救指令（house rule：先開 draft、指派自己）
//   ③ slug 以 `<issue#>-` 開頭時，PR body（stripCode 去 code span/fence 後）沒有行首純文字
//     `Closes #<issue#>` → deny（比 GitHub 解析更嚴的 house rule：換取版型一致＋零解析歧義）
//   ④ 真機驗證截圖 receipt（#152）：`.loops/<slug>/deliverables/real-run/` 下沒有任何截圖檔
//     （*.png/*.jpg/*.jpeg），且沒有**非空**的 `no-ui*` 標記檔 → deny，通用指示去跑專案宣告的
//     run / 驗證方式、人眼截圖存進該資料夾。jsdom / 單元測試綠 ≠ 真機正確。非視覺 loop（純後端 /
//     純文檔 / 純工具）放一個非空 `no-ui.md`（寫明為何無畫面可驗）即通過。
//   ⑤ PR 合併衝突（#152）：spawn `gh pr view --json mergeable,mergeStateStatus`（不帶 PR 號、讓 gh
//     從當前分支推斷 PR），`mergeable === 'CONFLICTING'` 或 `mergeStateStatus === 'DIRTY'` → deny，
//     要求先解衝突再送。**指令帶顯式 PR 號 / branch / url**（如 `gh pr comment 123`）時**跳過本閘**
//     ——那針對的未必是當前分支的 PR，查當前分支 mergeability 會誤擋。
//
// 非 loop 分支／非受管 gh pr 指令／任何判不出的情況（含 detached HEAD）一律放行——這是提醒型
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
// 三個獨立 flag（皆 defaultOn，僅字面 '0' 關；各守一組行為、逃生口互不牽連）：
//   LOOPS_PR_GATE          → 閘①②③（build 完先 verify／draft+assignee／Closes 開法，只作用 create）
//   LOOPS_PR_REALRUN_GATE  → 閘④（真機截圖 receipt，作用 create + ready）
//   LOOPS_PR_CONFLICT_GATE → 閘⑤（合併衝突，作用 create + ready + comment；唯一 spawn gh）
// fail-open：payload 壞 / 讀檔失敗 / 判不出分支 / gh 錯誤一律放行 exit 0，永不因 hook 故障卡住使用者。
//
// 閘⑤ 的 `gh` spawn 不會遞迴觸發 PreToolUse——PreToolUse 只對 model 的 tool call 觸發，不對 hook
// 自身 spawn 的子行程。測試注入 seam：`readMergeability` 在 `env.LOOPS_PR_CONFLICT_STUB` 有值時把它
// 當「gh 會印的原始 JSON 字串」，與真 gh 路徑共用同一段 JSON.parse（讓解析路徑受測、非注入已解析
// 結果）。安全：clean stub ≡ `LOOPS_PR_CONFLICT_GATE=0` 逃生、conflicting stub 只擋自己 → 零提權。
//
// 分層（仿同目錄 outbound-comment-guard.mjs / worktree-guard.mjs）：
//   1) 純函式（無 IO）：isPrCreateCommand / isPrReadyCommand / isPrCommentCommand / classifyPrCommand /
//      hasDraftFlag / hasAssigneeMe / issueNumberFromSlug / hasClosesLine / isScreenshotFile /
//      isNoUiMarker / isMergeConflict / hasExplicitPrTarget / 各閘 deny 理由組字函式。
//   2) IO 薄邊界：readGitBranch（讀 cwd 的 .git）、realRunReceiptExists（讀 real-run 目錄）、
//      readMergeability（spawn gh / 讀 stub）、main()（讀 stdin、印 deny）——import 時不執行。
// 依賴：node 內建（fs / path / url / child_process）+ 同目錄 hook-flags、outbound-comment-guard
// （stripCode / extractCommentBody / makeHardenedReadFileSafe）、worktree-guard（findLoopRoot /
// extractWorktreeSlug）——閘與分支判定不重抄兄弟 hook 已寫好、已測過的邏輯。
// stripQuotedValues／readGitBranch 對外 export：供 merge-guard.mjs 重用（#133）——同一套「剝殼視圖
// 判子指令詞」「讀 .git 判分支」邏輯，不重抄。isPrReadyCommand／prSubcommandAtSegmentStart 對外
// export：供 pr-owner-guard.mjs 重用（#164）——同一套「剝殼視圖判 gh pr 子指令位置」邏輯，不重抄。

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

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
 * 這條指令有沒有一段「命令段開頭」是 `gh pr <sub>`。兩道防誤判：
 *   ①先 stripQuotedValues 剝掉引號包住的參數值——避免字樣只出現在別的指令的引號值裡（例如
 *     `gh issue comment` 的 `--body` 內文提到這幾個字）被誤判。
 *   ②要求 `gh` 出現在**命令段開頭**（字串開頭，或 `;`／`&`／`|`／換行／`(`／`` ` ``／`{` 這些命令
 *     分隔符之後）——避免未加引號的 heredoc／`-F -` 本文（如 `git commit` 的 message body 行中提到
 *     「gh pr comment 流程」）被當成真的在執行 `gh pr <sub>`（#152 verify 實測踩過：commit 訊息含
 *     這幾個字被誤擋）。收尾 `(?=\s|$)` 防 `create-xxx`／`ready-xxx` 這類未來子指令誤中。
 * 注意：只有這裡的偵測用剝殼視圖——後續 hasDraftFlag / hasAssigneeMe / extractCommentBody 等仍
 * 作用於原始字串，不能連真正的旗標與 body 內容都被剝掉。
 */
// export：供 pr-owner-guard.mjs 重用（#164）——同一套「剝殼視圖判子指令詞在命令段開頭」邏輯
// （用於判 `gh pr edit`/`gh pr create` 子指令位置），不重抄。
export function prSubcommandAtSegmentStart(cmd, sub) {
  if (typeof cmd !== 'string') return false;
  // 收尾 lookahead 允許空白／字串結尾／shell 分隔符（`)` `;` `&` `|`）——後者涵蓋 `(gh pr ready)`
  // 這類子 shell 包住的情形；仍擋 `ready-xxx`／`create-xxx`（`-` 不在收尾集合）這類未來子指令誤中。
  return new RegExp(String.raw`(?:^|[\n;&|(\`{])\s*gh\s+pr\s+${sub}(?=[\s)|;&]|$)`).test(stripQuotedValues(cmd));
}

/**
 * 這條指令是不是在命令段開頭執行 `gh pr create`（非此一律放行，判定排在最前——即使 cwd 本身三閘
 * 全違規也不管）。
 */
export function isPrCreateCommand(cmd) {
  return prSubcommandAtSegmentStart(cmd, 'create');
}

/** 是不是在命令段開頭執行 `gh pr ready`（轉 draft PR 為 Ready）。 */
export function isPrReadyCommand(cmd) {
  return prSubcommandAtSegmentStart(cmd, 'ready');
}

/** 是不是在命令段開頭執行 `gh pr comment`（對 PR 留言）。 */
export function isPrCommentCommand(cmd) {
  return prSubcommandAtSegmentStart(cmd, 'comment');
}

/**
 * 把指令分類成受管的三型 gh pr 動作之一，或 null（非受管）：'create' / 'ready' / 'comment'。
 * 三者互斥（不同子指令），依 create→ready→comment 判。呼叫端據此決定跑哪組閘。
 */
export function classifyPrCommand(cmd) {
  if (isPrCreateCommand(cmd)) return 'create';
  if (isPrReadyCommand(cmd)) return 'ready';
  if (isPrCommentCommand(cmd)) return 'comment';
  return null;
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

/** 檔名是不是截圖（*.png / *.jpg / *.jpeg，大小寫不敏感）——閘④ 認可的真機驗證 receipt 型別之一。 */
export function isScreenshotFile(name) {
  return typeof name === 'string' && /\.(png|jpe?g)$/i.test(name);
}

/**
 * 檔名是不是「非視覺 loop」宣告標記（basename 以 `no-ui` 起頭、大小寫不敏感——`no-ui.md` /
 * `NO-UI.txt` / `no-ui-reason.md` 皆算）。`\b` 收尾：`no-ui` 後接非 word 字元（`.`/`-`）或字串結尾
 * 才算，避免 `nouix` 這類誤中。是否**非空**由 IO 層 realRunReceiptExists 再驗（純函式只判名字）。
 */
export function isNoUiMarker(name) {
  return typeof name === 'string' && /^no-ui\b/i.test(name);
}

/**
 * GitHub 已算好的 mergeability 是不是「有衝突」：`mergeable === 'CONFLICTING'` 或
 * `mergeStateStatus === 'DIRTY'`。null / 非物件 / 缺欄位 / UNKNOWN 一律 false（fail-open：只有明確
 * 衝突才擋，判不出不擋）。
 */
export function isMergeConflict(info) {
  return !!info && (info.mergeable === 'CONFLICTING' || info.mergeStateStatus === 'DIRTY');
}

/**
 * 指令是否指向「未必是當前分支的 PR」——有的話閘⑤ 該跳過（查當前分支 mergeability 會誤擋）。兩種情形：
 *   ①子指令 ready/comment 後緊接一個非 flag 的 positional token（PR 號 / url / branch，如
 *     `gh pr comment 123`）；②帶 `-R` / `--repo`（跨 repo 目標，絕不會是當前分支的 PR，即使 PR 號
 *     positional 被夾在 flag 之後也涵蓋，如 `gh pr comment --repo o/r 123`）。
 * create 永遠沒有 PR 目標（新建當前分支的 PR）→ 一律 false。
 * 尊重引號切 token（`gh pr comment "123"` 也算顯式目標）；被引號包住的內文不會被誤拆（整段一顆
 * token），故 `--body "...gh pr comment 5..."` 不會誤判。
 */
export function hasExplicitPrTarget(cmd, kind) {
  if ((kind !== 'ready' && kind !== 'comment') || typeof cmd !== 'string') return false;
  const tokens = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    tokens.push({ value: m[1] ?? m[2] ?? m[3], quoted: m[1] !== undefined || m[2] !== undefined });
  }
  // ②跨 repo：任一 flag token 是 -R / --repo / --repo=…（引號包住的不算 flag）→ 顯式目標。
  const hasRepoFlag = tokens.some(
    (t) => !t.quoted && (t.value === '-R' || t.value === '--repo' || t.value.startsWith('--repo=')),
  );
  if (hasRepoFlag) return true;
  // ①子指令緊接的下一個 token 是非 flag positional → 顯式目標。
  for (let i = 0; i + 2 < tokens.length; i += 1) {
    if (tokens[i].value === 'gh' && tokens[i + 1].value === 'pr' && tokens[i + 2].value === kind) {
      const next = tokens[i + 3];
      if (!next) return false; // 子指令後無 token → 隱式當前分支
      if (!next.quoted && next.value.startsWith('-')) return false; // flag → 隱式當前分支
      return true; // 非 flag positional（含引號包住的）→ 顯式目標
    }
  }
  return false;
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

function buildRealRunDenyReason(slug) {
  return (
    `這是 loop \`${slug}\` 的分支，開 / 轉正 PR 前要有「真機驗證」的截圖存證——找不到 ` +
    `\`.loops/${slug}/deliverables/real-run/\` 下任何截圖檔（*.png/*.jpg/*.jpeg）。` +
    `jsdom / 單元測試綠 ≠ 真機正確：請用**本專案宣告的方式**（見專案 AGENTS.md / CLAUDE.md 宣告的 ` +
    `run / verify / smoke skill 或啟動指令）把 app 跑起來、人眼確認這次改動的畫面，把截圖存到 ` +
    `\`.loops/${slug}/deliverables/real-run/\` 再重試。` +
    `若這條 loop 沒有可見畫面可截（純後端 / 純文檔 / 純工具），在同一資料夾放一個**非空**的 ` +
    `\`no-ui.md\`（寫明為何無畫面可驗、改用什麼方式驗，如 API 回應 / driver log）即可通過此閘。` +
    `確需繞過：設 LOOPS_PR_REALRUN_GATE=0。`
  );
}

function buildConflictDenyReason(slug, info) {
  return (
    `這是 loop \`${slug}\` 的分支，對應 PR 目前與 base 有合併衝突` +
    `（mergeable=${info?.mergeable} / mergeStateStatus=${info?.mergeStateStatus}）——` +
    `留言 / 開 PR / 轉正前請先解衝突：把 base（通常 master）merge 或 rebase 進本分支、解掉衝突、` +
    `push，等 GitHub 重新判定為可合併後再重試。確需繞過：設 LOOPS_PR_CONFLICT_GATE=0。`
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

/**
 * 閘④：`.loops/<slug>/deliverables/real-run/` 是否已有有效真機驗證 receipt——任一**非空的一般檔**
 * 且檔名是截圖（*.png/*.jpg/*.jpeg）或 `no-ui*` 標記。目錄不存在 / 讀不到 / 全空 → false（→ deny）。
 * **非空一般檔判定（statSync isFile && size>0）對截圖與 no-ui 一視同仁**——擋 `touch shot.png` 空檔
 * 或同名子目錄（`mkdir shot.png`）這類「假裝有跑過」的繞過，逼真的產出截圖 / 寫一行理由。
 */
export function realRunReceiptExists(loopRoot, slug) {
  const dir = join(loopRoot, '.loops', slug, 'deliverables', 'real-run');
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return false; // 目錄不存在 / 讀不到 → 無 receipt
  }
  for (const name of names) {
    if (!isScreenshotFile(name) && !isNoUiMarker(name)) continue;
    try {
      const st = statSync(join(dir, name));
      if (st.isFile() && st.size > 0) return true; // 非空一般檔才算 receipt
    } catch {
      // 這個項目讀不到 → 不當有效 receipt，繼續看下一個
    }
  }
  return false;
}

/**
 * 閘⑤：讀 GitHub 已算好的 mergeability（`{ mergeable, mergeStateStatus }`）或 null（fail-open）。
 * `env.LOOPS_PR_CONFLICT_STUB` 有值 → 當「gh 會印的原始 JSON 字串」；否則 spawn
 * `gh pr view --json mergeable,mergeStateStatus`（不帶 PR 號、cwd 內從當前分支推斷 PR、5s timeout）。
 * 兩條路徑共用下面同一段 JSON.parse（讓解析路徑受測、非注入已解析結果）。gh 未安裝 / 無對應 PR /
 * 非零離開 / timeout / 非 JSON → null（→ 放行）。hook spawn 的 gh 子行程不遞迴觸發 PreToolUse。
 */
// 閘⑤ 查 mergeability 的 gh argv（抽成 export 常數：讓測試釘死子指令與 `--json` 欄名，避免把
// `mergeable`／`mergeStateStatus` 拼錯或改壞而 stub 測試照樣綠——stub 會短路真 spawn，不 pin 這條就
// 無斷言守住真實 argv）。欄名 = isMergeConflict 讀的兩欄；「不帶 PR 號」讓 gh 從 cwd 當前分支推斷。
export const GH_MERGEABILITY_ARGS = ['pr', 'view', '--json', 'mergeable,mergeStateStatus'];

export function readMergeability(cwd, env = process.env) {
  let raw;
  const stub = env?.LOOPS_PR_CONFLICT_STUB;
  if (typeof stub === 'string' && stub) {
    raw = stub; // 測試注入：gh 會印的原始 JSON 字串
  } else {
    try {
      raw = execFileSync('gh', GH_MERGEABILITY_ARGS, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000, // 逾時反正 fail-open 放行，等久無益
      });
    } catch {
      return null; // gh 未安裝 / 無 PR / 非零離開 / timeout → fail-open
    }
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null; // 非 JSON → fail-open
  }
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
 * PreToolUse(Bash|PowerShell) hook 入口：依指令型別（create / ready / comment）跑各自適用的閘，
 * 依序、命中即 deny；非受管 gh pr 指令 / 非 loop 分支 / 判不出分支一律放行。fail-open：payload 壞 /
 * 缺欄位 / 任何讀檔或 gh 錯誤一律放行。
 *   create  → ①②③（LOOPS_PR_GATE）→ ④（LOOPS_PR_REALRUN_GATE）→ ⑤（LOOPS_PR_CONFLICT_GATE）
 *   ready   → ④ → ⑤
 *   comment → ⑤
 * 閘⑤（唯一 spawn gh）殿後：廉價的檔案 / 字串判定全過才 spawn，省無謂子行程（仿 merge-guard
 * 「便宜判定放前面」）。
 */
function main() {
  // 先無條件讀滿 stdin 再判（與家族 sibling 同序，避免大 payload EPIPE）。
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return; // payload 壞 → 放行
  }

  const command = payload?.tool_input?.command;
  const kind = classifyPrCommand(command); // 'create' | 'ready' | 'comment' | null
  if (!kind) return; // 非受管 gh pr 指令 → 放行（指令型判定排在最前）

  // 各 flag 各守一組閘；先算出本指令實際會跑哪些閘，三組都沒開就免做分支偵測。
  const runClosesGates = flagEnabled('LOOPS_PR_GATE', process.env) && kind === 'create'; // ①②③
  const runRealRun = flagEnabled('LOOPS_PR_REALRUN_GATE', process.env) && (kind === 'create' || kind === 'ready'); // ④
  const runConflict = flagEnabled('LOOPS_PR_CONFLICT_GATE', process.env); // ⑤（三型皆可能）
  if (!runClosesGates && !runRealRun && !runConflict) return;

  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : process.cwd();

  // 分支判定兩段式：①worktree 路徑段 → slug；②否則讀 .git/HEAD 取 branch 名當 slug。
  const slug = extractWorktreeSlug(cwd) || readGitBranch(cwd);
  if (!slug) return; // 判不出分支（含 detached HEAD）→ 放行

  const loopRoot = findLoopRoot(cwd, slug);
  if (!loopRoot) return; // slug 不是已建 loop → 放行（非 loop 分支不管）

  // 閘①②③（僅 create）——邏輯與作用範圍同 #132，原封不動。
  if (runClosesGates) {
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

  // 閘④：真機驗證截圖 receipt（create + ready 共用）。
  if (runRealRun && !realRunReceiptExists(loopRoot, slug)) {
    denyWith(buildRealRunDenyReason(slug));
    return;
  }

  // 閘⑤：PR 合併衝突（create + ready + comment，殿後、唯一 spawn gh）。指令帶顯式 PR 目標時跳過
  // （那未必是當前分支的 PR，查當前分支 mergeability 會誤擋）。
  if (runConflict && !hasExplicitPrTarget(command, kind)) {
    const info = readMergeability(cwd, process.env);
    if (isMergeConflict(info)) {
      denyWith(buildConflictDenyReason(slug, info));
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
