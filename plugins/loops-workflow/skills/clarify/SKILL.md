---
name: clarify
user-invocable: false
description: Turns a vague or ambiguous one-liner into a clear, confirmed understanding and a decided direction before any building. Use when the request is a fuzzy idea rather than a concrete issue#/PR#. Routed to by dispatch only for vague intent; clear intent skips it.
---

# clarify — 釐清模糊需求（再分流到對的階段）

## Overview

`clarify` 是迴圈最前面的**理解對齊**前置階段（與 scaffold / define 同層、不在 goal→…→iterate 圈內）：把工程師**一句話 / 模糊的想法**，用一次一問收斂成「**清楚、且經使用者確認**的理解」，再判方向、交給對的下一階段。

> **為什麼要獨立成一個階段**：工程師常用一句話描述需求，理解一旦偏掉，後面整條 loop 會持續往錯方向做、越做越貴（規則 10）。dispatch 是薄的純分流台、不該夾訪談確認；goal / define 是「目標已明確 / 要建 issue」之後的事。模糊的「你到底想要什麼」需要**自己的釐清流程** —— 一次一問、確認對齊，才往下。

> **只處理模糊**：意圖已明確（issue# / PR# / 「修這個」/ 具體到能直接動工）→ dispatch 直接跳過 clarify 進 goal / iterate，**不要對清楚的需求加 ceremony**。

## When to Use

**Use when**：dispatch 判定請求是**模糊想法 / 含糊一句話**（不是具體 issue# / PR#），要先釐清、對齊理解才知道往哪走。（`user-invocable: false`：不由使用者直接喊，由 dispatch 判模糊時內部驅動。）

**NOT for**：
- 已有 issue# / PR# / 目標很明確 —— 直接 goal / iterate（那階段負責理解該具體目標）。
- 已釐清、要把它變成 issue —— `define`；已知要研究怎麼做 —— `explore`。
- 反覆逐項逼問 —— 釐清是**收斂**、不是審問，信心夠就停。

## Process

### 1. 一次一問收斂理解
- 一則訊息只問一個問題，用 `AskUserQuestion` 給 2–4 選項並標推薦（依 `references/comment-policy.md`）。
- 每問內部記 **HYPOTHESIS + CONFIDENCE**（0–100），優先打最低信心、最影響方向的點。
- **should-want 偵測**：見 `references/goal-restate-schema.md`（表演式「應該／好的工程會」作答 → 追問一次真意圖）。
- **能從素材推得的不要問**；只問會改變方向的 blocking 點。

### 2. Restate 理解 + 一次確認
把收斂後的理解 restate 成這幾項：**問題（誰 / 什麼受影響、今天的痛）· 為何現在 · 大致範圍 · 明確不做 · 我的關鍵假設**。用 `AskUserQuestion` 做**一次**確認（對齊 ／ 要調整 + 說明）。**單次整份對齊、不是逐項再審一輪** —— 對了就往下。

### 3. 判方向 + 交棒（routine 不問）
依釐清結果決定方向，寫進 `00-clarify.md`（含確認後的理解 + 選定方向），然後直接進下一階段：
- 要**落地實作某功能** → `define`（把清楚的 intent 格式化成 template-ready 功能 issue，**不重新訪談**）→ goal。**做法不確定**就在 issue 標「實作待研究」，其迴圈 goal 後 explore 研究。
- 想**先探索一塊空間**再決定要做什麼 → `explore` 研究 → 產出經 `define` 開功能 issue（**不另開「研究 issue」**）。
- 是**修既有 PR / reviewer 回饋** → `iterate`。
- 是**完全乾淨空專案**要先有骨架 → 回 dispatch 的 scaffold 前置，骨架好再續。

> clarify 的產出是「**經確認的理解 + 方向**」，**不建 issue、不釘 DoD、不動 code**（那是 define / goal / build 的事）。它讓 define / goal 拿到的是已釐清的東西、不必重問。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「需求大致懂了，直接進 define / explore」 | 「大致」就是沒對齊。clarify 的產出是**經確認**的理解，少了它 define / goal 會各問一輪、或往你假設的方向跑偏。 |
| 「把釐清塞進 dispatch 一次確認就好」 | dispatch 是薄分流台；一次確認收斂不了真正模糊的需求。釐清要一次一問、有自己的階段。 |
| 「clarify 完，define 再訪談一次比較保險」 | 重複訪談是雙重打擾。clarify 已釐清的，define 只做格式化、不重問。 |
| 「對明確的 issue# 也跑一下 clarify 比較保險」 | 明確需求加 ceremony 是浪費。issue# / PR# 直接進 goal / iterate。 |

## Red Flags

- 對**明確 issue# / PR#** 還跑 clarify（多餘 ceremony）。
- 一則訊息塞了好幾個問題。
- restate 沒做那次確認就逕自交棒；或把單次確認搞成逐項反覆逼問。
- 在 clarify 裡開始**建 issue / 釘 DoD / 寫 code**（那是 define / goal / build 的事）。
- 釐清完沒判方向、沒寫 `00-clarify.md` 就交棒。

## Verification

- [ ] 僅在**模糊**請求進入；明確 issue# / PR# 沒被誤拉進來。
- [ ] 一次一問收斂；restate「問題 / 為何 / 範圍 / 不做 / 假設」+ **一次**確認（非逐項反覆逼問）。
- [ ] 判了方向並寫進 `00-clarify.md`，交棒給 define / explore / iterate（routine 轉場不問）。
- [ ] 沒在 clarify 內建 issue / 釘 DoD / 動 code。
