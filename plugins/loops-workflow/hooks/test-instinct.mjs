#!/usr/bin/env node
// test-instinct.mjs —— session-start.mjs 的 instinct 注入重構 紅綠斷言
// （自帶極簡 harness，仿同目錄 test-cost-hooks.mjs / test-stop-gate.mjs，不引測試框架）。
//
// 用法（cwd = plugins/loops-workflow）：node hooks/test-instinct.mjs
// 全綠 → exit 0；任一斷言失敗或 import 失敗 → exit 1（主線用此 exit code 判紅綠）。
//
// 預期 Red：本票要把 session-start.mjs 重構成 export 純函式 + 加 instinct 注入。
// session-start.mjs 目前「未 export」parseInstinct / selectInstincts / formatInstinctInjection，
// 下面的具名 import 會在「連結期」就因 "does not provide an export named ..." 拋例外
// （早於模組 body 求值，故不會誤觸 hook 的 main() 副作用）→ 整個檔載入失敗 → node 非 0 退出。
// 這就是 TDD 的紅燈起點。三函式補齊 export（且 main() 以 entry-point 守衛、import 時不執行）後，
// 下方純函式斷言 + smoke 才有機會逐條轉綠。

import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  parseInstinct,
  selectInstincts,
  formatInstinctInjection,
} from './session-start.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'instincts');
const HIGH = join(FIX, 'high.yaml'); // confidence 0.85 + summary
const LOW = join(FIX, 'low.yaml'); // confidence 0.5 + summary
const BROKEN = join(FIX, 'broken.yaml'); // 無 confidence 欄（容錯 → 0）
const SESSION_START_SCRIPT = join(HERE, 'session-start.mjs'); // 真跑的 hook（smoke）

// fixture 內已知文案（DAMP：測試自帶規格，負向斷言才釘得住）。
const HIGH_SUMMARY = 'docs-only verify 派 2 軸即可';
const LOW_SUMMARY = '大型重構派完整測試矩陣';
const BROKEN_SUMMARY = '這條沒有信心欄位僅供測試容錯';

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}
function callSafe(fn) {
  try {
    return { threw: false, val: fn() };
  } catch (e) {
    return { threw: true, err: e };
  }
}

// =============================================================================
// A) parseInstinct(yamlText) → {confidence:number, summary:string}
//    regex 抽 confidence: 後數字（無/非數字→0）、summary: 後整行 trim（無→''）、容錯不丟
// =============================================================================

// ── A1 high.yaml：confidence 0.85 + summary 非空且只取 summary 行（非整檔）─────
{
  const r = callSafe(() => parseInstinct(readFileSync(HIGH, 'utf8')));
  assert(!r.threw, 'parseInstinct(high.yaml)：不丟例外（容錯）[A1]');
  const p = r.val || {};
  assert(p.confidence === 0.85, 'parseInstinct(high.yaml)：confidence === 0.85（抽 confidence: 後數字）[A1]');
  assert(typeof p.summary === 'string' && p.summary.trim().length > 0,
    'parseInstinct(high.yaml)：summary 為非空字串 [A1]');
  assert(typeof p.summary === 'string' && p.summary.includes(HIGH_SUMMARY),
    'parseInstinct(high.yaml)：summary 抽到 summary: 行文案 [A1]');
  // Prove-It：summary 只取「summary: 那一行」，不可是整檔（整檔會含 "confidence"）。
  assert(typeof p.summary === 'string' && !p.summary.includes('confidence'),
    'parseInstinct(high.yaml)：summary 不含 "confidence"（證明只取單行、非整檔）[A1]');
}

// ── A2 low.yaml：confidence 0.5（餵給 selectInstincts 過濾邏輯的真實低信心樣本）──
{
  const p = parseInstinct(readFileSync(LOW, 'utf8'));
  assert(p && p.confidence === 0.5, 'parseInstinct(low.yaml)：confidence === 0.5 [A2]');
  assert(p && typeof p.summary === 'string' && p.summary.includes(LOW_SUMMARY),
    'parseInstinct(low.yaml)：summary 抽到 low 文案 [A2]');
}

