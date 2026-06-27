#!/usr/bin/env node
// edit-accumulator.mjs —— loops-workflow PostToolUse(Edit|Write) hook：把本 session 編輯過的檔案路徑
// 累積進 os.tmpdir() 的 state 檔，供 Stop 階段的 stop-gate 判斷「這趟有沒有改過檔」。
// 純記錄、不擋路、任何錯誤 no-op exit 0。
//
// 分層（仿 hooks/suggest-compact.mjs）：
//   1) 純函式（無 IO，測試直接 import）：addEdit / loadEdits / clearEdits / editsStateFile。
//   2) IO 薄邊界：main()（讀 stdin、讀寫 tmp state）——被 import 時不執行（import.meta.url 守門）。
// 依賴：僅 node 內建（fs / os / path / url / process），零外部套件。

import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 安全檔名規則的單一真相源：沿用 suggest-compact 的 sanitizeSessionId（避免重抄正則而漂移）。
import { sanitizeSessionId } from './suggest-compact.mjs';

export { sanitizeSessionId };

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

/**
 * PostToolUse(Edit|Write) hook 入口：把編輯過的 file_path 去重累積進本 session 的 state 檔。
 * 安全 / 永不擋路：payload 壞掉 / 無檔路徑 → no-op；state 只落在 os.tmpdir()；任何例外 exit 0。
 */
function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return; // payload 壞 → no-op
  }

  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== 'string' || !filePath) return; // 無檔路徑 → 無事可記

  const stateFile = editsStateFile(payload.session_id);
  const next = addEdit(loadEdits(readStateRaw(stateFile)), filePath);
  writeFileSync(stateFile, JSON.stringify({ ts: Date.now(), paths: next }), 'utf8');
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
