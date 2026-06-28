#!/usr/bin/env node
// test-eval-sandbox.mjs —— eval-sandbox.mjs 的紅綠斷言（自帶 harness，#52 sandbox isolation）。
// 用法（cwd = plugins/loops-workflow）：node scripts/test-eval-sandbox.mjs
//
// 注意：eval-sandbox.mjs 實作已存在（本檔為回歸守門）。用「動態 import + callSafe」讓：
//   (a) 整個模組缺檔 → 不是 link-time 連坐爆掉，仍印出每條斷言的紅；
//   (b) 個別 export 缺 → 細粒度紅（該函式那幾條紅，其它照跑）。
// callSafe 區分「export 根本不是 function（notFn）」與「呼叫時丟例外（threw）」，
// 這樣「非法輸入應 throw」一類斷言不會因為「函式根本不存在也會 throw」而假綠。

import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../scripts
const ROOT = dirname(HERE); // plugin root
const SCRIPT = join(HERE, 'eval-sandbox.mjs');

let S = {};
try {
  S = await import('./eval-sandbox.mjs');
} catch (err) {
  console.error(`  ⚠ import eval-sandbox.mjs 失敗（尚未實作？）：${err && err.message}`);
}

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed.push(msg); console.error(`  ✗ ${msg}`); }
}

// callSafe：包住「可能不存在 / 可能 throw」的純函式呼叫。
function callSafe(fn, ...args) {
  if (typeof fn !== 'function') {
    return { ok: false, notFn: true, threw: false, value: undefined, error: 'not-a-function' };
  }
  try {
    return { ok: true, notFn: false, threw: false, value: fn(...args) };
  } catch (e) {
    return { ok: false, notFn: false, threw: true, value: undefined, error: String((e && e.message) || e) };
  }
}

// argv 斷言小工具（皆對非陣列回 false，缺 export 時自然紅、不丟例外）。
const hasFlag = (argv, flag) => Array.isArray(argv) && argv.includes(flag);
function hasFlagValue(argv, flag, value) {
  if (!Array.isArray(argv)) return false;
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === flag && String(argv[i + 1]) === String(value)) return true;
  }
  return false;
}
function someEl(argv, pred) {
  return Array.isArray(argv) && argv.some((e) => typeof e === 'string' && pred(e));
}
function containsSubseq(argv, sub) {
  if (!Array.isArray(argv)) return false;
  outer: for (let i = 0; i + sub.length <= argv.length; i++) {
    for (let j = 0; j < sub.length; j++) if (argv[i + j] !== sub[j]) continue outer;
    return true;
  }
  return false;
}
// flagFollowedBy：flag 後「緊接」的值需匹配 re（釘相鄰，比 hasFlag+someEl 嚴：值散落他處不算）。
function flagFollowedBy(argv, flag, re) {
  if (!Array.isArray(argv)) return false;
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === flag && re.test(String(argv[i + 1]))) return true;
  }
  return false;
}
// 非法輸入：契約允許「throw」或「policy.valid===false」，但「export 不存在」不算 reject。
function isRejected(res) {
  if (res.notFn) return false;              // 缺 export ≠ 通過驗證
  if (res.threw) return true;
  const v = res.value;
  return !!(v && v.policy && v.policy.valid === false);
}

// reason 文字：逃逸 / 越界 / 非字串 的人話理由都該命中；node 的「Cannot find module」不該命中（避免假綠）。
const REASON_RE = /escap|逃|outside|out of|beyond|not contained|root|contain|invalid|non-?string|empty/i;

const cleanup = [];
function mkTmpRoot(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(d);
  return d;
}

