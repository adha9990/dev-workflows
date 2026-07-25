#!/usr/bin/env node
// test-token-optimizer.mjs —— token optimizer 忠實度／receipt／資格審查／候選比較的斷言（#178）。
// 用法：node test-token-optimizer.mjs [--filter <case-prefix>] [--min-cases <n>]

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROTECTED_EVIDENCE, RECEIPT_FIELDS, QUALIFICATION_CHECKS, QUALITY_DIMENSIONS,
  checkFidelity, describeFidelity, applyOptimizer, buildReceipt, validateReceipt, renderReceipt,
  qualificationReport, compareCandidate, renderComparison,
} from './token-optimizer.mjs';
import { loadCatalog, loadIntegrations, wizardOptions, withheldOptions } from './setup-plan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

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

/** 一份典型的工具輸出：同時含五種受保護證據。 */
const RAW = [
  'running 3 tests',
  '✗ src/app.ts:42 應該回 200 但回了 500',
  '1 failed, 2 passed',
  'exit code 1',
  'security finding P1：未驗證的輸入直接進 SQL',
  '{"permissionDecision":"deny","reason":"合併回主幹要人按"}',
  '一些不重要的進度輸出'.repeat(20),
].join('\n');

// ══════════════════════════════════════════════════════════════════════════
testCase('T1', '受保護證據的清單與判準', () => {
  assert(PROTECTED_EVIDENCE.length === 5, '五類受保護證據');
  for (const p of PROTECTED_EVIDENCE) assert(p.id && p.re instanceof RegExp && p.why, `${p.id} 有判準與「為什麼重要」`);
  const ids = PROTECTED_EVIDENCE.map((p) => p.id);
  for (const must of ['policy-denial', 'test-failure', 'exit-code', 'file-line', 'security-finding']) {
    assert(ids.includes(must), `涵蓋 ${must}`);
  }
});

testCase('T2', 'checkFidelity：壓掉任一類受保護證據都判失敗', () => {
  assert(checkFidelity(RAW, RAW).ok, '原文對原文 → 過');
  const reformatted = RAW.split('\n').map((l) => l.trim()).join('\r\n');
  assert(checkFidelity(RAW, reformatted).ok, '只改排版／換行 → 過（壓縮本來就會改排版）');
  const summarised = `${RAW}\n\n摘要：一共 1 個測試失敗`;
  assert(checkFidelity(RAW, summarised).ok, '多加摘要行 → 過（多出來不算問題）');

  const dropped = RAW.split('\n').filter((l) => !l.includes('permissionDecision')).join('\n');
  const r = checkFidelity(RAW, dropped);
  assert(!r.ok && r.losses.some((l) => l.id === 'policy-denial'), '壓掉 policy denial → 失敗並指名');
  assert(describeFidelity(r).includes('以為自己被放行'), '理由講明為什麼這條重要');

  for (const [label, filter] of [
    ['測試失敗', (l) => !l.includes('failed') && !l.includes('✗')],
    ['exit code', (l) => !l.includes('exit code')],
    ['file:line', (l) => !l.includes('src/app.ts:42')],
    ['security finding', (l) => !l.includes('security finding')],
  ]) {
    const partial = RAW.split('\n').filter(filter).join('\n');
    assert(!checkFidelity(RAW, partial).ok, `壓掉${label} → 失敗`);
  }
  assert(describeFidelity({ ok: true, losses: [] }) === null, '沒問題時不產理由');
});

testCase('T3', 'applyOptimizer：忠實度沒過就 bypass 回原始輸出', () => {
  const good = applyOptimizer(RAW, { source: 'opt', version: '1.0', strategy: 'drop-progress-lines', run: (t) => t.replace(/一些不重要的進度輸出/g, '') });
  assert(!good.receipt.bypassed, '壓縮沒動到受保護證據 → 採用');
  assert(good.receipt.processedBytes < good.receipt.rawBytes, '真的變小了');
  assert(good.receipt.savedBytes > 0 && good.receipt.fidelity.ok, 'receipt 記下省了多少、忠實度過');

  const lossy = applyOptimizer(RAW, { source: 'opt', version: '1.0', strategy: 'aggressive', run: (t) => t.split('\n').slice(0, 2).join('\n') });
  assert(lossy.receipt.bypassed, '壓掉受保護證據 → bypass');
  assert(lossy.output === RAW, 'bypass 時拿到的是完整的原始輸出');
  assert(lossy.receipt.errors.length > 0 && lossy.receipt.errors[0].includes('受保護證據'), 'receipt 記下為什麼 bypass');
});

