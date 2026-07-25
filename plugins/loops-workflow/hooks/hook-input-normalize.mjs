// hook-input-normalize.mjs —— Claude／Codex 雙 harness hook payload 正規化葉節點（issue #183 T4/T5/
// T6/T11）。兩個 harness 送進 hook 的 payload 形狀不同（Claude：tool_input.file_path 單一字串；
// Codex：apply_patch 的多檔 diff 夾在 tool_input.command 裡），既有 9 支 guard 各自用 ad hoc
// 字串判定。本檔把「判 harness／抽檔案路徑／切 git 子指令與 -C／解析 plugin-root 與 data-root
// 環境變數 alias」收斂到單一純函式入口，供後續任務接線進既有 guard。
//
// 純函式葉節點：不碰 process.env（env 由呼叫端傳入，同 hook-flags.mjs 慣例）、不做 IO、只 import
// node 內建模組、不 import 任何 guard（避免循環依賴——這是被 guard 依賴的葉節點，不是反過來）。
//
// degraded 的語意（issue 拍板）：只表示「這裡判不出來，用人看得懂的繁中說明講清楚」，不是「所以要
// 擋下」的決策——normalize 是純資料轉換，NormalizedInput 裡沒有 permissionDecision 這種欄位，擋不
// 擋永遠是呼叫端 guard 的事。
//
// tokenizeShellLike 收斂（reuse-check）：merge-guard.mjs／pr-owner-guard.mjs／pr-gate.mjs（內嵌同條
// regex）各自維護同一份「尊重引號切 token、回傳 quoted 旗標」邏輯，這裡收成單一定義並 export。
// 本任務範圍只建立並 export——三支既有 guard 改接線是後續任務，不在這裡動。

// ── tokenizeShellLike（收斂自 merge-guard.mjs / pr-owner-guard.mjs / pr-gate.mjs 的重複實作）───────

/**
 * 把指令字串尊重引號切成 token（單/雙引號包住的整段回傳去引號後的值＋是否為引號 token）。只做
 * 字面「切詞＋去引號」，不解讀完整 shell 語意（無變數展開／管線語意）。`quoted` 旗標是判定用的地基
 * ——呼叫端據此判斷一個以 `-` 開頭的 token 是不是真的 flag（引號包住的值即使字面像 flag 也不算，
 * 因為引號代表呼叫端明確把它標記成一個值，例如 `git push origin "-x"` 的 `"-x"` 是分支名不是旗標）。
 */
export function tokenizeShellLike(cmd) {
  const tokens = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    const quoted = m[1] !== undefined || m[2] !== undefined;
    tokens.push({ value: m[1] ?? m[2] ?? m[3], quoted });
  }
  return tokens;
}

// ── harness 判定 ──────────────────────────────────────────────────────────────────

// apply_patch patch 文字的三種檔案標頭，任一存在即代表這是 Codex apply_patch 承載的 command
// （而非一般 shell 指令）。錨在行首（`^…`，multiline）避免字樣出現在別的指令引號值/內文裡誤判。
const APPLY_PATCH_MARKER_RE = /^\*\*\* (Begin Patch|Add File:|Update File:|Delete File:|End Patch)/m;

function isApplyPatchCommand(command) {
  return typeof command === 'string' && APPLY_PATCH_MARKER_RE.test(command);
}

/**
 * 判斷 payload 屬於哪個 harness：apply_patch 承載於 tool_input.command → 'codex'；Claude 形狀
 * （tool_input.file_path 單一字串，或一般 shell tool_input.command）→ 'claude'；兩者皆判不出
 * → 'unknown'（degraded，見檔頭說明）。
 */
function detectHarness(command, filePath) {
  if (isApplyPatchCommand(command)) return 'codex';
  if (filePath != null || command != null) return 'claude';
  return 'unknown';
}

// ── apply_patch 逐檔抽取 ──────────────────────────────────────────────────────────

// `*** Add File: <path>` / `*** Update File: <path>` / `*** Delete File: <path>` 三種標頭，全域比對
// （global + multiline）以抽出 patch 裡所有檔案，不只取第一個。
const APPLY_PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

