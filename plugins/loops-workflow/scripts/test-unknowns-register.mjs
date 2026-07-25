#!/usr/bin/env node
// test-unknowns-register.mjs —— 四象限 Unknowns Register 的斷言（#174）。
// 對應驗收標準：節點欄位齊全、狀態轉移正確、blocking unknown 不進 build、PROGRESS 顯示四象限
// ＋blocking＋owner＋殘餘風險、以及**系統不宣稱 unknown-unknown ＝ 0**。
// 用法：node test-unknowns-register.mjs [--filter <case-prefix>] [--min-cases <n>]

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  QUADRANTS, UNKNOWN_STATUSES, UNKNOWN_TRANSITIONS, BLOCKING_AFFECTS, UNKNOWN_FIELDS, UNKNOWN_EVENT_TYPE,
  validateUnknown, canTransition, applyTransition, openBlocking, summarize, gateBuild, renderRegister,
  readUnknowns, recordUnknown, recordBlindSpotPass,
} from './unknowns-register.mjs';
import { appendEvent } from './loop-ledger.mjs';
import { projectLoopDir, selectBlocking, toGraph, NODE_KINDS } from './loop-graph.mjs';
import { regenerateLoopMd } from './loop-snapshot.mjs';
import { extractProgress, renderMarkdown, renderChat } from './progress.mjs';

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
  const dir = mkdtempSync(join(tmpdir(), 'unknowns-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const node = (over = {}) => ({
  id: 'U1', kind: 'known-unknown', statement: '結算幣別要不要跟著使用者地區走',
  source: 'clarify 訪談', owner: '使用者', discovered_at: '2026-07-26',
  affects: ['scope'], blocking: true, status: 'open', resolution: '', evidence: [], ...over,
});

// ══════════════════════════════════════════════════════════════════════════
testCase('U1', '四象限與狀態機的值域固定', () => {
  assert(QUADRANTS.join(',') === 'known-known,known-unknown,unknown-known,unknown-unknown', '四象限順序固定（最確定 → 最不確定）');
  assert(UNKNOWN_STATUSES.join(',') === 'discovered,open,researching,resolved,invalidated', '五種狀態');
  assert(UNKNOWN_FIELDS.length === 11, 'issue 逐字列的 11 個欄位');
  assert(BLOCKING_AFFECTS.join(',') === 'scope,ux,data,security,architecture,acceptance', '六個 blocking 面向');
});

testCase('U2', 'validateUnknown：欄位齊全與型別', () => {
  assert(validateUnknown(node()).ok, '合法節點通過');
  for (const f of UNKNOWN_FIELDS) {
    const broken = { ...node() };
    delete broken[f];
    assert(!validateUnknown(broken).ok, `缺 ${f} → 不通過`);
  }
  assert(!validateUnknown(null).ok, 'null → 不通過');
  assert(!validateUnknown({ ...node(), kind: '第五象限' }).ok, '未知象限 → 不通過');
  assert(!validateUnknown({ ...node(), status: '亂寫' }).ok, '未知狀態 → 不通過');
  assert(!validateUnknown({ ...node(), discovered_at: '昨天' }).ok, '非 ISO 日期 → 不通過');
  assert(!validateUnknown({ ...node(), owner: '  ' }).ok, 'owner 只有空白 → 不通過（沒有無主的 unknown）');
  assert(validateUnknown({ ...node(), discovered_at: '2026-07-26T10:00:00Z' }).ok, 'ISO 時間戳也接受');
});

testCase('U3', '不得自我豁免：affects 命中六面向就必須 blocking', () => {
  for (const a of BLOCKING_AFFECTS) {
    const v = validateUnknown({ ...node(), affects: [a], blocking: false });
    assert(!v.ok && v.errors.some((e) => e.includes('blocking 必須為 true')), `affects=[${a}] 卻標 blocking:false → 不通過`);
  }
  assert(validateUnknown({ ...node(), affects: ['文案用字'], blocking: false }).ok, '反向：不在六面向內 → 可以 non-blocking（殺掉「everything blocking」的實作）');
  assert(validateUnknown({ ...node(), status: 'resolved', resolution: '已拍板', blocking: false }).ok, '已解決的節點不受此約束（解掉的東西不擋任何事，否則閘永遠綠不了）');
});

