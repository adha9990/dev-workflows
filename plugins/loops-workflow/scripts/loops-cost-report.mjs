#!/usr/bin/env node
// loops-cost-report.mjs —— 讀主 repo `.loops/.metrics/costs.jsonl`（cost-tracker Stop hook 寫的），
// 取某 session 的**最終快照**（同一 session 取最後一行），產成人類可讀的 cost.md markdown 成本報告：
// loop 完整跑完後看 token 花在哪 —— 逐階段 by_stage ＋ 子代理 subagent ＋ 總計。
//
// 分層（仿 hooks/cost-tracker.mjs、scripts/loops-quality-gate.mjs、scripts/progress.mjs）：
//   1) 純函式（無 IO，測試直接 import）：pickSessionRow / formatCostReport。
//   2) IO 薄邊界：main()（讀 costs.jsonl、寫 --out / print stdout）——被 import 時不執行
//      （import.meta.url 守門）；讀不到 / 任何錯誤一律走 fallback，永遠產出東西、不崩。
// 依賴：僅 node 內建（fs / path / url），零外部套件。
// 用法：node loops-cost-report.mjs --cwd <主repo根> [--session <id>] [--slug <名>] [--out <檔路徑>]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── 純函式的內部小工具 ────────────────────────────────────────────────────────

function safeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// token 一律採「千分位整數」格式（單一慣例、全報告一致）；NaN / 缺值 → 0。
function fmtInt(value) {
  return String(Math.round(safeNum(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// cost_usd 一律標 $x.xx。
function fmtUsd(value) {
  return `$${safeNum(value).toFixed(2)}`;
}

// 誠實標註（Metric-Honesty，照 cost-tracker / journaling 口徑；一句帶過）：
// 這是「依 API 回報 usage 的估算」、非帳單權威，且有兩個方向相反的偏差。
const HONESTY_NOTE =
  '> ⚠️ 本報告是「依 API 回報 usage 的**估算**」、非帳單權威；有兩個**方向相反**的偏差：' +
  'rate table 無法表達 Opus >200K／1h-cache 2× 級距 → 偏**低估**；' +
  '跨 `--resume` 對整份 transcript 重複加總 → 偏**高估**（Metric-Honesty）。';

// ── 純函式層（無 IO，測試直接 import）────────────────────────────────────────

/**
 * 逐行 JSON.parse（壞行跳過）costs.jsonl 內容：
 * - 給 sessionId → 回**符合該 sessionId 的最後一行**物件（none → null）。
 * - 未給 sessionId（undefined / 空字串）→ 回整體最後一行有效物件。
 * - 無任何有效行 → null。
 * cost-tracker 每 Stop append 一行、per-session 累計，故「同一 session 最後一行」＝最終快照。
 */
export function pickSessionRow(fileContent, sessionId) {
  const wantSession = typeof sessionId === 'string' && sessionId.length > 0;
  let lastAny = null;
  let lastMatch = null;
  for (const line of String(fileContent ?? '').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // 壞行容錯：跳過，後續行照常處理
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    lastAny = row;
    if (wantSession && row.session_id === sessionId) lastMatch = row;
  }
  return wantSession ? lastMatch : lastAny;
}

/**
 * 把 costs.jsonl 的一列（cost-tracker schema 2/3）render 成 markdown 成本報告字串。
 * - row 為 null / 非物件 → fallback：一段簡短 no-data markdown（不丟例外，一律產出東西）。
 * - 標題含 slug；誠實標註一句（Metric-Honesty）。
 * - 總計：input/output/cache_creation/cache_read tokens ＋ cost_usd；
 *   schema 3 另標 total_cost_usd（主線＋子代理）與 subagents 聚合（count/tokens/cost）。
 * - by_stage 表（照 file 內順序）：stage｜turns｜in｜out｜cacheW｜cacheR｜cost_usd｜（有 subagent 時）子代理 cost。
 * token 採千分位、cost_usd 標 $x.xx。
 */
export function formatCostReport(row, opts = {}) {
  const slug = opts && typeof opts.slug === 'string' && opts.slug ? opts.slug : '(unknown)';

  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return [
      `# 成本報告：${slug}`,
      '',
      HONESTY_NOTE,
      '',
      'cost-tracker 未開或無 `.loops/.metrics/costs.jsonl` 資料，無逐階拆解；',
      '請見 `loop.md` 的 outcome 度量估算行。',
      '',
    ].join('\n');
  }

  const schema = safeNum(row.schema) || 2;
  const sub = row.subagents;
  const hasSub = schema >= 3 && sub && typeof sub === 'object';

  const lines = [];
  lines.push(`# 成本報告：${slug}`);
  lines.push('');
  lines.push(HONESTY_NOTE);
  lines.push('');

  // ── 總計 ──
  lines.push('## 總計');
  lines.push('');
  if (typeof row.model === 'string' && row.model) lines.push(`- model：\`${row.model}\``);
  lines.push(`- input：${fmtInt(row.input_tokens)}`);
  lines.push(`- output：${fmtInt(row.output_tokens)}`);
  lines.push(`- cache_creation：${fmtInt(row.cache_creation_input_tokens)}`);
  lines.push(`- cache_read：${fmtInt(row.cache_read_input_tokens)}`);
  lines.push(`- cost_usd（主線）：${fmtUsd(row.cost_usd)}`);

  if (hasSub) {
    lines.push(`- **total_cost_usd（主線＋子代理）：${fmtUsd(row.total_cost_usd)}**`);
    lines.push('');
    lines.push('### 子代理聚合（subagents）');
    lines.push('');
    lines.push(`- count：${fmtInt(sub.count)}`);
    lines.push(`- input：${fmtInt(sub.input_tokens)}`);
    lines.push(`- output：${fmtInt(sub.output_tokens)}`);
    lines.push(`- cache_creation：${fmtInt(sub.cache_creation_input_tokens)}`);
    lines.push(`- cache_read：${fmtInt(sub.cache_read_input_tokens)}`);
    lines.push(`- cost_usd：${fmtUsd(sub.cost_usd)}`);
  }
  lines.push('');

  // ── by_stage 表（照 file 內順序）──
  const stages = Array.isArray(row.by_stage) ? row.by_stage : [];
  if (stages.length) {
    const anyStageSub = stages.some((s) => s && s.subagent && typeof s.subagent === 'object');
    const header = ['stage', 'turns', 'in', 'out', 'cacheW', 'cacheR', 'cost_usd'];
    if (anyStageSub) header.push('子代理 cost');

    lines.push('## 逐階段（by_stage）');
    lines.push('');
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`| ${header.map(() => '---').join(' | ')} |`);
    for (const s of stages) {
      const cells = [
        String((s && s.stage) ?? 'unknown'),
        fmtInt(s && s.turns),
        fmtInt(s && s.input_tokens),
        fmtInt(s && s.output_tokens),
        fmtInt(s && s.cache_creation_input_tokens),
        fmtInt(s && s.cache_read_input_tokens),
        fmtUsd(s && s.cost_usd),
      ];
      if (anyStageSub) cells.push(s && s.subagent ? fmtUsd(s.subagent.cost_usd) : '—');
      lines.push(`| ${cells.join(' | ')} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── IO 薄邊界：main()（被 import 時不執行）────────────────────────────────────

function parseArgs(argv) {
  const opts = { cwd: '.', session: undefined, slug: undefined, out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--cwd') opts.cwd = argv[++i] ?? '.';
    else if (flag === '--session') opts.session = argv[++i];
    else if (flag === '--slug') opts.slug = argv[++i];
    else if (flag === '--out') opts.out = argv[++i];
  }
  return opts;
}

function readFileMaybe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null; // 檔不存在 / 讀不到屬正常情境（走 fallback），不是錯誤
  }
}

/**
 * 讀 `<cwd>/.loops/.metrics/costs.jsonl` → pickSessionRow 取列 → formatCostReport 產 markdown。
 * 有 --out → 寫進該檔（UTF-8，寫失敗退回 stdout）；無 → print 到 stdout。
 * 檔不存在 / 讀不到 → row=null → fallback（no-data 版），不崩。
 */
function main(argv) {
  const opts = parseArgs(argv);
  const slug = opts.slug || opts.session || 'loop';

  const content = readFileMaybe(join(opts.cwd, '.loops', '.metrics', 'costs.jsonl'));
  let row = null;
  if (content != null) {
    try {
      row = pickSessionRow(content, opts.session);
    } catch {
      row = null; // 極端壞資料 → 走 fallback
    }
  }

  const md = formatCostReport(row, { slug });
  if (opts.out) {
    try {
      writeFileSync(opts.out, md, 'utf8');
      return;
    } catch {
      // 寫檔失敗（路徑不存在等）→ 退回 stdout，仍產出東西、不崩
    }
  }
  process.stdout.write(md.endsWith('\n') ? md : `${md}\n`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch {
    // 最後防線：一律要能產出東西 → 印 no-data fallback，不崩
    process.stdout.write(`${formatCostReport(null, { slug: 'loop' })}\n`);
  }
  process.exit(0);
}
