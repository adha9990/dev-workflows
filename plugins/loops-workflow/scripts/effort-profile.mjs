#!/usr/bin/env node
// effort-profile.mjs —— 投入檔位（effort profile）的確定性判定與地板稽核（#222）。
//
// 要解的問題：既有的右尺寸化機制縮的都是「要不要加派」那一段（risk-map 的 predicate、
// verify-triage 的風險梯、evidence-portfolio 的證據階梯）。沒有一個在管**每條 loop 都要付的固定
// ceremony**——完整施工圖、機制圖、對齊 comment、三份完工 deliverable、收尾裁測、回環軟上限。
// 於是「改一段文案」和「改一條交易邊界」付的基礎成本幾乎一樣。檔位補的就是這一層。
//
// 這支腳本只做**機械判得動的那半**，語意判斷留給 skill 正文（見 `references/stages/effort-profile.md`）：
//   1. `--classify`：把 dispatch 逐條核出來的 predicate 布林值，算成一個檔位 ＋ 逐條理由。
//      為什麼要一支腳本而不是讓模型心算：檔位是「只升不降」的東西，升降必須可機械判定，
//      而且「判不出來就往嚴」這件事不能靠記得——它得是資料形狀的預設值。
//   2. `--audit`：讀 loop.md 宣告的檔位 ＋ Journal 的升檔軌跡 ＋ 本次實際改動的檔案清單，判
//      **這條 loop 有沒有低於它自己的地板**，吐一行 marker 給 `hooks/pr-gate.mjs` 閘⑨ 讀：
//        <!-- loops-effort profile=… floor=ok|violated highrisk=yes|no|unknown escalated=<n> -->
//
// 誠實邊界（規則 5）：讀不到 diff 時 `highrisk=unknown`、**不猜成 no**；`floor` 只在能證明違反時
// 才寫 `violated`——判不出來一律 `ok`，由文字紀律承接（機械閘寧可漏擋，不可誤擋）。
//
// 純函式（值域 / 判定 / 解析 / render）＋ IO 薄邊界（readChangedPaths / readLoopFiles / main）。
// 依賴：僅 node 內建 ＋ 同目錄 artifact-contract（載 canonical vocabulary，不在這裡寫第二份值域）。

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadWorkflowVocabulary } from './artifact-contract.mjs';
import { classifyPath } from './diff-footprint.mjs';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 檔位值域與排序。正本在 `references/workflow-vocabulary.json`；這裡是 fallback，兩者不一致時以 registry 為準。 */
export const PROFILE_ORDER = Object.freeze(['direct', 'standard', 'deep']);

/** 判不出來的預設檔位——**不是 `direct`**。向嚴是預設方向（`AGENTS.md` 規則 10 carve-out）。 */
export const DEFAULT_PROFILE = 'standard';

