#!/usr/bin/env node
// component-resolver.mjs —— 由 component id 解析出「絕對路徑」的單一入口（#171 T2）。
//
// 為什麼要有這層：prompt／agent／script 裡硬編相對路徑，在 subagent 的 CWD 下解不到
// （CWD 不可靠），而目錄重整後那些相對路徑又會整批失效。以 component-registry.json 的
// component id 當唯一穩定鍵、路徑一律交給本模組算，搬檔時只要 registry 跟著改，呼叫端零改動。
//
// 三條硬規則（各有測試）：
//   R1 找不到 id → 丟例外並指名 id（**不回 null**：回 null 會讓呼叫端靜默拼出壞路徑，
//      壞路徑要到很後面才炸、且炸在跟根因無關的地方）。
//   R2 一律回絕對路徑（相對路徑在 subagent 的 CWD 下等於沒解析）。
//   R3 不做 fallback 猜測——候選路徑只來自 registry 宣告的 paths／target_path，不試同名檔、
//      不掃目錄。全部候選都不存在 → 丟例外並列出試過的候選（猜錯比找不到更難查）。
//
// 分層：純解析（候選路徑推導）＋薄 IO（讀 registry、existsSync）＋薄 CLI。依賴：僅 node 內建。
//
// CLI（#171 T9 新增）：`node component-resolver.mjs <id> [<id>…]` 逐行印出絕對路徑。
// 為什麼本模組原本刻意不開 CLI、現在開：唯一的呼叫端本來只有 .mjs（直接 import 即可），
// 但派 subagent 的 orchestrator 是 **markdown skill**，它沒有 import，只能跑一行指令——
// 沒有 CLI 就等於逼它回頭自己拼相對路徑，正是本次重整要消滅的東西（見 AGENTS.md〈參考檔路徑解析〉）。
// 解不到一律非零退出並把例外訊息印到 stderr（沿用 R1/R3：不靜默、不猜）。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REGISTRY_REL = 'plugins/loops-workflow/references/component-registry.json';

// root → { root, components, byId }。registry 在單次行程內不會變，重複 JSON.parse 166 個元件
// 只是白花時間；以 root 絕對路徑為鍵，測試用 mkdtemp 造的各棵樹自然互不干擾。
const registryCache = new Map();

/** 本檔位於 <repo>/plugins/loops-workflow/scripts/ → 往上三層即 repo 根。 */
export function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/**
 * 讀取並索引 component-registry.json。讀不到／格式不對 → 丟例外（附絕對路徑）：
 * registry 是本模組唯一的真相源，讀不到就沒有任何「合理預設」可退，靜默退化只會把錯誤延後。
 */
export function loadRegistry(root = repoRoot()) {
  const key = resolve(root);
  const cached = registryCache.get(key);
  if (cached) return cached;

  const registryPath = join(key, REGISTRY_REL);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch (err) {
    throw new Error(`component-resolver：讀不到或解析不了 component registry（${registryPath}）：${err.message}`);
  }
  if (!Array.isArray(parsed?.components)) {
    throw new Error(`component-resolver：${registryPath} 缺少 components 陣列`);
  }

  const registry = {
    root: key,
    components: parsed.components,
    byId: new Map(parsed.components.map((c) => [c.id, c])),
  };
  registryCache.set(key, registry);
  return registry;
}

function registryOf(opts) {
  return opts?.registry ?? loadRegistry(opts?.root);
}

function componentOf(id, registry) {
  const component = registry.byId.get(id);
  if (!component) {
    throw new Error(`component-resolver：registry 內找不到元件 id「${id}」（registry 共 ${registry.byId.size} 個元件）`);
  }
  return component;
}

function isLiteralPath(p) {
  return typeof p === 'string' && p !== '' && !p.includes('*');
}

/**
 * 單一檔案元件的候選路徑：現況 paths（恰一條字面路徑）＋ registry 宣告的 target_path（搬遷後
 * 落點）。兩者都是 registry 宣告的、不是猜的 —— 同時收下兩者，是為了讓「搬到一半的樹」也解得到：
 * 搬檔期間 paths 尚未更新，但檔案已在 target_path，呼叫端不該因此整批解不到。
 * 多路徑／純 glob 元件（如 hook-shared-runtime、docs/**）沒有單一落點 → 回空陣列，
 * 由 resolveComponent 丟例外說明，不亂挑第一條。
 */
function candidatePaths(component) {
  const literal = (Array.isArray(component.paths) ? component.paths : []).filter(isLiteralPath);
  if (literal.length !== 1) return [];
  const target = isLiteralPath(component.target_path) ? [component.target_path] : [];
  return [...new Set([...literal, ...target])];
}

/** component id → 磁碟上實際存在的絕對路徑。違反 R1/R3 的情境一律丟例外，不回 null。 */
export function resolveComponent(id, opts = {}) {
  const registry = registryOf(opts);
  const component = componentOf(id, registry);

  const candidates = candidatePaths(component);
  if (candidates.length === 0) {
    throw new Error(
      `component-resolver：元件「${id}」不是單一檔案元件（paths=${JSON.stringify(component.paths ?? null)}），無法解析成單一路徑`,
    );
  }

  for (const rel of candidates) {
    const abs = join(registry.root, rel);
    if (existsSync(abs)) return abs;
  }
  throw new Error(
    `component-resolver：元件「${id}」的候選路徑都不存在（試過：${candidates.join('、')}；root=${registry.root}）——registry 與磁碟已漂移，本模組不做同名檔猜測`,
  );
}

/** 一批 id → { id: 絕對路徑 }。任一 id 解不到即丟例外（指名該 id），不回部分結果。 */
export function resolveMany(ids, opts = {}) {
  if (!Array.isArray(ids)) {
    throw new TypeError('component-resolver：resolveMany 需要 id 陣列');
  }
  const registry = registryOf(opts);
  const out = {};
  for (const id of ids) {
    out[id] = resolveComponent(id, { ...opts, registry });
  }
  return out;
}

/**
 * 依 owner_class 列出元件（回 registry 原物件，含 paths／target_path／user_invocable）。
 * 沒有任何元件宣告該 owner_class → 丟例外並列出已知值：拼錯的 owner class 回空陣列，
 * 跟「這類真的沒有成員」長得一模一樣，是與 R1 同型的靜默錯誤。
 */
export function listByOwner(ownerClass, opts = {}) {
  const registry = registryOf(opts);
  const known = new Set(registry.components.map((c) => c.owner_class));
  if (!known.has(ownerClass)) {
    const shown = [...known].map((v) => (v === null ? 'null' : v)).sort().join('、');
    throw new Error(`component-resolver：registry 內沒有 owner_class「${ownerClass}」（已知：${shown}）`);
  }
  return registry.components.filter((c) => c.owner_class === ownerClass);
}

// ── 薄 CLI：markdown orchestrator 取絕對路徑的唯一入口 ─────────────────────────

function main(argv) {
  if (argv.length === 0) {
    console.error('用法：node component-resolver.mjs <component-id> [<component-id>…]（id 見 references/component-registry.json）');
    process.exit(2);
  }
  try {
    const resolved = resolveMany(argv);
    for (const id of argv) console.log(resolved[id]);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2));
}
