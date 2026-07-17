#!/usr/bin/env node
// test-gen-reviewers.mjs —— gen-reviewers.mjs 的紅綠斷言。
// 自帶極簡 harness（仿同家族 test-*.mjs：assert 累加器，不引測試框架）。
// 用法（cwd = plugins/loops-workflow）：node scripts/test-gen-reviewers.mjs
// 全綠 → exit 0；任一斷言失敗 → exit 1。
//
// 兩層：
//   1) 純函式單元：parseSharedBlocks / substitute / overrideFrontmatter / buildDeepNote /
//      assembleDeep / firstDiff。
//   2) round-trip golden：以真實真相源（reviewer-shared.md + reviewers/*.md）組出 21 檔，
//      逐檔 EOL 正規化後 == agents/ 現況——與 CI 的 `--check` 同一 oracle，防 assemble 迴歸。

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseSharedBlocks,
  substitute,
  overrideFrontmatter,
  buildDeepNote,
  assembleDeep,
  assembleAll,
  firstDiff,
  DEEP,
} from './gen-reviewers.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = dirname(SCRIPTS_DIR);
const AGENTS_DIR = join(PLUGIN_DIR, 'agents');
const SHARED_FILE = join(PLUGIN_DIR, 'references', 'reviewer-shared.md');
const TEMPLATES_DIR = join(PLUGIN_DIR, 'references', 'reviewers');

let passed = 0;
const failed = [];
function assert(cond, msg) {
  if (cond) passed += 1;
  else { failed.push(msg); console.error('✗ ' + msg); }
}
const lf = s => s.replace(/\r\n/g, '\n');

// ── 1) 純函式單元 ────────────────────────────────────────────────────────────

// parseSharedBlocks
{
  const blocks = parseSharedBlocks('前言\n<!-- BEGIN:FOO -->\nline1\nline2\n<!-- END:FOO -->\n\n<!-- BEGIN:BAR -->\nx\n<!-- END:BAR -->\n');
  assert(blocks.FOO === 'line1\nline2', 'parseSharedBlocks：多行塊逐字擷取');
  assert(blocks.BAR === 'x', 'parseSharedBlocks：第二塊');
  assert(Object.keys(blocks).length === 2, 'parseSharedBlocks：只兩塊');
}

// substitute
{
  const b = { A: 'aaa', B: 'bbb' };
  assert(substitute('x {{A}} y {{B}} z', b) === 'x aaa y bbb z', 'substitute：多 slot 代換');
  assert(substitute('{{A}} {{A}}', b) === 'aaa aaa', 'substitute：同 slot 多次');
  assert(substitute('{{UNKNOWN}}', b) === '{{UNKNOWN}}', 'substitute：未知 slot 留原樣');
}

// overrideFrontmatter
{
  const tmpl = '---\nname: base\ndescription: 舊述\ntools: {{TOOLS_STANDARD}}\nmodel: sonnet\neffort: medium\n---\n\n身分行\n';
  const out = overrideFrontmatter(tmpl, 'base-deep', { description: '新述' });
  assert(/^name: base-deep$/m.test(out), 'overrideFrontmatter：name 換 deep');
  assert(/^description: 新述$/m.test(out), 'overrideFrontmatter：description 換');
  assert(/^model: opus$/m.test(out), 'overrideFrontmatter：model→opus');
  assert(/^effort: high$/m.test(out), 'overrideFrontmatter：effort→high');
  assert(out.includes('tools: {{TOOLS_STANDARD}}'), 'overrideFrontmatter：tools slot 不動');
  assert(out.includes('身分行'), 'overrideFrontmatter：body 不動');
}

// buildDeepNote
{
  const t = '> `{{DEEP_BASE}}.md`（{{DEEP_NOTEKIND}}）改{{DEEP_BEHAVIOR}}（{{DEEP_DEPTH}}）。';
  const out = buildDeepNote(t, { base: 'x-reviewer', noteKind: '審查內容', behavior: '審查行為', depth: '更深' });
  assert(out === '> `x-reviewer.md`（審查內容）改審查行為（更深）。', 'buildDeepNote：四佔位全代換');
}

