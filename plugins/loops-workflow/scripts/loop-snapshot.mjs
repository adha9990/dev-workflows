#!/usr/bin/env node
// loop-snapshot.mjs —— 由 event ledger 重生的人類快照 `loop.md`（#172）。
//
// 變的是**職責**不是格式：`loop.md` 以前同時是狀態、摘要與**無界 append 的 Journal**；現在
// 事件流搬到 `events.jsonl`（loop-ledger.mjs），`loop.md` 只剩「當前狀態 + 最近 N 筆必要事件」
// 的 generated snapshot——長度有界、隨時可由 ledger 重生、手改會被下次重生蓋掉。
//
// **相容性是硬約束**：既有消費端（scripts/loops-scan.mjs 的 pickLoopField / journalEntries、
// scripts/progress.mjs、hooks/session-start.mjs、hooks/pr-gate.mjs 的「推進模式：auto」欄位判定）
// 都在讀這份 markdown 的欄位表與 `- [E<n>] …` 行。重生出來的格式**必須仍被那些解析器讀得懂**，
// 本檔的測試把這件事釘死（拿 loops-scan / progress 的真函式反解自己的產出）。
//
// **事件編號用行序序號、不用 `seq`**：ledger 契約 E6 明訂 seq 只單調不減、不保證唯一（併發寫者
// 會撞號），拿它當顯示編號會出現兩行 `[E7]`。行序是唯一穩定的排序權威。
//
// 純函式（renderLoopMd / recentEvents / summarize）＋ IO 薄邊界（regenerateLoopMd）。僅 node 內建。

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readEvents } from './loop-ledger.mjs';
import { projectEvents, selectBlocking } from './loop-graph.mjs';
import { summarize as summarizeUnknowns, renderRegister } from './unknowns-register.mjs';
import { writeFileAtomic } from '../hooks/atomic-write.mjs';

/** 快照裡保留的「最近事件」筆數上限——這就是「不再無界」的那個界。 */
export const RECENT_EVENT_LIMIT = 12;

/** 這些型別是流水帳，只有在沒有更有意義的事件時才佔用快照額度。 */
const LOW_SIGNAL_TYPES = new Set(['toolrun', 'note']);

const GENERATED_HEADER = '<!-- 由 loops-workflow 自 events.jsonl 重生（generated snapshot），請勿手改；完整事件流見同目錄 events.jsonl -->';

/** 一筆事件 → 人讀的一句話。 */
export function describeEvent(ev) {
  const p = (ev && ev.payload) || {};
  switch (ev && ev.type) {
    case 'loop-create': return `建立 loop（類型 ${p.type ?? '?'}）`;
    case 'loop-close': return `完工${p.outcome ? `：${p.outcome}` : ''}`;
    case 'issue': return `對應 issue #${p.number}`;
    case 'stage-enter': return `進入 ${p.stage}`;
    case 'stage-exit': return `離開 ${p.stage}${p.summary ? `：${p.summary}` : ''}`;
    case 'round': return `回環 #${p.round}`;
    case 'decision': return `決策[${p.status ?? '?'}]：${p.question ?? ''}${p.choice ? ` → ${p.choice}` : ''}`;
    case 'task': return `任務 ${p.taskId ?? p.id ?? ''}${p.status ? `（${p.status}）` : ''} ${p.title ?? ''}`.trim();
    case 'artifact': return `產出 ${p.path ?? ''}`;
    case 'finding': return `finding ${p.findingId ?? p.id ?? ''}[${p.severity ?? ''}] ${p.title ?? ''}${p.status && p.status !== 'open' ? `（已${p.status === 'waived' ? '豁免' : '修正'}）` : ''}`;
    case 'gate': return `閘 ${p.gate ?? ''} = ${p.status ?? ''}`;
    case 'commit': return `commit ${String(p.sha ?? '').slice(0, 8)} ${p.subject ?? ''}`;
    case 'pr': return `PR #${p.number ?? ''}${p.merged ? ' 已合併' : ''} ${p.title ?? ''}`.trim();
    case 'toolrun': return `${p.tool ?? '工具'} → ${p.outcome ?? ''}`;
    case 'unknown': return p.blindSpotPass ? `blind-spot pass：${p.blindSpotPass}` : `unknown ${p.id ?? ''}[${p.kind ?? ''}] ${p.statement ?? ''}${p.status ? `（${p.status}）` : ''}`;
    case 'note': return String(p.text ?? '');
    default: return String((ev && ev.type) ?? '');
  }
}

