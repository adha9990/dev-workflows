#!/usr/bin/env node
// test-loop-snapshot.mjs —— loop.md generated snapshot 的斷言（#172）。
// 重點三件事：① 快照**有界**（不再是無界 Journal）；② 既有消費端（loops-scan / progress）仍解析
// 得到——相容性用它們的真函式反解自己的產出來釘，不靠肉眼；③ ledger 的健康度警告會浮到快照上。
// 用法：node test-loop-snapshot.mjs [--filter <case-prefix>] [--min-cases <n>]

import { mkdtempSync, mkdirSync, rmSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendEvent, readEvents } from './loop-ledger.mjs';
import { projectEvents } from './loop-graph.mjs';
import { renderLoopMd, recentEvents, recentEventLines, describeEvent, summarize, regenerateLoopMd, RECENT_EVENT_LIMIT } from './loop-snapshot.mjs';
import { pickLoopField, currentStage, isDone, journalEntries } from './loops-scan.mjs';
import { extractProgress } from './progress.mjs';

let passed = 0;
const failed = [];
const cases = [];
const testCase = (id, name, fn) => cases.push({ id, name, fn });
function assert(cond, msg) {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); } else { failed.push(msg); console.error(`  ✗ ${msg}`); }
}
function parseArgs(argv) {
  const opts = { filter: '', minCases: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--filter') opts.filter = argv[++i] ?? '';
    else if (argv[i] === '--min-cases') opts.minCases = Number(argv[++i] ?? 0);
  }
  return opts;
}
function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-snap-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const build = (specs) => specs.map((s, i) => ({ v: 1, id: `e${i + 1}`, seq: i + 1, type: s.type, payload: s.payload }));
function seedLedger(dir, specs) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'events.jsonl');
  for (const s of specs) appendEvent(file, s);
  return file;
}

const RUN = [
  { type: 'loop-create', payload: { type: 'feature', operation: 'add', mode: 'auto', session: 'S9', stopCondition: 'AC 全綠' } },
  { type: 'issue', payload: { number: 172 } },
  { type: 'stage-enter', payload: { stage: 'build' } },
  { type: 'task', payload: { taskId: 'T1', title: 'ledger', status: 'open' } },
  { type: 'stage-enter', payload: { stage: 'verify' } },
  { type: 'finding', payload: { findingId: 'F1', severity: 'P0', title: '狀態會漏事件', status: 'open' } },
  { type: 'gate', payload: { gate: 'tests', status: 'fail' } },
  { type: 'round', payload: { round: 2 } },
];

// ══════════════════════════════════════════════════════════════════════════
testCase('S1', '相容性：欄位表仍被 loops-scan.pickLoopField 讀得到', () => {
  const events = build(RUN);
  const md = renderLoopMd(projectEvents(events, { slug: 'demo' }), events);
  assert(pickLoopField(md, '類型') === 'feature', 'pickLoopField 讀得到「類型」');
  assert(pickLoopField(md, '推進模式') === 'auto', 'pickLoopField 讀得到「推進模式」（pr-gate 閘⑥ 的 auto 偵測靠這欄）');
  assert(pickLoopField(md, '停止條件') === 'AC 全綠', 'pickLoopField 讀得到「停止條件」');
  assert(pickLoopField(md, 'session') === 'S9', 'pickLoopField 讀得到 session（SessionStart 挑 active loop 靠這欄）');
  assert(currentStage(md) === 'verify', 'currentStage 讀得到當前階段');
  assert(isDone(currentStage(md)) === false, '未完工時 isDone=false');
});

testCase('S2', '相容性：完工快照被 isDone 認得、outcome 行仍在', () => {
  const events = build([...RUN, { type: 'loop-close', payload: { outcome: '已合併 PR #999' } }]);
  const md = renderLoopMd(projectEvents(events, { slug: 'demo' }), events);
  assert(isDone(currentStage(md)), '完工快照被 isDone 認得（SessionStart 靠它濾掉完工 loop）');
  assert(md.includes('★[outcome]'), 'outcome 行沿用既有 ★[outcome] 標記（progress.mjs 讀它）');
});

testCase('S3', '相容性：事件行仍是 `- [E<n>] …`，progress.extractProgress 解得出回環與階段', () => {
  const events = build(RUN);
  const md = renderLoopMd(projectEvents(events, { slug: 'demo' }), events);
  assert(journalEntries(md).length > 0, 'journalEntries 抓得到事件行');
  const p = extractProgress({ slug: 'demo', md });
  assert(p.round === 2, 'extractProgress 由「回環 #2」行解出圈數');
  assert(p.stages.find((s) => s.name === 'verify').state === 'now', 'extractProgress 標對當前階段');
  assert(p.mode === 'auto' && p.type === 'feature', 'extractProgress 讀得到欄位');
});

testCase('S4', '有界：事件再多，快照的事件行數不超過上限', () => {
  const many = [];
  for (let i = 0; i < 500; i += 1) many.push({ type: 'toolrun', payload: { tool: `t${i}`, outcome: 'ok' } });
  const events = build([...RUN, ...many]);
  const md = renderLoopMd(projectEvents(events, { slug: 'demo' }), events);
  assert(journalEntries(md).length <= RECENT_EVENT_LIMIT, `508 筆事件 → 快照事件行 ≤ ${RECENT_EVENT_LIMIT}（不再無界）`);
  assert(md.includes('events.jsonl'), '快照指向完整事件流的所在（不是把資訊弄丟）');
  assert(md.includes(`（完整流見 events.jsonl）`), '快照誠實寫出總事件數');
});

