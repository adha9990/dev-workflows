#!/usr/bin/env node
// outbound-comment-guard.mjs —— loops-workflow PreToolUse deny hook：把「對外訊息要先讀規範才能
// 送」＋「對外訊息格式規則」（references/comment-policy.md、references/outbound-templates.md）從
// 「只有載了 reference 才會遵守」變成「動作當下機械擋下」。攔 `gh pr/issue comment`、
// `gh pr/issue create`、`gh pr/issue edit`（帶 body）、`gh api .../comments`（帶 body）這些對外
// 發訊息的 shell 指令（Bash/PowerShell）。
//
// 起因：反覆出包——規則寫在 reference，手貼 comment 沒走 outbound 流程就沒載規則、整條漏掉。
// 這跟 loops-path-guard 機械擋「.loops 寫進 worktree」同一招：規則機械化、不靠人記得。
//
// #131 v2：從「只管 comment 的 @/客套兩條」擴成：
//   1) classifyOutboundCommand：comment / issue-create / pr-create / issue-edit / pr-edit 五型辨識。
//   2) read-gate：送出前，本 session 有沒有讀過對應規範檔（comment→comment-policy.md，其餘→
//      outbound-templates.md；靠 hooks/read-accumulator.mjs 記錄的已讀 state 判斷）——沒讀過就
//      deny、指路去讀。沒有 session_id（舊呼叫形態 / smoke）一律 fail-open 放行此關，只跑機械規則。
//   3) findFormatViolations：新增三條機械規則（.loops/ 路徑外洩／亂碼／整段技術英文未轉譯）。
//   4) 既有 @ 點名／客套開場規則現在對全部五型都管，不只 comment。
//   5) verify 回饋修正：複合指令（多 body／多受管子指令，例如用 && 接兩個 gh comment）一律 deny、
//      要求拆成多次呼叫；@ 點名掃描改 global（避免開頭 @me 擋住視野、漏放後面的真點名）；
//      --body-file - / -F body=@- 這類 stdin idiom（指令本身看不到內容）明確 deny，不再落入
//      「讀不到檔案→fail-open 放行」的一般路徑；readFileSafe 加 512KB／非一般檔上限；
//      buildReadGateReason('comment') 的 §7/§8 摘要修正為與 comment-policy.md 原文結構一致
//      （§7 是固定四小節、§8 才是雙視角，不能兩者混為一談）。
//
// 預設啟用（defaultOn）；env LOOPS_COMMENT_GUARD='0' 可關（誤擋逃生口，同時關掉 read-accumulator）。
// fail-open：payload 壞 / 讀不到 body / 任何例外一律放行 exit 0，永不因 hook 故障卡住使用者。
//
// 分層（仿同目錄 loops-path-guard.mjs）：
//   1) 純函式（測試直接 import）：classifyOutboundCommand / isCommentPostingCommand（相容包裝）/
//      extractCommentBody / findOutboundViolations / findFormatViolations / buildReadGateReason。
//   2) IO 薄邊界：main()（讀 stdin、必要時讀 body-file、查 read-accumulator state、印 deny JSON）
//      ——import 時不執行。
// 依賴：node 內建（fs / path / url）+ 同目錄 hook-flags、read-accumulator；除 stdin / body-file /
// read state 檔外零 I/O。

import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { flagEnabled } from './hook-flags.mjs';
import { readReadsForSession } from './read-accumulator.mjs';

// ── 純函式層（無 IO，測試直接 import）─────────────────────────────────────────────

function hasBodyArg(cmd) {
  return /(^|\s)(-b|--body)(\s|=)/.test(cmd)
    || /(^|\s)--body-file(\s|=)/.test(cmd)
    || /(^|\s)-[fF]\s+body=/.test(cmd);
}

// comment 型判定的單一真相源：isCommentPostingCommand（相容包裝）與 classifyOutboundCommand 的
// 'comment' 分支都靠這個私有函式判斷，避免同一段正則抄兩份而漂移。
function isCommentKind(cmd) {
  if (typeof cmd !== 'string' || !/\bgh\b/.test(cmd)) return false;
  if (/\bgh\s+pr\s+comment\b/.test(cmd)) return true;
  if (/\bgh\s+issue\s+comment\b/.test(cmd)) return true;
  if (/\bgh\s+api\b/.test(cmd) && /\/comments\b/.test(cmd) && hasBodyArg(cmd)) return true;
  return false;
}

