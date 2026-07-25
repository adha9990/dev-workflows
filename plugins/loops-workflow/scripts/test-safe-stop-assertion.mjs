#!/usr/bin/env node
// test-safe-stop-assertion.mjs —— T26：讓「auto 模式不吞安全停」這條規則有可機械驗證的承載。
//
// 背景（見任務描述）：規則說 auto 模式下一般決策可用推薦選項自動帶過，但安全停不得略過。
// 但這條規則在修此檔前是純散文契約、repo 內零 runtime 承載——`grep -rn "安全停" --include=*.mjs`
// 全 repo零命中。既有 `hooks/test-loop-driver.mjs` 的「closed + LOOPS_AUTO=1 → block」一條，
// `block` 指的是「續跑」（loop-driver 覆蓋 closed 語意），跟「安全停不得被略過」是**兩件事**，
// 不能拿來當這條規則的證據（在 master 上本來就綠、零工作量就能打勾，等於沒驗到）。
//
// 本檔驗三件事（對應任務描述 1/2/3）：
//   1. canonical 規則文字（AGENTS.md + references/auto-mode.md）裡確實有「安全停不得被
//      auto 略過」這條——用結構化斷言（標頭存在、清單項數、表格欄位語意）驗語意要素，
//      不是只 grep 一個詞。
//   2. corpus 的 high-risk-182-safe-stop 案例，其 trajectory oracle 能區分「停了、之後老實
//      走完全部關卡」（ok=true）與「跳過安全停、之後偷跑省關卡」（ok=false，漏 verify）。
//   3. auto-mode.md 對 `LOOPS_AUTO` 的段落（loop-driver 續跑覆蓋 closed）與安全停段落
//      結構上分離——不把「續跑」語意跟「略過安全停」語意混談。
//
// 分層：
//   1) 純函式（無 IO）：checkSafeStopHardStopClause / checkAutoModeCollapseKeepsSafeStop /
//      checkHardStopSection / checkSafeStopTableRow / checkLoopsAutoDistinctFromSafeStop /
//      checkSafeStopProse（彙整器）—— 對傳入的文字字串做結構化斷言，可對真檔與負向 fixture
//      都跑同一份規則，逼負向 fixture 真的變紂。
//   2) IO：讀 AGENTS.md / auto-mode.md 真檔、讀負向 fixture、讀 corpus case + observed journal
//      （trajectory 檢查直接 reuse `eval-trajectory.mjs` 既有的 readObservedStages/checkTrajectory，
//      不重造——見 reuse-check）。
//
// 硬約束（任務描述）：這支測試在移除規則後必須變紅；已用負向 fixture
// （scripts/fixtures/safe-stop-assertion/）實測驗證過。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readObservedStages, checkTrajectory } from './eval-trajectory.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..'); // scripts -> loops-workflow -> plugins -> repo root
const FIXTURES_DIR = join(HERE, 'fixtures', 'safe-stop-assertion');
const CORPUS_DIR = join(HERE, '..', 'evals', 'baseline', 'corpus');

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 純函式層：對 AGENTS.md / auto-mode.md 文字做結構化斷言（可對真檔與負向 fixture 都跑）
// ══════════════════════════════════════════════════════════════════════════

/**
 * AGENTS.md：安全停須被定義為「一定停」的硬煞車、且觸發類別 ≥ 3 種（用 `/` 列舉）。
 * 只驗一個詞（「安全停」出現與否）撿不到「定義弱化成可選」這種退化，所以連著「一定停」
 * 與列舉項數一起驗。
 */
export function checkSafeStopHardStopClause(agentsMdText) {
  const findings = [];
  const m = /安全停（一定停\s*\+\s*問）\*{0,2}\s*[:：]\s*([^\n]+)/.exec(agentsMdText);
  if (!m) {
    findings.push({ check: 'agents-md-hard-stop-clause', detail: 'AGENTS.md 找不到「安全停（一定停 + 問）」的定義句' });
    return findings;
  }
  const items = m[1].split('/').map((s) => s.trim()).filter(Boolean);
  if (items.length < 3) {
    findings.push({
      check: 'agents-md-hard-stop-categories',
      detail: `AGENTS.md 安全停定義句列舉的觸發類別過少（實際 ${items.length} 項：${JSON.stringify(items)}），至少要 3 項才算有實質內容`,
    });
  }
  return findings;
}

/**
 * AGENTS.md：`auto 模式` 那一句必須明講「決策用推薦選項自動帶過」之外，安全停仍然保留
 * （原句「只剩安全停」）——這是「一般決策可自動帶過、安全停不得略過」語意的直接承載。
 */