// assembleDeep：deep-note 注入在 frontmatter 之後、身分行之前
{
  const baseTmpl = '---\nname: b\ndescription: d\ntools: {{TOOLS_STANDARD}}\nmodel: sonnet\neffort: medium\n---\n\n你是身分行。\n\n## 審查範圍\n{{CODE_RETRIEVAL}}\n';
  const blocks = { TOOLS_STANDARD: 'TOOLS', CODE_RETRIEVAL: 'CR', DEEP_NOTE: '> deep-note {{DEEP_BASE}}' };
  const cfg = { base: 'b', description: 'dd', noteKind: '審查內容', behavior: '審查行為', depth: '更深' };
  const out = assembleDeep('b-deep', cfg, baseTmpl, blocks);
  assert(out.includes('---\n\n> deep-note b\n\n你是身分行。'), 'assembleDeep：deep-note 注在 frontmatter 後、身分行前');
  assert(out.includes('name: b-deep') && out.includes('model: opus'), 'assembleDeep：frontmatter override 生效');
  assert(out.includes('tools: TOOLS') && out.includes('## 審查範圍\nCR'), 'assembleDeep：body slot 代換');
}

// firstDiff
{
  const blocks = { FOO: 'shared-line\nother' };
  const d1 = firstDiff('a\nshared-line\nc', 'a\nHAND-EDIT\nc', blocks);
  assert(d1 && d1.line === 2 && d1.block === 'FOO', 'firstDiff：定位差異行 + 指出漂在哪塊');
  assert(firstDiff('a\nb', 'a\nb', blocks) === null, 'firstDiff：全同回 null');
  const d2 = firstDiff('a\nunique-body', 'a\nchanged', blocks);
  assert(d2 && d2.block === null, 'firstDiff：獨有內容區 block 為 null');
  assert(firstDiff('a\r\nb', 'a\nb', blocks) === null, 'firstDiff：EOL 差異不算漂移（正規化）');
}

// DEEP 設定完整性
{
  assert(Object.keys(DEEP).length === 4, 'DEEP：恰 4 個 deep');
  for (const [name, cfg] of Object.entries(DEEP)) {
    assert(cfg.base && cfg.noteKind && cfg.behavior && cfg.depth && cfg.description,
      `DEEP：${name} 欄位齊全`);
    assert(!/`/.test(cfg.description + cfg.depth + cfg.noteKind + cfg.behavior),
      `DEEP：${name} 值無 backtick（可安全內嵌）`);
  }
}

// ── 2) round-trip golden：真相源組裝 == agents/ 現況（EOL 正規化）────────────────
{
  const blocks = parseSharedBlocks(lf(readFileSync(SHARED_FILE, 'utf8')));
  const templates = {};
  for (const f of readdirSync(TEMPLATES_DIR)) {
    if (f.endsWith('.md')) templates[f.slice(0, -3)] = lf(readFileSync(join(TEMPLATES_DIR, f), 'utf8'));
  }
  const assembled = assembleAll({ blocks, templates });
  const names = Object.keys(assembled);
  assert(names.length === 21, `round-trip：組出 21 檔（實際 ${names.length}）`);
  let ok = 0;
  for (const name of names) {
    const disk = lf(readFileSync(join(AGENTS_DIR, name + '.md'), 'utf8'));
    const gen = assembled[name].endsWith('\n') ? assembled[name] : assembled[name] + '\n';
    if (disk === gen) ok += 1;
    else {
      const d = firstDiff(gen, disk, blocks);
      assert(false, `round-trip：${name} 與 agents/ 現況不符（第 ${d?.line} 行，塊 ${d?.block ?? '獨有'}）`);
    }
  }
  assert(ok === 21, `round-trip：21 檔全部 byte-identical（實際 ${ok}）`);
}

console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
process.exit(failed.length > 0 ? 1 : 0);