testCase('S5', '有界選取：高訊號事件優先於流水帳；編號用行序不用 seq', () => {
  const noise = [];
  for (let i = 0; i < 100; i += 1) noise.push({ type: 'toolrun', payload: { tool: `t${i}`, outcome: 'ok' } });
  const events = build([...RUN, ...noise]);
  const picked = recentEvents(events, RECENT_EVENT_LIMIT);
  assert(picked.some((x) => x.event.type === 'finding'), '被 100 筆 toolrun 淹沒時，finding 仍留在快照裡');
  assert(picked.some((x) => x.event.type === 'round'), '回環事件仍留在快照裡');
  assert(picked.length === RECENT_EVENT_LIMIT, '額度用滿（不浪費）');
  assert(picked.every((x, i, a) => i === 0 || a[i - 1].ordinal <= x.ordinal), '挑出來的事件依行序遞增');

  // seq 不保證唯一（ledger 契約 E6）：顯示編號必須用行序，否則會出現兩行 [E7]
  const dupSeq = [
    { v: 1, id: 'a', seq: 7, type: 'stage-enter', payload: { stage: 'goal' } },
    { v: 1, id: 'b', seq: 7, type: 'stage-enter', payload: { stage: 'plan' } },
  ];
  const lines = recentEventLines(dupSeq);
  assert(lines[0].startsWith('- [E1]') && lines[1].startsWith('- [E2]'), 'seq 撞號時顯示編號仍互不相同（用行序）');
});

testCase('S6', 'blocking 區段：未修 P0/P1 與沒過的閘出現在快照', () => {
  const events = build(RUN);
  const md = renderLoopMd(projectEvents(events, { slug: 'demo' }), events);
  assert(md.includes('仍擋著完工的'), '有 blocking 區段');
  assert(md.includes('F1') && md.includes('P0'), '未修的 P0 finding 出現在快照');
  assert(md.includes('tests') && md.includes('fail'), '沒過的閘出現在快照');
  const clean = build([{ type: 'loop-create', payload: {} }, { type: 'stage-enter', payload: { stage: 'goal' } }]);
  assert(renderLoopMd(projectEvents(clean, { slug: 'demo' }), clean).includes('（無）'), '沒有 blocking 時明確寫「無」');
});

testCase('S7', '決定性：同一組事件重生兩次逐字相同', () => {
  const events = build(RUN);
  const st = projectEvents(events, { slug: 'demo' });
  assert(renderLoopMd(st, events) === renderLoopMd(st, events), '重生兩次逐字相同');
  assert(describeEvent(events[5]).includes('F1'), 'describeEvent 產出可讀敘述');
  assert(summarize(st).includes('回環 #2'), 'summarize 帶出回環數');
  assert(recentEventLines(events).every((l) => /^- \[E\d+\] /.test(l)), '事件行格式固定');
  assert(describeEvent({ type: '未知型別', payload: {} }) === '未知型別', '未知型別不丟例外');
});

testCase('S8', 'IO：regenerateLoopMd 由 ledger 重生檔案', () => {
  withTmp((dir) => {
    const loopDir = join(dir, 'demo');
    seedLedger(loopDir, RUN);
    const md = regenerateLoopMd(loopDir, { slug: 'demo' });
    assert(existsSync(join(loopDir, 'loop.md')), 'loop.md 被寫出來');
    assert(readFileSync(join(loopDir, 'loop.md'), 'utf8') === md, '寫出的內容＝回傳的內容');
    appendEvent(join(loopDir, 'events.jsonl'), { type: 'finding', payload: { findingId: 'F1', status: 'resolved' } });
    const md2 = regenerateLoopMd(loopDir, { slug: 'demo' });
    assert(md2 !== md && !md2.includes('`F1` **P0**'), 'ledger 變了 → 重生的快照跟著變（F1 已不再 blocking）');
    assert(readEvents(join(loopDir, 'events.jsonl')).events.length === RUN.length + 1, '重生不會動到 ledger');
  });
});

testCase('S9', 'ledger 健康度警告會浮到快照最上方（丟棄不得只活在回傳值裡）', () => {
  withTmp((dir) => {
    const loopDir = join(dir, 'demo');
    seedLedger(loopDir, RUN);
    appendFileSync(join(loopDir, 'events.jsonl'), '{"v":1,"id":"x","seq":9,"type":"stage-en'); // 中斷的 append
    const md = regenerateLoopMd(loopDir, { slug: 'demo' });
    assert(md.includes('事件流健康度警告'), '殘骸尾行在快照上被明白告知');
    assert(md.indexOf('事件流健康度警告') < md.indexOf('| 欄位 |'), '警告排在欄位表之前（第一眼就看得到）');
    const clean = renderLoopMd(projectEvents(build(RUN), { slug: 'demo' }), build(RUN), { warnings: [] });
    assert(!clean.includes('事件流健康度警告'), '反向：健康的 ledger 不顯示警告區塊');
  });
});

// ══════════════════════════════════════════════════════════════════════════
const opts = parseArgs(process.argv.slice(2));
const selected = cases.filter((c) => c.id === opts.filter || c.id.startsWith(opts.filter));
for (const c of selected) { console.log(`\n[${c.id}] ${c.name}`); c.fn(); }
console.log(`\n${selected.length} cases run, ${passed} passed, ${failed.length} failed`);
if (opts.minCases > 0 && selected.length < opts.minCases) {
  console.error(`\n✗ case 數地板未達成：--min-cases ${opts.minCases}，實際 ${selected.length}`);
  process.exit(1);
}
if (failed.length) { console.error('\n失敗清單：'); for (const m of failed) console.error(`  - ${m}`); process.exit(1); }
process.exit(0);
