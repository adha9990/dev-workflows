// loop-ledger.mjs —— 一條 loop 的事件流（events.jsonl）的**唯一寫入路徑**與兩支 replay API（issue #172 T1/T2）。
//
// 定位（02-plan.md 決策 1）：事件流是唯一真相源，只增不改；SQLite 索引與 loop.md / PROGRESS.md 都是
//   可從它完整重建的衍生物。所以本檔只做三件事：append 一筆事件、逐行讀回、把事件流 reduce 成狀態。
//
// ⚠️ 刻意**不重用** `hooks/` 底下那支 tmp+rename 的整檔覆寫葉節點（契約 1 E1）：
//   那支檔頭第 9–10 行自己就寫明「不適用 append-only 寫法……tmp+rename 不適用（且會與其 append 語意衝突）」。
//   套上去等於每 append 一筆事件就重寫整份檔（O(n²)），並且破壞它宣告的職責邊界。
//   本檔照 repo 既有的 4 個 append 站點（`hooks/cost-tracker.mjs`、`scripts/eval-metrics.mjs`、
//   `scripts/eval-judge.mjs`、`scripts/eval-runs.mjs`）的形狀：`appendFileSync(JSON.stringify(e) + '\n')`。
//
// ⚠️ **事件流永不裁切、永不換檔**（契約 1 E5）：這是 audit trail，不是 advisory 的本地統計檔。
//   `eval-metrics.mjs` 那種「只留最後 1000 行」的做法自承是**非原子的 read→rewrite**、容忍偶發崩潰截斷；
//   對 audit trail 不可接受——它會把中段損壞從「實測 0 次」變成必然發生，而尾行檢查（E1）**完全偵測不到**
//   中段的洞。本票要解的無界成長是人與 agent 每回合重讀的 loop.md，不是機器讀的 jsonl。
//
// ⚠️ `seq` 的語意（契約 1 E6）：由本檔 `appendEvent()` 在同一次 append 前重讀檔尾配號，
//   **只保證單調不減、不保證唯一**。Stop 家族實測掛了多個併發 hook，兩個寫者各自「讀尾筆 → +1 → append」
//   物理上就會寫出重複 seq，而 append-only 不允許回頭改號。因此 **replay 的排序權威是「檔案行序」**，
//   任何依賴 seq 唯一性的 replay 邏輯都會間歇錯亂且無法修復既有事件流。
//
// ⚠️ 兩支 replay 語意不可混（契約 1b）：
//   - `replayExact()`  遇未知版本／壞行即**拋出**並指名版本號與行號 —— gate 判定、狀態判定、階段轉換走這支。
//   - `replayPrefix()` 停在**第一個**無法處理的事件，回 `{ state, complete, haltedAt }` —— 唯讀展示走這支，
//     呼叫端必須把 `haltedAt` 渲染成顯眼告警，不得靜默當成正常狀態。
//   **明文禁止「跳過壞事件續讀」**（R3）：停在第一個壞事件產出的是**定義良好的前綴狀態**（等價於「這條 loop
//   在第 N 筆事件時的樣子」，本身是完全正確的歷史狀態）；跳過續讀產出的是中間有洞的狀態，而 gate 會依據
//   它做判斷——那正是整份設計要防的形狀。
//
// 中斷的 append（E1）：判準是「尾行有沒有換行結尾」，不是「尾行能不能 parse」。無換行結尾 ⇒ 視為中斷殘骸、
//   丟棄並回報（`readEvents().truncatedTail`），前面的事件完好。
//   ⚠️ **殘骸 ≠ 壞事件**：殘骸是「這筆還沒寫完」，丟掉之後前面的事件全部完好，得到的是一個完整、沒有洞的
//   狀態；壞事件是「這筆內容不合法」，它之後的一切都不能算數。所以殘骸**不算 halt**——`replayPrefix()` 對它
//   仍回 `complete: true` / `haltedAt: null`，兩支 replay 的狀態都等於「不含殘骸尾行」的狀態。把殘骸當 halt，
//   會讓一條完全健康、只是中斷過一次寫入的事件流被誤判成不完整；而 gate 走 `replayExact()`（R1），它若因
//   一次中斷寫入就拋出，那條 loop 會被一次當機永久磚化。
//
// 落點（契約 6）：本檔**不建立任何目錄**——目錄由呼叫端負責，寫入路徑的 containment 檢查是 T9 的獨立原語。
//   在這裡順手 mkdir 等於繞過那道還沒建起來的圍堵。依賴：僅 node 內建。

