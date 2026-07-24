#!/usr/bin/env node
// baseline-trace.mjs —— #169 baseline corpus 軌跡抽取器（機制 B、契約 C2）。
// 把一條歷史 loop 的 session 編號跟 cost-tracker 落的逐 session 累計帳（costs.jsonl）接起來：
// 取該 session 全部快照、按時間排序、取最後一筆當總帳、首尾相減反推耗時下界。無精確帳（例如
// 本 repo 的 loop 成本記到了另一個 repo 名下——歸戶缺陷，本身就是 baseline 要記錄的發現）就
// 老實降級用 Journal 裡 ★[outcome] 行的人工估算級距，明標 est、不假裝精確。
//
// 假陽性防護：session 比對走「JSON 解析後 session_id 欄位嚴格全等」，不對整行文字做子字串 /
// 裸字串搜尋——共用前綴（如同一批次的相近 session）或行內其他數字都不會誤配。
//
// 分層（仿 hooks/cost-tracker.mjs、scripts/eval-oracle.mjs）：
//   1) 純函式（無 IO，測試直接 import）：parseSessionId / extractOutcomeLine / parseTokenRange /
//      parseSubagentCount / parseCostsLines / filterSessionRows / buildPreciseTrace /
//      buildDegradedTrace / resolveRepoName。
//   2) 薄 IO：traceSingleLoop / scanOutcomeLoops / CLI main —— 被 import 時不執行
//      （import.meta.url 守門）。全程唯讀：本檔不寫任何 --loops-root 底下的檔案。
// 依賴：僅 node 內建（fs / path / url），零外部套件。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SESSION_RE = /\*\*session\*\*[:：]\s*([0-9a-fA-F-]{36})/;
const OUTCOME_LINE_RE = /^.*★\[outcome\].*$/m;
const UNIT_MULTIPLIER = { k: 1_000, m: 1_000_000 };
const TOKEN_RANGE_RE = /token\s*≈\s*([\d.]+)\s*([kKmM])\s*[-–—]\s*([\d.]+)\s*([kKmM])/;
const SUBAGENT_COUNT_RE = /sub-agent\s*(\d+)/i;

// duration 口徑聲明：固定寫進每筆 trace 的 caveats，不管精確或降級態都要讀者知道這個限制。
const DURATION_CAVEAT = 'duration 為 Stop-to-Stop 下界估計（首尾 Stop 的 wall-clock 差；漏首個 Stop 前的工作；非精確總耗時）';
const SUBAGENT_LENS_CAVEAT = '本 trace 的 total_incl_subagents 為主、main 為輔——子代理帳可觀察到遠大於主線，只看 main 會嚴重低估';

// ── 純函式層（無 IO，測試直接 import）─────────────────────────────────────────────

