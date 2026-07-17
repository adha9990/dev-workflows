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
 * 誤判成真的執行（仿 pr-gate.mjs 的 isPrCreateCommand）。`merge` 收尾用 `(?=\s|$)` 取代 `\b`：
 * `\b` 在 word/非word 字元轉換處就成立（`e`→`-` 也算），為防未來出現 `gh pr merge-xxx` 這種
 * 形狀的子指令誤中，收尾一律要求後面接空白或字串結尾（同 isGitMergeCommand 修法，N8 同病根、
 * 順手一致處理）。
 */
export function isPrMergeCommand(cmd) {
  return typeof cmd === 'string' && /\bgh\s+pr\s+merge(?=\s|$)/.test(stripQuotedValues(cmd));
}

/**
 * 是不是 `git merge`（不判斷 branch——branch 判斷交給 classifyMergeCommand／呼叫端，因為「併到
 * 哪個分支才算高風險」需要外部脈絡）。同樣剝殼視圖判，理由同上。`merge` 收尾用 `(?=\s|$)` 取代
 * `\b`：`\b` 在 `e`→`-` 這種 word/非word 字元轉換處一樣成立，會把 `git merge-base`／
 * `git merge-tree`／`git merge-file` 這些唯讀查詢類 plumbing 子指令（不是真的合併動作）一併
 * 誤中；`(?=\s|$)` 只認「merge 後面接空白或字串結尾」兩者才算，這些 plumbing 指令放行，
 * `git merge x` 這種真的合併指令不受影響。
 */
export function isGitMergeCommand(cmd) {
  return typeof cmd === 'string' && /\bgit\s+merge(?=\s|$)/.test(stripQuotedValues(cmd));
}

/** branch 是不是 main/master（非字串——含 null，判不出分支時的傳入值——一律 false）。 */
export function isMainBranch(branch) {
  return branch === 'main' || branch === 'master';
}

/**
 * 把指令字串切成 shell token（尊重單/雙引號包住的整段，回傳去引號後的值＋是否為引號 token）。
 * 只做字面「切詞＋去引號」，不解讀完整 shell 語意（無變數展開／管線），足夠應付本檔要判的
 * `git push` 指令形狀。
 */
function tokenizeShellLike(cmd) {
  const tokens = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    const quoted = m[1] !== undefined || m[2] !== undefined;
    tokens.push({ value: m[1] ?? m[2] ?? m[3], quoted });
  }
  return tokens;
}

/**
 * 是不是「flag token」：未被引號包住、且字面開頭是 `-`。`--x=value` 整顆算一個 flag token 一起
 * 丟棄（不拆 `=` 兩側，值不會被單獨當成 positional 誤判）；被引號包住的 token 一律不算 flag
 * （即使字面內容剛好以 `-` 開頭），因為引號代表呼叫端明確把它標記成一個值。
 */
function isFlagToken(tok) {
  return !tok.quoted && tok.value.startsWith('-');
}

/** value（bare 分支名或 refspec 右側）是否指向 main/master（含 refs/heads/ 完整形）。 */
function isMainRefLike(value) {
  if (typeof value !== 'string') return false;
  const dest = value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : value;
  return dest === 'master' || dest === 'main' || dest === 'refs/heads/master' || dest === 'refs/heads/main';
}

/**
 * 是不是「`git push` 到 main/master」。子指令詞判定沿用剝殼視圖確認是 `git push`（避免指令詞
 * 誤判，同①②）；destination 判定改**token 化 positional 解析**（取代舊版「只看字串最後一個
 * token」＋「REFSPEC/`--delete` 全字串正則另外掃」的雙軌做法——舊版任一目的地後面夾尾隨 flag
 * （`--force-with-lease`／`-f`／`--set-upstream`）或一次 push 多個 ref（master 不是最後一個）
 * 就會漏判，且全字串正則會被 flag 值裡湊巧出現的「冒號+master」圖樣（如
 * `--push-option="note:master"`）誤中）：把指令尊重引號切成 token、丟棄 flag token（含
 * `--x=value` 整顆丟——flag 值不會被單獨當成 positional），取 `push` 之後剩下的 positional
 * 序列 [remote, ref1, ref2, …]。ref 群（positional 中 remote 之後全部——`git push` 可一次推
 * 多個 ref，目的地不保證是最後一個）任一命中 isMainRefLike（bare 分支名／refspec 冒號右側，
 * 引號包住的整個 positional 已在切 token 時去引號）即算；`--delete master` 因 `--delete` 被
 * 丟棄、`master` 落入 ref 群，三形（bare／refspec／`--delete`）統一由這條路徑涵蓋，`--delete`
 * 不豁免。少於兩個 positional（只有 remote 或完全沒有，例如裸 `git push` 依 tracking 設定推、
 * 目的地無法從指令本身判斷）→ false（fail-open 精神：判不出目的地就不擋）。
 */
