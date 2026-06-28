#!/usr/bin/env node
// eval-judge.mjs —— eval E4：eval-judge（issue #32）。為「無可執行 ground truth 的維度」
// （解釋/溝通品質）提供 single-answer rubric judge 的**可確定性測**部分：
//   驗 rubric（鎖死步驟 + scale/threshold）、tolerant 解析 judge 已產出的 verdict、
//   門檻為準推導 pass、標 track:'judge-estimate' 分軌、落獨立 judge-results.jsonl。
//
// 混合架構（issue #32 拍板）：**本 script 不 spawn judge agent**（plugin script 無此能力）。
//   judge 的 LLM 調用由主迴圈/Workflow 在 verify/eval 流程派（像現有 reviewer agent，見
//   agents/eval-judge.md）；script 只做離線可測的解析/驗證/分軌。
//
// 分軌（Metric-Honesty）：judge 分數帶 track:'judge-estimate'、落獨立 judge-results.jsonl，
//   **絕不**進 eval-metrics 的 passRate 回歸 gate（那只讀 eval-results.jsonl 的確定性 oracle 結果）。
//
// 分層（仿 eval-oracle / eval-trajectory）：
//   1) 純函式（無 IO，測試直接 import）：parseVerdict / parseRubricMeta / validateRubric /
//      validateVerdict / buildJudgeRecord / partitionByTrack / rotateLines。
//   2) 薄 IO 邊界：appendJudgeRecord（落檔）與 CLI main —— 被 import 時不執行（import.meta.url 守門）。
// 依賴：僅 node 內建（fs / path / url），零外部套件。
// 用法：
//   node eval-judge.mjs validate-rubric <rubric.md>
//   node eval-judge.mjs parse --rubric <rubric.md> --output <judge-out.json|-> [--judge-file <path>] [--judge-id <id>] [--model <name>]

import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const JUDGE_TRACK = 'judge-estimate'; // judge 分數的軌；永不 'measured'
const DEFAULT_JUDGE_PATH = ['.loops', '.metrics', 'judge-results.jsonl']; // 相對 cwd 預設落點（沿用 .loops/.metrics/）
const MAX_JUDGE_ROWS = 1000; // judge-results.jsonl rotation 上限（仿 eval-metrics，防無界成長）

// ── 純函式層：verdict 解析 ────────────────────────────────────────────────────────

/**
 * tolerant 解析 judge 輸出 → { score, pass, reasoning, dimension?, parseOk, parseError? }。
 * 三段降級：fenced ```json → 直接 JSON.parse 全文 → 首個平衡 {...}。皆失敗 → parseOk:false（不丟例外）。
 * score 僅接受真數字（字串 "high" / null / 缺 → null）；pass 僅接受 boolean（否則 null）。
 */
export function parseVerdict(raw) {
  const obj = extractJsonObject(typeof raw === 'string' ? raw : '');
  if (!obj) {
    return { score: null, pass: null, reasoning: '', parseOk: false, parseError: 'no JSON object found' };
  }
  const out = {
    score: coerceNumber(obj.score),
    pass: typeof obj.pass === 'boolean' ? obj.pass : null,
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
    parseOk: true,
  };
  if (typeof obj.dimension === 'string') out.dimension = obj.dimension;
  return out;
}

function extractJsonObject(text) {
  if (!text) return null;
  // 1) fenced code block：線性 indexOf 掃描（避開 regex 的 `\s*`+lazy 回溯），且**優先 ```json 標籤**
  //    的 fence，再退無標籤 fence —— judge 若先吐非 json fence、後吐真 verdict，仍抓到 json 那塊。
  const fromFence = extractFromFences(text);
  if (fromFence) return fromFence;
  // 2) 直接 parse 全文（clean JSON）
  const direct = tryParseObject(text);
  if (direct) return direct;
  // 3) 首個平衡 {...}（prose 包夾）
  const balanced = firstBalancedObject(text);
  return balanced ? tryParseObject(balanced) : null;
}