/** 從 loop.md 文字抽 session UUID（header 行 `- **session**：<uuid>` 或 `- **session**: <uuid>`，全形/半形冒號皆可）。抽不到 → null。 */
export function parseSessionId(text) {
  const m = SESSION_RE.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/** 抽 Journal 裡含 ★[outcome] 標記的那一整行（trim 過）。抽不到 → null。 */
export function extractOutcomeLine(text) {
  const m = OUTCOME_LINE_RE.exec(String(text ?? ''));
  return m ? m[0].trim() : null;
}

/** 從 outcome 行文字解出 token 級距（如 "200k-400k"／"2M–3M"）→ [lo, hi]（正規化成實際數字）。解不出 → null。 */
export function parseTokenRange(text) {
  const m = TOKEN_RANGE_RE.exec(String(text ?? ''));
  if (!m) return null;
  const lo = Number(m[1]) * UNIT_MULTIPLIER[m[2].toLowerCase()];
  const hi = Number(m[3]) * UNIT_MULTIPLIER[m[4].toLowerCase()];
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return [Math.round(lo), Math.round(hi)];
}

/** 從 outcome 行文字解出 sub-agent 數（只取標籤後緊接的整數，忽略後面的括號註記）。解不出 → null。 */
export function parseSubagentCount(text) {
  const m = SUBAGENT_COUNT_RE.exec(String(text ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * 逐行解析 costs.jsonl（JSONL）→ 合法 JSON 物件陣列。壞行（含刻意的假陽性測試行）
 * 一律 continue 跳過，不丟例外——與 cost-tracker/eval-oracle 的壞行容錯慣例一致。
 */
export function parseCostsLines(content) {
  const rows = [];
  for (const line of String(content ?? '').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row && typeof row === 'object') rows.push(row);
  }
  return rows;
}

/**
 * 篩出 session_id 與 sessionId **嚴格全等**的列（非子字串/前綴命中——防假陽性），
 * 依 ts 升冪排序（供「最後一筆＝累計總帳」「首尾相減＝duration」使用）。
 */
export function filterSessionRows(rows, sessionId) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.session_id === sessionId)
    .sort((a, b) => safeTs(a?.ts) - safeTs(b?.ts));
}

/** 把 loops-root 路徑正規化成 repo 短名（取最後一段、容忍尾端斜線）。 */
export function resolveRepoName(loopsRoot) {
  const s = String(loopsRoot ?? '').replace(/[\\/]+$/, '');
  return basename(s) || s;
}

/**
 * 組出精確態 C2 trace：main 取「最後一筆」（cost-tracker 每次 Stop 都重新加總全 transcript，
 * 故最後一筆即累計總帳，非把多筆相加）；total_incl_subagents = main + 最後一筆的 subagents 同名欄
 * （schema2 無 subagents → 兩者相等）；duration = 首尾 ts 差（單筆快照 → not_measured）。
 */
export function buildPreciseTrace({ loopSlug, repo, sessionId, rows }) {
  const sorted = Array.isArray(rows) ? rows : [];
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const main = fourFields(last);
  const sub = last?.subagents;
  const totalIncl = sub
    ? {
        input: main.input + numOr0(sub.input_tokens),
        output: main.output + numOr0(sub.output_tokens),
        cache_creation: main.cache_creation + numOr0(sub.cache_creation_input_tokens),
        cache_read: main.cache_read + numOr0(sub.cache_read_input_tokens),
        total: 0,
      }
    : { ...main };
  totalIncl.total = totalIncl.input + totalIncl.output + totalIncl.cache_creation + totalIncl.cache_read;

  const costMain = numOr0(last?.cost_usd);
  const costTotal = last?.total_cost_usd !== undefined ? numOr0(last.total_cost_usd) : costMain;

  const schemaVersionsSeen = [...new Set(sorted.map((r) => r?.schema).filter((s) => s !== undefined))].sort(
    (a, b) => a - b,
  );

  const durationMs = sorted.length > 1 ? safeTs(last?.ts) - safeTs(first?.ts) : 'not_measured';
  const caveats = [DURATION_CAVEAT, SUBAGENT_LENS_CAVEAT];
  if (durationMs === 'not_measured') caveats.push('僅單筆快照，無法反推 duration（需至少 2 筆同 session 快照）');

  return {
    loop_slug: loopSlug,
    repo,
    session_id: sessionId,
    first_ts: sorted.length ? safeTs(first?.ts) : null,
    last_ts: sorted.length ? safeTs(last?.ts) : null,
    duration_ms: durationMs,
    main,
    total_incl_subagents: totalIncl,
    cost_usd: { main: costMain, total: costTotal, estimate: true },
    subagent_count: numOr0(sub?.count),
    by_stage: Array.isArray(last?.by_stage) ? last.by_stage : [],
    schema_versions_seen: schemaVersionsSeen,
    caveats,
  };
}

/**
 * 組出降級態 C2 trace（無精確 costs.jsonl 命中）：有 outcome 行可解析 → est_range +
 * source:'outcome-line'；連 outcome 行都沒有（loop 進行中）→ 全欄 not_measured。
 * cost_usd 一律 not_measured——token est 換算成金額會疊加第二層不確定性，不假裝精確。
 */
export function buildDegradedTrace({ loopSlug, repo, sessionId, outcomeLine }) {
  const caveats = [
    DURATION_CAVEAT,
    '無 costs.jsonl 精確帳可比對此 session（歸戶缺陷：本 repo 的 loop 成本未落在本 repo 的 .loops/.metrics/costs.jsonl，見 baseline 發現）',
  ];

  if (!outcomeLine) {
    caveats.push('無 ★[outcome] Journal 行可供估算，totals 完全 not_measured');
    return {
      loop_slug: loopSlug,
      repo,
      session_id: sessionId ?? null,
      first_ts: null,
      last_ts: null,
      duration_ms: 'not_measured',
      main: 'not_measured',
      total_incl_subagents: 'not_measured',
      cost_usd: { main: 'not_measured', total: 'not_measured', estimate: true },
      subagent_count: 'not_measured',
      by_stage: [],
      schema_versions_seen: [],
      caveats,
    };
  }

  const range = parseTokenRange(outcomeLine);
  const subagentCount = parseSubagentCount(outcomeLine);
  caveats.push(`來源：Journal ★[outcome] 行人工估算級距（非精確帳）── 原文：${outcomeLine}`);
  if (!range) caveats.push('outcome 行存在但 token 級距格式無法解析，totals 改為 not_measured');
  const est = range ? { est_range: range, source: 'outcome-line' } : 'not_measured';

  return {
    loop_slug: loopSlug,
    repo,
    session_id: sessionId ?? null,
    first_ts: null,
    last_ts: null,
    duration_ms: 'not_measured',
    main: est,
    total_incl_subagents: est,
    cost_usd: { main: 'not_measured', total: 'not_measured', estimate: true },
    subagent_count: subagentCount ?? 'not_measured',
    by_stage: [],
    schema_versions_seen: [],
    caveats,
  };
}

function fourFields(row) {
  const input = numOr0(row?.input_tokens);
  const output = numOr0(row?.output_tokens);
  const cache_creation = numOr0(row?.cache_creation_input_tokens);
  const cache_read = numOr0(row?.cache_read_input_tokens);
  return { input, output, cache_creation, cache_read, total: input + output + cache_creation + cache_read };
}

function numOr0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function safeTs(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── 薄 IO 層（被 import 時不執行）──────────────────────────────────────────────────

function readTextOrNull(path) {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** 讀 <loopsRoot>/.loops/<loopSlug>/loop.md → session 解析 → 命中 costs.jsonl 走精確路徑，否則降級。 */
/**
 * rows 為選用（F6：scanOutcomeLoops 場景一次讀完 costs.jsonl、依 session 分組後把該 loop 的切片
 * 傳進來，避免逐 loop 各自重讀重解析整份 costs.jsonl）。undefined＝呼叫端沒給 → 退回原行為，
 * 自己讀檔（單次 --loop CLI 呼叫場景，只有一個 loop 用不到分攤成本）；空陣列 [] 是合法輸入
 * （已查過、該 session 在 costs.jsonl 裡確實零筆命中），與「沒給」語意不同，用 `!== undefined` 判斷。
 */
export function traceSingleLoop({ loopSlug, loopsRoot, rows: providedRows }) {
  const repo = resolveRepoName(loopsRoot);
  const loopMd = readTextOrNull(join(loopsRoot, '.loops', loopSlug, 'loop.md'));
  if (loopMd === null) {
    return { loop_slug: loopSlug, error: `loop.md not found under ${loopsRoot}/.loops/${loopSlug}/（唯讀來源不存在）` };
  }

  const sessionId = parseSessionId(loopMd);
  const outcomeLine = extractOutcomeLine(loopMd);

  if (sessionId) {
    const rows = providedRows !== undefined
      ? providedRows
      : filterSessionRows(parseCostsLines(readTextOrNull(join(loopsRoot, '.loops', '.metrics', 'costs.jsonl'))), sessionId);
    if (rows.length > 0) return buildPreciseTrace({ loopSlug, repo, sessionId, rows });
  }

  return buildDegradedTrace({ loopSlug, repo, sessionId, outcomeLine });
}

/** 把 parseCostsLines 的扁平列依 session_id 分組＋各組按 ts 升冪排序（與 filterSessionRows 同排序口徑）。 */
function groupRowsBySession(rows) {
  const bySession = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.session_id !== 'string') continue;
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
    bySession.get(r.session_id).push(r);
  }
  for (const arr of bySession.values()) arr.sort((a, b) => safeTs(a?.ts) - safeTs(b?.ts));
  return bySession;
}

/**
 * 掃 <loopsRoot>/.loops/* 底下所有子目錄，只收有 ★[outcome] 行的 loop（＝已完工、值得記一筆
 * baseline 現況的歷史 loop；進行中的 loop 連 est 都做不出，掃了也沒意義）。
 */
/**
 * F6：costs.jsonl 只讀一次（外層讀檔+parseCostsLines+依 session 分組），逐 loop 只查表、
 * 不重讀重解析——loop 數多時原本 O(N loop × 整份 costs.jsonl) 改成 O(1 讀檔 + N 查表)。
 */
export function scanOutcomeLoops({ loopsRoot }) {
  const loopsDir = join(loopsRoot, '.loops');
  if (!existsSync(loopsDir)) return [];

  let entries;
  try {
    entries = readdirSync(loopsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const slugs = entries
    .filter((d) => d.isDirectory() && d.name !== '.metrics')
    .map((d) => d.name)
    .sort();

  const rowsBySession = groupRowsBySession(
    parseCostsLines(readTextOrNull(join(loopsRoot, '.loops', '.metrics', 'costs.jsonl'))),
  );

  const out = [];
  for (const slug of slugs) {
    const loopMd = readTextOrNull(join(loopsRoot, '.loops', slug, 'loop.md'));
    if (loopMd === null || !extractOutcomeLine(loopMd)) continue;
    const sessionId = parseSessionId(loopMd);
    const rows = sessionId ? (rowsBySession.get(sessionId) ?? []) : [];
    out.push(traceSingleLoop({ loopSlug: slug, loopsRoot, rows }));
  }
  return out;
}

function parseArgs(argv) {
  const opts = { loop: null, loopsRoot: null, json: false, scan: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--loop') opts.loop = argv[++i] ?? null;
    else if (a === '--loops-root') opts.loopsRoot = argv[++i] ?? null;
    else if (a === '--json') opts.json = true;
    else if (a === '--scan-outcomes') opts.scan = true;
  }
  return opts;
}

const USAGE =
  'usage: node baseline-trace.mjs --loop <slug> --loops-root <path> [--json]\n' +
  '   or: node baseline-trace.mjs --scan-outcomes --loops-root <path> [--json]';

function formatTextSummary(traces) {
  return traces
    .map((t) => `${t.loop_slug}: session=${t.session_id ?? 'n/a'} duration_ms=${t.duration_ms} subagents=${t.subagent_count}`)
    .join('\n');
}

function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.loopsRoot || (!opts.loop && !opts.scan)) {
    console.error(USAGE);
    return 2; // 誤用
  }

  const loopsRootAbs = resolve(opts.loopsRoot);
  if (!existsSync(loopsRootAbs)) {
    console.error(`baseline-trace: loops-root 不存在 — ${loopsRootAbs}`);
    return 3; // 設定/IO 錯，不偽裝成 eval 結果
  }

  if (opts.scan) {
    const traces = scanOutcomeLoops({ loopsRoot: loopsRootAbs });
    console.log(opts.json ? JSON.stringify(traces, null, 2) : formatTextSummary(traces));
    return 0;
  }

  const trace = traceSingleLoop({ loopSlug: opts.loop, loopsRoot: loopsRootAbs });
  if (trace?.error) {
    console.error(`baseline-trace: ${trace.error}`);
    return 3;
  }
  console.log(opts.json ? JSON.stringify(trace, null, 2) : formatTextSummary([trace]));
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(err?.message ?? String(err));
    process.exit(1);
  }
}
