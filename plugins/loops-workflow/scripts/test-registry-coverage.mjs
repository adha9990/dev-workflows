#!/usr/bin/env node
// test-registry-coverage.mjs —— 三份 registry 對「真實 repo 現況」的覆蓋率地板（#170 T11）。
//
// 為什麼不是「compiler 對真實資料零 finding」就好：那是負向指標——registry 填得越空越容易綠。
// dependencies/consumers 填 [] ⇒ 雙向一致恆真、cycle 永不觸發、傳遞閉包退化成直接命中；
// required_checks 四桶全空 ⇒ 路徑檢查恆真、波及面查詢對「命中的元件」回一份空清單；
// projection/tests 填 [] ⇒ dangling 恆真。compiler 的 unmatched[] 只擋「路徑沒對上元件」，
// 擋不住「對上了元件、但該元件沒宣告任何必跑檢查」——後者是更隱蔽的同型假綠，本檔的 D 組專擋它。
//
// 七組地板，每一組都能被「把 registry 填空」打紅：
//   A. hooks/*.mjs 的每一支非測試 hook 都要被某個 component 的 paths 或 required_checks.hooks 涵蓋。
//      刻意不留「純函式葉節點」的豁免名單：葉節點（hook-flags／hook-decision-emit／
//      hook-input-normalize／atomic-write）正是 guard 全家的共同依賴，漏登記它們，波及面查詢會
//      對「改了葉節點」這種最該擴散的改動回出最窄的答案。豁免名單也是假綠的入口，一格都不開。
//   B. AGENTS.md §2 的每一條 Operating Rule 都對得到唯一一筆 policy（以 projection_marker 落在
//      該條規則的正文裡為綁定），且該筆的 projection 與 tests 皆非空（宣告了規則卻沒人守＝空宣告）。
//   C. repo 內測試檔被 registry 反查得到的比例 ≥ 地板（見 TEST_COVERAGE_FLOOR 的定法）。
//   D. 每個 component 被動到時都真的有事要做：closure 內要嘛有必跑的 hooks/evals/docs，
//      要嘛含一個測試元件——擋「對上元件卻沒宣告任何檢查」。
//   E. 變異斷言：拿掉 consumers 邊，--affected 的答案必須變小。E1 逐元件窮舉（每個有 consumers 的
//      元件都被驗到），E2 是一條具名邊的定點對照（連 required_checks 桶也要跟著縮）。
//      若拿掉邊之後答案沒變小 ⇒ 那條邊根本沒被傳遞閉包用到 ⇒ 紅。
//   F. 端到端煙霧：以子行程跑真正的 CLI（不是 import 純函式），驗波及面查詢在真實資料上有意義——
//      已登記路徑查得到下游必跑測試、未登記路徑落進 unmatched、查詢模式 exit code 一律 0。
//      A–E 都在行程內呼叫函式，繞過了 CLI 的參數解析與輸出格式；F 補的正是那一段。
//   G. skills／agents／references 的逐檔枚舉地板（#171 T1）：遞迴枚舉磁碟上的實檔，逐檔斷言
//      「恰好被一個 component 逐字登記」。A–E 全是「已登記的東西之間關係對不對」，對「整片檔案
//      根本沒進 registry」零鑑別力——實測在一棵所有路徑都失效的樹上，A–F 仍然全綠，因為地板只管
//      hooks 與測試檔。G 另外擋 glob 分組：一個 id 用 references/*.md 蓋掉 57 份檔，波及面對
//      「改了其中一份」只答得出整包，等於沒有解析度，所以要求 paths 逐字列出該檔（skill 是目錄
//      元件，要求逐字列出該 skill 自己的目錄 glob、且不兼管別的 skill）。順帶驗三個 #171 欄位
//      （owner_class／target_path／user_invocable）與反向的「registry 每條 path 都對得到實體檔案」。
//
// 用法：node scripts/test-registry-coverage.mjs（全綠 → exit 0）。自帶極簡 harness、不引測試框架。
// 重用（不重造）：glob 比對與傳遞閉包一律走 registry-compiler.mjs 已 export 的 computeAffected，
// JSON 解析走 check-registry-shape.mjs 已 export 的 parseRegistryJson。

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { computeAffected, globCovers } from './registry-compiler.mjs';
import { parseRegistryJson } from './check-registry-shape.mjs';
import { parseDescription } from './skill-lint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const HOOKS_DIR = join(REPO_ROOT, 'plugins', 'loops-workflow', 'hooks');
const REFERENCES_REL = 'plugins/loops-workflow/references';
const AGENTS_REL = 'AGENTS.md';

