#!/usr/bin/env node
// knowledge-metrics.mjs —— 共享記憶的成本與品質觀測（#218 的 S8）。
//
// 要回答的問題只有一個：**共享記憶到底有沒有讓這條 loop 變便宜，而且沒有讓品質退步。**
//
// 這支工具最重要的性質是**它不會替你回答那個問題**——它只把可以誠實量到的東西攤開：
//   · 事實建立了幾條、被誰重用了幾次、失效了幾條、補查了幾次；
//   · pack 建了幾份、真的被派出去幾份、估算多少 token（**估算**，不是實測）；
//   · 同一份來源被幾個不同角色各自重新宣告過（重複探索的可觀測代理指標）。
//
// **明文不做的事**（issue #218 非目標，也是 AGENTS 規則 5 Metric-Honesty）：
//   ✗ 不把「少查了幾次 graph」或「重用了幾條 claim」乘上一個係數，換算成「省了多少 token」。
//     省下來的量只能用**同一組 corpus 的 baseline 與 redesigned workflow 實跑 A/B**比出來；
//     runtime 沒給的數字一律 `not_measured`，不補 0、不用比例推估。
//   ✗ 不把 tool 搬動的位元組當成 token（沿用 telemetry-ledger 的既有邊界）。
//
// 分層：純函式（summarize／compare）＋ IO 薄邊界（讀事件流與 telemetry、CLI）。
// 依賴：僅 node 內建 ＋ 本 repo 內既有 script。
// 用法：node knowledge-metrics.mjs <loop 目錄> [--json]
//       node knowledge-metrics.mjs --baseline <loop 目錄> --candidate <loop 目錄> [--json]

import { pathToFileURL } from 'node:url';

import { NOT_MEASURED, projectKnowledge, readKnowledge } from './knowledge-ledger.mjs';
import { readTelemetryEvents, TOKEN_FIELDS } from './telemetry-ledger.mjs';

const countBy = (rows, key) => rows.reduce((acc, r) => {
  const k = r[key] ?? '(未填)';
  acc[k] = (acc[k] ?? 0) + 1;
  return acc;
}, {});

/**
 * 由知識狀態算出這條 loop 的共享記憶指標（純函式）。
 * 每個數字都是**計數**，不是節省量——命名刻意保持「發生了幾次」的語意。
 */
export function summarizeKnowledge(state) {
  const claims = state?.claims ?? [];
  const consumption = state?.consumption ?? [];
  const packs = state?.packs ?? [];

  // 同一份來源被幾個**不同角色**各自重新宣告過：這是「重複探索」目前唯一能機械觀測的代理指標。
  // 它不等於「重複讀了幾次檔案」——那要 runtime 的 tool 事件才量得到，量不到就別假裝量到。
  const rolesBySource = new Map();
  for (const c of claims) {
    for (const s of c.sources ?? []) {
      const key = `${s.type}:${s.locator}`;
      if (!rolesBySource.has(key)) rolesBySource.set(key, new Set());
      rolesBySource.get(key).add(c.createdBy?.agent_role ?? '(未填)');
    }
  }
  const repeatedSourceClaims = [...rolesBySource.entries()]
    .filter(([, roles]) => roles.size > 1)
    .map(([source, roles]) => ({ source, roles: [...roles] }));

  const consumedClaimIds = new Set(consumption.map((r) => r.claimId));
  return {
    claims: {
      total: claims.length,
      byValidity: countBy(claims, 'validity'),
      byKind: countBy(claims, 'kind'),
      byConfidence: countBy(claims, 'confidence'),
      reusable: claims.filter((c) => c.validity === 'valid').length,
      refreshed: claims.filter((c) => (c.refreshCount ?? 0) > 0).length,
      invalidatedBySource: claims.filter((c) => c.invalidationCause === 'source').length,
      invalidatedByUpstream: claims.filter((c) => c.invalidationCause === 'derived').length,
    },
    reuse: {
      consumptionEvents: consumption.length,
      distinctClaimsConsumed: consumedClaimIds.size,
      neverConsumed: claims.filter((c) => !consumedClaimIds.has(c.claimId)).length,
      byRole: countBy(consumption, 'agentRole'),
      byPhase: countBy(consumption, 'phase'),
    },
    packs: {
      built: packs.length,
      consumed: packs.filter((p) => (p.consumedBy ?? []).length > 0).length,
      overBudget: packs.filter((p) => p.overBudget).length,
      byRole: countBy(packs, 'role'),
      claimsPerPack: packs.map((p) => (p.claimIds ?? []).length),
      estimatedTokens: packs.reduce((n, p) => n + (p.tokensEstimated ?? 0), 0),
      estimatedTokensNote: '估算值（context-pack 的 heuristic），非 runtime 實測',
    },
    gaps: {
      total: (state?.gaps ?? []).length,
      resolved: (state?.gaps ?? []).filter((g) => g.resolvedByClaimId).length,
      byRole: countBy(state?.gaps ?? [], 'role'),
    },
    duplicateDiscovery: {
      repeatedSourceClaims: repeatedSourceClaims.length,
      detail: repeatedSourceClaims,
      note: '觀測值：同一份來源被不同角色各自重新宣告過。只記錄、不擋——語意上的重複探索用文字比對擋會誤傷合法調查',
    },
  };
}

/**
 * 把 telemetry 的 usage 依 agent role 攤開（成本歸戶已由 #217 的 trace envelope 保證）。
 * 沒有 telemetry ⇒ 全數 `not_measured`：**不編一組 0**，那會讓沒量到看起來像量到 0。
 */
