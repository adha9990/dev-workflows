#!/usr/bin/env node
// policy-runtime.mjs —— 四級規則執行引擎（#173）。
//
// 問題：同一條規則若只寫在 `AGENTS.md` / SKILL.md，AI 可能沒載入、載入了也可能略過；反過來，把所有
// 規則都塞進 prompt 又浪費 token，而且把**本來就可機械判定**的 invariant 交給語言模型判斷。
//
// 解法：**依可判定性把規則分四級**，各級由不同機制承接：
//
// | tier | 機制 | 誰執行 | 判定方式 |
// |---|---|---|---|
// | 1 `hard-invariant` | 工具呼叫前 deny | `hooks/*.mjs`（PreToolUse 家族） | 完全機械、零語意 |
// | 2 `workflow-invariant` | 流程狀態閘 | `scripts/*-lint.mjs`、pr-gate 的階段閘 | 機械讀狀態檔 / 掃樹 |
// | 3 `semantic` | bounded context ＋ eval | Promptfoo / eval-judge | 需要語意判斷，**評不到就標 degraded** |
// | 4 `advisory` | skill / agent 指示 | prompt 正文 | 靠模型遵循，不宣稱保證 |
//
// 三條不可退讓的規則：
//   1. **只能執行 registry 宣告的規則**：`decide()` 對未登記的 rule id 一律 deny（`undeclared-rule`）——
//      hook 想擋什麼，得先在 policy-registry.json 裡有一條，才有來源可反查。
//   2. **forbid-wins**：多條規則同時適用時，任一條 deny 就整體 deny（不做「多數決」也不取最寬鬆的）。
//   3. **protected action 的 state 缺失 / 壞掉一律 fail closed**：讀不到判定所需狀態時，
//      對標了 `fail_closed_on_missing_state` 的規則**擋下**而不是放行。
//      （沒標的規則維持 hook 家族既有的 fail-open 慣例——那是刻意的取捨，不是疏漏。）
//
// 逃生口是**有 scope、有到期、有留痕**的 approval token，且**只對 registry 標 `overridable: true`
// 的規則生效**——環境變數不得成為無記錄、無 scope 的永久逃生口（issue #173 非目標）。
//
// 純函式（compilePolicyRuntime / decide / decideAll / selectApproval / evaluateSemantic）＋
// IO 薄邊界（loadRegistry / recordApproval）。依賴：僅 node 內建。

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { appendEvent } from './loop-ledger.mjs';

/** 四級規則（順序即嚴格度；索引 +1 就是文件裡講的「第幾級」）。 */
export const POLICY_TIERS = Object.freeze(['hard-invariant', 'workflow-invariant', 'semantic', 'advisory']);

/** 每一級由什麼機制承接（compiler 用它反查「這條規則該有什麼 runtime 綁定」）。 */
export const TIER_MECHANISM = Object.freeze({
  'hard-invariant': 'pre-tool-deny',
  'workflow-invariant': 'state-guard',
  semantic: 'eval',
  advisory: 'prompt',
});

/** 只有這兩級能真的擋下動作；3/4 級回 advise，永遠不假裝自己擋得住。 */
export const BLOCKING_TIERS = Object.freeze(['hard-invariant', 'workflow-invariant']);

/** approval token 的必填欄位——少一個就不是有效授權（沒有「口頭同意」這種東西）。 */
export const APPROVAL_FIELDS = Object.freeze(['rule', 'target', 'expires_at', 'reason', 'issued_by']);

/** 稽核落點（相對主 repo 根）。 */
export const APPROVAL_AUDIT_REL = join('.loops', '.audit', 'policy-approvals.jsonl');

const POLICY_REGISTRY_REL = join('plugins', 'loops-workflow', 'references', 'policy-registry.json');

// ── 編譯（純函式）───────────────────────────────────────────────────────────

function finding(check, id, detail) {
  return { check, severity: 'P1', file: POLICY_REGISTRY_REL.split('\\').join('/'), detail: id ? `policy "${id}"：${detail}` : detail };
}

/**
 * registry → 可執行的規則表。**編譯不通過的規則不會進 rules**——寧可少一條可執行規則，
 * 也不要讓一條半殘的規則在 runtime 做出無法反查來源的判定。
 */
