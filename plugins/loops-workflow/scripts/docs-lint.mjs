#!/usr/bin/env node
// docs-lint.mjs —— 人類文件與機器事實的一致性閘（#180）。
//
// `AGENTS.md`、skills 與 references 是**給 AI 執行的**；人真正會讀的是 `README.md` 與 `docs/**`。
// 這兩邊很容易漂移：指令改了、來源換了、環境變數改名了，教學卻停在舊版——而讀教學的人不會知道。
//
// 本檔查五件**可機械判定**的事（人的散文不由 compiler 生成，只驗事實）：
//   1. `link` —— 文件裡的相對連結指得到真檔案（死連結是最常見、也最傷的漂移）。
//   2. `command` —— 文件宣傳的 slash 指令必須真的是公開入口（registry 標 `user_invocable: true`）。
//   3. `catalog` —— 文件提到的來源 id 必須在 setup catalog 裡；**且進得了 wizard 的來源都要被寫進教學**
//      （否則使用者在選單看到一個文件沒講的東西）。
//   4. `env` —— 文件提到的 `LOOPS_*` 參數必須真的存在（拿掉的參數留在教學裡比沒寫還糟）。
//   5. `history` —— 文件不得拿**具體的** issue／PR 編號或某條 `.loops/<slug>` 當永久說明；
//      那些會過期，而讀的人無從得知。**寫成通用型樣（`.loops/<slug>/`）是可以的。**
//
// 純函式（各 check 收 `{files, facts}` 回 findings）＋ IO 薄邊界（collect / loadFacts）。
// 依賴：僅 node 內建。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 要掃的人類文件面（相對 repo 根）。刻意**不含** `AGENTS.md`——那是 AI 執行契約，不是人的教學。 */
export const HUMAN_DOC_ROOTS = Object.freeze(['README.md', 'docs', join('plugins', 'loops-workflow', 'docs')]);

/**
 * 掃描面的排除項（逐項附理由，同 check-legacy-paths 的 allowlist 慣例）：
 * `docs/specs/**` 是**歷史設計文件**——描述某個時點的提案（含當時的指令名與單號），凍結為紀錄、
 * 不隨後續演進改寫。拿教學的標準去要求它，只會逼人去改一份本來就該保持原樣的東西。
 */
export const DOC_SCAN_EXCLUDES = Object.freeze([
  { prefix: 'docs/specs/', reason: '歷史設計文件：凍結為某時點的提案紀錄，不是給人讀的教學' },
]);

/**
 * 不套 no-history 規則的檔（逐項附理由）。這些檔**本質就是某一次的紀錄**——把「不要寫具體單號」
 * 套在驗證證據上，只會逼人把證據寫得無法追溯。
 */
export const HISTORY_SKIP = Object.freeze([
  { file: 'docs/CODEX-SMOKE.md', reason: '真機驗證證據紀錄：記的就是某一次跑了什麼、結果如何' },
  { file: 'docs/ACCEPTANCE.md', reason: '最終驗收報告：記的就是某一次全 repo 驗收的實測結果' },
]);

/** 具體歷史的圖樣：這些寫進教學會過期。 */
const HISTORY_PATTERNS = Object.freeze([
  { re: /\.loops\/\d[\w-]*/g, id: 'loops-history', why: '某條具體的 loop 目錄是本地暫存、會被清掉；教學請寫通用型樣 `.loops/<slug>/`' },
  { re: /(?:issue|PR|pull request)\s*#\d+/gi, id: 'ticket-history', why: '具體 issue／PR 編號會過期；教學要自包含，需要舉例請描述情境而不是指單號' },
]);

const MD_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const SLASH_COMMAND = /\/loops-workflow:([a-z][a-z0-9-]*)/g;
const ENV_NAME = /\bLOOPS_[A-Z0-9_]+\b/g;

const norm = (p) => String(p).split('\\').join('/');

// ── 收集（IO 薄邊界）──────────────────────────────────────────────────────

function walkMd(dir, out = []) {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const full = join(dir, name);
    try {
      if (statSync(full).isDirectory()) walkMd(full, out);
      else if (name.endsWith('.md')) out.push(full);
    } catch { /* 單一項目失敗跳過 */ }
  }
  return out;
}