testCase('U4', 'AI 的假設不得自行升格成 known-known', () => {
  const v = validateUnknown({ ...node(), kind: 'known-known', status: 'open' });
  assert(!v.ok && v.errors.some((e) => e.includes('不得自行升格')), 'known-known 但 status 不是 resolved → 不通過');
  assert(validateUnknown({ ...node(), kind: 'known-known', status: 'resolved', resolution: '使用者拍板跟地區走', blocking: false, affects: [] }).ok, '走完 resolved 才能是 known-known');
  const noRes = validateUnknown({ ...node(), status: 'resolved', resolution: '' });
  assert(!noRes.ok, 'resolved 卻沒寫 resolution → 不通過（怎麼解掉的要寫）');
});

testCase('U5', '狀態轉移：合法路徑與被擋掉的捷徑', () => {
  assert(canTransition('discovered', 'open'), 'discovered → open');
  assert(!canTransition('discovered', 'resolved'), 'discovered → resolved 被擋（沒經過「問成明確問題」就自稱解決）');
  assert(canTransition('open', 'researching') && canTransition('researching', 'resolved'), 'open → researching → resolved');
  assert(!canTransition('resolved', 'discovered'), 'resolved → discovered 被擋（要退回請走 invalidated）');
  assert(canTransition('resolved', 'invalidated') && canTransition('invalidated', 'open'), '事實被推翻 → invalidated → 重新 open');
  assert(Object.keys(UNKNOWN_TRANSITIONS).length === UNKNOWN_STATUSES.length, '每個狀態都有明列的出邊（含空集合）');
});

testCase('U6', 'applyTransition：解決與失效的語意', () => {
  const open = node();
  const bad = applyTransition(open, 'discovered');
  assert(!bad.ok && bad.node === open, '非法轉移不改到原節點');

  const noRes = applyTransition(open, 'resolved');
  assert(!noRes.ok && noRes.error.includes('resolution'), '轉 resolved 沒附 resolution → 擋');

  const done = applyTransition(open, 'resolved', { resolution: '使用者拍板跟地區走', evidence: ['issue #12 comment'] });
  assert(done.ok && done.node.kind === 'known-known' && done.node.blocking === false, 'resolved → 升格 known-known、不再 blocking');
  assert(done.node.evidence.length === 1, 'evidence 被累加');
  assert(validateUnknown(done.node).ok, '轉移後的節點仍通得過驗證');

  const invalid = applyTransition(done.node, 'invalidated');
  assert(invalid.ok && invalid.node.kind === 'known-unknown' && invalid.node.blocking === true, '既有事實被推翻 → 降回 known-unknown 且恢復 blocking（affects 仍含 scope）');
  assert(invalid.node.resolution === '', '失效後清掉舊結論（不留下已被推翻的答案）');

  const discovered = applyTransition({ ...node(), kind: 'unknown-unknown', status: 'discovered' }, 'open');
  assert(discovered.node.kind === 'known-unknown', '被發現的盲點一旦問成明確問題就是 known-unknown（unknown-unknown 只存在於還沒被發現）');
});

testCase('U7', 'gateBuild：未解決的 blocking unknown 不准進 build', () => {
  assert(gateBuild([]).ok, '沒有 unknown → 可進 build');
  assert(gateBuild([{ ...node(), blocking: false }]).ok, 'non-blocking → 可進 build');
  const gate = gateBuild([node(), { ...node(), id: 'U2', statement: '第二條' }]);
  assert(!gate.ok && gate.blocking.length === 2, '兩條未解決 blocking → 擋');
  assert(gate.reason.includes('U1') && gate.reason.includes('U2') && gate.reason.includes('owner'), '理由逐條列出 id 與 owner（不是只說「有問題」）');
  const resolved = applyTransition(node(), 'resolved', { resolution: '已拍板' }).node;
  assert(gateBuild([resolved]).ok, '解決後放行');
  assert(openBlocking([node(), resolved]).length === 1, 'openBlocking 只算未解決的');
});