/**
 * 選出要放進快照的最近事件（**有界**）。挑法：先把高訊號事件由新到舊填滿額度，額度還有剩才補
 * 流水帳——這樣一條跑了幾百個 toolrun 的 loop，快照仍看得到階段轉換與 finding。
 * 回傳 `{ ordinal, event }`，ordinal 是 1-based 行序（顯示編號的唯一穩定來源）。
 */
export function recentEvents(events, limit = RECENT_EVENT_LIMIT) {
  const all = (events || []).map((event, i) => ({ ordinal: i + 1, event }));
  const high = all.filter((x) => !LOW_SIGNAL_TYPES.has(x.event.type));
  const low = all.filter((x) => LOW_SIGNAL_TYPES.has(x.event.type));
  const picked = high.slice(-limit);
  const room = limit - picked.length;
  const merged = room > 0 ? [...picked, ...low.slice(-room)] : picked;
  return merged.sort((a, b) => a.ordinal - b.ordinal);
}

/** `- [E<n>] …` 行（維持既有 Journal 行格式，讓 loops-scan / progress 照舊解析得到）。 */
export function recentEventLines(events, limit = RECENT_EVENT_LIMIT) {
  return recentEvents(events, limit).map(({ ordinal, event }) => `- [E${ordinal}] ${describeEvent(event)}`);
}

/** 一句話狀態摘要（給人掃一眼）。 */
export function summarize(state) {
  const blocking = selectBlocking(state);
  if (state.loop.done) return `完工${state.loop.outcome ? `：${state.loop.outcome}` : ''}`;
  const bits = [`階段 ${state.currentStage ?? '未進入'}`];
  if (state.round) bits.push(`回環 #${state.round}`);
  if (blocking.count) bits.push(`仍有 ${blocking.findings.length} 條 P0/P1、${blocking.gates.length} 道閘未過、${blocking.decisions.length} 個未決決策、${(blocking.unknowns ?? []).length} 條未解決 unknown`);
  else bits.push('無 blocking');
  return bits.join('　');
}

/**
 * 重生 `loop.md`。欄位表刻意用「`| label | value |`」＋純文字 label，讓 loops-scan 的
 * pickLoopField（先試表格列、再試 `label：value` 行）兩條路徑都命中。
 * `warnings` 是 ledger 的健康度回報（殘骸尾行 / 壞行 / 重複 id）——**一律顯示在快照最上方**，
 * 不讓「有東西被丟掉」只活在程式回傳值裡。
 */
