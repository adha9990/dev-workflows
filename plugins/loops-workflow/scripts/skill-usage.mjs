#!/usr/bin/env node
// skill-usage.mjs —— skill／reference 的**實際載入度**分析（#205）。
//
// 反覆踩到的問題：規則寫在 skill 裡，實際跑的時候卻沒有被叫到。這支腳本回答最基本的那句話——
// **「這條 loop 到底載入了哪些 skill 與規範檔？」**
//
// 它只回答「有沒有載入」，**不回答「載入了有沒有照做」**。這兩件事的修法相反：沒載入要修路由或
// 改成 hook（改文字沒有用），載入了沒照做才是重寫措辭與語意評測的戰場。先有前者的資料，才知道
// 後者值不值得投資。
//
// 這是 `skill-lint` 既有 `orphan-ref` 檢查的**運行時鏡像**：那個查「靜態上沒人引用」，本檔查
// 「動態上沒被載入」。同一個形狀、相反方向。
//
// ── 三個關鍵設計 ──────────────────────────────────────────────────────────
//
// 1. **期望集合來自版本對齊的快照**。拿新的 registry 去比舊的 transcript，差集會混入一堆
//    「這個 skill 當時根本還不存在」的雜訊。快照來源＝已安裝 plugin 的歷史版本目錄；
//    **觀察到的 skill 不在快照裡 ⇒ 快照選錯**，該份 transcript 標 `not measured` 並排除，不硬套。
//
// 2. **期望集合用「skill 正文逐字提到該 reference 檔名」推導**，與 skill-lint 判 orphan-ref 同一套
//    判準。刻意不依賴 component registry——舊版快照根本沒有那份檔，靠它會讓多數版本無法分析。
//
// 3. **分母要誠實**。大部分 session 根本不是在跑 loop（一般對話、別的工作）。把它們算進分母，
//    會得出「74 個 session 只有 4 個叫過 skill」這種嚇人但無意義的數字。因此先分類，
//    **非 loop session 明確排除並計數**，讓排除本身看得見。
//
// 純函式（scanTranscript / classifyKind / expectedReferences / compareUsage / renderReport）＋
// IO 薄邊界（loadSnapshot / collectTranscripts / analyzeAll）。依賴：僅 node 內建。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** transcript 裡一次 Skill 工具呼叫。`skill` 形如 `loops-workflow:goal`。 */
export const SKILL_CALL_RE = /"name":"Skill","input":\{"skill":"([^"]+)"/g;
/** transcript 裡一次 Read；只取 file_path。 */
export const READ_PATH_RE = /"name":"Read","input":\{"file_path":"((?:[^"\\]|\\.)*)"/g;
/** 這個 session 有沒有在動某條 loop 的階段檔／索引（判 loop-session 的第二個訊號）。 */
export const LOOP_ARTIFACT_RE = /\.loops[/\\\\]+[\w.-]+[/\\\\]+(?:loop\.md|PROGRESS\.md|stages|deliverables|events\.jsonl)/g;

/**
 * transcript 裡出現的**已安裝 plugin 版本路徑**，形如 `…/loops-workflow/0.20.0/references/…`。
 * reviewer 的 prompt 帶的是安裝路徑下的絕對路徑，所以這個字串幾乎一定會出現在跑過 loop 的
 * transcript 裡——比「猜最新版」可靠得多，而且不需要任何外部資料。
 */
export const VERSION_PATH_RE = /loops-workflow[/\\]+(\d+\.\d+\.\d+)[/\\]/g;

/** 本 plugin 的 skill 命名空間前綴。 */
export const SKILL_NS = 'loops-workflow:';

/** 分類結果值域。 */
export const TRANSCRIPT_KINDS = Object.freeze(['loop-session', 'non-loop']);

// ── 掃描（純函式）─────────────────────────────────────────────────────────