export function compilePolicyRuntime(registry) {
  const rules = new Map();
  const findings = [];
  const list = Array.isArray(registry?.policies) ? registry.policies : [];
  for (const p of list) {
    const id = p?.id;
    if (typeof id !== 'string' || !id) { findings.push(finding('policy-runtime-shape', null, '有一條 policy 缺 id，無法編譯')); continue; }
    if (!POLICY_TIERS.includes(p.tier)) {
      findings.push(finding('policy-tier', id, `"tier" 須為 ${POLICY_TIERS.join('／')} 之一（實際：${JSON.stringify(p.tier)}）`));
      continue;
    }
    const runtime = p.runtime ?? null;
    if (BLOCKING_TIERS.includes(p.tier)) {
      if (!runtime || typeof runtime.guard !== 'string' || !runtime.guard) {
        findings.push(finding('policy-runtime-binding', id, `tier=${p.tier} 必須綁一個 runtime.guard（誰執行它）；沒有 guard 的規則擋不了任何東西，該降級成 semantic/advisory`));
        continue;
      }
      if (!Array.isArray(runtime.protected_actions) || runtime.protected_actions.length === 0) {
        findings.push(finding('policy-runtime-binding', id, `tier=${p.tier} 必須列出 runtime.protected_actions（這條規則保護哪些動作）`));
        continue;
      }
    } else if (p.tier === 'semantic' && (typeof p.evaluator !== 'string' || !p.evaluator)) {
      findings.push(finding('policy-evaluator', id, 'tier=semantic 必須指名 evaluator（評不到時要標 degraded，得先知道是誰評）'));
      continue;
    }
    if (rules.has(id)) { findings.push(finding('policy-runtime-shape', id, 'id 重複')); continue; }
    rules.set(id, {
      id,
      tier: p.tier,
      mechanism: TIER_MECHANISM[p.tier],
      enforcement: p.enforcement,
      overridable: p.overridable === true,
      failClosed: p.fail_closed_on_missing_state === true,
      guard: runtime?.guard ?? null,
      protectedActions: runtime?.protected_actions ? [...runtime.protected_actions] : [],
      evaluator: p.evaluator ?? null,
      tests: Array.isArray(p.tests) ? [...p.tests] : [],
      docs: Array.isArray(p.docs) ? [...p.docs] : [],
    });
  }
  return { rules, findings };
}

/** 這條 rule id 有沒有被 registry 宣告（hook 只能執行宣告過的規則）。 */
export function isDeclared(compiled, ruleId) {
  return compiled.rules.has(ruleId);
}

/** 某個 guard 被授權執行哪些規則（反查用：這支 hook 憑什麼擋）。 */
export function rulesForGuard(compiled, guardId) {
  return [...compiled.rules.values()].filter((r) => r.guard === guardId);
}

// ── approval token（純函式）─────────────────────────────────────────────────

/**
 * 解析 approval token 集合。接受 JSON 陣列或單一物件；**任何解析失敗一律回空集合**——
 * 壞掉的授權檔不得被當成「授權了」（fail closed 精神延伸到逃生口本身）。
 */
export function parseApprovals(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.filter((t) => t && typeof t === 'object' && !Array.isArray(t));
}

/** token 形狀是否完整（缺任一必填欄 → 無效）。 */
export function isWellFormedApproval(token) {
  return APPROVAL_FIELDS.every((f) => typeof token?.[f] === 'string' && token[f].trim() !== '');
}

/** target 比對：完全相等，或 token 的 target 以 `/*` 結尾時做前綴涵蓋（不做任意 glob）。 */
export function approvalCoversTarget(tokenTarget, target) {
  if (typeof tokenTarget !== 'string' || typeof target !== 'string') return false;
  if (tokenTarget === target) return true;
  if (tokenTarget.endsWith('/*')) return target.startsWith(tokenTarget.slice(0, -1));
  return false;
}

/**
 * 從 token 集合裡挑出**適用且未過期**的一張。回 `{token, reason}`；挑不到時 `token===null`
 * 且 `reason` 說明為什麼（形狀不完整 / 規則不符 / target 不涵蓋 / 已過期）——理由要能寫進稽核。
 */