/**
 * 這條 Bash 指令是不是在「貼 / 改一則對外 comment」——即 comment-policy §6/§8 適用的面。
 * @deprecated 相容包裝，留給既有呼叫端：等價於 classifyOutboundCommand(cmd) === 'comment'。
 */
export function isCommentPostingCommand(cmd) {
  return isCommentKind(cmd);
}

/**
 * 把一條 Bash 指令分類成五型對外發訊息之一，或 null（非受管指令）：
 * 'comment'（貼/改 comment）/ 'issue-create' / 'pr-create' / 'issue-edit' / 'pr-edit'。
 * comment 型判定同 isCommentPostingCommand；其餘四型都要求帶 body 參數才算受管（沒帶 body 就不是
 * 在「發訊息」，例如純改 label 的 `gh issue edit --add-label` 不受管）。
 */
export function classifyOutboundCommand(cmd) {
  if (isCommentKind(cmd)) return 'comment';
  if (typeof cmd !== 'string' || !/\bgh\b/.test(cmd) || !hasBodyArg(cmd)) return null;
  if (/\bgh\s+issue\s+create\b/.test(cmd)) return 'issue-create';
  if (/\bgh\s+pr\s+create\b/.test(cmd)) return 'pr-create';
  if (/\bgh\s+issue\s+edit\b/.test(cmd)) return 'issue-edit';
  if (/\bgh\s+pr\s+edit\b/.test(cmd)) return 'pr-edit';
  return null;
}

// ── #131 verify 回饋：複合指令偵測（純函式）────────────────────────────────────────
// 一條 shell 指令裡串了多個受管子指令或多個 body 參數（例如用 && 接兩個 gh comment）時，下面
// main() 抽 body 的邏輯只認得第一段——第二段（甚至更後面）的違規會直接漏放。countManagedSegments
// 數「受管子指令」出現幾次、countBodyFlags 數「body 參數旗標」出現幾次，任一 >1 就代表指令疑似
// 複合了不只一則對外訊息，main 據此在 read-gate 前直接 deny、要求拆開送出。

const MANAGED_SUBCOMMAND_RE_G = /\bgh\s+(?:pr\s+comment|issue\s+comment|issue\s+create|pr\s+create|issue\s+edit|pr\s+edit)\b/g;
const GH_API_RE_G = /\bgh\s+api\b/g;
const BODY_FLAG_RE_G = /(?:^|\s)(?:-b|--body)(?:\s|=)|(?:^|\s)--body-file(?:\s|=)|(?:^|\s)-[fF]\s+body=/g;

function countManagedSegments(cmd) {
  if (typeof cmd !== 'string') return 0;
  const matches = cmd.match(MANAGED_SUBCOMMAND_RE_G);
  let count = matches ? matches.length : 0;
  // gh api 比照 isCommentKind 對 gh api 的判定條件——只在整條指令同時「路徑含 /comments」且
  // 「帶 body 參數」時才計入受管段；純讀取的 gh api（如 gh api rate_limit）不算受管，不該觸發
  // 複合指令判定。
  if (/\/comments\b/.test(cmd) && hasBodyArg(cmd)) {
    const apiMatches = cmd.match(GH_API_RE_G);
    if (apiMatches) count += apiMatches.length;
  }
  return count;
}

function countBodyFlags(cmd) {
  if (typeof cmd !== 'string') return 0;
  const matches = cmd.match(BODY_FLAG_RE_G);
  return matches ? matches.length : 0;
}

/**
 * 這條指令是不是用 stdin idiom 餵 body（`--body-file -` 或 `-F body=@-` / `-f body=@-`）——這種
 * 寫法指令本身看不到實際內容（內容來自另一個行程 pipe 進來），guard 讀不到就該明確 deny，不能
 * 落入下面 readFileSafe「讀不到檔案 → fail-open 放行」的一般路徑（那等於允許繞過整個內容檢查）。
 */
function isStdinBodyIdiom(cmd) {
  if (typeof cmd !== 'string') return false;
  if (/--body-file[=\s]+-(?:\s|$)/.test(cmd)) return true;
  if (/-[fF]\s+body=@-(?:\s|$)/.test(cmd)) return true;
  return false;
}

/**
 * 從指令抽出 comment 的 body 文字。優先 file 形式（`--body-file <path>` / `-F body=@<path>`），
 * 讀不到就回 null（→ fail-open、不判定）；否則抓 inline 形式（`--body <text>` / `-b` /
 * `-F body=<text>`）。readFileSafe 由 main 注入（測試可 stub），出錯回 null。
 */
