#!/usr/bin/env node
// test-effort-profile.mjs —— 投入檔位判定與地板稽核的斷言（#222）。
// 對應驗收標準：檔位判不出來一律落在 standard（不是 direct）；使用者只能把檔位往上調；
// 高風險路徑判定不靠子字串（`tokenizer` 不算碰密鑰）；量不到 diff 時 highrisk=unknown 且閘放行；
// 宣稱 direct 卻碰高風險硬閘 → floor=violated；降檔一律回報為棘輪違反。
// 用法：node test-effort-profile.mjs [--filter <case-prefix>] [--min-cases <n>]

import {
  PROFILE_ORDER, DEFAULT_PROFILE, DIRECT_CHECK_IDS, DEEP_TRIGGER_IDS,
  profileRank, isProfile, maxProfile, pathWords, highRiskCategory, isExcludedFromRisk, classifyChangedPaths,
  classifyProfile, ratchetViolation, parseDeclaredProfile, parseEscalations, effectiveProfile,
  auditFloor, renderMarker, renderReport, registryProfiles,
} from './effort-profile.mjs';

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

/** 七條 direct 判準全成立的 signals。 */
const allDirect = (overrides = {}) => ({
  direct_checks: Object.fromEntries(DIRECT_CHECK_IDS.map((id) => [id, true])),
  ...overrides,
});

// ══════════════════════════════════════════════════════════════════════════
testCase('P1', '值域與排序：三檔、只升不降靠 rank 判定', () => {
  assert(PROFILE_ORDER.join(',') === 'direct,standard,deep', '三個檔位、由鬆到嚴排序');
  assert(profileRank('direct') === 0 && profileRank('deep') === 2, 'rank 對得上排序');
  assert(profileRank('nope') === null && isProfile('nope') === false, '認不得的 id 判不出 rank（不當成某一檔）');
  assert(maxProfile('direct', 'deep') === 'deep' && maxProfile('deep', 'standard') === 'deep', 'maxProfile 取較嚴的');
  assert(maxProfile(null, 'direct') === 'direct' && maxProfile('direct', null) === 'direct', '一方判不出來就回另一方');
  assert(maxProfile(null, null) === null, '都判不出來就誠實回 null，不編一個預設值');
});

testCase('P2', '判不出來一律落在 standard —— 預設不是 direct', () => {
  assert(DEFAULT_PROFILE === 'standard', '預設檔位是 standard（向嚴是預設方向）');
  assert(classifyProfile(undefined).profile === 'standard', '完全沒給 signals → standard');
  assert(classifyProfile({}).profile === 'standard', '空 signals → standard');
  const partial = classifyProfile({ direct_checks: { D1: true, D2: true, D3: true } });
  assert(partial.profile === 'standard', '只核了三條 → 其餘視為不成立 → standard');
  assert(partial.unknown_checks.includes('D7'), '沒核到的判準被列出來（不靜默當成立）');
  const falsy = classifyProfile({ direct_checks: Object.fromEntries(DIRECT_CHECK_IDS.map((id) => [id, 'yes'])) });
  assert(falsy.profile === 'standard', '非布林 true（字串 "yes"）不算成立——只認 === true');
});

testCase('P3', 'direct 要七條全成立；任一條翻掉就退回 standard', () => {
  assert(classifyProfile(allDirect()).profile === 'direct', 'D1–D7 全 true → direct');
  for (const id of DIRECT_CHECK_IDS) {
    const s = allDirect();
    s.direct_checks[id] = false;
    const r = classifyProfile(s);
    assert(r.profile === 'standard', `${id} 不成立 → 退回 standard`);
    assert(r.reasons.join('').includes(id), `理由指名是哪一條不成立（${id}）`);
  }
});

testCase('P4', 'deep 觸發優先於 direct，且認不得的 trigger 不靜默吃掉', () => {
  for (const t of DEEP_TRIGGER_IDS) {
    const r = classifyProfile(allDirect({ deep_triggers: [t] }));
    assert(r.profile === 'deep', `${t} 命中 → deep（即使七條 direct 判準都寫成立）`);
  }
  const typo = classifyProfile(allDirect({ deep_triggers: ['E-hihg-risk'] }));
  assert(typo.profile === 'direct', '打錯字的 trigger 不會被當成命中');
  assert(typo.reasons.some((x) => x.includes('E-hihg-risk')), '但打錯字有被列出來——靜默吃掉會讓打錯看起來像沒命中');
});