export function selectApproval(approvals, { rule, target, now }) {
  const t = typeof now === 'number' ? now : Date.parse(now ?? '') || 0;
  let reason = '沒有任何 approval token';
  for (const token of approvals || []) {
    if (!isWellFormedApproval(token)) { reason = `token 欄位不完整（必填：${APPROVAL_FIELDS.join('、')}）`; continue; }
    if (token.rule !== rule) { reason = `token 授權的是 "${token.rule}"，不是 "${rule}"`; continue; }
    if (!approvalCoversTarget(token.target, target)) { reason = `token 的 target "${token.target}" 未涵蓋 "${target}"`; continue; }
    const expiry = Date.parse(token.expires_at);
    if (!Number.isFinite(expiry)) { reason = `token 的 expires_at 無法解析（${token.expires_at}）`; continue; }
    if (expiry <= t) { reason = `token 已於 ${token.expires_at} 過期`; continue; }
    return { token, reason: null };
  }
  return { token: null, reason };
}

// ── 判定（純函式）───────────────────────────────────────────────────────────

/**
 * 對**單一規則**做判定。
 *
 * @param compiled compilePolicyRuntime 的結果
 * @param input `{ rule, action, target, violation, stateAvailable, approvals, now }`
 *   - `violation`：guard 的機械判定結果（true＝這個動作違反了這條規則）
 *   - `stateAvailable`：判定所需狀態讀得到嗎（false＝缺失或壞掉）
 * @returns `{ outcome: 'allow'|'deny'|'advise', code, rule, tier, reason, audit }`
 */
export function decide(compiled, { rule, action = '', target = '', violation = false, stateAvailable = true, approvals = [], now = Date.now() } = {}) {
  const r = compiled.rules.get(rule);
  if (!r) {
    // 未登記的規則一律擋——hook 想擋什麼就得先登記，否則沒有來源可反查、也沒有測試契約可套。
    return { outcome: 'deny', code: 'undeclared-rule', rule, tier: null, reason: `規則 "${rule}" 不在 policy registry 內；hook 只能執行已宣告的規則`, audit: null };
  }
  if (!BLOCKING_TIERS.includes(r.tier)) {
    return { outcome: 'advise', code: `tier-${r.tier}`, rule, tier: r.tier, reason: `tier=${r.tier} 由 ${r.mechanism} 承接，不在工具呼叫層擋`, audit: null };
  }
  if (r.protectedActions.length && action && !r.protectedActions.includes(action)) {
    return { outcome: 'allow', code: 'out-of-scope', rule, tier: r.tier, reason: `動作 "${action}" 不在本規則保護的動作清單內`, audit: null };
  }
  if (!stateAvailable) {
    return r.failClosed
      ? { outcome: 'deny', code: 'missing-state', rule, tier: r.tier, reason: '判定所需狀態缺失或無法解析；本規則標了 fail_closed_on_missing_state，一律擋下', audit: null }
      : { outcome: 'allow', code: 'fail-open', rule, tier: r.tier, reason: '判定所需狀態讀不到；本規則未標 fail-closed，沿用 hook 家族的 fail-open 慣例放行', audit: null };
  }
  if (!violation) {
    return { outcome: 'allow', code: 'no-violation', rule, tier: r.tier, reason: '未違反本規則', audit: null };
  }
  if (!r.overridable) {
    return { outcome: 'deny', code: 'non-overridable', rule, tier: r.tier, reason: '本規則不可核准繞過（overridable=false），approval token 一律不認', audit: null };
  }
  const { token, reason } = selectApproval(approvals, { rule, target, now });
  if (!token) {
    return { outcome: 'deny', code: 'no-valid-approval', rule, tier: r.tier, reason: `本規則可核准繞過，但${reason}`, audit: null };
  }
  return {
    outcome: 'allow',
    code: 'approved',
    rule,
    tier: r.tier,
    reason: `已由 ${token.issued_by} 核准繞過（到期 ${token.expires_at}）：${token.reason}`,
    audit: { rule, target, action, expires_at: token.expires_at, reason: token.reason, issued_by: token.issued_by },
  };
}

/**
 * 對**多條規則**做判定並合成。**forbid-wins**：任一條 deny 就整體 deny，並把所有 deny 的理由
 * 一起帶出來（不只回第一條——修一項再撞下一項對使用者是最差體驗）。
 */
export function decideAll(compiled, inputs = []) {
  const results = inputs.map((i) => decide(compiled, i));
  const denies = results.filter((r) => r.outcome === 'deny');
  return {
    outcome: denies.length ? 'deny' : 'allow',
    denies,
    results,
    reason: denies.length ? denies.map((d) => `[${d.rule}] ${d.reason}`).join('\n') : null,
  };
}

// ── semantic tier（純函式）──────────────────────────────────────────────────