/** 線性掃出所有 ``` fence；先試帶 `json` 標籤者、全失敗再試無標籤者。O(n)、無 regex 回溯。 */
function extractFromFences(text) {
  const tagged = [];
  const untagged = [];
  let i = 0;
  for (;;) {
    const open = text.indexOf('```', i);
    if (open < 0) break;
    const afterTicks = open + 3;
    const close = text.indexOf('```', afterTicks);
    if (close < 0) break; // 無閉合 fence → 不再有完整區塊可抽
    const nl = text.indexOf('\n', afterTicks);
    const hasLangLine = nl >= 0 && nl < close;
    const lang = (hasLangLine ? text.slice(afterTicks, nl) : '').trim().toLowerCase();
    const content = text.slice(hasLangLine ? nl + 1 : afterTicks, close);
    (lang === 'json' ? tagged : untagged).push(content);
    i = close + 3;
  }
  for (const content of [...tagged, ...untagged]) {
    const obj = tryParseObject(content);
    if (obj) return obj;
  }
  return null;
}

function tryParseObject(s) {
  try {
    const v = JSON.parse(String(s).trim());
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** 從首個 '{' 起算大括號平衡（跳過字串內的括號），回傳該平衡子字串或 null。 */
function firstBalancedObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function coerceNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ── 純函式層：rubric 解析 + 驗證 ──────────────────────────────────────────────────

/**
 * 抽 rubric 的扁平 YAML frontmatter 純量（regex，仿 instinct）+ 數 ## Evaluation steps 下的編號步驟。
 * → { dimension, scaleMin, scaleMax, threshold, schema, stepCount }（缺/壞 → 對應欄 null / 0）。
 */
export function parseRubricMeta(text) {
  const t = typeof text === 'string' ? text : '';
  const fm = t.match(/^---\s*\n([\s\S]*?)\n---/);
  const front = fm ? fm[1] : '';
  // 純量用水平空白 [ \t]（非 \s —— \s 含 \n，會在空值時跨行把下一行內容誤抽為值）。
  return {
    dimension: matchStr(front, /^dimension:[ \t]*(.+?)[ \t]*$/m),
    scaleMin: matchInt(front, /^scale_min:[ \t]*(-?\d+)[ \t]*$/m),
    scaleMax: matchInt(front, /^scale_max:[ \t]*(-?\d+)[ \t]*$/m),
    threshold: matchInt(front, /^threshold:[ \t]*(-?\d+)[ \t]*$/m),
    schema: matchInt(front, /^schema:[ \t]*(-?\d+)[ \t]*$/m),
    stepCount: countSteps(t),
  };
}

function matchStr(text, re) {
  const m = text.match(re);
  const val = m ? m[1].trim() : '';
  return val ? val : null;
}

function matchInt(text, re) {
  const m = text.match(re);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** 數 ## Evaluation steps 之後的 `<n>.` 編號步驟（鎖死步驟存在性檢查）。 */
function countSteps(text) {
  const idx = text.indexOf('## Evaluation steps');
  if (idx < 0) return 0;
  const matches = text.slice(idx).match(/^\s*\d+\.\s+\S/gm);
  return matches ? matches.length : 0;
}

/**
 * 驗 rubric meta → { valid, reasons[] }：dimension 非空 ＆ 整數 scaleMin<scaleMax ＆
 * scaleMin≤threshold≤scaleMax ＆ stepCount≥3（鎖死步驟）。
 */
export function validateRubric(meta) {
  const m = meta || {};
  const reasons = [];
  if (!m.dimension || typeof m.dimension !== 'string' || !m.dimension.trim()) reasons.push('dimension 缺或空');
  const hasScale = Number.isInteger(m.scaleMin) && Number.isInteger(m.scaleMax);
  if (!hasScale) reasons.push('scale_min/scale_max 非整數');
  else if (m.scaleMin >= m.scaleMax) reasons.push('scale_min 必須 < scale_max');
  if (!Number.isInteger(m.threshold)) reasons.push('threshold 非整數');
  else if (hasScale && (m.threshold < m.scaleMin || m.threshold > m.scaleMax)) reasons.push('threshold 不在 [scale_min, scale_max]');
  if (!(m.stepCount >= 3)) reasons.push('Evaluation steps 須 ≥3 條編號步驟（鎖死防漂移）');
  return { valid: reasons.length === 0, reasons };
}

// ── 純函式層：verdict 驗證（門檻為準）+ record 組裝 + 分軌 ─────────────────────────

/**
 * 對 verdict 套 rubric 的 scale/threshold → 加 scoreInRange / pass（門檻推導，覆蓋自報）/
 * passMismatch（自報非 null 且 ≠ 推導）/ valid（parseOk ＆ scoreInRange）。門檻為準把「分數→pass」變確定。
 */
export function validateVerdict(verdict, params) {
  const v = verdict || {};
  const { scaleMin, scaleMax, threshold, dimension } = params || {};
  const score = typeof v.score === 'number' && Number.isFinite(v.score) ? v.score : null;
  const scoreInRange = score !== null
    && Number.isFinite(scaleMin) && Number.isFinite(scaleMax)
    && score >= scaleMin && score <= scaleMax;
  // pass 必須先「分數落在量表內」才談門檻——越界分數（如 1–5 量表給 99）不可能 pass。
  // 不這樣 gate 的話 record 會出現 pass:true 但 valid:false 的自相矛盾，下游若只 filter(pass) 漏看 valid 就算進垃圾。
  const derivedPass = scoreInRange && Number.isFinite(threshold) && score >= threshold;
  const selfPass = typeof v.pass === 'boolean' ? v.pass : null;
  // dimension 比照 pass：**rubric 為權威**；judge 自報不一致 → 標 dimensionMismatch 留痕（dimension 是 #33 聚合的分組鍵，不能靜默信 judge）。
  const judgeDim = typeof v.dimension === 'string' && v.dimension ? v.dimension : null;
  const rubricDim = typeof dimension === 'string' && dimension ? dimension : null;
  return {
    ...v,
    dimension: rubricDim ?? judgeDim ?? null, // rubric 權威優先；無 rubric dimension 時才退 judge 自報
    score,
    scoreInRange,
    pass: derivedPass,
    passMismatch: selfPass !== null && selfPass !== derivedPass,
    dimensionMismatch: judgeDim !== null && rubricDim !== null && judgeDim !== rubricDim,
    valid: v.parseOk === true && scoreInRange,
  };
}

/**
 * 組 judge record。track 硬編 'judge-estimate'（**永不採信外部塞的 track**）；攜 judgeId/model/ts
 * 給 #33 PoLL/κ 在 record 陣列上聚合（forward-compat）。
 */
export function buildJudgeRecord(validated, meta) {
  const v = validated || {};
  const m = meta || {};
  return {
    ts: m.ts ?? null,
    dimension: v.dimension ?? null,
    judgeId: m.judgeId ?? null,
    model: m.model ?? null,
    score: v.score ?? null,
    pass: v.pass === true,
    scoreInRange: v.scoreInRange === true,
    passMismatch: v.passMismatch === true,
    dimensionMismatch: v.dimensionMismatch === true,
    reasoning: typeof v.reasoning === 'string' ? v.reasoning : '',
    parseOk: v.parseOk === true,
    valid: v.valid === true,
    track: JUDGE_TRACK,
    schema: 1,
  };
}

/** 依 track 分軌 → { measured, judgeEstimate }（其他 track 不混入兩軌；#33 聚合前用此隔離）。 */
export function partitionByTrack(records) {
  const list = Array.isArray(records) ? records : [];
  return {
    measured: list.filter((r) => r?.track === 'measured'),
    judgeEstimate: list.filter((r) => r?.track === JUDGE_TRACK),
  };
}

/** 超過 cap 保留最後 cap 行（純函式，仿 eval-metrics rotateLines）。 */
export function rotateLines(lines, cap) {
  const arr = Array.isArray(lines) ? lines : [];
  if (!Number.isFinite(cap) || cap <= 0 || arr.length <= cap) return arr;
  return arr.slice(arr.length - cap);
}

// ── 薄 IO 邊界：落檔 + CLI（被 import 時不執行）────────────────────────────────────

/**
 * append 一行 JSON 進 judge-results.jsonl，再 append-then-rotate 保留最後 cap 行。
 * 非原子（讀-改-寫；單機 dev-tool 可接受，與 eval-metrics 同取捨——此處「仿 eval-metrics」指 rotation 模式）。
 * **錯誤契約（與孿生 appendEvalRow 不同，注意）**：本函式**會把 IO 失敗往外丟**（不自吞），由 caller 決定是否擋路；
 * CLI `cmdParse` 用 try/catch 接住 → 落檔失敗仍印 record + exit 0（達成 advisory 永不擋路）。
 * 未來 importer（如 #33）若需「永不丟」語意，請自行包 try/catch。
 */
export function appendJudgeRecord(file, record, cap = MAX_JUDGE_ROWS) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`);
  const lines = readFileSync(file, 'utf8').split('\n').filter((ln) => ln.trim());
  const kept = rotateLines(lines, cap);
  if (kept.length !== lines.length) writeFileSync(file, `${kept.join('\n')}\n`);
}

const USAGE = [
  'usage:',
  '  node eval-judge.mjs validate-rubric <rubric.md>',
  '  node eval-judge.mjs parse --rubric <rubric.md> --output <judge-out.json|-> [--judge-file <path>] [--judge-id <id>] [--model <name>]',
].join('\n');

function parseArgs(argv) {
  const opts = { rubric: null, output: null, judgeFile: null, judgeId: 'judge', model: 'unknown' };
  for (let i = 0; i < argv.length; i += 1) {
    const f = argv[i];
    if (f === '--rubric') opts.rubric = argv[++i] ?? null;
    else if (f === '--output') opts.output = argv[++i] ?? null;
    else if (f === '--judge-file') opts.judgeFile = argv[++i] ?? null;
    else if (f === '--judge-id') opts.judgeId = argv[++i] ?? opts.judgeId;
    else if (f === '--model') opts.model = argv[++i] ?? opts.model;
  }
  return opts;
}

function readText(path) {
  return path === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(path), 'utf8');
}

function cmdValidateRubric(argv) {
  const path = argv[0];
  if (!path) { console.error(USAGE); process.exit(2); }
  let text;
  try { text = readText(path); }
  catch (err) { console.error(`validate-rubric: 讀檔失敗 ${path}: ${err?.message ?? err}`); process.exit(3); }
  const result = validateRubric(parseRubricMeta(text));
  if (result.valid) { console.log(`✓ rubric valid: ${path}`); process.exit(0); }
  console.error(`✗ rubric invalid: ${path}\n  - ${result.reasons.join('\n  - ')}`);
  process.exit(1);
}

function cmdParse(argv) {
  const opts = parseArgs(argv);
  if (!opts.rubric || !opts.output) { console.error(USAGE); process.exit(2); }
  let rubricText;
  try { rubricText = readText(opts.rubric); }
  catch (err) { console.error(`parse: rubric 讀檔失敗 ${opts.rubric}: ${err?.message ?? err}`); process.exit(3); }
  let outputText;
  try { outputText = readText(opts.output); }
  catch (err) { console.error(`parse: judge 輸出讀檔失敗 ${opts.output}: ${err?.message ?? err}`); process.exit(3); }

  const meta = parseRubricMeta(rubricText);
  const verdict = parseVerdict(outputText);
  // dimension 走 params 由 validateVerdict 以 rubric 為權威解析（並標 dimensionMismatch），不在此 pre-merge。
  const validated = validateVerdict(verdict, {
    scaleMin: meta.scaleMin, scaleMax: meta.scaleMax, threshold: meta.threshold, dimension: meta.dimension,
  });
  const record = buildJudgeRecord(validated, { judgeId: opts.judgeId, model: opts.model, ts: new Date().toISOString() });

  // 落檔（拍板：parse 也落檔）。落檔失敗不擋路：仍印 record + exit 0，但 stderr 診斷（永不擋路 ≠ 永不出聲）。
  const judgeFile = opts.judgeFile ? resolve(opts.judgeFile) : resolve(...DEFAULT_JUDGE_PATH);
  try { appendJudgeRecord(judgeFile, record); }
  catch (err) { console.error(`parse: 落檔失敗 ${judgeFile}: ${err?.message ?? err}（record 仍輸出）`); }

  // verdict 即使 invalid（越界/壞）也照印 record（誠實標 valid/parseOk）並 exit 0 —— judge 是 advisory、永不擋路。
  console.log(JSON.stringify(record));
  process.exit(0);
}

function main(argv) {
  const cmd = argv[0];
  if (cmd === 'validate-rubric') return cmdValidateRubric(argv.slice(1));
  if (cmd === 'parse') return cmdParse(argv.slice(1));
  console.error(`unknown command: ${cmd ?? '(none)'}\n${USAGE}`);
  process.exit(2);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try { main(process.argv.slice(2)); }
  catch (err) { console.error(err?.message ?? String(err)); process.exit(3); }
}
