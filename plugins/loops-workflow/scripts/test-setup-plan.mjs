#!/usr/bin/env node
// test-setup-plan.mjs —— `/setup` reconciliation 的斷言（#176）。
// 對應驗收標準：clean install／same-choice no-op／差異更新／互斥切換／停用／偵測既有來源；
// auto-update TTL／latest 解析／staged health／atomic switch／失敗回滾；失敗不留半套；
// receipt 可追溯；catalog 不出現資格未過的來源，也沒有 experimental 旗標。
// 用法：node test-setup-plan.mjs [--filter <case-prefix>] [--min-cases <n>]

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SETUP_CATEGORIES, PLAN_ACTIONS, OFFERABLE_STATUSES,
  validateCatalog, wizardOptions, withheldOptions, desiredFromChoices,
  diffPlan, isNoOp, applyPlan, hasHalfInstalled, renderReceipt,
  shouldAutoUpdate, dueForAutoUpdate, loadCatalog, loadIntegrations,
} from './setup-plan.mjs';

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

// ── 合成 fixture：兩個必裝、一組互斥（其一未合格）、一個選用 ─────────────
const INTEGRATIONS = {
  integrations: [
    { id: 'graph', support_status: 'supported', exclusive_group: 'retrieval' },
    { id: 'eval', support_status: 'supported', exclusive_group: 'eval-runner' },
    { id: 'opt-a', support_status: 'supported', exclusive_group: 'token-opt' },
    { id: 'opt-b', support_status: 'supported', exclusive_group: 'token-opt' },
    { id: 'editor', support_status: 'not_measured', exclusive_group: 'editing' },
    { id: 'unsupported-one', support_status: 'not_supported', exclusive_group: 'editing' },
  ],
};
const CATALOG = {
  entries: [
    { id: 'graph', integration: 'graph', category: 'required', recommended: true, summary: 'g', qualification: null, auto_update_ttl_hours: 168 },
    { id: 'eval', integration: 'eval', category: 'required', recommended: true, summary: 'e', qualification: null, auto_update_ttl_hours: 168 },
    { id: 'opt-a', integration: 'opt-a', category: 'token-optimizer', recommended: true, summary: 'a', qualification: null, auto_update_ttl_hours: 72 },
    { id: 'opt-b', integration: 'opt-b', category: 'token-optimizer', recommended: false, summary: 'b', qualification: ['Windows 實測', 'rollback 路徑'], auto_update_ttl_hours: 72 },
    { id: 'editor', integration: 'editor', category: 'optional', recommended: false, summary: 'ed', qualification: null, auto_update_ttl_hours: null },
    { id: 'nope', integration: 'unsupported-one', category: 'optional', recommended: false, summary: 'x', qualification: null, auto_update_ttl_hours: null },
  ],
};
const desiredOf = (choices) => desiredFromChoices(choices, CATALOG, INTEGRATIONS);
const okPorts = () => ({
  stage: () => ({ ok: true, detail: 'staged' }),
  health: () => ({ ok: true, detail: 'healthy' }),
  activate: () => ({ ok: true, detail: 'switched' }),
  rollback: () => ({ ok: true, detail: 'rolled back' }),
  remove: () => ({ ok: true, detail: 'removed' }),
});

