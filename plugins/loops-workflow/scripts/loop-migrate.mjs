#!/usr/bin/env node
// loop-migrate.mjs —— 把既有 `.loops/<slug>/loop.md`（欄位表＋無界 Journal）遷成 event ledger（#172）。
//
// 遷移的硬要求是**可追溯**：每一行舊 Journal 都要在 `events.jsonl` 找得到對應事件，且**原文逐字
// 保留**在 `payload.legacy`（推斷出來的語意另外標，不覆蓋原文）。這樣「遷移前後內容一致」不是靠
// 肉眼比對，而是可機械驗證的（見 test-loop-migrate.mjs 的往返斷言）。
//   推斷可能錯，原文不會——所以一行 Journal 可能同時產出 `stage-enter` / `round` / `note` 三筆，
//   三筆都帶同一份 `legacy` 原文（冗餘是刻意的：任一筆存活就追溯得到）。
//
// 安全邊界：
//   · **絕不寫進 linked worktree**（路徑含 `.claude/worktrees/`）——`.loops/` 一律錨定主 repo，
//     寫進 worktree 會被 `git worktree remove` 連坐刪掉（AGENTS 規則 9，且已踩過）。
//   · 目標已有 `events.jsonl` → 預設拒絕（要 `--force` 才重來），避免蓋掉手上的 ledger。
//   · 舊 `loop.md` 一律另存 `loop.md.legacy` 再重生，原始內容不會消失。
//
// 寫入一律走 `loop-ledger.appendEvent`（事件流的唯一寫入路徑），不自己拼 JSONL。
// 純函式（parseLegacyLoopMd / legacyEventSpecs / diffTraceability）＋ IO 薄邊界（migrateLoopDir）。

import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { appendEvent, readEvents } from './loop-ledger.mjs';
import { pickLoopField } from './loops-scan.mjs';
import { projectEvents } from './loop-graph.mjs';
import { renderLoopMd } from './loop-snapshot.mjs';
import { writeFileAtomic } from '../hooks/atomic-write.mjs';

/** Journal 行：`- [E12] …` 與 `- E12 [goal] …` 兩種歷史寫法都吃。 */
const JOURNAL_LINE = /^-\s*\[?E(\d+)\]?\s*(.*)$/;
/** 行首的 `[stage]` 標記。 */
const STAGE_TAG = /^\[([a-z-]+)\]\s*/i;

const STAGE_NAMES = new Set(['clarify', 'define', 'goal', 'explore', 'plan', 'build', 'verify', 'iterate', 'scaffold']);

/** 遷移產物落點禁區：linked worktree。 */
export function isInsideLinkedWorktree(path) {
  const parts = String(path).split(/[\\/]/);
  const i = parts.indexOf('.claude');
  return i >= 0 && parts[i + 1] === 'worktrees';
}

/**
 * 解析舊 `loop.md` → `{fields, journal}`。
 * `journal[i] = {n, raw, text, stage, round}`：`raw` 是**逐字原文**（追溯用），其餘是推斷。
 */
export function parseLegacyLoopMd(md) {
  const text = String(md ?? '');
  const fields = {
    type: pickLoopField(text, '類型'),
    operation: pickLoopField(text, 'operation'),
    mode: pickLoopField(text, '推進模式'),
    stage: pickLoopField(text, '當前階段'),
    stopCondition: pickLoopField(text, '停止條件'),
    session: pickLoopField(text, 'session'),
    issue: pickLoopField(text, 'issue'),
  };
  const journal = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(JOURNAL_LINE);
    if (!m) continue;
    const n = Number(m[1]);
    let rest = m[2].trim();
    let stage = '';
    const tag = rest.match(STAGE_TAG);
    if (tag && STAGE_NAMES.has(tag[1].toLowerCase())) {
      stage = tag[1].toLowerCase();
      rest = rest.slice(tag[0].length);
    } else {
      const enter = rest.match(/進入\s*([a-z-]+)/i);
      if (enter && STAGE_NAMES.has(enter[1].toLowerCase())) stage = enter[1].toLowerCase();
    }
    const roundMatch = rest.match(/(?:回環|round)\s*#?(\d+)/i);
    journal.push({ n, raw: line.trim(), text: rest, stage, round: roundMatch ? Number(roundMatch[1]) : null });
  }
  journal.sort((a, b) => a.n - b.n);
  return { fields, journal };
}

/**
 * 舊解析結果 → 待 append 的事件規格（`{type, payload}`；`v`/`id`/`seq` 由 ledger 補完）。
 * 保持純函式，讓「遷移會產出什麼」在不碰檔案的情況下就可被斷言。
 */
export function legacyEventSpecs(slug, parsed) {
  const specs = [];
  const f = parsed.fields;
  specs.push({ type: 'loop-create', payload: { type: f.type || '', operation: f.operation || '', mode: f.mode || '', session: f.session || '', stopCondition: f.stopCondition || '', migratedFrom: 'loop.md' } });
  const issueNum = Number(String(f.issue || slug).match(/\d+/)?.[0]);
  if (Number.isInteger(issueNum)) specs.push({ type: 'issue', payload: { number: issueNum } });

  let lastStage = '';
  for (const j of parsed.journal) {
    if (j.stage && j.stage !== lastStage) {
      specs.push({ type: 'stage-enter', payload: { stage: j.stage, migrated: true, legacy: j.raw } });
      lastStage = j.stage;
    }
    if (j.round !== null) specs.push({ type: 'round', payload: { round: j.round, migrated: true, legacy: j.raw } });
    specs.push({ type: 'note', payload: { text: j.text, stage: j.stage || lastStage, legacyId: `E${j.n}`, legacy: j.raw } });
  }

  if (/完工|done|✅/i.test(f.stage || '')) specs.push({ type: 'loop-close', payload: { outcome: f.stage, migrated: true } });
  return specs;
}