testCase('T4', '失敗隔離：optimizer 壞掉只是少省 token，不會讓人拿到殘缺證據', () => {
  const cases2 = [
    ['丟例外', () => { throw new Error('炸了'); }],
    ['回非字串', () => ({ compressed: true })],
    ['回空字串', () => ''],
    ['沒提供 run', null],
  ];
  for (const [label, run] of cases2) {
    const r = applyOptimizer(RAW, { source: 'opt', version: '1.0', run });
    assert(r.output === RAW, `${label} → 輸出仍是完整原文`);
    assert(r.receipt.bypassed === true, `${label} → receipt 標 bypassed`);
    assert(r.receipt.errors.length > 0, `${label} → receipt 記下錯誤（不是靜默）`);
  }
  assert(applyOptimizer('', { run: (t) => t }).output === '', '空輸入不會炸');
});

testCase('T5', 'receipt：欄位齊全、可追溯、且不得自相矛盾', () => {
  const r = applyOptimizer(RAW, { source: 'opt', version: '2.1', strategy: 'drop-progress-lines', run: (t) => t }).receipt;
  for (const f of RECEIPT_FIELDS) assert(r[f] !== undefined && r[f] !== null, `receipt 有 ${f}`);
  assert(validateReceipt(r).ok, '完整 receipt 通過驗證');
  for (const f of RECEIPT_FIELDS) {
    const broken = { ...r };
    delete broken[f];
    assert(!validateReceipt(broken).ok, `缺 ${f} → 不通過`);
  }
  const contradictory = { ...r, bypassed: false, fidelity: { ok: false, losses: [{ id: 'x' }] } };
  assert(!validateReceipt(contradictory).ok, '宣稱忠實度未過卻沒 bypass → 不通過（那代表殘缺的輸出被送出去了）');

  const md = renderReceipt(r);
  assert(md.includes('opt') && md.includes('2.1') && md.includes('drop-progress-lines'), 'receipt 渲染出來源／版本／策略');
  assert(renderReceipt(applyOptimizer(RAW, { run: () => 'x' }).receipt).includes('已回原始輸出'), 'bypass 時明講已回原始輸出');
  assert(buildReceipt({}).savedBytes === 0, '空 receipt 不會算出負的節省量');
});

testCase('T6', '資格審查：六項全綠才 qualified，not-measured 與 failed 一樣擋', () => {
  assert(QUALIFICATION_CHECKS.length === 6, '六項檢查');
  const allGreen = Object.fromEntries(QUALIFICATION_CHECKS.map((c) => [c, true]));
  assert(qualificationReport(allGreen).qualified, '全綠 → qualified');
  for (const c of QUALIFICATION_CHECKS) {
    const oneFailed = { ...allGreen, [c]: false };
    assert(!qualificationReport(oneFailed).qualified, `${c} 沒過 → 不 qualified`);
    const oneMissing = { ...allGreen };
    delete oneMissing[c];
    const rep = qualificationReport(oneMissing);
    assert(!rep.qualified, `${c} 沒量 → 不 qualified（「沒量」不是「過了」）`);
    assert(rep.rows.find((r) => r.id === c).state === 'not-measured', `${c} 如實標 not-measured`);
  }
  assert(qualificationReport({}).blocking.length === 6, '什麼都沒量 → 六項全擋');
  assert(qualificationReport({}).reason.includes('自己冒險'), '理由明講沒有冒險旗標');
});