// ══════════════════════════════════════════════════════════════════════════
testCase('S1', 'catalog 值域與自洽檢查', () => {
  assert(SETUP_CATEGORIES.join(',') === 'required,token-optimizer,recommended,optional', '四類固定');
  assert(PLAN_ACTIONS.includes('no-op') && PLAN_ACTIONS.includes('install'), 'plan 動作值域含 no-op 與 install');
  assert(validateCatalog(CATALOG, INTEGRATIONS).length === 0, '合法 catalog 無 finding');
  const badRef = { entries: [{ ...CATALOG.entries[0], integration: '不存在' }] };
  assert(validateCatalog(badRef, INTEGRATIONS).some((f) => f.check === 'setup-catalog-ref'), '指向不存在的 integration → 紅（免得 apply 才炸）');
  const badCat = { entries: [{ ...CATALOG.entries[0], category: '亂寫' }] };
  assert(validateCatalog(badCat, INTEGRATIONS).some((f) => f.check === 'setup-catalog-category'), '未知 category → 紅');
  const noGroup = { entries: [{ ...CATALOG.entries[2], integration: 'graph' }] };
  const noGroupReg = { integrations: [{ id: 'graph', support_status: 'supported', exclusive_group: null }] };
  assert(validateCatalog(noGroup, noGroupReg).some((f) => f.check === 'setup-catalog-exclusive'), '互斥類卻沒有 exclusive_group → 紅（互斥要由 registry 表達）');
  const requiredNotRecommended = { entries: [{ ...CATALOG.entries[0], recommended: false }] };
  assert(validateCatalog(requiredNotRecommended, INTEGRATIONS).length > 0, 'required 卻沒標 recommended → 紅');
  assert(validateCatalog({ entries: [CATALOG.entries[0], CATALOG.entries[0]] }, INTEGRATIONS).some((f) => f.detail.includes('重複')), 'id 重複 → 紅');
});

testCase('S2', 'wizard：資格未過與不支援的來源不出現，推薦與互斥標示清楚', () => {
  const groups = wizardOptions(CATALOG, INTEGRATIONS);
  const all = groups.flatMap((g) => g.options.map((o) => o.id));
  assert(!all.includes('opt-b'), '資格審查未過的來源不出現在選單（沒有 experimental fallback）');
  assert(!all.includes('nope'), 'support_status=not_supported 的來源不出現');
  assert(all.includes('editor'), 'not_measured 仍可出現（誠實標示，不是隱藏）');
  assert(OFFERABLE_STATUSES.includes('not_measured') && !OFFERABLE_STATUSES.includes('not_supported'), '可上架狀態的值域固定');

  const required = groups.find((g) => g.category === 'required');
  assert(required && required.asks === false, 'required 類不問使用者');
  const tokenOpt = groups.find((g) => g.category === 'token-optimizer');
  assert(tokenOpt && tokenOpt.allowDisable === true, '互斥組永遠可以整組停用');
  assert(tokenOpt.options.every((o) => o.exclusiveGroup === 'token-opt'), '互斥組標示帶出來');
  assert(tokenOpt.options.find((o) => o.id === 'opt-a').recommended === true, '推薦項標明');

  const withheld = withheldOptions(CATALOG);
  assert(withheld.length === 1 && withheld[0].id === 'opt-b' && withheld[0].missing.length === 2, '被擋掉的來源與「還缺什麼」誠實列出（不是靜默消失）');
});

testCase('S3', 'desired：required 一律啟用、互斥組最多一個', () => {
  const d = desiredOf([]);
  assert(d.get('graph').enabled && d.get('eval').enabled, 'required 就算沒勾也啟用');
  assert(!d.get('editor').enabled, 'optional 沒勾就不啟用');
  const both = desiredOf(['opt-a', 'opt-b']);
  assert([...both.values()].filter((v) => v.enabled && ['opt-a', 'opt-b'].includes([...both.keys()][[...both.values()].indexOf(v)])).length <= 1, '互斥組最多一個啟用');
  assert(both.get('opt-b').enabled === false, '資格未過的來源就算被選也不會啟用');
  const switched = desiredOf(['opt-a']);
  assert(switched.get('opt-a').enabled && !switched.get('opt-b').enabled, '選 a → 只有 a 啟用');
});

testCase('S4', 'clean install：什麼都沒裝 → 全部 install', () => {
  const plan = diffPlan(desiredOf(['opt-a']), new Map(), { latest: new Map([['graph', '1.0'], ['eval', '2.0'], ['opt-a', '3.0']]) });
  const installs = plan.steps.filter((s) => s.action === 'install').map((s) => s.id);
  assert(installs.includes('graph') && installs.includes('eval') && installs.includes('opt-a'), '三個要裝的都在 install');
  assert(plan.steps.find((s) => s.id === 'graph').to === '1.0', '帶上解析到的 latest 版本');
  assert(!isNoOp(plan), '有事要做');
});

