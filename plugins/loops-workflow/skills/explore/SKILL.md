---
name: explore
description: Surveys internal codebase for reusable approaches then external sources for industry practice, laying both side by side with a recommendation. Use when starting the explore stage of a loops-workflow run, or when you need to research how to build something before planning it.
---

# explore — 探索（內外一條龍）

## Overview

`explore` 是一條龍的四步研究：**先掃內部 codebase 找可重用的東西，再搜外部看業界做法，把兩邊攤開並排比較、給推薦**，讓使用者在 `explore → plan` gate 選走哪條路。

不是雙模式 —— 永遠先內後外、最後攤開比較。外部研究分層：便宜的 `WebSearch` 打前哨，需要看實作細節才升級昂貴的 deep-research（且要經使用者同意）。

## When to Use

**Use when**：dispatch 判為「設計 / 研究」、或 goal 完工定義已定、要研究「怎麼做」才能 plan。

**NOT for**：
- 已經知道用什麼方法、只差拆任務 —— 直接 plan。
- 一上來就 deep-research —— 先用便宜搜索打前哨，貴的要 gate。

## Process（依序）

### 0. 先摸架構（文檔優先）

動手探索前先建立架構認知：**文檔優先** —— 讀 `CLAUDE.md` / `AGENTS.md`（最高優先）、`README` / `docs/` / ADR；文檔已說明架構就以文檔為準，只在文檔有缺口才爬 code。輸出 2–4 行 project context 寫進 `01-explore.md` 開頭。詳見 `references/onboarding.md`。

### 1. 先掃內部（重用優先）

派內建 `Explore` agent（Haiku、read-only，天生適合摸 codebase）找：既有可重用的實作 / 模式 / 類似功能。**出入口稍異不等於要另造** —— 預設擴充或參數化既有方法。回精煉 digest 給主線（不是整檔貼回）。

### 2. 再搜外部

用便宜的 `WebSearch` / firecrawl 看業界怎麼做（例如「VS Code 怎麼用 command pattern」先搜一輪）。

### 3. 不夠才深入（升級要 gate）

只有當「需要看實作細節、便宜搜索答不了」時，才**建議升級 deep-research**，並**先問使用者同意**再跑（deep-research 又慢又貴）。

### 4. 框架 API 查證

涉及第三方框架 / 函式庫 API 時，套查證流程 **DETECT → FETCH → IMPLEMENT → CITE**：用 context7 MCP 抓官方文件再下筆；查不到的標 `UNVERIFIED`，不要憑記憶硬寫 API。

> **（可選）Fleet**：同一個研究難題若一條檢索路線不夠，可 opt-in 派多個 agent 各用不同策略查再投票 / 攤開（見 `references/fleet.md`）；多數情況上面的分工式流程已夠，不必編隊。

### 5. 攤開比較 + 推薦

把內部可重用方案 vs 外部做法**並排**寫進 `01-explore.md`：各自優缺點、適配度、引用來源（CITE）。給一個推薦 + 理由。**外部來源只有參考價值** —— 寫「參考 + 我的傾向（待你拍板）」，不寫「採用 / 已決定」。停在 `explore → plan` 決策 gate：**用 `AskUserQuestion` 把候選方法做成選項給使用者選**（每個標推薦 + 一句理由），不要用純文字要使用者打字。

## Common Rationalizations

| 藉口 | 反駁 |
|------|------|
| 「直接 deep-research 最完整」 | deep-research 又慢又貴。先便宜搜索打前哨，多數問題就答了；真要深入才 gate 升級。 |
| 「外部做法看起來更潮，就用它」 | 先看內部有沒有可重用的；出入口稍異不是另造的理由。外部來源是多一票佐證，不是權威。 |
| 「API 我記得大概長這樣」 | 記憶會錯。框架 API 一律查官方文件查證，查不到標 UNVERIFIED。 |
| 「比較表先省了，直接講結論」 | 沒有攤開比較，使用者沒法在 gate 做有依據的選擇。 |

## Red Flags

- 沒掃內部就直接搜外部 / 直接 deep-research。
- 沒問同意就跑 deep-research。
- 框架 API 沒查證就寫進 `01-explore.md`。
- 把推薦寫成「已決定採用」越過使用者的選擇 gate。

## Verification

- [ ] `01-explore.md` 有「內部可重用 vs 外部做法」並排比較。
- [ ] 有明確推薦 + 理由，且措辭是「待你拍板」不是「已決定」。
- [ ] 框架 API 來源已 CITE，查不到的標 UNVERIFIED。
- [ ] deep-research（若用）有先經同意。
- [ ] 已停在 `explore → plan` gate。
