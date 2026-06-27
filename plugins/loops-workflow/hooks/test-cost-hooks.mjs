#!/usr/bin/env node
// test-cost-hooks.mjs —— cost-tracker.mjs + suggest-compact.mjs 的紅綠斷言
// （自帶極簡 harness，仿 scripts/test-quality-gate.mjs，不引測試框架）。
//
// 用法（cwd = plugins/loops-workflow）：node hooks/test-cost-hooks.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1（主線用此 exit code 判紅綠）。
//
// 預期 Red：hooks/cost-tracker.mjs 與 hooks/suggest-compact.mjs 尚未實作，
// 下面的 import 會 ERR_MODULE_NOT_FOUND，整個檔在載入期就丟例外 → node 非 0 退出。
// 這就是 TDD 的紅燈起點。實作補齊兩模組後，下方斷言才有機會逐條轉綠。

import { readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  RATE_TABLE,
  getRates,
  sumUsageFromTranscript,
  estimateCostUsd,
  buildCostRow,
} from './cost-tracker.mjs';

import {
  getRealContextSize,
  computeReminderLevel,
  shouldRemind,
  formatCompactHint,
  pruneStale,
} from './suggest-compact.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');
const SAMPLE = join(FIX, 'transcript-sample.jsonl');
const NOUSAGE = join(FIX, 'transcript-no-usage.jsonl');
const LARGE = join(FIX, 'transcript-large.jsonl');
const COST_SCRIPT = join(HERE, 'cost-tracker.mjs'); // 真跑的腳本（smoke）
const COMPACT_SCRIPT = join(HERE, 'suggest-compact.mjs');

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
const near = (a, b, eps = 1e-9) => typeof a === 'number' && Math.abs(a - b) < eps;
function callSafe(fn) {
  try {
    return { threw: false, val: fn() };
  } catch (e) {
    return { threw: true, err: e };
  }
}

// =============================================================================
// A) cost-tracker.mjs — 純函式
// =============================================================================

// ── A1 RATE_TABLE：per-1M USD 三模型費率（值是對外契約，逐欄釘死）─────────────
{
  assert(RATE_TABLE && typeof RATE_TABLE === 'object', 'RATE_TABLE：是物件 [A1]');
  const h = RATE_TABLE.haiku || {};
  assert(h.in === 0.8 && h.out === 4.0 && h.cacheWrite === 1.0 && h.cacheRead === 0.08,
    'RATE_TABLE.haiku = {in:0.80,out:4.0,cacheWrite:1.00,cacheRead:0.08} [A1]');
  const s = RATE_TABLE.sonnet || {};
  assert(s.in === 3 && s.out === 15 && s.cacheWrite === 3.75 && s.cacheRead === 0.3,
    'RATE_TABLE.sonnet = {in:3,out:15,cacheWrite:3.75,cacheRead:0.30} [A1]');
  const o = RATE_TABLE.opus || {};
  assert(o.in === 15 && o.out === 75 && o.cacheWrite === 18.75 && o.cacheRead === 1.5,
    'RATE_TABLE.opus = {in:15,out:75,cacheWrite:18.75,cacheRead:1.50} [A1]');
}

// ── A2 getRates：含 haiku→haiku、含 opus→opus、其他→sonnet（預設）──────────────
{
  assert(getRates('claude-3-5-haiku-20241022') === RATE_TABLE.haiku, 'getRates：含 "haiku" → haiku rates [A2]');
  assert(getRates('claude-opus-4-8') === RATE_TABLE.opus, 'getRates：含 "opus" → opus rates [A2]');
  assert(getRates('claude-sonnet-4-5') === RATE_TABLE.sonnet, 'getRates：含 "sonnet" → sonnet rates [A2]');
  assert(getRates('totally-unknown-model') === RATE_TABLE.sonnet, 'getRates：無法辨識 → sonnet（預設）[A2]');
  assert(getRates('unknown') === RATE_TABLE.sonnet, 'getRates："unknown" → sonnet（預設）[A2]');
}

