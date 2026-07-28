#!/usr/bin/env node
// context-pack.mjs —— Context Broker：依「階段 × 角色 × 任務 × 變更範圍 × 有效事實 × 獨立性邊界 ×
// token budget」組裝 context pack（#172 建立、#218 擴充成 role/task-aware）。
//
// 取代的舊做法是「每個階段把 loop.md ＋ 各 stage markdown 整包重讀」——長度隨 loop 成長無界，
// 且讀進來的多半跟這一步無關。本檔改成：由 work graph 挑**這一步真正需要的**節點，依優先序填進
// 一個**硬上限**的預算裡。
//
// #218 加的兩件事：
//   · **共享事實**：把同一條 loop 已驗證的 knowledge claims（`knowledge-ledger.mjs`）依角色切片放進
//     pack，讓下一個 agent 不必為了「先熟悉專案」把架構重查一遍。只放 `valid` 的；`invalid`／
//     `uncertain` 只列 id 提醒「這條要自己補查」——**不得當 valid 偷渡**（stale fact 比沒有更貴）。
//   · **獨立性邊界**：預算與獨立性是**兩個不同的軸**，別混。預算決定「塞不塞得下」（受保護區段
//     再緊也不丟）；獨立性決定「這個角色**有沒有資格**看到」（`test-author` 看不到實作、reviewer 看不到
//     作者辯護與其他 reviewer 的判定）。被獨立性擋掉的東西**不是**被預算丟掉的，它會出現在
//     `excluded` 而不是 `dropped`——兩者混在一起，就再也分不出「省 token 省掉的」與「刻意不給的」。
//
// pack 是 **content-addressed** 的：同一組輸入永遠算出同一個 `packId`，所以「這個 agent 拿到的到底是
// 哪一份 context」事後查得出來，Context Pack Gate 也才有東西可以比對（見 `context-gate.mjs`）。
//
// 兩條不可退讓的規則：
//   1) **硬預算**：非受保護區段的總量絕不超過 budget（超出就丟，並在 `dropped` 誠實列出丟了什麼）。
//   2) **blocking 永不丟**：未修的 P0/P1 finding、沒過的閘、未決的決策屬**受保護區段**——預算再
//      緊也照放；真的塞不下時把 `overBudget` 標成 true 讓呼叫端知道（而不是靜默丟掉最關鍵的資訊）。
//      這條堵的是「為了省 token 把『還有什麼沒修完』擠掉」——那正是 #162/#188 反覆踩到的失效模式。
//      **這裡的 P0/P1 對應的是「完工前提」那一層（iterate §6：最近一輪 verify 無 actionable
//      findings），不是 pr-gate 閘⑥ 的機械下界（#211 起只認 P0）。兩層刻意不同、不要對齊**：
//      把 P1 從受保護區段拿掉，預算一緊 P1 就會被擠出 context，於是「還沒修完的 P1」沒人記得——
//      那正是本規則要防的事。詳見 `scripts/loop-graph.mjs` 的 `BLOCKING_SEVERITIES`。
//
// 純函式為主（estimateTokens / buildSections / packSections / buildContextPack）；
// 讀檔（artifact 內容）由呼叫端注入 `readSource`，本檔不自己碰 IO。

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readEvents } from './loop-ledger.mjs';
import { projectEvents, selectBlocking } from './loop-graph.mjs';
import { recentEvents, describeEvent } from './loop-snapshot.mjs';
import { globCovers } from './registry-compiler.mjs';
import { KNOWLEDGE_CONTRACT_VERSION, NOT_MEASURED, appendPackBuilt, buildPackMarker, roleProfile } from './knowledge-ledger.mjs';

/** 預設預算（token）。呼叫端一律顯式傳；這個值只是 CLI 的預設。 */
export const DEFAULT_BUDGET = 8000;

/**
 * 沒指定角色時的預設：主線自己。它**不排除任何東西**——主線本來就要看得到還擋著完工的事。
 * 獨立性邊界只對「被派出去做特定工作的 agent」成立，把它套到主線上等於讓主線失明。
 */
export const DEFAULT_ROLE = 'orchestrator';

const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

