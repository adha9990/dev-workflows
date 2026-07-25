#!/usr/bin/env node
// test-hook-decision-emit.mjs —— hook-decision-emit.mjs（T12：雙 harness compat layer 的葉節點，
// #183）紅綠斷言（自帶極簡 harness，仿同目錄 test-merge-guard.mjs 的動態 import 安全探測模式，
// 不引測試框架）。
//
// 用法（cwd = plugins/loops-workflow）：node hooks/test-hook-decision-emit.mjs
// 全綠 → exit 0；任一斷言失敗 → exit 1。
//
// （紅燈期：T12 期 hook-decision-emit.mjs 尚未存在——靜態具名 import 會在模組載入期就
// ERR_MODULE_NOT_FOUND、讓整個測試檔連一條斷言都跑不完就崩潰。改用動態 `await import()`
// try/catch 包住＋每次呼叫 emitDecision 前再包一層 try/catch，確保檔案不存在時本檔仍完整
// 跑完、印出逐條紅燈，而不是一次性崩潰——同 test-merge-guard.mjs 的做法。）
//
// 被測物契約摘要（純函式葉節點，只 import node 內建、不 import 任何 guard）：
//   type HookOutput =
//     | { kind:'deny';    reason:string; degraded:null|{reason} }
//     | { kind:'context'; context:string }
//     | { kind:'block';   reason:string }
//     | { kind:'text';    text:string }
//     | { kind:'noop' }
//   emitDecision(output, harness, hookEvent) -> string | null
//     harness   : 'claude' | 'codex' | 'unknown'
//     hookEvent : 'PreToolUse' | 'Stop' | ...（字串）
//
// 現況形狀抄錄來源（逐一實讀，非照抄任務描述）：
//   deny    ← hooks/merge-guard.mjs 的 denyWith()：
//             {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
//              "permissionDecisionReason":<reason>}}
//             （13 支 deny 家族同形，此為代表；pr-gate/config-protection/loops-path-guard/
//              worktree-guard/pr-owner-guard/outbound-comment-guard 皆同構，見各自 denyWith
//              /等價函式）。
//   context ← hooks/stop-gate.mjs（Stop 家族，injection!==null 分支）／hooks/eval-gate.mjs（同構）／
//             hooks/loop-driver.mjs 的 handleDegradedCompletion()（同構，皆 hookEventName:'Stop'）：
//             {"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":<context>}}
//             ／hooks/suggest-compact.mjs（PreToolUse 家族，hookEvent 與前三支不同）：
//             {"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":<context>}}
//   block   ← hooks/loop-driver.mjs 的 emitBlock()：
//             {"decision":"block","reason":<reason>}
//             （注意：頂層扁平形，無 hookSpecificOutput 包裹、也無 hookEventName 欄位——
//              與 deny/context 兩形結構不同，是第三種構形。）
//   text    ← hooks/stop-gate.mjs 的 DISCOVERY_HINT：console.log(DISCOVERY_HINT) 直接印純文字，
//             不包 JSON——是第四種構形（純字串，非 JSON blob）。
//   noop    ← 無輸出點對應此形（4 支只輸出「有事發生」時才印；noop 對應「靜默不印」——13 支 hook
//             大多數呼叫路徑都走這條：不印任何東西）。契約明定 noop → 回傳 null。
//
// 要驗的不變式：
//   I11｜Claude 分支位元相同：對五種 kind，emitDecision(output,'claude',<對應 hookEvent>) 的回傳
//        字串必須與現行 hook 實際輸出的字串位元相同；hookEvent 參數真的有被用到（傳不同值要得到
//        不同輸出——Stop 家族 vs suggest-compact 的 PreToolUse 家族即為此不同）。
//   I12｜codex 分支不得等同 unknown：emitDecision(sameOutput,'codex',ev) 不得與
//        emitDecision(sameOutput,'unknown',ev) 相同——若 codex 直接走 unknown 路徑，只是把
//        「靜默失效」換成「大聲失效」，這層就白做了。本任務最重要的斷言。
//   I13｜unknown 產出人可讀說明：harness='unknown' 時回傳內容含繁中人讀說明、且不是一個看起來
//        成功的平台 JSON（用「JSON.parse 應該失敗」當可證偽的判準：若還能被 JSON.parse 成功解析，
//        代表它偽裝成某種平台 JSON blob，不合格）。
//   noop｜kind:'noop' 回 null（代表不輸出任何東西），三個 harness 皆然。