testCase('T7', '候選比較：品質先於 token，退步就不接受', () => {
  const baseline = { taskSuccess: 0.9, ruleAdherence: 1.0, tokens: 100000, calls: 50, durationMs: 60000 };
  const better = { taskSuccess: 0.9, ruleAdherence: 1.0, tokens: 70000, calls: 50, durationMs: 55000 };
  const ok = compareCandidate(baseline, better);
  assert(ok.accepted, '品質持平、token 下降 → 接受');
  assert(ok.cost.find((c) => c.dim === 'tokens').verdict === 'improved', 'token 標 improved');

  const cheaper = { taskSuccess: 0.7, ruleAdherence: 1.0, tokens: 20000, calls: 40, durationMs: 30000 };
  const bad = compareCandidate(baseline, cheaper);
  assert(!bad.accepted, 'task success 退步 → 不接受，不論省多少 token');
  assert(bad.reason.includes('省 token 不能拿品質換'), '理由講明品質優先');

  const adherenceDrop = compareCandidate(baseline, { ...better, ruleAdherence: 0.8 });
  assert(!adherenceDrop.accepted, '規則遵循度退步 → 不接受');

  const noQuality = compareCandidate({ tokens: 100000 }, { tokens: 50000 });
  assert(!noQuality.accepted && noQuality.reason.includes('沒量'), '品質沒量到 → 不接受（沒量不等於沒退步）');
});

testCase('T8', 'token／call／duration 只報實測：沒量標 not measured、沒進步標 not improved', () => {
  const baseline = { taskSuccess: 0.9, ruleAdherence: 1.0, tokens: 100000 };
  const sameTokens = compareCandidate(baseline, { taskSuccess: 0.9, ruleAdherence: 1.0, tokens: 100000, calls: 10, durationMs: 10 });
  assert(sameTokens.cost.find((c) => c.dim === 'tokens').verdict === 'not improved', 'token 沒降 → not improved（不寫成「持平即成功」）');
  assert(sameTokens.cost.find((c) => c.dim === 'calls').verdict === 'not measured', 'baseline 沒有 calls → not measured');
  const worse = compareCandidate(baseline, { taskSuccess: 0.9, ruleAdherence: 1.0, tokens: 120000 });
  assert(worse.cost.find((c) => c.dim === 'tokens').verdict === 'not improved', 'token 變多也是 not improved（不粉飾）');
  assert(worse.accepted === true, '品質沒退步就仍可接受——但成本欄誠實標 not improved');
  const md = renderComparison(worse);
  assert(md.includes('not improved'), '渲染出來看得到 not improved');
  assert(renderComparison(compareCandidate(baseline, { taskSuccess: 0.5, ruleAdherence: 1.0 })).includes('不接受'), '不接受時渲染出理由');
  assert(QUALITY_DIMENSIONS.join(',') === 'taskSuccess,ruleAdherence', '品質維度值域固定');
});

testCase('T9', '真 catalog：互斥組僅推薦項進 wizard，未合格的維持在外', () => {
  const catalog = loadCatalog(REPO_ROOT);
  const integrations = loadIntegrations(REPO_ROOT);
  assert(catalog && integrations, '讀得到 catalog 與 integration registry');
  const group = wizardOptions(catalog, integrations).find((g) => g.category === 'token-optimizer');
  assert(group, 'wizard 有 token optimizer 這一組');
  assert(group.allowDisable === true, '互斥組永遠可以整組停用');
  assert(group.options.length === 1 && group.options[0].recommended === true, '目前只有推薦項合格、進得了選單');
  const withheld = withheldOptions(catalog).map((w) => w.id);
  assert(withheld.includes('token-optimizer-alternate'), '另一個實作維持在 catalog 之外');
  const entry = catalog.entries.find((e) => e.id === 'token-optimizer-alternate');
  assert(Array.isArray(entry.qualification) && entry.qualification.length > 0, '而且列出了還缺什麼（不是靜默消失）');
  const groups = new Set(catalog.entries.filter((e) => e.category === 'token-optimizer')
    .map((e) => integrations.integrations.find((i) => i.id === e.integration)?.exclusive_group));
  assert(groups.size === 1 && !groups.has(undefined), '兩個實作在同一個互斥組（不會同時啟用）');
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
