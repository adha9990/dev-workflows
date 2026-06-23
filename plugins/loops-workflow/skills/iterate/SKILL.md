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

接著產出**交 PR 的兩份交接物 —— 都先寫 tmp 草稿給使用者校稿、確認才送，不自動 post**：

1. **PR 收尾 comment**（依 `references/pr-spec.md` + `references/comment-policy.md`）：總結這次做了什麼 + 驗證證據，並逐條回覆 reviewer 意見（去客套、雙視角、婉拒項只陳述技術理由）。寫 tmp 草稿 → 使用者確認 → `--body-file` post。
2. **explain 理解包**（跑 `explain` skill）：實作導讀 + ownership 自測題 + 設計方向 recap，附給 reviewer / 交接用。

> 這兩份**只在「完工交 PR」這條分支**產；回環途中不產。

停在 `iterate` 決策 gate。

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

## Verification

- [ ] 每條回饋有 RECONCILE 分類。
- [ ] 每個 actionable 修的是根因 + 有回歸測試（GUARD）。
- [ ] 回環 ≤ 3 圈，超過已 escalate；`loop.md` 有回環歷史。
- [ ] 完工前對照 `00-goal.md` 停止條件全達成。
- [ ] 完工交 PR 時，PR 收尾 comment + explain 兩份草稿都經使用者確認才送（未自動 post）；回環途中不產這兩份。
- [ ] 停在 `iterate` 決策 gate。