// ── A3 sumUsageFromTranscript：逐行 try/catch、加總、camelCase 映射、tolerant ──
{
  // A3a：transcript-sample（夾雜非 assistant 行 + 一行壞 JSON）→ 兩個 assistant 加總
  const content = readFileSync(SAMPLE, 'utf8');
  const r = callSafe(() => sumUsageFromTranscript(content));
  assert(!r.threw, 'sumUsageFromTranscript：含壞 JSON 行不丟例外（逐行 tolerant）[A3a]');
  const u = r.val || {};
  // input 1000+2000、output 500+800、cache_creation 200+400、cache_read 300+50000
  assert(u.inputTokens === 3000, 'sumUsage：inputTokens 加總 = 3000（1000+2000）[A3a]');
  assert(u.outputTokens === 1300, 'sumUsage：outputTokens 加總 = 1300（500+800）[A3a]');
  assert(u.cacheWriteTokens === 600, 'sumUsage：cacheWriteTokens ← cache_creation_input_tokens 加總 = 600 [A3a]');
  assert(u.cacheReadTokens === 50300, 'sumUsage：cacheReadTokens ← cache_read_input_tokens 加總 = 50300 [A3a]');
  // 壞 JSON 行就排在兩個 assistant 之間：拿到完整 3000 證明壞行被跳過且後續仍處理
  assert(u.model === 'claude-opus-4-8', 'sumUsage：model 取最後一個 assistant 的 message.model [A3a]');
}
{
  // A3b：空輸入 → 全 0、model "unknown"
  const r = callSafe(() => sumUsageFromTranscript(''));
  assert(!r.threw, 'sumUsageFromTranscript("") 不丟例外 [A3b]');
  const u = r.val || {};
  assert(u.inputTokens === 0 && u.outputTokens === 0 && u.cacheWriteTokens === 0 && u.cacheReadTokens === 0,
    'sumUsage：空輸入 → 四個 token 欄皆 0 [A3b]');
  assert(u.model === 'unknown', 'sumUsage：空輸入 → model "unknown" [A3b]');
}
{
  // A3c：有行但無任何 assistant usage → 全 0、model "unknown"
  const u = sumUsageFromTranscript(readFileSync(NOUSAGE, 'utf8')) || {};
  assert(u.inputTokens === 0 && u.outputTokens === 0 && u.cacheWriteTokens === 0 && u.cacheReadTokens === 0,
    'sumUsage：無 assistant usage → 全 0 [A3c]');
  assert(u.model === 'unknown', 'sumUsage：無 assistant usage → model "unknown" [A3c]');
}
{
  // A3d：缺欄補 0（只有 input_tokens）+ model 取最後一個 assistant（兩個不同 model）
  const inline = [
    '{"type":"assistant","message":{"model":"claude-3-5-sonnet","usage":{"input_tokens":100}}}',
    '{"type":"user","message":{"role":"user","content":"x"}}',
    '{"type":"assistant","message":{"model":"claude-3-5-haiku","usage":{"input_tokens":50,"output_tokens":7}}}',
  ].join('\n');
  const u = sumUsageFromTranscript(inline) || {};
  assert(u.inputTokens === 150, 'sumUsage：input 加總 = 150（缺欄不影響有值欄）[A3d]');
  assert(u.outputTokens === 7, 'sumUsage：缺 output 的行補 0（總 = 7）[A3d]');
  assert(u.cacheWriteTokens === 0 && u.cacheReadTokens === 0, 'sumUsage：缺 cache 欄補 0、不丟例外 [A3d]');
  assert(u.model === 'claude-3-5-haiku', 'sumUsage：model 取「最後一個」有 usage 的 assistant [A3d]');
}

// ── A4 estimateCostUsd：依 getRates(model) 算 USD，(in*..+out*..+cw*..+cr*..)/1e6 ─
{
  // A4a：opus 費率 + sample 加總 = 0.2292（3000*15+1300*75+600*18.75+50300*1.5）/1e6
  const usage = { inputTokens: 3000, outputTokens: 1300, cacheWriteTokens: 600, cacheReadTokens: 50300 };
  const cost = estimateCostUsd(usage, 'claude-opus-4-8');
  assert(typeof cost === 'number', 'estimateCostUsd：回 number [A4a]');
  assert(near(cost, 0.2292), 'estimateCostUsd：opus 費率算出 0.2292 [A4a]');
}
{
  // A4b：sonnet（預設）—— 1M input → 恰 3.0 USD
  const cost = estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }, 'unknown');
  assert(near(cost, 3.0), 'estimateCostUsd：未知 model 走 sonnet，1M input = 3.0 USD [A4b]');
}
{
  // A4c：haiku —— 1M in + 1M out = 0.8 + 4.0 = 4.8 USD
  const cost = estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0 }, 'claude-haiku');
  assert(near(cost, 4.8), 'estimateCostUsd：haiku 1M in + 1M out = 4.8 USD [A4c]');
}
{
  // A4d：管線一致性（sumUsage → estimateCostUsd 用 sumUsage 回的 model）
  const u = sumUsageFromTranscript(readFileSync(SAMPLE, 'utf8'));
  const cost = estimateCostUsd(u, u.model);
  assert(near(cost, 0.2292), 'estimateCostUsd：吃 sumUsage(sample) + 其 model → 0.2292（端到端一致）[A4d]');
}