// C 組地板：本次實測為 49/49 = 100%（測試檔＝plugins/ 底下非 fixture 的 test-*.mjs）。
// 地板取 0.8 而不是 1.0，是留一格緩衝給「新測試檔已進 repo、registry 還沒補上」的短暫落差，
// 不必每加一支測試就紅；但只要有人把 registry 的 paths／required_checks 清空，比例會直接掉到 0，
// 遠低於地板。地板永遠低於實測值才有意義——調高 registry 覆蓋後可同步調高本常數。
const TEST_COVERAGE_FLOOR = 0.8;

// E2 定點對照用的具名邊：pr-gate 是 merge-guard／pr-owner-guard 的共同上游（兩者都 import 它），
// 拿掉這條 consumers 邊，改到 pr-gate.mjs 就不該再被告知要跑 test-merge-guard.mjs。
const NAMED_EDGE = { from: 'pr-gate', to: 'merge-guard' };
const NAMED_EDGE_PROBE = 'plugins/loops-workflow/hooks/pr-gate.mjs';
const NAMED_EDGE_LOST_CHECK = 'plugins/loops-workflow/hooks/test-merge-guard.mjs';

const REQUIRED_CHECK_PATH_BUCKETS = ['hooks', 'evals', 'docs'];

// G 組：逐檔枚舉的三棵樹。
const PLUGIN_REL = 'plugins/loops-workflow';
const SKILLS_REL = `${PLUGIN_REL}/skills`;
const AGENTS_DIR_REL = `${PLUGIN_REL}/agents`;
const REFERENCES_TREE_REL = `${PLUGIN_REL}/references`;
// 掃到的檔數地板（實測 11／25／74）。取「不得少於」而非「恰等於」：新增一支 skill／agent／
// reference 不該讓這裡紅，該紅的是「它沒被登記」——那由逐檔斷言負責，一漏就指名檔案。
// 掃成 0（掃錯目錄）會讓逐檔斷言一條都不跑、整組退化成空綠，所以這條下界必須在。
const SKILL_FLOOR = 11;
const AGENT_FLOOR = 25;
const REFERENCE_FLOOR = 74;
// #171 T1b 的 owner 分類值域（skills 不搬目錄，分類只記在 registry）。
const OWNER_CLASSES = {
  skill: ['entrypoint', 'stage', 'support'],
  agent: ['build', 'verify-core', 'verify-conditional', 'verify-validation', 'eval'],
  reference: ['stage', 'persona', 'shared-runtime', 'shared-quality', 'shared-delivery', 'shared-docs', 'shared-capability'],
};
// G6 走訪整棵 repo 時略過的目錄：版控內部、外部套件、執行期狀態、worktree 巢狀 checkout。
const WALK_SKIP_DIRS = new Set(['.git', 'node_modules', '.loops', '.claude']);

// F 組煙霧探針。
// 已登記端取 merge-guard.mjs：它有下游 consumers，答案不會退化成「只有自己」。
const SMOKE_REGISTERED_PROBE = 'plugins/loops-workflow/hooks/merge-guard.mjs';
const SMOKE_EXPECTED_CHECK = 'plugins/loops-workflow/hooks/test-merge-guard.mjs';
// 未登記端刻意挑一條本 repo 不存在、也不落在任何 component glob 底下的路徑；
// 真有人把這個前綴登記進 registry，F2 會紅，換一條沒人要的前綴即可。
const SMOKE_UNREGISTERED_PROBE = 'unregistered/example.txt';
const REGISTRY_COMPILER = join(HERE, 'registry-compiler.mjs');

let passed = 0;
const failed = [];

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
    return;
  }
  failed.push(msg);
  console.error(`  ✗ ${msg}`);
}

