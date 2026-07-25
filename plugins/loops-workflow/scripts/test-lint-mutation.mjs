#!/usr/bin/env node
// test-lint-mutation.mjs —— lint-mutation.mjs 的紅綠單元 + IO/CLI 整合斷言
// （自帶極簡 harness，仿 test-registry-compiler.mjs，不引測試框架）。
// 用法：node test-lint-mutation.mjs [--filter <case-prefix>] [--min-cases <n>]
//   --filter T1      只跑 case id 以 T1 開頭的
//   --min-cases 6    斷言實際跑到的 case 數不得少於 6（沒有這個地板，一個沒寫測試的任務也會 exit 0）
// 全綠且達到 case 地板 → exit 0；任一斷言失敗 / case 數不足 / import 失敗 → exit 1。
//
// 本檔最重要的兩個 case 是自我否證：
//   T5 注入一個**不會違規**的東西 → 該 case 必須被判「沒抓到」（證明工具驗的是「真的會紅」，
//      不是恆綠）。
//   T6 掃描面實測值低於下限 → 必須紅（證明 ② 那條軸不是裝飾）。

import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  SCENARIOS,
  SURFACE_PROBES,
  matchesExpectation,
  summarize,
  formatSummary,
  runScenario,
  buildReport,
} from './lint-mutation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const SCRIPT = fileURLToPath(new URL('./lint-mutation.mjs', import.meta.url));

// ── 極簡 harness ──────────────────────────────────────────────────────────────
let passed = 0;
const failed = [];
const cases = [];

function testCase(id, name, fn) {
  cases.push({ id, name, fn });
}

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function parseArgs(argv) {
  const opts = { filter: '', minCases: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--filter') opts.filter = argv[++i] ?? '';
    else if (flag === '--min-cases') opts.minCases = Number(argv[++i] ?? 0);
  }
  return opts;
}

// 每項既有檢查都必須有對應注入點——這份清單就是「涵蓋面」的機械契約，
// 少一項（例如有人刪掉某個 scenario）測試就紅。
const REQUIRED_CHECKS = [
  'deep-sync', 'orphan-ref', 'broken-ref', 'duplicate', 'footprint', 'count-drift',
  'dead-command', 'hooks-wiring', 'flag-sync',
  'platform-tool-name', 'C4', 'C5', 'C6',
];

// ══════════════════════════════════════════════════════════════════════════
testCase('T1', 'matchesExpectation：check 與 includes 都要對上才算「被指名抓到」', () => {
  const report = {
    findings: [{ check: 'deep-sync', severity: 'P1', deepFile: 'agents/x-deep.md', detail: 'jaccard=0.01 < 0.9' }],
    notes: [{ check: 'footprint', file: 'agents/y.md', detail: '900 chars' }],
  };

  assert(
    matchesExpectation(report, { kind: 'finding', check: 'deep-sync', includes: ['x-deep.md'] }),
    'T1-1：check 與 includes 皆命中 → true',
  );
  assert(
    !matchesExpectation(report, { kind: 'finding', check: 'deep-sync', includes: ['z-deep.md'] }),
    'T1-2：check 對但 includes 指名的是別的檔 → false（別的 finding 不能冒充）',
  );
  assert(
    !matchesExpectation(report, { kind: 'finding', check: 'orphan-ref', includes: ['x-deep.md'] }),
    'T1-3：includes 命中但 check 不同 → false',
  );
  assert(
    matchesExpectation(report, { kind: 'note', check: 'footprint', includes: ['y.md'] }),
    'T1-4：kind=note 時查的是 notes 池（footprint 走 note 不擋線）',
  );
  assert(
    !matchesExpectation(report, { kind: 'finding', check: 'footprint', includes: ['y.md'] }),
    'T1-5：notes 裡的項目不會被當成 findings',
  );
  assert(
    matchesExpectation({ findings: [], notes: ['docs/a.md:3 — 豁免 — opus'] }, { kind: 'note', check: '豁免', includes: ['opus'] }),
    'T1-6：字串形 note（compat-lint 形狀）退回全文子字串比對',
  );
});

