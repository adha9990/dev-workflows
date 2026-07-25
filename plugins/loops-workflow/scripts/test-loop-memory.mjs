#!/usr/bin/env node
// test-loop-memory.mjs —— #172 loop 記憶體（event ledger）的紅綠斷言。
// 用法：node test-loop-memory.mjs [--filter <case-id>] [--min-cases <n>]
//   --filter T1    只跑 id 為 T1 或以 T1- 開頭的 case（**精確或加連字號前綴**，見下）
//   --min-cases 8  斷言實際跑到的 case 數不得少於 8（沒有這個地板，一個沒寫測試的任務也會 exit 0）
// 全綠且達到 case 地板 → exit 0；任一斷言失敗 / case 數不足 / 模組載入失敗 → exit 1。
//
// ⚠ filter 比對刻意**不用** `c.id.startsWith(f)`（repo 其餘測試的既有寫法）：那會前綴撞號——
//   實測 `test-registry-compiler --filter T1` 會把 `T10-*` 一起選進來、跑了 16 個 case，
//   於是 `--min-cases` 這道地板量到的是別的任務的測試。本檔改為 `id === f || id.startsWith(f + '-')`。
//
// ── 分區 ────────────────────────────────────────────────────────────────────────
// T0：現況 characterization。輸入是 `fixtures/loop-memory/real-loops/` 底下**四條真實 loop.md
//     的逐字快照**（`.loops/` 是 gitignored 且不存在於 worktree，故必須先入版控——見該目錄 README）。
//     逐消費者枚舉、不抽樣。**其中數條鎖的是「現況已知有缺陷」的輸出**（標題會標明）：照實鎖住，
//     後續修它時就是刻意更新期望值，而不是意外破壞。
// T1：契約 1（事件 schema 與 append 寫法）——針對**尚未存在**的 `loop-ledger.mjs`，預期紅。
// T2：契約 1b（replay 兩支 API 與四種損壞的確定性行為）——同上，預期紅。
//
// ── T1／T2 釘死的 API 形狀（`loop-ledger.mjs` 的對外介面）────────────────────────
//   appendEvent(file, { type, payload, id? })
//       -> 實際寫出的事件物件 { v, id, seq, type, payload }；每筆一行 JSON ＋ '\n' 結尾
//   readEvents(file)
//       -> { events, truncatedTail, warnings }   // 行層：解析 ＋ 殘骸尾行的丟棄與回報
//   replayExact(file)   -> state                 // 未知 v / 壞行 ⇒ throw，訊息指名版本號與行號
//   replayPrefix(file)  -> { state, complete, haltedAt: { line, reason, version } | null, duplicates }
//   （契約只寫了 appendEvent／replayExact／replayPrefix 三個名字；`readEvents` 是本測試為了讓
//     「殘骸尾行被丟棄**並回報**」這件事在測試層可觀測而釘的第四支——`replayExact -> state`
//     沒有地方掛這個回報。若 lead 要換形狀，改這裡、不要改斷言的語意。）
//
// 依賴：僅 node 內建。不在 worktree 底下建立或寫入任何 `.loops/`——暫存一律走 os.tmpdir()。

import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  pickLoopField, journalEntries, lastJournalLine, currentStage, isDone,
} from './loops-scan.mjs';
import { extractProgress } from './progress.mjs';
import { readObservedStages } from './eval-trajectory.mjs';
import { parseSessionId, extractOutcomeLine, parseTokenRange, parseSubagentCount } from './baseline-trace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'loop-memory', 'real-loops');
const SESSION_START = join(HERE, '..', 'hooks', 'session-start.mjs');
const LEDGER = join(HERE, 'loop-ledger.mjs');

const SLUGS = [
  '170-policy-component-integration-registries',
  '171-restructure-skills-agents-references',
  '172-loop-memory-event-ledger',
  '183-dual-harness-compat-layer',
];

// ── 極簡 harness ──────────────────────────────────────────────────────────────
let passed = 0;
const failed = [];
const cases = [];

