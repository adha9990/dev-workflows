#!/usr/bin/env node
// loop-driver.mjs —— loops-workflow Stop hook：在 build 階段自動驅動迴圈續跑，是 hook 家族**第一支
// 會主動 block（decision:"block"）的 hook**。其餘家族成員一律「永不擋路」（no-op / 純注入 context），
// 唯有本 hook 在 opt-in（LOOPS_LOOP_DRIVER=1）且一連串安全前置條件皆成立時，才以 Stop hook 的
// stdout JSON `{ "decision":"block", "reason":… }` 攔下停止、把 agent 推回未完成的任務。
//
// ── 行為聲明 ─────────────────────────────────────────────────────────────────────
//   - opt-in：預設關（見 hook-flags.mjs 的 LOOPS_LOOP_DRIVER）。未開 → 立即放行。
//   - 防重入：payload.stop_hook_active===true 時放行（避免自己觸發的 Stop 又被自己攔）。
//   - fail-open：任何未預期錯誤一律吞掉並 exit 0；只有「明確判定要續跑」才會 block。
//   - 保險絲：iteration>=maxIterations → 放行（冪等，連跑多次都不 block）。
//   - 完工雙帳本：全 tasks done 時 spawn quality-gate；已跑閘紅→block、test 未跑→降級放行（弱帳本
//     標記）、test 綠→收攤刪 state。
//
// ── 單 writer 前提 ───────────────────────────────────────────────────────────────
//   state.json 的寫回假設「同一時刻只有本 hook 這一個 writer」（loops 迴圈本就序列化）。仍加簡易
//   CAS（寫前比對 updatedAt 快照，不一致→重讀重算一次）＋ tmp+rename 同目錄 atomic 寫，防偶發交錯。
//
// 分層（仿家族 stop-gate.mjs / cost-tracker.mjs）：
//   1) 純函式（無 IO，測試直接 import）：deriveCursor / shouldContinue / judgeLedger /
//      buildContinuationReason。
//   2) IO 薄邊界：main()（讀滿 stdin、定位 state、spawn quality-gate、atomic 寫回）——被 import
//      時不執行（import.meta.url 守門）。
// 依賴：僅 node 內建 + 家族內部模組（hook-flags / cost-tracker.resolveLoopsRoot）。見 #99。

import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { flagEnabled } from './hook-flags.mjs';
// 落點錨定（worktree cwd → 主 repo 根）沿用 cost-tracker 的單一真相源，不另抄一份純字串推導。
import { resolveLoopsRoot } from './cost-tracker.mjs';

const GATE_TIMEOUT_MS = 300000; // 完工品質閘上限 5 分鐘，逾時視為 spawn 失敗 → fail-open 放行
const REASON_CAP_CHARS = 10000; // 注入回 agent 的 reason 上限（10K cap），過長截斷
const BODY_HEAD_CAP_CHARS = 4000; // 單一 task body 只帶 head 段，避免超長 body 撐爆 reason
const BLOCKING_GATE_STATES = new Set(['failed', 'errored']); // 已跑閘的「紅」狀態

// ── A) 純函式層（無 IO，測試直接 import）─────────────────────────────────────────

/**
 * 找出第一個「尚未完成」的任務 index（cursor）。全空 / 全 done → -1。
 * 刻意用「首個非 done」而非「done 計數」：status 跳號假帳（如 [done, pending, done]）時，
 * cursor 精準指回中間那筆未完成任務，不會被尾端假 done 誤判成整體完工。
 */
export function deriveCursor(tasks) {
  if (!Array.isArray(tasks)) return -1;
  for (let i = 0; i < tasks.length; i += 1) {
    if (tasks[i]?.status !== 'done') return i;
  }
  return -1;
}

