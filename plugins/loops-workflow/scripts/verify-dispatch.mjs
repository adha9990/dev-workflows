#!/usr/bin/env node
// verify-dispatch.mjs —— verify 階段**派工組成**的觀測（#209）。
//
// 起因：載入度分析（#205 / #207）指出 `finding-validation.md` 從沒被載入。追查真實 transcript 後，
// 原因**不是**「reviewer 沒讀參考檔」——那一段實測是滿分——而是 **`finding-validator` 一次都沒被派**。
// 沒派出來，就沒有人會去讀它的判準檔。失效發生在「沒被派」這一層，不是「派了沒照做」。
//
// 本檔回答一句話：**「這條 loop 的 verify 派了幾個 reviewer、幾個 validator？」**
//
// ── 它刻意判不出來的那一格，就是設計的重點 ────────────────────────────────────
//
// 「派了 reviewer 卻沒派 validator」**不等於違規**：reviewer 全 clean、零候選 finding 時本來就不必派。
// 要斷「該派沒派」，需要的是 transcript **看不到**的那個數字——**這一輪有幾條候選 blocking finding**。
// 所以本檔對這一格一律回 `unconfirmed`（不是 `skipped`、更不是 `ok`），並且**不把它算進任何違規計數**。
//
// 這一格判不出來，正是 verify marker 要補 `findings=` / `validated=` 兩個欄位的理由：
//   - transcript 有「派了誰」，沒有「有幾條候選 finding」；
//   - 報告的 marker 有「有幾條候選 finding」，沒有「派了誰」。
// 兩邊各有一半。`--report` 帶進 verify 報告時，兩半合起來才判得出 `skipped`（自報有候選 finding、
// 自報 0 條經過確認）。這也是 pr-gate 閘⑦ 的判準——同一個契約、兩個消費者。
//
// **不要把 `unconfirmed` 讀成「大概是跳過了」**：這支腳本回報的是「無法判定」，把無法判定聚合成
// 違規率就是在製造假數字（Metric-Honesty）。要拿到可判定的資料，唯一的路是讓 verify 吐出 marker 欄位。
//
// 分層：純函式（classifyRole / scanDispatch / mergeDispatch / verdictFor / renderReport）＋
// IO 薄邊界（collectTranscripts / analyzeAll / main）。依賴：node 內建 ＋ 同 repo hooks/pr-gate.mjs
// 的 marker 解析（`extractLatestMarker` / `stripCodeForMarker`——marker 契約只該有一份正本，
// 兩邊各抄一份遲早分叉；import 安全：pr-gate 的 main 有 import.meta.url 守門）。
//
// 用法：
//   node verify-dispatch.mjs [--projects <dir>] [--report <04-verify.md>] [--json]

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { extractLatestMarker, stripCodeForMarker } from '../hooks/pr-gate.mjs';

/** transcript 裡一次子代理派工；擷取 `subagent_type`。 */
export const SUBAGENT_TYPE_RE = /"subagent_type":"([^"]+)"/g;

/** 本 plugin 的子代理命名空間前綴。 */
export const SUBAGENT_NS = 'loops-workflow:';

/** 角色值域。`other` 含非本 plugin 的子代理（Explore / general-purpose…）。 */
export const ROLES = Object.freeze(['reviewer', 'validator', 'builder', 'other']);

/** 判定值域。`unconfirmed` **不是**違規，是「資料不足以判定」。 */
export const VERDICTS = Object.freeze(['validated', 'skipped', 'unconfirmed', 'no-review']);

// ── 純函式層 ────────────────────────────────────────────────────────────────

/**
 * 子代理型別 → 角色。**刻意用命名規則判、不查現行目錄結構**：要分析的是歷史 transcript，
 * 當時的 agent 檔案佈局早就跟現在不同（#192 才把 agents/ 重整成分類目錄），查現行結構會讓
 * 舊資料整批判成 `other`。命名規則（`*-reviewer` / `finding-validator*`）跨版本穩定得多。
 *
 * `-deep` 變體與 base 同角色：`security-reviewer-deep` 仍是 reviewer、`finding-validator-deep`
 * 仍是 validator——高風險改派深審變體是 model/effort 的事，不改變它在流程裡的位置。
 */
export function classifyRole(subagentType) {
  if (typeof subagentType !== 'string' || !subagentType.startsWith(SUBAGENT_NS)) return 'other';
  const name = subagentType.slice(SUBAGENT_NS.length);
  if (name.startsWith('finding-validator')) return 'validator';
  if (/-reviewer(-deep)?$/.test(name)) return 'reviewer';
  if (name === 'impl-author' || name === 'test-author' || name === 'referee') return 'builder';
  return 'other';
}

/**
 * 掃一份 transcript 文字 → 派工組成。
 * 刻意不逐行 JSON.parse：transcript 動輒數十 MB，且單一壞行就會炸掉整份分析（同 skill-usage.mjs
 * 的取捨）。`subagent_type` 是穩定的字面欄位，regex 掃過去即可。
 */
