#!/usr/bin/env node
// context-gate.mjs —— 共享記憶的兩道機械閘（#218）：Context Pack Gate ＋ Invalidation Gate。
//
// **Context Pack Gate**：派 repo-aware agent 前，prompt 必須附 canonical 的 pack marker（loop／role／
// task／revision／independence）。缺 marker、marker 對錯 loop、或 marker 指的 pack 這條 loop 根本沒建過
// ⇒ 擋。理由與 agent-trace-guard 同源：**事前補一行，好過事後猜一輩子**——沒有 pack 身分，就查不出
// 「這個 agent 到底拿到哪些事實」，於是「它是不是又把架構重查了一遍」永遠問不出來。
// 它也順便擋掉「不給 pack、要 agent 自己讀整套 references 才開始」的老路。
//
// **Invalidation Gate**：pack 裡引用的 claim 現在必須仍是 `valid`。已被判 `invalid`／`uncertain`／
// `superseded` 的事實還被拿去派工 ⇒ 擋。這道閘堵的是最貴的失效模式：**stale fact 看起來跟正確的事實
// 一模一樣**，一路帶到 build／verify 才炸開。
//
// 三條刻意的邊界：
//   ① **只有能 deterministic 證明的才 hard fail**（issue 明訂）：缺 marker、pack 不存在、claim 已失效
//      ——這三件事都是「查得到的事實」。語意上的「這個 agent 好像又重查了一次架構」屬於 duplicate
//      discovery 觀測，只記 telemetry warning，不擋（脆弱的文字比對會擋掉合法調查）。
//   ② **判不出來 ≠ 通過**：revision 讀不到時，pack 的 revision 檢查回 `not_measured` 並在結果裡標
//      `degraded`，**不是**標成 clean。呼叫端（hook）依既有 hook 家族慣例只在可證明時 deny，
//      但誠實回報自己沒驗到什麼——兩者不衝突：不擋不等於說它沒問題。
//   ③ **作用範圍很窄**：這條 loop 從沒用過共享記憶（事件流裡一筆 knowledge 事件都沒有）⇒ 完全 no-op。
//      舊 loop 與不需要共享記憶的工作完全不受影響，且不靠日期或人工名單判斷。
//
// 分層：純函式（evaluateDispatch／checkPackFreshness／classifyActivity）＋ IO 薄邊界（讀 loop 狀態、CLI）。
// 依賴：僅 node 內建 ＋ 本 repo 內既有 script。
// 用法：node context-gate.mjs --loop-dir <dir> --prompt-file <file> [--activity <id>] [--revision <sha>] [--json]

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  NOT_MEASURED,
  parsePackMarker,
  projectKnowledge,
  readKnowledge,
  repoAwareActivities,
} from './knowledge-ledger.mjs';
import { extractTraceEnvelope, knownActivities } from './agent-trace.mjs';

/** 這幾種 validity 一旦出現在 pack 的引用清單裡，就是「拿失效的事實去派工」。 */
const NOT_REUSABLE = new Set(['invalid', 'uncertain', 'superseded']);

/**
 * 這次派工是不是 repo-aware（＝需要 context pack）。
 * 判定只讀 canonical vocabulary 的 `activities[].repo_aware`，**不另立第二份名單**。
 * activity 認不得時回 `null`＝判不出來——呼叫端一律當「不管」處理（判不出來就擋，會讓整個派工面失效）。
 */
export function classifyActivity(activity) {
  if (typeof activity !== 'string' || activity === '') return null;
  if (repoAwareActivities().has(activity)) return true;
  // 認得、而且明寫不是 repo-aware ⇒ 這道閘不管它；認不得 ⇒ 判不出來（不是「不用管」）。
  return knownActivities().has(activity) ? false : null;
}

/**
 * 檢查一份 pack 的新鮮度 → `{ ok, reason?, degraded[] }`（純函式）。
 * `revision` 取不到（`not_measured`）時**不當作通過**：回 degraded，讓呼叫端誠實回報沒驗到。
 */
export function checkPackFreshness(pack, knowledge, revision = NOT_MEASURED) {
  const degraded = [];
  const byId = new Map((knowledge?.claims ?? []).map((c) => [c.claimId, c]));

  const stale = (pack.claimIds ?? [])
    .map((id) => ({ id, claim: byId.get(id) }))
    .filter(({ claim }) => !claim || NOT_REUSABLE.has(claim.validity));
  if (stale.length > 0) {
    const detail = stale.map(({ id, claim }) => `${id}[${claim?.validity ?? '不存在於事件流'}]`).join('、');
    return { ok: false, reason: `pack 引用的事實已失效或無法證明仍有效：${detail}`, degraded };
  }

  if (!revision || revision === NOT_MEASURED) {
    degraded.push('取不到目前的 revision，無法比對 pack 的 source revision（標 not_measured，不當成已驗）');
  } else if (pack.sourceRevision && pack.sourceRevision !== NOT_MEASURED && pack.sourceRevision !== revision) {
    return {
      ok: false,
      reason: `pack 建立在 ${pack.sourceRevision}，目前是 ${revision}——請以目前 revision 重建 pack（或先跑失效判定）`,
      degraded,
    };
  } else if (!pack.sourceRevision || pack.sourceRevision === NOT_MEASURED) {
    degraded.push('pack 沒記下 source revision，無從證明它對應目前的程式碼');
  }
  return { ok: true, degraded };
}

