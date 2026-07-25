#!/usr/bin/env node
// lint-mutation.mjs —— lint 變異驗證（mutation testing for linters）。
//
// 解決的問題：既有測試「不由綠轉紅」擋得住行為回歸，卻**擋不住掃描面塌陷**——lint 的
// 目標檔案被搬走／改名後，regex 對不上、遞迴旗標關著，檢查器就掃不到任何東西，然後
// 一片全綠地回報「沒問題」。真實模擬證實過：把 agents/ 與 references/ 搬進巢狀子目錄後，
// skill-lint 的 deep-sync 分叉與孤兒 reference 都從「抓到 1」變成「抓到 0」，
// compat-lint 掃描面從 83 檔掉到 31 檔仍回報全綠。
//
// 本工具的作法（兩軸，缺一不可）：
//   ①注入軸：把 repo 複製到暫存目錄 → 對每一項既有檢查注入一個**真的**違規 → 跑該檢查 →
//     斷言它非 0 退出且 finding 指名該違規。注入沒被抓到 = 該檢查已空轉。
//   ②掃描面軸：對「一整類檔案」同時注入（N-fold probe），數檢查器實際回報幾筆，
//     與獨立遞迴掃出的檔案數比對，並設實測下限。單看 exit code 看不出面積縮水，這條才看得出。
//
// 每個注入點都有 precheck：目標必須**恰好存在**（找不到／找到多個一律丟例外），
// 不允許靜默跳過——否則重構後目標移位，本工具會什麼都沒注入然後回報「全部抓到」。
//
// 目標檔一律用「遞迴搜尋 + 檔名唯一」定位（不寫死平鋪路徑），這樣搬檔後本工具仍找得到目標、
// 真的注入下去，讓「檢查器掃不到」這件事以紅燈現形，而不是以「找不到目標」草草收場。
//
// 分層：
//   1) 判定層（純函式，無 IO）：matchesExpectation / summarize / formatSummary —— 測試直接 import。
//   2) IO 邊界：copyRepo / runScenario / runSurfaceProbe / buildReport / CLI main
//      （main 被 import 時不執行）。
// 依賴：僅 node 內建 + 同目錄的 skill-lint.mjs／compat-lint.mjs。
// 用法：node lint-mutation.mjs [--root <dir>] [--json]

import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildReport as buildSkillLintReport } from './skill-lint.mjs';
import { buildReport as buildCompatLintReport } from './compat-lint.mjs';

// ── 常數 ─────────────────────────────────────────────────────────────────────

const PLUGIN_REL = 'plugins/loops-workflow';
const AGENTS_REL = `${PLUGIN_REL}/agents`;
const REFERENCES_REL = `${PLUGIN_REL}/references`;
const HOOKS_REL = `${PLUGIN_REL}/hooks`;
const PLUGIN_DOCS_REL = `${PLUGIN_REL}/docs`;

// 複製 repo 時整段跳過的目錄：版控內部、依賴、工作區狀態——與 lint 掃描面無關，複製它們只是慢。
const COPY_SKIP_DIR_NAMES = new Set(['.git', 'node_modules', '.claude', '.loops']);

// reviewer base 模板（references/personas/<agent 名>.md）是 gen-reviewers.mjs 的生成真相源，
// compat-lint 與 skill-lint 皆明文排除——探針不跟著它們算，避免拿「本來就不該掃」當塌陷。
// 它們與手寫 persona 散文同層，故 personas/ 這個目錄本身仍要放探針（該目錄有大量非生成散文）。
const GENERATED_REFERENCE_FILE_RE = /^([\w-]+-reviewer|finding-validator)\.md$/;

