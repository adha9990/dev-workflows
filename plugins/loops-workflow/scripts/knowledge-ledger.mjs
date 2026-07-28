#!/usr/bin/env node
// knowledge-ledger.mjs —— 跨階段共享的 Agent Knowledge Contract（#218）。
//
// 要解的問題：同一條 loop 裡，`define`／`goal`／`explore`／`plan`／`build` 的每個 slice／`verify` 的每個
// reviewer／`iterate` 的每一輪，各自把同一份架構、同一組約定、同一條 caller chain **重新理解一次**。
// `codebase-memory-mcp` 讓「查」變便宜了，但每個 agent 仍要各自發 query、讀結果、把結果轉成自己的
// 理解——重複的是 input、cache read、tool call 與 reasoning，不是查詢本身。
//
// **為什麼不是「每階段寫一份 Markdown 摘要」**：產生敘事文字本身會燒 token，後續 agent 全文讀取又
// 燒一次，於是「重複探索」被換成「重複生成 ＋ 重複閱讀」，還多一份人類要維護的文件。所以共享記憶
// 的資料形狀是**短 claim ＋ scope ＋ provenance ＋ validity**，長內容留在 repo／code graph／既有 artifact，
// claim 只保留可追溯的錨點（statement 有硬性長度上限，見 `STATEMENT_MAX_CHARS`——這條是機械的，
// 不是自律的：寫成一篇架構作文會在 append 當下被拒絕）。
//
// 三條邊界寫在資料形狀裡：
//   ① **只共享事實、不共享結論**：`kind` 是白名單，品質結論在 vocabulary 裡**沒有可用的 kind**；
//      明文擋掉的那幾種（quality-verdict／review-conclusion／readiness／finding-status／recommendation／
//      author-defense）會回一句指名理由的錯誤。獨立 reviewer 仍自己判斷方案或程式對不對。
//   ② **沒有 provenance 就不是 valid**：來源缺 digest、code graph 取不到 revision 時，confidence 只能是
//      `reported`／`not_measured`，validity 上限被壓成 `uncertain`（`normalizeClaim` 自動降級並留下
//      adjustment 記錄）。**不得猜成 valid**——那正是 stale fact 混進下一階段的路徑。
//   ③ **`events.jsonl` 仍是唯一真相源**：agent 不得直接寫 `loops.sqlite`。新知識先 append canonical
//      event，再由 `loop-graph.mjs` 投影成 KnowledgeClaim／Source／ContextPack 節點。來源改變時 append
//      invalidation／refresh 事件，**不修改歷史 event**；刪掉 SQLite 後由事件流重建得到相同的有效記憶。
//
// 分層：純函式（值域、形狀、provenance 評估、reducer、marker）＋ IO 薄邊界（append／read）。
// 寫入與讀取原語只有一套——全部走 `loop-ledger.mjs`，不另寫第二份 JSONL 處理邏輯。
// 依賴：僅 node 內建 ＋ 本 repo 內既有 script。

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendEvent, readEvents } from './loop-ledger.mjs';
import { loadWorkflowVocabulary } from './artifact-contract.mjs';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** knowledge contract 的版本。pack identity 把它算進雜湊——契約改了，舊 pack 不該被當成同一份。 */
export const KNOWLEDGE_CONTRACT_VERSION = 1;

/**
 * statement 的硬性長度上限（Unicode code point）。
 * 這是 S5「agent memory 不產生額外敘事 Markdown」的機械化：claim 是**錨點**不是**作文**，
 * 長內容留在來源。上限訂在 240——足夠寫完一句完整的事實（含路徑），寫不下一段敘事。
 */
export const STATEMENT_MAX_CHARS = 240;

/** claim id 的形狀：可讀、穩定、可當節點鍵。 */
const CLAIM_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** 「量不到」的唯一寫法（Metric-Honesty）——不得用空字串或 0 假裝量過。 */
export const NOT_MEASURED = 'not_measured';

