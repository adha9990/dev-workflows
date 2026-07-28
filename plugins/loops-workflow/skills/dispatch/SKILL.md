---
name: dispatch
description: Routes a work request to the right entry point, sets how far to go (stop_after), and resumes an existing loop from its handoff. Use when starting any loops-workflow run, or when the user says /loops-workflow:dispatch, or is unsure which phase (define/plan/build/verify/finalize) to begin from.
---

# dispatch — 入口分類 + 走多遠 + 接續

## Overview

`dispatch` 是 loops-workflow 的**控制節點**，不是工作階段（phase 報表裡不會有它）。它很薄，只做四件事：

1. **接續**：輸入是既有 loop 的 slug → 走 resume 協定（freshness → 從該回的地方續）。
2. **判入口**：這份工作從哪個 phase 起跑（見〈判入口〉）。
3. **決定走多遠**：解析 `stop_after`——使用者只要開 issue？只要規劃？只要驗一份 PR？
4. **建 `.loops/<slug>/loop.md`**（＋會動 code 的迴圈開 worktree），然後進起點 phase。

它同時是「中央說明書」的入口：全程不變的紀律集中寫在 `AGENTS.md`，各階段不各自重述。

> 原則：**只分流、不串接** —— dispatch 判完直接進起點 phase（routine 轉場不問），但不替你把整條 loop 自動跑完，也**不會跨過使用者要求的停點**。

## When to Use

**Use when**：開始一個 loops-workflow 任務、接續一條中途的 loop、或不確定該從哪裡進。

**NOT for**：
- 把所有階段一路自動跑完 —— 那違反 Closed Loop。
- **側用工具不歸 dispatch 路由** —— `explain`（看懂改動）由 finalize 內部驅動（完整迴圈完工**一律自動產** `deliverables/explain.md`），或使用者以自然語言請求。

## Process

### 0. 先判 resume（輸入是既有 loop 的 slug 就不分類）

判入口**之前**先確定性檢查：算 `LOOPS_ROOT`（`git worktree list --porcelain | sed -n 's/^worktree //p' | head -1`），**若 `$LOOPS_ROOT/.loops/<輸入>/loop.md` 存在**（完全比對目錄名、不做模糊匹配）→ **跳過整個分類**，走 resume：

1. 讀 handoff 狀態：`node <plugin-root>/scripts/handoff-ledger.mjs "$LOOPS_ROOT/.loops/<slug>" --json`。
2. **有 handoff** → 跑 freshness（來源版本／Goal Contract revision／產物是否還在／pending 是否仍成立），依判定續跑：
   - `fresh` ⇒ 從 handoff 的 `next_entry` 起點續跑，**不重跑已完成階段**；
   - `stale`／`uncertain` ⇒ 只回到**最早受影響的那一個階段**，並在 Journal 記下是哪一項沒過。
   - 記一筆 `handoff.accepted` ＋ `workflow.resumed`（帶 verdict／resumeFrom／invalidated）。
3. **沒有 handoff**（舊 loop）→ 讀 Journal 重建狀態，回報停在哪個階段／哪個 gate，問是否續跑。

**「換了一個新 session」本身不是重跑的理由**——要重跑得說得出是哪一項 freshness 沒過。完整規則見 `references/shared/capability/handoff.md`。

### 1. 判入口（先看乾淨度，再看手上有什麼）

```
├─ 完全乾淨的空專案（無原始碼 / 空目錄）─────────▶ 先 scaffold 建骨架（§1.4）→ 再依下面分類
├─ 要改**工作流程規則本身**（「以後都要…」「把這條加進 plugin」）▶ `agents-md-maintainer`
├─ 還沒有 issue（含模糊的一句話想法）───────────▶ 入口 no-issue　起點 define
├─ 有 issue 號 / 「做這個 issue」──────────────────▶ 入口 issue　起點 plan
├─ 已有核准的 plan ───────────────────────────────▶ 入口 approved-plan　起點 build
├─ PR 號 / reviewer 回饋要修正 ────────────────────▶ 入口 pr-comment　起點 build
├─ 只要驗一份 PR / 改動 ──────────────────────────▶ 入口 verify-only　起點 verify
└─ 研究（bounded research 或 research issue）─────▶ 入口 research　起點 plan(research)
```

值域與各入口的安全預設終點見 `references/workflow-vocabulary.json` 的 `entries`。