export function isPushToMainDestination(cmd) {
  if (typeof cmd !== 'string') return false;
  if (!/\bgit\s+push\b/.test(stripQuotedValues(cmd))) return false;

  const tokens = tokenizeShellLike(cmd);
  const pushIdx = tokens.findIndex((t) => !t.quoted && t.value === 'push');
  if (pushIdx === -1) return false; // 理論上不會發生（上面已確認剝殼視圖含 "git push"），防呆放行

  const positionals = tokens.slice(pushIdx + 1).filter((t) => !isFlagToken(t)).map((t) => t.value);
  if (positionals.length < 2) return false; // 只有 remote（或完全沒有）：無目的地可判

  return positionals.slice(1).some(isMainRefLike);
}

// `/merge` 路徑右邊界：後面要接引號／空白／`?`（query string 起點）／字串結尾才算，避免
// `/pulls/1/mergeable`（查 mergeable 狀態的合法唯讀端點，字面恰好以 "/merge" 開頭）被裸
// `includes('/merge')` 誤中。
const API_MERGE_PATH_RE = /\/merge(?:["'\s?]|$)/;

/**
 * 是不是「`gh api` 用 PUT 打 `/pulls/.../merge` 路徑」。`gh api`／PUT 判定用剝殼視圖（避免指令詞
 * 誤判，同①②③的「是不是這個子指令」判定），路徑判定對原始字串（AND、不要求 `/pulls/` 與 `/merge`
 * 鄰接、容忍路徑被引號包住——剝殼視圖會把引號內路徑一併消掉，造成偽陰性）。GET（無 -X/--method）
 * 或路徑非 `/merge`（含 `/mergeable` 這種右邊界不對的近似路徑）放行。
 */
export function isApiPutMergeCommand(cmd) {
  if (typeof cmd !== 'string') return false;
  const stripped = stripQuotedValues(cmd);
  if (!/\bgh\s+api\b/.test(stripped)) return false;
  if (!/(^|\s)(-X\s+PUT|--method[\s=]PUT)(?=\s|$)/.test(stripped)) return false;
  return cmd.includes('/pulls/') && API_MERGE_PATH_RE.test(cmd);
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
 *
 * 判定順序刻意把「便宜判定」放前面：四型分類中只有 git-merge-main 需要 branch（readGitBranch 有
 * 檔案系統成本——讀 .git／沿祖先目錄上溯），其餘三型（pr-merge／push-main／api-put-merge）與
 * branch 無關。故先用零 IO 成本的 isGitMergeCommand 剝殼判定「這是不是 git merge 指令」，只有
 * 命中才呼叫 readGitBranch；絕大多數 Bash/PowerShell 呼叫（不是 git merge 的任何指令，這個
 * matcher 攔的是全部 Bash/PowerShell 呼叫）完全不觸發檔案系統存取。行為與「一律先讀 branch」
 * 等價：classifyMergeCommand 只有在 isGitMergeCommand(cmd) 為真時才會用到 branch 參數，沒命中
 * 時傳 null 進去效果相同（該分支的 isMainBranch 檢查根本不會被求值）。
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

  let branch = null;
  if (isGitMergeCommand(command)) {
    const cwd = typeof payload?.cwd === 'string' ? payload.cwd : process.cwd();
    branch = readGitBranch(cwd); // 判不出（無 .git／detached HEAD）→ null，②自然放行
  }

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