// ── A3 broken.yaml：無 confidence 欄 → confidence 0、不丟（容錯）─────────────────
{
  const r = callSafe(() => parseInstinct(readFileSync(BROKEN, 'utf8')));
  assert(!r.threw, 'parseInstinct(broken.yaml)：無 confidence 欄不丟例外 [A3]');
  const p = r.val || {};
  assert(p.confidence === 0, 'parseInstinct(broken.yaml)：無 confidence 欄 → confidence === 0（容錯預設）[A3]');
  assert(typeof p.summary === 'string', 'parseInstinct(broken.yaml)：summary 仍為字串 [A3]');
}

// ── A4 邊界：非數字 confidence→0、summary 後為空→''、完全無欄/空輸入→{0,''}、不丟 ─
{
  const p1 = parseInstinct('confidence: abc\nsummary: ');
  assert(p1.confidence === 0, 'parseInstinct：confidence 非數字（abc）→ 0 [A4]');
  assert(p1.summary === '', 'parseInstinct：summary 後為空 → "" [A4]');

  const p2 = parseInstinct('id: x\nscope: y');
  assert(p2.confidence === 0 && p2.summary === '',
    'parseInstinct：完全無 confidence/summary 欄 → {confidence:0, summary:""} [A4]');

  const r = callSafe(() => parseInstinct(''));
  assert(!r.threw, 'parseInstinct("")：空輸入不丟 [A4]');
  assert(r.val && r.val.confidence === 0 && r.val.summary === '',
    'parseInstinct("")：空輸入 → {confidence:0, summary:""} [A4]');
}

// ── A5 summary 長度上限 200 + confidence clamp 到 [0,1]（縱深防禦：髒/惡意 instinct）─────
{
  // F1：summary 注入長度上限——超長字串被截到 200 字（防爆 context）。
  // Prove-It：若無 .slice(0,200)，length 會是 500，此條會紅。
  const capped = parseInstinct(`summary: ${'x'.repeat(500)}\nconfidence: 0.9`);
  assert(capped.summary.length === 200,
    'parseInstinct：summary 超長（500 字）→ 截到 200 字上限（=== 200）[A5]');
  assert(capped.confidence === 0.9,
    'parseInstinct：cap 情境下 confidence 仍正確抽出 0.9 [A5]');

  // confidence 夾擠到 [0,1]：>1 → 1、<0 → 0、合法小數（科學記號）原值保留。
  assert(parseInstinct('confidence: 1.7\nsummary: s').confidence === 1,
    'parseInstinct：confidence 1.7 → clamp 到上界 1 [A5]');
  assert(parseInstinct('confidence: -0.2\nsummary: s').confidence === 0,
    'parseInstinct：confidence -0.2 → clamp 到下界 0（負值不外洩）[A5]');
  assert(parseInstinct('confidence: 1e-3\nsummary: s').confidence === 0.001,
    'parseInstinct：confidence 1e-3 → 0.001（科學記號完整捕獲、未被截半成假值）[A5]');
}

// ── A6 summary 在非末行、其後另有欄位 → 只取 summary: 那一行（單行非貪婪，不吃後續欄）─────
{
  // F3：先前 fixtures 的 summary 都恰在末行，無法證明「只取單行」；此 case 把 summary 放在
  // 第一行、後面再接 confidence / extra 欄，逼出單行非貪婪行為。
  // Prove-It：若 summary 改用貪婪跨行抽取（如 [\s\S]+），會吃進 'confidence' / '不該出現' → 紅。
  const p = parseInstinct('summary: 第一行\nconfidence: 0.9\nextra: 不該出現');
  assert(p.summary === '第一行',
    'parseInstinct：summary 在非末行時只取該行值（=== "第一行"，非貪婪、非整檔）[A6]');
  assert(!p.summary.includes('不該出現'),
    'parseInstinct：summary 不吞進後續欄位（不含「不該出現」）[A6]');
  assert(p.confidence === 0.9,
    'parseInstinct：summary 在前、confidence 在後，仍正確抽出 0.9 [A6]');
}

// =============================================================================
// B) selectInstincts(parsedList, opts) —— opts 預設 {threshold:0.7, topN:6}
//    過濾 confidence≥threshold、依 confidence 降冪、取前 topN
// =============================================================================

// ── B1 過濾 + 降冪：[0.85, 0.5, 0.9] → [0.9, 0.85]（0.5<0.7 濾掉、降冪）──────────
{
  const out = selectInstincts([
    { confidence: 0.85, summary: 'a' },
    { confidence: 0.5, summary: 'b' },
    { confidence: 0.9, summary: 'c' },
  ]);
  assert(Array.isArray(out), 'selectInstincts：回陣列 [B1]');
  assert(out.length === 2, 'selectInstincts：0.5 < 預設 threshold 0.7 → 濾掉，剩 2 條 [B1]');
  assert(out[0] && out[0].confidence === 0.9 && out[1] && out[1].confidence === 0.85,
    'selectInstincts：依 confidence 降冪（0.9 在 0.85 之前）[B1]');
}

