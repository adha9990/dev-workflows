#!/usr/bin/env node
// loops-quality-gate.mjs —— 跑 test / lint / type 三道閘並把各家 reporter 正規化成統一 Failure 清單。
// 設計成「純函式 + 薄 CLI」：reporter 解析全是無副作用純函式（給單元測試 import），
// 真正去 spawn 子程序、讀檔的副作用只在 CLI main 邊界發生（被 import 時不執行）。
// 依賴：僅 node 內建（child_process / fs / path / os / url），無外部套件。
// 用法：node loops-quality-gate.mjs [--cwd <dir>] [--gates test,lint,type] [--json]
//        [--continue-on-failure] [--max-failures <n>] [--tail <n>]

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_MAX_FAILURES = 160;
const DEFAULT_TAIL_CHARS = 80000;
const GATE_ORDER = ['test', 'lint', 'type'];

// ── 解析層（純函式，測試直接 import）────────────────────────────────────────────

/**
 * 讀 <cwd>/.loops/gate.config.json，回三道閘的指令字串。
 * 檔不存在、JSON 壞掉、或某鍵缺/非字串 → 該鍵回 null（呼叫端據此走自動偵測或標 not-run）。
 */
export function resolveConfig(cwd) {
  const blank = { test: null, lint: null, type: null };
  const raw = readFileMaybe(join(cwd, '.loops', 'gate.config.json'));
  if (raw === null) return blank;

  const parsed = parseJsonMaybe(raw);
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
 * tsc --noEmit 診斷文字 → 逐行抓 `file(line,col): error TSxxxx: msg`；
 * npm preamble、`Found N errors` 摘要等非配對行一律略過。
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
 * 去重（同一 kind+file+line+code/ruleId 視為同一筆，留先到者）再依 cap 截斷。
 * truncated 只代表「因 cap 砍掉了東西」，去重收斂不算截斷。
 */
export function dedupeFailures(failures, cap = DEFAULT_MAX_FAILURES) {
  const list = Array.isArray(failures) ? failures : [];

  const seen = new Set();
  const unique = [];
  for (const f of list) {
    const identity = [f?.kind, f?.file, f?.line, f?.code ?? f?.ruleId ?? ''].join('|');
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(f);
  }

  const truncated = unique.length > cap;
  return { failures: truncated ? unique.slice(0, cap) : unique, truncated };
}

/**
 * 把 GateResult 轉成人讀摘要。
 * 全綠 → 單行含 ✓ 與各 gate 狀態；有失敗 → 首行計數，續印各筆 file:line [code|ruleId] message。
 */
export function formatSummary(result) {
  const counts = result?.counts ?? { test: 0, lint: 0, type: 0, total: 0 };
  const failures = Array.isArray(result?.failures) ? result.failures : [];

  if (result?.ok && failures.length === 0) {
    const gates = result?.gates ?? {};
    const parts = GATE_ORDER.map((g) => `${g} ${gateLabel(gates[g])}`);
    return `✓ quality-gate: ${parts.join(', ')}`;
  }

  const lines = [`✗ ${counts.total} failures: test=${counts.test} lint=${counts.lint} type=${counts.type}`];
  for (const f of failures) {
    lines.push(`  ${formatFailureLine(f)}`);
  }
  if (result?.truncated) {
    lines.push('  … 更多失敗已達上限截斷。');
  }
  return lines.join('\n');
}

// ── 純函式的內部小工具 ──────────────────────────────────────────────────────────

function readFileMaybe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null; // 檔不存在屬正常情境（走自動偵測），不是錯誤
  }
}

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

function gateLabel(state) {
  if (state === 'passed') return 'ok';
  if (state === 'failed') return 'fail';
  if (state === 'not-run') return 'not-run';
  return state || 'unknown';
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

// ── CLI 邊界（副作用都收斂在這；被 import 時整段不執行）──────────────────────────

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
function planGate(gate, config, cwd, scripts) {
  if (gate === 'test') return planTestGate(config.test, scripts);
  if (gate === 'lint') return planLintGate(config.lint, scripts, cwd);
  if (gate === 'type') return planTypeGate(config.type, cwd);
  return null;
}

// package manager 跑 script 時，給底層工具的 flag 要經 `--` 轉發；npx/直接呼叫的工具則直接附加。
function isPackageManagerScript(command) {
  return /^(npm|pnpm|yarn)\b/.test(command.trim());
}

function appendToolFlags(command, flags) {
  return isPackageManagerScript(command) ? `${command} -- ${flags}` : `${command} ${flags}`;
}

function planTestGate(configCommand, scripts) {
  const base = configCommand ?? (scripts.test ? 'npm test' : null);
  if (!base) return null;

  // vitest 的 stdout 常夾雜雜訊，所以導向暫存檔再讀 raw json（outFile 引號包覆以容許路徑含空白）。
  const outFile = join(tmpdir(), `qg-vitest-${process.pid}-${Date.now()}.json`);
  const command = appendToolFlags(base, `--reporter=json --outputFile="${outFile}"`);
  return { command, parse: parseVitest, outFile };
}

function planLintGate(configCommand, scripts, cwd) {
  if (configCommand) return { command: configCommand, parse: parseEslint };
  if (scripts.lint) return { command: 'npm run lint -- -f json', parse: parseEslint };
  if (hasEslint(cwd)) return { command: 'npx eslint . -f json', parse: parseEslint };
  return null;
}

function planTypeGate(configCommand, cwd) {
  if (configCommand) return { command: configCommand, parse: parseTsc };
  if (existsSync(join(cwd, 'tsconfig.json'))) return { command: 'npx tsc --noEmit', parse: parseTsc };
  return null;
}

async function executeGate(plan, cwd, tailChars) {
  const { output } = await runCommand(plan.command, { cwd, tailChars });
  if (!plan.outFile) return plan.parse(output);

  const raw = readFileMaybe(plan.outFile);
  try {
    rmSync(plan.outFile, { force: true });
  } catch {
    // 暫存檔清不掉不影響結果，忽略
  }
  return plan.parse(raw ?? output);
}

function buildResult(gates, dedup) {
  const { failures, truncated } = dedup;
  const counts = { test: 0, lint: 0, type: 0, total: failures.length };
  for (const f of failures) {
    if (counts[f.kind] != null) counts[f.kind] += 1;
  }

  const ok = !failures.some((f) => f.severity === 'error');
  const status = !ok ? 'failed'
    : Object.values(gates).includes('not-run') ? 'partial'
    : 'passed';

  return { ok, status, counts, gates, failures, truncated };
}

async function main(rawArgv) {
  const opts = parseArgs(rawArgv);
  const cwd = resolve(opts.cwd);
  const config = resolveConfig(cwd);
  const scripts = readPackageScripts(cwd);

  const gates = {};
  const allFailures = [];
  let stopped = false;

  for (const gate of GATE_ORDER) {
    if (!opts.gates.has(gate) || stopped) {
      gates[gate] = 'not-run';
      continue;
    }
    const plan = planGate(gate, config, cwd, scripts);
    if (!plan) {
      gates[gate] = 'not-run';
      continue;
    }

    const failures = await executeGate(plan, cwd, opts.tail);
    allFailures.push(...failures);
    const failed = failures.some((f) => f.severity === 'error');
    gates[gate] = failed ? 'failed' : 'passed';
    if (failed && !opts.continueOnFailure) stopped = true;
  }

  const result = buildResult(gates, dedupeFailures(allFailures, opts.maxFailures));
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