/** `direct` 要全成立的七條。缺席 / 非 true 一律當**不成立**（判不出來就不是 direct）。 */
export const DIRECT_CHECK_IDS = Object.freeze(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7']);

/** `deep` 的觸發 id（命中任一即是）。 */
export const DEEP_TRIGGER_IDS = Object.freeze([
  'E-high-risk', 'E-predicate', 'E-behavior-risk', 'E-blast-radius', 'E-unknown', 'E-user',
]);

export function profileRank(id) {
  const i = PROFILE_ORDER.indexOf(String(id ?? ''));
  return i === -1 ? null : i;
}

export function isProfile(id) {
  return profileRank(id) !== null;
}

/** 兩個檔位取較嚴的那個。任一方判不出來就回另一方；都判不出來回 null。 */
export function maxProfile(a, b) {
  const ra = profileRank(a);
  const rb = profileRank(b);
  if (ra === null) return rb === null ? null : b;
  if (rb === null) return a;
  return ra >= rb ? a : b;
}

// ── 高風險路徑判定（verify-triage 硬閘清單的 path 投影）─────────────────────────

/**
 * 高風險硬閘的七類 × 路徑關鍵字。判定單位是**路徑的「詞」**（segment 再依 `-_.` 與 camelCase
 * 切開），不是子字串——否則 `tokenizer.ts` 會因為含 `token` 被誤判成碰了密鑰處理，而這種誤判
 * 只會讓人學會忽略這道閘。
 */
export const HIGH_RISK_KEYWORDS = Object.freeze({
  'auth': ['auth', 'authn', 'authz', 'login', 'logout', 'session', 'permission', 'permissions', 'rbac', 'acl', 'principal', 'authorize', 'authorization', 'authenticate'],
  'crypto-secret': ['crypto', 'cipher', 'encrypt', 'decrypt', 'secret', 'secrets', 'credential', 'credentials', 'jwt', 'password', 'keystore', 'signing', 'signature'],
  'billing': ['billing', 'payment', 'payments', 'invoice', 'subscription', 'refund', 'checkout', 'pricing', 'quota'],
  'schema-migration': ['migration', 'migrations', 'schema', 'sql', 'ddl', 'backfill'],
  'external-contract': ['api', 'routes', 'route', 'controller', 'controllers', 'endpoint', 'endpoints', 'openapi', 'swagger', 'graphql', 'proto', 'contract', 'contracts'],
  'concurrency': ['queue', 'queues', 'worker', 'workers', 'job', 'jobs', 'scheduler', 'cron', 'lock', 'locks', 'mutex', 'transaction', 'transactional', 'saga', 'concurrency'],
  'iac-deploy': ['workflows', 'dockerfile', 'terraform', 'kubernetes', 'k8s', 'helm', 'ansible', 'deploy', 'deployment', 'infra'],
});

/** 副檔名層級的高風險訊號（路徑詞判不到的那些）。 */
export const HIGH_RISK_EXTENSIONS = Object.freeze({ '.sql': 'schema-migration', '.tf': 'iac-deploy', '.proto': 'external-contract' });

/**
 * **不進高風險判定的兩類路徑**（先扣掉，再比對關鍵字）：
 *   · **純文件**——`verify-triage.md` 本來就把非 code 的文件另走 `product-contract` + `docs-devex`，
 *     不套 code 級風險梯。不扣掉的話，一份叫 `goal-contract.md` 的規範文件會因為路徑裡有
 *     `contract` 被判成「碰了對外契約」。
 *   · **測試面**——同表把 test-only 改動列為瑣碎級。判定沿用 `diff-footprint.mjs` 的
 *     `classifyPath`（測試面樣式的**唯一正本**），不在這裡抄第二份清單。
 *
 * 這不是放寬：**誤判會讓人學會忽略這道閘**，而它擋的是「宣稱最省檔位卻碰了高風險」這種
 * 罕見但代價高的情況——它必須準到值得相信。
 */
export const DOC_EXTENSIONS = Object.freeze(['.md', '.mdx', '.txt', '.rst', '.adoc']);

export function isExcludedFromRisk(path) {
  const norm = String(path ?? '').split('\\').join('/').toLowerCase();
  if (DOC_EXTENSIONS.some((ext) => norm.endsWith(ext))) return 'doc';
  return classifyPath(path) === 'test' ? 'test' : null;
}

/** 把一段路徑切成可比對的「詞」：`/` → segment，segment 再依 `-_.` 與 camelCase 邊界切。 */
export function pathWords(path) {
  const norm = String(path ?? '').split('\\').join('/');
  const words = [];
  for (const segment of norm.split('/')) {
    if (!segment) continue;
    for (const chunk of segment.split(/[-_.\s]+/)) {
      if (!chunk) continue;
      for (const w of chunk.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
        if (w) words.push(w.toLowerCase());
      }
    }
  }
  return words;
}

/**
 * 這條路徑碰到哪一類高風險硬閘 → 回類別 id，沒碰到回 null。
 * 單數 / 複數只做一層還原（結尾 `s` 去掉後仍在關鍵字表裡才算），不做形態學猜測。
 */
export function highRiskCategory(path) {
  if (isExcludedFromRisk(path)) return null;
  const norm = String(path ?? '').split('\\').join('/').toLowerCase();
  for (const [ext, category] of Object.entries(HIGH_RISK_EXTENSIONS)) {
    if (norm.endsWith(ext)) return category;
  }
  const words = new Set(pathWords(path));
  for (const [category, keywords] of Object.entries(HIGH_RISK_KEYWORDS)) {
    for (const kw of keywords) {
      if (words.has(kw)) return category;
      if (kw.endsWith('s') === false && words.has(`${kw}s`)) return category;
    }
  }
  return null;
}

/**
 * 一批改動路徑的高風險判定。
 * @returns `{ state: 'yes'|'no'|'unknown', hits: [{ path, category }] }`
 *          `paths === null`（量不到 diff）→ `unknown`：**不猜成 no**（規則 5）。
 */
export function classifyChangedPaths(paths) {
  if (paths === null || paths === undefined) return { state: 'unknown', hits: [] };
  const hits = [];
  for (const p of paths) {
    const category = highRiskCategory(p);
    if (category) hits.push({ path: p, category });
  }
  return { state: hits.length > 0 ? 'yes' : 'no', hits };
}

// ── 進場判定 ────────────────────────────────────────────────────────────────

/**
 * 由 dispatch 逐條核出來的 predicate 算檔位。
 *
 * @param signals `{ deep_triggers?: string[], direct_checks?: Record<string, boolean>, user_profile?: string }`
 * @returns `{ profile, reasons: string[], unknown_checks: string[] }`
 *
 * 三條刻意的偏嚴設計：
 *   · `direct_checks` 缺哪一條就當那條**不成立**——「沒核到」和「核過了不成立」在成本上是同一件事，
 *     但在風險上，把沒核到當成立才是那個會出事的方向；
 *   · `user_profile` **只能往上調**（`maxProfile`）——使用者可以要求更謹慎，要更省得靠判準成立；
 *   · 認不得的 trigger id 一律忽略但列進 reasons，不靜默吃掉（靜默吃掉會讓打錯字看起來像沒命中）。
 */
export function classifyProfile(signals) {
  const s = signals && typeof signals === 'object' ? signals : {};
  const reasons = [];

  const rawTriggers = Array.isArray(s.deep_triggers) ? s.deep_triggers.map(String) : [];
  const known = rawTriggers.filter((t) => DEEP_TRIGGER_IDS.includes(t));
  const unknownTriggers = rawTriggers.filter((t) => !DEEP_TRIGGER_IDS.includes(t));
  for (const t of unknownTriggers) reasons.push(`忽略認不得的 deep trigger「${t}」（值域見 workflow-vocabulary.json 的 effort_profiles）`);

  const checks = s.direct_checks && typeof s.direct_checks === 'object' ? s.direct_checks : {};
  const failed = DIRECT_CHECK_IDS.filter((id) => checks[id] !== true);
  const unknownChecks = DIRECT_CHECK_IDS.filter((id) => checks[id] === undefined || checks[id] === null);

  let profile;
  if (known.length > 0) {
    profile = 'deep';
    reasons.push(`deep：命中 ${known.join('、')}`);
  } else if (failed.length === 0) {
    profile = 'direct';
    reasons.push('direct：D1–D7 全部成立');
  } else {
    profile = DEFAULT_PROFILE;
    reasons.push(`standard：deep 未命中，但 direct 的 ${failed.join('、')} 不成立（未填＝不成立）`);
  }

  if (s.user_profile !== undefined && s.user_profile !== null && s.user_profile !== '') {
    if (!isProfile(s.user_profile)) {
      reasons.push(`忽略認不得的 user_profile「${s.user_profile}」`);
    } else {
      const raised = maxProfile(profile, s.user_profile);
      if (raised !== profile) reasons.push(`使用者要求 ${s.user_profile}（R-user）→ 由 ${profile} 升到 ${raised}`);
      else if (profileRank(s.user_profile) < profileRank(profile)) reasons.push(`使用者要求 ${s.user_profile}，但判準已定在 ${profile}——檔位只能往上調，維持 ${profile}`);
      profile = raised;
    }
  }

  return { profile, reasons, unknown_checks: unknownChecks };
}

/**
 * 棘輪檢查：`from → to` 這一步合不合法。降檔要走使用者拍板 ＋ 留痕（且只有「升檔依據被證偽」
 * 一種合法情況），所以這裡一律回報為違反，由呼叫端決定要不要記成 finding。
 */
export function ratchetViolation(from, to) {
  const rf = profileRank(from);
  const rt = profileRank(to);
  if (rf === null || rt === null) return null; // 判不出來就不判違規
  return rt < rf ? { from, to, detail: `檔位從 ${from} 降到 ${to}——只升不降（降檔要使用者拍板 ＋ 留痕）` } : null;
}

// ── loop.md / Journal 解析 ──────────────────────────────────────────────────

const PROFILE_ALTERNATION = PROFILE_ORDER.join('|');

/** 從 loop.md 取宣告的檔位（`投入檔位：direct…` 或 `effort_profile: direct`）。取不到回 null。 */
export function parseDeclaredProfile(text) {
  if (typeof text !== 'string') return null;
  for (const line of text.split(/\r?\n/)) {
    if (!/投入檔位|effort[_-]profile/i.test(line)) continue;
    const m = new RegExp(String.raw`\b(${PROFILE_ALTERNATION})\b`).exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * 從 loop.md（含 Journal）取升檔軌跡：每一筆 `舊 → 新`。
 * 只認**同一行內**的 `<profile> → <profile>`，避免把散文裡兩個不相干的字面兜成一次升檔。
 */
export function parseEscalations(text) {
  if (typeof text !== 'string') return [];
  const re = new RegExp(String.raw`\b(${PROFILE_ALTERNATION})\b\s*(?:→|->|=>)\s*\b(${PROFILE_ALTERNATION})\b`, 'g');
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/投入檔位|effort[_-]profile/i.test(line)) continue;
    for (const m of line.matchAll(re)) out.push({ from: m[1], to: m[2] });
  }
  return out;
}

/** 這條 loop 目前**實際生效**的檔位＝宣告值與所有升檔目標取最嚴（防「升了檔但欄位忘了改」）。 */
export function effectiveProfile(declared, escalations) {
  let profile = declared;
  for (const e of escalations ?? []) profile = maxProfile(profile, e.to);
  return profile;
}

// ── 地板稽核 ────────────────────────────────────────────────────────────────

/**
 * 判這條 loop 有沒有低於它自己的地板。
 *
 * **只判一件事**：宣稱走 `direct`，實際改動卻碰到高風險硬閘路徑（`D1` 不成立）。這是唯一
 * 「機械判得動、而且判錯的代價明確」的那格。其餘地板條目（設計審查有沒有派、拍板 gate 有沒有停）
 * 需要語意判斷，由 skill 正文與既有各閘承接——**不在這裡假裝驗過**。
 *
 * @returns `{ profile, floor: 'ok'|'violated', highrisk, escalated, violations, ratchet, hits }`
 */
export function auditFloor({ declared, escalations = [], changedPaths = null }) {
  const risk = classifyChangedPaths(changedPaths);
  const profile = effectiveProfile(declared, escalations);
  const violations = [];

  if (profile === 'direct' && risk.state === 'yes') {
    const categories = [...new Set(risk.hits.map((h) => h.category))].sort();
    violations.push({
      check: 'direct-touches-high-risk',
      detail: `loop 宣稱走 direct，但改動碰到高風險硬閘（${categories.join('、')}）——`
        + `${risk.hits.slice(0, 5).map((h) => h.path).join('、')}${risk.hits.length > 5 ? ' …' : ''}。`
        + '處置是升檔補做（R-high-risk），不是改 marker。',
    });
  }

  const ratchet = [];
  for (const e of escalations) {
    const v = ratchetViolation(e.from, e.to);
    if (v) ratchet.push(v);
  }

  return {
    profile: profile ?? null,
    floor: violations.length > 0 ? 'violated' : 'ok',
    highrisk: risk.state,
    escalated: (escalations ?? []).length,
    violations,
    ratchet,
    hits: risk.hits,
  };
}

/** 給 pr-gate 閘⑨ 讀的一行機械 marker（HTML 註解、rendered 不可見）。 */
export function renderMarker(audit) {
  return `<!-- loops-effort profile=${audit.profile ?? 'unknown'} floor=${audit.floor}`
    + ` highrisk=${audit.highrisk} escalated=${audit.escalated} -->`;
}

/** 人讀的精簡摘要（綠燈一行、紅燈逐條）。 */
export function renderReport(audit) {
  const icon = audit.floor === 'violated' ? '✗' : (audit.highrisk === 'unknown' ? '⚠' : '✓');
  const lines = [`${icon} 投入檔位：${audit.profile ?? '（loop.md 沒宣告）'}｜高風險路徑 ${audit.highrisk}｜升檔 ${audit.escalated} 次`];
  for (const v of audit.violations) lines.push(`  ✗ [${v.check}] ${v.detail}`);
  for (const r of audit.ratchet) lines.push(`  ✗ [ratchet] ${r.detail}`);
  if (audit.profile === null) lines.push('  · loop.md 沒有「投入檔位」欄——dispatch 建 loop.md 時要寫（判不出來就寫 standard）。');
  if (audit.highrisk === 'unknown') lines.push('  · 量不到本次改動的檔案清單，高風險判定標 unknown（不猜成 no）；閘⑨ 此時一律放行。');
  lines.push(renderMarker(audit));
  return lines.join('\n');
}

// ── IO 薄邊界 ───────────────────────────────────────────────────────────────

/** `git diff --name-only <base>...HEAD`；取不到回 null（呼叫端據實標 unknown，不編清單）。 */
export function readChangedPaths(cwd, base) {
  const r = spawnSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** 讀 loop 目錄下的 loop.md（含 Journal）。讀不到回 null。 */
export function readLoopMd(loopDir) {
  const p = join(loopDir, 'loop.md');
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** registry 的檔位值域（讀得到就用它對帳，讀不到就用本檔常數——觀測不該有能力擋住工作）。 */
export function registryProfiles(pluginRoot = PLUGIN_ROOT) {
  const loaded = loadWorkflowVocabulary(pluginRoot);
  const list = loaded?.vocabulary?.effort_profiles?.profiles;
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.map((p) => p.id);
}

function parseArgs(argv) {
  const opts = { mode: null, loopDir: null, signals: null, base: null, cwd: process.cwd(), json: false, markerOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--audit') { opts.mode = 'audit'; opts.loopDir = argv[++i] ?? null; }
    else if (a === '--classify') { opts.mode = 'classify'; opts.signals = argv[++i] ?? null; }
    else if (a === '--base') opts.base = argv[++i] ?? null;
    else if (a === '--cwd') opts.cwd = argv[++i] ?? process.cwd();
    else if (a === '--json') opts.json = true;
    else if (a === '--marker') opts.markerOnly = true;
  }
  return opts;
}

function readSignals(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  const text = raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw;
  return JSON.parse(text);
}

function main(argv) {
  const opts = parseArgs(argv.slice(2));

  if (opts.mode === 'classify') {
    let signals;
    try {
      signals = readSignals(opts.signals);
    } catch (err) {
      console.error(`--classify 的 JSON 讀不進來：${err.message}`);
      return 2;
    }
    const result = classifyProfile(signals);
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`投入檔位：${result.profile}`);
      for (const r of result.reasons) console.log(`  · ${r}`);
      if (result.unknown_checks.length) console.log(`  ⚠ 沒核到的 direct 判準：${result.unknown_checks.join('、')}（未填＝不成立）`);
    }
    return 0;
  }

  if (opts.mode === 'audit') {
    if (!opts.loopDir) {
      console.error('用法：node effort-profile.mjs --audit <loop-dir> [--base <ref>] [--cwd <repo>] [--json] [--marker]');
      return 2;
    }
    const loopText = readLoopMd(opts.loopDir);
    if (loopText === null) console.error(`（讀不到 ${join(opts.loopDir, 'loop.md')}，檔位標為未宣告）`);
    const declared = parseDeclaredProfile(loopText);
    const escalations = parseEscalations(loopText);
    const changedPaths = opts.base ? readChangedPaths(opts.cwd, opts.base) : null;
    const audit = auditFloor({ declared, escalations, changedPaths });
    if (opts.markerOnly) console.log(renderMarker(audit));
    else if (opts.json) console.log(JSON.stringify(audit, null, 2));
    else console.log(renderReport(audit));
    return audit.floor === 'violated' ? 1 : 0;
  }

  console.error('用法：node effort-profile.mjs --classify \'<json>|@<file>\' [--json]');
  console.error('      node effort-profile.mjs --audit <loop-dir> [--base <ref>] [--cwd <repo>] [--json] [--marker]');
  return 2;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(main(process.argv));
}
