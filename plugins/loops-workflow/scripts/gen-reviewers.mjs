#!/usr/bin/env node
// gen-reviewers.mjs —— reviewer/validator agent 檔生成器：由單一真相源重生 21 個
// reviewer/validator agent 檔，消除四塊逐字樣板的手抄漂移（tools 清單 / code-retrieval 指引句 /
// `## 輸出` 骨架 / Metric-Honesty 收尾）。
//
// 真相源：
//   1) references/personas/reviewer-shared.md —— 共用塊字典（`<!-- BEGIN:key -->`/`<!-- END:key -->` 逐字框定）。
//   2) references/personas/<agent 名>.md —— 17 個 base 模板（frontmatter + 身分行 + 每檔獨有審查軸，
//      共用塊處填 `{{SLOT}}` token）。**不含 model:/effort:**——這兩行完全由 (3) 注入，模板本身
//      沒有可漂移的字面留在磁碟上。
//   3) references/capability-registry.json —— model/effort 真相源：`agent_tiers[name]` 查 tier，
//      `model_tier[tier].claude.model` 查 model；`agent_effort[name]` 直查 effort。
//   4 個 deep 檔（architecture/code-quality/security/finding-validator 的 -deep）**不存 base 模板**，
//   由對應 base 模板 + frontmatter override（name/description）+ registry 查得的 model/effort（皆為
//   referee tier → opus·high）+ deep-note 注入衍生 —— 導入後 deep 對 base 的漂移結構性歸零。
//
// 用法：
//   node gen-reviewers.mjs --write   重生 21 檔落 agents/ ＋ references/model-effort-policy.md 的
//                                    分層表區塊（輸出純 LF、恰一個結尾換行）。
//   node gen-reviewers.mjs --check   在記憶體重生、與磁碟現況比對（EOL 正規化）；有漂移印出
//                                    「哪個檔、漂在哪塊」並以 exit 1 退出（供 CI drift-check）。
//
// model-effort-policy.md 的 25 列分層表（T20）：真相源同上（3），由 `<!-- BEGIN:generated-tier-table -->`/
// `<!-- END:generated-tier-table -->` marker 框定；marker 外的敘述文字維持人工維護、生成器不動。
// tier 欄位直接印 registry 的 tier id（referee/broad-review/implementation/fast-readonly），
// 不再維護額外的人工分類文字，消除該欄位另一條漂移源。
//
// EOL：現行 agent 檔在 Windows checkout 是 CRLF、Linux 是 LF（autocrlf）。生成器一律吐 LF；
//   `--check` 比對前兩邊 `\r\n`→`\n` 正規化，故 Windows/CI 皆為可靠 oracle（git diff 會被
//   autocrlf 正規化成假綠，不可當收斂帳本）。搭配 `.gitattributes` 對這些檔標 `text eol=lf`。
//
// 分層（仿家族 skill-lint.mjs / loops-quality-gate.mjs）：
//   1) 純函式（無 IO，測試直接 import）：parseSharedBlocks / substitute / overrideFrontmatter /
//      resolveModelEffort / injectModelEffort / buildDeepNote / assembleBase / assembleDeep / firstDiff。
//   2) IO 薄邊界：loadSources / main（讀真相源、--write/--check）——被 import 時不執行。
// 依賴：僅 node 內建（fs / path / url）。

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = dirname(SCRIPTS_DIR);
const REPO_ROOT = dirname(dirname(PLUGIN_DIR));
const PERSONAS_DIR = join(PLUGIN_DIR, 'references', 'personas');
const SHARED_FILE = join(PERSONAS_DIR, 'reviewer-shared.md');
const TEMPLATES_DIR = PERSONAS_DIR;
const REGISTRY_FILE = join(PLUGIN_DIR, 'references', 'capability-registry.json');
const POLICY_FILE = join(PLUGIN_DIR, 'references', 'shared', 'runtime', 'model-effort-policy.md');
// agent 落點：agents/ 已依角色分巢狀子目錄，輸出路徑不再是「agents/<name>.md」這個可推算的形狀，
// 一律查 component-registry.json 的 target_path（#171 定的單一真相源），生成器不自行推目錄。
const COMPONENT_REGISTRY_FILE = join(PLUGIN_DIR, 'references', 'component-registry.json');
// base 模板與手寫 persona 散文同層（references/personas/）；模板檔名恰好等於它生成的 agent 名
// （<*>-reviewer.md 或 finding-validator.md），據此框出真相源，避免把散文誤當模板生成一支 agent。
const TEMPLATE_FILE_RE = /^([\w-]+-reviewer|finding-validator)\.md$/;

