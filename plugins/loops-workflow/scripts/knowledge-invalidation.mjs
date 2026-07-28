#!/usr/bin/env node
// knowledge-invalidation.mjs —— 共享記憶的 deterministic 失效判定（#218）。
//
// 要解的問題：build／iterate／外部改動之後，**哪些共同事實還能重用、哪些必須重查**。整包重建太貴
// （等於回到「每個 agent 重新理解一次」），整包保留則會讓 stale fact 混進下一階段——後者更糟，因為
// 它看起來跟正確的事實一模一樣。所以判定必須是機械的：**逐 claim 比對 provenance，只失效受波及的那些**。
//
// 三種結果、涇渭分明（S3）：
//   · `invalid`   —— 有**正面證據**顯示來源變了（digest 不同、檔案不見了）。必須重查。
//   · `uncertain` —— **證明不了仍有效**（graph revision 對不上、evidence 的 revision 移動了、
//                     本該讀得到的來源讀不到、或它依賴的上游 claim 剛剛動了）。使用前保守補查。
//   · 不動        —— 來源逐一對得上帳。這才是「跨階段不重複探索」真正省下來的部分。
//
// **downstream 一律只降到 `uncertain`、不降到 `invalid`**（刻意）：上游變了只證明「這條的立足點動了」，
// 不證明「這條的敘述是錯的」。把它一律打成 invalid 會逼著整串重查，等於回到整包重建；標 uncertain 則
// 讓下一個 agent 知道「這條要自己確認一下」，而 gate 也不會把它當 valid 放行。
//
// **無法判定時一律降級，不當 clean**：這是本檔最重要的不對稱。判不出來就當沒事，等於把「檢查失敗」
// 靜默轉譯成「檢查通過」——那正是這道機制要防的形狀。唯一的例外是本檔**本來就查不到的遠端來源**
// （issue body），它們列進 `coverage.unprobed` 誠實揭露，由呼叫端決定要不要另行查證。
//
// 分層：純函式（computeInvalidation／propagate）＋ IO 薄邊界（probeSources 讀檔算 digest、
// applyInvalidation 走 knowledge-ledger append）。依賴：僅 node 內建 ＋ 本 repo 內既有 script。
// 用法：node knowledge-invalidation.mjs <loop 目錄> --root <repo 根> [--revision <sha>] [--apply] [--json]
//       預設**只判不寫**（dry-run）——加 `--apply` 才把判定 append 回事件流。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { digestOf, appendInvalidated, readKnowledge, NOT_MEASURED } from './knowledge-ledger.mjs';

/** 本檔查得到的來源型別（locator 對得上一個實體檔案）。 */
const LOCAL_SOURCE_TYPES = new Set(['repo-file', 'code-symbol', 'artifact']);
/** 本檔查不到、但也不該因此降級的來源型別（誠實列進 coverage.unprobed）。 */
const REMOTE_SOURCE_TYPES = new Set(['issue']);

/** 已經不會被取用的狀態：再判一次沒有意義，也不該產生第二筆 transition。 */
const TERMINAL = new Set(['invalid', 'superseded']);

/** code-symbol 的 locator `path#symbol` → 檔案路徑（digest 基準是整個檔案，見 vocabulary 註記）。 */
export function sourceFilePath(source) {
  const locator = String(source?.locator ?? '');
  return source?.type === 'code-symbol' ? locator.split('#')[0] : locator;
}

// ── IO 薄邊界：算出來源現在的 digest ────────────────────────────────────────

/**
 * 讀出每個**本地**來源現在的 digest → `Map<locator, digest|null>`。
 * `null` 代表「該讀得到卻讀不到」（檔案不見了／讀取失敗）——那是正面證據，不是未知。
 * 遠端來源（issue）不放進 map，呼叫端會在 coverage 看到它們。
 * `readFile` 以 port 注入，讓 computeInvalidation 的測試不必碰真的檔案系統。
 */
