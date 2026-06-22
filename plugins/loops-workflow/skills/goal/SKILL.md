---
name: goal
description: Turns a vague request or issue into an explicit definition-of-done and stop condition through one-question-at-a-time interview. Use when starting the goal stage of a loops-workflow run, or when requirements are unclear and need to be pinned down before exploring or planning.
---

# goal — 設定目標（完工定義 + 停止條件）

## Overview

`goal` 把一句模糊的需求 / 一張 issue，逼成「**明確的完工定義 + 可驗證的停止條件**」。方法是**一次只問一個問題**的適應性訪談，問完把理解 restate 成六欄，使用者明確點頭才往下。

訪談一次只問一個問題、用 `AskUserQuestion` 給選項並標推薦，只問會改變方向的 blocking 決策；每問記下信心，restate 成六欄完工定義後要使用者明確點頭才往下。

## When to Use

**Use when**：dispatch 判為「處理 issue」、或需求不清楚、要在 explore / plan 之前把「做完長什麼樣」釘死。

**NOT for**：
- 需求已經很清楚、完工定義白紙黑字 —— 直接 explore / plan。
- 沒完沒了地逼問 —— 信心夠了（見停止條件）就停。

## Process

### 1. 讀現有素材，先推再問

先讀 dispatch 建的 `loop.md` 與 issue / 描述。**能從素材推得的不要問** —— 只問會改變方向的 blocking 決策。

### 2. 一次一問

- 一則訊息只問一個問題；用 `AskUserQuestion` 給 2–4 個選項。
- 每個選項標**推薦**並一句話講為什麼（端決策一定要明確推薦）。
- 每問在內部記一條 **HYPOTHESIS + CONFIDENCE**（0–100）：你目前猜答案是什麼、多有把握。優先打 confidence 最低、影響最大的點。

### 3. Restate 六欄（完工定義）

訪談到信心足夠，把理解寫成 `00-goal.md`，固定六欄（schema 見 `references/goal-restate-schema.md`）：

| 欄 | 內容 |
|------|------|
| Outcome | 做完後世界有什麼不同（一句） |
| User | 誰受益、在什麼情境 |
| Why now | 為什麼現在做 |
| Success | 可驗證的成功訊號（對應停止條件） |
| Constraint | 邊界 / 不可違反的限制 |
| Out of scope | 明確不做什麼（防範圍蔓延） |

### 4. 停止條件 + explicit-yes gate

- **95% 信心**就停止訪談，不無止境追問。
- restate 給使用者看，要**明確的 yes** 才往下。「whatever you think」「你決定就好」**不算 yes** —— 那代表還沒對齊，回去補問。
- 停在 `goal → explore` 確認 gate。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「需求大致懂了，直接開始探索」 | 「大致」就是沒對齊。沒有六欄完工定義，explore / plan 會往你假設的方向跑偏。 |
| 「一次把問題全部問完比較有效率」 | 一次多問會讓使用者跳著答、漏答；一次一問才能用前一答收斂後一問。 |
| 「使用者說『你決定』，那就當 yes」 | 「你決定」是把判斷丟回給你，不是確認。重大且沒推薦的選項，要主動給意見再確認。 |
| 「Out of scope 先空著」 | 不寫不做什麼，範圍就會在 build 階段悄悄膨脹。 |

## Red Flags

- 一則訊息塞了好幾個問題。
- 六欄有欄位空著就產 `00-goal.md`。
- 沒拿到明確 yes 就跳 explore。
- 訪談超過必要、把非 blocking 的細節也逼問。

## Verification

- [ ] `00-goal.md` 六欄齊全，每欄有實質內容。
- [ ] Success 欄 = 可驗證的停止條件（不是「做得好」這種無法驗的話）。
- [ ] 使用者給了明確 yes。
- [ ] 已停在 `goal → explore` gate。