const HERE = new URL('.', import.meta.url);

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

// =============================================================================
// 動態 import 安全探測（仿 test-merge-guard.mjs）
// =============================================================================
let mod = null;
try {
  mod = await import('./hook-decision-emit.mjs');
} catch (e) {
  console.error(`  (hook-decision-emit.mjs 動態 import 失敗——預期中，檔案尚未建立：${e && e.message})`);
}

const IMPORT_FAILED = Symbol('emitDecision 呼叫失敗（模組不存在 / 拋例外）');

/** 安全呼叫 emitDecision：模組不存在或呼叫拋例外時回傳一個永不等於任何字串/ null 的哨兵值，
 *  讓後續 assert 因型別不符自然失敗，而不是讓整個測試檔崩潰。 */
function callEmit(output, harness, hookEvent) {
  try {
    if (!mod || typeof mod.emitDecision !== 'function') return IMPORT_FAILED;
    return mod.emitDecision(output, harness, hookEvent);
  } catch (e) {
    return IMPORT_FAILED;
  }
}

// =============================================================================
// Fixtures：五種 HookOutput 形狀
// =============================================================================
const denyOutput = { kind: 'deny', reason: '合併回主幹是需要人核可的動作，不能由 Claude 直接執行。', degraded: null };
const denyOutputDegraded = {
  kind: 'deny',
  reason: '合併回主幹是需要人核可的動作，不能由 Claude 直接執行。',
  degraded: { reason: '此平台無法真正阻擋工具呼叫，僅能盡力提醒。' },
};
const contextOutput = { kind: 'context', context: '[loops-workflow] 完工品質閘未通過，請修正下列問題。' };
const blockOutput = { kind: 'block', reason: '[loops-workflow] 迴圈續跑：本迴圈仍有未完成任務，請繼續推進。' };
const textOutput = { kind: 'text', text: '[loops-workflow] 偵測到 .loops/gate.config.json：可設 LOOPS_STOP_GATE=1。' };
const noopOutput = { kind: 'noop' };

// =============================================================================
// I11 / S11 —— Claude 分支位元相同 ＋ hookEvent 參數真的有被用到
// =============================================================================

// [S11-1] deny：對照 merge-guard.mjs 的 denyWith() 實際輸出構形（PreToolUse 信封）。
{
  const expected = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: denyOutput.reason,
    },
  });
  const actual = callEmit(denyOutput, 'claude', 'PreToolUse');
  assert(actual === expected, '[S11-1] deny kind ＋ claude ＋ PreToolUse → 與 merge-guard.mjs denyWith() 現況輸出位元相同');
}

// [S11-2] deny：degraded 欄位不應改變 Claude 分支輸出（現行 7 支 deny hook 從無此欄位，
// Claude 分支只認 reason；degraded 是留給非 claude harness 的訊號）。
{
  const expected = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: denyOutputDegraded.reason,
    },
  });
  const actual = callEmit(denyOutputDegraded, 'claude', 'PreToolUse');
  assert(actual === expected, '[S11-2] deny kind（degraded 非 null）＋ claude ＋ PreToolUse → 仍與現況 denyWith() 構形位元相同（degraded 不外滲進 Claude 輸出）');
}

