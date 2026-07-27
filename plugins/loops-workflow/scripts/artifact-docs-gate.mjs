#!/usr/bin/env node
// artifact-docs-gate.mjs —— Docs Gate：受管的人類文件都要有登記過的契約（#217 增量 3）。
//
// 要解的問題：人看的 Markdown 一直在長出來——README、各種 guide、驗收報告、設計 spec——但沒有任何
// 機制回答「這份文件屬於哪一類、該長什麼樣、誰在驗它」。結果是同一種東西在不同地方長成不同樣子，
// 而且新增一份時漏掉模板或 validator，沒有人會發現。這道閘把「分類」變成機械可判的事：
// 每份受管文件第一行帶 `<!-- loops-artifact: <id>@<v> -->`，id 必須在 artifact registry 登記過。
//
// **掃描面與豁免**都取自 registry（`artifacts[].path_pattern` 與 `unmanaged[]`），本檔不另立第二份名單——
// 兩份名單一定會漂移，而漂移的那一天沒有人會知道。
//
// **plugin 內的 docs**：`plugins/<x>/docs/<y>.md` 與 repo 根的 `docs/<y>.md` 是同一類人類文件，
// 只是落點不同。比對時把前者正規化成後者，讓 registry 只需要一條 `docs/**`，不必為每個 plugin
// 各寫一條（那正是會漂移的形狀）。
//
// 依賴：僅 node 內建 ＋ artifact-contract.mjs。
// 用法：node artifact-docs-gate.mjs [--root <dir>] [--json]

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadArtifactRegistry, validateArtifactDocument, resolveArtifactCandidates } from './artifact-contract.mjs';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 要掃的人類文件面（相對 repo 根）。與 docs-lint 的 HUMAN_DOC_ROOTS 同一組落點。 */
export const DOC_ROOTS = Object.freeze(['README.md', 'docs', join('plugins', 'loops-workflow', 'docs')]);

const norm = (p) => String(p).split('\\').join('/');

/**
 * 把 plugin 內的 docs 路徑正規化成 registry 認得的形狀。
 * `plugins/loops-workflow/docs/settings.md` → `docs/settings.md`；其餘原樣。
 */
export function normalizeDocPath(relPath) {
  const p = norm(relPath);
  const m = /^plugins\/[^/]+\/(docs\/.*)$/.exec(p);
  return m ? m[1] : p;
}

function walkMd(dir, out = []) {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names.sort()) {
    const full = join(dir, name);
    try {
      if (statSync(full).isDirectory()) walkMd(full, out);
      else if (name.endsWith('.md')) out.push(full);
    } catch { /* 單一項目失敗跳過 */ }
  }
  return out;
}

/** 收集要驗的人類文件 → `[{rel, lookup, abs, text}]`。 */
export function collectDocs(root) {
  const files = [];
  for (const entry of DOC_ROOTS) {
    const abs = join(root, entry);
    if (!existsSync(abs)) continue;
    const list = statSync(abs).isDirectory() ? walkMd(abs) : [abs];
    for (const f of list) {
      const rel = norm(relative(root, f));
      try {
        files.push({ rel, lookup: normalizeDocPath(rel), abs: f, text: readFileSync(f, 'utf8') });
      } catch { /* 讀不到就跳過 */ }
    }
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** 逐份驗證 → `{ ok, findings, scanned, managed }`。 */
export function buildReport(root, { registry: injected } = {}) {
  const loaded = injected ? { registry: injected } : loadArtifactRegistry(PLUGIN_ROOT);
  if (loaded.error) {
    return { ok: false, scanned: 0, managed: 0, findings: [{ check: 'registry-load', severity: 'P1', file: '-', detail: loaded.error }] };
  }
  const registry = loaded.registry;

  const findings = [];
  const files = collectDocs(root);
  let managed = 0;

  for (const f of files) {
    // 這條路徑有沒有對應契約，一律問 registry（不在本檔另立豁免名單）。
    if (resolveArtifactCandidates(registry, f.lookup).length === 0) continue;
    managed += 1;
    const result = validateArtifactDocument(registry, { path: f.lookup, text: f.text });
    for (const finding of result.findings) findings.push({ ...finding, file: f.rel });
  }

  return { ok: findings.length === 0, scanned: files.length, managed, findings };
}

/** 人讀摘要。 */
export function formatSummary(report) {
  if (report.ok) {
    return `✓ artifact-docs-gate：掃 ${report.scanned} 份文件、其中 ${report.managed} 份受管，全部有登記過的契約。`;
  }
  return [
    `✗ artifact-docs-gate：掃 ${report.scanned} 份文件、其中 ${report.managed} 份受管，${report.findings.length} 個 finding。`,
    ...report.findings.map((f) => `  ✗ [${f.check}] ${f.file} — ${f.detail}`),
  ].join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function repoRoot() {
  return join(PLUGIN_ROOT, '..', '..');
}

function main() {
  const args = process.argv.slice(2);
  const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : repoRoot();
  const report = buildReport(root);
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${formatSummary(report)}\n`);
  return report.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