/**
 * 判斷一次 Agent 派工能不能放行 → `{ allowed, reason?, marker?, degraded[] }`（純函式）。
 *
 * `knowledge` 是這條 loop 的知識狀態；`knowledge.enabled === false`（從沒用過共享記憶）⇒ 一律放行。
 * `prompt` 抽不到內容也一律放行——判不出來就擋，代價是整個派工面失效，而擋到的不一定是違規
 * （這是本 hook 家族的既有慣例，見 `agent-trace.mjs`）。
 */
export function evaluateDispatch({ prompt, knowledge, revision = NOT_MEASURED, loopSlug = null } = {}) {
  const degraded = [];
  if (!knowledge?.enabled) return { allowed: true, degraded, skipped: 'loop 尚未使用共享記憶' };
  if (typeof prompt !== 'string' || prompt === '') return { allowed: true, degraded, skipped: '抽不到 prompt' };

  // repo-aware 與否讀 trace envelope 的 activity（envelope 本身由 agent-trace-guard 負責要求）。
  const trace = extractTraceEnvelope(prompt);
  const repoAware = trace ? classifyActivity(trace.activity) : null;
  if (repoAware === false) return { allowed: true, degraded, skipped: `activity「${trace.activity}」不是 repo-aware` };
  if (repoAware === null) {
    degraded.push('派工沒有可辨識的 activity，無法判定是否 repo-aware（不因此擋路，但也不算驗過）');
    return { allowed: true, degraded };
  }

  const marker = parsePackMarker(prompt);
  if (!marker) {
    return {
      allowed: false,
      degraded,
      reason: [
        'repo-aware 的 agent 派工缺少 context pack 身分，事後查不出它拿到哪些事實，也擋不住「再把專案重新熟悉一遍」。',
        '請先用 context broker 產一份 pack（node scripts/context-pack.mjs <loop 目錄> --stage <phase> --role <role> --task <id> --revision <sha>），',
        '把它的第一行 marker 原樣放進 prompt：',
        '<!-- loops-pack id="<packId>" loop="<slug>" role="<role>" task="<task id 或 ->" revision="<git sha>" independence="<排除的 channel 或 none>" -->',
        'role 的合法值見 references/workflow-vocabulary.json 的 knowledge.roles。',
      ].join('\n'),
    };
  }
  if (loopSlug && marker.loopSlug !== loopSlug) {
    return { allowed: false, degraded, marker, reason: `pack 屬於 loop「${marker.loopSlug}」，這次派工在「${loopSlug}」——跨 loop 重用 context 會把另一條線的事實當成自己的` };
  }

  const pack = (knowledge.packs ?? []).find((p) => p.packId === marker.packId);
  if (!pack) {
    return { allowed: false, degraded, marker, reason: `pack ${marker.packId} 不在這條 loop 的事件流裡——marker 是手打的、或 pack 沒有 append \`context-pack.built\`（沒登記過的 pack 無從稽核）` };
  }

  const freshness = checkPackFreshness(pack, knowledge, revision);
  degraded.push(...freshness.degraded);
  if (!freshness.ok) return { allowed: false, degraded, marker, pack, reason: freshness.reason };

  return { allowed: true, degraded, marker, pack };
}

// ── IO 薄邊界 ───────────────────────────────────────────────────────────────

/** 讀一條 loop 的知識狀態（事件流讀不到就回空狀態＝enabled false ⇒ 閘 no-op）。 */
export function loadKnowledge(loopDir) {
  try {
    return readKnowledge(loopDir).state;
  } catch {
    return projectKnowledge([]);
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main(argv) {
  const flag = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  const loopDir = flag('--loop-dir');
  const promptFile = flag('--prompt-file');
  if (!loopDir || !promptFile) {
    process.stdout.write('用法：node context-gate.mjs --loop-dir <dir> --prompt-file <file> [--revision <sha>] [--loop <slug>] [--json]\n');
    return 0;
  }
  let prompt = '';
  try { prompt = readFileSync(promptFile, 'utf8'); } catch { prompt = ''; }
  const decision = evaluateDispatch({
    prompt,
    knowledge: loadKnowledge(loopDir),
    revision: flag('--revision', NOT_MEASURED),
    loopSlug: flag('--loop'),
  });
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
  } else if (decision.allowed) {
    process.stdout.write(`✓ context-gate：放行${decision.skipped ? `（${decision.skipped}）` : ''}\n`);
    for (const d of decision.degraded) process.stdout.write(`  ! 未驗到：${d}\n`);
  } else {
    process.stdout.write(`✗ context-gate：擋下——${decision.reason}\n`);
  }
  return decision.allowed ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
