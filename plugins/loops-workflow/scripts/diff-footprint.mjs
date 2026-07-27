#!/usr/bin/env node
// diff-footprint.mjs —— 把「這次改動實際長多大」量出來，並對 `stages/02-plan.md` 的 evidence
// portfolio 與 change budget 逐條對帳（#215）。
//
// 它回答四個問題，前三個**會擋**、第四個只提醒：
//   1. 有沒有**不屬於任何核准 slice** 的改動檔？（範圍外施工）
//   2. 有沒有**新測試但計畫沒說為什麼要新增**？（`new_test=true` 缺 `new_test_reason`，或根本沒宣告要新增）
//   3. 有沒有**重複證據沒填 distinct_risk**？（同一 behavior 兩份 primary）
//   4. footprint 超出 budget 了嗎？超了而且**沒有可稽核理由**（slice 的 `budget_overrun_reason`）→ 擋；
//      有理由 → 只記 drift。**測試／功能行數比例本身只是 warning，永遠不擋**——正當的測試不該被比例擋掉。
//
// 輸出一行機械可讀 marker 給 `hooks/pr-gate.mjs` 閘⑧ 讀：
//   <!-- loops-footprint status=ok|warn|blocked prod=<n> test=<n> newtests=<n> unslotted=<n> unexplained=<n> -->
//
// 用法：
//   node diff-footprint.mjs --base <ref> [--plan <path-to-02-plan.md>] [--cwd <repo>] [--json] [--marker]
//
// 純函式（classifyPath / parseNumstat / summarizeChange / auditFootprint / renderMarker / renderReport）
// ＋ IO 薄邊界（readNumstat / main）。測試直接 import 純函式、不 spawn git。

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { extractPlanBlock } from './validate-plan.mjs';

/** 判成「測試面」的路徑樣式：測試、benchmark、fixture、測試支援全算同一桶。 */
export const TEST_PATH_PATTERNS = Object.freeze([
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
  /(^|\/)e2e\//,
  /(^|\/)benchmark(s)?\//,
  /(^|\/)fixtures?\//,
  /(^|\/)test-support\//,
  /\.(test|spec|bench)\.[^/]+$/,
  /(^|\/)test-[^/]+$/,
  /(^|\/)[^/]+-test\.[^/]+$/,
]);

/** 一份改動檔屬於「測試面」還是「功能面」。 */
export function classifyPath(path) {
  const p = String(path ?? '').split('\\').join('/');
  return TEST_PATH_PATTERNS.some((re) => re.test(p)) ? 'test' : 'production';
}

/**
 * numstat 的 rename 形取「搬完之後的落點」——git 有兩種寫法：整段 `old => new`，
 * 以及共用前後綴的 `prefix/{old => new}/suffix`（其中 old 或 new 可能是空字串）。
 */
export function renameTarget(spec) {
  const braced = spec.match(/^(.*)\{(.*?) => (.*?)\}(.*)$/);
  if (braced) return `${braced[1]}${braced[3]}${braced[4]}`.replace(/\/{2,}/g, '/');
  const plain = spec.match(/^(.*?) => (.*)$/);
  return plain ? plain[2] : spec;
}

/**
 * 解析 `git diff --numstat` 的輸出。二進位檔（`-\t-`）計 0 行但仍算一個改動檔。
 * @returns `[{ path, added, deleted, binary }]`
 */
export function parseNumstat(text) {
  const rows = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    const path = m[3].includes(' => ') ? renameTarget(m[3]) : m[3];
    rows.push({ path, added: binary ? 0 : Number(m[1]), deleted: binary ? 0 : Number(m[2]), binary });
  }
  return rows;
}

/**
 * 把 numstat 收成兩桶（功能 / 測試）的 files 與 lines。
 * `lines` 口徑＝**新增行數**（與 plan budget 的口徑一致：budget 估的是「要寫多少」）。
 */
export function summarizeChange(rows) {
  const bucket = { production: { files: 0, lines: 0 }, test: { files: 0, lines: 0 } };
  const paths = { production: [], test: [] };
  for (const r of rows) {
    const kind = classifyPath(r.path);
    bucket[kind].files += 1;
    bucket[kind].lines += r.added;
    paths[kind].push(r.path);
  }
  return { ...bucket, paths, ratio: bucket.production.lines === 0 ? null : bucket.test.lines / bucket.production.lines };
}

/** plan 的 slice 清單（正式鍵 `slices`，legacy `tasks`）。 */
function planSlices(plan) {
  if (Array.isArray(plan?.slices)) return plan.slices;
  if (Array.isArray(plan?.tasks)) return plan.tasks;
  return [];
}