// [S11-3] context ＋ Stop：對照 stop-gate.mjs / eval-gate.mjs / loop-driver.mjs 的 Stop 家族現況輸出。
{
  const expected = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'Stop', additionalContext: contextOutput.context },
  });
  const actual = callEmit(contextOutput, 'claude', 'Stop');
  assert(actual === expected, '[S11-3] context kind ＋ claude ＋ hookEvent="Stop" → 與 stop-gate.mjs/eval-gate.mjs Stop 家族現況輸出位元相同');
}

// [S11-4] context ＋ PreToolUse：對照 suggest-compact.mjs 現況輸出——同一 kind、不同 hookEvent
// 必須得到不同 hookEventName，證明 hookEvent 參數真的有被用到（不是寫死 'Stop'）。
{
  const expected = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: contextOutput.context },
  });
  const actual = callEmit(contextOutput, 'claude', 'PreToolUse');
  assert(actual === expected, '[S11-4] context kind ＋ claude ＋ hookEvent="PreToolUse" → 與 suggest-compact.mjs 現況輸出位元相同（hookEventName 隨 hookEvent 參數變動，非寫死）');
}
{
  const stopResult = callEmit(contextOutput, 'claude', 'Stop');
  const preToolUseResult = callEmit(contextOutput, 'claude', 'PreToolUse');
  assert(
    typeof stopResult === 'string' && typeof preToolUseResult === 'string' && stopResult !== preToolUseResult,
    '[S11-5] 同一 context output，僅 hookEvent 參數不同（"Stop" vs "PreToolUse"）→ 回傳字串必須不同（直接證明 hookEvent 有被讀取使用，不是死值）',
  );
}

// [S11-6] block ＋ Stop：對照 loop-driver.mjs 的 emitBlock()——頂層扁平形，無 hookSpecificOutput
// 包裹、也無 hookEventName 欄位，是與 deny/context 不同的第三種構形。
{
  const expected = JSON.stringify({ decision: 'block', reason: blockOutput.reason });
  const actual = callEmit(blockOutput, 'claude', 'Stop');
  assert(actual === expected, '[S11-6] block kind ＋ claude ＋ Stop → 與 loop-driver.mjs emitBlock() 現況輸出位元相同（頂層扁平 {decision,reason} 形，無 hookSpecificOutput 包裹）');
}

// [S11-7] text ＋ Stop：對照 stop-gate.mjs 的 DISCOVERY_HINT——console.log 直接印純文字，不包 JSON，
// 是第四種構形。
{
  const actual = callEmit(textOutput, 'claude', 'Stop');
  assert(actual === textOutput.text, '[S11-7] text kind ＋ claude ＋ Stop → 回傳裸字串本身（與 stop-gate.mjs DISCOVERY_HINT 現況一致，不包 JSON）');
}

// [S11-8] noop：三個 harness 皆回 null（代表不輸出任何東西）。
{
  assert(callEmit(noopOutput, 'claude', 'Stop') === null, '[S11-8a] noop kind ＋ claude → null');
  assert(callEmit(noopOutput, 'codex', 'Stop') === null, '[S11-8b] noop kind ＋ codex → null');
  assert(callEmit(noopOutput, 'unknown', 'Stop') === null, '[S11-8c] noop kind ＋ unknown → null');
}

// =============================================================================
// I12 / S15 —— codex 分支不得等同 unknown（本任務最重要的斷言）
// =============================================================================

// [S15-1] deny：codex 與 unknown 對同一 output 的結果不得相同。
{
  const codexResult = callEmit(denyOutput, 'codex', 'PreToolUse');
  const unknownResult = callEmit(denyOutput, 'unknown', 'PreToolUse');
  assert(
    codexResult !== unknownResult,
    '[S15-1] deny kind：emitDecision(output,"codex",ev) !== emitDecision(output,"unknown",ev)（codex 分支不得直接落在 unknown 路徑上，否則只是把「靜默失效」換成「大聲失效」）',
  );
}