export function extractCommentBody(cmd, readFileSafe) {
  // 1) file 形式：--body-file <path> / --body-file=<path>
  const fileFlag = cmd.match(/--body-file[=\s]+('([^']+)'|"([^"]+)"|(\S+))/);
  if (fileFlag) {
    const path = fileFlag[2] ?? fileFlag[3] ?? fileFlag[4];
    return readFileSafe(path);
  }
  // 2) file 形式：-F body=@<path> / -f body=@<path>
  const fFile = cmd.match(/-[fF]\s+body=@('([^']+)'|"([^"]+)"|(\S+))/);
  if (fFile) {
    const path = fFile[2] ?? fFile[3] ?? fFile[4];
    return readFileSafe(path);
  }
  // 3) inline：--body '<text>' / -b "<text>" / --body=<text>
  const bodyFlag = cmd.match(/(?:^|\s)(?:-b|--body)(?:\s+|=)('([\s\S]*?)'|"([\s\S]*?)"|(\S+))/);
  if (bodyFlag) return bodyFlag[2] ?? bodyFlag[3] ?? bodyFlag[4] ?? null;
  // 4) inline：-F body=<text> / -f body=<text>（非 @file）
  const fInline = cmd.match(/-[fF]\s+body=(?!@)('([\s\S]*?)'|"([\s\S]*?)"|(\S+))/);
  if (fInline) return fInline[2] ?? fInline[3] ?? fInline[4] ?? null;
  return null;
}

/** 去掉 markdown 程式碼（```fenced``` 與 `inline`）——避免 code 片段裡的 @param / @Component /
 *  @scope/pkg / user@host 誤判成點名，也避免 fence 內的 .loops/ 範例路徑誤判成外洩。 */
function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
}

/**
 * 找出 body 違反 comment-policy §6/§8 的地方，回一個原因陣列（空＝乾淨）。
 * 只看 prose（先去 code）；@me 與 scoped-package（@scope/…）不算點名。
 * #131：現在對全部五型（comment/issue-create/pr-create/issue-edit/pr-edit）都跑，不只 comment。
 */