// ── A5 buildCostRow：camelCase usage → snake_case row、estimate/schema 常數 ─────
{
  const usage = { inputTokens: 3000, outputTokens: 1300, cacheWriteTokens: 600, cacheReadTokens: 50300, model: 'claude-opus-4-8' };
  const row = buildCostRow({ sessionId: 'sess-42', usage, model: 'claude-opus-4-8', costUsd: 0.2292, ts: '2026-06-27T00:00:00Z' });
  assert(row && row.ts === '2026-06-27T00:00:00Z', 'buildCostRow：ts 原樣帶出 [A5]');
  assert(row && row.session_id === 'sess-42', 'buildCostRow：sessionId → session_id [A5]');
  assert(row && row.model === 'claude-opus-4-8', 'buildCostRow：model 帶出 [A5]');
  assert(row && row.input_tokens === 3000, 'buildCostRow：inputTokens → input_tokens [A5]');
  assert(row && row.output_tokens === 1300, 'buildCostRow：outputTokens → output_tokens [A5]');
  assert(row && row.cache_creation_input_tokens === 600, 'buildCostRow：cacheWriteTokens → cache_creation_input_tokens [A5]');
  assert(row && row.cache_read_input_tokens === 50300, 'buildCostRow：cacheReadTokens → cache_read_input_tokens [A5]');
  assert(row && row.cost_usd === 0.2292, 'buildCostRow：costUsd → cost_usd [A5]');
  assert(row && row.estimate === true, 'buildCostRow：estimate === true（常數）[A5]');
  assert(row && row.schema === 1, 'buildCostRow：schema === 1（常數）[A5]');
  const nums = row ? [row.input_tokens, row.output_tokens, row.cache_creation_input_tokens, row.cache_read_input_tokens, row.cost_usd] : [];
  assert(nums.length === 5 && nums.every((n) => typeof n === 'number' && n >= 0), 'buildCostRow：所有數字欄皆 number 且 ≥ 0 [A5]');
}

// =============================================================================
// B) suggest-compact.mjs — 純函式
// =============================================================================

// ── B1 getRealContextSize：最後一個 assistant 的 input+cache_read+cache_creation ─
{
  // B1a：sample → 52400（2000+50000+400），且取「最後一個 assistant」非「最後一行」
  const r = callSafe(() => getRealContextSize(readFileSync(SAMPLE, 'utf8')));
  assert(!r.threw, 'getRealContextSize：含壞 JSON 行不丟例外（tolerant）[B1a]');
  assert(r.val === 52400, 'getRealContextSize：取最後一個 assistant usage（input+cacheRead+cacheCreation = 52400），尾端 user 行不干擾 [B1a]');
}
{
  // B1b：large → 310000（跨 compact 門檻）
  assert(getRealContextSize(readFileSync(LARGE, 'utf8')) === 310000, 'getRealContextSize：large fixture = 310000 [B1b]');
}
{
  // B1c：無 assistant usage → 0；空字串 → 0
  assert(getRealContextSize(readFileSync(NOUSAGE, 'utf8')) === 0, 'getRealContextSize：無 assistant usage → 0 [B1c]');
  assert(getRealContextSize('') === 0, 'getRealContextSize：空字串 → 0 [B1c]');
}