export function scanDispatch(text) {
  const byType = {};
  const roles = { reviewer: 0, validator: 0, builder: 0, other: 0 };
  if (typeof text !== 'string') return { byType, roles, total: 0 };
  for (const m of text.matchAll(SUBAGENT_TYPE_RE)) {
    const type = m[1];
    byType[type] = (byType[type] ?? 0) + 1;
    roles[classifyRole(type)] += 1;
  }
  const total = Object.values(byType).reduce((a, b) => a + b, 0);
  return { byType, roles, total };
}

/** 合併兩份派工組成（同一專案跨多份 transcript 聚合用）。 */
export function mergeDispatch(a, b) {
  const byType = { ...(a?.byType ?? {}) };
  for (const [k, v] of Object.entries(b?.byType ?? {})) byType[k] = (byType[k] ?? 0) + v;
  const roles = { reviewer: 0, validator: 0, builder: 0, other: 0 };
  for (const r of ROLES) roles[r] = (a?.roles?.[r] ?? 0) + (b?.roles?.[r] ?? 0);
  return { byType, roles, total: (a?.total ?? 0) + (b?.total ?? 0) };
}

/**
 * verify 報告的 marker → `{ findings, validated }`（缺欄位回 undefined，**不補 0**）。
 * marker 契約與解析正本在 `hooks/pr-gate.mjs`；本檔只是換個消費者。raw 與 fence-robust 兩視圖
 * 取「先有 findings 欄位的那個」——與閘⑥ 的兩視圖聯合同源，避免報告裡的示範 marker 蓋掉真的。
 */
export function readMarkerCounts(reportText) {
  if (typeof reportText !== 'string') return {};
  const stripped = extractLatestMarker(stripCodeForMarker(reportText));
  const raw = extractLatestMarker(reportText);
  const pick = stripped?.findings !== undefined ? stripped : raw;
  return { findings: pick?.findings, validated: pick?.validated };
}

/**
 * 判定。**四態，且 `unconfirmed` 明確不是違規。**
 *
 * - `no-review`：沒派任何 reviewer → verify 沒跑到 fan-out，本觀測不適用（不是「通過」也不是「違規」）。
 * - `validated`：派了 validator → 第二輪確實跑過。
 * - `skipped`：**唯一可斷的違規**——報告自報有候選 blocking finding（`findings>0`），卻自報
 *   0 條經過確認（`validated=0`）。這需要 marker 才判得出來，transcript 單獨判不出。
 * - `unconfirmed`：派了 reviewer、沒派 validator，且**沒有候選 finding 條數可查**。可能零候選
 *   （合法），也可能第二輪被整段跳過。**判不出來就說判不出來。**
 *
 * marker 的 `findings`/`validated` 優先於 transcript 的派工計數：報告是這一輪的自述，transcript
 * 可能橫跨多輪（同一個 session 跑了多次 verify），計數會混輪。
 *
 * 第一參數就是 `scanDispatch` 回傳的 `roles`，欄名逐字沿用（`reviewer`/`validator` 單數）——
 * 兩邊各取一套名字，呼叫端漏掉一個字母就會靜靜全判成 `no-review`（實測踩過）。
 */
export function verdictFor({ reviewer = 0, validator = 0 } = {}, marker = {}) {
  const { findings, validated } = marker ?? {};
  if (typeof findings === 'number' && findings > 0) {
    const confirmed = typeof validated === 'number' ? validated : validator;
    if (confirmed === 0) {
      return {
        verdict: 'skipped',
        reason: `報告自報 ${findings} 條候選 blocking finding，卻自報 0 條經過二輪確認——第二輪被跳過`,
      };
    }
    return { verdict: 'validated', reason: `${findings} 條候選 finding、${confirmed} 條經過二輪確認` };
  }
  if (typeof findings === 'number' && findings === 0) {
    return { verdict: 'validated', reason: '報告自報 0 條候選 blocking finding——本來就不必派 validator' };
  }
  if (validator > 0) return { verdict: 'validated', reason: `派了 ${validator} 個 finding-validator` };
  if (reviewer === 0) {
    return { verdict: 'no-review', reason: '沒派任何 reviewer——verify 沒跑到 fan-out，本觀測不適用' };
  }
  return {
    verdict: 'unconfirmed',
    reason:
      `派了 ${reviewer} 個 reviewer、0 個 finding-validator，但**找不到候選 finding 條數**——` +
      '可能零候選（合法），也可能第二輪被跳過，判不出來。要判得出來，verify 報告的 marker 需帶 `findings=`／`validated=`',
  };
}

/**
 * 報告文字。`unconfirmed` 與 `skipped` **分開列、不合併計數**——把「無法判定」摻進違規數，
 * 就是這支腳本存在的理由的反面。
 */