/**
 * token 估算（**估算，不是實測**——依 Metric-Honesty，呼叫端回報時要標明這是估算值）。
 * CJK 字元約 1 token/字，其餘按 4 字元 ≈ 1 token。刻意保守（寧可高估、不要爆預算）。
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  let cjk = 0;
  for (const ch of s) if (CJK.test(ch)) cjk += 1;
  const rest = s.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

/** 依 token 上限截斷文字（保留開頭、尾端標明截斷）。 */
export function truncateToTokens(text, maxTokens) {
  const s = String(text ?? '');
  if (maxTokens <= 0) return '';
  if (estimateTokens(s) <= maxTokens) return s;
  const marker = '\n…（依 context pack 預算截斷）';
  const reserve = estimateTokens(marker);
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(s.slice(0, mid)) + reserve <= maxTokens) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo) + marker;
}

/** 每個階段最需要看的 node 種類（挑選器，不是硬性排除——只影響優先序）。 */
export const STAGE_FOCUS = Object.freeze({
  goal: ['Issue', 'Decision'],
  explore: ['Issue', 'Decision', 'Artifact'],
  plan: ['Issue', 'Decision', 'Task'],
  build: ['Task', 'Artifact', 'Commit'],
  verify: ['Task', 'Artifact', 'Finding', 'Gate'],
  iterate: ['Finding', 'Gate', 'Task', 'PR'],
});

/**
 * 角色的獨立性邊界 → 這個角色**沒有資格**看到的 channel 集合。
 *
 * **認不得的角色一律拋出**（不回空集合）：空集合等於「什麼都不擋」，於是一個打錯字的
 * `test-authour` 會靜默拿到實作內容——隔離規則被一個 typo 繞過，而且沒有任何訊號。
 * 值域的唯一真相源是 vocabulary 的 `knowledge.roles`，認不得就是設定錯了，早點炸比較便宜。
 */
export function excludedChannels(role) {
  const id = role ?? DEFAULT_ROLE;
  const profile = roleProfile(id);
  if (!profile) {
    throw new Error(`context-pack：認不得的 role「${id}」——合法值見 references/workflow-vocabulary.json 的 knowledge.roles（不猜一組限制：猜空的等於隔離規則被打錯字繞過）`);
  }
  return new Set(profile.excludes ?? []);
}

/** 這個角色拿得到哪些 claim kind；`*` 代表不限（主線）。 */
function allowedKinds(role) {
  const profile = roleProfile(role ?? DEFAULT_ROLE);
  if (!profile || profile.claim_kinds === '*') return null;
  return new Set(profile.claim_kinds ?? []);
}

/** claim 的 scope 有沒有碰到這次的變更範圍（雙向 glob 覆蓋：`client/**` 與 `client/a.ts` 互相算命中）。 */
function scopeTouches(claim, affected) {
  if (!affected || affected.length === 0) return true; // 沒指定範圍 ⇒ 不用範圍篩
  const patterns = [...(claim.scope?.files ?? []), ...(claim.scope?.symbols ?? [])];
  return patterns.some((p) => affected.some((a) => p === a || globCovers(p, a) || globCovers(a, p)));
}

/**
 * 依角色與範圍挑出這次要給的 claims → `{ included, excluded, degraded }`（純函式）。
 *
 * · `included` —— `valid` 且 kind 合角色且 scope 有交集的事實。這才是「不必重新探索」省下來的部分。
 * · `excluded` —— 逐條帶理由：`independence:<channel>`／`role-kind`／`out-of-scope`／`validity:<state>`。
 *   **不靜默丟**：拿不到什麼、為什麼拿不到，agent 與事後稽核都看得到。
 * · `degraded` —— 失效或無法證明仍有效的那幾條，只回 id。列出來是為了讓 agent 知道
 *   「這個範圍我沒有可信的事實」，而不是誤以為那裡本來就沒東西可知道（那會變成靜默的知識空洞）。
 */
