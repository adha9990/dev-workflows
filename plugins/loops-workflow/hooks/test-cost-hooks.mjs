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

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  RATE_TABLE,
  getRates,
  sumUsageFromTranscript,
  sumUsageByStage,
  estimateCostUsd,
  buildCostRow,
  resolveLoopsRoot,
  resolveSubagentsDir,
  extractFirstUserText,
  classifySubagentStage,
} from './cost-tracker.mjs';

import {
  getRealContextSize,
  computeReminderLevel,
  shouldRemind,
  formatCompactHint,
  pruneStale,
  sanitizeSessionId,
} from './suggest-compact.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');
const SAMPLE = join(FIX, 'transcript-sample.jsonl');
const NOUSAGE = join(FIX, 'transcript-no-usage.jsonl');
const LARGE = join(FIX, 'transcript-large.jsonl');
const TYPEFILTER = join(FIX, 'transcript-type-filter.jsonl');
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
  assert(getRates('CLAUDE-OPUS-4-8') === RATE_TABLE.opus, 'getRates：全大寫 "CLAUDE-OPUS-4-8" → opus（守 toLowerCase，移除即降級為 sonnet→紅）[A2]');
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
{
  // A3e（type 過濾）：fixture 含一行帶 usage 的「user」+ 一行 assistant；只算 assistant。
  // 若移除 entry.type==='assistant' 過濾 → user 行的 usage 被混入加總 → 數值轉紅。
  const r = callSafe(() => sumUsageFromTranscript(readFileSync(TYPEFILTER, 'utf8')));
  assert(!r.threw, 'sumUsageFromTranscript：type-filter fixture 不丟例外 [A3e]');
  const u = r.val || {};
  assert(u.inputTokens === 100, 'sumUsage：只計 assistant 行 → inputTokens === 100（user 行的 7000 被 type 過濾排除）[A3e]');
  assert(u.outputTokens === 50, 'sumUsage：只計 assistant 行 → outputTokens === 50（排除 user 行的 3000）[A3e]');
  assert(u.cacheWriteTokens === 20, 'sumUsage：只計 assistant 行 → cacheWriteTokens === 20（排除 user 行的 1000）[A3e]');
  assert(u.cacheReadTokens === 30, 'sumUsage：只計 assistant 行 → cacheReadTokens === 30（排除 user 行的 9000）[A3e]');
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
  assert(row && row.schema === 2, 'buildCostRow：schema === 2（by_stage 版；常數）[A5]');
  assert(row && row.by_stage === undefined, 'buildCostRow：未給 byStage → 無 by_stage 欄（向後相容）[A5]');
  const nums = row ? [row.input_tokens, row.output_tokens, row.cache_creation_input_tokens, row.cache_read_input_tokens, row.cost_usd] : [];
  assert(nums.length === 5 && nums.every((n) => typeof n === 'number' && n >= 0), 'buildCostRow：所有數字欄皆 number 且 ≥ 0 [A5]');
}