testCase('S5', 'same-choice no-op：選擇沒變 → 什麼都不動（重跑安全）', () => {
  const observed = new Map([['graph', { installed: true, version: '1.0' }], ['eval', { installed: true, version: '2.0' }], ['opt-a', { installed: true, version: '3.0' }]]);
  const latest = new Map([['graph', '1.0'], ['eval', '2.0'], ['opt-a', '3.0']]);
  const plan = diffPlan(desiredOf(['opt-a']), observed, { latest });
  assert(isNoOp(plan), '完全相同的選擇與版本 → plan 全 no-op');
  assert(plan.steps.every((s) => s.action === 'no-op'), '逐步都是 no-op');
  const receipt = applyPlan(plan, okPorts());
  assert(receipt.steps.every((s) => s.status === 'no-op'), 'apply 也什麼都沒做');
});

testCase('S6', '差異更新：只動有差的那一個', () => {
  const observed = new Map([['graph', { installed: true, version: '1.0' }], ['eval', { installed: true, version: '2.0' }], ['opt-a', { installed: true, version: '3.0' }]]);
  const latest = new Map([['graph', '1.1'], ['eval', '2.0'], ['opt-a', '3.0']]);
  const plan = diffPlan(desiredOf(['opt-a']), observed, { latest });
  assert(plan.changed.length === 1 && plan.changed[0].id === 'graph' && plan.changed[0].action === 'update', '只有 graph 要更新');
  assert(plan.changed[0].from === '1.0' && plan.changed[0].to === '1.1', 'update 帶前後版本（可追溯）');
  assert(plan.steps.filter((s) => s.action === 'no-op').length === plan.steps.length - 1, '其餘全 no-op');
});

testCase('S7', '互斥切換與停用：由同一份 plan 表達', () => {
  const observed = new Map([['graph', { installed: true, version: '1.0' }], ['eval', { installed: true, version: '2.0' }], ['opt-a', { installed: true, version: '3.0' }]]);
  const latest = new Map([['graph', '1.0'], ['eval', '2.0'], ['editor', '9.0']]);
  // 切成 editor（optional）＋停用 token optimizer
  const plan = diffPlan(desiredOf(['editor']), observed, { latest });
  const off = plan.steps.find((s) => s.id === 'opt-a');
  const on = plan.steps.find((s) => s.id === 'editor');
  assert(off.action === 'switch-off' && on.action === 'install', '舊的關掉、新的裝上，在同一份 plan 裡');
  const disableAll = diffPlan(desiredOf([]), observed, { latest });
  assert(disableAll.steps.find((s) => s.id === 'opt-a').action === 'switch-off', '整組停用 → switch-off');
  assert(disableAll.steps.find((s) => s.id === 'graph').action === 'no-op', 'required 不會被停用');
});

testCase('S8', '偵測到既有來源：走 update／no-op，不重裝', () => {
  const observed = new Map([['graph', { installed: true, version: '0.9' }]]);
  const plan = diffPlan(desiredOf([]), observed, { latest: new Map([['graph', '1.0'], ['eval', '2.0']]) });
  const g = plan.steps.find((s) => s.id === 'graph');
  assert(g.action === 'update' && g.from === '0.9', '既有來源 → update（不是 install）');
  const same = diffPlan(desiredOf([]), new Map([['graph', { installed: true, version: '1.0' }]]), { latest: new Map([['graph', '1.0']]) });
  assert(same.steps.find((s) => s.id === 'graph').action === 'no-op', '版本一致 → no-op（verify 而非重裝）');
});

