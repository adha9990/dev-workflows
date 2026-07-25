// shared.mjs —— T3 characterization/mutation 共用基礎設施（非測試檔本身，供
// test-guard-characterization.mjs 與 test-characterization-mutation.mjs 兩者 import，避免兩份
// runner 各自維護一套 sandbox／case-runner 邏輯而漂移——那樣 mutation 測的就不是「同一把鎖」）。
//
// 職責：
//   1) buildSandbox()：建立 9 支 hook 需要的最小真實 fs fixture（僅在「hook 本身真的會做 fs
//      existsSync/statSync/readFileSync」時才建真實目錄/檔案；純字串邏輯的 hook 一律共用 GENERIC
//      這個「刻意不存在」的路徑，不需要真的建立）。
//   2) resolveTemplate()：把 fixture JSON 裡的 payload 樹狀結構中，字串值裡出現的 `$ROLE$<name>`
//      token 換成 buildSandbox() 算出的真實絕對路徑（forward-slash、Windows 形）。
//   3) stateFile 系列：outbound-comment-guard / suggest-compact / edit-accumulator 三支會讀寫
//      os.tmpdir() 裡 session-scoped state 檔的 hook，測試需要在跑 case 前「探測現有狀態→收斂」
//      （自我癒合：非存在即視為已收斂，存在則清掉或覆寫成 case 指定內容）。
//   4) runCase()：spawnSync 真跑一支 hook（子行程 IO 黑箱），回傳 { stdout, status }。env 一律先
//      從所有 LOOPS_* 環境變數「清空」再套用 case.env——防這台機器 ambient shell 帶
//      LOOPS_MERGE_GUARD=0 / LOOPS_PR_OWNER_GUARD=0 之類的殘留把 guard 整支關掉、測試變成空的
//      （比照 test-merge-guard.mjs:154-166 的 runHook 寫法，這裡推廣到全部 9 支的全部 LOOPS_* 旗標）。
//   5) docPathTokens()：outbound-comment-guard.mjs 的 read-gate deny 訊息含「本機這份 checkout 的
//      絕對路徑」（COMMENT_POLICY_PATH / OUTBOUND_TEMPLATES_PATH，由該 hook 自己的
//      import.meta.url 推導，換一台機器 checkout 到別的路徑就會不同）——這是本任務唯一「輸出含
//      絕對路徑」的欄位。處理方式：不放棄鎖定，改為將該欄位正規化成 token
//      （`$HOOKS_DIR$/comment-policy.md` 等）存進 fixture JSON，測試執行時用「本次執行當下、以
//      同一組 join 邏輯算出的實際路徑」回填 token 再比對——鎖住的是「這段路徑指到 references/ 下
//      正確檔名」這個不變量，而不是鎖死某台機器的字面路徑。

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const HOOKS_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // .../hooks（本檔在 hooks/fixtures/characterization/ 下，上三層）
const fwd = (p) => p.replace(/\\/g, '/');

// 刻意「不存在」的路徑：純字串邏輯的 hook（loops-path-guard／pr-owner-guard／suggest-compact 不讀
// cwd）或 fail-open「判不出」分支（merge-guard 的 push/api 型、pr-gate 的 allow-nonloop）共用。
export const GENERIC_CWD = 'C:/loops-t3-characterization/generic-nonexistent';

export function hookPath(name) {
  return join(HOOKS_DIR, name);
}

