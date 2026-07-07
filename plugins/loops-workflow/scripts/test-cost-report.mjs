#!/usr/bin/env node
// test-cost-report.mjs —— loops-cost-report.mjs 的紅綠斷言（自帶極簡 harness，不引測試框架，
// 仿 scripts/test-quality-gate.mjs / hooks/test-cost-hooks.mjs）。
// 用法：node test-cost-report.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1（主線用此 exit code 判紅綠）。
//
// 預期 Red：loops-cost-report.mjs 尚未實作時，下面的 import 會 ERR_MODULE_NOT_FOUND，
// 整個檔在載入期就丟例外 → node 非 0 退出。這就是 TDD 的紅燈起點。
//
// 輸入一律用「物件 / 字串常數」或 tmp 檔，不依賴真 costs.jsonl。

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { pickSessionRow, formatCostReport } from './loops-cost-report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'loops-cost-report.mjs'); // 端到端 smoke 真跑的腳本

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

// ── 共用 row fixtures（物件常數，不碰真檔）─────────────────────────────────────
const rowV2 = {
  ts: 1, session_id: 'sess-2', model: 'claude-opus-4-8',
  input_tokens: 3000, output_tokens: 1300,
  cache_creation_input_tokens: 600, cache_read_input_tokens: 50300,
  cost_usd: 0.2292, estimate: true, schema: 2,
  by_stage: [
    { stage: '(main)', turns: 1, input_tokens: 1000, output_tokens: 300, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, cost_usd: 0.05 },
    { stage: 'build', turns: 2, input_tokens: 2000, output_tokens: 1000, cache_creation_input_tokens: 400, cache_read_input_tokens: 50000, cost_usd: 0.18 },
  ],
};

const rowV3 = {
  ts: 2, session_id: 'sess-3', model: 'claude-opus-4-8',
  input_tokens: 110, output_tokens: 25,
  cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  cost_usd: 1, estimate: true, schema: 3,
  subagents: { count: 3, input_tokens: 0, output_tokens: 3_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost_usd: 45 },
  total_cost_usd: 46,
  by_stage: [
    { stage: '(main)', turns: 1, input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost_usd: 0.001 },
    { stage: 'verify', turns: 2, input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost_usd: 0.01,
      subagent: { agents: 2, input_tokens: 0, output_tokens: 2_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost_usd: 30 } },
    { stage: 'build', turns: 0, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost_usd: 0,
      subagent: { agents: 1, input_tokens: 0, output_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost_usd: 15 } },
  ],
};

// =============================================================================
// ① pickSessionRow：多 session 取對的最後一行、壞行容錯、無資料回 null
// =============================================================================
{
  // A1a：三行（a=cost1 / a=cost3 / b=cost2）；給 'a' → 最後一個 a（cost3），未給 → 整體最後一行（b）
  const content = [
    JSON.stringify({ session_id: 'a', cost_usd: 1 }),
    JSON.stringify({ session_id: 'a', cost_usd: 3 }),
    JSON.stringify({ session_id: 'b', cost_usd: 2 }),
  ].join('\n');
  const ra = callSafe(() => pickSessionRow(content, 'a'));
  assert(!ra.threw, 'pickSessionRow：多 session 不丟例外 [①a]');
  assert(ra.val && ra.val.session_id === 'a' && ra.val.cost_usd === 3,
    'pickSessionRow：給 sessionId → 取「符合的最後一行」（a 的 cost3，非 cost1）[①a]');
  const rlast = pickSessionRow(content);
  assert(rlast && rlast.session_id === 'b' && rlast.cost_usd === 2,
    'pickSessionRow：未給 sessionId → 整體最後一行（b）[①a]');
}
{
  // A1b：壞行容錯 —— 中間夾一行壞 JSON，前後有效行照常被解析、取到後方的最後一行
  const content = [
    JSON.stringify({ session_id: 's', cost_usd: 1 }),
    '{ this is not valid json',
    JSON.stringify({ session_id: 's', cost_usd: 9 }),
  ].join('\n');
  const r = callSafe(() => pickSessionRow(content, 's'));
  assert(!r.threw, 'pickSessionRow：含壞 JSON 行不丟例外（逐行 tolerant）[①b]');
  assert(r.val && r.val.cost_usd === 9, 'pickSessionRow：壞行被跳過、仍取到後方最後一行（cost9）[①b]');
}
{
  // A1c：無任何有效行 → null；空字串 → null；找不到指定 session → null
  assert(pickSessionRow('') === null, 'pickSessionRow：空字串 → null [①c]');
  assert(pickSessionRow('garbage\nmore {garbage') === null, 'pickSessionRow：全壞行 → null [①c]');
  const content = JSON.stringify({ session_id: 'x', cost_usd: 1 });
  assert(pickSessionRow(content, 'not-there') === null, 'pickSessionRow：sessionId 找不到 → null [①c]');
  assert(pickSessionRow(null) === null && pickSessionRow(undefined) === null, 'pickSessionRow：null/undefined 輸入 → null [①c]');
}