import { appendFileSync, readFileSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** 本實作寫出的 schema 版本。讀取端支援的版本清單見 SUPPORTED_VERSIONS（未知版本 ⇒ 明確失敗並指名）。 */
export const SCHEMA_VERSION = 1;

/** 讀得懂的 schema 版本。刻意是集合而非「<= 目前版本」：略過未知版本會讓狀態悄悄不完整（決策 2）。 */
export const SUPPORTED_VERSIONS = new Set([1]);

/** decision 型事件的 payload.status 列舉（契約 1）。 */
export const DECISION_STATUSES = new Set(['pending', 'decided']);

// 配號時往回讀的檔尾位元組數。讀不到完整的一行就往前加倍擴讀，直到讀到檔頭為止——
// 目的只是避免「每 append 一筆就整檔讀一遍」，不是任何形式的資料上限。
const TAIL_PROBE_BYTES = 8192;

const MODE_EXACT = 'exact';
const MODE_PREFIX = 'prefix';

// ── 純函式 ───────────────────────────────────────────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 把任意值變成錯誤訊息裡可讀的字面（undefined / 不可序列化的值都不得讓訊息本身炸掉）。 */
function describe(value) {
  if (value === undefined) return 'undefined';
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/** 一筆事件的正規欄位集合（契約 1）。其餘資訊一律進 payload。 */
export const EVENT_FIELDS = ['v', 'id', 'seq', 'type', 'payload'];

/**
 * 檢查一筆事件的形狀（契約 1）。合格回 null；不合格回 `{ reason, version? }`。
 * 版本檢查刻意排在最前面——v 不認得時，後面的欄位規則本來就可能還沒成立，先指名版本才是有用的訊息。
 *
 * 兩個開關對應「寫嚴、讀寬」的不對稱，這是刻意的：
 * - `requireSeq`：append 前的事件還沒配號（配號者只有 appendEvent），所以只有 replay 端要求 seq。
 * - `rejectUnknownFields`：**只在 append 端開**。我們控制得了自己寫進 audit trail 的東西，就讓它保持
 *   正規形狀（多出來的頂層欄位是 schema 違規，靜默寫進去等於讓 audit trail 悄悄長出第二種形狀）。
 *   讀取端反而必須寬容：真正的 schema 演進靠 `v` 表達並由未知版本那條攔下；若讀取端見到多一個欄位
 *   就拒絕，一份用新版寫出的事件流會讓舊版連「卡在哪」都讀不到——正是契約 1b 要防的磚化。
 */
export function checkEventShape(event, { requireSeq = true, rejectUnknownFields = false } = {}) {
  if (!isPlainObject(event)) {
    return { reason: `事件不是 JSON 物件（實際：${describe(event)}）` };
  }
  const { v, id, seq, type, payload } = event;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return { reason: `事件缺必要欄位 v（schema 版本，必須是數字；實際：${describe(v)}）` };
  }
  if (!SUPPORTED_VERSIONS.has(v)) {
    return {
      reason: `事件的 schema 版本 ${v} 不在本實作支援的版本清單（支援：${[...SUPPORTED_VERSIONS].join('、')}）`,
      version: v,
    };
  }
  if (typeof id !== 'string' || id === '') {
    return { reason: `事件缺必要欄位 id（必須是非空字串；實際：${describe(id)}）` };
  }
  if (requireSeq && (typeof seq !== 'number' || !Number.isFinite(seq))) {
    return { reason: `事件缺必要欄位 seq（必須是數字；實際：${describe(seq)}）` };
  }
  if (typeof type !== 'string' || type === '') {
    return { reason: `事件缺必要欄位 type（必須是非空字串；實際：${describe(type)}）` };
  }
  if (!isPlainObject(payload)) {
    return { reason: `事件缺必要欄位 payload（必須是物件；實際：${describe(payload)}）` };
  }
  if (type === 'decision' && !DECISION_STATUSES.has(payload.status)) {
    return {
      reason: `decision 事件的 payload 必須帶 status: 'pending' | 'decided'（實際：${describe(payload.status)}）`,
    };
  }
  if (rejectUnknownFields) {
    const extra = Object.keys(event).filter((key) => !EVENT_FIELDS.includes(key));
    if (extra.length > 0) {
      return { reason: `事件有正規欄位以外的頂層欄位 ${extra.join('、')}（正規欄位：${EVENT_FIELDS.join('、')}；其餘資訊請放進 payload）` };
    }
  }
  return null;
}

/**
 * 把事件流 reduce 成狀態的累加器。
 * 冪等（E4）：`id` 已套用過就整筆略過——**狀態裡不得留下任何「這筆重複過」的痕跡**，
 * 否則「重複兩次」與「只出現一次」的狀態會不同，冪等就是假的。重複的偵測與回報是 readEvents 的職責。
 */
/**
 * 從 payload 解出這筆事件講的是**哪一個實體**（node key）。順序固定、由專用到通用：
 * 顯式 `nodeId` 最優先，其次是各型別自己的識別欄，最後退回「型別 + 事件 id」——退回值保證每筆
 * 不同，所以**不會有事件因為沒有識別欄就從狀態裡消失**（那是靜默丟資訊，正是本設計要防的）。
 *
 * 這一層刻意只做 key 解析、不做語意投影：Loop/Issue/Stage/Decision/Task/Finding/Gate 的關係圖
 * 由 `loop-graph.mjs` 從同一份事件流投影出來（衍生物可以有很多種，真相源只有一個）。
 */
export function nodeKeyOf(event) {
  const p = event.payload ?? {};
  const explicit = [p.nodeId, p.id, p.taskId, p.findingId, p.decisionId, p.gate, p.stage, p.number]
    .find((v) => (typeof v === 'string' && v !== '') || Number.isFinite(v));
  return explicit !== undefined ? `${event.type}:${explicit}` : `${event.type}:#${event.id}`;
}

function createReduction() {
  const applied = new Set();
  const state = {
    schemaVersion: SCHEMA_VERSION,
    eventCount: 0,
    lastSeq: null,
    lastEventId: null,
    currentStage: null,
    byType: {},
    nodes: {},
  };
  return {
    state,
    apply(event) {
      if (applied.has(event.id)) return false;
      applied.add(event.id);
      state.eventCount += 1;
      state.lastSeq = event.seq;
      state.lastEventId = event.id;
      state.byType[event.type] = (state.byType[event.type] ?? 0) + 1;
      // 當前階段＝行序**最後**一筆 stage-enter 的 stage（不是 seq 最大的那筆——seq 不保證唯一，E6）。
      if (event.type === 'stage-enter' && typeof event.payload.stage === 'string' && event.payload.stage !== '') {
        state.currentStage = event.payload.stage;
      }
      // 同一個 node key 的後續事件覆蓋前一筆：勝者由**檔案行序**決定，不是 seq（E6）。
      const key = nodeKeyOf(event);
      state.nodes[key] = { nodeId: key, type: event.type, eventId: event.id, seq: event.seq, payload: event.payload };
      return true;
    },
  };
}

// ── 薄 IO ────────────────────────────────────────────────────────────────────────

/**
 * 逐物理行掃描事件流 → `{ records, truncatedTail }`。
 * records 逐筆帶 1-based 行號（錯誤訊息與 haltedAt 都要指名行號），順序即檔案行序。
 * 這一層只負責「切行 + JSON parse」，schema 規則留給 checkEventShape——讀取端不該在切行時就下語意判斷。
 */
export function scanRecords(ledgerPath) {
  let raw;
  try {
    raw = readFileSync(ledgerPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { records: [], truncatedTail: false };
    throw err;
  }
  if (raw === '') return { records: [], truncatedTail: false };

  const parts = raw.split('\n');
  // 有換行結尾 ⇒ 末段必為空字串（丟掉）；沒有換行結尾 ⇒ 末段是中斷殘骸（丟掉並回報）。
  const truncatedTail = parts[parts.length - 1] !== '';
  parts.pop();

  const records = parts.map((text, index) => {
    const line = index + 1;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { line, event: null, error: `不是合法 JSON：${err?.message ?? err}` };
    }
    if (!isPlainObject(parsed)) {
      return { line, event: null, error: `不是 JSON 物件（實際：${describe(parsed)}）` };
    }
    return { line, event: parsed, error: null };
  });
  return { records, truncatedTail };
}

/**
 * 讀檔尾拿最後一筆事件的 seq（沒有事件／檔案不存在 ⇒ 0）。
 * 從檔尾往前讀一小段就好——append 是每回合都在跑的路徑，整檔讀一遍會讓 append 變成 O(n²)。
 * 讀到的最後一行若是中斷殘骸（parse 不出 seq）就繼續往前找上一筆：配號要接在**最後一筆有效事件**之後。
 */
export function lastSeq(ledgerPath) {
  let fd;
  try {
    fd = openSync(ledgerPath, 'r');
  } catch (err) {
    if (err?.code === 'ENOENT') return 0;
    throw err;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return 0;
    let span = Math.min(size, TAIL_PROBE_BYTES);
    for (;;) {
      const buf = Buffer.alloc(span);
      readSync(fd, buf, 0, span, size - span);
      const lines = buf.toString('utf8').split('\n');
      // 沒讀到檔頭時，第一段可能被切在行中間（甚至切在 UTF-8 序列中間）⇒ 不可信，丟掉。
      const usable = span === size ? lines : lines.slice(1);
      for (let i = usable.length - 1; i >= 0; i -= 1) {
        const seq = seqOfLine(usable[i]);
        if (seq !== null) return seq;
      }
      if (span === size) return 0;
      span = Math.min(size, span * 4);
    }
  } finally {
    closeSync(fd);
  }
}

function seqOfLine(text) {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (isPlainObject(parsed) && typeof parsed.seq === 'number' && Number.isFinite(parsed.seq)) return parsed.seq;
  } catch {
    return null;
  }
  return null;
}