// ── B2 threshold 邊界（≥）：0.7 等於門檻保留、0.69 濾掉 ─────────────────────────
{
  const out = selectInstincts([
    { confidence: 0.7, summary: 'eq' },
    { confidence: 0.69, summary: 'below' },
  ]);
  assert(out.length === 1 && out[0] && out[0].summary === 'eq',
    'selectInstincts：confidence === threshold(0.7) 保留（≥），0.69 濾掉（邊界）[B2]');
}

// ── B3 topN 截斷：8 條皆高信心 → 只回前 6（且回的是 confidence 最高的 6 條）──────
{
  const eight = Array.from({ length: 8 }, (_, i) => ({ confidence: 0.8 + i * 0.001, summary: `s${i}` }));
  const out = selectInstincts(eight);
  assert(out.length === 6, 'selectInstincts：8 條皆 ≥threshold → 取前 topN(預設 6) [B3]');
  const kept = out.map((o) => o.summary);
  assert(!kept.includes('s0') && !kept.includes('s1'),
    'selectInstincts：降冪後截斷 → 最低兩條（s0/s1）被丟（保留最高 6 條）[B3]');
  assert(out.length === 6 && out[0].confidence >= out[5].confidence,
    'selectInstincts：回傳整體仍為降冪 [B3]');
}

// ── B4 opts 覆寫 threshold/topN ──────────────────────────────────────────────
{
  const out = selectInstincts(
    [{ confidence: 0.6, summary: 'x' }, { confidence: 0.4, summary: 'y' }],
    { threshold: 0.5, topN: 1 },
  );
  assert(out.length === 1 && out[0] && out[0].summary === 'x',
    'selectInstincts：opts 覆寫 threshold(0.5)+topN(1) → 只回 0.6 那條 [B4]');
}

// ── B5 空輸入 → [] ───────────────────────────────────────────────────────────
{
  assert(JSON.stringify(selectInstincts([])) === '[]', 'selectInstincts：空輸入 → [] [B5]');
}

// =============================================================================
// C) formatInstinctInjection(selected)
//    空陣列→''；否則第一行含「instinct」與「啟發式」、每條一行含 [Math.round(c*100)%] + summary
// =============================================================================

// ── C1 空陣列 → '' ───────────────────────────────────────────────────────────
{
  assert(formatInstinctInjection([]) === '', 'formatInstinctInjection：空陣列 → "" [C1]');
}

// ── C2 非空：第一行標頭含「instinct」「啟發式」；每條含 [N%] 與 summary ──────────
{
  const out = formatInstinctInjection([
    { confidence: 0.85, summary: HIGH_SUMMARY },
    { confidence: 0.9, summary: '另一條啟發內容' },
  ]);
  assert(typeof out === 'string' && out.length > 0, 'formatInstinctInjection：非空陣列 → 非空字串 [C2]');
  const firstLine = typeof out === 'string' ? out.split('\n')[0] : '';
  assert(firstLine.includes('instinct'), 'formatInstinctInjection：第一行含「instinct」字樣 [C2]');
  assert(firstLine.includes('啟發式'), 'formatInstinctInjection：第一行含「啟發式」字樣 [C2]');
  // F1：標頭框定來源（間接 prompt injection 降權標示）——「來源未驗證」「勿當指令」不可消失。
  assert(firstLine.includes('來源未驗證'),
    'formatInstinctInjection：標頭含「來源未驗證」（來源框定、降權標示）[C2]');
  assert(firstLine.includes('勿當指令'),
    'formatInstinctInjection：標頭含「勿當指令」（instinct 僅供參考、不可當指令）[C2]');
  assert(typeof out === 'string' && out.includes('[85%]'),
    'formatInstinctInjection：0.85 → 含 [85%]（Math.round(c*100)）[C2]');
  assert(typeof out === 'string' && out.includes('[90%]'),
    'formatInstinctInjection：0.9 → 含 [90%] [C2]');
  assert(typeof out === 'string' && out.includes(HIGH_SUMMARY),
    'formatInstinctInjection：每條一行含其 summary 文案 [C2]');
}