// =============================================================================
// ② formatCostReport schema 2（無 subagent）：含 by_stage 表、無子代理欄 / 無 total
// =============================================================================
{
  const r = callSafe(() => formatCostReport(rowV2, { slug: 'my-loop' }));
  assert(!r.threw, 'formatCostReport(schema2)：不丟例外 [②]');
  const md = typeof r.val === 'string' ? r.val : '';
  assert(md.length > 0, 'formatCostReport(schema2)：回非空字串 [②]');
  assert(md.includes('# 成本報告：my-loop'), 'formatCostReport：標題含 slug [②]');
  // 誠實標註（Metric-Honesty：估算 + 兩個方向相反偏差）
  assert(md.includes('估算') && md.includes('低估') && md.includes('高估'),
    'formatCostReport：含誠實標註（估算 / 低估 / 高估 兩方向偏差）[②]');
  // 總計（千分位）
  assert(md.includes('## 總計'), 'formatCostReport：有「總計」段 [②]');
  assert(md.includes('3,000'), 'formatCostReport：input 千分位 3,000 [②]');
  assert(md.includes('50,300'), 'formatCostReport：cache_read 千分位 50,300 [②]');
  assert(md.includes('$0.23'), 'formatCostReport：cost_usd 標 $x.xx（0.2292 → $0.23）[②]');
  // by_stage 表
  assert(md.includes('## 逐階段（by_stage）'), 'formatCostReport：有 by_stage 段 [②]');
  assert(md.includes('| stage | turns | in | out | cacheW | cacheR | cost_usd |'),
    'formatCostReport：by_stage 表頭（含 turns/cacheW/cacheR/cost_usd）[②]');
  assert(md.includes('| (main) |') && md.includes('| build |'),
    'formatCostReport：by_stage 逐 stage 列（照 file 內順序含 (main) 與 build）[②]');
  // schema 2 → 無子代理欄 / 無 total_cost_usd / 無子代理聚合
  assert(!md.includes('子代理 cost'), 'formatCostReport(schema2)：無「子代理 cost」欄 [②]');
  assert(!md.includes('total_cost_usd'), 'formatCostReport(schema2)：無 total_cost_usd [②]');
  assert(!md.includes('子代理聚合'), 'formatCostReport(schema2)：無子代理聚合段 [②]');
}

// =============================================================================
// ③ formatCostReport schema 3（有 subagents/total_cost_usd）：子代理欄 + total + 聚合
// =============================================================================
{
  const r = callSafe(() => formatCostReport(rowV3, { slug: 'v3-loop' }));
  assert(!r.threw, 'formatCostReport(schema3)：不丟例外 [③]');
  const md = typeof r.val === 'string' ? r.val : '';
  assert(md.includes('# 成本報告：v3-loop'), 'formatCostReport(schema3)：標題含 slug [③]');
  // total_cost_usd（主線 $1 + 子代理 $45 = $46）
  assert(md.includes('total_cost_usd') && md.includes('$46.00'),
    'formatCostReport(schema3)：標 total_cost_usd（主線+子代理 = $46.00）[③]');
  // 子代理聚合（count / tokens / cost）
  assert(md.includes('子代理聚合'), 'formatCostReport(schema3)：有子代理聚合段 [③]');
  assert(md.includes('count：3'), 'formatCostReport(schema3)：subagents count = 3 [③]');
  assert(md.includes('3,000,000'), 'formatCostReport(schema3)：subagents output 聚合千分位 3,000,000 [③]');
  assert(md.includes('$45.00'), 'formatCostReport(schema3)：subagents cost_usd = $45.00 [③]');
  // by_stage 子代理欄
  assert(md.includes('| stage | turns | in | out | cacheW | cacheR | cost_usd | 子代理 cost |'),
    'formatCostReport(schema3)：by_stage 表頭多「子代理 cost」欄 [③]');
  assert(md.includes('| verify |') && md.includes('$30.00'),
    'formatCostReport(schema3)：verify 段帶子代理 cost $30.00（2 reviewer）[③]');
  assert(md.includes('$15.00'), 'formatCostReport(schema3)：build 段子代理 cost $15.00 [③]');
}