testCase('P5', '使用者只能把檔位往上調，不能往下', () => {
  const up = classifyProfile(allDirect({ user_profile: 'deep' }));
  assert(up.profile === 'deep', '判準是 direct、使用者要 deep → deep');
  const down = classifyProfile({ deep_triggers: ['E-high-risk'], user_profile: 'direct' });
  assert(down.profile === 'deep', '判準是 deep、使用者要 direct → 仍是 deep（檔位不能被要求調低）');
  assert(down.reasons.some((x) => x.includes('只能往上')), '有解釋為什麼沒照使用者說的降');
  const bogus = classifyProfile(allDirect({ user_profile: 'turbo' }));
  assert(bogus.profile === 'direct' && bogus.reasons.some((x) => x.includes('turbo')), '認不得的 user_profile 被忽略但有留痕');
});

testCase('P6', '高風險路徑判定以「詞」為單位，不是子字串', () => {
  assert(highRiskCategory('src/services/auth/login.ts') === 'auth', 'auth 目錄命中');
  assert(highRiskCategory('sql/migrations/007_add_index.sql') === 'schema-migration', 'migration 命中');
  assert(highRiskCategory('src/http/routes/orders.ts') === 'external-contract', '對外路由命中');
  assert(highRiskCategory('src/jobs/queue-worker.ts') === 'concurrency', '背景 job 命中');
  assert(highRiskCategory('.github/workflows/ci.yml') === 'iac-deploy', 'CI 設定命中');
  assert(highRiskCategory('infra/main.tf') === 'iac-deploy', '副檔名層級也判得到');
  assert(highRiskCategory('src/lexer/tokenizer.ts') === null, '`tokenizer` 不算碰 token —— 子字串比對會在這裡誤判');
  assert(highRiskCategory('client/src/components/Button.tsx') === null, '一般 UI 元件不命中');
  assert(highRiskCategory('docs/README.md') === null, '文件不命中');
  assert(pathWords('src/authGuard.ts').includes('auth'), 'camelCase 切得開（authGuard → auth）');
});

testCase('P6b', '純文件與測試面先被扣掉，才比對關鍵字（誤判會讓人學會忽略這道閘）', () => {
  assert(isExcludedFromRisk('references/shared/capability/goal-contract.md') === 'doc',
    '規範文件不因為檔名有 contract 就算碰對外契約');
  assert(highRiskCategory('references/shared/capability/goal-contract.md') === null, '扣掉後不命中');
  assert(isExcludedFromRisk('references/shared/capability/decision-queue.md') === 'doc',
    '規範文件不因為檔名有 queue 就算碰並發');
  assert(isExcludedFromRisk('scripts/test-artifact-contract.mjs') === 'test',
    '測試檔走 diff-footprint 的測試面判定（不抄第二份清單）');
  assert(highRiskCategory('src/services/auth/__tests__/login.test.ts') === null,
    'auth 的測試檔也是測試面 —— test-only 在風險梯裡本來就是瑣碎級');
  assert(isExcludedFromRisk('src/services/auth/login.ts') === null, '真的 code 不被扣掉');
  assert(highRiskCategory('sql/migrations/001.sql') === 'schema-migration', 'migration 不是文件、照樣命中');
  assert(highRiskCategory('.github/workflows/ci.yml') === 'iac-deploy', 'CI 設定不是文件、照樣命中');
});

testCase('P7', '量不到 diff → highrisk=unknown，不猜成 no', () => {
  assert(classifyChangedPaths(null).state === 'unknown', 'null（讀不到）→ unknown');
  assert(classifyChangedPaths(undefined).state === 'unknown', 'undefined → unknown');
  assert(classifyChangedPaths([]).state === 'no', '空清單（真的沒改動）→ no —— 與「讀不到」是兩件事');
  assert(classifyChangedPaths(['src/a.ts']).state === 'no', '沒碰高風險 → no');
  const yes = classifyChangedPaths(['src/services/auth/token-store.ts', 'src/a.ts']);
  assert(yes.state === 'yes' && yes.hits.length === 1, '命中的逐條列出來（不是只回一個布林）');
});

