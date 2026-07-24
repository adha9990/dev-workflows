#!/usr/bin/env node
// baseline-corpus.mjs —— #169 baseline corpus runner（機制 A、契約 C1）。
// 讀 corpus 目錄下每個 fixture（C1 schema）→ 依 `oracle.type` 三軌分派判過不過：
//   quality-gate    → 重用既有 scoreTask + spawnGate（真跑 quality-gate，非重造 oracle）。
//   trajectory-rules→ 重用既有 checkTrajectory（純規則比對 observed Journal 階段序列）。
//   route-decision  → 本檔新增：expected_route 與 recorded_actual 嚴格比對，不符即紅
//                      （baseline 的價值是誠實記現況缺陷，不粉飾）。
// 三軌都是重跑斷言即得同結果的確定性判定，不重新生成候選。
//
// 分層（仿 scripts/eval-oracle.mjs）：
//   1) 純函式（無 IO，測試直接 import）：validateFixtureSchema / normalizeExpectedOutcome /
//      scoreRouteDecision / normalizeTrajectoryResult / scoreOracle / buildFixtureResult /
//      buildCorpusReport。
//   2) 薄 IO：resolveObservedStages（讀隨附 Journal 摘錄檔）/ resolveWorkspace（containment 守門）/
//      evaluateFixture（依型別 spawn quality-gate 或讀 observed_journal_file）/ loadCorpusFixtures /
//      CLI main —— 被 import 時不執行（import.meta.url 守門）。
// 依賴：僅 node 內建 + 既有兩支引擎的具名匯出（scoreTask/spawnGate/checkTrajectory；另借
//   parseStages 把 observed_journal 的 Journal 摘錄文字轉成階段陣列——checkTrajectory 本身只吃
//   陣列，parseStages 是 eval-trajectory 既有匯出，避免在本檔重造同一段正規表達式）。
//   不改 eval-oracle.mjs / eval-trajectory.mjs 本體、不裝任何外部套件。

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { scoreTask, spawnGate } from './eval-oracle.mjs';
import { checkTrajectory, parseStages } from './eval-trajectory.mjs';
import { isWithinRoot } from './path-containment.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../scripts
const PROJECT_ROOT = dirname(HERE); // plugin root：quality-gate workspace 的信任邊界

export const CATEGORY_ENUM = [
  'feature', 'bug', 'pr-review-verify', 'feedback-iterate', 'rule-change-maintainer',
  'resume', 'docs-only', 'high-risk', 'loop-243',
];
export const HARNESS_ENUM = ['claude-code', 'codex'];
export const ORACLE_TYPE_ENUM = ['quality-gate', 'trajectory-rules', 'route-decision'];
export const SOURCE_TYPE_ENUM = ['real-pr', 'real-loop', 'live-capture'];
export const EXPECTED_OUTCOME_ENUM = ['pass', 'expected-fail'];

// ── 純函式層（無 IO，測試直接 import）─────────────────────────────────────────────

/** 驗 fixture 是否合乎 C1 必填欄（含 oracle.type 逐型 config 定形）。回 {valid, errors[]}。 */
export function validateFixtureSchema(fixture) {
  const f = fixture ?? {};
  const errors = [];

  if (typeof f.id !== 'string' || !f.id.trim()) errors.push('id: 缺少或非字串');
  if (!CATEGORY_ENUM.includes(f.category)) errors.push(`category: 缺少或不在合法枚舉內（${CATEGORY_ENUM.join('/')}）`);
  if (!Array.isArray(f.harness) || f.harness.length === 0 || !f.harness.every((h) => HARNESS_ENUM.includes(h))) {
    errors.push(`harness: 缺少或含不合法值（僅允許 ${HARNESS_ENUM.join('/')}）`);
  }

  const prov = f.provenance;
  if (!prov || typeof prov !== 'object') {
    errors.push('provenance: 缺少');
  } else {
    if (!SOURCE_TYPE_ENUM.includes(prov.source_type)) {
      errors.push(`provenance.source_type: 缺少或不在合法枚舉內（${SOURCE_TYPE_ENUM.join('/')}）`);
    }
    if (typeof prov.ref !== 'string' || !prov.ref.trim()) errors.push('provenance.ref: 缺少或非字串');
    if (typeof prov.captured_at !== 'string' || !prov.captured_at.trim()) errors.push('provenance.captured_at: 缺少或非字串');
    if (typeof prov.method !== 'string' || !prov.method.trim()) errors.push('provenance.method: 缺少或非字串');
  }

  const oracle = f.oracle;
  if (!oracle || typeof oracle !== 'object') {
    errors.push('oracle: 缺少');
  } else if (!ORACLE_TYPE_ENUM.includes(oracle.type)) {
    errors.push(`oracle.type: 缺少或不在合法枚舉內（${ORACLE_TYPE_ENUM.join('/')}）`);
  } else {
    errors.push(...validateOracleConfig(oracle.type, oracle.config));
  }

  if (f.nondeterminism === undefined || f.nondeterminism === null) errors.push('nondeterminism: 缺少');
  if (typeof f.replay_cmd !== 'string' || !f.replay_cmd.trim()) errors.push('replay_cmd: 缺少或非字串');
  if (f.expected_outcome !== undefined && !EXPECTED_OUTCOME_ENUM.includes(f.expected_outcome)) {
    errors.push(`expected_outcome: 若指定須為 ${EXPECTED_OUTCOME_ENUM.join('/')}`);
  }

  return { valid: errors.length === 0, errors };
}