/**
 * 追溯性驗證（純函式）：舊 Journal 的每一行原文，是否都在事件（或事件規格）裡找得到。
 * `ok===false` 代表這次遷移**掉了東西**，呼叫端必須擋下。
 */
export function diffTraceability(parsed, events) {
  const seen = new Set();
  for (const ev of events || []) {
    const legacy = ev && ev.payload && ev.payload.legacy;
    if (typeof legacy === 'string') seen.add(legacy);
  }
  const missing = parsed.journal.filter((j) => !seen.has(j.raw)).map((j) => j.raw);
  return { ok: missing.length === 0, missing, total: parsed.journal.length };
}

// ── IO 薄邊界 ────────────────────────────────────────────────────────────────

/**
 * 遷移一個 loop 目錄。回 `{ok, slug, events, traceability, reason}`。
 * 追溯性檢查**在寫檔之前**跑（用純函式算出來的 specs 驗）——不合格就一個位元組都不寫。
 */
export function migrateLoopDir(loopDir, { slug = null, force = false, dryRun = false } = {}) {
  const name = slug ?? loopDir.split(/[\\/]/).filter(Boolean).pop();
  if (isInsideLinkedWorktree(loopDir)) {
    return { ok: false, slug: name, events: 0, traceability: null, reason: `拒絕遷移：目標落在 linked worktree（${loopDir}）——.loops 一律錨定主 repo` };
  }
  const legacyPath = join(loopDir, 'loop.md');
  if (!existsSync(legacyPath)) return { ok: false, slug: name, events: 0, traceability: null, reason: `找不到 ${legacyPath}` };
  const ledgerPath = join(loopDir, 'events.jsonl');
  if (existsSync(ledgerPath) && !force) {
    return { ok: false, slug: name, events: 0, traceability: null, reason: `${ledgerPath} 已存在——加 --force 才重來（避免蓋掉現行 ledger）` };
  }

  const md = readFileSync(legacyPath, 'utf8');
  const parsed = parseLegacyLoopMd(md);
  const specs = legacyEventSpecs(name, parsed);
  const traceability = diffTraceability(parsed, specs);
  if (!traceability.ok) {
    return { ok: false, slug: name, events: 0, traceability, reason: `追溯性檢查失敗：${traceability.missing.length}/${traceability.total} 行 Journal 沒有對應事件` };
  }
  if (dryRun) return { ok: true, slug: name, events: specs.length, traceability, reason: null, dryRun: true };

  if (existsSync(ledgerPath)) rmSync(ledgerPath);
  for (const spec of specs) appendEvent(ledgerPath, spec);

  // 舊檔留痕（不刪），再由 ledger 重生 loop.md——「遷移前」永遠可查。
  renameSync(legacyPath, join(loopDir, 'loop.md.legacy'));
  const { events, warnings } = readEvents(ledgerPath);
  writeFileAtomic(legacyPath, renderLoopMd(projectEvents(events, { slug: name }), events, { warnings }), 'utf8');
  return { ok: true, slug: name, events: events.length, traceability, reason: null };
}

/** 掃 `.loops/` 下所有仍是 legacy 形態（有 loop.md、無 events.jsonl）的 loop。 */
export function listLegacyLoops(loopsRoot) {
  if (!existsSync(loopsRoot)) return [];
  const out = [];
  for (const entry of readdirSync(loopsRoot)) {
    if (entry.startsWith('.')) continue;
    const dir = join(loopsRoot, entry);
    try {
      if (statSync(dir).isDirectory() && existsSync(join(dir, 'loop.md')) && !existsSync(join(dir, 'events.jsonl'))) out.push({ slug: entry, dir });
    } catch { /* 單一子目錄失敗跳過 */ }
  }
  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith('--')) ?? join(process.cwd(), '.loops');
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');
  if (isInsideLinkedWorktree(root)) {
    process.stderr.write(`拒絕：${root} 落在 linked worktree——.loops 一律錨定主 repo（AGENTS 規則 9）\n`);
    return 1;
  }
  const targets = listLegacyLoops(root);
  if (!targets.length) {
    process.stdout.write(`沒有需要遷移的 loop（${root} 下每條都已有 events.jsonl 或不存在）\n`);
    return 0;
  }
  let failed = 0;
  for (const t of targets) {
    const r = migrateLoopDir(t.dir, { slug: t.slug, force, dryRun });
    if (r.ok) process.stdout.write(`✓ ${r.slug}：${r.events} 筆事件、${r.traceability.total} 行 Journal 全數可追溯${r.dryRun ? '（dry-run，未寫檔）' : ''}\n`);
    else { failed += 1; process.stderr.write(`✗ ${r.slug}：${r.reason}\n`); }
  }
  return failed ? 1 : 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