/**
 * 語意級規則的評估。evaluator 不可用（沒注入 / 丟例外 / 回不出結論）時**一律標 `degraded`**，
 * 絕不寫成 `passed`——「評不到」與「評過了」是兩件事，混為一談等於偽造證據（Metric-Honesty）。
 */
export function evaluateSemantic(compiled, ruleId, { runEval = null } = {}) {
  const r = compiled.rules.get(ruleId);
  if (!r) return { status: 'degraded', rule: ruleId, reason: `規則 "${ruleId}" 不在 registry 內，無從評估` };
  if (r.tier !== 'semantic') return { status: 'not-applicable', rule: ruleId, reason: `tier=${r.tier} 不走 eval` };
  if (typeof runEval !== 'function') return { status: 'degraded', rule: ruleId, evaluator: r.evaluator, reason: `evaluator ${r.evaluator} 不可用（未注入），本輪標 degraded、不得寫成 passed` };
  let out;
  try {
    out = runEval(r);
  } catch (err) {
    return { status: 'degraded', rule: ruleId, evaluator: r.evaluator, reason: `evaluator ${r.evaluator} 執行失敗：${err.message}；標 degraded、不得寫成 passed` };
  }
  if (!out || (out.status !== 'passed' && out.status !== 'failed')) {
    return { status: 'degraded', rule: ruleId, evaluator: r.evaluator, reason: `evaluator ${r.evaluator} 沒有回出 passed/failed 結論，標 degraded` };
  }
  return { status: out.status, rule: ruleId, evaluator: r.evaluator, reason: out.reason ?? '' };
}

// ── 每條 hard rule 的共用測試契約（純函式，測試據此逐條驅動）─────────────────

/**
 * 一條 tier-1/2 規則**必須**被驗到的五種情形。這份清單是共用契約：
 * 新增一條 hard rule 就自動多五個必過的 case，不靠作者自己記得寫哪幾種。
 */
export const HARD_RULE_CONTRACT_CASES = Object.freeze(['allow', 'direct-deny', 'common-bypass', 'scoped-approval', 'malformed-state']);

/** 產生某條規則的契約 case 清單（含每個 case 的期望 outcome，測試直接拿去跑）。 */
export function hardRuleContract(compiled, ruleId) {
  const r = compiled.rules.get(ruleId);
  if (!r) return null;
  const action = r.protectedActions[0] ?? '';
  return HARD_RULE_CONTRACT_CASES.map((name) => {
    switch (name) {
      case 'allow':
        return { name, input: { rule: ruleId, action, violation: false }, expect: 'allow' };
      case 'direct-deny':
        return { name, input: { rule: ruleId, action, violation: true }, expect: 'deny' };
      case 'common-bypass':
        // 「換個寫法繞過」＝同一條規則、同一個保護動作，但呼叫端宣稱自己不算違反卻仍被 guard 判中。
        // 契約層要保證的是：judged-violation 一律 deny，沒有「換個包裝就放行」的旁路。
        return { name, input: { rule: ruleId, action, violation: true, approvals: [{ rule: ruleId, target: '*', expires_at: '2099-01-01T00:00:00Z', reason: '亂寫的萬用 token', issued_by: 'nobody' }] }, expect: 'deny' };
      case 'scoped-approval':
        return {
          name,
          input: {
            rule: ruleId, action, target: 'demo-target', violation: true,
            approvals: [{ rule: ruleId, target: 'demo-target', expires_at: '2099-01-01T00:00:00Z', reason: '本次例外的理由', issued_by: 'owner' }],
          },
          expect: r.overridable ? 'allow' : 'deny',
        };
      case 'malformed-state':
        return { name, input: { rule: ruleId, action, violation: true, stateAvailable: false }, expect: r.failClosed ? 'deny' : 'allow' };
      default:
        return null;
    }
  }).filter(Boolean);
}

// ── guard 覆蓋率（「hook 只能執行 registry 宣告的規則」的機械化）─────────────

/** hook 目錄裡「發得出 deny」的判準：檔案裡出現 `kind: 'deny'`（emitDecision 的 deny 信封）。 */
export const DENY_MARKER = "kind: 'deny'";

/**
 * 每一支**擋得住工具呼叫**的 hook，都必須有至少一條 policy 宣告自己由它執行。
 *
 * 這條把「hook 只能執行 registry 宣告的規則」從一句話變成會紅燈的檢查：新寫一支 deny hook 卻沒有
 * 對應 policy ＝ 一條擋人的規則沒有正式來源、查不到誰定的、也沒有測試契約可套。反向也查：policy
 * 指名的 guard 檔不存在 ＝ registry 在描述一個不存在的執行者。
 *
 * `listHookFiles` 以 port 注入（`(dir) => [{name, text}]`），測試不必造真的 hook 樹。
 */
