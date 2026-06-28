#!/usr/bin/env node
// eval-gate.mjs —— loops-workflow Stop hook：改檔回合（這趟有累積編輯）時，依三個各自 opt-in 的訊號
//   把 eval 觀測注入回 context 促 agent 自我修正，三者合併為單一 additionalContext。永不擋路：
//   未達條件 / spawn 失敗 / 任何例外 → no-op exit 0（注入是 advisory，從不阻擋 Stop）。
//     1) GATE（LOOPS_EVAL_GATE）：eval-metrics check 比歷史，偵測 passRate 退化（exit 1）才注入。
//     2) TAGS（LOOPS_EVAL_TAGS_GATE）：eval-tags by-tag 讀 per-task report，列出有失敗的 tag。
//     3) POLL（LOOPS_EVAL_POLL_GATE）：eval-poll poll 聚合 judge panel 共識（advisory、非回歸 gate）。
//
// ⚠️ SECURITY：三訊號都只 spawn 同 plugin 的固定腳本（固定子命令 + 固定參數）、只**讀** cwd 下
//   .loops/.metrics 的固定檔（路徑由 payload.cwd 推得、不內插任何外部字串、無 shell）；預設全關。
//
// accumulator 協調：與 stop-gate 共用 edit-accumulator。本 hook 排在 stop-gate **之前**、且**只在
//   stop-gate 未啟用時**才清 accumulator（stop-gate 開時由它清、本 hook 先跑讀到編輯不清），
//   避免兩 gate 互踩。任一訊號真的跑過閘（ranAny）才消費 edits。
//
// 分層（仿 hooks/stop-gate.mjs）：
//   1) 純函式（無 IO，測試直接 import）：shouldRun*Gate / build*Injection / composeInjections。
//   2) IO 薄邊界：main()（讀 stdin、查輸入檔、spawn 三腳本、合併注入、視情況清 accumulator）——被 import 時不執行。
// 依賴：僅 node 內建（fs / path / url / child_process / process），零外部套件。

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { readEditsForSession, clearEditsState } from './edit-accumulator.mjs';

const GATE_TIMEOUT_MS = 120000; // check 很便宜（讀 JSONL）；上限 2 分鐘，逾時視為 spawn 失敗 → no-op
const MAX_INJECTION_CHARS = 10000; // 注入回 context 的摘要上限，過長截斷
const MAX_TAG_CHARS = 80; // 單 tag 名注入上限：file-derived 字串截斷，防超長 corpus tag 名灌爆 context

// ── 純函式層（無 IO，測試直接 import）─────────────────────────────────────────────

/** 三道前置條件（flag 開、有歷史檔、有編輯）皆成立才跑閘——任一缺位即不跑。 */
export function shouldRunEvalGate({ flagOn, hasMetrics, hasEdits }) {
  return Boolean(flagOn && hasMetrics && hasEdits);
}

/**
 * 只有 eval-metrics check 判定退化（exit code 1）才注入；其餘（0 無退化 / 2 誤用 / null spawn 異常）→ null。
 * 退化診斷在 check 的 stderr/stdout；空輸出時給一句固定退化提示，避免注入空 additionalContext。
 */
export function buildEvalGateInjection(output, exitCode) {
  if (exitCode !== 1) return null;
  const out = String(output ?? '').slice(0, MAX_INJECTION_CHARS);
  return out.trim() ? out : '⚠ eval 回歸：eval-metrics check 偵測到 passRate 退化（exit 1）。建議先查看 .loops/.metrics/eval-results.jsonl。';
}

/** 三道前置（flag 開、這趟有編輯、有 per-task report）皆成立才跑 tags 閘——任一缺位即不跑。 */
export function shouldRunTagsGate({ flagOn, hasEdits, hasReport }) {
  return Boolean(flagOn && hasEdits && hasReport);
}

/** 三道前置（flag 開、這趟有編輯、有 judge records）皆成立才跑 poll 閘——任一缺位即不跑。 */
export function shouldRunPollGate({ flagOn, hasEdits, hasJudge }) {
  return Boolean(flagOn && hasEdits && hasJudge);
}

/** tolerant JSON.parse：壞輸入回 null（注入建構共用，避免兩處重抄 try/catch）。 */
function parseJsonOrNull(text) {
  try {
    return JSON.parse(String(text ?? ''));
  } catch {
    return null;
  }
}

/**
 * 消毒 file-derived 的 tag 名後才注入 LLM context：換行 / 控制字元（C0 控制碼 + DEL）壓成單一空白、
 * 再截到 MAX_TAG_CHARS——防惡意 tag 名偽造額外行（prompt-injection / 偽造行面）或灌爆注入長度。
 * 只動 tag 名這個外部字串；同段的 failed / total 是數字、無需消毒。
 */