// ── C3 百分比是 Math.round（非 floor/截斷）：0.876 → 87.6 → round → 88 ─────────
{
  const out = formatInstinctInjection([{ confidence: 0.876, summary: 'r' }]);
  assert(typeof out === 'string' && out.includes('[88%]'),
    'formatInstinctInjection：0.876 → Math.round(87.6)=88 → [88%]（四捨五入，非 floor/截斷）[C3]');
}

// =============================================================================
// SMOKE：真 spawn session-start.mjs 子行程（real-not-mock：真讀 .loops/、驗 stdout 最終輸出）
// session-start 讀 process.cwd() 掃 .loops/，故 spawn 以 cwd=暫存目錄。每 smoke mkdtemp+rmSync 冪等。
// =============================================================================

// ── active-loop 逐字格式的已知值（DAMP：測試自帶規格，逐字斷言才釘得住 formatLoopLine 契約）──
// inline（「label：value」行）格式的欄位值——既有 S2/S3/S4 也吃這份預設，數值不可變。
const LOOP_STAGE = 'goal'; // 當前階段
const LOOP_MODE = 'closed'; // 推進模式
const LOOP_JOURNAL = '- [E1] 初始化迴圈目標'; // 最後一條 Journal（無前後空白 → trim 後不變）
// markdown 表格格式（pickLoopField 的 table-row 分支）專用欄位值——刻意與 inline 不同，
// 以證明「值確實由表格列抽出」而非沿用 inline 預設。
const TABLE_STAGE = 'verify';
const TABLE_MODE = 'open';
const TABLE_JOURNAL = '- [E1] table 格式初始化迴圈';
// worktree 迴圈的 Journal（與主 repo 迴圈不同，便於逐字辨識來源）。
const WORKTREE_JOURNAL = '- [E2] worktree 迴圈進度';

// loop.md 內容組裝：inline =「label：value」行；table = markdown 表格列。
function inlineLoopMd(slug, journal = LOOP_JOURNAL) {
  return [
    `# ${slug}`,
    '',
    `當前階段：${LOOP_STAGE}`,
    `推進模式：${LOOP_MODE}`,
    '',
    '## Journal',
    journal,
    '',
  ].join('\n');
}
function tableLoopMd(slug) {
  return [
    `# ${slug}`,
    '',
    '| 欄位 | 內容 |',
    '| --- | --- |',
    `| 當前階段 | ${TABLE_STAGE} |`,
    `| 推進模式 | ${TABLE_MODE} |`,
    '',
    '## Journal',
    TABLE_JOURNAL,
    '',
  ].join('\n');
}

// 預期的 per-loop 提醒行（逐字鏡射 session-start.mjs::formatLoopLine，分隔符為全形｜與：）。
function expectedInlineLine(slug, journal = LOOP_JOURNAL) {
  return `  - ${slug}｜階段：${LOOP_STAGE}｜模式：${LOOP_MODE}｜最後：${journal}`;
}
function expectedTableLine(slug) {
  return `  - ${slug}｜階段：${TABLE_STAGE}｜模式：${TABLE_MODE}｜最後：${TABLE_JOURNAL}`;
}
// 預期的 active-loop 區塊標頭（逐字鏡射 formatActiveLoopsHeader，含偵測到的 count）。
function expectedActiveHeader(count) {
  return `[loops-workflow] 偵測到 ${count} 個 active 迴圈（.loops/ 含 worktree）。可用 /loops-workflow:dispatch <slug> 接續、或直接讀 .loops/<slug>/PROGRESS.md 看詳情：`;
}

