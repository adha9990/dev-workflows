---
name: dispatch
description: Routes a one-line work request to the right loops-workflow stage and sets up the loop. Use when starting any loops-workflow run, or when the user says /loops-workflow:dispatch, or is unsure which stage (goal/explore/plan/build/verify/iterate) to begin from.
---

# dispatch — 決策樹分流 + 操作規則入口

## Overview

`dispatch` 是 loops-workflow 的分流台，**很薄**：判類型（**乾淨空專案先 scaffold 骨架**、**模糊想法先進 `clarify` 釐清**、**已釐清的待解決問題 define 成 GitHub issue**）、建 `.loops/<slug>/loop.md`、進起點階段。routine 轉場不問你；只有分類衝突、或 scaffold / 建 issue 這種大動作 / outward action 才停下確認。**dispatch 自己不做需求訪談 / 複述確認 —— 那是 `clarify` 階段的事**（模糊就路由給它，別塞進 router）。

它同時是「中央說明書」的入口：全程不變的紀律集中寫在 `AGENTS.md`（繁中對外 / human gate 不可跳 / `.loops/` 每階段交接 / 模糊就 surface / Metric-Honesty），各階段不各自重述。dispatch 負責在開場把這套規矩立起來。

> 原則：**只分流、不串接** —— dispatch 不是自動駕駛，判完直接進起點階段（routine 不問），但不替你把整條 loop 自動跑完。

## When to Use

**Use when**：
- 開始一個 loops-workflow 任務、但不確定該從哪個階段進。
- 使用者丟一句話描述 / issue 號 / PR 號，要判斷這是「處理 issue / 設計問題 / 修正問題」。

**NOT for**：
- 你已經知道要哪個階段 —— 直接喊那個階段（`/loops-workflow:goal` 等），別繞 dispatch 多花一圈 token。
- 把所有階段一路自動跑完 —— 那違反 Closed Loop，dispatch 只送你到起點。

## Process

### 1. 判類型（決策樹：先看乾淨度，再判意圖清晰度）

```
├─ 完全乾淨的空專案（無原始碼 / 空目錄）─────────▶ 先 scaffold 建骨架（§1.4）→ 再依下面清晰度分流
├─ issue 號 / 「做這個 issue」（意圖明確）────────▶ 從 goal 開始（跳過 clarify）
├─ PR 號 / 「reviewer / 修正回饋」（意圖明確）────▶ 從 iterate 開始（跳過 clarify）
├─ 模糊想法 / 含糊一句話 / 不確定要落地還是研究 ─▶ 從 `clarify` 開始（一次一問釐清 + 確認 → 再判方向：define/goal/explore/iterate）
├─ 已釐清、要追蹤成 issue ────────────────────────▶ `define`（建 template-ready issue）→ goal
└─ 已知是純研究 / 評估（不落地）──────────────────▶ explore（不建 issue）
```

> 順序：**先看專案乾不乾淨**（沒架構先 scaffold），**再判意圖清晰度** —— 明確（issue#/PR#/具體到能動工）直進 goal/iterate；**模糊（一句話想法、範圍不清、不確定落地還是研究）先進 `clarify` 釐清再分流**。dispatch 自己不做訪談確認，那是 clarify 的事。

顯式語法可跳過判斷：`dispatch <type> <ref>`，例如 `dispatch issue #5`、`dispatch explore "command pattern 怎麼設計"`、`dispatch iterate PR#12`。

**推進模式**：預設只在決策點停（routine 轉場不問）。加 `auto` → `dispatch auto <描述>` 開 opt-in 自動連跑（核准計畫一次後連決策也用推薦自動帶過，危險 / 失敗 / P0 / 規格模糊仍硬停，見 `references/auto-mode.md`）。

### 1.4 完全乾淨的空專案 → 先 scaffold 骨架，再 define

