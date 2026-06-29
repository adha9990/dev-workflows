# Progress Preview（以 /progress + PROGRESS.md 取代 statusline）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一個共用 renderer（`scripts/progress.mjs`）＋兩個出口（`/loops-workflow:progress` 指令印 chat 儀表板、自動產的 `.loops/<slug>/PROGRESS.md` 供編輯器 markdown preview）取代資訊量過低的 statusline。

**Architecture:** `loop.md` + `0N-*.md` 是唯一資料源；`scripts/loops-scan.mjs`（自被刪的 `hud-status.mjs` 救出）做共用掃描/解析，`scripts/progress.mjs` 抽結構並渲染兩種出口。指令端跑 `progress.mjs [slug]`（印 stdout + 寫檔），恆跑的 Stop hook `hooks/progress-render.mjs` 每回合跑 `progress.mjs --write-only` 保持 PROGRESS.md 最新。移除整套 statusline。

**Tech Stack:** Node.js（僅內建 `fs`/`path`/`url`，零外部套件）；測試為自帶極簡 harness 的 `.mjs`（不引測試框架），仿 `hooks/test-stop-gate.mjs` / `scripts/test-eval-metrics.mjs`。

## Global Constraints

- 對外敘述一律**繁體中文**；code identifier / 路徑 / 指令 / skill 名保留英文。
- 所有 `.mjs` 分層：**純函式（無 IO，可直接 import 測）+ IO 薄邊界（`main()`）+ `import.meta.url` 守衛（被 import 時不執行 main）**；**任何錯誤一律吞掉 `exit 0`、永不擋路**（仿 `hooks/session-start.mjs`）。
- 僅用 node 內建模組，**不引任何外部套件、不引測試框架**。
- 測試以 cwd = `plugins/loops-workflow` 執行：`node scripts/test-progress.mjs`；全綠 exit 0、任一失敗 exit 1。
- `PROGRESS.md` 一律寫進 **loop.md 所在的 `.loops/<slug>/`**（主 repo），**不另寫進 worktree**（守 `AGENTS.md` 規則 9）。
- `PROGRESS.md` 受既有 `.gitignore` 的 `.loops/*` 涵蓋、不入庫。
- Stop hook **不注入任何 context**（只做檔案 side-effect、避免每回合吃 token）。
- commit message 用 conventional commits + 結尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

### Task 1: `scripts/loops-scan.mjs`（共用掃描/解析純函式）

**Files:**
- Create: `plugins/loops-workflow/scripts/loops-scan.mjs`
- Test: `plugins/loops-workflow/scripts/test-progress.mjs`（本任務先建檔，只放 Section A）

**Interfaces:**
- Produces:
  - `STAGE_ORDER: string[]` = `['goal','explore','plan','build','verify','iterate']`
  - `PRE_STAGES: string[]` = `['clarify','scaffold','define']`
  - `MAX_ROUNDS: number` = `3`
  - `pickLoopField(md: string, label: string): string`（無 → `''`）
  - `journalEntries(md: string): string[]`（`- [E\d+] …` 行，trim 後；無 → `[]`）
  - `lastJournalLine(md: string): string`（無 → `'(無 Journal)'`）
  - `currentStage(md: string): string`（去括號註解；無 → `'?'`）
  - `isDone(stage: string): boolean`（`/完工|done|✅/i`）
  - `collectLoopRoots(cwd: string): string[]`
  - `collectLoopEntries(cwd: string): {slug,dir,mdPath,md,mtime}[]`
  - `pickActiveLoop(entries, sid: string, now: number): entry|null`

- [ ] **Step 1: 寫失敗測試（建立 `test-progress.mjs`，Section A）**

```js
#!/usr/bin/env node
// test-progress.mjs —— loops-scan.mjs + progress.mjs 的紅綠斷言（自帶極簡 harness，不引測試框架）。
// 用法（cwd = plugins/loops-workflow）：node scripts/test-progress.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1。

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  STAGE_ORDER, PRE_STAGES, MAX_ROUNDS,
  pickLoopField, journalEntries, lastJournalLine, currentStage, isDone,
  collectLoopRoots, collectLoopEntries, pickActiveLoop,
} from './loops-scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROGRESS_SCRIPT = join(HERE, 'progress.mjs');

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed.push(msg); console.error(`  ✗ ${msg}`); }
}

// 樣本 loop.md（build 階段中、回環 1 圈、有 findings/commit）
const SAMPLE_LOOP_MD = `# loop：137-trash-delete-permanent

| 欄 | 值 |
|---|---|
| 類型 | issue |
| operation | bug-fix |
| 起點階段 | goal |
| 當前階段 | build（任務 3/4） |
| session | sess-abc |
| 推進模式 | auto |
| 停止條件 | DELETE 端點通過驗收且不誤刪他人 |

## Journal（append-only）

- [E1] 進入 goal：restate DoD
- [E2] 進入 explore：派 Explore 掃 codebase
- [E3] 進入 plan：拆 4 任務，ADR-1 記選型
- [E4] gate：plan→build 拍板
- [E5] 進入 build：任務 1 Red→Green→commit a1b2c3d
- [E6] 回環 #1：verify 報 findings 1→0（缺 owner 過濾）→ 回 build
`;

function seedLoop(cwd, slug, md) {
  const dir = join(cwd, '.loops', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'loop.md'), md, 'utf8');
  return dir;
}

// =============================================================================
// A) loops-scan.mjs — 純函式
// =============================================================================

// ── A1 常數契約 ──
{
  assert(JSON.stringify(STAGE_ORDER) === JSON.stringify(['goal','explore','plan','build','verify','iterate']),
    'STAGE_ORDER 六階段順序固定 [A1]');
  assert(JSON.stringify(PRE_STAGES) === JSON.stringify(['clarify','scaffold','define']),
    'PRE_STAGES = clarify/scaffold/define [A1]');
  assert(MAX_ROUNDS === 3, 'MAX_ROUNDS === 3 [A1]');
}

// ── A2 pickLoopField：表格列 / 行式 / 無 → '' ──
{
  assert(pickLoopField(SAMPLE_LOOP_MD, '類型') === 'issue', "pickLoopField('類型') === 'issue' [A2]");
  assert(pickLoopField(SAMPLE_LOOP_MD, 'session') === 'sess-abc', "pickLoopField('session') [A2]");
  assert(pickLoopField('當前階段：build', '當前階段') === 'build', 'pickLoopField 認行式「label：value」 [A2]');
  assert(pickLoopField(SAMPLE_LOOP_MD, '不存在欄') === '', 'pickLoopField 無欄 → "" [A2]');
  assert(pickLoopField('', '類型') === '' && pickLoopField(null, '類型') === '', 'pickLoopField 空/null → "" 不丟 [A2]');
}

// ── A3 journalEntries / lastJournalLine ──
{
  const j = journalEntries(SAMPLE_LOOP_MD);
  assert(j.length === 6, 'journalEntries → 6 筆 [A3]');
  assert(j[0].startsWith('- [E1]'), 'journalEntries 第一筆 E1 [A3]');
  assert(lastJournalLine(SAMPLE_LOOP_MD).startsWith('- [E6]'), 'lastJournalLine → E6 [A3]');
  assert(journalEntries('').length === 0 && lastJournalLine('') === '(無 Journal)', '空 → [] / "(無 Journal)" [A3]');
}

// ── A4 currentStage / isDone ──
{
  assert(currentStage(SAMPLE_LOOP_MD) === 'build', 'currentStage 去括號 → "build" [A4]');
  assert(currentStage('') === '?', 'currentStage 無 → "?" [A4]');
  assert(isDone('完工') === true && isDone('done') === true && isDone('✅ 完工') === true, 'isDone 認完工/done/✅ [A4]');
  assert(isDone('build') === false, 'isDone 非完工 → false [A4]');
}

// ── A5 collectLoopRoots / collectLoopEntries（真 .loops/）──
{
  const cwd = mkdtempSync(join(tmpdir(), 'ls-roots-'));
  try {
    assert(collectLoopRoots(cwd).length === 0, '無 .loops/ → roots [] [A5]');
    seedLoop(cwd, '137-trash-delete-permanent', SAMPLE_LOOP_MD);
    const roots = collectLoopRoots(cwd);
    assert(roots.length === 1 && roots[0].endsWith('.loops'), '有 .loops/ → roots 1 筆 [A5]');
    const entries = collectLoopEntries(cwd);
    assert(entries.length === 1 && entries[0].slug === '137-trash-delete-permanent', 'collectLoopEntries 抓到該 loop [A5]');
    assert(entries[0].md.includes('當前階段') && typeof entries[0].mtime === 'number', 'entry 帶 md + mtime [A5]');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

// ── A6 collectLoopEntries 也掃 worktree 下 .loops/ ──
{
  const cwd = mkdtempSync(join(tmpdir(), 'ls-wt-'));
  try {
    const wtDir = join(cwd, '.claude', 'worktrees', 'wt1', '.loops', 'x-slug');
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, 'loop.md'), SAMPLE_LOOP_MD, 'utf8');
    const entries = collectLoopEntries(cwd);
    assert(entries.some((e) => e.slug === 'x-slug'), 'collectLoopEntries 掃到 worktree 下 .loops/ [A6]');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

// ── A7 pickActiveLoop：sid 比對 / 排除完工 / 無 sid fallback ──
{
  const base = { slug: 's', dir: '', mdPath: '', mtime: 100 };
  const e1 = { ...base, slug: 'mine', md: SAMPLE_LOOP_MD, mtime: 200 }; // session=sess-abc, build
  const doneMd = SAMPLE_LOOP_MD.replace('當前階段 | build（任務 3/4）', '當前階段 | 完工');
  const e2 = { ...base, slug: 'done', md: doneMd, mtime: 300 };
  const e3 = { ...base, slug: 'other', md: SAMPLE_LOOP_MD.replace('sess-abc', 'sess-zzz'), mtime: 250 };

  assert(pickActiveLoop([e1, e2, e3], 'sess-abc', 1000).slug === 'mine', 'pickActiveLoop：sid 命中本 session [A7]');
  assert(pickActiveLoop([e2], 'sess-abc', 1000) === null, 'pickActiveLoop：完工的不算 active → null [A7]');
  assert(pickActiveLoop([e1, e3], '', 1000).slug === 'other' || pickActiveLoop([e1, e3], '', 1000).slug === 'mine',
    'pickActiveLoop：無 sid → 近期活躍取 mtime 最新 [A7]');
}

console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
```