/** validity 的強弱序（降級用；superseded 是終態、不參與比較上限）。 */
const VALIDITY_RANK = Object.freeze({ superseded: 0, invalid: 1, uncertain: 2, valid: 3 });

/** dispatch 端的 context pack 身分標記（Context Pack Gate 讀的就是這一行）。 */
export const PACK_MARKER_RE = /<!--\s*loops-pack\s+([^>]*?)\s*-->/;

// ── 值域：一律從 canonical vocabulary 取，不在這裡寫第二份清單 ──────────────

let vocabularyCache = null;
function vocabulary() {
  if (!vocabularyCache) {
    const loaded = loadWorkflowVocabulary(PLUGIN_ROOT);
    if (loaded.error) throw new Error(`knowledge-ledger：讀不到 workflow vocabulary —— ${loaded.error}`);
    if (!loaded.vocabulary?.knowledge) {
      throw new Error('knowledge-ledger：workflow vocabulary 缺 knowledge 區段（#218 的 canonical 詞彙）');
    }
    vocabularyCache = loaded.vocabulary;
  }
  return vocabularyCache;
}

/** 測試用：換掉 vocabulary（不落檔）。傳 null 還原成從檔案讀。 */
export function __setVocabulary(v) {
  vocabularyCache = v;
}

const idsOf = (list) => (Array.isArray(list) ? list.map((x) => x.id) : []);

export const knowledgeVocabulary = () => vocabulary().knowledge;
export const claimKinds = () => new Set(idsOf(knowledgeVocabulary().claim_kinds));
export const sourceTypes = () => new Map((knowledgeVocabulary().source_types ?? []).map((s) => [s.id, s]));
export const validityStates = () => new Set(idsOf(knowledgeVocabulary().validity_states));
export const confidenceLevels = () => new Set(idsOf(knowledgeVocabulary().confidence_levels));
export const knowledgeEventTypes = () => new Set(idsOf(knowledgeVocabulary().events));
export const independenceChannels = () => new Set(idsOf(knowledgeVocabulary().independence_channels));
/** 被明文擋掉的 kind → 擋它的理由（錯誤訊息要指名，不能只說「不合法」）。 */
export const forbiddenClaimKinds = () =>
  new Map((knowledgeVocabulary().forbidden_claim_kinds ?? []).map((k) => [k.id, k.reason]));

/** role → profile（claim_kinds／excludes）。認不得的 role 回 null，由呼叫端決定怎麼辦。 */
export function roleProfile(roleId) {
  return (knowledgeVocabulary().roles ?? []).find((r) => r.id === roleId) ?? null;
}

export function knownRoles() {
  return new Set(idsOf(knowledgeVocabulary().roles));
}

/**
 * 哪些 activity 是 repo-aware（＝派工前必須附 context pack）。
 * 判定依據只有 vocabulary 這一欄，**不另立第二份名單**——名單一分兩份，Gate 的作用範圍就會漂移。
 */
export function repoAwareActivities() {
  return new Set((vocabulary().activities ?? []).filter((a) => a.repo_aware === true).map((a) => a.id));
}

// ── 純函式：provenance ──────────────────────────────────────────────────────

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v !== '';
const codePoints = (s) => [...String(s ?? '')].length;

/** 內容 → canonical digest。所有來源共用同一支，避免兩處算法不同而對不上帳。 */
export function digestOf(content) {
  return `sha256:${createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex')}`;
}

/** 這個來源有沒有拿到它該有的 provenance（digestable 的要 digest；code graph 的要 revision）。 */
function sourceHasProvenance(source, claim, types) {
  const spec = types.get(source?.type);
  if (!spec) return false;
  if (spec.digestable) return DIGEST_RE.test(String(source?.digest ?? ''));
  // 非 digestable（code graph）：真相由 project ＋ revision 錨定，revision 取不到就是取不到。
  return isNonEmptyString(claim?.graph_project)
    && isNonEmptyString(claim?.graph_revision)
    && claim.graph_revision !== NOT_MEASURED;
}