/** 讀一份 registry；讀不到或壞掉一律當紅（回 null，呼叫端立刻 assert 失敗）。 */
function loadRegistry(rel) {
  try {
    const parsed = parseRegistryJson(readFileSync(join(REPO_ROOT, ...rel.split('/')), 'utf8'));
    return parsed.error ? null : parsed.registry;
  } catch {
    return null;
  }
}

const policyRegistry = loadRegistry(`${REFERENCES_REL}/policy-registry.json`);
const componentRegistry = loadRegistry(`${REFERENCES_REL}/component-registry.json`);
const integrationRegistry = loadRegistry(`${REFERENCES_REL}/integration-registry.json`);

console.log('\n[0] 三份 registry 都讀得到、都有內容');
assert(Array.isArray(policyRegistry?.policies) && policyRegistry.policies.length > 0, 'policy-registry 有登記內容');
assert(Array.isArray(componentRegistry?.components) && componentRegistry.components.length > 0, 'component-registry 有登記內容');
assert(Array.isArray(integrationRegistry?.integrations) && integrationRegistry.integrations.length > 0, 'integration-registry 有登記內容');

const components = componentRegistry?.components ?? [];
const policies = policyRegistry?.policies ?? [];

// ── 共用查詢 ─────────────────────────────────────────────────────────────────

/** 某條路徑被哪些 component 的 paths 擁有（glob 判定重用 computeAffected，consumers 先清空避免混入閉包）。 */
function ownersOf(path) {
  return components.filter((component) => computeAffected(
    { components: [{ ...component, consumers: [] }] },
    [path],
  ).components.length > 0);
}

/** required_checks 三個路徑桶攤平成一組 repo 相對路徑（integrations 是 id、不是路徑，不在此列）。 */
function declaredCheckPaths() {
  const paths = new Set();
  for (const component of components) {
    for (const bucket of REQUIRED_CHECK_PATH_BUCKETS) {
      for (const entry of component?.required_checks?.[bucket] ?? []) paths.add(entry);
    }
  }
  return paths;
}

const CHECK_PATHS = declaredCheckPaths();

/** 一條路徑是否被 registry 反查得到：被某個 component 的 paths 涵蓋，或被列為某個必跑檢查。 */
function isRegistered(path) {
  return CHECK_PATHS.has(path) || ownersOf(path).length > 0;
}

// ── A. 每一支非測試 hook 都要被登記 ───────────────────────────────────────────

console.log('\n[A] hooks/*.mjs 的每一支非測試 hook 都被 registry 涵蓋');
const productionHooks = readdirSync(HOOKS_DIR)
  .filter((name) => name.endsWith('.mjs') && !name.startsWith('test-'))
  .sort();
assert(productionHooks.length > 0, `掃到 ${productionHooks.length} 支非測試 hook（掃不到就是掃錯目錄）`);
for (const name of productionHooks) {
  const rel = `plugins/loops-workflow/hooks/${name}`;
  assert(isRegistered(rel), `hook 已登記：${name}`);
}

// ── B. AGENTS.md 的每一條規則都有非空的 policy 承載 ───────────────────────────

/**
 * 取 AGENTS.md §2 Operating Rules 的逐條正文。
 * 起點是 `## 2. Operating Rules` 標題行，終點是規則清單後的失敗模式引言／下一個小節標題——
 * 不切乾淨的話，規則 13 的區塊會把後面重述 Metric-Honesty 的段落吃進去，marker 綁定就會錯位。
 */