判類型前**先看目標專案是不是「完全乾淨」**：空目錄 / 沒有原始碼 / 沒有 `package.json` / 沒有 git 歷史（`git log --oneline -1` 無 commit、目錄無 `src`·`package.json`）。是的話沒有架構承載 define 出來的 issue、也沒有 code 可改 —— **先把骨架立起來**：

- **確認（一定停 —— scaffold 是大動作、且技術棧是定死的）**：用 `AskUserQuestion` 問要不要建骨架。loops-workflow **內建的 `scaffold-fullstack`** skill 出的是 **Fastify + React 19 + TanStack + Kysely/SQLite + Vitest** 的分層全端 TS 專案。
  - 要、且這個棧合用 → 交 `scaffold-fullstack`（它自己會問目錄 / 名稱、跑模板、`pnpm install` + `typecheck/lint/test` 驗收）。
  - 要、但要別的棧（FastAPI / Next.js / 純前端…）→ `scaffold-fullstack` 不適用，請使用者自行建好骨架再回來，dispatch 不硬塞。
  - 只想先把問題定義清楚 → 跳過，直接走 §1.5 define。
- 骨架立好後，依**意圖清晰度**往下（明確就直接走；模糊才進 clarify）：
  - **想法還模糊**（要做什麼 / 範圍不清，greenfield 常見）→ 先進 `clarify` 釐清 + 確認 → 再 define / explore。
  - **馬上實作某一件明確的事** → 走 §1.5 `define` 把那個問題具體化成 issue → 再 goal。
  - **先盤點要做哪些事** → 走 **`explore` 發散式**（研究設計空間）→ 由 `explore → define` gate 把確認過的問題開成 **issue backlog** → 停下等後續逐步解決（不強制續進 goal）。

> `scaffold-fullstack` 是 **loops-workflow 內建 skill**（`skills/scaffold-fullstack/`，自帶整棵模板樹 + scaffold 腳本）—— 無外部 plugin 依賴、永遠可用，直接 `/loops-workflow:scaffold-fullstack` 也能單獨跑。模稜兩可（已有少量檔案 / 半成品）→ 當既有專案、不 scaffold。



一個**已釐清、要解決 / 實作、但還沒有 GitHub issue** 的問題 → **進 `define` skill**：用 Readiness Model + repo 的 issue template + scope sizing + flowchart，把它具體化成 template-ready issue（草稿校稿 → `gh issue create --assignee @me` → 刪 tmp），slug 用 `<新 issue#>-<kebab>`、loop.md 類型 = issue，**再進 `goal`**。**若從 `clarify` 進來、需求已釐清，define 不重新訪談、只做格式化**（clarify 已把模糊收斂、判好方向）。

**還很模糊 / 分不清「要實作 vs 只是研究」**→ 不在 dispatch 猜或問一句，**進 `clarify`**：它一次一問釐清、確認理解後判方向（落地→define→goal / 研究→explore / 修既有→iterate）。

### 2. 建 / 認領 loop.md

slug：**issue / fix 迴圈用 `<issue#>-<kebab 描述>`**（例 `137-trash-delete-permanent`）、無 issue 號的設計 / 研究用 `<kebab 描述>`（英文 / 數字 / 連字號）。**不加 `fix/`/`feat/` 等 type 前綴** —— 這個 slug 同時是 loop 目錄、worktree、branch 的名字。建立 `.loops/<slug>/loop.md`，寫入：
- **類型**（issue / design / fix）
- **起點階段** + **當前階段**（當前階段初始＝起點階段，每進一個階段就更新；供 statusline 顯示）
- **session**（用 Bash 讀 `$CLAUDE_CODE_SESSION_ID` 填；statusline 靠它**只顯示「本 session」正在跑的 loop**，不被別 session / 歷史 loop 干擾）
- **推進模式**（closed / auto，預設 closed）
- **停止條件雛形**（goal 階段會精煉）
- **Journal（append-only 事件日誌）**（空，每階段 append 一筆，見 `references/journaling.md`）

