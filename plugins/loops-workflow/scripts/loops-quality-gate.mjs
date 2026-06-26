#!/usr/bin/env node
// loops-quality-gate.mjs —— 跑 test / lint / type 三道閘並把各家 reporter 正規化成統一 Failure 清單。
// 分層：
//   1) 解析 / 判定層（純函式，無 IO）：parseConfig / parseVitest / parseEslint / parseTsc /
//      dedupeFailures / classifyGate / buildResult / formatSummary —— 給單元測試直接 import。
//   2) IO 薄邊界：resolveConfig（讀 config 檔）與 CLI main（spawn 子程序、讀暫存檔）——
//      main 被 import 時不執行（import.meta.url 守門）。
// 依賴：僅 node 內建（child_process / fs / path / os / url），無外部套件。
// 用法：node loops-quality-gate.mjs [--cwd <dir>] [--gates test,lint,type] [--json]
//        [--continue-on-failure] [--max-failures <n>] [--tail <n>]

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_MAX_FAILURES = 160;
const DEFAULT_TAIL_CHARS = 80000;
const GATE_ORDER = ['test', 'lint', 'type'];
const BLOCKING_GATE_STATES = new Set(['failed', 'errored']);

// ── 解析 / 判定層（純函式，無 IO，測試直接 import）──────────────────────────────

/**
 * 解析 gate.config.json 內容字串 → 三道閘指令字串（純函式，無 IO）。
 * 非法 JSON / 非物件 / 某鍵非字串 → 該鍵回 null（呼叫端據此走自動偵測或標 not-run）。
 */
export function parseConfig(rawString) {
  const blank = { test: null, lint: null, type: null };
  const parsed = parseJsonMaybe(rawString);
  if (!parsed || typeof parsed !== 'object') return blank;
  return {
    test: asCommand(parsed.test),
    lint: asCommand(parsed.lint),
    type: asCommand(parsed.type),
  };
}

/**
 * vitest --reporter=json → 只挑 status==="failed" 的 assertion，正規化成 test 類 Failure。
 * file 取自所屬 testResults[].name；message 前綴 title 路徑方便人辨識，再接 failureMessages。
 */
export function parseVitest(rawJsonString) {
  const report = parseJsonMaybe(rawJsonString);
  const suites = Array.isArray(report?.testResults) ? report.testResults : [];

  const failures = [];
  for (const suite of suites) {
    const file = typeof suite?.name === 'string' ? suite.name : '';
    const assertions = Array.isArray(suite?.assertionResults) ? suite.assertionResults : [];
    for (const a of assertions) {
      if (a?.status !== 'failed') continue;
      failures.push({
        kind: 'test',
        severity: 'error',
        file,
        line: a?.location?.line,
        column: a?.location?.column,
        message: buildVitestMessage(a),
      });
    }
  }
  return failures;
}

/**
 * eslint -f json → 攤平每個 messages[] 成一筆 lint 類 Failure；severity 2→error、其餘→warning。
 * 乾淨檔（messages:[]）自然不貢獻任何 Failure。
 */
export function parseEslint(rawJsonString) {
  const report = parseJsonMaybe(rawJsonString);
  if (!Array.isArray(report)) return [];

  const failures = [];
  for (const entry of report) {
    const file = typeof entry?.filePath === 'string' ? entry.filePath : '';
    const messages = Array.isArray(entry?.messages) ? entry.messages : [];
    for (const m of messages) {
      failures.push({
        kind: 'lint',
        severity: m?.severity === 2 ? 'error' : 'warning',
        file,
        line: m?.line,
        column: m?.column,
        ruleId: m?.ruleId ?? null,
        message: typeof m?.message === 'string' ? m.message : '',
      });
    }
  }
  return failures;
}

const TSC_DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;

/**
 * tsc --noEmit 診斷文字 → 逐行抓 `file(line,col): error|warning TSxxxx: msg`；
 * npm preamble、`Found N errors` 摘要等非配對行一律略過。severity 依 error/warning 分流。
 */
