#!/usr/bin/env node
// test-gen-reviewers.mjs —— gen-reviewers.mjs 的紅綠斷言。
// 自帶極簡 harness（仿同家族 test-*.mjs：assert 累加器，不引測試框架）。
// 用法（cwd = plugins/loops-workflow）：node scripts/test-gen-reviewers.mjs
// 全綠 → exit 0；任一斷言失敗 → exit 1。
//
// 兩層：
//   1) 純函式單元：parseSharedBlocks / substitute / overrideFrontmatter / resolveModelEffort /
//      injectModelEffort / buildDeepNote / assembleDeep / firstDiff。
//   2) round-trip golden：以真實真相源（reviewer-shared.md + reviewers/*.md + capability-registry.json）
//      組出 21 檔，逐檔 EOL 正規化後 == agents/ 現況——與 CI 的 `--check` 同一 oracle，防 assemble 迴歸。

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseSharedBlocks,
  substitute,
  overrideFrontmatter,
  resolveModelEffort,
  injectModelEffort,
  buildDeepNote,
  assembleDeep,
  assembleAll,
  firstDiff,
  DEEP,
  TEMPLATE_FILE_RE,
} from './gen-reviewers.mjs';
import { resolveComponent } from './component-resolver.mjs'; // 重用：agent id → 巢狀落點，不在測試裡另推目錄

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = dirname(SCRIPTS_DIR);
// base 模板與 reviewer-shared.md 同住 references/personas/；模板以生成器的 TEMPLATE_FILE_RE 框出，
// 不用「.md 全收」——同層還有手寫 persona 散文，全收會把散文當模板。
const PERSONAS_DIR = join(PLUGIN_DIR, 'references', 'personas');
const SHARED_FILE = join(PERSONAS_DIR, 'reviewer-shared.md');
const TEMPLATES_DIR = PERSONAS_DIR;
const REGISTRY_FILE = join(PLUGIN_DIR, 'references', 'capability-registry.json');

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

// overrideFrontmatter：只動 name/description，model/effort 已不在模板裡、也不歸此函式管
{
  const tmpl = '---\nname: base\ndescription: 舊述\ntools: {{TOOLS_STANDARD}}\n---\n\n身分行\n';
  const out = overrideFrontmatter(tmpl, 'base-deep', { description: '新述' });
  assert(/^name: base-deep$/m.test(out), 'overrideFrontmatter：name 換 deep');
  assert(/^description: 新述$/m.test(out), 'overrideFrontmatter：description 換');
  assert(!/^model: /m.test(out) && !/^effort: /m.test(out), 'overrideFrontmatter：不注入 model/effort（該職責歸 injectModelEffort）');
  assert(out.includes('tools: {{TOOLS_STANDARD}}'), 'overrideFrontmatter：tools slot 不動');
  assert(out.includes('身分行'), 'overrideFrontmatter：body 不動');
}

// resolveModelEffort：由 registry 查 agent 的 model/effort（tier 間接 + effort 直查）
{
  const registry = {
    model_tier: { 'broad-review': { claude: { model: 'sonnet' } }, referee: { claude: { model: 'opus' } } },
    agent_tiers: { 'x-reviewer': 'broad-review', 'x-reviewer-deep': 'referee' },
    agent_effort: { 'x-reviewer': 'medium', 'x-reviewer-deep': 'high' },
  };
  const base = resolveModelEffort(registry, 'x-reviewer');
  assert(base.model === 'sonnet' && base.effort === 'medium', 'resolveModelEffort：broad-review tier → sonnet·medium');
  const deep = resolveModelEffort(registry, 'x-reviewer-deep');
  assert(deep.model === 'opus' && deep.effort === 'high', 'resolveModelEffort：referee tier → opus·high');
  let threw = false;
  try { resolveModelEffort(registry, 'unknown-agent'); } catch { threw = true; }
  assert(threw, 'resolveModelEffort：registry 缺該 agent 鍵 → 丟錯而非靜默回退');
}

// injectModelEffort：於 frontmatter 尾端插入 model/effort 兩行，body 與其餘 frontmatter 不動
{
  const tmpl = '---\nname: x\ndescription: d\ntools: {{TOOLS_STANDARD}}\n---\n\n身分行\n\n---\n分隔線不是 frontmatter\n';
  const out = injectModelEffort(tmpl, 'sonnet', 'medium');
  assert(out.startsWith('---\nname: x\ndescription: d\ntools: {{TOOLS_STANDARD}}\nmodel: sonnet\neffort: medium\n---\n\n身分行'),
    'injectModelEffort：model/effort 插在 frontmatter 尾、tools 之後');
  assert(out.includes('\n\n---\n分隔線不是 frontmatter\n'), 'injectModelEffort：body 內後續的 --- 不受影響（只動開頭 frontmatter 區塊）');
}

// buildDeepNote
{
  const t = '> `{{DEEP_BASE}}.md`（{{DEEP_NOTEKIND}}）改{{DEEP_BEHAVIOR}}（{{DEEP_DEPTH}}）。';
  const out = buildDeepNote(t, { base: 'x-reviewer', noteKind: '審查內容', behavior: '審查行為', depth: '更深' });
  assert(out === '> `x-reviewer.md`（審查內容）改審查行為（更深）。', 'buildDeepNote：四佔位全代換');
}

// assembleDeep：deep-note 注入在 frontmatter 之後、身分行之前；model/effort 由呼叫端傳入（registry 查得）
{
  const baseTmpl = '---\nname: b\ndescription: d\ntools: {{TOOLS_STANDARD}}\n---\n\n你是身分行。\n\n## 審查範圍\n{{CODE_RETRIEVAL}}\n';
  const blocks = { TOOLS_STANDARD: 'TOOLS', CODE_RETRIEVAL: 'CR', DEEP_NOTE: '> deep-note {{DEEP_BASE}}' };
  const cfg = { base: 'b', description: 'dd', noteKind: '審查內容', behavior: '審查行為', depth: '更深' };
  const out = assembleDeep('b-deep', cfg, baseTmpl, blocks, 'opus', 'high');
  assert(out.includes('---\n\n> deep-note b\n\n你是身分行。'), 'assembleDeep：deep-note 注在 frontmatter 後、身分行前');
  assert(out.includes('name: b-deep') && out.includes('model: opus') && out.includes('effort: high'), 'assembleDeep：frontmatter override + model/effort 注入生效');
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
    if (TEMPLATE_FILE_RE.test(f)) templates[f.slice(0, -3)] = lf(readFileSync(join(TEMPLATES_DIR, f), 'utf8'));
  }
  const registry = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
  const assembled = assembleAll({ blocks, templates, registry });
  const names = Object.keys(assembled);
  assert(names.length === 21, `round-trip：組出 21 檔（實際 ${names.length}）`);
  let ok = 0;
  for (const name of names) {
    const disk = lf(readFileSync(resolveComponent(`${name}-agent`), 'utf8'));
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
