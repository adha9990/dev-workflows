#!/usr/bin/env node
// test-canonical-contracts.mjs —— T31（issue #183）：skill discovery 與 resume 的 canonical 格式契約。
// 自帶極簡 harness（`let passed=0; const failed=[]`），不引測試框架、不做 IO 以外的黑箱 spawn
// （本檔全是純函式 + 檔案讀取，用法：node scripts/test-canonical-contracts.mjs，全綠→exit 0）。
//
// 三組契約：
//   A. public entrypoint 清單有單一來源：`skills/` 實際目錄 ⇄ 每個 SKILL.md frontmatter 的 `name`
//      ⇄ `user-invocable` 旗標圈出的「唯一對外入口」（dispatch）三者要對得起來。
//   B. `.loops/<slug>/loop.md` 的 state／Journal 格式有平台無關的 schema 契約——`.loops/` 進
//      .gitignore、CI 沒有真實實例可驗，改用版控內 fixture（scripts/fixtures/canonical-state/）
//      驗必要欄位＋格式規則，並對 evals/baseline/fixtures/ 既有真實樣本的 Journal 區段也跑同一套
//      規則（防「自己寫 schema 自己過」）。
//   C. 可見性有三方對帳：component-registry.json 的 `user_invocable` ⇄ 各元件 frontmatter ⇄ 兩平台
//      manifest（.claude-plugin／.codex-plugin）宣告的入口根，三邊必須一致，只有入口類為 true。
//
// 與 codex-plugin-lint.mjs 的分工（reuse-check：先讀過該檔，不重複實作）：codex-plugin-lint.mjs
// 已驗證 .codex-plugin/plugin.json 與 .claude-plugin/plugin.json 的 name/version/skills 欄位是否
// 同步（見其 manifestEqualityCheck／codexPluginRequiredFieldsCheck）——那條線本檔不重測。本檔只補
// 它沒驗的那條線：「skills/ 目錄實際內容」是否與「manifest 宣告的入口」對得上（manifest 的
// `skills: "./skills/"` 只宣告路徑，不宣告清單內容；哪個 skill 才是使用者看得到的唯一入口，
// manifest 完全不記，只能從 skills/ 樹本身的 frontmatter 推）。

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDescription } from './skill-lint.mjs'; // 重用：SKILL.md frontmatter 解析（name/userInvocable），不重抄
import { loadRegistry, resolveComponent } from './component-resolver.mjs'; // 重用：registry 載入與 id→絕對路徑，不重抄

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const PLUGIN_DIR = join(REPO_ROOT, 'plugins', 'loops-workflow');
const SKILLS_DIR = join(PLUGIN_DIR, 'skills');
const BASELINE_FIXTURES_DIR = join(PLUGIN_DIR, 'evals', 'baseline', 'fixtures');
const CANONICAL_STATE_DIR = join(HERE, 'fixtures', 'canonical-state');
const PLUGIN_REL_PREFIX = 'plugins/loops-workflow/';
const CLAUDE_MANIFEST = join(PLUGIN_DIR, '.claude-plugin', 'plugin.json');
const CODEX_MANIFEST = join(PLUGIN_DIR, '.codex-plugin', 'plugin.json');

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

// ============================================================================
// A) public entrypoint 清單單一來源
// ============================================================================

/** 讀 skills/ 底下每個子目錄的 SKILL.md，回 [{dirName, name, userInvocable}]（讀不到 → name=null）。 */
function readSkillEntries(skillsDir) {
  const dirNames = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  return dirNames.map((dirName) => {
    let content = null;
    try {
      content = readFileSync(join(skillsDir, dirName, 'SKILL.md'), 'utf8');
    } catch {
      // 讀不到 SKILL.md：name 留 null，呼叫端據此判「目錄有、SKILL.md 缺」
    }
    const parsed = content != null ? parseDescription(content) : { name: undefined, userInvocable: undefined };
    return { dirName, name: parsed.name ?? null, userInvocable: parsed.userInvocable };
  });
}

