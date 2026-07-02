#!/usr/bin/env node
// skill-lint.mjs —— 掃 loops-workflow plugin 樹，抓 skill/agent 描述膨脹、審查內容漂移、
// reference 斷鏈/孤兒、文件計數失準、已刪指令殘留五類維護債。
// 分層：
//   1) 解析 / 判定層（純函式，無 IO）：parseDescription / footprintCheck / wordSet / jaccard /
//      stripDeepVariantNote / stripFrontmatter / duplicateCheck / deepSyncCheck /
//      referenceIntegrityCheck / countLintCheck / deadCommandCheck / formatSummary ——
//      給單元測試直接 import。
//   2) IO 薄邊界：walk（掃檔）與 CLI main（組裝、印出、決定 exit code）——
//      main 被 import 時不執行（import.meta.url 守門）。
// 依賴：僅 node 內建（fs / path / url / process），無外部套件。
// 用法：node skill-lint.mjs [--root <dir>] [--json]
// 已知限制：countLintCheck 的計數詞抓取只認半形阿拉伯數字（\d+）；全形數字（如「５１ 份
// reference」）不會被偵測到、也就不會觸發 count-drift。純理論風險——本 repo 文件全數使用半形
// 數字，尚未實際發生過；若未來出現全形數字寫法，需另外擴充 COUNT_PREFIX_RE / COUNT_SUFFIX_RE。

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FOOTPRINT_LIMIT_CHARS = 500;
const DUPLICATE_THRESHOLD = 0.9;
const DEEP_SYNC_THRESHOLD = 0.9;
const COUNT_UNIT_WORDS = '份|個|支';
const FORCED_COUNT_KEYS = ['reference', 'skill', 'hook'];
// #84 指令面收斂後 dispatch 是唯一入口；這些是被刪掉、不該再出現在文件/註解裡的舊指令名。
const DEAD_COMMAND_TOKENS = [
  'loops-workflow:resume',
  'loops-workflow:status',
  'loops-workflow:progress',
  'loops-workflow:loop',
];
// 已知的「佔位符」token：文件裡用來示意任意檔名，非真實可解析路徑，broken-ref 不誤報。
const REFERENCE_PLACEHOLDER_FILENAMES = new Set(['xxx.md']);
const EXCLUDED_DIR_NAMES = new Set(['.loops', '.claude', '.git', 'evals']);
const PLUGIN_SUBDIRS = ['skills', 'agents', 'docs', 'references', 'hooks', 'scripts'];

// ── 解析 / 判定層（純函式，無 IO，測試直接 import）──────────────────────────────

/**
 * 解析 SKILL.md / agent .md 的 YAML frontmatter → { name, description, userInvocable }。
 * 支援單行 `description: ...` 與 `description: >-` 折疊塊（後續縮排行以單一空格拼接）。
 * 無 frontmatter（不以 `---` 起頭）→ description=''（呼叫端不必再判 undefined）。
 */
export function parseDescription(content) {
  const empty = { name: undefined, description: '', userInvocable: undefined };
  const lines = String(content ?? '').split(/\r?\n/);
  if (lines[0] !== '---') return empty;

  const closeIdx = lines.slice(1).findIndex((l) => l === '---');
  if (closeIdx === -1) return empty;
  const fmLines = lines.slice(1, closeIdx + 1);

  let name;
  let userInvocable;
  let description = '';
  for (let i = 0; i < fmLines.length; i += 1) {
    const line = fmLines[i];

    const nameMatch = line.match(/^name:\s*(.+)$/);
    if (nameMatch) {
      name = nameMatch[1].trim();
      continue;
    }

    const uiMatch = line.match(/^user-invocable:\s*(true|false)\s*$/);
    if (uiMatch) {
      userInvocable = uiMatch[1] === 'true';
      continue;
    }

    if (/^description:\s*>-\s*$/.test(line)) {
      const folded = [];
      let j = i + 1;
      while (j < fmLines.length && /^\s+\S/.test(fmLines[j])) {
        folded.push(fmLines[j].trim());
        j += 1;
      }
      description = folded.join(' ');
      i = j - 1;
      continue;
    }

    const singleMatch = line.match(/^description:\s*(.*)$/);
    if (singleMatch) {
      description = singleMatch[1].trim();
    }
  }

  return { name, description, userInvocable };
}

