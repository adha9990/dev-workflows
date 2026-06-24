---
name: goal
description: Turns a vague request or issue into an explicit definition-of-done and stop condition through one-question-at-a-time interview. Use when starting the goal stage of a loops-workflow run, or when requirements are unclear and need to be pinned down before exploring or planning.
---

# goal — 設定目標（完工定義 + 停止條件）

## Overview

`goal` 把一句模糊的需求 / 一張 issue，逼成「**明確的完工定義 + 可驗證的停止條件**」。方法是**一次只問一個問題**的適應性訪談，問完把理解 restate 成六欄給使用者看，然後**直接進 explore**（restate 不是要使用者點頭的 gate —— 有錯他會插話改）。

訪談一次只問一個問題、用 `AskUserQuestion` 給選項並標推薦，只問會改變方向的 blocking 決策；每問記下信心，restate 成六欄完工定義後**直接往 explore**，不停下要使用者確認 DoD。

> 需求若一進來就很模糊（連「要做什麼」都不清楚），那是 `clarify` 階段的事；goal 處理的是**已明確 / 已被 clarify 釐清**的目標 —— 逐句理解它、釘成 DoD。

## When to Use

**Use when**：dispatch 判為「處理 issue」、或需求不清楚、要在 explore / plan 之前把「做完長什麼樣」釘死。

**NOT for**：
- 需求已經很清楚、完工定義白紙黑字 —— 直接 explore / plan。
- 沒完沒了地逼問 —— 信心夠了（見停止條件）就停。

## Process

### 1. 逐句掃 issue，抽出每個 requirement

先讀 dispatch 建的 `loop.md` 與 issue / 描述。**逐句掃過整張 issue** —— 描述、背景、舉例、邊界說明、留言、甚至順帶一句的補充 —— **把每個 requirement-bearing 句子抽成一條清單**，**不是只看「驗收標準 / Acceptance Criteria」那一段**：需求常散在 prose、舉例、非目標裡（例：一句「排序要 score ASC」藏在敘述中段，不在任何 AC 清單）。抽出的每一條後面都要落到第 3 步六欄某處。

**issue 裡寫的實作做法 / 指名的套件，記成「建議」不是「需求」** —— 需求是「要達成 X」，「用套件 Y」只是建議，**留給 explore 多方法評估**（可能有更好的，見 explore §4.5）。別把「用 Y」當成 locked 的完工條件填進六欄。

**能從素材推得的不要問** —— 只問會改變方向的 blocking 決策。

### 2. 一次一問

- 一則訊息只問一個問題；用 `AskUserQuestion` 給 2–4 個選項。
- 每個選項標**推薦**並一句話講為什麼（端決策一定要明確推薦）。
- 每問在內部記一條 **HYPOTHESIS + CONFIDENCE**（0–100）：你目前猜答案是什麼、多有把握。優先打 confidence 最低、影響最大的點。
- **should-want 偵測**：使用者用「我**應該**…」「好的工程**會**…」這種**對誰交代 / 顯得專業**的措辭作答時，追問一次「**如果不用對任何人交代，你真正想要的是什麼？**」—— 區分表演式答案與真意圖，免得六欄填滿卻做錯東西。

### 3. Restate 六欄（完工定義）

訪談到信心足夠，把理解寫成 `00-goal.md`，固定六欄（schema 見 `references/goal-restate-schema.md`）。**第 1 步逐句抽出的每條 requirement 都要在六欄裡有著落**（沒著落的，不是漏抽就是該回去問）：

| 欄 | 內容 |
|------|------|
| Outcome | 做完後世界有什麼不同（一句） |
| User | 誰受益、在什麼情境 |
| Why now | 為什麼現在做 |
| Success | 可驗證的成功訊號（對應停止條件） |
| Constraint | 邊界 / 不可違反的限制 |
| Out of scope | 明確不做什麼（防範圍蔓延） |

### 4. 停止條件 + 直接進 explore（不問 DoD 確認）

- **95% 信心**就停止訪談，不無止境追問。
- restate 完工定義寫進 `00-goal.md` + chat 摘要給使用者看，然後**直接進 explore**。
- **不要停下問「DoD 正確嗎 / 可以鎖定嗎 / 要不要進 explore」** —— restate 出來就是給使用者看的，有錯他會插話改；「鎖定 DoD + 進 explore」是 **routine 轉場、不是決策點**（連 closed 模式也一樣，routine 轉場不問）。
- **唯一在 goal 停下用 `AskUserQuestion` 的情況**：有**具體的 scope 取捨選擇**（像「行為 X 要不要納入範圍」這種有明確選項、會改變方向的決策）才把它做成選項問。把「DoD 對不對」當成這種決策來問 = 誤用。
- 需求講不清（資訊不足以定義完工）→ 停下用 `AskUserQuestion` 問；但「whatever you think」不是把決定權丟回給你的藉口，能推得的就推。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「需求大致懂了，直接開始探索」 | 「大致」就是沒對齊。沒有六欄完工定義，explore / plan 會往你假設的方向跑偏。 |
| 「一次把問題全部問完比較有效率」 | 一次多問會讓使用者跳著答、漏答；一次一問才能用前一答收斂後一問。 |
| 「使用者說『你決定』，那就當 yes」 | 「你決定」是把判斷丟回給你，不是確認。重大且沒推薦的選項，要主動給意見再確認。 |
| 「Out of scope 先空著」 | 不寫不做什麼，範圍就會在 build 階段悄悄膨脹。 |
| 「closed 模式要先讓使用者鎖定 DoD 才能進 explore」 | 鎖定 DoD + 進 explore 是 routine 轉場，不是決策點。restate 給使用者看就往下、有錯他會插話；只有「具體 scope 取捨選擇」才停下問。 |

## Red Flags

- 一則訊息塞了好幾個問題。
- **只讀「驗收標準」段就定完工定義**，沒逐句掃完整 issue（漏掉散在描述 / 舉例 / 非目標裡的隱含需求）。
- 第 1 步抽的 requirement 有條沒落到六欄、就直接往下。
- 六欄有欄位空著就產 `00-goal.md`。
- 有真正的 scope 取捨卻沒用 `AskUserQuestion` 問就逕自決定。
- **把「DoD 正確嗎 / 可以鎖定進 explore 嗎」當 gate 停下問** —— 那是 routine 轉場，restate 給使用者看就直接進 explore（只有具體 scope 取捨選擇才問）。
- 訪談超過必要、把非 blocking 的細節也逼問。

## Verification

- [ ] 已**逐句掃過整張 issue**抽 requirement（不只 AC 段），每條都落到六欄某處。
- [ ] `00-goal.md` 六欄齊全，每欄有實質內容。
- [ ] Success 欄 = 可驗證的停止條件（不是「做得好」這種無法驗的話）。
- [ ] restate DoD 後**直接進 explore**，沒把「DoD 對嗎 / 可以鎖定嗎 / 要不要進 explore」當 gate 問；只有**具體 scope 取捨選擇**才用 `AskUserQuestion` 停下。
