#!/usr/bin/env node
// skill-lint.mjs —— 掃 loops-workflow plugin 樹，抓 skill/agent 描述膨脹、審查內容漂移、
// reference 斷鏈/孤兒、文件計數失準、已刪指令殘留、flag 分類與 hooks 掛載未同步七類維護債。
// 分層：
//   1) 解析 / 判定層（純函式，無 IO）：parseDescription / footprintCheck / wordSet / jaccard /
//      stripDeepVariantNote / stripFrontmatter / duplicateCheck / deepSyncCheck /
//      referenceIntegrityCheck / countLintCheck / deadCommandCheck / parseFlagDefaults /
//      flagSyncCheck / hooksWiringCheck / formatSummary —— 給單元測試直接 import。
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

// ── #128：flag 分類三方同步（hook-flags.mjs⇄settings.md⇄journaling.md）＋ hooks.json 掛載對帳 ──

// 「N 個 flag」不錨定收尾括號——真實 hook-flags.mjs 的引號是「「11 個 flag 各自屬於 defaultOn
// 還是 optIn」與「怎麼判斷開關」...」，收尾 」 在 optIn 之後，不是緊跟在 flag 後面；只認「數字＋
// 個＋flag」這段子字串，不要求它自成一個完整的「」引號單位（測試 fixture 剛好兩種寫法都收得到）。
const FLAG_HEADER_TOTAL_RE = /(\d+)\s*個\s*flag/;
const FLAG_HEADER_DEFAULT_ON_RE = /defaultOn（(\d+)）/;
const FLAG_HEADER_OPT_IN_RE = /optIn（(\d+)）/;
const FLAG_DEFAULTS_BLOCK_RE = /FLAG_DEFAULTS\s*=\s*\{([\s\S]*?)\n\}\s*;/;
const FLAG_ENTRY_RE = /^\s*(LOOPS_[A-Z_]+):\s*\{\s*defaultOn:\s*(true|false)\s*\}/;

/**
 * 解析 hook-flags.mjs 內容 → { flags:[{name,defaultOn}], headerClaims:{total?,defaultOn?,optIn?} }。
 * FLAG_DEFAULTS 物件字面量抽不到、或抽到區塊內一個 flag 都解不出 → 回傳 {error}（不是空陣列）——
 * 呼叫端 flagSyncCheck 靠這個分支判斷「檔案本身壞了」，不能讓它看起來像「檔案裡剛好沒 flag」而
 * 悄悄放行。
 */
export function parseFlagDefaults(content) {
  const text = String(content ?? '');
  const blockMatch = text.match(FLAG_DEFAULTS_BLOCK_RE);
  if (!blockMatch) {
    return { error: '找不到 FLAG_DEFAULTS = { ... } 物件字面量區塊' };
  }

  const flags = [];
  for (const line of blockMatch[1].split(/\r?\n/)) {
    const m = line.match(FLAG_ENTRY_RE);
    if (m) flags.push({ name: m[1], defaultOn: m[2] === 'true' });
  }
  if (flags.length === 0) {
    return { error: 'FLAG_DEFAULTS 區塊內找不到任何 "LOOPS_X: { defaultOn: true|false }" 行' };
  }

  const headerClaims = {};
  const totalMatch = text.match(FLAG_HEADER_TOTAL_RE);
  if (totalMatch) headerClaims.total = Number(totalMatch[1]);
  const defaultOnMatch = text.match(FLAG_HEADER_DEFAULT_ON_RE);
  if (defaultOnMatch) headerClaims.defaultOn = Number(defaultOnMatch[1]);
  const optInMatch = text.match(FLAG_HEADER_OPT_IN_RE);
  if (optInMatch) headerClaims.optIn = Number(optInMatch[1]);

  return { flags, headerClaims };
}

