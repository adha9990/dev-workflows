#!/usr/bin/env node
// handoff-ledger.mjs —— handoff checkpoint 的契約、事件與 resume freshness（#219）。
//
// 要解的問題：PM 可能只要開好 issue、架構師可能只要完成 plan、工程師可能只交 build 給 QA、QA 也可能
// 只完成 verify。這些停點過去會被當成「流程沒跑完」、或被 routine transition 自動跨過，逼同一個 session
// 繼續燒 token；換 session／換人接手時，新的 agent 又因為缺少 checkpoint contract 而重新 define、重新
// 探索、重新規劃。本檔把「做到哪裡算完成」變成**可機械判定**的資料：
//   ① 每個 checkpoint 要帶哪些內容、下一個合法入口是誰、建議由誰接手 —— 值域在 canonical vocabulary；
//   ② 到達 `stop_after` 之後，下一階段的 mutating action 一律被擋（`hooks/handoff-stop-guard.mjs`）；
//   ③ resume 先驗 freshness，通過就**不重跑已完成階段**，失敗只失效受影響的那一段。
//
// **不另建 handoff database**（#219 明列的非目標）：事件走 `loop-ledger.mjs` 的同一份 `events.jsonl`，
// 再由 `loop-graph.mjs` 投影成 Handoff 節點，人看的 Markdown 由 #217 的 artifact contract 產。三層各有
// 各的用途，但真相源只有事件流一份。
//
// 誠實邊界（憲章規則 5）：freshness 的每一項只有三種結果 —— `pass`／`fail`／`not_measured`。
//   量不到的**不得**算 pass：把「沒查」寫成「查過沒問題」，正是 resume 之後靜默重跑錯東西的起點。
//   有任何一項 `not_measured` 時，整份 freshness 的 `verdict` 是 `uncertain`，不是 `fresh`。
//
// 分層：純函式（值域、契約形狀、stop_after 解析、freshness、reducer）＋ IO 薄邊界（append／read）。
// 依賴：僅 node 內建 ＋ 本 repo 內既有 script。

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

import { appendEvent, readEvents } from './loop-ledger.mjs';
import { loadWorkflowVocabulary } from './artifact-contract.mjs';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 「量不到」的唯一寫法（與 knowledge-ledger 同一個字面，不另造第二種）。 */
export const NOT_MEASURED = 'not_measured';

/** freshness 的三種結果。`not_measured` **不算通過**——那是誠實承認沒查，不是查過沒問題。 */
export const CHECK_RESULTS = Object.freeze(['pass', 'fail', 'not_measured']);

/** 整份 freshness 的判定。`uncertain` 存在的唯一理由是：不讓「沒量到」被四捨五入成 fresh。 */
export const FRESHNESS_VERDICTS = Object.freeze(['fresh', 'stale', 'uncertain']);

/**
 * freshness 每一項失敗時，**最早受影響的 phase**。
 * resume 回到這幾個之中最早的那一個，而不是整條重跑——這是 #219 S5 的核心：
 * 「freshness 失敗時只 invalidates 受影響的 decisions／artifacts／knowledge claims」。
 */
export const CHECK_AFFECTS_PHASE = Object.freeze({
  'goal-revision': 'plan',
  'source-revision': 'build',
  'artifact-validity': 'build',
  'pending-work': 'build',
});

// ── 值域：一律從 canonical vocabulary 取，不在這裡寫第二份清單 ────────────────