export function selectClaims({ claims = [], role = DEFAULT_ROLE, affected = [] } = {}) {
  const kinds = allowedKinds(role);
  const channels = excludedChannels(role);
  const included = [];
  const excluded = [];
  const degraded = [];

  for (const claim of claims) {
    if (claim.validity !== 'valid') {
      if (claim.validity === 'invalid' || claim.validity === 'uncertain') degraded.push({ claimId: claim.claimId, validity: claim.validity });
      else excluded.push({ claimId: claim.claimId, reason: `validity:${claim.validity}` });
      continue;
    }
    // 獨立性優先於角色白名單：被邊界擋掉的要看得出「是被隔離規則擋的」，不是「這角色用不到」。
    if (claim.kind === 'implementation-detail' && channels.has('implementation')) {
      excluded.push({ claimId: claim.claimId, reason: 'independence:implementation' });
      continue;
    }
    if (kinds && !kinds.has(claim.kind)) {
      excluded.push({ claimId: claim.claimId, reason: 'role-kind' });
      continue;
    }
    if (!scopeTouches(claim, affected)) {
      excluded.push({ claimId: claim.claimId, reason: 'out-of-scope' });
      continue;
    }
    included.push(claim);
  }
  return { included, excluded, degraded };
}

/**
 * pack 的 content address。同一組輸入 ⇒ 同一個 id（deterministic），輸入變一個字 ⇒ 換一個 id。
 * 把 contract 版本算進去：契約改了，舊 pack 不該被當成同一份還能重用。
 */
