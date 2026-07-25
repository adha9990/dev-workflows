#!/usr/bin/env node
// setup-plan.mjs —— `/setup` 的 reconciliation 引擎（#176）。
//
// 定位：使用者的選擇 → **desired state**；當前環境 → **observed state**；兩者相減得到 **diff plan**；
// 套用 plan 產出可追溯的 **receipt**。這條路徑讓「重跑一次 setup」變成安全操作：**沒變的來源不重裝**，
// 只對真的有差的那幾個做事。
//
// 四條不可退讓的規則：
//   1. **不留半套**：每一步 staged install → health/canary → atomic switch；任一關失敗就回上一個可用版本，
//      絕不留下「裝了一半」的狀態。
//   2. **latest stable，不 pin**：解析當下的最新穩定版；receipt 記下**實際解析到的版本**（可追溯），
//      但 desired state 不寫死版本號。
//   3. **互斥組只留一個**：同一能力的兩個實作不同時啟用；切換＝關掉舊的、開新的，由同一份 plan 表達。
//   4. **沒有 experimental fallback**：資格審查沒過的來源**不出現在 wizard**，也不提供「自己冒險」的旗標。
//
// 純函式（validateCatalog / wizardOptions / desiredFromChoices / diffPlan / shouldAutoUpdate / renderReceipt）
// ＋ IO 薄邊界（loadCatalog / loadIntegrations）＋ port 注入的 applyPlan（安裝動作本身由呼叫端提供，
// 本檔不 spawn 任何東西——那讓 reconciliation 邏輯可以在沒有真實環境的情況下被完整測試）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** wizard 的四類。順序即呈現順序。 */
export const SETUP_CATEGORIES = Object.freeze(['required', 'token-optimizer', 'recommended', 'optional']);

/** plan 的動作種類。 */
export const PLAN_ACTIONS = Object.freeze(['install', 'update', 'switch-off', 'remove', 'no-op']);

/** 只有 support_status 是這些的來源才准進 wizard（Metric-Honesty：沒實測過的不推薦給人裝）。 */
export const OFFERABLE_STATUSES = Object.freeze(['supported', 'not_measured']);

const CATALOG_REL = join('plugins', 'loops-workflow', 'references', 'setup-catalog.json');
const INTEGRATION_REL = join('plugins', 'loops-workflow', 'references', 'integration-registry.json');

// ── 驗證（純函式）───────────────────────────────────────────────────────────

/**
 * catalog 自身與它對 integration registry 的引用是否自洽。
 * 這一關擋的是「wizard 提供了一個 registry 裡根本沒有的來源」——那會讓 apply 階段才炸。
 */
export function validateCatalog(catalog, integrationRegistry) {
  const findings = [];
  const entries = Array.isArray(catalog?.entries) ? catalog.entries : [];
  const byIntegration = new Map((integrationRegistry?.integrations ?? []).map((i) => [i.id, i]));
  const seen = new Set();
  for (const e of entries) {
    const id = e?.id;
    if (typeof id !== 'string' || !id) { findings.push({ check: 'setup-catalog-shape', detail: '有 entry 缺 id' }); continue; }
    if (seen.has(id)) findings.push({ check: 'setup-catalog-shape', detail: `entry id 重複：${id}` });
    seen.add(id);
    if (!SETUP_CATEGORIES.includes(e.category)) findings.push({ check: 'setup-catalog-category', detail: `entry "${id}" 的 category 須為 ${SETUP_CATEGORIES.join('／')} 之一（實際：${JSON.stringify(e.category)}）` });
    const integ = byIntegration.get(e.integration);
    if (!integ) { findings.push({ check: 'setup-catalog-ref', detail: `entry "${id}" 指向不存在的 integration "${e.integration}"` }); continue; }
    if (e.category === 'token-optimizer' && !integ.exclusive_group) {
      findings.push({ check: 'setup-catalog-exclusive', detail: `entry "${id}" 屬互斥類，但 integration "${integ.id}" 沒有 exclusive_group——互斥關係要由 registry 表達，不能只寫在 wizard 上` });
    }
    if (e.qualification !== null && !Array.isArray(e.qualification)) {
      findings.push({ check: 'setup-catalog-shape', detail: `entry "${id}" 的 qualification 須為 null 或「還缺什麼」的陣列` });
    }
    if (e.category === 'required' && e.recommended !== true) {
      findings.push({ check: 'setup-catalog-shape', detail: `entry "${id}" 是 required，recommended 必須為 true（required 不問使用者）` });
    }
  }
  return findings;
}

