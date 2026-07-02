#!/usr/bin/env node
// cost-tracker.mjs —— loops-workflow Stop hook：把本 session transcript 的 token 用量
// 依公開費率估算成 USD，append 一行 JSON 進 **主 repo** .loops/.metrics/costs.jsonl。
// 每行含 session 累計 + **逐 loop-stage 拆解**（by_stage）+ **子代理歸戶**（subagents 聚合 +
// by_stage[].subagent，schema 3；無子代理則 schema 2）。
// P2 落點錨定：cwd 落在 worktree 時仍寫回主 repo .loops（對齊 AGENTS 規則 9）。
// P1 子代理：額外掃 <transcript>/<session>/subagents/*.jsonl，依角色（reviewer→verify /
//   test·impl-author→build / design→plan / exploring→explore）歸到對應 stage——補上 verify /
//   iterate 等「幾乎全是 fan-out 子代理」的階段成本（主 transcript 本來看不到）。
// 估算值（estimate:true）、非帳單精確值；env LOOPS_COST_TRACKER=1 才啟用，預設靜默 no-op。
//
// 分層（仿 scripts/loops-quality-gate.mjs）：
//   1) 純函式（無 IO，測試直接 import）：getRates / sumUsageFromTranscript /
//      estimateCostUsd / buildCostRow。
//   2) IO 薄邊界：main()（讀 stdin / transcript、寫 costs.jsonl）——被 import 時不執行
//      （import.meta.url 守門）。任何錯誤一律吞掉 exit 0，永不擋路。
// 依賴：僅 node 內建（fs / path / url / process），零外部套件。

import { readFileSync, appendFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
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
 * P2 落點錨定：把 cwd 解析成「主 repo 根」——若 cwd 落在某個 worktree
 * （路徑含 `.claude/worktrees/<slug>/`），回傳該片段之前的主 checkout 根；否則原樣回傳。
 * 純字串推導、不 spawn git（與 AGENTS 規則 9 的 `git worktree list` 第一筆等價，因 worktree
 * 一律建在 `<主 repo>/.claude/worktrees/` 之下）。空 / 非字串 → ''。
 */
export function resolveLoopsRoot(cwd) {
  const s = typeof cwd === 'string' ? cwd : '';
  if (!s) return '';
  const m = s.match(/^(.*?)[/\\]\.claude[/\\]worktrees[/\\]/);
  return m ? m[1] : s;
}

/**
 * P1 子代理定位：主 transcript `.../<hash>/<session>.jsonl` →
 * 同層 `.../<hash>/<session>/subagents`（Claude Code 把每個子代理存成該目錄下 `agent-*.jsonl`）。
 * 空 / 非字串 → ''。
 */
export function resolveSubagentsDir(transcriptPath) {
  const s = typeof transcriptPath === 'string' ? transcriptPath : '';
  if (!s) return '';
  return join(dirname(s), basename(s).replace(/\.jsonl$/i, ''), 'subagents');
}

/** 取 transcript 第一個 type==='user' 的 message.content 文字（array 併字串）。空 → ''。用於判子代理角色。 */
export function extractFirstUserText(content) {
  for (const line of String(content ?? '').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type !== 'user' || !e?.message) continue;
    let c = e.message.content;
    if (Array.isArray(c)) c = c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join(' ');
    return String(c ?? '');
  }
  return '';
}

/**
 * 依子代理第一個 user 訊息（角色 prompt）判它屬哪個 loop-stage：
 * impl/test-author/referee→build、design reviewer→plan、finding-validator / 其他 reviewer→verify、
 * exploring→explore、無法辨識→other-subagent。順序有意：design reviewer 要先於一般 reviewer。
 */