export function computePackId(input) {
  const canonical = JSON.stringify({
    contract: KNOWLEDGE_CONTRACT_VERSION,
    loop: input.loop ?? '',
    phase: input.stage ?? '',
    role: input.role ?? DEFAULT_ROLE,
    task: input.taskId ?? '',
    affected: [...(input.affected ?? [])].sort(),
    claims: [...(input.claimIds ?? [])].sort(),
    budget: input.budget ?? null,
    revision: input.sourceRevision ?? NOT_MEASURED,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
}

/**
 * 由 state 組出候選區段（**尚未套預算**）。每段：
 *   `{id, title, priority（小者先）, protected, truncatable, channel, text}`
 *
 * `channel` 是獨立性邊界的掛鉤（#218）：角色沒資格看的 channel 在這裡就整段不產出，
 * 並回報進 `excludedSections`——被邊界擋掉不等於被預算丟掉，兩者不可混為一談。
 */
export function buildSections({ state, events, stage = null, affected = [], readSource = null, role = DEFAULT_ROLE, claims = null, taskId = '' } = {}) {
  const blocking = selectBlocking(state);
  const focus = STAGE_FOCUS[stage] || [];
  const channels = excludedChannels(role);
  const sections = [];
  const excludedSections = [];
  /** 產一段：被獨立性擋掉就不產、改記一筆理由（回傳 false 讓呼叫端知道這段沒進去）。 */
  const emit = (section) => {
    if (section.channel && channels.has(section.channel)) {
      excludedSections.push({ id: section.id, reason: `independence:${section.channel}` });
      return false;
    }
    sections.push(section);
    return true;
  };

  // ── 受保護：blocking（永不丟）───────────────────────────────────────────
  // channel＝peer-verdict：這一段是**別人已經下的判定**（誰找到什麼問題、哪道閘怎麼判、哪個決策還沒拍板）。
  // 主線與 iteration-controller 必須看得到它；獨立審查的角色不得拿它當判斷框架（S4）。
  // ⚠ 要給 reviewer 的機械訊號（例如某道閘的實際輸出）請走**有 provenance 的 evidence claim**，
  //   不要靠這一段——它與 finding 混在同一段，一起給就等於連別人的結論一起給了。
  const blockingLines = [];
  for (const f of blocking.findings) blockingLines.push(`- finding \`${f.id}\` **${f.severity}**（第 ${f.round} 輪，${f.axis || '未標軸'}）：${f.title}`);
  for (const g of blocking.gates) blockingLines.push(`- 閘 \`${g.gate}\` = **${g.status}**${g.detail ? `（${g.detail}）` : ''}`);
  for (const d of blocking.decisions) blockingLines.push(`- 未決決策 \`${d.id}\`：${d.question}`);
  emit({
    id: 'blocking',
    title: '仍擋著完工的（受保護區段，不因預算丟棄）',
    priority: 0,
    protected: true,
    truncatable: false,
    channel: 'peer-verdict',
    text: blockingLines.length ? blockingLines.join('\n') : '（無未修 P0/P1、無未過的閘、無未決決策）',
  });

  // ── 當前狀態 brief ─────────────────────────────────────────────────────
  const L = state.loop;
  emit({
    id: 'brief',
    title: '當前狀態',
    priority: 1,
    protected: false,
    truncatable: true,
    channel: null,
    text: [
      `loop：${L.slug}${state.issue != null ? `（issue #${state.issue}）` : ''}`,
      `類型 ${L.type || '?'}　operation ${L.operation || '-'}　推進模式 ${L.mode || 'closed'}`,
      `階段 ${L.done ? '完工' : (state.currentStage || '未進入')}　回環 #${state.round}`,
      taskId ? `任務：${taskId}` : '',
      L.stopCondition ? `停止條件：${L.stopCondition}` : '',
    ].filter(Boolean).join('\n'),
  });

  // ── 共享事實（#218）：這條 loop 已驗證、且這個角色拿得到的 claims ─────────
  const pool = claims ?? state.knowledge?.claims ?? [];
  const selection = selectClaims({ claims: pool, role, affected });
  if (selection.included.length > 0 || selection.degraded.length > 0) {
    const rows = [];
    // 失效／無法證明的先講：讓 agent 知道「這個範圍我沒有可信事實」，而不是誤以為那裡沒東西可知道。
    if (selection.degraded.length > 0) {
      rows.push(`> 這些事實已失效或無法證明仍有效，需要時請自己補查（**不得當成仍然成立**）：${selection.degraded.map((d) => `\`${d.claimId}\`[${d.validity}]`).join('、')}`);
    }
    for (const c of selection.included) {
      const anchor = [...(c.sources ?? [])].map((s) => s.locator).slice(0, 3).join('、');
      rows.push(`- \`${c.claimId}\`（${c.kind}）${c.statement}${anchor ? `　來源：${anchor}` : ''}`);
    }
    emit({
      id: 'claims',
      title: '這條 loop 已驗證的共同事實（不必重新探索；來源可查證）',
      priority: 2,
      protected: false,
      truncatable: true,
      channel: null,
      text: rows.join('\n'),
    });
  }

  // ── 本階段最相關的 node ────────────────────────────────────────────────
  if (focus.length) {
    const rows = [];
    if (focus.includes('Task')) for (const t of state.tasks.filter((x) => x.status !== 'done')) rows.push(`- 任務 \`${t.id}\` ${t.title}（${t.status}）`);
    if (focus.includes('Decision')) for (const d of state.decisions.filter((x) => !x.supersededBy).slice(-8)) rows.push(`- 決策 \`${d.id}\`[${d.status}]：${d.question} → ${d.choice}`);
    // finding 是別人的判定：獨立角色不給（同 blocking 段的理由），但其餘節點照給。
    if (focus.includes('Finding') && !channels.has('peer-verdict')) for (const f of state.findings.filter((x) => x.status === 'open')) rows.push(`- finding \`${f.id}\`[${f.severity}] ${f.title}`);
    if (focus.includes('Gate') && !channels.has('peer-verdict')) for (const g of state.gates.slice(-6)) rows.push(`- 閘 \`${g.gate}\` = ${g.status}`);
    if (focus.includes('Artifact')) for (const a of state.artifacts.slice(-10)) rows.push(`- 產出 \`${a.path}\`${a.summary ? ` — ${a.summary}` : ''}`);
    if (focus.includes('Commit')) for (const c of state.commits.slice(-6)) rows.push(`- commit \`${String(c.sha).slice(0, 8)}\` ${c.subject}`);
    if (focus.includes('PR')) for (const p of state.prs) rows.push(`- PR #${p.number}${p.merged ? '（已合併）' : ''} ${p.title}`);
    if (focus.includes('Issue') && state.issue != null) rows.push(`- issue #${state.issue}`);
    if (rows.length) {
      emit({ id: 'stage-focus', title: `${stage} 階段相關節點`, priority: 3, protected: false, truncatable: true, channel: null, text: rows.join('\n') });
    }
  }

  // ── 變更範圍（affected）────────────────────────────────────────────────
  // 隔離規則的實作點（S2）：`test-author` 拿得到「哪些檔在範圍內」，但拿不到**檔案內容**——
  // 看得到實作就寫得出遷就實作的測試。所以這裡不是整段擋掉（那會讓它連範圍都不知道），
  // 而是降級成只列路徑，並把降級這件事記進 excludedSections。
  const bodiesAllowed = !channels.has('implementation');
  if (affected && affected.length) {
    const rows = [];
    for (const key of affected) {
      const art = state.artifacts.find((a) => a.path === key || a.id === key);
      const body = bodiesAllowed && readSource ? readSource(key) : null;
      if (body) rows.push(`### ${key}\n${body}`);
      else rows.push(`- ${key}${art && art.summary ? ` — ${art.summary}` : ''}`);
    }
    if (!bodiesAllowed && readSource) excludedSections.push({ id: 'affected-bodies', reason: 'independence:implementation' });
    sections.push({ id: 'affected', title: '本次變更範圍', priority: 4, protected: false, truncatable: true, channel: null, text: rows.join('\n\n') });
  }

  // ── 最近事件（有界）────────────────────────────────────────────────────
  // finding 事件同樣是別人的判定——獨立角色的 pack 不帶，否則「不給 blocking 段」只是形式，
  // 同一批結論會從事件流這條路整批漏回去。
  const recentSource = channels.has('peer-verdict')
    ? (events || []).filter((e) => e?.type !== 'finding')
    : (events || []);
  const recent = recentEvents(recentSource, 12).map(({ ordinal, event }) => `- [E${ordinal}] ${describeEvent(event)}`);
  if (recent.length) sections.push({ id: 'recent', title: '最近事件', priority: 5, protected: false, truncatable: true, channel: null, text: recent.join('\n') });

  return { sections, excludedSections, selection };
}