testCase('P8', 'loop.md 解析：檔位欄與升檔軌跡', () => {
  const md = [
    '# loop：222-adaptive-effort',
    '- 類型：issue',
    '- 投入檔位：direct（判準 id：D1–D7）',
    '## Journal',
    '- [E3] 投入檔位 direct → standard｜R-contract｜冒出新套件',
    '- [E4] 一般敘述裡提到 direct 與 standard 但不是升檔紀錄',
  ].join('\n');
  assert(parseDeclaredProfile(md) === 'direct', '讀得到宣告的檔位');
  assert(parseDeclaredProfile('- effort_profile: deep') === 'deep', '英文欄名也認');
  assert(parseDeclaredProfile('沒有這一欄') === null, '沒有就誠實回 null');
  const esc = parseEscalations(md);
  assert(esc.length === 1 && esc[0].from === 'direct' && esc[0].to === 'standard', '只認同一行內的 A → B，散文不誤判');
  assert(effectiveProfile('direct', esc) === 'standard', '生效檔位＝宣告值與升檔目標取最嚴（防欄位忘了改）');
});

testCase('P9', '地板稽核：宣稱 direct 卻碰高風險硬閘 → violated', () => {
  const bad = auditFloor({ declared: 'direct', changedPaths: ['src/services/auth/session.ts'] });
  assert(bad.floor === 'violated' && bad.highrisk === 'yes', '碰 auth → floor=violated');
  assert(bad.violations[0].check === 'direct-touches-high-risk', '違反項指名是哪一條');
  assert(bad.violations[0].detail.includes('升檔'), '處置寫的是升檔補做，不是改 marker');

  const ok = auditFloor({ declared: 'direct', changedPaths: ['client/src/App.tsx'] });
  assert(ok.floor === 'ok', '沒碰高風險 → ok');

  const standardHighRisk = auditFloor({ declared: 'standard', changedPaths: ['sql/migrations/1.sql'] });
  assert(standardHighRisk.floor === 'ok', 'standard 碰高風險不是地板違反（那是 verify 選軸要處理的事，不是這道閘）');

  const unknown = auditFloor({ declared: 'direct', changedPaths: null });
  assert(unknown.floor === 'ok' && unknown.highrisk === 'unknown', '量不到就不判違規（機械閘寧可漏擋不可誤擋）');

  const escalated = auditFloor({
    declared: 'direct',
    escalations: [{ from: 'direct', to: 'deep' }],
    changedPaths: ['src/services/auth/session.ts'],
  });
  assert(escalated.floor === 'ok' && escalated.profile === 'deep', '已經升檔補做過的 loop 不再被擋');
});

testCase('P10', '棘輪：降檔一律回報為違反', () => {
  assert(ratchetViolation('direct', 'standard') === null, '升檔合法');
  assert(ratchetViolation('standard', 'standard') === null, '同檔不算違反');
  const v = ratchetViolation('deep', 'direct');
  assert(v !== null && v.detail.includes('只升不降'), '降檔回報違反並說明規則');
  assert(ratchetViolation('deep', 'nope') === null, '判不出來的 id 不判違規');
  const audited = auditFloor({ declared: 'deep', escalations: [{ from: 'deep', to: 'direct' }], changedPaths: [] });
  assert(audited.ratchet.length === 1, '稽核把降檔列進 ratchet 清單');
  assert(audited.profile === 'deep', '生效檔位仍是較嚴的那個——降檔不會因為寫在 Journal 就生效');
});

testCase('P11', 'marker 是 pr-gate 閘⑨ 的唯一契約（單行、HTML 註解、欄位齊全）', () => {
  const audit = auditFloor({ declared: 'direct', changedPaths: ['src/services/auth/session.ts'] });
  const marker = renderMarker(audit);
  assert(!marker.includes('\n'), 'marker 是單獨一行');
  assert(marker.startsWith('<!-- loops-effort ') && marker.endsWith(' -->'), 'HTML 註解形（rendered 不可見）');
  for (const k of ['profile=', 'floor=', 'highrisk=', 'escalated=']) assert(marker.includes(k), `marker 帶 ${k} 欄`);
  assert(marker.includes('floor=violated') && marker.includes('highrisk=yes'), '欄位值反映實際判定');
  assert(renderReport(audit).includes(marker), '人讀報告最後一行就是同一份 marker');
  const noDeclare = renderMarker(auditFloor({ declared: null, changedPaths: [] }));
  assert(noDeclare.includes('profile=unknown'), '沒宣告檔位就寫 unknown，不補一個看起來合理的值');
});

testCase('P12', 'registry 是值域正本，腳本常數只是 fallback', () => {
  const fromRegistry = registryProfiles();
  assert(Array.isArray(fromRegistry), 'registry 讀得到 effort_profiles.profiles');
  assert(fromRegistry.join(',') === PROFILE_ORDER.join(','), 'registry 的值域與腳本常數一致（不一致就是漂移）');
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
