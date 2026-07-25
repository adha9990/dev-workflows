#!/usr/bin/env node
// check-baseline-whitelist.mjs —— CI 基線白名單 guard（#183 T27）：Run tests 那個
// `plugins/**/test-*.mjs` glob 迴圈只保證「跑到的都綠」，不保證「該跑的都在」——
// 有人刪掉既有測試檔，glob 命中數就跟著少一個，CI 照樣綠、零警訊。
// 這條 lint 補的就是這個洞：持一份基線清單，逐檔存在性檢查，少了任何一支就紅並指名。
//
// 基線清單合計 53 支（22 支在 plugins/loops-workflow/hooks/、31 支在 plugins/loops-workflow/scripts/）。
// 來源：#171 T11② 重新對帳——`find plugins/loops-workflow -name "test-*.mjs"` 在收尾當下查得的
// 全量現況（52 支既有 ＋ 1 支本票新增的 test-check-legacy-paths.mjs，見 check-legacy-paths.mjs）。
// 最早的 33 支基線（master@bdb67db：31 支既有＋registry 機制隨附的 2 支
// test-registry-compiler.mjs／test-registry-coverage.mjs）之後陸續有 PR 新增測試檔卻沒同步這份
// 清單，導致清單長期落後現況；本次一併補上落差的 19 支。
// 之後任何 PR 若真的要刪測試檔，得同時改這份清單——這是刻意的摩擦，逼人做出明確決定，
// 而不是讓刪除行為在 glob 迴圈裡悄悄消失。
//
// 分層：
//   1) 判定層（純函式，無 IO）：checkBaseline / formatSummary —— 給單元測試直接 import。
//   2) IO 薄邊界：pathExists（fs port，供純函式可測）＋ buildReport ＋ CLI main——
//      main 被 import 時不執行。
// 依賴：僅 node 內建（fs / path / url / process），無外部套件。
// 用法：node check-baseline-whitelist.mjs [--root <dir>] [--json]

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOOKS_BASELINE = [
  'plugins/loops-workflow/hooks/test-characterization-mutation.mjs',
  'plugins/loops-workflow/hooks/test-config-protection.mjs',
  'plugins/loops-workflow/hooks/test-cost-hooks.mjs',
  'plugins/loops-workflow/hooks/test-edit-accumulator.mjs',
  'plugins/loops-workflow/hooks/test-eval-gate.mjs',
  'plugins/loops-workflow/hooks/test-guard-characterization.mjs',
  'plugins/loops-workflow/hooks/test-harness-equivalence.mjs',
  'plugins/loops-workflow/hooks/test-hook-decision-emit.mjs',
  'plugins/loops-workflow/hooks/test-hook-flags.mjs',
  'plugins/loops-workflow/hooks/test-hook-input-normalize.mjs',
  'plugins/loops-workflow/hooks/test-loop-driver.mjs',
  'plugins/loops-workflow/hooks/test-merge-guard.mjs',
  'plugins/loops-workflow/hooks/test-outbound-comment-guard.mjs',
  'plugins/loops-workflow/hooks/test-path-guard.mjs',
  'plugins/loops-workflow/hooks/test-pr-gate.mjs',
  'plugins/loops-workflow/hooks/test-pr-owner-guard.mjs',
  'plugins/loops-workflow/hooks/test-read-accumulator.mjs',
  'plugins/loops-workflow/hooks/test-session-start.mjs',
  'plugins/loops-workflow/hooks/test-stop-characterization.mjs',
  'plugins/loops-workflow/hooks/test-stop-concurrency.mjs',
  'plugins/loops-workflow/hooks/test-stop-gate.mjs',
  'plugins/loops-workflow/hooks/test-worktree-guard.mjs',
];