const POLICY_TABLE_BEGIN = '<!-- BEGIN:generated-tier-table -->';
const POLICY_TABLE_END = '<!-- END:generated-tier-table -->';

// 4 個 deep 檔的衍生設定（值皆無 backtick，可安全內嵌）。model/effort 不在此設——
// 一律由 capability-registry.json 查（見 resolveModelEffort），這裡的 description 字面提到
// 「opus·high」純屬人讀敘述，不是生成器讀取的資料源。
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

/** 依 DEEP 設定改寫 base 模板的 frontmatter（name/description）。model/effort 不在此改——
 * 模板已不含這兩行，一律由 injectModelEffort 依 registry 查得的值注入。 */
export function overrideFrontmatter(template, deepName, cfg) {
  return template
    .replace(/^name: .+$/m, `name: ${deepName}`)
    .replace(/^description: .+$/m, `description: ${cfg.description}`);
}

/**
 * 由 capability-registry.json 查某 agent 的 model/effort：
 * `agent_tiers[name]` → tier id → `model_tier[tier].claude.model`；`agent_effort[name]` 直查 effort。
 * 任一環節缺失即丟錯（不靜默回退），讓漂移在生成當下就爆炸，而不是吐出壞檔。
 */
export function resolveModelEffort(registry, name) {
  const tier = registry?.agent_tiers?.[name];
  if (!tier) throw new Error(`resolveModelEffort：registry.agent_tiers 缺 "${name}"`);
  const model = registry?.model_tier?.[tier]?.claude?.model;
  if (!model) throw new Error(`resolveModelEffort：registry.model_tier["${tier}"].claude.model 缺失（agent "${name}"）`);
  const effort = registry?.agent_effort?.[name];
  if (!effort) throw new Error(`resolveModelEffort：registry.agent_effort 缺 "${name}"`);
  return { model, effort };
}

/**
 * 於 frontmatter（開頭 `---\n...\n---\n` 區塊）尾端注入 `model:`/`effort:` 兩行。
 * 模板本身不帶這兩行（見檔頭真相源說明）——值一律來自 registry，此函式是唯一寫入點。
 */
export function injectModelEffort(template, model, effort) {
  const m = template.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error('injectModelEffort：找不到 frontmatter 區塊（缺開頭 ---\\n...\\n---\\n）');
  const front = m[1];
  const rebuilt = `---\n${front}\nmodel: ${model}\neffort: ${effort}\n---\n`;
  return template.slice(0, m.index) + rebuilt + template.slice(m.index + m[0].length);
}

/** 由 DEEP_NOTE 模板 + cfg 組出該 deep 的 blockquote 提示行。 */
export function buildDeepNote(deepNoteTemplate, cfg) {
  return deepNoteTemplate
    .replace('{{DEEP_BASE}}', cfg.base)
    .replace('{{DEEP_NOTEKIND}}', cfg.noteKind)
    .replace('{{DEEP_BEHAVIOR}}', cfg.behavior)
    .replace('{{DEEP_DEPTH}}', cfg.depth);
}

/** 組出一個 base 檔內容：注入 registry 查得的 model/effort → 模板 slot 代換。 */
export function assembleBase(template, blocks, model, effort) {
  return substitute(injectModelEffort(template, model, effort), blocks);
}

/**
 * 組出一個 deep 檔內容：取 base 模板 → override frontmatter（name/description）→ 注入 registry
 * 查得的 model/effort → 於 frontmatter 後注入 deep-note → slot 代換。
 * deep-note 插在「frontmatter 結束 `---\n\n`」之後、身分行之前。
 */