export function summarizeCostByRole(telemetryEvents) {
  const rows = (telemetryEvents ?? [])
    .map((e) => e?.payload)
    .filter((p) => p && p.event_type === 'usage.turn');
  if (rows.length === 0) {
    return { measurement_status: NOT_MEASURED, reason: 'telemetry 沒有帶 usage 的 turn 事件', byRole: {} };
  }
  const byRole = {};
  let anyExact = false;
  for (const p of rows) {
    const role = p.agent_role ?? '(未填)';
    byRole[role] ??= { turns: 0, not_measured_turns: 0, ...Object.fromEntries(TOKEN_FIELDS.map((f) => [f, 0])) };
    byRole[role].turns += 1;
    if (!p.usage) { byRole[role].not_measured_turns += 1; continue; }
    anyExact = true;
    for (const f of TOKEN_FIELDS) if (Number.isFinite(p.usage[f])) byRole[role][f] += p.usage[f];
  }
  return { measurement_status: anyExact ? 'exact' : NOT_MEASURED, byRole };
}

/** 一條 loop 的完整報告（知識指標 ＋ 成本歸戶）。 */
export function buildReport(loopDir) {
  let knowledge;
  let warnings = [];
  try {
    const read = readKnowledge(loopDir);
    knowledge = read.state;
    warnings = read.warnings;
  } catch (err) {
    knowledge = projectKnowledge([]);
    warnings = [`讀不到事件流：${err?.message ?? err}`];
  }
  let telemetry = [];
  try { telemetry = readTelemetryEvents(loopDir).events; } catch { telemetry = []; }

  return {
    loopDir,
    enabled: knowledge.enabled,
    warnings,
    knowledge: summarizeKnowledge(knowledge),
    cost: summarizeCostByRole(telemetry),
    savings: {
      value: NOT_MEASURED,
      why: '節省量只能由同一組 corpus 的 baseline 與 redesigned workflow 實跑 A/B 比出來；把重用次數乘係數換算成 token 是捏造',
      how: 'node knowledge-metrics.mjs --baseline <baseline loop 目錄> --candidate <candidate loop 目錄>',
    },
  };
}

/**
 * A/B 比較兩條 loop。**只在兩邊都真的量到時才給差值**——任一邊 `not_measured` 就整項標 not_measured，
 * 不用單邊的數字推另一邊（那等於用假設補資料）。
 */
export function compareReports(baseline, candidate) {
  const delta = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? b - a : NOT_MEASURED);
  const bothMeasured = baseline.cost.measurement_status === 'exact' && candidate.cost.measurement_status === 'exact';
  const totalOf = (report) => Object.values(report.cost.byRole ?? {})
    .reduce((n, r) => n + TOKEN_FIELDS.reduce((m, f) => m + (r[f] ?? 0), 0), 0);

  return {
    baseline: baseline.loopDir,
    candidate: candidate.loopDir,
    knowledge: {
      claims: delta(baseline.knowledge.claims.total, candidate.knowledge.claims.total),
      distinctClaimsConsumed: delta(baseline.knowledge.reuse.distinctClaimsConsumed, candidate.knowledge.reuse.distinctClaimsConsumed),
      repeatedSourceClaims: delta(baseline.knowledge.duplicateDiscovery.repeatedSourceClaims, candidate.knowledge.duplicateDiscovery.repeatedSourceClaims),
    },
    tokens: bothMeasured
      ? { measurement_status: 'exact', baseline: totalOf(baseline), candidate: totalOf(candidate), delta: totalOf(candidate) - totalOf(baseline) }
      : { measurement_status: NOT_MEASURED, reason: '兩邊都要有 runtime 實測的 usage 才能比；缺一邊就沒有可信的差值' },
    caveat: '成本必須改善且品質不得退步——品質面（findings、acceptance、escaped defect）不在本報表內，要另外用 eval corpus 對照',
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function renderReport(report) {
  const k = report.knowledge;
  const lines = [
    `共享記憶：${report.enabled ? '已啟用' : '未啟用（這條 loop 沒有 knowledge 事件）'}　${report.loopDir}`,
    `  事實：${k.claims.total} 條（可重用 ${k.claims.reusable}、補查過 ${k.claims.refreshed}、因來源失效 ${k.claims.invalidatedBySource}、因上游失效 ${k.claims.invalidatedByUpstream}）`,
    `  重用：${k.reuse.consumptionEvents} 次取用／涵蓋 ${k.reuse.distinctClaimsConsumed} 條事實，從未被取用 ${k.reuse.neverConsumed} 條`,
    `  pack：建 ${k.packs.built} 份、實際派出 ${k.packs.consumed} 份、超出預算 ${k.packs.overBudget} 份（估算 ${k.packs.estimatedTokens} tokens——估算值）`,
    `  缺口：${k.gaps.total} 筆（已補 ${k.gaps.resolved}）　重複來源宣告：${k.duplicateDiscovery.repeatedSourceClaims} 份來源`,
    `  成本歸戶：${report.cost.measurement_status}${report.cost.reason ? `（${report.cost.reason}）` : ''}`,
    `  節省量：${report.savings.value}——${report.savings.why}`,
  ];
  for (const w of report.warnings) lines.push(`  ! ${w}`);
  return lines.join('\n');
}

function main(argv) {
  const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const json = argv.includes('--json');
  const baselineDir = flag('--baseline');
  const candidateDir = flag('--candidate');

  if (baselineDir && candidateDir) {
    // 比較結果一律 JSON：它是要被貼進報告、進 eval 的資料，不是給人掃一眼的摘要。
    const result = compareReports(buildReport(baselineDir), buildReport(candidateDir));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  const dir = argv.find((a) => !a.startsWith('--'));
  if (!dir) {
    process.stdout.write('用法：node knowledge-metrics.mjs <loop 目錄> [--json]｜--baseline <dir> --candidate <dir>\n');
    return 0;
  }
  const report = buildReport(dir);
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${renderReport(report)}\n`);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
