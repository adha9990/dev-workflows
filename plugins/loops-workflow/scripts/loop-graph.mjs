#!/usr/bin/env node
// loop-graph.mjs —— 由 event ledger 投影出的 work graph（reducer + SQLite read model，#172 T3/T4）。
//
// 分工：`loop-ledger.mjs` 是**唯一真相源與唯一寫入路徑**（append / readEvents / replay），本檔只做
// **衍生投影**——把同一份事件流投影成 issue #172 的 node/edge 模型，再落成一份可隨時丟棄重建的
// SQLite read model。因此：
//   · 投影是純函式（events → state → graph），不讀檔、不看時鐘；
//   · rebuild 一律「先清掉該 loop 的既有列、再重寫」，跑幾次結果都一樣（冪等）；
//   · 刪掉整個 `.loops/.index/` 再 rebuild 必須得到逐欄位相同的結果（AC-1）；
//   · FTS 是 best-effort sidecar——建不起來 / 查詢失敗都只降級搜尋，**不影響 exact 查詢、
//     blocking 判定與 audit trail**（AC-5）。
//
// **排序權威是檔案行序、不是 seq**（承 loop-ledger 契約 E6：併發寫者會寫出重複 seq）。本檔一律
// 依 `readEvents()` 回傳的順序 reduce，不自行 sort。
//
// 依賴：僅 node 內建（含 node:sqlite，Node 22.5+ 內建，無外部套件）。

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readEvents } from './loop-ledger.mjs';
import { emptyKnowledgeState, reduceKnowledgeEvent } from './knowledge-ledger.mjs';
import { emptyHandoffState, reduceHandoffEvent } from './handoff-ledger.mjs';

/**
 * node 種類（issue #172 資料模型 ＋ #218 的共享記憶 ＋ #219 的 handoff）。
 * KnowledgeClaim 之後那七種是 #218 加的：claim 依 kind 投影成不同節點（architecture→ArchitectureSlice、
 * convention→Convention、contract→Contract、invariant→Invariant，其餘→KnowledgeClaim），讓「這條 loop
 * 認定的契約有哪些」這種問題查得出來，而不是把所有事實壓成同一種節點再回頭過濾。
 * `Handoff` 是 #219 加的：交接是**這條 loop 的成果狀態**，要查得出「停在哪個 checkpoint、誰接手、
 * resume 憑什麼不重跑」，所以它是節點，不是某份文件的附註。
 */
export const NODE_KINDS = Object.freeze(['Loop', 'Issue', 'Stage', 'Decision', 'Task', 'Artifact', 'Finding', 'Gate', 'Commit', 'PR', 'ToolRun', 'Unknown', 'KnowledgeClaim', 'Source', 'ContextPack', 'ArchitectureSlice', 'Convention', 'Contract', 'Invariant', 'Handoff']);
/** edge 種類（issue #172 資料模型 ＋ #218 的共享記憶 ＋ #219 的 handoff）。 */
export const EDGE_KINDS = Object.freeze(['HAS_STAGE', 'DEPENDS_ON', 'PRODUCED_BY', 'SUPERSEDES', 'ADDRESSES', 'VERIFIED_BY', 'IMPLEMENTS', 'DERIVED_FROM', 'APPLIES_TO', 'CONSUMED_BY', 'INVALIDATED_BY', 'REFRESHED_BY', 'HANDED_OFF']);

/** claim kind → node kind（沒對到的一律 KnowledgeClaim；新增 kind 不必動這張表也不會消失）。 */
export const CLAIM_NODE_KIND = Object.freeze({
  architecture: 'ArchitectureSlice',
  convention: 'Convention',
  contract: 'Contract',
  invariant: 'Invariant',
});

/**
 * 本投影認得的事件型別 → 語意。ledger 層刻意讓 `type` 是自由字串（schema 演進靠 `v`），
 * 白名單只存在於**投影層**：認不得的型別一律忽略（不丟例外、不猜語意），這樣舊版投影讀新版
 * 事件流時，最壞是少投影一種節點，而不是整條 loop 讀不出來。
 */
