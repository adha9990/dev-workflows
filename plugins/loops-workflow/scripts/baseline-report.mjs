#!/usr/bin/env node
// baseline-report.mjs —— #169 baseline corpus 報告生成器（契約 C3）。
// 組合 baseline-corpus.mjs 的逐 fixture 判定結果＋baseline-trace.mjs 產的 trace 檔 → 雙 harness
// 分組的不可變 baseline report（md+json）。北極星＝Metric-Honesty：schema 層面不給合併平均欄、
// route 現況不符照紅、預期紅（expected-fail）與意外紅分欄計數不混在同一個裸百分比裡、缺值一律
// not_measured 不留空白。
//
// 分層（仿 scripts/baseline-corpus.mjs）：
//   1) 純函式（無 IO，測試直接 import）：computeUnexpectedFailRate / collectExpectedFailRefs /
//      buildRouteSection / buildQualitySection / buildCostSection / buildPlatformDiffFromGaps /
//      validateGapEntry / validateGapsSchema / buildBaselineReport / buildMarkdownReport /
//      reportFilenames / formatDateYYYYMMDD。
//   2) 薄 IO：loadTraces / writeReportFiles / CLI main —— 被 import 時不執行（import.meta.url 守門）。
// 依賴：僅 node 內建 + 本 repo 既有 baseline-corpus.mjs 匯出（loadCorpusFixtures/evaluateFixture/
//   buildCorpusReport——本檔的合法上游，非 eval-oracle/eval-trajectory 本體）。零外部套件。

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadCorpusFixtures, evaluateFixture, buildCorpusReport } from './baseline-corpus.mjs';

// R12：平台差異表固定 8 面向。
const PLATFORM_DIFF_DIMENSIONS = [
  'manifest', 'skill_invocation', 'questions', 'agents', 'hooks', 'worktree', 'resume', 'transcript_metrics',
];
// R12 八面向 ↔ C4 gaps.json capability_id 對映（明確常數表，非啟發式猜測）。以
// evals/baseline/codex/gaps.json 實際 id 為準（platform-engineer 命名，17 列）；某面向若
// gaps.json 無對應列（如目前無 skill_invocation 以外的 codex.metrics.* 這種另一軸的量測項），
// 維持 not_measured 骨架，不硬湊。
const PLATFORM_DIFF_GAP_ID = {
  manifest: 'codex.manifest',
  skill_invocation: 'codex.skill.discovery_invocation',
  questions: 'codex.interaction.questions',
  agents: 'codex.agents.subagent_model',
  hooks: 'codex.hooks.trigger_trust',
  worktree: 'codex.worktree',
  resume: 'codex.resume.loops_state',
  transcript_metrics: 'codex.transcript_metrics_stability',
};
// R4 目前無資料來源的維度（誠實記缺口，不假裝量到）。
const UNMEASURED_COST_DIMENSIONS = ['questions', 'verify_findings', 'iterate_rounds', 'repeated_reads', 'unresolved_unknowns'];

const RECAPTURE_NOTE =
  'route-decision/live-capture 類的 recorded_actual 是 capture 當下凍結的錄音；oracle 重跑是恆等式、不會變—— ' +
  '要偵測 dispatch 行為漂移必須重新 live-capture（非決定性重播），不是單純重跑 baseline-corpus。';
const RECAPTURE_CAVEAT_REF = '見 rerun.recapture_note：route-decision/live-capture 類重跑是恆等式，非重新 capture。';
const SUBAGENT_LENS_CAVEAT = 'total_incl_subagents 為主、main 為輔——子代理帳可觀察到遠大於主線，只看 main 會嚴重低估';

// ── 純函式層（無 IO，測試直接 import）─────────────────────────────────────────────

/** M4：意外失敗率——分母排除 expected_outcome==='expected-fail' 的 fixture，裸百分比不混入預期紅。 */
export function computeUnexpectedFailRate(tasks) {
  const denom = (Array.isArray(tasks) ? tasks : []).filter((t) => t?.expectedOutcome !== 'expected-fail');
  const failCount = denom.filter((t) => t?.pass !== true).length;
  return {
    rate: denom.length > 0 ? failCount / denom.length : null,
    fail_count: failCount,
    total_count: denom.length,
  };
}

/** 預期紅 fixture 清單（附 still_failing——標「現況是否仍如預期般失敗」，供後續發現用）。 */
export function collectExpectedFailRefs(tasks) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t?.expectedOutcome === 'expected-fail')
    .map((t) => ({ id: t?.id ?? null, still_failing: t?.pass !== true }));
}

