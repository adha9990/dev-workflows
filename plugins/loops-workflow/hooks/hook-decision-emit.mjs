// hook-decision-emit.mjs —— 雙 harness（Claude / Codex / unknown）hook 決策輸出的單一葉節點
// （issue #183 T12）。純函式：只 import node 內建（其實本檔連內建都不需要），不 import 任何 guard，
// 不做任何 IO——把「同一個決策（deny/context/block/text/noop）在不同 harness 下該吐出什麼字串」
// 這件事收斂到一處，避免日後各輸出點各自散抄、漂移。
//
// 契約：emitDecision(output, harness, hookEvent) -> string | null
//   output.kind ∈ 'deny' | 'context' | 'block' | 'text' | 'noop'
//   harness     ∈ 'claude' | 'codex' | 'unknown'
//   hookEvent   : 字串（'PreToolUse' / 'Stop' / ...），必須真的用來決定輸出（不可寫死）。
//
// Claude 分支形狀（I11，逐一實讀現況輸出點抄準，非憑印象）：
//   deny    ← hooks/merge-guard.mjs 的 denyWith()（deny 家族同構：pr-gate／merge-guard／
//             config-protection／loops-path-guard／worktree-guard／pr-owner-guard／
//             outbound-comment-guard 共 7 支）：
//             {"hookSpecificOutput":{"hookEventName":<hookEvent>,"permissionDecision":"deny",
//              "permissionDecisionReason":<reason>}}
//   context ← hooks/stop-gate.mjs / eval-gate.mjs / loop-driver.mjs（Stop 家族）／
//             hooks/suggest-compact.mjs（PreToolUse 家族）：
//             {"hookSpecificOutput":{"hookEventName":<hookEvent>,"additionalContext":<context>}}
//   block   ← hooks/loop-driver.mjs 的 emitBlock()：頂層扁平形，無 hookSpecificOutput 包裹：
//             {"decision":"block","reason":<reason>}
//   text    ← hooks/stop-gate.mjs 的 DISCOVERY_HINT：裸字串，不包 JSON。
//   noop    ← 無對應輸出點（靜默不印）；契約明定回傳 null。
//
// Codex 分支形狀（I12）——**誠實標記：以下信封形狀來源是
// plugins/loops-workflow/references/capability-registry.json 的 hook_events facet
// （status: not_measured，官方文件描述、尚未經真機（CODEX_HOME 已認證隔離 home）校驗）。
// 該 facet 只確認「hooks/hooks.json 慣例自動發現 + /hooks review/trust」存在，並未給出
// hook stdout 決策信封的具體 JSON schema。因此本檔的 codex 信封形狀是本任務內為滿足
// 「不得與 unknown 等價、不得直接照搬 Claude 專屬信封」而設計的**暫定**結構，日後若有機會對
// 真實 Codex CLI 實測 hook 輸出，須回頭校準本區塊、不可假裝已驗證。**
//   deny    ← {"codexHookDecision":{"hookEvent":<hookEvent>,"decision":"deny","reason":<reason>,
//              "degraded":<degraded>}}
//   context ← {"codexHookDecision":{"hookEvent":<hookEvent>,"decision":"context","context":<context>}}
//   block   ← {"codexHookDecision":{"hookEvent":<hookEvent>,"decision":"block","reason":<reason>}}
//   text    ← {"codexHookDecision":{"hookEvent":<hookEvent>,"decision":"text","text":<text>}}
//   noop    ← null（同 Claude）。
//
// unknown 分支形狀（I13）：不偽裝成任何平台 JSON（JSON.parse 必須失敗），改回傳人可讀的繁體中文
// 說明，講清楚「這個 harness 未被辨識、原始決策內容是什麼」，讓操作者至少讀得懂發生了什麼事。

/** Claude 分支：五種 kind 對照現況輸出點的位元相同構形。 */
function emitClaude(output, hookEvent) {
  switch (output.kind) {
    case 'deny':
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: hookEvent,
          permissionDecision: 'deny',
          permissionDecisionReason: output.reason,
        },
      });
    case 'context':
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: hookEvent, additionalContext: output.context },
      });
    case 'block':
      return JSON.stringify({ decision: 'block', reason: output.reason });
    case 'text':
      return output.text;
    default:
      throw new Error(`hook-decision-emit: 未知的 output.kind："${output.kind}"（claude 分支）`);
  }
}

/** Codex 分支：暫定信封（見檔頭誠實標記），刻意與 Claude 信封、unknown 說明文字皆不同構。 */
function emitCodex(output, hookEvent) {
  switch (output.kind) {
    case 'deny':
      return JSON.stringify({
        codexHookDecision: { hookEvent, decision: 'deny', reason: output.reason, degraded: output.degraded },
      });
    case 'context':
      return JSON.stringify({
        codexHookDecision: { hookEvent, decision: 'context', context: output.context },
      });
    case 'block':
      return JSON.stringify({ codexHookDecision: { hookEvent, decision: 'block', reason: output.reason } });
    case 'text':
      return JSON.stringify({ codexHookDecision: { hookEvent, decision: 'text', text: output.text } });
    default:
      throw new Error(`hook-decision-emit: 未知的 output.kind："${output.kind}"（codex 分支）`);
  }
}

/** kind → 人讀標籤（unknown 分支用）。 */
const UNKNOWN_KIND_LABELS = {
  deny: '拒絕執行',
  context: '附加脈絡',
  block: '續跑阻擋',
  text: '提示文字',
};

/** kind → 該 kind 攜帶的實際內容（unknown 分支用，統一取出主要訊息欄位）。 */
function unknownDetail(output) {
  switch (output.kind) {
    case 'deny':
      return output.reason;
    case 'context':
      return output.context;
    case 'block':
      return output.reason;
    case 'text':
      return output.text;
    default:
      throw new Error(`hook-decision-emit: 未知的 output.kind："${output.kind}"（unknown 分支）`);
  }
}

/** unknown 分支：不偽裝成平台 JSON，回傳人可讀的繁體中文說明。 */
function emitUnknown(output, hookEvent) {
  const label = UNKNOWN_KIND_LABELS[output.kind] ?? output.kind;
  const detail = unknownDetail(output);
  return (
    `[loops-workflow] 目前執行環境未被辨識（harness=unknown），無對應的原生 hook 決策格式，` +
    `僅能以純文字提示呈現，請人工核對。事件：${hookEvent}；決策類型：${label}；內容：${detail}`
  );
}

/**
 * 依 harness 把 HookOutput 轉成該平台實際要吐出的字串（或 null 代表不輸出）。
 * @param {{kind:string}} output
 * @param {'claude'|'codex'|'unknown'} harness
 * @param {string} hookEvent
 * @returns {string|null}
 */
export function emitDecision(output, harness, hookEvent) {
  if (output.kind === 'noop') return null;

  if (harness === 'claude') return emitClaude(output, hookEvent);
  if (harness === 'codex') return emitCodex(output, hookEvent);
  return emitUnknown(output, hookEvent);
}