// ── A6 sumUsageByStage：按 Skill(loops-workflow:<stage>) 邊界分段 + buildCostRow by_stage ──
{
  // A6a：(main)（首標記前）→ plan → build 三段；標記行的 usage 歸「新」stage。
  const inline = [
    '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":5}}}',
    '{"type":"assistant","message":{"model":"claude-opus-4-8","content":[{"type":"tool_use","name":"Skill","input":{"skill":"loops-workflow:plan"}}],"usage":{"input_tokens":100,"output_tokens":20}}}',
    '{"type":"user","message":{"role":"user","content":"x"}}',
    '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":30}}}',
    '{"type":"assistant","message":{"model":"claude-opus-4-8","content":[{"type":"tool_use","name":"Skill","input":{"skill":"loops-workflow:build"}}],"usage":{"input_tokens":1000,"output_tokens":200}}}',
    '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":300}}}',
  ].join('\n');
  const r = callSafe(() => sumUsageByStage(inline));
  assert(!r.threw, 'sumUsageByStage：不丟例外 [A6a]');
  const st = r.val || [];
  assert(Array.isArray(st) && st.length === 3, 'sumUsageByStage：三段依出現序（(main)/plan/build）[A6a]');
  assert(st[0] && st[0].stage === '(main)' && st[0].inputTokens === 10 && st[0].turns === 1,
    'sumUsageByStage：首標記前 → (main)（10 in / 1 turn）[A6a]');
  assert(st[1] && st[1].stage === 'plan' && st[1].inputTokens === 200 && st[1].outputTokens === 50 && st[1].turns === 2,
    'sumUsageByStage：plan 段（標記行歸新 stage → 200 in / 50 out / 2 turns）[A6a]');
  assert(st[2] && st[2].stage === 'build' && st[2].inputTokens === 2000 && st[2].turns === 2,
    'sumUsageByStage：build 段（2000 in / 2 turns）[A6a]');
}
{
  // A6b：空輸入 → 空陣列；無 stage 標記 → 全歸 (main)
  assert(!callSafe(() => sumUsageByStage('')).threw, 'sumUsageByStage("") 不丟例外 [A6b]');
  assert((sumUsageByStage('') || []).length === 0, 'sumUsageByStage：空輸入 → 空陣列 [A6b]');
  const s2 = sumUsageByStage('{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":5}}}') || [];
  assert(s2.length === 1 && s2[0].stage === '(main)' && s2[0].inputTokens === 5,
    'sumUsageByStage：無 stage 標記 → 全歸 (main) [A6b]');
}
{
  // A6c：buildCostRow(byStage) → row.by_stage 陣列、snake_case、各段自帶 cost_usd、schema 2
  const byStage = sumUsageByStage(
    '{"type":"assistant","message":{"model":"claude-opus-4-8","content":[{"name":"Skill","input":{"skill":"loops-workflow:build"}}],"usage":{"input_tokens":1000000}}}',
  );
  const row = buildCostRow({ sessionId: 's', usage: { inputTokens: 1000000 }, model: 'claude-opus-4-8', costUsd: 15, ts: 't', byStage });
  assert(Array.isArray(row.by_stage) && row.by_stage.length === 1, 'buildCostRow：byStage → row.by_stage 陣列 [A6c]');
  const seg = row.by_stage[0] || {};
  assert(seg.stage === 'build' && seg.input_tokens === 1000000, 'buildCostRow：by_stage 段 snake_case（stage/input_tokens）[A6c]');
  assert(near(seg.cost_usd, 15), 'buildCostRow：by_stage 段自帶 cost_usd（opus 1M in = $15）[A6c]');
  assert(row.schema === 2, 'buildCostRow：帶 by_stage → schema === 2 [A6c]');
}
{
  // A5-neg（safeNonNeg）：負值 / NaN 輸入 → 對應數字欄一律落為 0（不可漏出髒值污染下游統計）。
  // 若把 safeNonNeg 退化成 safeNum（容許負值）或移除守衛 → 下列欄位會帶出 -5 / NaN → 轉紅。
  const usage = { inputTokens: -5, outputTokens: NaN, cacheWriteTokens: -100, cacheReadTokens: NaN, model: 'claude-opus-4-8' };
  const row = buildCostRow({ sessionId: 'sess-neg', usage, model: 'claude-opus-4-8', costUsd: -1, ts: '2026-06-27T00:00:00Z' });
  assert(row && row.input_tokens === 0, 'buildCostRow：負值 inputTokens(-5) → input_tokens === 0（safeNonNeg）[A5-neg]');
  assert(row && row.output_tokens === 0, 'buildCostRow：NaN outputTokens → output_tokens === 0（safeNonNeg）[A5-neg]');
  assert(row && row.cache_creation_input_tokens === 0, 'buildCostRow：負值 cacheWriteTokens(-100) → cache_creation_input_tokens === 0 [A5-neg]');
  assert(row && row.cache_read_input_tokens === 0, 'buildCostRow：NaN cacheReadTokens → cache_read_input_tokens === 0 [A5-neg]');
  assert(row && row.cost_usd === 0, 'buildCostRow：負值 costUsd(-1) → cost_usd === 0 [A5-neg]');
}

// =============================================================================
// C) cost-tracker.mjs — 子代理歸戶 + 主 repo 錨定（永久修：P1 掃子代理 / P2 落點錨定）
// =============================================================================

