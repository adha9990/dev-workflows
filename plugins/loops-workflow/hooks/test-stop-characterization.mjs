#!/usr/bin/env node
// test-stop-characterization.mjs —— T3b（零回歸位元鎖，Stop 家族）：對 Stop 陣列 5 支 hook 的「現況
// 行為」逐位元鎖住 stdout（+exit code，兩支主要作用是寫檔的 hook 另鎖檔案內容），不是語意斷言。
//
// 紅綠分離的明文例外（比照 test-guard-characterization.mjs 的 S10）：本檔驗收不是「先紅後綠」，是
// 「現況全綠 ＋ mutation 會變紅」（見 test-characterization-mutation.mjs）——所以本檔照現行實作錄
// 現狀，fixture 直接由真跑現行 hook 產生（見 fixtures/characterization/ 下 5 份 JSON；產生方式：對
// 每支 hook 用代表性 payload 真跑，撈 stdout/exit code/檔案內容存成 fixture，不是手寫猜的）。
//
// 涵蓋 5 支（plugins/loops-workflow/hooks/，依 hooks.json 的 Stop 陣列順序）：
//   cost-tracker／eval-gate／stop-gate／progress-render／loop-driver。
// 每支至少涵蓋「正常 Stop（有合理的 loop 狀態）」「無 loop 狀態」「結構殘缺（malformed stdin）」
// 三類 payload；loop-driver 額外涵蓋 reentry-guard／完工雙帳本（degraded／ledger-block）兩種分支——
// 它是家族唯一會主動 decision:block 的 hook，分支數天生較多，見 test-rubric §6 選對測試層級。
//
// 家族輸出形狀彼此不同（各自照實鎖，不假設一致）：
//   - loop-driver.mjs：兩種輸出——hookSpecificOutput.additionalContext（弱帳本 / eval 類注入）與
//     頂層 {"decision":"block","reason":...}（emitBlock，續跑 / 完工紅燈兩處觸發點）。
//   - stop-gate.mjs：hookSpecificOutput.additionalContext（quality-gate 紅燈摘要），另有一條純文字
//     console.log(DISCOVERY_HINT)（flag 未開時的發現性提示，非 JSON）。
//   - eval-gate.mjs：hookSpecificOutput.additionalContext（三訊號合併）。
//   - cost-tracker.mjs：stdout 恆空，主要作用是 append 一行 JSON 進 .loops/.metrics/costs.jsonl。
//   - progress-render.mjs：stdout 恆空（--write-only），主要作用是重生 .loops/<slug>/PROGRESS.md；
//     且是家族唯一用 process.cwd()（非 payload.cwd）定位 .loops 的成員、完全不讀 stdin。
//
// 環境注意（比照 test-guard-characterization.mjs 的 S10）：
//   - shared.mjs 的 runCase() 一律先清空全部 LOOPS_* 環境變數再套用 case.env，防這台機器 ambient
//     shell 帶 LOOPS_MERGE_GUARD=0／LOOPS_PR_OWNER_GUARD=0 之類殘留污染斷言。
//   - sandbox 的 payload.cwd 一律用 Windows 形路徑（`C:/...`）——POSIX 形會讓 Windows 上的 node
//     解不到、靜默無輸出，會被誤讀成「沒做事」。
//   - loop-driver.mjs 只在 LOOPS_LOOP_DRIVER=1 且 auto 語意成立（progressionMode:'auto' 或
//     LOOPS_AUTO=1）時才會動作——要測到它的 block 路徑必須在 case.env／seedFiles 裡明確給這些值。
//
// 檔案內容鎖的正規化欄位（cost-tracker／progress-render，見 fixtures/characterization/shared.mjs
// 的 FILE_NORMALIZERS 與檔頭第 7 點）：
//   - cost-tracker 的 costs.jsonl：只有 `ts`（Date.now() 產生的寫入時間戳）正規化成固定 token
//     `"$TS$"`；`session_id` 是 payload 給定的固定值（非隨機產生），不需正規化。另外因 costs.jsonl
//     是 append-only 檔、同一 sandbox 在同一 test process 內可能被同一 case 重複執行（mutation 對
//     每個變異體各跑一次），故只取「最後一行」比對，不受先前執行的累積行數影響。
//   - progress-render 的 PROGRESS.md：writeFileSync 整檔覆寫、內容純由 loop.md 靜態欄位推導、不含
//     任何時間戳，天生跨次重跑穩定，原樣比對（normalize:'exact'），不需正規化。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSandbox, cleanupSandbox, hookPath, runFixtureCase,
} from './fixtures/characterization/shared.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures', 'characterization');

const HOOKS = [
  'cost-tracker.mjs',
  'eval-gate.mjs',
  'stop-gate.mjs',
  'progress-render.mjs',
  'loop-driver.mjs',
];

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

function loadFixture(hookFile) {
  const p = join(FIXTURES_DIR, hookFile.replace('.mjs', '.json'));
  return JSON.parse(readFileSync(p, 'utf8'));
}

const { root, roles } = buildSandbox();
let caseCount = 0;

try {
  for (const hookFile of HOOKS) {
    const cases = loadFixture(hookFile);
    console.log(`\n[T3b] ${hookFile}（${cases.length} cases）`);
    for (const c of cases) {
      caseCount++;
      const result = runFixtureCase(hookPath(hookFile), c, roles, root);
      assert(
        result.error == null,
        `[T3b:${hookFile}:${c.id}] spawn 無 error（${c.description}）`,
      );
      assert(
        result.actualExitCode === c.expectedExitCode,
        `[T3b:${hookFile}:${c.id}] exit code === ${c.expectedExitCode}（實得 ${result.actualExitCode}）`,
      );
      assert(
        result.actualStdout === result.expectedStdout,
        `[T3b:${hookFile}:${c.id}] stdout 逐位元吻合 fixture 鎖住的現況（${c.description}）`,
      );
      if (result.fileChecked) {
        assert(
          result.fileOk,
          `[T3b:${hookFile}:${c.id}] 寫出的檔案內容（正規化後）吻合 fixture 鎖住的現況`,
        );
      }
    }
  }
} finally {
  cleanupSandbox(root);
}

const total = passed + failed.length;
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
console.log(`(T3b：${HOOKS.length} 支 Stop hook、共 ${caseCount} 個 fixture case、${total} 條斷言——逐位元鎖住現況 stdout/exit code，寫檔類另鎖正規化後的檔案內容)`);
process.exit(failed.length > 0 ? 1 : 0);