/**
 * 剝除 .md 的 YAML frontmatter（含前後 `---` 分隔線），回傳純 body。無 frontmatter（不以 `---`
 * 起頭，或找不到閉合 `---`）→ 原樣返回 content。agent/skill 內容比較（duplicateCheck /
 * deepSyncCheck）與 stripDeepVariantNote 串接時，都該先過這關再比字，否則 frontmatter 裡
 * model/effort 等每檔必異的欄位會把相似度洗低。
 */
export function stripFrontmatter(content) {
  const lines = String(content ?? '').split(/\r?\n/);
  if (lines[0] !== '---') return content;
  const closeIdx = lines.slice(1).findIndex((l) => l === '---');
  if (closeIdx === -1) return content;
  return lines.slice(closeIdx + 2).join('\n');
}

// Unicode code point 數（非 UTF-16 code unit）。astral 字元（如 emoji）在 JS 字串裡是 surrogate
// pair、.length 會灌水成 2 —— 用展開運算子逐 code point 迭代才是人類直覺的「字數」。
function codePointLength(str) {
  return [...String(str ?? '')].length;
}

/**
 * description 字數（context footprint，以 Unicode code point 計，非 .length）超過 500 → P2。
 * summary 供 CLI 摘要用（totalChars 加總、estTokens 粗估 = ceil(chars/4)）。
 */
export function footprintCheck(items) {
  const list = Array.isArray(items) ? items : [];
  const findings = [];
  let totalChars = 0;

  for (const item of list) {
    const description = item?.description ?? '';
    const charCount = codePointLength(description);
    totalChars += charCount;
    if (charCount > FOOTPRINT_LIMIT_CHARS) {
      findings.push({
        check: 'footprint',
        severity: 'P2',
        file: item.file,
        detail: `${charCount} chars`,
      });
    }
  }

  return { findings, summary: { totalChars, estTokens: Math.ceil(totalChars / 4) } };
}

/**
 * 文字 → 小寫、去標點的 token 集合（供 jaccard 相似度比較）。長度<2 的 token（如 i/a）濾掉，
 * 避免高頻虛詞把相似度灌水。中日韓字元與英數字皆視為 token 邊界內字元。
 */
export function wordSet(text) {
  const tokens = String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .filter((t) => t.length >= 2);
  return new Set(tokens);
}