// ── wizard（純函式）─────────────────────────────────────────────────────────

/**
 * wizard 要呈現什麼。**資格審查未過（`qualification` 非 null）的一律不出現**——
 * 沒有 experimental fallback，也不提供「自己冒險」的旗標。回傳依 category 分組，
 * 互斥組另外標 `exclusiveGroup` 與 `allowDisable`（互斥組永遠可以整組停用）。
 */
export function wizardOptions(catalog, integrationRegistry) {
  const byIntegration = new Map((integrationRegistry?.integrations ?? []).map((i) => [i.id, i]));
  const groups = [];
  for (const category of SETUP_CATEGORIES) {
    const options = (catalog?.entries ?? [])
      .filter((e) => e.category === category)
      .filter((e) => e.qualification === null)
      .filter((e) => OFFERABLE_STATUSES.includes(byIntegration.get(e.integration)?.support_status))
      .map((e) => ({
        id: e.id,
        integration: e.integration,
        summary: e.summary ?? '',
        recommended: e.recommended === true,
        exclusiveGroup: byIntegration.get(e.integration)?.exclusive_group ?? null,
      }));
    if (!options.length) continue;
    groups.push({
      category,
      asks: category !== 'required', // required 不問使用者，一律裝
      allowDisable: category === 'token-optimizer' || category === 'optional' || category === 'recommended',
      options,
    });
  }
  return groups;
}

/** 被擋在 wizard 外的來源與原因（誠實揭露：不是沒有，是還沒合格）。 */
export function withheldOptions(catalog) {
  return (catalog?.entries ?? [])
    .filter((e) => e.qualification !== null)
    .map((e) => ({ id: e.id, missing: [...e.qualification] }));
}

/**
 * 使用者選擇 → desired state（`Map<entryId, {enabled}>`）。
 * `required` 一律 enabled（不管使用者有沒有勾）；互斥組**最多一個** enabled——選了第二個就以
 * 後選的為準並把同組其餘關掉（wizard 是單選，這裡是防呆與可測的正式語意）。
 */
export function desiredFromChoices(choices, catalog, integrationRegistry) {
  const byIntegration = new Map((integrationRegistry?.integrations ?? []).map((i) => [i.id, i]));
  const entries = catalog?.entries ?? [];
  const desired = new Map();
  const chosen = new Set(Array.isArray(choices) ? choices : []);

  for (const e of entries) {
    const enabled = e.category === 'required' ? true : chosen.has(e.id);
    desired.set(e.id, { enabled: enabled && e.qualification === null, integration: e.integration });
  }
  // 互斥：同一 exclusive_group 內最多一個。以使用者選擇的順序取最後一個為準。
  const groupWinner = new Map();
  for (const id of chosen) {
    const e = entries.find((x) => x.id === id);
    if (!e) continue;
    const group = byIntegration.get(e.integration)?.exclusive_group;
    if (group) groupWinner.set(group, id);
  }
  for (const e of entries) {
    const group = byIntegration.get(e.integration)?.exclusive_group;
    if (!group || !groupWinner.has(group)) continue;
    if (groupWinner.get(group) !== e.id && e.category !== 'required') desired.set(e.id, { ...desired.get(e.id), enabled: false });
  }
  return desired;
}

// ── diff plan（純函式）─────────────────────────────────────────────────────

/**
 * desired × observed → 要做的事。
 * `observed` 是 `Map<entryId, {installed, version}>`。**沒有差別的來源產出 `no-op`**——
 * 重跑一次 setup 因此是安全的（AC：same-choice no-op）。
 * `latest` 是 `Map<entryId, version>`（呼叫端先解析好；本檔不上網）。
 */