/** 目錄名 ⇄ frontmatter name 一致性：每個 skill 目錄的 SKILL.md `name:` 都要等於資料夾名。 */
function skillNameConsistencyCheck(entries) {
  const findings = [];
  for (const e of entries) {
    if (e.name == null) {
      findings.push({ check: 'skill-name-consistency', dirName: e.dirName, detail: 'SKILL.md 讀不到或缺 frontmatter name 欄位' });
    } else if (e.name !== e.dirName) {
      findings.push({ check: 'skill-name-consistency', dirName: e.dirName, detail: `frontmatter name="${e.name}" 與目錄名不符` });
    }
  }
  return findings;
}

/**
 * 單一對外入口不變式：`user-invocable: false` 是各階段 skill 的顯式旗標（dispatch 才是使用者
 * 唯一該直接呼叫的入口，其餘皆由 dispatch 路由），故「未顯式標 false」（含未寫該欄位）的 skill
 * 數必須恰好 1 個——多於 1 個代表有 skill 忘了標 `user-invocable: false`、少於 1 個代表唯一入口
 * 本身被誤標，兩者都是「入口清單漂移」的訊號。
 */
function singleEntrypointCheck(entries) {
  const entrypoints = entries.filter((e) => e.userInvocable !== false).map((e) => e.dirName);
  return { ok: entrypoints.length === 1, entrypoints };
}

{
  const entries = readSkillEntries(SKILLS_DIR);
  assert(entries.length > 0, '[A0] skills/ 目錄非空（下面所有 A 案例的前提）');

  const nameFindings = skillNameConsistencyCheck(entries);
  assert(nameFindings.length === 0,
    `[A1] 每個 skill 目錄名與 SKILL.md frontmatter name 一致（${entries.length} 個 skill 全過；違規：${JSON.stringify(nameFindings)}）`);

  const { ok, entrypoints } = singleEntrypointCheck(entries);
  assert(ok && entrypoints.length === 1, `[A2] 恰好 1 個 skill 未標 user-invocable:false（實際：${JSON.stringify(entrypoints)}）`);
  assert(entrypoints[0] === 'dispatch', `[A3] 唯一對外入口是 "dispatch"（實際：${entrypoints[0]}）`);
}

// A4：負向案例（不落地成檔案——這兩條規則本身是純函式，用虛構資料直接驗證判定邏輯，不需要
// 另建一份假 skills/ 樹）。
{
  const twoEntrypoints = [
    { dirName: 'dispatch', name: 'dispatch', userInvocable: undefined },
    { dirName: 'goal', name: 'goal', userInvocable: undefined }, // 忘了標 false
  ];
  const r1 = singleEntrypointCheck(twoEntrypoints);
  assert(r1.ok === false && r1.entrypoints.length === 2, '[A4-1] 負向：2 個 skill 都未標 false → singleEntrypointCheck.ok===false（抓到入口清單漂移）');

  const zeroEntrypoints = [
    { dirName: 'dispatch', name: 'dispatch', userInvocable: false }, // 唯一入口被誤標 false
  ];
  const r2 = singleEntrypointCheck(zeroEntrypoints);
  assert(r2.ok === false && r2.entrypoints.length === 0, '[A4-2] 負向：唯一入口被誤標 user-invocable:false → ok===false（0 個入口）');

  const mismatchedName = [{ dirName: 'goal', name: 'goals', userInvocable: false }];
  const r3 = skillNameConsistencyCheck(mismatchedName);
  assert(r3.length === 1, '[A4-3] 負向：frontmatter name 與目錄名不符 → skillNameConsistencyCheck 抓到 1 條 finding');

  const missingName = [{ dirName: 'goal', name: null, userInvocable: false }];
  const r4 = skillNameConsistencyCheck(missingName);
  assert(r4.length === 1 && r4[0].detail.includes('缺'), '[A4-4] 負向：SKILL.md 讀不到 name → skillNameConsistencyCheck 抓到 1 條 finding');
}

// ============================================================================
// B) .loops/<slug>/loop.md canonical state schema
// ============================================================================