export function parseTsc(rawText) {
  if (typeof rawText !== 'string') return [];

  const failures = [];
  for (const line of rawText.split(/\r?\n/)) {
    const m = line.match(TSC_DIAGNOSTIC);
    if (!m) continue;
    const [, file, lineNo, column, severity, code, message] = m;
    failures.push({
      kind: 'type',
      severity,
      file,
      line: Number(lineNo),
      column: Number(column),
      code,
      message,
    });
  }
  return failures;
}

/**
 * 去重後依 cap 截斷。去重指紋：kind+file+line+(code/ruleId)；
 * 若該筆無 code/ruleId（多為 test 失敗），退而納入 column+message，避免同 file:line 的
 * 相異失敗被誤併（反過來：同 code/ruleId 的不同 message 仍視為同一筆 → 收斂）。
 * truncated 只代表「因 cap 砍掉了東西」，去重收斂不算截斷。
 */
export function dedupeFailures(failures, cap = DEFAULT_MAX_FAILURES) {
  const list = Array.isArray(failures) ? failures : [];

  const seen = new Set();
  const unique = [];
  for (const f of list) {
    const key = failureIdentity(f);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(f);
  }

  const truncated = unique.length > cap;
  return { failures: truncated ? unique.slice(0, cap) : unique, truncated };
}

/**
 * 判定單一 gate 的狀態。關鍵防呆：工具非 0 退出卻解不出任何 error → "errored"，
 * 不可當綠（否則 reporter 解析漏接時會假綠放行）。
 */
export function classifyGate({ ran, code, failures }) {
  if (!ran) return 'not-run';
  const list = Array.isArray(failures) ? failures : [];
  if (list.some((f) => f?.severity === 'error')) return 'failed';
  if (code !== 0) return 'errored';
  return 'passed';
}

/**
 * 把每 gate 的 { status, failures } 組裝成 GateResult。
 * gates.<g> 直接吐狀態值（passed/failed/not-run/errored），不轉成 "ok"，與 JSON / 人讀摘要一致。
 * ok = 無 error 級 failure 且無 gate 為 failed/errored；status 有 blocking→failed、否則有 not-run→partial、否則 passed。
 */
export function buildResult(perGate, cap = DEFAULT_MAX_FAILURES) {
  const gates = {};
  const collected = [];
  for (const gate of GATE_ORDER) {
    const entry = perGate?.[gate] ?? { status: 'not-run', failures: [] };
    gates[gate] = entry.status ?? 'not-run';
    if (Array.isArray(entry.failures)) collected.push(...entry.failures);
  }

  const { failures, truncated } = dedupeFailures(collected, cap);
  const counts = { test: 0, lint: 0, type: 0, total: failures.length };
  for (const f of failures) {
    if (counts[f.kind] != null) counts[f.kind] += 1;
  }

  const blocked = GATE_ORDER.some((g) => BLOCKING_GATE_STATES.has(gates[g]));
  const hasErrorFailure = failures.some((f) => f?.severity === 'error');
  const ok = !blocked && !hasErrorFailure;
  const status = blocked ? 'failed'
    : GATE_ORDER.some((g) => gates[g] === 'not-run') ? 'partial'
    : 'passed';

  return { ok, status, counts, gates, failures, truncated };
}

/**
 * 把 GateResult 轉成人讀摘要（gate 標籤即狀態值，與 JSON 一致）。每種結果第一行都列各 gate 狀態，
 * 這樣 errored（failures=0 但工具掛了）也看得出是哪個 gate 爆，不會只剩誤導的「0 failures」。
 * - ok 且無 warning → 單行 ✓ 摘要。
 * - ok 但有 warning → 中性 ✓ 措辭並標 warning 數（不印 "✗"，避免把警告當失敗嚇人）。
 * - 非 ok → ✗ gate 狀態行 + error/warning 計數行，續印各筆 `file:line [code|ruleId] message`；truncated 補提示。
 */