export function checkAutoModeCollapseKeepsSafeStop(agentsMdText) {
  const findings = [];
  const line = agentsMdText.split('\n').find((l) => l.includes('auto 模式') && l.includes('LOOPS_AUTO=1'));
  if (!line) {
    findings.push({ check: 'agents-md-auto-mode-line-missing', detail: 'AGENTS.md 找不到定義 auto 模式（LOOPS_AUTO=1）行為的句子' });
    return findings;
  }
  if (!/推薦選項自動帶過/.test(line)) {
    findings.push({ check: 'agents-md-auto-collapses-decisions', detail: `auto 模式句缺「決策用推薦選項自動帶過」語意（實際：${line.trim()}）` });
  }
  if (!/安全停/.test(line)) {
    findings.push({
      check: 'agents-md-auto-keeps-safe-stop',
      detail: `auto 模式句沒有明講安全停被保留、不隨決策一起被自動帶過（實際：${line.trim()}）`,
    });
  }
  return findings;
}

/**
 * auto-mode.md：要有一個明講「這些情況一定停（auto 的硬煞車）」的標頭段落，
 * 底下列舉 ≥ 3 條硬煞車項目（編號清單）——證明「安全停」不是散文裡順口一提，
 * 而是有專屬結構化清單。
 */
export function checkHardStopSection(autoModeText) {
  const findings = [];
  const headerRe = /##\s*但這些情況\*{0,2}一定停\*{0,2}（auto 的硬煞車）/;
  const headerMatch = headerRe.exec(autoModeText);
  if (!headerMatch) {
    findings.push({ check: 'auto-mode-hard-stop-header-missing', detail: 'auto-mode.md 找不到「這些情況一定停（auto 的硬煞車）」標頭段落' });
    return findings;
  }
  const afterHeader = autoModeText.slice(headerMatch.index + headerMatch[0].length, headerMatch.index + headerMatch[0].length + 2000);
  const items = afterHeader.split('\n').filter((l) => /^\d+\.\s/.test(l.trim()));
  if (items.length < 3) {
    findings.push({
      check: 'auto-mode-hard-stop-items-too-few',
      detail: `硬煞車標頭下的編號清單項數過少（實際 ${items.length} 項），撐不起「一定停」是一組具體規則、不是空話`,
    });
  }
  return findings;
}

/**
 * auto-mode.md：預設/auto 對照表要有「安全停點」一列，且 auto 欄位要有實質內容
 * （危險 / P0 / 失敗等關鍵字），不能空白或寫「略過」——這是「auto 欄仍保留安全停」的
 * 表格化承載，跟硬煞車標頭段落互為佐證（雙重承載、其一被刪都能抓到）。
 */
export function checkSafeStopTableRow(autoModeText) {
  const findings = [];
  const rowMatch = autoModeText.split('\n').find((l) => /^\|\s*安全停點\s*\|/.test(l.trim()));
  if (!rowMatch) {
    findings.push({ check: 'auto-mode-safe-stop-row-missing', detail: 'auto-mode.md 對照表找不到「安全停點」列' });
    return findings;
  }
  const cells = rowMatch.split('|').map((c) => c.trim()).filter((c, i, arr) => !(c === '' && (i === 0 || i === arr.length - 1)));
  // cells: ['安全停點', <預設欄>, <auto 欄>]
  const autoCell = cells[2] ?? '';
  if (!autoCell) {
    findings.push({ check: 'auto-mode-safe-stop-row-auto-cell-empty', detail: `安全停點列缺 auto 欄（實際整列：${rowMatch.trim()}）` });
  } else if (/^(無|略過|不生效|不適用)$/.test(autoCell) || !/危險|P0|失敗|規格/.test(autoCell)) {
    findings.push({
      check: 'auto-mode-safe-stop-row-auto-cell-skips',
      detail: `安全停點列的 auto 欄看起來把安全停略過或清空、缺具體停止類別（實際：${autoCell}）`,
    });
  }
  return findings;
}

/**
 * auto-mode.md：`LOOPS_AUTO` 段落（loop-driver 讓 build 機械續跑、覆蓋 closed）要跟「安全停
 * 不得被略過」語意結構上分離——該段要講「續跑」與「closed」，且**不得**在同一段落宣稱
 * 略過/跳過安全停。這是任務描述第 3 點：把 LOOPS_AUTO 的續跑覆蓋語意跟安全停明確區分。
 */