// =============================================================================
// ④ fallback（row=null）：產出 no-data 版、不丟例外、指向 loop.md
// =============================================================================
{
  const r = callSafe(() => formatCostReport(null, { slug: 'no-data-loop' }));
  assert(!r.threw, 'formatCostReport(null)：不丟例外（一律要能產出東西）[④]');
  const md = typeof r.val === 'string' ? r.val : '';
  assert(md.length > 0, 'formatCostReport(null)：回非空字串 [④]');
  assert(md.includes('# 成本報告：no-data-loop'), 'formatCostReport(null)：標題仍含 slug [④]');
  assert(md.includes('cost-tracker') && md.includes('loop.md'),
    'formatCostReport(null)：no-data 版指向 cost-tracker 未開 / loop.md outcome 行 [④]');
  // undefined / 非物件也走 fallback、不崩
  assert(!callSafe(() => formatCostReport(undefined, { slug: 's' })).threw, 'formatCostReport(undefined)：不丟例外 [④]');
  assert(!callSafe(() => formatCostReport(42, {})).threw, 'formatCostReport(非物件)：不丟例外（無 slug 也可）[④]');
}

// =============================================================================
// SMOKE：真 spawn 子行程 + 真讀檔（驗 IO/exit/--out/fallback 端到端接線）
// =============================================================================
function runReport(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

// ── S①：有 costs.jsonl + --session + --out → 寫出報告檔、exit 0、內容正確 ────────
{
  const cwd = mkdtempSync(join(tmpdir(), 'cost-report-'));
  try {
    const metricsDir = join(cwd, '.loops', '.metrics');
    mkdirSync(metricsDir, { recursive: true });
    // 兩 session：a=schema2、b=schema3；驗 --session 取對的那筆
    const jsonl = [
      JSON.stringify({ ...rowV2, session_id: 'a' }),
      JSON.stringify({ ...rowV3, session_id: 'b' }),
    ].join('\n');
    writeFileSync(join(metricsDir, 'costs.jsonl'), jsonl, 'utf8');
    const out = join(cwd, 'cost.md');
    const res = runReport(['--cwd', cwd, '--session', 'a', '--out', out]);
    assert(res.error == null, 'S①：node 啟動成功（spawn 無 error）[S①]');
    assert(res.status === 0, 'S①：exit 0 [S①]');
    assert(existsSync(out), 'S①：--out → 寫出報告檔 [S①]');
    const md = existsSync(out) ? readFileSync(out, 'utf8') : '';
    assert(md.includes('成本報告') && md.includes('## 逐階段'), 'S①：報告檔含標題與 by_stage 段 [S①]');
    assert(md.includes('| build |'), 'S①：session a（schema2）的 build 段有 render [S①]');
    assert(!md.includes('total_cost_usd'), 'S①：取到的是 session a（schema2）→ 無 total_cost_usd（未誤取 b）[S①]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── S②：--session b（schema3）不帶 --out → stdout 印 schema3 報告、exit 0 ────────
{
  const cwd = mkdtempSync(join(tmpdir(), 'cost-report-'));
  try {
    const metricsDir = join(cwd, '.loops', '.metrics');
    mkdirSync(metricsDir, { recursive: true });
    writeFileSync(join(metricsDir, 'costs.jsonl'), [
      JSON.stringify({ ...rowV2, session_id: 'a' }),
      JSON.stringify({ ...rowV3, session_id: 'b' }),
    ].join('\n'), 'utf8');
    const res = runReport(['--cwd', cwd, '--session', 'b']);
    assert(res.status === 0, 'S②：exit 0 [S②]');
    assert(typeof res.stdout === 'string' && res.stdout.includes('total_cost_usd') && res.stdout.includes('$46.00'),
      'S②：無 --out → stdout 印 schema3 報告（含 total_cost_usd $46.00）[S②]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── S③：無 costs.jsonl（cwd 無 .loops）→ fallback no-data 版、exit 0、不崩 ────────
{
  const cwd = mkdtempSync(join(tmpdir(), 'cost-report-'));
  try {
    const res = runReport(['--cwd', cwd, '--slug', 'ghost']);
    assert(res.error == null, 'S③：node 啟動成功 [S③]');
    assert(res.status === 0, 'S③：無資料 → exit 0、不崩 [S③]');
    assert(typeof res.stdout === 'string' && res.stdout.includes('cost-tracker') && res.stdout.includes('# 成本報告：ghost'),
      'S③：無 costs.jsonl → 印 no-data fallback（含 slug）[S③]');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ── 摘要 + exit code ─────────────────────────────────────────────────────────
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