/** 收集要掃的人類文件 → `[{rel, abs, text}]`。 */
export function collectHumanDocs(root) {
  const files = [];
  for (const entry of HUMAN_DOC_ROOTS) {
    const abs = join(root, entry);
    if (!existsSync(abs)) continue;
    const list = statSync(abs).isDirectory() ? walkMd(abs) : [abs];
    for (const f of list) {
      const rel = norm(relative(root, f));
      if (DOC_SCAN_EXCLUDES.some((x) => rel.startsWith(x.prefix))) continue;
      try { files.push({ rel, abs: f, text: readFileSync(f, 'utf8') }); } catch { /* 讀不到就跳過 */ }
    }
  }
  return files;
}

/** 讀機器事實：公開指令、來源 catalog、環境變數。 */
export function loadFacts(root) {
  const readJson = (rel) => { try { return JSON.parse(readFileSync(join(root, rel), 'utf8')); } catch { return null; } };
  const components = readJson('plugins/loops-workflow/references/component-registry.json');
  const catalog = readJson('plugins/loops-workflow/references/setup-catalog.json');
  const integrations = readJson('plugins/loops-workflow/references/integration-registry.json');

  const publicCommands = new Set((components?.components ?? [])
    .filter((c) => c.user_invocable === true && c.kind === 'skill')
    .map((c) => String(c.target_path ?? '').split('/').pop())
    .filter(Boolean));

  let envNames = new Set();
  try {
    const flags = readFileSync(join(root, 'plugins/loops-workflow/hooks/hook-flags.mjs'), 'utf8');
    envNames = new Set(flags.match(ENV_NAME) ?? []);
  } catch { /* 讀不到就當空集合，下面的檢查會因此不報（fail-open，不製造假紅） */ }
  try {
    const settings = readFileSync(join(root, 'plugins/loops-workflow/docs/settings.md'), 'utf8');
    for (const n of settings.match(ENV_NAME) ?? []) envNames.add(n);
  } catch { /* 同上 */ }

  return { publicCommands, catalog, integrations, envNames };
}

// ── 各 check（純函式）──────────────────────────────────────────────────────

const finding = (check, file, detail) => ({ check, severity: 'P1', file, detail });