/**
 * 迴圈續跑的 8 步決策（純函式，逐步防呆）：任一前置未過 → { action:'pass' }（放行）；
 * 全 tasks done → { action:'complete' }（交由完工帳本判定）；其餘 → { action:'block', cursorIdx }。
 * 每一步都是「先擋邊界再前進」的 guard，順序即安全契約——fuse 必須在 complete 之前（跑爆上限就算
 * 還沒完工也放行，避免無限續跑）。
 */
export function shouldContinue({ flagOn, stopHookActive, state, sessionId, loopsAuto }) {
  if (!flagOn) return pass(); // flag 關 → 防呆放行
  if (stopHookActive) return pass(); // 防重入：本 hook 自己觸發的 Stop 不再攔
  if (!state || typeof state !== 'object') return pass(); // state 缺 / 壞 → fail-open
  if (state.stage !== 'build') return pass(); // 只在 build 階段驅動
  if (state.session !== sessionId) return pass(); // session 不符 → 非本迴圈的 Stop
  if (state.awaitingApproval === true) return pass(); // 等待人工審查 → 不硬推

  const autoOn = state.progressionMode === 'auto' || loopsAuto === true;
  if (!autoOn) return pass(); // 非 auto 且 LOOPS_AUTO 未開 → 放行（LOOPS_AUTO 具覆蓋語意）

  const iteration = safeInt(state.iteration);
  const maxIterations = safeInt(state.maxIterations);
  if (iteration >= maxIterations) return pass(); // 保險絲：跑爆上限 → 放行

  const cursorIdx = deriveCursor(state.tasks);
  if (cursorIdx === -1) return { action: 'complete', cursorIdx };
  return { action: 'block', cursorIdx };
}

function pass() {
  return { action: 'pass' };
}

/**
 * 完工雙帳本判定（純函式）：吃 quality-gate 的 GateResult + tasks，回 { verdict }。
 *   - tasks 有任一非 done（跳號假帳）→ 'block'：即便 gate 全綠也不算完工。
 *   - 已跑的閘有 failed / errored → 'block'：帶著紅燈不准收攤。
 *   - test 閘 not-run（即便 lint / type 綠）→ 'degraded'：弱帳本，不得被非 test 綠燈頂替。
 *   - test 閘 passed 且已跑者無紅、tasks 全 done → 'pass'：強帳本，收攤。
 */
export function judgeLedger(gateResult, tasks) {
  if (deriveCursor(tasks) !== -1) return { verdict: 'block' };

  const gates = gateResult?.gates ?? {};
  const hasRedGate = Object.values(gates).some((s) => BLOCKING_GATE_STATES.has(s));
  if (hasRedGate) return { verdict: 'block' };

  if (gates.test !== 'passed') return { verdict: 'degraded' };
  return { verdict: 'pass' };
}

/**
 * 組出「續跑指令」的 reason 字串（Stop hook block 時注入回 agent）。必含要素：
 * 任務 id / title / body（head 段）、半成品前置檢查指令 `git status --porcelain`、
 * 「完成後把 status 改 done」推進契約、「需審查則把 awaitingApproval 設 true」停下指令、
 * 「以 02-plan 為準、此為快照」註記。整串上限 REASON_CAP_CHARS（10K），過長截斷。
 */
export function buildContinuationReason(task, cursorIdx, total, iteration, maxIterations) {
  const id = String(task?.id ?? '');
  const title = String(task?.title ?? '');
  const body = String(task?.body ?? '').slice(0, BODY_HEAD_CAP_CHARS);
  const position = `${safeInt(cursorIdx) + 1}/${safeInt(total)}`;

  const reason = [
    '[loops-workflow] 迴圈續跑：本迴圈仍有未完成任務，請繼續推進，不要停下。',
    '',
    `當前任務（cursor ${position}，iteration ${safeInt(iteration)}/${safeInt(maxIterations)}）：`,
    `- id: ${id}`,
    `- title: ${title}`,
    '',
    'body:',
    body,
    '',
    '推進契約：',
    '1. 先跑 `git status --porcelain` 檢查是否有半成品未提交 / 未整理。',
    '2. 完成此任務後，把該任務的 status 改為 done，再繼續下一筆。',
    '3. 若需人工審查或遇阻無法自行推進，把 awaitingApproval 設為 true 後停下，不要硬推。',
    '',
    '註記：本訊息為 state.json 的快照，實際規格以 02-plan 的計畫為準。',
  ].join('\n');

  return reason.slice(0, REASON_CAP_CHARS);
}

function safeInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// ── B) IO 薄邊界：main()（被 import 時不執行）────────────────────────────────────

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const GATE_SCRIPT = join(dirname(HOOKS_DIR), 'scripts', 'loops-quality-gate.mjs');

function readStdin() {
  return readFileSync(0, 'utf8'); // fd 0 = stdin；readFileSync 讀到 EOF，一次讀滿（防大 payload EPIPE）
}

/**
 * 在 loopsRoot/.loops/<slug>/state.json 中定位「本 session」的 state：掃各 slug 目錄，讀第一個
 * session 相符的 state（stage 等其餘條件交給 shouldContinue 判）。回 { filePath, state } 或 null。
 * 全程容錯：目錄不存在 / 壞 JSON → 略過，不丟例外。
 */
function locateLoopState(loopsRoot, sessionId) {
  const loopsDir = join(loopsRoot, '.loops');
  let entries;
  try {
    entries = readdirSync(loopsDir, { withFileTypes: true });
  } catch {
    return null; // 無 .loops 目錄 → 無 state 可定位
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = join(loopsDir, entry.name, 'state.json');
    const state = readStateMaybe(filePath);
    if (state && state.session === sessionId) return { filePath, state };
  }
  return null;
}

function readStateMaybe(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null; // 檔不存在 / 壞 JSON → fail-open（視為無 state）
  }
}

/**
 * tmp+rename 同目錄 atomic 寫回，寫前做簡易 CAS：若磁碟上的 updatedAt 已與讀取快照不一致
 * （單 writer 前提被打破），改用磁碟最新版重讀一次再寫，避免覆蓋掉別人的更新。
 * 回傳實際寫回的 state（供呼叫端據其 tasks 重算 reason）。
 */
function incrementIterationAtomic(filePath, snapshot) {
  const disk = readStateMaybe(filePath);
  const base = disk && disk.updatedAt !== snapshot.updatedAt ? disk : snapshot;

  const next = {
    ...base,
    iteration: safeInt(base.iteration) + 1,
    updatedAt: new Date().toISOString(),
  };
  writeStateAtomic(filePath, next);
  return next;
}