function validateOracleConfig(type, config) {
  const c = config ?? {};
  const errors = [];
  if (type === 'quality-gate') {
    if (typeof c.workspace !== 'string' || !c.workspace.trim()) errors.push('oracle.config.workspace: 缺少或非字串');
    if (!Array.isArray(c.failToPass) && !Array.isArray(c.passToPass)) {
      errors.push('oracle.config: failToPass/passToPass 至少要有一個陣列');
    }
  } else if (type === 'trajectory-rules') {
    if (!c.reference || typeof c.reference !== 'object') errors.push('oracle.config.reference: 缺少');
    if (typeof c.observed_journal !== 'string' && !Array.isArray(c.observed_journal) && typeof c.observed_journal_file !== 'string') {
      errors.push('oracle.config: observed_journal（內嵌文字或已解析陣列）或 observed_journal_file（隨附檔）至少要有一個');
    }
  } else if (type === 'route-decision') {
    if (typeof c.expected_route !== 'string' || !c.expected_route.trim()) errors.push('oracle.config.expected_route: 缺少或非字串');
    if (typeof c.recorded_actual !== 'string' || !c.recorded_actual.trim()) errors.push('oracle.config.recorded_actual: 缺少或非字串');
  }
  return errors;
}

/** C1：expected_outcome 缺省＝'pass'；只有顯式 'expected-fail' 才算誠實紅。 */
export function normalizeExpectedOutcome(fixture) {
  return fixture?.expected_outcome === 'expected-fail' ? 'expected-fail' : 'pass';
}

/** route-decision 型：expected_route 與 recorded_actual 嚴格比對，不符即紅（不粉飾現況）。 */
export function scoreRouteDecision(oracleConfig) {
  const expected = oracleConfig?.expected_route;
  const actual = oracleConfig?.recorded_actual;
  const bothPresent = typeof expected === 'string' && typeof actual === 'string';
  const pass = bothPresent && expected === actual;
  return {
    pass,
    errored: !bothPresent,
    expected_route: expected ?? null,
    recorded_actual: actual ?? null,
    reason: !bothPresent
      ? 'oracle.config 缺 expected_route/recorded_actual — 無從比對'
      : pass
        ? 'recorded_actual 與 expected_route 相符'
        : `route 不符：expected_route="${expected}"，recorded_actual="${actual}"`,
  };
}

/** 把 checkTrajectory 的 {ok,...} 正規化成本檔統一的 {pass, errored, reason,...} 結果信封。 */
export function normalizeTrajectoryResult(result) {
  const r = result ?? {};
  const pass = r.ok === true;
  const parts = [];
  if (r.missing?.length) parts.push(`漏階段: ${r.missing.join(', ')}`);
  if (r.forbidden?.length) parts.push(`禁止階段出現: ${r.forbidden.join(', ')}`);
  if (r.orderViolations?.length) {
    parts.push(`順序違反: ${r.orderViolations.map((p) => p.join('→應早於→')).join('; ')}`);
  }
  return {
    pass,
    errored: false, // 規則比對永遠「有跑」，不像 quality-gate 有 unobserved 態
    missing: r.missing ?? [],
    extra: r.extra ?? [],
    forbidden: r.forbidden ?? [],
    orderViolations: r.orderViolations ?? [],
    reason: pass
      ? `trajectory ok${r.extra?.length ? `（多餘步：${r.extra.join(', ')}）` : ''}`
      : parts.join('; ') || 'trajectory not ok',
  };
}