/** Jaccard 相似度（交集/聯集）。雙空集合視為完全相同 → 1（避免除以零，也符合「無內容差異」直覺）。 */
export function jaccard(setA, setB) {
  const a = setA instanceof Set ? setA : new Set(setA);
  const b = setB instanceof Set ? setB : new Set(setB);
  if (a.size === 0 && b.size === 0) return 1;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

// -deep 變體開頭的慣例提示句（審查內容逐字複製 base，僅 model/effort 不同）。比相似度前先剝除，
// 否則這句本身的文字差異會把「內容其實同步」的 base/deep 判成分叉（假陽性）。
// 前導 \s*（非 ^>）刻意容忍 body 開頭的空白/換行 —— 真實管線裡 stripFrontmatter 回傳的 body
// 常以 "\n" 起頭（frontmatter 後那個分隔空行），天真的 `^>` 錨定在該情境下永遠對不上、
// 讓這條 regex 形同死碼（F-B：validator 抓到兩組真實 base/deep 對邊際相似度僅 0.01–0.02，
// 代表剝句從未真的生效）。
const DEEP_VARIANT_NOTE_RE = /^\s*>\s*\*\*此檔是[^\n]*\n\n?/;

/** 剝除 -deep 檔開頭的變體提示 blockquote（含其後空行）；無此句 → 原樣返回。 */
export function stripDeepVariantNote(body) {
  const text = String(body ?? '');
  return text.replace(DEEP_VARIANT_NOTE_RE, '');
}

/**
 * 兩兩比對 agent body，jaccard≥threshold → 疑似逐字複製（P3，提醒收斂或說明差異）。
 * base⇄deep 命名對（X.md / X-deep.md）刻意逐字同步，不算違規重複 —— 交給 deepSyncCheck 管
 * （方向相反：那邊查的是「同步是否還成立」，這邊查的是「不該同步的兩份是否意外撞成一份」）。
 */
export function duplicateCheck(agents, threshold = DUPLICATE_THRESHOLD) {
  const list = Array.isArray(agents) ? agents : [];
  // 每個 agent 的 wordSet 只算一次（迴圈外預先算），避免 O(n²) 比較時重算 O(n) 次 —— agent 數
  // 隨 verify fan-out 成長，重算的浪費是乘數的。
  const wordSets = list.map((a) => wordSet(a.body));
  const findings = [];

  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      if (isBaseDeepPair(a.file, b.file)) continue;

      const similarity = jaccard(wordSets[i], wordSets[j]);
      if (similarity >= threshold) {
        findings.push({
          check: 'duplicate',
          severity: 'P3',
          files: [a.file, b.file],
          detail: `jaccard=${similarity.toFixed(2)}`,
        });
      }
    }
  }

  return findings;
}

function isBaseDeepPair(fileA, fileB) {
  const stem = (f) => String(f).replace(/\.md$/, '');
  const a = stem(fileA);
  const b = stem(fileB);
  return `${a}-deep` === b || `${b}-deep` === a;
}

/**
 * base⇄deep 命名對：各自剝除慣例提示句後比對，仍 <threshold → 審查內容真的分叉了，
 * deep 檔沒跟著 base 同步（P1，需要人工核對是否該同步或更新 base 引用行為）。
 */
export function deepSyncCheck(pairs, threshold = DEEP_SYNC_THRESHOLD) {
  const list = Array.isArray(pairs) ? pairs : [];
  const findings = [];

  for (const pair of list) {
    const baseWords = wordSet(stripDeepVariantNote(pair.baseBody));
    const deepWords = wordSet(stripDeepVariantNote(pair.deepBody));
    const similarity = jaccard(baseWords, deepWords);
    if (similarity < threshold) {
      findings.push({
        check: 'deep-sync',
        severity: 'P1',
        baseFile: pair.baseFile,
        deepFile: pair.deepFile,
        detail: `jaccard=${similarity.toFixed(2)} < ${threshold}`,
      });
    }
  }

  return findings;
}

// 只認「裸露」的 references/X.md 形狀（X 不含路徑分隔字元），字面 glob（references/*.md）
// 因含 `*` 天然不落入 [\w.-]+ 而不匹配；skill-local 形狀（skills/x/references/y.md）由呼叫端
// 依referrer 是否落在 skills/ 底下判斷是否略過，這裡只單純抓檔名。
const REFERENCE_MENTION_RE = /references\/([\w.-]+\.md)/g;

function extractReferenceMentions(content) {
  const filenames = new Set();
  for (const match of String(content ?? '').matchAll(REFERENCE_MENTION_RE)) {
    filenames.add(match[1]);
  }
  return filenames;
}

function isUnderSkillsDir(file) {
  return /(^|\/)skills\/[^/]+\//.test(file);
}

