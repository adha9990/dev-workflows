#!/usr/bin/env node
// test-loop-ledger.mjs —— loop-ledger.mjs 的紅綠斷言（#172 T1/T2；02-plan.md 契約 1 與契約 1b）。
// 用法：node test-loop-ledger.mjs [--filter <case-id>] [--min-cases <n>]
//   --filter T1     只跑 T1-*（精確 id 或「id + 連字號」前綴；不會讓 T1 撈到 T10-*）
//   --min-cases 18  斷言實際跑到的 case 數不得少於 18（沒有這個地板，一個沒寫測試的任務也會 exit 0）
// 全綠且達到 case 地板 → exit 0；任一斷言失敗 / case 數不足 → exit 1。
//
// 覆蓋：
//   T1-*  契約 1（E1 單行＋換行結尾／尾行殘骸、appendEvent 回傳實際寫出的完整事件、
//               必要欄位驗證、decision 必含 status、E5 永不 rotate、
//               E6 seq 只保證單調不減且排序權威是檔案行序、E1 明文不走 atomic-write）
//   T2-*  契約 1b（replayExact 遇未知版本／壞行即拋出並指名、replayPrefix 停在第一個壞事件、
//               R3 明文禁止跳過壞事件續讀、殘骸尾行 ≠ 壞事件、E4 重複 id 冪等且回報）
//
// T1/T2 是本檔的唯一歸屬（T0 在 test-loop-memory.mjs）。原先寫在 test-loop-memory.mjs 的
// T1/T2 已由 lead 裁決收攏到這裡：T1-2 強化、T1-12／T1-13／T2-13／T2-14 為併入項。
//   H-*   harness 自檢：即使受測模組不存在也必須全綠。它們的用途是把「模組還沒寫」跟
//         「測試自己壞了」這兩種紅分開——H-* 綠而 T1/T2 全紅 ⇒ 是前者。
//
// 落點紀律：所有暫存檔一律開在 os.tmpdir() 底下，絕不在 worktree／repo 內建立 .loops/（契約 6）。

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = join(HERE, 'loop-ledger.mjs');
const WORKTREE_ROOT = resolve(HERE, '..', '..', '..');

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

function parseArgs(argv) {
  const opts = { filter: '', minCases: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--filter') opts.filter = argv[++i] ?? '';
    else if (flag === '--min-cases') opts.minCases = Number(argv[++i] ?? 0);
  }
  return opts;
}

// 精確 id 或「id + 連字號」前綴。用 startsWith(filter) 會讓 --filter T1 撈到 T10-*。
function matchesFilter(id, filter) {
  if (!filter) return true;
  return id === filter || id.startsWith(`${filter}-`);
}

function throwsWith(fn, needle) {
  try {
    const value = fn();
    return { threw: false, matched: false, message: `(沒有丟例外，回傳 ${JSON.stringify(value)?.slice(0, 120)})` };
  } catch (err) {
    const message = String(err?.message ?? err);
    return { threw: true, matched: message.includes(needle), message };
  }
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return { __unparseable: String(text).slice(0, 80) }; }
}

const EVENT_KEYS = ['id', 'payload', 'seq', 'type', 'v'];

function keysOf(obj) {
  return JSON.stringify(Object.keys(obj ?? {}).sort());
}

// ── 狀態比對：形狀不可知，所以正規化後序列化再比字串 ─────────────────────────────
// replayExact 的回傳「state」在契約裡沒有指定形狀，因此所有跨狀態的斷言都只能用
// 「同一支實作的兩個 state 互比」這種形狀不可知的方式，不預設任何欄位名。
function normalize(value, ancestors = new Set()) {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'bigint') return `#BigInt:${value}`;
  if (t === 'function') return `#Function:${value.name}`;
  if (t === 'undefined') return '#undefined';
  if (t !== 'object') return value;
  if (ancestors.has(value)) return '#circular';
  ancestors.add(value);
  let out;
  if (value instanceof Date) {
    out = `#Date:${value.toISOString()}`;
  } else if (value instanceof Map) {
    out = {
      '#Map': [...value.entries()]
        .map(([k, v]) => [normalize(k, ancestors), normalize(v, ancestors)])
        .sort((a, b) => (JSON.stringify(a[0]) < JSON.stringify(b[0]) ? -1 : 1)),
    };
  } else if (value instanceof Set) {
    out = { '#Set': [...value].map((v) => JSON.stringify(normalize(v, ancestors))).sort() };
  } else if (Array.isArray(value)) {
    out = value.map((v) => normalize(v, ancestors));
  } else {
    out = {};
    for (const k of Object.keys(value).sort()) out[k] = normalize(value[k], ancestors);
  }
  ancestors.delete(value);
  return out;
}

function stable(value) {
  return JSON.stringify(normalize(value));
}

// 兩個 state 不相等時，指出「差在哪幾個頂層欄位」——否則失敗訊息只是「不相等」，無從裁決。
function diffKeys(actual, expected) {
  const a = normalize(actual) ?? {};
  const b = normalize(expected) ?? {};
  if (typeof a !== 'object' || typeof b !== 'object') return `(非物件：${stable(actual)} vs ${stable(expected)})`;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const diff = keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  if (diff.length === 0) return '(頂層欄位全同)';
  return diff.map((k) => `${k}: ${JSON.stringify(a[k])?.slice(0, 60)} vs ${JSON.stringify(b[k])?.slice(0, 60)}`).join('；');
}

// ── 落點稽查：worktree 底下的 .loops/ 快照（跑之前先照一張，H-9 比對前後差異）──────
// 註：worktree 內本來就有數個「committed 的 fixture .loops/」（hooks/fixtures/**、
// scripts/fixtures/**），所以判準不是「一個都不能有」，而是「這支測試不得新增任何一個」。
function scanLoopsDirs(root) {
  const found = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const abs = join(dir, e.name);
      if (e.name === '.loops') { found.push(abs.slice(root.length + 1).replace(/\\/g, '/')); continue; }
      walk(abs);
    }
  };
  walk(root);
  return found.sort();
}

const LOOPS_BEFORE = scanLoopsDirs(WORKTREE_ROOT);

// ── 暫存落點：一律 os.tmpdir()，絕不落在 repo／worktree 底下 ────────────────────
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'loop-ledger-test-'));
let ledgerCounter = 0;

function newLedgerPath(name = 'events') {
  ledgerCounter += 1;
  const dir = join(TMP_ROOT, `case-${ledgerCounter}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${name}.jsonl`);
}