/** 相對連結指得到真檔案（外部 URL 與純錨點跳過）。 */
export function checkLinks(files, root) {
  const out = [];
  for (const f of files) {
    for (const m of f.text.matchAll(MD_LINK)) {
      const target = m[1];
      if (/^(?:https?:|mailto:|#)/.test(target)) continue;
      const [pathPart] = target.split('#');
      if (!pathPart) continue;
      const abs = resolve(dirname(f.abs), pathPart);
      if (!existsSync(abs)) out.push(finding('doc-link', f.rel, `連結指不到檔案：${target}`));
    }
  }
  return out;
}

/** 文件宣傳的 slash 指令必須真的是公開入口。 */
export function checkCommands(files, facts) {
  const out = [];
  if (!facts.publicCommands || facts.publicCommands.size === 0) return out; // 讀不到事實就不製造假紅
  for (const f of files) {
    for (const m of f.text.matchAll(SLASH_COMMAND)) {
      if (!facts.publicCommands.has(m[1])) {
        out.push(finding('doc-command', f.rel, `文件寫了 /loops-workflow:${m[1]}，但它不是公開入口（公開的只有：${[...facts.publicCommands].sort().join('、')}）`));
      }
    }
  }
  return out;
}

/**
 * 來源 catalog 與教學雙向對齊：
 *   · 文件提到的來源 id 必須存在；
 *   · **進得了 wizard 的來源都要在教學裡被提到**——否則使用者在選單看到一個文件沒講的東西。
 */
export function checkCatalog(files, facts, { guideFile = 'docs/SETUP-GUIDE.md' } = {}) {
  const out = [];
  const entries = facts.catalog?.entries ?? [];
  if (!entries.length) return out;
  const ids = new Set(entries.map((e) => e.id));
  const guide = files.find((f) => f.rel === guideFile);

  // 「提到不存在的來源」只在**安裝教學**裡查。別處出現的相似字面多半是**衍生名稱**
  // （驗收項目 `skill-optimizer-run`、`prompt-eval-full` 之類），那不是在宣稱有這個來源；
  // 用前綴啟發式去全 repo 抓，只會製造偽陽性，然後大家學會忽略這道閘。
  if (guide) {
    for (const m of guide.text.matchAll(/`([a-z][a-z0-9-]{3,})`/g)) {
      const token = m[1];
      if (!/^(?:code-graph|prompt-eval|token-optimizer|skill-optimizer|symbol-aware)/.test(token)) continue;
      if (!ids.has(token)) out.push(finding('doc-catalog', guideFile, `安裝教學提到來源 \`${token}\`，但它不在 setup catalog 內`));
    }
  }
  if (guide) {
    const offered = entries.filter((e) => e.qualification === null).map((e) => e.id);
    for (const id of offered) {
      if (!guide.text.includes(id)) out.push(finding('doc-catalog', guideFile, `來源 \`${id}\` 會出現在 wizard 選單，但教學沒提到它`));
    }
  }
  return out;
}

/** 文件提到的環境變數必須真的存在。 */
export function checkEnvNames(files, facts) {
  const out = [];
  if (!facts.envNames || facts.envNames.size === 0) return out;
  for (const f of files) {
    for (const name of new Set(f.text.match(ENV_NAME) ?? [])) {
      if (!facts.envNames.has(name)) out.push(finding('doc-env', f.rel, `文件提到 ${name}，但它不在 hook-flags 或參數總覽裡（拿掉的參數留在教學裡比沒寫還糟）`));
    }
  }
  return out;
}

/** 文件不得拿具體的 issue／PR 編號或某條 loop 當永久說明。 */
export function checkNoHistory(files, { skip = [] } = {}) {
  const out = [];
  for (const f of files) {
    if (skip.includes(f.rel)) continue;
    const stripped = stripCodeAndLinks(f.text);
    for (const { re, id, why } of HISTORY_PATTERNS) {
      for (const m of new Set(stripped.match(re) ?? [])) {
        out.push(finding('doc-history', f.rel, `${id}：出現「${m}」——${why}`));
      }
    }
  }
  return out;
}

/** 去掉 code fence／inline code 與連結目標（那些是路徑與範例，不是散文主張）。 */
export function stripCodeAndLinks(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(MD_LINK, (m, target) => m.replace(target, ''));
}

/** 全部檢查。 */
export function buildReport(root, { skipHistory = [] } = {}) {
  const files = collectHumanDocs(root);
  const facts = loadFacts(root);
  const findings = [
    ...checkLinks(files, root),
    ...checkCommands(files, facts),
    ...checkCatalog(files, facts),
    ...checkEnvNames(files, facts),
    ...checkNoHistory(files, { skip: skipHistory }),
  ];
  return { ok: findings.length === 0, findings, scanned: files.length };
}

/** 人讀摘要。 */
export function formatSummary(report) {
  if (report.ok) return `✓ docs-lint：${report.scanned} 份人類文件全綠，無 finding。`;
  return [`✗ docs-lint：${report.scanned} 份人類文件，${report.findings.length} 個 finding。`,
    ...report.findings.map((f) => `  ✗ [${f.check}] ${f.file} — ${f.detail}`)].join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function main() {
  const args = process.argv.slice(2);
  const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : repoRoot();
  const report = buildReport(root, { skipHistory: HISTORY_SKIP.map((x) => x.file) });
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${formatSummary(report)}\n`);
  return report.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