function pluginRootsOf(files) {
  const roots = new Set();
  for (const file of files) {
    const m = file.match(/^plugins\/([^/]+)\//);
    if (m) roots.add(`plugins/${m[1]}`);
  }
  return [...roots];
}

function pluginRootOf(file, pluginRoots) {
  return pluginRoots.find((root) => file.startsWith(`${root}/`)) ?? null;
}

function isPluginReferenceFile(file, pluginRoots) {
  return pluginRoots.some((root) => new RegExp(`^${escapeRegExp(root)}/references/[^/]+\\.md$`).test(file));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * broken-ref：`references/X.md` 提到卻不存在（P1）。
 * orphan-ref：plugin `references/*.md` 檔沒有任何地方（文字裡逐字提到檔名）引用它（P2）。
 *
 * skill-local 形狀（referrer 本身落在 skills/<name>/ 底下）刻意略過 broken-ref 檢查 ——
 * 那類 `references/x.md` 慣例上指該 skill 自己的 references/ 子目錄，不是 plugin 層 references/，
 * 本檢查不管那條子目錄的完整性。orphan-ref 的「有沒有被提到」則不分 referrer 位置，全文皆算。
 */
export function referenceIntegrityCheck(map) {
  const files = Object.keys(map ?? {});
  const pluginRoots = pluginRootsOf(files);
  const findings = [];

  for (const file of files) {
    if (isUnderSkillsDir(file)) continue; // skill-local 慣例，交給 skill 自己的規範管

    const ownRoot = pluginRootOf(file, pluginRoots);
    const candidateRoots = ownRoot ? [ownRoot] : pluginRoots;
    for (const filename of extractReferenceMentions(map[file])) {
      if (REFERENCE_PLACEHOLDER_FILENAMES.has(filename)) continue;

      const candidates = candidateRoots.map((root) => `${root}/references/${filename}`);
      const resolved = candidates.some((c) => map[c] != null);
      if (!resolved) {
        findings.push({
          check: 'broken-ref',
          severity: 'P1',
          file,
          detail: `references/${filename} not found`,
        });
      }
    }
  }

  for (const file of files) {
    if (!isPluginReferenceFile(file, pluginRoots)) continue;

    const filename = basename(file);
    const mentioned = files.some((other) => other !== file && mentionsFilename(map[other], filename));
    if (!mentioned) {
      findings.push({
        check: 'orphan-ref',
        severity: 'P2',
        file,
        detail: `no referrer mentions ${filename}`,
      });
    }
  }

  return findings;
}

function mentionsFilename(content, filename) {
  const re = new RegExp(`(^|[^\\w-])${escapeRegExp(filename)}($|[^\\w-])`);
  return re.test(String(content ?? ''));
}

// 前綴表格形：**hook** 8 個。unit 詞（份/個/支）強制要求，避免抓到 "**skill** | \`dispatch\`（1）"
// 這類「bold 標籤後面隨便一個無關數字」的誤配（沒有 unit 詞就不算「這是計數宣告」）。
const COUNT_PREFIX_RE = new RegExp(`\\*\\*(${FORCED_COUNT_KEYS.join('|')}|agent)\\*\\*[^\\d\\n]{0,10}(\\d+)\\s*(?:${COUNT_UNIT_WORDS})`, 'g');
// 後綴形：51 份 reference / 12 個 skill。
const COUNT_SUFFIX_RE = new RegExp(`(\\d+)\\s*(?:${COUNT_UNIT_WORDS})\\s*(${FORCED_COUNT_KEYS.join('|')}|agent)`, 'g');
const HISTORICAL_SNAPSHOT_MARK = '當時快照';

/**
 * 文件裡宣告的「N 份 reference / N 個 skill / N 個 hook（/ agent，非強制鍵）」與 actualCounts 對帳。
 * 標「當時快照」的行視為歷史紀錄、略過（數字本就該停留在過去）。
 * 只有 reference/skill/hook 三個強制鍵的落差進 findings（P1）；其餘鍵（如 agent）落差只記進 notes，
 * 不擋線 —— 這三鍵是本檔案唯一有精確 actualCounts 來源（掃檔算出）的，agent 之類的鍵沒有同等機械
 * 可信的來源，誤差可能是文件本身的統計口徑差異，不該直接判紅。
 */
export function countLintCheck(map, actualCounts) {
  const files = Object.keys(map ?? {});
  const actual = actualCounts ?? {};
  const findings = [];
  const notes = [];

  for (const file of files) {
    const lines = String(map[file] ?? '').split(/\r?\n/);
    for (const line of lines) {
      if (line.includes(HISTORICAL_SNAPSHOT_MARK)) continue;
      for (const [keyword, claimed] of extractCountClaims(line)) {
        if (!(keyword in actual)) continue;
        const claimedNum = Number(claimed);
        if (claimedNum === actual[keyword]) continue;

        const note = { check: 'count-drift', file, key: keyword, claimed: claimedNum, actual: actual[keyword] };
        notes.push(note);
        if (FORCED_COUNT_KEYS.includes(keyword)) {
          findings.push({
            check: 'count-drift',
            severity: 'P1',
            file,
            detail: `${keyword}: 文件宣告 ${claimedNum}，實際 ${actual[keyword]}`,
          });
        }
      }
    }
  }

  return { findings, notes };
}

function extractCountClaims(line) {
  const claims = [];
  for (const m of line.matchAll(COUNT_PREFIX_RE)) claims.push([m[1], m[2]]);
  for (const m of line.matchAll(COUNT_SUFFIX_RE)) claims.push([m[2], m[1]]);
  return claims;
}

/**
 * .md/.mjs 內殘留已刪指令 token（#84 指令收斂後唯一入口是 dispatch）→ P1，提醒清掉舊指代。
 * 比對前 lowercase 兩邊（token 清單本身已全小寫）：文件裡偶有大小寫混排（如標題句首大寫），
 * 大小寫敏感比對會漏掉那些寫法，讓真正殘留的死指令因排版差異溜掉。
 */
export function deadCommandCheck(map) {
  const files = Object.keys(map ?? {});
  const findings = [];

  for (const file of files) {
    const content = String(map[file] ?? '').toLowerCase();
    for (const token of DEAD_COMMAND_TOKENS) {
      if (content.includes(token)) {
        findings.push({ check: 'dead-command', severity: 'P1', file, detail: `殘留已刪指令「${token}」` });
      }
    }
  }

  return findings;
}

// notes 形狀不只一種（footprint finding 形＝{check,file,detail}；countLintCheck 非強制鍵形＝
// {check,file,key,claimed,actual}；呼叫端也可能自帶 {file,message} 形）——依序 fallback 取得可讀
// 的一行，避免因缺欄位印出 "undefined"。
function formatNoteLine(note) {
  const check = note?.check ?? 'note';
  const file = note?.file ?? '';
  const detail = note?.detail
    ?? note?.message
    ?? (note?.key ? `${note.key}: 文件宣告 ${note.claimed}，實際 ${note.actual}` : '');
  return `⚠ [${check}] ${file} — ${detail}`;
}

/**
 * 把整體檢查結果轉人讀摘要：findings 決定綠/紅頭（全綠單行 ✓；有 finding → 逐條
 * "✗ [check] severity file — detail"）。notes（footprint 超標、非強制鍵計數落差等
 * informational 提醒）永遠**額外**逐行印在頭部之後，不影響頭部綠/紅判定 —— notes 不擋線，
 * 但也不能悶掉：plain 輸出是使用者唯一會看的畫面，notes 若不印，維護者永遠不會知道要瘦身。
 */
export function formatSummary(result) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const notes = Array.isArray(result?.notes) ? result.notes : [];
  const filesScanned = result?.summary?.filesScanned ?? 0;

  const header = findings.length === 0
    ? `✓ skill-lint：${filesScanned} 檔全綠，無 finding。`
    : findings.map((f) => `✗ [${f.check}] ${f.severity} ${f.file} — ${f.detail}`).join('\n');

  return [header, ...notes.map(formatNoteLine)].join('\n');
}

// ── IO 邊界：walk（掃檔）+ actualCounts（讀 hooks.json / 目錄）+ CLI main ──────────

function shouldSkipDir(name) {
  return EXCLUDED_DIR_NAMES.has(name);
}

// 遞迴列出 dir 底下所有檔案的絕對路徑；沿路跳過 EXCLUDED_DIR_NAMES。目錄不存在則安靜回空陣列
// （plugin 不一定六個子目錄都有）。
function listFilesRecursive(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      files.push(...listFilesRecursive(join(dir, entry.name)));
    } else if (entry.isFile()) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

function toRelPosix(root, absPath) {
  return relative(root, absPath).split('\\').join('/');
}

function listPluginRoots(root) {
  const pluginsDir = join(root, 'plugins');
  let entries;
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !shouldSkipDir(e.name))
    .map((e) => join(pluginsDir, e.name));
}