const unescape = (s) => String(s).replace(/\\\\/g, '\\').replace(/\\"/g, '"');

/**
 * 掃一份 transcript 文字 → 觀察到的事實。
 * 刻意不解析整份 JSON：transcript 動輒數十 MB、每行一個大物件，逐行 parse 又慢又容易被單一壞行
 * 打斷；這裡要的三件事都是穩定的字面圖樣。
 */
export function scanTranscript(text) {
  const raw = String(text ?? '');
  const skillCalls = [];
  for (const m of raw.matchAll(SKILL_CALL_RE)) skillCalls.push(m[1]);
  const referenceReads = [];
  for (const m of raw.matchAll(READ_PATH_RE)) {
    const path = unescape(m[1]).split('\\').join('/');
    // 只算 references/ 樹底下的檔——不論它是 repo 內的相對路徑，還是 reviewer 拿到的快取絕對路徑
    if (/(^|\/)references\//.test(path) && path.endsWith('.md')) referenceReads.push(basename(path));
  }
  const loopArtifacts = (raw.match(LOOP_ARTIFACT_RE) ?? []).length;
  return { skillCalls, referenceReads, loopArtifacts, detectedVersion: detectVersion(raw) };
}

/**
 * 這份 transcript 算不算「在跑 loop」。兩個訊號任一成立即算：
 * 叫過本 plugin 的 skill，或動過某條 loop 的階段檔。
 * **非 loop session 一律排除在分母之外**（並另外計數，讓排除看得見）。
 */
export function classifyKind({ skillCalls = [], loopArtifacts = 0 } = {}) {
  const usedOurSkill = skillCalls.some((s) => s.startsWith(SKILL_NS));
  return usedOurSkill || loopArtifacts > 0 ? 'loop-session' : 'non-loop';
}

/**
 * 這份 transcript 跑的是哪一版。**取出現最多次的**——偶爾出現的舊路徑（例如引用歷史紀錄）
 * 不該蓋掉這條 loop 實際跑的版本。抽不到 → `null`（**不猜**：標明比猜對更重要）。
 */
export function detectVersion(text) {
  const counts = new Map();
  for (const m of String(text ?? '').matchAll(VERSION_PATH_RE)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  if (!counts.size) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

// ── 期望集合（純函式）─────────────────────────────────────────────────────

/**
 * 快照裡「有 skill 宣稱會用到」的 reference 集合。
 * 判準＝**skill 正文逐字提到該檔名**，與 skill-lint 判 orphan-ref 同一套（不另發明第二套）。
 * 回 `Map<referenceBasename, Set<skillName>>`。
 */
export function expectedReferences(snapshot) {
  const map = new Map();
  for (const [skill, text] of snapshot.skillTexts ?? []) {
    for (const ref of snapshot.references ?? []) {
      if (!text.includes(ref)) continue;
      if (!map.has(ref)) map.set(ref, new Set());
      map.get(ref).add(skill);
    }
  }
  return map;
}

// ── 比對（純函式）─────────────────────────────────────────────────────────

/**
 * 只報**事實**、不報差集：叫了哪些 skill、讀了哪些 reference。
 * 給「抽不到版本／找不到對應快照」的那些組用——沒有期望集合就不能算差集，但事實仍然有價值，
 * 整組丟掉等於把已經拿到的觀測浪費掉。
 */
export function observedOnly(observations) {
  const loop = observations.filter((o) => o.kind === 'loop-session');
  const tally = (pick) => {
    const m = new Map();
    for (const o of loop) for (const it of pick(o)) m.set(it, (m.get(it) ?? 0) + 1);
    return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  };
  return {
    loopSessions: loop.length,
    nonLoop: observations.length - loop.length,
    skills: tally((o) => (o.skillCalls ?? []).filter((x) => x.startsWith(SKILL_NS)).map((x) => x.slice(SKILL_NS.length))),
    references: tally((o) => o.referenceReads ?? []),
  };
}

/**
 * 觀察 × 快照 → 載入度報告。
 *
 * `observations` 是 `[{file, kind, skillCalls, referenceReads}]`。
 * **觀察到的 skill 不在快照裡 ⇒ 版本對不上**，該份標 `not measured` 排除（而不是把它算成
 * 「載入了未宣告」——那會讓「新版才有的 skill」被誤讀成 registry 沒登記）。
 */
export function compareUsage(observations, snapshot) {
  const expected = expectedReferences(snapshot);
  const snapshotSkills = new Set(snapshot.skills ?? []);

  const notMeasured = [];
  const counted = [];
  let nonLoop = 0;

  for (const o of observations) {
    if (o.kind === 'non-loop') { nonLoop += 1; continue; }
    const ours = (o.skillCalls ?? []).filter((s) => s.startsWith(SKILL_NS)).map((s) => s.slice(SKILL_NS.length));
    // 版本錯配的**第一道**判準：transcript 自己講它跑的是哪一版。
    // 這條擋的是既有規則擋不住的方向——跑舊版時 skill 名是新版的子集，靠 skill 名永遠看不出來。
    if (o.detectedVersion && snapshot.version && o.detectedVersion !== snapshot.version) {
      notMeasured.push({ file: o.file, reason: `transcript 跑的是 ${o.detectedVersion}，快照是 ${snapshot.version}——拿新版的期望集合去比舊版的行為會得出假差集（實測差過 3.6 倍）` });
      continue;
    }
    const unknown = [...new Set(ours)].filter((s) => !snapshotSkills.has(s));
    if (unknown.length) {
      notMeasured.push({ file: o.file, reason: `叫到快照裡沒有的 skill（${unknown.join('、')}）——這份 transcript 跑的不是快照 ${snapshot.version}，硬比會得出假差集` });
      continue;
    }
    counted.push({ ...o, ours });
  }

  const tally = (rows, pick) => {
    const calls = new Map();
    const sessions = new Map();
    for (const r of rows) {
      const items = pick(r);
      for (const it of items) calls.set(it, (calls.get(it) ?? 0) + 1);
      for (const it of new Set(items)) sessions.set(it, (sessions.get(it) ?? 0) + 1);
    }
    return { calls, sessions };
  };

  const skillTally = tally(counted, (r) => r.ours);
  const refTally = tally(counted, (r) => r.referenceReads ?? []);

  const sortRows = (t) => [...t.calls.entries()]
    .map(([name, n]) => ({ name, count: n, sessions: t.sessions.get(name) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const invokedSkills = sortRows(skillTally);
  const loadedRefs = sortRows(refTally);
  const loadedRefNames = new Set(loadedRefs.map((r) => r.name));
  const expectedNames = [...expected.keys()].sort();

  // 逐 session 攤開：分母裡混了「碰過 loop 檔、但一次 skill 都沒叫」的 session——
  // 那本身就是最強的訊號，不能被聚合數字蓋掉。
  const sessions = counted.map((r) => ({
    file: r.file,
    detectedVersion: r.detectedVersion ?? 'unknown',
    skillCalls: r.ours.length,
    distinctSkills: [...new Set(r.ours)].sort(),
    referenceReads: (r.referenceReads ?? []).length,
    distinctReferences: new Set(r.referenceReads ?? []).size,
    loopArtifacts: r.loopArtifacts ?? 0,
    subagentFiles: r.subagentFiles ?? 0,
  })).sort((a, b) => b.skillCalls - a.skillCalls || a.file.localeCompare(b.file));

  return {
    snapshot: { version: snapshot.version, skills: snapshotSkills.size, references: (snapshot.references ?? []).length, expectedReferences: expectedNames.length },
    transcripts: { total: observations.length, loopSessions: counted.length, nonLoop, notMeasured, noSkillCall: sessions.filter((s) => s.skillCalls === 0).length },
    sessions,
    skills: {
      invoked: invokedSkills,
      neverInvoked: [...snapshotSkills].filter((s) => !skillTally.calls.has(s)).sort(),
    },
    references: {
      loaded: loadedRefs,
      neverLoaded: expectedNames.filter((r) => !loadedRefNames.has(r)).map((r) => ({ name: r, declaredBy: [...expected.get(r)].sort() })),
      loadedNotExpected: loadedRefs.filter((r) => !expected.has(r.name)).map((r) => r.name),
    },
  };
}

// ── 報告（純函式）─────────────────────────────────────────────────────────

export function renderReport(report) {
  const t = report.transcripts;
  const lines = [
    '# skill／reference 實際載入度',
    '',
    `快照：\`${report.snapshot.version}\`（${report.snapshot.skills} 個 skill、${report.snapshot.references} 份 reference，其中 ${report.snapshot.expectedReferences} 份有 skill 宣稱會用到）`,
    '',
    '## 分母',
    '',
    '| 掃到的 transcript | 算進分母（loop session） | 排除：非 loop | 排除：版本對不上 |',
    '|---|---|---|---|',
    `| ${t.total} | ${t.loopSessions} | ${t.nonLoop} | ${t.notMeasured.length} |`,
    '',
    '> 大部分 session 根本不是在跑 loop。把它們算進分母會得出嚇人但無意義的比例，所以**明確排除並計數**。',
    '',
  ];
  if (t.notMeasured.length) {
    lines.push('### 版本對不上而排除的（逐份列出，不靜默丟）', '');
    for (const n of t.notMeasured) lines.push(`- \`${n.file}\`：${n.reason}`);
    lines.push('');
  }

  lines.push('## 逐 session', '',
    `分母裡有 **${t.noSkillCall} 個 session 碰過 loop 的檔案、卻一次 skill 都沒叫**——那本身就是訊號，不能被聚合數字蓋掉。`,
    '',
    '| session | skill 呼叫 | 叫到哪些 | reference 載入（去重） | loop 檔動作 | 子代理檔 |', '|---|---|---|---|---|---|');
  for (const s of report.sessions ?? []) {
    lines.push(`| \`${s.file}\` | ${s.skillCalls} | ${s.distinctSkills.length ? s.distinctSkills.map((x) => `\`${x}\``).join('、') : '（無）'} | ${s.referenceReads}（${s.distinctReferences}） | ${s.loopArtifacts} | ${s.subagentFiles} |`);
  }
  lines.push('');

  lines.push('## skill 被叫到幾次', '', '| skill | 呼叫次數 | 出現在幾個 session |', '|---|---|---|');
  for (const s of report.skills.invoked) lines.push(`| \`${s.name}\` | ${s.count} | ${s.sessions} |`);
  if (!report.skills.invoked.length) lines.push('| （無） | — | — |');
  lines.push('');
  lines.push('### 一次都沒被叫到的 skill', '');
  lines.push(report.skills.neverInvoked.length
    ? report.skills.neverInvoked.map((s) => `- \`${s}\``).join('\n')
    : '（無——快照裡每個 skill 都至少被叫到一次）');
  lines.push('');

  lines.push('## reference 被載入幾次', '', '| reference | 載入次數 | 出現在幾個 session |', '|---|---|---|');
  for (const r of report.references.loaded.slice(0, 30)) lines.push(`| \`${r.name}\` | ${r.count} | ${r.sessions} |`);
  if (!report.references.loaded.length) lines.push('| （無） | — | — |');
  if (report.references.loaded.length > 30) lines.push(`| …另 ${report.references.loaded.length - 30} 份 | | |`);
  lines.push('');

  lines.push('### 有 skill 宣稱會用、但一次都沒被載入', '');
  if (!report.references.neverLoaded.length) {
    lines.push('（無）');
  } else {
    lines.push('**這一節是本報告的重點**：規範寫了、skill 也指名了，但實際跑的時候從來沒讀進去。', '');
    lines.push('| reference | 哪些 skill 宣稱會用它 |', '|---|---|');
    for (const r of report.references.neverLoaded) lines.push(`| \`${r.name}\` | ${r.declaredBy.map((s) => `\`${s}\``).join('、')} |`);
  }
  lines.push('');

  if (report.references.loadedNotExpected.length) {
    lines.push('### 被載入、但沒有任何 skill 正文提到它', '',
      '反向訊號：實際依賴沒寫進 skill 正文（或是由 agent／hook 直接指路的）。', '');
    for (const r of report.references.loadedNotExpected) lines.push(`- \`${r}\``);
    lines.push('');
  }

  lines.push('## 這份報告不回答什麼', '',
    '- **不回答「載入了有沒有照做」**。那是另一層；要先看完這裡的差集，才知道值不值得投資語意評測。',
    '- **不宣稱某條規則沒用**。一份 reference 從沒被載入，可能是機制沒接上、也可能是它本來就不需要——那是人的判斷。', '');
  return lines.join('\n');
}

// ── IO 薄邊界 ────────────────────────────────────────────────────────────────

function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

const safeRead = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
const safeDirs = (d) => { try { return readdirSync(d); } catch { return []; } };

function walkFiles(dir, filter, out = []) {
  for (const name of safeDirs(dir)) {
    const full = join(dir, name);
    try {
      if (statSync(full).isDirectory()) walkFiles(full, filter, out);
      else if (filter(name)) out.push(full);
    } catch { /* 單一項目失敗跳過 */ }
  }
  return out;
}

/**
 * 讀一份 plugin 快照（已安裝的歷史版本目錄，或 repo 內的 plugin 目錄）。
 * `references` 用**遞迴**收集 basename——這樣扁平版（舊）與分類子目錄版（新）都適用。
 */
export function loadSnapshot(dir) {
  const skillsDir = join(dir, 'skills');
  const refsDir = join(dir, 'references');
  const skills = safeDirs(skillsDir).filter((n) => { try { return statSync(join(skillsDir, n)).isDirectory(); } catch { return false; } });
  const skillTexts = skills.map((n) => [n, safeRead(join(skillsDir, n, 'SKILL.md')) ?? '']);
  const references = [...new Set(walkFiles(refsDir, (n) => n.endsWith('.md')).map((f) => basename(f)))].sort();
  return { version: basename(dir), dir, skills, skillTexts, references };
}

/** 列出已安裝的 plugin 快照版本（新到舊）。 */
export function listSnapshots(cacheRoot) {
  return safeDirs(cacheRoot)
    .filter((n) => /^\d+\.\d+\.\d+$/.test(n))
    .sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pb[i] - pa[i];
      return 0;
    })
    .map((n) => join(cacheRoot, n));
}

/** 收集要掃的 transcript：主檔 ＋ 同名目錄底下的 `subagents/*.jsonl`（reviewer 的 Read 在那裡）。 */
export function collectTranscripts(projectsRoot) {
  const out = [];
  for (const proj of safeDirs(projectsRoot)) {
    const dir = join(projectsRoot, proj);
    for (const name of safeDirs(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = name.replace(/\.jsonl$/, '');
      const subagents = walkFiles(join(dir, sessionId, 'subagents'), (n) => n.endsWith('.jsonl'));
      out.push({ project: proj, sessionId, main: join(dir, name), subagents });
    }
  }
  return out;
}

/**
 * 專案目錄名是由**絕對路徑**衍生的（`C--Users-<user>-Documents-GitHub-<repo>`），直接寫進報告
 * 等於把使用者的機器路徑推進版控。收斂成可讀標籤：砍掉磁碟機／使用者／常見上層目錄前綴。
 * 認不出前綴就原樣保留（不猜、不亂砍）。
 */
export function shortenProjectLabel(name) {
  return String(name ?? '')
    .replace(/^[A-Za-z]--Users-[^-]+-(?:Documents-)?(?:GitHub-)?/, '')
    // worktree 的專案目錄名長成 `<repo>--claude-worktrees-<slug>`。收成 `<repo>@<slug>` 有兩個理由：
    // 讀起來清楚，而且**那段前綴會被 compat-lint 誤判成廠商 model id**（它以 `claude-` 開頭）。
    .replace(/--claude-worktrees-/, '@');
}

/** 掃一組 transcript（主檔＋子代理）→ 一筆觀察。 */
export function observeTranscript(entry) {
  const parts = [entry.main, ...(entry.subagents ?? [])];
  const merged = { skillCalls: [], referenceReads: [], loopArtifacts: 0, detectedVersion: null };
  const versionCounts = new Map();
  for (const f of parts) {
    const text = safeRead(f);
    if (text === null) continue;
    const s = scanTranscript(text);
    merged.skillCalls.push(...s.skillCalls);
    merged.referenceReads.push(...s.referenceReads);
    merged.loopArtifacts += s.loopArtifacts;
    if (s.detectedVersion) versionCounts.set(s.detectedVersion, (versionCounts.get(s.detectedVersion) ?? 0) + 1);
  }
  // 主檔與子代理檔各自投票；版本以出現在最多份檔案的那個為準
  if (versionCounts.size) merged.detectedVersion = [...versionCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  return {
    file: `${shortenProjectLabel(entry.project)}/${entry.sessionId.slice(0, 8)}`,
    kind: classifyKind(merged),
    subagentFiles: (entry.subagents ?? []).length,
    ...merged,
  };
}

/**
 * 依偵測到的版本分組，各自對上**自己那一版的快照**分析。這才是正確的做法——
 * 單一快照模式只在「所有 transcript 都跑同一版」時才成立。
 *
 * 沒有對應快照的版本組、以及抽不到版本的組，**整組標明原因**、不硬套別版的期望集合。
 */
export function analyzeByVersion(projectsRoot, cacheRoot) {
  const snapshotsByVersion = new Map(listSnapshots(cacheRoot).map((d) => [basename(d), d]));
  const observations = collectTranscripts(projectsRoot).map(observeTranscript);

  const groups = new Map();
  for (const o of observations) {
    const key = o.detectedVersion ?? 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }

  const analysed = [];
  const skipped = [];
  for (const [version, rows] of [...groups.entries()].sort()) {
    const loopRows = rows.filter((r) => r.kind === 'loop-session');
    if (version === 'unknown') {
      skipped.push({ version, transcripts: rows.length, loopSessions: loopRows.length, observed: observedOnly(rows), reason: '這批 transcript 裡抽不到版本路徑——不猜它跑的是哪一版，整組不下差集結論；但觀測到的事實仍列出' });
      continue;
    }
    const dir = snapshotsByVersion.get(version);
    if (!dir) {
      skipped.push({ version, transcripts: rows.length, loopSessions: loopRows.length, observed: observedOnly(rows), reason: `找不到 ${version} 的 plugin 快照——沒有當時的期望集合就無從比對，整組不下差集結論；但觀測到的事實仍列出` });
      continue;
    }
    analysed.push({ version, report: compareUsage(rows, loadSnapshot(dir)) });
  }
  return { analysed, skipped, totalTranscripts: observations.length };
}

/** 分版本報告 → markdown。逐版本各一節，並把整組被跳過的原因寫出來。 */
export function renderByVersionReport(result) {
  const lines = [
    '# skill／reference 實際載入度（逐版本）',
    '',
    `掃到 ${result.totalTranscripts} 份 transcript。**每一組都用它自己那一版的快照當期望集合**——`,
    '拿新版的期望去比舊版的行為會得出假差集（實測差過 3.6 倍），所以版本不對就不比。',
    '',
  ];
  if (result.skipped.length) {
    lines.push('## 整組未量測（誠實揭露）', '', '| 版本 | transcript | 其中 loop session | 原因 |', '|---|---|---|---|');
    for (const s of result.skipped) lines.push(`| \`${s.version}\` | ${s.transcripts} | ${s.loopSessions} | ${s.reason} |`);
    lines.push('');
    for (const s of result.skipped) {
      if (!s.observed || !s.observed.loopSessions) continue;
      lines.push(`### \`${s.version}\` 組觀測到的事實（**沒有期望集合，所以不下差集結論**）`, '',
        `loop session ${s.observed.loopSessions} 個｜叫到的 skill：${s.observed.skills.length ? s.observed.skills.map((x) => `\`${x.name}\`×${x.count}`).join('、') : '（無）'}`, '',
        `載入的 reference：${s.observed.references.length ? s.observed.references.map((x) => `\`${x.name}\`×${x.count}`).join('、') : '（無）'}`, '');
    }
  }
  for (const a of result.analysed) {
    // 去掉子報告自己的 H1，換成標明版本的標題——一份文件裡不該有多個同級主標題
    const body = renderReport(a.report).split('\n').slice(1).join('\n');
    lines.push('---', '', `# 版本 \`${a.version}\``, body);
  }
  return lines.join('\n');
}

/** 一步到位：掃 transcript 根目錄 × 快照 → 報告。 */
export function analyzeAll(projectsRoot, snapshotDir) {
  const snapshot = loadSnapshot(snapshotDir);
  const observations = collectTranscripts(projectsRoot).map(observeTranscript);
  return compareUsage(observations, snapshot);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const at = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const projectsRoot = at('--transcripts', join(home, '.claude', 'projects'));
  const cacheRoot = at('--cache', join(home, '.claude', 'plugins', 'cache', 'dev-workflows', 'loops-workflow'));
  let snapshotDir = at('--snapshot', null);
  if (!snapshotDir) {
    const found = listSnapshots(cacheRoot);
    if (!found.length) {
      process.stderr.write(`skill-usage：找不到任何 plugin 快照（${cacheRoot}）——用 --snapshot <dir> 指定，或用 repo 內的 plugin 目錄\n`);
      return 1;
    }
    [snapshotDir] = found;
  }
  if (!existsSync(projectsRoot)) {
    process.stderr.write(`skill-usage：找不到 transcript 根目錄（${projectsRoot}）\n`);
    return 1;
  }
  if (args.includes('--by-version')) {
    const result = analyzeByVersion(projectsRoot, cacheRoot);
    if (args.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
    else process.stdout.write(`${renderByVersionReport(result)}
`);
    return 0;
  }
  const report = analyzeAll(projectsRoot, snapshotDir);
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (args.includes('--report')) process.stdout.write(`${renderReport(report)}\n`);
  else {
    const t = report.transcripts;
    process.stdout.write(`快照 ${report.snapshot.version}：${t.loopSessions} 個 loop session（排除 ${t.nonLoop} 個非 loop、${t.notMeasured.length} 個版本對不上）\n`);
    process.stdout.write(`  skill 被叫到 ${report.skills.invoked.length} 個、一次都沒叫到 ${report.skills.neverInvoked.length} 個\n`);
    process.stdout.write(`  reference 被載入 ${report.references.loaded.length} 份、宣稱會用卻沒載入 ${report.references.neverLoaded.length} 份\n`);
  }
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());

export { repoRoot };