// loop.md 建立者寫入的必要索引欄位（見 skills/dispatch/SKILL.md §2；本檔只驗這四個 plan 明點名的
// 欄位，不驗「停止條件雛形」等其餘欄——那些欄位在不同 loop 類型下措辭本就允許差異較大）。
const REQUIRED_HEADER_FIELDS = ['類型', '當前階段', 'session', '推進模式'];
const JOURNAL_HEADING = '## Journal';
// Journal 條目格式採 evals/baseline/fixtures/ 既有真實樣本實際採用的「- E<序號> [<stage>] <說明>」形
// （parseStages 可辨識），非 references/journaling.md prose 範例的「- [E1] ...」形（後者已知與
// parseStages 有格式落差、已回報 team-lead，見 evals fixtures 內註——非本測試修復範圍）。
const JOURNAL_ENTRY_RE = /^- E\d+ \[[a-z][a-z0-9-]*\] .+/;
// Claude Code 內建 Read 工具預設只讀前 2000 行（見本 session 環境說明「By default, it reads up to
// 2000 lines」）；loop.md 是跨 session resume 的唯一入口，若超過這個上限，新 session 讀它時會被
// 靜默截斷、看不到完整 Journal，resume 會依殘缺狀態誤判——故訂為格式規則而非僅風格建議。
const MAX_LINES = 2000;

/** loop.md 必要 header 欄位是否齊全（只掃 `## Journal` 之前的區段，避免 Journal 內文誤判）。 */
function loopMdHeaderCheck(text) {
  const journalIdx = text.indexOf(JOURNAL_HEADING);
  const headerText = journalIdx >= 0 ? text.slice(0, journalIdx) : text;
  const labels = new Set();
  for (const line of headerText.split(/\r?\n/)) {
    const m = line.match(/^- ([^：:]+)[：:]/);
    if (m) labels.add(m[1].trim());
  }

  const findings = [];
  for (const field of REQUIRED_HEADER_FIELDS) {
    if (!labels.has(field)) findings.push({ check: 'loop-md-header', field, detail: `缺少必要欄位「${field}」` });
  }
  if (journalIdx === -1) findings.push({ check: 'loop-md-header', field: 'Journal', detail: `缺少「${JOURNAL_HEADING}」區段標題` });
  return findings;
}

/**
 * Journal 區段內每個「看起來像條目」的行（以 `- ` 起頭）都要符合 JOURNAL_ENTRY_RE。非 `- ` 開頭的行
 * （標題本身、空行、blockquote 附註）不判——本檢查只抓「試圖當條目寫、但格式壞掉」的行，不是強制
 * Journal 區段除了條目什麼都不能有。
 */
function journalEntryFormatCheck(text) {
  const idx = text.indexOf(JOURNAL_HEADING);
  if (idx === -1) return [{ check: 'journal-entry-format', detail: `找不到「${JOURNAL_HEADING}」區段，無法檢查條目格式` }];

  const body = text.slice(idx + JOURNAL_HEADING.length);
  const findings = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('- ')) continue;
    if (!JOURNAL_ENTRY_RE.test(line)) {
      findings.push({ check: 'journal-entry-format', line, detail: 'Journal 條目須符合「- E<序號> [<stage>] <說明>」格式' });
    }
  }
  return findings;
}

/** 每份 loop.md（或本檢查適用的任何 markdown state 檔）行數不得超過 MAX_LINES。 */
function lineCountCheck(text, limit = MAX_LINES) {
  const lineCount = text.split(/\r?\n/).length;
  if (lineCount <= limit) return [];
  return [{ check: 'line-count', detail: `共 ${lineCount} 行，超過上限 ${limit}（Read 工具預設只讀前 ${limit} 行，超過會被靜默截斷）` }];
}

// ── B1：正向 fixture（scripts/fixtures/canonical-state/valid-loop.md）─────────────────
{
  const text = readFileSync(join(CANONICAL_STATE_DIR, 'valid-loop.md'), 'utf8');
  assert(loopMdHeaderCheck(text).length === 0, '[B1-1] 正向 fixture：必要 header 欄位全齊 → 0 findings');
  assert(journalEntryFormatCheck(text).length === 0, '[B1-2] 正向 fixture：Journal 條目全數合規 → 0 findings');
  assert(lineCountCheck(text).length === 0, '[B1-3] 正向 fixture：行數遠低於 2000 → 0 findings');
}

// ── B2：負向 fixture①——缺 session 欄（scripts/fixtures/canonical-state/missing-field-loop.md）──
{
  const text = readFileSync(join(CANONICAL_STATE_DIR, 'missing-field-loop.md'), 'utf8');
  const findings = loopMdHeaderCheck(text);
  assert(findings.length === 1 && findings[0].field === 'session', `[B2] 負向 fixture：缺 session 欄 → loopMdHeaderCheck 抓到 1 條（實際：${JSON.stringify(findings)}）`);
}

