#!/usr/bin/env node
// final-acceptance.mjs —— 全 repo hardening 與最終驗收（#181）。
//
// 日常一條 issue 只跑波及範圍，成本可控但**不代表跨元件的組合一定正確**。所有功能合併之後，需要
// 一次獨立、全 repo 的驗收：把每一道閘從頭跑一遍，並產出一份**可追溯、誠實**的報告。
//
// 這份報告最重要的性質是**誠實**：
//   · 跑得起來的，回報實際結果（`passed` / `failed`）；
//   · 環境裡沒有那個來源、跑不了的，一律 `not measured`——**絕不寫成 passed，也不寫成「已優化」**；
//   · 有實測但沒變好的，寫 `not improved`，不粉飾。
//
// 因此本檔的 `runGate()` 只有兩種結果來源：**真的跑了**，或**明確標記為沒跑**。沒有第三種。
//
// 純函式（GATES 定義 / summarize / renderReport）＋ IO 薄邊界（runGate 走 spawnSync）。
// 依賴：僅 node 內建。

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 一項驗收的結果值域。 */
export const GATE_RESULTS = Object.freeze(['passed', 'failed', 'not measured']);

/** 沒跑的一律用這個字面。 */
export const NOT_MEASURED = 'not measured';

/**
 * 全 repo 驗收要跑的閘。`kind`：
 *   · `script`  —— 直接跑一支腳本，exit 0 即通過；
 *   · `suite`   —— 跑一整個目錄的 `test-*.mjs`；
 *   · `external`—— **需要外部來源**才跑得動；來源不在就 `not measured`（誠實，不是失敗）。
 */
export const GATES = Object.freeze([
  { id: 'registry-compiler', kind: 'script', script: 'registry-compiler.mjs', why: 'policy／component／integration 三表的形狀、互指與衝突' },
  { id: 'policy-runtime', kind: 'script', script: 'policy-runtime.mjs', why: '四級規則編譯，且每支會 deny 的 hook 都有宣告來源' },
  { id: 'skill-lint', kind: 'script', script: 'skill-lint.mjs', why: 'skill／agent／reference 的引用、計數與 flag 三方同步' },
  { id: 'compat-lint', kind: 'script', script: 'compat-lint.mjs', why: 'canonical 規則文字守平台中立表面' },
  { id: 'codex-plugin-lint', kind: 'script', script: 'codex-plugin-lint.mjs', why: '第二個 harness 的 manifest 與投影一致' },
  { id: 'check-registry-shape', kind: 'script', script: 'check-registry-shape.mjs', why: 'registry envelope 形狀' },
  { id: 'artifact-contract', kind: 'script', script: 'artifact-contract.mjs', why: 'artifact contract registry 形狀、producer 對得上 workflow vocabulary、template 不 dangling' },
  { id: 'artifact-docs-gate', kind: 'script', script: 'artifact-docs-gate.mjs', why: '受管的人類文件都有 artifact marker、marker 指得到登記過的契約、必填區塊齊全' },
  { id: 'codex-telemetry-probe', kind: 'script', script: 'codex-telemetry.mjs', why: 'Codex capability probe 可跑且誠實回報（沒有 runtime 時全數 not_measured，不假裝量過）' },
  { id: 'check-legacy-paths', kind: 'script', script: 'check-legacy-paths.mjs', why: '沒有扁平舊路徑殘留' },
  { id: 'check-emit-residual', kind: 'script', script: 'check-emit-residual.mjs', why: 'hook 輸出信封沒有殘留的舊寫法' },
  { id: 'check-plugin-version', kind: 'script', script: 'check-plugin-version.mjs', why: 'plugin 對外表面（skill／公開入口／hook 集合）變動時版本有跟著前進' },
  { id: 'docs-lint', kind: 'script', script: 'docs-lint.mjs', why: '人類文件的連結／指令／來源／參數與事實一致' },
  { id: 'setup-plan', kind: 'script', script: 'setup-plan.mjs', why: 'setup catalog 自洽、資格未過的來源不在選單' },
  { id: 'reference-graph', kind: 'script', script: 'reference-graph.mjs', args: ['--compare'], why: '規範引用圖與基準逐條比對（抓文件漂移）' },
  { id: 'gen-reviewers', kind: 'script', script: 'gen-reviewers.mjs', args: ['--check'], why: '生成的 reviewer 人設與真相源沒有漂移' },
  { id: 'hook-tests', kind: 'suite', dir: 'hooks', why: 'hook 的 direct／bypass／approval／malformed-state 全套' },
  { id: 'script-tests', kind: 'suite', dir: 'scripts', why: 'registry／記憶體／policy／setup／optimization／docs 的全部單元與整合測試' },
  { id: 'skill-optimizer-run', kind: 'external', source: 'skill-optimizer', why: '對所有支援的 skill 產候選並依序驗收' },
  { id: 'prompt-eval-full', kind: 'external', source: 'prompt-eval', why: '完整 corpus ＋ held-out trajectory' },
  { id: 'token-benchmark-full', kind: 'external', source: 'token-optimizer', why: '全 corpus 的 token／call／duration 實測對照' },
  { id: 'symbol-consistency', kind: 'external', source: 'symbol-aware-editor', why: '符號與引用一致性' },
]);

// ── 執行（IO 薄邊界）──────────────────────────────────────────────────────