export function formatSummary(result) {
  const failures = Array.isArray(result?.failures) ? result.failures : [];
  const gates = result?.gates ?? {};
  const gateLine = (mark) =>
    `${mark} quality-gate: ${GATE_ORDER.map((g) => `${g} ${gates[g] ?? 'unknown'}`).join(', ')}`;

  if (result?.ok) {
    const warnings = failures.filter((f) => f?.severity === 'warning');
    const header = gateLine('✓');
    if (warnings.length === 0) return header;

    const lines = [`${header} (${warnings.length} warnings)`];
    for (const f of warnings) lines.push(`  ${formatFailureLine(f)}`);
    if (result?.truncated) lines.push('  … 更多項目已達上限截斷。');
    return lines.join('\n');
  }

  const errorCount = failures.filter((f) => f?.severity === 'error').length;
  const warningCount = failures.filter((f) => f?.severity === 'warning').length;
  const lines = [gateLine('✗'), `  ${errorCount} errors, ${warningCount} warnings`];
  for (const f of failures) {
    lines.push(`  ${formatFailureLine(f)}`);
  }
  if (result?.truncated) {
    lines.push('  … 更多失敗已達上限截斷。');
  }
  return lines.join('\n');
}

// ── 純函式的內部小工具 ──────────────────────────────────────────────────────────

function parseJsonMaybe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null; // reporter 輸出壞掉時讓上層回空清單，而非整支 gate 崩潰
  }
}

function asCommand(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function buildVitestMessage(assertion) {
  const titlePath = [...(assertion?.ancestorTitles ?? []), assertion?.title]
    .filter((s) => typeof s === 'string' && s.length > 0)
    .join(' > ');
  const detail = Array.isArray(assertion?.failureMessages) ? assertion.failureMessages.join('\n') : '';
  return titlePath ? `${titlePath}\n${detail}` : detail;
}

function failureIdentity(f) {
  const tag = f?.code ?? f?.ruleId;
  const discriminator = tag != null && tag !== '' ? tag : `${f?.column ?? ''}::${f?.message ?? ''}`;
  return [f?.kind, f?.file, f?.line, discriminator].join('|');
}

function formatFailureLine(f) {
  const where = f?.line != null ? `${f.file}:${f.line}` : `${f?.file ?? ''}`;
  const tag = f?.code || f?.ruleId;
  const label = tag ? `[${tag}] ` : '';
  return `${where} ${label}${firstLine(f?.message)}`;
}

function firstLine(message) {
  return String(message ?? '').split(/\r?\n/)[0].trim();
}

// ── IO 邊界：讀 config（薄 wrapper）+ CLI main（被 import 時整段不執行）──────────

function readFileMaybe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null; // 檔不存在屬正常情境（走自動偵測），不是錯誤
  }
}

/**
 * 讀 <cwd>/.loops/gate.config.json（**會碰檔案系統**）→ parseConfig 解析。
 * 檔不存在 → 三鍵皆 null（呼叫端走自動偵測）。IO 只在此 wrapper，解析邏輯交給純函式。
 */
export function resolveConfig(cwd) {
  const raw = readFileMaybe(join(cwd, '.loops', 'gate.config.json'));
  return raw === null ? { test: null, lint: null, type: null } : parseConfig(raw);
}

function parseArgs(argv) {
  const opts = {
    cwd: '.',
    gates: new Set(GATE_ORDER),
    json: false,
    continueOnFailure: false,
    maxFailures: DEFAULT_MAX_FAILURES,
    tail: DEFAULT_TAIL_CHARS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--cwd') opts.cwd = argv[++i] ?? '.';
    else if (flag === '--gates') opts.gates = parseGateList(argv[++i]);
    else if (flag === '--json') opts.json = true;
    else if (flag === '--continue-on-failure') opts.continueOnFailure = true;
    else if (flag === '--max-failures') opts.maxFailures = toPositiveInt(argv[++i], DEFAULT_MAX_FAILURES);
    else if (flag === '--tail') opts.tail = toPositiveInt(argv[++i], DEFAULT_TAIL_CHARS);
  }
  return opts;
}