export function classifySubagentStage(text) {
  const t = String(text ?? '').toLowerCase();
  if (!t) return 'other-subagent';
  if (t.includes('impl-author') || t.includes('test-author') || t.includes('referee')) return 'build';
  if (t.includes('design reviewer') || t.includes('design review')) return 'plan';
  if (t.includes('finding-validator') || t.includes('finding validator')) return 'verify';
  if (t.includes('reviewer') || t.includes('review the')) return 'verify';
  if (t.includes('exploring') || t.includes('map all')) return 'explore';
  return 'other-subagent';
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
export function buildCostRow({ sessionId, usage, model, costUsd, ts, byStage, subagents }) {
  const u = usage ?? {};
  const hasSub = Array.isArray(subagents) && subagents.length > 0;
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
    // schema 2 = 主線 by_stage；schema 3 = 額外含子代理歸戶（subagents 聚合 + by_stage[].subagent）。
    // 未給 subagents → 維持 schema 2，向後相容既有消費者（新欄皆可忽略）。
    schema: hasSub ? 3 : 2,
  };
  // by_stage（可選）：逐 loop-stage 拆解——camelCase bucket → snake_case 欄位 + 各段自帶 cost_usd。
  // 這裡的 token / cost 一律為「主線」部分（子代理另掛在 .subagent，見下）。
  let stageRows = null;
  if (Array.isArray(byStage)) {
    stageRows = byStage.map((b) => ({
      stage: String(b?.stage ?? 'unknown'),
      turns: safeNonNeg(b?.turns),
      input_tokens: safeNonNeg(b?.inputTokens),
      output_tokens: safeNonNeg(b?.outputTokens),
      cache_creation_input_tokens: safeNonNeg(b?.cacheWriteTokens),
      cache_read_input_tokens: safeNonNeg(b?.cacheReadTokens),
      cost_usd: safeNonNeg(estimateCostUsd(b ?? {}, b?.model)),
    }));
  }

  // P1 子代理歸戶：subagents = [{ stage, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, model }]。
  // 聚合成 row.subagents（總），併 row.total_cost_usd（主線+子代理），並把各 stage 的子代理掛到 by_stage[].subagent。
  if (hasSub) {
    const agg = { in: 0, out: 0, cw: 0, cr: 0, cost: 0 };
    const perStage = new Map(); // stage → { agents, in, out, cw, cr, cost }
    for (const s of subagents) {
      const su = {
        inputTokens: safeNum(s?.inputTokens),
        outputTokens: safeNum(s?.outputTokens),
        cacheWriteTokens: safeNum(s?.cacheWriteTokens),
        cacheReadTokens: safeNum(s?.cacheReadTokens),
      };
      const c = estimateCostUsd(su, s?.model);
      agg.in += su.inputTokens; agg.out += su.outputTokens; agg.cw += su.cacheWriteTokens; agg.cr += su.cacheReadTokens; agg.cost += c;
      const st = String(s?.stage ?? 'other-subagent');
      let e = perStage.get(st);
      if (!e) { e = { agents: 0, in: 0, out: 0, cw: 0, cr: 0, cost: 0 }; perStage.set(st, e); }
      e.agents += 1; e.in += su.inputTokens; e.out += su.outputTokens; e.cw += su.cacheWriteTokens; e.cr += su.cacheReadTokens; e.cost += c;
    }
    row.subagents = {
      count: subagents.length,
      input_tokens: safeNonNeg(agg.in),
      output_tokens: safeNonNeg(agg.out),
      cache_creation_input_tokens: safeNonNeg(agg.cw),
      cache_read_input_tokens: safeNonNeg(agg.cr),
      cost_usd: safeNonNeg(agg.cost),
    };
    row.total_cost_usd = safeNonNeg(row.cost_usd + agg.cost);

    const subObj = (e) => ({
      agents: safeNonNeg(e.agents),
      input_tokens: safeNonNeg(e.in),
      output_tokens: safeNonNeg(e.out),
      cache_creation_input_tokens: safeNonNeg(e.cw),
      cache_read_input_tokens: safeNonNeg(e.cr),
      cost_usd: safeNonNeg(e.cost),
    });
    stageRows = stageRows || [];
    for (const sr of stageRows) {
      const e = perStage.get(sr.stage);
      if (e) { sr.subagent = subObj(e); perStage.delete(sr.stage); }
    }
    // 主線沒出現過的 stage（例如 verify 主線 marker 缺、但派了 reviewer 子代理）→ 補一段（主線 0 + 子代理）。
    for (const [st, e] of perStage) {
      stageRows.push({
        stage: st, turns: 0, input_tokens: 0, output_tokens: 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost_usd: 0,
        subagent: subObj(e),
      });
    }
  }

  if (stageRows) row.by_stage = stageRows;
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
 * P1 IO：讀本 session 的子代理 transcript（`<transcript>/../<session>/subagents/agent-*.jsonl`），
 * 每檔加總 usage + 依角色判 stage。回 [{stage, ...usage, model}] 或 undefined（無子代理 / 讀不到）。
 * 全程容錯：目錄不存在、壞檔一律略過，不丟例外。
 */
function readSubagents(transcriptPath) {
  const dir = resolveSubagentsDir(transcriptPath);
  if (!dir || !existsSync(dir)) return undefined;
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'));
  } catch {
    return undefined;
  }
  const out = [];
  for (const f of files) {
    let content;
    try { content = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    const u = sumUsageFromTranscript(content);
    out.push({
      stage: classifySubagentStage(extractFirstUserText(content)),
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      cacheReadTokens: u.cacheReadTokens,
      model: u.model,
    });
  }
  return out.length ? out : undefined;
}

/**
 * Stop hook 入口：讀 payload → 估算 → append 一行進 **主 repo** `.loops/.metrics/costs.jsonl`。
 * 落點錨定（P2）：不看 cwd 是否有 .loops，而是把 cwd 解析成主 repo 根（worktree cwd 也寫回主 repo），
 * 對齊 AGENTS 規則 9 的 .loops 錨定——修好「worktree session 的成本寫進 worktree .loops（會被清 / 分裂）」。
 * 子代理歸戶（P1）：額外掃 `<transcript>/<session>/subagents/*.jsonl` 併入 by_stage。
 * 安全 / 永不擋路：env 預設關、主 repo 無 .loops/ 不自建、transcript 讀不到不崩、任何例外一律 exit 0。
 */
function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return; // payload 壞掉 → 靜默 no-op
  }

  if (process.env.LOOPS_COST_TRACKER !== '1') return; // 預設關閉

  const loopsRoot = resolveLoopsRoot(payload?.cwd); // P2：worktree cwd → 主 repo 根
  if (!loopsRoot || !existsSync(join(loopsRoot, '.loops'))) return; // 不在 loops 工作區 → 不自建

  let transcript;
  try {
    transcript = readFileSync(payload.transcript_path, 'utf8');
  } catch {
    return; // transcript 不存在 / 讀不到 → 不崩
  }

  const usage = sumUsageFromTranscript(transcript);
  const costUsd = estimateCostUsd(usage, usage.model);
  const byStage = sumUsageByStage(transcript);
  const subagents = readSubagents(payload.transcript_path); // P1
  const row = buildCostRow({
    sessionId: payload.session_id,
    usage,
    model: usage.model,
    costUsd,
    ts: Date.now(),
    byStage,
    subagents,
  });

  const metricsDir = join(loopsRoot, '.loops', '.metrics');
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