/**
 * 掃 repo：plugin 樹（skills/agents/docs/references/hooks/scripts 底下 .md/.mjs）+ repo 根
 * README.md/AGENTS.md。回傳 relPath('/' 正規化) → 內容字串的 map（**會碰檔案系統**）。
 */
export function walk(root) {
  const map = {};

  for (const rootFile of ['README.md', 'AGENTS.md']) {
    const abs = join(root, rootFile);
    try {
      map[rootFile] = readFileSync(abs, 'utf8');
    } catch {
      // repo 根沒有這份檔屬正常情境，略過
    }
  }

  for (const pluginDir of listPluginRoots(root)) {
    for (const subdir of PLUGIN_SUBDIRS) {
      for (const abs of listFilesRecursive(join(pluginDir, subdir))) {
        if (!/\.(md|mjs)$/.test(abs)) continue;
        map[toRelPosix(root, abs)] = readFileSync(abs, 'utf8');
      }
    }
  }

  return map;
}

// skill-lint 自身與 test-skill-lint 不參與 deadCommand/countLint 掃描（自身原始碼裡含大量
// 「舊指令 token」「錯誤計數」字面示例，掃自己會把測試 fixture 誤判成真違規）；
// 全部 hooks/與 scripts/底下的 test-*.mjs 同理（fixture 字面常故意放故障字串）。
function isExcludedFromLintScan(relPath) {
  const base = basename(relPath);
  if (base === 'skill-lint.mjs' || base === 'test-skill-lint.mjs') return true;
  const underHooksOrScripts = relPath.includes('/hooks/') || relPath.includes('/scripts/');
  return underHooksOrScripts && /^test-.*\.mjs$/.test(base);
}