function makeLoopCwd({
  withLoop = true,
  withInstincts = false,
  slug = 'demo-feature',
  format = 'inline', // 'inline' |「label：value」行；'table' | markdown 表格列
  worktreeLoop = null, // {wt, slug}：額外在 .claude/worktrees/<wt>/.loops/<slug>/ 建迴圈
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'session-start-smoke-'));
  if (withLoop) {
    const loopDir = join(dir, '.loops', slug);
    mkdirSync(loopDir, { recursive: true });
    // 重構特徵測試的已知 active-loop 形狀：當前階段 + 推進模式 + 一行 Journal。
    writeFileSync(
      join(loopDir, 'loop.md'),
      format === 'table' ? tableLoopMd(slug) : inlineLoopMd(slug),
    );
  }
  if (worktreeLoop) {
    // 主 repo 開的 session 也要看得到 worktree 底下在跑的迴圈（collectLoopRoots 的 worktree 分支）。
    const wtLoopDir = join(dir, '.claude', 'worktrees', worktreeLoop.wt, '.loops', worktreeLoop.slug);
    mkdirSync(wtLoopDir, { recursive: true });
    writeFileSync(join(wtLoopDir, 'loop.md'), inlineLoopMd(worktreeLoop.slug, WORKTREE_JOURNAL));
  }
  if (withInstincts) {
    const instDir = join(dir, '.loops', '.instincts');
    mkdirSync(instDir, { recursive: true });
    // 真檔複製（real-not-mock）：用同一份 fixtures 餵 hook，與純函式單元共享真相源。
    copyFileSync(HIGH, join(instDir, 'high.yaml'));
    copyFileSync(LOW, join(instDir, 'low.yaml'));
    copyFileSync(BROKEN, join(instDir, 'broken.yaml'));
  }
  return { dir, slug };
}

function runSessionStart(cwd, extraEnv = {}) {
  const env = { ...process.env };
  delete env.LOOPS_INSTINCT_INJECT; // 確保「未設」情境真未設（不被外層環境污染）
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [SESSION_START_SCRIPT], {
    cwd,
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd }),
    env,
    encoding: 'utf8',
  });
}

const out = (res) => (typeof res.stdout === 'string' ? res.stdout : '');