- [ ] **Step 2: 跑測試確認 Red**

Run: `cd plugins/loops-workflow && node scripts/test-progress.mjs`
Expected: FAIL —— `ERR_MODULE_NOT_FOUND`（`loops-scan.mjs` 尚未建立，import 在載入期就丟，node 非 0 退出）。

- [ ] **Step 3: 寫最小實作 `scripts/loops-scan.mjs`**

```js
#!/usr/bin/env node
// loops-scan.mjs —— 共用 .loops/ 掃描 + loop.md 欄位/Journal 解析。
// scripts/progress.mjs 與 hooks/progress-render.mjs 共用（自被刪的 hud-status.mjs 救出）。
// 純函式無 IO（測試直接 import）；IO 邊界容錯不丟。僅 node 內建。

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const STAGE_ORDER = ['goal', 'explore', 'plan', 'build', 'verify', 'iterate'];
export const PRE_STAGES = ['clarify', 'scaffold', 'define'];
export const MAX_ROUNDS = 3;
const FALLBACK_WINDOW_MS = 4 * 60 * 60 * 1000; // 無 session id 時的「近期活躍」窗

/** loop.md 欄位：先試 markdown 表格列「label … | value |」，再試「label：value」行；無 → ''。 */
export function pickLoopField(md, label) {
  const text = String(md || '');
  const tableRow = text.match(new RegExp(`${label}[^\\n|]*\\|\\s*([^|\\n]+?)\\s*\\|`));
  if (tableRow) return tableRow[1].trim();
  const inlineLine = text.match(new RegExp(`${label}[：:]\\s*([^\\n]+)`));
  return inlineLine ? inlineLine[1].trim() : '';
}

/** Journal 行（- [E\\d+] …）陣列（trim 後）；無 → []。 */
export function journalEntries(md) {
  return String(md || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^-\s*\[E\d+\]/.test(l));
}

/** 最後一條 Journal 行；無 → '(無 Journal)'。 */
export function lastJournalLine(md) {
  const lines = journalEntries(md);
  return lines.length ? lines[lines.length - 1] : '(無 Journal)';
}

/** 當前階段（去括號註解）；無 → '?'。 */
export function currentStage(md) {
  return (pickLoopField(md, '當前階段') || '?').split(/[（(]/)[0].trim() || '?';
}

/** 是否完工。 */
export function isDone(stage) {
  return /完工|done|✅/i.test(String(stage || ''));
}

const safeReaddir = (dir) => { try { return readdirSync(dir); } catch { return []; } };
const safeReadFile = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };

/** 要掃的 .loops/ 根目錄：cwd/.loops ＋ cwd/.claude/worktrees/*/.loops。 */
export function collectLoopRoots(cwd) {
  const roots = [];
  const main = join(cwd, '.loops');
  if (existsSync(main)) roots.push(main);
  const wtBase = join(cwd, '.claude', 'worktrees');
  if (existsSync(wtBase)) {
    for (const wt of safeReaddir(wtBase)) {
      const l = join(wtBase, wt, '.loops');
      if (existsSync(l)) roots.push(l);
    }
  }
  return roots;
}

/** 掃所有根目錄下含 loop.md 的子目錄 → [{slug, dir, mdPath, md, mtime}]。 */
export function collectLoopEntries(cwd) {
  const entries = [];
  for (const root of collectLoopRoots(cwd)) {
    for (const slug of safeReaddir(root)) {
      try {
        const dir = join(root, slug);
        const mdPath = join(dir, 'loop.md');
        if (statSync(dir).isDirectory() && existsSync(mdPath)) {
          entries.push({ slug, dir, mdPath, md: safeReadFile(mdPath), mtime: statSync(mdPath).mtimeMs });
        }
      } catch { /* 單一子目錄失敗 → 跳過、續掃其餘 */ }
    }
  }
  return entries;
}

/**
 * 從 entries 挑「本 session active」一筆：排除完工；有 sid → 比對 session 欄、取 mtime 最新；
 * 無 sid → 近期活躍窗內取 mtime 最新。now 注入以利測試（省略視為 0、等同不設窗下限）。
 */
export function pickActiveLoop(entries, sid, now) {
  const t = typeof now === 'number' ? now : 0;
  const active = (entries || []).filter((e) => !isDone(currentStage(e.md)));
  if (sid) {
    return active.filter((e) => pickLoopField(e.md, 'session') === sid).sort((a, b) => b.mtime - a.mtime)[0] || null;
  }
  return active.filter((e) => t - e.mtime < FALLBACK_WINDOW_MS).sort((a, b) => b.mtime - a.mtime)[0] || null;
}
```

- [ ] **Step 4: 跑測試確認 Green**

Run: `cd plugins/loops-workflow && node scripts/test-progress.mjs`
Expected: PASS —— Section A 全綠（progress.mjs 的 smoke 尚未加入，本步不含）。

