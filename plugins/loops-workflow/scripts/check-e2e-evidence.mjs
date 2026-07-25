#!/usr/bin/env node
// check-e2e-evidence.mjs —— 機械驗證 docs/dual-harness-e2e.md 的證據表完整性：7 步 × 2 平台
// （claude／codex）恰好 14 格，`status` 只能是 `pass` 或 `not_measured`，且每個 `not_measured`
// 格的 `repro` 欄非空、含可執行的重播指令（而不是一句空話帶過）。
//
// 為什麼機械查這個：證據表本身是散文＋表格，人讀起來像已經填好，但「格子有沒有漏」「status
// 有沒有手滑打錯字」「repro 是不是真的一段能跑的指令」這些形狀完整性不該只靠人眼審。
//
// 資料來源：docs/dual-harness-e2e.md 文末的 ```json 資料區塊（`cells: [{step, platform, status,
// evidence, repro}]`），與文件裡的人讀表格是同一份事實的兩種呈現——本檢查只解析資料區塊，
// 不解析 markdown 表格本身（表格格式脆弱、資料區塊是穩定的機械解析入口）。
//
// 分層：
//   1) 解析 / 判定層（純函式，無 IO）：extractDataBlock / validateCells / formatSummary ——
//      給單元測試直接 import。
//   2) IO 薄邊界：buildReport（讀檔、組裝）＋ CLI main（印出、決定 exit code）——main 被
//      import 時不執行（import.meta.url 守門）。
// 依賴：僅 node 內建（fs / path / url / process），無外部套件。
// 用法：node check-e2e-evidence.mjs [--file <path>] [--json]

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STEP_IDS = [1, 2, 3, 4, 5, 6, 7];
const PLATFORM_IDS = ['claude', 'codex'];
const STATUS_ENUM = ['pass', 'not_measured'];
const EXPECTED_CELL_COUNT = STEP_IDS.length * PLATFORM_IDS.length;
const E2E_DOC_REL = 'plugins/loops-workflow/docs/dual-harness-e2e.md';

// repro 是否「含可執行指令」的判準：出現至少一個具體可執行的訊號詞（實際指令名 / 環境變數賦值 /
// inline code span），而不是純敘述句（例如「之後再測」這種空話不該算數）。刻意保守——寧可漏抓
// 邊緣寫法，也不誤放行真正的空話。
const EXECUTABLE_MARKER_RE = /\bnode\b|\bexec\b|CODEX_HOME=|`[^`]+`/;

// ── 解析 / 判定層（純函式，無 IO，測試直接 import）──────────────────────────────

/**
 * 從文件全文抽出文末 ```json 資料區塊並解析。找不到區塊或解析失敗 → { error }；
 * 成功 → { cells }（cells 若非陣列，視為格式錯誤，一併回 error，呼叫端不必再判型別）。
 */
export function extractDataBlock(text) {
  const match = /```json\r?\n([\s\S]*?)```/.exec(String(text ?? ''));
  if (!match) return { error: '找不到 ```json 資料區塊' };

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (e) {
    return { error: `資料區塊 JSON 解析失敗：${e.message}` };
  }
  if (!parsed || !Array.isArray(parsed.cells)) {
    return { error: '資料區塊須含 cells 陣列' };
  }
  return { cells: parsed.cells };
}

/**
 * 驗 14 格（7 步 × 2 平台）齊全、無重複、status 值域封閉、not_measured 的 repro 非空且含可執行指令。
 * 回傳 findings 陣列（全綠回空陣列）。
 */