**Worktree（會動 code 的迴圈才開）**：type 是 issue / fix → loop 啟動時開**隔離 worktree（自帶 branch）做 code**，**主 checkout 不動**：用 `EnterWorktree`，或 `git worktree add .claude/worktrees/<slug> -b <slug> <base>`（**branch / worktree 名 = slug `<issue#>-<slug>`，例 `137-trash-delete-permanent`，不加 type 前綴**）；fix 型把該 PR branch checkout 進 worktree。**但 `.loops/<slug>/` 建在主 repo（dispatch 當下的 cwd / `git worktree list` 第一筆）、不放進 worktree** —— worktree 只放 code；未追蹤的 `.loops/` 放 worktree 會在 clean/refresh/remove 時被一起刪掉。各階段即使 cd 在 worktree 裡，也把 `.loops/` 寫回主 repo（用絕對路徑）。純設計 / 研究免開（走到 build 再開）。見 `AGENTS.md` 規則 9。

**Resume**：若 `.loops/<slug>/loop.md` 已存在 → 不覆蓋，走 resume 協定（讀 Journal 重建狀態 → 回報「停在哪個階段 / 哪個 gate、已完成 E1–En」→ 問使用者是否續跑，見 `references/journaling.md`）。

### 3. 進起點階段（routine 轉場不問）

宣告判定結果 + 起點 + loop.md 路徑，然後**直接進起點階段開始做** —— **不問「要不要進 goal / iterate」**（routine 轉場不問）。**意圖模糊**的請求 → 路由給 `clarify`（讓它釐清，不是在 dispatch 停下問一句）；只有**連分類都衝突 / 多重**（連是 code 任務還是別的都分不出）時才停下用 `AskUserQuestion` 問。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「我直接幫他把所有階段跑完比較快」 | 在關鍵決策點（選方法 / 拍板 / 完工 or 回環）讓使用者把關才不會一路錯下去；routine 轉場可不問，但這些決策點不能自己跳過。 |
| 「需求有點模糊，但我猜大概是 issue / 直接開 define」 | 模糊想法 → 進 `clarify` 釐清，不是猜、也不是在 dispatch 停下問一句。猜錯會從錯方向起跑、整條迴圈白做。 |
| 「loop.md 之後再補」 | loop.md 是後續階段認領狀態的唯一依據；現在不建，下個階段就接不住。 |

## Red Flags

- 你在 dispatch 裡開始讀 codebase / 寫 code / 訪談 —— 那是 explore / build / goal 的事，dispatch 只分流。
- 你判完類型沒停、直接開始跑下一階段。
- 沒建 loop.md 就交棒。
- **要實作的工作沒有對應 issue 就直接進 plan / build** —— 一律先 `define` 建一個新 issue 再進（AGENTS 規則 12；研究 explore 例外）。

## Verification

- [ ] 分流結果正確（類型 ↔ 起點階段對得上決策樹）。
- [ ] **意圖明確**（issue#/PR#）跳過 clarify 直進 goal/iterate；**模糊想法**先進 `clarify` 釐清再分流（dispatch 自己沒做訪談 / 複述確認）。
- [ ] 目標若是**完全乾淨的空專案**，已先用 `AskUserQuestion` 確認 + scaffold 骨架（或使用者選跳過 / 要別的棧）才進 clarify / define / explore；既有 / 半成品專案不 scaffold。
- [ ] 無 issue 的「待解決問題」有先建成 GitHub issue（草稿確認後 `gh issue create`）才進 goal；純研究 / 設計則直接 explore、不建 issue。
- [ ] `.loops/<slug>/loop.md` 已建立（或既有的已認領），含類型 / 起點 / 停止條件雛形。
- [ ] 已進起點階段開始做（分類模糊時才停下用 `AskUserQuestion` 問），沒有用純文字問「要不要進 X」。