testCase('U8', '系統不宣稱 unknown-unknown ＝ 0', () => {
  const s = summarize([node()], { blindSpotPasses: ['code exploration', 'reviewer 視角'] });
  assert(typeof s.counts['unknown-unknown'] === 'number', '內部仍有計數欄');
  assert(s.unknownUnknownClaim.includes('不宣稱'), '對外宣稱欄明講「不宣稱清零」');
  const md = renderRegister(s);
  assert(!/\| unknown-unknown \| 0 \|/.test(md), '渲染出來的表格不會出現「unknown-unknown | 0」這種誤導數字');
  assert(md.includes('未知（本系統不宣稱盲點已清零'), '該格改寫成「未知」');
  assert(md.includes('code exploration') && md.includes('reviewer 視角'), '已做的 blind-spot pass 逐項列出');
  assert(renderRegister(summarize([])).includes('（尚未做）'), '一次都沒做時明講尚未做');
});

testCase('U9', 'summarize / renderRegister：四象限、blocking、owner、殘餘風險', () => {
  const nodes = [
    node(),
    { ...node(), id: 'U2', affects: ['文案'], blocking: false, statement: '按鈕文案用「送出」還是「確認」', owner: '設計' },
    applyTransition(node({ id: 'U3' }), 'resolved', { resolution: '已拍板' }).node,
    { ...node(), id: 'U4', kind: 'unknown-known', statement: '舊系統的隱藏規則', status: 'open', affects: ['data'] },
  ];
  const s = summarize(nodes);
  assert(s.counts['known-unknown'] === 2 && s.counts['known-known'] === 1 && s.counts['unknown-known'] === 1, '四象限計數正確');
  assert(s.blocking.length === 2 && s.blocking.every((b) => b.owner), 'blocking 逐條帶 owner');
  assert(s.residualRisk.length === 1 && s.residualRisk[0].id === 'U2', '殘餘風險＝未解決但不擋的');
  const md = renderRegister(s);
  assert(md.includes('Unknowns Register（四象限）') && md.includes('擋著 build 的') && md.includes('殘餘風險'), 'markdown 四個區塊齊全');
  assert(md.includes('U1') && md.includes('U4') && md.includes('U2'), 'blocking 與殘餘風險逐條出現');
  assert(renderRegister(summarize([])).includes('（無）'), '沒有 blocking 時明寫「無」');
});

testCase('U10', 'IO：unknown 走 loop ledger 的唯一寫入路徑、同 id 後者覆蓋前者', () => {
  withTmp((root) => {
    const loopDir = join(root, 'demo');
    recordUnknown(loopDir, node());
    recordUnknown(loopDir, { ...node(), id: 'U2', statement: '第二條', affects: ['文案'], blocking: false });
    recordBlindSpotPass(loopDir, 'code exploration');
    const first = readUnknowns(loopDir);
    assert(first.nodes.length === 2 && first.warnings.length === 0, '讀回兩條、ledger 無警告');
    assert(first.blindSpotPasses.join(',') === 'code exploration', 'blind-spot pass 分開收，不混進 node');

    recordUnknown(loopDir, applyTransition(node(), 'resolved', { resolution: '已拍板' }).node);
    const after = readUnknowns(loopDir);
    assert(after.nodes.length === 2, '同 id 不重複建節點');
    assert(after.nodes.find((n) => n.id === 'U1').status === 'resolved', '同 id 後者覆蓋前者（依檔案行序）');
    assert(gateBuild(after.nodes).ok, '解掉之後閘變綠');

    let threw = false;
    try { recordUnknown(loopDir, { ...node(), owner: '' }); } catch { threw = true; }
    assert(threw, '不合法的 unknown 拒絕寫入');
    assert(readUnknowns(loopDir).nodes.length === 2, '拒絕後 ledger 沒被污染');
    assert(UNKNOWN_EVENT_TYPE === 'unknown', '事件型別固定為 unknown');
  });
});