// ══════════════════════════════════════════════════════════════════════════
testCase('T2', 'SCENARIOS／SURFACE_PROBES 結構契約：id 唯一、欄位齊、涵蓋所有既有檢查', () => {
  const ids = SCENARIOS.map((s) => s.id);
  assert(new Set(ids).size === ids.length, `T2-1：scenario id 唯一（${ids.length} 個）`);

  const missingField = SCENARIOS.filter(
    (s) => !s.tool || !s.check || !s.describe || typeof s.precheck !== 'function'
      || typeof s.apply !== 'function' || typeof s.expect !== 'function',
  ).map((s) => s.id);
  assert(missingField.length === 0, `T2-2：每個 scenario 都有 tool/check/describe/precheck/apply/expect（缺欄位：${JSON.stringify(missingField)}）`);

  const covered = new Set(SCENARIOS.map((s) => s.check));
  const uncovered = REQUIRED_CHECKS.filter((c) => !covered.has(c));
  assert(uncovered.length === 0, `T2-3：必涵蓋的檢查全都有注入點（未涵蓋：${JSON.stringify(uncovered)}）`);

  const probeIds = SURFACE_PROBES.map((p) => p.id);
  assert(new Set(probeIds).size === probeIds.length, `T2-4：surface probe id 唯一（${probeIds.length} 個）`);
  const badFloor = SURFACE_PROBES.filter((p) => !(Number.isInteger(p.floor) && p.floor > 0) || !p.floorSource).map((p) => p.id);
  assert(badFloor.length === 0, `T2-5：每個 probe 都有正整數下限與來源說明（不合格：${JSON.stringify(badFloor)}）`);
});

