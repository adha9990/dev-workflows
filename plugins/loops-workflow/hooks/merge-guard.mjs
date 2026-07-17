#!/usr/bin/env node
// merge-guard.mjs —— loops-workflow PreToolUse(Bash|PowerShell) deny hook：機械化「合併回主幹是人核可
// （human gate）的動作，不能由 Claude 直接執行」（issue #133）。與 pr-gate.mjs（擋 loop 分支上未過三閘
// 的 `gh pr create`）是姊妹規則：那個管「開 PR 前要過的閘」、本檔管「合併這個動作本身要人核可」——
// 不限 loop 分支，任何 cwd 偵測到以下四型指令一律 deny：
//   ① `gh pr merge`（任意 flag 組合）——PR 合併鍵要人類按，不能 Claude 直接呼叫。
//   ② cwd 目前所在分支是 main/master 時的 `git merge <ref>`——把別的分支併入主幹前要有人核可；
//      非主幹分支上的 `git merge`（互併 feature 分支）合法、不擋；判不出分支（無 .git／detached
//      HEAD）一律放行（fail-open，不能因為判斷不出來就卡人）。
//   ③ `git push` 的目的地是 main/master（bare positional／refspec 冒號右側／`--delete` 皆算，
//      `--delete` 不豁免）——直接推進主幹等同繞過 PR review。push 到 feature 分支放行。
//   ④ `gh api` 用 PUT/`--method PUT` 打 `/pulls/.../merge` 路徑——這是透過 API 直接合併 PR，效果
//      同①，一樣要擋。GET（查狀態）或非 `/merge` 路徑放行。
//
// 視圖分工（D1，#132 Q1 同課＋審查實測補強兩缺口）：**子指令詞判定**（這是不是 `gh pr merge`／
// `git merge`／`gh api`+PUT）一律用 stripQuotedValues 剝殼視圖判——避免指令詞字面只是出現在別的
// 指令的引號值裡（例如 `gh issue comment --body "...git merge..."`）被誤判成真的執行。但**push
// 目的地與 api 路徑**改判**原始未剝殼字串**——剝殼視圖會把引號包住的目的地/路徑一併消掉
// （`git push origin "HEAD:master"` 整段 refspec 被引號包住、`gh api -X PUT "repos/x/y/pulls/1/merge"`
// 路徑被引號包住），若對剝殼視圖判會造成偽陰性、漏放真正的高風險指令。
//
// 預設啟用（defaultOn）；env LOOPS_MERGE_GUARD='0'（字面 '0'）可關。
// fail-open：payload 壞 / 缺 command / 判不出分支一律放行 exit 0，永不因 hook 故障卡住使用者。
// 與使用者層既有的「gh pr merge 需人核可」提醒並存＝雙保險、不衝突（見 references/journaling.md
// 本 hook 條目尾註）。
//
// 分層（仿同目錄 pr-gate.mjs / worktree-guard.mjs）：
//   1) 純函式（無 IO）：isPrMergeCommand / isGitMergeCommand / isMainBranch / isPushToMainDestination /
//      isApiPutMergeCommand / classifyMergeCommand（四型分類主入口）/ deny 理由組字函式。
//   2) IO 薄邊界：main()（讀 stdin、呼叫 pr-gate.mjs 匯出的 readGitBranch、印 deny）——import 時不執行。
// 依賴：node 內建（fs / url）+ 同目錄 hook-flags（flagEnabled）、pr-gate（stripQuotedValues /
// readGitBranch，#133 plan §1：pr-gate.mjs 僅加 export、零行為變更）——子指令詞剝殼判定與分支
// 判定不重抄 pr-gate.mjs 已寫好、已測過的邏輯。

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { flagEnabled } from './hook-flags.mjs';
import { stripQuotedValues, readGitBranch } from './pr-gate.mjs';

// ── 純函式層（無 IO）──────────────────────────────────────────────────────────────

/**
 * 是不是 `gh pr merge`（任意 flag 組合）。比對前先用 stripQuotedValues 剝掉引號包住的參數值，
 * 避免字樣只出現在別的指令的引號值裡（例如 `gh issue comment --body "...gh pr merge..."`）被
 * 誤判成真的執行（仿 pr-gate.mjs 的 isPrCreateCommand）。
 */
export function isPrMergeCommand(cmd) {
  return typeof cmd === 'string' && /\bgh\s+pr\s+merge\b/.test(stripQuotedValues(cmd));
}

/**
 * 是不是 `git merge`（不判斷 branch——branch 判斷交給 classifyMergeCommand／呼叫端，因為「併到
 * 哪個分支才算高風險」需要外部脈絡）。同樣剝殼視圖判，理由同上。
 */
export function isGitMergeCommand(cmd) {
  return typeof cmd === 'string' && /\bgit\s+merge\b/.test(stripQuotedValues(cmd));
}

/** branch 是不是 main/master（非字串——含 null，判不出分支時的傳入值——一律 false）。 */
export function isMainBranch(branch) {
  return branch === 'main' || branch === 'master';
}

/**
 * 取指令字串最後一個 shell token（尊重單/雙引號包住的整段，回傳去引號後的內容）。
 * `git push` 的目的地不論是 bare positional（`origin master`）、refspec（`origin any:master`）
 * 或 `--delete <branch>`，該值都落在指令的最後一個 token——三形不必分開解析、統一從尾端抽取即可。
 * 找不到（例如空字串）回 null。
 */
