#!/usr/bin/env node
// test-hook-input-normalize.mjs —— hook-input-normalize.mjs（#183 T4/T5/T6/T11 雙 harness 相容層純函式葉節點）
// 紅燈斷言。自帶極簡 assert harness（仿同目錄 test-merge-guard.mjs），不引測試框架。
//
// 用法（cwd = plugins/loops-workflow）：node hooks/test-hook-input-normalize.mjs
// 全綠 → exit 0；任一斷言失敗 → exit 1。
//
// 紅燈期說明：hook-input-normalize.mjs 尚未存在——動態 `await import()` 會 ERR_MODULE_NOT_FOUND，
// 本檔以 try/catch 吞掉、把 normalize/tokenizeShellLike 綁成 undefined，讓所有斷言完整跑完、逐條顯紅，
// 而不是一次性崩潰（同 test-merge-guard.mjs 的「動態 import 安全探測」慣例）。
//
// 受測物契約摘要（見任務說明；純函式葉節點，只 import node 內建、不 import 任何 guard）：
//   normalize(payload, env) → NormalizedInput { harness, hookEvent, toolName, command, tokens,
//     filePaths, gitSubcommands, effectiveGitDir, pluginRoot, dataRoot, rootSource, cwd, degraded }
//   tokenizeShellLike(cmd) → Array<{ value, quoted }>（引號感知 tokenizer）
//
// Root 環境變數命名假設（無先例可查，本檔基於 evals/baseline/codex/gaps.json 明文「hook 命令環境變數含
// CLAUDE_PLUGIN_ROOT/PLUGIN_ROOT 相容」推得 pluginRoot 的 native/alias 對；dataRoot 依同一 CLAUDE_ 前綴
// 慣例類推 CLAUDE_PROJECT_DIR/PROJECT_DIR——若 impl 採用不同變數名，S14 三條會因「變數名不符」而非
// 「機制錯誤」致紅，見 notes）。

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = join(HERE, 'hook-input-normalize.mjs');

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

// =============================================================================
// 動態 import 安全探測
// =============================================================================
let mod = null;
try {
  mod = await import('./hook-input-normalize.mjs');
} catch (e) {
  console.error(`  (hook-input-normalize.mjs 動態 import 失敗——預期中，檔案尚未建立：${e && e.message})`);
}
assert(existsSync(MODULE_PATH), 'hooks/hook-input-normalize.mjs 檔案存在（下面所有案例的前提）[exist]');

function callNormalize(payload, env) {
  if (!mod || typeof mod.normalize !== 'function') return undefined;
  try {
    return mod.normalize(payload, env);
  } catch (e) {
    return { __threw: e && e.message };
  }
}
function callTokenize(cmd) {
  if (!mod || typeof mod.tokenizeShellLike !== 'function') return undefined;
  try {
    return mod.tokenizeShellLike(cmd);
  } catch (e) {
    return { __threw: e && e.message };
  }
}

// =============================================================================
// Payload builders（家族慣例：PreToolUse Bash|Edit 同形；仿 test-merge-guard.mjs / config-protection.mjs）
// =============================================================================
function claudeCommandPayload(command, cwd) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd };
}
function claudeFilePayload(filePath, cwd) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: filePath }, cwd };
}
function codexApplyPatchPayload(patchBody, cwd) {
  // apply_patch 承載於 tool_input.command（官方載 Bash canonical tool_name + Edit/Write matcher 別名——
  // 這裡固定用 Bash 殼，區別點在 command 內容本身是 apply_patch patch 文字，而非 harness 專屬 tool_name）。
  return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: patchBody }, cwd };
}

const ADD_UPDATE_DELETE_PATCH = [
  '*** Begin Patch',
  '*** Add File: src/new-file.js',
  '+export const value = 1;',
  '*** Update File: src/protected.js',
  '@@',
  '-const a = 1;',
  '+const a = 2;',
  '*** Delete File: src/old-file.js',
  '*** End Patch',
].join('\n');

const isChineseReadable = (s) => typeof s === 'string' && s.length > 0 && /[\u4e00-\u9fff]/.test(s);