export function checkGuardCoverage(compiled, { hooks = [] } = {}) {
  const findings = [];
  const declaredGuards = new Set([...compiled.rules.values()].map((r) => r.guard).filter(Boolean));
  const denyHooks = hooks.filter((h) => String(h.text ?? '').includes(DENY_MARKER)).map((h) => h.name.replace(/\.mjs$/, ''));
  for (const guard of denyHooks) {
    if (!declaredGuards.has(guard)) {
      findings.push({ check: 'guard-not-declared', severity: 'P1', file: `plugins/loops-workflow/hooks/${guard}.mjs`, detail: `這支 hook 發得出 deny，但沒有任何 policy 宣告 runtime.guard="${guard}"——擋人的規則必須先在 policy registry 有正式來源` });
    }
  }
  const hookNames = new Set(hooks.map((h) => h.name.replace(/\.mjs$/, '')));
  for (const r of compiled.rules.values()) {
    if (r.guard && r.mechanism === 'pre-tool-deny' && !hookNames.has(r.guard)) {
      findings.push({ check: 'guard-missing', severity: 'P1', file: 'plugins/loops-workflow/references/policy-registry.json', detail: `policy "${r.id}" 宣告由 hook "${r.guard}" 執行，但 hooks/ 底下沒有這支檔` });
    }
  }
  return { findings, denyHooks, declaredGuards: [...declaredGuards].sort() };
}

// ── IO 薄邊界 ────────────────────────────────────────────────────────────────

/** 列出 hooks 目錄下的非測試 `.mjs`（供 checkGuardCoverage 用）。 */
export function listHookFiles(root) {
  const dir = join(root, 'plugins', 'loops-workflow', 'hooks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.mjs') && !n.startsWith('test-'))
    .map((name) => {
      try { return { name, text: readFileSync(join(dir, name), 'utf8') }; } catch { return { name, text: '' }; }
    });
}

/** 讀 policy registry（讀不到 / 壞掉 → 回 null，呼叫端自行 fail closed）。 */
export function loadRegistry(root) {
  const file = join(root, POLICY_REGISTRY_REL);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 把一次「核准繞過」寫進稽核帳本。重用 loop-ledger 的 append-only 寫入路徑（#172）——
 * 逃生口用了幾次、誰核的、為什麼、到期何時，全部留痕、可回查。
 */
export function recordApproval(root, audit, { now = Date.now() } = {}) {
  const file = join(root, APPROVAL_AUDIT_REL);
  mkdirSync(dirname(file), { recursive: true });
  return appendEvent(file, {
    type: 'policy-approval',
    payload: { ...audit, recorded_at: new Date(now).toISOString() },
  });
}

/** 稽核帳本路徑是否已存在（供 CLI 與測試查詢，不建立）。 */
export function approvalAuditPath(root) {
  const file = join(root, APPROVAL_AUDIT_REL);
  return { file, exists: existsSync(file) };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function main() {
  const args = process.argv.slice(2);
  const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : repoRoot();
  const registry = loadRegistry(root);
  if (!registry) {
    process.stderr.write('policy-runtime：讀不到 policy-registry.json\n');
    return 1;
  }
  const compiled = compilePolicyRuntime(registry);
  const coverage = checkGuardCoverage(compiled, { hooks: listHookFiles(root) });
  const findings = [...compiled.findings, ...coverage.findings];
  const byTier = {};
  for (const r of compiled.rules.values()) (byTier[r.tier] ??= []).push(r.id);
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ok: findings.length === 0, byTier, denyHooks: coverage.denyHooks, findings }, null, 2)}\n`);
  } else {
    const mark = findings.length ? '✗' : '✓';
    process.stdout.write(`${mark} policy-runtime：可執行規則 ${compiled.rules.size} 條、deny hook ${coverage.denyHooks.length} 支全數有宣告來源\n`);
    for (const tier of POLICY_TIERS) {
      const ids = byTier[tier] ?? [];
      process.stdout.write(`  · ${tier}（${TIER_MECHANISM[tier]}）：${ids.length ? ids.join('、') : '（無）'}\n`);
    }
    for (const f of findings) process.stderr.write(`  ✗ [${f.check}] ${f.detail}\n`);
  }
  return findings.length ? 1 : 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
