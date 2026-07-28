#!/usr/bin/env node
// test-hook-flags.mjs —— hook-flags.mjs 的紅綠斷言（自帶極簡 harness，仿同目錄其他 test-*.mjs）。
//
// 用法（cwd = plugins/loops-workflow）：node hooks/test-hook-flags.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1（主線用此 exit code 判紅綠）。
//
// 預期 Red：hooks/hook-flags.mjs 尚未實作（issue #87「hook 預設值翻轉」的新模組），
// 下面具名 import 會 ERR_MODULE_NOT_FOUND，整個檔在載入期就丟例外 → node 非 0 退出。
// 這就是 TDD 的紅燈起點。實作補齊後，下方斷言才有機會逐條轉綠。
//
// 對外契約（拍板後，見 issue #87 討論；#99 loop-driver 併入後追加 LOOPS_LOOP_DRIVER）：
//   FLAG_DEFAULTS：19 個 flag 的分類表（defaultOn / optIn）。
//   flagEnabled(name, env)：純函式，env 物件參數（非直接讀 process.env）。
//   - defaultOn 類（LOOPS_PATH_CONTAINMENT / LOOPS_WORKTREE_GUARD / LOOPS_COST_TRACKER /
//     LOOPS_EVAL_GATE / LOOPS_EVAL_TAGS_GATE / LOOPS_EVAL_POLL_GATE /
//     LOOPS_CONFIG_PROTECTION / LOOPS_COMMENT_GUARD / LOOPS_PR_GATE / LOOPS_PR_REALRUN_GATE /
//     LOOPS_PR_BLOCKING_GATE / LOOPS_PR_VALIDATION_GATE / LOOPS_PR_FOOTPRINT_GATE /
//     LOOPS_PR_CONFLICT_GATE / LOOPS_MERGE_GUARD / LOOPS_PR_OWNER_GUARD）：
//     僅字面 '0' 關；'1' / '' / 未設 / 'true' / 'off' / '2' 等怪值皆開（不會關）。
//   - optIn 類（LOOPS_STOP_GATE / LOOPS_COMPACT_HINT / LOOPS_LOOP_DRIVER）：
//     僅字面 '1' 開；其餘（未設 / '' / '0' / 'true' / 'yes' 等）皆關。

import { FLAG_DEFAULTS, flagEnabled } from './hook-flags.mjs';

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
function callSafe(fn) {
  try {
    return { threw: false, val: fn() };
  } catch (e) {
    return { threw: true, err: e };
  }
}

// defaultOn 類（15）：未設 / 怪值一律「開」，只有字面 '0' 才關。
// （#188：清單原缺 pr-gate 家族 5 枚〔已存在卻沒被 A1/A2 覆蓋的漂移〕，本輪一併補齊 + 加
//   LOOPS_PR_BLOCKING_GATE，並在 A1 加反向完整性斷言，防後續新增 flag 又被漏測。
//   #209：那條反向完整性斷言**真的接住了** LOOPS_PR_VALIDATION_GATE——新 flag 加進 FLAG_DEFAULTS
//   當下就紅，不是等到某天有人發現它沒被測到。#215 的 LOOPS_PR_FOOTPRINT_GATE 同樣被它接住。）
const DEFAULT_ON_FLAGS = [
  'LOOPS_PATH_CONTAINMENT',
  'LOOPS_WORKTREE_GUARD',
  'LOOPS_COST_TRACKER',
  'LOOPS_EVAL_GATE',
  'LOOPS_EVAL_TAGS_GATE',
  'LOOPS_EVAL_POLL_GATE',
  'LOOPS_CONFIG_PROTECTION',
  'LOOPS_COMMENT_GUARD',
  'LOOPS_PR_GATE',
  'LOOPS_PR_REALRUN_GATE',
  'LOOPS_PR_BLOCKING_GATE',
  'LOOPS_PR_VALIDATION_GATE',
  'LOOPS_PR_FOOTPRINT_GATE',
  'LOOPS_PR_CONFLICT_GATE',
  'LOOPS_MERGE_GUARD',
  'LOOPS_PR_OWNER_GUARD',
  // #217：telemetry 觀測與 Agent Gate。兩者都有「該 loop 已有 telemetry/」前置，
  // 所以預設開也不會影響舊 loop——deny 型的 AGENT_TRACE_GATE 對舊 loop 完全 no-op。
  'LOOPS_TELEMETRY',
  'LOOPS_AGENT_TRACE_GATE',
  'LOOPS_ARTIFACT_GATE',
  // #218：Context Pack Gate。前置比 #217 那兩道更窄——除了「該 loop 已有 telemetry/」，
  // 還要「這條 loop 真的用過共享記憶」，所以預設開對舊 loop 與尚未採用的 loop 都完全 no-op。
  'LOOPS_CONTEXT_PACK_GATE',
];
// optIn 類（3）：未設 / 怪值一律「關」，只有字面 '1' 才開。
const OPT_IN_FLAGS = [
  'LOOPS_STOP_GATE',
  'LOOPS_COMPACT_HINT',
  'LOOPS_LOOP_DRIVER',
];

