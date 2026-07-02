#!/usr/bin/env node
// stop-gate.mjs —— loops-workflow Stop hook：當 (1) opt-in 開啟、(2) cwd 是 loops gate 工作區
// （存在 .loops/gate.config.json）、(3) 這趟有累積編輯 三條件齊備時，跑 quality-gate 的 type/lint
// 兩道閘；紅燈把摘要注入回 context 促 agent 自我修正，綠燈靜默。無論綠紅，gate 跑完都清空 accumulator。
// 永不擋路：未達條件 / spawn 失敗 / 任何例外 → no-op exit 0。
//
// ⚠️ SECURITY：啟用 LOOPS_STOP_GATE 等於授權「在每個改檔回合自動執行 .loops/gate.config.json
//   內定義的 lint/type 命令」（以及 quality-gate 偵測到的 lint/test 工具）。這些命令來自 repo、
//   等同自動執行 repo 控制的 code。**只在你信任的 repo 開此 flag。** 風險本就存在於手動跑
//   quality-gate；本 hook 把它變成改檔回合自動，故格外提醒。
//
// 發現性提示（#87）：LOOPS_STOP_GATE 仍是 optIn（未設＝關）。當 flag 關但 cwd 是 loops gate 工作區
//   （有 .loops/gate.config.json）時，主動提示可設 LOOPS_STOP_GATE=1 啟用——每個 session 只提示一次
//   （state 記在 os.tmpdir()，仿 suggest-compact 的 per-session 節流）。
//
// 分層（仿 hooks/suggest-compact.mjs / scripts/loops-quality-gate.mjs）：
//   1) 純函式（無 IO，測試直接 import）：shouldRunGate / buildGateInjection / shouldShowDiscoveryHint。
//   2) IO 薄邊界：main()（讀 stdin、查 config、spawn quality-gate、清 accumulator、發現性提示）——被
//      import 時不執行。
// 依賴：僅 node 內建（fs / os / path / url / child_process / process），零外部套件。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// state 讀 / 清、安全檔名規則都走 edit-accumulator 的單一真相源 IO（本檔不再自存一份 readStateRaw）。
import { readEditsForSession, clearEditsState, sanitizeSessionId } from './edit-accumulator.mjs';
import { flagEnabled } from './hook-flags.mjs';

const GATE_TIMEOUT_MS = 300000; // 跑閘上限 5 分鐘，逾時視為 spawn 失敗 → no-op（不擋）
const MAX_INJECTION_CHARS = 10000; // 注入回 context 的摘要上限，過長截斷
const DISCOVERY_HINT =
  '[loops-workflow] 偵測到 .loops/gate.config.json：可設 LOOPS_STOP_GATE=1，讓每次改檔回合自動跑 ' +
  'type/lint 閘並在紅燈時提示修正。⚠️ 此 flag 會自動執行 repo 控制的 lint/type 命令，僅在你信任的 repo 開啟。';

// ── 純函式層（無 IO，測試直接 import）─────────────────────────────────────────────

/** 三道前置條件（flag 開、有 gate.config、有編輯）皆成立才跑閘——任一缺位即不跑。 */
export function shouldRunGate({ flagOn, hasConfig, hasEdits }) {
  return Boolean(flagOn && hasConfig && hasEdits);
}

/**
 * 綠燈（ok===true）靜默不注入 → null；紅燈回摘要字串（上限 MAX_INJECTION_CHARS，過長截斷）。
 * 空 guard：gate 腳本崩潰時 stdout 可能為空 / 全空白——此時也回 null，避免注入空 additionalContext。
 */
export function buildGateInjection(summary, ok) {
  if (ok === true) return null;
  const out = String(summary).slice(0, MAX_INJECTION_CHARS);
  return out.trim() ? out : null;
}

/** 發現性提示三條件：flag 關（optIn 未開）、cwd 是 gate 工作區、本 session 未提示過 —— 皆成立才提示。 */
export function shouldShowDiscoveryHint({ flagOn, hasConfig, alreadyHinted }) {
  return Boolean(!flagOn && hasConfig && !alreadyHinted);
}