export function checkLoopsAutoDistinctFromSafeStop(autoModeText) {
  const findings = [];
  const idx = autoModeText.indexOf('LOOPS_AUTO=1');
  if (idx === -1) {
    findings.push({ check: 'auto-mode-loops-auto-mention-missing', detail: 'auto-mode.md 找不到 LOOPS_AUTO=1 的說明' });
    return findings;
  }
  // 取 LOOPS_AUTO 出現處往後一段（同一個條列項的篇幅），檢查是否講到 loop-driver 的續跑/closed 覆蓋語意
  const paragraph = autoModeText.slice(idx, idx + 600);
  const mentionsContinuation = /續跑/.test(paragraph) && /closed/.test(paragraph);
  if (!mentionsContinuation) {
    findings.push({
      check: 'auto-mode-loops-auto-continuation-semantics-missing',
      detail: 'LOOPS_AUTO 段落沒有講清楚它管的是「續跑覆蓋 closed」（loop-driver 語意），跟安全停是兩回事這件事沒被明講',
    });
  }
  if (/略過安全停|跳過安全停/.test(paragraph)) {
    findings.push({
      check: 'auto-mode-loops-auto-conflates-safe-stop-skip',
      detail: 'LOOPS_AUTO 段落把「續跑」跟「略過安全停」混談了，違反兩者要區分的規則',
    });
  }
  return findings;
}

/** 彙整器：對 { agentsMd, autoMode } 兩份文字跑全部結構化斷言，回 { ok, findings }。 */
export function checkSafeStopProse({ agentsMd, autoMode }) {
  const findings = [
    ...checkSafeStopHardStopClause(agentsMd),
    ...checkAutoModeCollapseKeepsSafeStop(agentsMd),
    ...checkHardStopSection(autoMode),
    ...checkSafeStopTableRow(autoMode),
    ...checkLoopsAutoDistinctFromSafeStop(autoMode),
  ];
  return { ok: findings.length === 0, findings };
}

// ══════════════════════════════════════════════════════════════════════════
// 1. 正向：真實 AGENTS.md + references/auto-mode.md → 全綠（0 findings）
// ══════════════════════════════════════════════════════════════════════════
const REAL_AGENTS_MD = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8');
const REAL_AUTO_MODE_MD = readFileSync(join(REPO_ROOT, 'plugins', 'loops-workflow', 'references', 'auto-mode.md'), 'utf8');

{
  const result = checkSafeStopProse({ agentsMd: REAL_AGENTS_MD, autoMode: REAL_AUTO_MODE_MD });
  assert(
    result.ok === true,
    `真實 AGENTS.md + auto-mode.md → checkSafeStopProse ok===true（實際 findings：${JSON.stringify(result.findings)}）[canonical-positive]`,
  );
}
{
  const findings = checkSafeStopHardStopClause(REAL_AGENTS_MD);
  assert(findings.length === 0, `真實 AGENTS.md：安全停硬煞車定義句 + ≥3 觸發類別存在（findings：${JSON.stringify(findings)}）[canonical-a]`);
}
{
  const findings = checkAutoModeCollapseKeepsSafeStop(REAL_AGENTS_MD);
  assert(findings.length === 0, `真實 AGENTS.md：auto 模式句同時講「決策自動帶過」與「只剩安全停」（findings：${JSON.stringify(findings)}）[canonical-b]`);
}
{
  const findings = checkHardStopSection(REAL_AUTO_MODE_MD);
  assert(findings.length === 0, `真實 auto-mode.md：硬煞車標頭 + ≥3 項編號清單存在（findings：${JSON.stringify(findings)}）[canonical-c]`);
}
{
  const findings = checkSafeStopTableRow(REAL_AUTO_MODE_MD);
  assert(findings.length === 0, `真實 auto-mode.md：對照表「安全停點」列、auto 欄有實質停止類別（findings：${JSON.stringify(findings)}）[canonical-d]`);
}
{
  const findings = checkLoopsAutoDistinctFromSafeStop(REAL_AUTO_MODE_MD);
  assert(findings.length === 0, `真實 auto-mode.md：LOOPS_AUTO 段落講續跑/closed、不與安全停混談（findings：${JSON.stringify(findings)}）[canonical-e]`);
}

// ══════════════════════════════════════════════════════════════════════════
// 2. 負向：移除該規則的散文 fixture → 必須紅（證明測試真的在量東西、不是恆綠）
// ══════════════════════════════════════════════════════════════════════════
const FIXTURE_AGENTS_MD = readFileSync(join(FIXTURES_DIR, 'agents-md-no-safe-stop.md'), 'utf8');
const FIXTURE_AUTO_MODE_MD = readFileSync(join(FIXTURES_DIR, 'auto-mode-no-safe-stop.md'), 'utf8');