/** route-decision 型 fixture 逐條 outcome + expected_outcome（S2：5 條 route 明確 pass/fail）。 */
export function buildRouteSection(tasks) {
  const out = {};
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (t?.oracleType !== 'route-decision') continue;
    out[t.id ?? '(no id)'] = { outcome: t.pass === true ? 'pass' : 'fail', expected_outcome: t.expectedOutcome ?? 'pass' };
  }
  return out;
}

/** 組 groups.<harness>.quality（S3：品質面——正確率/route/預期紅意外紅分欄）。 */
export function buildQualitySection(corpusReport) {
  const tasks = Array.isArray(corpusReport?.tasks) ? corpusReport.tasks : [];
  const unexpected = computeUnexpectedFailRate(tasks);
  return {
    unexpected_fail_rate: unexpected.rate,
    unexpected_fail_count: unexpected.fail_count,
    unexpected_fail_denominator: unexpected.total_count,
    expected_fail_count: tasks.filter((t) => t?.expectedOutcome === 'expected-fail').length,
    expected_fail_refs: collectExpectedFailRefs(tasks),
    route: buildRouteSection(tasks),
    total_fixtures: tasks.length,
  };
}

/**
 * 組 groups.claude-code.cost（S3：成本面，R4 逐欄）。tokens 精確與 est 分開加總、不混一個數字；
 * duration/tool_or_agent_calls 各自看有測到的筆數；R4 剩餘無資料來源的維度固定標 not_measured。
 */
export function buildCostSection(traces) {
  const list = Array.isArray(traces) ? traces : [];
  const precise = [];
  const est = [];
  let notMeasuredTokenTraces = 0;
  let durationSumMs = 0;
  let durationMeasuredCount = 0;
  let durationNotMeasuredCount = 0;
  let subagentSum = 0;
  let subagentMeasuredCount = 0;

  for (const t of list) {
    if (t?.main && typeof t.main === 'object' && typeof t.main.total === 'number') {
      precise.push(t);
    } else if (t?.main && typeof t.main === 'object' && t.main.source === 'outcome-line' && Array.isArray(t.main.est_range)) {
      est.push(t);
    } else {
      notMeasuredTokenTraces += 1;
    }

    if (typeof t?.duration_ms === 'number') {
      durationSumMs += t.duration_ms;
      durationMeasuredCount += 1;
    } else {
      durationNotMeasuredCount += 1;
    }

    if (typeof t?.subagent_count === 'number') {
      subagentSum += t.subagent_count;
      subagentMeasuredCount += 1;
    }
  }

  const tokens = {
    precise: precise.length
      ? {
          main: precise.reduce((s, t) => s + t.main.total, 0),
          total_incl_subagents: precise.reduce((s, t) => s + (t.total_incl_subagents?.total ?? t.main.total), 0),
          traces_count: precise.length,
        }
      : 'not_measured',
    est_range: est.length
      ? {
          lo: est.reduce((s, t) => s + t.main.est_range[0], 0),
          hi: est.reduce((s, t) => s + t.main.est_range[1], 0),
          traces_count: est.length,
          source: 'outcome-line（多筆級距逐界相加，非精確帳，不得與 precise 混算成單一數字）',
        }
      : 'not_measured',
    traces_not_measured: notMeasuredTokenTraces,
  };

  const durationMs = durationMeasuredCount > 0
    ? { sum_ms: durationSumMs, traces_measured: durationMeasuredCount, traces_not_measured: durationNotMeasuredCount }
    : 'not_measured';

  const toolOrAgentCalls = subagentMeasuredCount > 0
    ? { subagent_count_sum: subagentSum, traces_measured: subagentMeasuredCount, source: 'trace subagent_count（子代理數之和，非嚴格 tool-call 計數）' }
    : 'not_measured';

  const unmeasured = Object.fromEntries(UNMEASURED_COST_DIMENSIONS.map((k) => [k, 'not_measured']));
  return { tokens, duration_ms: durationMs, tool_or_agent_calls: toolOrAgentCalls, ...unmeasured };
}

// C4（platform-engineer 起草版定案，見 plan §1④）：gaps.json 逐欄枚舉。
export const GAPS_STATUS_ENUM = ['supported', 'degraded', 'not_supported', 'not_measured'];
export const GAPS_MEASURABILITY_ENUM = ['login_free', 'needs_auth', 'no_stable_interface'];

