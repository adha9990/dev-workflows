#!/usr/bin/env node
// check-emit-residual.mjs —— Tier A 機械 guard（#183 T13）：確認全部決策輸出點（共 13 處）都已改走
// hooks/hook-decision-emit.mjs 的 emitDecision()，沒有人在 production hook 裡自己重新組裝決策信封。
// 這條 lint 存在的理由：雙 harness 相容層的價值全繫於「信封形狀只有一處決定」；只要有一支 hook
// 私下自組信封，日後切 harness 時它就會靜默漏接（輸出仍是 Claude 專屬格式，別的 harness 直接忽略）。
//
// 掃描範圍（刻意只掃 production hook）：plugins/loops-workflow/hooks/*.mjs，排除
//   - test-*.mjs：測試檔本來就要用字面斷言 Claude 形狀輸出（那是 #183 零回歸的位元鎖），
//     掃進來只會逼人拆掉斷言，等於自毀依據。
//   - fixtures/：假資料不是 production code（本 lint 只讀 hooks/ 頂層檔，不遞迴，天然排除）。
//   - hook-decision-emit.mjs：它就是唯一被授權組裝信封的葉節點。
//
// 三種殘留形狀（三者都是「繞過 emitDecision 自己講決策」的具體長相）：
//   R1 hook-specific-output-literal：出現 `hookSpecificOutput` 字面 → Claude 專屬信封手工組裝。
//   R2 top-level-decision-literal：出現 `decision: '…'` 形式的物件欄位 → loop-driver 那種頂層扁平
//      `{decision:'block',reason}` 手工組裝（注意：`const decision = emitDecision(...)` 是賦值不是
//      物件欄位，不會命中；`permissionDecision:` 也不會命中，那由 R1 的信封字面負責）。
//   R3 bare-console-decision：`console.log(JSON.stringify(` → 直接把 JSON 決策信封印上 stdout。
//      已知限制（誠實標記）：先組成變數再印（`const s = JSON.stringify({…}); console.log(s);`）不會被
//      R3 命中；但那種寫法的信封內容仍會被 R1/R2 命中，故實務覆蓋足夠。純文字 stdout（如
//      session-start.mjs 印 active loop 表頭）不是決策信封，刻意不納入。
//
// 分層（仿 scripts/codex-plugin-lint.mjs）：
//   1) 判定層（純函式，無 IO）：scanSource / formatSummary —— 給單元測試直接 import。
//   2) IO 薄邊界：listHookFiles（掃檔）＋ buildReport ＋ CLI main（印出、決定 exit code）——
//      main 被 import 時不執行。
// 依賴：僅 node 內建（fs / path / url / process），無外部套件。
// 用法：node check-emit-residual.mjs [--hooks-dir <dir>] [--json]

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 唯一被授權組裝決策信封的葉節點（本 lint 對它豁免；其餘 production hook 一律不得自組）。
const EMIT_LEAF_FILE = 'hook-decision-emit.mjs';
const TEST_FILE_PREFIX = 'test-';

