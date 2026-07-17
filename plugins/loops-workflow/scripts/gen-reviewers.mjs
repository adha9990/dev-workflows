#!/usr/bin/env node
// gen-reviewers.mjs —— reviewer/validator agent 檔生成器：由單一真相源重生 21 個
// reviewer/validator agent 檔，消除四塊逐字樣板的手抄漂移（tools 清單 / code-retrieval 指引句 /
// `## 輸出` 骨架 / Metric-Honesty 收尾）。
//
// 真相源：
//   1) references/reviewer-shared.md —— 共用塊字典（`<!-- BEGIN:key -->`/`<!-- END:key -->` 逐字框定）。
//   2) references/reviewers/<name>.md —— 17 個 base 模板（frontmatter + 身分行 + 每檔獨有審查軸，
//      共用塊處填 `{{SLOT}}` token）。
//   4 個 deep 檔（architecture/code-quality/security/finding-validator 的 -deep）**不存 base 模板**，
//   由對應 base 模板 + frontmatter override（name/description/model:opus/effort:high）+ deep-note 注入衍生
//   —— 導入後 deep 對 base 的漂移結構性歸零。
//
// 用法：
//   node gen-reviewers.mjs --write   重生 21 檔落 agents/（輸出純 LF、恰一個結尾換行）。
//   node gen-reviewers.mjs --check   在記憶體重生、與磁碟現況比對（EOL 正規化）；有漂移印出
//                                    「哪個檔、漂在哪塊」並以 exit 1 退出（供 CI drift-check）。
//
// EOL：現行 agent 檔在 Windows checkout 是 CRLF、Linux 是 LF（autocrlf）。生成器一律吐 LF；
//   `--check` 比對前兩邊 `\r\n`→`\n` 正規化，故 Windows/CI 皆為可靠 oracle（git diff 會被
//   autocrlf 正規化成假綠，不可當收斂帳本）。搭配 `.gitattributes` 對這些檔標 `text eol=lf`。
//
// 分層（仿家族 skill-lint.mjs / loops-quality-gate.mjs）：
//   1) 純函式（無 IO，測試直接 import）：parseSharedBlocks / substitute / overrideFrontmatter /
//      buildDeepNote / assembleBase / assembleDeep / firstDiff。
//   2) IO 薄邊界：loadSources / main（讀真相源、--write/--check）——被 import 時不執行。
// 依賴：僅 node 內建（fs / path / url）。

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = dirname(SCRIPTS_DIR);
const AGENTS_DIR = join(PLUGIN_DIR, 'agents');
const SHARED_FILE = join(PLUGIN_DIR, 'references', 'reviewer-shared.md');
const TEMPLATES_DIR = join(PLUGIN_DIR, 'references', 'reviewers');

// 4 個 deep 檔的衍生設定（值皆無 backtick，可安全內嵌）。
export const DEEP = {
  'architecture-reviewer-deep': {
    base: 'architecture-reviewer',
    description: 'architecture-reviewer 的高風險深審變體（opus·high）：verify 判高風險時改派此版做更徹底的分層 / 契約 / 依賴深審。審查軸 / 範圍 / 輸出格式 / 反偏見紀律同 architecture-reviewer。',
    noteKind: '審查內容', behavior: '審查行為', depth: '更深分層 / 契約 / 依賴推敲',
  },
  'code-quality-reviewer-deep': {
    base: 'code-quality-reviewer',
    description: 'code-quality-reviewer 的高風險深審變體（opus·high）：verify 判高風險時改派此版做更徹底的正確性 / 狀態流 / 錯誤處理深審。審查軸 / 範圍 / 輸出格式 / 反偏見紀律同 code-quality-reviewer。',
    noteKind: '審查內容', behavior: '審查行為', depth: '更深的正確性與狀態流推敲',
  },
  'security-reviewer-deep': {
    base: 'security-reviewer',
    description: 'security-reviewer 的高風險深審變體（opus·high）：verify 判高風險時改派此版做更徹底的威脅建模。審查軸 / 範圍 / 輸出格式 / 反偏見紀律同 security-reviewer。',
    noteKind: '審查內容', behavior: '審查行為', depth: '更深威脅建模',
  },
  'finding-validator-deep': {
    base: 'finding-validator',
    description: 'finding-validator 的高風險深審變體（opus·high）：verify 判高風險時改派此版對候選 finding 做更嚴格的二輪確認。四問 / 判定 / 鐵律 / 反偏見紀律同 finding-validator。',
    noteKind: '二輪確認內容', behavior: '判定行為', depth: '更嚴格的二輪確認',
  },
};

// ── A) 純函式層 ─────────────────────────────────────────────────────────────

/** 解析 reviewer-shared.md 的 `<!-- BEGIN:key -->…<!-- END:key -->` 塊 → { key: 逐字內容 }。 */
export function parseSharedBlocks(sharedText) {
  const blocks = {};
  const re = /<!-- BEGIN:([A-Z_]+) -->\n([\s\S]*?)\n<!-- END:\1 -->/g;
  let m;
  while ((m = re.exec(sharedText)) !== null) blocks[m[1]] = m[2];
  return blocks;
}

/** 把模板的 `{{SLOT}}` 換成共用塊內容。未知 slot 留原樣（--check 會抓到不符）。 */
export function substitute(template, blocks) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(blocks, key) ? blocks[key] : whole,
  );
}

/** 依 DEEP 設定改寫 base 模板的 frontmatter（name/description/model/effort）。 */
export function overrideFrontmatter(template, deepName, cfg) {
  return template
    .replace(/^name: .+$/m, `name: ${deepName}`)
    .replace(/^description: .+$/m, `description: ${cfg.description}`)
    .replace(/^model: .+$/m, 'model: opus')
    .replace(/^effort: .+$/m, 'effort: high');
}