/**
 * 評估一條 claim 的 provenance → `{ confidence, maxValidity, missing[] }`（純函式）。
 *
 * · 每個來源都有該有的 provenance ⇒ `verified`，validity 上限 `valid`。
 * · 只有部分有 ⇒ `reported`；一個都沒有 ⇒ `not_measured`。兩者的 validity 上限都是 `uncertain`——
 *   **「證明不了仍有效」與「已知失效」不同，但都不是 valid**；把它們當 valid 就是 stale fact 的入口。
 */
export function assessProvenance(claim) {
  const types = sourceTypes();
  const sources = Array.isArray(claim?.sources) ? claim.sources : [];
  if (sources.length === 0) {
    return { confidence: NOT_MEASURED, maxValidity: 'uncertain', missing: ['（沒有任何來源）'] };
  }
  const missing = sources
    .filter((s) => !sourceHasProvenance(s, claim, types))
    .map((s) => `${s?.type ?? '?'}:${s?.locator ?? '?'}`);

  if (missing.length === 0) return { confidence: 'verified', maxValidity: 'valid', missing };
  const confidence = missing.length === sources.length ? NOT_MEASURED : 'reported';
  return { confidence, maxValidity: 'uncertain', missing };
}

/**
 * 依 provenance 把 claim 修成誠實的樣子 → `{ claim, adjustments[] }`（純函式，不改入參）。
 * **降級是自動的、且留痕**：呼叫端寫 `validity: 'valid'` 但來源缺 digest 時，這裡把它壓成
 * `uncertain` 並記一筆 adjustment，而不是靜默接受，也不是直接拒絕整條 claim
 * （拒絕會讓 agent 乾脆不記，於是那條事實下一個階段又要重查一次）。
 */
export function normalizeClaim(input) {
  const claim = { ...(isPlainObject(input) ? input : {}) };
  const adjustments = [];
  const assessment = assessProvenance(claim);

  if (claim.confidence !== assessment.confidence) {
    adjustments.push(`confidence：${claim.confidence ?? '(未填)'} → ${assessment.confidence}（缺 provenance：${assessment.missing.join('、') || '無'}）`);
    claim.confidence = assessment.confidence;
  }

  const requested = claim.validity ?? 'valid';
  // superseded 是 lifecycle 終態、不受 provenance 上限影響（它已經不會被取用）。
  if (requested !== 'superseded') {
    const rank = VALIDITY_RANK[requested] ?? VALIDITY_RANK.uncertain;
    const cap = VALIDITY_RANK[assessment.maxValidity];
    if (rank > cap) {
      adjustments.push(`validity：${requested} → ${assessment.maxValidity}（provenance 只到 ${assessment.confidence}）`);
      claim.validity = assessment.maxValidity;
    } else {
      claim.validity = requested;
    }
  }
  return { claim, adjustments };
}

// ── 純函式：形狀檢查 ────────────────────────────────────────────────────────

