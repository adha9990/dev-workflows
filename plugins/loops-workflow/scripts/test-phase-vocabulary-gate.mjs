#!/usr/bin/env node
// test-phase-vocabulary-gate.mjs —— Phase Vocabulary Gate 的斷言（#219）。
//
// 這道閘要防的是「改了一半」：registry 換成新詞彙、但某份文件的流程圖還畫著舊階段、某支腳本還寫死
// 一份舊 stage 清單，於是新舊兩套詞彙長期並行而沒有人發現。所以斷言分兩面：
//   ① **抓得到真的殘留**（串連形狀的流程鏈、寫死的 stage 清單、vocabulary 自己不自洽）；
//   ② **不誤傷**（解釋「goal 為什麼不再是 phase」的句子、activity 清單、skill 名清單、測試 fixture）。
//   ②的每一條都對應一個實際存在的檔案形狀——沒有這道界，這支閘會把每份說明文件都判紅。
//
// 用法：node test-phase-vocabulary-gate.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkVocabularySelfConsistency, checkArtifactProducers, findRetiredChains,
  findHardcodedStageLists, isSyntheticFixture, buildReport,
} from './phase-vocabulary-gate.mjs';

let passed = 0;
const failed = [];
const assert = (cond, msg) => {
  if (cond) { passed += 1; console.log(`  ✓ ${msg}`); } else { failed.push(msg); console.error(`  ✗ ${msg}`); }
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RETIRED = new Set(['clarify', 'goal', 'explore', 'iterate']);
const PHASES = new Set(['define', 'plan', 'build', 'verify', 'finalize']);

// ── ① vocabulary 自洽 ──────────────────────────────────────────────────────
console.log('\n[A] vocabulary 自洽');
const good = {
  phases: [{ id: 'define', order: 1 }, { id: 'plan', order: 2 }],
  control_nodes: [{ id: 'dispatch' }, { id: 'iteration-controller' }],
  capabilities: [{ id: 'goal-contract', activities: ['create-goal'], roles: ['goal-resolver'] }],
  retired_phases: [{ id: 'goal', successor: { kind: 'capability', id: 'goal-contract' } }],
  activities: [{ id: 'create-goal' }],
  entries: [{ id: 'issue', start_phase: 'plan' }],
  knowledge: { roles: [{ id: 'goal-resolver' }] },
  handoff: { checkpoints: [{ id: 'issue', after_phase: 'define' }], stop_after: ['issue'] },
};
assert(checkVocabularySelfConsistency(good).length === 0, '自洽的 vocabulary 全綠 [A1]');

const stillPhase = { ...good, phases: [...good.phases, { id: 'goal', order: 3 }] };
assert(checkVocabularySelfConsistency(stillPhase).some((f) => f.check === 'retired-still-a-phase'),
  '同時列在 phases 與 retired_phases ⇒ 紅 [A2]');

const danglingSuccessor = { ...good, retired_phases: [{ id: 'goal', successor: { kind: 'capability', id: 'nope' } }] };
assert(checkVocabularySelfConsistency(danglingSuccessor).some((f) => f.check === 'retired-successor-missing'),
  '退場沒有去處 ⇒ 紅（這條規則等於沒有落點）[A3]');

const noRetired = { ...good, retired_phases: [] };
assert(checkVocabularySelfConsistency(noRetired).some((f) => f.check === 'vocabulary-retired-missing'),
  'retired_phases 空的 ⇒ 紅（沒有東西能證明舊詞彙真的被移除）[A4]');

const badEntry = { ...good, entries: [{ id: 'x', start_phase: 'goal' }] };
assert(checkVocabularySelfConsistency(badEntry).some((f) => f.check === 'entry-phase-missing'),
  '入口指向退場的 phase ⇒ 紅 [A5]');

const badCheckpoint = { ...good, handoff: { checkpoints: [{ id: 'issue', after_phase: 'goal' }], stop_after: ['issue', 'nope'] } };
const cpFindings = checkVocabularySelfConsistency(badCheckpoint);
assert(cpFindings.some((f) => f.check === 'checkpoint-phase-missing'), 'checkpoint 掛在退場 phase 上 ⇒ 紅 [A6]');
assert(cpFindings.some((f) => f.check === 'stop-after-missing-checkpoint'), 'stop_after 沒有對應 checkpoint ⇒ 紅 [A7]');

const badCapability = { ...good, capabilities: [{ id: 'x', activities: ['nope'], roles: ['nobody'] }] };
const capFindings = checkVocabularySelfConsistency(badCapability);
assert(capFindings.some((f) => f.check === 'capability-activity-missing')
  && capFindings.some((f) => f.check === 'capability-role-missing'),
  'capability 引用不存在的 activity / role ⇒ 紅 [A8]');

// ── ② artifact producer ────────────────────────────────────────────────────
console.log('\n[B] artifact producer');
assert(checkArtifactProducers({ artifacts: [{ artifact_id: 'x', producer: 'goal' }] }, RETIRED).length === 1,
  'producer 還是退場 phase ⇒ 紅 [B1]');
assert(checkArtifactProducers({ artifacts: [{ artifact_id: 'x', producer: 'create-goal' }] }, RETIRED).length === 0,
  'producer 換成對應 activity ⇒ 綠 [B2]');

// ── ③ 文字面：抓串連、不抓解釋 ─────────────────────────────────────────────
console.log('\n[C] 流程鏈');
assert(findRetiredChains('dispatch → goal → explore → plan → build → verify → iterate', RETIRED, PHASES).length > 0,
  '箭頭串起來的舊流程圖 ⇒ 抓到 [C1]');
assert(findRetiredChains('goal/explore/plan/build/verify/iterate', RETIRED, PHASES).length > 0,
  '斜線串起來的舊階段表 ⇒ 抓到 [C2]');
assert(findRetiredChains('goal 不再是 phase，它是跨階段的工作契約', RETIRED, PHASES).length === 0,
  '解釋「goal 為什麼退場」的句子 ⇒ 不抓（否則等於禁止文件說明改了什麼）[C3]');
assert(findRetiredChains('iterate 是 verify→build→verify 的迴圈控制', RETIRED, PHASES).length === 0,
  '鏈裡全是 canonical phase 時不抓，即使句子提到退場的名字 [C4]');
assert(findRetiredChains('route/clarify/author-issue/research/design', RETIRED, PHASES).length === 0,
  'activity 清單長得像流程串，但 canonical phase 不足 2 個 ⇒ 不抓 [C5]');
assert(findRetiredChains('define → plan → build → verify → finalize', RETIRED, PHASES).length === 0,
  '新流程圖 ⇒ 不抓 [C6]');

// ── ④ 程式碼面 ─────────────────────────────────────────────────────────────
console.log('\n[D] 寫死的 stage 清單');
assert(findHardcodedStageLists("const S = ['goal', 'explore', 'plan', 'build', 'verify', 'iterate'];", RETIRED, PHASES).length === 1,
  '寫死的六階段清單 ⇒ 抓到 [D1]');
assert(findHardcodedStageLists("const S = ['dispatch', 'goal', 'setup'];", RETIRED, PHASES).length === 0,
  'skill 名清單（canonical phase 不足 2 個）⇒ 不抓 [D2]');
assert(findHardcodedStageLists("const A = ['route', 'clarify', 'author-issue'];", RETIRED, PHASES).length === 0,
  'activity 清單 ⇒ 不抓——`clarify` 同時是合法的 activity id [D3]');
assert(findHardcodedStageLists("const S = ['define', 'plan', 'build', 'verify', 'finalize'];", RETIRED, PHASES).length === 0,
  '新的 phase 清單 ⇒ 不抓 [D4]');

assert(isSyntheticFixture('plugins/loops-workflow/scripts/test-progress.mjs') === true, '測試檔屬合成資料 [D5]');
assert(isSyntheticFixture('plugins/loops-workflow/scripts/fixtures/x/y.json') === true, 'fixtures/ 底下屬合成資料 [D6]');
assert(isSyntheticFixture('plugins/loops-workflow/scripts/progress.mjs') === false, '正式腳本不是合成資料 [D7]');

// ── ⑤ 真的跑一次整個 repo ──────────────────────────────────────────────────
console.log('\n[E] 全 repo');
const report = buildReport(REPO_ROOT);
assert(report.ok, `本 repo 目前沒有新舊詞彙並行${report.ok ? '' : `（${report.findings.map((f) => `${f.file}: ${f.detail}`).join('；')}）`} [E1]`);
assert((report.scanned ?? 0) > 50, `掃描面涵蓋到實際檔案（掃了 ${report.scanned} 檔）[E2]`);

console.log(`\n${failed.length === 0 ? '✓' : '✗'} phase-vocabulary-gate：${passed} 個斷言通過、${failed.length} 個失敗`);
for (const f of failed) console.error(`  ✗ ${f}`);
process.exit(failed.length === 0 ? 0 : 1);