function writeRaw(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

function writeLines(path, lines, { trailingNewline = true } = {}) {
  return writeRaw(path, lines.join('\n') + (trailingNewline ? '\n' : ''));
}

function physicalLines(path) {
  const raw = readFileSync(path, 'utf8');
  return raw.length === 0 ? [] : raw.split('\n');
}

// ── 事件工廠 ─────────────────────────────────────────────────────────────────
// 注意：appendEvent 不帶 seq——契約 E6 明訂 seq 由 appendEvent 自己在 append 前重讀檔尾配號。
function ev(over = {}) {
  return { v: 1, id: 'evt-1', type: 'stage-enter', payload: { nodeId: 'stage-plan', stage: 'plan' }, ...over };
}

function headLine(n) {
  return JSON.stringify({
    v: 1, id: `evt-HEAD-${n}`, seq: n, type: 'stage-enter',
    payload: { nodeId: `stage-HEAD-${n}`, stage: `s${n}`, note: `HEAD-${n}` },
  });
}

function tailLine(n) {
  return JSON.stringify({
    v: 1, id: `evt-TAIL-${n}`, seq: n, type: 'stage-enter',
    payload: { nodeId: `stage-TAIL-${n}`, stage: `s${n}`, note: `TAIL-${n}` },
  });
}

// 1000 行事件流：1–499 = HEAD，500 = MID，501–1000 = TAIL；
// 第 250 行與第 750 行是同一個 decision node 的兩筆事件（pending → decided），
// 讓「跳過壞行續讀」的實作在狀態上留下無法辯解的痕跡（gate 會讀到 decided）。
function buildThousandLines() {
  const lines = [];
  for (let n = 1; n <= 1000; n += 1) {
    if (n === 250) {
      lines.push(JSON.stringify({
        v: 1, id: 'evt-HEAD-250', seq: 250, type: 'decision',
        payload: { nodeId: 'd-1', status: 'pending', note: 'HEAD-250' },
      }));
    } else if (n === 500) {
      lines.push(JSON.stringify({
        v: 1, id: 'evt-MID-500', seq: 500, type: 'stage-enter',
        payload: { nodeId: 'stage-MID-500', stage: 's500', note: 'MID-500' },
      }));
    } else if (n === 750) {
      lines.push(JSON.stringify({
        v: 1, id: 'evt-TAIL-750', seq: 750, type: 'decision',
        payload: { nodeId: 'd-1', status: 'decided', note: 'TAIL-750' },
      }));
    } else if (n < 500) {
      lines.push(headLine(n));
    } else {
      lines.push(tailLine(n));
    }
  }
  return lines;
}

const CORRUPT_LINE = '{"v":1,"id":"evt-BAD-500","seq":500,';

// ── 受測模組：動態載入，載不到不得炸掉整份 harness ─────────────────────────────
let mod = null;
let modError = null;
try {
  mod = await import(pathToFileURL(MODULE_PATH).href);
} catch (err) {
  modError = err;
}

console.log(`受測模組：${MODULE_PATH}`);
if (mod) {
  console.log(`  載入成功；export：${Object.keys(mod).sort().join(', ') || '(無)'}`);
} else {
  console.error(`  ✗ 載入失敗：${modError?.code ?? '(無 code)'} — ${modError?.message ?? modError}`);
  console.error('    ⇒ 這是「實作尚未存在」的紅。H-* 自檢案例不依賴此模組，應該全綠；');
  console.error('       若 H-* 也紅，才是 harness 自己壞了。');
}

const REQUIRED_EXPORTS = ['appendEvent', 'readEvents', 'replayExact', 'replayPrefix'];

// 取受測 export；模組或 export 缺席時記一筆失敗並回 null，讓該 case 紅而非讓整份 crash。
function api(name) {
  if (!mod) {
    failed.push(`受測模組載入失敗，無法取得 ${name}()：${modError?.code ?? modError?.message ?? modError}`);
    console.error(`  ✗ 受測模組載入失敗，無法取得 ${name}()：${modError?.code ?? modError?.message ?? modError}`);
    return null;
  }
  if (typeof mod[name] !== 'function') {
    failed.push(`模組未 export 函式 ${name}（實際：${typeof mod[name]}）`);
    console.error(`  ✗ 模組未 export 函式 ${name}（實際：${typeof mod[name]}）`);
    return null;
  }
  return mod[name];
}

function moduleSource() {
  try {
    return readFileSync(MODULE_PATH, 'utf8');
  } catch (err) {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// H-*｜harness 自檢——不依賴受測模組，用來把「模組沒寫」跟「測試寫壞」分開
// ══════════════════════════════════════════════════════════════════════════

testCase('H-1', 'filter 比對是精確 id 或加連字號前綴，T1 不得撈到 T10-*', () => {
  assert(matchesFilter('T1-3', 'T1'), 'T1-3 應被 --filter T1 選中');
  assert(matchesFilter('T1', 'T1'), '精確 id T1 應被 --filter T1 選中');
  assert(!matchesFilter('T10-1', 'T1'), 'T10-1 不得被 --filter T1 選中（既有 startsWith 實作會誤撈）');
  assert(!matchesFilter('T2-1', 'T1'), 'T2-1 不得被 --filter T1 選中');
  assert(matchesFilter('T2-9', ''), '空 filter 應選中全部');
});

testCase('H-2', '狀態正規化序列化：鍵序無關、值不同即不同', () => {
  assert(stable({ a: 1, b: 2 }) === stable({ b: 2, a: 1 }), '物件鍵序不影響序列化結果');
  assert(stable({ a: 1 }) !== stable({ a: 2 }), '值不同 ⇒ 序列化結果不同');
  assert(stable(new Map([['k', 1]])) === stable(new Map([['k', 1]])), 'Map 內容相同 ⇒ 序列化相同');
  assert(stable(new Map([['k', 1]])) !== stable(new Map([['k', 2]])), 'Map 值不同 ⇒ 序列化不同');
  assert(stable([1, 2]) !== stable([2, 1]), '陣列順序有意義：順序不同 ⇒ 序列化不同');
});

testCase('H-3', '暫存落點在 os.tmpdir() 底下，不在 worktree 內', () => {
  const tmpResolved = resolve(TMP_ROOT).toLowerCase();
  const wtResolved = resolve(WORKTREE_ROOT).toLowerCase();
  assert(tmpResolved.startsWith(resolve(tmpdir()).toLowerCase()), `暫存根目錄必須在 os.tmpdir() 底下（實際：${TMP_ROOT}）`);
  assert(!tmpResolved.startsWith(wtResolved + sep.toLowerCase()), `暫存根目錄不得落在 worktree 底下（worktree：${WORKTREE_ROOT}）`);
});

testCase('H-4', 'harness 的檔案讀寫原語本身可用（不依賴受測模組）', () => {
  const p = newLedgerPath('selfcheck');
  writeLines(p, ['{"a":1}', '{"a":2}']);
  const raw = readFileSync(p, 'utf8');
  assert(raw === '{"a":1}\n{"a":2}\n', `writeLines 應寫出兩行含尾換行（實際：${JSON.stringify(raw)}）`);
  assert(physicalLines(p).length === 3, `尾換行後 split 應得 3 段（末段為空字串），實際 ${physicalLines(p).length}`);
  writeLines(p, ['{"a":1}'], { trailingNewline: false });
  assert(!readFileSync(p, 'utf8').endsWith('\n'), 'trailingNewline:false 應寫出無尾換行的檔');
});

testCase('H-5', '1000 行 fixture 造得出來且第 500 行可被指定為壞行', () => {
  const lines = buildThousandLines();
  assert(lines.length === 1000, `fixture 應有 1000 行（實際 ${lines.length}）`);
  assert(JSON.parse(lines[249]).payload.status === 'pending', '第 250 行應是 pending 的 decision');
  assert(JSON.parse(lines[749]).payload.status === 'decided', '第 750 行應是 decided 的 decision');
  assert(lines.slice(0, 499).every((l) => !l.includes('TAIL-')), '前 499 行不得含 TAIL 標記');
  assert(lines.slice(500).every((l) => l.includes('TAIL-')), '第 501–1000 行應全部含 TAIL 標記');
  const bad = throwsWith(() => JSON.parse(CORRUPT_LINE), '');
  assert(bad.threw, '壞行 fixture 必須真的不是合法 JSON');
});

// ══════════════════════════════════════════════════════════════════════════
// T1｜契約 1：事件 schema 與 append 寫法
// ══════════════════════════════════════════════════════════════════════════

testCase('T1-1', 'append 出的每筆是單行 JSON ＋ 換行結尾（payload 內含換行也不得撐成兩行）', () => {
  const appendEvent = api('appendEvent');
  const readEvents = api('readEvents');
  if (!appendEvent || !readEvents) return;
  const p = newLedgerPath();
  appendEvent(p, ev({ id: 'evt-1' }));
  appendEvent(p, ev({ id: 'evt-2', type: 'finding', payload: { nodeId: 'f-1', note: '第一行\n第二行' } }));
  appendEvent(p, ev({ id: 'evt-3' }));

  const raw = readFileSync(p, 'utf8');
  assert(raw.endsWith('\n'), `檔案必須以換行結尾（實際尾字元：${JSON.stringify(raw.slice(-1))}）`);
  const lines = raw.slice(0, -1).split('\n');
  assert(lines.length === 3, `3 筆事件必須剛好 3 個物理行（實際 ${lines.length}）——payload 內的換行必須被 JSON 轉義`);
  assert(lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), '每一行都必須是可獨立 parse 的完整 JSON');
  const back = readEvents(p);
  const e2 = back.events.find((e) => e.id === 'evt-2');
  assert(e2?.payload?.note === '第一行\n第二行', `payload 內的換行必須原樣往返（實際：${JSON.stringify(e2?.payload?.note)}）`);
});

testCase('T1-2', 'appendEvent 回傳「實際寫出去的那筆事件」：欄位集合恰為 { v, id, seq, type, payload }，且與檔案那一行深度相等', () => {
  const appendEvent = api('appendEvent');
  const readEvents = api('readEvents');
  if (!appendEvent || !readEvents) return;
  const p = newLedgerPath();
  const r1 = appendEvent(p, ev({ id: 'evt-1' }));
  const r2 = appendEvent(p, ev({ id: 'evt-2' }));

  assert(r1 !== null && typeof r1 === 'object', `appendEvent 必須回傳物件（實際：${JSON.stringify(r1)}）`);
  assert(keysOf(r1) === JSON.stringify(EVENT_KEYS), `回傳的欄位集合必須恰為 ${EVENT_KEYS.join('／')}——不得多也不得少（實際：${keysOf(r1)}）`);
  assert(r1?.v === 1, `回傳的 v 必須是 1（實際：${JSON.stringify(r1?.v)}）`);
  assert(typeof r1?.id === 'string' && r1.id.length > 0, `回傳的 id 必須是非空字串（實際：${JSON.stringify(r1?.id)}）`);
  assert(Number.isInteger(r1?.seq), `回傳的 seq 必須是整數（實際：${JSON.stringify(r1?.seq)}）`);

  // 不變式：回傳的就是寫進去的
  const lines = readFileSync(p, 'utf8').replace(/\n$/, '').split('\n');
  assert(lines.length === 2, `檔內應有 2 個物理行（實際 ${lines.length}）`);
  assert(stable(safeParse(lines[0])) === stable(r1), `第 1 行 JSON.parse 後必須深度相等於 appendEvent 的回傳值（檔內：${lines[0]}）`);
  assert(stable(safeParse(lines[1])) === stable(r2), `第 2 行同上（檔內：${lines[1]}）`);

  const events = readEvents(p).events;
  assert(events.length === 2, `readEvents 應讀回 2 筆（實際 ${events.length}）`);
  assert(events[0]?.seq === r1?.seq, `回傳的 seq 必須等於檔內該筆的 seq（回傳 ${r1?.seq} vs 檔內 ${events[0]?.seq}）`);
  assert(events[1]?.seq === r2?.seq, `第二筆同上（回傳 ${r2?.seq} vs 檔內 ${events[1]?.seq}）`);
});

testCase('T1-3', 'seq 單調不減（不斷言唯一——契約 E6 明訂不保證唯一）', () => {
  const appendEvent = api('appendEvent');
  const readEvents = api('readEvents');
  if (!appendEvent || !readEvents) return;
  const p = newLedgerPath();
  for (let i = 1; i <= 12; i += 1) appendEvent(p, ev({ id: `evt-${i}` }));
  const seqs = readEvents(p).events.map((e) => e.seq);

  assert(seqs.length === 12, `應讀回 12 筆（實際 ${seqs.length}）`);
  assert(seqs.every((s) => typeof s === 'number'), `每筆的 seq 都必須是數字（實際：${JSON.stringify(seqs)}）`);
  assert(seqs.every((s, i) => i === 0 || s >= seqs[i - 1]), `seq 必須單調不減（實際：${JSON.stringify(seqs)}）`);
});

testCase('T1-4', '尾行無換行 ⇒ 視為中斷殘骸丟棄，且 truncatedTail === true，前面事件完好', () => {
  const readEvents = api('readEvents');
  if (!readEvents) return;

  // (a) 尾行是半截 JSON
  const p1 = newLedgerPath('halfline');
  writeLines(p1, [headLine(1), headLine(2)]);
  appendFileSync(p1, '{"v":1,"id":"evt-3","seq":3,');
  const r1 = readEvents(p1);
  assert(r1.events.length === 2, `半截尾行必須被丟棄，只留前 2 筆（實際 ${r1.events.length}）`);
  assert(r1.truncatedTail === true, `必須明確回報 truncatedTail === true（實際：${JSON.stringify(r1.truncatedTail)}）`);
  assert(r1.events[0]?.id === 'evt-HEAD-1' && r1.events[1]?.id === 'evt-HEAD-2', `前面的事件必須完好（實際：${JSON.stringify(r1.events.map((e) => e.id))}）`);

  // (b) 尾行是「JSON 合法但沒有換行結尾」——契約 E1 判準是換行結尾，不是能不能 parse
  const p2 = newLedgerPath('noeol');
  writeLines(p2, [headLine(1), headLine(2), headLine(3)], { trailingNewline: false });
  const r2 = readEvents(p2);
  assert(r2.events.length === 2, `無換行結尾的尾行即使 JSON 合法也要丟棄（實際留下 ${r2.events.length} 筆）`);
  assert(r2.truncatedTail === true, `(b) 同樣必須回報 truncatedTail === true（實際：${JSON.stringify(r2.truncatedTail)}）`);
});

testCase('T1-5', '反向：健康的事件流 truncatedTail === false（殺掉「恆回 true」的實作）', () => {
  const readEvents = api('readEvents');
  if (!readEvents) return;
  const p = newLedgerPath('healthy');
  writeLines(p, [headLine(1), headLine(2), headLine(3)]);
  const r = readEvents(p);
  assert(r.truncatedTail === false, `健康檔必須回 truncatedTail === false（實際：${JSON.stringify(r.truncatedTail)}）`);
  assert(r.events.length === 3, `健康檔必須讀回全部 3 筆（實際 ${r.events.length}）`);
});

testCase('T1-6', 'decision 型事件 payload 缺 status ⇒ appendEvent 拒絕，且不得改動既有檔案', () => {
  const appendEvent = api('appendEvent');
  if (!appendEvent) return;
  const p = newLedgerPath('decision');
  appendEvent(p, ev({ id: 'evt-1' }));
  const before = readFileSync(p, 'utf8');

  const missing = throwsWith(() => appendEvent(p, ev({ id: 'evt-bad', type: 'decision', payload: { nodeId: 'd-1' } })), 'status');
  assert(missing.threw, `decision 缺 status 必須被拒（實際：${missing.message}）`);
  assert(missing.matched, `拒絕訊息必須指名 status（實際：${missing.message}）`);
  assert(readFileSync(p, 'utf8') === before, '被拒的 append 不得留下任何位元組（不得寫半行再丟例外）');

  const badValue = throwsWith(() => appendEvent(p, ev({ id: 'evt-bad2', type: 'decision', payload: { nodeId: 'd-1', status: 'maybe' } })), 'maybe');
  assert(badValue.threw, `status 為列舉外的值（'maybe'）必須被拒（實際：${badValue.message}）`);
  assert(readFileSync(p, 'utf8') === before, '界外 status 被拒後檔案同樣不得被改動');
});

testCase('T1-7', "反向：decision 帶合法 status（'pending' / 'decided'）必須被接受", () => {
  const appendEvent = api('appendEvent');
  const readEvents = api('readEvents');
  if (!appendEvent || !readEvents) return;
  const p = newLedgerPath('decision-ok');
  const okPending = throwsWith(() => appendEvent(p, ev({ id: 'evt-p', type: 'decision', payload: { nodeId: 'd-1', status: 'pending' } })), '');
  const okDecided = throwsWith(() => appendEvent(p, ev({ id: 'evt-d', type: 'decision', payload: { nodeId: 'd-1', status: 'decided' } })), '');
  assert(!okPending.threw, `status: 'pending' 必須被接受（實際：${okPending.message}）`);
  assert(!okDecided.threw, `status: 'decided' 必須被接受（實際：${okDecided.message}）`);
  const nonDecision = throwsWith(() => appendEvent(p, ev({ id: 'evt-s', type: 'stage-enter', payload: { nodeId: 'stage-plan' } })), '');
  assert(!nonDecision.threw, `非 decision 型不得被要求 status（實際：${nonDecision.message}）`);
  assert(readEvents(p).events.length === 3, `三筆合法事件都應落檔（實際 ${readEvents(p).events.length}）`);
});

testCase('T1-8', 'seq 相同時，排序權威是檔案行序而不是 seq（E6）', () => {
  const readEvents = api('readEvents');
  const replayExact = api('replayExact');
  if (!readEvents || !replayExact) return;

  const first = JSON.stringify({ v: 1, id: 'evt-A', seq: 5, type: 'decision', payload: { nodeId: 'd-1', status: 'pending', note: 'ORDER-A' } });
  const second = JSON.stringify({ v: 1, id: 'evt-B', seq: 5, type: 'decision', payload: { nodeId: 'd-1', status: 'decided', note: 'ORDER-B' } });

  const pAB = writeLines(newLedgerPath('order-ab'), [headLine(1), first, second]);
  const pBA = writeLines(newLedgerPath('order-ba'), [headLine(1), second, first]);

  assert(
    JSON.stringify(readEvents(pAB).events.map((e) => e.id)) === JSON.stringify(['evt-HEAD-1', 'evt-A', 'evt-B']),
    `readEvents 必須照檔案行序回傳，不得依 seq／id 重排（實際：${JSON.stringify(readEvents(pAB).events.map((e) => e.id))}）`,
  );
  assert(
    JSON.stringify(readEvents(pBA).events.map((e) => e.id)) === JSON.stringify(['evt-HEAD-1', 'evt-B', 'evt-A']),
    `行序對調後也必須照檔案行序（實際：${JSON.stringify(readEvents(pBA).events.map((e) => e.id))}）`,
  );
  // 兩份檔的 seq 多重集完全相同，只有行序不同：若實作照 seq（或 seq+id）排序，兩者狀態會相同。
  assert(
    stable(replayExact(pAB)) !== stable(replayExact(pBA)),
    'seq 相同的兩筆事件對調行序後，replay 出的狀態必須不同（相同 ⇒ 實作是照 seq 排序，非檔案行序）',
  );
});

testCase('T1-9', '事件流永不 rotate：append 1200 筆後第一筆仍在、一筆不少（E5）', () => {
  const appendEvent = api('appendEvent');
  const readEvents = api('readEvents');
  if (!appendEvent || !readEvents) return;
  const p = newLedgerPath('norotate');
  const TOTAL = 1200; // > eval-metrics.mjs 的 MAX_METRIC_ROWS(1000) cap，照抄那支就會在這裡紅
  for (let i = 1; i <= TOTAL; i += 1) appendEvent(p, ev({ id: `evt-${i}`, payload: { nodeId: `stage-${i}`, stage: `s${i}` } }));

  const r = readEvents(p);
  assert(r.events.length === TOTAL, `append ${TOTAL} 筆後必須全部讀得回來（實際 ${r.events.length}）`);
  assert(r.events[0]?.id === 'evt-1', `最早的一筆必須還在（實際首筆：${r.events[0]?.id}）`);
  assert(r.events[TOTAL - 1]?.id === `evt-${TOTAL}`, `最後一筆必須是 evt-${TOTAL}（實際：${r.events[TOTAL - 1]?.id}）`);
  assert(physicalLines(p).length === TOTAL + 1, `物理行數必須是 ${TOTAL} 行＋尾換行（實際 split 得 ${physicalLines(p).length} 段）`);
  assert(r.truncatedTail === false, `連續 append 後不得回報 truncatedTail（實際：${JSON.stringify(r.truncatedTail)}）`);
});

testCase('T1-10', '反向（讀原始碼）：不得使用 atomic-write，必須走 appendFileSync 的既有 append 慣例', () => {
  const src = moduleSource();
  assert(src !== null, `必須讀得到 ${MODULE_PATH} 的原始碼`);
  if (src === null) return;
  assert(!src.includes('atomic-write'), 'loop-ledger.mjs 原始碼不得出現 atomic-write（該檔第 9–10 行自陳排除 append 語意；tmp+rename 會變成每筆事件重寫整檔 O(n²)）');
  assert(!src.includes('renameSync'), '不得使用 tmp+rename 整檔覆寫（renameSync）');
  assert(src.includes('appendFileSync'), 'append 必須走 appendFileSync（照 cost-tracker.mjs:412 等既有 4 個站點的慣例）');
});

testCase('T1-11', '反向（讀原始碼）：不得有 rotate／行數上限邏輯（E5 明文禁止照抄 eval-metrics 的 1000 行 cap）', () => {
  const src = moduleSource();
  assert(src !== null, `必須讀得到 ${MODULE_PATH} 的原始碼`);
  if (src === null) return;
  const banned = [
    [/\brotat/i, 'rotate／rotation／rotateLines'],
    [/\.slice\(\s*-\s*\d{2,}\s*\)/, '.slice(-<兩位數以上>) 形式的保留末 N 行'],
    [/\.slice\([^)]*length\s*-\s*\d{2,}/, '.slice(x.length - <兩位數以上>) 形式的保留末 N 行'],
    [/\b(MAX|CAP|LIMIT|KEEP)_[A-Z_]*(ROWS|LINES|EVENTS|ENTRIES)\b/, 'MAX_*_ROWS／CAP_*_LINES 之類的行數上限常數'],
    [/\bftruncate|truncateSync/, 'ftruncate／truncateSync 截檔'],
  ];
  for (const [re, label] of banned) {
    assert(!re.test(src), `原始碼不得出現 ${label}（會把中段損壞從「實測 0 次」變成必然發生，而 E1 只檢查尾行、完全偵測不到）`);
  }
});

testCase('T1-12', 'appendEvent 的 id 選填（沒給就自己生非空字串）、v 預設 1，且自動生成的 id 不得相撞', () => {
  const appendEvent = api('appendEvent');
  const readEvents = api('readEvents');
  if (!appendEvent || !readEvents) return;
  const p = newLedgerPath('defaults');
  // 不給 id、不給 v：兩者都是選填，appendEvent 必須自己補完
  const attempt = throwsWith(() => appendEvent(p, { type: 'task', payload: { taskId: 'T1' } }), '');
  assert(!attempt.threw, `不給 id 與 v 的 append 必須被接受（id 選填、v 預設 1）（實際：${attempt.message}）`);
  if (attempt.threw) return;
  const r1 = appendEvent(p, { type: 'task', payload: { taskId: 'T1b' } });
  const r2 = appendEvent(p, { type: 'task', payload: { taskId: 'T2' } });

  assert(keysOf(r1) === JSON.stringify(EVENT_KEYS), `補完後的欄位集合必須恰為 ${EVENT_KEYS.join('／')}（實際：${keysOf(r1)}）`);
  assert(r1?.v === 1, `沒給 v 時必須預設為 1（實際：${JSON.stringify(r1?.v)}）`);
  assert(typeof r1?.id === 'string' && r1.id.length > 0, `沒給 id 時必須自己生一個非空字串（實際：${JSON.stringify(r1?.id)}）`);
  // 由 E4 導出：自動生成的 id 若會相撞，兩筆正常事件會被當成重複而讓第二筆不生效
  assert(r1?.id !== r2?.id, `自動生成的 id 必須每筆不同（實際：${JSON.stringify(r1?.id)} vs ${JSON.stringify(r2?.id)}）`);
  assert((readEvents(p).duplicates ?? []).length === 0, `自動生成 id 的兩筆事件不得被判成重複（實際：${JSON.stringify(readEvents(p).duplicates)}）`);

  const lines = readFileSync(p, 'utf8').replace(/\n$/, '').split('\n');
  assert(stable(safeParse(lines[1])) === stable(r1), `補完後的事件必須就是寫進檔案那一行（檔內：${lines[1]}）`);
});

testCase('T1-13', 'appendEvent 必要欄位：缺 type 或 payload 非物件 ⇒ 拒絕並指名該欄位，且一個位元組都不得寫入', () => {
  const appendEvent = api('appendEvent');
  if (!appendEvent) return;
  const p = newLedgerPath('required-fields');
  appendEvent(p, ev({ id: 'evt-seed' }));
  const before = readFileSync(p, 'utf8');

  const noType = throwsWith(() => appendEvent(p, { payload: {} }), 'type');
  assert(noType.threw, `缺 type 必須被拒（實際：${noType.message}）`);
  assert(noType.matched, `缺 type 的錯誤訊息必須指名 type（實際：${noType.message}）`);

  const noPayload = throwsWith(() => appendEvent(p, { type: 'task' }), 'payload');
  assert(noPayload.threw, `缺 payload 必須被拒（實際：${noPayload.message}）`);
  assert(noPayload.matched, `缺 payload 的錯誤訊息必須指名 payload（實際：${noPayload.message}）`);

  const strPayload = throwsWith(() => appendEvent(p, { type: 'task', payload: 'not-an-object' }), 'payload');
  assert(strPayload.threw, `payload 是字串必須被拒（實際：${strPayload.message}）`);
  assert(strPayload.matched, `payload 非物件的錯誤訊息必須指名 payload（實際：${strPayload.message}）`);

  // typeof null === 'object'，所以只寫 typeof 檢查的實作會放行 null，之後讀 payload.status 才炸
  const nullPayload = throwsWith(() => appendEvent(p, { type: 'task', payload: null }), 'payload');
  assert(nullPayload.threw, `payload 是 null 必須被拒（typeof null === 'object'，只查 typeof 會放行）（實際：${nullPayload.message}）`);
  assert(nullPayload.matched, `payload 為 null 的錯誤訊息必須指名 payload（實際：${nullPayload.message}）`);

  assert(readFileSync(p, 'utf8') === before, '被拒絕的 append 一個位元組都不得寫進事件流');
});

// ══════════════════════════════════════════════════════════════════════════
// T2｜契約 1b：replay 的兩支 API 與四種損壞的確定性行為
// ══════════════════════════════════════════════════════════════════════════

testCase('T2-1', 'replayExact 遇未知 v ⇒ throw，且錯誤訊息指名版本號', () => {
  const replayExact = api('replayExact');
  if (!replayExact) return;
  const future = JSON.stringify({ v: 99, id: 'evt-future', seq: 2, type: 'stage-enter', payload: { nodeId: 'stage-x' } });
  const p = writeLines(newLedgerPath('unknown-version'), [headLine(1), future, headLine(3)]);
  const r = throwsWith(() => replayExact(p), '99');
  assert(r.threw, `未知版本必須丟例外，不得靜默略過（實際：${r.message}）`);
  assert(r.matched, `錯誤訊息必須指名版本號 99（實際：${r.message}）`);
});

testCase('T2-2', 'replayExact 遇非法 JSON ⇒ throw，且錯誤訊息指名行號', () => {
  const replayExact = api('replayExact');
  if (!replayExact) return;
  const lines = [];
  for (let n = 1; n <= 12; n += 1) lines.push(n === 7 ? '{"v":1,"id":"evt-BAD",' : headLine(n));
  const p = writeLines(newLedgerPath('bad-json'), lines);
  const r = throwsWith(() => replayExact(p), '7');
  assert(r.threw, `壞行必須丟例外（實際：${r.message}）`);
  assert(r.matched, `錯誤訊息必須指名行號 7（1-based，第 7 個物理行）（實際：${r.message}）`);
});

testCase('T2-3', 'replayExact 遇缺必要欄位 ⇒ throw，且指名行號', () => {
  const replayExact = api('replayExact');
  if (!replayExact) return;
  // 第 4 行：合法 JSON 但缺 id；第 9 行留給 decision 缺 status 的變體另測
  const lines = [];
  for (let n = 1; n <= 10; n += 1) {
    lines.push(n === 4 ? JSON.stringify({ v: 1, seq: 4, type: 'stage-enter', payload: { nodeId: 'stage-x' } }) : headLine(n));
  }
  const p = writeLines(newLedgerPath('missing-field'), lines);
  const r = throwsWith(() => replayExact(p), '4');
  assert(r.threw, `缺必要欄位（id）必須丟例外（實際：${r.message}）`);
  assert(r.matched, `錯誤訊息必須指名行號 4（實際：${r.message}）`);

  const lines2 = [headLine(1), headLine(2), JSON.stringify({ v: 1, id: 'evt-d', seq: 3, type: 'decision', payload: { nodeId: 'd-1' } }), headLine(4), headLine(5)];
  const p2 = writeLines(newLedgerPath('decision-no-status'), lines2);
  const r2 = throwsWith(() => replayExact(p2), '3');
  assert(r2.threw, `decision 缺 status 在 replay 時同樣必須丟例外（實際：${r2.message}）`);
  assert(r2.matched, `該錯誤訊息必須指名行號 3（實際：${r2.message}）`);
});

testCase('T2-4', 'replayPrefix 停在第一個無法處理的事件，回報 { complete:false, haltedAt:{ line, reason } }', () => {
  const replayPrefix = api('replayPrefix');
  if (!replayPrefix) return;
  const lines = [];
  for (let n = 1; n <= 12; n += 1) lines.push(n === 7 ? '{"v":1,"id":"evt-BAD",' : headLine(n));
  // 第 9 行也壞：用來證明「停在第一個」而不是「停在最後一個」
  lines[8] = '{"v":1,"id":"evt-BAD-2",';
  const p = writeLines(newLedgerPath('prefix-halt'), lines);
  const r = replayPrefix(p);

  assert(r && typeof r === 'object', `replayPrefix 必須回物件（實際：${JSON.stringify(r)}）`);
  assert(r?.complete === false, `有壞行時 complete 必須是 false（實際：${JSON.stringify(r?.complete)}）`);
  assert(r?.haltedAt != null, `haltedAt 不得是 null（實際：${JSON.stringify(r?.haltedAt)}）`);
  assert(r?.haltedAt?.line === 7, `必須停在第一個壞事件（第 7 行），不是第 9 行（實際：${JSON.stringify(r?.haltedAt?.line)}）`);
  assert(typeof r?.haltedAt?.reason === 'string' && r.haltedAt.reason.length > 0, `haltedAt.reason 必須是非空字串（實際：${JSON.stringify(r?.haltedAt?.reason)}）`);
  assert('state' in (r ?? {}), 'replayPrefix 必須回傳 state（前綴狀態本身是完全正確的歷史狀態）');
});

testCase('T2-5', 'replayPrefix 遇未知版本：haltedAt.version 指名該版本號', () => {
  const replayPrefix = api('replayPrefix');
  if (!replayPrefix) return;
  const future = JSON.stringify({ v: 99, id: 'evt-future', seq: 3, type: 'stage-enter', payload: { nodeId: 'stage-x' } });
  const p = writeLines(newLedgerPath('prefix-version'), [headLine(1), headLine(2), future, headLine(4)]);
  const r = replayPrefix(p);
  assert(r?.complete === false, `未知版本必須讓 complete === false（實際：${JSON.stringify(r?.complete)}）`);
  assert(r?.haltedAt?.line === 3, `haltedAt.line 必須是 3（實際：${JSON.stringify(r?.haltedAt?.line)}）`);
  assert(r?.haltedAt?.version === 99, `haltedAt.version 必須指名 99（實際：${JSON.stringify(r?.haltedAt?.version)}）`);
  assert(typeof r?.haltedAt?.reason === 'string' && r.haltedAt.reason.length > 0, `haltedAt.reason 必須是非空字串（實際：${JSON.stringify(r?.haltedAt?.reason)}）`);
});

testCase('T2-6', '1000 行、第 500 行壞掉：前綴狀態 == 只讀前 499 筆，且不含第 501–1000 筆的任何影響', () => {
  const replayPrefix = api('replayPrefix');
  const replayExact = api('replayExact');
  if (!replayPrefix || !replayExact) return;

  const healthy = buildThousandLines();
  const broken = healthy.slice();
  broken[499] = CORRUPT_LINE;

  const pBroken = writeLines(newLedgerPath('k-broken'), broken);
  const pFirst499 = writeLines(newLedgerPath('k-first499'), healthy.slice(0, 499));
  const pHealthy = writeLines(newLedgerPath('k-healthy'), healthy);

  const prefixState = replayPrefix(pBroken)?.state;
  const only499 = replayExact(pFirst499);
  const full1000 = replayExact(pHealthy);

  assert(
    stable(prefixState) === stable(only499),
    `前綴狀態必須逐項等於「只讀前 499 筆」的狀態（差異欄位 → ${diffKeys(prefixState, only499)}）`,
  );
  assert(
    stable(prefixState) !== stable(full1000),
    '前綴狀態必須不等於「1000 筆全健康」的狀態（相等 ⇒ 實作跳過壞行續讀，重建出中間有洞的狀態）',
  );
  // 標記探針：先證明探針有鑑別力（健康全流的狀態確實含 TAIL 標記），再斷言前綴狀態不含
  assert(stable(full1000).includes('TAIL-'), '探針有效性：1000 筆全健康的狀態必須含 TAIL 標記（否則下一條斷言是空轉）');
  assert(!stable(prefixState).includes('TAIL-'), '前綴狀態不得含任何 TAIL 標記（第 501–1000 筆一律不得生效）');
  assert(!stable(prefixState).includes('MID-500'), '前綴狀態不得含第 500 行（壞行）本身的影響');
});

testCase('T2-7', '同一份 1000 行壞流：haltedAt.line === 500 且 complete === false', () => {
  const replayPrefix = api('replayPrefix');
  if (!replayPrefix) return;
  const broken = buildThousandLines();
  broken[499] = CORRUPT_LINE;
  const p = writeLines(newLedgerPath('k-halt'), broken);
  const r = replayPrefix(p);
  assert(r?.complete === false, `complete 必須是 false（實際：${JSON.stringify(r?.complete)}）`);
  assert(r?.haltedAt?.line === 500, `haltedAt.line 必須是 500（實際：${JSON.stringify(r?.haltedAt?.line)}）`);
  assert(typeof r?.haltedAt?.reason === 'string' && r.haltedAt.reason.length > 0, `haltedAt.reason 必須是非空字串（實際：${JSON.stringify(r?.haltedAt?.reason)}）`);
});

testCase('T2-8', '反向：健康事件流 ⇒ complete === true 且 haltedAt === null（殺掉「恆回 incomplete」的實作）', () => {
  const replayPrefix = api('replayPrefix');
  if (!replayPrefix) return;
  const p = writeLines(newLedgerPath('prefix-healthy'), buildThousandLines());
  const r = replayPrefix(p);
  assert(r?.complete === true, `健康流必須回 complete === true（實際：${JSON.stringify(r?.complete)}）`);
  assert(r?.haltedAt === null, `健康流必須回 haltedAt === null（實際：${JSON.stringify(r?.haltedAt)}）`);
});

testCase('T2-9', '反向：健康事件流 ⇒ replayExact 不丟例外，且與 replayPrefix.state 相同（殺掉「恆 throw」的實作）', () => {
  const replayExact = api('replayExact');
  const replayPrefix = api('replayPrefix');
  if (!replayExact || !replayPrefix) return;
  const p = writeLines(newLedgerPath('exact-healthy'), buildThousandLines());
  const r = throwsWith(() => replayExact(p), '');
  assert(!r.threw, `健康流不得丟例外（實際：${r.message}）`);
  if (r.threw) return;
  assert(stable(replayExact(p)) === stable(replayPrefix(p).state), '健康流下兩支 API 必須得到相同狀態');
});

testCase('T2-10', '重複 id ⇒ 冪等：狀態與只出現一次相同', () => {
  const replayExact = api('replayExact');
  if (!replayExact) return;
  const dup = JSON.stringify({ v: 1, id: 'evt-dup', seq: 2, type: 'decision', payload: { nodeId: 'd-1', status: 'pending', note: 'DUP' } });
  const pOnce = writeLines(newLedgerPath('dup-once'), [headLine(1), dup, headLine(3)]);
  const pTwice = writeLines(newLedgerPath('dup-twice'), [headLine(1), dup, dup, headLine(3)]);
  const once = throwsWith(() => replayExact(pOnce), '');
  const twice = throwsWith(() => replayExact(pTwice), '');
  assert(!once.threw, `無重複的流不得丟例外（實際：${once.message}）`);
  assert(!twice.threw, `含重複 id 的流不得丟例外——重複是冪等處理，不是壞行（實際：${twice.message}）`);
  if (once.threw || twice.threw) return;
  assert(stable(replayExact(pTwice)) === stable(replayExact(pOnce)), '重複 id 出現兩次的狀態必須等於只出現一次的狀態');
});

testCase('T2-11', '重複 id ⇒ readEvents 的 duplicates 回報偵測到重複', () => {
  const readEvents = api('readEvents');
  if (!readEvents) return;
  const dup = JSON.stringify({ v: 1, id: 'evt-dup', seq: 2, type: 'stage-enter', payload: { nodeId: 'stage-x' } });
  const p = writeLines(newLedgerPath('dup-report'), [headLine(1), dup, headLine(3), dup]);
  const r = readEvents(p);
  assert(Array.isArray(r?.duplicates), `duplicates 必須是陣列（實際：${JSON.stringify(r?.duplicates)}）`);
  assert((r?.duplicates?.length ?? 0) >= 1, `偵測到的重複必須被回報（實際：${JSON.stringify(r?.duplicates)}）`);
  assert(JSON.stringify(r?.duplicates ?? []).includes('evt-dup'), `duplicates 必須指名重複的 id evt-dup（實際：${JSON.stringify(r?.duplicates)}）`);
});

testCase('T2-12', '反向：沒有重複時 duplicates 為空（殺掉「恆報重複」的實作）', () => {
  const readEvents = api('readEvents');
  if (!readEvents) return;
  const p = writeLines(newLedgerPath('dup-none'), [headLine(1), headLine(2), headLine(3)]);
  const r = readEvents(p);
  assert(Array.isArray(r?.duplicates), `duplicates 必須是陣列（實際：${JSON.stringify(r?.duplicates)}）`);
  assert((r?.duplicates?.length ?? -1) === 0, `無重複時 duplicates 必須是空陣列（實際：${JSON.stringify(r?.duplicates)}）`);
});

testCase('T2-13', 'replayExact 遇兩個壞行 ⇒ 停在最早那個（不得跳過續讀）', () => {
  const replayExact = api('replayExact');
  const replayPrefix = api('replayPrefix');
  if (!replayExact || !replayPrefix) return;
  const p = writeLines(newLedgerPath('two-bad'), [
    headLine(1),
    '壞行甲',
    headLine(3),
    '壞行乙',
    headLine(5),
  ]);
  const r = throwsWith(() => replayExact(p), '2');
  assert(r.threw, `有壞行必須丟例外（實際：${r.message}）`);
  assert(r.matched, `錯誤訊息必須指名最早的壞行行號 2（實際：${r.message}）`);
  assert(!/行\s*4|line\s*4/i.test(r.message), `不得指名第 4 行——那代表跳過了第 2 行繼續讀（實際：${r.message}）`);
  // 非啟發式的同義斷言：同一份檔的 prefix 版必須也停在第 2 行
  assert(replayPrefix(p)?.haltedAt?.line === 2, `replayPrefix 對同一份檔必須停在第 2 行（實際：${JSON.stringify(replayPrefix(p)?.haltedAt?.line)}）`);
});

testCase('T2-14', '殘骸尾行不算 halt：replayPrefix 仍回 complete === true，state 等於不含殘骸的 state', () => {
  const replayPrefix = api('replayPrefix');
  const replayExact = api('replayExact');
  if (!replayPrefix || !replayExact) return;
  // 殘骸 ≠ 壞事件：殘骸是「寫到一半被中斷」，丟掉之後前面全都完好；
  // 壞事件是「這筆內容不合法」，之後都不能算數。把殘骸當 halt，會讓一條完全健康、
  // 只是中斷過一次寫入的事件流被誤判成不完整。
  const good = [headLine(1), headLine(2), headLine(3)];
  const p = writeLines(newLedgerPath('residue'), good);
  appendFileSync(p, '{"v":1,"id":"evt-RESIDUE","seq":4,"type":"ta');

  const r = replayPrefix(p);
  const want = replayExact(writeLines(newLedgerPath('residue-ref'), good));
  assert(r?.complete === true, `殘骸尾行是「已定義的丟棄」而非 halt ⇒ complete 仍必須是 true（實際：${JSON.stringify(r?.complete)}）`);
  assert(r?.haltedAt === null, `haltedAt 仍必須是 null（實際：${JSON.stringify(r?.haltedAt)}）`);
  assert(stable(r?.state) === stable(want), `state 必須等於「不含殘骸尾行」的 state（差異欄位 → ${diffKeys(r?.state, want)}）`);
  assert(!stable(r?.state).includes('RESIDUE'), 'state 不得含殘骸尾行的任何影響');

  // 平行推論（R1）：gate 走 replayExact，若它因一次中斷寫入就丟例外，那條 loop 會永久磚化
  const ex = throwsWith(() => replayExact(p), '');
  assert(!ex.threw, `replayExact 同樣不得因殘骸尾行而丟例外（實際：${ex.message}）`);
  if (!ex.threw) assert(stable(replayExact(p)) === stable(want), `replayExact 對殘骸檔的狀態也必須等於「不含殘骸尾行」的 state（差異欄位 → ${diffKeys(replayExact(p), want)}）`);
});

// ══════════════════════════════════════════════════════════════════════════
// H-9｜跑完後的落點稽查（註冊在最後，所以在所有 T1/T2 之後執行）
// ══════════════════════════════════════════════════════════════════════════

testCase('H-9', '跑完後 worktree 底下的 .loops/ 集合與跑之前完全相同（本測試不得寫出任何 .loops）', () => {
  const after = scanLoopsDirs(WORKTREE_ROOT);
  const added = after.filter((p) => !LOOPS_BEFORE.includes(p));
  console.log(`  · 跑之前既有的 .loops/（committed fixture）共 ${LOOPS_BEFORE.length} 個`);
  assert(added.length === 0, `本測試不得在 worktree 底下新增任何 .loops/（新增：${JSON.stringify(added)}）`);
  assert(after.length === LOOPS_BEFORE.length, `.loops/ 總數必須不變（前 ${LOOPS_BEFORE.length} → 後 ${after.length}）`);
  assert(!LOOPS_BEFORE.includes('.loops') && !after.includes('.loops'), 'worktree 根目錄不得有 .loops/（.loops 一律落在主 repo）');
  assert(existsSync(TMP_ROOT) && statSync(TMP_ROOT).isDirectory(), '測試暫存目錄應仍在 os.tmpdir() 底下（跑完由 harness 清掉）');
});

// ══════════════════════════════════════════════════════════════════════════
const opts = parseArgs(process.argv.slice(2));
const selected = cases.filter((c) => matchesFilter(c.id, opts.filter));

for (const c of selected) {
  console.log(`\n[${c.id}] ${c.name}`);
  try {
    c.fn();
  } catch (err) {
    const msg = `[${c.id}] 未預期例外（case 本身炸了，不是斷言失敗）：${err?.stack ?? err}`;
    failed.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

console.log(`\n${selected.length} cases run, ${passed} passed, ${failed.length} failed`);

try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* 清理失敗不影響判定 */ }

if (opts.minCases > 0 && selected.length < opts.minCases) {
  console.error(`\n✗ case 數地板未達成：--min-cases ${opts.minCases}，實際跑到 ${selected.length}（filter="${opts.filter}"）`);
  process.exit(1);
}

if (failed.length > 0) {
  if (!mod) {
    console.error(`\n⚠ 受測模組 ${MODULE_PATH} 載入失敗（${modError?.code ?? modError?.message}）——`);
    console.error('  所有 T1/T2 的紅都源自於此。H-* 若全綠，代表 harness 本身可用。');
  }
  console.error('\n失敗清單：');
  for (const msg of failed) console.error(`  - ${msg}`);
  process.exit(1);
}
process.exit(0);