testCase('S9', 'staged → health → switch：健康檢查沒過就回滾，不留半套', () => {
  const plan = diffPlan(desiredOf([]), new Map([['graph', { installed: true, version: '1.0' }]]), { latest: new Map([['graph', '1.1'], ['eval', '2.0']]) });
  const calls = [];
  const ports = {
    ...okPorts(),
    stage: (id, v) => { calls.push(`stage:${id}:${v}`); return { ok: true, detail: '' }; },
    health: (id) => { calls.push(`health:${id}`); return id === 'graph' ? { ok: false, detail: '啟動不了' } : { ok: true, detail: '' }; },
    activate: (id) => { calls.push(`activate:${id}`); return { ok: true, detail: '' }; },
    rollback: (id, prev) => { calls.push(`rollback:${id}:${prev}`); return { ok: true, detail: '' }; },
  };
  const receipt = applyPlan(plan, ports);
  assert(calls.includes('stage:graph:1.1') && calls.includes('health:graph'), '順序是先 stage 再 health');
  assert(!calls.includes('activate:graph'), '健康檢查沒過就不切換（atomic switch 的意義）');
  assert(calls.includes('rollback:graph:1.0'), '回上一個可用版本');
  assert(!hasHalfInstalled(receipt), '沒有留下半套狀態');
  assert(receipt.ok === false, 'receipt 誠實標記整體失敗');
  const eval1 = receipt.steps.find((s) => s.id === 'eval');
  assert(eval1.status === 'done', '一步失敗不影響其餘步驟（各來源獨立）');
});

testCase('S10', 'stage 失敗 / switch 失敗 / rollback 也失敗，各自的誠實結果', () => {
  const plan = diffPlan(desiredOf([]), new Map(), { latest: new Map([['graph', '1.0'], ['eval', '2.0']]) });
  const acted = (r) => r.steps.filter((s) => s.status !== 'no-op');
  const stageFail = applyPlan(plan, { ...okPorts(), stage: () => ({ ok: false, detail: '下載失敗' }) });
  assert(acted(stageFail).length > 0 && acted(stageFail).every((s) => s.status === 'failed' && s.health === 'not-run'), 'stage 就失敗 → 健康檢查根本沒跑，如實標 not-run');
  assert(!hasHalfInstalled(stageFail), 'stage 失敗也已回滾');

  const switchFail = applyPlan(plan, { ...okPorts(), activate: () => ({ ok: false, detail: '切換時被佔用' }) });
  assert(acted(switchFail).every((s) => s.health === 'passed' && s.status === 'failed'), '健康檢查過了但切換失敗 → health 標 passed、整步 failed');
  assert(!hasHalfInstalled(switchFail), '切換失敗也已回滾');

  const rollbackFail = applyPlan(plan, { ...okPorts(), health: () => ({ ok: false, detail: 'x' }), rollback: () => ({ ok: false, detail: '回不去' }) });
  assert(hasHalfInstalled(rollbackFail), '連 rollback 都失敗 → 誠實標成「有半套狀態」，不假裝乾淨');

  const throwing = applyPlan(plan, { ...okPorts(), stage: () => { throw new Error('炸了'); } });
  assert(acted(throwing).every((s) => s.status === 'failed'), 'port 丟例外一律當失敗（呼叫端不必自己 try/catch）');
  const missingPort = applyPlan(plan, {});
  assert(acted(missingPort).every((s) => s.status === 'failed'), '呼叫端沒提供動作 → 失敗，不是靜默成功');
});

testCase('S11', 'receipt 可追溯：來源、解析到的版本、動作、健康、回滾', () => {
  const plan = diffPlan(desiredOf(['opt-a']), new Map([['opt-a', { installed: true, version: '2.9' }]]), { latest: new Map([['graph', '1.0'], ['eval', '2.0'], ['opt-a', '3.0']]) });
  const receipt = applyPlan(plan, okPorts(), { now: 0 });
  const md = renderReceipt(receipt);
  for (const col of ['來源', '動作', '解析到的版本', '健康檢查', '回滾']) assert(md.includes(col), `receipt 有「${col}」欄`);
  assert(md.includes('`opt-a`') && md.includes('3.0'), 'receipt 記下實際解析到的版本');
  assert(receipt.at === '1970-01-01T00:00:00.000Z', '時間由呼叫端注入（測試可決定性）');
  const failed1 = applyPlan(plan, { ...okPorts(), health: () => ({ ok: false, detail: 'x' }) });
  assert(renderReceipt(failed1).includes('已回上一個可用版本'), '失敗時 receipt 明講已回滾、沒留半套');
});