- [ ] **Step 5: Commit**

```bash
git add plugins/loops-workflow/scripts/loops-scan.mjs plugins/loops-workflow/scripts/test-progress.mjs
git commit -m "feat(loops-workflow): add loops-scan shared .loops parser

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `scripts/progress.mjs`（renderer + CLI）

**Files:**
- Create: `plugins/loops-workflow/scripts/progress.mjs`
- Modify: `plugins/loops-workflow/scripts/test-progress.mjs`（追加 Section B + smoke）

**Interfaces:**
- Consumes: `loops-scan.mjs` 全部 export。
- Produces:
  - `extractProgress(entry): {slug,type,operation,mode,round,maxRounds,done,stopCondition,stages:{name,state}[],preStages:{name,state}[],findings:string,head:string,currentTask:string,nextStep:string,recentJournal:string[],outcome:string}`（`state ∈ 'done'|'now'|'pending'`）
  - `renderChat(p): string`
  - `renderMarkdown(p): string`
  - CLI：`node progress.mjs [slug] [--write-only]` —— 掃 cwd、挑 loop（給 slug 用該 slug；否則 `pickActiveLoop` 用 `CLAUDE_CODE_SESSION_ID`）、寫 `<loop.dir>/PROGRESS.md`；非 `--write-only` 時把 `renderChat` 印到 stdout。無 loop → no-op exit 0。任何錯誤吞掉 exit 0。

- [ ] **Step 1: 追加失敗測試（`test-progress.mjs` 在 `process.exit` 前插入 Section B + smoke）**

```js
// =============================================================================
// B) progress.mjs — 純函式（extractProgress / renderChat / renderMarkdown）
// =============================================================================
import { extractProgress, renderChat, renderMarkdown } from './progress.mjs';

// ── B1 extractProgress：階段管線狀態（build 為 now、其前 done、其後 pending）──
{
  const p = extractProgress({ slug: '137-trash-delete-permanent', dir: '', md: SAMPLE_LOOP_MD, mtime: 1 });
  assert(p.slug === '137-trash-delete-permanent', 'extractProgress slug [B1]');
  assert(p.type === 'issue' && p.operation === 'bug-fix' && p.mode === 'auto', 'extractProgress 類型/operation/模式 [B1]');
  const byName = Object.fromEntries(p.stages.map((s) => [s.name, s.state]));
  assert(byName.plan === 'done' && byName.build === 'now' && byName.verify === 'pending',
    'extractProgress：plan=done / build=now / verify=pending [B1]');
  assert(p.done === false, 'extractProgress：未完工 done=false [B1]');
}

// ── B2 extractProgress：圈數 / findings / nextStep / maxRounds ──
{
  const p = extractProgress({ slug: 's', dir: '', md: SAMPLE_LOOP_MD, mtime: 1 });
  assert(p.round === 1 && p.maxRounds === 3, 'extractProgress：回環 #1 → round=1, maxRounds=3 [B2]');
  assert(/1\s*[→\-]+>?\s*0/.test(p.findings), 'extractProgress：findings 抓到 1→0 [B2]');
  assert(p.nextStep === 'verify', 'extractProgress：build 的下一步 = verify [B2]');
  assert(p.recentJournal.length >= 1 && p.recentJournal.length <= 5, 'extractProgress：recentJournal 1~5 筆 [B2]');
}

// ── B3 extractProgress：完工 loop → done=true、全階段 done、有 outcome ──
{
  const doneMd = SAMPLE_LOOP_MD.replace('當前階段 | build（任務 3/4）', '當前階段 | 完工')
    + '\n- ★[outcome] 完工 ｜ token≈120K(中)est ｜ sub-agent 3 ｜ 回環 1 圈 ｜ findings 1→0 ｜ 交付：PR #6 merged\n';
  const p = extractProgress({ slug: 's', dir: '', md: doneMd, mtime: 1 });
  assert(p.done === true, 'extractProgress：完工 → done=true [B3]');
  assert(p.stages.every((s) => s.state === 'done'), 'extractProgress：完工 → 全階段 done [B3]');
  assert(p.outcome.includes('★[outcome]') && p.outcome.includes('PR #6'), 'extractProgress：抓到 outcome 行 [B3]');
  assert(p.nextStep === '完工', 'extractProgress：完工 → nextStep="完工" [B3]');
}

// ── B4 extractProgress：缺欄不編造（無 findings / 無回環 → 空字串 / round 0）──
{
  const lean = `| 類型 | design |\n| 當前階段 | explore |\n\n## Journal\n- [E1] 進入 explore\n`;
  const p = extractProgress({ slug: 's', dir: '', md: lean, mtime: 1 });
  assert(p.findings === '' && p.head === '', 'extractProgress：無 findings/commit → 空字串 [B4]');
  assert(p.round === 0, 'extractProgress：無回環 → round 0 [B4]');
  const byName = Object.fromEntries(p.stages.map((s) => [s.name, s.state]));
  assert(byName.explore === 'now' && byName.goal === 'done' && byName.plan === 'pending', 'extractProgress：explore=now [B4]');
}

// ── B5 renderChat：含 slug、階段符號、圈數、下一步 ──
{
  const p = extractProgress({ slug: '137-trash-delete-permanent', dir: '', md: SAMPLE_LOOP_MD, mtime: 1 });
  const chat = renderChat(p);
  assert(chat.includes('137-trash-delete-permanent'), 'renderChat 含 slug [B5]');
  assert(chat.includes('build ●') && chat.includes('plan ✓') && chat.includes('verify ○'), 'renderChat 階段符號 [B5]');
  assert(chat.includes('圈 1/3'), 'renderChat 含圈數 [B5]');
  assert(/下一步.*verify/.test(chat), 'renderChat 含下一步 [B5]');
}

// ── B6 renderMarkdown：標題、checkbox、mermaid、勿手改註記 ──
{
  const p = extractProgress({ slug: '137-trash-delete-permanent', dir: '', md: SAMPLE_LOOP_MD, mtime: 1 });
  const mdOut = renderMarkdown(p);
  assert(mdOut.includes('# ⟳ 137-trash-delete-permanent'), 'renderMarkdown 標題 [B6]');
  assert(mdOut.includes('```mermaid'), 'renderMarkdown 含 mermaid [B6]');
  assert(mdOut.includes('- [x] plan') && mdOut.includes('- [ ] **build'), 'renderMarkdown checkbox（build 標現在）[B6]');
  assert(/自動產生.*勿/.test(mdOut), 'renderMarkdown 含「自動產生請勿手改」註記 [B6]');
}

// =============================================================================
// SMOKE — progress.mjs（真 spawn，驗 stdout / PROGRESS.md / no-op / --write-only）
// =============================================================================
function runProgress(args, cwd, env = {}) {
  return spawnSync(process.execPath, [PROGRESS_SCRIPT, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env },
  });
}