// ── B3：負向 fixture②——Journal 條目格式壞掉（scripts/fixtures/canonical-state/malformed-journal-loop.md）──
{
  const text = readFileSync(join(CANONICAL_STATE_DIR, 'malformed-journal-loop.md'), 'utf8');
  assert(loopMdHeaderCheck(text).length === 0, '[B3-1] 負向 fixture②：header 欄位本身合規（隔離出只有 Journal 格式壞掉這一項）');
  const findings = journalEntryFormatCheck(text);
  assert(findings.length === 1, `[B3-2] 負向 fixture②：1 條 Journal 條目格式壞掉 → journalEntryFormatCheck 抓到 1 條（實際：${JSON.stringify(findings)}）`);
}

// ── B4：負向 fixture③——超過 2000 行（不落地成實體大檔，programmatically 產生，避免 repo 塞入
//     一份 2000+ 行的假檔案；行數規則本身與檔案來源無關，純函式直接餵字串即可驗）──────────────
{
  const oversizedText = Array.from({ length: MAX_LINES + 1 }, (_, i) => `line ${i}`).join('\n');
  const findings = lineCountCheck(oversizedText);
  assert(findings.length === 1, `[B4-1] 負向：${MAX_LINES + 1} 行 → lineCountCheck 抓到超限（實際：${JSON.stringify(findings)}）`);

  const exactlyAtLimit = Array.from({ length: MAX_LINES }, (_, i) => `line ${i}`).join('\n');
  assert(lineCountCheck(exactlyAtLimit).length === 0, `[B4-2] 邊界：恰好 ${MAX_LINES} 行 → 不算超限（<=，非 <）`);
}

// ============================================================================
// B5 —— 反自我印證：同一套 Journal 格式規則對 evals/baseline/fixtures/ 既有真實樣本也要成立
// （這些不是本測試造的 fixture，是版控內既有的真實 loop 摘錄——防「自己寫 schema 自己過」）。
// 這些檔案只截了 loop.md 的 `## Journal` 區段（檔頭已用 blockquote 註明是摘錄／重排格式，非完整
// loop.md），故只驗 Journal 格式與行數兩條共通規則，不驗 header 欄位（header 欄位規則只對「完整
// loop.md」成立，這些 fixture 從未宣稱自己是完整 loop.md）。
// ============================================================================
{
  const realFixtureDirs = readdirSync(BASELINE_FIXTURES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== '_shared')
    .map((e) => e.name);
  assert(realFixtureDirs.length >= 3, `[B5-0] evals/baseline/fixtures/ 找得到 >=3 個真實樣本目錄（實際：${realFixtureDirs.length}）`);

  for (const dir of realFixtureDirs) {
    const path = join(BASELINE_FIXTURES_DIR, dir, 'observed-journal.md');
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue; // 該目錄剛好沒有 observed-journal.md（非本檢查範疇的其他種 fixture）→ 略過
    }
    const journalFindings = journalEntryFormatCheck(text);
    assert(journalFindings.length === 0,
      `[B5-1] 真實樣本 ${dir}/observed-journal.md：Journal 條目格式對既有真樣本也成立（0 findings；實際：${JSON.stringify(journalFindings)}）`);
    assert(lineCountCheck(text).length === 0, `[B5-2] 真實樣本 ${dir}/observed-journal.md：行數遠低於 2000`);
  }
}

// ============================================================================
// C) 可見性三方對帳：component-registry 的 user_invocable ⇄ 各元件 frontmatter ⇄ 兩平台 manifest
//
// A 組只看 skills/ 樹自己說了什麼，看不出「registry 宣告的可見性」與「manifest 對外曝光的入口根」
// 有沒有跟著漂。目錄重整（#171）會同時動 registry 的 target_path 與元件實體位置，三邊各自為政就會
// 出現「registry 說某支非入口 skill 是入口 / agent 被標成使用者可直接叫」這種只在執行期才炸的漂移。
// 三邊各是獨立來源，任兩邊對上、第三邊沒對上都要紅，且必須指名是哪個元件、差在哪一邊。
// ============================================================================