// settings.md「## 預設開／預設關」兩段各自的內文（容忍標題後綴文字，如「（想關才需要設...）」）；
// 段落邊界＝下一個任意層級 2 標題或檔尾，找不到指定標題 → 空字串（呼叫端得到空 Set，等同「這個
// 分類段落沒有任何旗標」）。
const SETTINGS_DEFAULT_ON_HEADER_RE = /^##\s*預設開/;
const SETTINGS_OPT_IN_HEADER_RE = /^##\s*預設關/;
const ANY_H2_HEADER_RE = /^##\s/;
// 非 blockquote 版表格列（settings.md 的表格沒有 `> ` 前綴，journaling.md 決策表另有專屬 regex）。
const MARKDOWN_TABLE_ROW_RE = /^\|(.+)\|\s*$/;
const FLAG_NAME_CELL_RE = /`(LOOPS_[A-Z_]+)`/g;

function sliceMarkdownSection(content, headerRe) {
  const lines = String(content ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => headerRe.test(l));
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (ANY_H2_HEADER_RE.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join('\n');
}

// 只看每個表格列的**第一欄**（旗標名欄）——不掃整段文字，避免說明欄／「想關」範例欄裡順帶提到
// 的其他旗標名被誤當成「這段落也記載了它」（表頭列「參數」、分隔列「---」天然不含反引號旗標名，
// 不需要另外偵測跳過）。
function extractTableFirstColumnFlagNames(sectionText) {
  const names = new Set();
  for (const line of String(sectionText ?? '').split(/\r?\n/)) {
    const m = line.match(MARKDOWN_TABLE_ROW_RE);
    if (!m) continue;
    const firstCell = m[1].split('|')[0] ?? '';
    for (const nm of firstCell.matchAll(FLAG_NAME_CELL_RE)) names.add(nm[1]);
  }
  return names;
}

function parseSettingsSections(settingsContent) {
  return {
    defaultOnNames: extractTableFirstColumnFlagNames(sliceMarkdownSection(settingsContent, SETTINGS_DEFAULT_ON_HEADER_RE)),
    optInNames: extractTableFirstColumnFlagNames(sliceMarkdownSection(settingsContent, SETTINGS_OPT_IN_HEADER_RE)),
  };
}

// journaling.md 決策表：以第一個 `> ` 前綴的 blockquote 表列為表頭起點，連續同形列（含
// |---|---|---| 分隔列）都算表格一部分，遇到第一個非 blockquote 表列的行即表格結束——藉此跟本檔
// 更早、非 blockquote 的「outcome 度量格式」表格區分開來（那張表沒有 `> ` 前綴）。
const JOURNALING_TABLE_ROW_RE = /^>\s*\|(.+)\|\s*$/;

function journalingTableDataRows(journalingContent) {
  const lines = String(journalingContent ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => JOURNALING_TABLE_ROW_RE.test(l));
  if (start === -1) return [];

  const rows = [];
  for (let i = start; i < lines.length; i += 1) {
    const m = lines[i].match(JOURNALING_TABLE_ROW_RE);
    if (!m) break;
    rows.push(m[1]);
  }
  return rows.slice(2); // 跳過表頭列與 |---|---|---| 分隔列
}

/**
 * journaling.md 決策表 → { classification: Map<flagName,'defaultOn'|'optIn'>, mentionedNames: Set }。
 * 兩者都只看每列**第一欄**（旗標名欄，可用 `/` 併列多個反引號全名共用同一分類，比照真實
 * journaling.md 的 `LOOPS_EVAL_GATE`/`LOOPS_EVAL_TAGS_GATE`/`LOOPS_EVAL_POLL_GATE` 三合一寫法）——
 * 「一句理由」欄常順帶提到別的旗標名做舉例／對比，那不代表「這份文件記載了它」，第三欄一律不看。
 * 分類欄含「開」→ defaultOn；含 "opt-in"（不分大小寫）→ optIn；兩者皆無（如「已淘汰」列）→
 * classification 略過該名字，但仍算 mentionedNames（列出現過，只是分類文字辨識不出來）。
 */
function parseJournalingFlagTable(journalingContent) {
  const classification = new Map();
  const mentionedNames = new Set();

  for (const row of journalingTableDataRows(journalingContent)) {
    const cells = row.split('|');
    const names = [...(cells[0] ?? '').matchAll(FLAG_NAME_CELL_RE)].map((mm) => mm[1]);
    if (names.length === 0) continue;
    for (const name of names) mentionedNames.add(name);

    const classCell = cells[1] ?? '';
    let cls = null;
    if (classCell.includes('開')) cls = 'defaultOn';
    else if (/opt-in/i.test(classCell)) cls = 'optIn';
    if (!cls) continue;

    for (const name of names) classification.set(name, cls);
  }

  return { classification, mentionedNames };
}

// hook-flags.mjs 不管、但合法出現在文件裡的 LOOPS_*（skill 層 env、內部測試參數、或純代稱非真
// 環境變數）——flag-sync 的「未知旗標」P2 檢查不誤報這些（見 docs/settings.md「進階／內部」一節）。
const FLAG_NAME_ALLOWLIST = new Set([
  'LOOPS_AUTO',
  'LOOPS_EXPLAIN',
  'LOOPS_SANDBOX_RUNNER',
  'LOOPS_LOOP_DRIVER_GATE_SCRIPT',
  'LOOPS_ROOT',
]);

const HEADER_CLAIM_LABELS = { total: 'flag 總數', defaultOn: 'defaultOn 數', optIn: 'optIn 數' };

/**
 * hook-flags.mjs（單一真相源）⇄ settings.md「## 預設開/關」⇄ journaling.md 決策表 三方對帳，
 * 外加「兩文檔出現不屬於任何一邊的 LOOPS_*」反向掃描。hook-flags.mjs 解析失敗 → 單一 P1 直接
 * 返回（沒有 flags[] 可比對，其餘子檢查連跑都跑不起來，跑了也只是噪音）。
 */
export function flagSyncCheck({ hookFlagsContent, settingsContent, journalingContent } = {}) {
  const parsed = parseFlagDefaults(hookFlagsContent);
  if (parsed.error) {
    return [{
      check: 'flag-sync',
      severity: 'P1',
      file: 'hooks/hook-flags.mjs',
      detail: `無法解析 FLAG_DEFAULTS：${parsed.error}`,
    }];
  }

  const { flags, headerClaims } = parsed;
  const findings = [];
  const actualDefaultOn = flags.filter((f) => f.defaultOn).length;
  const actualCounts = { total: flags.length, defaultOn: actualDefaultOn, optIn: flags.length - actualDefaultOn };

  for (const key of ['total', 'defaultOn', 'optIn']) {
    if (headerClaims[key] == null || Number(headerClaims[key]) === actualCounts[key]) continue;
    findings.push({
      check: 'flag-sync',
      severity: 'P1',
      file: 'hooks/hook-flags.mjs',
      detail: `header 宣稱 ${HEADER_CLAIM_LABELS[key]} 為 ${headerClaims[key]}，實際 FLAG_DEFAULTS 有 ${actualCounts[key]} 個`,
    });
  }

  const settingsSections = parseSettingsSections(settingsContent);
  const journalingTable = parseJournalingFlagTable(journalingContent);

  for (const flag of flags) {
    const expectedCls = flag.defaultOn ? 'defaultOn' : 'optIn';
    const ownNames = flag.defaultOn ? settingsSections.defaultOnNames : settingsSections.optInNames;
    const otherNames = flag.defaultOn ? settingsSections.optInNames : settingsSections.defaultOnNames;
    const ownSectionLabel = flag.defaultOn ? '預設開' : '預設關';
    const otherSectionLabel = flag.defaultOn ? '預設關' : '預設開';

    if (!ownNames.has(flag.name)) {
      findings.push({
        check: 'flag-sync',
        severity: 'P1',
        file: 'docs/settings.md',
        detail: `${flag.name}（${expectedCls}）未出現在「${ownSectionLabel}」段`,
      });
    }
    if (otherNames.has(flag.name)) {
      findings.push({
        check: 'flag-sync',
        severity: 'P1',
        file: 'docs/settings.md',
        detail: `${flag.name}（${expectedCls}）卻出現在「${otherSectionLabel}」段`,
      });
    }

    const journalingCls = journalingTable.classification.get(flag.name);
    if (journalingCls == null) {
      findings.push({
        check: 'flag-sync',
        severity: 'P1',
        file: 'references/journaling.md',
        detail: `${flag.name} 未出現在 flag 決策表`,
      });
    } else if (journalingCls !== expectedCls) {
      findings.push({
        check: 'flag-sync',
        severity: 'P1',
        file: 'references/journaling.md',
        detail: `${flag.name} 決策表分類（${journalingCls}）與 hook-flags.mjs（${expectedCls}）不一致`,
      });
    }
  }

  const knownNames = new Set(flags.map((f) => f.name));
  const settingsNames = new Set([...settingsSections.defaultOnNames, ...settingsSections.optInNames]);
  const journalingNames = journalingTable.mentionedNames;
  for (const name of new Set([...settingsNames, ...journalingNames])) {
    if (knownNames.has(name) || FLAG_NAME_ALLOWLIST.has(name)) continue;
    const sources = [];
    if (settingsNames.has(name)) sources.push('docs/settings.md');
    if (journalingNames.has(name)) sources.push('references/journaling.md');
    findings.push({
      check: 'flag-sync',
      severity: 'P2',
      file: sources.join(', '),
      detail: `未知旗標 ${name}：不在 FLAG_DEFAULTS 也不在 allowlist，疑似拼錯名或待補`,
    });
  }

  return findings;
}

// hooks.json 內 `${CLAUDE_PLUGIN_ROOT}/hooks/X.mjs` 形狀的指令引用；greedy 到第一個 ".mjs" 即可
// （hook 路徑段不含裸 ".mjs" 字面量），不需要 non-greedy。
const HOOK_COMMAND_REF_RE = /\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/[\w./-]+\.mjs)/g;