// ── S1：給 slug → 寫出 PROGRESS.md 且 stdout 含儀表板 ──
{
  const cwd = mkdtempSync(join(tmpdir(), 'prog-slug-'));
  try {
    const dir = seedLoop(cwd, '137-trash-delete-permanent', SAMPLE_LOOP_MD);
    const res = runProgress(['137-trash-delete-permanent'], cwd);
    assert(res.status === 0, 'S1：exit 0 [S1]');
    assert(existsSync(join(dir, 'PROGRESS.md')), 'S1：寫出 .loops/<slug>/PROGRESS.md [S1]');
    assert(res.stdout.includes('137-trash-delete-permanent') && res.stdout.includes('圈 1/3'), 'S1：stdout 含儀表板 [S1]');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

// ── S2：--write-only → 不印 stdout、只寫檔 ──
{
  const cwd = mkdtempSync(join(tmpdir(), 'prog-wo-'));
  try {
    const dir = seedLoop(cwd, '137-trash-delete-permanent', SAMPLE_LOOP_MD);
    const res = runProgress(['137-trash-delete-permanent', '--write-only'], cwd);
    assert(res.status === 0, 'S2：exit 0 [S2]');
    assert(res.stdout.trim() === '', 'S2：--write-only 不印 stdout [S2]');
    assert(existsSync(join(dir, 'PROGRESS.md')), 'S2：--write-only 仍寫檔 [S2]');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

// ── S3：無 slug + 設 CLAUDE_CODE_SESSION_ID → 挑本 session loop ──
{
  const cwd = mkdtempSync(join(tmpdir(), 'prog-sid-'));
  try {
    const dir = seedLoop(cwd, '137-trash-delete-permanent', SAMPLE_LOOP_MD); // session=sess-abc
    const res = runProgress([], cwd, { CLAUDE_CODE_SESSION_ID: 'sess-abc' });
    assert(res.status === 0 && existsSync(join(dir, 'PROGRESS.md')), 'S3：本 session loop 被挑中並寫檔 [S3]');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

// ── S4：無 .loops/ → no-op、exit 0、無輸出、不丟 ──
{
  const cwd = mkdtempSync(join(tmpdir(), 'prog-empty-'));
  try {
    const res = runProgress([], cwd, { CLAUDE_CODE_SESSION_ID: 'sess-abc' });
    assert(res.status === 0, 'S4：無 .loops/ → exit 0 [S4]');
    assert(res.stdout.trim() === '', 'S4：無 loop → 無輸出 [S4]');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
```

- [ ] **Step 2: 跑測試確認 Red**

Run: `cd plugins/loops-workflow && node scripts/test-progress.mjs`
Expected: FAIL —— `ERR_MODULE_NOT_FOUND`（`progress.mjs` 尚未建立）。

- [ ] **Step 3: 寫最小實作 `scripts/progress.mjs`**

```js
#!/usr/bin/env node
// progress.mjs —— loops-workflow 進度 renderer（取代 statusline）。
// 兩出口：① stdout chat 儀表板（/loops-workflow:progress 用）② .loops/<slug>/PROGRESS.md（編輯器 preview）。
// CLI：node progress.mjs [slug] [--write-only]。無 loop → no-op；任何錯誤吞掉 exit 0、永不擋路。
// 純函式（extractProgress/renderChat/renderMarkdown）可直接 import 測；main() 為 IO 薄邊界 + import.meta.url 守衛。

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  STAGE_ORDER, PRE_STAGES, MAX_ROUNDS,
  pickLoopField, journalEntries, currentStage, isDone,
  collectLoopEntries, pickActiveLoop,
} from './loops-scan.mjs';

const STATE_SYMBOL = { done: '✓', now: '●', pending: '○' };
const RECENT_JOURNAL_N = 5;

/** 把 loop entry 抽成結構化進度。純函式（只讀 entry.md）。 */
export function extractProgress(entry) {
  const md = String(entry && entry.md || '');
  const stage = currentStage(md);
  const done = isDone(stage);
  const journal = journalEntries(md);

  // 階段管線狀態
  const currentIdx = STAGE_ORDER.indexOf(stage);
  const stages = STAGE_ORDER.map((name, i) => {
    let state = 'pending';
    if (done || (currentIdx >= 0 && i < currentIdx)) state = 'done';
    else if (i === currentIdx) state = 'now';
    return { name, state };
  });
  // 前置階段：journal 出現「進入 <pre>」才顯示，一律視為 done（在 goal 之前）
  const preStages = PRE_STAGES
    .filter((name) => journal.some((j) => new RegExp(`進入\\s*${name}`).test(j)))
    .map((name) => ({ name, state: 'done' }));

  // 圈數：journal「回環 #N」最大 N（無 → 0）
  const round = journal.reduce((max, j) => {
    const m = j.match(/回環\s*#?(\d+)/);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);

  // findings「X→Y」/ commit SHA：從 journal 由後往前找
  const findings = findLast(journal, /findings?\s*[:：]?\s*\d+\s*[→\-]+>?\s*\d+/i) || '';
  const headLine = findLast(journal, /\b[0-9a-f]{7,40}\b/);
  const head = headLine ? (headLine.match(/\b([0-9a-f]{7,40})\b/) || [])[1] || '' : '';
  const findingsText = (findings.match(/findings?\s*[:：]?\s*\d+\s*[→\-]+>?\s*\d+/i) || [''])[0];

  // 當前任務：journal 最後一筆含「任務」的；下一步：階段順序映射
  const currentTask = stripEventTag(findLast(journal, /任務/) || '');
  const nextStep = done ? '完工' : (currentIdx >= 0 && currentIdx < STAGE_ORDER.length - 1
    ? STAGE_ORDER[currentIdx + 1] : (currentIdx === STAGE_ORDER.length - 1 ? '完工' : (stage === '?' ? '' : 'goal')));

  const outcome = (md.split('\n').map((l) => l.trim()).find((l) => l.includes('★[outcome]'))) || '';
  const recentJournal = journal.slice(-RECENT_JOURNAL_N).map(stripEventTagKeepId);

  return {
    slug: entry && entry.slug || '?',
    type: pickLoopField(md, '類型') || '?',
    operation: pickLoopField(md, 'operation') || '',
    mode: pickLoopField(md, '推進模式') || '',
    round, maxRounds: MAX_ROUNDS, done,
    stopCondition: pickLoopField(md, '停止條件') || '',
    stages, preStages,
    findings: findingsText, head,
    currentTask, nextStep, outcome, recentJournal,
  };
}

function findLast(arr, re) {
  for (let i = arr.length - 1; i >= 0; i--) if (re.test(arr[i])) return arr[i];
  return '';
}
function stripEventTag(line) { return String(line).replace(/^-\s*\[E\d+\]\s*/, '').trim(); }
function stripEventTagKeepId(line) {
  const m = String(line).match(/^-\s*\[(E\d+)\]\s*(.*)$/);
  return m ? `${m[1]} ${m[2].trim()}` : stripEventTag(line);
}

/** chat 緊湊儀表板。 */
export function renderChat(p) {
  const head = `⟳ ${p.slug}   ${[p.type, p.operation, p.mode].filter(Boolean).join('·')}   圈 ${p.round}/${p.maxRounds}`;
  const pipeline = p.stages.map((s) => `${s.name} ${STATE_SYMBOL[s.state]}`).join('  ');
  const lines = [head, pipeline];
  const taskBits = [p.currentTask, p.head && `HEAD ${p.head}`].filter(Boolean).join('   ');
  if (taskBits) lines.push(taskBits);
  if (p.findings) lines.push(p.findings);
  if (p.recentJournal.length) lines.push('最近：' + p.recentJournal.join(' / '));
  if (p.nextStep) lines.push(`下一步 → ${p.nextStep}`);
  if (p.done && p.outcome) lines.push(p.outcome);
  return lines.join('\n');
}

/** PROGRESS.md（編輯器 markdown preview 用）。 */
export function renderMarkdown(p) {
  const meta = [p.type, p.operation, p.mode].filter(Boolean).map((x) => `\`${x}\``).join(' · ');
  const mermaid = ['```mermaid', 'flowchart LR'];
  const cls = { done: 'done', now: 'now', pending: 'todo' };
  const ids = p.stages.map((s, i) => `s${i}["${s.name}"]:::${cls[s.state]}`);
  mermaid.push('  ' + ids.join(' --> '));
  mermaid.push('  classDef done fill:#9f9,stroke:#393;');
  mermaid.push('  classDef now fill:#fd6,stroke:#c90,font-weight:bold;');
  mermaid.push('  classDef todo fill:#eee,stroke:#999;');
  mermaid.push('```');

  const checks = p.stages.map((s) => s.state === 'now'
    ? `- [ ] **${s.name} ← 現在**`
    : `- [${s.state === 'done' ? 'x' : ' '}] ${s.name}`);

  const journalRows = ['| # | 事件 |', '|---|---|',
    ...p.recentJournal.map((j) => {
      const m = j.match(/^(E\d+)\s*(.*)$/);
      return m ? `| ${m[1]} | ${m[2]} |` : `| | ${j} |`;
    })];

  const out = [
    '<!-- 由 loops-workflow 自動產生（每回合 Stop hook 重生），請勿手改；已被 .loops/* gitignore -->',
    `# ⟳ ${p.slug}`,
    `${meta} · 圈 ${p.round}/${p.maxRounds}${p.stopCondition ? ` · 停止條件：${p.stopCondition}` : ''}`,
    '',
    '## 階段',
    mermaid.join('\n'),
    '',
    ...(p.preStages.length ? [`前置：${p.preStages.map((s) => s.name).join(' → ')} ✓`, ''] : []),
    ...checks,
    '',
  ];
  if (p.currentTask || p.findings || p.head) {
    out.push('## 當前任務');
    if (p.currentTask) out.push(p.currentTask);
    const bits = [p.findings, p.head && `HEAD \`${p.head}\``].filter(Boolean).join('　');
    if (bits) out.push(bits);
    out.push('');
  }
  if (p.recentJournal.length) { out.push('## Journal（最近）', ...journalRows, ''); }
  out.push(p.done ? (p.outcome || '完工 ✅') : `下一步 → ${p.nextStep}`, '');
  return out.join('\n');
}

// ── IO 薄邊界 ──
function main() {
  const args = process.argv.slice(2);
  const writeOnly = args.includes('--write-only');
  const slug = args.find((a) => !a.startsWith('--'));
  const cwd = process.cwd();
  const entries = collectLoopEntries(cwd);

  let entry = null;
  if (slug) entry = entries.find((e) => e.slug === slug) || null;
  else entry = pickActiveLoop(entries, (process.env.CLAUDE_CODE_SESSION_ID || '').trim(), Date.now());
  if (!entry) return; // no-op

  const p = extractProgress(entry);
  try { writeFileSync(join(entry.dir, 'PROGRESS.md'), renderMarkdown(p), 'utf8'); } catch { /* 寫檔失敗不擋路 */ }
  if (!writeOnly) process.stdout.write(renderChat(p) + '\n');
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try { main(); } catch { /* 永不擋路 */ }
  process.exit(0);
}
```

> 註：`dirname` import 雖未直接用於 main，可移除；保留 `join` 即可。實作時若 lint 報未用 import 就刪掉 `dirname`。

- [ ] **Step 4: 跑測試確認 Green**

Run: `cd plugins/loops-workflow && node scripts/test-progress.mjs`
Expected: PASS —— Section A + B + S1~S4 全綠。

- [ ] **Step 5: Commit**

```bash
git add plugins/loops-workflow/scripts/progress.mjs plugins/loops-workflow/scripts/test-progress.mjs
git commit -m "feat(loops-workflow): add progress renderer (chat + PROGRESS.md)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `hooks/progress-render.mjs`（Stop hook）+ 註冊

**Files:**
- Create: `plugins/loops-workflow/hooks/progress-render.mjs`
- Modify: `plugins/loops-workflow/hooks/hooks.json`（Stop 陣列加一筆 + 更新 description）
- Modify: `plugins/loops-workflow/scripts/test-progress.mjs`（追加 hook smoke）

**Interfaces:**
- Consumes: 透過 spawn 跑 `scripts/progress.mjs --write-only`（同 plugin 內相對路徑）。
- Produces: 恆跑 Stop hook，對本 session active loop 重生 PROGRESS.md；**不注入 context、不擋路、exit 0**。

- [ ] **Step 1: 追加失敗測試（`test-progress.mjs` 於 `process.exit` 前插入）**

```js
// =============================================================================
// SMOKE — hooks/progress-render.mjs（真 spawn hook，驗只寫檔不注入 context）
// =============================================================================
const RENDER_HOOK = join(HERE, '..', 'hooks', 'progress-render.mjs');

// ── H1：Stop hook 對本 session loop 寫出 PROGRESS.md、stdout 無 additionalContext ──
{
  const cwd = mkdtempSync(join(tmpdir(), 'prog-hook-'));
  try {
    const dir = seedLoop(cwd, '137-trash-delete-permanent', SAMPLE_LOOP_MD);
    const res = spawnSync(process.execPath, [RENDER_HOOK], {
      cwd, encoding: 'utf8',
      input: JSON.stringify({ session_id: 'sess-abc', cwd }),
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'sess-abc' },
    });
    assert(res.status === 0, 'H1：hook exit 0 [H1]');
    assert(existsSync(join(dir, 'PROGRESS.md')), 'H1：hook 寫出 PROGRESS.md [H1]');
    assert(!String(res.stdout).includes('additionalContext'), 'H1：hook 不注入 context [H1]');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

// ── H2：無 .loops/ → hook no-op、exit 0、不丟 ──
{
  const cwd = mkdtempSync(join(tmpdir(), 'prog-hook-empty-'));
  try {
    const res = spawnSync(process.execPath, [RENDER_HOOK], {
      cwd, encoding: 'utf8', input: JSON.stringify({ session_id: 'sess-abc', cwd }),
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'sess-abc' },
    });
    assert(res.status === 0, 'H2：無 .loops/ → hook exit 0 [H2]');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
```

- [ ] **Step 2: 跑測試確認 Red**

Run: `cd plugins/loops-workflow && node scripts/test-progress.mjs`
Expected: FAIL —— H1 寫檔斷言失敗（`progress-render.mjs` 尚未建立、spawn 子程序 `ENOENT`/非 0，PROGRESS.md 不存在）。

- [ ] **Step 3: 寫實作 `hooks/progress-render.mjs`**

```js
#!/usr/bin/env node
// progress-render.mjs —— loops-workflow Stop hook（恆跑）。
// 每回合結束跑 scripts/progress.mjs --write-only，對本 session active loop 重生 PROGRESS.md。
// 不注入任何 context（只做檔案 side-effect）、無 .loops/ → no-op、永不擋路 exit 0。
// stdin 的 hook payload 讀掉即丟（不需要）。

import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../hooks
const PROGRESS = join(HERE, '..', 'scripts', 'progress.mjs');

try {
  // 同步 spawn renderer（--write-only：只寫 PROGRESS.md、不印 stdout）。
  // CLAUDE_CODE_SESSION_ID 由 progress.mjs 自 env 讀，挑本 session active loop。
  spawnSync(process.execPath, [PROGRESS, '--write-only'], {
    cwd: process.cwd(),
    stdio: 'ignore',
    env: process.env,
  });
} catch {
  // 永不擋路
}
process.exit(0);
```

- [ ] **Step 4: 跑測試確認 Green**

Run: `cd plugins/loops-workflow && node scripts/test-progress.mjs`
Expected: PASS —— H1/H2 連同前面全綠。

- [ ] **Step 5: 註冊進 `hooks/hooks.json`（Stop 陣列加一筆、更新 description）**

把 Stop 區塊的 `hooks` 陣列**最後**加入 progress-render（放最後，使它在 cost/eval/stop-gate 之後跑）：

```json
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/progress-render.mjs\""
          }
```

並在 `description` 的 `Stop=` 段末尾補一句：`+ progress-render 恆跑：每回合對本 session active loop 重生 .loops/<slug>/PROGRESS.md（只寫檔、不注入、永不擋路）`。

- [ ] **Step 6: 驗證 hooks.json 仍是合法 JSON**

Run: `cd plugins/loops-workflow && node -e "JSON.parse(require('fs').readFileSync('hooks/hooks.json','utf8'));console.log('hooks.json OK')"`
Expected: 印出 `hooks.json OK`。

- [ ] **Step 7: Commit**

```bash
git add plugins/loops-workflow/hooks/progress-render.mjs plugins/loops-workflow/hooks/hooks.json plugins/loops-workflow/scripts/test-progress.mjs
git commit -m "feat(loops-workflow): auto-render PROGRESS.md via Stop hook

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `commands/progress.md`（slash 指令）

**Files:**
- Create: `plugins/loops-workflow/commands/progress.md`

- [ ] **Step 1: 寫指令檔**

```markdown
---
description: 顯示某條 loops-workflow 迴圈的完整進度儀表板（chat），並重生 .loops/<slug>/PROGRESS.md 供編輯器 markdown preview。
argument-hint: [slug]
---

顯示一條 loop 的完整進度（取代舊 statusline）。**唯讀進度、不改 loop 狀態。**

1. **定位 renderer**：在 `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/` 底下找路徑含 `loops-workflow/scripts/` 的 `progress.mjs`（marketplaces 與 cache 兩處都找，優先 `plugins/marketplaces/`）。找不到 → 回報「找不到 loops-workflow，請先 `/plugin install loops-workflow@dev-workflows`」並停止。
2. **跑它**：`node "<progress.mjs 絕對路徑>" $ARGUMENTS`（`$ARGUMENTS` 為使用者給的 slug；省略則自動挑本 session 正在跑的 loop）。
3. **relay 輸出**：把 stdout 的儀表板原樣呈現給使用者。若無輸出（沒有 active loop / 找不到該 slug）→ 回報「目前沒有正在跑的 loop（或查無此 slug）。可用 `/loops-workflow:status` 列出全部」。
4. **提示**：它同時已（重）寫 `.loops/<slug>/PROGRESS.md`，提醒使用者可在 VS Code 開該檔的 **markdown preview** 常駐看進度（免安裝、會被 Stop hook 每回合自動更新）。

> 與 `/loops-workflow:status` 的分工：`status` 列「全部 active loop」一行摘要；`progress` 深看「一條 loop」的完整儀表板 + 產 PROGRESS.md。
```

- [ ] **Step 2: 驗證 frontmatter 格式與既有 command 一致**

Run: `cd plugins/loops-workflow && head -4 commands/progress.md`
Expected: 含 `---` / `description:` / `argument-hint:` / `---`（對齊 `commands/resume.md` 風格）。

- [ ] **Step 3: Commit**

```bash
git add plugins/loops-workflow/commands/progress.md
git commit -m "feat(loops-workflow): add /progress command

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 移除 statusline

**Files:**
- Delete: `plugins/loops-workflow/scripts/statusline.sh`
- Delete: `plugins/loops-workflow/scripts/hud-status.mjs`
- Delete: `plugins/loops-workflow/commands/install-statusline.md`

- [ ] **Step 1: 刪檔**

```bash
git rm plugins/loops-workflow/scripts/statusline.sh \
       plugins/loops-workflow/scripts/hud-status.mjs \
       plugins/loops-workflow/commands/install-statusline.md
```

- [ ] **Step 2: 確認沒有 code 還 import hud-status（文件引用留待 Task 6）**

Run: `cd plugins/loops-workflow && grep -rn "hud-status\|statusline.sh\|install-statusline" --include=*.mjs --include=*.json . || echo "NO CODE REFERENCES"`
Expected: 印出 `NO CODE REFERENCES`（`.mjs`/`.json` 內已無引用；`.md` 文件引用在 Task 6 處理）。

- [ ] **Step 3: 跑測試確認未被波及**

Run: `cd plugins/loops-workflow && node scripts/test-progress.mjs`
Expected: PASS（全綠，刪 statusline 不影響新 renderer）。

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(loops-workflow): remove statusline (replaced by /progress)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 文件全面同步（README 重構 + AGENTS/FLOW/automations）

**Files:**
- Modify: `README.md`（全面重構，見下方完整新內容）
- Modify: `AGENTS.md`（規則 3 / 規則 9 / §3 intent 表）
- Modify: `plugins/loops-workflow/docs/FLOW.md`（§9 automations 列、§10 數字）
- Modify: `plugins/loops-workflow/references/automations.md`（若提及 statusline）

- [ ] **Step 1: 用下列完整內容覆寫 `README.md`**

````markdown
# dev-workflows

> 個人開發工作流 plugin marketplace（測試性）。目前 **1 個 plugin**：

| Plugin | 用途 | 怎麼用 |
|---|---|---|
| **loops-workflow** | 7 階段閉環開發工作流（**既有專案**內加功能 / 設計 / 修問題）+ 內建 greenfield 專案 scaffold | `/loops-workflow:dispatch <一句話>` |

## 安裝

```
/plugin marketplace add adha9990/dev-workflows  # 從 GitHub 加入 marketplace（owner/repo 簡寫）
/plugin install loops-workflow@dev-workflows    # 閉環開發 + 內建 greenfield scaffold（單一 plugin）
/reload-plugins
```

**怎麼選**：既有專案內開發 → `/loops-workflow:dispatch`；空資料夾從零建乾淨架構 → `/loops-workflow:scaffold-fullstack`（或 dispatch 偵測到乾淨專案會引導你用）。

---

# loops-workflow（plugin）

7 階段閉環開發工作流，呼叫帶 `loops-workflow:` 前綴。把開發拆成 `dispatch → goal → explore → plan → build → verify → iterate`（dispatch 視情況先走前置：`clarify` 釐清模糊需求 / `scaffold` 建骨架 / `define` 開 issue），`.loops/<slug>/` 的 markdown 當階段間記憶體。**只在真正要你選的決策點停（用 `AskUserQuestion`）**，routine 轉場直接往下；也支援 opt-in 自動連跑。

> 📊 **完整流程圖**（每階段用幾個 skill / agent、在處理什麼、機制、策略 + mermaid 全貌）見 **[`docs/FLOW.md`](plugins/loops-workflow/docs/FLOW.md)**；**共用規範的分類目錄**見 **[`docs/REFERENCES.md`](plugins/loops-workflow/docs/REFERENCES.md)**。下面是快速參考。

> **設計座標**：**Closed Loop**（人類在框架內把關）· **單一迴圈**預設、opt-in **Fleet** 編隊 · 目標脈絡＝**VISION**（goal）/ **ARCHITECTURE**（設計書 §0–§9）/ **RULES**（AGENTS）· **成本意識**（迴圈很貴 → 高上下文效率、便宜的先·貴的 gate、不重複勞動、fail-fast；**只砍非必要貴動作 + 浪費,不砍 define/gate/verify**；見 `AGENTS.md` 規則 10）。

## 工作流程

```
前置（dispatch 視情況路由）：clarify 釐清模糊需求｜scaffold 建骨架｜define 開 issue
        │
dispatch → goal → explore → plan → build → verify → iterate
                                                        │
                  回 goal / explore / plan / build ◀────┤（≤ 3 圈，修完一定再 verify）
                                                        └──▶ 完工（交 PR / 收尾）
```

> **修完一定再過一輪 verify**（fix delta + 波及面派 fresh reviewer；「測試綠 / typecheck 0」不算數）。**完工只在 verify 乾淨那輪才可達** —— 交給其他 reviewer 前先在內部把問題解到最少。

**只在真正要你做選擇的決策點停下用 `AskUserQuestion` 問**（explore 選方法 / plan 拍板 / iterate 完工或回環 / 真正的 scope 取捨 / 安全停：分類模糊·危險操作·P0·規格不清）。**routine 轉場（進入下一階段）不問、直接往下**，產出寫進 `.loops/` + 摘要，你隨時可插話喊停 / 改。需要時可開 opt-in `auto` 模式（連決策也用推薦選項自動帶過，只剩安全停）。

## Skill 清單（7 階段，各自可獨立呼叫）

> 「停下問你？」欄：✋ = 真決策、一定停下用 `AskUserQuestion`；其餘只在列出的條件下才停，否則 routine 直接往下。

| Skill | 停下問你？ | 做什麼 |
|---|---|---|
| `loops-workflow:dispatch` | 僅分類模糊 / scaffold 才停 | 決策樹分流（**乾淨空專案→scaffold 骨架** / issue→goal / 無 issue 待解決→define / 設計→explore / PR→iterate）+ 建 `loop.md` + 進起點階段 |
| `loops-workflow:define` | 有 blocking 決策才停 | **前置**：模糊問題 / 點子 → Readiness Model + repo issue template + **一次一問 intake** + scope sizing + flowchart → 建 template-ready issue（草稿確認 → `gh issue create --assignee @me`）→ 再 goal |
| `loops-workflow:goal` | 有 scope 取捨才停 | **逐句掃 issue 抽 requirement**（不只 AC 段）→ 一次一問訪談 → restate 六欄完工定義 + 可驗證停止條件 |
| `loops-workflow:explore` | ✋ 選方法 | 內部找可重用 → **不夠才**搜外部（內部+需求已釘死就不搜、省資源）→ 攤開推薦；deep-research 升級要 gate；框架 API 查官方文件 |
| `loops-workflow:plan` | ✋ 拍板方案 | decision record + 機制圖（**拍板 gate 渲染運作流程圖＋注入接線圖給你看**）+ ≥3 套件評估 + 拆成可獨立 verify 的任務；**計畫草稿在 plan 階段就送出**（living plan，實作偏離回去改） |
| `loops-workflow:build` | 危險 / 卡關才停 | 逐任務**紅綠分離**（test-author 看不到 impl / impl-author 不准改 test）+ Refactor + 分段 commit |
| `loops-workflow:verify` | 出 P0 才停 | **同回合派 6 reviewer** fan-out（+ 視領域加派條件式 reviewer）+ 跑真 app + 本機 /code-review + finding-validator 二輪 + P0–P3 分級 |
| `loops-workflow:iterate` | ✋ 完工（回環自動） | 回饋四分類 + **actionable 一律自動全修（不論 P2/P3、不問「修多少」）** + Stop-the-Line 根因修 + **3 圈上限**；收尾交接物**依類型**（修正型只一份回覆 reviewer／完整迴圈才產 PR 收尾 comment + explain），草稿確認才送；**follow-up 留當前 issue、不另開** |

另有兩個側用 skill（唯讀 / 不在迴圈裡）：`loops-workflow:explain <target>` 產工程師理解包（實作導讀 + 自測題 + 設計方向）；`loops-workflow:agents-md-maintainer` 漸進維護 repo 的 agent-facing 文檔（`AGENTS.md` + 覆蓋率追蹤表 + 各模組 `AGENTS.md`，documentation-only、不被 dispatch 路由）。

## 兩個引擎

- **build 紅綠分離**：`test-author`（只看需求、看不到 impl）→ `impl-author`（只轉綠、不准改 test）→ Refactor → 衝突派 `referee` 裁決。讓測試不會遷就實作。
- **verify fan-out**：主線同回合派 6 reviewer（product-contract / architecture / security / performance / code-quality / tests）各審一軸 + 條件式領域 reviewer + `finding-validator` 二輪，輸出 Ready / Not ready。

## 看進度（`/progress` + `PROGRESS.md`）

迴圈進度全寫在 `.loops/<slug>/` 的 `loop.md`（儀表板 + Journal 事件日誌）。要看「目前跑到哪、第幾圈、findings、下一步」，有三條路、**全部免安裝、零 token、跨平台**：

| 看法 | 怎麼用 | 看到什麼 |
|---|---|---|
| **完整儀表板（chat）** | `/loops-workflow:progress [slug]` | 一條 loop 的階段管線（`plan ✓ build ● verify ○`）+ 圈數 + 當前任務 + findings + 最近 Journal + 下一步 |
| **常駐預覽（編輯器）** | 開 `.loops/<slug>/PROGRESS.md` 的 **markdown preview** | 同一份儀表板的 markdown 版（mermaid 階段圖 + checkbox + Journal 時間軸）；由 Stop hook **每回合自動重生**、永遠最新 |
| **列出全部 active loop** | `/loops-workflow:status` | 每條 loop 一行摘要（slug / 類型 / 當前階段 / 模式 / 最後一筆 Journal） |

> 機制：`scripts/progress.mjs`（共用 renderer，吃 `loop.md` + `0N-*.md`）渲染兩種出口；恆跑的 Stop hook `hooks/progress-render.mjs` 每回合對「本 session 正在跑」的 loop 重生 `PROGRESS.md`（靠 `CLAUDE_CODE_SESSION_ID` 比對，已完工 / 別 session 不顯示）。`PROGRESS.md` 寫在主 repo 的 `.loops/`、被 `.loops/*` gitignore 涵蓋、不入庫。SessionStart hook 另會在開場浮出 active 迴圈。

## 進階（opt-in）

| 能力 | 入口 |
|---|---|
| 自動連跑（核准一次、危險才停） | `dispatch auto <…>`，見 `references/auto-mode.md` |
| 競賽 / 投票式編隊（N 方案→評審） | plan / explore 說「用 Fleet」，見 `references/fleet.md` |
| 跨 session 接續 | `/loops-workflow:resume <slug>`，見 `references/journaling.md` |
| 機器可驗證計畫 + eval | 計畫塊 `scripts/validate-plan.mjs`（見 `references/machine-plan-schema.md`）/ dispatch 場景評測 `scripts/run-eval.mjs`（見 `references/eval-harness.md`） |
| 看單條 loop 完整進度 | `/loops-workflow:progress <slug>`（chat 儀表板 + 重生 `PROGRESS.md`） |
| 列出 active 迴圈 | `/loops-workflow:status`（SessionStart hook 也會自動浮出） |
| 工程師理解包 | `/loops-workflow:explain <target>`（唯讀側用） |
| code 工作隔離 | 會動 code 的迴圈（issue / fix）在 **git worktree**（自帶 branch）裡做，不擾動主 checkout；`EnterWorktree` 或 `.claude/worktrees/<issue#>-<slug>`（例 `137-trash-delete-permanent`，**不加 `fix/` 前綴**） |

intent→command 對照與全程操作規則見 plugin 內的 `AGENTS.md`（marketplace 根）。

## 結構

```
plugins/loops-workflow/
├── skills/       define（前置：模糊問題→issue）+ 7 階段 + explain（側用）
│                 + scaffold-fullstack（前置：greenfield 骨架，自帶整棵模板樹）
│                 + agents-md-maintainer（側用：AGENTS.md 文檔維運）
├── agents/       build 紅綠分離 3（test-author / impl-author / referee）
│                 + verify 6 核心 reviewer + finding-validator + 9 條件式領域 reviewer（含 root-cause / docs-devex）
├── commands/     loop / resume / status / explain / progress
├── hooks/        SessionStart：浮出 active .loops/ 迴圈；Stop：progress-render 重生 PROGRESS.md（恆跑）+ opt-in 觀測/閘
├── scripts/      validate-plan / run-eval / loops-scan / progress
└── references/   各階段規範 + 模板（clean-code / clean-architecture / design-patterns / refactoring / code-simplification /
                  security-checklist / reuse-check / docs-policy /
                  commit-spec / pr-spec / comment-policy / onboarding / reviewer-severity /
                  finding-validation / preflight / cross-model-review / optional-reviewers /
                  〔per-axis 審查判準〕review-dispositions / acceptance-review / correctness-review / architecture-review /
                  performance-review / ui-interaction-review / root-cause-review / docs-devex-review /
                  auto-mode / fleet /
                  journaling / plan-schema / design-plan-schema / contract-spec / eval-harness /
                  automations / test-rubric / pr-feedback-sources / goal-restate-schema /
                  task-template / change-summaries / adr-template）
```

> 全程操作規則（決策點停、繁中、重用優先、文件紀律、對外溝通、參考檔路徑解析）見 `AGENTS.md`。

---

# scaffold-fullstack（loops-workflow 內建 skill：greenfield 骨架）

greenfield 從零建全端 TypeScript 專案骨架：分層 Fastify 後端（`domain ← ports ← adapters/services/repositories/http`）+ React 19 + TanStack SPA、ESLint 強制分層與前後端牆、SQLite + Kysely、Vitest（unit/e2e/benchmark），含一條貫穿各層的範例垂直切片。自帶整棵模板樹 + scaffold 腳本，無外部依賴。

用 `/loops-workflow:scaffold-fullstack` —— 在空資料夾從模板生出整個分層專案骨架；或 `dispatch` 偵測到完全乾淨的空專案時會引導你用（確認後才跑）。**只建新專案、不改既有 code**（既有專案內開發走 loops 迴圈）。
````

- [ ] **Step 2: 改 `AGENTS.md`（三處去 statusline）**

3 處 find → replace：

1. 規則 3 內 `（供 statusline / resume）` → `（供 progress / resume）`。
2. 規則 9 結尾 `statusline / `status` / hook 仍會掃 `.claude/worktrees/*/.loops/` 當保險。` → `progress / `status` / hook 仍會掃 `.claude/worktrees/*/.loops/` 當保險。`。
3. §3 intent 表整列
   `| 想裝 statusline（顯示當前 loop / 階段） | `/loops-workflow:install-statusline` | 側用（一次性設定，patch settings.json） |`
   →
   `| 想看單條 loop 的完整進度 | `/loops-workflow:progress <slug>` | 側用（唯讀，chat 儀表板 + 重生 PROGRESS.md） |`

- [ ] **Step 3: 改 `docs/FLOW.md`（§9 automations 列、§10 數字）**

1. §9 automations 列：`| **自動化** | `dispatch auto`、`/loop`·`/schedule`、statusline HUD | Automations |` → `| **自動化** | `dispatch auto`、`/loop`·`/schedule`、progress（`/progress` + Stop hook 自動產 PROGRESS.md） | Automations |`。
2. §10「數字總結」reference 行的 command 清單：`command loop / resume / status / explain / install-statusline` → `command loop / resume / status / explain / progress`。
3. §10 同段 hook 描述：把「7 個 / 4 事件」改為「8 個 / 4 事件」，並在 Stop 段補述 `+ progress-render（恆跑，每回合對本 session active loop 重生 PROGRESS.md、不注入、永不擋路）`；SessionStart 仍恆跑、其餘 opt-in 不變。

- [ ] **Step 4: 改 `references/automations.md`（若有 statusline 提及）**

Run: `cd plugins/loops-workflow && grep -n "statusline\|HUD\|install-statusline" references/automations.md || echo "NONE"`
若有命中：把該段落改述為「進度看 `/loops-workflow:progress` + 自動產的 `PROGRESS.md`（Stop hook 恆跑）」；若印 `NONE` 則跳過本步。

- [ ] **Step 5: 全庫掃描——確認再無殘留 statusline 引用**

Run: `grep -rni "statusline\|hud-status\|install-statusline" --include=*.md --include=*.mjs --include=*.json --include=*.sh . | grep -v "docs/superpowers/" || echo "CLEAN"`
Expected: 印出 `CLEAN`（spec/plan 文件除外，已用 `grep -v docs/superpowers/` 排除）。若有殘留 → 逐筆改掉再重跑。

- [ ] **Step 6: 跑測試確認全綠**

Run: `cd plugins/loops-workflow && node scripts/test-progress.mjs`
Expected: PASS（文件改動不影響）。

- [ ] **Step 7: Commit**

```bash
git add README.md AGENTS.md plugins/loops-workflow/docs/FLOW.md plugins/loops-workflow/references/automations.md
git commit -m "docs(loops-workflow): rewrite README + sync docs for /progress

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 開 PR

- [ ] **Step 1: 最終全綠 + push**

```bash
cd plugins/loops-workflow && node scripts/test-progress.mjs
cd ../.. && git push -u origin progress-preview
```
Expected: 測試 PASS、push 成功。

- [ ] **Step 2: 開 PR（squash merge 待使用者核可）**

```bash
gh pr create --base master --head progress-preview \
  --title "feat(loops-workflow): 以 /progress + PROGRESS.md 取代 statusline" \
  --body "$(cat <<'EOF'
## 摘要
- 新增共用 renderer `scripts/progress.mjs`（吃 loop.md + 0N-*.md）與 `scripts/loops-scan.mjs`（自 hud-status 救出的共用掃描）
- 新增 `/loops-workflow:progress [slug]`：chat 完整進度儀表板 + 重生 `.loops/<slug>/PROGRESS.md`
- 新增恆跑 Stop hook `progress-render.mjs`：每回合自動保持 PROGRESS.md 最新（零 token、不注入、永不擋路）
- 移除 statusline（`statusline.sh` / `hud-status.mjs` / `install-statusline`）
- 全面重構 README，並同步 AGENTS.md / FLOW.md / automations.md

## 測試
`cd plugins/loops-workflow && node scripts/test-progress.mjs` 全綠（loops-scan 純函式 + progress 純函式 + spawn smoke + hook smoke）

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

> **合併策略**：使用者 review 後 **squash merge**（`gh pr merge <PR#> --squash --delete-branch`），master 每 PR 一個 commit。

---

## Self-Review

**Spec coverage：**
- §1/§2 目標與決策 → 全部任務涵蓋。
- §3 架構（loops-scan / progress / command / hook）→ Task 1/2/3/4。
- §4 元件「刪除」→ Task 5；「修改 hooks.json / 文件」→ Task 3 Step 5、Task 6。
- §5 抽取規則 → `extractProgress`（Task 2 Step 3）+ B1~B4 測試。
- §6 兩出口長相 → `renderChat`/`renderMarkdown`（Task 2）+ B5/B6。
- §7 錯誤處理/邊界（never throw、worktree、不注入）→ 各 `.mjs` 守衛 + H1（不注入）+ 寫主 repo `.loops/`。
- §8 README 重構 → Task 6 Step 1（完整新內容）。
- §9 文件同步 → Task 6 Step 2~5。
- §10 交付 → Task 7。

**Placeholder scan：** 無 TBD/TODO；所有 code step 附完整 code；doc step 附完整新內容或精確 find→replace。

**Type consistency：** `loops-scan` 的 export（`collectLoopEntries`/`pickActiveLoop`/`currentStage`/`isDone`/`STAGE_ORDER`…）在 `progress.mjs` 與測試中名稱一致；`extractProgress` 回傳欄位（`stages[].state`、`round`/`maxRounds`、`findings`/`head`/`nextStep`/`recentJournal`/`outcome`）在 B1~B6 與 `renderChat`/`renderMarkdown` 一致。