// =============================================================================
// A) FLAG_DEFAULTS：分類表本身的契約（值即契約，逐欄釘死）
// =============================================================================

// ── A1：FLAG_DEFAULTS 是物件，含全部 18 個 flag 的分類 ────────────────────────
{
  assert(FLAG_DEFAULTS && typeof FLAG_DEFAULTS === 'object', 'FLAG_DEFAULTS：是物件 [A1]');
  for (const name of DEFAULT_ON_FLAGS) {
    assert(Object.prototype.hasOwnProperty.call(FLAG_DEFAULTS ?? {}, name),
      `FLAG_DEFAULTS：含 ${name} 這個 key [A1]`);
  }
  for (const name of OPT_IN_FLAGS) {
    assert(Object.prototype.hasOwnProperty.call(FLAG_DEFAULTS ?? {}, name),
      `FLAG_DEFAULTS：含 ${name} 這個 key [A1]`);
  }
  // A1-complete（#188）：反向完整性——FLAG_DEFAULTS 的 key 集合 = 兩份清單聯集，一個不多一個不少。
  // 少了 → 上面兩迴圈已抓；多了（新增 flag 沒同步進清單 → 被 A2/A3 漏測）→ 這條抓。
  const listed = new Set([...DEFAULT_ON_FLAGS, ...OPT_IN_FLAGS]);
  const actual = Object.keys(FLAG_DEFAULTS ?? {});
  const extra = actual.filter((k) => !listed.has(k));
  assert(extra.length === 0, `FLAG_DEFAULTS 沒有未列進測試清單的 flag（漏測防線；多出：${extra.join(',') || '無'}）[A1-complete]`);
  assert(actual.length === listed.size, `FLAG_DEFAULTS key 數（${actual.length}）= 清單聯集數（${listed.size}）[A1-complete]`);
}

// ── A2：defaultOn 類在 FLAG_DEFAULTS 中標記為 true（defaultOn === true）───────
{
  for (const name of DEFAULT_ON_FLAGS) {
    const entry = FLAG_DEFAULTS?.[name];
    const val = entry && typeof entry === 'object' ? entry.defaultOn : entry;
    assert(val === true, `FLAG_DEFAULTS.${name}：defaultOn === true [A2]`);
  }
}

// ── A3：optIn 類在 FLAG_DEFAULTS 中標記為 false（defaultOn === false）────────
{
  for (const name of OPT_IN_FLAGS) {
    const entry = FLAG_DEFAULTS?.[name];
    const val = entry && typeof entry === 'object' ? entry.defaultOn : entry;
    assert(val === false, `FLAG_DEFAULTS.${name}：defaultOn === false [A3]`);
  }
}