export const PROJECTED_TYPES = Object.freeze({
  'loop-create': 'Loop', 'loop-close': 'Loop', issue: 'Issue',
  'stage-enter': 'Stage', 'stage-exit': 'Stage', round: 'Loop',
  decision: 'Decision', task: 'Task', artifact: 'Artifact',
  finding: 'Finding', gate: 'Gate', commit: 'Commit', pr: 'PR', toolrun: 'ToolRun', note: null,
  unknown: 'Unknown',
  'handoff.created': 'Handoff', 'handoff.accepted': 'Handoff',
  'workflow.paused': 'Handoff', 'workflow.resumed': 'Handoff',
});

/**
 * blocking 嚴重度下限——與 references/personas/reviewer-severity.md 的 P0/P1 擋線一致
 * （＝verify 判 Ready / Not ready 的擋線，#211 沒有改它）。
 *
 * **刻意與 pr-gate 閘⑥ 的下界不同、別對齊**：閘⑥ 是「誰都不能繞過的機械下界」，#211 起只認 P0；
 * 這裡是「還有什麼站在完工路上」——iterate §6 的完工前提仍是「最近一輪 verify 無 actionable
 * findings」，未修的 P1 一樣還在路上，而且它必須留在 context pack 的受保護區段裡（把 P1 從這個
 * 集合拿掉，預算一緊它就被丟出 context、沒人記得修）。
 */
export const BLOCKING_SEVERITIES = Object.freeze(['P0', 'P1']);

/** index 落點（相對主 repo 根）。 */
export const INDEX_REL_PATH = join('.loops', '.index', 'loops.sqlite');

// ── 投影（純函式）───────────────────────────────────────────────────────────

function emptyState(slug) {
  return {
    loop: { slug, type: '', operation: '', mode: '', session: '', stopCondition: '', done: false, outcome: '' },
    issue: null,
    stages: [],
    currentStage: null,
    round: 0,
    decisions: [],
    tasks: [],
    artifacts: [],
    findings: [],
    gates: [],
    commits: [],
    prs: [],
    toolRuns: [],
    notes: [],
    unknowns: [],
    blindSpotPasses: [],
    knowledge: emptyKnowledgeState(),
    handoff: emptyHandoffState(),
    eventCount: 0,
  };
}

/**
 * 同 id 的後續事件覆蓋前一筆，但**只覆蓋這次帶到的欄位**（patch 裡 `undefined` 的鍵一律跳過）。
 *
 * 為什麼不是整筆取代：一筆 `task` 事件常常只帶「這次變了什麼」（例如把 status 改成 done），
 * 整筆取代會把上一筆才宣告的 `dependsOn` 一起抹掉——依賴邊就這樣憑空消失。實測踩到：
 * `T2 dependsOn:[T1]` 在 T2 收工那筆事件之後不見了。first-write 才套 `defaults`。
 */
const upsert = (list, id, patch, defaults = {}) => {
  const found = list.find((x) => x.id === id);
  const target = found ?? { id, ...defaults };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) target[k] = v;
  if (!found) list.push(target);
  return target;
};

/**
 * events（**檔案行序**）→ 投影狀態。純函式：同一組事件永遠得到同一份 state（AC-1 的基礎）。
 * 未知型別與缺欄位一律忽略而非丟例外——嚴格判定是 `replayExact()` 的職責，本層是唯讀投影。
 */
