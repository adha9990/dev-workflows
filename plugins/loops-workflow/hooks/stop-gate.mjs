#!/usr/bin/env node
// stop-gate.mjs —— loops-workflow Stop hook：當 (1) opt-in 開啟、(2) cwd 是 loops gate 工作區
// （存在 .loops/gate.config.json）、(3) 這趟有累積編輯 三條件齊備時，跑 quality-gate 的 type/lint
// 兩道閘；紅燈把摘要注入回 context 促 agent 自我修正，綠燈靜默。無論綠紅，gate 跑完都清空 accumulator。
// 永不擋路：未達條件 / spawn 失敗 / 任何例外 → no-op exit 0。
//
// 分層（仿 hooks/suggest-compact.mjs / scripts/loops-quality-gate.mjs）：
//   1) 純函式（無 IO，測試直接 import）：shouldRunGate / buildGateInjection。
//   2) IO 薄邊界：main()（讀 stdin、查 config、spawn quality-gate、清 accumulator）——被 import 時不執行。
// 依賴：僅 node 內建（fs / path / url / child_process / process），零外部套件。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { loadEdits, clearEdits, editsStateFile } from './edit-accumulator.mjs';

const GATE_TIMEOUT_MS = 300000; // 跑閘上限 5 分鐘，逾時視為 spawn 失敗 → no-op（不擋）
const MAX_INJECTION_CHARS = 10000; // 注入回 context 的摘要上限，過長截斷

// ── 純函式層（無 IO，測試直接 import）─────────────────────────────────────────────

/** 三道前置條件（flag 開、有 gate.config、有編輯）皆成立才跑閘——任一缺位即不跑。 */
export function shouldRunGate({ flagOn, hasConfig, hasEdits }) {
  return Boolean(flagOn && hasConfig && hasEdits);
}

/** 綠燈（ok===true）靜默不注入 → null；紅燈回摘要字串（上限 MAX_INJECTION_CHARS，過長截斷）。 */
export function buildGateInjection(summary, ok) {
  if (ok === true) return null;
  return String(summary).slice(0, MAX_INJECTION_CHARS);
}

// ── IO 薄邊界：main()（被 import 時不執行）────────────────────────────────────────

// quality-gate 腳本路徑由本檔位置推得：hooks/ 上一層即 plugin root，再 + scripts/loops-quality-gate.mjs。
const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const GATE_SCRIPT = join(dirname(HOOKS_DIR), 'scripts', 'loops-quality-gate.mjs');

function readStdin() {
  return readFileSync(0, 'utf8'); // fd 0 = stdin（hook payload 由父行程以 pipe 餵入）
}

function readStateRaw(stateFile) {
  try {
    return readFileSync(stateFile, 'utf8');
  } catch {
    return ''; // 尚無 state 檔 → 視為空（loadEdits('') === []）
  }
}

/**
 * Stop hook 入口：條件齊備才 spawn quality-gate（type/lint）；紅燈注入摘要、綠燈靜默；跑完清 accumulator。
 * 安全 / 永不擋路：env 預設關、無 gate.config / 無編輯 → no-op、spawn 失敗 → no-op、任何例外 exit 0。
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
  if (typeof cwd !== 'string') return; // 無 cwd → 無從跑閘

  const stateFile = editsStateFile(payload.session_id);
  const flagOn = process.env.LOOPS_STOP_GATE === '1';
  const hasConfig = existsSync(join(cwd, '.loops', 'gate.config.json'));
  const hasEdits = loadEdits(readStateRaw(stateFile)).length > 0;

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
  writeFileSync(stateFile, JSON.stringify(clearEdits()), 'utf8');
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
