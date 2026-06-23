---
name: dispatch
description: Routes a one-line work request to the right loops-workflow stage and sets up the loop. Use when starting any loops-workflow run, or when the user says /loops-workflow:dispatch, or is unsure which stage (goal/explore/plan/build/verify/iterate) to begin from.
---

# dispatch — 決策樹分流 + 操作規則入口

## Overview

`dispatch` 是 loops-workflow 的分流台，**很薄**：只做三件事 —— 判類型、建 `.loops/<slug>/loop.md`、進起點階段。routine 轉場不問你；只有分類模糊才停下用 `AskUserQuestion` 問。

它同時是「中央說明書」的入口：全程不變的紀律集中寫在 `AGENTS.md`（繁中對外 / human gate 不可跳 / `.loops/` 每階段交接 / 模糊就 surface / Metric-Honesty），七個階段不各自重述。dispatch 負責在開場把這套規矩立起來。

> 原則：**只分流、不串接** —— dispatch 不是自動駕駛，判完類型就交棒停下。

## When to Use

**Use when**：
- 開始一個 loops-workflow 任務、但不確定該從哪個階段進。
- 使用者丟一句話描述 / issue 號 / PR 號，要判斷這是「處理 issue / 設計問題 / 修正問題」。

**NOT for**：
- 你已經知道要哪個階段 —— 直接喊那個階段（`/loops-workflow:goal` 等），別繞 dispatch 多花一圈 token。
- 把所有階段一路自動跑完 —— 那違反 Closed Loop，dispatch 只送你到起點。

## Process

### 1. 判類型（決策樹）

```
├─ issue 號 / 「做這個 issue」 ─────────▶ 從 goal 開始（完整迴圈）
├─ 「設計 / 研究 / 評估」+ 無 issue ────▶ 從 explore 開始（開放式）
├─ PR 號 / 「reviewer / 修正回饋」 ─────▶ 從 iterate 開始
└─ 模糊 / 多重 / 衝突 ──────────────────▶ 停下來問使用者（唯一的釐清 gate）
```

顯式語法可跳過判斷：`dispatch <type> <ref>`，例如 `dispatch issue #5`、`dispatch explore "command pattern 怎麼設計"`、`dispatch iterate PR#12`。

**推進模式**：預設只在決策點停（routine 轉場不問）。加 `auto` → `dispatch auto <描述>` 開 opt-in 自動連跑（核准計畫一次後連決策也用推薦自動帶過，危險 / 失敗 / P0 / 規格模糊仍硬停，見 `references/auto-mode.md`）。

### 2. 建 / 認領 loop.md

slug 由描述或 issue 標題生 kebab-case（英文 / 數字 / 連字號）。建立 `.loops/<slug>/loop.md`，寫入：
- **類型**（issue / design / fix）
- **起點階段** + **當前階段**（當前階段初始＝起點階段，每進一個階段就更新；供 statusline 顯示）
- **session**（用 Bash 讀 `$CLAUDE_CODE_SESSION_ID` 填；statusline 靠它**只顯示「本 session」正在跑的 loop**，不被別 session / 歷史 loop 干擾）
- **推進模式**（closed / auto，預設 closed）
- **停止條件雛形**（goal 階段會精煉）
- **Journal（append-only 事件日誌）**（空，每階段 append 一筆，見 `references/journaling.md`）

**Worktree（會動 code 的迴圈才開）**：type 是 issue / fix → loop 啟動時開**隔離 worktree（自帶 branch）**，整條 loop 在裡面跑、`.loops/<slug>/` 也放裡面，**主 checkout 不動**：用 `EnterWorktree`，或 `git worktree add .claude/worktrees/<slug> -b <branch> <base>`；fix 型把該 PR branch checkout 進 worktree。純設計 / 研究免開（走到 build 再開）。見 `AGENTS.md` 規則 9。

**Resume**：若 `.loops/<slug>/loop.md` 已存在 → 不覆蓋，走 resume 協定（讀 Journal 重建狀態 → 回報「停在哪個階段 / 哪個 gate、已完成 E1–En」→ 問使用者是否續跑，見 `references/journaling.md`）。

### 3. 進起點階段（routine 轉場不問）

宣告判定結果 + 起點 + loop.md 路徑，然後**直接進起點階段開始做** —— **不問「要不要進 goal / iterate」**（routine 轉場不問）。只有**分類模糊 / 多重 / 衝突**時才停下用 `AskUserQuestion` 問是哪一種。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「我直接幫他把所有階段跑完比較快」 | 在關鍵決策點（選方法 / 拍板 / 完工 or 回環）讓使用者把關才不會一路錯下去；routine 轉場可不問，但這些決策點不能自己跳過。 |
| 「類型有點模糊，但我猜大概是 issue」 | 模糊就停下問，這是決策樹明定的唯一釐清 gate。猜錯會從錯的階段起跑、整條迴圈白做。 |
| 「loop.md 之後再補」 | loop.md 是後續階段認領狀態的唯一依據；現在不建，下個階段就接不住。 |

## Red Flags

- 你在 dispatch 裡開始讀 codebase / 寫 code / 訪談 —— 那是 explore / build / goal 的事，dispatch 只分流。
- 你判完類型沒停、直接開始跑下一階段。
- 沒建 loop.md 就交棒。

## Verification

- [ ] 分流結果正確（類型 ↔ 起點階段對得上決策樹）。
- [ ] `.loops/<slug>/loop.md` 已建立（或既有的已認領），含類型 / 起點 / 停止條件雛形。
- [ ] 已進起點階段開始做（分類模糊時才停下用 `AskUserQuestion` 問），沒有用純文字問「要不要進 X」。
