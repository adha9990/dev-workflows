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
import { extractProgress, renderChat, renderMarkdown } from './progress.mjs';

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
    assert(entries[0].main === true, 'collectLoopEntries：主 repo .loops 的 entry main===true [A5]');
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
    const wtEntry = entries.find((e) => e.slug === 'x-slug');
    assert(wtEntry && wtEntry.main === false, 'collectLoopEntries：worktree 來源 entry main===false [A6]');
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
  assert(pickActiveLoop([e1, e3], '', 1000).slug === 'other',
    'pickActiveLoop：無 sid → 近期活躍取 mtime 最新（other 250 > mine 200）[A7]');
}

// =============================================================================
// B) progress.mjs — 純函式（extractProgress / renderChat / renderMarkdown）
// =============================================================================

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

// ── B7 extractProgress：純數字不被誤判成 HEAD；真 SHA（含字母）仍抓到（Metric-Honesty）──
{
  const md = `| 類型 | issue |\n| 當前階段 | build |\n\n## Journal\n- [E1] 進入 build：估 token 1200000\n- [E2] 於 20260629 推進\n`;
  const p = extractProgress({ slug: 's', dir: '', md, mtime: 1 });
  assert(p.head === '', 'extractProgress：純十進位數字（1200000 / 20260629）不被當 HEAD（head 為空）[B7]');
  const p2 = extractProgress({ slug: 's', dir: '', md: SAMPLE_LOOP_MD, mtime: 1 });
  assert(p2.head === 'a1b2c3d', 'extractProgress：真 SHA（含字母）仍被抓到 head=a1b2c3d [B7]');
}

// =============================================================================
// SMOKE — progress.mjs（真 spawn，驗 stdout / PROGRESS.md / no-op / --write-only）
// =============================================================================
function runProgress(args, cwd, env = {}) {
  return spawnSync(process.execPath, [PROGRESS_SCRIPT, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env },
  });
}

// ── S1：給 slug → 寫出 PROGRESS.md（內容含 mermaid + slug）且 stdout 含儀表板 ──
{
  const cwd = mkdtempSync(join(tmpdir(), 'prog-slug-'));
  try {
    const dir = seedLoop(cwd, '137-trash-delete-permanent', SAMPLE_LOOP_MD);
    const res = runProgress(['137-trash-delete-permanent'], cwd);
    assert(res.status === 0, 'S1：exit 0 [S1]');
    const pmd = join(dir, 'PROGRESS.md');
    assert(existsSync(pmd), 'S1：寫出 .loops/<slug>/PROGRESS.md [S1]');
    const content = readFileSync(pmd, 'utf8');
    assert(content.includes('```mermaid') && content.includes('137-trash-delete-permanent'),
      'S1：PROGRESS.md 內容含 mermaid + slug [S1]');
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

// ── S5：worktree 來源 loop → 不在 worktree 寫 PROGRESS.md（守 AGENTS 規則 9），chat 仍顯示 ──
{
  const cwd = mkdtempSync(join(tmpdir(), 'prog-wt-write-'));
  try {
    const wtLoopDir = join(cwd, '.claude', 'worktrees', 'wt1', '.loops', 'x-slug');
    mkdirSync(wtLoopDir, { recursive: true });
    writeFileSync(join(wtLoopDir, 'loop.md'), SAMPLE_LOOP_MD, 'utf8');
    const res = runProgress(['x-slug'], cwd);
    assert(res.status === 0, 'S5：exit 0 [S5]');
    assert(existsSync(join(wtLoopDir, 'PROGRESS.md')) === false,
      'S5：worktree 來源 loop → 不在 worktree 寫 PROGRESS.md [S5]');
    assert(res.stdout.includes('x-slug'), 'S5：worktree loop 仍能在 chat 顯示 [S5]');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

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

console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
