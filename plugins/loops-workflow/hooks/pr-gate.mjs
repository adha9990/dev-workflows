#!/usr/bin/env node
// pr-gate.mjs —— loops-workflow PreToolUse(Bash|PowerShell) deny hook：機械化「loop 分支上開 PR /
// 轉正 / 留言前要先過的閘」（issue #132 三閘 + #152 兩閘）。只在**當前處於某個已建 loop 的分支**
// （worktree 路徑段或 `.git/HEAD` 反查 `.loops/<slug>/loop.md` 存在）時生效。
//
// 依指令型別分派各自適用的閘（`classifyPrCommand` → create / ready / comment），依序、命中即擋：
//   `gh pr create` → 閘①②③⑥⑦④⑤；`gh pr ready` → 閘⑥⑦④⑤；`gh pr comment` → 閘⑤。
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
//   ⑥ 收圈硬條件＝P0 清零（#188 建閘、#211 把門檻從「P0/P1」收斂為「只看 P0」——P1 是下界之上的
//     期望，不再是這道機械閘的判準，避免院子裡永遠有 P1 殘留就卡死收圈）：讀 `stages/04-verify.md`
//     的機械 marker `<!-- loops-verify verdict=ready|not-ready p0=<n> p1=<n> round=<n> -->`。判定
//     fail-safe：**raw 與 fence-robust stripped 兩視圖各取最後一個 marker、任一 blocking 即擋**
//     （stripped 擋「fenced 示範 ready marker 蓋掉真 not-ready」；raw 擋「報告裡 fence 把真 marker 藏進
//     fence 內、stripped 漏讀」——真 marker 一定在 raw、藏不掉）。判定以 `p0` 為**權威欄位**（`p0` 能
//     解出數字時，`p0>0` 即擋、`p0<=0` 即放行，`verdict`/`p1` 都不再參與——即使 marker 寫
//     `verdict=not-ready` 或 `p1>0` 也不擋）；只有 `p0` 解不出數字（半寫 marker）時才退回看
//     `verdict==='not-ready'` 當 fail-safe 兜底，防半套 marker 被誤讀成乾淨。deny 時除非
//     **知情豁免**：非 auto 且 `.loops/<slug>/blocking-waiver.md` 非空 → 放行；**auto 一律不認 waiver**
//     （防用豁免繞過、對齊 auto 硬煞車 #4）。兩視圖皆無 marker / 讀檔失敗 → fail-open 放行。
//   ⑦ 第二輪確認沒跑（#209，create + ready）：同一個 marker 多讀兩個欄位
//     `findings=<候選 blocking 條數> validated=<經 finding-validator 確認的條數>`。
//     `findings>0 && validated===0` → deny：報告自己承認有候選 blocking finding、卻一條都沒過二輪確認。
//     **這一格是本閘唯一擋的事**，其餘一律放行：
//       - 兩欄位皆缺（舊報告 / 舊版 verify）→ 放行。**缺席 ≠ 沒派**，把「不知道」當違規就是造假數字；
//       - `findings=0` → 放行（零候選本來就不必派 validator）。
//     唯一的 fail-safe 例外：**已宣告 `findings>0` 卻沒宣告 `validated`** → deny。這只打得到「已經
//     採用新契約、卻只寫一半」的報告（舊報告連 `findings` 都沒有、打不到），且修法就是補上那個數字。
//     **本閘不認 `blocking-waiver.md`**——那份豁免的語意是「知情接受這些風險」，但二輪確認沒跑時
//     風險根本還沒被評估過，沒有東西可以知情接受。確需繞過只有 `LOOPS_PR_VALIDATION_GATE=0`。
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
// 五個獨立 flag（皆 defaultOn，僅字面 '0' 關；各守一組行為、逃生口互不牽連）：
//   LOOPS_PR_GATE           → 閘①②③（build 完先 verify／draft+assignee／Closes 開法，只作用 create）
//   LOOPS_PR_REALRUN_GATE   → 閘④（真機截圖 receipt，作用 create + ready）
//   LOOPS_PR_BLOCKING_GATE  → 閘⑥（P0 未清不准收圈，作用 create + ready；純讀檔；#211 起只認 p0）
//   LOOPS_PR_VALIDATION_GATE→ 閘⑦（第二輪確認沒跑不准收圈，作用 create + ready；純讀檔）
//   LOOPS_PR_CONFLICT_GATE  → 閘⑤（合併衝突，作用 create + ready + comment；唯一 spawn gh）
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
// 依賴：node 內建（fs / path / url / child_process）+ 同目錄 hook-flags、hook-input-normalize
// （tokenizeShellLike——尊重引號切詞的唯一正本，#183 T5 收斂，原本本檔內嵌同一條 regex）、outbound-comment-guard
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
import { tokenizeShellLike } from './hook-input-normalize.mjs';
import { stripCode, extractCommentBody, makeHardenedReadFileSafe } from './outbound-comment-guard.mjs';
import { findLoopRoot, extractWorktreeSlug } from './worktree-guard.mjs';
import { emitDecision, ACTIVE_HARNESS } from './hook-decision-emit.mjs';

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
  const tokens = tokenizeShellLike(cmd);
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