function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/** 跑一支 node 腳本，回 `{result, detail}`。 */
function runScript(root, rel, args = []) {
  const res = spawnSync(process.execPath, [join(root, 'plugins', 'loops-workflow', 'scripts', rel), ...args], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (res.error) return { result: 'failed', detail: `無法執行：${res.error.message}` };
  const tail = String(res.stdout || res.stderr || '').trim().split('\n').slice(-1)[0] ?? '';
  return { result: res.status === 0 ? 'passed' : 'failed', detail: tail.slice(0, 200) };
}

/** 跑一整個目錄的 `test-*.mjs`，回通過數與失敗清單。 */
function runSuite(root, dir) {
  const base = join(root, 'plugins', 'loops-workflow', dir);
  let files = [];
  try { files = readdirSync(base).filter((f) => f.startsWith('test-') && f.endsWith('.mjs')); } catch {
    return { result: NOT_MEASURED, detail: `讀不到 ${dir}/` };
  }
  const failures = [];
  for (const f of files) {
    const res = spawnSync(process.execPath, [join(base, f)], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (res.status !== 0) failures.push(f);
  }
  return {
    result: failures.length === 0 ? 'passed' : 'failed',
    detail: failures.length ? `${files.length} 支中 ${failures.length} 支失敗：${failures.join('、')}` : `${files.length} 支全綠`,
  };
}

/**
 * 跑一項閘。`available` 是外部來源可用性的判定 port（`(sourceId) => boolean`）——
 * **沒注入就一律當作不可用**，於是外部項全部落 `not measured`。這是刻意的：
 * 「不知道有沒有裝」與「裝了而且過了」之間，只能誠實選前者。
 */
export function runGate(gate, { root = repoRoot(), available = null } = {}) {
  if (gate.kind === 'external') {
    const ok = typeof available === 'function' ? available(gate.source) === true : false;
    if (!ok) return { id: gate.id, result: NOT_MEASURED, detail: `外部來源 \`${gate.source}\` 未安裝或未啟用——沒跑就標 ${NOT_MEASURED}，不寫成 passed`, why: gate.why };
    return { id: gate.id, result: NOT_MEASURED, detail: `來源可用，但本檔不代跑外部工具；請由 /setup 安裝後另跑並回填實測`, why: gate.why };
  }
  const out = gate.kind === 'suite' ? runSuite(root, gate.dir) : runScript(root, gate.script, gate.args ?? []);
  return { id: gate.id, result: out.result, detail: out.detail, why: gate.why };
}

/** 跑全部閘。 */
export function runAll({ root = repoRoot(), available = null, only = null } = {}) {
  const gates = only ? GATES.filter((g) => only.includes(g.id)) : GATES;
  return gates.map((g) => runGate(g, { root, available }));
}

// ── 摘要與報告（純函式）──────────────────────────────────────────────────

/** 統計。`ok` 的定義刻意是「**沒有 failed**」——`not measured` 不算通過，但也不算失敗。 */
export function summarize(results) {
  const counts = { passed: 0, failed: 0, [NOT_MEASURED]: 0 };
  for (const r of results) counts[r.result] = (counts[r.result] ?? 0) + 1;
  return {
    ok: counts.failed === 0,
    complete: counts.failed === 0 && counts[NOT_MEASURED] === 0,
    counts,
    failed: results.filter((r) => r.result === 'failed').map((r) => r.id),
    notMeasured: results.filter((r) => r.result === NOT_MEASURED).map((r) => r.id),
  };
}

/**
 * 最終報告（markdown）。**未跑的項目一律逐條列出並標 `not measured`**——
 * 一份把沒跑的項目藏起來的驗收報告，比沒有報告更危險。
 */
export function renderReport(results, { at = null } = {}) {
  const s = summarize(results);
  const lines = [
    '# 最終驗收報告',
    '',
    at ? `產出時間：${at}` : '',
    '',
    s.complete
      ? '**全部項目都跑過且通過。**'
      : (s.ok
        ? `**跑得起來的項目全部通過；有 ${s.counts[NOT_MEASURED]} 項因環境缺少對應來源而未量測（逐項列在下方，未量測不等於通過）。**`
        : `**有 ${s.counts.failed} 項失敗，需處理後才可接受。**`),
    '',
    `| 通過 | 失敗 | 未量測 |`,
    `|---|---|---|`,
    `| ${s.counts.passed} | ${s.counts.failed} | ${s.counts[NOT_MEASURED]} |`,
    '',
    '## 逐項',
    '',
    '| 項目 | 結果 | 查什麼 | 說明 |',
    '|---|---|---|---|',
  ];
  for (const r of results) {
    const mark = r.result === 'passed' ? '✓ passed' : (r.result === 'failed' ? '✗ failed' : `— ${NOT_MEASURED}`);
    lines.push(`| \`${r.id}\` | ${mark} | ${r.why} | ${r.detail} |`);
  }
  lines.push('');
  if (s.notMeasured.length) {
    lines.push('## 未量測的項目（誠實揭露）', '',
      '這些項目需要對應的外部來源就位才跑得動。**未量測不等於通過**——安裝之後要另跑並回填實測結果。', '');
    for (const id of s.notMeasured) lines.push(`- \`${id}\``);
    lines.push('');
  }
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : repoRoot();
  const only = args.includes('--only') ? String(args[args.indexOf('--only') + 1] ?? '').split(',').filter(Boolean) : null;
  const results = runAll({ root, only });
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ summary: summarize(results), results }, null, 2)}\n`);
  } else if (args.includes('--report')) {
    process.stdout.write(renderReport(results));
  } else {
    const s = summarize(results);
    process.stdout.write(`${s.ok ? '✓' : '✗'} final-acceptance：${s.counts.passed} 通過／${s.counts.failed} 失敗／${s.counts[NOT_MEASURED]} 未量測\n`);
    for (const r of results) {
      const mark = r.result === 'passed' ? '✓' : (r.result === 'failed' ? '✗' : '—');
      process.stdout.write(`  ${mark} ${r.id}：${r.detail}\n`);
    }
  }
  return summarize(results).ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
