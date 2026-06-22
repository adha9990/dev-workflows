---
name: dispatch
description: Routes a one-line work request to the right loops-workflow stage and sets up the loop. Use when starting any loops-workflow run, or when the user says /loops-workflow:dispatch, or is unsure which stage (goal/explore/plan/build/verify/iterate) to begin from.
---

# dispatch — 決策樹分流 + 操作規則入口

## Overview

`dispatch` 是 loops-workflow 的分流台，**很薄**：只做四件事 —— 判類型、建 `.loops/<slug>/loop.md`、建議起點、交棒。它不替你把後續階段跑完，分完就停在起點 gate 等使用者。

它同時是「中央說明書」的入口：全程不變的紀律集中寫在 `AGENTS.md`（繁中對外 / human gate 不可跳 / `.loops/` 每階段交接 / 模糊就 surface / Metric-Honesty），七個階段不各自重述。dispatch 負責在開場把這套規矩立起來。

> 形式借鑑 agent-skills 的 `using-agent-skills`（決策樹分流 + 集中守則），但**只分流、不串接**。

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

**推進模式**：預設 Closed Loop（階段間都停）。加 `auto` → `dispatch auto <描述>` 開 opt-in 自動連跑（核准計畫一次後連跑，危險 / 失敗 / P0 / 規格模糊仍硬停，見 `references/auto-mode.md`）。

### 2. 建 / 認領 loop.md

slug 由描述或 issue 標題生 kebab-case（英文 / 數字 / 連字號）。建立 `.loops/<slug>/loop.md`，寫入：
- **類型**（issue / design / fix）
- **起點階段**
- **推進模式**（closed / auto，預設 closed）
- **停止條件雛形**（goal 階段會精煉）
- **Journal（append-only 事件日誌）**（空，每階段 append 一筆，見 `references/journaling.md`）

**Resume**：若 `.loops/<slug>/loop.md` 已存在 → 不覆蓋，走 resume 協定（讀 Journal 重建狀態 → 回報「停在哪個階段 / 哪個 gate、已完成 E1–En」→ 問使用者是否續跑，見 `references/journaling.md`）。

### 3. 交棒（停在起點 gate）

宣告判定結果 + 起點 + loop.md 路徑，然後**停下**。不要自己接著跑 goal / explore / iterate —— 等使用者拍板才往下。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「我直接幫他把所有階段跑完比較快」 | Closed Loop 的價值就是每階段都有 gate；串接會奪走使用者的判斷點，錯的方向會一路錯下去。 |
| 「類型有點模糊，但我猜大概是 issue」 | 模糊就停下問，這是決策樹明定的唯一釐清 gate。猜錯會從錯的階段起跑、整條迴圈白做。 |
| 「loop.md 之後再補」 | loop.md 是後續階段認領狀態的唯一依據；現在不建，下個階段就接不住。 |

## Red Flags

- 你在 dispatch 裡開始讀 codebase / 寫 code / 訪談 —— 那是 explore / build / goal 的事，dispatch 只分流。
- 你判完類型沒停、直接開始跑下一階段。
- 沒建 loop.md 就交棒。

## Verification

- [ ] 分流結果正確（類型 ↔ 起點階段對得上決策樹）。
- [ ] `.loops/<slug>/loop.md` 已建立（或既有的已認領），含類型 / 起點 / 停止條件雛形。
- [ ] 已停在起點 gate，沒有自動往下跑。