// ══════════════════════════════════════════════════════════════════════════
testCase('T3', 'precheck 是硬前置：目標不存在時丟例外，不靜默跳過', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-mut-empty-'));
  try {
    // 空目錄＝所有注入目標都不存在。任何一個 precheck 若「安靜回傳」，重構後就會變成
    // 什麼都沒注入卻回報全部抓到——這正是本工具最危險的失效模式。
    const silent = [];
    for (const s of [...SCENARIOS, ...SURFACE_PROBES]) {
      try {
        s.precheck(dir);
        silent.push(s.id);
      } catch {
        // 預期行為：目標不存在就丟例外
      }
    }
    // filesScanned 兩個 probe 不需要任何目標（apply 是 no-op），是刻意的例外。
    const allowedSilent = ['skill-lint-files-scanned', 'compat-lint-files-scanned'];
    const unexpected = silent.filter((id) => !allowedSilent.includes(id));
    assert(unexpected.length === 0, `T3-1：空 root 上每個需要目標的 precheck 都丟例外（靜默通過的：${JSON.stringify(unexpected)}）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════════
testCase('T4', 'summarize／formatSummary：全抓到才綠，逃脫的注入要被指名', () => {
  const green = summarize(
    [{ id: 'S1', tool: 'skill-lint', check: 'deep-sync', describe: 'x', target: 'a.md', caught: true }],
    [{ id: 'p1', tool: 'skill-lint', describe: 'y', floor: 10, measured: 10 }],
  );
  assert(green.ok === true, 'T4-1：全抓到且掃描面達標 → ok=true');
  assert(green.summary.injected === 1 && green.summary.caught === 1, 'T4-2：summary 帶「注入總數／被抓到數」');
  assert(formatSummary(green).startsWith('✓ lint-mutation：注入 1 / 抓到 1'), 'T4-3：綠燈摘要印出計數');

  const red = summarize(
    [{ id: 'S1', tool: 'skill-lint', check: 'deep-sync', describe: '把 -deep body 換掉', target: 'a-deep.md', caught: false }],
    [],
  );
  assert(red.ok === false, 'T4-4：有注入逃脫 → ok=false');
  const detail = red.findings[0]?.detail ?? '';
  assert(
    red.findings[0]?.check === 'mutation-escaped' && detail.includes('deep-sync') && detail.includes('把 -deep body 換掉'),
    `T4-5：逃脫 finding 指名是哪個檢查、注入了什麼（實際：${detail}）`,
  );
});

// ══════════════════════════════════════════════════════════════════════════
testCase('T5', '自我否證：注入一個「不會違規」的東西 → 該 case 必須紅', () => {
  // 與 S2-orphan-ref 同形，但新增的 reference **同時補上引用者**，所以根本不是孤兒（不違規）。
  // 若這個 case 仍被判 caught，代表整套判定是恆綠的、毫無鑑別力。
  const PROBE_NAME = '__self_falsify_probe__.md';
  const harmless = {
    id: 'SELF-FALSIFY',
    tool: 'skill-lint',
    check: 'orphan-ref',
    describe: '新增 reference 但同時補上引用者（自我否證用的無害注入）',
    precheck(root) {
      return {
        file: join(root, 'plugins', 'loops-workflow', 'references', PROBE_NAME),
        referrer: join(root, 'plugins', 'loops-workflow', 'docs', 'FLOW.md'),
      };
    },
    apply(root, target) {
      mkdirSync(dirname(target.file), { recursive: true });
      writeFileSync(target.file, '# 無害探針\n\n這份檔案不製造任何違規。\n', 'utf8');
      appendFileSync(target.referrer, `\n詳見 references/${PROBE_NAME}。\n`, 'utf8');
    },
    expect() {
      return { kind: 'finding', check: 'orphan-ref', includes: [PROBE_NAME] };
    },
  };

  // 對照組：同一個 runScenario 機制跑真違規（真的沒有引用者的孤兒檔）必須綠。
  const realOrphan = SCENARIOS.find((s) => s.id === 'S2-orphan-ref');
  assert(realOrphan != null, 'T5-0：找得到真違規對照組 S2-orphan-ref');

  const harmlessResult = runScenario(harmless, REPO_ROOT);
  assert(
    harmlessResult.caught === false,
    `T5-1：無害注入不該被抓到（實際 caught=${harmlessResult.caught}）—— 證明判定不是恆綠`,
  );

  const escaped = summarize([harmlessResult], []);
  assert(escaped.ok === false, 'T5-2：無害注入使整體判紅');
  assert(
    (escaped.findings[0]?.detail ?? '').includes('自我否證'),
    'T5-3：紅燈訊息指名是哪個注入逃脫',
  );

  const realResult = runScenario(realOrphan, REPO_ROOT);
  assert(realResult.caught === true, `T5-4：對照組真違規必須被抓到（實際 caught=${realResult.caught}）`);
});

// ══════════════════════════════════════════════════════════════════════════
testCase('T6', '自我否證（掃描面軸）：實測值低於下限 → 紅並指名塌陷', () => {
  const collapsed = summarize([], [{ id: 'refs', tool: 'skill-lint', describe: 'reference 判定面', floor: 74, measured: 31 }]);
  assert(collapsed.ok === false, 'T6-1：掃描面 31 < 下限 74 → ok=false');
  const f = collapsed.findings[0];
  assert(
    f?.check === 'surface-collapse' && f.detail.includes('31') && f.detail.includes('74'),
    `T6-2：finding 指名實測值與下限（實際：${f?.detail}）`,
  );
  const boundary = summarize([], [{ id: 'refs', tool: 'skill-lint', describe: 'x', floor: 74, measured: 74 }]);
  assert(boundary.ok === true, 'T6-3：實測值恰好等於下限 → 綠（下限是「不得再少」，非「必須更多」）');
});

// ══════════════════════════════════════════════════════════════════════════
testCase('T7', 'CLI 整合：在真實 repo 上全綠、exit 0、注入數＝抓到數、不留暫存殘留', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--root', REPO_ROOT, '--json'], { encoding: 'utf8' });
  assert(res.status === 0, `T7-1：真實 repo 上 exit 0（實際 ${res.status}／${res.stderr?.slice(0, 400)}）`);

  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    // 解析失敗由下一條斷言報出
  }
  assert(json?.ok === true, 'T7-2：--json 輸出 ok=true');
  assert(
    json?.summary?.injected === SCENARIOS.length && json?.summary?.caught === SCENARIOS.length,
    `T7-3：注入總數＝被抓到數＝${SCENARIOS.length}（實際 injected=${json?.summary?.injected}、caught=${json?.summary?.caught}）`,
  );
  const below = (json?.summary?.surfaces ?? []).filter((s) => s.measured < s.floor);
  assert(below.length === 0, `T7-4：所有掃描面達下限（未達：${JSON.stringify(below)}）`);
  assert(
    (json?.summary?.surfaces ?? []).length === SURFACE_PROBES.length,
    `T7-5：掃描面下限斷言 ${SURFACE_PROBES.length} 項全數回報`,
  );
});

// ══════════════════════════════════════════════════════════════════════════
testCase('T8', 'buildReport 可注入自訂 scenario／probe 清單（供上層做否證與抽樣）', () => {
  const result = buildReport(REPO_ROOT, {
    scenarios: [SCENARIOS.find((s) => s.id === 'S1-deep-sync')],
    probes: [],
  });
  assert(result.ok === true && result.summary.injected === 1, 'T8-1：只跑單一 scenario 時 injected=1 且全綠');
  assert(result.summary.scenarios[0].id === 'S1-deep-sync', 'T8-2：summary 逐筆列出跑了哪些 scenario');
});

// ══════════════════════════════════════════════════════════════════════════
// 執行（含 --filter 與 --min-cases 地板）
// ══════════════════════════════════════════════════════════════════════════
const opts = parseArgs(process.argv.slice(2));
const selected = cases.filter((c) => c.id.startsWith(opts.filter));

for (const c of selected) {
  console.log(`\n[${c.id}] ${c.name}`);
  c.fn();
}

console.log(`\n${selected.length} cases run, ${passed} passed, ${failed.length} failed`);

if (opts.minCases > 0 && selected.length < opts.minCases) {
  console.error(`\n✗ case 數地板未達成：--min-cases ${opts.minCases}，實際跑到 ${selected.length}（filter="${opts.filter}"）`);
  process.exit(1);
}

if (failed.length > 0) {
  console.error('\n失敗清單：');
  for (const msg of failed) console.error(`  - ${msg}`);
  process.exit(1);
}
process.exit(0);
