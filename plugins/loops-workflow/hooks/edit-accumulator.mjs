#!/usr/bin/env node
// edit-accumulator.mjs —— loops-workflow PostToolUse(Write|Edit|MultiEdit) hook：把本 session 編輯過的檔案路徑
// 累積進 os.tmpdir() 的 state 檔，供 Stop 階段的 stop-gate / eval-gate 判斷「這趟有沒有改過檔」。
// 純記錄、不擋路、任何錯誤 no-op exit 0。loops-scoped（#87）：只在 payload.cwd 下存在 .loops/ 才記錄，
// 不擾非 loops 專案。
//
// 分層（仿 hooks/suggest-compact.mjs）：
//   1) 純函式（無 IO，測試直接 import）：addEdit / loadEdits / clearEdits / editsStateFile。
//   2) state IO 單一真相源（export，本檔 main 與 stop-gate 共用）：readEditsForSession /
//      writeEditsState / clearEditsState——「讀 / 寫 state 檔」只在這層各定義一次，不散落兩處。
//   3) IO 薄邊界：main()（讀 stdin、經上述 state IO 落盤）——被 import 時不執行（import.meta.url 守門）。
// 依賴：僅 node 內建（fs / os / path / url / process），零外部套件。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 安全檔名規則的單一真相源：沿用 suggest-compact 的 sanitizeSessionId（避免重抄正則而漂移）。
import { sanitizeSessionId } from './suggest-compact.mjs';
import { flagEnabled } from './hook-flags.mjs';

export { sanitizeSessionId };

// accumulator 的消費端旗標：任一開啟就代表有下游 gate 需要「這趟改了哪些檔」，producer 才記 edit。
// stop-gate（LOOPS_STOP_GATE，optIn）與 eval-gate 三訊號（LOOPS_EVAL_GATE / _TAGS_GATE / _POLL_GATE，
// defaultOn）皆消費同一份 state；各自依 hook-flags 的分類判斷開關（#87）。
const ACCUMULATOR_FLAGS = ['LOOPS_STOP_GATE', 'LOOPS_EVAL_GATE', 'LOOPS_EVAL_TAGS_GATE', 'LOOPS_EVAL_POLL_GATE'];

// ── 純函式層（無 IO，測試直接 import）─────────────────────────────────────────────

/** append 一筆編輯路徑：回「新」陣列（不就地改入參）；已存在則去重不重覆加。 */
export function addEdit(list, path) {
  const base = Array.isArray(list) ? list : [];
  if (base.includes(path)) return [...base];
  return [...base, path];
}

/**
 * 解析 state 檔內容字串 → 取出已累積的 paths 陣列。
 * 壞 JSON / 非物件 / 無 paths 欄 / 空 → []（容錯不丟，永不擋路）。
 */
export function loadEdits(rawString) {
  let parsed;
  try {
    parsed = JSON.parse(rawString);
  } catch {
    return []; // 壞 JSON / 空字串 → 視為空
  }
  if (!parsed || typeof parsed !== 'object') return [];
  return Array.isArray(parsed.paths) ? parsed.paths : [];
}

/** 回空狀態：序列化後經 loadEdits 還原即為 []（清空 accumulator 用）。 */
export function clearEdits() {
  return { ts: Date.now(), paths: [] };
}

/** session 對應的 accumulator state 檔絕對路徑：os.tmpdir()/loops-edits-<safe session>.json。 */
export function editsStateFile(sessionId) {
  return join(tmpdir(), `loops-edits-${sanitizeSessionId(sessionId)}.json`);
}

// ── IO 薄邊界：main()（被 import 時不執行）────────────────────────────────────────

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

// state 檔寫入的唯一落點：序列化 state 物件 → 寫本 session 的 tmp 檔。writeEditsState /
// clearEditsState 都經這裡，確保「寫 state 檔」只有一處 writeFileSync（單一真相源）。
function writeStateFile(sessionId, state) {
  writeFileSync(editsStateFile(sessionId), JSON.stringify(state), 'utf8');
}

/**
 * 讀本 session 已累積的編輯路徑陣列：state 檔不存在 / 壞 JSON / 無 paths → []（容錯不丟）。
 * accumulator.main 與 stop-gate 讀 state 的唯一入口（讀路徑只有 readStateRaw 一處）。
 */
export function readEditsForSession(sessionId) {
  return loadEdits(readStateRaw(editsStateFile(sessionId)));
}

/** 把 paths 落盤成本 session 的 state（{ ts, paths }）；accumulator.main 累積後寫回用。 */
export function writeEditsState(sessionId, paths) {
  writeStateFile(sessionId, { ts: Date.now(), paths });
}

/** 清空本 session 的 accumulator：寫入 clearEdits() 的空狀態；stop-gate 跑完閘後呼叫。 */
export function clearEditsState(sessionId) {
  writeStateFile(sessionId, clearEdits());
}

/**
 * PostToolUse(Edit|Write) hook 入口：把編輯過的 file_path 去重累積進本 session 的 state 檔。
 * 安全 / 永不擋路：消費 flag 全關 / payload 壞掉 / 無檔路徑 / cwd 下無 .loops/ → no-op；
 * state 只落在 os.tmpdir()；任何例外 exit 0。
 */
function main() {
  // accumulator 的消費者是 stop-gate 與 eval-gate（含其 tags / poll 訊號）；ACCUMULATOR_FLAGS 任一
  // 依 hook-flags 判定為開，才需要「這趟改了哪些檔」。全關時真 no-op、不寫 tmp——
  // 避免「flag 關卻仍每次寫 state」的 footprint 不一致。
  if (!ACCUMULATOR_FLAGS.some((f) => flagEnabled(f, process.env))) return;

  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return; // payload 壞 → no-op
  }

  // loops-scoped（#87）：只在 payload.cwd 下存在 .loops/ 才記錄，不擾非 loops 專案。
  const cwd = payload?.cwd;
  if (typeof cwd !== 'string' || !existsSync(join(cwd, '.loops'))) return;

  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== 'string' || !filePath) return; // 無檔路徑 → 無事可記

  const sessionId = payload.session_id;
  const next = addEdit(readEditsForSession(sessionId), filePath);
  writeEditsState(sessionId, next);
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