// =============================================================================
// S11 —— 等價判定：平台形狀不同（Claude tool_input.file_path 單一字串 vs Codex apply_patch）但正確
// 分流出 harness 欄位；同時釘住 I1 的 Claude 單檔抽取。
// =============================================================================
{
  const cwd = 'C:/repo/base-cwd';
  const claudePayload = claudeFilePayload('src/target.js', cwd);
  const env = { CLAUDE_PLUGIN_ROOT: '/native/plugin-root' };
  const result = callNormalize(claudePayload, env);
  assert(result?.harness === 'claude', "[S11-1] Claude 形狀 payload（tool_input.file_path 單一字串）→ harness === 'claude'");
  assert(Array.isArray(result?.filePaths) && result.filePaths.length === 1 && result.filePaths[0] === 'src/target.js',
    '[S11-2] I1 Claude 形狀：filePaths 恰好一筆、等於 tool_input.file_path 的值');
  assert(result?.degraded == null, '[S11-3] Claude 形狀 payload 判得出 harness → degraded 為 null');
}
{
  const cwd = 'C:/repo/base-cwd';
  const codexPayload = codexApplyPatchPayload(ADD_UPDATE_DELETE_PATCH, cwd);
  const env = { PLUGIN_ROOT: '/alias/plugin-root' };
  const result = callNormalize(codexPayload, env);
  assert(result?.harness === 'codex', "[S11-4] Codex 形狀 payload（tool_input.command 為 apply_patch）→ harness === 'codex'");
}
{
  const unrecognizable = { foo: 'bar', tool_input: {} };
  const result = callNormalize(unrecognizable, {});
  assert(result?.harness === 'unknown', "[S11-5] 判不出來的 payload → harness === 'unknown'");
  assert(result?.degraded != null, '[S11-6] harness 判不出來 → degraded 非 null（可見降級，見 S16）');
}

// =============================================================================
// S12 —— apply_patch 逐檔：Codex apply_patch patch 內 N 個檔（Add/Update/Delete 三種）→ filePaths 回 N 筆；
// 反向：受保護檔非第一個仍須出現（只抽首檔的實作要讓這條紅）。
// =============================================================================
{
  const payload = codexApplyPatchPayload(ADD_UPDATE_DELETE_PATCH, 'C:/repo/base-cwd');
  const result = callNormalize(payload, {});
  assert(Array.isArray(result?.filePaths) && result.filePaths.length === 3,
    '[S12-1] apply_patch patch 含 3 個檔（Add/Update/Delete 各一）→ filePaths 回 3 筆');
  assert(result?.filePaths?.includes('src/new-file.js'), '[S12-2] filePaths 含 Add File 的路徑 "src/new-file.js"');
  assert(result?.filePaths?.includes('src/protected.js'),
    '[S12-3] filePaths 含 Update File 的路徑 "src/protected.js"（非首檔，只抽首檔的實作要讓這條紅）');
  assert(result?.filePaths?.includes('src/old-file.js'), '[S12-4] filePaths 含 Delete File 的路徑 "src/old-file.js"');
}
{
  // 反向重點案例：受保護檔擺在第二個位置（非第一個），仍須完整出現於 filePaths。
  const patch = [
    '*** Begin Patch',
    '*** Add File: docs/unrelated.md',
    '+irrelevant content',
    '*** Update File: .claude/settings.json',
    '@@',
    '-old',
    '+new',
    '*** End Patch',
  ].join('\n');
  const result = callNormalize(codexApplyPatchPayload(patch, 'C:/repo/base-cwd'), {});
  assert(result?.filePaths?.length === 2, '[S12-5] 反向：兩個檔（受保護檔在第二個）→ filePaths 回 2 筆');
  assert(result?.filePaths?.includes('.claude/settings.json'),
    '[S12-6] 反向：受保護檔 ".claude/settings.json" 不是 patch 內第一個檔，仍出現在 filePaths 裡');
}