// R2：物件欄位形式的 `decision: '…'`。前綴排除英數字 / `_` / `$` / `.`，讓 `permissionDecision:`
// 與 `foo.decision:` 不誤命中；賦值（`decision = …`）本就不含冒號，天然不命中。
const TOP_LEVEL_DECISION_RE = /(^|[^A-Za-z0-9_$.])decision\s*:\s*['"]/;
// R3：把 JSON 直接印上 stdout（允許 console.log 與 JSON.stringify 之間有換行縮排）。
const BARE_CONSOLE_JSON_RE = /console\.log\(\s*JSON\.stringify\(/;

const RESIDUAL_RULES = [
  {
    check: 'hook-specific-output-literal',
    detail: '出現 hookSpecificOutput 字面：決策信封請改由 hooks/hook-decision-emit.mjs 的 emitDecision() 組裝',
    matches: (line) => line.includes('hookSpecificOutput'),
  },
  {
    check: 'top-level-decision-literal',
    detail: "出現頂層 decision: '…' 手工組裝：請改用 emitDecision({ kind: 'block', reason }, …)",
    matches: (line) => TOP_LEVEL_DECISION_RE.test(line),
  },
  {
    check: 'bare-console-decision',
    detail: 'console.log(JSON.stringify(…)) 直接印決策信封：請改印 emitDecision() 的回傳值',
    matches: (line) => BARE_CONSOLE_JSON_RE.test(line),
  },
];

// 整行註解（`// …` 與 block 註解續行 `* …`）：檔頭說明常引用舊信封字面來解釋設計（例如
// loop-driver.mjs 檔頭寫「以 stdout JSON `{ "decision":"block" }` 攔下停止」），那是文件不是殘留，
// 不該被判違規。只跳過「整行都是註解」的行——行尾註解若真寫了信封字面仍會被抓，寧可誤報也不漏報。
const WHOLE_LINE_COMMENT_RE = /^\s*(\/\/|\*|\/\*)/;

// ── 判定層（純函式，無 IO，測試直接 import）──────────────────────────────────────

/** 本 lint 只管 production hook：非 .mjs、test-*.mjs、emit 葉節點本身皆不掃。 */
export function shouldScanFile(fileName) {
  if (!fileName.endsWith('.mjs')) return false;
  if (fileName.startsWith(TEST_FILE_PREFIX)) return false;
  return fileName !== EMIT_LEAF_FILE;
}

/**
 * 掃一份 production hook 原始碼，逐行比對三條殘留規則，回傳 finding 陣列（全綠回空陣列）。
 * 逐行掃的理由：finding 要能指到行號，讓讀者直接跳到現場，而不是只知道「這檔有問題」。
 * @param {string} file 顯示用檔名（相對路徑）
 * @param {string} source 檔案內容
 * @returns {Array<{check:string, severity:string, file:string, detail:string}>}
 */
export function scanSource(file, source) {
  const findings = [];
  const lines = String(source ?? '').split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (WHOLE_LINE_COMMENT_RE.test(line)) return; // 整行註解＝說明文字，不是殘留的組裝程式碼
    for (const rule of RESIDUAL_RULES) {
      if (!rule.matches(line)) continue;
      findings.push({
        check: rule.check,
        severity: 'P1',
        file: `${file}:${idx + 1}`,
        detail: rule.detail,
      });
    }
  });
  return findings;
}

/** 把整體檢查結果轉人讀摘要：全綠單行 ✓；有 finding → 逐條 "✗ [check] severity file — detail"。 */
export function formatSummary(result) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const filesScanned = result?.summary?.filesScanned ?? 0;

  if (findings.length === 0) {
    return `✓ check-emit-residual：${filesScanned} 支 production hook 全綠，無決策輸出殘留。`;
  }
  return findings.map((f) => `✗ [${f.check}] ${f.severity} ${f.file} — ${f.detail}`).join('\n');
}

// ── IO 邊界：掃檔 + 組報告 + CLI main ────────────────────────────────────────────

/** 列出 hooksDir 頂層（不遞迴，故 fixtures/ 天然排除）該掃的 production hook 檔名。 */
function listHookFiles(hooksDir) {
  let entries;
  try {
    entries = readdirSync(hooksDir, { withFileTypes: true });
  } catch {
    return null; // 目錄不存在 / 讀不到 → 由呼叫端報成 finding，不假裝全綠
  }
  return entries.filter((e) => e.isFile() && shouldScanFile(e.name)).map((e) => e.name).sort();
}

/** 掃描 hooksDir，跑殘留檢查，組成完整結果物件（--json 與人讀摘要共用同一份）。 */
export function buildReport(hooksDir) {
  const fileNames = listHookFiles(hooksDir);
  if (fileNames === null) {
    return {
      ok: false,
      findings: [{ check: 'hooks-dir-unreadable', severity: 'P1', file: hooksDir, detail: '無法讀取 hooks 目錄' }],
      notes: [],
      summary: { filesScanned: 0 },
    };
  }

  const findings = [];
  for (const name of fileNames) {
    let source;
    try {
      source = readFileSync(join(hooksDir, name), 'utf8');
    } catch {
      findings.push({ check: 'hook-file-unreadable', severity: 'P1', file: name, detail: '無法讀取檔案內容' });
      continue;
    }
    findings.push(...scanSource(name, source));
  }

  return {
    ok: findings.length === 0,
    findings,
    notes: [],
    summary: { filesScanned: fileNames.length },
  };
}

function defaultHooksDir() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return join(scriptDir, '..', 'hooks');
}

function parseArgs(argv) {
  const opts = { hooksDir: defaultHooksDir(), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--hooks-dir') opts.hooksDir = argv[++i] ?? opts.hooksDir;
    else if (flag === '--json') opts.json = true;
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const result = buildReport(opts.hooksDir);
  console.log(opts.json ? JSON.stringify(result, null, 2) : formatSummary(result));
  process.exit(result.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2));
}