/** 檢查一條 claim → 合格回 null；不合格回 `{ reason }`（訊息一律指名欄位與理由）。 */
export function checkClaim(claim) {
  if (!isPlainObject(claim)) return { reason: `claim 不是物件（實際：${typeof claim}）` };

  if (!CLAIM_ID_RE.test(String(claim.claim_id ?? ''))) {
    return { reason: `claim_id 必須是字母開頭的穩定識別碼（實際：${JSON.stringify(claim.claim_id)}）` };
  }

  const forbidden = forbiddenClaimKinds();
  if (forbidden.has(claim.kind)) {
    return { reason: `kind「${claim.kind}」是**結論不是事實**，共享記憶只共享事實：${forbidden.get(claim.kind)}` };
  }
  if (!claimKinds().has(claim.kind)) {
    return { reason: `kind「${claim.kind}」不在 canonical claim kinds 內（見 references/workflow-vocabulary.json 的 knowledge.claim_kinds）` };
  }

  if (!isNonEmptyString(claim.statement)) return { reason: 'statement 必須是非空字串' };
  if (codePoints(claim.statement) > STATEMENT_MAX_CHARS) {
    return {
      reason: `statement 超過 ${STATEMENT_MAX_CHARS} 字（實際 ${codePoints(claim.statement)}）——claim 是錨點不是敘事，長內容留在來源、這裡只寫一句可查證的事實`,
    };
  }

  const scope = claim.scope;
  if (!isPlainObject(scope)) return { reason: 'scope 必須是物件（至少帶 files 或 symbols）' };
  const files = Array.isArray(scope.files) ? scope.files : [];
  const symbols = Array.isArray(scope.symbols) ? scope.symbols : [];
  if (files.length === 0 && symbols.length === 0) {
    return { reason: 'scope.files 與 scope.symbols 不得同時為空——沒有 scope 的 claim 無法被 invalidation 追蹤，也選不進任何 pack' };
  }
  if ([...files, ...symbols].some((x) => !isNonEmptyString(x))) {
    return { reason: 'scope.files／scope.symbols 的每一項都必須是非空字串' };
  }

  const sources = claim.sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    return { reason: 'sources 必須是非空陣列——沒有來源的 claim 無從查證，也無從失效' };
  }
  const types = sourceTypes();
  for (const s of sources) {
    if (!isPlainObject(s)) return { reason: 'sources 的每一項都必須是物件' };
    if (!types.has(s.type)) return { reason: `source type「${s.type}」不在 canonical source types 內` };
    if (!isNonEmptyString(s.locator)) return { reason: `source（${s.type}）缺 locator` };
    if (s.digest !== undefined && s.digest !== null && !DIGEST_RE.test(String(s.digest))) {
      return { reason: `source（${s.locator}）的 digest 形狀不合法，必須是 sha256:<64 hex>（實際：${s.digest}）` };
    }
  }
  if (sources.some((s) => types.get(s.type)?.digestable === false) && !isNonEmptyString(claim.graph_project)) {
    return { reason: 'claim 有 code-graph 來源，就必須帶 graph_project（否則那份 snapshot 事後認不出來）' };
  }

  if (!validityStates().has(claim.validity)) {
    return { reason: `validity 必須是 ${[...validityStates()].join('｜')}（實際：${claim.validity}）` };
  }
  if (!confidenceLevels().has(claim.confidence)) {
    return { reason: `confidence 必須是 ${[...confidenceLevels()].join('｜')}（實際：${claim.confidence}）` };
  }

  const by = claim.created_by;
  if (!isPlainObject(by) || !isNonEmptyString(by.phase) || !isNonEmptyString(by.agent_role)) {
    return { reason: 'created_by 必須帶 phase 與 agent_role（事後要查得出這條事實是誰、在哪個階段建立的）' };
  }
  if (!isNonEmptyString(claim.created_at_revision)) {
    return { reason: `created_at_revision 必須是 git sha 或字面 ${NOT_MEASURED}（不得留空）` };
  }
  if (claim.derived_from !== undefined && (!Array.isArray(claim.derived_from) || claim.derived_from.some((x) => !isNonEmptyString(x)))) {
    return { reason: 'derived_from 必須是 claim id 的字串陣列' };
  }

  // 誠實一致性：宣稱的 confidence／validity 不得高於 provenance 撐得住的程度。
  const assessment = assessProvenance(claim);
  if (claim.confidence !== assessment.confidence) {
    return {
      reason: `confidence 宣稱 ${claim.confidence}，但依 provenance 只能是 ${assessment.confidence}（缺：${assessment.missing.join('、') || '無'}）`,
    };
  }
  if (claim.validity !== 'superseded' && (VALIDITY_RANK[claim.validity] ?? 0) > VALIDITY_RANK[assessment.maxValidity]) {
    return { reason: `validity 宣稱 ${claim.validity}，但 provenance 只到 ${assessment.confidence}，上限是 ${assessment.maxValidity}` };
  }
  return null;
}

