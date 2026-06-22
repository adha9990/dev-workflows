#!/usr/bin/env node
// validate-plan.mjs —— 檢查 02-plan.md 內嵌的 ```loops-plan JSON 區塊是否符合 plan-schema。
// 用法：node validate-plan.mjs <path-to-02-plan.md>
// 通過 → exit 0；任一問題 → 列出後 exit 1。依賴：無（純 Node）。

import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('用法：node validate-plan.mjs <path-to-02-plan.md>');
  process.exit(2);
}

let text;
try {
  text = readFileSync(file, 'utf8');
} catch (e) {
  console.error(`讀不到檔案：${file}`);
  process.exit(2);
}

const m = text.match(/```loops-plan\s*\n([\s\S]*?)\n```/);
if (!m) {
  console.error('找不到 ```loops-plan 區塊（計畫未啟用機器可驗證模式）。');
  process.exit(2);
}

let plan;
try {
  plan = JSON.parse(m[1]);
} catch (e) {
  console.error(`loops-plan 區塊不是合法 JSON：${e.message}`);
  process.exit(1);
}

const problems = [];
const tasks = Array.isArray(plan.tasks) ? plan.tasks : null;
if (!tasks || tasks.length === 0) {
  problems.push('tasks 必須是非空陣列。');
}

const ids = new Set();
for (const [i, t] of (tasks || []).entries()) {
  const where = `任務 #${i + 1}${t && t.id ? `（${t.id}）` : ''}`;
  if (!t || typeof t !== 'object') { problems.push(`${where}：不是物件。`); continue; }
  if (!t.id || typeof t.id !== 'string') problems.push(`${where}：id 缺或非字串。`);
  else if (ids.has(t.id)) problems.push(`${where}：id 重複。`);
  else ids.add(t.id);
  if (!t.title || typeof t.title !== 'string') problems.push(`${where}：title 缺或非字串。`);
  else if (/\sand\s/i.test(t.title)) problems.push(`${where}：title 含 " and "（該再拆）。`);
  if (!Array.isArray(t.acceptance) || t.acceptance.length === 0) problems.push(`${where}：acceptance 必須是非空陣列。`);
  else if (t.acceptance.length > 3) problems.push(`${where}：acceptance > 3 條（該再拆）。`);
  if (!t.verification || typeof t.verification !== 'string' || !t.verification.trim()) problems.push(`${where}：verification 必須是非空可執行指令。`);
  if (t.deps !== undefined && !Array.isArray(t.deps)) problems.push(`${where}：deps 必須是陣列。`);
  if (t.files !== undefined && !Array.isArray(t.files)) problems.push(`${where}：files 必須是陣列。`);
}

// deps 都要存在
for (const t of tasks || []) {
  for (const d of (t && Array.isArray(t.deps) ? t.deps : [])) {
    if (!ids.has(d)) problems.push(`任務 ${t.id}：依賴的 ${d} 不存在。`);
  }
}

// 依賴環檢測（DFS）
if (tasks) {
  const graph = new Map(tasks.map((t) => [t.id, (t.deps || []).filter((d) => ids.has(d))]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...ids].map((id) => [id, WHITE]));
  const stack = [];
  let cycle = null;
  const dfs = (u) => {
    color.set(u, GRAY); stack.push(u);
    for (const v of graph.get(u) || []) {
      if (color.get(v) === GRAY) { cycle = [...stack.slice(stack.indexOf(v)), v]; return true; }
      if (color.get(v) === WHITE && dfs(v)) return true;
    }
    color.set(u, BLACK); stack.pop(); return false;
  };
  for (const id of ids) { if (color.get(id) === WHITE && dfs(id)) break; }
  if (cycle) problems.push(`依賴成環：${cycle.join(' → ')}`);
}

if (problems.length) {
  console.error(`✗ 計畫驗證未通過（${problems.length} 個問題）：`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`✓ 計畫驗證通過（${tasks.length} 個任務，依賴無環、verification 齊全）。`);
process.exit(0);