// ── 對外 API ─────────────────────────────────────────────────────────────────────

/**
 * append 一筆事件 → **實際寫出去的那筆事件**（含配到的 `seq`）。事件流的**唯一寫入路徑**（契約 1 E1/E6）。
 *
 * - 形狀不合格 ⇒ 在碰檔案之前就拋出：被拒的 append 不得留下任何位元組（不寫半行再丟例外）。
 * - `seq` 由本函式配號並覆蓋呼叫端傳進來的值——E6 明訂配號者只有這一個，呼叫端自己算的號沒有意義。
 * - 回傳值刻意是**把寫出去的那一行讀回來**的結果，不是記憶體裡的原物件：兩者只要有落差（例如 payload
 *   帶了 `undefined`，JSON 會靜默丟掉），呼叫端拿到的就不是事件流裡真正那筆。回傳＝寫入，無條件成立。
 * - 目錄不存在時直接讓 appendFileSync 拋 ENOENT：建目錄是呼叫端與 containment 原語的事（契約 6）。
 */
export function appendEvent(ledgerPath, event) {
  // `v` 與 `id` 是**選填**（契約 1 E7）：呼叫端關心的是 type/payload，版本與識別碼由本檔補完——
  //   · `v` 預設 SCHEMA_VERSION：呼叫端不該自己記得現在是第幾版（記錯就寫出讀不回來的事件）；
  //   · `id` 預設 randomUUID()：id 的唯一用途是 E4 的冪等去重，讓呼叫端手配等於把「兩筆不同事件
  //     撞成同一筆、後者被靜默吞掉」的風險外包出去。
  // 補完在形狀檢查**之前**做，錯誤訊息才會指名真正缺的欄位（type/payload），而不是每次都先怪 v。
  const candidate = isPlainObject(event)
    ? { ...event, v: event.v ?? SCHEMA_VERSION, id: event.id ?? randomUUID() }
    : event;
  const problem = checkEventShape(candidate, { requireSeq: false, rejectUnknownFields: true });
  if (problem) throw new Error(`loop-ledger：拒絕 append —— ${problem.reason}`);

  const seq = lastSeq(ledgerPath) + 1;
  const record = { v: candidate.v, id: candidate.id, seq, type: candidate.type, payload: candidate.payload };

  // 先序列化再寫：序列化失敗（例如 payload 有環）也必須在檔案被碰到之前就炸掉。
  const line = `${JSON.stringify(record)}\n`;
  appendFileSync(ledgerPath, line, 'utf8');
  return JSON.parse(line);
}