function writeStateAtomic(filePath, stateObj) {
  const tmp = join(dirname(filePath), `.state.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(stateObj, null, 2));
  renameSync(tmp, filePath); // 同目錄 rename → 對 reader 原子可見
}

function deleteState(filePath) {
  try {
    unlinkSync(filePath); // 完工收攤：移除 state.json
  } catch {
    // 已被別人刪 / 權限問題不影響「已放行」的結果，忽略
  }
}

function emitBlock(reason) {
  // Stop hook 以 stdout JSON 傳達 block（process exit code 仍為 0）。
  console.log(JSON.stringify({ decision: 'block', reason: String(reason).slice(0, REASON_CAP_CHARS) }));
}

/** 已跑閘紅：把 quality-gate 的失敗清單攤成人讀 reason（含 code / message），供 agent 修正後再收攤。 */
function buildLedgerBlockReason(gateResult) {
  const failures = Array.isArray(gateResult?.failures) ? gateResult.failures : [];
  const lines = ['[loops-workflow] 完工品質閘未通過，請修正下列問題後再把任務收攤：'];
  for (const f of failures) {
    const where = f?.line != null ? `${f?.file ?? ''}:${f.line}` : `${f?.file ?? ''}`;
    const tag = f?.code || f?.ruleId;
    lines.push(`  - ${where} ${tag ? `[${tag}] ` : ''}${String(f?.message ?? '').split(/\r?\n/)[0].trim()}`);
  }
  return lines.join('\n');
}

/** 完工帳本判 block → iteration+1（state 留著供重跑）+ 注入失敗清單。 */
function handleLedgerBlock(filePath, state, gateResult) {
  incrementIterationAtomic(filePath, state);
  emitBlock(buildLedgerBlockReason(gateResult));
}

/** test 閘 not-run 的弱帳本：明標「弱帳本」注入回 context（不 block），仍收攤刪 state。 */
function handleDegradedCompletion(filePath) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext:
          '[loops-workflow] 弱帳本：本迴圈完工，但 test 閘為 not-run（未實際跑過測試）。' +
          '已放行收攤，惟此完工未經測試背書——請留意這不是強帳本綠燈。',
      },
    }),
  );
  deleteState(filePath);
}

/** 全 tasks done → spawn quality-gate → 依 judgeLedger 走 block / 降級放行 / 收攤三路。 */
function handleCompletion(filePath, state, cwd) {
  const res = spawnSync(
    process.execPath,
    [GATE_SCRIPT, '--cwd', cwd, '--json'],
    { encoding: 'utf8', timeout: GATE_TIMEOUT_MS },
  );
  if (res.error) return; // spawn 失敗 / 逾時 → fail-open 放行（不 block、不收攤）

  let gateResult;
  try {
    gateResult = JSON.parse(res.stdout);
  } catch {
    return; // gate 輸出解不出 → fail-open 放行
  }

  const { verdict } = judgeLedger(gateResult, state.tasks);
  if (verdict === 'block') return handleLedgerBlock(filePath, state, gateResult);
  if (verdict === 'degraded') return handleDegradedCompletion(filePath);
  deleteState(filePath); // 'pass'：強帳本，靜默收攤
}

/** 未完工續跑 → iteration+1 + 注入指回 cursor 任務的續跑指令。 */
function handleContinuation(filePath, state, cursorIdx) {
  const written = incrementIterationAtomic(filePath, state);
  const tasks = Array.isArray(written.tasks) ? written.tasks : [];
  const idx = deriveCursor(tasks); // CAS 後以實際寫回的 state 重算，指向仍未完成的那筆
  const reason = buildContinuationReason(
    tasks[idx],
    idx,
    tasks.length,
    written.iteration,
    safeInt(written.maxIterations),
  );
  emitBlock(reason);
}

/**
 * Stop hook 入口（8 步，先讀滿 stdin 再判 flag）：flag optIn → 防重入 → 定位 state（worktree cwd →
 * 主 repo 根，掃各 .loops slug 的 state.json、session/stage 雙比對）→ auto 語意 → 保險絲 → 續跑 / 完工雙帳本。
 * 全程 fail-open：任何未預期錯誤由外層守門吞掉 exit 0。
 */
function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return; // payload 壞 → no-op
  }

  const cwd = payload?.cwd;
  if (typeof cwd !== 'string') return; // 無 cwd → 無從定位 state

  const flagOn = flagEnabled('LOOPS_LOOP_DRIVER', process.env);
  if (!flagOn) return; // opt-in 未開 → 立即放行（省下所有 IO）

  const sessionId = payload.session_id;
  const located = locateLoopState(resolveLoopsRoot(cwd), sessionId);
  const state = located?.state ?? null;

  const decision = shouldContinue({
    flagOn,
    stopHookActive: payload.stop_hook_active === true,
    state,
    sessionId,
    loopsAuto: process.env.LOOPS_AUTO === '1',
  });

  if (decision.action === 'pass') return;
  if (decision.action === 'complete') return handleCompletion(located.filePath, state, cwd);
  handleContinuation(located.filePath, state, decision.cursorIdx);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch {
    // hook 絕不可因錯誤擋路：吞掉所有例外
  }
  process.exit(0);
}
