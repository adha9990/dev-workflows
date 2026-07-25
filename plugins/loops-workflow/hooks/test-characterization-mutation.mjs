#!/usr/bin/env node
// test-characterization-mutation.mjs —— S10／T3b mutation 驗證：證明 test-guard-characterization.mjs
// 與 test-stop-characterization.mjs 兩把「逐位元鎖住 stdout（+選配的檔案內容）」的鎖真的有鑑別力，
// 不是形式上全綠的裝飾（test-rubric §5 Prove-It：「如果功能根本沒做，這條會紅嗎？」）。
// T3b（issue #183）把 Stop 家族 5 支（cost-tracker／eval-gate／stop-gate／progress-render／
// loop-driver）也納入下方 MUTATIONS 表，沿用同一份 runner／同一套 buildSandbox+runFixtureCase
// 邏輯，不另開一支 mutation 測試檔。
//
// 做法（對每一支受測 hook）：讀出原始檔內容 → 在記憶體產生 2 種變異副本 → 把變異副本寫到**同一個
// hooks/ 目錄**（不是隔離 tmp 目錄——這 9 支互相 import 對方的 export，如 merge-guard.mjs 依賴
// pr-gate.mjs 的 stripQuotedValues/readGitBranch、pr-gate.mjs 依賴 worktree-guard.mjs 的
// findLoopRoot 等，寫進同目錄才能讓相對 import 原樣解析到真實的 sibling 依賴，只有「被測物自己」
// 是變異體）→ 用子行程對同一份 characterization fixture 真跑變異體 → 斷言至少一個 case 的
// stdout／exit code 與 fixture 鎖住的現況不吻合（＝變異被殺）。跑完印「變異體總數」與「被殺數」，
// 兩者不相等就 exit 1 並指名是哪支哪種變異存活。
//
// 兩種變異型（案例列表任務指定的最低兩種，逐一驗過「目標子字串在原始檔恰好出現一次」才動手，
// 防未來原始碼格式漂移讓某個目標子字串消失、變異變成靜默 no-op）：
//   A) decision-flip：把 `permissionDecision: 'deny',` 改成 `permissionDecision: 'allow',`——
//      7 支「會 deny 的 hook」都有這個字面（merge-guard／config-protection／worktree-guard／
//      loops-path-guard／pr-gate／pr-owner-guard／outbound-comment-guard）。
//   B) reason-truncate：把 deny 理由文字開頭那個字串常數的第一個字元刪掉——同樣只在 7 支 deny hook
//      適用（各自锁定的常數不同，逐一列在 MUTATIONS 表）。
//
// suggest-compact.mjs／edit-accumulator.mjs 兩支不是 deny hook（沒有 permissionDecision／reason
// 欄位），改用語意對應的兩種變異（皆會被「stdout/exit code 逐位元鎖」偵測到，型態解釋見各自的
// description 欄）：
//   suggest-compact.mjs：A' 讓 shouldRemind 永遠回 false（＝提醒被抑制，decision-flip 的類比）；
//                          B' 刪掉提醒字串開頭第一個字元（reason-truncate 的類比）。
//   edit-accumulator.mjs：這支 hook 全程沒有任何 console.log，stdout 恆為空——見報告已知限制：
//                          純 stdout 鎖對它的內部記錄邏輯沒有鑑別力（不管怎麼改內部邏輯，只要不動
//                          到 stdout/exit code 這兩個唯一可觀察介面，測試看不出來）。這裡改鎖它
//                          「恆靜默、恆 exit 0」這個 hook 協定本身（PostToolUse hook 意外印東西會
//                          污染 harness 解析、意外非 0 exit 會被誤判成 hook 故障）：
//                          A'' 尾端 process.exit(0) 改 process.exit(1)（exit code 契約）；
//                          B'' main() 開頭注入一行 console.log（洩漏輸出契約，模擬「不小心留了
//                          debug log」這種真實會發生的回歸）。
//
// 禁止的做法（見任務描述，本檔均未採用）：只變異一支就宣稱全體——這裡對全部 9 支各跑 2 種；
// 用 try/catch 吞掉子行程失敗——runFixtureCase 對 spawn error 是斷言失敗而非吞掉；把變異寫在
// 測試自己的斷言裡——這裡是真的讀檔、真的用字串替換改內容、真的寫成檔案、真的 spawnSync 執行。

