#!/usr/bin/env node
// artifact-phase-gate.mjs —— Phase Gate：離開一個 phase 之前，驗那個 phase 該產的東西（#217 增量 3）。
//
// 要解的問題：階段紀錄「有寫」跟「寫齊」是兩件事。少了關鍵區塊的 plan 或 verify 報告，下游會照樣
// 往前跑——直到很後面才發現當初根本沒有記錄某個決定。這道閘在轉場時把它變成當下就看得見的失敗。
//
// **`iteration-controller` 不是 phase**：它不擁有任何 artifact，所以對它查 phase artifact 一定是空的。
// 把它當 phase 查，只會逼人為了過閘而生出一份沒有意義的文件——#217 明文把它排除在 phase 之外。
//
// **phase exited 的事件由「成功轉移之後」的一方寫**：這支腳本只做檢查、不寫事件，
// 也不要求一個尚未發生的 exit 事件存在（那會讓轉場永遠過不了自己的閘）。
//
// 只對**新制 loop**（已有 `telemetry/`）生效；舊 loop 一律回 skipped，不回填也不阻擋。
//
// 依賴：僅 node 內建 ＋ artifact-contract.mjs。
// 用法：node artifact-phase-gate.mjs --loop <loopDir> --phase <phase> [--json]

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadArtifactRegistry, loadWorkflowVocabulary, validateArtifactDocument } from './artifact-contract.mjs';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 這個 phase **一定**要產出哪些受管產物（registry 是唯一來源，不在這裡另列清單）。
 * `optional: true` 的排除在外——那些是條件式產物（沒畫面可截才寫的替代證據、知情豁免留痕），
 * 無條件要求它們存在，只會逼人為了過閘生出一份沒有意義的文件。
 */
export function artifactsForPhase(registry, phase) {
  return (registry?.artifacts ?? []).filter((a) => a.producer === phase
    && (a.gate === 'phase' || a.gate === 'finalize')
    && a.optional !== true);
}

/** 把 registry 的 path_pattern 套上實際 slug → 這條 loop 裡的實際相對路徑。 */
export function resolvePathForLoop(pattern, slug) {
  return String(pattern ?? '').replace('<slug>', slug);
}

/**
 * 檢查一個 phase 的產出 → `{ ok, skipped, phase, findings, checked }`。
 * `skipped:true` 代表這條 loop 不受管（舊制）或這個節點不是 phase——兩者都不是失敗。
 */
export function checkPhase(loopDir, phase, { registry: injectedRegistry, vocabulary: injectedVocab } = {}) {
  const loadedVocab = injectedVocab ? { vocabulary: injectedVocab } : loadWorkflowVocabulary(PLUGIN_ROOT);
  if (loadedVocab.error) return { ok: false, skipped: false, phase, checked: 0, findings: [{ check: 'vocabulary-load', detail: loadedVocab.error }] };

  const isPhase = (loadedVocab.vocabulary.phases ?? []).some((p) => p.id === phase);
  if (!isPhase) {
    return {
      ok: true, skipped: true, phase, checked: 0,
      findings: [],
      reason: `「${phase}」不是工作階段（控制節點不擁有 artifact，對它查 phase 產出必然是空的）`,
    };
  }

  if (!existsSync(join(loopDir, 'telemetry'))) {
    return { ok: true, skipped: true, phase, checked: 0, findings: [], reason: '這條 loop 不是新制（沒有 telemetry/），依 #217 不回填也不阻擋' };
  }

  const loaded = injectedRegistry ? { registry: injectedRegistry } : loadArtifactRegistry(PLUGIN_ROOT);
  if (loaded.error) return { ok: false, skipped: false, phase, checked: 0, findings: [{ check: 'registry-load', detail: loaded.error }] };

  const slug = loopDir.split(/[/\\]/).filter(Boolean).pop() ?? '<slug>';
  const findings = [];
  let checked = 0;

  for (const artifact of artifactsForPhase(loaded.registry, phase)) {
    const rel = resolvePathForLoop(artifact.path_pattern, slug);
    // path_pattern 只描述 `.loops/<slug>/…` 這種本地產物；GitHub 型沒有本地檔可查。
    if (!rel.startsWith('.loops/')) continue;
    const abs = join(loopDir, rel.split('/').slice(2).join('/'));
    checked += 1;

    if (!existsSync(abs)) {
      findings.push({ check: 'missing-artifact', artifact: artifact.artifact_id, detail: `${phase} 應該產出的 ${artifact.artifact_id} 不存在：${rel}` });
      continue;
    }
    let text = '';
    try { text = readFileSync(abs, 'utf8'); } catch (err) {
      findings.push({ check: 'unreadable-artifact', artifact: artifact.artifact_id, detail: `讀不到 ${rel}：${err?.message ?? err}` });
      continue;
    }
    const result = validateArtifactDocument(loaded.registry, { path: rel, text });
    for (const f of result.findings) findings.push({ ...f, artifact: artifact.artifact_id });
  }

  return { ok: findings.length === 0, skipped: false, phase, checked, findings };
}

/** 人讀摘要。 */
export function formatSummary(report) {
  if (report.skipped) return `· artifact-phase-gate（${report.phase}）：略過——${report.reason}`;
  if (report.ok) return `✓ artifact-phase-gate（${report.phase}）：檢查 ${report.checked} 份產出，全部符合契約。`;
  return [`✗ artifact-phase-gate（${report.phase}）：檢查 ${report.checked} 份產出，${report.findings.length} 個 finding。`,
    ...report.findings.map((f) => `  ✗ [${f.check}] ${f.artifact ?? '-'} — ${f.detail}`)].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const loopDir = args.includes('--loop') ? args[args.indexOf('--loop') + 1] : null;
  const phase = args.includes('--phase') ? args[args.indexOf('--phase') + 1] : null;
  if (!loopDir || !phase) {
    process.stderr.write('用法：node artifact-phase-gate.mjs --loop <loopDir> --phase <phase> [--json]\n');
    return 1;
  }
  const report = checkPhase(loopDir, phase);
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${formatSummary(report)}\n`);
  return report.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