/** 從 apply_patch patch 文字逐檔抽出路徑（Add/Update/Delete 三種標頭皆抽，依 patch 內出現順序）。 */
function extractApplyPatchFilePaths(command) {
  return [...command.matchAll(APPLY_PATCH_FILE_RE)].map((m) => m[1].trim());
}

// ── git -C 兩層解析 ───────────────────────────────────────────────────────────────

// shell 命令段分隔符（未被引號包住時才算）：`&&`／`||`／`;`／`|`。
const SEGMENT_SEPARATORS = new Set(['&&', '||', ';', '|']);

/** 把已切好的 token 序列，依未引號的命令段分隔符切成多段（每段對應一次獨立的指令呼叫）。 */
function splitIntoSegments(tokens) {
  const segments = [];
  let current = [];
  for (const tok of tokens) {
    if (!tok.quoted && SEGMENT_SEPARATORS.has(tok.value)) {
      segments.push(current);
      current = [];
    } else {
      current.push(tok);
    }
  }
  segments.push(current);
  return segments;
}

// git 全域選項中「後面接獨立一個 token 當值」的集合（`-C` 另外處理、要記錄其值；這裡是其餘會
// 吃掉下一個 token、但呼叫端不關心其值的全域選項——只需正確跳過，才能找到真正的子指令）。
const GIT_GLOBAL_OPTS_TAKING_VALUE = new Set([
  '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env',
]);

/**
 * 解析單一「以 git 開頭」的命令段：跳過全域選項找出子指令，並記錄綁定在這次 git 呼叫上的 `-C`
 * 值（若有）。約束：`-C` 必須綁到擁有該子指令的這一次 git 呼叫——本函式只在呼叫端已確認
 * `segment[0] === 'git'` 時處理該段，天生滿足這個約束（不會跨段刮取）。
 */
function parseGitSegment(segment) {
  let i = 1;
  let dashC = null;
  while (i < segment.length) {
    const tok = segment[i];
    if (tok.quoted || !tok.value.startsWith('-')) break; // 第一個非選項 token = 子指令
    if (tok.value === '-C') {
      dashC = segment[i + 1] ? segment[i + 1].value : null;
      i += 2;
      continue;
    }
    i += GIT_GLOBAL_OPTS_TAKING_VALUE.has(tok.value) ? 2 : 1;
  }
  const subcommand = segment[i] ? segment[i].value : null;
  return subcommand ? { subcommand, dashC } : null;
}

/**
 * 把整條指令字串切成命令片段（依 `&&`／`||`／`;`／`|`），只在片段第一個 token 是（未引號的）`git`
 * 時才解析該片段的子指令與 `-C`——非 git 指令（例如 `foo -C /elsewhere`）不會被誤判成 git 呼叫，
 * 這正是 `-C` 綁定約束（見檔頭說明）的地基。
 */
function extractGitSubcommands(command) {
  const segments = splitIntoSegments(tokenizeShellLike(command));
  const result = [];
  for (const segment of segments) {
    const first = segment[0];
    if (!first || first.quoted || first.value !== 'git') continue;
    const parsed = parseGitSegment(segment);
    if (parsed) result.push(parsed);
  }
  return result;
}

/**
 * effectiveGitDir：指令裡最後一次「帶 `-C` 的 git 呼叫」的目的地；若沒有任何 git 呼叫帶 `-C`，退回
 * cwd（fail-safe：判不出來就用呼叫當下所在目錄，不得誤取無關指令的 `-C`）。
 */
function computeEffectiveGitDir(gitSubcommands, cwd) {
  for (let i = gitSubcommands.length - 1; i >= 0; i -= 1) {
    if (gitSubcommands[i].dashC != null) return gitSubcommands[i].dashC;
  }
  return cwd;
}

// ── plugin-root／data-root 解析（原生變數優先，其次 alias，皆無則 'none'）────────────────────────