export function validateCells(cells) {
  const findings = [];
  const list = Array.isArray(cells) ? cells : [];

  const seen = new Map(); // "step:platform" → 出現次數，抓重複格
  for (const cell of list) {
    const key = `${cell?.step}:${cell?.platform}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  // ① 齊全性：每個 (step, platform) 組合恰好出現一次。
  for (const step of STEP_IDS) {
    for (const platform of PLATFORM_IDS) {
      const key = `${step}:${platform}`;
      const count = seen.get(key) ?? 0;
      if (count === 0) {
        findings.push({
          check: 'e2e-cell-missing',
          severity: 'P1',
          detail: `缺少格子：step=${step} platform=${platform}`,
        });
      } else if (count > 1) {
        findings.push({
          check: 'e2e-cell-duplicate',
          severity: 'P1',
          detail: `格子重複出現 ${count} 次：step=${step} platform=${platform}`,
        });
      }
    }
  }

  // ② 逐格內容驗證（僅對落在合法 (step, platform) 範圍內的格子做內容檢查；不在範圍內的
  //   格子——例如 step=8 或 platform=unknown——本身已不合法，交由呼叫端從 findings 看出異常，
  //   這裡不重複報「內容也怪」，避免同一筆壞資料報兩次噪音）。
  const validKeys = new Set(STEP_IDS.flatMap((s) => PLATFORM_IDS.map((p) => `${s}:${p}`)));
  for (const cell of list) {
    const key = `${cell?.step}:${cell?.platform}`;
    if (!validKeys.has(key)) continue;

    const label = `step=${cell?.step} platform=${cell?.platform}`;
    if (!STATUS_ENUM.includes(cell?.status)) {
      findings.push({
        check: 'e2e-status-invalid',
        severity: 'P1',
        detail: `${label}：status="${cell?.status}" 不在合法值域內（僅允許 ${STATUS_ENUM.join('/')}）`,
      });
      continue; // status 都不合法，不必再往下驗 pass/not_measured 各自的欄位規則
    }

    if (cell.status === 'pass' && !String(cell?.evidence ?? '').trim()) {
      findings.push({
        check: 'e2e-evidence-empty',
        severity: 'P1',
        detail: `${label}：status=pass 但 evidence 欄為空`,
      });
    }

    if (cell.status === 'not_measured') {
      const repro = String(cell?.repro ?? '').trim();
      if (!repro) {
        findings.push({
          check: 'e2e-repro-empty',
          severity: 'P1',
          detail: `${label}：status=not_measured 但 repro 欄為空`,
        });
      } else if (!EXECUTABLE_MARKER_RE.test(repro)) {
        findings.push({
          check: 'e2e-repro-not-executable',
          severity: 'P1',
          detail: `${label}：repro 欄非空但未含可辨識的可執行指令訊號（node/exec/CODEX_HOME=/inline code）：「${repro}」`,
        });
      }
    }
  }

  return findings;
}

/** findings → 人讀摘要：全綠一行 ✓；否則逐條列出。 */
export function formatSummary(findings) {
  const list = Array.isArray(findings) ? findings : [];
  if (list.length === 0) {
    return `✓ check-e2e-evidence：${EXPECTED_CELL_COUNT} 格（7 步 × 2 平台）齊全，status/repro 皆合規。`;
  }
  return list.map((f) => `✗ [${f.check}] ${f.severity} — ${f.detail}`).join('\n');
}

// ── IO 邊界：讀檔 + CLI main ────────────────────────────────────────────────

/** 讀 root 下的 dual-harness-e2e.md，抽資料區塊、跑 validateCells，組成完整結果物件。 */
export function buildReport(root, opts = {}) {
  const fileAbs = opts.file ?? join(root, ...E2E_DOC_REL.split('/'));
  if (!existsSync(fileAbs)) {
    return { ok: false, findings: [{ check: 'e2e-file-missing', severity: 'P1', detail: `找不到證據表：${fileAbs}` }] };
  }

  let text;
  try {
    text = readFileSync(fileAbs, 'utf8');
  } catch (e) {
    return { ok: false, findings: [{ check: 'e2e-file-read-error', severity: 'P1', detail: `讀取失敗：${e.message}` }] };
  }

  const parsed = extractDataBlock(text);
  if (parsed.error) {
    return { ok: false, findings: [{ check: 'e2e-data-block-invalid', severity: 'P1', detail: parsed.error }] };
  }

  const findings = validateCells(parsed.cells);
  return { ok: findings.length === 0, findings };
}

function defaultRoot() {
  const scriptDir = fileURLToPath(new URL('.', import.meta.url));
  return join(scriptDir, '..', '..', '..');
}

function parseArgs(argv) {
  const opts = { root: defaultRoot(), file: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--file') opts.file = argv[++i] ?? null;
    else if (flag === '--json') opts.json = true;
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const result = buildReport(opts.root, { file: opts.file });
  console.log(opts.json ? JSON.stringify(result, null, 2) : formatSummary(result.findings));
  process.exit(result.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2));
}