// ── C1 resolveLoopsRoot：worktree cwd → 主 repo 根；主 repo cwd → 原樣（兩種分隔符）──
{
  assert(resolveLoopsRoot('/home/u/repo/.claude/worktrees/137-x') === '/home/u/repo',
    'resolveLoopsRoot：POSIX worktree cwd → 主 repo 根（去 /.claude/worktrees/<slug>）[C1]');
  assert(resolveLoopsRoot('C:\\Users\\e\\repo\\.claude\\worktrees\\137-x') === 'C:\\Users\\e\\repo',
    'resolveLoopsRoot：Windows worktree cwd（反斜線）→ 主 repo 根 [C1]');
  assert(resolveLoopsRoot('/home/u/repo') === '/home/u/repo',
    'resolveLoopsRoot：非 worktree cwd → 原樣回傳 [C1]');
  assert(resolveLoopsRoot('C:\\Users\\e\\repo') === 'C:\\Users\\e\\repo',
    'resolveLoopsRoot：Windows 非 worktree → 原樣 [C1]');
  assert(resolveLoopsRoot('') === '' && resolveLoopsRoot(null) === '',
    'resolveLoopsRoot：空 / null → 空字串（不丟例外）[C1]');
}

// ── C2 resolveSubagentsDir：<dir>/<session>.jsonl → <dir>/<session>/subagents ─────
{
  assert(resolveSubagentsDir('/p/hash/sess-abc.jsonl') === join('/p/hash', 'sess-abc', 'subagents'),
    'resolveSubagentsDir：主 transcript 路徑 → <同層>/<session>/subagents [C2]');
  assert(resolveSubagentsDir('') === '' && resolveSubagentsDir(null) === '',
    'resolveSubagentsDir：空 / null → 空字串 [C2]');
}

// ── C3 extractFirstUserText：取第一個 type=user 的 message.content（array 併字串）─
{
  const c = [
    '{"type":"assistant","message":{"model":"m","usage":{"input_tokens":1}}}',
    '{"type":"user","message":{"role":"user","content":"You are the impl-author for one TDD task"}}',
    '{"type":"user","message":{"role":"user","content":"second user (should be ignored)"}}',
  ].join('\n');
  assert(extractFirstUserText(c).includes('impl-author'), 'extractFirstUserText：取第一個 user 訊息文字 [C3]');
  const arr = '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"You are a read-only DESIGN reviewer"}]}}';
  assert(extractFirstUserText(arr).includes('DESIGN reviewer'), 'extractFirstUserText：content 為 array → 併出文字 [C3]');
  assert(extractFirstUserText('') === '' && extractFirstUserText(null) === '', 'extractFirstUserText：空 → "" [C3]');
}

// ── C4 classifySubagentStage：角色關鍵字 → stage（build/plan/verify/explore/other）─
{
  assert(classifySubagentStage('You are the impl-author for one TDD task') === 'build', 'classify：impl-author → build [C4]');
  assert(classifySubagentStage('You are the test-author for one TDD task') === 'build', 'classify：test-author → build [C4]');
  assert(classifySubagentStage('You are a read-only DESIGN reviewer. Review the plan') === 'plan', 'classify：DESIGN reviewer → plan [C4]');
  assert(classifySubagentStage('You are the loops-workflow verify security-reviewer') === 'verify', 'classify：security-reviewer → verify [C4]');
  assert(classifySubagentStage('You are the product-contract reviewer') === 'verify', 'classify：一般 reviewer → verify [C4]');
  assert(classifySubagentStage('You second-pass validate each candidate finding (finding-validator)') === 'verify', 'classify：finding-validator → verify [C4]');
  assert(classifySubagentStage('You are exploring the React SPA to map all thumbnails') === 'explore', 'classify：exploring → explore [C4]');
  assert(classifySubagentStage('do something unrelated') === 'other-subagent', 'classify：無法辨識 → other-subagent [C4]');
  assert(classifySubagentStage('') === 'other-subagent', 'classify：空 → other-subagent [C4]');
}