const PROBE_TOKEN = '__mutation_probe__';
const PROBE_ORPHAN_BASENAME = `${PROBE_TOKEN}orphan.md`;
const PROBE_MISSING_REFERENCE = `${PROBE_TOKEN}missing.md`;
const PROBE_MISSING_HOOK = `${PROBE_TOKEN}missing.mjs`;
const PROBE_WRONG_MODEL = `${PROBE_TOKEN}wrong-model`;
const PROBE_ORPHAN_SPAN_ID = `${PROBE_TOKEN}orphan-span`;
const PROBE_DRIFT_MATCHER = `${PROBE_TOKEN}drift`;
const PROBE_BOGUS_COUNT = 9999;
// 刻意用字串組合而非字面量：skill-lint 的 dead-command 會掃本檔，寫死字面量會讓本檔自己變成違規
// （skill-lint 只對自身與 test-*.mjs 豁免，不對本檔豁免——而擴大豁免面等於少掃一個檔，不划算）。
const PROBE_DEAD_COMMAND = ['loops-workflow', 'resume'].join(':');
const PROBE_PLATFORM_TOOL = 'AskUserQuestion';

// footprint 門檻是 500 字元；探針 description 必須明確超過才算真違規。
const FOOTPRINT_LIMIT_CHARS = 500;
const OVERSIZED_DESCRIPTION = 'ｍ'.repeat(FOOTPRINT_LIMIT_CHARS + 20);

// deep-sync 用 jaccard≥0.9 判同步；探針 body 必須與 base 幾乎零交集才是「真的分叉」。
const FORKED_DEEP_BODY = [
  '',
  '## 變異注入：本檔內容已與 base 分叉',
  '',
  '鳳梨 芭樂 火龍果 楊桃 蓮霧 釋迦 枇杷 山竹 榴槤 荔枝。',
  'pineapple guava dragonfruit carambola waxapple sugarapple loquat mangosteen durian lychee.',
  '',
].join('\n');

// ── 判定層（純函式，無 IO，測試直接 import）─────────────────────────────────────

function entryText(entry) {
  return typeof entry === 'string' ? entry : JSON.stringify(entry);
}

/**
 * 一份 lint report 裡是否存在符合 expectation 的項目。
 * expectation = { kind: 'finding'|'note', check, includes: string[] }。
 * check 比對物件形 entry 的 check 欄位（字串形 notes 退回全文子字串比對）；
 * includes 逐條都要在 entry 全文裡出現——「有紅燈」不夠，必須**指名到這次注入的東西**，
 * 否則別的既有 finding 就能讓變異假裝被抓到。
 */
export function matchesExpectation(report, expectation) {
  const pool = expectation?.kind === 'note' ? report?.notes : report?.findings;
  const includes = expectation?.includes ?? [];

  return (Array.isArray(pool) ? pool : []).some((entry) => {
    const text = entryText(entry);
    if (expectation?.check != null) {
      const checkMatched = typeof entry === 'string'
        ? text.includes(expectation.check)
        : entry?.check === expectation.check;
      if (!checkMatched) return false;
    }
    return includes.every((needle) => text.includes(needle));
  });
}

/**
 * scenario 結果 + surface probe 結果 → 整體報告骨架。
 * 任一注入沒被抓到、或任一掃描面低於下限 → ok=false，並各自產出指名到底是哪個檢查、
 * 注入了什麼／面積掉到多少的 finding。
 */
export function summarize(scenarioResults, probeResults) {
  const scenarios = Array.isArray(scenarioResults) ? scenarioResults : [];
  const probes = Array.isArray(probeResults) ? probeResults : [];
  const findings = [];

  for (const r of scenarios) {
    if (r.caught) continue;
    findings.push({
      check: 'mutation-escaped',
      severity: 'P1',
      file: r.target,
      detail: `[${r.tool}/${r.check}] 注入「${r.describe}」後，${r.tool} 沒有回報對應 finding —— 該檢查已空轉`,
    });
  }

  for (const p of probes) {
    if (p.measured >= p.floor) continue;
    findings.push({
      check: 'surface-collapse',
      severity: 'P1',
      file: p.tool,
      detail: `[${p.id}] 掃描面 ${p.measured} < 下限 ${p.floor}（${p.describe}）—— 檢查器掃得到的檔案變少了`,
    });
  }

  const caught = scenarios.filter((r) => r.caught).length;
  return {
    ok: findings.length === 0,
    findings,
    notes: [],
    summary: {
      injected: scenarios.length,
      caught,
      scenarios: scenarios.map((r) => ({ id: r.id, tool: r.tool, check: r.check, target: r.target, caught: r.caught })),
      surfaces: probes.map((p) => ({ id: p.id, tool: p.tool, measured: p.measured, floor: p.floor })),
    },
  };
}

