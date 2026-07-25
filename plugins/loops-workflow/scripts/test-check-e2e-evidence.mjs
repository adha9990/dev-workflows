#!/usr/bin/env node
// test-check-e2e-evidence.mjs —— check-e2e-evidence.mjs 的紅綠斷言。自帶極簡 harness（仿同家族
// test-compat-lint.mjs / test-check-registry-shape.mjs：assert 累加器，不引測試框架）。
//
// 用法：node scripts/test-check-e2e-evidence.mjs
// 全綠 → exit 0；任一斷言失敗 → exit 1。
//
// 涵蓋：
//   正向：對真實 docs/dual-harness-e2e.md 跑 buildReport，須 14 格齊全、全綠。
//   負向（三個獨立 fixture，各只破壞一件事，其餘維持合法——確保各自的檢查真的有鑑別力）：
//     ①缺格：14 格拿掉一格 → 必須抓到 e2e-cell-missing。
//     ②非法 status：某格 status 打錯字 → 必須抓到 e2e-status-invalid。
//     ③空 repro：某個 not_measured 格 repro 留空 → 必須抓到 e2e-repro-empty。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractDataBlock, validateCells, buildReport } from './check-e2e-evidence.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

// ============================================================================
// 共用：一份完全合法的 14 格 baseline（fixture 從這份複製後破壞單一屬性）。
// ============================================================================

function buildValidCells() {
  const cells = [];
  for (const step of [1, 2, 3, 4, 5, 6, 7]) {
    cells.push({ step, platform: 'claude', status: 'pass', evidence: `scripts/test-x-${step}.mjs`, repro: '' });
    cells.push({
      step,
      platform: 'codex',
      status: 'not_measured',
      evidence: '',
      repro: `CODEX_HOME=<已認證隔離 home> node exec --json -C <repo> "<fixture ${step}>"`,
    });
  }
  return cells;
}

function toDoc(cells) {
  return [
    '# fixture',
    '```json',
    JSON.stringify({ cells }, null, 2),
    '```',
    '',
  ].join('\n');
}

// ============================================================================
// A) 正向：真實文件
// ============================================================================

const realDocPath = join(REPO_ROOT, 'plugins', 'loops-workflow', 'docs', 'dual-harness-e2e.md');
const realText = readFileSync(realDocPath, 'utf8');
const realParsed = extractDataBlock(realText);
assert(!realParsed.error, `[A1] 真實文件的資料區塊可解析（實際：${realParsed.error ?? 'ok'}）`);
assert(Array.isArray(realParsed.cells) && realParsed.cells.length === 14, `[A2] 真實文件恰有 14 格（實際：${realParsed.cells?.length}）`);

const realFindings = validateCells(realParsed.cells ?? []);
assert(realFindings.length === 0, `[A3] 真實文件全綠，無 finding（實際：${JSON.stringify(realFindings)}）`);

const realReport = buildReport(REPO_ROOT);
assert(realReport.ok === true, '[A4] buildReport(root) 對真實文件回 ok=true');

// ============================================================================
// B) 正向：手工組出的合法 baseline 本身也該全綠（驗證 baseline 本身無誤，反例才有意義）
// ============================================================================

const baselineFindings = validateCells(buildValidCells());
assert(baselineFindings.length === 0, `[B1] 合法 baseline（14 格）本身全綠（實際：${JSON.stringify(baselineFindings)}）`);

// ============================================================================
// C) 反例①：缺格 —— 拿掉 step=3 platform=codex
// ============================================================================

const missingCells = buildValidCells().filter((c) => !(c.step === 3 && c.platform === 'codex'));
const missingFindings = validateCells(missingCells);
assert(
  missingFindings.some((f) => f.check === 'e2e-cell-missing' && f.detail.includes('step=3') && f.detail.includes('platform=codex')),
  `[C1] 缺格（step=3/codex）被 e2e-cell-missing 抓到（實際：${JSON.stringify(missingFindings)}）`,
);
assert(missingFindings.length > 0, '[C2] 缺格 fixture 整體非全綠');

const missingReport = extractDataBlock(toDoc(missingCells));
assert(!missingReport.error && validateCells(missingReport.cells).length > 0, '[C3] 缺格 fixture 走完整解析路徑仍非全綠');

// ============================================================================
// D) 反例②：非法 status —— step=5 platform=claude 打成 "passed"（不是合法值 "pass"）
// ============================================================================

const badStatusCells = buildValidCells().map((c) =>
  c.step === 5 && c.platform === 'claude' ? { ...c, status: 'passed' } : c,
);
const badStatusFindings = validateCells(badStatusCells);
assert(
  badStatusFindings.some((f) => f.check === 'e2e-status-invalid' && f.detail.includes('step=5') && f.detail.includes('platform=claude')),
  `[D1] 非法 status（"passed"）被 e2e-status-invalid 抓到（實際：${JSON.stringify(badStatusFindings)}）`,
);
assert(badStatusFindings.length > 0, '[D2] 非法 status fixture 整體非全綠');

// ============================================================================
// E) 反例③：空 repro —— step=2 platform=codex 的 not_measured 格 repro 清空
// ============================================================================

const emptyReproCells = buildValidCells().map((c) =>
  c.step === 2 && c.platform === 'codex' ? { ...c, repro: '' } : c,
);
const emptyReproFindings = validateCells(emptyReproCells);
assert(
  emptyReproFindings.some((f) => f.check === 'e2e-repro-empty' && f.detail.includes('step=2') && f.detail.includes('platform=codex')),
  `[E1] 空 repro（step=2/codex）被 e2e-repro-empty 抓到（實際：${JSON.stringify(emptyReproFindings)}）`,
);
assert(emptyReproFindings.length > 0, '[E2] 空 repro fixture 整體非全綠');

// 附加：repro 非空但不含可執行指令訊號（純敘述句）也該被抓——證明 EXECUTABLE_MARKER_RE 真的有鑑別力。
const proseOnlyReproCells = buildValidCells().map((c) =>
  c.step === 6 && c.platform === 'codex' ? { ...c, repro: '之後有空再手動測一下就好' } : c,
);
const proseOnlyFindings = validateCells(proseOnlyReproCells);
assert(
  proseOnlyFindings.some((f) => f.check === 'e2e-repro-not-executable' && f.detail.includes('step=6')),
  `[E3] 純敘述句 repro（無可執行指令訊號）被 e2e-repro-not-executable 抓到（實際：${JSON.stringify(proseOnlyFindings)}）`,
);

// ============================================================================
// F) buildReport 對找不到的檔案 fail closed（不是靜默放行）
// ============================================================================

const missingFileReport = buildReport(REPO_ROOT, { file: join(REPO_ROOT, 'plugins', 'loops-workflow', 'docs', 'does-not-exist.md') });
assert(missingFileReport.ok === false, '[F1] 檔案不存在時 buildReport 回 ok=false（fail closed，不是靜默放行）');

// ============================================================================

console.log('');
if (failed.length === 0) {
  console.log(`✓ ${passed} passed, 0 failed`);
  process.exit(0);
} else {
  console.error(`✗ ${passed} passed, ${failed.length} failed`);
  for (const msg of failed) console.error(`  - ${msg}`);
  process.exit(1);
}