// ── B2 computeReminderLevel：base 250000 / step 60000，邊界上下界逐點釘 ─────────
{
  assert(computeReminderLevel(249999) === 0, 'computeReminderLevel：base-1（249999）→ 0 [B2]');
  assert(computeReminderLevel(250000) === 1, 'computeReminderLevel：= base（250000）→ 1 [B2]');
  assert(computeReminderLevel(309999) === 1, 'computeReminderLevel：base..base+step-1 → 1 [B2]');
  assert(computeReminderLevel(310000) === 2, 'computeReminderLevel：base+step（310000）→ 2 [B2]');
  assert(computeReminderLevel(370000) === 3, 'computeReminderLevel：base+2*step（370000）→ 3 [B2]');
  assert(computeReminderLevel(1000, { base: 500, step: 100 }) === 6, 'computeReminderLevel：opts 覆寫 base/step（500+5*100 → 6）[B2]');
}

// ── B3 shouldRemind：level>lastNotifiedLevel && level>=1 ──────────────────────
{
  assert(shouldRemind(2, 0) === true, 'shouldRemind：2 > 0 且 ≥1 → true [B3]');
  assert(shouldRemind(3, 2) === true, 'shouldRemind：升級（3>2）→ true [B3]');
  assert(shouldRemind(2, 2) === false, 'shouldRemind：同級（2>2 false）→ false（不重複提醒）[B3]');
  assert(shouldRemind(1, 2) === false, 'shouldRemind：降級（1>2 false）→ false [B3]');
  assert(shouldRemind(0, 0) === false, 'shouldRemind：level 0（<1）→ false [B3]');
}

// ── B4 formatCompactHint：含 ~Nk 近似值（四捨五入）+「估算」(Metric-Honesty)─────
{
  const h = formatCompactHint(310000, 2);
  assert(typeof h === 'string', 'formatCompactHint：回字串 [B4]');
  assert(typeof h === 'string' && h.includes('~310k'), 'formatCompactHint：含近似值 "~310k" [B4]');
  assert(typeof h === 'string' && h.includes('估算'), 'formatCompactHint：含「估算」二字 [B4]');
  // 四捨五入（非截斷）：252600 → 252.6 → 253
  const h2 = formatCompactHint(252600, 1);
  assert(typeof h2 === 'string' && h2.includes('~253k'), 'formatCompactHint：252600 → "~253k"（四捨五入非截斷）[B4]');
}

// ── B5 pruneStale：超過 TTL 重置、未過原樣；ttlMs 預設 14 天；邊界嚴格 > ──────────
{
  const DAY = 86400000;
  const now = 1_000_000_000_000;
  const stale = pruneStale({ lastNotifiedLevel: 3, ts: now - 15 * DAY }, now); // 預設 14 天 TTL
  assert(stale && stale.lastNotifiedLevel === 0 && stale.ts === now, 'pruneStale：超過預設 14 天 → 重置 {lastNotifiedLevel:0, ts:now} [B5]');
  const fresh = pruneStale({ lastNotifiedLevel: 3, ts: now - 1 * DAY }, now);
  assert(fresh && fresh.lastNotifiedLevel === 3, 'pruneStale：未過預設 TTL → lastNotifiedLevel 原樣保留 [B5]');
  // 顯式 ttl 邊界：嚴格大於才重置
  const over = pruneStale({ lastNotifiedLevel: 2, ts: now - 1001 }, now, 1000);
  assert(over && over.lastNotifiedLevel === 0, 'pruneStale：now-ts=1001 > ttl=1000 → 重置 [B5]');
  const eq = pruneStale({ lastNotifiedLevel: 2, ts: now - 1000 }, now, 1000);
  assert(eq && eq.lastNotifiedLevel === 2, 'pruneStale：now-ts=1000 == ttl（非嚴格大於）→ 不重置 [B5]');
}

// =============================================================================
// SMOKE：真 spawn 子行程 + 真讀檔（real-not-mock：驗 IO/exit/檔案最終狀態）
// =============================================================================
function makeCwd(withLoops) {
  const dir = mkdtempSync(join(tmpdir(), 'cost-hook-smoke-'));
  if (withLoops) mkdirSync(join(dir, '.loops'), { recursive: true });
  return dir;
}
function runHook(scriptAbs, payload, extraEnv = {}) {
  const env = { ...process.env };
  delete env.LOOPS_COST_TRACKER; // 確保「未設」情境真的未設（不被外層環境污染）
  delete env.LOOPS_COMPACT_HINT;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [scriptAbs], { input: JSON.stringify(payload), env, encoding: 'utf8' });
}