let vocabularyCache = null;
function vocabulary() {
  if (!vocabularyCache) {
    const loaded = loadWorkflowVocabulary(PLUGIN_ROOT);
    if (loaded.error) throw new Error(`handoff-ledger：讀不到 workflow vocabulary —— ${loaded.error}`);
    if (!loaded.vocabulary?.handoff) {
      throw new Error('handoff-ledger：workflow vocabulary 缺 handoff 區段（#219 的 canonical 詞彙）');
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

export const handoffVocabulary = () => vocabulary().handoff;
export const checkpointIds = () => idsOf(handoffVocabulary().checkpoints);
export const stopAfterValues = () => [...(handoffVocabulary().stop_after ?? [])];
export const handoffStatuses = () => new Set(idsOf(handoffVocabulary().statuses));
export const handoffStopReasons = () => new Set(idsOf(handoffVocabulary().stop_reasons));
export const handoffOwners = () => new Set(idsOf(handoffVocabulary().owners));
export const handoffEventTypes = () => new Set(idsOf(handoffVocabulary().events));
export const freshnessCheckIds = () => idsOf(handoffVocabulary().freshness_checks);

/** checkpoint id → 完整定義（認不得回 null，由呼叫端決定怎麼辦）。 */
export function checkpointProfile(id) {
  return (handoffVocabulary().checkpoints ?? []).find((c) => c.id === id) ?? null;
}

/** entry id → 完整定義（起點 phase 與該入口的安全預設終點）。 */
export function entryProfile(id) {
  return (vocabulary().entries ?? []).find((e) => e.id === id) ?? null;
}

/** phase id → order（認不得回 null——猜一個 order 會讓越界判定靜默失準）。 */
export function phaseOrder(phaseId) {
  const phase = (vocabulary().phases ?? []).find((p) => p.id === phaseId);
  return phase ? phase.order : null;
}

/** stop_after → 它允許做完的最後一個 phase 的 order（認不得回 null）。 */
export function stopAfterOrder(stopAfter) {
  const profile = checkpointProfile(stopAfter);
  return profile ? phaseOrder(profile.after_phase) : null;
}

// ── 純函式：stop_after 解析 ─────────────────────────────────────────────────

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v !== '';

/**
 * 從使用者意圖解析 `stop_after` → `{ stopAfter, source, reason }`。
 *
 * 優先序刻意是「明講的 > 意圖字面 > 入口預設」：
 *   · `explicit` —— 使用者直接指定（`--stop-after build`），最高優先，認不得就拋（打錯字不該靜默退成預設）。
 *   · `intent`   —— vocabulary 的 intent_map 逐條比對使用者的話。**只做包含比對、不做模糊猜測**：
 *                   猜錯的代價是跨過使用者要求的停點，那正是本票要消除的形狀。
 *   · `entry`    —— 都沒有時才用該入口的安全預設終點（`default_stop_after`）。
 */
export function resolveStopAfter({ explicit = null, intent = null, entry = null } = {}) {
  const allowed = stopAfterValues();

  if (isNonEmptyString(explicit)) {
    if (!allowed.includes(explicit)) {
      throw new Error(`handoff-ledger：stop_after「${explicit}」不在 canonical 值域（合法值：${allowed.join('｜')}）`);
    }
    return { stopAfter: explicit, source: 'explicit', reason: '使用者明確指定' };
  }

  if (isNonEmptyString(intent)) {
    const text = intent.replace(/\s+/g, '');
    for (const row of handoffVocabulary().intent_map ?? []) {
      if (text.includes(row.intent.replace(/\s+/g, ''))) {
        return { stopAfter: row.stop_after, source: 'intent', reason: `意圖對照表命中「${row.intent}」` };
      }
    }
  }

  if (isNonEmptyString(entry)) {
    const profile = entryProfile(entry);
    if (!profile) {
      throw new Error(`handoff-ledger：認不得的入口「${entry}」（合法值：${idsOf(vocabulary().entries).join('｜')}）`);
    }
    if (profile.default_stop_after) {
      return { stopAfter: profile.default_stop_after, source: 'entry-default', reason: `入口 ${entry} 的安全預設終點` };
    }
  }

  return { stopAfter: null, source: 'unresolved', reason: '沒有明確 partial intent，也沒有入口預設——由呼叫端決定要不要問' };
}

/**
 * 做完 `phase` 之後，是否已經到達 `stopAfter`？
 * 用 order 比較而不是字串相等：跳過中間階段（例如已有 approved plan 直接 build）時，
 * 字串相等會讓 stop 條件永遠不成立，於是 workflow 直接開過頭。
 */
export function reachedStopAfter(phase, stopAfter) {
  const here = phaseOrder(phase);
  const limit = stopAfterOrder(stopAfter);
  if (here === null || limit === null) return false;
  return here >= limit;
}

/**
 * 在 `stopAfter` 已停下的狀態，對 `targetPhase` 動手是不是越界 → boolean。
 * 這是 Handoff Stop Gate 的判定核心：**到達 stop_after 後，任何下一階段的 mutating action
 * 都要被擋住，直到收到明確 resume**。同階段的收尾動作（例如補寫 handoff 本身）不算越界。
 */
export function crossesHandoff(stopAfter, targetPhase) {
  const limit = stopAfterOrder(stopAfter);
  const target = phaseOrder(targetPhase);
  if (limit === null || target === null) return false;
  return target > limit;
}

// ── 純函式：handoff contract 形狀 ───────────────────────────────────────────

/**
 * 檢查一份 handoff contract → 合格回 null；不合格回 `{ reason }`（訊息一律指名欄位）。
 * 值域全部來自 vocabulary：checkpoint／status／stop_reason／suggested_owner／next_entry。
 */
export function checkHandoffContract(handoff) {
  if (!isPlainObject(handoff)) return { reason: `handoff 不是物件（實際：${typeof handoff}）` };

  for (const field of (handoffVocabulary().contract_fields ?? []).filter((f) => f.required)) {
    if (!(field.id in handoff)) return { reason: `缺必要欄位 ${field.id}（${field.description}）` };
  }

  const profile = checkpointProfile(handoff.checkpoint);
  if (!profile) {
    return { reason: `checkpoint「${handoff.checkpoint}」不在 canonical 清單（合法值：${checkpointIds().join('｜')}）` };
  }
  if (!handoffStatuses().has(handoff.status)) {
    return { reason: `status「${handoff.status}」不在 canonical 清單（合法值：${[...handoffStatuses()].join('｜')}）` };
  }
  if (!handoffStopReasons().has(handoff.stop_reason)) {
    return { reason: `stop_reason「${handoff.stop_reason}」不在 canonical 清單（合法值：${[...handoffStopReasons()].join('｜')}）` };
  }
  if (!handoffOwners().has(handoff.suggested_owner)) {
    return { reason: `suggested_owner「${handoff.suggested_owner}」不在 canonical 清單（合法值：${[...handoffOwners()].join('｜')}）` };
  }

  for (const field of ['completed', 'pending', 'artifacts']) {
    if (!Array.isArray(handoff[field])) {
      return { reason: `${field} 必須是陣列（沒有就給空陣列，不要省略——省略與「刻意沒有」分不出來）` };
    }
  }
  // completed 為空的 `ready` 是自相矛盾的：宣稱 requested scope 已完成，卻說不出完成了什麼。
  if (handoff.status === 'ready' && handoff.stop_reason === 'requested-scope' && handoff.completed.length === 0) {
    return { reason: 'status=ready 且 stop_reason=requested-scope 時 completed 不得為空——說不出完成了什麼，就不是完成' };
  }

  if (!Number.isInteger(handoff.goal_revision) || handoff.goal_revision < 1) {
    return { reason: `goal_revision 必須是 ≥1 的整數（實際：${handoff.goal_revision}）` };
  }
  if (!isNonEmptyString(handoff.source_revision)) {
    return { reason: `source_revision 必須是非空字串；量不到就寫 ${NOT_MEASURED}（不得省略或留空）` };
  }

  // next_entry 允許 null（終點 checkpoint），但**不允許亂填**：填了就得是認得的入口。
  if (handoff.next_entry !== null && !entryProfile(handoff.next_entry)) {
    return { reason: `next_entry「${handoff.next_entry}」不是認得的入口（合法值：${idsOf(vocabulary().entries).join('｜')}，終點可為 null）` };
  }

  return null;
}

/**
 * 由 checkpoint 補完可推導的欄位 → `{ handoff, adjustments }`。
 * 只補**vocabulary 已經定死**的東西（next_entry／suggested_owner），不猜內容欄位——
 * completed／pending／artifacts 是這次真的做了什麼，猜出來的等於捏造交接內容。
 */
export function normalizeHandoff(input) {
  const src = isPlainObject(input) ? input : {};
  const profile = checkpointProfile(src.checkpoint);
  const adjustments = [];
  const handoff = {
    checkpoint: src.checkpoint,
    status: src.status ?? 'ready',
    stop_reason: src.stop_reason ?? 'requested-scope',
    completed: Array.isArray(src.completed) ? [...src.completed] : [],
    pending: Array.isArray(src.pending) ? [...src.pending] : [],
    artifacts: Array.isArray(src.artifacts) ? [...src.artifacts] : [],
    source_revision: isNonEmptyString(src.source_revision) ? src.source_revision : NOT_MEASURED,
    goal_revision: Number.isInteger(src.goal_revision) ? src.goal_revision : 1,
    next_entry: src.next_entry,
    suggested_owner: src.suggested_owner,
  };
  if (!isNonEmptyString(src.source_revision)) {
    adjustments.push(`source_revision 未提供 ⇒ ${NOT_MEASURED}（resume 時這一項會是 not_measured，不算通過）`);
  }
  if (profile) {
    if (handoff.next_entry === undefined) {
      handoff.next_entry = profile.next_entry ?? null;
      adjustments.push(`next_entry 由 checkpoint ${profile.id} 推得：${handoff.next_entry ?? 'null（終點）'}`);
    }
    if (handoff.suggested_owner === undefined) {
      handoff.suggested_owner = profile.suggested_owner;
      adjustments.push(`suggested_owner 由 checkpoint ${profile.id} 推得：${handoff.suggested_owner}`);
    }
  }
  return { handoff, adjustments };
}

/**
 * 這個 checkpoint 的交接內容清單（給 handoff note 模板與 artifact validator 用）。
 *
 * **刻意不在這裡對 contract 的自由文字做字串比對**：`completed: ["開好 issue #219"]` 顯然交代了
 * issue identity，但它不會逐字出現「issue URL／identity」。用字面比對就會每次都吐一串假缺漏，
 * 於是真的缺漏被淹沒——內容完整性由人類 Markdown 的 required_sections 機械檢查（#217 artifact
 * contract），這裡只負責提供「該交代哪些事」的單一真相源。
 */
export function checkpointRequiredContent(checkpoint) {
  return [...(checkpointProfile(checkpoint)?.required_content ?? [])];
}

// ── 純函式：resume freshness ────────────────────────────────────────────────

/**
 * resume 前的 freshness 判定 → `{ verdict, checks, resumeFrom, invalidated, reason }`。
 *
 * `observed` 是**現況**（呼叫端量出來的），`handoff` 是交接當時記下的：
 *   · `observed.sourceRevision` —— 現在的來源版本；量不到就別給（會落到 not_measured）。
 *   · `observed.goalRevision`   —— 現在的 Goal Contract revision。
 *   · `observed.missingArtifacts` —— handoff 列的產物中，現在找不到或已換版的。
 *   · `observed.pendingStillValid` —— pending 清單是否仍成立（false ⇒ 這段要重想）。
 *
 * 判定規則：
 *   · 全 pass ⇒ `fresh`，`resumeFrom` ＝ 下一個入口的起點 phase（**不重跑已完成階段**）。
 *   · 有 fail ⇒ `stale`，`resumeFrom` ＝ 失敗項對應的**最早受影響 phase**（不是整條重跑）。
 *   · 沒有 fail、但有 not_measured ⇒ `uncertain`，`resumeFrom` 保守退到最早受影響 phase：
 *     沒查過就當作沒問題，正是「新 session 靜默重跑錯東西」的來源。
 */
export function evaluateFreshness({ handoff, observed = {} } = {}) {
  const checks = [];
  const push = (id, result, detail) => checks.push({ id, result, detail, affectsPhase: CHECK_AFFECTS_PHASE[id] ?? null });

  // ① source revision
  if (handoff?.source_revision === NOT_MEASURED || !isNonEmptyString(observed.sourceRevision)) {
    push('source-revision', NOT_MEASURED, handoff?.source_revision === NOT_MEASURED
      ? 'handoff 當時就沒量到來源版本，無從比對'
      : '現況的來源版本沒量到，無從比對');
  } else if (observed.sourceRevision === handoff.source_revision) {
    push('source-revision', 'pass', `來源版本一致（${handoff.source_revision}）`);
  } else {
    push('source-revision', 'fail', `來源版本已變：handoff 記 ${handoff.source_revision}，現況 ${observed.sourceRevision}`);
  }

  // ② goal revision
  if (!Number.isInteger(observed.goalRevision)) {
    push('goal-revision', NOT_MEASURED, '現況的 Goal Contract revision 沒解析到');
  } else if (observed.goalRevision === handoff.goal_revision) {
    push('goal-revision', 'pass', `Goal Contract 仍是 revision ${handoff.goal_revision}`);
  } else {
    push('goal-revision', 'fail', `Goal Contract 已改版：handoff 對應 revision ${handoff.goal_revision}，現況 ${observed.goalRevision}`);
  }

  // ③ artifact validity
  if (!Array.isArray(observed.missingArtifacts)) {
    push('artifact-validity', NOT_MEASURED, 'handoff 列的產物沒有實際查過是否還在');
  } else if (observed.missingArtifacts.length === 0) {
    push('artifact-validity', 'pass', `${(handoff.artifacts ?? []).length} 份產物都還在且對得上`);
  } else {
    push('artifact-validity', 'fail', `找不到或已換版：${observed.missingArtifacts.join('、')}`);
  }

  // ④ pending work
  if (typeof observed.pendingStillValid !== 'boolean') {
    push('pending-work', NOT_MEASURED, 'pending 清單沒有實際比對過是否仍成立');
  } else if (observed.pendingStillValid) {
    push('pending-work', 'pass', `pending ${(handoff.pending ?? []).length} 項仍成立`);
  } else {
    push('pending-work', 'fail', 'pending 清單已不成立，這一段要重想');
  }

  const failed = checks.filter((c) => c.result === 'fail');
  const unmeasured = checks.filter((c) => c.result === NOT_MEASURED);
  const affected = [...failed, ...unmeasured]
    .map((c) => c.affectsPhase)
    .filter(Boolean)
    .sort((a, b) => (phaseOrder(a) ?? 99) - (phaseOrder(b) ?? 99));

  if (failed.length === 0 && unmeasured.length === 0) {
    const entry = entryProfile(handoff.next_entry);
    return {
      verdict: 'fresh',
      checks,
      resumeFrom: entry?.start_phase ?? null,
      invalidated: [],
      reason: '四項 freshness 全部通過——不重跑已完成階段，直接從下一個入口續跑',
    };
  }

  return {
    verdict: failed.length > 0 ? 'stale' : 'uncertain',
    checks,
    resumeFrom: affected[0] ?? checkpointProfile(handoff.checkpoint)?.after_phase ?? null,
    invalidated: [...failed, ...unmeasured].map((c) => ({ check: c.id, result: c.result, affectsPhase: c.affectsPhase, detail: c.detail })),
    reason: failed.length > 0
      ? '有 freshness 項目失敗——只回到最早受影響的階段，其餘已完成的工作不重跑'
      : `有 freshness 項目 ${NOT_MEASURED}——沒查過不算通過，保守退到最早受影響的階段`,
  };
}

// ── 純函式：reducer（事件流 → handoff 狀態）────────────────────────────────

export function emptyHandoffState() {
  return { enabled: false, handoffs: [], paused: false, pausedAt: null, stopAfter: null, resumes: [] };
}

const findHandoff = (state, id) => state.handoffs.find((h) => h.handoffId === id) ?? null;

/**
 * 把一筆 handoff 事件套進狀態（純函式，就地更新；認不得的 type 回 false）。
 * 與 knowledge-ledger 同樣的「一份 reducer 兩個入口」原則：獨立投影與 work graph 投影共用這一支。
 */
export function reduceHandoffEvent(state, event, at = 0) {
  const p = event?.payload ?? {};
  switch (event?.type) {
    case 'handoff.created': {
      state.enabled = true;
      const id = p.handoffId;
      if (!isNonEmptyString(id)) return true;
      const record = {
        handoffId: id,
        at,
        checkpoint: p.handoff?.checkpoint ?? '',
        status: p.handoff?.status ?? '',
        stopReason: p.handoff?.stop_reason ?? '',
        completed: p.handoff?.completed ?? [],
        pending: p.handoff?.pending ?? [],
        artifacts: p.handoff?.artifacts ?? [],
        sourceRevision: p.handoff?.source_revision ?? NOT_MEASURED,
        goalRevision: p.handoff?.goal_revision ?? null,
        nextEntry: p.handoff?.next_entry ?? null,
        suggestedOwner: p.handoff?.suggested_owner ?? '',
        stopAfter: p.stopAfter ?? null,
        accepted: false,
        acceptedBy: null,
      };
      const existing = findHandoff(state, id);
      if (existing) Object.assign(existing, record);
      else state.handoffs.push(record);
      return true;
    }
    case 'workflow.paused': {
      state.enabled = true;
      state.paused = true;
      state.pausedAt = at;
      state.stopAfter = p.stopAfter ?? state.stopAfter;
      state.pausedHandoffId = p.handoffId ?? null;
      return true;
    }
    case 'handoff.accepted': {
      state.enabled = true;
      const h = findHandoff(state, p.handoffId);
      if (h) {
        h.accepted = true;
        h.acceptedBy = p.owner ?? null;
      }
      return true;
    }
    case 'workflow.resumed': {
      state.enabled = true;
      state.paused = false;
      state.stopAfter = p.stopAfter ?? null;
      state.resumes.push({
        at,
        handoffId: p.handoffId ?? null,
        verdict: p.verdict ?? '',
        resumeFrom: p.resumeFrom ?? null,
        invalidated: Array.isArray(p.invalidated) ? p.invalidated : [],
      });
      return true;
    }
    default:
      return false;
  }
}

/** 事件流（**檔案行序**）→ handoff 狀態。純函式。 */
export function projectHandoffs(events) {
  const state = emptyHandoffState();
  let at = 0;
  for (const ev of events || []) {
    reduceHandoffEvent(state, ev, at);
    at += 1;
  }
  return state;
}

/** 最近一份 handoff（沒有就 null）。 */
export function latestHandoff(state) {
  const list = state?.handoffs ?? [];
  return list.length ? list[list.length - 1] : null;
}

/**
 * 目前是不是停在某個 handoff 上 → `{ paused, stopAfter, handoff }`。
 * Handoff Stop Gate 讀的就是這個：`paused && crossesHandoff(stopAfter, targetPhase)` ⇒ 擋。
 */
export function activePause(state) {
  if (!state?.paused) return { paused: false, stopAfter: null, handoff: null };
  const handoff = state.pausedHandoffId ? findHandoff(state, state.pausedHandoffId) : latestHandoff(state);
  return { paused: true, stopAfter: state.stopAfter ?? handoff?.stopAfter ?? null, handoff };
}

// ── IO 薄邊界 ───────────────────────────────────────────────────────────────

/** 一條 loop 的 canonical 事件流落點（handoff 事件與 workflow 事件同一份，不另開資料庫）。 */
export const ledgerPath = (loopDir) => join(loopDir, 'events.jsonl');

/** handoff id：checkpoint ＋ 這是第幾份，人看得懂也查得到。 */
export function makeHandoffId(checkpoint, ordinal) {
  return `H-${checkpoint}-${ordinal}`;
}

/** append 一筆 handoff 事件。type 不在 canonical 清單就拋（認不得的型別靜默寫入＝投影少一整類）。 */
export function appendHandoffEvent(loopDir, type, payload) {
  if (!handoffEventTypes().has(type)) {
    throw new Error(`handoff-ledger：拒絕 append —— 事件型別「${type}」不在 canonical handoff events 內`);
  }
  return appendEvent(ledgerPath(loopDir), { type, payload });
}

/**
 * 產生一份 handoff 並記進事件流 → `{ event, handoff, handoffId, adjustments, requiredContent }`。
 * 先 normalize（補可推導欄位並留痕）再 check（形狀），不合格在碰檔案之前就拋。
 */
export function appendHandoffCreated(loopDir, input, { stopAfter = null, ordinal = null } = {}) {
  const { handoff, adjustments } = normalizeHandoff(input);
  const problem = checkHandoffContract(handoff);
  if (problem) throw new Error(`handoff-ledger：拒絕 append handoff —— ${problem.reason}`);

  const seq = Number.isInteger(ordinal)
    ? ordinal
    : projectHandoffs(readEvents(ledgerPath(loopDir)).events).handoffs.filter((h) => h.checkpoint === handoff.checkpoint).length + 1;
  const handoffId = makeHandoffId(handoff.checkpoint, seq);

  const event = appendHandoffEvent(loopDir, 'handoff.created', {
    nodeId: handoffId, handoffId, handoff, stopAfter, adjustments,
  });
  return { event, handoff, handoffId, adjustments, requiredContent: checkpointRequiredContent(handoff.checkpoint) };
}

/**
 * 記一次暫停。**必須在 `handoff.created` 成功之後才呼叫**（#219 Handoff Stop Gate）——
 * 先 paused 再 created 的話，中間崩掉會留下一個「停住了但沒有交接內容」的狀態，
 * 下一位接手時既不知道做完了什麼，也不知道該從哪裡續。
 */
export function appendPaused(loopDir, { handoffId, stopAfter, reason = 'requested-scope' }) {
  if (!isNonEmptyString(handoffId)) {
    throw new Error('handoff-ledger：workflow.paused 必須指名 handoffId——沒有交接內容的暫停無法接手');
  }
  const state = projectHandoffs(readEvents(ledgerPath(loopDir)).events);
  if (!findHandoff(state, handoffId)) {
    throw new Error(`handoff-ledger：找不到 handoff「${handoffId}」——handoff.created 成功之後才可以寫 workflow.paused`);
  }
  return appendHandoffEvent(loopDir, 'workflow.paused', { nodeId: handoffId, handoffId, stopAfter, reason });
}

/** 記一次接手（下一位認領這份 handoff）。 */
export function appendAccepted(loopDir, { handoffId, owner }) {
  return appendHandoffEvent(loopDir, 'handoff.accepted', { nodeId: handoffId, handoffId, owner });
}

/**
 * 記一次恢復推進。freshness 的判定一起寫進事件——事後要查得出「這次 resume 憑什麼不重跑」。
 * `verdict` 不是 fresh 時，`resumeFrom` 與 `invalidated` 就是「回到哪裡、失效了什麼」的證據。
 */
export function appendResumed(loopDir, { handoffId, verdict, resumeFrom, invalidated = [], stopAfter = null }) {
  if (!FRESHNESS_VERDICTS.includes(verdict)) {
    throw new Error(`handoff-ledger：verdict「${verdict}」不在 ${FRESHNESS_VERDICTS.join('｜')} 內`);
  }
  return appendHandoffEvent(loopDir, 'workflow.resumed', {
    nodeId: handoffId, handoffId, verdict, resumeFrom, invalidated, stopAfter,
  });
}

/** 讀回一條 loop 的 handoff 狀態（含 ledger 自己的健康度回報，呼叫端要顯示 warnings）。 */
export function readHandoffs(loopDir) {
  const { events, warnings, truncatedTail, duplicates } = readEvents(ledgerPath(loopDir));
  return { state: projectHandoffs(events), events, warnings, truncatedTail, duplicates };
}

// ── 人讀摘要 ────────────────────────────────────────────────────────────────

export function formatFreshness(result) {
  const head = result.verdict === 'fresh'
    ? '✓ freshness：可以直接續跑'
    : `⚠ freshness：${result.verdict}——${result.reason}`;
  const lines = [head, `  回到：${result.resumeFrom ?? '（未定）'}`];
  for (const c of result.checks) {
    const icon = c.result === 'pass' ? '✓' : (c.result === 'fail' ? '✗' : '—');
    lines.push(`  ${icon} [${c.id}] ${c.detail}`);
  }
  return lines.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');

  if (args.includes('--check')) {
    const target = args[args.indexOf('--check') + 1];
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(target, 'utf8'));
    } catch (err) {
      process.stderr.write(`讀不到或解析不了 ${target}：${err?.message ?? err}\n`);
      return 1;
    }
    const { handoff, adjustments } = normalizeHandoff(parsed);
    const problem = checkHandoffContract(handoff);
    const result = {
      ok: !problem,
      problem,
      adjustments,
      requiredContent: problem ? [] : checkpointRequiredContent(handoff.checkpoint),
      handoff,
    };
    if (asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (problem) process.stdout.write(`✗ handoff contract 不合格：${problem.reason}\n`);
    else process.stdout.write(`✓ handoff contract 合格（${handoff.checkpoint}）。交接內容要交代：${result.requiredContent.join('、')}\n`);
    return result.ok ? 0 : 1;
  }

  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    process.stdout.write('用法：node handoff-ledger.mjs <loop 目錄> [--json]\n      node handoff-ledger.mjs --check <handoff.json> [--json]\n');
    return 0;
  }
  const { state, warnings } = readHandoffs(dir);
  const pause = activePause(state);
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ state, pause, warnings }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`handoff：${state.handoffs.length} 份${pause.paused ? `，目前停在 stop_after=${pause.stopAfter ?? '?'}` : '，目前未暫停'}\n`);
  for (const h of state.handoffs) {
    process.stdout.write(`  · ${h.handoffId}（${h.checkpoint}）→ ${h.nextEntry ?? '終點'}　owner ${h.suggestedOwner}${h.accepted ? '　已接手' : ''}\n`);
  }
  for (const w of warnings) process.stdout.write(`  ! ${w}\n`);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
