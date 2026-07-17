#!/usr/bin/env node
// worktree-guard.mjs —— loops-workflow PreToolUse(Bash|PowerShell) deny hook：機械化 AGENTS 規則 9 的
// 「code 變更在 worktree 裡做、不在主 checkout 直接 `checkout -b` loop branch」。
// 這是 loops-path-guard（擋 .loops 寫進 worktree）的**姊妹規則**：那個管 .loops 落點，本檔管 code 落點。
//
// 觸發：shell 指令（Bash/PowerShell）是「對一個『已建 loop』的 branch 做 `git checkout -b <slug>` / `git switch -c <slug>`」，
//       且 cwd 在主 checkout（不在 .claude/worktrees/ 底下）→ deny，導向 `git worktree add`。
//       「已建 loop」＝從 cwd 往上任一層存在 `.loops/<slug>/loop.md`（否則放行——非 loop branch）。
// 預設啟用（defaultOn）；env LOOPS_WORKTREE_GUARD='0'（字面 '0'）可關閉。
// fail-open：任何例外 / payload 壞掉一律放行 exit 0，永不因 hook 故障卡住使用者。
//
// 為什麼要這條：規則 9 白紙黑字寫了、卻被「session 的 work-in-place 設定」這種藉口 override 過
// （在主 checkout `checkout -b` 做了一輪才被使用者抓）。文字擋不住合理化 → 用 hook 機械擋。
//
// 分層（仿同目錄 loops-path-guard.mjs）：
//   1) 純函式（無 IO，測試直接 import）：parseLoopBranchCreation、isInsideWorktree。
//   2) IO 薄邊界：findLoopRoot（走訪祖先找 .loops/<slug>/loop.md）、main()（讀 stdin、印 deny）。
// 依賴：僅 node 內建（path / fs / url），零外部套件。

import { resolve, dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { flagEnabled } from './hook-flags.mjs';

// ── 純函式層（無 IO，測試直接 import）─────────────────────────────────────────────

/**
 * 從 shell 指令（Bash/PowerShell）字串抽出「建立並切入一個 branch」的 branch 名（`git checkout -b <name>` /
 * `git switch -c <name>`），沒有則回 null。只抓 checkout -b / switch -c（會把當前工作目錄切到新
 * branch 的動作）——不抓 `git branch <name>`（只建 ref、不切、不構成「在主 checkout 做 code」）。
 * 保守解析：git 與 checkout/switch 之間允許夾 flag（如 `-C path`），但不跨 ; & | 邊界。
 */
export function parseLoopBranchCreation(command) {
  if (typeof command !== 'string') return null;
  // branch 名字元類排除 shell 分隔符（; & | ）與 )——git ref 本就不含這些；避免把 `-b a; rm` 的 `a;` 一起吃進。
  const patterns = [
    /\bgit\b[^\n;&|]*?\bcheckout\s+(?:-b|-B|--branch)\s+(['"]?)([^\s'";&|)]+)\1/,
    /\bgit\b[^\n;&|]*?\bswitch\s+(?:-c|-C|--create)\s+(['"]?)([^\s'";&|)]+)\1/,
  ];
  for (const re of patterns) {
    const m = command.match(re);
    if (m && m[2]) return m[2];
  }
  return null;
}

/**
 * cwd（解析後）是否落在某個 worktree（.claude/worktrees/ 之下）。段完全相等比對、不做 substring。
 * 在 worktree 裡就不是「主 checkout 違規」——放行。
 */
export function isInsideWorktree(cwd) {
  const normalized = resolve(cwd).replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/').filter((s) => s.length > 0);
  return segments.some(
    (segment, i) => segment === '.claude' && segments[i + 1] === 'worktrees',
  );
}

// ── IO 薄邊界（被 import 時不執行 main）──────────────────────────────────────────

/**
 * 從 startDir 往上走訪祖先，找第一個存在 `<dir>/.loops/<slug>/loop.md` 的層 → 回該 dir；找不到回 null。
 * 有界（最多 12 層）避免退化。判「slug 是不是一個已建 loop」＝這個檔在不在。
 */
function findLoopRoot(startDir, slug) {
  let dir = resolve(startDir);
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, '.loops', slug, 'loop.md'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // 到檔案系統根
    dir = parent;
  }
  return null;
}

function readStdin() {
  return readFileSync(0, 'utf8'); // fd 0 = stdin（hook payload 由父行程以 pipe 餵入）
}

function denyReason(slug) {
  return (
    `loop \`${slug}\` 的 code 要在獨立 worktree 做、不在主 checkout：` +
    `改用 \`git worktree add .claude/worktrees/${slug} -b ${slug} <base>\`` +
    `（branch 已存在則 \`git worktree add .claude/worktrees/${slug} ${slug}\`），` +
    `之後在 worktree 內改 code（.loops/ 續留主 repo）。` +
    `session／harness 的「work in place」「skip EnterWorktree」設定不豁免本條` +
    `（那管 session 隔離、與「為 loop 的 code 開 worktree」是不同層且相容）——見 AGENTS 規則 9。` +
    `確需繞過：設 LOOPS_WORKTREE_GUARD=0。`
  );
}

/**
 * PreToolUse(Bash|PowerShell) hook 入口：主 checkout 對已建 loop 的 `checkout -b/switch -c` → deny；其餘放行。
 * fail-open：payload 壞 / 缺欄位 / 非 loop branch 一律放行。
 */
function main() {
  // 先無條件讀滿 stdin 再查 env（與家族 sibling 同序）——先 return 不讀會讓父行程對大 payload EPIPE。
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return; // payload 壞 → 放行
  }

  if (!flagEnabled('LOOPS_WORKTREE_GUARD', process.env)) return; // 明確 opt-out（字面 '0'）→ 放行

  const command = payload?.tool_input?.command;
  const slug = parseLoopBranchCreation(command);
  if (!slug) return; // 不是 branch 建立指令 → 放行

  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : process.cwd();
  if (isInsideWorktree(cwd)) return; // 已在 worktree → 非主 checkout 違規，放行

  if (!findLoopRoot(cwd, slug)) return; // slug 不是已建 loop → 放行（一般 branch 不管）

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denyReason(slug),
      },
    }),
  );
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch {
    // fail-open：hook 絕不可因錯誤擋路 → 吞掉所有例外、放行
  }
  process.exit(0);
}
