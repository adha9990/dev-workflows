// shared.mjs —— T3/T3b characterization/mutation 共用基礎設施（非測試檔本身，供
// test-guard-characterization.mjs／test-stop-characterization.mjs 與 test-characterization-mutation.mjs
// 三者 import，避免各 runner 各自維護一套 sandbox／case-runner 邏輯而漂移——那樣 mutation 測的就不是
// 「同一把鎖」）。
//
// 職責：
//   1) buildSandbox()：建立各 hook 需要的最小真實 fs fixture（僅在「hook 本身真的會做 fs
//      existsSync/statSync/readFileSync」時才建真實目錄/檔案；純字串邏輯的 hook 一律共用 GENERIC
//      這個「刻意不存在」的路徑，不需要真的建立）。
//   2) resolveTemplate()：把 fixture JSON 裡的 payload／env 樹狀結構中，字串值裡出現的
//      `$ROLE$<name>` token 換成 buildSandbox() 算出的真實絕對路徑（forward-slash、Windows 形）。
//   3) stateFile 系列：outbound-comment-guard / suggest-compact / edit-accumulator / eval-gate /
//      stop-gate 等會讀寫 os.tmpdir() 裡 session-scoped state 檔的 hook，測試需要在跑 case 前
//      「探測現有狀態→收斂」（自我癒合：非存在即視為已收斂，存在則清掉或覆寫成 case 指定內容）。
//   4) runCase()：spawnSync 真跑一支 hook（子行程 IO 黑箱），回傳 { stdout, status }。env 一律先
//      從所有 LOOPS_* 環境變數「清空」再套用 case.env——防這台機器 ambient shell 帶
//      LOOPS_MERGE_GUARD=0 / LOOPS_PR_OWNER_GUARD=0 之類的殘留把 guard 整支關掉、測試變成空的
//      （比照 test-merge-guard.mjs:154-166 的 runHook 寫法，這裡推廣到全部旗標）。
//   5) docPathTokens()：outbound-comment-guard.mjs 的 read-gate deny 訊息含「本機這份 checkout 的
//      絕對路徑」（COMMENT_POLICY_PATH / OUTBOUND_TEMPLATES_PATH，由該 hook 自己的
//      import.meta.url 推導，換一台機器 checkout 到別的路徑就會不同）——這是 T3 任務唯一「輸出含
//      絕對路徑」的欄位。處理方式：不放棄鎖定，改為將該欄位正規化成 token
//      （`$HOOKS_DIR$/comment-policy.md` 等）存進 fixture JSON，測試執行時用「本次執行當下、以
//      同一組 join 邏輯算出的實際路徑」回填 token 再比對——鎖住的是「這段路徑指到 references/ 下
//      正確檔名」這個不變量，而不是鎖死某台機器的字面路徑。
//   6) seedFiles（T3b 新增）：Stop 家族的 loop-driver.mjs 會原地改寫 `.loops/<slug>/state.json`
//      （iteration+1）；同一份 fixture case 會被 characterization 測試跑一次、又被 mutation 測試對
//      每個變異體各跑一次，若不「每次執行前重寫回已知初態」，state.json 的 iteration 會跨執行累積
//      飄移，讓 stdout 比對變成看執行次數而非看行為——runFixtureCase 執行 hook 前先依
//      fixtureCase.seedFiles 把指定檔案覆寫回固定內容（自我癒合：不管前次殘留為何，一律收斂）。
//   7) fileCheck（T3b 新增）：cost-tracker.mjs／progress-render.mjs 兩支的主要作用是寫檔、stdout
//      恆空——純 stdout 位元鎖對它們沒有鑑別力。runFixtureCase 額外支援 fixtureCase.fileCheck
//      （{ path, normalize?, expectedContent? } 或 { path, expectMissing:true }），跑完 hook 後讀
//      該檔案、依 normalize 對應的正規化器處理（見 FILE_NORMALIZERS）後與 expectedContent 比對，
//      一併併入 runFixtureCase 回傳的 ok。

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
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
 * 建本檔涵蓋之受測 hook 們共用的 sandbox。SANDBOX_ROOT 固定名（非 pid 隨機）——自我癒合寫法：先探測（rmSync
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

  // ── cost-tracker：「有 .loops/」與「無 .loops/」兩種 cwd + 一份已知 usage 的 transcript ─────
  const ctWithLoops = fwd(join(root, 'ct-with-loops'));
  mkdirSync(join(ctWithLoops, '.loops'), { recursive: true });
  const ctNoLoops = fwd(join(root, 'ct-no-loops'));
  mkdirSync(ctNoLoops, { recursive: true });
  const ctTranscript = fwd(join(root, 'ct-transcript.jsonl'));
  writeFileSync(
    ctTranscript,
    '{"type":"assistant","message":{"model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":2000,"output_tokens":800,"cache_creation_input_tokens":200,"cache_read_input_tokens":100}}}\n',
  );
  const ctTranscriptMissing = fwd(join(root, 'ct-transcript-missing.jsonl')); // 刻意不寫檔——read 失敗案例用

  // ── eval-gate：真觸發 GATE 訊號的 regression 歷史 + 「有 .loops/ 但無任何 eval 檔」兩種 cwd ────
  const egRegressed = fwd(join(root, 'eg-regressed'));
  mkdirSync(join(egRegressed, '.loops', '.metrics'), { recursive: true });
  writeFileSync(
    join(egRegressed, '.loops', '.metrics', 'eval-results.jsonl'),
    '{"corpus":"c1","passRate":0.9}\n{"corpus":"c1","passRate":0.5}\n',
  );
  const egFresh = fwd(join(root, 'eg-fresh'));
  mkdirSync(join(egFresh, '.loops'), { recursive: true }); // 有 .loops，但無任何 eval metrics/report/judge 檔

  // ── stop-gate：gate.config.json 的 type 指令指向真實的 pass/fail 腳本（絕對路徑、sandbox 下無空白
  //    字元，故不需 shell 引號防禦；仍加引號僅為防禦性寫法，不依賴這個假設）───────────────────────
  const sgFailScript = fwd(join(root, 'sg-fail-type.mjs'));
  writeFileSync(sgFailScript, "console.log('fixture.ts(3,5): error TS2322: Type mismatch (fixture)');\nprocess.exit(1);\n");
  const sgPassScript = fwd(join(root, 'sg-pass-type.mjs'));
  writeFileSync(sgPassScript, 'process.exit(0);\n');
  const sgHintRoot = fwd(join(root, 'sg-hint-root'));
  mkdirSync(join(sgHintRoot, '.loops'), { recursive: true });
  writeFileSync(join(sgHintRoot, '.loops', 'gate.config.json'), '{}\n');
  const sgGateRedRoot = fwd(join(root, 'sg-gate-red-root'));
  mkdirSync(join(sgGateRedRoot, '.loops'), { recursive: true });
  writeFileSync(join(sgGateRedRoot, '.loops', 'gate.config.json'), JSON.stringify({ type: `node "${sgFailScript}"` }));
  const sgGateGreenRoot = fwd(join(root, 'sg-gate-green-root'));
  mkdirSync(join(sgGateGreenRoot, '.loops'), { recursive: true });
  writeFileSync(join(sgGateGreenRoot, '.loops', 'gate.config.json'), JSON.stringify({ type: `node "${sgPassScript}"` }));
  const sgNoConfigRoot = fwd(join(root, 'sg-no-config-root')); // 無 .loops、無 gate.config.json

  // ── loop-driver：fake gate script 透過 env LOOPS_LOOP_DRIVER_GATE_SCRIPT 覆寫（spawnSync 陣列參數、
  //    無 shell，無引號風險）；各案例各自 slug 目錄，state.json 內容由 fixture 的 seedFiles 每次執行前
  //    重寫（見檔頭 6），避免 characterization／mutation 兩份 runner 重跑同一 case 造成 iteration 飄移 ──
  const ldGateDegraded = fwd(join(root, 'ld-gate-degraded.mjs'));
  writeFileSync(ldGateDegraded, "console.log(JSON.stringify({gates:{test:'not-run',lint:'passed',type:'passed'},failures:[]}));\nprocess.exit(0);\n");
  const ldGateBlocked = fwd(join(root, 'ld-gate-blocked.mjs'));
  writeFileSync(ldGateBlocked, "console.log(JSON.stringify({gates:{test:'failed',lint:'passed',type:'passed'},failures:[{file:'src/x.ts',line:10,message:'boom',code:'E1'}]}));\nprocess.exit(1);\n");
  const ldRoot = fwd(join(root, 'ld-root')); // 主 repo 根（loop-driver 用 resolveLoopsRoot(cwd) 解析）
  for (const slug of ['ld-block', 'ld-degraded', 'ld-ledger-block', 'ld-reentry']) {
    mkdirSync(join(ldRoot, '.loops', slug), { recursive: true }); // state.json 由各 case 的 seedFiles 寫入
  }
  const ldNoState = fwd(join(root, 'ld-no-state')); // 主 repo 根，完全無 .loops/
  mkdirSync(ldNoState, { recursive: true });

  // ── progress-render：唯一用 process.cwd()（非 payload.cwd）定位 .loops 的家族成員——sandbox root
  //    的 OS cwd 就是 spawnSync 的 cwd（見 runCase），故這裡直接把 .loops 掛在 root 頂層，而非某個
  //    role 子目錄。pr-other-330 的 session 刻意不被任何 case 選中，PROGRESS.md 恆不存在，可當穩定
  //    的「從未寫入」基準，不受 case 執行順序影響 ─────────────────────────────────────────────
  mkdirSync(join(root, '.loops', 'pr-active-220'), { recursive: true });
  writeFileSync(join(root, '.loops', 'pr-active-220', 'loop.md'), [
    '# loop pr-active-220',
    '',
    '- session：loops-t3-char-progress-active',
    '- 類型：feature',
    '- 推進模式：manual',
    '- 停止條件：全部任務完成',
    '- 當前階段：build',
    '',
    '## Journal',
    '- [E1] 任務：實作 X',
    '',
  ].join('\n'));
  mkdirSync(join(root, '.loops', 'pr-other-330'), { recursive: true });
  writeFileSync(join(root, '.loops', 'pr-other-330', 'loop.md'), [
    '# loop pr-other-330',
    '',
    '- session：loops-t3-char-progress-other-session',
    '- 當前階段：goal',
    '',
  ].join('\n'));

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
    // ── T3b：Stop 家族 5 支 ──────────────────────────────────────────────────────
    CT_WITH_LOOPS: ctWithLoops,
    CT_NO_LOOPS: ctNoLoops,
    CT_TRANSCRIPT: ctTranscript,
    CT_TRANSCRIPT_MISSING: ctTranscriptMissing,
    EG_REGRESSED: egRegressed,
    EG_FRESH: egFresh,
    SG_HINT_ROOT: sgHintRoot,
    SG_GATE_RED_ROOT: sgGateRedRoot,
    SG_GATE_GREEN_ROOT: sgGateGreenRoot,
    SG_NO_CONFIG_ROOT: sgNoConfigRoot,
    LD_ROOT: ldRoot,
    LD_NO_STATE: ldNoState,
    LD_GATE_DEGRADED: ldGateDegraded,
    LD_GATE_BLOCKED: ldGateBlocked,
    PR_ACTIVE_PROGRESS: fwd(join(root, '.loops', 'pr-active-220', 'PROGRESS.md')),
    PR_OTHER_PROGRESS: fwd(join(root, '.loops', 'pr-other-330', 'PROGRESS.md')),
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
// stop-gate.mjs 的「發現性提示」per-session 節流 state 檔（loops-stop-gate-hint-<session>.json，見
// hooks/stop-gate.mjs 的 discoveryHintStateFile）。同一個 session_id 若曾在本機任何一次執行（含
// 產生 fixture 用的一次性腳本、或本測試檔前次執行殘留）被印過提示，之後同 session 就不會再印
// ——測試若不每次收斂清掉，會變成「跑第一次綠、跑第二次紅」的不可重現案例，故也需要 stateSetup。
export function stopGateHintStateFilePath(sessionId) {
  return join(tmpdir(), `loops-stop-gate-hint-${safeSessionId(sessionId)}.json`);
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
  if (stateSetup.kind === 'edits') {
    // eval-gate／stop-gate 共用的 edit-accumulator state 檔（loops-edits-<session>.json）；
    // preset 是「已累積的編輯路徑陣列」（hasEdits 判定的來源），非 reads/compact 的計數/等級語意。
    const p = editsStateFilePath(sessionId);
    if (stateSetup.preset == null) clearStateFile(p);
    else presetStateFile(p, { ts: 1, paths: stateSetup.preset });
    return;
  }
  if (stateSetup.kind === 'stopGateHint') {
    // stop-gate.mjs 的發現性提示節流 state；preset:null → 清掉（收斂成「本 session 尚未提示過」，
    // 讓 discovery-hint case 不受本機前次執行殘留影響，可重複執行皆綠）。
    const p = stopGateHintStateFilePath(sessionId);
    if (stateSetup.preset == null) clearStateFile(p);
    else presetStateFile(p, { hinted: true });
    return;
  }
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

/**
 * T3b 新增：把 fixtureCase.seedFiles（[{ path, content }]，path 可含 $ROLE$ token）在每次執行 hook
 * 「前」覆寫回固定內容——自我癒合寫法（先 mkdir 收斂父目錄、再整檔覆寫，不管前次殘留為何）。
 * 主要供 loop-driver.mjs 的 state.json 用：該 hook 會原地改寫 state.json（iteration+1），若不每次
 * 收斂回已知初態，characterization 與 mutation 兩份 runner 對同一 case 的重複呼叫會讓 iteration
 * 累積飄移，比對就會失去意義。content 為字串則原樣寫入，物件則 JSON.stringify（2 空白縮排，可讀）。
 */
export function applySeedFiles(seedFiles, roles) {
  if (!Array.isArray(seedFiles)) return;
  for (const sf of seedFiles) {
    const path = resolveTemplate(sf.path, roles);
    mkdirSync(dirname(path), { recursive: true });
    const content = typeof sf.content === 'string' ? sf.content : JSON.stringify(sf.content, null, 2);
    writeFileSync(path, content, 'utf8');
  }
}

// ── outbound-comment-guard 的絕對路徑正規化 token（見檔頭說明）───────────────────────────
export function docPathTokens() {
  // 與 outbound-comment-guard.mjs 內部 HOOKS_DIR/REFERENCES_DIR 算法一致（同一個 hooks/ 目錄、
  // 同一組相對 join 片段），確保 token 回填值與 hook 實際印出的值同源。刻意**不** forward-slash
  // 正規化——hook 本身用原生 path.join（Windows 上是反斜線），印出的字面文字就是反斜線；這裡若轉
  // 成 `/` 會跟真實 stdout 對不上，位元鎖會誤判成不吻合。
  return {
    COMMENT_POLICY_PATH: join(HOOKS_DIR, '..', 'references', 'shared', 'delivery', 'comment-policy.md'),
    OUTBOUND_TEMPLATES_PATH: join(HOOKS_DIR, '..', 'references', 'shared', 'delivery', 'outbound-templates.md'),
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

/** 讀檔；不存在／讀不到一律回 null（fileCheck 用，區分「檔案不存在」與「內容不吻合」）。 */
export function readFileMaybe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// T3b：cost-tracker.mjs／progress-render.mjs 主要作用是寫檔、stdout 恆空，純 stdout 位元鎖對它們
// 沒有鑑別力，故 fileCheck 額外鎖寫出的檔案內容。正規化器把「非本次行為決定」的不穩定欄位換成固定
// token，鎖住的是「這次執行真的把正確內容寫進去」這個不變量，而非某次執行湊巧的時間戳。
const FILE_NORMALIZERS = {
  // costs.jsonl 是 append-only：同一個 sandbox 在同一個 test process 內可能被同一個 case 重複執行
  // 多次（characterization 跑一次 + mutation 對每個變異體各跑一次），故只取「最後一行」（本次執行
  // 剛寫入的那行）比對，不受先前執行的行數累積影響。ts 欄位來自 Date.now()，非本次行為的一部分，
  // 正規化成固定 token。
  costRow: (text) => {
    const lines = String(text ?? '').split('\n').filter((l) => l.trim());
    if (lines.length === 0) return '(empty)';
    const row = JSON.parse(lines[lines.length - 1]);
    row.ts = '$TS$';
    return JSON.stringify(row);
  },
  // progress-render 每次都用 writeFileSync 整檔覆寫（非 append），內容純由 loop.md 靜態欄位推導、
  // 不含任何時間戳，天生跨次重跑穩定——原樣比對即可，不需正規化。
  exact: (text) => text,
};

function checkFileExpectation(fixtureCase, roles) {
  if (!fixtureCase.fileCheck) return { checked: false, ok: true };
  const path = resolveTemplate(fixtureCase.fileCheck.path, roles);
  const raw = readFileMaybe(path);
  if (fixtureCase.fileCheck.expectMissing) {
    return { checked: true, ok: raw === null, actual: raw === null ? '(missing)' : '(exists)', expected: '(missing)' };
  }
  if (raw === null) {
    return { checked: true, ok: false, actual: '(missing)', expected: fixtureCase.fileCheck.expectedContent ?? null };
  }
  const normalize = FILE_NORMALIZERS[fixtureCase.fileCheck.normalize || 'exact'];
  if (!normalize) throw new Error(`checkFileExpectation: 未知 normalize "${fixtureCase.fileCheck.normalize}"`);
  const normalized = normalize(raw);
  const expected = fixtureCase.fileCheck.expectedContent ?? null;
  return { checked: true, ok: normalized === expected, actual: normalized, expected };
}

/**
 * 單一真相源：把一個 fixture case 針對某個 hook 絕對路徑（可以是原始 hook，也可以是 mutation 測試
 * 寫出的變異副本）真跑一次，回傳「是否吻合 fixture 鎖住的現況」。characterization 與 mutation 兩份
 * runner 都呼叫這裡，確保兩邊比對的是同一把鎖、不是各自重寫一份而可能漂移
 * （mutation 測的就會失去「證明 characterization 那把鎖有鑑別力」的意義）。
 * 執行順序：resolve payload → stateSetup（讀 payload.session_id）→ seedFiles（與 payload 無關，
 * 每次執行前收斂持久檔案到已知初態）→ resolve env（T3b：env 值也支援 $ROLE$ token，供
 * LOOPS_LOOP_DRIVER_GATE_SCRIPT 之類需要指向 sandbox 路徑的旗標用）→ 真跑 → 比對 stdout/exit +
 * 選配的 fileCheck。
 */
export function runFixtureCase(hookAbsPath, fixtureCase, roles, sandboxRoot) {
  const payload = fixtureCase.payload ? resolveTemplate(fixtureCase.payload, roles) : undefined;
  if (fixtureCase.stateSetup) applyStateSetup(fixtureCase.stateSetup, payload);
  if (fixtureCase.seedFiles) applySeedFiles(fixtureCase.seedFiles, roles);
  const env = fixtureCase.env ? resolveTemplate(fixtureCase.env, roles) : {};
  const r = runCase(hookAbsPath, {
    payload,
    rawInput: fixtureCase.rawInput,
    env,
    sandboxRoot,
  });
  const expectedStdout = fillDocPathTokens(fixtureCase.expectedStdout);
  const stdoutOk = r.error == null && r.status === fixtureCase.expectedExitCode && r.stdout === expectedStdout;
  const fileResult = checkFileExpectation(fixtureCase, roles);
  const ok = stdoutOk && fileResult.ok;
  return {
    ok,
    actualStdout: r.stdout,
    actualExitCode: r.status,
    expectedStdout,
    error: r.error,
    fileChecked: fileResult.checked,
    fileOk: fileResult.ok,
    fileActual: fileResult.actual,
    fileExpected: fileResult.expected,
  };
}
