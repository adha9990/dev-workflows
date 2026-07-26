#!/usr/bin/env node
// test-skill-usage.mjs —— skill／reference 實際載入度分析的斷言（#205）。
// 重點：分母要誠實（非 loop session 明確排除）、版本對不上要標 not measured 而不是硬比、
// 三種差集正反都驗、報告不宣稱「某條規則沒用」。
// 用法：node test-skill-usage.mjs [--filter <case-prefix>] [--min-cases <n>]

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SKILL_NS, TRANSCRIPT_KINDS,
  scanTranscript, classifyKind, expectedReferences, compareUsage, renderReport,
  loadSnapshot, listSnapshots, collectTranscripts, observeTranscript, analyzeAll, shortenProjectLabel,
} from './skill-usage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_PLUGIN = join(HERE, '..');

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
  const dir = mkdtempSync(join(tmpdir(), 'skill-usage-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const skillLine = (name, args = 'x') => `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"${name}","args":"${args}"}}]}}`;
const readLine = (path) => `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"${path}"}}]}}`;
const loopLine = () => '{"tool_input":{"file_path":".loops/300-demo/loop.md"}}';

/** 合成快照：兩個 skill、三份 reference，其中兩份被 skill 正文提到。 */
function makeSnapshot(root) {
  const dir = join(root, '0.99.0');
  mkdirSync(join(dir, 'skills', 'alpha'), { recursive: true });
  mkdirSync(join(dir, 'skills', 'beta'), { recursive: true });
  mkdirSync(join(dir, 'references', 'nested'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'alpha', 'SKILL.md'), '見 `references/used.md` 與 `references/nested/declared.md`', 'utf8');
  writeFileSync(join(dir, 'skills', 'beta', 'SKILL.md'), '沒有提到任何規範檔', 'utf8');
  writeFileSync(join(dir, 'references', 'used.md'), 'u', 'utf8');
  writeFileSync(join(dir, 'references', 'nested', 'declared.md'), 'd', 'utf8');
  writeFileSync(join(dir, 'references', 'orphan.md'), 'o', 'utf8');
  return dir;
}

// ══════════════════════════════════════════════════════════════════════════
testCase('U1', 'scanTranscript：抓得到 Skill 呼叫、references 樹底下的 Read、loop 檔動作', () => {
  const text = [
    skillLine('loops-workflow:goal'),
    skillLine('code-review'),
    readLine('plugins/loops-workflow/references/shared/quality/clean-code.md'),
    readLine('C:\\\\Users\\\\x\\\\references\\\\comment-policy.md'),
    readLine('src/app.ts'),
    readLine('plugins/loops-workflow/skills/plan/SKILL.md'),
    loopLine(),
  ].join('\n');
  const s = scanTranscript(text);
  assert(s.skillCalls.join(',') === 'loops-workflow:goal,code-review', '兩個 Skill 呼叫都抓到（含別的 plugin 的）');
  assert(s.referenceReads.sort().join(',') === 'clean-code.md,comment-policy.md', '只算 references/ 樹底下的 .md，反斜線路徑也認得');
  assert(!s.referenceReads.includes('SKILL.md'), 'skills/ 底下的檔不算 reference');
  assert(s.loopArtifacts >= 1, 'loop 檔動作被計數');
  assert(scanTranscript('').skillCalls.length === 0 && scanTranscript(null).referenceReads.length === 0, '空輸入不丟例外');
});

testCase('U2', 'classifyKind：分母要誠實——非 loop session 明確排除', () => {
  assert(TRANSCRIPT_KINDS.join(',') === 'loop-session,non-loop', '兩種分類');
  assert(classifyKind({ skillCalls: [`${SKILL_NS}goal`] }) === 'loop-session', '叫過本 plugin 的 skill → loop session');
  assert(classifyKind({ loopArtifacts: 3 }) === 'loop-session', '動過 loop 檔 → loop session');
  assert(classifyKind({ skillCalls: ['code-review'], loopArtifacts: 0 }) === 'non-loop', '只叫別的 plugin 的 skill → 非 loop');
  assert(classifyKind({}) === 'non-loop', '什麼都沒有 → 非 loop');
});

testCase('U3', 'expectedReferences：判準＝skill 正文逐字提到檔名（與 orphan-ref 同一套）', () => {
  withTmp((root) => {
    const snap = loadSnapshot(makeSnapshot(root));
    assert(snap.skills.sort().join(',') === 'alpha,beta', 'skill 集合讀得到');
    assert(snap.references.join(',') === 'declared.md,orphan.md,used.md', 'reference **遞迴**收集（扁平與巢狀版都適用）');
    const exp = expectedReferences(snap);
    assert(exp.size === 2 && exp.has('used.md') && exp.has('declared.md'), '只有被 skill 正文提到的算「宣稱會用」');
    assert(!exp.has('orphan.md'), '沒人提到的不算期望（那是 skill-lint 的 orphan-ref 在管）');
    assert([...exp.get('used.md')].join(',') === 'alpha', '記得住是哪個 skill 宣稱的');
  });
});

testCase('U4', 'compareUsage：三種差集，正反都驗', () => {
  withTmp((root) => {
    const snap = loadSnapshot(makeSnapshot(root));
    const obs = [
      { file: 's1', kind: 'loop-session', skillCalls: [`${SKILL_NS}alpha`], referenceReads: ['used.md', 'used.md', 'orphan.md'], loopArtifacts: 1, subagentFiles: 0 },
      { file: 's2', kind: 'non-loop', skillCalls: [], referenceReads: [], loopArtifacts: 0, subagentFiles: 0 },
    ];
    const r = compareUsage(obs, snap);
    assert(r.transcripts.loopSessions === 1 && r.transcripts.nonLoop === 1, '分母只算 loop session，非 loop 另外計數');
    assert(r.skills.invoked[0].name === 'alpha' && r.skills.invoked[0].count === 1, 'skill 呼叫次數');
    assert(r.skills.neverInvoked.join(',') === 'beta', '沒被叫到的 skill 列出來');
    assert(r.references.loaded.find((x) => x.name === 'used.md').count === 2, 'reference 載入次數（同 session 多次也算）');
    assert(r.references.neverLoaded.map((x) => x.name).join(',') === 'declared.md', '宣稱會用卻沒載入 → 這是重點');
    assert(r.references.neverLoaded[0].declaredBy.join(',') === 'alpha', '而且指名是哪個 skill 宣稱的');
    assert(r.references.loadedNotExpected.join(',') === 'orphan.md', '載入了但沒有 skill 提到它 → 反向訊號');

    // 反向：全都載入了就不該有差集（殺掉「恆報 neverLoaded」的實作）
    const full = compareUsage([{ file: 's', kind: 'loop-session', skillCalls: [`${SKILL_NS}alpha`, `${SKILL_NS}beta`], referenceReads: ['used.md', 'declared.md'], loopArtifacts: 1 }], snap);
    assert(full.references.neverLoaded.length === 0 && full.skills.neverInvoked.length === 0, '全載入 → 差集為空');
  });
});

testCase('U5', '版本對不上 → 標 not measured 並排除，不硬比', () => {
  withTmp((root) => {
    const snap = loadSnapshot(makeSnapshot(root));
    const obs = [
      { file: 'old', kind: 'loop-session', skillCalls: [`${SKILL_NS}alpha`], referenceReads: ['used.md'], loopArtifacts: 1 },
      { file: 'new', kind: 'loop-session', skillCalls: [`${SKILL_NS}setup`], referenceReads: ['declared.md'], loopArtifacts: 1 },
    ];
    const r = compareUsage(obs, snap);
    assert(r.transcripts.notMeasured.length === 1 && r.transcripts.notMeasured[0].file === 'new', '叫到快照沒有的 skill → 該份標 not measured');
    assert(r.transcripts.notMeasured[0].reason.includes('setup'), '理由指名是哪個 skill 對不上');
    assert(r.transcripts.notMeasured[0].reason.includes('硬比會得出假差集'), '理由講明為什麼不硬比');
    assert(r.transcripts.loopSessions === 1, '被排除的不算進分母');
    assert(r.references.neverLoaded.some((x) => x.name === 'declared.md'), '被排除那份的 Read 也不算進載入（否則等於偷偷混版本）');
  });
});

testCase('U6', '逐 session 攤開：碰過 loop 檔卻一次 skill 都沒叫的，要看得見', () => {
  withTmp((root) => {
    const snap = loadSnapshot(makeSnapshot(root));
    const r = compareUsage([
      { file: 'real', kind: 'loop-session', skillCalls: [`${SKILL_NS}alpha`], referenceReads: ['used.md'], loopArtifacts: 5, subagentFiles: 3 },
      { file: 'touched-only', kind: 'loop-session', skillCalls: [], referenceReads: [], loopArtifacts: 4, subagentFiles: 0 },
    ], snap);
    assert(r.transcripts.noSkillCall === 1, '「碰過 loop 檔但沒叫 skill」單獨計數');
    assert(r.sessions.length === 2 && r.sessions[0].file === 'real', '逐 session 列出、依呼叫數排序');
    const touched = r.sessions.find((s) => s.file === 'touched-only');
    assert(touched.skillCalls === 0 && touched.loopArtifacts === 4, '該 session 的 0 次呼叫看得見（不被聚合數字蓋掉）');
    assert(r.sessions[0].subagentFiles === 3, '子代理檔數帶出來（reviewer 的 Read 在那裡）');
  });
});

testCase('U7', '報告：重點差集、排除原因、以及「不回答什麼」都寫出來', () => {
  withTmp((root) => {
    const snap = loadSnapshot(makeSnapshot(root));
    const r = compareUsage([
      { file: 's1', kind: 'loop-session', skillCalls: [`${SKILL_NS}alpha`], referenceReads: ['used.md'], loopArtifacts: 1 },
      { file: 'bad', kind: 'loop-session', skillCalls: [`${SKILL_NS}ghost`], referenceReads: [], loopArtifacts: 1 },
      { file: 'n', kind: 'non-loop', skillCalls: [], referenceReads: [], loopArtifacts: 0 },
    ], snap);
    const md = renderReport(r);
    assert(md.includes('這一節是本報告的重點'), '重點差集有標出來');
    assert(md.includes('declared.md'), '沒被載入的 reference 逐條列出');
    assert(md.includes('版本對不上而排除的'), '排除的逐份列出，不靜默丟');
    assert(md.includes('`bad`'), '指名是哪一份被排除');
    assert(md.includes('不回答「載入了有沒有照做」'), '明講這份報告不回答什麼');
    assert(md.includes('不宣稱某條規則沒用'), '明講不代人下結論');
    assert(md.includes('明確排除並計數'), '分母怎麼算講清楚');
  });
});

testCase('U8', 'listSnapshots：版本由新到舊（數字比較、不是字串比較）', () => {
  withTmp((root) => {
    for (const v of ['0.9.0', '0.10.0', '1.0.0', 'not-a-version']) mkdirSync(join(root, v), { recursive: true });
    const found = listSnapshots(root).map((d) => d.split(/[\\/]/).pop());
    assert(found.join(',') === '1.0.0,0.10.0,0.9.0', `新到舊排序、非版本目錄排除（實際：${found.join(',')}）`);
    assert(listSnapshots(join(root, '不存在')).length === 0, '目錄不存在 → 空清單、不丟');
  });
});

testCase('U9', 'IO：掃 transcript 目錄（含子代理），合成資料端到端跑得出報告', () => {
  withTmp((root) => {
    const snapDir = makeSnapshot(root);
    const projects = join(root, 'projects', 'proj-a');
    mkdirSync(join(projects, 'sess1', 'subagents'), { recursive: true });
    writeFileSync(join(projects, 'sess1.jsonl'), [skillLine(`${SKILL_NS}alpha`), loopLine()].join('\n'), 'utf8');
    // reviewer 的 Read 在子代理 transcript 裡——主檔看不到，一定要掃進來
    writeFileSync(join(projects, 'sess1', 'subagents', 'agent-1.jsonl'), readLine('x/references/used.md'), 'utf8');
    writeFileSync(join(projects, 'sess2.jsonl'), readLine('src/a.ts'), 'utf8');

    const entries = collectTranscripts(join(root, 'projects'));
    assert(entries.length === 2, '兩份主 transcript 都收到');
    const s1 = entries.find((e) => e.sessionId === 'sess1');
    assert(s1.subagents.length === 1, '子代理 transcript 被收進來');
    const obs = observeTranscript(s1);
    assert(obs.referenceReads.join(',') === 'used.md', '**子代理的 Read 有被算進去**（reviewer 的載入只在那裡看得到）');
    assert(obs.kind === 'loop-session', '分類正確');
    assert(observeTranscript(entries.find((e) => e.sessionId === 'sess2')).kind === 'non-loop', '純讀 code 的 session → 非 loop');

    const r = analyzeAll(join(root, 'projects'), snapDir);
    assert(r.transcripts.loopSessions === 1 && r.transcripts.nonLoop === 1, '端到端分母正確');
    assert(r.references.neverLoaded.map((x) => x.name).join(',') === 'declared.md', '端到端算得出重點差集');
  });
});

testCase('U9b', '專案標籤不把使用者的機器路徑寫進報告', () => {
  assert(shortenProjectLabel('C--Users-someone-Documents-GitHub-my-repo') === 'my-repo', '砍掉磁碟機／使用者／上層目錄前綴');
  assert(shortenProjectLabel('D--Users-other-my-repo') === 'my-repo', '沒有 Documents/GitHub 段也砍得掉');
  assert(shortenProjectLabel('plain-label') === 'plain-label', '認不出前綴 → 原樣保留（不猜、不亂砍）');
  assert(!shortenProjectLabel('C--Users-someone-Documents-GitHub-my-repo').includes('Users'), '結果不含使用者名');
  assert(shortenProjectLabel('C--Users-x-Documents-GitHub-my-repo--claude-worktrees-205-thing') === 'my-repo@205-thing',
    'worktree 目錄名收成 <repo>@<slug>（也避開 compat-lint 對 `claude-` 前綴的廠商 model id 誤判）');
});

testCase('U10', '真 repo 的 plugin 目錄本身可以當快照（不必依賴已安裝的快取）', () => {
  const snap = loadSnapshot(REPO_PLUGIN);
  assert(snap.skills.length >= 14, `repo 內的 skill 集合讀得到（${snap.skills.length} 個）`);
  assert(snap.references.length > 50, `reference 遞迴收集得到（${snap.references.length} 份，含分類子目錄）`);
  const exp = expectedReferences(snap);
  assert(exp.size > 20, `有 ${exp.size} 份 reference 被至少一個 skill 正文指名`);
  assert(exp.has('reviewer-severity.md'), '抽樣：verify 指名的 reviewer-severity.md 在期望集合裡');
  assert(!snap.references.includes('SKILL.md'), 'skills 底下的檔不會混進 reference 集合');
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
