#!/usr/bin/env node
// artifact-creation-guard.mjs —— Creation Gate：新建受管 Markdown 時就驗契約（#217 增量 3）。
//
// 為什麼擋在「寫下去的那一刻」：格式債的特性是**寫的時候零成本、發現的時候已經散落各處**。
// 等到 CI 或 review 才發現一份文件沒有 artifact marker、或少了必填區塊，那份文件通常已經被
// 引用、被複製、被當成下一份的範本了。擋在 Write 的當下，修正成本是一行。
//
// **只管整檔寫入（Write），不管局部編輯（Edit／MultiEdit）**：局部編輯拿到的是片段而不是完整
// 文件，用片段去驗「必填區塊齊不齊」必然誤判——而一道會誤判的閘，最後一定會被關掉。
// 新建與整檔覆寫都會走 Write，這已經涵蓋「新增一種產物」這個真正要治的行為。
//
// **作用範圍**（任一不成立就完全 no-op）：
//   ① flag 未關；② 是 Write；③ 目標路徑在 artifact registry 有對應契約；
//   ④ 若目標在 `.loops/` 底下，那條 loop 必須是**新制**（已有 `telemetry/`）——舊 loop 的格式
//      不一致按 #217 明文保留，不回填、不阻擋。
//
// 出錯一律 fail-open（放行）。依賴：僅 node 內建 ＋ 本 repo 內既有 hook／script。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { flagEnabled } from './hook-flags.mjs';
import { emitDecision, ACTIVE_HARNESS } from './hook-decision-emit.mjs';
import { resolveLoopsRoot } from './cost-tracker.mjs';
import { loadArtifactRegistry, validateArtifactDocument, resolveArtifactCandidates } from '../scripts/artifact-contract.mjs';

const HOOK_EVENT = 'PreToolUse';
// 用 fileURLToPath 而不是 URL.pathname：後者在 Windows 上會留下前導斜線（`/C:/…`），
// 拼出來的路徑讀不到檔，而本 hook 的失敗模式是「靜默不擋」——那種 bug 不會有人發現。
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const norm = (p) => String(p ?? '').split('\\').join('/');

/**
 * 把工具給的路徑換算成「相對 repo 根」的形狀（registry 的 path_pattern 就是這個形狀）。
 * 判不出來回 null——判不出就不管，這是本家族的 fail-open 慣例。
 */
export function toRepoRelative(filePath, cwd) {
  const root = resolveLoopsRoot(cwd);
  if (!root || !filePath) return null;
  const abs = isAbsolute(filePath) ? filePath : resolve(cwd || root, filePath);
  const rel = norm(relative(root, abs));
  if (rel === '' || rel.startsWith('../')) return null; // 落在 repo 之外
  return rel;
}

/**
 * `.loops/<slug>/…` 的目標是否屬於新制 loop（有 telemetry/）。
 * 非 `.loops/` 路徑一律回 true（人類文件不分新舊，一律受管）。
 */
export function isManagedTarget(repoRel, loopsRoot) {
  const m = /^\.loops\/([^/]+)\//.exec(norm(repoRel));
  if (!m) return true;
  return existsSync(join(loopsRoot, '.loops', m[1], 'telemetry'));
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }

  if (!flagEnabled('LOOPS_ARTIFACT_GATE', process.env)) return;
  if (String(payload?.tool_name ?? '') !== 'Write') return;

  const filePath = payload?.tool_input?.file_path;
  const content = payload?.tool_input?.content;
  if (typeof filePath !== 'string' || typeof content !== 'string') return;
  if (!filePath.endsWith('.md')) return;

  const repoRel = toRepoRelative(filePath, payload?.cwd);
  if (!repoRel) return;

  const loaded = loadArtifactRegistry(PLUGIN_ROOT);
  if (loaded.error) return; // 讀不到 registry 就不擋（沒有依據的阻擋只會製造噪音）
  const registry = loaded.registry;

  if (resolveArtifactCandidates(registry, repoRel).length === 0) return; // 不納管
  if (!isManagedTarget(repoRel, resolveLoopsRoot(payload.cwd))) return; // 舊制 loop 不受影響

  const result = validateArtifactDocument(registry, { path: repoRel, text: content });
  if (result.ok) return;

  const reason = [
    `這份受管的人類文件不符合它登記的契約：${repoRel}`,
    ...result.findings.map((f) => `  · [${f.check}] ${f.detail}`),
    '',
    '契約定義在 references/artifact-registry.json；新增一種人類 Markdown 產物時，要同時補 catalog entry、template 與 validator。',
    '確需繞過設 LOOPS_ARTIFACT_GATE=0。',
  ].join('\n');

  const out = emitDecision({ kind: 'deny', reason }, ACTIVE_HARNESS, HOOK_EVENT);
  if (out) process.stdout.write(`${out}\n`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch {
    // hook 絕不可因錯誤擋路
  }
  process.exit(0);
}