import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSandbox, cleanupSandbox, hookPath, runFixtureCase,
} from './fixtures/characterization/shared.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures', 'characterization');

function loadFixture(hookFile) {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, hookFile.replace('.mjs', '.json')), 'utf8'));
}

/** 對 source 做「恰好一次」的字面替換；找不到剛好一次就丟例外（防原始碼漂移讓變異變 no-op）。 */
function replaceExactlyOnce(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`[mutation setup] "${label}" 目標子字串在原始檔出現 ${count} 次（預期恰好 1 次）——原始碼可能已改版，需更新 mutation 定義。`);
  }
  return source.split(from).join(to);
}

// ── 每支 hook 的變異定義（file / mutations[{id, apply(source)->mutated, description}]） ──────
const MUTATIONS = [
  {
    file: 'merge-guard.mjs',
    mutations: [
      {
        id: 'decision-flip',
        description: 'permissionDecision: deny → allow',
        apply: (s) => replaceExactlyOnce(s, "permissionDecision: 'deny',", "permissionDecision: 'allow',", 'merge-guard decision-flip'),
      },
      {
        id: 'reason-truncate',
        description: 'HUMAN_GATE_NOTE 開頭字元刪除',
        apply: (s) => replaceExactlyOnce(
          s,
          "const HUMAN_GATE_NOTE = '合併回主幹是需要人核可（human gate）的動作，不能由 Claude 直接執行。';",
          "const HUMAN_GATE_NOTE = '併回主幹是需要人核可（human gate）的動作，不能由 Claude 直接執行。';",
          'merge-guard reason-truncate',
        ),
      },
    ],
  },
  {
    file: 'config-protection.mjs',
    mutations: [
      {
        id: 'decision-flip',
        description: 'permissionDecision: deny → allow',
        apply: (s) => replaceExactlyOnce(s, "permissionDecision: 'deny',", "permissionDecision: 'allow',", 'config-protection decision-flip'),
      },
      {
        id: 'reason-truncate',
        description: 'DENY_REASON 開頭字元刪除',
        apply: (s) => replaceExactlyOnce(
          s,
          "'請修正程式碼錯誤，而非弱化 linter/formatter 設定檔。若確需修改設定，請設 LOOPS_CONFIG_PROTECTION=0 暫時關閉' +",
          "'修正程式碼錯誤，而非弱化 linter/formatter 設定檔。若確需修改設定，請設 LOOPS_CONFIG_PROTECTION=0 暫時關閉' +",
          'config-protection reason-truncate',
        ),
      },
    ],
  },
  {
    file: 'worktree-guard.mjs',
    mutations: [
      {
        id: 'decision-flip',
        description: 'permissionDecision: deny → allow',
        apply: (s) => replaceExactlyOnce(s, "permissionDecision: 'deny',", "permissionDecision: 'allow',", 'worktree-guard decision-flip'),
      },
      {
        id: 'reason-truncate',
        description: 'denyReason() 開頭模板字串首字元刪除',
        apply: (s) => replaceExactlyOnce(
          s,
          '    `loop \\`${slug}\\` 的 code 要在獨立 worktree 做、不在主 checkout：` +',
          '    `oop \\`${slug}\\` 的 code 要在獨立 worktree 做、不在主 checkout：` +',
          'worktree-guard reason-truncate',
        ),
      },
    ],
  },
  {
    file: 'loops-path-guard.mjs',
    mutations: [
      {
        id: 'decision-flip',
        description: 'permissionDecision: deny → allow',
        apply: (s) => replaceExactlyOnce(s, "permissionDecision: 'deny',", "permissionDecision: 'allow',", 'loops-path-guard decision-flip'),
      },
      {
        id: 'reason-truncate',
        description: 'DENY_REASON 開頭字元刪除',
        apply: (s) => replaceExactlyOnce(
          s,
          "  '.loops/ 一律錨定主 repo —— 請寫入 $LOOPS_ROOT/.loops/<slug>/' +",
          "  'loops/ 一律錨定主 repo —— 請寫入 $LOOPS_ROOT/.loops/<slug>/' +",
          'loops-path-guard reason-truncate',
        ),
      },
    ],
  },
  {
    file: 'pr-gate.mjs',
    mutations: [
      {
        id: 'decision-flip',
        description: 'permissionDecision: deny → allow',
        apply: (s) => replaceExactlyOnce(s, "permissionDecision: 'deny',", "permissionDecision: 'allow',", 'pr-gate decision-flip'),
      },
      {
        id: 'reason-truncate',
        description: 'buildVerifyDenyReason() 開頭模板字串首字元刪除（閘①）',
        apply: (s) => replaceExactlyOnce(
          s,
          '    `這是 loop \\`${slug}\\` 的分支，開 PR 前必須先過 verify——找不到 ` +',
          '    `是 loop \\`${slug}\\` 的分支，開 PR 前必須先過 verify——找不到 ` +',
          'pr-gate reason-truncate',
        ),
      },
    ],
  },
  {
    file: 'pr-owner-guard.mjs',
    mutations: [
      {
        id: 'decision-flip',
        description: 'permissionDecision: deny → allow',
        apply: (s) => replaceExactlyOnce(s, "permissionDecision: 'deny',", "permissionDecision: 'allow',", 'pr-owner-guard decision-flip'),
      },
      {
        id: 'reason-truncate',
        description: 'OWNER_NOTE 開頭字元刪除',
        apply: (s) => replaceExactlyOnce(
          s,
          "  '把 draft PR 轉 ready、加 reviewer、request review 是 PR owner 的驗收動作，不能由 Claude 自動' +",
          "  'draft PR 轉 ready、加 reviewer、request review 是 PR owner 的驗收動作，不能由 Claude 自動' +",
          'pr-owner-guard reason-truncate',
        ),
      },
    ],
  },
  {
    file: 'outbound-comment-guard.mjs',
    mutations: [
      {
        id: 'decision-flip',
        description: 'permissionDecision: deny → allow',
        apply: (s) => replaceExactlyOnce(s, "permissionDecision: 'deny',", "permissionDecision: 'allow',", 'outbound-comment-guard decision-flip'),
      },
      {
        id: 'reason-truncate',
        description: 'buildReadGateReason(comment) 開頭字元刪除',
        apply: (s) => replaceExactlyOnce(
          s,
          "'這則對外 comment 送出前，本 session 還沒讀過 comment-policy.md——那裡有 §7 驗收報告版型、'",
          "'則對外 comment 送出前，本 session 還沒讀過 comment-policy.md——那裡有 §7 驗收報告版型、'",
          'outbound-comment-guard reason-truncate',
        ),
      },
    ],
  },
  {
    file: 'suggest-compact.mjs',
    mutations: [
      {
        id: 'decision-flip-analog',
        description: 'shouldRemind() 永遠回 false（提醒被永久抑制，decision-flip 的類比）',
        apply: (s) => replaceExactlyOnce(
          s,
          '  return level > lastNotifiedLevel && level >= 1;',
          '  return false;',
          'suggest-compact decision-flip-analog',
        ),
      },
      {
        id: 'reason-truncate-analog',
        description: '提醒字串開頭字元刪除（reason-truncate 的類比）',
        apply: (s) => replaceExactlyOnce(
          s,
          '  return `[loops-workflow] 估計 context 已約 ~${approxK}k tokens（依 API usage 估算、非精確）。可考慮 /compact 省 token。`;',
          '  return `loops-workflow] 估計 context 已約 ~${approxK}k tokens（依 API usage 估算、非精確）。可考慮 /compact 省 token。`;',
          'suggest-compact reason-truncate-analog',
        ),
      },
    ],
  },
  {
    file: 'edit-accumulator.mjs',
    mutations: [
      // edit-accumulator.mjs 全程無 console.log，stdout 恆空——見檔頭「已知限制」說明：純 stdout
      // 鎖對其內部記錄邏輯沒有鑑別力，這裡改鎖「恆靜默、恆 exit 0」的 hook 協定本身。
      {
        id: 'exit-code-flip',
        description: 'process.exit(0) → process.exit(1)（exit code 契約）',
        apply: (s) => replaceExactlyOnce(s, '  process.exit(0);', '  process.exit(1);', 'edit-accumulator exit-code-flip'),
      },
      {
        id: 'stray-stdout-leak',
        description: 'main() 開頭注入一行 console.log（洩漏輸出契約——模擬不小心留了 debug log 的真實回歸）',
        apply: (s) => replaceExactlyOnce(
          s,
          'function main() {',
          "function main() {\n  console.log('MUTATION-INJECTED-DEBUG-OUTPUT');",
          'edit-accumulator stray-stdout-leak',
        ),
      },
    ],
  },
  // ── T3b（issue #183）：Stop 家族 5 支，沿用同一套 replaceExactlyOnce + runFixtureCase 鑑別力驗證 ──
  {
    file: 'cost-tracker.mjs',
    mutations: [
      {
        id: 'estimate-flag-flip',
        description: 'buildCostRow() 的 estimate: true → false（寫進 costs.jsonl 的契約欄位，decision-flip 的類比）',
        apply: (s) => replaceExactlyOnce(s, '    estimate: true,', '    estimate: false,', 'cost-tracker estimate-flag-flip'),
      },
      {
        id: 'sonnet-out-rate-corrupt',
        description: 'RATE_TABLE.sonnet.out 3.0→15.0 的 15.0 改 150.0（cost_usd 計算被打偏一個數量級）',
        apply: (s) => replaceExactlyOnce(s, 'out: 15.0,', 'out: 150.0,', 'cost-tracker sonnet-out-rate-corrupt'),
      },
    ],
  },
  {
    file: 'eval-gate.mjs',
    mutations: [
      {
        id: 'gate-injection-condition-flip',
        description: 'buildEvalGateInjection() 的 exitCode !== 1 → !== 2（GATE 訊號永遠不會在真退化時注入）',
        apply: (s) => replaceExactlyOnce(s, 'if (exitCode !== 1) return null;', 'if (exitCode !== 2) return null;', 'eval-gate gate-injection-condition-flip'),
      },
      {
        id: 'should-run-gate-always-false',
        description: 'shouldRunEvalGate() 恆回 false（三道前置條件判定被短路，decision-flip 的類比）',
        apply: (s) => replaceExactlyOnce(s, '  return Boolean(flagOn && hasMetrics && hasEdits);', '  return false;', 'eval-gate should-run-gate-always-false'),
      },
    ],
  },
  {
    file: 'stop-gate.mjs',
    mutations: [
      {
        id: 'gate-injection-polarity-flip',
        description: 'buildGateInjection() 的 ok===true → ok===false（綠燈變靜默失效、紅燈變誤判靜默，decision-flip 的類比）',
        apply: (s) => replaceExactlyOnce(s, 'if (ok === true) return null;', 'if (ok === false) return null;', 'stop-gate gate-injection-polarity-flip'),
      },
      {
        id: 'discovery-hint-truncate',
        description: 'DISCOVERY_HINT 開頭字元刪除（reason-truncate 的類比）',
        apply: (s) => replaceExactlyOnce(
          s,
          "  '[loops-workflow] 偵測到 .loops/gate.config.json：可設 LOOPS_STOP_GATE=1，讓每次改檔回合自動跑 ' +",
          "  'loops-workflow] 偵測到 .loops/gate.config.json：可設 LOOPS_STOP_GATE=1，讓每次改檔回合自動跑 ' +",
          'stop-gate discovery-hint-truncate',
        ),
      },
    ],
  },
  {
    file: 'progress-render.mjs',
    mutations: [
      {
        id: 'progress-script-path-corrupt',
        description: 'PROGRESS 腳本路徑指到不存在的檔名——spawnSync 靜默失敗、PROGRESS.md 不再被重生（fileCheck 鑑別力示範：純 stdout 鎖對此無感）',
        apply: (s) => replaceExactlyOnce(s, "join(HERE, '..', 'scripts', 'progress.mjs')", "join(HERE, '..', 'scripts', 'progress-MUTATED.mjs')", 'progress-render progress-script-path-corrupt'),
      },
      {
        id: 'exit-code-flip',
        description: 'process.exit(0) → process.exit(1)（exit code 契約）',
        apply: (s) => replaceExactlyOnce(s, 'process.exit(0);', 'process.exit(1);', 'progress-render exit-code-flip'),
      },
    ],
  },
  {
    file: 'loop-driver.mjs',
    mutations: [
      {
        id: 'blocking-gate-states-corrupt',
        description: 'BLOCKING_GATE_STATES 的 [\'failed\',\'errored\'] 換成永不匹配的值——完工紅燈被誤判成弱帳本降級放行',
        apply: (s) => replaceExactlyOnce(s, "new Set(['failed', 'errored']);", "new Set(['never-matches']);", 'loop-driver blocking-gate-states-corrupt'),
      },
      {
        id: 'continuation-reason-truncate',
        description: '續跑 reason 開頭字串首字元刪除（reason-truncate 的類比）',
        apply: (s) => replaceExactlyOnce(
          s,
          "'[loops-workflow] 迴圈續跑：本迴圈仍有未完成任務，請繼續推進，不要停下。',",
          "'loops-workflow] 迴圈續跑：本迴圈仍有未完成任務，請繼續推進，不要停下。',",
          'loop-driver continuation-reason-truncate',
        ),
      },
    ],
  },
];