function lastShellToken(cmd) {
  const m = cmd.match(/(?:'([^']*)'|"([^"]*)"|(\S+))\s*$/);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/** value（bare 分支名或 refspec 右側）是否指向 main/master（含 refs/heads/ 完整形）。 */
function isMainRefLike(value) {
  if (typeof value !== 'string') return false;
  const dest = value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : value;
  return dest === 'master' || dest === 'main' || dest === 'refs/heads/master' || dest === 'refs/heads/main';
}

// refspec「冒號右側＝main/master」：掃整段原始字串（不限最後一個 token，容忍前面還有其他 flag），
// 右側容忍被引號包住（引號可能緊接冒號後、或收在分支名後——`"HEAD:master"` 這種整段refspec被引號
// 包住時，冒號後直接是分支名，分支名後接收尾引號）。左側（冒號前）不論內容為何。
const REFSPEC_MAIN_RE = /:['"]?(?:refs\/heads\/)?(?:master|main)(?=['"\s]|$)/;
// `--delete <branch>` 形：同樣掃整段原始字串，不限最後一個 token。
const DELETE_MAIN_RE = /--delete\s+['"]?(?:refs\/heads\/)?(?:master|main)(?=['"\s]|$)/;

/**
 * 是不是「`git push` 到 main/master」。對『原始未剝殼』cmd 判：先用剝殼視圖確認是 `git push`
 * （避免指令詞誤判，同①②），destination 判定一律對原始字串——bare positional／refspec 冒號右側
 * （左側不論、容忍引號包裹整段）／`--delete` 值，三形皆算，`--delete` 不豁免。push 到 feature
 * 分支（含 `--delete feature`）放行。
 */
export function isPushToMainDestination(cmd) {
  if (typeof cmd !== 'string') return false;
  if (!/\bgit\s+push\b/.test(stripQuotedValues(cmd))) return false;
  if (REFSPEC_MAIN_RE.test(cmd)) return true;
  if (DELETE_MAIN_RE.test(cmd)) return true;
  return isMainRefLike(lastShellToken(cmd));
}

/**
 * 是不是「`gh api` 用 PUT 打 `/pulls/.../merge` 路徑」。`gh api`／PUT 判定用剝殼視圖（避免指令詞
 * 誤判，同①②③的「是不是這個子指令」判定），路徑判定對原始字串（AND、不要求 `/pulls/` 與 `/merge`
 * 鄰接、容忍路徑被引號包住——剝殼視圖會把引號內路徑一併消掉，造成偽陰性）。GET（無 -X/--method）
 * 或路徑非 `/merge` 放行。
 */
export function isApiPutMergeCommand(cmd) {
  if (typeof cmd !== 'string') return false;
  const stripped = stripQuotedValues(cmd);
  if (!/\bgh\s+api\b/.test(stripped)) return false;
  if (!/(^|\s)(-X\s+PUT|--method[\s=]PUT)(?=\s|$)/.test(stripped)) return false;
  return cmd.includes('/pulls/') && cmd.includes('/merge');
}

/**
 * 四型分類主入口：依序判定，命中即回對應型別字串，全不中回 null。branch 由呼叫端（main()）算好
 * 傳入（沿用 pr-gate.mjs 匯出的 readGitBranch）；本函式不做 IO，且僅②會用到 branch——③④與分支
 * 無關，即使傳入非主幹 branch 仍應命中。
 */
export function classifyMergeCommand(cmd, branch) {
  if (isPrMergeCommand(cmd)) return 'pr-merge';
  if (isGitMergeCommand(cmd) && isMainBranch(branch)) return 'git-merge-main';
  if (isPushToMainDestination(cmd)) return 'push-main';
  if (isApiPutMergeCommand(cmd)) return 'api-put-merge';
  return null;
}

const HUMAN_GATE_NOTE = '合併回主幹是需要人核可（human gate）的動作，不能由 Claude 直接執行。';
const ESCAPE_HATCH_NOTE = '確需繞過：設 LOOPS_MERGE_GUARD=0。';

const DENY_DETAILS = {
  'pr-merge': '偵測到 `gh pr merge`——PR 合併請由人類在 GitHub 上按下合併鍵，或請人類親自執行這個指令。',
  'git-merge-main': '偵測到目前分支已是 main/master、指令是 `git merge`——把其他分支併入主幹前要有人核可。',
  'push-main': '偵測到 `git push` 的目的地是 main/master——直接推進主幹等同繞過 PR review。',
  'api-put-merge': '偵測到 `gh api` 對 `/pulls/.../merge` 路徑送出 PUT——這是透過 API 直接合併 PR，效果等同 `gh pr merge`。',
};

function buildDenyReason(kind) {
  return `${HUMAN_GATE_NOTE}${DENY_DETAILS[kind] ?? ''}${ESCAPE_HATCH_NOTE}`;
}

// ── IO 薄邊界（被 import 時不執行 main）──────────────────────────────────────────

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
 * PreToolUse(Bash|PowerShell) hook 入口：四型高風險合併指令一律 deny；其餘放行。fail-open：
 * payload 壞 / 缺 command / 判不出分支一律放行。
 */
function main() {
  // 先無條件讀滿 stdin 再判（與家族 sibling 同序，避免大 payload EPIPE）。
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return; // payload 壞 → 放行
  }

  if (!flagEnabled('LOOPS_MERGE_GUARD', process.env)) return; // 字面 '0' opt-out → 放行

  const command = payload?.tool_input?.command;
  if (typeof command !== 'string') return; // 缺 command → 放行

  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : process.cwd();
  const branch = readGitBranch(cwd); // 判不出（無 .git／detached HEAD）→ null，②自然放行

  const kind = classifyMergeCommand(command, branch);
  if (!kind) return;

  denyWith(buildDenyReason(kind));
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