export function assembleDeep(deepName, cfg, baseTemplate, blocks, model, effort) {
  const note = buildDeepNote(blocks.DEEP_NOTE, cfg);
  const overridden = overrideFrontmatter(baseTemplate, deepName, cfg);
  const withModelEffort = injectModelEffort(overridden, model, effort);
  const injected = withModelEffort.replace(/^(---\n[\s\S]*?\n---\n\n)/, `$1${note}\n\n`);
  return substitute(injected, blocks);
}

/**
 * 由 registry 的 agent_tiers / model_tier / agent_effort 組出 model-effort-policy.md 的 25 列表格
 * （含表頭）。列序沿用 agent_tiers 的鍵序（registry 為唯一真相源，不另維護人工排序 / 分類文字）。
 * tier 欄位直接印 tier id（referee/broad-review/implementation/fast-readonly），
 * 不再另維護一份人讀分類（如「6 核心 reviewer」）——那份文字無資料源可對帳，是漂移源本身。
 */
export function buildTierTable(registry) {
  const header = ['| agent | model | effort | tier |', '|---|---|---|---|'];
  const rows = Object.keys(registry?.agent_tiers ?? {}).map((name) => {
    const { model, effort } = resolveModelEffort(registry, name);
    const tier = registry.agent_tiers[name];
    return `| \`${name}\` | \`${model}\` | \`${effort}\` | \`${tier}\` |`;
  });
  return [...header, ...rows].join('\n');
}

/**
 * 表格外包上 marker + 生成標示註解，得到可直接嵌回 model-effort-policy.md 的完整區塊。
 * 表格本身（model 欄含 vendor model 字面如 `opus`/`sonnet`）額外包一層
 * `<!-- adapter-projection -->`……`<!-- /adapter-projection -->`——這是 registry 投影出的合法內容，
 * 而非本檔手寫的平台耦合散文，讓 compat-lint 的 vendor-model-id 檢查認得此區塊屬豁免①。
 */
export function buildPolicyBlock(registry) {
  return [
    POLICY_TABLE_BEGIN,
    '<!-- 本區塊由 `gen-reviewers.mjs` 從 `capability-registry.json` 生成，請勿手改；要改請改 registry 再跑 `--write`。 -->',
    '',
    '<!-- adapter-projection -->',
    buildTierTable(registry),
    '<!-- /adapter-projection -->',
    POLICY_TABLE_END,
  ].join('\n');
}