try {
  // ── T1 checkContainment（純邏輯，lexical containment，不可 stat / 不可 throw）──────────
  // 契約#1
  {
    const root = mkTmpRoot('sbx-contain-');
    const insideAbs = join(root, 'evals', 'build');       // root 內（不建立 → 釘住 lexical：不靠存在性）
    const outsideAbs = process.platform === 'win32' ? 'C:\\other\\x' : '/tmp/sbx-outside-x';

    const rIn = callSafe(S.checkContainment, insideAbs, root);
    assert(rIn.ok && rIn.value && rIn.value.contained === true
      && typeof rIn.value.resolved === 'string' && isAbsolute(rIn.value.resolved),
      'checkContainment：root 內絕對路徑 → contained:true + resolved 為絕對路徑 [#1]');

    const rEq = callSafe(S.checkContainment, root, root);
    assert(rEq.ok && rEq.value && rEq.value.contained === true,
      'checkContainment：workspace === root 本身 → contained:true [#1]');

    const rEsc1 = callSafe(S.checkContainment, '../escape', root);
    assert(rEsc1.ok && rEsc1.value && rEsc1.value.contained === false
      && typeof rEsc1.value.reason === 'string' && REASON_RE.test(rEsc1.value.reason),
      'checkContainment：../escape 逃出 root → contained:false + reason 提逃逸（不丟例外）[#1]');

    const rEsc2 = callSafe(S.checkContainment, '../../x', root);
    assert(rEsc2.ok && rEsc2.value && rEsc2.value.contained === false,
      'checkContainment：../../x 更深逃逸 → contained:false [#1]');

    const rOut = callSafe(S.checkContainment, outsideAbs, root);
    assert(rOut.ok && rOut.value && rOut.value.contained === false,
      'checkContainment：絕對路徑在 root 外 → contained:false [#1]');

    const rEmptyWs = callSafe(S.checkContainment, '', root);
    assert(!rEmptyWs.notFn && !rEmptyWs.threw && rEmptyWs.value
      && rEmptyWs.value.contained === false
      && typeof rEmptyWs.value.reason === 'string' && rEmptyWs.value.reason.length > 0,
      'checkContainment：空字串 workspace → contained:false + reason（不丟例外）[#1]');

    const rNullWs = callSafe(S.checkContainment, null, root);
    assert(!rNullWs.notFn && !rNullWs.threw && rNullWs.value && rNullWs.value.contained === false,
      'checkContainment：非字串 workspace（null）→ contained:false（不丟例外）[#1]');

    const rBadRoot = callSafe(S.checkContainment, insideAbs, '');
    assert(!rBadRoot.notFn && !rBadRoot.threw && rBadRoot.value && rBadRoot.value.contained === false,
      'checkContainment：非字串 / 空 root → contained:false（不丟例外）[#1]');

    // prefix 同層假陽性（layer-1 安全、最關鍵）：共享前綴的兄弟目錄，刻意不用 join。
    // mutation Prove-It：若 impl 把 startsWith(root + sep) 退化成 startsWith(root)，此條由綠轉紅。
    const siblingShared = root + 'X-evil'; // 例：/tmp/sbx-contain-abcX-evil，與 root 共享前綴但非子目錄
    const rSibling = callSafe(S.checkContainment, siblingShared, root);
    assert(rSibling.ok && rSibling.value && rSibling.value.contained === false,
      'checkContainment：共享前綴兄弟目錄(root+\'X-evil\') → contained:false（防 startsWith(root) 假陽性 mutation）[#1]');

    // 正向：root 內相對路徑（相對 root 解析）→ contained:true。
    const rRelIn = callSafe(S.checkContainment, 'evals/build', root);
    assert(rRelIn.ok && rRelIn.value && rRelIn.value.contained === true,
      'checkContainment：root 內相對路徑 evals/build → contained:true [#1]');
  }

  // ── T2 buildSandboxCommand（純邏輯，建構 docker argv）────────────────────────────────
  // 契約#2
  {
    const WS = '/abs/project/work';
    const IMAGE = 'node:20-alpine';
    const TESTCMD = ['npm', 'test'];

    // 完整 docker opts（memory/pids/cpus 顯式給；release: 釘住隔離旗標逐項存在）。
    const dockerOpts = { runner: 'docker', image: IMAGE, testCmd: TESTCMD, memory: '512m', pids: 256, cpus: '1' };
    const r = callSafe(S.buildSandboxCommand, WS, dockerOpts);
    const argv = r.value && r.value.argv;
    assert(r.ok && Array.isArray(argv), 'buildSandboxCommand(docker) → 回傳 {argv:[]} [#2]');
    assert(hasFlagValue(argv, '--network', 'none'), 'buildSandboxCommand(docker) → argv 含 --network none [#2]');
    assert(hasFlag(argv, '--read-only'), 'buildSandboxCommand(docker) → argv 含 --read-only [#2]');
    assert(hasFlag(argv, '--memory'), 'buildSandboxCommand(docker) → argv 含 --memory [#2]');
    assert(hasFlag(argv, '--pids-limit'), 'buildSandboxCommand(docker) → argv 含 --pids-limit [#2]');
    assert(hasFlag(argv, '--cpus'), 'buildSandboxCommand(docker) → argv 含 --cpus [#2]');
    assert(hasFlagValue(argv, '--cap-drop', 'ALL'), 'buildSandboxCommand(docker) → argv 含 --cap-drop ALL [#2]');
    assert(flagFollowedBy(argv, '--security-opt', /no-new-privileges/),
      'buildSandboxCommand(docker) → argv --security-opt 緊接 no-new-privileges（相鄰 subseq，非分散）[#2]');
    assert(hasFlag(argv, '--tmpfs'),
      'buildSandboxCommand(docker) → argv 含 --tmpfs（唯讀 root 下的可寫暫存；拿掉轉紅）[#2]');
    assert(hasFlag(argv, '-v') && someEl(argv, (e) => e.includes(WS)),
      'buildSandboxCommand(docker) → argv 含 -v 掛載 workspaceAbs [#2]');
    assert(hasFlagValue(argv, '-w', '/work'), 'buildSandboxCommand(docker) → argv 含 -w /work [#2]');
    assert(hasFlag(argv, IMAGE), 'buildSandboxCommand(docker) → argv 含 image [#2]');
    assert(containsSubseq(argv, TESTCMD), 'buildSandboxCommand(docker) → argv 末段含 testCmd（npm test 連續）[#2]');
    assert(r.value && r.value.policy && r.value.policy.isolated === true,
      'buildSandboxCommand(docker) → policy.isolated:true [#2]');

    // runner:'none' → argv 退化、policy.isolated:false（仍保留 testCmd 以便本地直跑）。
    const noneOpts = { runner: 'none', image: IMAGE, testCmd: TESTCMD, memory: '512m', pids: 256, cpus: '1' };
    const rn = callSafe(S.buildSandboxCommand, WS, noneOpts);
    const argvN = rn.value && rn.value.argv;
    assert(rn.ok && Array.isArray(argvN), 'buildSandboxCommand(none) → 回傳 {argv:[]} [#2]');
    assert(!hasFlag(argvN, '--network') && !hasFlag(argvN, '--read-only') && !hasFlag(argvN, '--cap-drop'),
      'buildSandboxCommand(none) → argv 退化：不含 docker 隔離旗標 [#2]');
    assert(rn.value && rn.value.policy && rn.value.policy.isolated === false,
      'buildSandboxCommand(none) → policy.isolated:false [#2]');
    assert(containsSubseq(argvN, TESTCMD), 'buildSandboxCommand(none) → argv 仍含 testCmd [#2]');

    // 自訂 limits → argv 反映該值。
    const customOpts = { runner: 'docker', image: IMAGE, testCmd: TESTCMD, memory: '1g', pids: 128, cpus: '2' };
    const rc = callSafe(S.buildSandboxCommand, WS, customOpts);
    const argvC = rc.value && rc.value.argv;
    assert(rc.ok && hasFlagValue(argvC, '--memory', '1g'), 'buildSandboxCommand：自訂 memory 1g → argv 反映 [#2]');
    assert(hasFlagValue(argvC, '--pids-limit', 128), 'buildSandboxCommand：自訂 pids 128 → argv 反映 [#2]');
    assert(hasFlagValue(argvC, '--cpus', '2'), 'buildSandboxCommand：自訂 cpus 2 → argv 反映 [#2]');

    // 非法輸入 → throw 或 policy.valid===false（不假設哪種；但「缺 export」不算 reject）。
    assert(isRejected(callSafe(S.buildSandboxCommand, WS, { runner: '', image: IMAGE, testCmd: TESTCMD, memory: '512m' })),
      'buildSandboxCommand：runner=\'\' → 拒絕（throw 或 policy.valid:false）[#2]');
    assert(isRejected(callSafe(S.buildSandboxCommand, WS, { runner: 'docker', image: '', testCmd: TESTCMD, memory: '512m' })),
      'buildSandboxCommand：image=\'\' → 拒絕 [#2]');
    assert(isRejected(callSafe(S.buildSandboxCommand, WS, { runner: 'docker', image: IMAGE, testCmd: 'npm test', memory: '512m' })),
      'buildSandboxCommand：testCmd 非陣列 → 拒絕 [#2]');
    assert(isRejected(callSafe(S.buildSandboxCommand, WS, { runner: 'docker', image: IMAGE, testCmd: TESTCMD })),
      'buildSandboxCommand：缺 memory → 拒絕 [#2]');

    // image argument injection：消毒注入字元（前導 -、旗標+空白、/ 開頭旗標樣）→ 拒絕。
    assert(isRejected(callSafe(S.buildSandboxCommand, WS, { runner: 'docker', image: '--privileged', testCmd: TESTCMD, memory: '512m' })),
      'buildSandboxCommand：image=\'--privileged\'（前導 - 旗標注入）→ 拒絕 [#2]');
    assert(isRejected(callSafe(S.buildSandboxCommand, WS, { runner: 'docker', image: '-v /:/host', testCmd: TESTCMD, memory: '512m' })),
      'buildSandboxCommand：image=\'-v /:/host\'（旗標+空白掛載注入）→ 拒絕 [#2]');

    // argv↔policy 一致：dropCaps:false → argv 不含 --cap-drop 且 policy.capsDropped:false（兩者一致）。
    const rNoCap = callSafe(S.buildSandboxCommand, WS, { runner: 'docker', image: IMAGE, testCmd: TESTCMD, memory: '512m', dropCaps: false });
    const argvNoCap = rNoCap.value && rNoCap.value.argv;
    assert(rNoCap.ok && !hasFlag(argvNoCap, '--cap-drop'),
      'buildSandboxCommand：dropCaps:false → argv 不含 --cap-drop [#2]');
    assert(rNoCap.value && rNoCap.value.policy && rNoCap.value.policy.capsDropped === false,
      'buildSandboxCommand：dropCaps:false → policy.capsDropped:false（與 argv 一致）[#2]');

    // 預設（dropCaps 未給→true）：argv 含 --cap-drop ALL 且 policy.capsDropped:true（一致）。
    const rDefCap = callSafe(S.buildSandboxCommand, WS, { runner: 'docker', image: IMAGE, testCmd: TESTCMD, memory: '512m' });
    assert(rDefCap.ok && hasFlagValue(rDefCap.value && rDefCap.value.argv, '--cap-drop', 'ALL')
      && rDefCap.value.policy && rDefCap.value.policy.capsDropped === true,
      'buildSandboxCommand：預設 → argv 含 --cap-drop ALL 且 policy.capsDropped:true（一致）[#2]');

    // noNewPrivileges:false → argv 不含 no-new-privileges 且 policy.noNewPrivileges:false（一致）。
    const rNoNNP = callSafe(S.buildSandboxCommand, WS, { runner: 'docker', image: IMAGE, testCmd: TESTCMD, memory: '512m', noNewPrivileges: false });
    const argvNoNNP = rNoNNP.value && rNoNNP.value.argv;
    assert(rNoNNP.ok && !someEl(argvNoNNP, (e) => /no-new-privileges/.test(e)),
      'buildSandboxCommand：noNewPrivileges:false → argv 不含 no-new-privileges security-opt [#2]');
    assert(rNoNNP.value && rNoNNP.value.policy && rNoNNP.value.policy.noNewPrivileges === false,
      'buildSandboxCommand：noNewPrivileges:false → policy.noNewPrivileges:false（與 argv 一致）[#2]');

    // workspaceMount:'ro' → -v 掛載值含 :ro（唯讀掛載）。
    const rRo = callSafe(S.buildSandboxCommand, WS, { runner: 'docker', image: IMAGE, testCmd: TESTCMD, memory: '512m', workspaceMount: 'ro' });
    assert(rRo.ok && flagFollowedBy(rRo.value && rRo.value.argv, '-v', /:ro\b/),
      'buildSandboxCommand：workspaceMount:\'ro\' → -v 掛載值含 :ro [#2]');
  }

  // ── T3 validateSandboxPolicy（純邏輯）─────────────────────────────────────────────
  // 契約#3
  {
    const full = {
      network: 'none', memory: '512m', pids: 256,
      capsDropped: true, noNewPrivileges: true, readOnlyRoot: true, isolated: true,
    };
    const rFull = callSafe(S.validateSandboxPolicy, full);
    assert(rFull.ok && rFull.value && rFull.value.valid === true
      && Array.isArray(rFull.value.violations) && rFull.value.violations.length === 0,
      'validateSandboxPolicy：完整隔離 policy → valid:true、violations 空 [#3]');

    function expectViolation(mutate, re, label) {
      const policy = { ...full };
      mutate(policy);
      const r = callSafe(S.validateSandboxPolicy, policy);
      const vstr = r.value && Array.isArray(r.value.violations) ? JSON.stringify(r.value.violations) : '';
      assert(r.ok && r.value && r.value.valid === false && re.test(vstr), label);
    }
    expectViolation((p) => { p.network = 'host'; }, /network|host/i,
      'validateSandboxPolicy：network:host → violations 含網路項、valid:false [#3]');
    expectViolation((p) => { delete p.memory; }, /memory/i,
      'validateSandboxPolicy：缺 memory → memory violation、valid:false [#3]');
    expectViolation((p) => { delete p.pids; }, /pids?/i,
      'validateSandboxPolicy：缺 pids → pids violation、valid:false [#3]');
    expectViolation((p) => { p.capsDropped = false; }, /cap/i,
      'validateSandboxPolicy：capsDropped:false → cap violation、valid:false [#3]');
    expectViolation((p) => { p.noNewPrivileges = false; }, /privile|no-new|nnp/i,
      'validateSandboxPolicy：noNewPrivileges:false → violation、valid:false [#3]');
    expectViolation((p) => { p.readOnlyRoot = false; }, /read.?only|readonly|root/i,
      'validateSandboxPolicy：readOnlyRoot:false → violation、valid:false [#3]');
    expectViolation((p) => { p.isolated = false; }, /lexical|container|isolat/i,
      'validateSandboxPolicy：isolated:false（runner none）→ lexical-only / no-container violation、valid:false [#3]');

    // 資源上限要「有意義」（非只檢查存在）：memory '0'/'' = 無上限 fail-open；pids 0/負/NaN 無效。
    expectViolation((p) => { p.memory = '0'; }, /memory/i,
      'validateSandboxPolicy：memory=\'0\'（等同無上限 fail-open）→ memory violation、valid:false [#3]');
    expectViolation((p) => { p.memory = ''; }, /memory/i,
      'validateSandboxPolicy：memory=\'\'（空字串）→ memory violation、valid:false [#3]');
    expectViolation((p) => { p.pids = 0; }, /pids?/i,
      'validateSandboxPolicy：pids=0（無 fork 上限）→ pids violation、valid:false [#3]');
    expectViolation((p) => { p.pids = -1; }, /pids?/i,
      'validateSandboxPolicy：pids=-1（負值無意義）→ pids violation、valid:false [#3]');
    expectViolation((p) => { p.pids = NaN; }, /pids?/i,
      'validateSandboxPolicy：pids=NaN（非數）→ pids violation、valid:false [#3]');
  }

  // ── T4 resolveRunner（純邏輯，讀 env 物件）────────────────────────────────────────
  // 契約#4
  {
    const rDocker = callSafe(S.resolveRunner, { LOOPS_SANDBOX_RUNNER: 'docker' });
    assert(rDocker.ok && rDocker.value && rDocker.value.runner === 'docker' && rDocker.value.isolated === true,
      'resolveRunner：docker → {runner:docker, isolated:true} [#4]');
    const rPodman = callSafe(S.resolveRunner, { LOOPS_SANDBOX_RUNNER: 'podman' });
    assert(rPodman.ok && rPodman.value && rPodman.value.runner === 'podman' && rPodman.value.isolated === true,
      'resolveRunner：podman → {runner:podman, isolated:true} [#4]');
    const rUnset = callSafe(S.resolveRunner, {});
    assert(rUnset.ok && rUnset.value && rUnset.value.runner === 'none' && rUnset.value.isolated === false,
      'resolveRunner：未設 → {runner:none, isolated:false} [#4]');
    const rNone = callSafe(S.resolveRunner, { LOOPS_SANDBOX_RUNNER: 'none' });
    assert(rNone.ok && rNone.value && rNone.value.runner === 'none' && rNone.value.isolated === false,
      'resolveRunner：none → {runner:none, isolated:false} [#4]');
    const rBogus = callSafe(S.resolveRunner, { LOOPS_SANDBOX_RUNNER: 'wat-unknown' });
    assert(rBogus.ok && rBogus.value && rBogus.value.runner === 'none' && rBogus.value.isolated === false,
      'resolveRunner：未知值 → {runner:none, isolated:false}（安全退化）[#4]');
  }

  // ── T5 CLI smoke（真 spawn，不真跑容器：plan = 建構不執行）──────────────────────────
  // 契約#5
  function runCli(args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
  }
  function combined(r) { return `${r.stdout || ''}${r.stderr || ''}`; }
  function parseJsonLoose(s) {
    if (typeof s !== 'string') return null;
    try { return JSON.parse(s); } catch { /* fallthrough */ }
    const a = s.indexOf('{'); const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* fallthrough */ } }
    return null;
  }
  {
    const root = mkTmpRoot('sbx-cli-');
    const inside = join(root, 'evals', 'build');
    mkdirSync(inside, { recursive: true });
    const escape = join(root, '..', 'escape'); // root + '/../escape' → 逃出 root

    // check：root 內 → exit 0
    const cIn = runCli(['check', '--workspace', inside, '--root', root]);
    assert(cIn.status === 0, 'CLI check：root 內路徑 → exit 0 [#5]');

    // check：逃逸 → exit 1 + 輸出提 reason（同時要求 reason 文字，避免 node 缺檔 exit1 假綠）
    const cEsc = runCli(['check', '--workspace', escape, '--root', root]);
    assert(cEsc.status === 1 && REASON_RE.test(combined(cEsc)),
      'CLI check：逃逸路徑 → exit 1 且 stderr/stdout 提 reason [#5]');

    // check：缺旗標 → exit 2（misuse）
    assert(runCli(['check']).status === 2, 'CLI check：缺 --workspace/--root → exit 2 [#5]');
    assert(runCli(['check', '--workspace', inside]).status === 2, 'CLI check：缺 --root → exit 2 [#5]');
    assert(runCli(['bogus-subcommand']).status === 2, 'CLI：未知命令 → exit 2 [#5]');

    // plan + docker：exit 0、stdout 合法 JSON 含 argv/policy/valid/containment、argv 含 --network none（建構不執行）
    const pDocker = runCli(['plan', '--workspace', inside, '--runner', 'docker', '--root', root]);
    const jd = parseJsonLoose(pDocker.stdout);
    assert(pDocker.status === 0, 'CLI plan(docker)：exit 0 [#5]');
    assert(jd && Array.isArray(jd.argv) && jd.policy && typeof jd.valid !== 'undefined' && jd.containment,
      'CLI plan(docker)：stdout 合法 JSON 含 argv/policy/valid/containment [#5]');
    assert(jd && hasFlagValue(jd.argv, '--network', 'none'),
      'CLI plan(docker)：JSON.argv 含 --network none（印出指令但未真跑 docker）[#5]');
    assert(jd && jd.containment && jd.containment.contained === true && jd.valid === true,
      'CLI plan(docker)：containment.contained:true、valid:true [#5]');

    // plan 無 --runner → none：fail-closed（valid:false）→ exit 1，但仍印 plan/policy 供診斷 + lexical-only 警告。
    const pNone = runCli(['plan', '--workspace', inside, '--root', root]);
    const jn = parseJsonLoose(pNone.stdout);
    assert(pNone.status === 1, 'CLI plan(none)：valid:false fail-closed → exit 1（未顯式 opt-in 不放行）[#5]');
    assert(jn && jn.policy && jn.policy.isolated === false,
      'CLI plan(none)：policy.isolated:false（仍印出 plan 供診斷）[#5]');
    assert(jn && jn.valid === false,
      'CLI plan(none)：valid:false（fail-closed 之因）[#5]');
    assert(/lexical/i.test(combined(pNone)),
      'CLI plan(none)：印 lexical-only 警告（none 退化可辨識）[#5]');

    // --allow-unsandboxed：顯式 opt-in → exit 0，policy.isolated:false 仍印出。
    const pAllow = runCli(['plan', '--workspace', inside, '--root', root, '--allow-unsandboxed']);
    const ja = parseJsonLoose(pAllow.stdout);
    assert(pAllow.status === 0, 'CLI plan(none) --allow-unsandboxed：顯式 opt-in → exit 0 [#5]');
    assert(ja && ja.policy && ja.policy.isolated === false,
      'CLI plan(none) --allow-unsandboxed：policy.isolated:false 仍印出 [#5]');

    // docker + 顯式 --memory → valid:true → exit 0（fail-closed 只在 invalid 觸發）。
    const pDockerMem = runCli(['plan', '--workspace', inside, '--root', root, '--runner', 'docker', '--memory', '512m']);
    const jdm = parseJsonLoose(pDockerMem.stdout);
    assert(pDockerMem.status === 0 && jdm && jdm.valid === true,
      'CLI plan(docker --memory 512m)：valid:true → exit 0 [#5]');

    // --test-cmd custom → argv 尾端反映自訂命令（覆寫預設 npm test）。
    const pCustom = runCli(['plan', '--workspace', inside, '--root', root, '--runner', 'docker', '--test-cmd', 'my-custom-test --x']);
    const jc = parseJsonLoose(pCustom.stdout);
    assert(pCustom.status === 0 && jc && Array.isArray(jc.argv) && someEl(jc.argv, (e) => e.includes('my-custom-test')),
      'CLI plan --test-cmd custom：argv 尾端反映自訂命令、覆寫預設 npm test [#5]');

    // plan + 逃逸 → exit 1（逃逸先擋，建構之前）+ reason 文字
    const pEsc = runCli(['plan', '--workspace', escape, '--root', root]);
    assert(pEsc.status === 1 && REASON_RE.test(combined(pEsc)),
      'CLI plan：逃逸路徑 → exit 1（逃逸先擋）且提 reason [#5]');
  }

  // ── T6 build-not-execute 靜態守（讀原始碼，釘住「plan = 建構不執行容器」契約）──────────
  // 契約#6（靜態）：未來有人在 eval-sandbox.mjs 加 spawn / exec 會由綠轉紅。
  {
    let src = '';
    let readOk = false;
    try { src = readFileSync(SCRIPT, 'utf8'); readOk = true; } catch { readOk = false; }
    assert(readOk, 'build-not-execute：能讀取 eval-sandbox.mjs 原始碼 [#6]');
    // 只剝除區塊註解與整行 // 註解（避免文件式註解誤觸）；不碰字串 / 行尾註解，以免漏放真正的 exec。
    const code = String(src)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ');
    assert(readOk && !/child_process/.test(code),
      'build-not-execute：原始碼不得引用 child_process（絕不執行容器）[#6]');
    assert(readOk && !/spawnSync/.test(code),
      'build-not-execute：原始碼不得用 spawnSync [#6]');
    assert(readOk && !/execSync/.test(code),
      'build-not-execute：原始碼不得用 execSync [#6]');
    assert(readOk && !/\bexec\s*\(/.test(code),
      'build-not-execute：原始碼不得呼叫 exec( [#6]');
  }
} finally {
  for (const d of cleanup) { try { rmSync(d, { recursive: true, force: true }); } catch { /* idempotent */ } }
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.error('FAILED:\n' + failed.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
