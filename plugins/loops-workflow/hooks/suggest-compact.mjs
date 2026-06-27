#!/usr/bin/env node
// suggest-compact.mjs —— loops-workflow PreToolUse(Edit|Write) hook：依 transcript 的真實
// context 大小（API usage 推估）跨級距時，浮一句繁中提醒可考慮 /compact 省 token。
// 估算值、非精確；env LOOPS_COMPACT_HINT=1 才啟用，預設靜默。每個級距對同 session 只提醒一次
// （state 記在 os.tmpdir()，14 天 TTL 後重置）。
//
// 分層（仿 scripts/loops-quality-gate.mjs）：
//   1) 純函式（無 IO，測試直接 import）：getRealContextSize / computeReminderLevel /
//      shouldRemind / formatCompactHint / pruneStale。
//   2) IO 薄邊界：main()（讀 stdin / transcript、讀寫 tmp state、印 hook output）——被 import
//      時不執行（import.meta.url 守門）。任何錯誤一律吞掉 exit 0。
// 依賴：僅 node 內建（fs / os / path / url / process），零外部套件。

import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE = 250000; // 第一級提醒門檻（tokens）
const DEFAULT_STEP = 60000; // 每升一級的級距（tokens）
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // state 過期門檻：14 天

// ── 純函式層（無 IO，測試直接 import）─────────────────────────────────────────────

/**
 * 逐行解析 transcript（JSONL）→ 回「最後一個」有 usage 的 assistant 的真實 context 大小，
 * 即 input_tokens + cache_read_input_tokens + cache_creation_input_tokens（窗口實際載入量）。
 * 容錯：壞 JSON 行跳過；無任何 assistant usage → 0。
 */
export function getRealContextSize(content) {
  let size = 0;
  for (const line of String(content ?? '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== 'assistant' || !entry?.message?.usage) continue;

    const u = entry.message.usage;
    size = safeNum(u.input_tokens) + safeNum(u.cache_read_input_tokens) + safeNum(u.cache_creation_input_tokens);
  }
  return size;
}

/**
 * context 大小 → 提醒級數。base 以下為 0（不提醒）；達 base 起算 1，每跨一個 step 升一級。
 * opts 可覆寫 base / step（測試用）。
 */
export function computeReminderLevel(contextSize, opts = {}) {
  const base = opts.base ?? DEFAULT_BASE;
  const step = opts.step ?? DEFAULT_STEP;
  if (contextSize < base) return 0;
  return 1 + Math.floor((contextSize - base) / step);
}

/** 只在「升到更高且至少 1 級」時才提醒 —— 同級或降級不重複打擾。 */
export function shouldRemind(level, lastNotifiedLevel) {
  return level > lastNotifiedLevel && level >= 1;
}

/**
 * 組一句繁中提醒：含 ~Nk 近似值（四捨五入）與「估算」字樣（Metric-Honesty：明示為估值非精確）。
 * level 為提醒級數，屬對外簽名契約（呼叫端據級距決定是否提醒）。
 */
export function formatCompactHint(contextSize, level) {
  void level;
  const approxK = Math.round(contextSize / 1000);
  return `[loops-workflow] 估計 context 已約 ~${approxK}k tokens（依 API usage 估算、非精確）。可考慮 /compact 省 token。`;
}

/** state 超過 TTL（嚴格大於）→ 重置為新鮮初值；否則原樣保留。 */
export function pruneStale(state, now, ttlMs = DEFAULT_TTL_MS) {
  if (now - state.ts > ttlMs) return { lastNotifiedLevel: 0, ts: now };
  return state;
}

function safeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// ── IO 薄邊界：main()（被 import 時不執行）────────────────────────────────────────

function readStdin() {
  return readFileSync(0, 'utf8'); // fd 0 = stdin（hook payload 由父行程以 pipe 餵入）
}

/** session_id 轉成安全檔名片段：非 [A-Za-z0-9_-] 一律換成 _（避免路徑穿越 / 非法檔名）。 */
function sanitizeSessionId(sessionId) {
  return String(sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '_');
}

function readState(stateFile) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    return { lastNotifiedLevel: safeNum(parsed?.lastNotifiedLevel), ts: safeNum(parsed?.ts) };
  } catch {
    return { lastNotifiedLevel: 0, ts: Date.now() }; // 無 state / 壞檔 → 新鮮初值
  }
}

/**
 * PreToolUse(Edit|Write) hook 入口：估算 context 大小 → 跨級距才印一句提醒並記住級數。
 * 安全 / 永不擋路：env 預設關、transcript 讀不到不崩、state 只落在 os.tmpdir()、任何例外 exit 0。
 */
function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return;
  }

  if (process.env.LOOPS_COMPACT_HINT !== '1') return; // 預設關閉

  let transcript;
  try {
    transcript = readFileSync(payload.transcript_path, 'utf8');
  } catch {
    return; // transcript 讀不到 → 不崩
  }

  const size = getRealContextSize(transcript);
  const level = computeReminderLevel(size);

  const stateFile = join(tmpdir(), `loops-compact-${sanitizeSessionId(payload.session_id)}.json`);
  const state = pruneStale(readState(stateFile), Date.now());

  if (!shouldRemind(level, state.lastNotifiedLevel)) return; // 同級 / 未達門檻 → 靜默

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: formatCompactHint(size, level),
      },
    }),
  );
  writeFileSync(stateFile, JSON.stringify({ lastNotifiedLevel: level, ts: Date.now() }));
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
