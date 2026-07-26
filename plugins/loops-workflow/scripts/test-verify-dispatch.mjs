#!/usr/bin/env node
// test-verify-dispatch.mjs —— verify 派工觀測的斷言（#209）。
// 重點：判不出來的那一格**必須**回 `unconfirmed`（不是 `skipped`、更不是 `ok`），且不被聚合成違規；
// 角色判定用命名規則（跨版本穩定）；marker 的兩個欄位正反都驗。
// 用法：node test-verify-dispatch.mjs [--filter <case-prefix>] [--min-cases <n>]

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ROLES, VERDICTS, SUBAGENT_NS,
  classifyRole, scanDispatch, mergeDispatch, readMarkerCounts, verdictFor,
  renderReport, collectTranscripts, shortenProjectLabel, analyzeAll, defaultProjectsRoot,
} from './verify-dispatch.mjs';

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
  const dir = mkdtempSync(join(tmpdir(), 'verify-dispatch-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** 造一行帶 subagent_type 的 transcript 片段（形狀比照真實 transcript 的 tool_use 欄位）。 */
const dispatchLine = (type) =>
  `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Agent","input":{"subagent_type":"${type}","prompt":"x"}}]}}`;

const marker = (fields) => `<!-- loops-verify ${fields} -->`;

// ── D1：角色判定 ─────────────────────────────────────────────────────────────

testCase('D1', '角色判定用命名規則（跨版本穩定），-deep 變體與 base 同角色', () => {
  assert(classifyRole(`${SUBAGENT_NS}security-reviewer`) === 'reviewer', '`*-reviewer` → reviewer');
  assert(classifyRole(`${SUBAGENT_NS}security-reviewer-deep`) === 'reviewer', '`*-reviewer-deep` 仍是 reviewer（深審變體不改流程位置）');
  assert(classifyRole(`${SUBAGENT_NS}finding-validator`) === 'validator', 'finding-validator → validator');
  assert(classifyRole(`${SUBAGENT_NS}finding-validator-deep`) === 'validator', 'finding-validator-deep 仍是 validator');
  assert(classifyRole(`${SUBAGENT_NS}impl-author`) === 'builder', 'impl-author → builder');
  assert(classifyRole(`${SUBAGENT_NS}test-author`) === 'builder', 'test-author → builder');
  assert(classifyRole(`${SUBAGENT_NS}referee`) === 'builder', 'referee → builder');
  assert(classifyRole(`${SUBAGENT_NS}eval-judge`) === 'other', '本 plugin 但非上述角色 → other');

  // 反向：非本 plugin 的子代理不得被算進任何 loops 角色，否則分母會被一般對話污染。
  assert(classifyRole('Explore') === 'other', '非本 plugin 的 Explore → other');
  assert(classifyRole('general-purpose') === 'other', '非本 plugin 的 general-purpose → other');
  assert(classifyRole('some-other-reviewer') === 'other', '**沒有命名空間前綴**的 `*-reviewer` 不算本 plugin 的 reviewer');
  assert(classifyRole(null) === 'other' && classifyRole(undefined) === 'other', 'null/undefined 不炸、回 other');
});

// ── D2：掃描與合併 ───────────────────────────────────────────────────────────

testCase('D2', '掃描逐型別計數，合併不遺漏型別', () => {
  const text = [
    dispatchLine(`${SUBAGENT_NS}security-reviewer`),
    dispatchLine(`${SUBAGENT_NS}tests-reviewer`),
    dispatchLine(`${SUBAGENT_NS}finding-validator`),
    dispatchLine(`${SUBAGENT_NS}impl-author`),
    dispatchLine('Explore'),
  ].join('\n');
  const d = scanDispatch(text);
  assert(d.roles.reviewer === 2, '兩個 reviewer 都數到');
  assert(d.roles.validator === 1, 'validator 數到 1');
  assert(d.roles.builder === 1, 'builder 數到 1');
  assert(d.roles.other === 1, 'Explore 落在 other');
  assert(d.total === 5, 'total ＝ 全部派工次數');
  assert(d.byType[`${SUBAGENT_NS}security-reviewer`] === 1, 'byType 逐型別留存（供人核對派了哪幾軸）');

  assert(scanDispatch(null).total === 0, '非字串輸入不炸、回零');
  assert(scanDispatch('沒有任何派工的一般對話').total === 0, '無派工 → 零');

  const merged = mergeDispatch(d, scanDispatch(dispatchLine(`${SUBAGENT_NS}finding-validator`)));
  assert(merged.roles.validator === 2, '合併後 validator 累加');
  assert(merged.roles.reviewer === 2, '合併不動到其他角色');
  assert(merged.total === 6, '合併後 total 累加');
  assert(ROLES.every((r) => typeof merged.roles[r] === 'number'), '合併結果四個角色鍵齊全');
});

// ── D3：marker 兩欄位（正反） ────────────────────────────────────────────────

testCase('D3', 'marker 欄位缺席回 undefined（不補 0），有值時正確取出', () => {
  const both = readMarkerCounts(`判定段\n${marker('verdict=ready p0=0 p1=0 round=2 findings=4 validated=4')}`);
  assert(both.findings === 4 && both.validated === 4, '兩欄位都取得到');

  const old = readMarkerCounts(`舊報告\n${marker('verdict=ready p0=0 p1=0 round=1')}`);
  assert(old.findings === undefined, '舊 marker 無 findings → undefined，**不是 0**（補 0 會把「沒寫」讀成「零條」）');
  assert(old.validated === undefined, '舊 marker 無 validated → undefined');

  assert(readMarkerCounts('沒有 marker 的報告').findings === undefined, '無 marker → undefined');
  assert(readMarkerCounts(null).findings === undefined, '非字串不炸');

  // fence-robust：報告裡貼的示範 marker 不該蓋掉真的那個。
  const withFence = [
    '報告內文',
    '```',
    marker('verdict=ready p0=0 p1=0 round=1 findings=0 validated=0'),
    '```',
    marker('verdict=ready p0=0 p1=0 round=1 findings=3 validated=3'),
  ].join('\n');
  assert(readMarkerCounts(withFence).findings === 3, 'fence 內的示範 marker 不蓋掉真 marker');
});

// ── D4：判定四態（每一態正反都驗）────────────────────────────────────────────

testCase('D4', '判定四態；`unconfirmed` 不是違規、不得被讀成 skipped', () => {
  // 沒派 reviewer → 本觀測不適用。
  assert(verdictFor({ reviewer: 0, validator: 0 }).verdict === 'no-review', '零 reviewer → no-review');

  // 派了 validator → 第二輪跑過。
  assert(verdictFor({ reviewer: 6, validator: 3 }).verdict === 'validated', '有 validator → validated');

  // **本票的核心情境**：派了 reviewer、沒派 validator、查不到候選 finding 條數。
  const u = verdictFor({ reviewer: 10, validator: 0 });
  assert(u.verdict === 'unconfirmed', '派了 reviewer、沒派 validator、無 marker → unconfirmed');
  assert(u.verdict !== 'skipped', '**不得**在沒有候選 finding 條數時就斷定 skipped');
  assert(/判不出來|可能零候選/.test(u.reason), 'reason 說明為什麼判不出來，而不是含糊帶過');

  // 有 marker 才判得出 skipped —— 這正是 marker 要補兩個欄位的理由。
  const s = verdictFor({ reviewer: 10, validator: 0 }, { findings: 4, validated: 0 });
  assert(s.verdict === 'skipped', 'findings>0 且 validated=0 → skipped（同一組派工資料，有 marker 才判得出來）');

  // 反向一：零候選本來就不必派 validator，不得判成違規。
  assert(verdictFor({ reviewer: 6, validator: 0 }, { findings: 0 }).verdict === 'validated',
    'findings=0 → 不是違規（零候選不必派）');

  // 反向二：有候選、也確認了 → 放行。
  assert(verdictFor({ reviewer: 6, validator: 2 }, { findings: 2, validated: 2 }).verdict === 'validated',
    'findings>0 且 validated>0 → validated');

  // marker 優先於 transcript 計數：transcript 可能橫跨多輪、計數會混輪。
  assert(verdictFor({ reviewer: 6, validator: 5 }, { findings: 3, validated: 0 }).verdict === 'skipped',
    'marker 自報 validated=0 時，transcript 數到的 5 個 validator 不能翻案（那可能是別輪的）');

  assert(verdictFor().verdict === 'no-review', '無參數不炸');
  assert(VERDICTS.includes(u.verdict) && VERDICTS.includes(s.verdict), '回傳值都落在宣告的值域內');
});

// ── D5：報告不把「判不出來」聚合成違規率 ────────────────────────────────────

testCase('D5', '報告逐個列出判不出來的 session，且明講它不是違規計數', () => {
  const md = renderReport({
    projectsRoot: '/tmp/p',
    rows: [
      { label: 'a/1111', roles: { reviewer: 10, validator: 0, builder: 0, other: 5 }, verdict: 'unconfirmed', reason: '判不出來' },
      { label: 'b/2222', roles: { reviewer: 6, validator: 2, builder: 1, other: 0 }, verdict: 'validated', reason: 'ok' },
    ],
  });
  assert(md.includes('a/1111') && md.includes('b/2222'), '逐 session 攤開，不只給聚合數字');
  assert(/不是違規計數/.test(md), '報告明講 `unconfirmed` 不是違規計數');
  assert(/判不出來的 session/.test(md), '判不出來的 session 另立一段逐個列出');
  assert(!/違規率|比率/.test(md.split('判定分佈')[0] ?? ''), '表格區不出現「違規率」這種聚合說法');

  const empty = renderReport({ projectsRoot: '/tmp/p', rows: [] });
  assert(typeof empty === 'string' && empty.includes('納入 0 個'), '零列不炸、如實寫 0');
  assert(!/判不出來的 session/.test(empty), '沒有判不出來的 session 時不多印那一段');
});

// ── D6：IO 邊界 ─────────────────────────────────────────────────────────────

testCase('D6', '掃描目錄、標籤不外洩機器路徑、非 jsonl 不收', () => {
  withTmp((dir) => {
    const proj = join(dir, 'C--Users-Someone-Documents-GitHub-myrepo');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'aaaaaaaa-1111.jsonl'), dispatchLine(`${SUBAGENT_NS}tests-reviewer`), 'utf8');
    writeFileSync(join(proj, 'notes.txt'), 'not a transcript', 'utf8');

    const found = collectTranscripts(dir);
    assert(found.length === 1, '只收 .jsonl');
    assert(found[0].project.startsWith('C--Users-'), 'entry 帶原始目錄名供後續縮寫');

    const res = analyzeAll(dir, null);
    assert(res.rows.length === 1, '有派過本 plugin 子代理的 session 才進表');
    assert(res.rows[0].verdict === 'unconfirmed', '一個 reviewer、零 validator、無 marker → unconfirmed');
    assert(!res.rows[0].label.includes('Users'), '標籤不把使用者機器路徑寫進產出');

    // 反向：只有非本 plugin 子代理的 session 不進表（分母要誠實）。
    const proj2 = join(dir, 'C--Users-Someone-Documents-GitHub-other');
    mkdirSync(proj2, { recursive: true });
    writeFileSync(join(proj2, 'bbbbbbbb-2222.jsonl'), dispatchLine('Explore'), 'utf8');
    assert(analyzeAll(dir, null).rows.length === 1, '只派過 Explore 的 session **不**進分母');

    // marker 帶進來後，同一份資料的判定要跟著變。
    const withMarker = analyzeAll(dir, `x\n${marker('verdict=ready p0=0 p1=0 round=1 findings=2 validated=0')}`);
    assert(withMarker.rows[0].verdict === 'skipped', '帶入 marker 後同一份 transcript 判成 skipped');
  });

  assert(collectTranscripts('/nonexistent-dir-xyz').length === 0, '目錄不存在不炸、回空');
  assert(analyzeAll('/nonexistent-dir-xyz', null).rows.length === 0, '掃不到東西不炸');
  assert(shortenProjectLabel('C--Users-User-Documents-GitHub-repo--claude-worktrees-slug') === 'repo@slug',
    'worktree 目錄名收成 `<repo>@<slug>`（那段前綴會被 compat-lint 誤判成廠商 model id）');
  assert(typeof defaultProjectsRoot() === 'string', '預設 projects 根目錄可取得');
});

// ── runner ──────────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv.slice(2));
const selected = cases.filter((c) => !opts.filter || c.id.startsWith(opts.filter));
for (const c of selected) {
  console.log(`\n[${c.id}] ${c.name}`);
  try { c.fn(); } catch (e) { failed.push(`${c.id} threw: ${e?.message}`); console.error(`  ✗ threw: ${e?.message}`); }
}
if (opts.minCases && selected.length < opts.minCases) {
  failed.push(`跑到的 case 數 ${selected.length} < --min-cases ${opts.minCases}`);
}
console.log(`\n${failed.length === 0 ? '✓' : '✗'} test-verify-dispatch：${selected.length} cases、${passed} 條斷言通過、${failed.length} 條失敗`);
if (failed.length > 0) { for (const f of failed) console.error(`  - ${f}`); process.exit(1); }