/**
 * 三軌分派（純函式：IO 結果已由呼叫端先取得再傳入）。
 * ioInputs：quality-gate 用 {gateResult}；trajectory-rules 用 {observedStages}；route-decision 不需要。
 */
export function scoreOracle(oracleType, oracleConfig, ioInputs = {}) {
  if (oracleType === 'quality-gate') return scoreTask(ioInputs.gateResult, oracleConfig);
  if (oracleType === 'trajectory-rules') {
    if (!Array.isArray(ioInputs.observedStages)) {
      return { pass: false, errored: true, reason: 'observed_journal 無法解析成階段陣列 — 未驗到' };
    }
    return normalizeTrajectoryResult(checkTrajectory(ioInputs.observedStages, oracleConfig?.reference));
  }
  if (oracleType === 'route-decision') return scoreRouteDecision(oracleConfig);
  return { pass: false, errored: true, reason: `unknown oracle.type "${oracleType}"` };
}

/** 組單一 fixture 的最終結果（passthrough id/category/harness/expectedOutcome + 判定 + 原始 detail）。 */
export function buildFixtureResult(fixture, scored) {
  return {
    id: fixture?.id ?? null,
    category: fixture?.category ?? null,
    harness: Array.isArray(fixture?.harness) ? fixture.harness : [],
    oracleType: fixture?.oracle?.type ?? null,
    expectedOutcome: normalizeExpectedOutcome(fixture),
    pass: scored?.pass === true,
    errored: scored?.errored === true,
    reason: typeof scored?.reason === 'string' ? scored.reason : '(no reason)',
    detail: scored ?? null,
  };
}

/** 聚合 per-fixture 結果 → {total, passed, failed, tasks}（errored 計入 failed，非 passed）。 */
export function buildCorpusReport(results) {
  const tasks = Array.isArray(results) ? results : [];
  const passed = tasks.filter((r) => r?.pass === true).length;
  return { total: tasks.length, passed, failed: tasks.length - passed, tasks };
}

// ── 薄 IO 層（被 import 時不執行）──────────────────────────────────────────────────

// 只吃 `## Journal` 區段再交給 parseStages——沿用 eval-trajectory.mjs 的 readObservedStages 同一策略
// （避免摘錄檔上半部的方法論說明文字裡示範用的 `[stagename]` 之類佔位方括號被誤抽成階段；
// 無 `## Journal` 標題則退回全文，與既有引擎行為一致）。
function stagesFromJournalText(text) {
  const idx = text.indexOf('## Journal');
  return parseStages(idx >= 0 ? text.slice(idx) : text);
}

/**
 * 解出 trajectory-rules 的 observed 階段陣列：優先吃內嵌陣列 → `observed_journal` 字串（C1：
 * 「內嵌或隨附」同一欄位兩種寫法——先試著當隨附檔路徑解析，檔案真的存在就讀檔內容再
 * stagesFromJournalText；不存在才把字串本身當內嵌 Journal 文字直接 stagesFromJournalText）→
 * 明確 `observed_journal_file` 欄（額外的顯式別名，向後相容）。讀不到回 null，不丟例外。
 * fixture 自足、不引 .loops 活路徑。
 */
