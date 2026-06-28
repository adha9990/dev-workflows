#!/usr/bin/env node
// eval-sandbox.mjs —— eval Phase：候選測試的沙箱隔離守門（#52 sandbox isolation）。
//
// 兩道防線，互補：
//   1. 詞法 containment（checkContainment）：workspace 解析後必須落在 project root 內，
//      逃逸（../）/ root 外絕對路徑一律拒絕——與 eval-oracle 的 PROJECT_ROOT 詞法邊界語意一致。
//   2. 容器隔離（buildSandboxCommand）：把測試包進 docker/podman，限網路/記憶體/PID/CPU、
//      drop caps、no-new-privileges、read-only root——降低候選 code「跑測試」時的爆破面。
//
// fail-closed：缺隔離條件（memory 必填無預設、runner/image 空、testCmd 非陣列）→ 拒絕（throw），
//   絕不靜默放行一個無上限的沙箱。CLI 只「建構並驗證指令並印出」，**絕不執行容器**。
//
// 分層（仿 eval 家族）：純函式 export + 薄 IO + import.meta.url 守門。依賴：僅 node 內建。
// 用法：
//   node eval-sandbox.mjs check --workspace <path> --root <root>
//   node eval-sandbox.mjs plan  --workspace <path> [--root <root>] [--runner docker|podman] [--image --memory --pids --cpus]

import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isWithinRoot } from './path-containment.mjs';

// ── 預設值（具名常數，無裸魔法值）─────────────────────────────────────────────────
const DEFAULT_RUNNER = 'docker';
const DEFAULT_IMAGE = 'node:20-alpine';
const DEFAULT_TEST_CMD = ['npm', 'test'];
const DEFAULT_PIDS = 256;
const DEFAULT_CPUS = '1';
const DEFAULT_NETWORK = 'none';
const DEFAULT_TMPFS = '/tmp';
const WORK_DIR = '/work';                              // 容器內掛載點 + 工作目錄
const SUPPORTED_RUNNERS = new Set(['docker', 'podman']);
const CLI_DEFAULT_MEMORY = '512m';                    // CLI 便利預設：plan 不強制使用者帶 --memory（純函式仍必填）
const MEMORY_UNLIMITED = '0';                         // docker：--memory 0 等同無上限（fail-open）
// image allowlist：只放行合法 image 字元；前導 - 另擋（會被 docker 當旗標 → argument injection）。
const IMAGE_PATTERN = /^[A-Za-z0-9._:/@-]+$/;

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
const withDefault = (v, d) => (v === undefined ? d : v);
// image 是否安全可放進 argv：非空、合法樣式、且不以 - 開頭（避免被當 docker 旗標）。
const isSafeImageRef = (v) => isNonEmptyString(v) && IMAGE_PATTERN.test(v) && !v.startsWith('-');
// 資源上限「有意義」判定（非只檢查 presence）。
const isMeaningfulMemory = (v) => isNonEmptyString(v) && v !== MEMORY_UNLIMITED;
const isMeaningfulPids = (v) => Number.isFinite(v) && v > 0;

// ── 純函式 ───────────────────────────────────────────────────────────────────────

/**
 * 詞法 containment 守門：workspace 解析後是否落在 projectRoot 內（自身或子路徑）。
 * 相對 workspace 對 root 解析、絕對 workspace 原樣解析。不 stat、不丟例外（非法輸入回 contained:false + reason）。
 * @returns {{contained:boolean, resolved:(string|null), reason:(string|null)}}
 */
export function checkContainment(workspacePath, projectRoot) {
  if (!isNonEmptyString(projectRoot)) {
    return { contained: false, resolved: null, reason: 'invalid project root: expected a non-empty string path' };
  }
  if (!isNonEmptyString(workspacePath)) {
    return { contained: false, resolved: null, reason: 'invalid workspace: expected a non-empty string path' };
  }
  const rootResolved = resolve(projectRoot);
  const resolved = isAbsolute(workspacePath) ? resolve(workspacePath) : resolve(rootResolved, workspacePath);
  // 詞法 containment 走共用安全原語（單一真相源，與 eval-oracle 一致）。
  const contained = isWithinRoot(resolved, rootResolved);
  if (!contained) {
    return {
      contained: false,
      resolved,
      reason: `workspace "${workspacePath}" resolves outside project root (path traversal / escape rejected)`,
    };
  }
  return { contained: true, resolved, reason: null };
}

/**
 * 建構容器隔離指令（不執行）。fail-closed：非法輸入直接 throw，不回一個半殘的沙箱。
 * runner==='none' → argv 退化為純 testCmd（本地直跑）、policy.isolated:false。
 * @returns {{argv:string[], policy:object}}
 */