// ── S1（重構特徵測試）：有 active loop → stdout 仍含「active 迴圈」+ slug（既有行為不可消失）──
{
  const { dir, slug } = makeLoopCwd({ withLoop: true, withInstincts: false, slug: 'feat-active' });
  try {
    const res = runSessionStart(dir); // 不開 instinct 旗標
    assert(res.error == null, 'S1：node 啟動成功（spawn 無 error）[S1]');
    assert(res.status === 0, 'S1：exit 0 [S1]');
    assert(out(res).includes('active 迴圈'),
      'S1：重構後 stdout 仍含「active 迴圈」（既有 active-loop 提醒不可因重構消失）[S1]');
    assert(out(res).includes(slug), 'S1：stdout 含該 active loop 的 slug（feat-active）[S1]');
    // F2-a 逐字特徵：per-loop 行整行逐字釘死（slug｜階段｜模式｜最後 Journal）。
    assert(out(res).includes(expectedInlineLine(slug)),
      'S1：stdout 含完整 per-loop 行「  - feat-active｜階段：goal｜模式：closed｜最後：- [E1] 初始化迴圈目標」（formatLoopLine 逐字）[S1]');
    // F2-a 標頭含偵測到的 count（單一迴圈 → 偵測到 1 個）+ 整行逐字。
    assert(out(res).includes('偵測到 1 個'),
      'S1：active-loop 標頭含「偵測到 1 個」（count 正確）[S1]');
    assert(out(res).includes(expectedActiveHeader(1)),
      'S1：active-loop 標頭整行逐字（formatActiveLoopsHeader(1)）[S1]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── S2（注入開）：LOOPS_INSTINCT_INJECT=1 + .instincts/(high+low+broken) →
//     stdout 含 high 的 [85%]+summary；不含 low(50%<70%) 與 broken(無 conf→0)；active-loop 仍在 ──
{
  const { dir } = makeLoopCwd({ withLoop: true, withInstincts: true, slug: 'feat-inject' });
  try {
    const res = runSessionStart(dir, { LOOPS_INSTINCT_INJECT: '1' });
    assert(res.error == null, 'S2：spawn 無 error [S2]');
    assert(res.status === 0, 'S2：exit 0 [S2]');
    assert(out(res).includes('[85%]'),
      'S2：旗標開 + high(0.85≥0.7) → stdout 含 [85%] 行 [S2]');
    assert(out(res).includes(HIGH_SUMMARY),
      'S2：stdout 含 high 的 summary 文案 [S2]');
    assert(!out(res).includes('[50%]') && !out(res).includes(LOW_SUMMARY),
      'S2：low(0.5<0.7) 被濾掉 → stdout 不含 [50%] 與其 summary [S2]');
    assert(!out(res).includes('[0%]') && !out(res).includes(BROKEN_SUMMARY),
      'S2：broken(無 confidence→0) 被濾掉 → stdout 不含 [0%] 與其 summary [S2]');
    assert(out(res).includes('active 迴圈'),
      'S2：注入開啟時 active-loop 提醒仍在（注入是疊加、非取代）[S2]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── S3（旗標關）：不設 LOOPS_INSTINCT_INJECT（即便 .instincts/ 在）→ 無 instinct 行、active-loop 仍在 ──
{
  const { dir } = makeLoopCwd({ withLoop: true, withInstincts: true, slug: 'feat-off' });
  try {
    const res = runSessionStart(dir); // runSessionStart 已 delete 旗標
    assert(res.status === 0, 'S3：exit 0 [S3]');
    assert(!out(res).includes('[85%]') && !out(res).includes('啟發式'),
      'S3：未設 LOOPS_INSTINCT_INJECT → 無 instinct 注入（不含 [85%] / 不含「啟發式」標頭）[S3]');
    assert(out(res).includes('active 迴圈'),
      'S3：旗標關時 active-loop 提醒仍在 [S3]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── S4（無 .instincts/ 目錄）：旗標開但無 .loops/.instincts/ → 無 instinct 行、不崩、active-loop 仍在 ──
{
  const { dir } = makeLoopCwd({ withLoop: true, withInstincts: false, slug: 'feat-noinst' });
  try {
    const res = runSessionStart(dir, { LOOPS_INSTINCT_INJECT: '1' });
    assert(res.error == null, 'S4：spawn 無 error（無 .instincts/ 不崩在 spawn 層）[S4]');
    assert(res.status === 0, 'S4：無 .loops/.instincts/ → exit 0、不崩 [S4]');
    assert(!out(res).includes('[85%]') && !out(res).includes('啟發式'),
      'S4：旗標開但無 .instincts/ → 無 instinct 行 [S4]');
    assert(out(res).includes('active 迴圈'),
      'S4：active-loop 提醒仍在 [S4]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── S5（worktree 掃描）：主 repo 迴圈 + .claude/worktrees/<wt>/.loops/<slug>/ 迴圈都要被偵測 + 計數 ──
//    守 collectLoopRoots 的 worktree 分支：若該分支不存在，worktree 迴圈消失、count 退回 1 → 紅。
{
  const mainSlug = 'feat-main';
  const wtSlug = 'feat-wt';
  const { dir } = makeLoopCwd({
    withLoop: true,
    slug: mainSlug,
    worktreeLoop: { wt: 'wt-alpha', slug: wtSlug },
  });
  try {
    const res = runSessionStart(dir); // 不開 instinct 旗標，純看 active-loop 掃描
    assert(res.error == null, 'S5：spawn 無 error [S5]');
    assert(res.status === 0, 'S5：exit 0 [S5]');
    assert(out(res).includes(mainSlug),
      'S5：stdout 含主 repo 迴圈 slug（feat-main）[S5]');
    assert(out(res).includes(wtSlug),
      'S5：stdout 含 worktree 迴圈 slug（feat-wt，來自 .claude/worktrees/wt-alpha/.loops）[S5]');
    assert(out(res).includes(expectedInlineLine(wtSlug, WORKTREE_JOURNAL)),
      'S5：worktree 迴圈整行逐字（含其專屬 Journal「- [E2] worktree 迴圈進度」）[S5]');
    assert(out(res).includes('偵測到 2 個'),
      'S5：主 repo + worktree 兩迴圈皆計入 count（標頭「偵測到 2 個」）[S5]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── S6（markdown 表格分支）：欄位以表格列寫 → pickLoopField 的 table-row 正則要抽得出值 ──
//    守 pickLoopField 的 table 分支（既有測試零覆蓋）：loop.md 只用表格列、無「label：value」行，
//    若 table 分支壞掉，inline 正則因無冒號而落空 → 階段值變 '?' → 逐字斷言紅。
{
  const slug = 'feat-table';
  const { dir } = makeLoopCwd({ withLoop: true, slug, format: 'table' });
  try {
    const res = runSessionStart(dir);
    assert(res.error == null, 'S6：spawn 無 error [S6]');
    assert(res.status === 0, 'S6：exit 0 [S6]');
    assert(out(res).includes('階段：verify'),
      'S6：表格列「| 當前階段 | verify |」→ 階段值由 table 分支抽出為 verify（非 "?"）[S6]');
    assert(out(res).includes(expectedTableLine(slug)),
      'S6：表格格式 loop.md 的整行逐字（階段：verify｜模式：open，table 分支）[S6]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 摘要 + exit code ─────────────────────────────────────────────────────────
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
