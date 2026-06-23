---
name: iterate
description: Triages verify findings or PR feedback, decides which stage to loop back to (max 3 rounds), and finishes when the stop condition is met. Use when starting the iterate stage of a loops-workflow run, or when a PR has reviewer feedback to act on.
---

# iterate — 迭代（triage + 回環決策 + 收尾）

## Overview

`iterate` 把 verify 的缺口 / PR reviewer 的回饋做 triage，決定**回哪個階段重來**（最多 3 圈），或**完工收尾交 PR**。它是閉環的收口 —— 確保「錯的東西被修正、修正有回歸測試守住」，而不是無限繞圈。

做法：彙整三來源回饋 → 分四類 → 對真問題走 Stop-the-Line 修根因（每修加回歸測試）→ 決定回哪個階段或完工收尾。

## When to Use

**Use when**：`04-verify.md` 出爐、或 PR 有 reviewer 回饋要處理。

**NOT for**：
- 還沒驗收 —— 去 verify。
- 全新需求 —— 回 goal 開新迴圈。

## Process

### 1. 收集三來源回饋

verify 報告 / PR reviewer comment / CI 失敗。彙整成一張清單。

### 2. RECONCILE 四分類

每條回饋分類：
- **contract misread**：reviewer 誤讀了契約 → 婉拒，只陳述技術理由。
- **actionable**：真問題 → 要修。
- **trade-off**：取捨選擇 → 記 decision record，回覆說明選擇。
- **noise**：純風格 / 無關 → 過濾。

### 3. Stop-the-Line 修（針對 actionable）

每個要修的問題走 **STOP → PRESERVE → DIAGNOSE → FIX → GUARD → RESUME**：
- 修**根因**而非症狀。
- 每修一個 bug **加一條回歸測試**守住（GUARD）。

### 4. 決定回環目標

依問題性質決定回哪個階段，或完工：
- 需求理解錯 → 回 `goal`
- 方法選錯 → 回 `explore`
- 拆解 / 設計缺陷 → 回 `plan`
- 實作 bug → 回 `build`
- 都過了 → **完工**

### 5. 3 圈上限

回環**最多 3 圈**。超過就 **escalate 給使用者**（別無限繞）。每次回環在 `loop.md` 記一筆（第幾圈、回哪、為什麼）。

### 6. 完工收尾

對照 `00-goal.md` 停止條件全部達成 → 跑 Pre-Launch checklist 骨架（砍掉 infra 項）→ 收尾前過 `references/docs-policy.md`（補 `docs/<topic>.md` + `docs/README.md` 索引、慣例 / 規則有變更才同步 `AGENTS.md` / `CLAUDE.md`）。

**交接物依迴圈類型而定 —— 都先寫暫存 tmp 草稿（不進專案）→ 使用者確認 → `--body-file` post → 刪 tmp，不自動 post**：

- **修正型（`type=fix`，從 PR reviewer 回饋進來、PR 已存在）→ 只產一份：回覆 reviewer**（依 `references/comment-policy.md`：逐條記「改了什麼 `<file:line>` + 驗證證據」、雙視角、婉拒只講技術理由）。**不另寫 PR body as-built 條目、不另發 issue comment**（除非使用者明確要）。
- **完整迴圈（`type=issue/design`，交新 PR）→ PR 收尾 comment**（`references/pr-spec.md` + `references/comment-policy.md`：成果 + 驗證證據 + 回覆）+ **explain 理解包**（跑 `explain` skill，給工程師理解）。修正型**不自動產 explain**；要的話用 `/loops-workflow:explain`（opt-in）。

**follow-up 在當前 issue 內處理、不另開 issue**：發現的後續項 / 既有非本次引入的退化，預設記在當前 issue / PR thread 並在本次或本 issue 內處理，**不 spin off 新 issue**（除非使用者明確要另開）。

> 這些只在「完工」這條分支產；回環途中不產。

完工後把 `loop.md` 的「當前階段」設為「**完工**」（statusline 即不再顯示此 loop）。

停在 `iterate` 決策 gate：**用 `AskUserQuestion` 問**完工交 PR / 回哪個階段重來（標推薦）。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「症狀壓掉就好，根因之後再說」 | 症狀修會復發。debugging 的鐵律是修根因，且每修加回歸測試。 |
| 「reviewer 講的我覺得不對，直接忽略」 | 不對的也要分類成 contract misread 並陳述理由婉拒，不是默默忽略。 |
| 「再繞一圈應該就好了」（已第 4 圈） | 超過 3 圈代表方向有更深的問題，要 escalate，不是再賭一圈。 |
| 「修完不用加測試，這次很簡單」 | 沒有回歸測試守住，同一個 bug 會再回來。GUARD 不可省。 |

## Red Flags

- 修症狀沒修根因。
- 修了 bug 沒加回歸測試。
- 回環超過 3 圈還在繞、沒 escalate。
- `loop.md` 沒記回環歷史。
- 回覆 reviewer 堆客套 / 沒給驗證證據。
- 修正型（`type=fix`）收尾還產一堆草稿（PR body as-built / 另發 issue comment）—— 只該一份回覆 reviewer。
- 把本可在當前 issue 解決的 follow-up 擅自另開新 issue。

## Verification

- [ ] 每條回饋有 RECONCILE 分類。
- [ ] 每個 actionable 修的是根因 + 有回歸測試（GUARD）。
- [ ] 回環 ≤ 3 圈，超過已 escalate；`loop.md` 有回環歷史。
- [ ] 完工前對照 `00-goal.md` 停止條件全達成。
- [ ] 收尾交接物依迴圈類型：修正型只一份「回覆 reviewer」、完整迴圈才產 PR 收尾 comment（+ explain）；都經使用者確認才送、未自動 post、回環途中不產。
- [ ] follow-up 在當前 issue 內處理，沒有擅自另開新 issue。
- [ ] 停在 `iterate` 決策 gate。