/** C4：驗一筆 gaps.json 條目是否合乎 schema。回 {valid, errors[]}。 */
export function validateGapEntry(entry) {
  const e = entry ?? {};
  const errors = [];
  if (typeof e.capability_id !== 'string' || !e.capability_id.trim()) errors.push('capability_id: 缺少或非字串');
  if (typeof e.harness !== 'string' || !e.harness.trim()) errors.push('harness: 缺少或非字串');
  if (!GAPS_STATUS_ENUM.includes(e.status)) errors.push(`status: 缺少或不在合法枚舉內（${GAPS_STATUS_ENUM.join('/')}）`);
  if (!GAPS_MEASURABILITY_ENUM.includes(e.measurability)) {
    errors.push(`measurability: 缺少或不在合法枚舉內（${GAPS_MEASURABILITY_ENUM.join('/')}）`);
  }
  if (!Array.isArray(e.gates_metrics)) errors.push('gates_metrics: 缺少或非陣列');
  if (typeof e.codex_interface !== 'string' || !e.codex_interface.trim()) errors.push('codex_interface: 缺少或非字串');
  if (!e.evidence || typeof e.evidence !== 'object' || typeof e.evidence.source !== 'string' || !e.evidence.source.trim()) {
    errors.push('evidence.source: 缺少或非字串');
  }
  if (typeof e.blocker !== 'string') errors.push('blocker: 缺少或非字串');
  if (typeof e.repro !== 'string' || !e.repro.trim()) errors.push('repro: 缺少或非字串');
  if (typeof e.x183_action !== 'string' || !e.x183_action.trim()) errors.push('x183_action: 缺少或非字串');
  return { valid: errors.length === 0, errors };
}

/** C4：驗整份 gaps.json（根層須為陣列＋每筆逐欄）。回 {valid, count, errors:[{index,capability_id,errors[]}]}。 */
export function validateGapsSchema(gaps) {
  if (!Array.isArray(gaps)) return { valid: false, count: 0, errors: [{ index: -1, capability_id: null, errors: ['gaps.json 根層須為陣列'] }] };
  const errors = [];
  gaps.forEach((entry, index) => {
    const r = validateGapEntry(entry);
    if (!r.valid) errors.push({ index, capability_id: entry?.capability_id ?? null, errors: r.errors });
  });
  return { valid: errors.length === 0, count: gaps.length, errors };
}

function defaultPlatformDiff() {
  return PLATFORM_DIFF_DIMENSIONS.map((dimension) => ({ dimension, status: 'not_measured', evidence: null }));
}

/**
 * R12：8 面向對映 gaps.json 逐列 status（走 PLATFORM_DIFF_GAP_ID 顯式常數表，非猜測）。
 * 面向在 gaps 裡找不到對應 capability_id → 該面向維持 not_measured 骨架（不硬湊、不假裝量到）。
 */
export function buildPlatformDiffFromGaps(gaps) {
  const byId = new Map((Array.isArray(gaps) ? gaps : []).map((g) => [g?.capability_id, g]));
  return PLATFORM_DIFF_DIMENSIONS.map((dimension) => {
    const gapId = PLATFORM_DIFF_GAP_ID[dimension];
    const entry = gapId ? byId.get(gapId) : undefined;
    if (!entry) return { dimension, status: 'not_measured', evidence: null };
    return {
      dimension,
      status: entry.status,
      evidence: entry.evidence?.source ? { source: entry.evidence.source, capability_id: entry.capability_id } : null,
    };
  });
}