export function projectEvents(events, { slug = '' } = {}) {
  const state = emptyState(slug);
  let i = 0;
  for (const ev of events || []) {
    const p = ev.payload || {};
    const at = i; // 行序位置：用來當「同名階段第幾次進入」與節點排序的穩定依據（不是 seq）
    i += 1;
    state.eventCount += 1;
    switch (ev.type) {
      case 'loop-create':
        state.loop.type = p.type ?? state.loop.type;
        state.loop.operation = p.operation ?? state.loop.operation;
        state.loop.mode = p.mode ?? state.loop.mode;
        state.loop.session = p.session ?? state.loop.session;
        state.loop.stopCondition = p.stopCondition ?? state.loop.stopCondition;
        break;
      case 'loop-close':
        state.loop.done = true;
        state.loop.outcome = p.outcome ?? state.loop.outcome;
        state.currentStage = null;
        break;
      case 'issue':
        if (Number.isFinite(Number(p.number))) state.issue = Number(p.number);
        break;
      case 'stage-enter': {
        if (typeof p.stage !== 'string' || !p.stage) break;
        const index = state.stages.filter((s) => s.name === p.stage).length;
        state.stages.push({ id: `${p.stage}#${index}`, name: p.stage, index, at, exitedAt: null, summary: '', round: state.round });
        state.currentStage = p.stage;
        break;
      }
      case 'stage-exit': {
        const open = [...state.stages].reverse().find((s) => s.name === p.stage && s.exitedAt === null);
        if (open) { open.exitedAt = at; open.summary = p.summary ?? ''; }
        break;
      }
      case 'round':
        if (Number.isInteger(p.round)) state.round = p.round;
        else state.round += 1;
        break;
      case 'decision': {
        const id = p.decisionId || p.id || `d@${at}`;
        upsert(state.decisions, id, { at, question: p.question, choice: p.choice, rationale: p.rationale, by: p.by, status: p.status, supersedes: p.supersedes },
          { question: '', choice: '', rationale: '', by: '', status: 'pending', supersedes: null });
        if (p.supersedes) {
          const prev = state.decisions.find((d) => d.id === p.supersedes);
          if (prev) prev.supersededBy = id;
        }
        break;
      }
      case 'task': {
        const id = p.taskId || p.id || `t@${at}`;
        upsert(state.tasks, id, {
          at,
          title: p.title,
          status: p.status,
          dependsOn: Array.isArray(p.dependsOn) ? [...p.dependsOn] : undefined,
          addresses: p.addresses,
        }, { title: '', status: 'open', dependsOn: [], addresses: null });
        break;
      }
      case 'artifact':
        upsert(state.artifacts, p.path || `a@${at}`, { at, path: p.path ?? '', kind: p.kind ?? '', stage: p.stage ?? state.currentStage ?? '', summary: p.summary ?? '' });
        break;
      case 'finding': {
        const id = p.findingId || p.id || `f@${at}`;
        upsert(state.findings, id, {
          at,
          severity: p.severity === undefined ? undefined : String(p.severity).toUpperCase(),
          title: p.title,
          axis: p.axis,
          round: Number.isInteger(p.round) ? p.round : undefined,
          status: p.status,
          resolution: p.resolution,
        }, { severity: '', title: '', axis: '', round: state.round, status: 'open', resolution: '' });
        break;
      }
      case 'gate':
        // 同一道閘 last-wins：node key 是閘名，所以「最近一次評估」自然覆蓋歷史（不必另外挑）。
        upsert(state.gates, p.gate || `g@${at}`, { at, gate: p.gate ?? '', status: p.status ?? '', detail: p.detail ?? '', stage: p.stage ?? state.currentStage ?? '' });
        break;
      case 'commit':
        upsert(state.commits, p.sha || `c@${at}`, { at, sha: p.sha ?? '', subject: p.subject ?? '', implements: p.implements ?? null });
        break;
      case 'pr':
        upsert(state.prs, String(p.number ?? `pr@${at}`), { at, number: p.number ?? null, title: p.title ?? '', url: p.url ?? '', merged: p.merged === true });
        break;
      case 'toolrun':
        state.toolRuns.push({ id: `tr@${at}`, at, tool: p.tool ?? '', outcome: p.outcome ?? '', detail: p.detail ?? '' });
        break;
      case 'note':
        state.notes.push({ at, text: p.text ?? '', stage: p.stage ?? state.currentStage ?? '' });
        break;
      case 'unknown':
        // 兩種 payload：blind-spot pass 的留痕（只有 blindSpotPass 欄）與 unknown node 本身。
        if (p.blindSpotPass) state.blindSpotPasses.push(String(p.blindSpotPass));
        else if (typeof p.id === 'string' && p.id) upsert(state.unknowns, p.id, { at, ...p }, {});
        break;
      default:
        // #219 的 handoff 事件（handoff.* / workflow.paused / workflow.resumed）與 #218 的共享記憶事件
        // （knowledge.* / context-pack.* / context-gap.*）各由**它自己那一份 reducer** 處理——投影邏輯
        // 只留一份，兩處各寫一次遲早對「什麼叫仍然有效」「什麼叫已經交接」分岔。
        // 兩支都認不得的型別才是真的忽略（不丟例外、不猜語意）。
        if (!reduceHandoffEvent(state.handoff, ev, at)) reduceKnowledgeEvent(state.knowledge, ev, at);
        break;
    }
  }
  return state;
}

