#!/usr/bin/env node
// progress.mjs —— loops-workflow 進度 renderer（取代 statusline）。
// 兩出口：① stdout chat 儀表板（/loops-workflow:progress 用）② .loops/<slug>/PROGRESS.md（編輯器 preview）。
// CLI：node progress.mjs [slug] [--write-only]。無 loop → no-op；任何錯誤吞掉 exit 0、永不擋路。
// 純函式（extractProgress/renderChat/renderMarkdown）可直接 import 測；main() 為 IO 薄邊界 + import.meta.url 守衛。

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  STAGE_ORDER, PRE_STAGES, MAX_ROUNDS,
  pickLoopField, journalEntries, currentStage, isDone,
  collectLoopEntries, pickActiveLoop,
} from './loops-scan.mjs';

const STATE_SYMBOL = { done: '✓', now: '●', pending: '○' };
const RECENT_JOURNAL_N = 5;

/** 把 loop entry 抽成結構化進度。純函式（只讀 entry.md）。 */
export function extractProgress(entry) {
  const md = String(entry && entry.md || '');
  const stage = currentStage(md);
  const done = isDone(stage);
  const journal = journalEntries(md);

  // 階段管線狀態
  const currentIdx = STAGE_ORDER.indexOf(stage);
  const stages = STAGE_ORDER.map((name, i) => {
    let state = 'pending';
    if (done || (currentIdx >= 0 && i < currentIdx)) state = 'done';
    else if (i === currentIdx) state = 'now';
    return { name, state };
  });
  // 前置階段：journal 出現「進入 <pre>」才顯示，一律視為 done（在 goal 之前）
  const preStages = PRE_STAGES
    .filter((name) => journal.some((j) => new RegExp(`進入\\s*${name}`).test(j)))
    .map((name) => ({ name, state: 'done' }));

  // 圈數：journal「回環 #N」最大 N（無 → 0）
  const round = journal.reduce((max, j) => {
    const m = j.match(/回環\s*#?(\d+)/);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);

  // findings「X→Y」/ commit SHA：從 journal 由後往前找
  const findingsLine = findLast(journal, /findings?\s*[:：]?\s*\d+\s*[→\-]+>?\s*\d+/i);
  const findingsText = (findingsLine.match(/findings?\s*[:：]?\s*\d+\s*[→\-]+>?\s*\d+/i) || [''])[0];
  const headLine = findLast(journal, /\b[0-9a-f]{7,40}\b/);
  const head = headLine ? (headLine.match(/\b([0-9a-f]{7,40})\b/) || [])[1] || '' : '';

  // 當前任務：journal 最後一筆含「任務」的；下一步：階段順序映射
  const currentTask = stripEventTag(findLast(journal, /任務/) || '');
  let nextStep = '';
  if (done) nextStep = '完工';
  else if (currentIdx >= 0 && currentIdx < STAGE_ORDER.length - 1) nextStep = STAGE_ORDER[currentIdx + 1];
  else if (currentIdx === STAGE_ORDER.length - 1) nextStep = '完工';
  else if (stage !== '?') nextStep = 'goal';

  const outcome = (md.split('\n').map((l) => l.trim()).find((l) => l.includes('★[outcome]'))) || '';
  const recentJournal = journal.slice(-RECENT_JOURNAL_N).map(stripEventTagKeepId);

  return {
    slug: (entry && entry.slug) || '?',
    type: pickLoopField(md, '類型') || '?',
    operation: pickLoopField(md, 'operation') || '',
    mode: pickLoopField(md, '推進模式') || '',
    round, maxRounds: MAX_ROUNDS, done,
    stopCondition: pickLoopField(md, '停止條件') || '',
    stages, preStages,
    findings: findingsText, head,
    currentTask, nextStep, outcome, recentJournal,
  };
}

function findLast(arr, re) {
  for (let i = arr.length - 1; i >= 0; i--) if (re.test(arr[i])) return arr[i];
  return '';
}
function stripEventTag(line) { return String(line).replace(/^-\s*\[E\d+\]\s*/, '').trim(); }
function stripEventTagKeepId(line) {
  const m = String(line).match(/^-\s*\[(E\d+)\]\s*(.*)$/);
  return m ? `${m[1]} ${m[2].trim()}` : stripEventTag(line);
}

/** chat 緊湊儀表板。 */
export function renderChat(p) {
  const head = `⟳ ${p.slug}   ${[p.type, p.operation, p.mode].filter(Boolean).join('·')}   圈 ${p.round}/${p.maxRounds}`;
  const pipeline = p.stages.map((s) => `${s.name} ${STATE_SYMBOL[s.state]}`).join('  ');
  const lines = [head, pipeline];
  const taskBits = [p.currentTask, p.head && `HEAD ${p.head}`].filter(Boolean).join('   ');
  if (taskBits) lines.push(taskBits);
  if (p.findings) lines.push(p.findings);
  if (p.recentJournal.length) lines.push('最近：' + p.recentJournal.join(' / '));
  if (p.nextStep) lines.push(`下一步 → ${p.nextStep}`);
  if (p.done && p.outcome) lines.push(p.outcome);
  return lines.join('\n');
}

/** PROGRESS.md（編輯器 markdown preview 用）。 */
export function renderMarkdown(p) {
  const meta = [p.type, p.operation, p.mode].filter(Boolean).map((x) => `\`${x}\``).join(' · ');
  const mermaid = ['```mermaid', 'flowchart LR'];
  const cls = { done: 'done', now: 'now', pending: 'todo' };
  const ids = p.stages.map((s, i) => `s${i}["${s.name}"]:::${cls[s.state]}`);
  mermaid.push('  ' + ids.join(' --> '));
  mermaid.push('  classDef done fill:#9f9,stroke:#393;');
  mermaid.push('  classDef now fill:#fd6,stroke:#c90,font-weight:bold;');
  mermaid.push('  classDef todo fill:#eee,stroke:#999;');
  mermaid.push('```');

  const checks = p.stages.map((s) => s.state === 'now'
    ? `- [ ] **${s.name} ← 現在**`
    : `- [${s.state === 'done' ? 'x' : ' '}] ${s.name}`);

  const journalRows = ['| # | 事件 |', '|---|---|',
    ...p.recentJournal.map((j) => {
      const m = j.match(/^(E\d+)\s*(.*)$/);
      return m ? `| ${m[1]} | ${m[2]} |` : `| | ${j} |`;
    })];

  const out = [
    '<!-- 由 loops-workflow 自動產生（每回合 Stop hook 重生），請勿手改；已被 .loops 規則 gitignore -->',
    `# ⟳ ${p.slug}`,
    `${meta} · 圈 ${p.round}/${p.maxRounds}${p.stopCondition ? ` · 停止條件：${p.stopCondition}` : ''}`,
    '',
    '## 階段',
    mermaid.join('\n'),
    '',
    ...(p.preStages.length ? [`前置：${p.preStages.map((s) => s.name).join(' → ')} ✓`, ''] : []),
    ...checks,
    '',
  ];
  if (p.currentTask || p.findings || p.head) {
    out.push('## 當前任務');
    if (p.currentTask) out.push(p.currentTask);
    const bits = [p.findings, p.head && `HEAD \`${p.head}\``].filter(Boolean).join('　');
    if (bits) out.push(bits);
    out.push('');
  }
  if (p.recentJournal.length) { out.push('## Journal（最近）', ...journalRows, ''); }
  out.push(p.done ? (p.outcome || '完工 ✅') : `下一步 → ${p.nextStep}`, '');
  return out.join('\n');
}

// ── IO 薄邊界 ──
function main() {
  const args = process.argv.slice(2);
  const writeOnly = args.includes('--write-only');
  const slug = args.find((a) => !a.startsWith('--'));
  const cwd = process.cwd();
  const entries = collectLoopEntries(cwd);

  let entry = null;
  if (slug) entry = entries.find((e) => e.slug === slug) || null;
  else entry = pickActiveLoop(entries, (process.env.CLAUDE_CODE_SESSION_ID || '').trim(), Date.now());
  if (!entry) return; // no-op

  const p = extractProgress(entry);
  try { writeFileSync(join(entry.dir, 'PROGRESS.md'), renderMarkdown(p), 'utf8'); } catch { /* 寫檔失敗不擋路 */ }
  if (!writeOnly) process.stdout.write(renderChat(p) + '\n');
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try { main(); } catch { /* 永不擋路 */ }
  process.exit(0);
}