export function probeSources(rootDir, claims, { readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  const probes = new Map();
  for (const claim of claims ?? []) {
    for (const source of claim?.sources ?? []) {
      if (!LOCAL_SOURCE_TYPES.has(source?.type)) continue;
      const locator = String(source.locator ?? '');
      if (locator === '' || probes.has(locator)) continue;
      try {
        probes.set(locator, digestOf(readFile(join(rootDir, sourceFilePath(source)))));
      } catch {
        probes.set(locator, null); // 讀不到＝來源不在了，這是可判定的失效
      }
    }
  }
  return probes;
}

// ── 純函式：逐 claim 判定 ───────────────────────────────────────────────────

function classifyClaim(claim, { probes, graphRevisions, revision }) {
  const changed = [];
  const missing = [];
  const unprobedLocal = [];
  const unprobed = [];
  let graphStale = null;
  let evidenceStale = null;

  for (const source of claim.sources ?? []) {
    const locator = String(source?.locator ?? '');
    if (source?.type === 'code-graph') {
      const project = claim.graphProject ?? null;
      const current = project ? graphRevisions?.[project] : undefined;
      if (!current || current === NOT_MEASURED) {
        graphStale = `code graph snapshot 的 revision 取不到（project ${project ?? '?'}）`;
      } else if (claim.graphRevision && claim.graphRevision !== NOT_MEASURED && current !== claim.graphRevision) {
        graphStale = `code graph snapshot 已換版（${claim.graphRevision} → ${current}）`;
      } else if (!claim.graphRevision || claim.graphRevision === NOT_MEASURED) {
        graphStale = 'claim 沒記下當時的 code graph revision，無從證明仍然對得上';
      }
      continue;
    }
    if (source?.type === 'command-output') {
      // 命令輸出只證明「當時那個 revision 上跑出這個結果」。revision 移動了就不再是證據。
      if (!revision || revision === NOT_MEASURED) {
        evidenceStale = '取不到目前的 revision，無從證明這份執行證據仍對應同一份程式碼';
      } else if (claim.createdAtRevision && claim.createdAtRevision !== NOT_MEASURED && claim.createdAtRevision !== revision) {
        evidenceStale = `執行證據取自 ${claim.createdAtRevision}，目前是 ${revision}`;
      } else if (!claim.createdAtRevision || claim.createdAtRevision === NOT_MEASURED) {
        evidenceStale = 'claim 沒記下取得證據時的 revision';
      }
      continue;
    }
    if (REMOTE_SOURCE_TYPES.has(source?.type)) {
      unprobed.push(locator);
      continue;
    }
    if (!probes.has(locator)) {
      unprobedLocal.push(locator); // 本該查得到卻沒查到 ⇒ 判不出來 ⇒ 降級，不當 clean
      continue;
    }
    const current = probes.get(locator);
    if (current === null) missing.push(locator);
    else if (source.digest && current !== source.digest) changed.push(locator);
    else if (!source.digest) unprobedLocal.push(locator); // 當初就沒記 digest ⇒ 無從比對
  }

  if (changed.length > 0 || missing.length > 0) {
    const parts = [];
    if (changed.length) parts.push(`來源內容已改：${changed.join('、')}`);
    if (missing.length) parts.push(`來源已不存在：${missing.join('、')}`);
    return { to: 'invalid', reason: parts.join('；'), changedSources: [...changed, ...missing], unprobed };
  }
  const doubts = [graphStale, evidenceStale, unprobedLocal.length ? `無從比對的來源：${unprobedLocal.join('、')}` : null].filter(Boolean);
  if (doubts.length > 0) {
    return { to: 'uncertain', reason: doubts.join('；'), changedSources: [], unprobed };
  }
  return { to: null, reason: '', changedSources: [], unprobed };
}

/**
 * 逐 claim 判定失效 → `{ transitions, unaffected, coverage }`（純函式）。
 *
 * · `probes`：`Map<locator, digest|null>`，由 `probeSources()` 產生（或測試注入）。
 * · `graphRevisions`：`{ [project]: revision }`，取不到就別給——**不要填 `not_measured` 以外的假值**。
 * · `revision`：目前的 git sha；取不到傳 `not_measured`（會讓執行證據型 claim 降級，這是刻意的）。
 *
 * downstream 傳播跑到不動點為止：上游被降級 ⇒ 下游一律 `uncertain`（見檔頭）。
 */
export function computeInvalidation({ claims = [], probes = new Map(), graphRevisions = {}, revision = NOT_MEASURED } = {}) {
  const transitions = [];
  const moved = new Map(); // claimId → 新狀態（供 downstream 傳播查詢）
  const coverage = { checked: 0, unprobed: [] };

  for (const claim of claims) {
    if (TERMINAL.has(claim.validity)) continue;
    coverage.checked += 1;
    const verdict = classifyClaim(claim, { probes, graphRevisions, revision });
    for (const locator of verdict.unprobed) {
      if (!coverage.unprobed.includes(locator)) coverage.unprobed.push(locator);
    }
    if (!verdict.to) continue;
    if (claim.validity === verdict.to) continue; // 已經是這個狀態 ⇒ 不重複寫一筆
    transitions.push({
      claimId: claim.claimId,
      from: claim.validity,
      to: verdict.to,
      reason: verdict.reason,
      changedSources: verdict.changedSources,
      cause: 'source',
    });
    moved.set(claim.claimId, verdict.to);
  }

  // downstream：依賴剛被降級的 claim ⇒ 一律 uncertain，跑到不動點（依賴鏈可能不只一層）。
  const byId = new Map(claims.map((c) => [c.claimId, c]));
  for (;;) {
    let grew = false;
    for (const claim of claims) {
      if (TERMINAL.has(claim.validity) || moved.has(claim.claimId)) continue;
      const trigger = (claim.derivedFrom ?? []).find((parentId) => {
        const parentMoved = moved.get(parentId);
        if (parentMoved) return true;
        const parent = byId.get(parentId);
        return parent ? parent.validity !== 'valid' : true; // 上游根本不在 ⇒ 同樣證明不了
      });
      if (!trigger) continue;
      if (claim.validity === 'uncertain') { moved.set(claim.claimId, 'uncertain'); continue; }
      transitions.push({
        claimId: claim.claimId,
        from: claim.validity,
        to: 'uncertain',
        reason: `上游 claim ${trigger} 已失效或無法證明仍有效`,
        changedSources: [],
        cause: 'derived',
      });
      moved.set(claim.claimId, 'uncertain');
      grew = true;
    }
    if (!grew) break;
  }

  const unaffected = claims.filter((c) => !TERMINAL.has(c.validity) && !moved.has(c.claimId)).map((c) => c.claimId);
  return { transitions, unaffected, coverage };
}

// ── IO 薄邊界：把判定寫回事件流 ─────────────────────────────────────────────

/**
 * 把 transitions append 成 `knowledge.invalidated` 事件（**不修改歷史 event**，只往後追加）。
 * 回傳實際寫出去的那幾筆——呼叫端要能對帳「判定了幾條、寫了幾條」。
 */
export function applyInvalidation(loopDir, transitions) {
  return (transitions ?? []).map((t) => appendInvalidated(loopDir, {
    claimId: t.claimId,
    validity: t.to,
    reason: t.reason,
    changedSources: t.changedSources,
    cause: t.cause,
  }));
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main(argv) {
  const flag = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  const loopDir = argv.find((a) => !a.startsWith('--') && !argv[argv.indexOf(a) - 1]?.startsWith('--'));
  if (!loopDir) {
    process.stdout.write('用法：node knowledge-invalidation.mjs <loop 目錄> --root <repo 根> [--revision <sha>] [--apply] [--json]\n');
    return 0;
  }
  const root = flag('--root', process.cwd());
  const revision = flag('--revision', NOT_MEASURED);
  const claims = readKnowledge(loopDir).state.claims;
  const result = computeInvalidation({ claims, probes: probeSources(root, claims), revision });
  const applied = argv.includes('--apply') ? applyInvalidation(loopDir, result.transitions).length : 0;

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ...result, applied, dryRun: !argv.includes('--apply') }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`失效判定：檢查 ${result.coverage.checked} 條、降級 ${result.transitions.length} 條、保持有效 ${result.unaffected.length} 條${argv.includes('--apply') ? `（已寫回 ${applied} 筆）` : '（dry-run，未寫回；加 --apply 才寫）'}\n`);
  for (const t of result.transitions) process.stdout.write(`  · ${t.claimId}：${t.from} → ${t.to}（${t.cause}）——${t.reason}\n`);
  for (const locator of result.coverage.unprobed) process.stdout.write(`  ! 本檔查不到的來源（未驗到，不代表沒問題）：${locator}\n`);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