function parseGateList(raw) {
  const wanted = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => GATE_ORDER.includes(s));
  return new Set(wanted.length ? wanted : GATE_ORDER);
}

function toPositiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * 跑一道閘的指令字串，回 { code, output }（stdout+stderr 合併、tail 截斷）。
 *
 * 安全：command 來自 .loops/gate.config.json（repo owner 提交）或自動偵測——皆為受信任設定、
 * 非外部不可信輸入，且本函式不在指令裡內插任何外部資料。故用平台 shell 執行（shell:true），
 * 跨平台且讓 Windows 的 npm/npx/tsc/eslint `.cmd` shim 能正常啟動（shell:false 對 .cmd 會 spawn EINVAL）。
 * 非 0 退出不丟例外；spawn 自身錯誤(error 事件)也轉成 { code:-1, output:<訊息> } 不外拋，由呼叫端據 code 決策。
 */
export async function runCommand(command, opts = {}) {
  const { cwd, tailChars = DEFAULT_TAIL_CHARS } = opts;
  return new Promise((resolveRun) => {
    const child = spawn(command, { cwd, shell: true });

    let buffer = '';
    const collect = (chunk) => { buffer += chunk.toString(); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    child.on('error', (err) => resolveRun({ code: -1, output: tailTruncate(`${buffer}\n${err.message}`, tailChars) }));
    child.on('close', (code) => resolveRun({ code: code ?? -1, output: tailTruncate(buffer, tailChars) }));
  });
}

function tailTruncate(text, max) {
  if (typeof max !== 'number' || max <= 0 || text.length <= max) return text;
  return text.slice(text.length - max);
}

function readPackageScripts(cwd) {
  const raw = readFileMaybe(join(cwd, 'package.json'));
  const pkg = raw === null ? null : parseJsonMaybe(raw);
  return pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
}

const ESLINT_CONFIG_FILES = [
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
  '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
];

function hasEslint(cwd) {
  if (ESLINT_CONFIG_FILES.some((f) => existsSync(join(cwd, f)))) return true;
  const bin = process.platform === 'win32' ? 'eslint.cmd' : 'eslint';
  return existsSync(join(cwd, 'node_modules', '.bin', bin));
}

// 規劃一道閘怎麼跑：回 { command, parse, outFile? } 或 null（偵測不到 → 該閘 graceful skip）。
// outFile 一律放進呼叫端建好的私有暫存目錄（scratchDir），由呼叫端統一清理。
function planGate(gate, config, cwd, scripts, scratchDir) {
  if (gate === 'test') return planTestGate(config.test, scripts, scratchDir);
  if (gate === 'lint') return planLintGate(config.lint, scripts, cwd, scratchDir);
  if (gate === 'type') return planTypeGate(config.type, cwd);
  return null;
}

// package manager 跑 script 時，給底層工具的 flag 要經 `--` 轉發；npx/直接呼叫的工具則直接附加。
function isPackageManagerScript(command) {
  return /^(npm|pnpm|yarn)\b/.test(command.trim());
}

/**
 * 把工具 flags（token 陣列）接到指令字串。
 * npm/pnpm/yarn run script → flags 放 ` -- ` 之後（轉發給底層工具，否則被 package manager 自己吃掉）；
 * npx / 直接 binary → 直接附加（無 `--`）。
 */
export function appendToolFlags(command, flags) {
  const suffix = (Array.isArray(flags) ? flags : [flags]).join(' ');
  return isPackageManagerScript(command) ? `${command} -- ${suffix}` : `${command} ${suffix}`;
}

// test / lint 都把 reporter 寫進暫存檔再讀「完整 raw」，避免吃到被 tail 砍過或混入 stderr 的 stdout。
function planTestGate(configCommand, scripts, scratchDir) {
  const base = configCommand ?? (scripts.test ? 'npm test' : null);
  if (!base) return null;

  const outFile = join(scratchDir, 'vitest.json');
  // reporter flags 經 appendToolFlags 轉發（npm test 形式時要落在 `--` 之後才到得了 vitest）。
  const command = appendToolFlags(base, ['--reporter=json', `--outputFile="${outFile}"`]);
  return { command, parse: parseVitest, outFile };
}

function planLintGate(configCommand, scripts, cwd, scratchDir) {
  const base = configCommand
    ?? (scripts.lint ? 'npm run lint' : hasEslint(cwd) ? 'npx eslint .' : null);
  if (!base) return null;

  const outFile = join(scratchDir, 'eslint.json');
  // -f json 與 --output-file 都是「給 eslint 的 flags」，一起經 appendToolFlags 轉發
  // （F3：npm script 時兩者都得在 `--` 之後，否則 eslint 收不到 → 退化成截斷假綠）。
  const command = appendToolFlags(base, eslintReporterFlags(base, outFile));
  return { command, parse: parseEslint, outFile };
}

// eslint reporter flags：已含 format 的 config 指令不重複加 -f json；outFile 引號包覆容許路徑含空白。
function eslintReporterFlags(command, outFile) {
  const hasFormat = /(^|\s)(-f|--format)(\s|=)/.test(command);
  return [...(hasFormat ? [] : ['-f', 'json']), '--output-file', `"${outFile}"`];
}

function planTypeGate(configCommand, cwd) {
  // tsc 是 line-based 文字診斷，沒有 outputFile json，照舊讀 stdout。
  if (configCommand) return { command: configCommand, parse: parseTsc };
  if (existsSync(join(cwd, 'tsconfig.json'))) return { command: 'npx tsc --noEmit', parse: parseTsc };
  return null;
}

// 跑一道閘 → 回 { code, failures }。有 outFile 的閘讀檔取完整 raw；否則用（tail 截斷後的）stdout。
async function executeGate(plan, cwd, tailChars) {
  const { code, output } = await runCommand(plan.command, { cwd, tailChars });
  const raw = plan.outFile ? (readFileMaybe(plan.outFile) ?? output) : output;
  return { code, failures: plan.parse(raw) };
}

async function main(rawArgv) {
  const opts = parseArgs(rawArgv);
  const cwd = resolve(opts.cwd);
  const config = resolveConfig(cwd);
  const scripts = readPackageScripts(cwd);

  // 私有暫存目錄收納各閘 outFile，收尾整包刪除（C4：不在公共 tmp 散落零碎檔）。
  const scratchDir = mkdtempSync(join(tmpdir(), 'qg-'));
  const perGate = {};
  try {
    let stopped = false;
    for (const gate of GATE_ORDER) {
      const plan = (!opts.gates.has(gate) || stopped) ? null : planGate(gate, config, cwd, scripts, scratchDir);
      if (!plan) {
        perGate[gate] = { status: 'not-run', failures: [] };
        continue;
      }

      const { code, failures } = await executeGate(plan, cwd, opts.tail);
      const status = classifyGate({ ran: true, code, failures });
      perGate[gate] = { status, failures };
      if (BLOCKING_GATE_STATES.has(status) && !opts.continueOnFailure) stopped = true;
    }
  } finally {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // 暫存目錄清不掉不影響結果，忽略
    }
  }

  const result = buildResult(perGate, opts.maxFailures);
  console.log(opts.json ? JSON.stringify(result, null, 2) : formatSummary(result));
  process.exit(result.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err?.message ?? String(err));
    process.exit(1);
  });
}