/**
 * 逐行讀回事件 → `{ events, truncatedTail, duplicates, malformed, warnings }`。
 * `events` 照**檔案行序**，不依 seq／id 重排（E6），且含重複出現的那幾筆——這一支是忠實的讀取器，
 * 冪等是 replay 層的事。重複與壞行都明確回報，不靜默吞掉。
 * `warnings` 是把上述各類結構化回報攤成**人可讀的一行行**：丟棄／隔離這種事必須在最表層就看得見，
 * 呼叫端不該為了知道「有沒有東西被丟掉」而自己去 join 三個陣列（靜默丟棄正是這份設計要防的）。
 */
export function readEvents(ledgerPath) {
  const { records, truncatedTail } = scanRecords(ledgerPath);
  const events = [];
  const malformed = [];
  const duplicates = [];
  const firstSeen = new Map();
  for (const record of records) {
    if (record.error !== null) {
      malformed.push({ line: record.line, reason: record.error });
      continue;
    }
    const { id } = record.event;
    if (typeof id === 'string') {
      if (firstSeen.has(id)) duplicates.push({ id, line: record.line, firstLine: firstSeen.get(id) });
      else firstSeen.set(id, record.line);
    }
    events.push(record.event);
  }
  const warnings = [];
  if (truncatedTail) warnings.push('尾行沒有換行結尾 ⇒ 視為中斷的 append 殘骸並丟棄；其前的事件完好（truncatedTail）');
  for (const m of malformed) warnings.push(`第 ${m.line} 行無法解析並已略過：${m.reason}`);
  for (const d of duplicates) warnings.push(`第 ${d.line} 行的事件 id ${d.id} 與第 ${d.firstLine} 行重複（replay 依 E4 冪等去重）`);
  return { events, truncatedTail, duplicates, malformed, warnings };
}