/** 人讀摘要：全綠印「注入總數／被抓到數」單行；有 finding 逐條印，並仍附上計數行。 */
export function formatSummary(result) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const injected = result?.summary?.injected ?? 0;
  const caught = result?.summary?.caught ?? 0;
  const surfaces = result?.summary?.surfaces ?? [];

  const lines = [];
  if (findings.length === 0) {
    lines.push(`✓ lint-mutation：注入 ${injected} / 抓到 ${caught}，掃描面 ${surfaces.length} 項皆達下限。`);
  } else {
    lines.push(...findings.map((f) => `✗ [${f.check}] ${f.severity} ${f.file} — ${f.detail}`));
    lines.push(`注入 ${injected} / 抓到 ${caught}`);
  }
  lines.push(...surfaces.map((s) => `  · 掃描面 ${s.id}（${s.tool}）：${s.measured}（下限 ${s.floor}）`));
  return lines.join('\n');
}

// ── IO 工具：複製 repo、遞迴定位目標 ──────────────────────────────────────────

function copyRepo(sourceRoot) {
  const dest = mkdtempSync(join(tmpdir(), 'lint-mutation-'));
  cpSync(sourceRoot, dest, {
    recursive: true,
    filter: (src) => !COPY_SKIP_DIR_NAMES.has(basename(src)),
  });
  return dest;
}

