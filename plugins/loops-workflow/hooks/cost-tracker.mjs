#!/usr/bin/env node
// cost-tracker.mjs —— loops-workflow Stop hook：把本 session transcript 的 token 用量
// 依公開費率估算成 USD，append 一行 JSON 進 <cwd>/.loops/.metrics/costs.jsonl。
// 每行含 session 累計 + **逐 loop-stage 拆解**（by_stage：goal/explore/plan/build/verify/iterate…，schema 2）。
// 估算值（estimate:true）、非帳單精確值；env LOOPS_COST_TRACKER=1 才啟用，預設靜默 no-op。
//
// 分層（仿 scripts/loops-quality-gate.mjs）：
//   1) 純函式（無 IO，測試直接 import）：getRates / sumUsageFromTranscript /
//      estimateCostUsd / buildCostRow。
//   2) IO 薄邊界：main()（讀 stdin / transcript、寫 costs.jsonl）——被 import 時不執行
//      （import.meta.url 守門）。任何錯誤一律吞掉 exit 0，永不擋路。
// 依賴：僅 node 內建（fs / path / url / process），零外部套件。

import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── 對外契約：per-1M-token USD 費率（值即契約，逐欄釘死）──────────────────────────
export const RATE_TABLE = {
  haiku: { in: 0.8, out: 4.0, cacheWrite: 1.0, cacheRead: 0.08 },
  sonnet: { in: 3.0, out: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
  opus: { in: 15.0, out: 75.0, cacheWrite: 18.75, cacheRead: 1.5 },
};

const RATES_PER_MILLION = 1_000_000;

// ── 純函式層（無 IO，測試直接 import）─────────────────────────────────────────────

/** model 名稱（任意大小寫）→ 對應費率；含 haiku→haiku、含 opus→opus、其餘預設 sonnet。 */
export function getRates(model) {
  const name = String(model).toLowerCase();
  if (name.includes('haiku')) return RATE_TABLE.haiku;
  if (name.includes('opus')) return RATE_TABLE.opus;
  return RATE_TABLE.sonnet;
}

/**
 * 逐行解析 transcript（JSONL）→ 加總所有 assistant 行的 token 用量。
 * 容錯：壞 JSON 行 continue（不丟例外）；只取 type==="assistant" 且 message.usage 的行。
 * model 取「最後一個」有 usage 的 assistant 的 message.model；無任何用量 → 全 0 + "unknown"。
 * 缺欄補 0、數字走安全轉換（NaN→0）。
 */
export function sumUsageFromTranscript(content) {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    model: 'unknown',
  };

  for (const line of String(content ?? '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 壞行容錯：跳過，後續行照常處理
    }
    if (entry?.type !== 'assistant' || !entry?.message?.usage) continue;

    const u = entry.message.usage;
    usage.inputTokens += safeNum(u.input_tokens);
    usage.outputTokens += safeNum(u.output_tokens);
    usage.cacheWriteTokens += safeNum(u.cache_creation_input_tokens);
    usage.cacheReadTokens += safeNum(u.cache_read_input_tokens);
    if (typeof entry.message.model === 'string') usage.model = entry.message.model;
  }

  return usage;
}

// stage 邊界＝一行含 Skill(loops-workflow:<stage>) 呼叫（transcript 為 compact JSON、無空白）。
export const STAGE_MARKER_RE = /"name":"Skill"[^}]*"skill":"loops-workflow:([a-z-]+)"/;

/**
 * 按 loops stage 邊界把 assistant usage 分段加總（goal/explore/plan/build/verify/iterate…）。
 * 段界＝出現 Skill(loops-workflow:<stage>) 呼叫的那一行；自該行起算，切到下一個 stage 標記。
 * 第一個標記前的回合歸 '(main)'（loop 外的主線工作）。缺欄補 0、壞行跳過、數字安全轉換。
 * 回「依首次出現序」的陣列：[{ stage, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, model, turns }]。
 *
 * 已知限制（誠實標註、非 bug）：transcript 只有「stage 開始」標記、沒有「stage 結束」標記，
 * 所以**最後一個 stage 標記之後**仍在主線做的雜項（loop 收尾後的工作）會續記在該最後 stage 名下，
 * 無法自動歸還給 '(main)'——逐 loop 分析時，把最後一個 stage 的尾段視為「含收尾雜項」。
 */