// ── C5 buildCostRow(subagents)：給 subagents → schema 3 + subagents 聚合 + by_stage[].subagent ──
{
  // 主線 by_stage：(main) + verify（主線 verify 有 1 turn）；子代理：2 個 verify reviewer + 1 個 build impl-author
  const byStage = sumUsageByStage([
    '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":5}}}',
    '{"type":"assistant","message":{"model":"claude-opus-4-8","content":[{"name":"Skill","input":{"skill":"loops-workflow:verify"}}],"usage":{"input_tokens":100,"output_tokens":20}}}',
  ].join('\n'));
  const subagents = [
    { stage: 'verify', inputTokens: 0, outputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0, model: 'claude-sonnet-5' },
    { stage: 'verify', inputTokens: 0, outputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0, model: 'claude-sonnet-5' },
    { stage: 'build', inputTokens: 0, outputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0, model: 'claude-sonnet-5' },
  ];
  const row = buildCostRow({ sessionId: 's', usage: { inputTokens: 110, outputTokens: 25 }, model: 'claude-opus-4-8', costUsd: 1, ts: 't', byStage, subagents });
  assert(row.schema === 3, 'buildCostRow：給 subagents → schema === 3 [C5]');
  assert(row.subagents && row.subagents.count === 3, 'buildCostRow：row.subagents.count === 3（子代理檔數）[C5]');
  // 3 個 sonnet 各 1M output = 3M out * $15/1M = $45
  assert(near(row.subagents.cost_usd, 45), 'buildCostRow：row.subagents.cost_usd === $45（3×1M sonnet out）[C5]');
  assert(near(row.subagents.output_tokens, 3_000_000), 'buildCostRow：subagents.output_tokens 聚合 = 3M [C5]');
  assert(near(row.total_cost_usd, 46), 'buildCostRow：total_cost_usd = 主線 $1 + 子代理 $45 = $46 [C5]');
  // by_stage[verify] 應帶 .subagent（2×1M sonnet = $30）
  const v = (row.by_stage || []).find((s) => s.stage === 'verify');
  assert(v && v.subagent && near(v.subagent.cost_usd, 30), 'buildCostRow：by_stage[verify].subagent.cost_usd === $30（2 reviewer）[C5]');
  assert(v && v.subagent.agents === 2, 'buildCostRow：by_stage[verify].subagent.agents === 2 [C5]');
  // build 主線在此 session 無 marker（沒進過 build skill）→ 由子代理補一個 build 段
  const b = (row.by_stage || []).find((s) => s.stage === 'build');
  assert(b && b.subagent && near(b.subagent.cost_usd, 15), 'buildCostRow：主線無 build 段時，子代理 build 仍補出 by_stage[build].subagent（$15）[C5]');
  assert(b && b.input_tokens === 0 && b.output_tokens === 0, 'buildCostRow：補出的 build 段主線部分為 0（只有子代理）[C5]');
}
{
  // C5b：不給 subagents → 維持 schema 2、無 subagents/total_cost_usd 欄（向後相容）
  const row = buildCostRow({ sessionId: 's', usage: { inputTokens: 100 }, model: 'claude-opus-4-8', costUsd: 1, ts: 't' });
  assert(row.schema === 2, 'buildCostRow：不給 subagents → schema 維持 2（向後相容）[C5b]');
  assert(row.subagents === undefined && row.total_cost_usd === undefined, 'buildCostRow：不給 subagents → 無 subagents / total_cost_usd 欄 [C5b]');
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
{
  // B1d（type 過濾）：尾端是一行「帶 usage 的 user」，其後才是 assistant。反向掃描必須跳過 user 行、
  // 命中 assistant 行 → 100+30+20 = 150。若移除 type==='assistant' 過濾 → 反向先命中尾端 user 行
  // → 回 7000+9000+1000 = 17000 → 轉紅。釘住「取最後一筆 assistant、非最後一行 / 非 user」。
  const r = callSafe(() => getRealContextSize(readFileSync(TYPEFILTER, 'utf8')));
  assert(!r.threw, 'getRealContextSize：type-filter fixture 不丟例外 [B1d]');
  assert(r.val === 150, 'getRealContextSize：取最後一個 assistant（150），尾端帶 usage 的 user 行被 type 過濾排除 [B1d]');
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

// ── S-cost①：顯式 LOOPS_COST_TRACKER='0' → 不產 costs.jsonl、exit 0 ───────────
// （新語意：LOOPS_COST_TRACKER 已翻轉為 defaultOn，「未開→無動作」須用字面 '0' 顯式關閉才成立；
//   單純 delete/未設不再代表關閉，見下方 S-cost①b 的翻轉斷言。）
{
  const cwd = makeCwd(true);
  try {
    const res = runHook(COST_SCRIPT, { transcript_path: SAMPLE, session_id: 'smoke-1', cwd }, { LOOPS_COST_TRACKER: '0' });
    const costFile = join(cwd, '.loops', '.metrics', 'costs.jsonl');
    assert(res.error == null, 'S-cost①：node 啟動成功（spawn 無 error）[S-cost①]');
    assert(res.status === 0, 'S-cost①：顯式關閉旗標 → exit 0 [S-cost①]');
    assert(!existsSync(costFile), 'S-cost①：LOOPS_COST_TRACKER=\'0\'（顯式關）→ 不產生 .loops/.metrics/costs.jsonl [S-cost①]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── S-cost①b（defaultOn 翻轉）：未設 LOOPS_COST_TRACKER + 有 .loops/ → 仍產 costs.jsonl ─────
// 釘住 #87 翻轉契約：LOOPS_COST_TRACKER 現為 defaultOn，「未設」等同「開」，不再是「關」。
// runHook() 內部固定 delete env.LOOPS_COST_TRACKER，此處刻意不覆寫、驗證真正的「未設」語意。
{
  const cwd = makeCwd(true);
  try {
    const res = runHook(COST_SCRIPT, { transcript_path: SAMPLE, session_id: 'smoke-1b', cwd }); // 不帶 extraEnv → 旗標真正未設
    const costFile = join(cwd, '.loops', '.metrics', 'costs.jsonl');
    assert(res.status === 0, 'S-cost①b：未設旗標（defaultOn）→ exit 0 [S-cost①b]');
    assert(existsSync(costFile), 'S-cost①b：未設 LOOPS_COST_TRACKER 但有 .loops/ → 仍產生 costs.jsonl（defaultOn 翻轉）[S-cost①b]');
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
    assert(row && row.schema === 2, 'S-cost②：schema === 2（by_stage 版）[S-cost②]');
    assert(row && Array.isArray(row.by_stage), 'S-cost②：main 接線 byStage → row.by_stage 為陣列（sample 無 stage 標記 → (main) 一段）[S-cost②]');
    // row wiring：釘住 main() 的 payload→row 接線（session_id 不可漏帶、cost/model 不可斷線）。
    assert(row && row.session_id === 'smoke-1', 'S-cost②：row.session_id === payload.session_id("smoke-1")（main 接線）[S-cost②]');
    assert(row && row.cost_usd > 0, 'S-cost②：row.cost_usd > 0（sample 有用量 → 成本 > 0）[S-cost②]');
    assert(row && row.model === 'claude-opus-4-8', 'S-cost②：row.model === sample 最後一筆 assistant-with-usage 的 model("claude-opus-4-8")[S-cost②]');
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
    const costFile = join(cwd, '.loops', '.metrics', 'costs.jsonl');
    assert(res.error == null, 'S-cost④：node 啟動成功（未崩在 spawn 層）[S-cost④]');
    assert(res.status === 0, 'S-cost④：transcript 不存在 → exit 0、不崩 [S-cost④]');
    assert(!existsSync(costFile), 'S-cost④：transcript 不存在 → 在讀檔失敗即 return，不寫任何 row（不產 costs.jsonl）[S-cost④]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── S-cost⑤（V2 append 累積）：同一 cwd 連續 spawn 兩次 → costs.jsonl 累積到 2 行 ─────────
// 釘住 main() 用 appendFileSync（而非 writeFileSync）。若改成 writeFileSync，第二次會覆蓋第一行
// → 檔只剩 1 行 → 本條轉紅。每執行用全新 mkdtempSync 暫存 cwd、跑完 rmSync，跨執行冪等。
{
  const cwd = makeCwd(true);
  try {
    const costFile = join(cwd, '.loops', '.metrics', 'costs.jsonl');
    const r1 = runHook(COST_SCRIPT, { transcript_path: SAMPLE, session_id: 'append-1', cwd }, { LOOPS_COST_TRACKER: '1' });
    const r2 = runHook(COST_SCRIPT, { transcript_path: SAMPLE, session_id: 'append-2', cwd }, { LOOPS_COST_TRACKER: '1' });
    assert(r1.status === 0 && r2.status === 0, 'S-cost⑤：同一 cwd 連跑兩次皆 exit 0 [S-cost⑤]');
    assert(existsSync(costFile), 'S-cost⑤：連跑兩次 → costs.jsonl 存在 [S-cost⑤]');
    const lines = existsSync(costFile)
      ? readFileSync(costFile, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    assert(lines.length === 2, 'S-cost⑤：append 累積 → 檔有 2 行（appendFileSync 換 writeFileSync 只會剩 1 行 → 紅）[S-cost⑤]');
    let allParse = lines.length === 2;
    for (const ln of lines) {
      try { JSON.parse(ln); } catch { allParse = false; }
    }
    assert(allParse, 'S-cost⑤：兩行皆為合法 JSON（逐行可 JSON.parse）[S-cost⑤]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── S-cost⑥（P1+P2 整合）：worktree cwd → costs.jsonl 落主 repo .loops + 掃到子代理（schema 3）──
// 釘住兩個永久修：P2 落點錨定（cwd 是 worktree 也寫回主 repo .loops）、P1 子代理歸戶（verify reviewer 被算進）。
{
  const mainRoot = mkdtempSync(join(tmpdir(), 'cost-mainrepo-'));
  const proj = mkdtempSync(join(tmpdir(), 'cost-proj-'));
  try {
    mkdirSync(join(mainRoot, '.loops'), { recursive: true });
    // 模擬 worktree cwd（主 repo 之下）
    const wtCwd = join(mainRoot, '.claude', 'worktrees', 'my-slug');
    mkdirSync(wtCwd, { recursive: true });
    // 主 transcript：(main) + Skill(verify) 段
    const transcript = join(proj, 'sess-x.jsonl');
    writeFileSync(transcript, [
      '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":5}}}',
      '{"type":"assistant","message":{"model":"claude-opus-4-8","content":[{"name":"Skill","input":{"skill":"loops-workflow:verify"}}],"usage":{"input_tokens":100,"output_tokens":20}}}',
    ].join('\n'));
    // 子代理：一個 verify reviewer（1M sonnet output → $15）
    const subDir = join(proj, 'sess-x', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'agent-r1.jsonl'), [
      '{"type":"user","message":{"role":"user","content":"You are the loops-workflow verify security-reviewer"}}',
      '{"type":"assistant","message":{"model":"claude-sonnet-5","usage":{"input_tokens":0,"output_tokens":1000000}}}',
    ].join('\n'));

    const res = runHook(COST_SCRIPT, { transcript_path: transcript, session_id: 'sess-x', cwd: wtCwd }, { LOOPS_COST_TRACKER: '1' });
    assert(res.status === 0, 'S-cost⑥：exit 0 [S-cost⑥]');
    // P2：檔應在「主 repo」.loops，而非 worktree cwd 底下
    const mainCostFile = join(mainRoot, '.loops', '.metrics', 'costs.jsonl');
    const wtCostFile = join(wtCwd, '.loops', '.metrics', 'costs.jsonl');
    assert(existsSync(mainCostFile), 'S-cost⑥[P2]：worktree cwd → costs.jsonl 錨定寫入「主 repo」.loops/.metrics [S-cost⑥]');
    assert(!existsSync(wtCostFile), 'S-cost⑥[P2]：不寫進 worktree cwd 底下的 .loops（避免漂移/被清）[S-cost⑥]');
    let row = null;
    if (existsSync(mainCostFile)) {
      const lines = readFileSync(mainCostFile, 'utf8').trim().split('\n').filter(Boolean);
      try { row = JSON.parse(lines[lines.length - 1]); } catch { row = null; }
    }
    // P1：掃到子代理 → schema 3 + subagents 聚合 + verify 段帶 subagent
    assert(row && row.schema === 3, 'S-cost⑥[P1]：有子代理 → schema === 3 [S-cost⑥]');
    assert(row && row.subagents && row.subagents.count === 1, 'S-cost⑥[P1]：subagents.count === 1 [S-cost⑥]');
    assert(row && near(row.subagents.cost_usd, 15), 'S-cost⑥[P1]：subagents.cost_usd === $15（1M sonnet out）[S-cost⑥]');
    const v = row && (row.by_stage || []).find((s) => s.stage === 'verify');
    assert(v && v.subagent && near(v.subagent.cost_usd, 15), 'S-cost⑥[P1]：by_stage[verify].subagent.cost_usd === $15（reviewer 歸到 verify）[S-cost⑥]');
    assert(row && near(row.total_cost_usd, row.cost_usd + 15), 'S-cost⑥：total_cost_usd = 主線 + 子代理 [S-cost⑥]');
  } finally {
    rmSync(mainRoot, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
}

// suggest-compact 把每 session 的 lastNotifiedLevel 持久化於 os.tmpdir()，跨「執行」會殘留。
// 持久化是正確功能、不可動；測試這邊要對它冪等（self-healing）：每個 compact smoke 用「執行內唯一」
// 的 session_id（pid+時間+序號），跑前/跑後再 best-effort 刪狀態檔。如此連續兩次跑都從 clean state
// 起跑（不靠刪檔即成立），刪檔只是 tmp 清潔，避免殘留垃圾。
function compactStateFile(sessionId) {
  // 用 impl 對外 export 的 sanitizeSessionId 當「安全檔名規則」單一真相源，避免測試重抄正則而漂移。
  return join(tmpdir(), 'loops-compact-' + sanitizeSessionId(sessionId) + '.json');
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