export function renderReport(result) {
  const rows = result?.rows ?? [];
  const L = [];
  L.push('# verify 派工觀測');
  L.push('');
  L.push(`掃描來源：\`${result?.projectsRoot ?? '(未指定)'}\`；納入 ${rows.length} 個有派過本 plugin 子代理的 session。`);
  L.push('');
  L.push('| session | reviewer | validator | 其他 | 判定 |');
  L.push('|---|---|---|---|---|');
  for (const r of rows) {
    L.push(`| \`${r.label}\` | ${r.roles.reviewer} | ${r.roles.validator} | ${r.roles.builder + r.roles.other} | ${r.verdict} |`);
  }
  L.push('');
  const tally = {};
  for (const r of rows) tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
  L.push('## 判定分佈');
  L.push('');
  for (const v of VERDICTS) if (tally[v]) L.push(`- \`${v}\`：${tally[v]} 個 session`);
  L.push('');
  L.push('> `unconfirmed` **不是違規計數**：它代表「派了 reviewer、沒派 validator，但查不到候選 finding 條數」——');
  L.push('> 可能零候選（合法），也可能第二輪被跳過。要把這一格變成可判定的，verify 報告的 marker 要帶');
  L.push('> `findings=` / `validated=`（見 `skills/verify/SKILL.md` 步驟 5 與 pr-gate 閘⑦）。');
  const unresolved = rows.filter((r) => r.verdict === 'unconfirmed');
  if (unresolved.length > 0) {
    L.push('');
    L.push('## 判不出來的 session（逐個列出，不聚合成比率）');
    L.push('');
    for (const r of unresolved) L.push(`- \`${r.label}\`：${r.reason}`);
  }
  return L.join('\n');
}

// ── IO 薄邊界 ───────────────────────────────────────────────────────────────

const safeRead = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
const safeDirs = (d) => { try { return readdirSync(d); } catch { return []; } };

/** 預設的 transcript 根目錄（Claude Code 逐專案存放處）。 */
export function defaultProjectsRoot() {
  return join(homedir(), '.claude', 'projects');
}

/**
 * 掃 `<projectsRoot>/<專案>/*.jsonl` → `[{ project, file, path }]`。
 * 子代理的 sidechain transcript 也在同一層、也會被掃到——它們沒有 `subagent_type` 欄位
 * （派工紀錄留在主線那份），所以自然落在「零派工」被 analyzeAll 濾掉，不必特別辨識。
 */
export function collectTranscripts(projectsRoot) {
  const out = [];
  for (const project of safeDirs(projectsRoot)) {
    const dir = join(projectsRoot, project);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    for (const file of safeDirs(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      out.push({ project, file, path: join(dir, file) });
    }
  }
  return out;
}

/** 專案目錄名 → 短標籤（不把使用者機器路徑寫進版控；同 skill-usage.mjs 的處理）。 */
export function shortenProjectLabel(name) {
  return String(name)
    .replace(/^C--Users-[^-]+(?:-[^-]+)*?-Documents-GitHub-/, '')
    .replace(/--claude-worktrees-/, '@');
}

/**
 * 掃全部 transcript → 逐 session 的派工列。只保留**有派過本 plugin 子代理**的 session
 * （`roles.reviewer + validator + builder > 0`）——其餘是一般對話 / 別的工作 / sidechain，
 * 算進去只會稀釋分母（同 skill-usage.mjs 的「分母要誠實」）。
 */
export function analyzeAll(projectsRoot, reportText) {
  const marker = readMarkerCounts(reportText);
  const rows = [];
  for (const entry of collectTranscripts(projectsRoot)) {
    const text = safeRead(entry.path);
    if (text === null) continue;
    const d = scanDispatch(text);
    if (d.roles.reviewer + d.roles.validator + d.roles.builder === 0) continue;
    const { verdict, reason } = verdictFor(d.roles, marker);
    rows.push({
      label: `${shortenProjectLabel(entry.project)}/${basename(entry.file, '.jsonl').slice(0, 8)}`,
      project: entry.project,
      file: entry.file,
      roles: d.roles,
      byType: d.byType,
      verdict,
      reason,
    });
  }
  rows.sort((a, b) => b.roles.reviewer - a.roles.reviewer || a.label.localeCompare(b.label));
  return { projectsRoot, marker, rows };
}

function parseArgs(argv) {
  const opts = { projects: defaultProjectsRoot(), report: '', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--projects') opts.projects = argv[++i] ?? opts.projects;
    else if (argv[i] === '--report') opts.report = argv[++i] ?? '';
    else if (argv[i] === '--json') opts.json = true;
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const reportText = opts.report ? safeRead(opts.report) : null;
  const result = analyzeAll(opts.projects, reportText);
  console.log(opts.json ? JSON.stringify(result, null, 2) : renderReport(result));
  // 觀測工具不判紅綠：它的產出是事實，該不該擋是 pr-gate 閘⑦ 的職責。一律 exit 0。
  process.exit(0);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main(process.argv.slice(2));
