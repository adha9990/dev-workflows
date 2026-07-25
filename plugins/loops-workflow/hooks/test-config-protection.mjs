#!/usr/bin/env node
// test-config-protection.mjs —— config-protection.mjs（PreToolUse Write|Edit|MultiEdit deny hook，
// #87）接上 hook-input-normalize.mjs 正規化層（issue #183 T8）後的紅綠斷言。自帶極簡 harness（真
// spawn，仿同目錄 test-merge-guard.mjs 的 runHook 模式），不引測試框架。
//
// 用法（cwd = plugins/loops-workflow）：node hooks/test-config-protection.mjs
// 全綠 → exit 0；任一斷言失敗 → exit 1。
//
// 涵蓋（見任務指示的 5 類）：
//   C1 Claude 形狀 file_path 指向受保護檔 → deny（現有行為，位元鎖見 test-guard-characterization.mjs）。
//   C2 Claude 形狀指向一般檔 → 放行。
//   C3 apply_patch 內含多檔、受保護檔不是第一個 → 仍 deny（核心修復：改前只抽 tool_input.file_path
//      單一欄位，apply_patch 形狀的 payload 該欄位不存在 → 全面 fail-open，一個檔都不抽）。
//   C4 反向：apply_patch 內全部是一般檔 → 放行（證明不是「有 apply_patch 就擋」）。
//   C5 apply_patch 結構殘缺（tool_input 既無 file_path 也無 command）→ normalize() 判 harness=unknown
//      → degraded 可見（stderr 含人可讀繁中說明）但仍放行（fail-open 契約不變，見 config-protection.mjs
//      檔頭「任何例外一律放行」的擴充：degraded 不是例外，但同樣不得改變擋不擋）。
//
// 環境注意（比照 test-merge-guard.mjs:154-166 的 runHook）：這台機器的 shell env 帶著
// LOOPS_CONFIG_PROTECTION 之類殘留——一律先清空再套用 case 指定值，防 ambient 污染。
// 環境注意 2：payload.cwd 一律用 Windows 形路徑（`C:/...`）——POSIX 形在 Windows 上的 node 會解不到。

import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = join(HERE, 'config-protection.mjs');

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

assert(existsSync(HOOK_SCRIPT), 'hooks/config-protection.mjs 檔案存在（下面所有 IO 層案例的前提）[exist]');

const SANDBOX = join(tmpdir(), `cp-t8-${process.pid}`);