const ENTRY_COMPONENT_ID = 'dispatch-skill';
// Claude 平台的 manifest 不寫 skills 欄位（以 plugin 根底下的 skills/ 目錄慣例自動探）；Codex 平台
// 必須明寫（見 codex-plugin-lint.mjs 的 REQUIRED_SKILLS_VALUE）。兩者指的必須是同一個入口根——不同
// 就代表兩平台曝光的入口集合不同，是「同一份 skill 樹、兩種可見性」的漂移。
const SKILLS_ROOT_CONVENTION = './skills/';

/** manifest 宣告（或依平台慣例隱含）的入口根，正規化成 plugin 相對的 `skills/` 形。 */
function manifestSkillsRoot(manifest) {
  const declared = typeof manifest?.skills === 'string' && manifest.skills !== '' ? manifest.skills : SKILLS_ROOT_CONVENTION;
  return declared.replace(/^\.\//, '').replace(/\/?$/, '/');
}

/**
 * 元件 frontmatter 表達的「使用者可直接呼叫」：
 *   - skill：沿用 A 組不變式——`user-invocable: false` 是顯式退出，沒寫就是對外入口。
 *   - agent：subagent 由 skill 派工，必須顯式寫 `user-invocable: true` 才算入口（沒寫＝不是）。
 * 其餘 kind（reference／script／hook／doc／eval）沒有 frontmatter 可宣告可見性，不在本函式範圍。
 */
function frontmatterUserInvocable(kind, parsed) {
  if (kind === 'skill') return parsed.userInvocable !== false;
  return parsed.userInvocable === true;
}

/**
 * 三方對帳（純函式：吃三邊快照、回 findings，不做 IO——負向 fixture 才能餵改過的 registry 副本）。
 * findings 一律帶 component id 與差異描述，讓紅燈直接指名元件而非只說「有東西不一致」。
 */
function visibilityReconciliationCheck({ components, frontmatterById, manifestRoots }) {
  const findings = [];

  const roots = new Set(manifestRoots.map((m) => m.root));
  if (roots.size !== 1) {
    findings.push({
      check: 'manifest-entry-root',
      component: null,
      detail: `兩平台 manifest 宣告的入口根不一致：${manifestRoots.map((m) => `${m.platform}="${m.root}"`).join('、')}`,
    });
  }
  const entryRoot = manifestRoots[0]?.root;

  for (const component of components) {
    const { id, kind, user_invocable: declared, target_path: targetPath } = component;

    if (typeof declared !== 'boolean') {
      findings.push({ check: 'registry-visibility-type', component: id, detail: `user_invocable 不是布林（實際：${JSON.stringify(declared)}）` });
      continue;
    }

    const parsed = frontmatterById.get(id);
    if (parsed) {
      const fromFrontmatter = frontmatterUserInvocable(kind, parsed);
      if (fromFrontmatter !== declared) {
        findings.push({
          check: 'registry-vs-frontmatter',
          component: id,
          detail: `registry user_invocable=${declared}，但 frontmatter 表達的是 ${fromFrontmatter}`,
        });
      }
    }

    if (!declared) continue;

    // 入口類的定義：manifest 對外曝光的入口根底下的 skill。agent／reference／script 等一律不是入口。
    if (kind !== 'skill') {
      findings.push({ check: 'non-entry-kind-invocable', component: id, detail: `kind="${kind}" 不是入口類，卻標了 user_invocable=true` });
      continue;
    }
    const pluginRel = typeof targetPath === 'string' ? targetPath.replace(PLUGIN_REL_PREFIX, '') : '';
    if (entryRoot && !pluginRel.startsWith(entryRoot)) {
      findings.push({
        check: 'entry-outside-manifest-root',
        component: id,
        detail: `user_invocable=true，但 target_path="${targetPath}" 不在 manifest 宣告的入口根 "${entryRoot}" 底下`,
      });
    }
  }

  const entries = components.filter((c) => c.user_invocable === true).map((c) => c.id);
  if (entries.length !== 1) {
    findings.push({ check: 'single-entry-component', component: null, detail: `user_invocable=true 的元件應恰好 1 個（實際：${JSON.stringify(entries)}）` });
  }
  return findings;
}

/** 讀得到 frontmatter 的元件（skill 讀 target_path/SKILL.md，agent 用 resolver 解單一檔）→ Map<id, parsed>。 */
function readComponentFrontmatter(components, root) {
  const byId = new Map();
  for (const component of components) {
    if (component.kind !== 'skill' && component.kind !== 'agent') continue;
    const path = component.kind === 'skill'
      ? join(root, component.target_path, 'SKILL.md')
      : resolveComponent(component.id, { root });
    byId.set(component.id, parseDescription(readFileSync(path, 'utf8')));
  }
  return byId;
}

{
  const { components } = loadRegistry(REPO_ROOT);
  const manifestRoots = [
    { platform: 'claude', root: manifestSkillsRoot(JSON.parse(readFileSync(CLAUDE_MANIFEST, 'utf8'))) },
    { platform: 'codex', root: manifestSkillsRoot(JSON.parse(readFileSync(CODEX_MANIFEST, 'utf8'))) },
  ];
  const frontmatterById = readComponentFrontmatter(components, REPO_ROOT);

  assert(frontmatterById.size >= 30, `[C0] registry 內有 frontmatter 可對帳的 skill/agent 元件 >=30 個（實際：${frontmatterById.size}）`);

  const findings = visibilityReconciliationCheck({ components, frontmatterById, manifestRoots });
  assert(findings.length === 0,
    `[C1] registry user_invocable ⇄ 元件 frontmatter ⇄ 兩平台 manifest 三方一致（${components.length} 個元件全過；違規：${JSON.stringify(findings)}）`);

  const entries = components.filter((c) => c.user_invocable === true).map((c) => c.id);
  assert(entries.length === 1 && entries[0] === ENTRY_COMPONENT_ID,
    `[C2] registry 內唯一入口元件是 "${ENTRY_COMPONENT_ID}"（實際：${JSON.stringify(entries)}）`);

  // C3 負向 fixture：把某支非入口 skill 的 registry 值改成 true（只改記憶體副本，不動版控內 registry）
  // → 必須紅，且指名該元件。
  const tamperedId = 'goal-skill';
  const tampered = components.map((c) => (c.id === tamperedId ? { ...c, user_invocable: true } : c));
  const tamperedFindings = visibilityReconciliationCheck({ components: tampered, frontmatterById, manifestRoots });
  assert(tamperedFindings.some((f) => f.component === tamperedId && f.check === 'registry-vs-frontmatter'),
    `[C3-1] 負向：非入口 skill「${tamperedId}」registry 值被改成 true → 指名該元件報 registry-vs-frontmatter（實際：${JSON.stringify(tamperedFindings)}）`);
  assert(tamperedFindings.some((f) => f.check === 'single-entry-component'),
    '[C3-2] 負向：入口數變成 2 → 同時報 single-entry-component');

  // C4 負向：agent 被標成 user_invocable=true（非入口類）／兩平台 manifest 入口根不一致。
  const agentSample = components.find((c) => c.kind === 'agent');
  const agentTampered = components.map((c) => (c.id === agentSample.id ? { ...c, user_invocable: true } : c));
  const agentFindings = visibilityReconciliationCheck({ components: agentTampered, frontmatterById, manifestRoots });
  assert(agentFindings.some((f) => f.component === agentSample.id && f.check === 'non-entry-kind-invocable'),
    `[C4-1] 負向：agent「${agentSample.id}」被標 user_invocable=true → 報 non-entry-kind-invocable`);

  const splitRoots = [{ platform: 'claude', root: 'skills/' }, { platform: 'codex', root: 'codex-skills/' }];
  const rootFindings = visibilityReconciliationCheck({ components, frontmatterById, manifestRoots: splitRoots });
  assert(rootFindings.some((f) => f.check === 'manifest-entry-root'),
    '[C4-2] 負向：兩平台 manifest 宣告不同入口根 → 報 manifest-entry-root（兩平台可見性漂移）');
}

const total = passed + failed.length;
console.log(`\n${failed.length ? '✗' : '✓'} ${passed} passed, ${failed.length} failed`);
console.log(`(共 ${total} 條斷言：A=入口清單單一來源／B=loop.md canonical state schema／C=可見性三方對帳，含對既有真實樣本反自我印證)`);
process.exit(failed.length > 0 ? 1 : 0);
