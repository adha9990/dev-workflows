#!/usr/bin/env node
// test-guard-characterization.mjs —— S10（零回歸位元鎖）：對 9 支既有 hook 的「現況行為」逐位元
// 鎖住 stdout（+exit code），不是語意斷言。這 9 支之後都會被改成吃正規化輸入／經統一輸出投影
// （dual-harness compat layer），本檔先把「現在到底印什麼」釘死，讓那次改動有一張問「有沒有變」
// 的底片可比對。
//
// 紅綠分離的明文例外（見 issue #183 任務 T3）：本檔的驗收不是「先紅後綠」，是「現況全綠 ＋
// mutation 會變紅」（見同目錄 test-characterization-mutation.mjs）——所以本檔照現行實作錄現狀，
// fixture 直接由真跑現行 hook 產生（見 fixtures/characterization/ 下 9 份 JSON；產生方式：對每支
// hook 用代表性 payload 真跑，撈 stdout/exit code 存成 fixture，不是手寫猜的）。
//
// 涵蓋 9 支（plugins/loops-workflow/hooks/）：merge-guard／config-protection／worktree-guard／
// loops-path-guard／pr-gate／pr-owner-guard／outbound-comment-guard／suggest-compact／
// edit-accumulator。每支至少涵蓋 deny／放行／結構殘缺（malformed stdin）三類 case。
//
// 環境注意（比照 test-merge-guard.mjs:154-166 的 runHook）：這台機器的 shell env 帶著
// LOOPS_MERGE_GUARD=0／LOOPS_PR_OWNER_GUARD=0 之類殘留——shared.mjs 的 runCase() 一律先清空全部
// LOOPS_* 再套用 case.env，防 ambient 殘留把 guard 整支關掉、測試變成空的（見 fixtures/
// characterization/shared.mjs 的 runCase 註解，推廣到全部 9 支的全部 LOOPS_* 旗標）。
// 環境注意 2：sandbox 的 payload.cwd 一律用 Windows 形路徑（`C:/...`，見 shared.mjs buildSandbox()
// 產生的 roles）——POSIX 形（`/c/...`）會讓 Windows 上的 node 解不到、靜默無輸出，會被誤讀成
// 「沒擋」。
//
// 已知的「輸出含絕對路徑」欄位（無法直接字面鎖死，已正規化處理，非放棄鎖定）：
// outbound-comment-guard.mjs 的 read-gate deny 訊息含本機這份 checkout 的絕對路徑
// （COMMENT_POLICY_PATH／OUTBOUND_TEMPLATES_PATH，由該 hook 自己的 import.meta.url 推導，換一台
// 機器 checkout 到別的路徑就會不同）。處理方式：fixture 存 `$HOOKS_DIR$/comment-policy.md` 這種
// token，測試執行時用「本次執行當下、以同一份 join 邏輯算出的實際路徑」回填（shared.mjs 的
// fillDocPathTokens）再比對——鎖住的是「這段路徑指到 references/ 下正確檔名」這個不變量，不是鎖死
// 某台機器的字面路徑。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSandbox, cleanupSandbox, hookPath, runFixtureCase,
} from './fixtures/characterization/shared.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures', 'characterization');

const HOOKS = [
  'merge-guard.mjs',
  'config-protection.mjs',
  'worktree-guard.mjs',
  'loops-path-guard.mjs',
  'pr-gate.mjs',
  'pr-owner-guard.mjs',
  'outbound-comment-guard.mjs',
  'suggest-compact.mjs',
  'edit-accumulator.mjs',
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
    console.log(`\n[S10] ${hookFile}（${cases.length} cases）`);
    for (const c of cases) {
      caseCount++;
      const result = runFixtureCase(hookPath(hookFile), c, roles, root);
      assert(
        result.error == null,
        `[S10:${hookFile}:${c.id}] spawn 無 error（${c.description}）`,
      );
      assert(
        result.actualExitCode === c.expectedExitCode,
        `[S10:${hookFile}:${c.id}] exit code === ${c.expectedExitCode}（實得 ${result.actualExitCode}）`,
      );
      assert(
        result.actualStdout === result.expectedStdout,
        `[S10:${hookFile}:${c.id}] stdout 逐位元吻合 fixture 鎖住的現況（${c.description}）`,
      );
    }
  }
} finally {
  cleanupSandbox(root);
}

const total = passed + failed.length;
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
console.log(`(S10：${HOOKS.length} 支 hook、共 ${caseCount} 個 fixture case、${total} 條斷言——逐位元鎖住現況 stdout/exit code)`);
process.exit(failed.length > 0 ? 1 : 0);