function listFilesRecursive(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

function toRelPosix(root, abs) {
  return relative(root, abs).split('\\').join('/');
}

/**
 * 在 root/relDir 底下遞迴找檔名等於 name 的檔案，**必須恰好一個**。
 * 找不到或找到多個一律丟例外——這是本工具的命脈：目標移位時要大聲紅，不是靜默不注入。
 */
function findExactlyOne(root, relDir, name) {
  const matches = listFilesRecursive(join(root, ...relDir.split('/'))).filter((f) => basename(f) === name);
  if (matches.length !== 1) {
    throw new Error(`前置檢查失敗：${relDir} 底下應恰好有 1 個 ${name}，實際 ${matches.length} 個`);
  }
  return matches[0];
}

function listMarkdownIn(root, relDir) {
  return listFilesRecursive(join(root, ...relDir.split('/'))).filter((f) => f.endsWith('.md'));
}

/** agents 樹（遞迴）裡的 .md 全清單；空 → 例外（agents 是本工具多數注入點的前提）。 */
function listAgentFiles(root) {
  const files = listMarkdownIn(root, AGENTS_REL).sort();
  if (files.length === 0) throw new Error(`前置檢查失敗：${AGENTS_REL} 底下找不到任何 .md`);
  return files;
}

/** -deep 檔與其同目錄 base 檔配對（skill-lint 的配對規則：X-deep.md ⇄ X.md，同路徑）。 */
function listDeepPairs(root) {
  const files = listAgentFiles(root);
  const set = new Set(files);
  return files
    .filter((f) => f.endsWith('-deep.md'))
    .map((deep) => ({ deep, base: deep.replace(/-deep\.md$/, '.md') }))
    .filter((pair) => set.has(pair.base));
}

/**
 * plugin references 樹裡「非生成物」的 .md 依所在目錄分組，回傳目錄絕對路徑清單。
 * 孤兒探針要放進**每一個**這樣的目錄——平鋪時只有 references/ 一層，搬檔後會是多個巢狀層，
 * 探針跟著搬過去，檢查器認不認得出來就見真章。
 */
function listReferenceDirs(root) {
  const dirs = new Set();
  for (const file of listMarkdownIn(root, REFERENCES_REL)) {
    if (GENERATED_REFERENCE_FILE_RE.test(basename(file))) continue;
    dirs.add(dirname(file));
  }
  if (dirs.size === 0) throw new Error(`前置檢查失敗：${REFERENCES_REL} 底下找不到任何非生成 .md`);
  return [...dirs].sort();
}

/** 探針要落腳的「主 references 目錄」＝ 直屬 .md 最多的那個目錄（平鋪時就是 references/ 本身）。 */
function primaryReferenceDir(root) {
  const counts = new Map();
  for (const file of listMarkdownIn(root, REFERENCES_REL)) {
    if (GENERATED_REFERENCE_FILE_RE.test(basename(file))) continue;
    const dir = dirname(file);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  if (counts.size === 0) throw new Error(`前置檢查失敗：${REFERENCES_REL} 底下找不到任何非生成 .md`);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

function readText(abs) {
  return readFileSync(abs, 'utf8');
}

function writeText(abs, content) {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function appendLine(abs, line) {
  writeText(abs, `${readText(abs)}\n${line}\n`);
}

/** 換掉 frontmatter 的某個單行欄位；欄位不存在 → 例外（目標形狀變了就該紅）。 */
function replaceFrontmatterField(abs, field, value) {
  const re = new RegExp(`^${field}:.*$`, 'm');
  const text = readText(abs);
  if (!re.test(text)) throw new Error(`前置檢查失敗：${abs} 的 frontmatter 找不到 ${field}: 欄位`);
  writeText(abs, text.replace(re, `${field}: ${value}`));
}

/** frontmatter 保留、body 整段換掉（deep-sync 分叉注入用）。 */
function replaceBody(abs, newBody) {
  const lines = readText(abs).split(/\r?\n/);
  if (lines[0] !== '---') throw new Error(`前置檢查失敗：${abs} 沒有 frontmatter，無法只換 body`);
  const closeIdx = lines.slice(1).findIndex((l) => l === '---');
  if (closeIdx === -1) throw new Error(`前置檢查失敗：${abs} 的 frontmatter 沒有閉合 ---`);
  writeText(abs, `${lines.slice(0, closeIdx + 2).join('\n')}\n${newBody}`);
}

function readJson(abs) {
  return JSON.parse(readText(abs));
}

function writeJson(abs, value) {
  writeText(abs, `${JSON.stringify(value, null, 2)}\n`);
}

// ── 跑 lint ──────────────────────────────────────────────────────────────────

const LINT_RUNNERS = {
  'skill-lint': (root) => buildSkillLintReport(root),
  'compat-lint': (root) => buildCompatLintReport(root, {}),
};

function runLint(tool, root) {
  const runner = LINT_RUNNERS[tool];
  if (!runner) throw new Error(`未知的 lint 工具：${tool}`);
  return runner(root);
}

// ── ①注入軸：每項既有檢查一個真違規 ──────────────────────────────────────────

/**
 * 每個 scenario：
 *   precheck(root) → target 資訊（找不到／不唯一就丟例外，絕不靜默跳過）
 *   apply(root, target) → 真的把違規寫進暫存樹
 *   expect(root, target) → 這次注入該長出什麼 finding／note
 */
export const SCENARIOS = [
  {
    id: 'S1-deep-sync',
    tool: 'skill-lint',
    check: 'deep-sync',
    describe: '把某支 -deep agent 的 body 換成與 base 完全無關的內容（真分叉）',
    precheck(root) {
      const pairs = listDeepPairs(root);
      if (pairs.length === 0) throw new Error(`前置檢查失敗：${AGENTS_REL} 底下找不到任何 X-deep.md ⇄ X.md 配對`);
      return { file: pairs[0].deep };
    },
    apply(root, target) {
      replaceBody(target.file, FORKED_DEEP_BODY);
    },
    expect(root, target) {
      return { kind: 'finding', check: 'deep-sync', includes: [basename(target.file)] };
    },
  },
  {
    id: 'S2-orphan-ref',
    tool: 'skill-lint',
    check: 'orphan-ref',
    describe: '新增一份沒有任何檔案引用的 reference',
    precheck(root) {
      return { file: join(primaryReferenceDir(root), PROBE_ORPHAN_BASENAME) };
    },
    apply(root, target) {
      writeText(target.file, '# 變異探針\n\n這份文件刻意沒有任何引用者。\n');
    },
    expect() {
      return { kind: 'finding', check: 'orphan-ref', includes: [PROBE_ORPHAN_BASENAME] };
    },
  },
  {
    id: 'S3-broken-ref',
    tool: 'skill-lint',
    check: 'broken-ref',
    describe: '在 plugin 文件裡引用一份不存在的 reference',
    precheck(root) {
      return { file: findExactlyOne(root, PLUGIN_DOCS_REL, 'FLOW.md') };
    },
    apply(root, target) {
      appendLine(target.file, `詳見 references/${PROBE_MISSING_REFERENCE}。`);
    },
    expect() {
      return { kind: 'finding', check: 'broken-ref', includes: [PROBE_MISSING_REFERENCE] };
    },
  },
  {
    id: 'S4-duplicate',
    tool: 'skill-lint',
    check: 'duplicate',
    describe: '把一支 agent 的 body 逐字複製到另一支非 base/deep 配對的 agent',
    precheck(root) {
      const files = listAgentFiles(root);
      const set = new Set(files);
      const standalone = files.filter((f) => !f.endsWith('-deep.md') && !set.has(f.replace(/\.md$/, '-deep.md')));
      if (standalone.length < 2) {
        throw new Error(`前置檢查失敗：需要至少 2 支「無 -deep 變體」的 agent 才能製造重複，實際 ${standalone.length} 支`);
      }
      return { source: standalone[0], file: standalone[1] };
    },
    apply(root, target) {
      const sourceBody = readText(target.source).split(/\r?\n---\r?\n/).slice(1).join('\n---\n');
      replaceBody(target.file, sourceBody);
    },
    expect(root, target) {
      return { kind: 'finding', check: 'duplicate', includes: [basename(target.file), basename(target.source)] };
    },
  },
  {
    id: 'S5-footprint',
    tool: 'skill-lint',
    check: 'footprint',
    // footprint 命中在 skill-lint 裡是 informational note（既有債刻意不擋線），
    // 所以這個 scenario 驗的是「有沒有被看見」而不是 exit code —— 掃描面塌陷時 note 一樣會消失。
    describe: '把某支 agent 的 description 灌成超過 500 字元',
    precheck(root) {
      return { file: listAgentFiles(root)[0] };
    },
    apply(root, target) {
      replaceFrontmatterField(target.file, 'description', OVERSIZED_DESCRIPTION);
    },
    expect(root, target) {
      return { kind: 'note', check: 'footprint', includes: [basename(target.file)] };
    },
  },
  {
    id: 'S6-count-drift',
    tool: 'skill-lint',
    check: 'count-drift',
    describe: '在文件裡宣告一個與實際不符的 reference 份數',
    precheck(root) {
      return { file: findExactlyOne(root, PLUGIN_DOCS_REL, 'FLOW.md') };
    },
    apply(root, target) {
      appendLine(target.file, `本 plugin 共 ${PROBE_BOGUS_COUNT} 份 reference。`);
    },
    expect() {
      return { kind: 'finding', check: 'count-drift', includes: [String(PROBE_BOGUS_COUNT)] };
    },
  },
  {
    id: 'S7-dead-command',
    tool: 'skill-lint',
    check: 'dead-command',
    describe: '在文件裡留下已刪除的舊指令名',
    precheck(root) {
      return { file: findExactlyOne(root, PLUGIN_DOCS_REL, 'FLOW.md') };
    },
    apply(root, target) {
      appendLine(target.file, `可用 \`/${PROBE_DEAD_COMMAND}\` 續跑。`);
    },
    expect() {
      return { kind: 'finding', check: 'dead-command', includes: [PROBE_DEAD_COMMAND] };
    },
  },
  {
    id: 'S8-hooks-wiring',
    tool: 'skill-lint',
    check: 'hooks-wiring',
    describe: '把 hooks.json 的某個 command 指向不存在的 hook 檔',
    precheck(root) {
      const file = findExactlyOne(root, HOOKS_REL, 'hooks.json');
      const text = readText(file);
      const re = /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/[\w./-]+\.mjs/;
      if (!re.test(text)) throw new Error(`前置檢查失敗：${file} 找不到任何 \${CLAUDE_PLUGIN_ROOT}/hooks/*.mjs 引用`);
      return { file, re };
    },
    apply(root, target) {
      writeText(target.file, readText(target.file).replace(target.re, `\${CLAUDE_PLUGIN_ROOT}/hooks/${PROBE_MISSING_HOOK}`));
    },
    expect() {
      return { kind: 'finding', check: 'hooks-wiring', includes: [PROBE_MISSING_HOOK] };
    },
  },
  {
    id: 'S9-flag-sync',
    tool: 'skill-lint',
    check: 'flag-sync',
    describe: '把 hook-flags.mjs 檔頭宣告的 flag 總數改成與 FLAG_DEFAULTS 不符的數字',
    precheck(root) {
      const file = findExactlyOne(root, HOOKS_REL, 'hook-flags.mjs');
      const re = /\d+\s*個\s*flag/;
      if (!re.test(readText(file))) throw new Error(`前置檢查失敗：${file} 檔頭找不到「N 個 flag」宣告`);
      return { file, re };
    },
    apply(root, target) {
      writeText(target.file, readText(target.file).replace(target.re, `${PROBE_BOGUS_COUNT} 個 flag`));
    },
    expect() {
      return { kind: 'finding', check: 'flag-sync', includes: [String(PROBE_BOGUS_COUNT)] };
    },
  },
  {
    id: 'C3-platform-tool-name',
    tool: 'compat-lint',
    check: 'platform-tool-name',
    describe: '在 canonical 散文（reference）裡寫死平台專屬工具名',
    precheck(root) {
      return { file: findExactlyOne(root, REFERENCES_REL, 'journaling.md') };
    },
    apply(root, target) {
      appendLine(target.file, `決策時直接呼叫 ${PROBE_PLATFORM_TOOL} 問使用者。`);
    },
    expect(root, target) {
      return { kind: 'finding', check: 'platform-tool-name', includes: [PROBE_PLATFORM_TOOL, basename(target.file)] };
    },
  },
  {
    id: 'C4-agent-model-drift',
    tool: 'compat-lint',
    check: 'C4',
    describe: '把某支手寫 agent 的 frontmatter model 改成與 registry tier 展開值不符',
    precheck(root) {
      const file = findExactlyOne(root, AGENTS_REL, 'referee.md');
      const registry = readJson(findExactlyOne(root, REFERENCES_REL, 'capability-registry.json'));
      const tier = registry?.agent_tiers?.referee;
      const expectedModel = registry?.model_tier?.[tier]?.claude?.model;
      if (expectedModel == null) throw new Error('前置檢查失敗：registry 展不出 referee 的 model_tier.claude.model');
      return { file };
    },
    apply(root, target) {
      replaceFrontmatterField(target.file, 'model', PROBE_WRONG_MODEL);
    },
    expect() {
      return { kind: 'finding', check: 'C4', includes: [PROBE_WRONG_MODEL] };
    },
  },
  {
    id: 'C5-orphan-runtime-span',
    tool: 'compat-lint',
    check: 'C5',
    describe: '在散文裡放一段 registry overrides[] 沒有登記的 runtime scoped span',
    precheck(root) {
      return { file: findExactlyOne(root, REFERENCES_REL, 'journaling.md') };
    },
    apply(root, target) {
      appendLine(target.file, `<!-- runtime: codex id=${PROBE_ORPHAN_SPAN_ID} -->\n未登記的平台專屬規則。\n<!-- /runtime -->`);
    },
    expect() {
      return { kind: 'finding', check: 'C5', includes: [PROBE_ORPHAN_SPAN_ID] };
    },
  },
  {
    id: 'C6-projection-drift',
    tool: 'compat-lint',
    check: 'C6',
    describe: '手改 hooks-codex.json 的 matcher，製造與 hooks.json 投影的漂移',
    precheck(root) {
      const file = findExactlyOne(root, HOOKS_REL, 'hooks-codex.json');
      const json = readJson(file);
      const eventName = Object.keys(json?.hooks ?? {})
        .find((name) => (json.hooks[name] ?? []).some((block) => typeof block?.matcher === 'string'));
      if (!eventName) throw new Error(`前置檢查失敗：${file} 找不到任何帶 matcher 字串的 hook block`);
      return { file, eventName };
    },
    apply(root, target) {
      const json = readJson(target.file);
      const block = json.hooks[target.eventName].find((b) => typeof b?.matcher === 'string');
      block.matcher = PROBE_DRIFT_MATCHER;
      writeJson(target.file, json);
    },
    expect() {
      return { kind: 'finding', check: 'C6', includes: ['drift'] };
    },
  },
];

// ── ②掃描面軸：N-fold probe + 實測下限 ────────────────────────────────────────

// 下限值來源：在**未搬檔**的平鋪樹上實測當前數字後寫死（2026-07 量測，見各 floorSource）。
// 下限是「不得再少」，新增檔案讓實測值上升不會誤紅；掃描面塌陷才會紅。
export const SURFACE_PROBES = [
  {
    id: 'skill-lint-files-scanned',
    tool: 'skill-lint',
    describe: 'skill-lint walk() 掃到的檔案總數',
    floor: 256,
    floorSource: '實測 skill-lint.mjs --json 的 summary.filesScanned = 256（含本檔與其測試加入 scripts/ 後）',
    precheck() { return {}; },
    apply() {},
    measure(report) { return report?.summary?.filesScanned ?? 0; },
  },
  {
    id: 'compat-lint-files-scanned',
    tool: 'compat-lint',
    describe: 'compat-lint 五個 scope 合計掃到的檔案總數（真實模擬中從 83 掉到 31 的那個數字）',
    floor: 82,
    floorSource: '實測 compat-lint.mjs --root . --json 的 summary.filesScanned = 82',
    precheck() { return {}; },
    apply() {},
    measure(report) { return report?.summary?.filesScanned ?? 0; },
  },
  {
    id: 'skill-lint-agent-surface',
    tool: 'skill-lint',
    describe: 'skill-lint 的 agent 判定面（對每一支 agent 灌爆 description，數 footprint note 幾筆）',
    floor: 25,
    floorSource: '實測 agents/ 遞迴 .md = 25 支，全數注入後 footprint note = 25 筆',
    precheck(root) { return { files: listAgentFiles(root) }; },
    apply(root, target) {
      for (const file of target.files) replaceFrontmatterField(file, 'description', OVERSIZED_DESCRIPTION);
    },
    measure(report) {
      return (report?.notes ?? []).filter((n) => n?.check === 'footprint' && String(n.file).includes('/agents/')).length;
    },
  },
  {
    id: 'skill-lint-deep-pair-surface',
    tool: 'skill-lint',
    describe: 'skill-lint 的 base/deep 配對面（對每一支 -deep agent 注入分叉，數 deep-sync finding 幾筆）',
    floor: 4,
    floorSource: '實測 agents/ 遞迴有 4 組 X-deep.md ⇄ X.md 配對，全數注入後 deep-sync finding = 4 筆',
    precheck(root) {
      const pairs = listDeepPairs(root);
      if (pairs.length === 0) throw new Error(`前置檢查失敗：${AGENTS_REL} 底下找不到任何 base/deep 配對`);
      return { pairs };
    },
    apply(root, target) {
      for (const pair of target.pairs) replaceBody(pair.deep, FORKED_DEEP_BODY);
    },
    measure(report) {
      return (report?.findings ?? []).filter((f) => f?.check === 'deep-sync').length;
    },
  },
  {
    id: 'skill-lint-reference-dir-surface',
    tool: 'skill-lint',
    describe: 'skill-lint 的 plugin-reference 判定面（每個放 reference 的目錄各丟一份孤兒探針，數抓到幾份）',
    floor: 1,
    floorSource:
      '實測：非生成的 reference 目錄目前只有 references/ 直屬一層，探針 1 份、抓到 1 份。'
      + '搬檔後 reference 若全落入子目錄而判定面沒跟上，這個數字會掉到 0。',
    precheck(root) { return { dirs: listReferenceDirs(root) }; },
    apply(root, target) {
      for (const dir of target.dirs) {
        writeText(join(dir, PROBE_ORPHAN_BASENAME), '# 變異探針\n\n這份文件刻意沒有任何引用者。\n');
      }
    },
    measure(report) {
      return (report?.findings ?? [])
        .filter((f) => f?.check === 'orphan-ref' && String(f.file).includes(PROBE_ORPHAN_BASENAME)).length;
    },
  },
  {
    id: 'compat-lint-c4-agent-surface',
    tool: 'compat-lint',
    describe: 'compat-lint C4 的 agent 讀取面（對每一支 agent 寫錯 model，數 C4 finding 幾筆）',
    floor: 25,
    floorSource: '實測 agents/ 遞迴 .md = 25 支，全數注入錯 model 後 C4 finding = 25 筆',
    precheck(root) { return { files: listAgentFiles(root) }; },
    apply(root, target) {
      for (const file of target.files) replaceFrontmatterField(file, 'model', PROBE_WRONG_MODEL);
    },
    measure(report) {
      return (report?.findings ?? []).filter((f) => f?.check === 'C4').length;
    },
  },
];

// ── 執行單元：每個 scenario／probe 各拿一份乾淨的暫存副本 ─────────────────────

function withRepoCopy(sourceRoot, fn) {
  const workRoot = copyRepo(sourceRoot);
  try {
    return fn(workRoot);
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

/** 跑單一注入 scenario：複製 → precheck → 注入 → 跑 lint → 判定有沒有被指名抓到。 */
export function runScenario(scenario, sourceRoot) {
  return withRepoCopy(sourceRoot, (workRoot) => {
    const target = scenario.precheck(workRoot);
    scenario.apply(workRoot, target);
    const report = runLint(scenario.tool, workRoot);
    const expectation = scenario.expect(workRoot, target);
    return {
      id: scenario.id,
      tool: scenario.tool,
      check: scenario.check,
      describe: scenario.describe,
      target: toRelPosix(workRoot, target.file ?? workRoot),
      caught: matchesExpectation(report, expectation),
    };
  });
}

/** 跑單一掃描面 probe：複製 → precheck → N-fold 注入 → 跑 lint → 量測實際回報筆數。 */
export function runSurfaceProbe(probe, sourceRoot) {
  return withRepoCopy(sourceRoot, (workRoot) => {
    const target = probe.precheck(workRoot);
    probe.apply(workRoot, target);
    const report = runLint(probe.tool, workRoot);
    return {
      id: probe.id,
      tool: probe.tool,
      describe: probe.describe,
      floor: probe.floor,
      measured: probe.measure(report, target),
    };
  });
}

/** 跑完整套：所有注入 scenario + 所有掃描面 probe，組成報告（--json 與人讀摘要共用）。 */
export function buildReport(sourceRoot, { scenarios = SCENARIOS, probes = SURFACE_PROBES } = {}) {
  const scenarioResults = scenarios.map((s) => runScenario(s, sourceRoot));
  const probeResults = probes.map((p) => runSurfaceProbe(p, sourceRoot));
  return summarize(scenarioResults, probeResults);
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