/** yyyy/mm/dd → 8 碼 YYYYMMDD（UTC，避免時區導致跨日不穩定）。 */
export function formatDateYYYYMMDD(input) {
  const dt = input instanceof Date ? input : new Date(input);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** 不可變檔名：baseline-<date>-<sha8>.{json,md}（date 已是 8 碼字串、sha 取前 8 碼）。 */
export function reportFilenames(date, repoSha) {
  const sha8 = String(repoSha ?? '').slice(0, 8);
  const base = `baseline-${date}-${sha8}`;
  return { base, json: `${base}.json`, md: `${base}.md` };
}

/**
 * 組完整 C3 report。corpusReport＝baseline-corpus.mjs 的 buildCorpusReport 輸出；
 * traces＝已攤平的 C2 trace 物件陣列；gapsPresent＝C4 gaps.json 是否可用（只決定 gaps_ref，
 * codex 組指標仍固定 not_measured——不得靠推論 Claude 結果去猜 Codex）；gaps＝已驗證的 C4 陣列本體
 * （給了才能對映 R12 八面向；platformDiff 顯式傳入時優先於 gaps 推導，兩者皆缺 → 全 not_measured 骨架）。
 */
export function buildBaselineReport({
  repoSha,
  date,
  harnessVersions,
  env,
  corpusReport,
  traces,
  gapsPresent,
  gaps,
  platformDiff,
  corpusCmd,
  traceCmds,
  extraCaveats,
}) {
  const resolvedPlatformDiff = Array.isArray(platformDiff) && platformDiff.length
    ? platformDiff
    : (Array.isArray(gaps) && gaps.length ? buildPlatformDiffFromGaps(gaps) : defaultPlatformDiff());

  return {
    meta: {
      repo_sha: repoSha ?? null,
      date: date ?? null,
      harness_versions: {
        claude_code: harnessVersions?.claude_code ?? 'not_measured',
        codex: harnessVersions?.codex ?? 'not_measured',
      },
      env: env ?? {},
    },
    groups: {
      'claude-code': {
        quality: buildQualitySection(corpusReport),
        cost: buildCostSection(traces),
      },
      codex: {
        quality: 'not_measured',
        cost: 'not_measured',
        gaps_ref: gapsPresent ? 'evals/baseline/codex/gaps.json' : null,
      },
    },
    platform_diff: resolvedPlatformDiff,
    rerun: {
      corpus_cmd: corpusCmd ?? null,
      trace_cmds: Array.isArray(traceCmds) ? traceCmds : [],
      recapture_note: RECAPTURE_NOTE,
    },
    caveats: [SUBAGENT_LENS_CAVEAT, RECAPTURE_CAVEAT_REF, ...(Array.isArray(extraCaveats) ? extraCaveats : [])],
  };
}

function formatRate(rate) {
  return typeof rate === 'number' ? `${(rate * 100).toFixed(1)}%` : 'not_measured';
}

/** C3 → 人類可讀 markdown（雙 harness 分組表 + R12 八面向 + rerun + caveats）。 */
export function buildMarkdownReport(report) {
  const r = report ?? {};
  const q = r.groups?.['claude-code']?.quality ?? {};
  const c = r.groups?.['claude-code']?.cost ?? {};
  const lines = [
    `# Baseline Report — ${r.meta?.date ?? 'unknown-date'} (${r.meta?.repo_sha ?? 'unknown-sha'})`,
    '',
    '## claude-code 組',
    '',
    `- 意外失敗率（unexpected_fail_rate）：${formatRate(q.unexpected_fail_rate)}（${q.unexpected_fail_count ?? '?'}/${q.unexpected_fail_denominator ?? '?'}，分母已排除預期紅）`,
    `- 預期紅（expected_fail）：${q.expected_fail_count ?? 0} 筆 — refs: ${(q.expected_fail_refs ?? []).map((x) => x.id).join(', ') || '(無)'}`,
    `- fixture 總數：${q.total_fixtures ?? 0}`,
    `- cost.tokens：${JSON.stringify(c.tokens ?? 'not_measured')}`,
    `- cost.duration_ms：${JSON.stringify(c.duration_ms ?? 'not_measured')}`,
    '',
    '## codex 組',
    '',
    `- 全欄 not_measured（gaps_ref: ${r.groups?.codex?.gaps_ref ?? '（尚無）'}）`,
    '',
    '## R12 平台差異（8 面向）',
    '',
    ...(r.platform_diff ?? []).map((d) => `- ${d.dimension}: ${d.status}`),
    '',
    '## rerun',
    '',
    `- corpus: \`${r.rerun?.corpus_cmd ?? 'n/a'}\``,
    ...(r.rerun?.trace_cmds ?? []).map((cmd) => `- trace: \`${cmd}\``),
    `- recapture_note: ${r.rerun?.recapture_note ?? ''}`,
    '',
    '## caveats',
    '',
    ...(r.caveats ?? []).map((cv) => `- ${cv}`),
    '',
  ];
  return lines.join('\n');
}

// ── 薄 IO 層（被 import 時不執行）──────────────────────────────────────────────────

/** 讀 dir 下所有 *.json → 攤平：陣列展開併入、單一物件直接 push。壞檔跳過（誠實記，不崩）。 */
export function loadTraces(dir) {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.json'))
    .map((d) => d.name)
    .sort();

  const out = [];
  for (const name of names) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) out.push(...parsed);
    else if (parsed && typeof parsed === 'object') out.push(parsed);
  }
  return out;
}