export function resolveObservedStages(oracleConfig, fixtureDir) {
  const embedded = oracleConfig?.observed_journal;
  if (Array.isArray(embedded)) return embedded;
  if (typeof embedded === 'string' && embedded.trim()) {
    const asPath = resolve(fixtureDir, embedded);
    if (existsSync(asPath)) {
      try {
        return stagesFromJournalText(readFileSync(asPath, 'utf8'));
      } catch {
        return null;
      }
    }
    return stagesFromJournalText(embedded);
  }

  const filePath = oracleConfig?.observed_journal_file;
  if (typeof filePath === 'string' && filePath.trim()) {
    try {
      const abs = resolve(fixtureDir, filePath);
      return stagesFromJournalText(readFileSync(abs, 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

/** 解析並守門 quality-gate workspace：相對 fixtureDir 解析後須落在 PROJECT_ROOT 內，否則拒絕（不 spawn）。 */
function resolveWorkspace(requested, fixtureDir) {
  if (typeof requested !== 'string' || isAbsolute(requested)) {
    return { ok: false, reason: `workspace "${requested}" 是絕對路徑（拒絕；須落在 plugin 根內）— 未執行` };
  }
  const workspace = resolve(fixtureDir, requested);
  if (!isWithinRoot(workspace, PROJECT_ROOT)) {
    return { ok: false, reason: `workspace "${requested}" 解析後落在 plugin 根外（路徑逃逸拒絕）— 未執行` };
  }
  return { ok: true, workspace };
}

/** 評一個 fixture：先驗 schema，型別合法才依型別做必要 IO 並交給 scoreOracle 判定。 */
export function evaluateFixture(fixture, fixtureDir) {
  const schema = validateFixtureSchema(fixture);
  if (!schema.valid) {
    return buildFixtureResult(fixture, { pass: false, errored: true, reason: `schema 不合法 — ${schema.errors.join('; ')}` });
  }

  const oracleType = fixture.oracle.type;
  const config = fixture.oracle.config ?? {};

  if (oracleType === 'quality-gate') {
    const ws = resolveWorkspace(config.workspace, fixtureDir);
    if (!ws.ok) {
      return buildFixtureResult(fixture, { pass: false, errored: true, reason: ws.reason });
    }
    return buildFixtureResult(fixture, scoreOracle(oracleType, config, { gateResult: spawnGate(ws.workspace) }));
  }

  if (oracleType === 'trajectory-rules') {
    const observedStages = resolveObservedStages(config, fixtureDir);
    return buildFixtureResult(fixture, scoreOracle(oracleType, config, { observedStages }));
  }

  // route-decision：純比對，無需額外 IO。
  return buildFixtureResult(fixture, scoreOracle(oracleType, config, {}));
}

/** 讀 dir 下所有 *.json（非 .json 忽略；子目錄不遞迴）→ [{fixture, file}]，穩定排序。 */
export function loadCorpusFixtures(dir) {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.json'))
    .map((d) => d.name)
    .sort();

  return names.map((name) => {
    const raw = readFileSync(join(dir, name), 'utf8');
    try {
      return { fixture: JSON.parse(raw), file: name };
    } catch (err) {
      throw new Error(`loadCorpusFixtures: invalid JSON in ${name}: ${err?.message ?? err}`);
    }
  });
}

// --corpus/--task 是 T1 fixture 的 replay_cmd 實際採用的拼法（workflow-engineer 10 個 fixture
// 一致選用）；--dir/--fixture 是本檔最初設計拼法，兩邊都收，兩套名字互為別名、行為完全相同。
function parseArgs(argv) {
  const opts = { dir: null, fixture: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dir' || flag === '--corpus') opts.dir = argv[++i] ?? null;
    else if (flag === '--fixture' || flag === '--task') opts.fixture = argv[++i] ?? null;
    else if (flag === '--json') opts.json = true;
  }
  return opts;
}

function formatTextReport(report) {
  const lines = [`baseline-corpus: ${report.passed}/${report.total} passed (${report.failed} failed)`];
  for (const t of report.tasks) {
    const mark = t.pass ? '✓' : t.errored ? '⚠' : '✗';
    lines.push(`  ${mark} ${t.id ?? '(no id)'} [${t.oracleType ?? 'n/a'}/${t.expectedOutcome}] ${t.reason}`);
  }
  return lines.join('\n');
}

function main(rawArgv) {
  const opts = parseArgs(rawArgv);
  if (!opts.dir) {
    console.error('usage: node baseline-corpus.mjs --dir|--corpus <corpus-dir> [--fixture|--task <id>] [--json]');
    process.exit(1);
  }

  const corpusDir = resolve(opts.dir);
  if (!existsSync(corpusDir)) {
    console.error(`baseline-corpus: corpus dir 不存在 — ${corpusDir}`);
    process.exit(1);
  }

  const entries = loadCorpusFixtures(corpusDir);
  const filtered = opts.fixture ? entries.filter((e) => e.fixture?.id === opts.fixture) : entries;
  if (opts.fixture && filtered.length === 0) {
    console.error(`baseline-corpus: no fixture matched --fixture "${opts.fixture}" in ${corpusDir}`);
    process.exit(2);
  }

  const results = filtered.map((e) => evaluateFixture(e.fixture, corpusDir));
  const report = buildCorpusReport(results);

  console.log(opts.json ? JSON.stringify(report, null, 2) : formatTextReport(report));
  process.exit(report.failed > 0 ? 1 : 0);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err?.message ?? String(err));
    process.exit(1);
  }
}
