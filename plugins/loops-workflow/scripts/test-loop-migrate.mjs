#!/usr/bin/env node
// test-loop-migrate.mjs —— 既有 .loops 遷移到 event ledger 的斷言（#172 AC-6）。
// 重點：① 舊 Journal 每一行都可追溯；② 拒絕寫進 linked worktree；③ **真實歷史 loop 跑得過**
// ——輸入用 `fixtures/loop-memory/real-loops/` 底下四條 loop.md 的**逐字快照**（見該目錄 README：
// 逐字才鎖得住現實），外加 `evals/baseline/fixtures/loop-243-*` 這條更舊的歷史 loop。
// 用法：node test-loop-migrate.mjs [--filter <case-prefix>] [--min-cases <n>]

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readEvents } from './loop-ledger.mjs';
import { projectEvents } from './loop-graph.mjs';
import { parseLegacyLoopMd, legacyEventSpecs, diffTraceability, migrateLoopDir, listLegacyLoops, isInsideLinkedWorktree } from './loop-migrate.mjs';
import { currentStage, journalEntries, pickLoopField } from './loops-scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_LOOPS = join(HERE, 'fixtures', 'loop-memory', 'real-loops');
// 註：這份 243 corpus 的檔頭自陳「已重排格式、非逐字複製」，因此只當**次要**證據
// （它證明更舊、更大規模的 loop 也解析得動），主要證據是上面四條逐字快照。
const CORPUS_243 = join(HERE, '..', 'evals', 'baseline', 'fixtures', 'loop-243-show-subfolder-contents', 'observed-journal.md');

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
  const dir = mkdtempSync(join(tmpdir(), 'loop-migrate-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const LEGACY_MD = `# loop: 300-demo

| 欄位 | 值 |
|---|---|
| 類型 | feature |
| operation | add |
| 推進模式 | closed |
| 當前階段 | verify |
| 停止條件 | 全綠 |
| session | S123 |

## Journal

- [E1] 進入 goal，抽出六欄 DoD
- [E2] 進入 explore，派 3 個平行掃描
- [E3] 進入 build，任務 T1 紅→綠
- [E4] 進入 verify，8 reviewer，Not Ready
- [E5] 回環 #1 修 3 條 P1
`;

/** 在 tmp 建一個 legacy loop 目錄。 */
function makeLegacyLoop(root, slug, md) {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'loop.md'), md, 'utf8');
  return dir;
}

// ══════════════════════════════════════════════════════════════════════════
testCase('M1', 'parseLegacyLoopMd：欄位表與兩種 Journal 行格式都吃', () => {
  const p = parseLegacyLoopMd(LEGACY_MD);
  assert(p.fields.type === 'feature' && p.fields.mode === 'closed' && p.fields.session === 'S123', '欄位表解析正確');
  assert(p.journal.length === 5, '5 行 Journal 都抓到');
  assert(p.journal[0].stage === 'goal' && p.journal[3].stage === 'verify', '由「進入 X」推斷 stage');
  assert(p.journal[4].round === 1, '由「回環 #1」推斷 round');
  assert(p.journal.every((j) => j.raw.startsWith('- ')), 'raw 保留逐字原文');

  const altFormat = parseLegacyLoopMd('- E7 [verify] 部分，spend limit 中斷\n- E9 [iterate] round 1 修 7 真缺口');
  assert(altFormat.journal.length === 2, '`- E7 [verify] …` 這種舊格式也吃');
  assert(altFormat.journal[0].stage === 'verify' && altFormat.journal[1].stage === 'iterate', '`[stage]` 標記被辨識');
  assert(altFormat.journal[1].round === 1, '`round 1` 也算回環');
  assert(parseLegacyLoopMd('').journal.length === 0, '空輸入不丟例外');
});

testCase('M2', 'legacyEventSpecs：每行 Journal 都有帶原文的事件，推斷不覆蓋原文', () => {
  const p = parseLegacyLoopMd(LEGACY_MD);
  const specs = legacyEventSpecs('300-demo', p);
  assert(specs[0].type === 'loop-create', '首筆是 loop-create');
  assert(specs.some((s) => s.type === 'issue' && s.payload.number === 300), 'slug 前綴的數字被當成 issue 編號');
  for (const j of p.journal) {
    assert(specs.some((s) => s.type === 'note' && s.payload.legacy === j.raw), `「${j.raw.slice(0, 18)}…」有對應的 note（原文逐字保留）`);
  }
  assert(specs.filter((s) => s.type === 'stage-enter').length === 4, '推斷出 4 次階段進入');
  assert(specs.filter((s) => s.type === 'round').length === 1, '推斷出 1 次回環');
  assert(specs.every((s) => !('v' in s) && !('id' in s) && !('seq' in s)), 'specs 不自己配 v/id/seq——那是 ledger 的職責（唯一寫入路徑）');
});

testCase('M3', 'diffTraceability：漏一行就判失敗（追溯性是機械驗證、不是肉眼）', () => {
  const p = parseLegacyLoopMd(LEGACY_MD);
  const full = legacyEventSpecs('300-demo', p);
  assert(diffTraceability(p, full).ok, '完整遷移 → 追溯性通過');
  // 一行 Journal 可能同時產出 stage-enter / round / note（都帶同一份原文），
  // 所以「掉了這一行」要把帶該原文的事件全數拿掉才模擬得準。
  const lossy = full.filter((s) => s.payload.legacy !== p.journal[2].raw);
  const bad = diffTraceability(p, lossy);
  assert(!bad.ok && bad.missing.length === 1 && bad.missing[0] === p.journal[2].raw, '刻意漏掉一行 → 判失敗並指名是哪一行');
  assert(full.filter((s) => s.payload.legacy === p.journal[2].raw).length >= 2, '同一行產出的多筆事件都帶原文（任一筆存活即追溯得到，冗餘是刻意的）');
});

testCase('M4', '安全邊界：拒絕遷移落在 linked worktree 的目錄', () => {
  assert(isInsideLinkedWorktree('/repo/.claude/worktrees/172-x/.loops/demo'), 'worktree 路徑被認出來');
  assert(isInsideLinkedWorktree('C:\\repo\\.claude\\worktrees\\172-x\\.loops\\demo'), 'Windows 反斜線路徑也認得');
  assert(!isInsideLinkedWorktree('/repo/.loops/demo'), '主 repo 的 .loops 不誤判');
  assert(!isInsideLinkedWorktree('/repo/.claude/settings.json'), '.claude 底下非 worktrees 的路徑不誤判');
  withTmp((dir) => {
    const fake = join(dir, '.claude', 'worktrees', '172-x', '.loops', 'demo');
    makeLegacyLoop(join(dir, '.claude', 'worktrees', '172-x', '.loops'), 'demo', LEGACY_MD);
    const r = migrateLoopDir(fake);
    assert(!r.ok && r.reason.includes('linked worktree'), '落在 worktree → 拒絕遷移（AGENTS 規則 9）');
    assert(!existsSync(join(fake, 'events.jsonl')), '拒絕時沒有留下半套產物');
  });
});

testCase('M5', '安全邊界：已有 ledger 時預設不覆蓋，--force 才重來；舊檔一律留痕', () => {
  withTmp((dir) => {
    const loopDir = makeLegacyLoop(dir, '300-demo', LEGACY_MD);
    const first = migrateLoopDir(loopDir);
    assert(first.ok && first.events > 0, '第一次遷移成功');
    assert(existsSync(join(loopDir, 'loop.md.legacy')), '舊 loop.md 另存 .legacy（遷移前內容永遠可查）');
    assert(readFileSync(join(loopDir, 'loop.md.legacy'), 'utf8') === LEGACY_MD, '.legacy 逐字等於原檔');

    writeFileSync(join(loopDir, 'loop.md'), LEGACY_MD, 'utf8'); // 模擬又有人手寫了一份
    const second = migrateLoopDir(loopDir);
    assert(!second.ok && second.reason.includes('--force'), '已有 ledger → 預設拒絕、指路 --force');
    assert(migrateLoopDir(loopDir, { force: true }).ok, '--force 才重來');
  });
});

testCase('M6', 'dry-run 不寫檔、listLegacyLoops 只挑還沒遷的', () => {
  withTmp((dir) => {
    const loopDir = makeLegacyLoop(dir, '300-demo', LEGACY_MD);
    makeLegacyLoop(dir, '301-other', LEGACY_MD);
    assert(listLegacyLoops(dir).length === 2, '兩條 legacy loop 都被列出');
    const dry = migrateLoopDir(loopDir, { dryRun: true });
    assert(dry.ok && dry.dryRun && !existsSync(join(loopDir, 'events.jsonl')), 'dry-run 判得出結果但不寫檔');
    migrateLoopDir(loopDir);
    assert(listLegacyLoops(dir).map((l) => l.slug).join(',') === '301-other', '遷過的不再出現在待遷清單');
    assert(listLegacyLoops(join(dir, '不存在')).length === 0, '目錄不存在 → 空清單、不丟');
  });
});

testCase('M7', '遷移後 loop.md 由 ledger 重生、且仍被既有解析器讀得懂', () => {
  withTmp((dir) => {
    const loopDir = makeLegacyLoop(dir, '300-demo', LEGACY_MD);
    migrateLoopDir(loopDir);
    const md = readFileSync(join(loopDir, 'loop.md'), 'utf8');
    assert(md.includes('generated snapshot'), '重生的 loop.md 標明是 generated');
    assert(pickLoopField(md, '類型') === 'feature', '欄位在遷移後仍讀得到');
    assert(currentStage(md) === 'verify', '當前階段在遷移後仍讀得到');
    assert(journalEntries(md).length > 0, '事件行在遷移後仍讀得到');
    const { events, warnings } = readEvents(join(loopDir, 'events.jsonl'));
    assert(warnings.length === 0, '產出的 ledger 沒有任何健康度警告');
    const st = projectEvents(events, { slug: '300-demo' });
    assert(st.stages.map((s) => s.name).join('→') === 'goal→explore→build→verify', '投影出來的階段序列與舊 Journal 一致');
    assert(st.round === 1, '回環數一致');
  });
});

testCase('M8', 'AC-6：四條真實 loop.md 的逐字快照全數遷得動、且每行可追溯', () => {
  assert(existsSync(REAL_LOOPS), '真實 loop 逐字快照目錄存在（不存在則本 case 的結論不成立、不得視為通過）');
  const files = readdirSync(REAL_LOOPS).filter((f) => f.endsWith('.md') && f !== 'README.md');
  assert(files.length === 4, `四條真實 loop 都在（實際 ${files.length}）`);
  withTmp((dir) => {
    for (const file of files) {
      const slug = file.replace(/\.md$/, '');
      const md = readFileSync(join(REAL_LOOPS, file), 'utf8');
      const parsed = parseLegacyLoopMd(md);
      assert(parsed.journal.length > 0, `${slug}：解析得到 ${parsed.journal.length} 行 Journal`);
      const loopDir = makeLegacyLoop(dir, slug, md);
      const r = migrateLoopDir(loopDir, { slug });
      assert(r.ok, `${slug}：遷移成功（${r.reason ?? ''}）`);
      assert(r.traceability.ok && r.traceability.total === parsed.journal.length, `${slug}：${parsed.journal.length}/${parsed.journal.length} 行全可追溯`);
      assert(readFileSync(join(loopDir, 'loop.md.legacy'), 'utf8') === md, `${slug}：原始快照逐字保留在 .legacy`);
      const { events, warnings } = readEvents(join(loopDir, 'events.jsonl'));
      assert(warnings.length === 0, `${slug}：產出的 ledger 無健康度警告`);
      const st = projectEvents(events, { slug });
      assert(st.issue === Number(slug.match(/^(\d+)/)[1]), `${slug}：issue 編號由 slug 推得`);
      const ledgerText = readFileSync(join(loopDir, 'events.jsonl'), 'utf8');
      for (const j of parsed.journal) {
        assert(ledgerText.includes(JSON.stringify(j.raw).slice(1, -1)), `${slug}：ledger 內含原文「${j.raw.slice(0, 14)}…」`);
      }
    }
  });
});

testCase('M9', 'AC-6（次要證據）：更舊、更大規模的歷史 loop（243）也解析得動', () => {
  assert(existsSync(CORPUS_243), '243 corpus 存在（不存在則本 case 的結論不成立）');
  const md = readFileSync(CORPUS_243, 'utf8');
  const parsed = parseLegacyLoopMd(md);
  assert(parsed.journal.length === 8, '8 行 Journal 全數解析到');
  const specs = legacyEventSpecs('243-show-subfolder-contents', parsed);
  const trace = diffTraceability(parsed, specs);
  assert(trace.ok && trace.total === 8, '8/8 行都可追溯回事件（遷移不掉字）');
  withTmp((dir) => {
    const loopDir = makeLegacyLoop(dir, '243-show-subfolder-contents', md);
    const r = migrateLoopDir(loopDir);
    assert(r.ok && r.traceability.ok, '真機遷移（寫檔）也通過追溯性檢查');
    const st = projectEvents(readEvents(join(loopDir, 'events.jsonl')).events, { slug: '243-show-subfolder-contents' });
    assert(st.stages.map((s) => s.name).join('→') === 'goal→explore→plan→build→verify→iterate', '階段序列＝該 loop 走過的六階段');
    assert(st.issue === 243, 'issue 編號由 slug 推得');
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