try {
  // Fixture：有 .loops/（loops-scoped 生效）＋一份已存在的 eslint.config.js＋一份一般檔。
  const WITH_LOOPS = join(SANDBOX, 'with-loops').replace(/\\/g, '/');
  mkdirSync(join(WITH_LOOPS, '.loops'), { recursive: true });
  writeFileSync(join(WITH_LOOPS, 'eslint.config.js'), 'module.exports = {};\n');
  writeFileSync(join(WITH_LOOPS, 'README.md'), '# readme\n');
  writeFileSync(join(WITH_LOOPS, 'src.ts'), 'export const x = 1;\n');

  function runHook({ rawInput, payload, env = {} } = {}) {
    const input = rawInput !== undefined ? rawInput : JSON.stringify(payload);
    const mergedEnv = { ...process.env, ...env };
    // 防 ambient shell 環境殘留 LOOPS_CONFIG_PROTECTION 汙染斷言——預設不繼承，僅 case 明確傳入才保留
    // （#132 P7 教訓同款防護，同 test-merge-guard.mjs runHook）。
    if (!('LOOPS_CONFIG_PROTECTION' in env)) delete mergedEnv.LOOPS_CONFIG_PROTECTION;
    return spawnSync(process.execPath, [HOOK_SCRIPT], {
      input,
      cwd: WITH_LOOPS,
      env: mergedEnv,
      encoding: 'utf8',
    });
  }
  const stdoutOf = (res) => (typeof res.stdout === 'string' ? res.stdout : '');
  const parseOut = (res) => { try { return JSON.parse(stdoutOf(res).trim()); } catch { return null; } };
  const isDeny = (res) => parseOut(res)?.hookSpecificOutput?.permissionDecision === 'deny';
  const isAllow = (res) => res.status === 0 && stdoutOf(res).trim() === '';

  // ===========================================================================
  // C1 —— Claude 形狀 file_path 指向受保護檔 → deny（現有行為，不得變）
  // ===========================================================================
  {
    const res = runHook({
      payload: { cwd: WITH_LOOPS, tool_input: { file_path: `${WITH_LOOPS}/eslint.config.js` } },
    });
    assert(res.error == null && res.status === 0, '[C1-1] spawn 無 error、exit 0');
    assert(isDeny(res), '[C1-2] Claude 形狀 file_path 指向受保護且已存在的 eslint.config.js → deny');
  }

  // ===========================================================================
  // C2 —— Claude 形狀指向一般檔 → 放行
  // ===========================================================================
  {
    const res = runHook({
      payload: { cwd: WITH_LOOPS, tool_input: { file_path: `${WITH_LOOPS}/README.md` } },
    });
    assert(isAllow(res), '[C2-1] Claude 形狀 file_path 指向一般檔 README.md → 放行');
  }

  // ===========================================================================
  // C3 —— apply_patch 內含多檔、受保護檔不是第一個 → 仍 deny（核心修復）
  // ===========================================================================
  {
    const patch = [
      '*** Begin Patch',
      '*** Update File: README.md',
      '@@',
      '-old',
      '+new',
      '*** Update File: eslint.config.js',
      '@@',
      '-module.exports = {};',
      '+module.exports = { rules: {} };',
      '*** End Patch',
    ].join('\n');
    const res = runHook({
      payload: { cwd: WITH_LOOPS, tool_input: { command: patch } },
    });
    assert(isDeny(res),
      '[C3-1] apply_patch 多檔 patch（README.md 在前、受保護 eslint.config.js 在後、非第一個）→ deny'
      + '（改前只讀 tool_input.file_path，這種 payload 該欄位不存在，全面 fail-open——一個檔都不抽）');
  }

  // ===========================================================================
  // C4 —— 反向：apply_patch 內全部是一般檔 → 放行（證明不是「有 apply_patch 就擋」）
  // ===========================================================================
  {
    const patch = [
      '*** Begin Patch',
      '*** Update File: README.md',
      '@@',
      '-old',
      '+new',
      '*** Add File: src.ts',
      '+export const y = 2;',
      '*** End Patch',
    ].join('\n');
    const res = runHook({
      payload: { cwd: WITH_LOOPS, tool_input: { command: patch } },
    });
    assert(isAllow(res),
      '[C4-1] apply_patch 多檔 patch（README.md／src.ts，皆非受保護檔）→ 放行（不是「有 apply_patch 就擋」）');
  }

  // ===========================================================================
  // C5 —— apply_patch 結構殘缺（既無 file_path 也無 command）→ degraded 可見（stderr）但仍放行
  // ===========================================================================
  {
    const res = runHook({
      payload: { cwd: WITH_LOOPS, tool_input: {} },
    });
    assert(isAllow(res), '[C5-1] tool_input 既無 file_path 也無 command（結構殘缺）→ 仍放行（fail-open 契約不變）');
    const stderrText = typeof res.stderr === 'string' ? res.stderr : '';
    assert(stderrText.includes('config-protection'), '[C5-2] stderr 含 hook 名稱前綴，degraded 訊息確實有輸出');
    assert(/[\u4e00-\u9fff]/.test(stderrText), '[C5-3] stderr degraded 說明含中文（人可讀繁中說明，非原始物件轉字串）');
    assert(stderrText.includes('unknown') || stderrText.includes('harness'),
      '[C5-4] stderr 說明點出「判不出 harness」這個具體原因（可追溯到 normalize() 的 degraded.reason）');
  }
} finally {
  rmSync(SANDBOX, { recursive: true, force: true });
}

const total = passed + failed.length;
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
console.log(`(共 ${total} 條斷言：C1=Claude deny／C2=Claude allow／C3=apply_patch 多檔 deny／C4=apply_patch 多檔 allow／C5=結構殘缺 degraded+fail-open)`);
process.exit(failed.length > 0 ? 1 : 0);