// =============================================================================
// S13 —— git -C 兩層：-C 綁定到緊鄰其後的子指令，不是全域刮取 command 內所有 -C
// =============================================================================
{
  const result = callNormalize(claudeCommandPayload('git -C /tmp/x merge foo', 'C:/repo/base-cwd'), {});
  const mergeEntry = (result?.gitSubcommands || []).find((e) => e?.subcommand === 'merge');
  assert(mergeEntry?.dashC === '/tmp/x', "[S13-1] 'git -C /tmp/x merge foo' → gitSubcommands 有一筆 {subcommand:'merge', dashC:'/tmp/x'}");
  assert(result?.effectiveGitDir === '/tmp/x', "[S13-2] effectiveGitDir === '/tmp/x'");
}
{
  // 反向關鍵案例：非 git 指令的 -C 選項（foo -C /elsewhere）不得污染 effectiveGitDir；
  // 全域刮取所有 -C 的實作會讓這條紅。
  const cwd = 'C:/repo/base-cwd';
  const result = callNormalize(claudeCommandPayload('foo -C /elsewhere && git merge foo', cwd), {});
  assert(result?.effectiveGitDir !== '/elsewhere',
    "[S13-3] 反向：'foo -C /elsewhere && git merge foo' → effectiveGitDir 不得取 '/elsewhere'（全域刮取所有 -C 的實作要讓這條紅）");
  assert(result?.effectiveGitDir === cwd,
    "[S13-4] 反向：無 git 指令自帶 -C 時，effectiveGitDir 應退回 cwd（本例 = 'C:/repo/base-cwd'）");
}
{
  // 含空白的路徑，被引號包住——tokenizer 要正確取出完整值，不能被空白截斷。
  const result = callNormalize(claudeCommandPayload('git -C "D:/a b" merge x', 'C:/repo/base-cwd'), {});
  const mergeEntry = (result?.gitSubcommands || []).find((e) => e?.subcommand === 'merge');
  assert(mergeEntry?.dashC === 'D:/a b', '[S13-5] \'git -C "D:/a b" merge x\' → dashC === \'D:/a b\'（含空白、引號正確剝除）');
}
{
  // 跳過 git 全域選項（--no-pager）後仍要認出 subcommand 與 -C。
  const result = callNormalize(claudeCommandPayload('git --no-pager -C /x merge y', 'C:/repo/base-cwd'), {});
  const mergeEntry = (result?.gitSubcommands || []).find((e) => e?.subcommand === 'merge');
  assert(mergeEntry?.subcommand === 'merge', "[S13-6] 'git --no-pager -C /x merge y' → 跳過全域選項後仍認出 subcommand='merge'");
  assert(mergeEntry?.dashC === '/x', "[S13-7] 'git --no-pager -C /x merge y' → dashC === '/x'");
}
{
  // 多個 git 呼叫：兩筆 gitSubcommands，merge 那筆的 dashC 各自獨立、不互相污染。
  const result = callNormalize(claudeCommandPayload('git -C /a status && git -C /b merge z', 'C:/repo/base-cwd'), {});
  assert(Array.isArray(result?.gitSubcommands) && result.gitSubcommands.length === 2,
    "[S13-8] 'git -C /a status && git -C /b merge z' → gitSubcommands 恰好兩筆");
  const statusEntry = (result?.gitSubcommands || []).find((e) => e?.subcommand === 'status');
  const mergeEntry = (result?.gitSubcommands || []).find((e) => e?.subcommand === 'merge');
  assert(statusEntry?.dashC === '/a', '[S13-9] status 那筆 dashC === \'/a\'');
  assert(mergeEntry?.dashC === '/b', '[S13-10] merge 那筆 dashC === \'/b\'（各自獨立，不被前一筆污染）');
}

// =============================================================================
// tokens 的 quoted 旗標（isFlagToken = !quoted && startsWith('-') 語意的地基；無獨立 S-ID，補齊邊界）
// =============================================================================
{
  const quotedTokens = callTokenize('git push origin "-x"');
  const bareTokens = callTokenize('git push origin -x');
  const quotedX = (Array.isArray(quotedTokens) ? quotedTokens : []).find((t) => t?.value === '-x');
  const bareX = (Array.isArray(bareTokens) ? bareTokens : []).find((t) => t?.value === '-x');
  assert(quotedX?.quoted === true, '[Q1] \'git push origin "-x"\' → "-x" token 的 quoted === true');
  assert(bareX?.quoted === false, "[Q2] 'git push origin -x' → \"-x\" token 的 quoted === false");
  assert(quotedX?.quoted !== bareX?.quoted,
    '[Q3] 反向斷言：兩者的 quoted 值必須不同（若 tokenizer 丟掉 quoted 資訊，isFlagToken 語意會壞）');
}