/** 把 plan 的每個 slice budget 加總成整體預算。 */
export function planBudget(plan) {
  const total = { production: { files: 0, lines: 0 }, test: { files: 0, lines: 0 } };
  let declared = false;
  for (const s of planSlices(plan)) {
    for (const [field, key] of [['production_change_budget', 'production'], ['test_change_budget', 'test']]) {
      const b = s?.[field];
      if (!b || typeof b !== 'object') continue;
      declared = true;
      if (Number.isFinite(b.files)) total[key].files += b.files;
      if (Number.isFinite(b.lines)) total[key].lines += b.lines;
    }
  }
  return declared ? total : null;
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * footprint 對帳。純函式：不碰 git、不碰檔案系統。
 *
 * @param rows    parseNumstat 的結果
 * @param plan    已解析的 loops-plan（可為 null＝沒有機器可驗證計畫）
 * @returns `{ status, change, budget, drift, blocking, warnings, notes }`
 */
export function auditFootprint(rows, plan) {
  const change = summarizeChange(rows);
  const blocking = [];
  const warnings = [];
  const notes = [];

  const slices = planSlices(plan);
  const budget = planBudget(plan);

  // ① 範圍外施工：改動檔不屬於任何核准 slice。
  const slotted = new Set();
  for (const s of slices) for (const f of (Array.isArray(s?.files) ? s.files : [])) if (typeof f === 'string') slotted.add(f);
  const unslotted = slices.length === 0 || slotted.size === 0
    ? []
    : change.paths.production.filter((p) => !slotted.has(p));
  if (unslotted.length) {
    blocking.push({
      check: 'unslotted-change',
      detail: `${unslotted.length} 個功能檔不屬於任何核准 slice：${unslotted.slice(0, 8).join('、')}`
        + `${unslotted.length > 8 ? ' …' : ''} —— 要嘛回 plan 把它納入某個 slice（living plan），要嘛它根本不該改。`,
    });
  }
  if (slices.length === 0) notes.push('計畫沒有 slice 清單 —— 範圍外施工這一項無從判定（沒判定就不宣稱通過）。');

  // ② / ③ evidence portfolio 對帳（沒有 portfolio 就只在 notes 留痕、不假裝驗過）。
  const portfolio = Array.isArray(plan?.evidence_portfolio) ? plan.evidence_portfolio : null;
  const newTestFiles = change.paths.test.length;
  if (!portfolio) {
    notes.push('計畫沒有 evidence portfolio —— 新測試理由與重複證據這兩項無從判定。');
  } else {
    const declaredNewTest = portfolio.filter((e) => e?.new_test === true);
    for (const e of declaredNewTest) {
      if (!isNonEmptyString(e?.new_test_reason)) {
        blocking.push({
          check: 'new-test-without-reason',
          detail: `behavior ${e?.behavior_id ?? '(未指名)'} 宣告要新增測試卻沒寫 new_test_reason（既有證據缺哪個觀察點）。`,
        });
      }
    }
    if (change.test.lines > 0 && declaredNewTest.length === 0) {
      blocking.push({
        check: 'new-test-without-reason',
        detail: `diff 有 ${change.test.lines} 行測試改動，但 evidence portfolio 沒有任何 new_test=true 的條目`
          + ' —— 新增的測試沒有對應的理由，回 plan 補 new_test_reason 或說明它守的是哪個 behavior。',
      });
    }

    const primaryPerBehavior = new Map();
    for (const e of portfolio) {
      if (!isNonEmptyString(e?.behavior_id)) continue;
      if (isNonEmptyString(e?.distinct_risk)) continue;
      primaryPerBehavior.set(e.behavior_id, (primaryPerBehavior.get(e.behavior_id) ?? 0) + 1);
    }
    for (const [bid, n] of primaryPerBehavior) {
      if (n > 1) {
        blocking.push({
          check: 'duplicate-evidence',
          detail: `behavior ${bid} 有 ${n} 份 primary evidence 卻沒填 distinct_risk —— 重複證據，取一份或寫出第二份守什麼別的風險。`,
        });
      }
    }
  }

  // ④ budget drift。
  let drift = null;
  if (budget) {
    drift = {
      production: { files: change.production.files - budget.production.files, lines: change.production.lines - budget.production.lines },
      test: { files: change.test.files - budget.test.files, lines: change.test.lines - budget.test.lines },
    };
    const over = [];
    if (drift.production.lines > 0) over.push(`功能 +${drift.production.lines} 行`);
    if (drift.test.lines > 0) over.push(`測試 +${drift.test.lines} 行`);
    if (over.length) {
      const explained = slices.some((s) => isNonEmptyString(s?.budget_overrun_reason));
      if (explained) {
        notes.push(`footprint 超出 budget（${over.join('、')}），計畫已補 budget_overrun_reason。`);
      } else {
        blocking.push({
          check: 'unexplained-overrun',
          detail: `footprint 超出 plan budget（${over.join('、')}）且計畫沒有 budget_overrun_reason`
            + ' —— 超出不是禁止，但要在 living plan 補一句可稽核理由。',
        });
      }
    }
  } else {
    notes.push('計畫沒有 change budget —— drift 無從判定（缺少可驗證的 budget 本來就不該進 build）。');
  }

  // 比例：只提醒，永不擋（正當的測試不該被比例擋掉）。
  if (change.ratio !== null && change.ratio > 1) {
    warnings.push(`測試／功能新增行數比 ${change.ratio.toFixed(2)}:1（>1 是過度訊號，先按 test-rubric §10 判多餘六型裁，不以比例當品質標準）。`);
  }

  const status = blocking.length ? 'blocked' : (warnings.length ? 'warn' : 'ok');
  return { status, change, budget, drift, blocking, warnings, notes, newTestFiles, unslotted };
}

/** 給 pr-gate 閘⑧ 讀的一行機械 marker（HTML 註解、rendered 不可見）。 */
export function renderMarker(report) {
  const unexplained = report.blocking.filter((b) => b.check === 'unexplained-overrun').length;
  return `<!-- loops-footprint status=${report.status} prod=${report.change.production.lines}`
    + ` test=${report.change.test.lines} newtests=${report.newTestFiles}`
    + ` unslotted=${report.unslotted.length} unexplained=${unexplained} -->`;
}

/** 人讀的精簡摘要（紅燈才逐條列，綠燈一行）。 */
export function renderReport(report) {
  const c = report.change;
  const head = `${report.status === 'ok' ? '✓' : report.status === 'warn' ? '⚠' : '✗'} footprint：`
    + `功能 ${c.production.files} 檔 / +${c.production.lines} 行；測試 ${c.test.files} 檔 / +${c.test.lines} 行`
    + `${c.ratio === null ? '' : `（比 ${c.ratio.toFixed(2)}:1）`}`;
  const lines = [head];
  if (report.drift) {
    lines.push(`  budget：功能 ${report.drift.production.lines >= 0 ? '+' : ''}${report.drift.production.lines} 行、`
      + `測試 ${report.drift.test.lines >= 0 ? '+' : ''}${report.drift.test.lines} 行（相對 plan）`);
  }
  for (const b of report.blocking) lines.push(`  ✗ [${b.check}] ${b.detail}`);
  for (const w of report.warnings) lines.push(`  ⚠ ${w}`);
  for (const n of report.notes) lines.push(`  · ${n}`);
  lines.push(renderMarker(report));
  return lines.join('\n');
}

// ── IO 薄邊界 ───────────────────────────────────────────────────────────────

/** 跑 `git diff --numstat <base>...HEAD`；取不到回 null（呼叫端據實標「量不到」，不編數字）。 */
export function readNumstat(cwd, base) {
  const r = spawnSync('git', ['diff', '--numstat', `${base}...HEAD`], { cwd, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout;
}

function parseArgs(argv) {
  const opts = { base: null, plan: null, cwd: process.cwd(), json: false, markerOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base') opts.base = argv[++i] ?? null;
    else if (argv[i] === '--plan') opts.plan = argv[++i] ?? null;
    else if (argv[i] === '--cwd') opts.cwd = argv[++i] ?? process.cwd();
    else if (argv[i] === '--json') opts.json = true;
    else if (argv[i] === '--marker') opts.markerOnly = true;
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv.slice(2));
  if (!opts.base) {
    console.error('用法：node diff-footprint.mjs --base <ref> [--plan <02-plan.md>] [--cwd <repo>] [--json] [--marker]');
    return 2;
  }
  const numstat = readNumstat(opts.cwd, opts.base);
  if (numstat === null) {
    console.error(`量不到 diff：git diff --numstat ${opts.base}...HEAD 在 ${opts.cwd} 失敗（沒量到就標 not measured，不編數字）。`);
    return 2;
  }
  let plan = null;
  if (opts.plan) {
    try {
      const extracted = extractPlanBlock(readFileSync(opts.plan, 'utf8'));
      if (extracted.error) console.error(`（計畫讀得到但取不到 loops-plan 區塊：${extracted.error.detail}）`);
      else plan = extracted.plan;
    } catch {
      console.error(`（讀不到計畫檔 ${opts.plan}，budget 與 evidence 對帳這幾項標為無從判定）`);
    }
  }
  const report = auditFootprint(parseNumstat(numstat), plan);
  if (opts.markerOnly) console.log(renderMarker(report));
  else if (opts.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderReport(report));
  return report.status === 'blocked' ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