const SCRIPTS_BASELINE = [
  'plugins/loops-workflow/scripts/test-baseline-corpus.mjs',
  'plugins/loops-workflow/scripts/test-baseline-report.mjs',
  'plugins/loops-workflow/scripts/test-baseline-trace.mjs',
  'plugins/loops-workflow/scripts/test-canonical-contracts.mjs',
  'plugins/loops-workflow/scripts/test-check-baseline-whitelist.mjs',
  'plugins/loops-workflow/scripts/test-check-e2e-evidence.mjs',
  'plugins/loops-workflow/scripts/test-check-emit-residual.mjs',
  'plugins/loops-workflow/scripts/test-check-legacy-paths.mjs',
  'plugins/loops-workflow/scripts/test-check-registry-shape.mjs',
  'plugins/loops-workflow/scripts/test-codex-plugin-lint.mjs',
  'plugins/loops-workflow/scripts/test-compat-lint.mjs',
  'plugins/loops-workflow/scripts/test-component-resolver.mjs',
  'plugins/loops-workflow/scripts/test-eval-judge.mjs',
  'plugins/loops-workflow/scripts/test-eval-metrics.mjs',
  'plugins/loops-workflow/scripts/test-eval-oracle.mjs',
  'plugins/loops-workflow/scripts/test-eval-panel.mjs',
  'plugins/loops-workflow/scripts/test-eval-passk.mjs',
  'plugins/loops-workflow/scripts/test-eval-poll.mjs',
  'plugins/loops-workflow/scripts/test-eval-runs.mjs',
  'plugins/loops-workflow/scripts/test-eval-sandbox.mjs',
  'plugins/loops-workflow/scripts/test-eval-tags.mjs',
  'plugins/loops-workflow/scripts/test-eval-trajectory.mjs',
  'plugins/loops-workflow/scripts/test-gen-reviewers.mjs',
  'plugins/loops-workflow/scripts/test-lint-mutation.mjs',
  'plugins/loops-workflow/scripts/test-progress.mjs',
  'plugins/loops-workflow/scripts/test-quality-gate.mjs',
  'plugins/loops-workflow/scripts/test-reference-graph.mjs',
  'plugins/loops-workflow/scripts/test-registry-compiler.mjs',
  'plugins/loops-workflow/scripts/test-registry-coverage.mjs',
  'plugins/loops-workflow/scripts/test-safe-stop-assertion.mjs',
  'plugins/loops-workflow/scripts/test-skill-lint.mjs',
];

// 基線：22（hooks）+ 31（scripts）＝ 53 支測試檔（見檔頭的來源說明）。
export const BASELINE_TEST_FILES = [...HOOKS_BASELINE, ...SCRIPTS_BASELINE];

// ── 判定層（純函式，無 IO，測試直接 import）──────────────────────────────────────

/**
 * 逐檔跑存在性檢查；pathExists 由呼叫端注入（IO 已在邊界完成，這裡純比對）。
 * @param {string[]} baseline 相對路徑清單
 * @param {(rel: string) => boolean} pathExists
 * @returns {{ ok: boolean, findings: Array<{check:string, severity:string, file:string, detail:string}> }}
 */
export function checkBaseline(baseline, pathExists) {
  const findings = [];
  for (const rel of baseline) {
    if (!pathExists(rel)) {
      findings.push({
        check: 'baseline-file-missing',
        severity: 'P1',
        file: rel,
        detail: `基線測試檔缺失：${rel}（是被刪了還是搬走了？請同步更新 check-baseline-whitelist.mjs 的清單）`,
      });
    }
  }
  return { ok: findings.length === 0, findings };
}

/** 把整體檢查結果轉人讀摘要：全綠單行 ✓；有 finding → 逐條 "✗ [check] severity file — detail"。 */
export function formatSummary(result) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  if (result?.ok && findings.length === 0) {
    return `✓ check-baseline-whitelist：基線 ${BASELINE_TEST_FILES.length} 支測試檔全數存在。`;
  }
  return findings.map((f) => `✗ [${f.check}] ${f.severity} ${f.file} — ${f.detail}`).join('\n');
}

// ── IO 邊界：存在性檢查 + CLI main ───────────────────────────────────────────────

/** 對 root 跑基線存在性檢查，組成完整結果物件（--json 與人讀摘要共用同一份）。 */
export function buildReport(root) {
  const pathExists = (rel) => existsSync(join(root, ...rel.split('/')));
  return checkBaseline(BASELINE_TEST_FILES, pathExists);
}

function defaultRoot() {
  const scriptDir = fileURLToPath(new URL('.', import.meta.url));
  return join(scriptDir, '..', '..', '..');
}

function parseArgs(argv) {
  const opts = { root: defaultRoot(), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--root') opts.root = argv[++i] ?? opts.root;
    else if (flag === '--json') opts.json = true;
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const result = buildReport(opts.root);
  console.log(opts.json ? JSON.stringify(result, null, 2) : formatSummary(result));
  process.exit(result.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2));
}