// =============================================================================
// S14 —— root 解析：平台原生變數 vs alias vs 都無（值 + rootSource + degraded 三態）
// =============================================================================
{
  const env = { CLAUDE_PLUGIN_ROOT: '/native/plugin-root', CLAUDE_PROJECT_DIR: '/native/data-root' };
  const result = callNormalize(claudeCommandPayload('git status', 'C:/repo/base-cwd'), env);
  assert(result?.rootSource === 'native', "[S14-1] 平台原生變數（CLAUDE_PLUGIN_ROOT/CLAUDE_PROJECT_DIR）存在 → rootSource === 'native'");
  assert(result?.pluginRoot === '/native/plugin-root', '[S14-2] rootSource=native 時 pluginRoot 取原生值');
  assert(result?.dataRoot === '/native/data-root', '[S14-3] rootSource=native 時 dataRoot 取原生值');
}
{
  const env = { PLUGIN_ROOT: '/alias/plugin-root', PROJECT_DIR: '/alias/data-root' };
  const result = callNormalize(claudeCommandPayload('git status', 'C:/repo/base-cwd'), env);
  assert(result?.rootSource === 'alias', "[S14-4] 只有 alias 變數（PLUGIN_ROOT/PROJECT_DIR）存在 → rootSource === 'alias'");
  assert(result?.pluginRoot === '/alias/plugin-root', '[S14-5] rootSource=alias 時 pluginRoot 取 alias 值');
  assert(result?.dataRoot === '/alias/data-root', '[S14-6] rootSource=alias 時 dataRoot 取 alias 值');
}
{
  const result = callNormalize(claudeCommandPayload('git status', 'C:/repo/base-cwd'), {});
  assert(result?.rootSource === 'none', "[S14-7] 平台原生與 alias 變數都不存在 → rootSource === 'none'");
  assert(result?.pluginRoot == null && result?.dataRoot == null, '[S14-8] rootSource=none 時 pluginRoot/dataRoot 皆為 null');
  assert(result?.degraded != null, '[S14-9] rootSource=none → degraded 非 null');
}

// =============================================================================
// S16 —— degraded 可見：reason 必須是人看得懂的繁中說明。⚠ 不斷言 degraded 導致擋下——
// degraded 只讓降級可見、不改變放行與否（該行為切換屬另一張 issue，見 I3）。
// =============================================================================
{
  const result = callNormalize({ foo: 'bar', tool_input: {} }, {});
  assert(result?.degraded != null, '[S16-1] 判不出 harness → degraded 非 null');
  assert(isChineseReadable(result?.degraded?.reason),
    '[S16-2] degraded.reason 是人看得懂的繁體中文說明（非英文錯誤碼 / 空字串）');
}
{
  const result = callNormalize(claudeCommandPayload('git status', 'C:/repo/base-cwd'), {});
  assert(result?.rootSource === 'none' && result?.degraded != null, '[S16-3]（前置）root 都解析不出 → degraded 非 null');
  assert(isChineseReadable(result?.degraded?.reason),
    '[S16-4] root 解析不出時 degraded.reason 同樣是人看得懂的繁體中文說明');
  // 關鍵反向：degraded 不得被誤實作成「放行/擋下」的判斷依據——這裡只驗 reason 語意，不驗任何
  // permissionDecision / deny 欄位（本函式契約裡根本沒有這種欄位；normalize 是純資料轉換，不做擋不擋的判斷）。
  assert(!('permissionDecision' in (result || {})),
    '[S16-5] NormalizedInput 不含 permissionDecision 欄位（degraded 不改變放行與否，屬另一張 issue）');
}

const total = passed + failed.length;
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
console.log(`(共 ${total} 條斷言：S11=等價判定／S12=apply_patch逐檔／S13=-C兩層／Q=quoted旗標／S14=root解析／S16=degraded可見)`);
process.exit(failed.length > 0 ? 1 : 0);
