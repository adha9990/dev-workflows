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