// =============================================================================
// B) flagEnabled(name, env) —— defaultOn 類：僅字面 '0' 關，其餘（含怪值）皆開
// =============================================================================

const WEIRD_ON_VALUES = ['1', '', 'true', 'off', '2', 'TRUE', 'no']; // 怪值：明斷言「不會關」
for (const name of DEFAULT_ON_FLAGS) {
  {
    const r = callSafe(() => flagEnabled(name, {}));
    assert(!r.threw && r.val === true, `flagEnabled(${name}, {})：未設 env → true（defaultOn）[B]`);
  }
  {
    const r = callSafe(() => flagEnabled(name, { [name]: '0' }));
    assert(!r.threw && r.val === false, `flagEnabled(${name}, {${name}:'0'})：字面 '0' → false（唯一關閉值）[B]`);
  }
  for (const weird of WEIRD_ON_VALUES) {
    const r = callSafe(() => flagEnabled(name, { [name]: weird }));
    assert(!r.threw && r.val === true,
      `flagEnabled(${name}, {${name}:${JSON.stringify(weird)}})：怪值 → true（不會關，只有字面 '0' 才關）[B]`);
  }
}

// =============================================================================
// C) flagEnabled(name, env) —— optIn 類：僅字面 '1' 開，其餘（含怪值）皆關
// =============================================================================

const WEIRD_OFF_VALUES = ['', '0', 'true', 'yes', 'TRUE', '2', 'on']; // 怪值：明斷言「不會開」
for (const name of OPT_IN_FLAGS) {
  {
    const r = callSafe(() => flagEnabled(name, {}));
    assert(!r.threw && r.val === false, `flagEnabled(${name}, {})：未設 env → false（optIn）[C]`);
  }
  {
    const r = callSafe(() => flagEnabled(name, { [name]: '1' }));
    assert(!r.threw && r.val === true, `flagEnabled(${name}, {${name}:'1'})：字面 '1' → true（唯一開啟值）[C]`);
  }
  for (const weird of WEIRD_OFF_VALUES) {
    const r = callSafe(() => flagEnabled(name, { [name]: weird }));
    assert(!r.threw && r.val === false,
      `flagEnabled(${name}, {${name}:${JSON.stringify(weird)}})：怪值 → false（不會開，只有字面 '1' 才開）[C]`);
  }
}

// =============================================================================
// D) flagEnabled：純函式（不讀 process.env，只吃傳入的 env 參數）
// =============================================================================

// ── D1：即便 process.env 有相反設定，flagEnabled 只看傳入的 env 參數（純函式、非直接讀 process.env）──
{
  const savedCost = process.env.LOOPS_COST_TRACKER;
  const savedStop = process.env.LOOPS_STOP_GATE;
  try {
    process.env.LOOPS_COST_TRACKER = '0'; // process.env 說「關」
    process.env.LOOPS_STOP_GATE = '1'; // process.env 說「開」
    const r1 = callSafe(() => flagEnabled('LOOPS_COST_TRACKER', {})); // 傳空 env → 應照 env 參數判（未設→開）
    assert(!r1.threw && r1.val === true,
      'flagEnabled：process.env.LOOPS_COST_TRACKER="0" 但傳入 env={} → true（純函式，不偷讀 process.env）[D1]');
    const r2 = callSafe(() => flagEnabled('LOOPS_STOP_GATE', {})); // 傳空 env → 應照 env 參數判（未設→關）
    assert(!r2.threw && r2.val === false,
      'flagEnabled：process.env.LOOPS_STOP_GATE="1" 但傳入 env={} → false（純函式，不偷讀 process.env）[D1]');
  } finally {
    if (savedCost === undefined) delete process.env.LOOPS_COST_TRACKER; else process.env.LOOPS_COST_TRACKER = savedCost;
    if (savedStop === undefined) delete process.env.LOOPS_STOP_GATE; else process.env.LOOPS_STOP_GATE = savedStop;
  }
}

// ── 摘要 + exit code ─────────────────────────────────────────────────────────
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