export function diffPlan(desired, observed, { latest = new Map(), forceUpdate = new Set() } = {}) {
  const steps = [];
  for (const [id, want] of desired) {
    const have = observed.get(id) ?? { installed: false, version: null };
    const target = latest.get(id) ?? null;
    if (want.enabled && !have.installed) {
      steps.push({ id, action: 'install', from: null, to: target, reason: '尚未安裝' });
    } else if (want.enabled && have.installed && target && have.version !== target) {
      steps.push({ id, action: 'update', from: have.version, to: target, reason: `有更新的穩定版（${have.version} → ${target}）` });
    } else if (want.enabled && have.installed && forceUpdate.has(id)) {
      steps.push({ id, action: 'update', from: have.version, to: target ?? have.version, reason: 'TTL 到期，重新確認最新穩定版' });
    } else if (!want.enabled && have.installed) {
      // 同一互斥組裡「因為選了別的而被關掉」與「使用者明確不要」在動作上相同，理由分開寫
      steps.push({ id, action: 'switch-off', from: have.version, to: null, reason: '目前選擇不啟用這個來源' });
    } else {
      steps.push({ id, action: 'no-op', from: have.version, to: have.version, reason: want.enabled ? '已是想要的狀態' : '本來就沒裝' });
    }
  }
  return { steps, changed: steps.filter((s) => s.action !== 'no-op') };
}

/** 這次 setup 有沒有實際要做的事（全 no-op ＝ 重跑安全、什麼都不動）。 */
export function isNoOp(plan) {
  return plan.changed.length === 0;
}

// ── apply（IO 由 port 注入）────────────────────────────────────────────────

/**
 * 套用 plan。每一步固定三段：**stage → health → switch**；任一段失敗就 `rollback` 回上一個可用版本，
 * 並把該步標成 `rolled-back`。**一步失敗不影響其餘步驟**（各來源獨立），但失敗的那一步**絕不留半套**。
 *
 * `ports`：`{ stage(id, version), health(id, version), activate(id, version), rollback(id, previous), remove(id) }`
 * 每個都回 `{ok, detail}`；丟例外一律當作失敗（呼叫端不必自己 try/catch）。
 */