function runReplay(ledgerPath, mode) {
  // 殘骸尾行在 scanRecords 就被丟掉了，這裡看到的每一筆都是完整寫出的一行——所以中斷過一次寫入的
  // 事件流與沒中斷過的，reduce 出的狀態逐項相同（殘骸不是 halt，見檔頭）。回報留給 readEvents。
  const { records } = scanRecords(ledgerPath);
  const reduction = createReduction();
  // 重複 id 的**回報**與去重是兩件事：去重讓狀態冪等（E4），回報讓「有東西被吃掉」看得見。
  const duplicates = [];
  const firstSeen = new Map();

  for (const record of records) {
    const problem = record.error !== null
      ? { reason: record.error }
      : checkEventShape(record.event, { requireSeq: true });
    if (problem) {
      // R3：停在**第一個**無法處理的事件。兩支都不得往後續讀——續讀出來的是有洞的狀態。
      if (mode === MODE_EXACT) throw new Error(`loop-ledger：第 ${record.line} 行${problem.reason}`);
      return {
        state: reduction.state,
        complete: false,
        haltedAt: { line: record.line, reason: problem.reason, version: problem.version ?? null },
        duplicates,
      };
    }
    const { id } = record.event;
    if (firstSeen.has(id)) duplicates.push({ id, line: record.line, firstLine: firstSeen.get(id) });
    else firstSeen.set(id, record.line);
    reduction.apply(record.event);
  }
  return { state: reduction.state, complete: true, haltedAt: null, duplicates };
}

/**
 * 嚴格 replay → state（契約 1b R1）。**gate 判定、狀態判定、階段轉換一律走這支。**
 * 遇未知版本或壞行即拋出，訊息指名版本號與行號；絕不靜默略過，也絕不跳過該行續讀。
 */
export function replayExact(ledgerPath) {
  return runReplay(ledgerPath, MODE_EXACT).state;
}

/**
 * 前綴 replay → `{ state, complete, haltedAt, duplicates }`（契約 1b R2）。**唯讀展示走這支**，
 * 呼叫端必須把 `haltedAt` 渲染成顯眼告警，不得靜默當成正常狀態。
 * 健康的事件流 ⇒ `complete: true` 且 `haltedAt: null`；否則停在第一個無法處理的事件，
 * `state` 是該點之前的**前綴狀態**——它等價於「這條 loop 在第 N 筆事件時的樣子」，本身完全正確。
 */
export function replayPrefix(ledgerPath) {
  return runReplay(ledgerPath, MODE_PREFIX);
}