export function findOutboundViolations(body) {
  if (typeof body !== 'string' || body.trim() === '') return [];
  const violations = [];
  const prose = stripCode(body);

  // (a) @ 點名人：行首或空白後的 @handle（GitHub handle：英數+連字號、1–39），
  //     排除 @me、排除 scoped-package（後面接 /）、排除 email（@ 前是非空白，被 (^|\s) 擋掉）。
  //     #131 verify 回饋：global 掃描全部 @handle、不是只看第一個——避免 body 開頭先出現 @me
  //     （本身放行）後，後面真正的點名（如 "@me 自我指派後 @realuser 請看"）被第一個 match 擋住
  //     視野而漏放。
  const mentionRe = /(?:^|\s)@([A-Za-z0-9][A-Za-z0-9-]{0,38})(?![\w/-])/g;
  let mentionHandle = null;
  for (const m of prose.matchAll(mentionRe)) {
    if (m[1].toLowerCase() !== 'me') { mentionHandle = m[1]; break; }
  }
  if (mentionHandle) {
    violations.push(`comment 不 @ 點名人（找到 "@${mentionHandle}"）——見 comment-policy §6/§8`);
  }

  // (b) 客套開場：body（去標題/空白後）以 感謝 / 謝謝 / thanks / thank you 起頭。
  //     CJK 詞不加 \b（CJK 非 ASCII \w，\b 匹配不到）；英文詞才需 \b。
  if (/^[\s#>*_-]*(?:感謝|謝謝|多謝|(?:thank you|thanks|thx)\b)/i.test(body.trimStart())) {
    violations.push('comment 不寫客套開場（感謝 / thanks…）——見 comment-policy §6');
  }
  return violations;
}

const LOOPS_INTERNAL_PATH_RE = /\.loops\//;
const BARE_STAGES_FILE_RE = /\bstages\/0\d[\w-]*\.md\b/;
const REPLACEMENT_CHAR_RE = /�/; // mojibake 訊號字元（U+FFFD replacement character）
const URL_RE = /https?:\/\/\S+/g;
const CJK_CHAR_RE = /[一-鿿]/g; // CJK Unified Ideographs（涵蓋繁中常用字）
const LONG_NON_CJK_PROSE_THRESHOLD = 120;
const MIN_CJK_COUNT = 10;
// #131 verify 回饋：--body-file 指向的檔案上限——超過就視為「讀不到」同一 fail-open 路徑，避免
// 把巨大檔案整讀進記憶體判定（也避免用超大檔夾帶違規內容規避掃描的疑慮）。
const MAX_BODY_FILE_BYTES = 512 * 1024;

function countCJKChars(text) {
  const matches = text.match(CJK_CHAR_RE);
  return matches ? matches.length : 0;
}

/**
 * #131：找出 body 違反對外內容「格式」規則的地方（不同於 findOutboundViolations 管的語氣/點名），
 * 回一個原因陣列（空＝乾淨）：
 *   ① 去 code 後的 prose 引用 `.loops/` 路徑或裸 `stages/0N-*.md` 檔名（comment-policy §0：
 *      本地暫存、merge/close 後即消失，對外內容要 self-contained）。
 *   ② raw body（不去 code——fence 內的亂碼一樣是亂碼）含 U+FFFD replacement character。
 *   ③ 去 code＋去 URL 後的 prose ≥120 字元且 CJK 字數 <10（疑似整段技術英文未轉譯成中文白話，
 *      見 comment-policy §1/§2）；CJK ≥10 一律放行——長但夾雜英文 log / identifier 的中文說明
 *      不該被這條誤擋。
 */
export function findFormatViolations(body) {
  if (typeof body !== 'string' || body.trim() === '') return [];
  const violations = [];

  if (REPLACEMENT_CHAR_RE.test(body)) {
    violations.push('內容含亂碼字元（U+FFFD replacement character）——請確認編碼正確後再送');
  }

  const prose = stripCode(body);
  if (LOOPS_INTERNAL_PATH_RE.test(prose) || BARE_STAGES_FILE_RE.test(prose)) {
    violations.push(
      '內容引用了 .loops/ 或 stages/0N-*.md 路徑——這是本地暫存、merge/close 後即消失，'
      + '請把要講的內容 inline 寫進本體——見 comment-policy §0',
    );
  }

  const proseForLength = prose.replace(URL_RE, ' ').trim();
  if (proseForLength.length >= LONG_NON_CJK_PROSE_THRESHOLD && countCJKChars(proseForLength) < MIN_CJK_COUNT) {
    violations.push(
      '這段內容偏長但幾乎沒有中文——請照 §1/§2 用繁體中文白話重寫（identifier/路徑/指令可保留原文）',
    );
  }

  return violations;
}

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const REFERENCES_DIR = join(HOOKS_DIR, '..', 'references');
const COMMENT_POLICY_PATH = join(REFERENCES_DIR, 'comment-policy.md');
const OUTBOUND_TEMPLATES_PATH = join(REFERENCES_DIR, 'outbound-templates.md');

/**
 * read-gate deny 時的理由文字：依 kind 指向對應規範檔的絕對路徑（import.meta.url 推導）+ 對應
 * 章節摘要，附「先讀再送」引導與 code fence 提示。
 * comment → comment-policy.md（§7 驗收報告版型／§8 修正回覆版型）；
 * issue-create / pr-create / issue-edit / pr-edit → outbound-templates.md（樣板索引 + 通則摘要）。
 * 注意：comment 分支的 §7/§8 摘要文字需與 references/comment-policy.md 該兩節原文同步維護——
 * §7 是逐點固定四小節（會發生什麼情境／為什麼是問題／建議怎麼修／建議補測試），§8 才是工程角度／
 * 客戶角度雙視角；兩者結構不同，摘要不能把 §7 也描述成雙視角格式。
 */
export function buildReadGateReason(kind) {
  if (kind === 'comment') {
    return (
      '這則對外 comment 送出前，本 session 還沒讀過 comment-policy.md——那裡有 §7 驗收報告版型、'
      + '§8 修正回覆版型：§7 逐點用固定四小節（會發生什麼情境／為什麼是問題／建議怎麼修／建議補'
      + '測試）；§8 逐點用工程角度／客戶角度雙視角（根因／怎麼修／怎麼驗＋修正前後）。兩邊皆不 @ 點名、'
      + '不客套。\n'
      + `請先讀 ${COMMENT_POLICY_PATH}，套用對應版型後再送出這則 comment。\n`
      + '內容如果含 code fence，記得先確認 fence 內外的分界正確（fence 內的程式碼片段不受這些格式規則管）。\n'
      + '確需繞過：設 LOOPS_COMMENT_GUARD=0。'
    );
  }
  return (
    '這則對外內容送出前，本 session 還沒讀過 outbound-templates.md——那裡是每一型對外訊息（issue 建立／'
    + '各種 comment／PR body／端給使用者的問題）的樣板索引，開頭附通則 house-style（語言／白話／雙視角／不客套）。\n'
    + `請先讀 ${OUTBOUND_TEMPLATES_PATH}，找到對應型的樣板並套用後再送出。\n`
    + '內容如果含 code fence，記得先確認 fence 內外的分界正確（fence 內的程式碼片段不受這些格式規則管）。\n'
    + '確需繞過：設 LOOPS_COMMENT_GUARD=0。'
  );
}

// ── IO 薄邊界：main()（被 import 時不執行）────────────────────────────────────────

function readStdin() {
  return readFileSync(0, 'utf8');
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

function main() {
  // 先無條件讀滿 stdin 再判（與家族 sibling 同序，避免大 payload EPIPE）。
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return; // payload 壞 → 放行
  }

  if (!flagEnabled('LOOPS_COMMENT_GUARD', process.env)) return; // 字面 '0' opt-out → 放行

  const cmd = payload?.tool_input?.command;
  const kind = classifyOutboundCommand(cmd);
  if (!kind) return; // 非受管指令 → 放行

  // #131 verify 回饋：複合指令——一條 shell 指令裡串了多個 body 參數或多個受管子指令（例如用
  // && 接兩個 gh comment），下面的抽 body 邏輯只認得第一段，後段違規會漏放。在 read-gate 前擋
  // 下，要求拆成多次呼叫、逐一過完整檢查。
  if (countManagedSegments(cmd) > 1 || countBodyFlags(cmd) > 1) {
    denyWith(
      '這條指令疑似把多個對外發訊動作（多個 body 參數或多個受管子指令）複合在同一次呼叫裡——'
      + '一次只能送一則，請拆成多次呼叫，讓每則各自過 read-gate／內容檢查後再送。'
      + '確需繞過：設 LOOPS_COMMENT_GUARD=0。',
    );
    return;
  }

  // read-gate（#131）：本 session 有沒有讀過 kind 對應的規範檔——只在 payload 帶 session_id 時查；
  // 缺 session_id（舊呼叫形態 / smoke 測試）一律 fail-open 放行此關，退回只跑下面的機械規則。
  const sessionId = payload?.session_id;
  if (typeof sessionId === 'string' && sessionId) {
    const requiredDoc = kind === 'comment' ? 'comment-policy.md' : 'outbound-templates.md';
    if (!readReadsForSession(sessionId).includes(requiredDoc)) {
      denyWith(buildReadGateReason(kind));
      return;
    }
  }

  // #131 verify 回饋：stdin idiom（--body-file - / -F body=@-）指令本身看不到實際內容（內容來自
  // 另一個行程 pipe 進來）——不能落入下面「讀不到檔案 → fail-open 放行」的一般路徑，那等於允許
  // 繞過整個內容檢查。明確 deny、指路改用 tmp 檔路徑。
  if (isStdinBodyIdiom(cmd)) {
    denyWith(
      '這條指令用 --body-file - 或 -F body=@- 從 stdin 讀 body，指令本身看不到實際內容、無法判'
      + '定是否違規，一律 deny。請改用 tmp 檔路徑：先把內容寫進暫存檔，再用 --body-file <tmp 檔'
      + '路徑> 送出。確需繞過：設 LOOPS_COMMENT_GUARD=0。',
    );
    return;
  }

  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : process.cwd();
  const readFileSafe = (p) => {
    try {
      const resolved = resolve(cwd, p);
      const stat = statSync(resolved);
      // 非一般檔（目錄等）或超過大小上限 → 視為「讀不到」同一 fail-open 路徑——不誤讀非檔案內容，
      // 也不把巨大檔案整讀進記憶體判定。
      if (!stat.isFile() || stat.size > MAX_BODY_FILE_BYTES) return null;
      return readFileSync(resolved, 'utf8');
    } catch {
      return null; // 讀不到 → 無從判定，放行（fail-open）
    }
  };

  const body = extractCommentBody(cmd, readFileSafe);
  if (body == null) return; // 抽不到 body → 放行

  const violations = [...findOutboundViolations(body), ...findFormatViolations(body)];
  if (violations.length === 0) return; // 乾淨 → 放行

  denyWith(
    `這則對外內容違反 comment-policy：\n- ${violations.join('\n- ')}\n`
    + '請改掉內容（拿掉 @點名／客套開場、避免 .loops/ 路徑與亂碼、偏長的技術英文改寫成中文白話）再送。'
    + '確需繞過：設 LOOPS_COMMENT_GUARD=0。',
  );
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