function sanitizeTag(tag) {
  // 消毒策略：逐 code point 檢查——C0 控制碼（< 0x20，含換行 / 歸位 / Tab / BEL / ESC）與 DEL（0x7F）
  // 換成空白、其餘（含非 ASCII tag 名）原樣保留；再把連續空白壓成單一格，最後截到 MAX_TAG_CHARS。
  const collapsed = [...String(tag ?? '')]
    .map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? ' ' : ch))
    .join('')
    .replace(/ +/g, ' ');
  return collapsed.slice(0, MAX_TAG_CHARS);
}

/**
 * eval-tags by-tag 輸出 → 有失敗 tag 才注入。exitCode !== 0（誤用 2 / 讀檔失敗 3 / spawn 異常 null）→ null
 * （出錯不拿非法輸出當注入、永不擋）；parse 失敗 / byTag 非陣列 / 無失敗 tag → null（無事不擾）。
 * tag 名來自 corpus 資料（file-derived），拼進注入前先 sanitizeTag 消毒；總量仍受 MAX_INJECTION_CHARS cap。
 */
export function buildTagsGateInjection(stdout, exitCode) {
  if (exitCode !== 0) return null;
  const byTag = parseJsonOrNull(stdout)?.byTag;
  if (!Array.isArray(byTag)) return null;
  const fails = byTag.filter((t) => t?.failed > 0);
  if (fails.length === 0) return null;
  const detail = fails.map((t) => `${sanitizeTag(t.tag)} ${t.failed}/${t.total}`).join('、');
  return `★ eval-tags（改檔回合）：有 eval 失敗的 tag — ${detail}。建議查對應 task 類別。`.slice(0, MAX_INJECTION_CHARS);
}

/**
 * eval-poll poll 輸出 → judge panel 共識計數注入（只印計數、不展開逐 case，確保長度 ≤ 上限）。
 * exitCode !== 0 → null；parse 失敗 / loaded 非 >0 / cases 非「非空陣列」→ null（無共識可報）。
 */
export function buildPollGateInjection(stdout, exitCode) {
  if (exitCode !== 0) return null;
  const parsed = parseJsonOrNull(stdout);
  const cases = parsed?.cases;
  const loaded = parsed?.loaded;
  if (!Array.isArray(cases) || cases.length === 0 || !(loaded > 0)) return null;
  const skippedNote = parsed.skipped > 0 ? `、skipped ${parsed.skipped}` : '';
  return `★ eval-poll（改檔回合）：judge panel 共識 — ${cases.length} case、loaded ${loaded}${skippedNote}（judge-estimate advisory、非回歸 gate）。`.slice(0, MAX_INJECTION_CHARS);
}

/**
 * 合併多訊號注入成單一 additionalContext：濾掉 null / 空白段 → 以空行分隔 join；全空 → null。
 * 非陣列 → null（不丟）。整體仍受 MAX_INJECTION_CHARS 截斷。
 */
export function composeInjections(parts) {
  if (!Array.isArray(parts)) return null;
  const kept = parts.filter((p) => typeof p === 'string' && p.trim());
  if (kept.length === 0) return null;
  return kept.join('\n\n').slice(0, MAX_INJECTION_CHARS);
}

// ── IO 薄邊界：main()（被 import 時不執行）────────────────────────────────────────

// eval 腳本路徑由本檔位置推得：hooks/ 上一層即 plugin root，再 + scripts/<name>.mjs（固定、無外部內插）。
const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(dirname(HOOKS_DIR), 'scripts');
const METRICS_SCRIPT = join(SCRIPTS_DIR, 'eval-metrics.mjs');
const TAGS_SCRIPT = join(SCRIPTS_DIR, 'eval-tags.mjs');
const POLL_SCRIPT = join(SCRIPTS_DIR, 'eval-poll.mjs');
// 三訊號各自的輸入檔（相對 cwd 的固定落點，與 eval-metrics record 的落盤位置一致）。
const METRICS_FILE_REL = ['.loops', '.metrics', 'eval-results.jsonl'];
const REPORT_FILE_REL = ['.loops', '.metrics', 'eval-report.json'];
const JUDGE_FILE_REL = ['.loops', '.metrics', 'judge-results.jsonl'];

function readStdin() {
  return readFileSync(0, 'utf8'); // fd 0 = stdin（hook payload 由父行程以 pipe 餵入）
}