function buildLintScanMap(fullMap) {
  const out = {};
  for (const [file, content] of Object.entries(fullMap)) {
    if (isExcludedFromLintScan(file)) continue;
    out[file] = content;
  }
  return out;
}

function buildCountLintMap(lintScanMap) {
  const out = {};
  for (const [file, content] of Object.entries(lintScanMap)) {
    if (basename(file) === 'optimization-odw-ecc.md') continue;
    out[file] = content;
  }
  return out;
}

function buildReferenceMap(fullMap) {
  const out = {};
  for (const [file, content] of Object.entries(fullMap)) {
    if (file.endsWith('.md')) out[file] = content;
  }
  return out;
}

// hooks.json 的 hooks 樹裡，遞迴數 { "type": "command" } 的 entry 數。
function countCommandHooks(node) {
  if (Array.isArray(node)) return node.reduce((sum, item) => sum + countCommandHooks(item), 0);
  if (node && typeof node === 'object') {
    let count = node.type === 'command' ? 1 : 0;
    for (const value of Object.values(node)) count += countCommandHooks(value);
    return count;
  }
  return 0;
}

function readJsonMaybe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function countDirs(path) {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

function countFiles(path, ext) {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(ext)).length;
  } catch {
    return 0;
  }
}

/** 對每個 plugin 目錄實際數出 reference/skill/hook 數，加總（多 plugin 情境下合計）。 */
function computeActualCounts(root) {
  let reference = 0;
  let skill = 0;
  let hook = 0;

  for (const pluginDir of listPluginRoots(root)) {
    reference += countFiles(join(pluginDir, 'references'), '.md');
    skill += countDirs(join(pluginDir, 'skills'));
    const hooksJson = readJsonMaybe(join(pluginDir, 'hooks', 'hooks.json'));
    hook += hooksJson ? countCommandHooks(hooksJson.hooks) : 0;
  }

  return { reference, skill, hook };
}

