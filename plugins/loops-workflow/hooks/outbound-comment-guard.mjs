#!/usr/bin/env node
// outbound-comment-guard.mjs —— loops-workflow PreToolUse deny hook：把「對外 comment 不 @ 點名
// 人 / 不寫客套開場」（references/comment-policy.md §6/§8）從「只有載了 reference 才會遵守」
// 變成「動作當下機械擋下」。攔 `gh pr comment` / `gh issue comment` / `gh api .../comments`
// （POST/PATCH）這類貼 / 改 comment 的 Bash 指令：body 內含 @人名（排除 @me）或開頭客套就 deny。
//
// 起因：反覆出包——規則寫在 reference，手貼 comment 沒走 outbound 流程就沒載規則、整條漏掉。
// 這跟 loops-path-guard 機械擋「.loops 寫進 worktree」同一招：規則機械化、不靠人記得。
//
// 預設啟用（defaultOn）；env LOOPS_COMMENT_GUARD='0' 可關（誤擋逃生口）。
// fail-open：payload 壞 / 讀不到 body / 任何例外一律放行 exit 0，永不因 hook 故障卡住使用者。
//
// 分層（仿同目錄 loops-path-guard.mjs）：
//   1) 純函式（測試直接 import）：isCommentPostingCommand / extractCommentBody / findOutboundViolations。
//   2) IO 薄邊界：main()（讀 stdin、必要時讀 body-file、印 deny JSON）——import 時不執行。
// 依賴：僅 node 內建（fs / path / url）+ 同目錄 hook-flags；除 stdin 與 body-file 外零 I/O。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { flagEnabled } from './hook-flags.mjs';

// ── 純函式層（無 IO，測試直接 import）─────────────────────────────────────────────

/**
 * 這條 Bash 指令是不是在「貼 / 改一則對外 comment」——即 comment-policy §6/§8 適用的面。
 * 涵蓋 `gh pr comment` / `gh issue comment` / `gh api <路徑含 /comments> (帶 body 參數)`。
 * gh api 不帶 body 參數（純 GET 讀 comment）不算——只有真的寫入才受規範。
 */
export function isCommentPostingCommand(cmd) {
  if (typeof cmd !== 'string' || !/\bgh\b/.test(cmd)) return false;
  if (/\bgh\s+pr\s+comment\b/.test(cmd)) return true;
  if (/\bgh\s+issue\s+comment\b/.test(cmd)) return true;
  if (/\bgh\s+api\b/.test(cmd) && /\/comments\b/.test(cmd) && hasBodyArg(cmd)) return true;
  return false;
}

function hasBodyArg(cmd) {
  return /(^|\s)(-b|--body)(\s|=)/.test(cmd)
    || /(^|\s)--body-file(\s|=)/.test(cmd)
    || /(^|\s)-[fF]\s+body=/.test(cmd);
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
 *  @scope/pkg / user@host 誤判成點名。 */
function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
}

/**
 * 找出 body 違反 comment-policy §6/§8 的地方，回一個原因陣列（空＝乾淨）。
 * 只看 prose（先去 code）；@me 與 scoped-package（@scope/…）不算點名。
 */
export function findOutboundViolations(body) {
  if (typeof body !== 'string' || body.trim() === '') return [];
  const violations = [];
  const prose = stripCode(body);

  // (a) @ 點名人：行首或空白後的 @handle（GitHub handle：英數+連字號、1–39），
  //     排除 @me、排除 scoped-package（後面接 /）、排除 email（@ 前是非空白，被 (^|\s) 擋掉）。
  const mention = prose.match(/(?:^|\s)@([A-Za-z0-9][A-Za-z0-9-]{0,38})(?![\w/-])/);
  if (mention && mention[1].toLowerCase() !== 'me') {
    violations.push(`comment 不 @ 點名人（找到 "@${mention[1]}"）——見 comment-policy §6/§8`);
  }

  // (b) 客套開場：body（去標題/空白後）以 感謝 / 謝謝 / thanks / thank you 起頭。
  //     CJK 詞不加 \b（CJK 非 ASCII \w，\b 匹配不到）；英文詞才需 \b。
  if (/^[\s#>*_-]*(?:感謝|謝謝|多謝|(?:thank you|thanks|thx)\b)/i.test(body.trimStart())) {
    violations.push('comment 不寫客套開場（感謝 / thanks…）——見 comment-policy §6');
  }
  return violations;
}

// ── IO 薄邊界：main()（被 import 時不執行）────────────────────────────────────────

function readStdin() {
  return readFileSync(0, 'utf8');
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
  if (typeof cmd !== 'string' || !isCommentPostingCommand(cmd)) return; // 非貼 comment → 放行

  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : process.cwd();
  const readFileSafe = (p) => {
    try {
      return readFileSync(resolve(cwd, p), 'utf8');
    } catch {
      return null; // 讀不到 → 無從判定，放行（fail-open）
    }
  };

  const body = extractCommentBody(cmd, readFileSafe);
  if (body == null) return; // 抽不到 body → 放行

  const violations = findOutboundViolations(body);
  if (violations.length === 0) return; // 乾淨 → 放行

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `這則對外 comment 違反 comment-policy：\n- ${violations.join('\n- ')}\n` +
          '請改掉 body（拿掉 @點名 / 客套開場、直接陳述每點修法與驗證）再送。' +
          '確需繞過：設 LOOPS_COMMENT_GUARD=0。',
      },
    }),
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