// ── 純函式：context pack 的身分標記 ─────────────────────────────────────────

const escapeAttr = (v) => String(v).replace(/"/g, '&quot;').replace(/>/g, '&gt;');
const unescapeAttr = (v) => String(v).replace(/&gt;/g, '>').replace(/&quot;/g, '"');

const PACK_FIELDS = Object.freeze([
  ['id', 'packId'],
  ['loop', 'loopSlug'],
  ['role', 'role'],
  ['task', 'taskId'],
  ['revision', 'sourceRevision'],
  ['independence', 'independence'],
]);

/**
 * 組出派工端要附的一行 pack marker。缺欄位就拋——寫出一個必然解析失敗的 marker，
 * 等於在派工當下就製造一次「事後查不出這個 agent 拿到什麼」的斷點。
 */
export function buildPackMarker(input) {
  const v = input ?? {};
  const missing = PACK_FIELDS.filter(([, prop]) => !isNonEmptyString(v[prop])).map(([key]) => key);
  if (missing.length > 0) throw new Error(`knowledge-ledger：pack marker 缺必填欄位 ${missing.join('、')}`);
  return `<!-- loops-pack ${PACK_FIELDS.map(([key, prop]) => `${key}="${escapeAttr(v[prop])}"`).join(' ')} -->`;
}

/** 解析一行 pack marker → 物件；缺任一必填欄位一律 null（半套 marker 比沒有更危險）。 */
export function parsePackMarker(text) {
  if (typeof text !== 'string') return null;
  const m = PACK_MARKER_RE.exec(text);
  if (!m) return null;
  const attrs = new Map();
  for (const a of m[1].matchAll(/([a-z]+)="([^"]*)"/g)) attrs.set(a[1], unescapeAttr(a[2]));
  const out = {};
  for (const [key, prop] of PACK_FIELDS) {
    const raw = attrs.get(key);
    if (!isNonEmptyString(raw)) return null;
    out[prop] = raw;
  }
  return out;
}

// ── 純函式：reducer（事件流 → 知識狀態）──────────────────────────────────────

export function emptyKnowledgeState() {
  return {
    enabled: false,
    contractVersion: KNOWLEDGE_CONTRACT_VERSION,
    claims: [],
    packs: [],
    consumption: [],
    gaps: [],
  };
}

const findClaim = (state, id) => state.claims.find((c) => c.claimId === id) ?? null;

/**
 * 把一筆 knowledge／context-pack 事件套進知識狀態（純函式，就地更新 state；認不得的 type 回 false）。
 *
 * **同一份 reducer 兩個入口**：`projectKnowledge()`（獨立投影）與 `loop-graph.projectEvents()`
 * （work graph 投影）都走這裡，不各自實作一次——兩份 reducer 遲早對「什麼叫仍然有效」給出不同答案。
 */
export function reduceKnowledgeEvent(state, event, at = 0) {
  const p = event?.payload ?? {};
  switch (event?.type) {
    case 'knowledge.claimed': {
      state.enabled = true;
      const claim = p.claim ?? {};
      const id = claim.claim_id ?? p.claimId;
      if (!isNonEmptyString(id)) return true; // 沒有 id 的 claim 進不了狀態，但事件本身仍被認得
      const existing = findClaim(state, id);
      const record = {
        claimId: id,
        at,
        kind: claim.kind ?? '',
        statement: claim.statement ?? '',
        scope: claim.scope ?? { files: [], symbols: [] },
        sources: Array.isArray(claim.sources) ? claim.sources : [],
        derivedFrom: Array.isArray(claim.derived_from) ? claim.derived_from : [],
        graphProject: claim.graph_project ?? null,
        graphRevision: claim.graph_revision ?? null,
        confidence: claim.confidence ?? NOT_MEASURED,
        validity: claim.validity ?? 'uncertain',
        validityReason: p.adjustments?.length ? p.adjustments.join('；') : '',
        createdBy: claim.created_by ?? {},
        createdAtRevision: claim.created_at_revision ?? NOT_MEASURED,
        supersedes: claim.supersedes ?? null,
        supersededBy: existing?.supersededBy ?? null,
        refreshCount: existing?.refreshCount ?? 0,
      };
      if (existing) Object.assign(existing, record);
      else state.claims.push(record);
      if (isNonEmptyString(claim.supersedes)) {
        const prev = findClaim(state, claim.supersedes);
        if (prev) {
          prev.validity = 'superseded';
          prev.supersededBy = id;
        }
      }
      return true;
    }
    case 'knowledge.invalidated': {
      state.enabled = true;
      const c = findClaim(state, p.claimId);
      if (c) {
        // 只認 invalid／uncertain 兩種降級——invalidation 事件不得用來把東西升回 valid。
        c.validity = p.validity === 'invalid' ? 'invalid' : 'uncertain';
        c.validityReason = p.reason ?? '';
        c.invalidationCause = p.cause ?? 'source';
        c.changedSources = Array.isArray(p.changedSources) ? p.changedSources : [];
      }
      return true;
    }
    case 'knowledge.refreshed': {
      state.enabled = true;
      const c = findClaim(state, p.claimId);
      if (c) {
        const refreshed = p.claim ?? {};
        if (Array.isArray(refreshed.sources)) c.sources = refreshed.sources;
        if (isNonEmptyString(refreshed.statement)) c.statement = refreshed.statement;
        if (isNonEmptyString(refreshed.graph_revision)) c.graphRevision = refreshed.graph_revision;
        if (isNonEmptyString(refreshed.confidence)) c.confidence = refreshed.confidence;
        c.validity = refreshed.validity ?? 'valid';
        c.validityReason = p.reason ?? '';
        c.changedSources = [];
        c.refreshCount = (c.refreshCount ?? 0) + 1;
        c.refreshedAt = at;
      }
      return true;
    }
    case 'knowledge.superseded': {
      state.enabled = true;
      const c = findClaim(state, p.claimId);
      if (c) {
        c.validity = 'superseded';
        c.supersededBy = p.supersededBy ?? null;
      }
      return true;
    }
    case 'knowledge.consumed': {
      state.enabled = true;
      state.consumption.push({
        at,
        claimId: p.claimId ?? '',
        packId: p.packId ?? '',
        agentRole: p.agentRole ?? '',
        agentId: p.agentId ?? '',
        phase: p.phase ?? '',
        taskId: p.taskId ?? '',
      });
      return true;
    }
    case 'context-pack.built': {
      state.enabled = true;
      const packId = p.packId ?? '';
      if (!isNonEmptyString(packId)) return true;
      const existing = state.packs.find((x) => x.packId === packId);
      const record = {
        packId,
        at,
        role: p.role ?? '',
        phase: p.phase ?? '',
        taskId: p.taskId ?? '',
        claimIds: Array.isArray(p.claimIds) ? p.claimIds : [],
        droppedClaimIds: Array.isArray(p.droppedClaimIds) ? p.droppedClaimIds : [],
        excludedClaimIds: Array.isArray(p.excludedClaimIds) ? p.excludedClaimIds : [],
        tokensEstimated: Number.isFinite(p.tokensEstimated) ? p.tokensEstimated : null,
        budget: Number.isFinite(p.budget) ? p.budget : null,
        overBudget: p.overBudget === true,
        sourceRevision: p.sourceRevision ?? NOT_MEASURED,
        independence: p.independence ?? '',
        consumedBy: existing?.consumedBy ?? [],
      };
      if (existing) Object.assign(existing, record);
      else state.packs.push(record);
      return true;
    }
    case 'context-pack.consumed': {
      state.enabled = true;
      const pack = state.packs.find((x) => x.packId === p.packId);
      if (pack) pack.consumedBy.push({ at, agentRole: p.agentRole ?? '', agentId: p.agentId ?? '', dispatchId: p.dispatchId ?? '' });
      return true;
    }
    case 'context-gap.detected': {
      state.enabled = true;
      state.gaps.push({
        at,
        packId: p.packId ?? '',
        role: p.role ?? '',
        gap: p.gap ?? '',
        requestedScope: Array.isArray(p.requestedScope) ? p.requestedScope : [],
        resolvedByClaimId: p.resolvedByClaimId ?? null,
      });
      return true;
    }
    default:
      return false;
  }
}

/** 事件流（**檔案行序**）→ 知識狀態。純函式：同一組事件永遠得到同一份狀態。 */
export function projectKnowledge(events) {
  const state = emptyKnowledgeState();
  let at = 0;
  for (const ev of events || []) {
    reduceKnowledgeEvent(state, ev, at);
    at += 1;
  }
  return state;
}

/** 目前仍可重用的 claims（`valid` 才算——`uncertain` 不得當 `valid` 偷渡）。 */
export function validClaims(state) {
  return (state?.claims ?? []).filter((c) => c.validity === 'valid');
}

/**
 * 某個 agent 目前的 compact state（S7 的 delta work 用）：它讀過哪些 claim、審過哪個 revision、
 * 哪些讀過的 claim 已經失效。**不保存整段對話副本**——那正是要避免的成本。
 */
export function buildAgentState(state, agentId) {
  const rows = (state?.consumption ?? []).filter((c) => c.agentId === agentId);
  const byId = new Map((state?.claims ?? []).map((c) => [c.claimId, c]));
  const consumed = [...new Set(rows.map((r) => r.claimId))];
  const packIds = [...new Set(rows.map((r) => r.packId))];
  const packs = (state?.packs ?? []).filter((p) => packIds.includes(p.packId));
  return {
    agentId,
    consumedClaimIds: consumed,
    packIds,
    reviewedRevisions: [...new Set(packs.map((p) => p.sourceRevision))],
    invalidatedClaimIds: consumed.filter((id) => {
      const v = byId.get(id)?.validity;
      return v === 'invalid' || v === 'uncertain' || v === 'superseded';
    }),
    openGaps: (state?.gaps ?? []).filter((g) => packIds.includes(g.packId) && !g.resolvedByClaimId),
  };
}

// ── IO 薄邊界 ───────────────────────────────────────────────────────────────

/** 一條 loop 的 canonical 事件流落點（knowledge 事件與 workflow 事件同一份，不另開第二套資料庫）。 */
export const ledgerPath = (loopDir) => join(loopDir, 'events.jsonl');

/**
 * append 一筆 knowledge／context-pack 事件 → 實際寫出去的那筆。
 * type 不在 canonical 清單就拋——認不得的型別靜默寫進去，會讓投影少掉一整類卻沒人發現。
 */
export function appendKnowledgeEvent(loopDir, type, payload) {
  if (!knowledgeEventTypes().has(type)) {
    throw new Error(`knowledge-ledger：拒絕 append —— 事件型別「${type}」不在 canonical knowledge events 內`);
  }
  return appendEvent(ledgerPath(loopDir), { type, payload });
}

/**
 * append 一條新事實（`knowledge.claimed`）→ `{ event, claim, adjustments }`。
 * 先 normalize（自動誠實降級並留痕）再 check（形狀），不合格在碰檔案之前就拋。
 */
export function appendClaim(loopDir, input) {
  const { claim, adjustments } = normalizeClaim(input);
  const problem = checkClaim(claim);
  if (problem) throw new Error(`knowledge-ledger：拒絕 append claim —— ${problem.reason}`);
  const event = appendKnowledgeEvent(loopDir, 'knowledge.claimed', {
    nodeId: claim.claim_id,
    claimId: claim.claim_id,
    claim,
    adjustments,
  });
  return { event, claim, adjustments };
}

/** 記一次「某個 agent 透過某份 pack 取用了某條 claim」。 */
export function appendConsumed(loopDir, { claimId, packId, agentRole, agentId, phase = '', taskId = '' }) {
  return appendKnowledgeEvent(loopDir, 'knowledge.consumed', {
    nodeId: `${packId}:${claimId}`, claimId, packId, agentRole, agentId, phase, taskId,
  });
}

/**
 * 記一次失效。`validity` 只認 invalid／uncertain——這個事件不得用來把東西升回 valid。
 * `cause` 分「來源自己變了（source）」與「上游 claim 動了（derived）」，事後才看得出失效是怎麼傳開的。
 */
export function appendInvalidated(loopDir, { claimId, validity = 'invalid', reason, changedSources = [], cause = 'source' }) {
  return appendKnowledgeEvent(loopDir, 'knowledge.invalidated', {
    nodeId: claimId, claimId, validity: validity === 'uncertain' ? 'uncertain' : 'invalid', reason, changedSources, cause,
  });
}

/** 記一次局部補查。傳進來的 claim 同樣先 normalize＋check，refresh 不是繞過誠實檢查的後門。 */
export function appendRefreshed(loopDir, { claimId, claim: input, reason = '' }) {
  const { claim, adjustments } = normalizeClaim(input);
  const problem = checkClaim(claim);
  if (problem) throw new Error(`knowledge-ledger：拒絕 append refresh —— ${problem.reason}`);
  return appendKnowledgeEvent(loopDir, 'knowledge.refreshed', {
    nodeId: claimId, claimId, claim, reason, adjustments,
  });
}

/** 記一次取代（新 claim 已經 append 過才呼叫；本事件只負責把舊的標成 superseded）。 */
export function appendSuperseded(loopDir, { claimId, supersededBy }) {
  return appendKnowledgeEvent(loopDir, 'knowledge.superseded', { nodeId: claimId, claimId, supersededBy });
}

/** 記一份 pack 的誕生（Context Pack Gate 就是靠這筆認得 pack 身分）。 */
export function appendPackBuilt(loopDir, pack) {
  return appendKnowledgeEvent(loopDir, 'context-pack.built', { nodeId: pack.packId, ...pack });
}

/** 記一份 pack 真的被派出去給誰。 */
export function appendPackConsumed(loopDir, { packId, agentRole, agentId, dispatchId }) {
  return appendKnowledgeEvent(loopDir, 'context-pack.consumed', {
    nodeId: `${packId}:${dispatchId}`, packId, agentRole, agentId, dispatchId,
  });
}

/**
 * 記一個**具體**缺口。agent 只能指名缺什麼，不得以「先熟悉專案」為理由重跑完整 architecture discovery
 * ——所以 `gap` 是必填的一句話，`requestedScope` 是具體的檔案／symbol 清單。
 */
export function appendGap(loopDir, { packId, role, gap, requestedScope = [] }) {
  if (!isNonEmptyString(gap)) throw new Error('knowledge-ledger：context-gap 必須指名缺什麼（不得只說「需要更多脈絡」）');
  return appendKnowledgeEvent(loopDir, 'context-gap.detected', { packId, role, gap, requestedScope });
}

/** 讀回一條 loop 的知識狀態（含 ledger 自己的健康度回報，呼叫端要顯示 warnings）。 */
export function readKnowledge(loopDir) {
  const { events, warnings, truncatedTail, duplicates } = readEvents(ledgerPath(loopDir));
  return { state: projectKnowledge(events), events, warnings, truncatedTail, duplicates };
}