> **模糊的一句話不再有獨立的釐清階段**：直接進 `define`。它會**先探索現況、再一次問一個** blocking 決策（Decision Queue，見 `references/shared/capability/decision-queue.md`），所以問出來的題目扣著這個 repo 的實際狀況，而不是憑空追問。這正是 `clarify` 退場的原因——尚未理解現有實作就訪談，只會把問題越問越偏。

> **policy-change intent 優先於其他判定**：請求的對象是「工作流程規則本身」而不是某個功能時（典型句式：「以後都要 X」「把 X 這條規則加進 plugin」），一律路由到 `agents-md-maintainer`。只有使用者在陳述偏好、沒要求落成規則時才不路由（先確認）。

顯式語法可跳過判斷：`dispatch <type> <ref>`，例如 `dispatch issue #5`、`dispatch verify PR#12`；接續既有 loop 用 `dispatch <slug>`（步驟 0 自動偵測）。

### 1.2 決定走多遠（`stop_after`）

**優先序：使用者明講的 > 意圖字面 > 入口預設**。

| 使用者意圖 | `stop_after` | 停在 |
|---|---|---|
| 先開 issue | `issue` | H1 · Issue Ready |
| 規劃 issue | `plan` | H2 · Plan Ready |
| 照 approved plan 實作、交 QA | `build` | H3 · Build Ready |
| 只驗 PR／改動 | `verified` | H4 · Verified |
| 完成 issue／處理完 PR comment | `finalized` | H5 · Delivery Ready |
| 完成研究報告 | `research-finalized` | H5R · Research Finalized |

解析用的是同一份值域（`references/workflow-vocabulary.json` 的 `handoff`）：程式內走 `scripts/handoff-ledger.mjs` 的 `resolveStopAfter({ explicit, intent, entry })`。把結果寫進 `loop.md` 的 `stop_after` 欄。

規則：**不在每個 checkpoint 重問要不要繼續**；到達 `stop_after` 必須停（`auto` 模式也一樣）；沒有明確 partial intent 時才用入口預設。

### 1.4 完全乾淨的空專案 → 先 scaffold 骨架

判入口前先看目標專案是不是「完全乾淨」（空目錄 / 沒有原始碼 / 沒有 `package.json` / 沒有 git 歷史）。是的話沒有架構承載 define 出來的 issue、也沒有 code 可改 —— **先把骨架立起來**：

- **確認（一定停 —— scaffold 是大動作、且技術棧是定死的）**：開一個決策點問要不要建骨架（給選項並標推薦；表述形狀與平台映射見 `references/shared/delivery/interaction-adapter.md`）。內建的 `scaffold-fullstack` 出的是 **Fastify + React 19 + TanStack + Kysely/SQLite + Vitest** 的分層全端 TS 專案。
- 要別的棧（FastAPI / Next.js / 純前端…）→ 請使用者自行建好骨架再回來，dispatch 不硬塞。
- 骨架立好後回到 §1 判入口（多半是 no-issue → define）。

> 模稜兩可（已有少量檔案 / 半成品）→ 當既有專案、不 scaffold。

### 2. 建 / 認領 loop.md

slug：**issue / fix 迴圈用 `<issue#>-<kebab 描述>`**（例 `137-trash-delete-permanent`）、無 issue 號的研究用 `<kebab 描述>`。**不加 `fix/`/`feat/` 等 type 前綴** —— 這個 slug 同時是 loop 目錄、worktree、branch 的名字。建立 `.loops/<slug>/loop.md`（**留在 loop 根**；階段過程檔進 `stages/`、交接進 `handoff/`、完工 deliverable 進 `deliverables/`），寫入：

- **類型**（issue / research / fix）
- **operation 性質**（`new-feature` / `change-behavior` / `bug-fix` / `refactor`）—— 依 issue 內容判定，決定 **build 紅燈第一步**（見 `references/stages/operation-first-move.md`）。**拿不準向嚴用 `new-feature`** 並在 Journal 註明。無 issue 工作經 `define` 建 loop.md 時由 define 寫；任何成因導致缺欄時由 `plan` 兜底補。
- **入口** + **起點 phase** + **當前階段**（每進一個 phase 就更新）
- **`stop_after`**（見 §1.2）
- **session**（讀 harness 提供的 session 識別碼填；progress / hook 靠它只顯示「本 session」正在跑的 loop）
  <!-- adapter-projection -->
  - Claude Code：session 識別碼放在環境變數 `CLAUDE_CODE_SESSION_ID`，用 Bash 讀（`echo "$CLAUDE_CODE_SESSION_ID"`）。
  <!-- /adapter-projection -->
