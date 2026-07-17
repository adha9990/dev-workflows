#!/usr/bin/env node
// read-accumulator.mjs —— loops-workflow PostToolUse(Read) hook：把本 session 讀過的「對外規範
// 參考檔」（comment-policy.md / outbound-templates.md）basename 累積進 os.tmpdir() 的 state 檔，
// 供 outbound-comment-guard v2 的 read-gate 判斷「送出對外內容前，這個 session 有沒有先讀過對
// 應規範」（#131）。純記錄、不擋路、任何錯誤 no-op exit 0。
//
// 分層（仿 hooks/edit-accumulator.mjs）：
//   1) 純函式（無 IO，測試直接 import）：addRead / loadReads / readsStateFile。
//   2) state IO 單一真相源（export，本檔 main 與 outbound-comment-guard 共用）：
//      readReadsForSession / writeReadsState——「讀 / 寫 state 檔」只在這層各定義一次，不散落兩處。
//   3) IO 薄邊界：main()（讀 stdin、經上述 state IO 落盤）——被 import 時不執行（import.meta.url 守門）。
// 依賴：僅 node 內建（fs / os / path / url / process）+ 同目錄 hook-flags，零外部套件。
//
// 不做 loops-scoped（`.loops/` 存在）過濾——不同於 edit-accumulator：讀規範檔這個動作本身就是
// 訊號，跟目標 repo 是否為 loops 專案無關；outbound-comment-guard 的 read-gate 對任何 repo 都適用。

import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 安全檔名規則的單一真相源：沿用 suggest-compact 的 sanitizeSessionId（避免重抄正則而漂移）。
import { sanitizeSessionId } from './suggest-compact.mjs';
import { flagEnabled } from './hook-flags.mjs';

// read-gate 只在乎這兩份「對外規範」檔有沒有讀過；basename 精確比對（大小寫不敏感）、忽略路徑。
const TRACKED_REFERENCE_FILES = ['comment-policy.md', 'outbound-templates.md'];

// ── 純函式層（無 IO，測試直接 import）─────────────────────────────────────────────

/** append 一筆已讀 basename：回「新」陣列（不就地改入參）；已存在則去重不重覆加。 */
export function addRead(list, basename) {
  const base = Array.isArray(list) ? list : [];
  if (base.includes(basename)) return [...base];
  return [...base, basename];
}

/**
 * 解析 state 檔內容字串 → 取出已累積的已讀 basename 陣列。
 * 壞 JSON / 非物件 / 無 reads 欄 / 空 → []（容錯不丟，永不擋路）。
 */
export function loadReads(rawString) {
  let parsed;
  try {
    parsed = JSON.parse(rawString);
  } catch {
    return []; // 壞 JSON / 空字串 → 視為空
  }
  if (!parsed || typeof parsed !== 'object') return [];
  return Array.isArray(parsed.reads) ? parsed.reads : [];
}

/** session 對應的 accumulator state 檔絕對路徑：os.tmpdir()/loops-reads-<safe session>.json。 */
export function readsStateFile(sessionId) {
  return join(tmpdir(), `loops-reads-${sanitizeSessionId(sessionId)}.json`);
}

// ── basename 判斷（跨平台，不依賴 node path.basename——host 平台的分隔符判定會漏掉另一種）───

/** '/' 與 '\' 皆視為分隔符取最後一段——不能只用 node path.basename（POSIX host 不識別 '\'）。 */
function crossPlatformBasename(filePath) {
  const normalized = String(filePath ?? '').replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

/** file_path 是否精確命中兩份受管規範檔之一（大小寫不敏感）；命中回其正規（小寫）檔名，否則 null。 */
function matchTrackedReference(filePath) {
  const base = crossPlatformBasename(filePath).toLowerCase();
  return TRACKED_REFERENCE_FILES.find((name) => name === base) ?? null;
}

// ── IO 薄邊界：main()（被 import 時不執行）────────────────────────────────────────

function readStdin() {
  return readFileSync(0, 'utf8'); // fd 0 = stdin（hook payload 由父行程以 pipe 餵入）
}

function readStateRaw(stateFile) {
  try {
    return readFileSync(stateFile, 'utf8');
  } catch {
    return ''; // 尚無 state 檔 → 視為空（loadReads('') === []）
  }
}

// state 檔寫入的唯一落點：序列化 state 物件 → 寫本 session 的 tmp 檔。writeReadsState 經這裡，
// 確保「寫 state 檔」只有一處 writeFileSync（單一真相源）。
function writeStateFile(sessionId, state) {
  writeFileSync(readsStateFile(sessionId), JSON.stringify(state), 'utf8');
}

/**
 * 讀本 session 已累積的已讀 basename 陣列：state 檔不存在 / 壞 JSON / 無 reads → []（容錯不丟）。
 * accumulator.main 與 outbound-comment-guard 的 read-gate 讀 state 的唯一入口（讀路徑只有
 * readStateRaw 一處）。
 */
export function readReadsForSession(sessionId) {
  return loadReads(readStateRaw(readsStateFile(sessionId)));
}

/** 把已讀 basename 陣列落盤成本 session 的 state（{ ts, reads }）；accumulator.main 累積後寫回用。 */
export function writeReadsState(sessionId, reads) {
  writeStateFile(sessionId, { ts: Date.now(), reads });
}

/**
 * PostToolUse(Read) hook 入口：命中受管規範檔（comment-policy.md / outbound-templates.md，
 * basename 精確比對、大小寫不敏感）才去重累積進本 session 的 state 檔；其餘檔案不記、不建檔。
 * 安全 / 永不擋路：先無條件讀滿 stdin 再查 flag（同序見 edit-accumulator.mjs 的 EPIPE 教訓——先
 *   查 flag 就提前 return 會讓子行程在父行程仍在寫大 payload 時提前關閉 pipe）；
 *   LOOPS_COMMENT_GUARD='0' 或無檔路徑或非受管檔 → no-op；state 只落在 os.tmpdir()；任何例外 exit 0。
 */
function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return; // payload 壞 → no-op
  }

  // 本 accumulator 是 outbound-comment-guard read-gate 的唯一 producer；共用同一把 flag——flag 關
  // 掉時兩端都該退回 v1 行為，沒有「只關 guard、accumulator 繼續空轉寫 tmp」的中間態。
  if (!flagEnabled('LOOPS_COMMENT_GUARD', process.env)) return;

  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== 'string' || !filePath) return; // 無檔路徑 → 無事可記

  const tracked = matchTrackedReference(filePath);
  if (!tracked) return; // 非受管規範檔 → 不記、不建 state 檔

  const sessionId = payload.session_id;
  const next = addRead(readReadsForSession(sessionId), tracked);
  writeReadsState(sessionId, next);
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