function testCase(id, name, fn) {
  cases.push({ id, name, fn });
}

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${msg}（期望 ${e}；實際 ${a}）`);
}

function parseArgs(argv) {
  const opts = { filter: '', minCases: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--filter') opts.filter = argv[++i] ?? '';
    else if (flag === '--min-cases') opts.minCases = Number(argv[++i] ?? 0);
  }
  return opts;
}

/** 精確比對，或「filter + 連字號」的前綴——`T1` 不得選到 `T10-*`。空 filter → 全選。 */
function selectCases(all, filter) {
  if (!filter) return all;
  return all.filter((c) => c.id === filter || c.id.startsWith(`${filter}-`));
}

async function throwsWith(fn, ...needles) {
  try {
    await fn();
    return { threw: false, message: '(沒有丟例外)', missing: needles };
  } catch (err) {
    const message = String(err?.message ?? err);
    return { threw: true, message, missing: needles.filter((n) => !message.includes(n)) };
  }
}

// ── 共用 helper ───────────────────────────────────────────────────────────────
const fixturePath = (slug) => join(FIXTURES, `${slug}.md`);
const fixtureText = (slug) => readFileSync(fixturePath(slug), 'utf8');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const tmpDirs = [];
function makeTmpDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
function cleanupTmp() {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** `loop-ledger.mjs` 尚未存在時，把載入失敗轉成「這條 case 紅」而不是整支測試崩掉。 */
let ledgerMod = null;
let ledgerErr = null;
async function ledger() {
  if (ledgerMod) return ledgerMod;
  if (ledgerErr) throw new Error(`載入 loop-ledger.mjs 失敗：${ledgerErr}`);
  try {
    ledgerMod = await import(pathToFileURL(LEDGER).href);
  } catch (err) {
    ledgerErr = String(err?.message ?? err);
    throw new Error(`載入 loop-ledger.mjs 失敗：${ledgerErr}`);
  }
  return ledgerMod;
}

/** 直接寫一份 events.jsonl（不經 appendEvent——T2 要能自造壞行、重複 id、未知版本）。 */
function writeStream(dir, name, lines, { trailingNewline = true } = {}) {
  const file = join(dir, name);
  writeFileSync(file, lines.join('\n') + (trailingNewline ? '\n' : ''), 'utf8');
  return file;
}
const evtLine = (e) => JSON.stringify(e);

// ══════════════════════════════════════════════════════════════════════════════
// T0 —— 現況 characterization（輸入＝四條真實 loop.md 的逐字快照）
// ══════════════════════════════════════════════════════════════════════════════

const EXPECTED = {
  '170-policy-component-integration-registries': {
    fields: {
      '類型': 'issue',
      '當前階段': '完工',
      '推進模式': 'auto',
      'session': '78271dcb-8ef0-4ef2-8a67-7f9913544e32',
      'operation': '`new-feature`',
      '停止條件': '',
    },
    sha256: 'f5df34a0b2c36f704f773fae9056101e297f40c3af1d237eb8bbd250bb30c595',
    journalCount: 8,
    journalFirst: '- [E1] dispatch：issue# 明確 → 起點 goal。建 loop.md ＋ worktree @ master 6a6c26a。',
    journalLast: '- [E8] PR #191 開出（pr-gate 依 verify 跳過指示用 LOOPS_PR_GATE=0 逃生口）、CI 雙平台綠、squash merged。issue #170 CLOSED。',
    currentStage: '完工',
    isDone: true,
    progress: {
      type: 'issue',
      operation: '`new-feature`',
      mode: 'auto',
      round: 0,
      maxRounds: 3,
      done: true,
      stopCondition: '',
      stages: 'goal:done,explore:done,plan:done,build:done,verify:done,iterate:done',
      preStages: [],
      findings: '',
      head: '6a6c26a',
      currentTask: '折回：契約 1 補 `requires`/`forbids`/`conflicts_with`/`projection_marker` ＋ P6（fail-closed 必填）/P7（投影標記＝generated drift）/P8（自帶平台中立檢查）；契約 2 補 `required_checks.integrations` ＋ C5；契約 3 補 I5/I6；契約 4 明訂 `ok` 納入 `decisions` 且摘要須渲染。任務 13→16（新增 T0 資料切片提前證偽、T4b generated drift、T12 端到端波及面煙霧），T1–T10 改為各自 `--filter` ＋ `--min-cases` 地板（原本 10 個任務共用同一條指令，無法證明該任務的測試存在），T11 由「零 finding」改為**可證偽的覆蓋率地板 ＋ 變異斷言**。',
      nextStep: '完工',
      outcome: '- ★[outcome] 完工 ｜ token≈?(高)est ｜ sub-agent 5 ｜ 回環 0 圈（verify 依指示跳過）｜ findings 6→0（設計審查）｜ 交付：PR #191 merged',
      recentJournalIds: ['E4', 'E5', 'E6', 'E7', 'E8'],
    },
    observedStages: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e6a', 'e7', 'e8'],
    baseline: {
      sessionId: null,
      outcomeLine: '- ★[outcome] 完工 ｜ token≈?(高)est ｜ sub-agent 5 ｜ 回環 0 圈（verify 依指示跳過）｜ findings 6→0（設計審查）｜ 交付：PR #191 merged',
      tokenRange: null,
      subagentCount: 5,
    },
  },
  '171-restructure-skills-agents-references': {
    fields: {
      '類型': 'issue ｜ **operation** `refactor`（既有行為不得變）',
      '當前階段': '完工',
      '推進模式': 'auto（跳過 verify，使用者指示）',
      'session': '',
      'operation': '',
      '停止條件': '',
    },
    sha256: '7cdd173eb5f4159aa56bb6a5343993311d2884cedfbcbb5c6271396867cc4163',
    journalCount: 15,
    journalFirst: '- [E1] dispatch → goal：現況實測 305 處硬編引用／71 檔；skills 11／agents 25／references 74；component-registry 現有覆蓋僅 reference 7／skill 3／agent 2，遠未全覆蓋。',
    journalLast: '- [E15] PR #192 squash merged，issue #171 CLOSED。',
    currentStage: '完工',
    isDone: true,
    progress: {
      type: 'issue ｜ **operation** `refactor`（既有行為不得變）',
      operation: '',
      mode: 'auto（跳過 verify，使用者指示）',
      round: 0,
      maxRounds: 3,
      done: true,
      stopCondition: '',
      stages: 'goal:done,explore:done,plan:done,build:done,verify:done,iterate:done',
      preStages: [],
      findings: '',
      head: '680293c',
      currentTask: 'T7/T8 搬檔 99 檔（git mv）＋14 類路徑常數同步。lint-mutation 仍 13/13、掃描面只增不減。agent 正確回 BLOCKED（T8/T9 在「綠」的層次不可分割，是我的任務切分問題），裁決併入同輪。',
      nextStep: '完工',
      outcome: '- ★[outcome] 完工 ｜ token≈?(高)est ｜ sub-agent 7 ｜ 回環 0 圈（verify 依指示跳過）｜ findings 8→0（設計審查）｜ 交付：PR #192 merged',
      recentJournalIds: ['E11', 'E12', 'E13', 'E14', 'E15'],
    },
    observedStages: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9', 'e10', 'e11', 'e12', 'e13', 'e14', 'e15'],
    baseline: {
      sessionId: null,
      outcomeLine: '- ★[outcome] 完工 ｜ token≈?(高)est ｜ sub-agent 7 ｜ 回環 0 圈（verify 依指示跳過）｜ findings 8→0（設計審查）｜ 交付：PR #192 merged',
      tokenRange: null,
      subagentCount: 7,
    },
  },
  '172-loop-memory-event-ledger': {
    fields: {
      '類型': 'issue ｜ **operation** `new-feature`',
      '當前階段': 'build',
      '推進模式': 'auto（跳過 verify；本 repo 已無 CI；本機測試掃描暫停至全部 issue 完成）',
      'session': '',
      'operation': '',
      '停止條件': '',
    },
    sha256: '03ff1820f574dccdcec7204c7f77f8c4d855a3df35af76bb565beeae20324036',
    journalCount: 14,
    journalFirst: '- [E1] dispatch → 可行性實測（見上表）。三個既有 loop（170／171／183）＋一份 trace 是遷移驗證素材。',
    journalLast: '- [E14] `events.jsonl` 的成長界線原本一個字都沒寫，而 repo 另外三份 jsonl 都有 1000 行 cap、且用的是自承「**非原子 read→rewrite**」的輪替——照抄會把中段損壞從「實測 0 次」變成「必然發生」，而 E1 只檢查尾行完全偵測不到 ⇒ 明訂 **事件流永不輪替**並禁止照抄。',
    currentStage: 'build',
    isDone: false,
    progress: {
      type: 'issue ｜ **operation** `new-feature`',
      operation: '',
      mode: 'auto（跳過 verify；本 repo 已無 CI；本機測試掃描暫停至全部 issue 完成）',
      round: 0,
      maxRounds: 3,
      done: false,
      stopCondition: '',
      stages: 'goal:done,explore:done,plan:done,build:now,verify:pending,iterate:pending',
      preStages: [],
      findings: '',
      head: '',
      currentTask: '設計審查三軸回報，共 **17 條 must-fix**，全數採納並折回計畫（任務 10 → **16**）。**Lead 自己被打臉一條**：E4① 錯誤——`--filter`／`--min-cases` **是**既有慣例（4 支測試實作、地板未達成真的 exit 1、出處是 #170「10 個任務共用一條指令無法證明該任務的測試存在」），已改回並補上前綴撞號修正（實測 `--filter T1` 會跑到 16 個 case，把 T10+ 算進來）。',
      nextStep: 'verify',
      outcome: '',
      recentJournalIds: ['E10', 'E11', 'E12', 'E13', 'E14'],
    },
    observedStages: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9', 'e10', 'e11', 'e12', 'e13', 'e14'],
    baseline: {
      sessionId: null,
      outcomeLine: null,
      tokenRange: null,
      subagentCount: null,
    },
  },
  '183-dual-harness-compat-layer': {
    fields: {
      '類型': 'issue',
      '當前階段': '完工',
      '推進模式': 'auto',
      'session': '14b1162e-fb0a-4878-b9d3-4cd7a344ee0c',
      'operation': '`new-feature`（拿不準向嚴取；詳見下方註記）',
      '停止條件': '',
    },
    sha256: '7579ce898b8d6071938032949b14b99ae8bc0696e748d6f94c013dd8089d2bf4',
    journalCount: 24,
    journalFirst: '- [E1] dispatch：輸入 `183`，`.loops/` 不存在 → 非 resume。判類型＝issue 號、意圖明確 → 跳過 clarify、起點 goal。專案非空 → 不 scaffold。',
    journalLast: '- [E24] PR #190 squash merged（`6a6c26a2`），issue #183 自動關閉。worktree 已清。',
    currentStage: '完工',
    isDone: true,
    progress: {
      type: 'issue',
      operation: '`new-feature`（拿不準向嚴取；詳見下方註記）',
      mode: 'auto',
      round: 0,
      maxRounds: 3,
      done: true,
      stopCondition: '',
      stages: 'goal:done,explore:done,plan:done,build:done,verify:done,iterate:done',
      preStages: [],
      findings: '',
      head: '6a6c26a2',
      currentTask: 'build 完成：33/33 任務，145 檔 +10931/-395。合併態主線親跑 gate：47 支測試 0 fail、CI 的 8 個 step 本機逐一 exit 0、compat-lint 全庫由 152 筆清到 0、`.claude-plugin` 相對 master 零 diff（`--quiet` 斷言）。',
      nextStep: '完工',
      outcome: '- ★[outcome] 完工 ｜ token≈?(高)est ｜ sub-agent 27 ｜ 回環 0 圈（verify 依使用者指示跳過）｜ findings — ｜ 交付：PR #190 merged',
      recentJournalIds: ['E20', 'E21', 'E22', 'E23', 'E24'],
    },
    observedStages: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8a', 'e8', 'e9', 'e10', 'e11', 'e12', 'e13', 'e14', 'e15', 'e16', 'e17', 'e17a', 'e18', 'e19', 'e20', 'e21', 'e22', 'e23', 'e24'],
    baseline: {
      sessionId: null,
      outcomeLine: '- ★[outcome] 完工 ｜ token≈?(高)est ｜ sub-agent 27 ｜ 回環 0 圈（verify 依使用者指示跳過）｜ findings — ｜ 交付：PR #190 merged',
      tokenRange: null,
      subagentCount: 27,
    },
  },
};

// session-start hook 對這四條的**逐字**輸出（該 hook 的解析器是私有副本，只能從 stdout 觀測）。
const SESSION_START_HEADER =
  '[loops-workflow] 偵測到 4 個 active 迴圈（.loops/ 含 worktree）。可用 /loops-workflow:dispatch <slug> 接續、或直接讀 .loops/<slug>/PROGRESS.md 看詳情：';
const SESSION_START_LINES = [
  '  - 170-policy-component-integration-registries｜階段：完工｜模式：auto｜最後：- [E8] PR #191 開出（pr-gate 依 verify 跳過指示用 LOOPS_PR_GATE=0 逃生口）、CI 雙平台綠、squash merged。issue #170 CLOSED。',
  '  - 171-restructure-skills-agents-references｜階段：完工｜模式：auto（跳過 verify，使用者指示）｜最後：- [E15] PR #192 squash merged，issue #171 CLOSED。',
  '  - 172-loop-memory-event-ledger｜階段：build｜模式：auto（跳過 verify；本 repo 已無 CI；本機測試掃描暫停至全部 issue 完成）｜最後：- [E14] `events.jsonl` 的成長界線原本一個字都沒寫，而 repo 另外三份 jsonl 都有 1000 行 cap、且用的是自承「**非原子 read→rewrite**」的輪替——照抄會把中段損壞從「實測 0 次」變成「必然發生」，而 E1 只檢查尾行完全偵測不到 ⇒ 明訂 **事件流永不輪替**並禁止照抄。',
  '  - 183-dual-harness-compat-layer｜階段：完工｜模式：auto｜最後：- [E24] PR #190 squash merged（`6a6c26a2`），issue #183 自動關閉。worktree 已清。',
];

/** 把四條 fixture 擺進一個 tmp cwd 的 .loops/ 底下（**不是** worktree），供 spawn session-start。 */
function stageLoopsInTmp() {
  const dir = makeTmpDir('lm-ss-');
  for (const slug of SLUGS) {
    mkdirSync(join(dir, '.loops', slug), { recursive: true });
    writeFileSync(join(dir, '.loops', slug, 'loop.md'), readFileSync(fixturePath(slug)));
  }
  return dir;
}

testCase('T0-1', 'loops-scan.pickLoopField —— 四條真實 loop.md × 六個欄位【現況已知有缺陷：171／172 的「類型」抽出整串垃圾（類型與 operation 被塞進同一個表格格子），同一根因讓 operation 對這兩條抽不到；session 對這兩條也是空】', () => {
  for (const slug of SLUGS) {
    const md = fixtureText(slug);
    for (const [label, value] of Object.entries(EXPECTED[slug].fields)) {
      eq(pickLoopField(md, label), value, `${slug}｜pickLoopField('${label}')`);
    }
  }
});

testCase('T0-2', 'loops-scan.journalEntries —— 條目數與首尾條目逐字', () => {
  for (const slug of SLUGS) {
    const je = journalEntries(fixtureText(slug));
    const x = EXPECTED[slug];
    eq(je.length, x.journalCount, `${slug}｜journalEntries 條目數`);
    eq(je[0], x.journalFirst, `${slug}｜第一條 Journal 逐字`);
    eq(je[je.length - 1], x.journalLast, `${slug}｜最後一條 Journal 逐字`);
    assert(je.every((l) => /^-\s*\[E\d+\]/.test(l)), `${slug}｜每一條都符合 live 格式 - [E<n>]`);
  }
});

testCase('T0-3', 'loops-scan.currentStage / isDone —— 含唯一一條進行中的 loop', () => {
  for (const slug of SLUGS) {
    const md = fixtureText(slug);
    eq(currentStage(md), EXPECTED[slug].currentStage, `${slug}｜currentStage`);
    eq(isDone(currentStage(md)), EXPECTED[slug].isDone, `${slug}｜isDone`);
  }
  const inProgress = SLUGS.filter((s) => !EXPECTED[s].isDone);
  eq(inProgress, ['172-loop-memory-event-ledger'], '四條裡恰好一條未完工（唯一的進行中形態）');
});

testCase('T0-4', 'loops-scan.lastJournalLine —— 逐字，且等於 journalEntries 的最後一條', () => {
  for (const slug of SLUGS) {
    const md = fixtureText(slug);
    eq(lastJournalLine(md), EXPECTED[slug].journalLast, `${slug}｜lastJournalLine 逐字`);
    eq(lastJournalLine(md), journalEntries(md).at(-1), `${slug}｜lastJournalLine === journalEntries 最後一條`);
  }
});

testCase('T0-5', 'progress.extractProgress —— 表頭欄位（type / operation / mode / stopCondition / done）【現況已知有缺陷：停止條件四條全空】', () => {
  for (const slug of SLUGS) {
    const p = extractProgress({ slug, md: fixtureText(slug) });
    const x = EXPECTED[slug].progress;
    eq(p.slug, slug, `${slug}｜slug`);
    eq(p.type, x.type, `${slug}｜type`);
    eq(p.operation, x.operation, `${slug}｜operation`);
    eq(p.mode, x.mode, `${slug}｜mode`);
    eq(p.stopCondition, x.stopCondition, `${slug}｜stopCondition`);
    eq(p.done, x.done, `${slug}｜done`);
    eq(p.maxRounds, x.maxRounds, `${slug}｜maxRounds`);
  }
  assert(SLUGS.every((s) => EXPECTED[s].progress.stopCondition === ''), '停止條件：四條真實 loop 全抓不到（現況，計畫決策 5 已記載）');
});

testCase('T0-6', 'progress.extractProgress —— stages / preStages / nextStep', () => {
  for (const slug of SLUGS) {
    const p = extractProgress({ slug, md: fixtureText(slug) });
    const x = EXPECTED[slug].progress;
    eq(p.stages.map((s) => `${s.name}:${s.state}`).join(','), x.stages, `${slug}｜stages`);
    eq(p.preStages, x.preStages, `${slug}｜preStages`);
    eq(p.nextStep, x.nextStep, `${slug}｜nextStep`);
  }
});

testCase('T0-7', 'progress.extractProgress —— head（由後往前掃全 Journal 的 commit SHA）【現況已知有缺陷：會撈到別條 loop 的 commit——170 的 head 抽成 6a6c26a，那是 #183 的交付 merge commit（PR #190），只因為出現在 170 的 Journal 文字裡就被撈走；170 自己的交付是 PR #191】', () => {
  for (const slug of SLUGS) {
    const p = extractProgress({ slug, md: fixtureText(slug) });
    eq(p.head, EXPECTED[slug].progress.head, `${slug}｜head`);
  }
});

testCase('T0-8', 'progress.extractProgress —— round / findings【現況已知有缺陷：四條恆 0 與空字串】', () => {
  for (const slug of SLUGS) {
    const p = extractProgress({ slug, md: fixtureText(slug) });
    eq(p.round, EXPECTED[slug].progress.round, `${slug}｜round【現況已知有缺陷】`);
    eq(p.findings, EXPECTED[slug].progress.findings, `${slug}｜findings【現況已知有缺陷】`);
  }
  // 為什麼是缺陷：`回環 N 圈`／`findings X→Y` 只寫在 ★[outcome] 那行，而該行不符 /^-\s*\[E\d+\]/、
  // 根本不進 journalEntries() ⇒ 這兩個欄位從未在真實資料上生效過。修好它時本 case 會轉紅。
  for (const slug of SLUGS) {
    const md = fixtureText(slug);
    const outcome = EXPECTED[slug].baseline.outcomeLine;
    if (!outcome) continue;
    assert(/回環\s*\d+\s*圈/.test(outcome), `${slug}｜★[outcome] 行裡確實有圈數字樣`);
    assert(!journalEntries(md).some((j) => /回環/.test(j)), `${slug}｜但 journalEntries 裡一條都沒有「回環」⇒ round 恆 0`);
  }
});

testCase('T0-9', 'progress.extractProgress —— currentTask / outcome / recentJournal', () => {
  for (const slug of SLUGS) {
    const md = fixtureText(slug);
    const p = extractProgress({ slug, md });
    const x = EXPECTED[slug].progress;
    eq(p.currentTask, x.currentTask, `${slug}｜currentTask 逐字`);
    eq(p.outcome, x.outcome, `${slug}｜outcome 逐字`);
    eq(p.recentJournal.map((j) => j.split(' ')[0]), x.recentJournalIds, `${slug}｜recentJournal 的事件 id 序列`);
    // 關係式斷言：recentJournal ＝ Journal 最後 5 條、事件標記由 `- [E<n>]` 改寫成 `E<n> `
    const derived = journalEntries(md).slice(-5).map((l) => {
      const m = l.match(/^-\s*\[(E\d+)\]\s*(.*)$/);
      return m ? `${m[1]} ${m[2].trim()}` : l;
    });
    eq(p.recentJournal, derived, `${slug}｜recentJournal 內容 === Journal 最後 5 條（改寫標記後）`);
  }
});

testCase('T0-10', 'session-start.mjs 的私有解析器 —— 四條真實 loop 的提醒行逐字', () => {
  const dir = stageLoopsInTmp();
  const r = spawnSync(process.execPath, [SESSION_START], { cwd: dir, encoding: 'utf8' });
  assert(r.status === 0, `session-start 必須 exit 0（實際：${r.status}，stderr：${r.stderr}）`);
  const lines = r.stdout.split('\n').filter((l) => l !== '');
  eq(lines[0], SESSION_START_HEADER, 'session-start 標頭行逐字');
  eq(lines.slice(1).sort(), [...SESSION_START_LINES].sort(), 'session-start 四條提醒行逐字（不依賴目錄列舉順序）');
  eq(lines.length, 5, 'session-start 恰好印 1 行標頭 ＋ 4 行提醒');
});

testCase('T0-11', 'session-start.mjs 的私有解析器 —— 無該欄回 "?"（loops-scan 回 ""）', () => {
  const dir = makeTmpDir('lm-ss2-');
  const slug = 'synthetic-no-mode';
  const md = ['# loop', '', '| 欄 | 值 |', '|---|---|', '| **當前階段** | build |', '', '## Journal', '- [E1] 起手。', ''].join('\n');
  mkdirSync(join(dir, '.loops', slug), { recursive: true });
  writeFileSync(join(dir, '.loops', slug, 'loop.md'), md, 'utf8');

  const r = spawnSync(process.execPath, [SESSION_START], { cwd: dir, encoding: 'utf8' });
  assert(r.stdout.includes('｜模式：?｜'), `session-start 對缺欄回 "?"（實際 stdout：${JSON.stringify(r.stdout)}）`);
  eq(pickLoopField(md, '推進模式'), '', 'loops-scan.pickLoopField 對同一份輸入回空字串（兩份解析器的行為差）');
  eq(extractProgress({ slug, md }).mode, '', 'extractProgress.mode 亦為空字串（沿用 loops-scan 那份）');
});

testCase('T0-12', 'session-start.mjs 的私有解析器 —— 200 字元 cap 對四條真實資料全未觸發', () => {
  const MARKER = '…（截斷；完整 Journal 見該 loop.md）';
  for (const slug of SLUGS) {
    const last = EXPECTED[slug].journalLast;
    assert(last.length <= 200, `${slug}｜最後一條 Journal 長度 ${last.length} ≤ 200（cap 不觸發）`);
  }
  const dir = stageLoopsInTmp();
  const r = spawnSync(process.execPath, [SESSION_START], { cwd: dir, encoding: 'utf8' });
  assert(!r.stdout.includes(MARKER), '四條真實 loop 的 stdout 不含截斷記號（cap 在真實資料上是死碼）');
});

testCase('T0-13', 'eval-trajectory.readObservedStages【現況已知有缺陷：抽出的是事件 id、不是階段名】', () => {
  const LIFECYCLE = new Set(['goal', 'explore', 'plan', 'build', 'verify', 'iterate', 'clarify', 'scaffold', 'define', 'dispatch']);
  for (const slug of SLUGS) {
    const observed = readObservedStages(fixturePath(slug));
    eq(observed, EXPECTED[slug].observedStages, `${slug}｜readObservedStages【現況已知有缺陷】`);
    assert(observed.every((s) => /^e\d+[a-z]?$/.test(s)), `${slug}｜抽出的每一項都是 e<n> 形狀的事件 id`);
    assert(observed.every((s) => !LIFECYCLE.has(s)), `${slug}｜沒有任何一項是真實 lifecycle 階段名【缺陷本體】`);
  }
});

testCase('T0-14', 'baseline-trace.parseSessionId【現況已知有缺陷：四條全 null，真檔用表格豎線】', () => {
  for (const slug of SLUGS) {
    const md = fixtureText(slug);
    eq(parseSessionId(md), EXPECTED[slug].baseline.sessionId, `${slug}｜parseSessionId【現況已知有缺陷】`);
  }
  // 缺陷本體：170／183 的 loop.md 明明有 session uuid（loops-scan 抓得到），baseline-trace 卻抓不到
  // ——它要 `**session**：<uuid>` 的冒號形式，真檔是 markdown 表格的豎線形式。
  for (const slug of ['170-policy-component-integration-registries', '183-dual-harness-compat-layer']) {
    const md = fixtureText(slug);
    assert(/^[0-9a-f-]{36}$/.test(pickLoopField(md, 'session')), `${slug}｜loops-scan 抓得到 session uuid`);
    assert(parseSessionId(md) === null, `${slug}｜baseline-trace 對同一份輸入回 null【缺陷本體】`);
  }
});

testCase('T0-15', 'baseline-trace 的 outcome 抽取（extractOutcomeLine / parseTokenRange / parseSubagentCount）', () => {
  for (const slug of SLUGS) {
    const md = fixtureText(slug);
    const x = EXPECTED[slug].baseline;
    const line = extractOutcomeLine(md);
    eq(line, x.outcomeLine, `${slug}｜extractOutcomeLine 逐字`);
    eq(parseTokenRange(line ?? ''), x.tokenRange, `${slug}｜parseTokenRange（四條的 token 級距皆寫成 ?(高)est ⇒ 解不出）`);
    eq(parseSubagentCount(line ?? ''), x.subagentCount, `${slug}｜parseSubagentCount`);
  }
  assert(EXPECTED['172-loop-memory-event-ledger'].baseline.outcomeLine === null, '唯一進行中的 172 沒有 ★[outcome] 行 ⇒ 降級態全 not_measured');
});

testCase('T0-16', '鑑別力：Journal 含「回環 #2」且超出保留視窗 ⇒ round 仍須為 2', () => {
  // 現有三個 characterization fixture 的期望值都是「圈 0/3」，對圈數零鑑別力——
  // 把整段 round 推導刪掉照樣全綠。本 case 專門讓「Journal 被截短導致圈數靜默倒退成 0」先能被抓到。
  const md = [
    '# loop', '',
    '| 欄 | 值 |', '|---|---|',
    '| **類型** | issue |',
    '| **當前階段** | iterate |',
    '| **推進模式** | auto |', '',
    '## Journal', '',
    '- [E1] dispatch → goal。',
    '- [E2] 回環 #2：verify 回 P1 兩條，折回 build。',
    '- [E3] build：修 P1-a。',
    '- [E4] build：修 P1-b。',
    '- [E5] verify：重審。',
    '- [E6] iterate：收斂。',
    '- [E7] iterate：任務 T9 完成。',
    '- [E8] iterate：等待 PR 回饋。',
    '',
  ].join('\n');
  const p = extractProgress({ slug: 'synthetic-round-2', md });
  eq(journalEntries(md).length, 8, 'Journal 長度 8 條（> 保留視窗 5）');
  eq(p.round, 2, '回環 #2 在保留視窗之外，round 仍須為 2（截短 Journal 會讓這裡靜默倒退成 0）');
  eq(p.recentJournal.map((j) => j.split(' ')[0]), ['E4', 'E5', 'E6', 'E7', 'E8'], 'recentJournal 只留最後 5 條');
  assert(!p.recentJournal.some((j) => j.includes('回環')), '「回環 #2」確實已被保留視窗切掉 ⇒ 本 case 對「只看最後 N 條」的實作有鑑別力');
});

testCase('T0-17', 'fixture 完整性：四條逐字快照的 sha256 未漂移', () => {
  for (const slug of SLUGS) {
    eq(sha256(readFileSync(fixturePath(slug))), EXPECTED[slug].sha256, `${slug}｜fixture sha256`);
  }
});

// README 表格列：`| \`<檔名>.md\` | \`<來源>\` | <bytes> | \`<sha256>\` |`
const README_ROW_RE = /^\|\s*`([^`]+\.md)`\s*\|[^|]*\|\s*(\d+)\s*\|\s*`([0-9a-fA-F]+)`\s*\|/;

testCase('T0-README-SELFCHECK', 'fixtures README 的 bytes／sha256 表格必須與磁碟實況相符', () => {
  // 這條把「手打的文件」變成「被檢查的文件」——本表曾有一列被手打成 65 個十六進位字元
  // （sha256 恆為 64），在比對任何內容之前就已經是假的，而人眼比對 64 個字元抓不到。
  const readmePath = join(FIXTURES, 'README.md');
  const rows = readFileSync(readmePath, 'utf8')
    .split('\n')
    .map((l) => README_ROW_RE.exec(l.trim()))
    .filter(Boolean)
    .map((m) => ({ name: m[1], bytes: Number(m[2]), sha256: m[3] }));

  eq(rows.map((r) => r.name).sort(), SLUGS.map((s) => `${s}.md`).sort(),
    'README 表格必須恰好列出四條 fixture（少列一行不得當成通過）');

  for (const row of rows) {
    const buf = readFileSync(join(FIXTURES, row.name));
    assert(row.sha256.length === 64,
      `${row.name}｜README 宣告的 sha256 必須是 64 個十六進位字元（實際 ${row.sha256.length} 個：${row.sha256}）`);
    assert(row.bytes === buf.length,
      `${row.name}｜bytes 對帳（README 宣告 ${row.bytes}；磁碟實際 ${buf.length}）`);
    const actual = sha256(buf);
    assert(row.sha256.toLowerCase() === actual,
      `${row.name}｜sha256 對帳（README 宣告 ${row.sha256}；磁碟實際 ${actual}）`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// T1 —— 契約 1：事件 schema 與 append 寫法（loop-ledger.mjs 尚未存在 ⇒ 預期紅）
// ══════════════════════════════════════════════════════════════════════════════

testCase('T1-1', 'appendEvent：每筆一行 JSON ＋ 換行結尾，無多餘空行', async () => {
  const { appendEvent } = await ledger();
  const dir = makeTmpDir('lm-t1-');
  const file = join(dir, 'events.jsonl');
  appendEvent(file, { type: 'stage-enter', payload: { stage: 'goal' } });
  appendEvent(file, { type: 'decision', payload: { id: 'D1', status: 'pending' } });
  appendEvent(file, { type: 'gate', payload: { id: 'G1', state: 'open' } });

  const raw = readFileSync(file, 'utf8');
  assert(raw.endsWith('\n'), '檔案以換行結尾（尾行完整）');
  const lines = raw.split('\n');
  eq(lines.at(-1), '', '最後一個 split 片段為空 ⇒ 沒有殘留半行');
  const body = lines.slice(0, -1);
  eq(body.length, 3, 'append 三筆 ⇒ 三行');
  assert(body.every((l) => l.trim() !== '' && !l.includes('\r')), '沒有空行、沒有 CR');
  assert(body.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), '每一行單獨都是合法 JSON');
  eq(body.map((l) => JSON.parse(l).type), ['stage-enter', 'decision', 'gate'], '行序 === append 順序');
});

testCase('T1-2', 'appendEvent：回傳實際寫出的事件，schema 為 { v, id, seq, type, payload } 且 v === 1', async () => {
  const { appendEvent } = await ledger();
  const dir = makeTmpDir('lm-t1-');
  const file = join(dir, 'events.jsonl');
  const e = appendEvent(file, { type: 'task', payload: { taskId: 'T1' } });
  eq(Object.keys(e).sort(), ['id', 'payload', 'seq', 'type', 'v'], 'appendEvent 回傳的欄位集合');
  eq(e.v, 1, 'schema 版本 v === 1');
  assert(typeof e.id === 'string' && e.id.length > 0, `id 為非空字串（實際：${JSON.stringify(e.id)}）`);
  assert(Number.isInteger(e.seq), `seq 為整數（實際：${JSON.stringify(e.seq)}）`);
  eq(JSON.parse(readFileSync(file, 'utf8').trim()), e, '寫進檔案的內容 === appendEvent 的回傳值');
});

testCase('T1-3', '尾行無換行 ⇒ 讀取時視為殘骸丟棄，且**回報**這件事（不是只看結果）', async () => {
  const { readEvents } = await ledger();
  const dir = makeTmpDir('lm-t1-');
  const file = join(dir, 'events.jsonl');
  const good = [
    { v: 1, id: 'e1', seq: 1, type: 'stage-enter', payload: { stage: 'goal' } },
    { v: 1, id: 'e2', seq: 2, type: 'stage-enter', payload: { stage: 'plan' } },
  ];
  writeFileSync(file, good.map(evtLine).join('\n') + '\n', 'utf8');
  appendFileSync(file, '{"v":1,"id":"e3","seq":3,"type":"stage-en'); // 寫到一半就中斷

  const r = readEvents(file);
  eq(r.events.length, 2, '前面的事件完好（殘骸尾行被丟棄）');
  eq(r.events.map((e) => e.id), ['e1', 'e2'], '保留下來的是完整的兩筆');
  eq(r.truncatedTail, true, 'truncatedTail 必須為 true —— 丟棄要**被回報**，不得靜默');
  assert(Array.isArray(r.warnings) && r.warnings.some((w) => /尾行|truncat/i.test(String(w))),
    `warnings 要有一條講明尾行被丟棄（實際：${JSON.stringify(r?.warnings)}）`);

  const clean = readEvents(writeStream(makeTmpDir('lm-t1-'), 'events.jsonl', good.map(evtLine)));
  eq(clean.truncatedTail, false, '反向：尾行完整時 truncatedTail 必須是 false（防「永遠回報截斷」的實作）');
});

testCase('T1-4', 'decision 型事件 payload 必含 status；缺了 appendEvent 要拒絕並指名', async () => {
  const { appendEvent } = await ledger();
  const dir = makeTmpDir('lm-t1-');
  const file = join(dir, 'events.jsonl');

  const bad = await throwsWith(() => appendEvent(file, { type: 'decision', payload: { id: 'D1' } }), 'status');
  assert(bad.threw, `decision 缺 status 必須丟例外（實際：${bad.message}）`);
  eq(bad.missing, [], `例外訊息要指名 status（實際：${bad.message}）`);

  for (const status of ['pending', 'decided']) {
    const ok = appendEvent(file, { type: 'decision', payload: { id: `D-${status}`, status } });
    eq(ok.payload.status, status, `status='${status}' 是合法值`);
  }
  const wrong = await throwsWith(() => appendEvent(file, { type: 'decision', payload: { id: 'D2', status: 'maybe' } }), 'status');
  assert(wrong.threw, `status 不在 { pending, decided } 內必須丟例外（實際：${wrong.message}）`);
});

testCase('T1-5', 'appendEvent 必要欄位：缺 type 或 payload 非物件 ⇒ 拒絕並指名該欄位', async () => {
  const { appendEvent } = await ledger();
  const dir = makeTmpDir('lm-t1-');
  const file = join(dir, 'events.jsonl');

  const noType = await throwsWith(() => appendEvent(file, { payload: {} }), 'type');
  assert(noType.threw && noType.missing.length === 0, `缺 type 要丟例外並指名 type（實際：${noType.message}）`);

  const noPayload = await throwsWith(() => appendEvent(file, { type: 'task' }), 'payload');
  assert(noPayload.threw && noPayload.missing.length === 0, `缺 payload 要丟例外並指名 payload（實際：${noPayload.message}）`);

  const badPayload = await throwsWith(() => appendEvent(file, { type: 'task', payload: 'not-an-object' }), 'payload');
  assert(badPayload.threw && badPayload.missing.length === 0, `payload 非物件要丟例外並指名 payload（實際：${badPayload.message}）`);

  assert(!existsOrEmpty(file), '被拒絕的 append 一個位元組都不得寫進事件流');
});

testCase('T1-6', 'seq 只保證單調不減、不保證唯一', async () => {
  const { appendEvent } = await ledger();
  const dir = makeTmpDir('lm-t1-');
  const file = join(dir, 'events.jsonl');
  const seqs = [];
  for (let i = 0; i < 12; i += 1) seqs.push(appendEvent(file, { type: 'task', payload: { n: i } }).seq);
  assert(seqs.every((s, i) => i === 0 || s >= seqs[i - 1]), `seq 必須單調不減（實際：${JSON.stringify(seqs)}）`);

  const fromFile = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).seq);
  eq(fromFile, seqs, '檔案裡的 seq 順序 === appendEvent 回傳的順序');
});

testCase('T1-7', '兩筆事件 seq 相同時，replay 順序仍依**檔案行序**（排序權威不是 seq）', async () => {
  const { replayExact, readEvents } = await ledger();
  const dir = makeTmpDir('lm-t1-');
  // 兩個併發寫者各自「讀尾筆 seq → +1 → append」就會寫出重複 seq；append-only 不允許回頭改。
  const file = writeStream(dir, 'events.jsonl', [
    evtLine({ v: 1, id: 'a', seq: 1, type: 'stage-enter', payload: { stage: 'goal' } }),
    evtLine({ v: 1, id: 'b', seq: 7, type: 'stage-enter', payload: { stage: 'plan' } }),
    evtLine({ v: 1, id: 'c', seq: 7, type: 'stage-enter', payload: { stage: 'build' } }),
    evtLine({ v: 1, id: 'd', seq: 7, type: 'stage-enter', payload: { stage: 'verify' } }),
  ]);
  eq(readEvents(file).events.map((e) => e.id), ['a', 'b', 'c', 'd'], 'readEvents 依行序回傳，不依 seq 重排');
  const state = replayExact(file);
  assert(JSON.stringify(state).includes('verify'),
    `replay 後的當前階段必須是行序最後那筆（verify）——依 seq 排序的實作會不穩定（實際 state：${JSON.stringify(state)}）`);
});

testCase('T1-8', '事件流永不 rotate：append 超過任何合理行數上限後，前面的事件一筆都不少', async () => {
  const { appendEvent, readEvents } = await ledger();
  const dir = makeTmpDir('lm-t1-');
  const file = join(dir, 'events.jsonl');
  const N = 1200; // repo 其餘三份 jsonl 的 cap 是 1000 行，且用的是自承「非原子 read→rewrite」的輪替
  for (let i = 1; i <= N; i += 1) appendEvent(file, { id: `evt-${String(i).padStart(4, '0')}`, type: 'task', payload: { n: i } });

  const raw = readFileSync(file, 'utf8');
  eq(raw.split('\n').length - 1, N, `檔案行數 === ${N}（沒有被輪替截掉）`);
  const r = readEvents(file);
  eq(r.events.length, N, `readEvents 讀回 ${N} 筆`);
  eq(r.events[0].id, 'evt-0001', '第 1 筆事件仍在第 1 行（rotate 會讓它消失）');
  eq(r.events[999].id, 'evt-1000', '第 1000 筆事件仍在原位');
  eq(r.events.at(-1).id, `evt-${N}`, '最後一筆是最新那筆');
});

testCase('T1-9', '反向斷言：loop-ledger.mjs 的原始碼不得 import hooks/atomic-write.mjs', () => {
  let src;
  try {
    src = readFileSync(LEDGER, 'utf8');
  } catch (err) {
    assert(false, `讀不到 loop-ledger.mjs 原始碼（${err?.code ?? err}）—— 該檔尚未存在`);
    return;
  }
  assert(!/atomic-write/.test(src),
    'loop-ledger.mjs 不得提及 atomic-write —— 該檔第 9–10 行明文排除 append 語意（tmp+rename 套上去會變成每筆事件重寫整檔 O(n²)）');
  assert(/appendFileSync/.test(src),
    'loop-ledger.mjs 要照 repo 既有 4 個站點的慣例用 appendFileSync 寫單行 ＋ 換行');
  assert(!/writeFileAtomic/.test(src), 'loop-ledger.mjs 不得呼叫 writeFileAtomic');
});

function existsOrEmpty(file) {
  try {
    return readFileSync(file, 'utf8').length > 0;
  } catch {
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// T2 —— 契約 1b：replay 的兩支 API 與四種損壞（loop-ledger.mjs 尚未存在 ⇒ 預期紅）
// ══════════════════════════════════════════════════════════════════════════════

const okEvent = (n, extra = {}) => ({
  v: 1,
  id: `evt-${String(n).padStart(4, '0')}`,
  seq: n,
  type: 'task',
  payload: { taskId: `T${n}`, title: `task-${n}` },
  ...extra,
});

testCase('T2-1', 'replayExact：未知 v ⇒ 拋出，且錯誤訊息**指名版本號**', async () => {
  const { replayExact } = await ledger();
  const dir = makeTmpDir('lm-t2-');
  const file = writeStream(dir, 'events.jsonl', [
    evtLine(okEvent(1)),
    evtLine({ ...okEvent(2), v: 99 }),
    evtLine(okEvent(3)),
  ]);
  const r = await throwsWith(() => replayExact(file), '99');
  assert(r.threw, `未知版本必須拋出，不得靜默略過（實際：${r.message}）`);
  eq(r.missing, [], `錯誤訊息要指名版本號 99（實際：${r.message}）`);
});

testCase('T2-2', 'replayExact：非法 JSON 行 ⇒ 拋出，且錯誤訊息**指名行號**', async () => {
  const { replayExact } = await ledger();
  const dir = makeTmpDir('lm-t2-');
  const file = writeStream(dir, 'events.jsonl', [
    evtLine(okEvent(1)),
    evtLine(okEvent(2)),
    '{"v":1,"id":"evt-0003","seq":3,,,壞掉的行}',
    evtLine(okEvent(4)),
  ]);
  const r = await throwsWith(() => replayExact(file), '3');
  assert(r.threw, `非法 JSON 必須拋出（實際：${r.message}）`);
  eq(r.missing, [], `錯誤訊息要指名行號 3（實際：${r.message}）`);
});

testCase('T2-3', 'replayExact：缺必要欄位 ⇒ 拋出，且指名行號與欄位名', async () => {
  const { replayExact } = await ledger();
  const noPayload = writeStream(makeTmpDir('lm-t2-'), 'events.jsonl', [
    evtLine(okEvent(1)),
    evtLine({ v: 1, id: 'evt-0002', seq: 2, type: 'stage-enter' }), // 缺 payload
  ]);
  const r1 = await throwsWith(() => replayExact(noPayload), '2', 'payload');
  assert(r1.threw, `缺 payload 必須拋出（實際：${r1.message}）`);
  eq(r1.missing, [], `錯誤訊息要同時指名行號 2 與欄位 payload（實際：${r1.message}）`);

  const noId = writeStream(makeTmpDir('lm-t2-'), 'events.jsonl', [
    evtLine({ v: 1, seq: 1, type: 'task', payload: {} }), // 缺 id
  ]);
  const r2 = await throwsWith(() => replayExact(noId), '1', 'id');
  assert(r2.threw && r2.missing.length === 0, `缺 id 要拋出並指名行號 1 與欄位 id（實際：${r2.message}）`);

  const decisionNoStatus = writeStream(makeTmpDir('lm-t2-'), 'events.jsonl', [
    evtLine({ v: 1, id: 'd1', seq: 1, type: 'decision', payload: { id: 'D1' } }),
  ]);
  const r3 = await throwsWith(() => replayExact(decisionNoStatus), '1', 'status');
  assert(r3.threw && r3.missing.length === 0, `decision 缺 status 要拋出並指名行號與 status（實際：${r3.message}）`);
});

testCase('T2-4', 'replayPrefix：停在第一個無法處理的事件，回 { state, complete:false, haltedAt:{line,reason,version} }', async () => {
  const { replayPrefix } = await ledger();
  const dir = makeTmpDir('lm-t2-');
  const file = writeStream(dir, 'events.jsonl', [
    evtLine(okEvent(1)),
    evtLine(okEvent(2)),
    '這一行不是 JSON',
    evtLine(okEvent(4)),
  ]);
  const r = replayPrefix(file);
  eq(r.complete, false, 'complete 必須是 false');
  assert(r.haltedAt && typeof r.haltedAt === 'object', `haltedAt 必須是物件（實際：${JSON.stringify(r?.haltedAt)}）`);
  eq(r.haltedAt?.line, 3, 'haltedAt.line 指向第一個無法處理的行');
  assert(typeof r.haltedAt?.reason === 'string' && r.haltedAt.reason.length > 0, `haltedAt.reason 要是非空字串（實際：${JSON.stringify(r?.haltedAt?.reason)}）`);
  assert('version' in (r.haltedAt ?? {}), 'haltedAt 必須有 version 欄（非版本問題時可為 null，但欄位要在）');
  assert(JSON.stringify(r.state).includes('task-2'), `前綴狀態要含第 2 筆（實際 state：${JSON.stringify(r.state)}）`);
  assert(!JSON.stringify(r.state).includes('task-4'), `前綴狀態**不得**含第 4 筆——跳過壞行續讀是明文禁止的（實際 state：${JSON.stringify(r.state)}）`);
});

testCase('T2-5', 'replayPrefix：遇未知版本 ⇒ haltedAt.version 指名該版本號', async () => {
  const { replayPrefix } = await ledger();
  const dir = makeTmpDir('lm-t2-');
  const file = writeStream(dir, 'events.jsonl', [
    evtLine(okEvent(1)),
    evtLine({ ...okEvent(2), v: 7 }),
    evtLine(okEvent(3)),
  ]);
  const r = replayPrefix(file);
  eq(r.complete, false, '未知版本 ⇒ complete false');
  eq(r.haltedAt?.line, 2, 'haltedAt.line === 2');
  eq(r.haltedAt?.version, 7, 'haltedAt.version 指名該未知版本號 7');
  assert(!JSON.stringify(r.state).includes('task-3'), '第 3 筆不得被納入');
});

testCase('T2-6', '鑑別力：1000 行第 500 行壞掉 ⇒ state 等於「只讀前 499 筆」，且不含 501–1000 的任何影響', async () => {
  const { replayExact, replayPrefix } = await ledger();
  const N = 1000;
  const all = [];
  for (let i = 1; i <= N; i += 1) all.push(evtLine(okEvent(i)));

  const brokenLines = all.slice();
  brokenLines[499] = '{"v":1,"id":"evt-0500","seq":500,"type":"task","payload":{'; // 第 500 行：截斷的 JSON
  const brokenFile = writeStream(makeTmpDir('lm-t2-'), 'events.jsonl', brokenLines);
  const prefixFile = writeStream(makeTmpDir('lm-t2-'), 'events.jsonl', all.slice(0, 499));

  const got = replayPrefix(brokenFile);
  const want = replayExact(prefixFile);

  eq(got.complete, false, 'complete === false');
  eq(got.haltedAt?.line, 500, 'haltedAt.line === 500');
  assert(JSON.stringify(got.state) === JSON.stringify(want),
    'replayPrefix 的 state 必須逐欄等於「只讀前 499 筆」的 state（state 必須是已消費事件的純函式）');

  const dump = JSON.stringify(got.state);
  assert(dump.includes('task-499'), '前 499 筆確實被套用（含 task-499）');
  for (const n of [500, 501, 600, 999, 1000]) {
    assert(!dump.includes(`task-${n}`), `state 不得含第 ${n} 筆的任何影響——這條專打「跳過壞行繼續讀」的實作`);
  }
});

testCase('T2-7', '反向：完好的事件流 ⇒ replayPrefix 回 complete:true 且 haltedAt 為 null', async () => {
  const { replayPrefix, replayExact } = await ledger();
  const lines = [];
  for (let i = 1; i <= 20; i += 1) lines.push(evtLine(okEvent(i)));
  const file = writeStream(makeTmpDir('lm-t2-'), 'events.jsonl', lines);

  const r = replayPrefix(file);
  eq(r.complete, true, '完好事件流 ⇒ complete === true（防「永遠 halted」的實作全綠）');
  eq(r.haltedAt, null, '完好事件流 ⇒ haltedAt === null');
  assert(JSON.stringify(r.state) === JSON.stringify(replayExact(file)),
    '完好事件流上，replayPrefix.state 必須等於 replayExact 的 state');
});

testCase('T2-8', '重複 id ⇒ 冪等：狀態與只出現一次相同', async () => {
  const { replayExact } = await ledger();
  const base = [
    evtLine({ v: 1, id: 'e1', seq: 1, type: 'stage-enter', payload: { stage: 'goal' } }),
    evtLine({ v: 1, id: 'e2', seq: 2, type: 'task', payload: { taskId: 'T1', title: 'task-1' } }),
    evtLine({ v: 1, id: 'e3', seq: 3, type: 'stage-enter', payload: { stage: 'plan' } }),
  ];
  const dupLines = [base[0], base[1], base[1], base[2]]; // e2 出現兩次
  const once = replayExact(writeStream(makeTmpDir('lm-t2-'), 'events.jsonl', base));
  const twice = replayExact(writeStream(makeTmpDir('lm-t2-'), 'events.jsonl', dupLines));
  assert(JSON.stringify(once) === JSON.stringify(twice),
    `重複 id 的 state 必須與只出現一次相同（once：${JSON.stringify(once)}；twice：${JSON.stringify(twice)}）`);
});

testCase('T2-9', '重複 id ⇒ **回報**偵測到重複（不得靜默吞掉）', async () => {
  const { replayPrefix } = await ledger();
  const line2 = evtLine({ v: 1, id: 'e2', seq: 2, type: 'task', payload: { taskId: 'T1' } });
  const file = writeStream(makeTmpDir('lm-t2-'), 'events.jsonl', [
    evtLine({ v: 1, id: 'e1', seq: 1, type: 'stage-enter', payload: { stage: 'goal' } }),
    line2,
    line2,
    evtLine({ v: 1, id: 'e3', seq: 3, type: 'stage-enter', payload: { stage: 'plan' } }),
  ]);
  const r = replayPrefix(file);
  assert(Array.isArray(r.duplicates), `duplicates 必須是陣列（實際：${JSON.stringify(r?.duplicates)}）`);
  assert(JSON.stringify(r.duplicates).includes('e2'), `duplicates 要指名重複的 id e2（實際：${JSON.stringify(r?.duplicates)}）`);
  eq(r.complete, true, '重複 id 不是損壞 ⇒ 仍然 complete');

  const clean = replayPrefix(writeStream(makeTmpDir('lm-t2-'), 'events.jsonl', [
    evtLine({ v: 1, id: 'e1', seq: 1, type: 'stage-enter', payload: { stage: 'goal' } }),
  ]));
  eq(clean.duplicates, [], '反向：沒有重複時 duplicates 必須是空陣列（防「永遠回報重複」的實作）');
});

testCase('T2-10', 'replayExact：兩個壞行時，停在**最早**那個（不得跳過續讀）', async () => {
  const { replayExact } = await ledger();
  const file = writeStream(makeTmpDir('lm-t2-'), 'events.jsonl', [
    evtLine(okEvent(1)),
    '壞行甲',
    evtLine(okEvent(3)),
    '壞行乙',
    evtLine(okEvent(5)),
  ]);
  const r = await throwsWith(() => replayExact(file), '2');
  assert(r.threw && r.missing.length === 0, `錯誤訊息要指名最早的壞行行號 2（實際：${r.message}）`);
  assert(!/行\s*4|line\s*4/i.test(r.message), `不得指名第 4 行——那代表跳過了第 2 行繼續讀（實際：${r.message}）`);
});

testCase('T2-11', '殘骸尾行不算 halt：replayPrefix 仍 complete，state 等於不含殘骸的 state', async () => {
  const { replayPrefix, replayExact } = await ledger();
  const good = [evtLine(okEvent(1)), evtLine(okEvent(2)), evtLine(okEvent(3))];
  const dir = makeTmpDir('lm-t2-');
  const file = writeStream(dir, 'events.jsonl', good);
  appendFileSync(file, '{"v":1,"id":"evt-0004","seq":4,"type":"ta'); // 中斷的半行

  const r = replayPrefix(file);
  eq(r.complete, true, '殘骸尾行是「已定義的丟棄」而非 halt ⇒ complete 仍為 true');
  eq(r.haltedAt, null, 'haltedAt 仍為 null');
  const want = replayExact(writeStream(makeTmpDir('lm-t2-'), 'events.jsonl', good));
  assert(JSON.stringify(r.state) === JSON.stringify(want), 'state 等於「不含殘骸尾行」的 state');
  assert(!JSON.stringify(r.state).includes('evt-0004'), 'state 不得含殘骸尾行的任何影響');
});

// ══════════════════════════════════════════════════════════════════════════════
const opts = parseArgs(process.argv.slice(2));
const selected = selectCases(cases, opts.filter);

for (const c of selected) {
  console.log(`\n[${c.id}] ${c.name}`);
  try {
    await c.fn();
  } catch (err) {
    const msg = `[${c.id}] 執行中丟出例外：${err?.message ?? err}`;
    failed.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}
cleanupTmp();

console.log(`\n${selected.length} cases run, ${passed} passed, ${failed.length} failed`);

if (opts.minCases > 0 && selected.length < opts.minCases) {
  console.error(`\n✗ case 數地板未達成：--min-cases ${opts.minCases}，實際跑到 ${selected.length}（filter="${opts.filter}"）`);
  process.exit(1);
}

if (failed.length > 0) {
  console.error('\n失敗清單：');
  for (const msg of failed) console.error(`  - ${msg}`);
  process.exit(1);
}
process.exit(0);