/** 由 DEEP_NOTE 模板 + cfg 組出該 deep 的 blockquote 提示行。 */
export function buildDeepNote(deepNoteTemplate, cfg) {
  return deepNoteTemplate
    .replace('{{DEEP_BASE}}', cfg.base)
    .replace('{{DEEP_NOTEKIND}}', cfg.noteKind)
    .replace('{{DEEP_BEHAVIOR}}', cfg.behavior)
    .replace('{{DEEP_DEPTH}}', cfg.depth);
}

/** 組出一個 base 檔內容：模板 slot 代換。 */
export function assembleBase(template, blocks) {
  return substitute(template, blocks);
}

/**
 * 組出一個 deep 檔內容：取 base 模板 → override frontmatter → 於 frontmatter 後注入 deep-note →
 * slot 代換。deep-note 插在「frontmatter 結束 `---\n\n`」之後、身分行之前。
 */
export function assembleDeep(deepName, cfg, baseTemplate, blocks) {
  const note = buildDeepNote(blocks.DEEP_NOTE, cfg);
  const overridden = overrideFrontmatter(baseTemplate, deepName, cfg);
  const injected = overridden.replace(/^(---\n[\s\S]*?\n---\n\n)/, `$1${note}\n\n`);
  return substitute(injected, blocks);
}

const normalizeEol = s => s.replace(/\r\n/g, '\n');

/**
 * 找出 expected vs actual 首個差異行，回 { line, expected, actual, block }。無差異回 null。
 * block：若差異行落在某共用塊的展開內容中，回該塊 key，滿足「漂在哪塊」。
 */
export function firstDiff(expected, actual, blocks) {
  const e = normalizeEol(expected).split('\n');
  const a = normalizeEol(actual).split('\n');
  const n = Math.max(e.length, a.length);
  for (let i = 0; i < n; i += 1) {
    if (e[i] !== a[i]) {
      let block = null;
      for (const [k, v] of Object.entries(blocks || {})) {
        if (typeof v === 'string' && v.split('\n').includes(e[i] ?? '')) { block = k; break; }
      }
      return { line: i + 1, expected: e[i] ?? '(無此行)', actual: a[i] ?? '(無此行)', block };
    }
  }
  return null;
}

// ── B) IO 薄邊界 ─────────────────────────────────────────────────────────────

function loadSources() {
  const blocks = parseSharedBlocks(readFileSync(SHARED_FILE, 'utf8').replace(/\r\n/g, '\n'));
  const templates = {};
  for (const f of readdirSync(TEMPLATES_DIR)) {
    if (f.endsWith('.md')) templates[f.slice(0, -3)] = readFileSync(join(TEMPLATES_DIR, f), 'utf8').replace(/\r\n/g, '\n');
  }
  return { blocks, templates };
}

/** 組出全部 21 檔內容 → { name: content(LF, 一個結尾換行) }。 */
export function assembleAll({ blocks, templates }) {
  const out = {};
  for (const [name, tmpl] of Object.entries(templates)) out[name] = assembleBase(tmpl, blocks);
  for (const [deepName, cfg] of Object.entries(DEEP)) {
    out[deepName] = assembleDeep(deepName, cfg, templates[cfg.base], blocks);
  }
  return out;
}

function ensureTrailingLf(s) {
  return s.endsWith('\n') ? s : s + '\n';
}

function main() {
  const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--write') ? 'write' : null;
  if (!mode) {
    console.error('用法：node gen-reviewers.mjs --write | --check');
    process.exit(2);
  }
  const sources = loadSources();
  const assembled = assembleAll(sources);
  const names = Object.keys(assembled).sort();

  if (mode === 'write') {
    for (const name of names) writeFileSync(join(AGENTS_DIR, name + '.md'), ensureTrailingLf(assembled[name]));
    console.log(`gen-reviewers：重生 ${names.length} 檔（LF）→ agents/`);
    return;
  }

  // --check：EOL 正規化後逐 byte 比對；有漂移印「哪檔、漂在哪塊」並 exit 1。
  const drifted = [];
  for (const name of names) {
    let disk;
    try { disk = readFileSync(join(AGENTS_DIR, name + '.md'), 'utf8'); }
    catch { drifted.push({ name, reason: 'agents/ 缺此檔（真相源有、磁碟無）' }); continue; }
    const expected = ensureTrailingLf(assembled[name]);
    if (normalizeEol(disk) !== normalizeEol(expected)) {
      const d = firstDiff(expected, disk, sources.blocks);
      drifted.push({ name, diff: d });
    }
  }
  if (drifted.length === 0) {
    console.log(`gen-reviewers --check：${names.length} 檔全部與真相源一致，無漂移。`);
    return;
  }
  console.error(`gen-reviewers --check：偵測到 ${drifted.length} 個漂移檔（手改了 agents/ 而非改真相源）：`);
  for (const d of drifted) {
    if (d.reason) { console.error(`  ✗ ${d.name}.md —— ${d.reason}`); continue; }
    const where = d.diff.block ? `共用塊 [${d.diff.block}]` : '每檔獨有內容區';
    console.error(`  ✗ ${d.name}.md：第 ${d.diff.line} 行起漂移（落在 ${where}）`);
    console.error(`      真相源應為: ${JSON.stringify(d.diff.expected)}`);
    console.error(`      磁碟現況為: ${JSON.stringify(d.diff.actual)}`);
  }
  console.error('修法：改真相源（references/reviewer-shared.md 或 references/reviewers/<name>.md）後跑 `node scripts/gen-reviewers.mjs --write`；勿手改 agents/*.md。');
  process.exit(1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