- **推進模式**（closed / auto，預設 closed）—— 建 loop.md 前跑一次 `echo "${LOOPS_AUTO:-}"`，輸出 `1` → auto（見 `references/shared/runtime/auto-mode.md`）
- **Journal（append-only 事件日誌）**（空，每階段 append 一筆，見 `references/shared/runtime/journaling.md`）

**Worktree（會動 code 的迴圈才開）**：①**何時開**：入口會走到 build 的才開；`stop_after=issue`／`plan` 與純研究**不開**（走到 build 再開）。②**怎麼開**：harness 若有原生能力就用它，沒有就 `git worktree add .claude/worktrees/<slug> -b <slug> <base>`；fix 型把該 PR branch checkout 進 worktree。③**`.loops/<slug>/` 一律建在主 repo**（`$LOOPS_ROOT` 絕對路徑），不進 worktree。完整規範、落點錨定公式與理由見 `AGENTS.md` 規則 9。

**Resume**：若 `.loops/<slug>/loop.md` 已存在 → 不覆蓋，走步驟 0 的 resume 協定。

### 3. 進起點 phase（routine 轉場不問）

宣告判定結果（入口 / 起點 / `stop_after` / loop.md 路徑），然後**直接進起點 phase 開始做** —— **不問「要不要進 plan / build」**。只有**連分類都衝突 / 多重**（連是 code 任務還是別的都分不出）時才停下開一個決策點問。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「我直接幫他把所有階段跑完比較快」 | 使用者說「先開 issue 就好」時，跑完整條 loop 不是效率、是跨過他要求的停點。`stop_after` 是硬的。 |
| 「需求有點模糊，先問一句再說」 | 模糊 → 進 `define`，它會先探索再一次一問。在 dispatch 停下問一句既沒有 repo 脈絡、也不會被記進 decision graph。 |
| 「新 session 了，保險起見重新探索一遍」 | 換 session 不是 freshness 失敗。要重跑得說得出哪一項沒過（來源版本／goal revision／產物／pending）。 |
| 「loop.md 之後再補」 | loop.md 是後續階段認領狀態的唯一依據；現在不建，下個階段就接不住。 |

## Red Flags

- 你在 dispatch 裡開始讀 codebase / 寫 code / 訪談 —— 那是 define / plan / build 的事，dispatch 只分流。
- 沒解析 `stop_after` 就往下跑（等於預設「一路做到底」，而使用者可能只要一張 issue）。
- resume 時整條重跑，而不是只回到最早受影響的階段。
- `stop_after=issue`／`plan` 卻先開了 worktree。
- 沒建 loop.md 就交棒。
- **要實作的工作沒有對應 issue 就直接進 plan / build** —— 一律先 `define` 建一個再進（AGENTS 規則 12）。

## Verification

- [ ] 輸入是既有 slug 時走 resume：跑過 freshness、依 verdict 決定從哪續、記了 `handoff.accepted` ＋ `workflow.resumed`。
- [ ] 入口分類正確（對得上 `entries` 值域），起點是五個 canonical phase 之一。
- [ ] `stop_after` 已解析並寫進 loop.md（明講 > 意圖 > 入口預設）。
- [ ] 目標若是**完全乾淨的空專案**，已先開決策點確認 + scaffold（或使用者選跳過 / 要別的棧）才往下；既有 / 半成品專案不 scaffold。
- [ ] **所有無 issue 的工作都先經 `define` 用 repo template 建 issue**——不 ad-hoc `gh issue create`（規則 12）。
- [ ] `.loops/<slug>/loop.md` 已建立（或既有的已認領），含類型 / 入口 / 起點 / `stop_after`，**且落在主 repo 根 `$LOOPS_ROOT/.loops/`（絕對路徑錨定、不在任何 `.claude/worktrees/*/` 內）**。
- [ ] `stop_after` 不會走到 build 時**沒有**開 worktree。
- [ ] 已進起點 phase 開始做（分類模糊時才停下開決策點問），沒有用純文字問「要不要進 X」。
