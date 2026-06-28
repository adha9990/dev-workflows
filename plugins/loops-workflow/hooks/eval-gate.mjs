#!/usr/bin/env node
// eval-gate.mjs —— loops-workflow Stop hook：當 (1) opt-in 開啟、(2) cwd 有 eval-results.jsonl
//   歷史檔、(3) 這趟有累積編輯 三條件齊備時，跑 eval-metrics check 比歷史；偵測 passRate 退化
//   （exit 1）把警示注入回 context 促 agent 自我修正，無退化靜默。永不擋路：未達條件 / spawn
//   失敗 / 任何例外 → no-op exit 0。
//
// ⚠️ SECURITY：eval-metrics check 只**讀** .loops/.metrics/eval-results.jsonl 與 spawn 同 plugin
//   的固定腳本（不執行 repo 內定義的命令，故風險低於 stop-gate）；仍 opt-in 預設關。
//
// accumulator 協調：與 stop-gate 共用 edit-accumulator。本 hook 在 hooks.json 排在 stop-gate **之前**、
//   且**只在 stop-gate 未啟用時**才清 accumulator —— stop-gate 開時由它清（本 hook 先跑、讀到編輯、不清），
//   避免兩個 gate 互踩把對方的編輯清掉。
//
// 分層（仿 hooks/stop-gate.mjs）：
//   1) 純函式（無 IO，測試直接 import）：shouldRunEvalGate / buildEvalGateInjection。
//   2) IO 薄邊界：main()（讀 stdin、查歷史檔、spawn eval-metrics check、視情況清 accumulator）——被 import 時不執行。
// 依賴：僅 node 內建（fs / path / url / child_process / process），零外部套件。

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { readEditsForSession, clearEditsState } from './edit-accumulator.mjs';

const GATE_TIMEOUT_MS = 120000; // check 很便宜（讀 JSONL）；上限 2 分鐘，逾時視為 spawn 失敗 → no-op
const MAX_INJECTION_CHARS = 10000; // 注入回 context 的摘要上限，過長截斷

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

// ── IO 薄邊界：main()（被 import 時不執行）────────────────────────────────────────

// eval-metrics 腳本路徑由本檔位置推得：hooks/ 上一層即 plugin root，再 + scripts/eval-metrics.mjs。
const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const METRICS_SCRIPT = join(dirname(HOOKS_DIR), 'scripts', 'eval-metrics.mjs');
const METRICS_FILE_REL = ['.loops', '.metrics', 'eval-results.jsonl'];

function readStdin() {
  return readFileSync(0, 'utf8'); // fd 0 = stdin（hook payload 由父行程以 pipe 餵入）
}

/**
 * Stop hook 入口：條件齊備才 spawn eval-metrics check；退化注入警示、無退化靜默。
 * 安全 / 永不擋路：env 預設關、無歷史檔 / 無編輯 → no-op、spawn 失敗 → no-op、任何例外 exit 0。
 * spawn 的是 plugin 自帶腳本（固定路徑 + 固定參數），metricsFile 由 cwd 推得，不內插任何外部字串。
 */
function main() {
  const flagOn = process.env.LOOPS_EVAL_GATE === '1';
  if (!flagOn) return; // opt-in 預設關 → no-op，連 stdin 都不讀

  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return; // payload 壞 → no-op
  }

  const cwd = payload?.cwd;
  if (typeof cwd !== 'string') return; // 無 cwd → 無從定位歷史檔

  const sessionId = payload.session_id;
  const metricsFile = join(cwd, ...METRICS_FILE_REL);
  const hasMetrics = existsSync(metricsFile);
  const hasEdits = readEditsForSession(sessionId).length > 0;

  if (!shouldRunEvalGate({ flagOn, hasMetrics, hasEdits })) return; // 未達條件 → no-op

  const res = spawnSync(
    process.execPath,
    [METRICS_SCRIPT, 'check', '--metrics-file', metricsFile],
    { encoding: 'utf8', timeout: GATE_TIMEOUT_MS },
  );
  if (res.error) return; // spawn 失敗 / 逾時 → no-op（不擋）

  const injection = buildEvalGateInjection(`${res.stderr || ''}${res.stdout || ''}`, res.status);
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

  // accumulator 清理：只有 stop-gate 未啟用時由本 hook 負責清（stop-gate 開時由它清、本 hook 先跑不清）。
  if (process.env.LOOPS_STOP_GATE !== '1') clearEditsState(sessionId);
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