export function buildSandboxCommand(workspaceAbs, opts = {}) {
  const runner = withDefault(opts.runner, DEFAULT_RUNNER);
  const image = withDefault(opts.image, DEFAULT_IMAGE);
  const testCmd = withDefault(opts.testCmd, DEFAULT_TEST_CMD);
  const memory = opts.memory; // 必填、無預設——缺則拒絕

  // 邊界先擋（guard clause）：寧可拒絕，也不靜默放行無上限/無映像的沙箱。
  if (!isNonEmptyString(runner)) throw new Error('buildSandboxCommand: runner must be a non-empty string');
  if (!isNonEmptyString(image)) throw new Error('buildSandboxCommand: image must be a non-empty string');
  // image 消毒（fail-closed）：擋前導 - / 含空白 / 非法字元——否則 image 會被 docker 當成
  // 額外旗標（--privileged、-v /:/host…）造成 argument injection，整套隔離形同虛設。
  if (!isSafeImageRef(image)) {
    throw new Error(`buildSandboxCommand: image "${image}" is not a valid image reference (argument injection rejected)`);
  }
  if (!Array.isArray(testCmd)) throw new Error('buildSandboxCommand: testCmd must be an array of command tokens');
  if (!isNonEmptyString(memory)) {
    throw new Error('buildSandboxCommand: memory limit is required (no default) — refuse to build an unbounded sandbox');
  }
  if (!isNonEmptyString(workspaceAbs)) {
    throw new Error('buildSandboxCommand: workspaceAbs must be a non-empty absolute path');
  }

  const pids = withDefault(opts.pids, DEFAULT_PIDS);
  const cpus = withDefault(opts.cpus, DEFAULT_CPUS);
  const network = withDefault(opts.network, DEFAULT_NETWORK);
  const readOnlyRoot = withDefault(opts.readOnlyRoot, true);
  const workspaceMount = withDefault(opts.workspaceMount, 'rw');
  const tmpfs = withDefault(opts.tmpfs, DEFAULT_TMPFS);
  const dropCaps = withDefault(opts.dropCaps, true);
  const noNewPrivileges = withDefault(opts.noNewPrivileges, true);

  const policy = {
    runner, network, memory, pids, cpus, readOnlyRoot, workspaceMount,
    capsDropped: dropCaps, noNewPrivileges, isolated: runner !== 'none',
  };

  // runner none：無容器可用，退化為本地直跑（policy.isolated:false 已標出降級）。
  if (runner === 'none') {
    return { argv: [...testCmd], policy };
  }

  // argv 一律用陣列形式（不拼 shell 字串）→ 無 shell 注入；argument injection 由 image 驗證擋。
  const mount = `${workspaceAbs}:${WORK_DIR}${workspaceMount === 'ro' ? ':ro' : ''}`;
  // 隔離旗標依 opts 條件式輸出，確保 argv ↔ policy 一致（policy 欄位反映實際 argv）。
  const argv = [
    runner, 'run', '--rm',
    '--network', network,
    '--memory', memory,
    '--pids-limit', String(pids),
    '--cpus', String(cpus),
    ...(dropCaps ? ['--cap-drop', 'ALL'] : []),
    ...(noNewPrivileges ? ['--security-opt', 'no-new-privileges'] : []),
    ...(readOnlyRoot ? ['--read-only'] : []),
    '--tmpfs', tmpfs,
    '-v', mount,
    '-w', WORK_DIR,
    image,
    ...testCmd,
  ];
  return { argv, policy };
}

/**
 * 逐項檢查隔離 policy，缺一項記一條具名 violation；isolated:false 明確記為「無容器隔離」。
 * @returns {{valid:boolean, violations:string[]}}
 */
export function validateSandboxPolicy(policy) {
  const p = policy ?? {};
  const violations = [];
  if (p.network !== 'none') violations.push(`network not isolated: must be 'none' (got ${JSON.stringify(p.network)})`);
  // 資源上限要「有意義」、非只檢查 presence：'0'/'' 的 memory 與 0/負/NaN 的 pids 形同無上限。
  if (!isMeaningfulMemory(p.memory)) violations.push(`memory limit missing or unbounded (got ${JSON.stringify(p.memory)})`);
  if (!isMeaningfulPids(p.pids)) violations.push(`pids limit missing or unbounded (must be a finite count > 0, got ${JSON.stringify(p.pids)})`);
  if (p.capsDropped !== true) violations.push('Linux capabilities not dropped (cap-drop ALL required)');
  if (p.noNewPrivileges !== true) violations.push('no-new-privileges not set (privilege escalation possible)');
  if (p.readOnlyRoot !== true) violations.push('root filesystem not read-only');
  if (p.isolated === false) violations.push('no container isolation (lexical-only containment)');
  return { valid: violations.length === 0, violations };
}

/**
 * 從 env 解析 container runner。只 allowlist docker/podman → isolated:true；
 * 其餘（未設 / none / 未知值）一律安全退化為 none（isolated:false）。
 * @returns {{runner:string, isolated:boolean}}
 */