/**
 * 跑一個訊號：shouldRun 為否 → 不 spawn（ran:false）；spawn 失敗 / 逾時 → injection null（不擋）。
 * includeStderr：GATE 的退化診斷印在 eval-metrics check 的 stderr，故 GATE 需併 stderr；
 *   by-tag / poll 把結果印在 stdout，只取 stdout。回 { ran, injection } 供 main 合併與決定是否清 edits。
 */
function runGateSignal(shouldRun, scriptPath, args, buildInjection, { includeStderr = false } = {}) {
  if (!shouldRun) return { ran: false, injection: null };
  const res = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', timeout: GATE_TIMEOUT_MS });
  if (res.error) return { ran: true, injection: null }; // 跑了閘但 spawn 失敗 → 不注入、仍算 ran（消費 edits）
  const output = includeStderr ? `${res.stderr || ''}${res.stdout || ''}` : (res.stdout || '');
  return { ran: true, injection: buildInjection(output, res.status) };
}

/**
 * Stop hook 入口：三訊號各自 opt-in，齊備條件才 spawn 對應腳本，注入合併為單一 additionalContext。
 * 安全 / 永不擋路：三 flag 全關 → 連 stdin 都不讀、no-op；缺輸入 / 無編輯 / spawn 失敗 / 任何例外 exit 0。
 * spawn 的都是 plugin 自帶腳本（固定路徑 + 固定子命令 + 固定參數），輸入檔由 cwd 推得，不內插外部字串。
 */
function main() {
  const gateOn = process.env.LOOPS_EVAL_GATE === '1';
  const tagsOn = process.env.LOOPS_EVAL_TAGS_GATE === '1';
  const pollOn = process.env.LOOPS_EVAL_POLL_GATE === '1';
  if (!(gateOn || tagsOn || pollOn)) return; // 三閘全關 → no-op，連 stdin 都不讀

  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return; // payload 壞 → no-op
  }

  const cwd = payload?.cwd;
  if (typeof cwd !== 'string') return; // 無 cwd → 無從定位輸入檔（早退在清 accumulator 之前）

  const sessionId = payload.session_id;
  const hasEdits = readEditsForSession(sessionId).length > 0;
  const metricsFile = join(cwd, ...METRICS_FILE_REL);
  const reportFile = join(cwd, ...REPORT_FILE_REL);
  const judgeFile = join(cwd, ...JUDGE_FILE_REL);

  const gate = runGateSignal(
    shouldRunEvalGate({ flagOn: gateOn, hasMetrics: existsSync(metricsFile), hasEdits }),
    METRICS_SCRIPT, ['check', '--metrics-file', metricsFile], buildEvalGateInjection, { includeStderr: true },
  );
  const tags = runGateSignal(
    shouldRunTagsGate({ flagOn: tagsOn, hasEdits, hasReport: existsSync(reportFile) }),
    TAGS_SCRIPT, ['by-tag', '--results', reportFile], buildTagsGateInjection,
  );
  const poll = runGateSignal(
    shouldRunPollGate({ flagOn: pollOn, hasEdits, hasJudge: existsSync(judgeFile) }),
    POLL_SCRIPT, ['poll', '--records', judgeFile, '--score-method', 'median'], buildPollGateInjection,
  );

  const injection = composeInjections([gate.injection, tags.injection, poll.injection]);
  if (injection !== null) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'Stop',
          additionalContext: injection,
        },
      }),
    );
  }

  // accumulator 清理：任一訊號真的跑過閘（ranAny）才消費 edits；只在 stop-gate「真的會跑並清」時才 defer
  //   給它清（本 hook 排在 stop-gate 之前、先跑不清，避免互踩）。stop-gate 的執行前置是 cwd 下
  //   .loops/gate.config.json 存在——缺 config 時 stop-gate 會早退不清，故此時不可盲 defer，否則 edits 沒人清
  //   → 每次 Stop 重觸發（洩漏）；改由本 hook 自己清。全短路未跑閘 → 不清，分辨「短路 vs 跑空閘」。
  //   殘留窄洞（誠實註明）：stop-gate config 在但其 spawn 罕見失敗時，本 hook 已 defer 不清 → 該回合 edits 仍可能殘留。
  const ranAny = gate.ran || tags.ran || poll.ran;
  const deferToStopGate = process.env.LOOPS_STOP_GATE === '1' && existsSync(join(cwd, '.loops', 'gate.config.json'));
  if (ranAny && !deferToStopGate) clearEditsState(sessionId);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch {
    // hook 絕不可因錯誤擋路：吞掉所有例外
  }
  process.exit(0);
}