// ── S-cost①：未設 LOOPS_COST_TRACKER → 不產 costs.jsonl、exit 0 ───────────────
{
  const cwd = makeCwd(true);
  try {
    const res = runHook(COST_SCRIPT, { transcript_path: SAMPLE, session_id: 'smoke-1', cwd });
    const costFile = join(cwd, '.loops', '.metrics', 'costs.jsonl');
    assert(res.error == null, 'S-cost①：node 啟動成功（spawn 無 error）[S-cost①]');
    assert(res.status === 0, 'S-cost①：未設旗標 → exit 0 [S-cost①]');
    assert(!existsSync(costFile), 'S-cost①：未設 LOOPS_COST_TRACKER → 不產生 .loops/.metrics/costs.jsonl [S-cost①]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── S-cost②：=1 + 有 .loops/ + payload.cwd → 產檔，最後一行可 parse 且欄位正確 ──
{
  const cwd = makeCwd(true);
  try {
    const res = runHook(COST_SCRIPT, { transcript_path: SAMPLE, session_id: 'smoke-1', cwd }, { LOOPS_COST_TRACKER: '1' });
    const costFile = join(cwd, '.loops', '.metrics', 'costs.jsonl');
    assert(res.status === 0, 'S-cost②：exit 0 [S-cost②]');
    assert(existsSync(costFile), 'S-cost②：=1 且有 .loops/（用 payload.cwd 定位）→ 產生 costs.jsonl [S-cost②]');
    let row = null;
    if (existsSync(costFile)) {
      const lines = readFileSync(costFile, 'utf8').trim().split('\n').filter(Boolean);
      try { row = JSON.parse(lines[lines.length - 1]); } catch { row = null; }
    }
    assert(row && typeof row === 'object', 'S-cost②：最後一行 JSON.parse 成功 [S-cost②]');
    assert(row && row.input_tokens > 0, 'S-cost②：input_tokens > 0（sample 加總 3000）[S-cost②]');
    assert(row && row.estimate === true, 'S-cost②：estimate === true [S-cost②]');
    assert(row && row.schema === 1, 'S-cost②：schema === 1 [S-cost②]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── S-cost③：=1 但 cwd 無 .loops/ → 不產檔、exit 0 ───────────────────────────
{
  const cwd = makeCwd(false);
  try {
    const res = runHook(COST_SCRIPT, { transcript_path: SAMPLE, session_id: 'smoke-1', cwd }, { LOOPS_COST_TRACKER: '1' });
    const costFile = join(cwd, '.loops', '.metrics', 'costs.jsonl');
    assert(res.status === 0, 'S-cost③：無 .loops/ → exit 0 [S-cost③]');
    assert(!existsSync(costFile), 'S-cost③：=1 但無 .loops/ → 不產檔（不自建 .loops/）[S-cost③]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── S-cost④：transcript 指向不存在檔 → exit 0、不崩 ──────────────────────────
{
  const cwd = makeCwd(true);
  try {
    const missing = join(cwd, 'does-not-exist.jsonl');
    const res = runHook(COST_SCRIPT, { transcript_path: missing, session_id: 'smoke-1', cwd }, { LOOPS_COST_TRACKER: '1' });
    assert(res.error == null, 'S-cost④：node 啟動成功（未崩在 spawn 層）[S-cost④]');
    assert(res.status === 0, 'S-cost④：transcript 不存在 → exit 0、不崩 [S-cost④]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// suggest-compact 把每 session 的 lastNotifiedLevel 持久化於 os.tmpdir()，跨「執行」會殘留。
// 持久化是正確功能、不可動；測試這邊要對它冪等（self-healing）：每個 compact smoke 用「執行內唯一」
// 的 session_id（pid+時間+序號），跑前/跑後再 best-effort 刪狀態檔。如此連續兩次跑都從 clean state
// 起跑（不靠刪檔即成立），刪檔只是 tmp 清潔，避免殘留垃圾。
function compactStateFile(sessionId) {
  return join(tmpdir(), 'loops-compact-' + String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_') + '.json');
}
let compactSeq = 0;
function freshCompactSession(prefix) {
  return `${prefix}-${process.pid}-${Date.now()}-${++compactSeq}`;
}

// ── S-compact①：未設 LOOPS_COMPACT_HINT → stdout 無 additionalContext、exit 0 ──
{
  const cwd = makeCwd(true);
  const sessionId = freshCompactSession('sc-1');
  const stateFile = compactStateFile(sessionId);
  rmSync(stateFile, { force: true });
  try {
    const res = runHook(COMPACT_SCRIPT, { transcript_path: LARGE, session_id: sessionId, cwd });
    assert(res.status === 0, 'S-compact①：未設旗標 → exit 0 [S-compact①]');
    assert(typeof res.stdout === 'string' && !res.stdout.includes('additionalContext'),
      'S-compact①：未設 LOOPS_COMPACT_HINT → stdout 無 additionalContext（即便 context 大）[S-compact①]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateFile, { force: true });
  }
}

// ── S-compact②：=1 + sample（context 52400 < 門檻）→ 無 additionalContext ──────
{
  const cwd = makeCwd(true);
  const sessionId = freshCompactSession('sc-2');
  const stateFile = compactStateFile(sessionId);
  rmSync(stateFile, { force: true });
  try {
    const res = runHook(COMPACT_SCRIPT, { transcript_path: SAMPLE, session_id: sessionId, cwd }, { LOOPS_COMPACT_HINT: '1' });
    assert(res.status === 0, 'S-compact②：exit 0 [S-compact②]');
    assert(typeof res.stdout === 'string' && !res.stdout.includes('additionalContext'),
      'S-compact②：=1 但 context(52400) < base → 無 additionalContext [S-compact②]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateFile, { force: true });
  }
}

// ── S-compact③：=1 + large（≥310k）→ additionalContext 含「估算」、exit 0 ───────
{
  const cwd = makeCwd(true);
  const sessionId = freshCompactSession('sc-3');
  const stateFile = compactStateFile(sessionId);
  rmSync(stateFile, { force: true }); // clean state 起跑，否則殘留 state 會讓「應 emit」假紅
  try {
    const res = runHook(COMPACT_SCRIPT, { transcript_path: LARGE, session_id: sessionId, cwd }, { LOOPS_COMPACT_HINT: '1' });
    assert(res.status === 0, 'S-compact③：exit 0 [S-compact③]');
    let out = null;
    try { out = JSON.parse(res.stdout); } catch { out = null; }
    const ctx = out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext;
    assert(typeof ctx === 'string' && ctx.length > 0, 'S-compact③：≥310k → stdout JSON 有 hookSpecificOutput.additionalContext [S-compact③]');
    assert(typeof ctx === 'string' && ctx.includes('估算'), 'S-compact③：additionalContext 含「估算」(Metric-Honesty)[S-compact③]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateFile, { force: true });
  }
}

// ── S-compact④：同 session 同級距緊接再跑 → 第二次無 additionalContext（state 記住）─
{
  const cwd = makeCwd(true);
  const sessionId = freshCompactSession('sc-4');
  const stateFile = compactStateFile(sessionId);
  rmSync(stateFile, { force: true }); // 「首次」之前清一次；兩次 sub-run 之間刻意不清（要驗 state 記憶）
  try {
    const payload = { transcript_path: LARGE, session_id: sessionId, cwd };
    const first = runHook(COMPACT_SCRIPT, payload, { LOOPS_COMPACT_HINT: '1' });
    const second = runHook(COMPACT_SCRIPT, payload, { LOOPS_COMPACT_HINT: '1' });
    let firstOut = null;
    try { firstOut = JSON.parse(first.stdout); } catch { firstOut = null; }
    const firstCtx = firstOut && firstOut.hookSpecificOutput && firstOut.hookSpecificOutput.additionalContext;
    assert(typeof firstCtx === 'string' && firstCtx.length > 0, 'S-compact④：首次（同 session）→ 有 additionalContext [S-compact④]');
    assert(second.status === 0, 'S-compact④：第二次 exit 0 [S-compact④]');
    assert(typeof second.stdout === 'string' && !second.stdout.includes('additionalContext'),
      'S-compact④：同 session 同級距再跑 → 第二次無 additionalContext（state 已記住 lastNotifiedLevel）[S-compact④]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateFile, { force: true });
  }
}

// ── 摘要 + exit code ─────────────────────────────────────────────────────────
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