/**
 * 仍擋著**完工**的東西：未解決的 P0/P1 finding ＋ 最近一次評估為 fail 的閘 ＋ 仍 pending 的決策。
 * 這是 context pack 的**受保護區段**（AC-4：預算再緊也不得丟）。
 *
 * 用「完工」而非「收圈」：對應的是 iterate §6 的完工前提（最近一輪 verify 無 actionable findings），
 * **不是** pr-gate 閘⑥ 的機械下界（#211 起只認 P0）。兩層刻意不同——見上方 `BLOCKING_SEVERITIES`。
 */
export function selectBlocking(state) {
  const findings = state.findings.filter((f) => f.status === 'open' && BLOCKING_SEVERITIES.includes(f.severity));
  const gates = state.gates.filter((g) => g.status === 'fail');
  const decisions = state.decisions.filter((d) => d.status === 'pending' && !d.supersededBy);
  // #174：未解決的 blocking unknown 與未修的 P0/P1 同級——都是「還沒搞清楚就往下做」的形狀。
  const unknowns = (state.unknowns ?? []).filter((u) => u.blocking === true && u.status !== 'resolved');
  return { findings, gates, decisions, unknowns, count: findings.length + gates.length + decisions.length + unknowns.length };
}

/** state → `{nodes, edges}`（issue #172 的 node/edge 模型）。純函式。 */
export function toGraph(state) {
  const slug = state.loop.slug;
  const nodes = [];
  const edges = [];
  const nid = (kind, key) => `${kind}:${slug}:${key}`;
  const push = (kind, key, label, data, at) => {
    const id = nid(kind, key);
    nodes.push({ id, kind, loop: slug, label, data, seq: at });
    return id;
  };
  const link = (from, to, kind, at) => edges.push({ from, to, kind, loop: slug, seq: at });

  const loopId = push('Loop', '.', slug, { ...state.loop, round: state.round, currentStage: state.currentStage }, 0);

  if (state.issue !== null) {
    const issueId = push('Issue', String(state.issue), `#${state.issue}`, { number: state.issue }, 0);
    link(loopId, issueId, 'ADDRESSES', 0);
  }

  const stageIds = new Map();
  for (const s of state.stages) {
    const id = push('Stage', s.id, s.name, s, s.at);
    stageIds.set(s.id, id);
    link(loopId, id, 'HAS_STAGE', s.at);
  }
  /** 某個行序位置當下所屬的 stage node（artifact / gate / finding 掛回產出它的階段）。 */
  const stageAt = (at, name) => {
    const candidates = state.stages.filter((s) => (!name || s.name === name) && s.at <= at);
    const last = candidates[candidates.length - 1];
    return last ? stageIds.get(last.id) : null;
  };

  for (const d of state.decisions) {
    const id = push('Decision', d.id, d.question || d.choice || d.id, d, d.at);
    const st = stageAt(d.at);
    if (st) link(st, id, 'PRODUCED_BY', d.at);
    if (d.supersedes) link(id, nid('Decision', d.supersedes), 'SUPERSEDES', d.at);
  }

  const findingIds = new Set(state.findings.map((f) => f.id));
  for (const f of state.findings) {
    const id = push('Finding', f.id, `[${f.severity}] ${f.title}`, f, f.at);
    const st = stageAt(f.at);
    if (st) link(st, id, 'PRODUCED_BY', f.at);
  }

  for (const t of state.tasks) {
    const id = push('Task', t.id, t.title || t.id, t, t.at);
    for (const dep of t.dependsOn) link(id, nid('Task', dep), 'DEPENDS_ON', t.at);
    if (t.addresses && findingIds.has(t.addresses)) link(id, nid('Finding', t.addresses), 'ADDRESSES', t.at);
  }

  for (const a of state.artifacts) {
    const id = push('Artifact', a.id, a.path || a.id, a, a.at);
    const st = stageAt(a.at, a.stage);
    if (st) link(id, st, 'PRODUCED_BY', a.at);
  }

  for (const g of state.gates) {
    const id = push('Gate', g.id, `${g.gate}=${g.status}`, g, g.at);
    const st = stageAt(g.at, g.stage);
    if (st) link(st, id, 'VERIFIED_BY', g.at);
  }

  for (const c of state.commits) {
    const id = push('Commit', c.id, c.subject || c.sha, c, c.at);
    if (c.implements) link(id, nid('Task', c.implements), 'IMPLEMENTS', c.at);
  }

  for (const pr of state.prs) {
    const id = push('PR', pr.id, pr.title || `PR #${pr.number}`, pr, pr.at);
    link(id, loopId, 'ADDRESSES', pr.at);
  }

  for (const tr of state.toolRuns) push('ToolRun', tr.id, `${tr.tool} → ${tr.outcome}`, tr, tr.at);

  for (const u of state.unknowns ?? []) {
    const id = push('Unknown', u.id, `[${u.kind}] ${u.statement ?? ''}`, u, u.at);
    const st = stageAt(u.at);
    if (st) link(st, id, 'PRODUCED_BY', u.at); // 這條 unknown 是在哪個階段被挖出來的
  }

  // ── #219 handoff：停在哪個 checkpoint、誰接手、resume 憑什麼不重跑 ─────────
  // 它掛在 Loop 上（HANDED_OFF）而不是掛在某個階段：交接是這條 loop 的成果狀態，
  // 換人接手時要問的是「這條工作到哪了」，不是「哪個階段留下了一份檔案」。
  // 同時掛回產出它的階段（PRODUCED_BY），讓「H3 是誰做出來的」也查得到。
  for (const h of state.handoff?.handoffs ?? []) {
    const id = push('Handoff', h.handoffId, `${h.checkpoint}${h.accepted ? '（已接手）' : ''}`, h, h.at);
    link(loopId, id, 'HANDED_OFF', h.at);
    const st = stageAt(h.at);
    if (st) link(id, st, 'PRODUCED_BY', h.at);
  }

  // ── #218 共享記憶：claim／source／pack 與它們之間的關係 ────────────────────
  // 這一段就是 S6（SQLite 可完整重建）的實體：刪掉整個 index 再 rebuild，claim 的 validity、
  // provenance 與 pack metadata 全部從同一份事件流重新長回來，沒有第二個資料來源。
  const K = state.knowledge ?? { claims: [], packs: [], consumption: [], gaps: [] };
  const claimNodeId = (claim) => nid(CLAIM_NODE_KIND[claim.kind] ?? 'KnowledgeClaim', claim.claimId);
  const sourceKey = (s) => `${s.type}:${s.locator}`;
  const sourceIds = new Map();
  const ensureSource = (s, at) => {
    const key = sourceKey(s);
    if (!sourceIds.has(key)) sourceIds.set(key, push('Source', key, s.locator, { ...s }, at));
    return sourceIds.get(key);
  };

  for (const c of K.claims ?? []) {
    const kind = CLAIM_NODE_KIND[c.kind] ?? 'KnowledgeClaim';
    const id = push(kind, c.claimId, `[${c.validity}] ${c.statement}`, c, c.at);

    for (const s of c.sources ?? []) {
      const sid = ensureSource(s, c.at);
      link(id, sid, 'DERIVED_FROM', c.at);
      // 執行證據型 claim 與它的命令輸出之間是「被這次執行驗證過」，不只是「衍生自」。
      if (c.kind === 'evidence' && s.type === 'command-output') link(id, sid, 'VERIFIED_BY', c.at);
      // 失效時記下是哪個來源動的——事後要查得出「這條為什麼被判失效」。
      if ((c.changedSources ?? []).includes(s.locator)) link(id, sid, 'INVALIDATED_BY', c.at);
      if ((c.refreshCount ?? 0) > 0) link(id, sid, 'REFRESHED_BY', c.refreshedAt ?? c.at);
    }

    for (const parent of c.derivedFrom ?? []) {
      const p = (K.claims ?? []).find((x) => x.claimId === parent);
      if (p) link(id, claimNodeId(p), 'DERIVED_FROM', c.at);
    }
    if (c.supersedes) {
      const prev = (K.claims ?? []).find((x) => x.claimId === c.supersedes);
      if (prev) link(id, claimNodeId(prev), 'SUPERSEDES', c.at);
    }
    // APPLIES_TO ＝「這條事實是為哪個工作單位成立的」：有 task 就掛 task，否則掛建立它的階段。
    const taskId = c.createdBy?.task_id ?? null;
    if (taskId && state.tasks.some((t) => t.id === taskId)) link(id, nid('Task', taskId), 'APPLIES_TO', c.at);
    else {
      const st = stageAt(c.at, c.createdBy?.phase);
      if (st) link(id, st, 'APPLIES_TO', c.at);
    }
  }

  for (const pack of K.packs ?? []) {
    const id = push('ContextPack', pack.packId, `${pack.role}@${pack.phase}（${(pack.claimIds ?? []).length} claims）`, pack, pack.at);
    const st = stageAt(pack.at, pack.phase);
    if (st) link(id, st, 'PRODUCED_BY', pack.at);
    for (const claimId of pack.claimIds ?? []) {
      const c = (K.claims ?? []).find((x) => x.claimId === claimId);
      if (c) link(claimNodeId(c), id, 'CONSUMED_BY', pack.at);
    }
  }

  return { nodes, edges };
}