export function resolveRunner(env = {}) {
  const requested = env?.LOOPS_SANDBOX_RUNNER;
  if (SUPPORTED_RUNNERS.has(requested)) return { runner: requested, isolated: true };
  return { runner: 'none', isolated: false };
}

// ── 薄 IO / CLI（被 import 時不執行；絕不執行容器，只建構/驗證/印）────────────────

const USAGE = [
  'usage:',
  '  node eval-sandbox.mjs check --workspace <path> --root <root>',
  '  node eval-sandbox.mjs plan  --workspace <path> [--root <root>] [--runner docker|podman] [--image <img>] [--memory <m>] [--pids <n>] [--cpus <n>] [--test-cmd "<cmd>"] [--allow-unsandboxed]',
  '  （check：詞法 containment 守門；plan：建構並驗證沙箱指令，只印不執行容器；--allow-unsandboxed：顯式放行無 runtime 的非隔離執行）',
].join('\n');

// 把 --test-cmd 的整串依空白拆成 token 陣列（operator 可讓容器跑評分命令而非預設 npm test）。
function splitTestCmd(raw) {
  if (!isNonEmptyString(raw)) return undefined;
  const tokens = raw.trim().split(/\s+/);
  return tokens.length > 0 ? tokens : undefined;
}

function parseArgs(argv) {
  const opts = {
    workspace: null, root: null, runner: null, image: undefined,
    memory: undefined, pids: undefined, cpus: undefined,
    testCmd: undefined, allowUnsandboxed: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const f = argv[i];
    if (f === '--workspace') opts.workspace = argv[++i] ?? null;
    else if (f === '--root') opts.root = argv[++i] ?? null;
    else if (f === '--runner') opts.runner = argv[++i] ?? null;
    else if (f === '--image') opts.image = argv[++i];
    else if (f === '--memory') opts.memory = argv[++i];
    else if (f === '--pids') opts.pids = Number.parseInt(argv[++i] ?? '', 10);
    else if (f === '--cpus') opts.cpus = argv[++i];
    else if (f === '--test-cmd') opts.testCmd = splitTestCmd(argv[++i]);
    else if (f === '--allow-unsandboxed') opts.allowUnsandboxed = true;
  }
  return opts;
}

function cmdCheck(argv) {
  const opts = parseArgs(argv);
  if (!opts.workspace || !opts.root) { console.error(USAGE); process.exit(2); }
  const containment = checkContainment(opts.workspace, opts.root);
  if (!containment.contained) {
    console.error(`check: ${containment.reason}`);
    process.exit(1);
  }
  console.log(JSON.stringify(containment));
  process.exit(0);
}

function cmdPlan(argv) {
  const opts = parseArgs(argv);
  if (!opts.workspace) { console.error(USAGE); process.exit(2); }
  const root = opts.root ?? process.cwd();

  // 逃逸先擋（建構之前）：containment 不過就不該替它規劃任何沙箱。
  const containment = checkContainment(opts.workspace, root);
  if (!containment.contained) {
    console.error(`plan: ${containment.reason}`);
    process.exit(1);
  }

  // --runner 優先於 env；皆透過 resolveRunner 做 allowlist 退化。
  const { runner } = resolveRunner({ LOOPS_SANDBOX_RUNNER: opts.runner ?? process.env.LOOPS_SANDBOX_RUNNER });
  const built = buildSandboxCommand(containment.resolved, {
    runner,
    image: opts.image,
    memory: opts.memory ?? CLI_DEFAULT_MEMORY,
    pids: opts.pids,
    cpus: opts.cpus,
    testCmd: opts.testCmd,
  });
  const { valid, violations } = validateSandboxPolicy(built.policy);
  // stdout 維持純 JSON（警告走 stderr），讓下游可直接 parse。
  console.log(JSON.stringify({ argv: built.argv, policy: built.policy, valid, violations, containment }, null, 2));

  if (runner === 'none') {
    console.error('plan: ⚠️ no container runtime configured — lexical-only containment (set LOOPS_SANDBOX_RUNNER=docker|podman to isolate); tests will run WITHOUT a sandbox');
    // 顯式 opt-in（--allow-unsandboxed）才放行無沙箱執行；否則照 fail-closed 退非 0。
    if (opts.allowUnsandboxed) process.exit(0);
  }
  // fail-closed：policy 無效（含 none 模式 isolated:false → valid:false）→ exit 1，仍印 plan 供診斷。
  process.exit(valid ? 0 : 1);
}

function main(argv) {
  const cmd = argv[0];
  if (cmd === 'check') return cmdCheck(argv.slice(1));
  if (cmd === 'plan') return cmdPlan(argv.slice(1));
  console.error(`unknown command: ${cmd ?? '(none)'}\n${USAGE}`);
  process.exit(2);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try { main(process.argv.slice(2)); }
  catch (err) { console.error(err?.message ?? String(err)); process.exit(3); }
}
