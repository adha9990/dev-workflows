#!/usr/bin/env node
// gen-hooks-codex.mjs —— hooks/hooks-codex.json（generated 投影）重生器（#183 T25）。
// 真相源：hooks/hooks.json（Claude 側正本）＋ capability-registry.json 的
// facets.hook_events.platforms.codex.projection_mapping（matcher 別名表）。投影規則（事件 1:1、
// matcher 別名、command 原樣保留）由 compat-lint.mjs 的 projectHooksToCodex 提供，本檔直接
// reuse、不重寫一份（避免生成器與 C6 漂移檢查各自維護一套規則、彼此脫鉤）。
//
// 用法：node gen-hooks-codex.mjs --write   讀真相源、重生 hooks/hooks-codex.json（保留既有
//                                          _meta.generator/warning/verification_status 文案，
//                                          只重算 hooks 區塊）。
// 手改 hooks-codex.json 不要用這支修——改 hooks.json 正本或 registry 的 projection_mapping，
// 再跑本檔重生；漂移偵測本身是 compat-lint.mjs 的 C6，不在這裡重複。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseRegistryJson } from './check-registry-shape.mjs';
import { projectHooksToCodex } from './compat-lint.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = dirname(SCRIPTS_DIR);
const HOOKS_JSON_FILE = join(PLUGIN_DIR, 'hooks', 'hooks.json');
const HOOKS_CODEX_JSON_FILE = join(PLUGIN_DIR, 'hooks', 'hooks-codex.json');
const REGISTRY_FILE = join(PLUGIN_DIR, 'references', 'capability-registry.json');

const DEFAULT_META = {
  generated: true,
  generator: 'plugins/loops-workflow/scripts/gen-hooks-codex.mjs --write（真相源：hooks/hooks.json + references/capability-registry.json#facets.hook_events.platforms.codex.projection_mapping）',
  warning: '此檔為 generated 投影，請勿手改；要改請改 hooks/hooks.json 正本或 registry 的 projection_mapping 再重生（node plugins/loops-workflow/scripts/gen-hooks-codex.mjs --write）。compat-lint.mjs 的 C6 檢查會對此檔做漂移比對，手改會紅。',
  verification_status: '形狀依官方文件（learn.chatgpt.com/docs/hooks）與 evals/baseline/codex/gaps.json 的 codex.hooks.trigger_trust／codex.guard.shell_apply_patch 兩筆推導投影，尚未經真機校驗（兩筆 gaps 皆列 blocker=authenticated Codex session）。matcher 別名僅涵蓋官方文件明載的 Edit/Write→apply_patch；MultiEdit/Read/PowerShell 無官方別名記載，原樣保留、視同未驗證直通。',
};

/** 組出完整 hooks-codex.json 內容（純函式）：既有 _meta（若存在）保留文案、只重算 hooks。 */
export function buildHooksCodexFile({ hooksJson, registry, existingMeta }) {
  const mappingRules = registry?.facets?.hook_events?.platforms?.codex?.projection_mapping ?? null;
  return {
    _meta: existingMeta ?? DEFAULT_META,
    description: 'loops-workflow hooks 的 Codex 側等價投影（由 hooks/hooks.json 逐事件／matcher 投影而成，事件集合與正本 1:1 對應；matcher 依 registry projection_mapping 的 matcher_tool_alias 表投影）；其餘規則同正本：SessionStart/progress 恆跑，其餘逐 flag 拍板，除 deny 類與 loop-driver opt-in 外不擋路。',
    hooks: projectHooksToCodex(hooksJson, mappingRules),
  };
}

function main() {
  const write = process.argv.includes('--write');
  if (!write) {
    console.error('用法：node gen-hooks-codex.mjs --write');
    process.exit(1);
  }
  const hooksJson = JSON.parse(readFileSync(HOOKS_JSON_FILE, 'utf8'));
  const parsedRegistry = parseRegistryJson(readFileSync(REGISTRY_FILE, 'utf8'));
  if (parsedRegistry.error) {
    console.error(parsedRegistry.error);
    process.exit(1);
  }
  const existingMeta = existsSync(HOOKS_CODEX_JSON_FILE)
    ? JSON.parse(readFileSync(HOOKS_CODEX_JSON_FILE, 'utf8'))._meta
    : undefined;
  const out = buildHooksCodexFile({ hooksJson, registry: parsedRegistry.registry, existingMeta });
  writeFileSync(HOOKS_CODEX_JSON_FILE, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  console.log(`已重生 ${HOOKS_CODEX_JSON_FILE}`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
