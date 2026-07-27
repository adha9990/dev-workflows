#!/usr/bin/env node
// test-artifact-creation-guard.mjs —— Creation Gate 的端到端斷言（#217 增量 3）。
// 用法（cwd = plugins/loops-workflow）：node hooks/test-artifact-creation-guard.mjs
//
// 一律用 spawnSync 真的跑起來、餵真的 payload、看真的 stdout——這道閘的價值全在
// 「在對的時候擋、在對的時候完全不擋」，import 純函式證明不了掛上去會怎樣。
//
// 覆蓋：合格放行／缺 marker 擋／未登記 id 擋／缺必填區塊擋／舊制 loop 不受管／
//       不納管路徑不誤擋／只管整檔寫入／flag 可關。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, 'artifact-creation-guard.mjs');

let passed = 0;
const failed = [];
const assert = (cond, msg) => {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed.push(msg); console.error(`  ✗ ${msg}`); }
};

const TMP = mkdtempSync(join(tmpdir(), 'loops-creation-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失敗不影響結果 */ } });

const SLUG = '217-demo';

function makeRepo(name, { newProtocol = true } = {}) {
  const root = join(TMP, name);
  const loopDir = join(root, '.loops', SLUG);
  mkdirSync(join(loopDir, 'stages'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  if (newProtocol) mkdirSync(join(loopDir, 'telemetry'), { recursive: true });
  return { root, loopDir };
}

function run(filePath, content, { cwd, env = {}, tool = 'Write' } = {}) {
  return spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: tool, tool_input: { file_path: filePath, content }, cwd }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const denied = (res) => {
  try { return JSON.parse(res.stdout)?.hookSpecificOutput?.permissionDecision === 'deny'; }
  catch { return false; }
};

const GOOD_VERIFY = [
  '<!-- loops-artifact: stage-verify@1 -->',
  '# verify', '',
  '## 判定', '', 'Ready', '',
  '## findings', '', '（無）', '',
  '## 逐 behavior 回核', '', 'B1 ✓', '',
].join('\n');

console.log('▸ C-1 合格的受管文件放行');
{
  const { root, loopDir } = makeRepo('c1');
  const res = run(join(loopDir, 'stages', '04-verify.md'), GOOD_VERIFY, { cwd: root });
  assert(res.stdout.trim() === '', '契約齊全 → 不擋');
}

console.log('▸ C-2 缺 marker 擋下');
{
  const { root, loopDir } = makeRepo('c2');
  const res = run(join(loopDir, 'stages', '04-verify.md'), '# verify\n\n## 判定\n\n## findings\n\n## 逐 behavior 回核\n', { cwd: root });
  assert(denied(res), '沒有 artifact marker → deny');
  assert(res.stdout.includes('artifact-registry'), 'deny 訊息指路到 registry');
}

console.log('▸ C-3 缺必填區塊擋下');
{
  const { root, loopDir } = makeRepo('c3');
  const res = run(join(loopDir, 'stages', '04-verify.md'), '<!-- loops-artifact: stage-verify@1 -->\n# verify\n\n## 判定\n\nReady\n', { cwd: root });
  assert(denied(res), '少了 findings／逐 behavior 回核 → deny');
  assert(res.stdout.includes('必填區塊'), 'deny 訊息說明缺什麼');
}

console.log('▸ C-4 未登記的 artifact id 擋下');
{
  const { root } = makeRepo('c4');
  const res = run(join(root, 'docs', 'new-thing.md'), '<!-- loops-artifact: made-up@1 -->\n# x\n', { cwd: root });
  assert(denied(res), '宣稱一個沒登記的 id → deny（新增產物漏補 registry 要當場被發現）');
}

console.log('▸ C-5 人類文件缺 marker 擋下');
{
  const { root } = makeRepo('c5');
  const res = run(join(root, 'docs', 'guide.md'), '# 一份沒有分類的教學\n', { cwd: root });
  assert(denied(res), 'docs/ 下的新文件沒有分類 → deny');
}

console.log('▸ C-6 舊制 loop 完全不受管');
{
  const { root, loopDir } = makeRepo('c6', { newProtocol: false });
  const res = run(join(loopDir, 'stages', '04-verify.md'), '# verify（舊格式，什麼都沒有）\n', { cwd: root });
  assert(res.stdout.trim() === '', '沒有 telemetry/ 的舊 loop：格式不合也不擋（#217 明文保留）');
}

console.log('▸ C-7 不納管的路徑不誤擋');
{
  const { root } = makeRepo('c7');
  const res = run(join(root, 'AGENTS.md'), '# AGENTS\n', { cwd: root });
  assert(res.stdout.trim() === '', 'AGENTS.md 是 agent-facing 契約，不要求 marker');

  const res2 = run(join(root, 'src', 'index.ts'), 'export const x = 1;\n', { cwd: root });
  assert(res2.stdout.trim() === '', '非 .md 一律放行');
}

console.log('▸ C-8 只管整檔寫入');
{
  const { root, loopDir } = makeRepo('c8');
  const res = run(join(loopDir, 'stages', '04-verify.md'), '# 片段', { cwd: root, tool: 'Edit' });
  assert(res.stdout.trim() === '', 'Edit 拿到的是片段，用片段驗必填區塊會誤判 → 不管');
}

console.log('▸ C-9 flag 關掉就完全不作用');
{
  const { root } = makeRepo('c9');
  const res = run(join(root, 'docs', 'guide.md'), '# 沒有分類\n', { cwd: root, env: { LOOPS_ARTIFACT_GATE: '0' } });
  assert(res.stdout.trim() === '', 'LOOPS_ARTIFACT_GATE=0 → 不擋');
}

console.log(`\n${failed.length ? '✗' : '✓'} artifact-creation-guard：${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.error(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