export function renderLoopMd(state, events, { warnings = [] } = {}) {
  const blocking = selectBlocking(state);
  const L = state.loop;
  const openTasks = state.tasks.filter((t) => t.status !== 'done');
  const lines = [
    GENERATED_HEADER,
    `# loop：${L.slug}`,
    '',
  ];
  if (warnings.length) {
    lines.push('> ⚠ 事件流健康度警告（來自 loop-ledger）：', '');
    for (const w of warnings) lines.push(`> - ${w}`);
    lines.push('');
  }
  lines.push(
    '| 欄位 | 值 |',
    '|---|---|',
    `| 類型 | ${L.type || '?'} |`,
    `| operation | ${L.operation || '-'} |`,
    `| 推進模式 | ${L.mode || 'closed'} |`,
    `| 當前階段 | ${L.done ? '完工 ✅' : (state.currentStage || '未進入')} |`,
    `| 回環 | ${state.round} |`,
    `| 停止條件 | ${L.stopCondition || '-'} |`,
    `| session | ${L.session || '-'} |`,
    `| issue | ${state.issue !== null ? `#${state.issue}` : '-'} |`,
    `| 事件數 | ${(events || []).length}（完整流見 events.jsonl）|`,
    '',
    `> ${summarize(state)}`,
    '',
    // 「完工」而不是「收圈」：這一段列的是 iterate §6 完工前提（最近一輪 verify 無 actionable
    // findings）還沒清掉的東西——**不是** pr-gate 閘⑥ 的機械下界（#211 起只認 P0）。用「收圈」會
    // 和那個現在有精確定義的詞撞在一起，讓人以為這裡列的 P1 也會被機械閘擋。
    '## 仍擋著完工的',
  );
  if (!blocking.count) {
    lines.push('', '（無）', '');
  } else {
    lines.push('');
    for (const f of blocking.findings) lines.push(`- finding \`${f.id}\` **${f.severity}**：${f.title}`);
    for (const g of blocking.gates) lines.push(`- 閘 \`${g.gate}\` = ${g.status}${g.detail ? `（${g.detail}）` : ''}`);
    for (const d of blocking.decisions) lines.push(`- 未決決策 \`${d.id}\`：${d.question}`);
    for (const u of blocking.unknowns ?? []) lines.push(`- 未解決的 blocking unknown \`${u.id}\`（owner ${u.owner ?? '?'}，影響 ${(u.affects ?? []).join('、')}）：${u.statement ?? ''}`);
    lines.push('');
  }

  if (openTasks.length) {
    lines.push('## 未完成任務', '');
    for (const t of openTasks) lines.push(`- [ ] \`${t.id}\` ${t.title}${t.dependsOn.length ? `（依賴 ${t.dependsOn.join('、')}）` : ''}`);
    lines.push('');
  }

  // #174：四象限 Unknowns Register —— 只在這條 loop 真的有 unknown 或做過 blind-spot pass 時才渲染，
  // 免得每條 loop 的快照都多一塊空表（小任務不加 ceremony）。
  if ((state.unknowns ?? []).length || (state.blindSpotPasses ?? []).length) {
    lines.push(renderRegister(summarizeUnknowns(state.unknowns ?? [], { blindSpotPasses: state.blindSpotPasses ?? [] })));
  }

  lines.push(`## 最近事件（最多 ${RECENT_EVENT_LIMIT} 筆，非完整 Journal）`, '');
  const recent = recentEventLines(events);
  lines.push(...(recent.length ? recent : ['（無事件）']));
  lines.push('');

  if (L.done) lines.push(`★[outcome] ${L.outcome || '完工'}`, '');
  return lines.join('\n');
}

// ── IO 薄邊界 ────────────────────────────────────────────────────────────────

/** 讀 ledger → 投影 → 覆寫 `loop.md`（tmp+rename，reader 不會讀到半截檔）。回傳寫出的內容。 */
export function regenerateLoopMd(loopDir, { slug = null } = {}) {
  const name = slug ?? loopDir.split(/[\\/]/).filter(Boolean).pop();
  const { events, warnings } = readEvents(join(loopDir, 'events.jsonl'));
  const md = renderLoopMd(projectEvents(events, { slug: name }), events, { warnings });
  writeFileAtomic(join(loopDir, 'loop.md'), md, 'utf8');
  return md;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function main() {
  const dir = process.argv[2];
  if (!dir) {
    process.stdout.write('用法：node loop-snapshot.mjs <loop 目錄> [--stdout]\n');
    return 0;
  }
  if (process.argv.includes('--stdout')) {
    const slug = dir.split(/[\\/]/).filter(Boolean).pop();
    const { events, warnings } = readEvents(join(dir, 'events.jsonl'));
    process.stdout.write(renderLoopMd(projectEvents(events, { slug }), events, { warnings }));
  } else {
    regenerateLoopMd(dir);
    process.stdout.write(`✓ 已由 events.jsonl 重生 ${join(dir, 'loop.md')}\n`);
  }
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