// footprint 的 items：agents/*.md 與 skills/*/SKILL.md 的 description 全掃（皆常駐 context，
// 值得盯字數）。>500 命中在 buildReport 降級成 informational notes（不擋線）——真正超標的
// scaffold-fullstack 目前確實破格（1189 字元），但這是「該被看見、逐步瘦身」的既有債，不該讓
// lint 本身把既有 repo 判紅；notes 讓每次跑都看得到警示，同時不阻擋其餘檢查通過。
function buildFootprintItems(fullMap) {
  const items = [];
  for (const [file, content] of Object.entries(fullMap)) {
    const isAgent = /^plugins\/[^/]+\/agents\/[^/]+\.md$/.test(file);
    const isSkill = /^plugins\/[^/]+\/skills\/[^/]+\/SKILL\.md$/.test(file);
    if (!isAgent && !isSkill) continue;
    items.push({ file, description: parseDescription(content).description });
  }
  return items;
}

function buildAgentsList(fullMap) {
  return Object.entries(fullMap)
    .filter(([file]) => /^plugins\/[^/]+\/agents\/[^/]+\.md$/.test(file))
    .map(([file, content]) => ({ file, body: stripFrontmatter(content) }));
}

function buildDeepSyncPairs(agentsList) {
  const byFile = new Map(agentsList.map((a) => [a.file, a]));
  const pairs = [];
  for (const agent of agentsList) {
    if (!agent.file.endsWith('-deep.md')) continue;
    const baseFile = agent.file.replace(/-deep\.md$/, '.md');
    const base = byFile.get(baseFile);
    if (!base) continue;
    pairs.push({ baseFile: base.file, baseBody: base.body, deepFile: agent.file, deepBody: agent.body });
  }
  return pairs;
}

/** 掃描 root，跑五類檢查，組成完整結果物件（--json 與人讀摘要共用同一份）。 */
export function buildReport(root) {
  const fullMap = walk(root);
  const lintScanMap = buildLintScanMap(fullMap);
  const countLintMap = buildCountLintMap(lintScanMap);
  const referenceMap = buildReferenceMap(fullMap);
  const agentsList = buildAgentsList(fullMap);

  const footprint = footprintCheck(buildFootprintItems(fullMap));
  const referenceFindings = referenceIntegrityCheck(referenceMap);
  const duplicateFindings = duplicateCheck(agentsList, DUPLICATE_THRESHOLD);
  const deepSyncFindings = deepSyncCheck(buildDeepSyncPairs(agentsList), DEEP_SYNC_THRESHOLD);
  const countLint = countLintCheck(countLintMap, computeActualCounts(root));
  const deadCommandFindings = deadCommandCheck(lintScanMap);

  // footprint 命中降為 informational notes（與 countLint 的非強制鍵 notes 同機制）：
  // 提醒既有內容該瘦身，但不因既有債把每次跑判紅、擋住其餘檢查的綠燈。
  const findings = [
    ...referenceFindings,
    ...duplicateFindings,
    ...deepSyncFindings,
    ...countLint.findings,
    ...deadCommandFindings,
  ];
  const notes = [...footprint.findings, ...countLint.notes];

  return {
    ok: findings.length === 0,
    findings,
    notes,
    summary: {
      filesScanned: Object.keys(fullMap).length,
      totalChars: footprint.summary.totalChars,
      estTokens: footprint.summary.estTokens,
      hint: '新增 reference/skill/hook 或 allowlist token 時，記得同步 actualCounts 掃法與 allowlist 清單（見 skill-lint.mjs）。',
    },
  };
}

function defaultRoot() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return join(scriptDir, '..', '..', '..');
}

function parseArgs(argv) {
  const opts = { root: defaultRoot(), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--root') opts.root = argv[++i] ?? opts.root;
    else if (flag === '--json') opts.json = true;
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const result = buildReport(opts.root);
  console.log(opts.json ? JSON.stringify(result, null, 2) : formatSummary(result));
  process.exit(result.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2));
}
