#!/usr/bin/env node
// handoff-stop.mjs —— Handoff Stop Gate 的判定核心（#219）。
//
// 規則：**到達 `stop_after` 之後，任何下一階段的 mutating action 都要被擋住，直到收到明確 resume。**
// 過去這只是一句規範，而違反它幾乎沒有代價訊號——使用者說「先幫我開 issue 就好」，agent 順手建了
// worktree、進了 plan、開始改 code，帳單、context 與 review 面積全部照跑，事後只看得到「這條 loop
// 比較貴」。所以要在動作發生的那一刻擋。
//
// **怎麼判定「這個動作屬於哪個階段」**：不猜語意，只認幾種**形狀明確、且真的會推進工作成果**的動作
// （建 issue／開 worktree／改 repo 內的檔／開 PR／對外留言）。認不出來的一律放行——擋錯的代價
// （使用者被莫名其妙卡住）遠高於漏擋（下一次動作多半仍會命中其中一種形狀）。
//
// `.loops/` 底下的寫入**一律放行**：寫 handoff note、更新 loop.md、補階段紀錄，正是「停下來交接」
// 本身要做的事。把它們一起擋掉，等於讓 workflow 停得下來卻交接不出去。
//
// 分層：純函式（分類 ＋ 判定）＋ 無 IO。依賴：僅本 repo 內既有 hook 的切詞與剝殼原語。

import { stripQuotedValues } from '../hooks/pr-gate.mjs';
import { gitSubcommands } from '../hooks/hook-input-normalize.mjs';
import { crossesHandoff } from './handoff-ledger.mjs';

/**
 * 動作形狀 → 它屬於哪個 phase。
 * 只列**推進工作成果**的動作：唯讀查詢（`gh pr view`／`git status`）與跑測試不在內——
 * 停在 H1 的人仍然可以看、可以查，被擋住的只有「繼續往下做」。
 */
export const ACTION_PHASES = Object.freeze({
  'issue-create': 'define',
  'worktree-create': 'build',
  'repo-write': 'build',
  'pr-write': 'finalize',
  'outbound-comment': 'finalize',
});

const norm = (p) => String(p ?? '').split('\\').join('/');

/** 這條路徑是不是 loop 記憶體（`.loops/` 底下）。 */
export function isLoopMemoryPath(path) {
  return /(^|\/)\.loops\//.test(norm(path));
}

/**
 * 一次 Bash／PowerShell 呼叫 → 動作型別（認不出回 null）。
 * 子指令詞一律用剝殼視圖判（避免字樣只出現在別的指令的引號值裡被誤判成真的執行），
 * `git` 另外 OR 上 token 化解析，涵蓋 `git -C <dir> worktree add` 這種夾全域選項的形狀。
 */
export function classifyCommand(cmd) {
  if (typeof cmd !== 'string' || cmd === '') return null;
  const bare = stripQuotedValues(cmd);

  if (/\bgh\s+issue\s+create(?=\s|$)/.test(bare)) return 'issue-create';
  if (/\bgh\s+pr\s+(create|ready|edit|merge)(?=\s|$)/.test(bare)) return 'pr-write';
  if (/\bgh\s+(pr|issue)\s+(comment|review)(?=\s|$)/.test(bare)) return 'outbound-comment';

  const isWorktreeCall = /\bgit\s+worktree(?=\s|$)/.test(bare)
    || gitSubcommands(cmd).some((c) => c.subcommand === 'worktree');
  if (isWorktreeCall && /\bworktree\s+add(?=\s|$)/.test(bare)) return 'worktree-create';
  if (/\bgit\s+checkout\s+-b(?=\s|$)/.test(bare) || /\bgit\s+switch\s+-c(?=\s|$)/.test(bare)) return 'worktree-create';

  return null;
}

/**
 * 一次檔案寫入 → 動作型別（loop 記憶體回 null＝放行）。
 * 判不出路徑時回 null：擋一個看不出目標的寫入，只會讓人不知道自己被什麼擋住。
 */
export function classifyWrite(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return null;
  return isLoopMemoryPath(filePath) ? null : 'repo-write';
}

/** tool 呼叫 → `{ action, phase }` 或 null（認不出＝放行）。 */
export function classifyAction({ toolName, toolInput } = {}) {
  const action = /^(Bash|PowerShell)$/.test(String(toolName ?? ''))
    ? classifyCommand(toolInput?.command)
    : (/^(Write|Edit|MultiEdit)$/.test(String(toolName ?? '')) ? classifyWrite(toolInput?.file_path) : null);
  if (!action) return null;
  return { action, phase: ACTION_PHASES[action] };
}

/**
 * 判定一次動作是否越過已經停下的 handoff → `{ allowed, reason?, action?, phase? }`。
 *
 * `pause` 來自 `handoff-ledger.activePause(state)`。沒停下、或這個動作不屬於更後面的階段 ⇒ 放行。
 */
export function evaluateAction({ pause, toolName, toolInput } = {}) {
  if (!pause?.paused || !pause.stopAfter) return { allowed: true };

  const classified = classifyAction({ toolName, toolInput });
  if (!classified) return { allowed: true };
  if (!crossesHandoff(pause.stopAfter, classified.phase)) return { allowed: true };

  const h = pause.handoff;
  return {
    allowed: false,
    action: classified.action,
    phase: classified.phase,
    reason: [
      `這條 loop 已經在 \`${pause.stopAfter}\` 這個 handoff 停下（${h?.handoffId ?? '未知 handoff'}），`,
      `而這個動作（${describeAction(classified.action)}）屬於 \`${classified.phase}\` 階段——那是**下一位**的工作。`,
      '',
      'handoff 的意思是「這次被要求做的範圍已經完成」，不是還沒做完。要繼續往下做，需要的是**明確的 resume**：',
      '  1. 跑 freshness check（來源版本／Goal Contract revision／產物是否還在／pending 是否仍成立）；',
      '  2. 依判定結果決定從哪個階段續跑（通過就不重跑已完成階段）；',
      '  3. 記一筆 `workflow.resumed` 並更新 stop_after。',
      '',
      `目前的交接內容在這條 loop 的 \`handoff/${h?.checkpoint ?? pause.stopAfter}.md\`；`,
      '寫 handoff、更新 loop 記憶體這類收尾動作不受本閘限制。',
    ].join('\n'),
  };
}

function describeAction(action) {
  switch (action) {
    case 'issue-create': return '建立 GitHub issue';
    case 'worktree-create': return '開 worktree／建 loop 分支';
    case 'repo-write': return '改動 repo 內的檔案';
    case 'pr-write': return '開 PR／轉正／編輯／合併';
    case 'outbound-comment': return '對外留言／送出 review';
    default: return action;
  }
}