/** 把 policyText 中 marker 框住的舊區塊換成 newBlock（含 marker 本身）；marker 外文字不動。 */
export function applyPolicyBlock(policyText, newBlock) {
  const start = policyText.indexOf(POLICY_TABLE_BEGIN);
  const end = policyText.indexOf(POLICY_TABLE_END);
  if (start === -1 || end === -1) {
    throw new Error(`applyPolicyBlock：找不到 marker 區塊（${POLICY_TABLE_BEGIN} / ${POLICY_TABLE_END}）`);
  }
  return policyText.slice(0, start) + newBlock + policyText.slice(end + POLICY_TABLE_END.length);
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

/**
 * agent 名 → 該 agent 檔的絕對輸出路徑（查 component-registry 的 target_path）。
 * registry 沒登記某支生成 agent → 丟例外並指名：靜默退回 agents/<name>.md 會在巢狀樹裡憑空
 * 生出第二份平鋪檔（雙路徑），正是本次重整要消滅的東西。
 */
function agentPathsByName() {
  const registry = JSON.parse(readFileSync(COMPONENT_REGISTRY_FILE, 'utf8'));
  const out = {};
  for (const c of registry.components ?? []) {
    if (c.kind !== 'agent' || typeof c.target_path !== 'string') continue;
    out[c.target_path.slice(c.target_path.lastIndexOf('/') + 1, -3)] = join(REPO_ROOT, ...c.target_path.split('/'));
  }
  return out;
}

function agentFileOf(agentPaths, name) {
  const file = agentPaths[name];
  if (!file) throw new Error(`gen-reviewers：component-registry.json 沒有登記 agent「${name}」的 target_path，無從決定輸出落點`);
  return file;
}

function loadSources() {
  const blocks = parseSharedBlocks(readFileSync(SHARED_FILE, 'utf8').replace(/\r\n/g, '\n'));
  const templates = {};
  for (const f of readdirSync(TEMPLATES_DIR)) {
    if (TEMPLATE_FILE_RE.test(f)) templates[f.slice(0, -3)] = readFileSync(join(TEMPLATES_DIR, f), 'utf8').replace(/\r\n/g, '\n');
  }
  const registry = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
  const policyText = readFileSync(POLICY_FILE, 'utf8');
  return { blocks, templates, registry, policyText };
}

/** 組出全部 21 檔內容 → { name: content(LF, 一個結尾換行) }。model/effort 皆查 registry。 */
export function assembleAll({ blocks, templates, registry }) {
  const out = {};
  for (const [name, tmpl] of Object.entries(templates)) {
    const { model, effort } = resolveModelEffort(registry, name);
    out[name] = assembleBase(tmpl, blocks, model, effort);
  }
  for (const [deepName, cfg] of Object.entries(DEEP)) {
    const { model, effort } = resolveModelEffort(registry, deepName);
    out[deepName] = assembleDeep(deepName, cfg, templates[cfg.base], blocks, model, effort);
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
  const agentPaths = agentPathsByName();
  const expectedPolicyText = applyPolicyBlock(sources.policyText, buildPolicyBlock(sources.registry));

  if (mode === 'write') {
    for (const name of names) writeFileSync(agentFileOf(agentPaths, name), ensureTrailingLf(assembled[name]));
    if (normalizeEol(sources.policyText) !== normalizeEol(expectedPolicyText)) {
      writeFileSync(POLICY_FILE, expectedPolicyText);
    }
    console.log(`gen-reviewers：重生 ${names.length} 檔（LF）→ agents/ ＋ model-effort-policy.md 分層表區塊`);
    return;
  }

  // --check：EOL 正規化後逐 byte 比對；有漂移印「哪檔、漂在哪塊」並 exit 1。
  const drifted = [];
  for (const name of names) {
    let disk;
    const file = agentFileOf(agentPaths, name);
    try { disk = readFileSync(file, 'utf8'); }
    catch { drifted.push({ name, reason: 'agents/ 缺此檔（真相源有、磁碟無）' }); continue; }
    const expected = ensureTrailingLf(assembled[name]);
    if (normalizeEol(disk) !== normalizeEol(expected)) {
      const d = firstDiff(expected, disk, sources.blocks);
      drifted.push({ name, diff: d });
    }
  }
  const policyDrifted = normalizeEol(sources.policyText) !== normalizeEol(expectedPolicyText);
  if (drifted.length === 0 && !policyDrifted) {
    console.log(`gen-reviewers --check：${names.length} 檔 + model-effort-policy.md 分層表區塊全部與真相源一致，無漂移。`);
    return;
  }
  console.error(`gen-reviewers --check：偵測到 ${drifted.length + (policyDrifted ? 1 : 0)} 個漂移檔（手改了生成產物而非改真相源）：`);
  for (const d of drifted) {
    if (d.reason) { console.error(`  ✗ ${d.name}.md —— ${d.reason}`); continue; }
    const where = d.diff.block ? `共用塊 [${d.diff.block}]` : '每檔獨有內容區';
    console.error(`  ✗ ${d.name}.md：第 ${d.diff.line} 行起漂移（落在 ${where}）`);
    console.error(`      真相源應為: ${JSON.stringify(d.diff.expected)}`);
    console.error(`      磁碟現況為: ${JSON.stringify(d.diff.actual)}`);
  }
  if (policyDrifted) {
    const d = firstDiff(expectedPolicyText, sources.policyText, {});
    console.error(`  ✗ model-effort-policy.md：第 ${d?.line ?? '?'} 行起漂移（落在 generated-tier-table 區塊）`);
    console.error(`      真相源應為: ${JSON.stringify(d?.expected)}`);
    console.error(`      磁碟現況為: ${JSON.stringify(d?.actual)}`);
  }
  console.error('修法：改真相源（references/personas/reviewer-shared.md、references/personas/<agent 名>.md 或 references/capability-registry.json）後跑 `node scripts/gen-reviewers.mjs --write`；勿手改 agents/*.md 或 model-effort-policy.md 的 generated-tier-table 區塊。');
  process.exit(1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