let totalMutants = 0;
let killedMutants = 0;
const survivors = [];

const { root, roles } = buildSandbox();

try {
  for (const { file, mutations } of MUTATIONS) {
    const originalPath = hookPath(file);
    const originalSource = readFileSync(originalPath, 'utf8');
    const fixtureCases = loadFixture(file);

    for (const mutation of mutations) {
      totalMutants++;
      const mutantPath = join(HERE, `.mutant-tmp-${file.replace('.mjs', '')}-${mutation.id}.mjs`);
      let setupError = null;
      let mutatedSource = null;
      try {
        mutatedSource = mutation.apply(originalSource);
      } catch (e) {
        setupError = e;
      }

      if (setupError) {
        console.error(`  ✗ [MUTATION SETUP FAILED] ${file}::${mutation.id} — ${setupError.message}`);
        survivors.push(`${file}::${mutation.id}（setup 失敗，非「變異存活」而是目標子字串找不到——同樣視為未驗證通過）`);
        continue;
      }

      writeFileSync(mutantPath, mutatedSource, 'utf8');
      try {
        let killedByThisMutant = false;
        let firstMismatch = null;
        for (const c of fixtureCases) {
          const result = runFixtureCase(mutantPath, c, roles, root);
          if (!result.ok) {
            killedByThisMutant = true;
            if (!firstMismatch) firstMismatch = c.id;
            // 不 break：跑完全部 case，行為上等同對變異體也做一次完整 characterization 掃描
            // （非必要但比較有信心——只要有一個不吻合就足以判「殺掉」，其餘 case 是否也連帶跑掉
            // 不影響本次判定，純觀察用）。
          }
        }
        if (killedByThisMutant) {
          killedMutants++;
          console.log(`  ✓ [KILLED] ${file}::${mutation.id}（${mutation.description}）——首個不吻合 case：${firstMismatch}`);
        } else {
          survivors.push(`${file}::${mutation.id}（${mutation.description}）——全部 ${fixtureCases.length} 個 case 的 stdout/exit code 在變異後仍與 fixture 吻合，位元鎖沒殺掉這個變異`);
          console.error(`  ✗ [SURVIVED] ${file}::${mutation.id}（${mutation.description}）`);
        }
      } finally {
        rmSync(mutantPath, { force: true }); // 清乾淨，不留 .mutant-tmp-*.mjs 在 repo 裡
      }
    }
  }
} finally {
  cleanupSandbox(root);
  // 保險：萬一中途丟例外，掃一次目錄殘留的 .mutant-tmp-*.mjs 清掉（自我癒合，不留垃圾檔案）。
  for (const { file, mutations } of MUTATIONS) {
    for (const mutation of mutations) {
      const p = join(HERE, `.mutant-tmp-${file.replace('.mjs', '')}-${mutation.id}.mjs`);
      if (existsSync(p)) rmSync(p, { force: true });
    }
  }
}

console.log(`\n變異體總數：${totalMutants}`);
console.log(`被殺數：${killedMutants}`);
if (survivors.length > 0) {
  console.error('\n存活的變異體（位元鎖沒能殺掉，代表 characterization 的鎖對這個改動沒有鑑別力）：');
  for (const s of survivors) console.error(`  - ${s}`);
}

const ok = totalMutants === killedMutants && survivors.length === 0;
console.log(`\n${ok ? '✓' : '✗'} 變異體總數與被殺數${ok ? '相等' : '不相等'}`);
process.exit(ok ? 0 : 1);