/**
 * 閘⑥：把 marker 掃描前該濾掉的 code 濾掉——**對「未閉合 fence」穩健**（不用 `stripCode`，它只成對去
 * fence/span，未閉合就漏，讓 fenced 示範 marker 存活、被選在 allow 方向〔#188 verify P2〕）。逐行掃：
 *   ①遇到 fence 邊界行（`` ``` `` / `~~~` 起頭）toggle「在 fence 內」並丟掉該行——**未閉合的開 fence
 *     會把其後全部行當 fence 內丟到 EOF**（正是要的：示範 marker 藏在未閉合 fence 後也被丟）；
 *   ②非 fence 內的行，去掉**同一行內**成對的 inline code span（`` `[^`\n]*` ``，不跨行——避免像
 *     `stripCode` 那樣一顆跨行 span 把真 marker 一起吞掉、又造成 allow 方向漏放）。
 * 真 marker 由 verify 寫成獨立 HTML 註解行（無反引號、不在 fence 內），一律存活。
 */
export function stripCodeForMarker(text) {
  if (typeof text !== 'string') return '';
  const lines = text.split(/\r?\n/);
  let inFence = false;
  const kept = [];
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence; // fence 邊界行本身丟掉、切換狀態（未閉合 → 其後到 EOF 皆算 fence 內）
      continue;
    }
    if (inFence) continue;
    kept.push(line.replace(/`[^`\n]*`/g, ' ')); // 同行成對 inline span 去掉（不跨行）
  }
  return kept.join('\n');
}

/**
 * 閘⑥⑦：從**已預處理**的文字取最後一個機械 marker，回傳
 * `{ verdict, p0, p1, round, findings, validated }` 或 null。
 * 契約：`<!-- loops-verify verdict=ready|not-ready p0=<n> p1=<n> round=<n> findings=<n> validated=<n> -->`；
 * `matchAll` global、取**最後一個**（多輪 append 最近一輪 wins；`round` 僅供人讀、不用於選取）；無行錨
 * （`[^>]*?` 不跨 `-->`）CRLF 安全。verdict 原樣回字串（呼叫端**嚴格全等**比對，絕不 `includes`——
 * `not-ready` 內含 `ready`）。
 *
 * `findings`/`validated`（#209）是**後加的欄位**：`findings`＝這一輪去重後的候選 blocking finding 條數、
 * `validated`＝其中經 finding-validator 二輪確認的條數。與 `p0`/`p1` 是不同的量——後者是**判定當下仍未修**
 * 的條數（Ready 時必為 0），所以 `p0=0 p1=0` 完全不代表「這一輪沒有 finding」，也就無法用來判斷第二輪
 * 有沒有跑。缺欄位一律回 `undefined`（**不補 0**）——舊報告沒有這兩欄，補 0 會把「沒寫」讀成「零條」。
 */
export function extractLatestMarker(text) {
  if (typeof text !== 'string') return null;
  const ms = [...text.matchAll(/<!--\s*loops-verify\s+([^>]*?)\s*-->/g)];
  if (ms.length === 0) return null;
  const body = ms[ms.length - 1][1];
  const field = (k) => {
    const m = new RegExp(String.raw`(?:^|\s)${k}=(\S+)`).exec(body);
    return m ? m[1] : undefined;
  };
  const num = (v) => {
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) ? undefined : n;
  };
  return {
    verdict: field('verdict'),
    p0: num(field('p0')),
    p1: num(field('p1')),
    round: num(field('round')),
    findings: num(field('findings')),
    validated: num(field('validated')),
  };
}

/**
 * 閘⑥（#188）：verify 報告（`stages/04-verify.md`）**fence-robust 視圖**的最後一個 marker——先
 * `stripCodeForMarker` 去 code（報告裡示範用的 fenced marker 不被誤選）再取最後一個。p0/p1 = 判定
 * 當下仍未修（blocking）的 P0/P1 條數（Ready ⟹ p0=0 p1=0）。**#211 起**收圈判定只認 `p0`（`p1` 仍解出來
 * 供人讀 / 供 deny 訊息顯示，但不再影響 blocking 與否——見 `hasBlockingFindings`）。**注意**：收圈判定用
 * `verifyReportBlocks`（raw 與 stripped 兩視圖聯合、fail-safe），不是單看本函式——本函式仍匯出供純函式測試。
 */
export function parseLatestVerifyVerdict(text) {
  if (typeof text !== 'string') return null;
  return extractLatestMarker(stripCodeForMarker(text));
}

/**
 * 閘⑥收圈判定（fail-safe 向 deny，#188 verify 修正輪；#211 把門檻收斂為只看 P0）：report 是否代表
 * 「仍有未修 P0」。**raw 視圖與 stripped 視圖的最後 marker，任一 blocking 即 blocking**：
 *   - stripped 視圖擋「fenced 示範 ready marker 蓋掉真 not-ready」（原 P2）；
 *   - raw 視圖擋「報告裡的 fence（貼的 code/diff、`` ``` `` 與 `~~~` 混用、未閉合 fence）把真 marker
 *     藏進 fence 內 → stripped 視圖漏讀 → 誤放行」（P2 的修正引入、又被 re-verify 抓到的反向漏洞）——
 *     真 marker 一定在 raw 裡、藏不掉。
 * 無 marker（兩視圖皆 null）→ false（fail-open 放行，S9：舊報告 / verify 沒吐 marker）。realistic 報告
 * 無示範 marker，raw-last 即真 marker；stripped 只多擋不現實的「貼了示範 marker」情形。代價＝罕見
 * fail-safe 誤擋（報告有未閉合 fence 這種缺陷時），安全方向、有逃生口 `LOOPS_PR_BLOCKING_GATE=0`。
 */
export function verifyReportBlocks(text) {
  if (typeof text !== 'string') return false;
  return hasBlockingFindings(parseLatestVerifyVerdict(text)) || hasBlockingFindings(extractLatestMarker(text));
}

/**
 * 閘⑥：這份 verify verdict 是否代表「仍有未修的 P0」（blocking-first、fail-safe 向 deny；#211 把門檻
 * 從「P0/P1 任一」收斂為「只看 P0」——P1 是收圈下界之上的期望、不再是這道機械閘的判準，`p1` 完全不
 * 參與這個判定，只在 deny 訊息裡印出來給人看）。判定表：
 *   - `parsed` 為 falsy（無 marker / 讀檔失敗）→ false（fail-open 放行）。
 *   - `p0` 能解出數字 → **`p0` 是唯一權威欄位**：`p0>0` → true；`p0<=0` → false——**即使 `verdict` 仍寫
 *     `not-ready`、即使 `p1>0`，`p0<=0` 就不擋**（`verdict`/`p1` 對此列完全不影響結果，避免「只放寬
 *     p1 卻漏放寬 verdict」這種半吊子實作）。
 *   - `p0` 解不出數字（半寫 marker，`p0=abc` 或欄位缺席）→ 退回看 `verdict === 'not-ready'`（嚴格全等）
 *     當 fail-safe 兜底：一份寫到一半、`p0` 還沒填的 marker 不該被讀成「乾淨」。
 *   - 其餘（`p0` 非數字且 `verdict` 不是 `'not-ready'`）→ false。
 */
export function hasBlockingFindings(parsed) {
  if (!parsed) return false;
  if (typeof parsed.p0 === 'number') return parsed.p0 > 0;
  return parsed.verdict === 'not-ready';
}

/**
 * 閘⑦（#209）：這份 verify verdict 是否代表「第二輪確認沒跑」。**只擋一件事**——報告自報有候選
 * blocking finding，卻自報零條經過 finding-validator 確認。
 *
 * 判定表（**放行是預設，deny 是例外**）：
 *   | findings | validated | 結果 | 為什麼 |
 *   |---|---|---|---|
 *   | 缺席 | 任意 | false | 舊報告 / 舊版 verify 沒有這個欄位。**缺席 ≠ 沒派**，不知道就不擋。 |
 *   | 0 | 任意 | false | 零候選 finding 本來就不必派 validator。 |
 *   | >0 | >0 | false | 第二輪跑過了。 |
 *   | >0 | 0 | **true** | 有候選卻零確認 —— 這就是本閘存在的理由。 |
 *   | >0 | 缺席 / 無法解析 | **true** | 已採用新契約卻只寫一半，fail-safe 向 deny（見下）。 |
 *
 * 最後一列是唯一的 fail-safe：它**打不到舊報告**（舊報告連 `findings` 都沒有，落在第一列放行），
 * 只打得到「已經開始寫 `findings=` 卻漏掉 `validated=`」的半套 marker，而那個修法就是補上數字。
 * null（無 marker / 讀檔失敗）→ false，同 fail-open 精神。
 */
export function validationSkipped(parsed) {
  if (!parsed) return false;
  if (typeof parsed.findings !== 'number' || parsed.findings <= 0) return false;
  return typeof parsed.validated !== 'number' || parsed.validated === 0;
}

/**
 * 閘⑦：verify 報告是否代表「第二輪確認沒跑」。與閘⑥ 同一套 raw + fence-robust **兩視圖聯合、
 * 任一命中即擋**（fail-safe 方向一致；理由同 `verifyReportBlocks` 的 doc-comment）。
 */
export function verifyReportSkipsValidation(text) {
  if (typeof text !== 'string') return false;
  return validationSkipped(parseLatestVerifyVerdict(text)) || validationSkipped(extractLatestMarker(text));
}

/**
 * 閘⑥：目前是不是 auto 推進模式（決定豁免 waiver 認不認）。兩訊號：
 *   ①`env.LOOPS_AUTO === '1'`——**唯一防竄改的權威訊號**（hook 讀 session env、agent 動不了；對齊
 *     loop-driver 直讀慣例）；
 *   ②loop.md 的「推進模式：auto」欄位行（field-anchored 正則：行首起 bullet/星號 + `推進模式` +
 *     `：/:` + `auto`）——補「auto 經 loop.md 授權但 env 未設」（如 loop #113/#119/#164），值位置
 *     錨定避免 Journal 裡「把推進模式：auto 改回 closed」這類敘述誤中。
 * **誠實範圍（journaling 揭露）**：loop.md 由 agent 自己擁有、理論上可改掉欄位行規避——故「auto 不得
 * 用豁免繞過」的機械保證在正常 auto（env）路徑成立，純靠 loop.md 而 env 未設是 best-effort；loop.md
 * 讀不到時退為 env-only（fail-open 不誤擋，但 auto-bypass 防護退為 env 權威）。
 */
export function isAutoMode(env, loopMdText) {
  if (env && env.LOOPS_AUTO === '1') return true;
  // 大小寫不敏感（`i`）：對齊 sibling `hasClosesLine` 的 case-insensitive 慣例，`推進模式：Auto`/`AUTO`
  // 也判到（值位置錨定；env 才是防竄改的權威訊號，見 doc-comment 誠實範圍）。
  return typeof loopMdText === 'string'
    && /^[-*\s]*\*{0,2}推進模式\*{0,2}\s*[：:]\s*auto\b/mi.test(loopMdText);
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

function buildBlockingDenyReason(slug, parsed, auto) {
  const counts = `p0=${parsed?.p0 ?? '?'} p1=${parsed?.p1 ?? '?'}` + (parsed?.verdict ? ` verdict=${parsed.verdict}` : '');
  const exemptionLine = auto
    ? `auto 模式**不得**帶著未修的 P0 收圈（auto 硬煞車 #4）——請停下讓使用者接手（attended）決定；` +
      `此時 waiver 不被認可（防 auto 用豁免繞過）。`
    : `若使用者知情決定帶著未修的 P0 先進 PR：在 \`.loops/${slug}/blocking-waiver.md\` 寫明豁免哪幾條 ` +
      `＋理由（非空檔）並同步 issue / PR 留痕，再重試（此知情豁免僅 attended 生效、auto 不認）。`;
  return (
    `這是 loop \`${slug}\` 的分支，最近一輪 verify 仍有未修的 P0（${counts}）——收圈（開 / 轉正 PR）的` +
    `硬條件是 P0 清零（見 iterate §5）。P0 不再和 P1 混算：這道閘只看 p0，p0=0 就不擋，即使 verdict 仍寫` +
    `\`not-ready\` 或 p1 還有殘留也一樣——但這只是收圈的**下界**、不代表 P1 可以不修，仍請比照 P0 一併處理。` +
    `請先把未修的 P0 修完、再跑一輪 verify 到 Ready 再重試。` +
    exemptionLine +
    `確需繞過本閘：設 LOOPS_PR_BLOCKING_GATE=0。`
  );
}

function buildValidationDenyReason(slug, parsed) {
  const missing = typeof parsed?.validated !== 'number';
  const counts = `findings=${parsed?.findings ?? '?'} validated=${missing ? '(缺)' : parsed.validated}`;
  const body = missing
    ? `marker 宣告了 \`findings=${parsed?.findings ?? '?'}\` 卻沒宣告 \`validated=\`——補上「其中幾條經過 ` +
      `finding-validator 二輪確認」這個數字再重試（真的一條都沒確認就寫 \`validated=0\`，本閘會如實擋下）。`
    : `這一輪有 ${parsed?.findings} 條候選 blocking finding，卻沒有任何一條經過 \`finding-validator\` 的` +
      `二輪確認（是否真實 / 是否本次引入 / 是否已被既有防護處理 / 修法是否對症）。**未經確認的 finding ` +
      `不該驅動 iterate**——會去修根本不需要修的東西。請對每條候選 blocking finding 派 ` +
      `\`finding-validator\`，把結果寫回報告的 \`Validation coverage\`，並更新 marker 的 \`validated=\`。`;
  return (
    `這是 loop \`${slug}\` 的分支，最近一輪 verify 的第二輪確認沒跑（${counts}）——` +
    body +
    `\n\n本閘**不認 \`blocking-waiver.md\`**：那份豁免的語意是「知情接受這些風險」，但二輪確認沒跑時` +
    `風險還沒被評估過，沒有東西可以知情接受。確需繞過：設 LOOPS_PR_VALIDATION_GATE=0。`
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
 * 閘⑥：讀 `stages/04-verify.md` 原始文字（收圈判定由 `verifyReportBlocks` 用 raw+stripped 兩視圖做）。
 * 讀檔失敗 / 檔不存在 → null（fail-open 放行，同 `realRunReceiptExists` 的 try/catch 精神）。
 */
export function readVerifyText(loopRoot, slug) {
  try {
    return readFileSync(join(loopRoot, '.loops', slug, 'stages', '04-verify.md'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * 閘⑥：知情豁免 waiver 是否存在且非空——`.loops/<slug>/blocking-waiver.md` 為**非空一般檔**
 * （`statSync isFile && size>0`，仿 `realRunReceiptExists` 擋純 `touch` 空檔 / 同名子目錄）。
 * 讀不到 / 不存在 → false。
 */
export function waiverExists(loopRoot, slug) {
  try {
    const st = statSync(join(loopRoot, '.loops', slug, 'blocking-waiver.md'));
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/** 閘⑥：讀 loop.md 文字（供 `isAutoMode` 的 loop.md 訊號）；讀不到回 ''（→ isAutoMode 退為 env-only）。 */
function readLoopMdText(loopRoot, slug) {
  try {
    return readFileSync(join(loopRoot, '.loops', slug, 'loop.md'), 'utf8');
  } catch {
    return '';
  }
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
  // 「擋不擋、理由是什麼」留在本檔；信封形狀交給 hook-decision-emit.mjs 這個單一葉節點（#183 T13）。
  const decision = emitDecision({ kind: 'deny', reason }, ACTIVE_HARNESS, 'PreToolUse');
  if (decision !== null) console.log(decision);
}

/**
 * PreToolUse(Bash|PowerShell) hook 入口：依指令型別（create / ready / comment）跑各自適用的閘，
 * 依序、命中即 deny；非受管 gh pr 指令 / 非 loop 分支 / 判不出分支一律放行。fail-open：payload 壞 /
 * 缺欄位 / 任何讀檔或 gh 錯誤一律放行。
 *   create  → ①②③（LOOPS_PR_GATE）→ ⑥（LOOPS_PR_BLOCKING_GATE）→ ⑦（LOOPS_PR_VALIDATION_GATE）
 *             → ④（LOOPS_PR_REALRUN_GATE）→ ⑤（LOOPS_PR_CONFLICT_GATE）
 *   ready   → ⑥ → ⑦ → ④ → ⑤
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
  const runBlocking = flagEnabled('LOOPS_PR_BLOCKING_GATE', process.env) && (kind === 'create' || kind === 'ready'); // ⑥
  const runValidation = flagEnabled('LOOPS_PR_VALIDATION_GATE', process.env) && (kind === 'create' || kind === 'ready'); // ⑦
  const runConflict = flagEnabled('LOOPS_PR_CONFLICT_GATE', process.env); // ⑤（三型皆可能）
  if (!runClosesGates && !runRealRun && !runBlocking && !runValidation && !runConflict) return;

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

  // 閘⑥（#188 建閘、#211 門檻收斂為只看 P0）：verify 仍有未修 P0 → 不准收圈（create + ready）。排在
  // 閘④ 前——verify blocking 比截圖 receipt 更根本；仍在唯一 spawn gh 的閘⑤ 之前（純讀檔、廉價）。
  // blocking 時：auto 一律 deny（waiver 不認、防繞過）；非 auto 則有非空 waiver 才放行（知情豁免）。
  // 閘⑥⑦ 共讀同一份 verify 報告：兩閘都是純讀檔、判的是**同一個 marker 的不同欄位**（⑥ 看 p0/p1
  // ＝仍未修的 blocking 條數，⑦ 看 findings/validated ＝這一輪有幾條候選、確認了幾條），沒有理由
  // 讀兩次。⑥ 排在 ⑦ 前：還有未修 P0/P1 時，先講那件更根本的事。
  if (runBlocking || runValidation) {
    const verifyText = readVerifyText(loopRoot, slug);

    if (runBlocking && verifyReportBlocks(verifyText)) {
      const auto = isAutoMode(process.env, readLoopMdText(loopRoot, slug));
      if (auto || !waiverExists(loopRoot, slug)) {
        // deny 訊息挑「真正 blocking 的那個 marker」的計數顯示（stripped 優先，退 raw）。
        const strM = parseLatestVerifyVerdict(verifyText);
        const parsed = hasBlockingFindings(strM) ? strM : extractLatestMarker(verifyText);
        denyWith(buildBlockingDenyReason(slug, parsed, auto));
        return;
      }
    }

    // 閘⑦（#209）：第二輪確認沒跑 → 不准收圈。**不認 waiver**（見檔頭 ⑦ 說明：風險還沒被評估過，
    // 沒有東西可以知情接受），所以也不必判 auto/attended——兩者一視同仁。
    if (runValidation && verifyReportSkipsValidation(verifyText)) {
      const strM = parseLatestVerifyVerdict(verifyText);
      const parsed = validationSkipped(strM) ? strM : extractLatestMarker(verifyText);
      denyWith(buildValidationDenyReason(slug, parsed));
      return;
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