{
  const result = checkSafeStopProse({ agentsMd: FIXTURE_AGENTS_MD, autoMode: FIXTURE_AUTO_MODE_MD });
  assert(
    result.ok === false && result.findings.length > 0,
    `負向 fixture（規則已移除）→ checkSafeStopProse ok===false 且 findings 非空（實際：${JSON.stringify(result)}）[negative-aggregate]`,
  );
}
{
  const findings = checkSafeStopHardStopClause(FIXTURE_AGENTS_MD);
  assert(findings.length > 0, `負向 fixture AGENTS.md：安全停硬煞車定義句已移除 → 命中 finding（實際：${JSON.stringify(findings)}）[negative-a]`);
}
{
  const findings = checkAutoModeCollapseKeepsSafeStop(FIXTURE_AGENTS_MD);
  assert(
    findings.some((f) => f.check === 'agents-md-auto-keeps-safe-stop'),
    `負向 fixture AGENTS.md：auto 模式句不再提安全停保留 → 命中 agents-md-auto-keeps-safe-stop（實際：${JSON.stringify(findings)}）[negative-b]`,
  );
}
{
  const findings = checkHardStopSection(FIXTURE_AUTO_MODE_MD);
  assert(
    findings.some((f) => f.check === 'auto-mode-hard-stop-header-missing'),
    `負向 fixture auto-mode.md：硬煞車段落整段被拿掉 → 命中 auto-mode-hard-stop-header-missing（實際：${JSON.stringify(findings)}）[negative-c]`,
  );
}
{
  const findings = checkSafeStopTableRow(FIXTURE_AUTO_MODE_MD);
  assert(
    findings.some((f) => f.check === 'auto-mode-safe-stop-row-missing'),
    `負向 fixture auto-mode.md：對照表「安全停點」列被拿掉 → 命中 auto-mode-safe-stop-row-missing（實際：${JSON.stringify(findings)}）[negative-d]`,
  );
}
{
  const findings = checkLoopsAutoDistinctFromSafeStop(FIXTURE_AUTO_MODE_MD);
  assert(
    findings.some((f) => f.check === 'auto-mode-loops-auto-continuation-semantics-missing'),
    `負向 fixture auto-mode.md：LOOPS_AUTO 段落不再講續跑/closed → 命中 continuation-semantics-missing（實際：${JSON.stringify(findings)}）[negative-e]`,
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 3. corpus：high-risk-182-safe-stop 案例存在、其 trajectory oracle 能區分
//    「停了、之後老實走完全部關卡」（ok=true）與「跳過安全停、之後偷跑省關卡」（ok=false）。
//    直接 reuse eval-trajectory.mjs 的 readObservedStages/checkTrajectory，不重造判定邏輯。
// ══════════════════════════════════════════════════════════════════════════
const CASE_FILE = join(CORPUS_DIR, 'high-risk-182-safe-stop.json');
const corpusCase = JSON.parse(readFileSync(CASE_FILE, 'utf8'));

assert(corpusCase.category === 'high-risk', `corpus case high-risk-182-safe-stop：category==='high-risk'（實際：${corpusCase.category}）[corpus-a]`);
assert(corpusCase.oracle?.type === 'trajectory-rules', `corpus case：oracle.type==='trajectory-rules'（實際：${corpusCase.oracle?.type}）[corpus-b]`);
assert(/安全停/.test(corpusCase.description ?? ''), `corpus case description 提到「安全停」情境（實際：${corpusCase.description}）[corpus-c]`);

const reference = corpusCase.oracle.config.reference;
const observedJournalPath = join(CORPUS_DIR, corpusCase.oracle.config.observed_journal);
const positiveObserved = readObservedStages(observedJournalPath);
const positiveResult = checkTrajectory(positiveObserved, reference);
assert(
  positiveResult.ok === true,
  `corpus case 真實 observed journal（安全停後老實走完 build→verify→iterate）→ checkTrajectory ok===true（實際：${JSON.stringify(positiveResult)}）[corpus-positive]`,
);

// 負向 trajectory fixture：撞到同一個認證卡點卻不安全停、直接偷跑跳過 verify 收圈——
// 用來證明 oracle 真的能區分「停了、老實走完」與「沒老實走完」，不是恆真。
const negativeJournalPath = join(FIXTURES_DIR, 'no-safe-stop-observed-journal.md');
const negativeObserved = readObservedStages(negativeJournalPath);
const negativeResult = checkTrajectory(negativeObserved, reference);
assert(
  negativeResult.ok === false && negativeResult.missing.includes('verify'),
  `負向 trajectory fixture（略過安全停、偷跑省 verify）→ checkTrajectory ok===false 且漏 verify（實際：${JSON.stringify(negativeResult)}）[corpus-negative]`,
);

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.error('\n失敗清單：');
  for (const msg of failed) console.error(`  - ${msg}`);
  process.exit(1);
}
process.exit(0);