/**
 * 套預算。受保護區段先無條件放進去；剩下的依 priority 填，塞不下就先嘗試截斷（truncatable），
 * 截到剩不到 `minSectionTokens` 就整段丟。回傳的 `dropped` 逐條列出丟了什麼與為什麼——
 * **不做靜默截斷**（AGENTS〈no silent caps〉）。
 */
export function packSections(sections, budget, { minSectionTokens = 40 } = {}) {
  const ordered = [...sections].sort((a, b) => a.priority - b.priority);
  const kept = [];
  const dropped = [];
  let used = 0;

  for (const s of ordered.filter((x) => x.protected)) {
    const cost = estimateTokens(s.text) + estimateTokens(s.title);
    kept.push({ ...s, tokens: cost, truncated: false });
    used += cost;
  }
  const overBudget = used > budget;

  for (const s of ordered.filter((x) => !x.protected)) {
    const titleCost = estimateTokens(s.title);
    const room = budget - used - titleCost;
    const full = estimateTokens(s.text);
    if (room >= full) {
      kept.push({ ...s, tokens: full + titleCost, truncated: false });
      used += full + titleCost;
      continue;
    }
    if (s.truncatable && room >= minSectionTokens) {
      const text = truncateToTokens(s.text, room);
      const cost = estimateTokens(text) + titleCost;
      kept.push({ ...s, text, tokens: cost, truncated: true });
      used += cost;
      dropped.push({ id: s.id, reason: 'truncated', droppedTokens: full - estimateTokens(text) });
      continue;
    }
    dropped.push({ id: s.id, reason: overBudget ? 'protected-section-consumed-budget' : 'no-room', droppedTokens: full });
  }

  return { sections: kept, tokensUsed: used, budget, overBudget, dropped };
}

/**
 * 一步到位：state + events → 套好預算、算好身分的 context pack。
 *
 * 回傳值除了既有的預算欄位，另帶 #218 的三組資訊：
 *   · `packId` / `marker` —— content address 與派工要附的那一行（Context Pack Gate 讀它）。
 *   · `claimIds` / `excludedClaims` / `degradedClaims` —— 這份 pack 帶了哪些事實、少了哪些、為什麼。
 *   · `excludedSections` —— 被**獨立性邊界**擋掉的區段（與被**預算**丟掉的 `dropped` 分開列）。
 */