export function applyPlan(plan, ports, { now = 0 } = {}) {
  const call = (fn, ...args) => {
    if (typeof fn !== 'function') return { ok: false, detail: '呼叫端沒有提供這個動作' };
    try {
      const r = fn(...args);
      return r && typeof r === 'object' ? { ok: r.ok === true, detail: r.detail ?? '' } : { ok: false, detail: '動作沒有回傳結果' };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  };

  const receipt = { at: new Date(now).toISOString(), steps: [] };
  for (const step of plan.steps) {
    if (step.action === 'no-op') { receipt.steps.push({ ...step, status: 'no-op', health: null, rolledBack: false }); continue; }
    if (step.action === 'switch-off' || step.action === 'remove') {
      const r = call(ports.remove, step.id);
      receipt.steps.push({ ...step, status: r.ok ? 'done' : 'failed', health: null, rolledBack: false, detail: r.detail });
      continue;
    }
    const staged = call(ports.stage, step.id, step.to);
    if (!staged.ok) {
      const rb = call(ports.rollback, step.id, step.from);
      receipt.steps.push({ ...step, status: 'failed', health: 'not-run', rolledBack: rb.ok, detail: `staged install 失敗：${staged.detail}` });
      continue;
    }
    const health = call(ports.health, step.id, step.to);
    if (!health.ok) {
      const rb = call(ports.rollback, step.id, step.from);
      receipt.steps.push({ ...step, status: 'failed', health: 'failed', rolledBack: rb.ok, detail: `健康檢查未過：${health.detail}——已回上一個可用版本` });
      continue;
    }
    const activated = call(ports.activate, step.id, step.to);
    if (!activated.ok) {
      const rb = call(ports.rollback, step.id, step.from);
      receipt.steps.push({ ...step, status: 'failed', health: 'passed', rolledBack: rb.ok, detail: `切換失敗：${activated.detail}——已回上一個可用版本` });
      continue;
    }
    receipt.steps.push({ ...step, status: 'done', health: 'passed', rolledBack: false, detail: activated.detail });
  }
  receipt.ok = receipt.steps.every((s) => s.status !== 'failed');
  return receipt;
}

/** 有沒有留下「裝了一半」的狀態：失敗的步驟必須都已 rollback。 */
export function hasHalfInstalled(receipt) {
  return receipt.steps.some((s) => s.status === 'failed' && s.rolledBack !== true);
}

/** receipt → 人讀的表（來源／解析到的版本／動作／健康／是否回滾）。 */
export function renderReceipt(receipt) {
  const rows = ['| 來源 | 動作 | 解析到的版本 | 健康檢查 | 回滾 | 說明 |', '|---|---|---|---|---|---|'];
  for (const s of receipt.steps) {
    rows.push(`| \`${s.id}\` | ${s.action} | ${s.to ?? '-'} | ${s.health ?? '-'} | ${s.rolledBack ? '是' : '否'} | ${s.detail ?? s.reason} |`);
  }
  return [`## setup 結果（${receipt.at}）`, '', receipt.ok ? '全部完成。' : '**有步驟失敗，已回上一個可用版本**（沒有留下半套狀態）。', '', ...rows, ''].join('\n');
}

// ── 自動更新（純函式）──────────────────────────────────────────────────────

/**
 * 依 TTL 決定這個來源這次要不要重新查 latest。
 * `lastCheckedAt` 為 null（從沒查過）→ 一律要查；TTL 為 null（不自動更新）→ 一律不查。
 */
export function shouldAutoUpdate(entry, { lastCheckedAt = null, now = 0 } = {}) {
  const ttl = entry?.auto_update_ttl_hours;
  if (ttl === null || ttl === undefined) return false;
  if (lastCheckedAt === null || lastCheckedAt === undefined) return true;
  const last = typeof lastCheckedAt === 'number' ? lastCheckedAt : Date.parse(lastCheckedAt);
  if (!Number.isFinite(last)) return true; // 讀不出上次時間就當作該查（保守）
  return now - last >= ttl * 3600 * 1000;
}

/** 這一輪 TTL 到期、要重新確認最新穩定版的來源 id 集合。 */
export function dueForAutoUpdate(catalog, { lastChecked = new Map(), now = 0 } = {}) {
  const due = new Set();
  for (const e of catalog?.entries ?? []) {
    if (shouldAutoUpdate(e, { lastCheckedAt: lastChecked.get(e.id) ?? null, now })) due.add(e.id);
  }
  return due;
}

// ── IO 薄邊界 ────────────────────────────────────────────────────────────────

function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}
const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};

export function loadCatalog(root = repoRoot()) { return readJson(join(root, CATALOG_REL)); }
export function loadIntegrations(root = repoRoot()) { return readJson(join(root, INTEGRATION_REL)); }

// ── CLI ──────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : repoRoot();
  const catalog = loadCatalog(root);
  const integrations = loadIntegrations(root);
  if (!catalog || !integrations) {
    process.stderr.write('setup-plan：讀不到 setup-catalog.json 或 integration-registry.json\n');
    return 1;
  }
  const findings = validateCatalog(catalog, integrations);
  const groups = wizardOptions(catalog, integrations);
  const withheld = withheldOptions(catalog);
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ok: findings.length === 0, groups, withheld, findings }, null, 2)}\n`);
  } else {
    process.stdout.write(`${findings.length ? '✗' : '✓'} setup catalog：${catalog.entries.length} 個來源\n`);
    for (const g of groups) {
      process.stdout.write(`  · ${g.category}${g.asks ? '' : '（不問，一律裝）'}：${g.options.map((o) => o.id + (o.recommended ? '（推薦）' : '')).join('、')}\n`);
    }
    for (const w of withheld) process.stdout.write(`  · 未進 wizard：${w.id}——還缺 ${w.missing.join('、')}\n`);
    for (const f of findings) process.stderr.write(`  ✗ [${f.check}] ${f.detail}\n`);
  }
  return findings.length ? 1 : 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