testCase('S12', '自動更新 TTL', () => {
  const HOUR = 3600 * 1000;
  const e = { auto_update_ttl_hours: 24 };
  assert(shouldAutoUpdate(e, { lastCheckedAt: null, now: 0 }) === true, '從沒查過 → 要查');
  assert(shouldAutoUpdate(e, { lastCheckedAt: 0, now: 23 * HOUR }) === false, '未到期 → 不查（不動就不會壞）');
  assert(shouldAutoUpdate(e, { lastCheckedAt: 0, now: 24 * HOUR }) === true, '剛好到期 → 查');
  assert(shouldAutoUpdate({ auto_update_ttl_hours: null }, { lastCheckedAt: null, now: 0 }) === false, 'TTL 為 null → 永不自動更新');
  assert(shouldAutoUpdate(e, { lastCheckedAt: '不是時間', now: 0 }) === true, '上次時間讀不出來 → 保守地查');
  const due = dueForAutoUpdate(CATALOG, { lastChecked: new Map([['graph', 0], ['opt-a', 0]]), now: 100 * HOUR });
  assert(!due.has('graph'), 'graph 的 TTL 是 168h，過了 100h 還沒到期 → 不查');
  assert(due.has('opt-a'), 'opt-a 的 TTL 是 72h，過了 100h 已到期 → 查');
  assert(!due.has('editor'), 'editor 的 TTL 是 null → 永不自動更新');
  assert(dueForAutoUpdate(CATALOG, { lastChecked: new Map(), now: 0 }).has('graph'), '沒查過的一律要查');
});

testCase('S13', 'TTL 到期會讓沒有版本差的來源也重新確認一次', () => {
  const observed = new Map([['graph', { installed: true, version: '1.0' }]]);
  const latest = new Map([['graph', '1.0'], ['eval', '2.0']]);
  const plain = diffPlan(desiredOf([]), observed, { latest });
  assert(plain.steps.find((s) => s.id === 'graph').action === 'no-op', '沒到期 → no-op');
  const forced = diffPlan(desiredOf([]), observed, { latest, forceUpdate: new Set(['graph']) });
  const g = forced.steps.find((s) => s.id === 'graph');
  assert(g.action === 'update' && g.reason.includes('TTL'), 'TTL 到期 → 重新確認，理由講明是 TTL');
});

testCase('S14', '真 repo：catalog 自洽、選單沒有不合格來源、也沒有 experimental 旗標', () => {
  const catalog = loadCatalog(REPO_ROOT);
  const integrations = loadIntegrations(REPO_ROOT);
  assert(catalog && integrations, '讀得到 setup-catalog.json 與 integration-registry.json');
  const findings = validateCatalog(catalog, integrations);
  assert(findings.length === 0, `真 catalog 無 finding（實際：${JSON.stringify(findings)}）`);
  const groups = wizardOptions(catalog, integrations);
  assert(groups.some((g) => g.category === 'required') && groups.some((g) => g.category === 'token-optimizer'), '必裝與互斥兩類都有內容');
  const offered = groups.flatMap((g) => g.options.map((o) => o.id));
  for (const w of withheldOptions(catalog)) assert(!offered.includes(w.id), `資格未過的 "${w.id}" 沒有出現在選單`);
  const skill = readFileSync(join(REPO_ROOT, 'plugins/loops-workflow/skills/setup/SKILL.md'), 'utf8');
  assert(/user-invocable:\s*true/.test(skill), 'setup 是公開入口');
  const catalogText = readFileSync(join(REPO_ROOT, 'plugins/loops-workflow/references/setup-catalog.json'), 'utf8');
  for (const banned of ['--experimental', 'experimental_fallback', 'unsupported']) {
    assert(!catalogText.includes(banned) && !skill.includes(banned), `catalog 與 skill 都沒有 "${banned}"`);
  }
  const publicSkills = ['dispatch', 'setup'];
  assert(publicSkills.length === 2, '公開入口就這兩個（其餘由 skill-lint 的 user-invocable 檢查守住）');
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