// fixtures/ 段（任一路徑段等於 fixtures）、test-*.mjs、hook-flags.mjs：這三類本就不是「該被
// hooks.json 掛載執行」的 hook 本體（測試 fixture／單元測試／純資料表），未掛載不算 P2。
function isHookWiringExempt(relPath) {
  const segments = String(relPath ?? '').split('/');
  if (segments.includes('fixtures')) return true;
  const base = segments[segments.length - 1] ?? '';
  return base === 'hook-flags.mjs' || /^test-.*\.mjs$/.test(base);
}

/**
 * hooks.json 的 `${CLAUDE_PLUGIN_ROOT}/hooks/X.mjs` 引用 ⇄ 實際 hooks/*.mjs 檔案清單對帳。
 * 引用不存在的檔 → P1（執行期真的會噴錯）；存在卻沒被任何 entry 引用的檔 → P2（較可能只是死檔
 * 或漏接線，不像引用不存在那麼致命）。
 */
export function hooksWiringCheck(hooksJsonContent, hookFiles) {
  const files = Array.isArray(hookFiles) ? hookFiles : [];
  const fileSet = new Set(files);
  const findings = [];

  const referenced = new Set(
    [...String(hooksJsonContent ?? '').matchAll(HOOK_COMMAND_REF_RE)].map((m) => m[1]),
  );

  for (const ref of referenced) {
    if (fileSet.has(ref)) continue;
    findings.push({ check: 'hooks-wiring', severity: 'P1', file: 'hooks/hooks.json', detail: `引用不存在的 ${ref}` });
  }

  for (const file of files) {
    if (referenced.has(file) || isHookWiringExempt(file)) continue;
    findings.push({
      check: 'hooks-wiring',
      severity: 'P2',
      file,
      detail: '存在卻未被 hooks.json 任何 entry 引用',
    });
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

// hooks.json 要餵給 hooksWiringCheck 的是原始文字（該函式自己用正則掃 command 字串），
// 不是 readJsonMaybe 的已解析物件——用途跟 readJsonMaybe 不同，各自留著。
function readTextMaybe(path) {
  try {
    return readFileSync(path, 'utf8');
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

/**
 * flagSyncCheck／hooksWiringCheck 接線：只對「有採用 hook-flags.mjs 慣例」的 plugin 跑（目前僅
 * loops-workflow；其餘 plugin 若未來也導入這慣例，加了 hook-flags.mjs 就會自動被納入，不必改這
 * 裡）。hooks.json 不是 .md/.mjs，不在 walk() 的掃描面內，另外直接讀檔。P1 併入 findings、
 * P2 併入 notes——與 footprint／countLint 的 non-forced-key notes 走同一套分流慣例。
 */
function buildFlagAndWiringResults(fullMap, root) {
  const findings = [];
  const notes = [];

  for (const pluginDir of listPluginRoots(root)) {
    const pluginRel = toRelPosix(root, pluginDir);
    const hookFlagsKey = `${pluginRel}/hooks/hook-flags.mjs`;
    if (!(hookFlagsKey in fullMap)) continue;

    const flagFindings = flagSyncCheck({
      hookFlagsContent: fullMap[hookFlagsKey],
      settingsContent: fullMap[`${pluginRel}/docs/settings.md`],
      journalingContent: fullMap[`${pluginRel}/references/journaling.md`],
    });
    for (const f of flagFindings) (f.severity === 'P1' ? findings : notes).push(f);

    const hooksJsonContent = readTextMaybe(join(pluginDir, 'hooks', 'hooks.json'));
    if (hooksJsonContent == null) continue;
    const hookFiles = Object.keys(fullMap)
      .filter((k) => k.startsWith(`${pluginRel}/hooks/`) && k.endsWith('.mjs'))
      .map((k) => k.slice(pluginRel.length + 1));
    const wiringFindings = hooksWiringCheck(hooksJsonContent, hookFiles);
    for (const f of wiringFindings) (f.severity === 'P1' ? findings : notes).push(f);
  }

  return { findings, notes };
}

/** 掃描 root，跑七類檢查，組成完整結果物件（--json 與人讀摘要共用同一份）。 */
export function buildReport(root) {
  const fullMap = walk(root);
  const lintScanMap = buildLintScanMap(fullMap);
  const countLintMap = lintScanMap; // #95 起無逐檔排除（原 odw-ecc 歷程紀錄已刪），countLint 掃描面＝lint 掃描面
  const referenceMap = buildReferenceMap(fullMap);
  const agentsList = buildAgentsList(fullMap);

  const footprint = footprintCheck(buildFootprintItems(fullMap));
  const referenceFindings = referenceIntegrityCheck(referenceMap);
  const duplicateFindings = duplicateCheck(agentsList, DUPLICATE_THRESHOLD);
  const deepSyncFindings = deepSyncCheck(buildDeepSyncPairs(agentsList), DEEP_SYNC_THRESHOLD);
  const countLint = countLintCheck(countLintMap, computeActualCounts(root));
  const deadCommandFindings = deadCommandCheck(lintScanMap);
  const flagAndWiring = buildFlagAndWiringResults(fullMap, root);

  // footprint 命中降為 informational notes（與 countLint 的非強制鍵 notes 同機制）：
  // 提醒既有內容該瘦身，但不因既有債把每次跑判紅、擋住其餘檢查的綠燈。
  const findings = [
    ...referenceFindings,
    ...duplicateFindings,
    ...deepSyncFindings,
    ...countLint.findings,
    ...deadCommandFindings,
    ...flagAndWiring.findings,
  ];
  const notes = [...footprint.findings, ...countLint.notes, ...flagAndWiring.notes];

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