export function sumUsageByStage(content) {
  const order = [];
  const byStage = new Map();
  const bucket = (stage) => {
    let b = byStage.get(stage);
    if (!b) {
      b = { stage, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, model: 'unknown', turns: 0 };
      byStage.set(stage, b);
      order.push(stage);
    }
    return b;
  };

  let cur = '(main)';
  for (const line of String(content ?? '').split('\n')) {
    if (!line.trim()) continue;
    const marker = line.match(STAGE_MARKER_RE);
    if (marker) cur = marker[1]; // 切到新 stage（該行的 usage 起算即歸新 stage）
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 壞行容錯
    }
    if (entry?.type !== 'assistant' || !entry?.message?.usage) continue;
    const b = bucket(cur);
    const u = entry.message.usage;
    b.inputTokens += safeNum(u.input_tokens);
    b.outputTokens += safeNum(u.output_tokens);
    b.cacheWriteTokens += safeNum(u.cache_creation_input_tokens);
    b.cacheReadTokens += safeNum(u.cache_read_input_tokens);
    b.turns += 1;
    if (typeof entry.message.model === 'string') b.model = entry.message.model;
  }

  return order.map((stage) => byStage.get(stage));
}

/** 依 model 對應費率把 token 用量估算成 USD：Σ(tokens × rate) / 1M。 */
export function estimateCostUsd(usage, model) {
  const r = getRates(model);
  const u = usage ?? {};
  const total =
    safeNum(u.inputTokens) * r.in +
    safeNum(u.outputTokens) * r.out +
    safeNum(u.cacheWriteTokens) * r.cacheWrite +
    safeNum(u.cacheReadTokens) * r.cacheRead;
  return total / RATES_PER_MILLION;
}

/**
 * 組裝寫入 costs.jsonl 的一列（camelCase usage → snake_case 欄位、estimate/schema 常數）。
 * 所有數字欄一律 ≥ 0（負值 / NaN → 0），確保下游統計不被髒值污染。
 */
export function buildCostRow({ sessionId, usage, model, costUsd, ts, byStage }) {
  const u = usage ?? {};
  const row = {
    ts,
    session_id: sessionId,
    model,
    input_tokens: safeNonNeg(u.inputTokens),
    output_tokens: safeNonNeg(u.outputTokens),
    cache_creation_input_tokens: safeNonNeg(u.cacheWriteTokens),
    cache_read_input_tokens: safeNonNeg(u.cacheReadTokens),
    cost_usd: safeNonNeg(costUsd),
    estimate: true,
    schema: 2,
  };
  // by_stage（可選）：逐 loop-stage 拆解——camelCase bucket → snake_case 欄位 + 各段自帶 cost_usd。
  // 未給 byStage → 不加此欄（schema 2 的 row 向後相容 schema 1 的消費者，多一個可忽略的欄）。
  if (Array.isArray(byStage)) {
    row.by_stage = byStage.map((b) => ({
      stage: String(b?.stage ?? 'unknown'),
      turns: safeNonNeg(b?.turns),
      input_tokens: safeNonNeg(b?.inputTokens),
      output_tokens: safeNonNeg(b?.outputTokens),
      cache_creation_input_tokens: safeNonNeg(b?.cacheWriteTokens),
      cache_read_input_tokens: safeNonNeg(b?.cacheReadTokens),
      cost_usd: safeNonNeg(estimateCostUsd(b ?? {}, b?.model)),
    }));
  }
  return row;
}

function safeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function safeNonNeg(value) {
  const n = safeNum(value);
  return n > 0 ? n : 0;
}

// ── IO 薄邊界：main()（被 import 時不執行）────────────────────────────────────────

function readStdin() {
  return readFileSync(0, 'utf8'); // fd 0 = stdin（hook payload 由父行程以 pipe 餵入）
}

/**
 * Stop hook 入口：讀 payload → 估算 → append 一行進 <payload.cwd>/.loops/.metrics/costs.jsonl。
 * 安全 / 永不擋路：env 預設關、cwd 無 .loops/ 不自建、transcript 讀不到不崩、不輸出 context、
 * 任何例外一律 exit 0。只讀本 session transcript、只寫該 session 的 .loops/.metrics。
 */
function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return; // payload 壞掉 → 靜默 no-op
  }

  if (process.env.LOOPS_COST_TRACKER !== '1') return; // 預設關閉

  const cwd = payload?.cwd;
  if (typeof cwd !== 'string' || !existsSync(join(cwd, '.loops'))) return; // 不在 loops 工作區 → 不自建

  let transcript;
  try {
    transcript = readFileSync(payload.transcript_path, 'utf8');
  } catch {
    return; // transcript 不存在 / 讀不到 → 不崩
  }

  const usage = sumUsageFromTranscript(transcript);
  const costUsd = estimateCostUsd(usage, usage.model);
  const byStage = sumUsageByStage(transcript);
  const row = buildCostRow({
    sessionId: payload.session_id,
    usage,
    model: usage.model,
    costUsd,
    ts: Date.now(),
    byStage,
  });

  const metricsDir = join(cwd, '.loops', '.metrics');
  mkdirSync(metricsDir, { recursive: true });
  appendFileSync(join(metricsDir, 'costs.jsonl'), `${JSON.stringify(row)}\n`);
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