// [S15-2] deny（degraded 非 null）：同上，degraded 訊號存在時也要成立。
{
  const codexResult = callEmit(denyOutputDegraded, 'codex', 'PreToolUse');
  const unknownResult = callEmit(denyOutputDegraded, 'unknown', 'PreToolUse');
  assert(
    codexResult !== unknownResult,
    '[S15-2] deny kind（degraded 非 null）：codex 分支結果不得等同 unknown 分支結果',
  );
}

// [S15-3] context：codex 與 unknown 對同一 output 的結果不得相同。
{
  const codexResult = callEmit(contextOutput, 'codex', 'Stop');
  const unknownResult = callEmit(contextOutput, 'unknown', 'Stop');
  assert(
    codexResult !== unknownResult,
    '[S15-3] context kind：emitDecision(output,"codex",ev) !== emitDecision(output,"unknown",ev)',
  );
}

// [S15-4] block：同上。
{
  const codexResult = callEmit(blockOutput, 'codex', 'Stop');
  const unknownResult = callEmit(blockOutput, 'unknown', 'Stop');
  assert(
    codexResult !== unknownResult,
    '[S15-4] block kind：emitDecision(output,"codex",ev) !== emitDecision(output,"unknown",ev)',
  );
}

// [S15-5] text：同上。
{
  const codexResult = callEmit(textOutput, 'codex', 'Stop');
  const unknownResult = callEmit(textOutput, 'unknown', 'Stop');
  assert(
    codexResult !== unknownResult,
    '[S15-5] text kind：emitDecision(output,"codex",ev) !== emitDecision(output,"unknown",ev)',
  );
}

// [S15-6] codex 分支也不得直接等同 claude 分支（若 codex 直接借用 claude 的輸出格式，
// 平台收到不認得的 permissionDecision/decision 欄位多半整包忽略，等同另一種形式的靜默失效）。
{
  const claudeResult = callEmit(denyOutput, 'claude', 'PreToolUse');
  const codexResult = callEmit(denyOutput, 'codex', 'PreToolUse');
  assert(
    claudeResult !== codexResult,
    '[S15-6] deny kind：emitDecision(output,"codex",ev) !== emitDecision(output,"claude",ev)（codex 分支不得直接照搬 Claude 專屬信封格式）',
  );
}

// =============================================================================
// I13 —— unknown 產出人可讀說明（繁中、非偽裝成平台 JSON）
// =============================================================================
const CJK_RE = /[一-鿿]/;

function assertUnknownIsHumanReadable(output, hookEvent, label) {
  const result = callEmit(output, 'unknown', hookEvent);
  assert(typeof result === 'string' && result.length > 0, `[${label}-1] harness="unknown" → 回傳非空字串`);
  assert(typeof result === 'string' && CJK_RE.test(result), `[${label}-2] harness="unknown" → 內容含繁中人讀說明（含中文字元）`);
  let parsedOk = false;
  try {
    JSON.parse(typeof result === 'string' ? result : '');
    parsedOk = true;
  } catch {
    parsedOk = false;
  }
  assert(parsedOk === false, `[${label}-3] harness="unknown" → 內容不是一個可被 JSON.parse 成功解析的平台 JSON blob（不得偽裝成看起來成功的平台格式）`);
}

assertUnknownIsHumanReadable(denyOutput, 'PreToolUse', 'I13-deny');
assertUnknownIsHumanReadable(contextOutput, 'Stop', 'I13-context');
assertUnknownIsHumanReadable(blockOutput, 'Stop', 'I13-block');
assertUnknownIsHumanReadable(textOutput, 'Stop', 'I13-text');

const total = passed + failed.length;
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
console.log(`(共 ${total} 條斷言：S11=Claude 分支位元相同/hookEvent 有被使用／S15=codex≠unknown≠claude／I13=unknown 人讀說明／noop=null)`);
process.exit(failed.length > 0 ? 1 : 0);