/** 讀某條 loop 的 ledger → 投影狀態（含 ledger 自己的健康度回報，呼叫端要顯示 warnings）。 */
export function projectLoopDir(loopDir, { slug = null } = {}) {
  const name = slug ?? loopDir.split(/[\\/]/).filter(Boolean).pop();
  const { events, warnings, truncatedTail, duplicates } = readEvents(join(loopDir, 'events.jsonl'));
  return { state: projectEvents(events, { slug: name }), events, warnings, truncatedTail, duplicates };
}

// ── SQLite read model（IO 邊界）──────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS loops (
  slug TEXT PRIMARY KEY, issue INTEGER, type TEXT, operation TEXT, mode TEXT,
  stage TEXT, round INTEGER, done INTEGER, event_count INTEGER, blocking INTEGER
);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, loop TEXT NOT NULL,
  label TEXT, data TEXT, seq INTEGER
);
CREATE TABLE IF NOT EXISTS edges (
  from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL, loop TEXT NOT NULL, seq INTEGER
);
CREATE INDEX IF NOT EXISTS idx_nodes_loop_kind ON nodes(loop, kind);
CREATE INDEX IF NOT EXISTS idx_edges_loop ON edges(loop);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(id UNINDEXED, loop UNINDEXED, kind UNINDEXED, label, body);
`;

/**
 * 開（必要時建）index。回 `{db, fts}`；`fts=false` 代表這個 SQLite build 沒有 FTS5——
 * **只降級搜尋，其餘功能照常**（AC-5）。
 */
export async function openIndex(dbPath) {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  let fts = true;
  try {
    db.exec(FTS_SCHEMA);
  } catch {
    fts = false; // FTS5 不可用：搜尋改走 LIKE fallback，exact 狀態完全不受影響
  }
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('fts', fts ? 'ok' : 'unavailable');
  return { db, fts };
}

/**
 * 把一條 loop 的投影寫進 index（先刪該 loop 既有列再寫 → 冪等）。
 * FTS 寫入單獨包 try/catch：FTS 壞掉不回滾 exact 資料。
 */
export function rebuildLoop({ db, fts }, state) {
  const slug = state.loop.slug;
  const { nodes, edges } = toGraph(state);
  const blocking = selectBlocking(state).count;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM nodes WHERE loop = ?').run(slug);
    db.prepare('DELETE FROM edges WHERE loop = ?').run(slug);
    db.prepare('DELETE FROM loops WHERE slug = ?').run(slug);
    const insNode = db.prepare('INSERT INTO nodes(id, kind, loop, label, data, seq) VALUES(?,?,?,?,?,?)');
    for (const n of nodes) insNode.run(n.id, n.kind, n.loop, String(n.label ?? ''), JSON.stringify(n.data ?? {}), Number(n.seq) || 0);
    const insEdge = db.prepare('INSERT INTO edges(from_id, to_id, kind, loop, seq) VALUES(?,?,?,?,?)');
    for (const e of edges) insEdge.run(e.from, e.to, e.kind, e.loop, Number(e.seq) || 0);
    db.prepare('INSERT INTO loops(slug, issue, type, operation, mode, stage, round, done, event_count, blocking) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(slug, state.issue ?? null, state.loop.type ?? '', state.loop.operation ?? '', state.loop.mode ?? '',
        state.currentStage ?? (state.loop.done ? '完工' : ''), state.round ?? 0, state.loop.done ? 1 : 0, state.eventCount ?? 0, blocking);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  if (fts) {
    try {
      db.prepare('DELETE FROM nodes_fts WHERE loop = ?').run(slug);
      const insFts = db.prepare('INSERT INTO nodes_fts(id, loop, kind, label, body) VALUES(?,?,?,?,?)');
      for (const n of nodes) insFts.run(n.id, n.loop, n.kind, String(n.label ?? ''), JSON.stringify(n.data ?? {}));
    } catch {
      // FTS sidecar 壞掉只影響模糊搜尋——exact 狀態、blocking 判定與 audit trail 已在上面的
      // transaction 內落定，刻意不回滾、不冒泡（AC-5）。
    }
  }
  return { nodes: nodes.length, edges: edges.length, blocking };
}

/** exact 查詢：某 loop 的某類 node。 */
export function queryNodes(db, { loop, kind } = {}) {
  const where = [];
  const args = [];
  if (loop) { where.push('loop = ?'); args.push(loop); }
  if (kind) { where.push('kind = ?'); args.push(kind); }
  const sql = `SELECT id, kind, loop, label, data, seq FROM nodes${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq, id`;
  return db.prepare(sql).all(...args).map((r) => ({ ...r, data: safeJson(r.data) }));
}

/** exact 查詢：某 loop 的 edges。 */
export function queryEdges(db, { loop, kind } = {}) {
  const where = [];
  const args = [];
  if (loop) { where.push('loop = ?'); args.push(loop); }
  if (kind) { where.push('kind = ?'); args.push(kind); }
  const sql = `SELECT from_id, to_id, kind, loop, seq FROM edges${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq, from_id, to_id`;
  return db.prepare(sql).all(...args);
}

/**
 * 模糊搜尋。FTS 可用就走 FTS5，**任何失敗（含 FTS 表壞掉）一律 fallback 成 LIKE 掃描**，
 * 回傳的 `degraded` 讓呼叫端誠實回報「搜尋降級了」（AC-5）。
 */
export function searchNodes({ db, fts }, query, { loop = null, limit = 20 } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return { rows: [], degraded: false };
  if (fts) {
    try {
      const sql = `SELECT id, loop, kind, label FROM nodes_fts WHERE nodes_fts MATCH ?${loop ? ' AND loop = ?' : ''} LIMIT ?`;
      const args = loop ? [q, loop, limit] : [q, limit];
      return { rows: db.prepare(sql).all(...args), degraded: false };
    } catch {
      // 落到下面的 LIKE fallback
    }
  }
  const like = `%${q}%`;
  const sql = `SELECT id, loop, kind, label FROM nodes WHERE (label LIKE ? OR data LIKE ?)${loop ? ' AND loop = ?' : ''} ORDER BY seq LIMIT ?`;
  const args = loop ? [like, like, loop, limit] : [like, like, limit];
  return { rows: db.prepare(sql).all(...args), degraded: true };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return {}; }
}

/** 掃 `.loops/` 下所有含 ledger 的 loop 目錄（略過 `.` 開頭的，例如 `.index`）。 */
export function listLedgerLoops(loopsRoot) {
  if (!existsSync(loopsRoot)) return [];
  const out = [];
  for (const name of readdirSync(loopsRoot)) {
    if (name.startsWith('.')) continue;
    const dir = join(loopsRoot, name);
    try {
      if (statSync(dir).isDirectory() && existsSync(join(dir, 'events.jsonl'))) out.push({ slug: name, dir });
    } catch { /* 單一子目錄失敗跳過 */ }
  }
  return out;
}

/** 全量重建：把 `.loops/` 下每條有 ledger 的 loop 重寫進 index。 */
export async function rebuildAll(loopsRoot, { dbPath = null } = {}) {
  const target = dbPath ?? join(loopsRoot, '.index', 'loops.sqlite');
  const handle = await openIndex(target);
  const results = [];
  for (const { slug, dir } of listLedgerLoops(loopsRoot)) {
    const { state, warnings } = projectLoopDir(dir, { slug });
    results.push({ slug, ...rebuildLoop(handle, state), warnings });
  }
  return { handle, results, dbPath: target };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith('--')) ?? join(process.cwd(), '.loops');
  const { handle, results, dbPath } = await rebuildAll(root);
  handle.db.close();
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ dbPath, fts: handle.fts, results }, null, 2)}\n`);
  } else {
    process.stdout.write(`✓ work graph 重建：${results.length} 條 loop → ${dbPath}${handle.fts ? '' : '（FTS 不可用，搜尋降級）'}\n`);
    for (const r of results) {
      process.stdout.write(`  · ${r.slug}：${r.nodes} nodes / ${r.edges} edges${r.blocking ? `、${r.blocking} 項 blocking` : ''}\n`);
      for (const w of r.warnings) process.stdout.write(`    ! ${w}\n`);
    }
  }
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().then((c) => process.exit(c)).catch((err) => { process.stderr.write(`${err.message}\n`); process.exit(1); });