function readOperatingRules() {
  const lines = readFileSync(join(REPO_ROOT, AGENTS_REL), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => /^## 2\. Operating Rules/.test(line));
  if (start === -1) return [];

  const blocks = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^(### |> \*\*兩個)/.test(line)) break;
    const head = line.match(/^(\d+)\.\s+(.*)$/);
    if (head) {
      current = { number: Number(head[1]), text: head[2] };
      blocks.push(current);
      continue;
    }
    if (current) current.text += `\n${line}`;
  }
  return blocks;
}

console.log('\n[B] AGENTS.md 的每一條 Operating Rule 都有非空的 policy 承載');
const rules = readOperatingRules();
// 16 條：#173 把三條原本只寫在 flag 表裡的擋人規則（合併回主幹要人按／draft→ready 是 owner 動作／
// 不得放寬 linter 設定）補進 §2 —— 它們本來就有 hook 在擋，卻沒有 canonical 正文，正是「多份文件
// 各寫一份、互相漂移」要治的形狀。#215 再補一條「一個行為一份主證據」（evidence portfolio 主幹，
// 一條規則承載五個 policy marker）。#218 再補一條「同一條 loop 的共同事實只探索一次」（共享記憶：
// 共享事實不共享結論、沒有 provenance 就不是 valid）。改這個數字是刻意的一次提交，不是意外漂移。
assert(rules.length === 24, `AGENTS.md §2 解析出 ${rules.length} 條 Operating Rule（預期 24 條）`);
assert(
  rules.every((rule, index) => rule.number === index + 1),
  '規則編號連續、無跳號（解析沒漏塊）',
);
assert(policies.length >= rules.length, `policy 筆數 ${policies.length} ≥ 規則條數 ${rules.length}`);

const matchedRuleNumbers = new Set();
for (const policy of policies) {
  const marker = policy?.projection_marker ?? policy?.id;
  const hits = rules.filter((rule) => typeof marker === 'string' && marker !== '' && rule.text.includes(marker));
  assert(
    hits.length === 1,
    `policy "${policy?.id}" 的 projection_marker 恰好落在一條規則正文裡（命中 ${hits.length} 條）`,
  );
  if (hits.length === 1) matchedRuleNumbers.add(hits[0].number);

  assert(
    Array.isArray(policy?.projection) && policy.projection.length > 0,
    `policy "${policy?.id}" 的 projection 非空`,
  );
  assert(
    Array.isArray(policy?.tests) && policy.tests.length > 0,
    `policy "${policy?.id}" 的 tests 非空（宣告了規則卻沒有任何測試承載＝空宣告）`,
  );
}
for (const rule of rules) {
  assert(matchedRuleNumbers.has(rule.number), `AGENTS.md 規則 ${rule.number} 有對應的 policy`);
}

// ── C. 測試檔覆蓋率地板 ───────────────────────────────────────────────────────

/** 掃 plugins/ 底下所有非 fixture 的 test-*.mjs（fixture 目錄裡的是素材、不是測試入口）。 */
function collectTestFiles(dirRel) {
  const out = [];
  for (const entry of readdirSync(join(REPO_ROOT, ...dirRel.split('/')), { withFileTypes: true })) {
    const rel = `${dirRel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'fixtures' || entry.name === 'node_modules') continue;
      out.push(...collectTestFiles(rel));
      continue;
    }
    if (entry.name.startsWith('test-') && entry.name.endsWith('.mjs')) out.push(rel);
  }
  return out;
}

console.log('\n[C] 測試檔被 registry 反查得到的比例 ≥ 地板');
const testFiles = collectTestFiles('plugins');
const uncovered = testFiles.filter((rel) => !isRegistered(rel));
const ratio = testFiles.length === 0 ? 0 : (testFiles.length - uncovered.length) / testFiles.length;
console.log(`    實測：${testFiles.length - uncovered.length}/${testFiles.length} = ${(ratio * 100).toFixed(1)}%（地板 ${TEST_COVERAGE_FLOOR * 100}%）`);
if (uncovered.length > 0) console.log(`    未覆蓋：${uncovered.join('、')}`);
assert(testFiles.length >= 40, `掃到 ${testFiles.length} 個測試檔（掃不到就是掃錯目錄）`);
assert(ratio >= TEST_COVERAGE_FLOOR, `測試檔覆蓋率 ${(ratio * 100).toFixed(1)}% ≥ 地板 ${TEST_COVERAGE_FLOOR * 100}%`);

// ── D. 命中元件必須真的有事要做 ───────────────────────────────────────────────

/** component 的第一條 path 當探針；glob 本身也能被 globCovers 逐字命中，不必展開成實體檔案。 */
function probeOf(component) {
  return component?.paths?.[0] ?? '';
}

console.log('\n[D] 每個 component 被動到時都有必跑的檢查（擋「對上元件卻回空清單」）');
for (const component of components) {
  const affected = computeAffected(componentRegistry, [probeOf(component)]);
  const hasCheck = REQUIRED_CHECK_PATH_BUCKETS.some((bucket) => affected[bucket].length > 0);
  const hasTestComponent = affected.components.some((id) => id.endsWith('-tests'));
  assert(
    hasCheck || hasTestComponent,
    `component "${component?.id}" 的波及面含必跑檢查或測試元件`,
  );
}

// ── E. 變異斷言：拿掉 consumers 邊，答案必須變小 ──────────────────────────────

/** 在記憶體改一份 registry 副本：把 mutate(component) 套到指定 id 上，原檔不動。 */
function mutatedRegistry(id, mutate) {
  return {
    ...componentRegistry,
    components: components.map((component) => (component.id === id ? mutate(component) : component)),
  };
}

console.log('\n[E1] 逐元件窮舉：拿掉某元件全部 consumers 邊，對它自己的路徑查詢必須變小');
for (const component of components) {
  const consumers = component?.consumers ?? [];
  if (consumers.length === 0) continue;

  const probe = probeOf(component);
  const owners = ownersOf(probe);
  const before = computeAffected(componentRegistry, [probe]).components;
  const after = computeAffected(
    mutatedRegistry(component.id, (c) => ({ ...c, consumers: [] })),
    [probe],
  ).components;
  const detail = owners.length > 1 ? `（探針另有共同擁有者：${owners.map((o) => o.id).join('、')}）` : '';
  assert(
    after.length < before.length,
    `拿掉 "${component.id}" 的 consumers 後波及面變小：${before.length} → ${after.length}${detail}`,
  );
}

console.log('\n[E2] 定點對照：拿掉一條具名 consumers 邊，必跑檢查也要跟著縮');
const namedBefore = computeAffected(componentRegistry, [NAMED_EDGE_PROBE]);
const namedAfter = computeAffected(
  mutatedRegistry(NAMED_EDGE.from, (c) => ({
    ...c,
    consumers: (c.consumers ?? []).filter((id) => id !== NAMED_EDGE.to),
  })),
  [NAMED_EDGE_PROBE],
);
assert(
  namedBefore.components.includes(NAMED_EDGE.to),
  `基準線：${NAMED_EDGE_PROBE} 的波及面含 "${NAMED_EDGE.to}"`,
);
assert(
  namedAfter.components.length < namedBefore.components.length,
  `拿掉 "${NAMED_EDGE.from}" → "${NAMED_EDGE.to}" 這條邊後元件數變小：${namedBefore.components.length} → ${namedAfter.components.length}`,
);
assert(
  namedBefore.hooks.includes(NAMED_EDGE_LOST_CHECK) && !namedAfter.hooks.includes(NAMED_EDGE_LOST_CHECK),
  `拿掉該邊後 required_checks.hooks 少掉 ${NAMED_EDGE_LOST_CHECK}（證明閉包真的在收集下游檢查）`,
);

// ── F. 端到端煙霧：真的把 CLI 跑起來 ──────────────────────────────────────────

/** 以子行程跑 registry-compiler 的波及面查詢，回 exit code、stdout 與（JSON 模式的）解析結果。 */
function runAffectedCli(paths, { json = false } = {}) {
  const args = [REGISTRY_COMPILER, '--root', REPO_ROOT, '--affected', paths.join(',')];
  if (json) args.push('--json');
  const res = spawnSync(process.execPath, args, { encoding: 'utf8' });
  let parsed = null;
  if (json) {
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      parsed = null;
    }
  }
  return { code: res.status, stdout: res.stdout ?? '', parsed };
}

console.log('\n[F] 端到端煙霧：波及面查詢在真實資料上有意義');

const smokeRegistered = runAffectedCli([SMOKE_REGISTERED_PROBE], { json: true });
assert(smokeRegistered.code === 0, `F1：查詢已登記路徑 exit code 為 0（實際：${smokeRegistered.code}）`);
assert(smokeRegistered.parsed !== null, 'F1：--json 輸出是可解析的 JSON');
assert(
  (smokeRegistered.parsed?.hooks ?? []).includes(SMOKE_EXPECTED_CHECK),
  `F1：改 ${SMOKE_REGISTERED_PROBE} 會被告知要跑 ${SMOKE_EXPECTED_CHECK}（實際：${JSON.stringify(smokeRegistered.parsed?.hooks ?? [])}）`,
);
assert(
  (smokeRegistered.parsed?.unmatched ?? [SMOKE_REGISTERED_PROBE]).length === 0,
  `F1：已登記路徑不該落進 unmatched（實際：${JSON.stringify(smokeRegistered.parsed?.unmatched ?? [])}）`,
);

const smokeText = runAffectedCli([SMOKE_REGISTERED_PROBE]);
assert(smokeText.code === 0, `F2：文字模式 exit code 為 0（實際：${smokeText.code}）`);
assert(
  smokeText.stdout.includes(SMOKE_EXPECTED_CHECK),
  `F2：文字輸出也點名 ${SMOKE_EXPECTED_CHECK}（人讀的那份不能比 JSON 少講）`,
);

const smokeMixed = runAffectedCli([SMOKE_REGISTERED_PROBE, SMOKE_UNREGISTERED_PROBE], { json: true });
assert(smokeMixed.code === 0, `F3：混入未登記路徑後 exit code 仍為 0——查詢模式不是 lint（實際：${smokeMixed.code}）`);
assert(
  (smokeMixed.parsed?.unmatched ?? []).includes(SMOKE_UNREGISTERED_PROBE),
  `F3：未登記路徑 ${SMOKE_UNREGISTERED_PROBE} 出現在 unmatched（實際：${JSON.stringify(smokeMixed.parsed?.unmatched ?? [])}）`,
);
assert(
  (smokeMixed.parsed?.hooks ?? []).includes(SMOKE_EXPECTED_CHECK),
  'F3：未登記路徑不會淹掉同批已登記路徑的答案',
);

// ── G. skills／agents／references 逐檔枚舉地板 ─────────────────────────────────

/** 遞迴枚舉某棵樹底下符合 keep(檔名) 的實檔，回 repo 相對路徑。 */
function collectFiles(dirRel, keep) {
  const out = [];
  for (const entry of readdirSync(join(REPO_ROOT, ...dirRel.split('/')), { withFileTypes: true })) {
    const rel = `${dirRel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (WALK_SKIP_DIRS.has(entry.name)) continue;
      out.push(...collectFiles(rel, keep));
      continue;
    }
    if (keep(entry.name, rel)) out.push(rel);
  }
  return out.sort();
}

const skillFiles = collectFiles(SKILLS_REL, (name) => name === 'SKILL.md');
const agentFiles = collectFiles(AGENTS_DIR_REL, (name) => name.endsWith('.md'));
const referenceFiles = collectFiles(REFERENCES_TREE_REL, (name) => name.endsWith('.md'));

console.log('\n[G1] 三棵樹掃得到東西（掃不到就是掃錯目錄，逐檔斷言會整組退化成空綠）');
assert(skillFiles.length >= SKILL_FLOOR, `掃到 ${skillFiles.length} 個 SKILL.md（地板 ${SKILL_FLOOR}）`);
assert(agentFiles.length >= AGENT_FLOOR, `掃到 ${agentFiles.length} 支 agent（地板 ${AGENT_FLOOR}）`);
assert(referenceFiles.length >= REFERENCE_FLOOR, `掃到 ${referenceFiles.length} 份 reference（地板 ${REFERENCE_FLOOR}）`);

/**
 * 逐檔斷言：恰好一個 component 擁有它，且那個 component 是「逐字登記」這個檔——
 * 檔案元件要求 paths 逐字列出該路徑；skill 是目錄元件，要求逐字列出自己的目錄 glob 且只列它。
 * 只驗「被某個 glob 蓋到」不夠：references/*.md 這種一網打盡的寫法也蓋得到，
 * 而那正是本組要擋的東西（波及面對「改了其中一份」只答得出整包）。
 */
function assertExactlyRegistered(rel, { expectedPaths, kindLabel }) {
  const owners = ownersOf(rel);
  if (owners.length !== 1) {
    assert(false, `${kindLabel} ${rel} 恰好被一個 component 擁有（實際 ${owners.length} 個：${owners.map((o) => o.id).join('、') || '無'}）`);
    return null;
  }
  const owner = owners[0];
  const paths = owner.paths ?? [];
  assert(
    expectedPaths.length === paths.length && expectedPaths.every((p) => paths.includes(p)),
    `${kindLabel} ${rel} 被 component "${owner.id}" 逐字登記（期望 paths ${JSON.stringify(expectedPaths)}，實際 ${JSON.stringify(paths)}）`,
  );
  return owner;
}

/** #171 的三個欄位：分類在值域內、target_path 是非空字串、user_invocable 是布林。 */
function assertOwnerClassification(owner, rel) {
  const allowed = OWNER_CLASSES[owner.kind] ?? [];
  assert(
    allowed.includes(owner.owner_class),
    `component "${owner.id}"（${rel}）的 owner_class 落在 ${owner.kind} 的值域 ${allowed.join('／')} 內（實際：${JSON.stringify(owner.owner_class)}）`,
  );
  assert(
    typeof owner.target_path === 'string' && owner.target_path !== '',
    `component "${owner.id}"（${rel}）的 target_path 是非空字串（實際：${JSON.stringify(owner.target_path)}）`,
  );
  assert(
    typeof owner.user_invocable === 'boolean',
    `component "${owner.id}"（${rel}）的 user_invocable 顯式為布林值（實際：${JSON.stringify(owner.user_invocable)}）`,
  );
}

console.log('\n[G2] 每一支 skill 都有唯一 component，且分類欄位齊備');
for (const rel of skillFiles) {
  const dirRel = rel.slice(0, -'/SKILL.md'.length);
  const owner = assertExactlyRegistered(rel, { expectedPaths: [`${dirRel}/**`], kindLabel: 'skill' });
  if (owner) assertOwnerClassification(owner, rel);
}

console.log('\n[G3] 每一支 agent 都有唯一 component，且分類欄位齊備');
for (const rel of agentFiles) {
  const owner = assertExactlyRegistered(rel, { expectedPaths: [rel], kindLabel: 'agent' });
  if (owner) assertOwnerClassification(owner, rel);
}

console.log('\n[G4] 每一份 reference 都有唯一 component，且分類欄位齊備');
for (const rel of referenceFiles) {
  const owner = assertExactlyRegistered(rel, { expectedPaths: [rel], kindLabel: 'reference' });
  if (owner) assertOwnerClassification(owner, rel);
}

/**
 * G5：user_invocable 與各 SKILL.md frontmatter 的 user-invocable 對帳。
 * 只驗 registry 內部一致（例如「恰好一個 true」）擋不住填錯對象——真相在 frontmatter，
 * 沒宣告 user-invocable 的 skill 依 loader 慣例即為使用者入口。
 */
console.log('\n[G5] user_invocable 與 SKILL.md frontmatter 對帳');
for (const rel of skillFiles) {
  const declared = parseDescription(readFileSync(join(REPO_ROOT, ...rel.split('/')), 'utf8')).userInvocable;
  const expected = declared !== false;
  const owner = ownersOf(rel)[0];
  assert(
    owner?.user_invocable === expected,
    `${rel} 的 frontmatter user-invocable=${JSON.stringify(declared)} ⇒ registry 應為 ${expected}（component "${owner?.id}" 實際：${JSON.stringify(owner?.user_invocable)}）`,
  );
}

/** G6：反向——registry 登記的每條 path 都要對得到實體檔案（glob 至少命中一個）。 */
console.log('\n[G6] registry 的每條 path 都對得到實體檔案');
const repoFiles = collectFiles('.', () => true).map((rel) => rel.replace(/^\.\//, ''));
assert(repoFiles.length > 100, `走訪到 ${repoFiles.length} 個檔案（走不到就是走錯根目錄）`);
for (const component of components) {
  for (const path of component.paths ?? []) {
    assert(
      repoFiles.some((file) => globCovers(path, file)),
      `component "${component.id}" 的 path 對得到實體檔案：${path}`,
    );
  }
}

// ── 收尾 ─────────────────────────────────────────────────────────────────────

console.log(`\n${failed.length === 0 ? '✓' : '✗'} test-registry-coverage：${passed} passed, ${failed.length} failed`);
if (failed.length > 0) {
  for (const msg of failed) console.error(`  - ${msg}`);
  process.exit(1);
}