// ── IO 薄邊界：main()（被 import 時不執行）────────────────────────────────────────

// quality-gate 腳本路徑由本檔位置推得：hooks/ 上一層即 plugin root，再 + scripts/loops-quality-gate.mjs。
const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const GATE_SCRIPT = join(dirname(HOOKS_DIR), 'scripts', 'loops-quality-gate.mjs');

function readStdin() {
  return readFileSync(0, 'utf8'); // fd 0 = stdin（hook payload 由父行程以 pipe 餵入）
}

/** 發現性提示的 per-session state 檔絕對路徑：os.tmpdir()/loops-stop-gate-hint-<safe session>.json。 */
function discoveryHintStateFile(sessionId) {
  return join(tmpdir(), `loops-stop-gate-hint-${sanitizeSessionId(sessionId)}.json`);
}

function hasAlreadyHinted(stateFile) {
  try {
    return Boolean(JSON.parse(readFileSync(stateFile, 'utf8'))?.hinted);
  } catch {
    return false; // 無 state / 壞檔 → 視為尚未提示過
  }
}

/**
 * flag 關但 cwd 是 gate 工作區、本 session 未提示過 → 印一行發現性提示並記住（per-session 只提示一次）。
 * persist-before-emit（防洗版，仿 suggest-compact:140）：先落盤「已提示」，落盤成功才印，
 * 確保「提示過」必然伴隨「已記住」，否則下次又會重複洗版。
 */
function maybeShowDiscoveryHint(sessionId, hasConfig) {
  const stateFile = discoveryHintStateFile(sessionId);
  const alreadyHinted = hasAlreadyHinted(stateFile);
  if (!shouldShowDiscoveryHint({ flagOn: false, hasConfig, alreadyHinted })) return;

  writeFileSync(stateFile, JSON.stringify({ hinted: true }));
  console.log(DISCOVERY_HINT);
}

/**
 * Stop hook 入口：條件齊備才 spawn quality-gate（type/lint）；紅燈注入摘要、綠燈靜默；跑完清 accumulator。
 * flag 關時改走發現性提示（cwd 是 gate 工作區且本 session 未提示過才印一行）。
 * 安全 / 永不擋路：先無條件讀滿 stdin 再查 flag（與家族其他 hook 同序，避免大 payload EPIPE）、
 * 無 gate.config / 無編輯 → no-op、spawn 失敗 → no-op、任何例外 exit 0。
 * spawn 的是 plugin 自帶腳本（固定路徑 + 固定參數），cwd 來自 payload，不內插任何外部字串。
 */
function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return; // payload 壞 → no-op
  }

  const cwd = payload?.cwd;
  if (typeof cwd !== 'string') return; // 無 cwd → 無從跑閘、也無從判定是否為 gate 工作區

  const flagOn = flagEnabled('LOOPS_STOP_GATE', process.env);
  const sessionId = payload.session_id;
  const hasConfig = existsSync(join(cwd, '.loops', 'gate.config.json'));

  if (!flagOn) {
    maybeShowDiscoveryHint(sessionId, hasConfig);
    return;
  }

  const hasEdits = readEditsForSession(sessionId).length > 0;

  if (!shouldRunGate({ flagOn, hasConfig, hasEdits })) return; // 未達條件 → no-op（不 spawn、不清）

  const res = spawnSync(
    process.execPath,
    [GATE_SCRIPT, '--cwd', cwd, '--gates', 'type,lint'],
    { encoding: 'utf8', timeout: GATE_TIMEOUT_MS },
  );
  if (res.error) return; // spawn 失敗 / 逾時 → no-op（不擋、不清）

  const injection = buildGateInjection(res.stdout, res.status === 0);
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

  // 無論綠紅，gate 跑完即清空 accumulator（下趟重新累積，避免舊編輯一直觸發重跑）。
  clearEditsState(sessionId);
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