export function buildContextPack({
  state, events, stage = null, affected = [], budget = DEFAULT_BUDGET, readSource = null,
  role = DEFAULT_ROLE, taskId = '', claims = null, sourceRevision = NOT_MEASURED,
} = {}) {
  const built = buildSections({ state, events, stage, affected, readSource, role, claims, taskId });
  const packed = packSections(built.sections, budget);
  const loop = state.loop.slug;
  const claimIds = built.selection.included.map((c) => c.claimId);
  const packId = computePackId({ loop, stage, role, taskId, affected, claimIds, budget, sourceRevision });
  return {
    ...packed,
    stage,
    loop,
    role,
    taskId,
    sourceRevision,
    packId,
    marker: buildPackMarker({
      packId, loopSlug: loop, role, taskId: taskId || '-', sourceRevision, independence: [...excludedChannels(role)].join(',') || 'none',
    }),
    claimIds,
    excludedClaims: built.selection.excluded,
    degradedClaims: built.selection.degraded,
    excludedSections: built.excludedSections,
    estimateMethod: 'heuristic（CJK 1 token/字、其餘 4 字元/token）——估算值，非實測',
  };
}

/** pack → 可直接塞進 prompt 的 markdown。第一行是 pack marker（派工端要保留它，Gate 讀的就是它）。 */
export function renderPack(pack) {
  const head = [];
  if (pack.marker) head.push(pack.marker);
  head.push(`<!-- context pack：loop ${pack.loop}${pack.stage ? ` · ${pack.stage} 階段` : ''} · ${pack.tokensUsed}/${pack.budget} tokens（估算）${pack.overBudget ? ' · 受保護區段已超出預算' : ''} -->`);
  for (const s of pack.sections) head.push('', `## ${s.title}`, '', s.text);
  if (pack.dropped.length) {
    head.push('', '## 因預算未納入的內容（誠實揭露，非靜默截斷）', '');
    for (const d of pack.dropped) head.push(`- \`${d.id}\`：${d.reason}，約 ${d.droppedTokens} tokens 未納入`);
  }
  // 獨立性擋掉的東西**另立一節**：它跟預算無關，混在一起會讓人以為「多給點預算就能拿到」。
  if (pack.excludedSections?.length || pack.excludedClaims?.length) {
    head.push('', '## 因獨立性邊界不提供的內容（與預算無關，這個角色本來就不該拿到）', '');
    for (const e of pack.excludedSections ?? []) head.push(`- 區段 \`${e.id}\`：${e.reason}`);
    const byReason = new Map();
    for (const e of pack.excludedClaims ?? []) byReason.set(e.reason, [...(byReason.get(e.reason) ?? []), e.claimId]);
    for (const [reason, ids] of byReason) head.push(`- 事實 ${ids.map((i) => `\`${i}\``).join('、')}：${reason}`);
  }
  return `${head.join('\n')}\n`;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    process.stdout.write('用法：node context-pack.mjs <loop 目錄> [--stage <name>] [--role <role>] [--task <id>] [--affected <p1,p2>] [--revision <sha>] [--budget <n>] [--record] [--json]\n');
    return 0;
  }
  const flag = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const stage = flag('--stage');
  const role = flag('--role', DEFAULT_ROLE);
  const taskId = flag('--task', '');
  const sourceRevision = flag('--revision', NOT_MEASURED);
  const affected = (flag('--affected', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const budget = args.includes('--budget') ? Number(args[args.indexOf('--budget') + 1]) : DEFAULT_BUDGET;
  const { events } = readEvents(join(dir, 'events.jsonl'));
  const state = projectEvents(events, { slug: dir.split(/[\\/]/).filter(Boolean).pop() });
  const pack = buildContextPack({ state, events, stage, budget, role, taskId, affected, sourceRevision });

  // `--record`：把這份 pack 登記進事件流。Context Pack Gate 認的就是這筆——**產 pack 與登記 pack
  // 分成兩個步驟，就一定會有人只做前者**，然後在派工當下被擋下、回頭補一次。合成一個旗標，
  // 讓「照文件跑一次」就直接是可派工的狀態。
  if (args.includes('--record')) {
    appendPackBuilt(dir, {
      packId: pack.packId, role: pack.role, phase: stage ?? '', taskId,
      claimIds: pack.claimIds,
      droppedClaimIds: pack.dropped.map((d) => d.id),
      excludedClaimIds: pack.excludedClaims.map((e) => e.claimId),
      tokensEstimated: pack.tokensUsed, budget: pack.budget, overBudget: pack.overBudget,
      sourceRevision, independence: [...excludedChannels(role)].join(',') || 'none',
    });
  }

  process.stdout.write(args.includes('--json') ? `${JSON.stringify(pack, null, 2)}\n` : renderPack(pack));
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