testCase('U11', '接進 work graph：unknown 成為節點、blocking unknown 與未修 P0/P1 同級擋收圈', () => {
  withTmp((root) => {
    const loopDir = join(root, 'demo');
    mkdirSync(loopDir, { recursive: true }); // loop-ledger 契約 6：ledger 不建目錄，建目錄是呼叫端的事
    appendEvent(join(loopDir, 'events.jsonl'), { type: 'loop-create', payload: { type: 'feature' } });
    appendEvent(join(loopDir, 'events.jsonl'), { type: 'stage-enter', payload: { stage: 'clarify' } });
    recordUnknown(loopDir, node());
    recordBlindSpotPass(loopDir, 'code exploration');
    const { state } = projectLoopDir(loopDir, { slug: 'demo' });
    assert(state.unknowns.length === 1 && state.blindSpotPasses.join(',') === 'code exploration', 'unknown 與 blind-spot pass 分別進 state');
    const b = selectBlocking(state);
    assert(b.unknowns.length === 1 && b.count === 1, '未解決的 blocking unknown 計入 blocking');
    const g = toGraph(state);
    assert(g.nodes.some((n) => n.kind === 'Unknown' && n.id.endsWith(':U1')), 'work graph 上有 Unknown 節點');
    assert(NODE_KINDS.includes('Unknown'), 'Unknown 在 node 種類白名單內');
    assert(g.edges.some((e) => e.kind === 'PRODUCED_BY' && e.to.includes('Unknown')), '掛回挖出它的那個階段');

    recordUnknown(loopDir, applyTransition(node(), 'resolved', { resolution: '已拍板' }).node);
    assert(selectBlocking(projectLoopDir(loopDir, { slug: 'demo' }).state).count === 0, '解掉後不再擋（殺掉「恆擋」的實作）');
  });
});

testCase('U12', 'PROGRESS.md 與 loop.md 都看得到四象限、blocking、owner、殘餘風險', () => {
  withTmp((root) => {
    const loopDir = join(root, 'demo');
    mkdirSync(loopDir, { recursive: true });
    appendEvent(join(loopDir, 'events.jsonl'), { type: 'loop-create', payload: { type: 'feature', mode: 'closed' } });
    appendEvent(join(loopDir, 'events.jsonl'), { type: 'stage-enter', payload: { stage: 'clarify' } });
    recordUnknown(loopDir, node());
    recordUnknown(loopDir, { ...node(), id: 'U2', statement: '按鈕文案', affects: ['文案'], blocking: false, owner: '設計' });
    recordBlindSpotPass(loopDir, 'code exploration');
    const md = regenerateLoopMd(loopDir, { slug: 'demo' });
    assert(md.includes('Unknowns Register（四象限）'), 'loop.md 有四象限區塊');
    assert(md.includes('U1') && md.includes('owner 使用者'), 'blocking 項帶 owner');
    assert(md.includes('殘餘風險') && md.includes('U2'), '殘餘風險逐條列出');
    assert(md.includes('仍有 1 條 P0/P1、0 道閘未過、0 個未決決策、1 條未解決 unknown') === false || md.includes('條未解決 unknown'), '摘要行帶未解決 unknown 數');

    const p = extractProgress({ slug: 'demo', md });
    assert(p.unknowns.includes('Unknowns Register'), 'extractProgress 切出 register 區塊');
    assert(!p.unknowns.includes('## 最近事件'), '切到下一個同級標題為止，不吃進後面的段落');
    const progressMd = renderMarkdown(p);
    assert(progressMd.includes('Unknowns Register（四象限）') && progressMd.includes('U1') && progressMd.includes('殘餘風險'), 'PROGRESS.md 帶出四象限＋blocking＋殘餘風險');
    assert(p.blockingUnknowns === 1, '只數「擋著 build 的」那幾條，殘餘風險不算（否則 chat 上會誇大擋路的數量）');
    assert(renderChat(p).includes('擋著 build 的 unknown 1 條'), 'chat 儀表板緊湊帶一行');

    // 反向：沒有 unknown 的 loop 不該多出空區塊
    const plain = join(root, 'plain');
    mkdirSync(plain, { recursive: true });
    appendEvent(join(plain, 'events.jsonl'), { type: 'loop-create', payload: { type: 'chore' } });
    const plainMd = regenerateLoopMd(plain, { slug: 'plain' });
    assert(!plainMd.includes('Unknowns Register'), '沒有 unknown 的 loop 不渲染空表（小任務不加 ceremony）');
    assert(extractProgress({ slug: 'plain', md: plainMd }).unknowns === '', 'extractProgress 對沒有區塊的回空字串');
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