/**
 * 寫不可變 report（json+md）：目標檔任一已存在 → 拒絕（不覆寫、不部分寫），回 {written:false, reason}。
 * 兩檔皆不存在才動筆，回 {written:true, jsonPath, mdPath}。
 */
export function writeReportFiles({ report, outDir, date, repoSha }) {
  const { json, md } = reportFilenames(date, repoSha);
  const jsonPath = join(outDir, json);
  const mdPath = join(outDir, md);
  if (existsSync(jsonPath) || existsSync(mdPath)) {
    return { written: false, reason: `report 已存在（不可變、拒絕覆寫）— ${existsSync(jsonPath) ? json : md}`, jsonPath, mdPath };
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(mdPath, buildMarkdownReport(report), 'utf8');
  return { written: true, jsonPath, mdPath };
}

function parseArgs(argv) {
  const opts = { corpus: null, tracesDir: null, gaps: null, repoSha: null, date: null, outDir: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--corpus') opts.corpus = argv[++i] ?? null;
    else if (a === '--traces-dir') opts.tracesDir = argv[++i] ?? null;
    else if (a === '--gaps') opts.gaps = argv[++i] ?? null;
    else if (a === '--repo-sha') opts.repoSha = argv[++i] ?? null;
    else if (a === '--date') opts.date = argv[++i] ?? null;
    else if (a === '--out-dir') opts.outDir = argv[++i] ?? null;
    else if (a === '--json') opts.json = true;
  }
  return opts;
}

const USAGE =
  'usage: node baseline-report.mjs --corpus <dir> --traces-dir <dir> --repo-sha <sha> --out-dir <dir> ' +
  '[--gaps <gaps.json>] [--date <YYYYMMDD>] [--json]';

function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.corpus || !opts.tracesDir || !opts.repoSha || !opts.outDir) {
    console.error(USAGE);
    return 2;
  }

  const corpusDir = resolve(opts.corpus);
  const tracesDir = resolve(opts.tracesDir);
  const outDir = resolve(opts.outDir);
  if (!existsSync(corpusDir)) {
    console.error(`baseline-report: corpus dir 不存在 — ${corpusDir}`);
    return 3;
  }

  const entries = loadCorpusFixtures(corpusDir);
  const results = entries.map((e) => evaluateFixture(e.fixture, corpusDir));
  const corpusReport = buildCorpusReport(results);
  const traces = loadTraces(tracesDir);
  const date = opts.date ?? formatDateYYYYMMDD(new Date());

  // C4：--gaps 給了就真的驗（非只檢查存在）——驗不過直接擋，不讓 report 假裝 gaps_ref 可信。
  // 驗證通過的 gapsData 本體會餵給 buildBaselineReport 做 R12 八面向對映（見 buildPlatformDiffFromGaps）。
  let gapsPresent = false;
  let gapsData = null;
  if (opts.gaps) {
    const gapsPath = resolve(opts.gaps);
    if (!existsSync(gapsPath)) {
      console.error(`baseline-report: --gaps 指定的檔案不存在 — ${gapsPath}`);
      return 3;
    }
    try {
      gapsData = JSON.parse(readFileSync(gapsPath, 'utf8'));
    } catch (err) {
      console.error(`baseline-report: --gaps 檔案不是合法 JSON — ${err?.message ?? err}`);
      return 3;
    }
    const validation = validateGapsSchema(gapsData);
    if (!validation.valid) {
      console.error(`baseline-report: gaps.json 未通過 C4 schema 驗證（${validation.errors.length}/${validation.count} 筆有問題）`);
      for (const e of validation.errors) console.error(`  - [${e.index}] ${e.capability_id ?? '(no id)'}: ${e.errors.join('; ')}`);
      return 1;
    }
    gapsPresent = true;
  }

  const report = buildBaselineReport({
    repoSha: opts.repoSha,
    date,
    corpusReport,
    traces,
    gapsPresent,
    gaps: gapsData,
    corpusCmd: `node plugins/loops-workflow/scripts/baseline-corpus.mjs --corpus ${opts.corpus} --json`,
    traceCmds: [`node plugins/loops-workflow/scripts/baseline-trace.mjs --scan-outcomes --loops-root <repo> --json`],
  });

  const result = writeReportFiles({ report, outDir, date, repoSha: opts.repoSha });
  if (!result.written) {
    console.error(`baseline-report: ${result.reason}`);
    return 1;
  }

  console.log(opts.json ? JSON.stringify({ ...result, report }, null, 2) : `written: ${result.jsonPath}\nwritten: ${result.mdPath}`);
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