/**
 * 解析 pluginRoot／dataRoot：原生變數（CLAUDE_PLUGIN_ROOT／CLAUDE_PROJECT_DIR）任一存在 →
 * rootSource='native'、兩欄皆取原生值；否則 alias 變數（PLUGIN_ROOT／PROJECT_DIR）任一存在 →
 * rootSource='alias'、兩欄皆取 alias 值；兩者皆無 → rootSource='none'、兩欄皆 null。
 */
function resolveRoots(env) {
  const source = env ?? {};
  const nativePluginRoot = source.CLAUDE_PLUGIN_ROOT ?? null;
  const nativeDataRoot = source.CLAUDE_PROJECT_DIR ?? null;
  const aliasPluginRoot = source.PLUGIN_ROOT ?? null;
  const aliasDataRoot = source.PROJECT_DIR ?? null;

  if (nativePluginRoot != null || nativeDataRoot != null) {
    return { pluginRoot: nativePluginRoot, dataRoot: nativeDataRoot, rootSource: 'native' };
  }
  if (aliasPluginRoot != null || aliasDataRoot != null) {
    return { pluginRoot: aliasPluginRoot, dataRoot: aliasDataRoot, rootSource: 'alias' };
  }
  return { pluginRoot: null, dataRoot: null, rootSource: 'none' };
}

// ── degraded 可見性（不做擋不擋的判斷，只把「判不出來」講清楚）───────────────────────────────────

function buildDegraded(harness, rootSource) {
  const reasons = [];
  if (harness === 'unknown') {
    reasons.push('無法從 payload 形狀判斷這是 Claude 還是 Codex 送來的（既非 tool_input.file_path 也非 tool_input.command），harness 判定為 unknown。');
  }
  if (rootSource === 'none') {
    reasons.push('偵測不到外掛根目錄（CLAUDE_PLUGIN_ROOT／PLUGIN_ROOT）或專案根目錄（CLAUDE_PROJECT_DIR／PROJECT_DIR）的環境變數，pluginRoot／dataRoot 皆判定為 none。');
  }
  return reasons.length ? { reason: reasons.join('；') } : null;
}

// ── 對外主入口 ────────────────────────────────────────────────────────────────────

/**
 * 把 Claude／Codex 兩種 harness 的 hook payload 正規化成統一形狀。純函式：不讀 process.env（env
 * 由呼叫端傳入）、不做 IO。
 *
 * @param {object} payload hook 收到的原始 JSON payload（PreToolUse 形狀：hook_event_name /
 *   tool_name / tool_input / cwd）。
 * @param {object} env 環境變數物件（呼叫端傳 process.env）。
 * @returns {{harness:string, hookEvent:?string, toolName:?string, command:?string,
 *   tokens:Array, filePaths:string[], gitSubcommands:Array, effectiveGitDir:?string,
 *   pluginRoot:?string, dataRoot:?string, rootSource:string, cwd:?string, degraded:?object}}
 */
export function normalize(payload, env) {
  const toolInput = payload?.tool_input ?? {};
  const command = typeof toolInput.command === 'string' ? toolInput.command : null;
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : null;
  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : null;

  const isPatch = isApplyPatchCommand(command);
  const harness = detectHarness(command, filePath);

  const filePaths = isPatch ? extractApplyPatchFilePaths(command) : (filePath != null ? [filePath] : []);
  const tokens = command != null && !isPatch ? tokenizeShellLike(command) : [];
  const gitSubcommands = command != null && !isPatch ? extractGitSubcommands(command) : [];
  const effectiveGitDir = computeEffectiveGitDir(gitSubcommands, cwd);

  const { pluginRoot, dataRoot, rootSource } = resolveRoots(env);

  return {
    harness,
    hookEvent: payload?.hook_event_name ?? null,
    toolName: payload?.tool_name ?? null,
    command,
    tokens,
    filePaths,
    gitSubcommands,
    effectiveGitDir,
    pluginRoot,
    dataRoot,
    rootSource,
    cwd,
    degraded: buildDegraded(harness, rootSource),
  };
}