/** 遞迴走訪 value（字串／陣列／物件），把字串裡的 `$ROLE$<name>` 換成 roles[name]。 */
export function resolveTemplate(value, roles) {
  if (typeof value === 'string') {
    return value.replace(/\$ROLE\$([A-Za-z0-9_]+)/g, (_, name) => {
      if (!(name in roles)) throw new Error(`resolveTemplate: 未知 role token "${name}"`);
      return roles[name];
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplate(v, roles));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveTemplate(v, roles);
    return out;
  }
  return value;
}

/**
 * 建 9 支 hook 共用的 sandbox。SANDBOX_ROOT 固定名（非 pid 隨機）——自我癒合寫法：先探測（rmSync
 * force 對不存在的路徑是 no-op）→ 收斂（重建）→ 再做事，允許前次 crash 殘留仍能正常跑。回傳
 * { root, roles }：root 給 spawnSync 的真實 process cwd 用（必須是一個真的存在的目錄，即使 hook
 * 本身讀的是 payload.cwd 這個邏輯欄位、不是真實 OS cwd）；roles 給 resolveTemplate 用。
 */
export function buildSandbox() {
  const root = fwd(join(tmpdir(), 'loops-t3-characterization-sandbox'));
  rmSync(root, { recursive: true, force: true }); // 自我癒合：不管前次是否殘留，一律收斂到乾淨初態
  mkdirSync(root, { recursive: true });

  // ── merge-guard：git-merge-main 型（②）需要真實 .git/HEAD（目錄形）指向 master ──────────
  const mgMaster = fwd(join(root, 'mg-master'));
  mkdirSync(join(mgMaster, '.git'), { recursive: true });
  writeFileSync(join(mgMaster, '.git', 'HEAD'), 'ref: refs/heads/master\n');

  // ── config-protection：loops-scoped 判定需要 .loops/ 存在與否兩種 cwd，各自放一份既存的
  //    eslint.config.js（讓「受保護且已存在」與「scope 關閉時即使存在也放行」都能真的踩到 IO）──
  const cpWithLoops = fwd(join(root, 'cp-with-loops'));
  mkdirSync(join(cpWithLoops, '.loops'), { recursive: true });
  writeFileSync(join(cpWithLoops, 'eslint.config.js'), 'module.exports = {};\n');
  const cpNoLoops = fwd(join(root, 'cp-no-loops'));
  mkdirSync(cpNoLoops, { recursive: true });
  writeFileSync(join(cpNoLoops, 'eslint.config.js'), 'module.exports = {};\n');

  // ── worktree-guard：需要 .loops/<slug>/loop.md（findLoopRoot 走訪祖先讀這個檔判「已建
  //    loop」）；worktree 內cwd 只是字串路徑（isInsideWorktree 純 resolve+split，不需要那層目錄
  //    真的存在）──────────────────────────────────────────────────────────────────────
  const wgProj = fwd(join(root, 'wg-proj'));
  mkdirSync(join(wgProj, '.loops', '220-feature'), { recursive: true });
  writeFileSync(join(wgProj, '.loops', '220-feature', 'loop.md'), '# loop 220-feature\n');
  const wgWorktree = `${wgProj}/.claude/worktrees/220-feature`; // 純字串路徑，不建實體目錄

  // ── pr-gate：三種漸進 fs 狀態（findLoopRoot／realRunReceiptExists 都吃真實檔案）；cwd 用
  //    worktree 路徑段（extractWorktreeSlug 優先於 readGitBranch，不需要 .git）──────────────
  const slug = '999-test-slug'; // 帶 issue# 前綴，讓 gate③（Closes #999）也能被踩到
  function buildPrGateRoot(name, { verify, realRun } = {}) {
    const r = fwd(join(root, name));
    mkdirSync(join(r, '.loops', slug), { recursive: true });
    writeFileSync(join(r, '.loops', slug, 'loop.md'), `# loop ${slug}\n`);
    if (verify) {
      mkdirSync(join(r, '.loops', slug, 'stages'), { recursive: true });
      writeFileSync(join(r, '.loops', slug, 'stages', '04-verify.md'), '# verify 完成\n');
    }
    if (realRun) {
      mkdirSync(join(r, '.loops', slug, 'deliverables', 'real-run'), { recursive: true });
      writeFileSync(join(r, '.loops', slug, 'deliverables', 'real-run', 'no-ui.md'), '純後端 loop，無畫面可截。\n');
    }
    return r;
  }
  const prgNoVerify = buildPrGateRoot('prg-no-verify', { verify: false, realRun: false });
  const prgVerifyOnly = buildPrGateRoot('prg-verify-only', { verify: true, realRun: false });
  const prgReady = buildPrGateRoot('prg-ready', { verify: true, realRun: true });
  const prgNoVerifyWt = `${prgNoVerify}/.claude/worktrees/${slug}`;
  const prgVerifyOnlyWt = `${prgVerifyOnly}/.claude/worktrees/${slug}`;
  const prgReadyWt = `${prgReady}/.claude/worktrees/${slug}`;

  // ── edit-accumulator：只需 .loops/ 存在與否兩種 cwd（記錄動作本身不影響 stdout，但仍要真的
  //    踩到 existsSync 分支，鎖住的是「這個分支不會意外印出東西」這個契約）────────────────────
  const eaWithLoops = fwd(join(root, 'ea-with-loops'));
  mkdirSync(join(eaWithLoops, '.loops'), { recursive: true });
  const eaNoLoops = fwd(join(root, 'ea-no-loops'));
  mkdirSync(eaNoLoops, { recursive: true });

  // ── suggest-compact：transcript JSONL fixture（usage 加總precise 可推算，非隨機值）───────
  const scHigh = fwd(join(root, 'sc-transcript-high.jsonl'));
  writeFileSync(
    scHigh,
    '{"type":"assistant","message":{"usage":{"input_tokens":200000,"cache_read_input_tokens":50000,"cache_creation_input_tokens":10000}}}\n',
  );
  const scLow = fwd(join(root, 'sc-transcript-low.jsonl'));
  writeFileSync(
    scLow,
    '{"type":"assistant","message":{"usage":{"input_tokens":1000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n',
  );
  const scMissing = fwd(join(root, 'sc-transcript-missing.jsonl')); // 刻意不寫檔——fail-open 案例用

  const roles = {
    GENERIC: GENERIC_CWD,
    MG_MASTER: mgMaster,
    CP_WITH_LOOPS: cpWithLoops,
    CP_NO_LOOPS: cpNoLoops,
    WG_PROJ: wgProj,
    WG_WORKTREE: wgWorktree,
    PRG_NO_VERIFY_WT: prgNoVerifyWt,
    PRG_VERIFY_ONLY_WT: prgVerifyOnlyWt,
    PRG_READY_WT: prgReadyWt,
    EA_WITH_LOOPS: eaWithLoops,
    EA_NO_LOOPS: eaNoLoops,
    SC_TRANSCRIPT_HIGH: scHigh,
    SC_TRANSCRIPT_LOW: scLow,
    SC_TRANSCRIPT_MISSING: scMissing,
  };

  return { root, roles };
}

export function cleanupSandbox(root) {
  rmSync(root, { recursive: true, force: true });
}

// ── session-scoped tmp state 檔（os.tmpdir()，與 sandbox 是不同的落點——三支 accumulator/
//    suggest-compact 的 state 檔天生就是寫在 os.tmpdir() 而非 payload.cwd 底下）──────────────
function safeSessionId(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_'); // 與 sanitizeSessionId 同規則（測試獨立複刻，不 import 被測物）
}
export function readsStateFilePath(sessionId) {
  return join(tmpdir(), `loops-reads-${safeSessionId(sessionId)}.json`);
}
export function compactStateFilePath(sessionId) {
  return join(tmpdir(), `loops-compact-${safeSessionId(sessionId)}.json`);
}
export function editsStateFilePath(sessionId) {
  return join(tmpdir(), `loops-edits-${safeSessionId(sessionId)}.json`);
}

/** 自我癒合：清掉（不管原本存在與否）。 */
export function clearStateFile(path) {
  rmSync(path, { force: true });
}

/** 自我癒合：清掉再寫入指定內容（收斂到 case 要求的已知狀態，不依賴前次殘留）。 */
export function presetStateFile(path, content) {
  rmSync(path, { force: true });
  writeFileSync(path, JSON.stringify(content), 'utf8');
}

/**
 * 依 fixture case 的 `stateSetup` 欄位（{kind:'reads'|'compact', preset:null|array|number}）收斂
 * session-scoped tmp state 檔到 case 要求的已知狀態；三個呼叫端（generator／characterization／
 * mutation 三份 runner）共用同一份，避免各自維護一份而漂移。resolvedPayload 需已 resolveTemplate
 * 過（讀 session_id 欄位）。
 */
export function applyStateSetup(stateSetup, resolvedPayload) {
  if (!stateSetup) return;
  const sessionId = resolvedPayload.session_id;
  const pathFor = stateSetup.kind === 'reads' ? readsStateFilePath : compactStateFilePath;
  const p = pathFor(sessionId);
  if (stateSetup.preset == null) {
    clearStateFile(p);
  } else if (stateSetup.kind === 'reads') {
    presetStateFile(p, { ts: 1, reads: stateSetup.preset });
  } else {
    presetStateFile(p, { ts: 1, lastNotifiedLevel: stateSetup.preset });
  }
}

// ── outbound-comment-guard 的絕對路徑正規化 token（見檔頭說明）───────────────────────────
export function docPathTokens() {
  // 與 outbound-comment-guard.mjs 內部 HOOKS_DIR/REFERENCES_DIR 算法一致（同一個 hooks/ 目錄、
  // 同一組相對 join 片段），確保 token 回填值與 hook 實際印出的值同源。刻意**不** forward-slash
  // 正規化——hook 本身用原生 path.join（Windows 上是反斜線），印出的字面文字就是反斜線；這裡若轉
  // 成 `/` 會跟真實 stdout 對不上，位元鎖會誤判成不吻合。
  return {
    COMMENT_POLICY_PATH: join(HOOKS_DIR, '..', 'references', 'comment-policy.md'),
    OUTBOUND_TEMPLATES_PATH: join(HOOKS_DIR, '..', 'references', 'outbound-templates.md'),
  };
}

// r.stdout（子行程真實輸出）本身就是 JSON.stringify 過的文字——路徑裡的反斜線在這段「原始文字」
// 中已經是「跳脫後」的雙反斜線（`\\`），不是解碼後的單反斜線。tokenizeDocPaths（generator 用，
// 存進 fixture）與 fillDocPathTokens（測試 runner 用，回填後跟真實 stdout 比對）都要在「JSON 文字」
// 這個層次做代換，用 JSON.stringify 把解碼後的路徑轉成它在 JSON 文字裡實際長的樣子（去頭尾引號），
// 而不是直接拿解碼路徑去比對原始文字（那樣反斜線數量對不上，位元鎖會誤判不吻合）。
function asJsonTextFragment(decodedPath) {
  return JSON.stringify(decodedPath).slice(1, -1);
}

export function tokenizeDocPaths(rawStdoutText) {
  const tokens = docPathTokens();
  return rawStdoutText
    .split(asJsonTextFragment(tokens.COMMENT_POLICY_PATH)).join('$HOOKS_DIR$/comment-policy.md')
    .split(asJsonTextFragment(tokens.OUTBOUND_TEMPLATES_PATH)).join('$HOOKS_DIR$/outbound-templates.md');
}

export function fillDocPathTokens(text) {
  const tokens = docPathTokens();
  return text
    .replaceAll('$HOOKS_DIR$/comment-policy.md', asJsonTextFragment(tokens.COMMENT_POLICY_PATH))
    .replaceAll('$HOOKS_DIR$/outbound-templates.md', asJsonTextFragment(tokens.OUTBOUND_TEMPLATES_PATH));
}

/**
 * 真跑一支 hook（子行程 IO 黑箱）。env 一律先清空全部 LOOPS_* 再套用 caseEnv——防這台機器 ambient
 * shell 帶 LOOPS_MERGE_GUARD=0／LOOPS_PR_OWNER_GUARD=0 之類殘留把 guard 整支關掉（比照
 * test-merge-guard.mjs:154-166 的 runHook，推廣到全部 9 支的全部 LOOPS_* 旗標，而不只那兩個）。
 */
export function runCase(hookAbsPath, { payload, rawInput, env = {}, sandboxRoot }) {
  const input = rawInput !== undefined ? rawInput : JSON.stringify(payload);
  const mergedEnv = { ...process.env, ...env };
  for (const key of Object.keys(mergedEnv)) {
    if (key.startsWith('LOOPS_') && !(key in env)) delete mergedEnv[key];
  }
  const res = spawnSync(process.execPath, [hookAbsPath], {
    input,
    cwd: sandboxRoot, // 真實 OS process cwd：一律指向 sandbox root（必須真實存在，即使 hook 自己不讀它）
    env: mergedEnv,
    encoding: 'utf8',
  });
  return {
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : '',
    status: res.status,
    error: res.error,
  };
}

/**
 * 單一真相源：把一個 fixture case 針對某個 hook 絕對路徑（可以是原始 hook，也可以是 mutation 測試
 * 寫出的變異副本）真跑一次，回傳「是否吻合 fixture 鎖住的現況」。characterization 與 mutation 兩份
 * runner 都呼叫這裡，確保兩邊比對的是同一把鎖、不是各自重寫一份而可能漂移
 * （mutation 測的就會失去「證明 characterization 那把鎖有鑑別力」的意義）。
 */
export function runFixtureCase(hookAbsPath, fixtureCase, roles, sandboxRoot) {
  const payload = fixtureCase.payload ? resolveTemplate(fixtureCase.payload, roles) : undefined;
  if (fixtureCase.stateSetup) applyStateSetup(fixtureCase.stateSetup, payload);
  const r = runCase(hookAbsPath, {
    payload,
    rawInput: fixtureCase.rawInput,
    env: fixtureCase.env || {},
    sandboxRoot,
  });
  const expectedStdout = fillDocPathTokens(fixtureCase.expectedStdout);
  const ok = r.error == null && r.status === fixtureCase.expectedExitCode && r.stdout === expectedStdout;
  return { ok, actualStdout: r.stdout, actualExitCode: r.status, expectedStdout, error: r.error };
}
